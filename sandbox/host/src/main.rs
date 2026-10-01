//! sandboxd — Lorehouse's sandbox host daemon.
//!
//! One Firecracker microVM per sandbox id (Lorehouse uses one per Slack thread), behind
//! the API src/sandbox-client.ts speaks:
//!
//!   POST   /v1/sandboxes/{id}/exec   {command, cwd, env, timeoutMs} → {exitCode, stdout, stderr}
//!   GET    /v1/sandboxes/{id}/file?path=…                         → bytes (404 if absent)
//!   PUT    /v1/sandboxes/{id}/file?path=…                         → 204
//!   DELETE /v1/sandboxes/{id}                                     → 204 (VM stopped, disk gone)
//!   GET    /v1/sandboxes                                          → what exists, running or not
//!   POST   /v1/sandboxes/{id}/stage  {owner, name, base, token?} → the commits to publish, verified
//!   POST   /v1/sandboxes/{id}/push   {owner, name, sha, branch, token} → pushed (see publish.rs)
//!   GET    /healthz                                               → ok (no auth)
//!
//! Every /v1 request needs `Authorization: Bearer <SANDBOXD_TOKEN>`. Requests for a
//! stopped sandbox boot it first; idle ones are stopped with their disk kept.

mod config;
mod net;
mod publish;
mod runner;
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

async fn push(State(app): State<App>, Json(req): Json<publish::PushRequest>) -> Response {
    match app.publisher.push(req).await {
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
        eprintln!("sandboxd: state dir {}: {e}", cfg.state_dir.display());
        std::process::exit(1);
    }
    // Start clean: whatever a previous run left (a crash, a kill) is removed first, VMMs
    // before their taps, and before any request can boot a disk one of them still holds.
    vm::stop_stale_vmms(&cfg.state_dir).await;
    net::teardown_all().await;
    if let Err(e) = net::setup(&cfg.uplink).await {
        eprintln!("sandboxd: network setup: {e}");
        net::teardown_all().await;
        std::process::exit(1);
    }

    let vms = Manager::new(cfg.clone());
    // Mirrors of the repos published from here; the dot keeps them out of the sandbox list.
    let publisher = Arc::new(publish::Publisher::new(cfg.state_dir.join(".mirrors"), cfg.github_url.clone()));

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
    vms.stop_all().await;
    net::teardown_all().await;
}
