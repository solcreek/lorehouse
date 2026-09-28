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
//!   GET    /healthz                                               → ok (no auth)
//!
//! Every /v1 request needs `Authorization: Bearer <SANDBOXD_TOKEN>`. Requests for a
//! stopped sandbox boot it first; idle ones are stopped with their disk kept.

mod config;
mod net;
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
use subtle::ConstantTimeEq;
use vm::Manager;

#[derive(Clone)]
struct App {
    vms: Arc<Manager>,
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
    match vsock::request(&uds, method, &guest_path, body).await {
        Ok(reply) => {
            let mut headers = HeaderMap::new();
            if let Some(ct) = reply.content_type.and_then(|v| v.parse().ok()) {
                headers.insert(header::CONTENT_TYPE, ct);
            }
            (reply.status, headers, reply.body).into_response()
        }
        Err(e) => error(502, e),
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
    let app = App { vms: vms.clone(), token_digest: digest(&cfg.token) };

    let reaper = vms.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        loop {
            tick.tick().await;
            reaper.reap().await;
        }
    });

    let v1 = Router::new()
        .route("/v1/sandboxes", get(list))
        .route("/v1/sandboxes/{id}", axum::routing::delete(destroy))
        .route("/v1/sandboxes/{id}/exec", post(exec))
        .route("/v1/sandboxes/{id}/file", get(read_file).put(write_file))
        .layer(middleware::from_fn_with_state(app.clone(), auth));
    let router = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .merge(v1)
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024 * 1024))
        .with_state(app);

    let listener = match tokio::net::TcpListener::bind(&cfg.listen).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("sandboxd: listen {}: {e}", cfg.listen);
            net::teardown_all().await;
            std::process::exit(1);
        }
    };
    eprintln!("sandboxd: listening on {} (up to {} VMs, idle stop after {} s)", cfg.listen, cfg.max_vms, cfg.idle.as_secs());

    let shutdown = async {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    };
    let _ = axum::serve(listener, router).with_graceful_shutdown(shutdown).await;
    eprintln!("sandboxd: stopping every VM (disks kept)");
    vms.stop_all().await;
    net::teardown_all().await;
}
