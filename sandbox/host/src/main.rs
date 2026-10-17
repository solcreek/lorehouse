//! sandboxd — Lorehouse's sandbox host daemon.
//!
//! One Firecracker microVM per sandbox id (Lorehouse uses one per Slack thread), behind
//! the API src/sandbox-client.ts speaks:
//!
//!   POST   /v1/sandboxes/{id}/exec   {command, cwd, env, timeoutMs} → {exitCode, stdout, stderr}
//!   GET    /v1/sandboxes/{id}/file?path=…                         → bytes (404 if absent)
//!   PUT    /v1/sandboxes/{id}/file?path=…                         → 204
//!   POST   /v1/sandboxes/{id}/jobs   {id, command, cwd, env, timeoutMs} → 201 a background job (200: that id's job, already started)
//!   GET    /v1/sandboxes/{id}/jobs/{job}?waitMs=…&tailBytes=…       → the job: state, exit code, elapsed, output tail
//!   POST   /v1/sandboxes/{id}/jobs/{job}/cancel                     → the job, once stopped (its process group killed)
//!   DELETE /v1/sandboxes/{id}                                     → 204 (VM stopped, disk gone, its jobs with it)
//!   GET    /v1/sandboxes                                          → what exists, running or not
//!   POST   /v1/sandboxes/{id}/stage  {owner, name, base, branch, token?} → the commits to publish, verified, and a stage id
//!   POST   /v1/sandboxes/{id}/push   {stage, owner, name, sha, branch, token} → pushed (see publish.rs)
//!   GET    /healthz                                               → ok (no auth)
//!
//! Every /v1 request needs `Authorization: Bearer <SANDBOXD_TOKEN>`. Requests for a
//! stopped sandbox boot it first; idle ones are stopped with their disk kept.

mod child;
mod config;
mod gitjail;
mod jail;
mod net;
mod pidfd;
mod publish;
mod quota;
mod runner;
#[cfg(test)]
mod service_unit;
mod vm;
mod vsock;

use axum::{
    body::Bytes,
    extract::{Path, RawQuery, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use std::time::Duration;

/// Backstop for one proxied request (Lorehouse's longest command is 10 minutes).
pub const REQUEST_DEADLINE: Duration = Duration::from_secs(15 * 60 + 30);
/// How long requests in flight get after SIGTERM before the VMs are stopped anyway.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(30);
/// How often the mirrors' upkeep runs (retention, the daily gc, what heavy stages left).
const MIRROR_UPKEEP_EVERY: Duration = Duration::from_secs(5 * 60);
use subtle::ConstantTimeEq;
use vm::Manager;

#[derive(Clone)]
struct App {
    vms: Arc<Manager>,
    publisher: Arc<publish::Publisher>,
    token_digest: [u8; 32],
}

fn digest(s: &str) -> [u8; 32] {
    Sha256::digest(s.as_bytes()).into()
}

async fn auth(State(app): State<App>, req: Request, next: Next) -> Response {
    let given = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split_once(' '))
        .filter(|(scheme, _)| scheme.eq_ignore_ascii_case("bearer"))
        .map(|(_, token)| token)
        .unwrap_or("");
    if bool::from(digest(given).ct_eq(&app.token_digest)) {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, [(header::WWW_AUTHENTICATE, "Bearer")], "unauthorized").into_response()
    }
}

fn error(status: u16, msg: impl Into<String>) -> Response {
    let status = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

/// Boot the sandbox if needed and pass one request through to its guestd.
async fn forward(app: &App, id: &str, method: Method, guest_path: String, body: Bytes) -> Response {
    if !vm::valid_id(id) {
        return error(400, "sandbox id: 1–128 of [A-Za-z0-9_.-], not starting with a dot");
    }
    let (_use, uds) = match app.vms.acquire(id).await {
        Ok(v) => v,
        Err((status, msg)) => return error(status, msg),
    };
    // A host-side deadline, whatever the guest does: Lorehouse's longest command is 10
    // minutes, and guestd kills it at its own timeout, so this is the backstop.
    match tokio::time::timeout(REQUEST_DEADLINE, vsock::request(&uds, method, &guest_path, body)).await {
        Ok(Ok(reply)) => {
            let mut headers = HeaderMap::new();
            if let Some(ct) = reply.content_type.and_then(|v| v.parse().ok()) {
                headers.insert(header::CONTENT_TYPE, ct);
            }
            (reply.status, headers, reply.body).into_response()
        }
        Ok(Err(e)) => error(502, e),
        Err(_) => error(504, format!("the guest didn't answer within {} s", REQUEST_DEADLINE.as_secs())),
    }
}

async fn exec(State(app): State<App>, Path(id): Path<String>, body: Bytes) -> Response {
    forward(&app, &id, Method::POST, "/exec".into(), body).await
}

fn file_path(query: Option<String>) -> String {
    format!("/file?{}", query.unwrap_or_default())
}

async fn read_file(State(app): State<App>, Path(id): Path<String>, RawQuery(q): RawQuery) -> Response {
    forward(&app, &id, Method::GET, file_path(q), Bytes::new()).await
}

async fn write_file(State(app): State<App>, Path(id): Path<String>, RawQuery(q): RawQuery, body: Bytes) -> Response {
    forward(&app, &id, Method::PUT, file_path(q), body).await
}

async fn job_start(State(app): State<App>, Path(id): Path<String>, body: Bytes) -> Response {
    forward(&app, &id, Method::POST, "/jobs".into(), body).await
}

/// The guestd path for a job route, or why it is refused (a 400). `job` is as Axum decoded it, so
/// an encoded `%2F` is a `/` by now: it must be a job id before it goes into a path, and the
/// method is the route's (GET status, POST cancel), never read from the path's text.
fn job_guest_path(method: &Method, job: &str, query: Option<String>) -> Result<String, &'static str> {
    if !vm::valid_job_id(job) {
        return Err(vm::BAD_JOB_ID);
    }
    let path = match (method, query) {
        (&Method::POST, _) => format!("/jobs/{job}/cancel"),
        (_, Some(q)) => format!("/jobs/{job}?{q}"),
        (_, None) => format!("/jobs/{job}"),
    };
    match vm::job_call(method.as_str(), &path) {
        Some(m) if m == *method => Ok(path),
        _ => Err(vm::job_call_refusal(&path)),
    }
}

async fn job_status(State(app): State<App>, Path((id, job)): Path<(String, String)>, RawQuery(q): RawQuery) -> Response {
    match job_guest_path(&Method::GET, &job, q) {
        Ok(path) => forward(&app, &id, Method::GET, path, Bytes::new()).await,
        Err(why) => error(400, why),
    }
}

async fn job_cancel(State(app): State<App>, Path((id, job)): Path<(String, String)>) -> Response {
    match job_guest_path(&Method::POST, &job, None) {
        Ok(path) => forward(&app, &id, Method::POST, path, Bytes::new()).await,
        Err(why) => error(400, why),
    }
}

async fn destroy(State(app): State<App>, Path(id): Path<String>) -> Response {
    if !vm::valid_id(&id) {
        return error(400, "bad sandbox id");
    }
    match app.vms.destroy(&id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error(409, e),
    }
}

async fn stage(State(app): State<App>, Path(id): Path<String>, Json(req): Json<publish::StageRequest>) -> Response {
    match app.publisher.stage(&app.vms, &id, req).await {
        Ok(staged) => Json(staged).into_response(),
        Err((status, msg)) => error(status, msg),
    }
}

async fn push(State(app): State<App>, Path(id): Path<String>, Json(req): Json<publish::PushRequest>) -> Response {
    match app.publisher.push(&id, req).await {
        Ok(pushed) => Json(pushed).into_response(),
        Err((status, msg)) => error(status, msg),
    }
}

async fn list(State(app): State<App>) -> Response {
    Json(app.vms.list().await).into_response()
}

#[tokio::main]
async fn main() {
    let cfg = match config::Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    if let Err(e) = tokio::fs::create_dir_all(&cfg.state_dir).await {
        eprintln!("sandboxd: state dir {}: {e}; under sandboxd.service, a SANDBOXD_STATE other than the default must exist and be in ReadWritePaths=", cfg.state_dir.display());
        std::process::exit(1);
    }
    // sandboxd.service makes everything read-only but /var/lib/lorehouse-sandboxes
    // (ProtectSystem=strict); another SANDBOXD_STATE would fail at the first boot instead.
    let probe = cfg.state_dir.join(".write-probe");
    if let Err(e) = tokio::fs::write(&probe, b"").await {
        eprintln!("sandboxd: state dir {} isn't writable ({e}); under sandboxd.service, list it in ReadWritePaths=", cfg.state_dir.display());
        std::process::exit(1);
    }
    let _ = tokio::fs::remove_file(&probe).await;
    // No jailer, no cgroup of its own, or uids that belong to someone: no VMs at all.
    let host = match jail::prepare(&cfg).await {
        Ok(h) => Arc::new(h),
        Err(e) => {
            eprintln!("sandboxd: {e}");
            std::process::exit(1);
        }
    };
    // Publishing's git runs isolated from sandboxd (gitjail.rs), or not at all: a host that
    // can't set that up, as a probe run shows, doesn't start.
    let git_jail = match gitjail::GitJail::prepare(&cfg.state_dir, jail::git_cgroups(&host), cfg.jail.git_uid_base) {
        Ok(j) => Arc::new(j),
        Err(e) => {
            eprintln!("sandboxd: {e}");
            std::process::exit(1);
        }
    };
    match git_jail.probe(&cfg.state_dir.join(".git-probe")).await {
        Ok(version) => eprintln!(
            "sandboxd: publishing's {version} runs isolated: its own uid per run (SANDBOXD_GIT_UID_BASE + n), only its mirror and /usr in view, no network but through sandboxd, a cgroup per run under {}",
            jail::git_cgroups(&host).display()
        ),
        Err(e) => {
            eprintln!("sandboxd: publishing's git can't run isolated here: {e}");
            std::process::exit(1);
        }
    }
    // A disk quota set explicitly but not enforceable here refuses the start too.
    let quota = match quota::detect(&cfg.state_dir, &cfg.limits.disk_quota).await {
        Ok(q) => q,
        Err(e) => {
            eprintln!("sandboxd: {e}");
            std::process::exit(1);
        }
    };
    // Start clean: whatever a previous run left (a crash, a kill) is removed first, VMMs
    // before their taps, and before any request can boot a disk one of them still holds.
    vm::stop_stale_vmms(&cfg.state_dir, &host).await;
    net::teardown_all().await;
    let fw = net::Firewall::new(&cfg.uplink, cfg.max_vms);
    if let Err(e) = net::setup(&fw).await {
        eprintln!("sandboxd: network setup: {e}");
        net::teardown_all().await;
        std::process::exit(1);
    }

    let vms = Manager::new(cfg.clone(), host, quota, fw.clone());
    // The table, kept as loaded: checked every SANDBOXD_NET_CHECK_SECS (and before every
    // boot, in vm.rs). One that is gone or changed is loaded again; one that can't be takes
    // every tap down and stops every VM, and none boots until it is back (fail closed).
    let watch = (fw.clone(), vms.clone());
    let every = cfg.net_check;
    tokio::spawn(async move {
        let (fw, vms) = watch;
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = tick.tick() => {}
                _ = fw.alarm.notified() => {}
            }
            if fw.is_closed() {
                break;
            }
            if fw.ensure().await.is_err() && !fw.is_closed() {
                // Cut off at once (taps down), then stopped in a task of its own so the checks
                // go on meanwhile: gracefully (the guest's sync, seconds each) where its tap is
                // confirmed down, killed at once where it isn't. sandboxd keeps running, and
                // refusing boots, so the runner can report the state.
                let down = net::taps_down().await;
                if !down.errors.is_empty() {
                    eprintln!("sandboxd: ALERT: {}; their VMs are killed now, without a sync", down.errors.join("; "));
                }
                // On every failed check, not only the first: a tap that fails to go down later
                // is still acted on (its kill needs no lock), and a VM a stop is already
                // under way for is found stopped once that stop is done.
                if vms.running_count().await > 0 {
                    eprintln!("sandboxd: ALERT: the network rules are gone; stopping every running VM (killed where its tap isn't confirmed down)");
                    let vms = vms.clone();
                    tokio::spawn(async move { vms.fail_closed(&down).await });
                }
            }
        }
    });
    // Mirrors of the repos published from here; the dot keeps them out of the sandbox list.
    let publisher = Arc::new(publish::Publisher::new(cfg.state_dir.join(".mirrors"), cfg.github_url.clone(), git_jail).with_policy(cfg.mirrors.clone()));

    // Every mirror measured before any job is taken, so the quotas count them all.
    let inventory = publisher.clone();
    let _ = tokio::task::spawn_blocking(move || inventory.inventory()).await;
    // The mirrors' upkeep (publish/upkeep.rs): at start, then every few minutes.
    let upkeep = publisher.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(MIRROR_UPKEEP_EVERY);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tick.tick().await;
            upkeep.maintain().await;
        }
    });

    let reaper = vms.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            reaper.reap().await;
        }
    });

    // On SIGTERM/SIGINT: stop taking work, give what's in flight SHUTDOWN_GRACE, then
    // stop the VMs anyway. A 10-minute command must not hold the service past systemd's
    // stop timeout.
    let signalled = Arc::new(tokio::sync::Notify::new());
    let shutdown = {
        let signalled = signalled.clone();
        async move {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            signalled.notify_one();
        }
    };

    match &cfg.mode {
        config::Mode::Runner { app_url, token, name, transport } => {
            eprintln!("sandboxd: runner {name} for {app_url} ({transport:?}; up to {} VMs, idle stop after {} s)", cfg.max_vms, cfg.idle.as_secs());
            let runner = runner::Runner::new(vms.clone(), publisher.clone(), app_url.clone(), token.clone(), name.clone(), *transport, cfg.state_dir.join(".runner-jobs"));
            tokio::select! {
                _ = runner.run() => {}
                _ = shutdown => {}
            }
            // No new jobs now; let the running ones finish, within the grace.
            let deadline = tokio::time::Instant::now() + SHUTDOWN_GRACE;
            while vms.in_flight().await > 0 && tokio::time::Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
        config::Mode::Serve { listen, token } => {
            let app = App { vms: vms.clone(), publisher: publisher.clone(), token_digest: digest(token) };
            let v1 = Router::new()
                .route("/v1/sandboxes", get(list))
                .route("/v1/sandboxes/{id}", axum::routing::delete(destroy))
                .route("/v1/sandboxes/{id}/exec", post(exec))
                .route("/v1/sandboxes/{id}/file", get(read_file).put(write_file))
                .route("/v1/sandboxes/{id}/jobs", post(job_start))
                .route("/v1/sandboxes/{id}/jobs/{job}", get(job_status))
                .route("/v1/sandboxes/{id}/jobs/{job}/cancel", post(job_cancel))
                .route("/v1/sandboxes/{id}/stage", post(stage))
                .route("/v1/sandboxes/{id}/push", post(push))
                .layer(middleware::from_fn_with_state(app.clone(), auth));
            let router = Router::new()
                .route("/healthz", get(|| async { "ok" }))
                .merge(v1)
                .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
                .with_state(app);
            let listener = match tokio::net::TcpListener::bind(listen).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!("sandboxd: listen {listen}: {e}");
                    fw.close().await;
                    net::teardown_all().await;
                    std::process::exit(1);
                }
            };
            eprintln!("sandboxd: listening on {listen} (up to {} VMs, idle stop after {} s)", cfg.max_vms, cfg.idle.as_secs());
            let serve = axum::serve(listener, router).with_graceful_shutdown(shutdown);
            let grace = async {
                signalled.notified().await;
                tokio::time::sleep(SHUTDOWN_GRACE).await;
                eprintln!("sandboxd: requests still running after {} s; stopping anyway", SHUTDOWN_GRACE.as_secs());
            };
            tokio::select! {
                _ = serve => {}
                _ = grace => {}
            }
        }
    }
    eprintln!("sandboxd: stopping every VM (disks kept)");
    fw.close().await;
    vms.stop_all().await;
    net::teardown_all().await;
}

#[cfg(test)]
mod tests {
    use axum::{
        extract::{Path, RawQuery},
        http::Method,
        response::IntoResponse,
        routing::{get, post},
        Router,
    };
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// The serve API's job routes, each answering with the guestd call it would forward
    /// (forward itself needs a VM), and one raw HTTP request to them: status and body.
    async fn job_route(method: &str, target: &str) -> (u16, String) {
        let to_guest = |m: Method| move |Path((_id, job)): Path<(String, String)>, RawQuery(q): RawQuery| async move {
            match super::job_guest_path(&m, &job, if m == Method::POST { None } else { q }) {
                Ok(path) => format!("{m} {path}").into_response(),
                Err(why) => super::error(400, why),
            }
        };
        let app = Router::new()
            .route("/v1/sandboxes/{id}/jobs/{job}", get(to_guest(Method::GET)))
            .route("/v1/sandboxes/{id}/jobs/{job}/cancel", post(to_guest(Method::POST)));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(format!("{method} {target} HTTP/1.1\r\nhost: x\r\ncontent-length: 0\r\nconnection: close\r\n\r\n").as_bytes()).await.unwrap();
        let mut reply = String::new();
        s.read_to_string(&mut reply).await.unwrap();
        let status = reply[9..12].parse().unwrap();
        (status, reply.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default())
    }

    #[tokio::test]
    async fn a_job_route_forwards_its_own_method_and_refuses_an_encoded_slash() {
        assert_eq!(job_route("GET", "/v1/sandboxes/s/jobs/bench-1?waitMs=5").await, (200, "GET /jobs/bench-1?waitMs=5".into()));
        assert_eq!(job_route("POST", "/v1/sandboxes/s/jobs/bench-1/cancel").await, (200, "POST /jobs/bench-1/cancel".into()));
        // Axum decodes %2F inside {job}: a status must not become a cancel, nor reach another route.
        for (m, t) in [
            ("GET", "/v1/sandboxes/s/jobs/bench-1%2Fcancel"),
            ("GET", "/v1/sandboxes/s/jobs/bench-1%2fcancel"),
            ("POST", "/v1/sandboxes/s/jobs/bench-1%2Fcancel/cancel"),
            ("GET", "/v1/sandboxes/s/jobs/..%2F..%2Fexec"),
        ] {
            let (status, body) = job_route(m, t).await;
            assert_eq!(status, 400, "{m} {t}: {body}");
            assert!(body.contains("bad job id"), "{m} {t}: {body}");
        }
    }
}
