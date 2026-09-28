//! Runner mode: connect out to Lorehouse and ask for work (docs/sandbox-runners.md).
//!
//! The host holds no open port. Over WebSocket, jobs are pushed as they come; over long
//! poll, each POST /runners/poll is held until there's work. `auto` tries WebSocket and
//! falls back to long poll when the upgrade is refused (a 426, or a proxy that strips
//! it). Either way a lost connection is retried with backoff, and jobs run concurrently.

use crate::config::Transport;
use crate::vm::{self, Manager};
use crate::vsock;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use hyper::Method;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Deserialize, Debug)]
struct Job {
    id: String,
    sandbox: String,
    op: String,
    method: Option<String>,
    path: Option<String>,
    #[serde(rename = "bodyBase64")]
    body_base64: Option<String>,
}

#[derive(Serialize, Debug)]
struct JobResult {
    id: String,
    status: u16,
    #[serde(rename = "contentType", skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(rename = "bodyBase64", skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl JobResult {
    fn error(id: &str, status: u16, msg: impl Into<String>) -> JobResult {
        JobResult { id: id.to_string(), status, content_type: None, body_base64: None, error: Some(msg.into()) }
    }
}

/// Only these guest calls are run, whatever a job asks for.
fn allowed(method: &str, path: &str) -> Option<Method> {
    let (route, _) = path.split_once('?').unwrap_or((path, ""));
    match (method, route) {
        ("POST", "/exec") => Some(Method::POST),
        ("GET", "/file") if path.starts_with("/file?") => Some(Method::GET),
        ("PUT", "/file") if path.starts_with("/file?") => Some(Method::PUT),
        _ => None,
    }
}

async fn execute(vms: &Manager, job: Job) -> JobResult {
    if !vm::valid_id(&job.sandbox) {
        return JobResult::error(&job.id, 400, "bad sandbox id");
    }
    match job.op.as_str() {
        "destroy" => match vms.destroy(&job.sandbox).await {
            Ok(()) => JobResult { id: job.id, status: 204, content_type: None, body_base64: None, error: None },
            Err(e) => JobResult::error(&job.id, 409, e),
        },
        "guest" => {
            let (m, p) = (job.method.as_deref().unwrap_or(""), job.path.as_deref().unwrap_or(""));
            let Some(method) = allowed(m, p) else { return JobResult::error(&job.id, 400, format!("guest call not allowed: {m} {p}")) };
            let body = match job.body_base64.as_deref().map(|b| B64.decode(b)) {
                None => Bytes::new(),
                Some(Ok(b)) => Bytes::from(b),
                Some(Err(_)) => return JobResult::error(&job.id, 400, "bodyBase64 is not base64"),
            };
            let (_use, uds) = match vms.acquire(&job.sandbox).await {
                Ok(v) => v,
                Err((status, msg)) => return JobResult::error(&job.id, status, msg),
            };
            // The same host-side backstop as serve mode: the guest can't hold a job forever.
            match tokio::time::timeout(crate::REQUEST_DEADLINE, vsock::request(&uds, method, p, body)).await {
                Ok(Ok(r)) => JobResult {
                    id: job.id,
                    status: r.status.as_u16(),
                    content_type: r.content_type,
                    body_base64: Some(B64.encode(&r.body)),
                    error: None,
                },
                Ok(Err(e)) => JobResult::error(&job.id, 502, e),
                Err(_) => JobResult::error(&job.id, 504, format!("the guest didn't answer within {} s", crate::REQUEST_DEADLINE.as_secs())),
            }
        }
        other => JobResult::error(&job.id, 400, format!("unknown op {other:?}")),
    }
}

async fn status_json(vms: &Manager, name: &str) -> serde_json::Value {
    serde_json::json!({ "type": "status", "runner": name, "capacity": vms.capacity(), "running": vms.running_count().await, "version": VERSION })
}

pub struct Runner {
    pub vms: Arc<Manager>,
    pub app_url: String,
    pub token: String,
    pub name: String,
    pub transport: Transport,
}

enum WsEnd {
    /// The server doesn't take WebSocket here: long poll instead.
    Refused(String),
    /// The connection dropped or failed: retry.
    Lost(String),
}

impl Runner {
    pub async fn run(self: Arc<Self>) {
        let mut use_ws = self.transport != Transport::Poll;
        let mut backoff = Duration::from_secs(1);
        loop {
            let started = tokio::time::Instant::now();
            let why = if use_ws {
                match self.clone().ws_session().await {
                    WsEnd::Refused(why) if self.transport == Transport::Auto => {
                        eprintln!("sandboxd: WebSocket refused ({why}); using long poll");
                        use_ws = false;
                        continue;
                    }
                    WsEnd::Refused(why) | WsEnd::Lost(why) => why,
                }
            } else {
                self.clone().poll_session().await
            };
            // A session that held for a while was healthy: start the backoff over.
            if started.elapsed() > Duration::from_secs(60) {
                backoff = Duration::from_secs(1);
            }
            eprintln!("sandboxd: connection to {} lost: {why}; retrying in {} s", self.app_url, backoff.as_secs());
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(Duration::from_secs(30));
        }
    }

    /// One WebSocket connection, until it ends.
    async fn ws_session(self: Arc<Self>) -> WsEnd {
        let url = format!("{}/runners/connect", self.app_url.replacen("http", "ws", 1));
        let mut req = match url.into_client_request() {
            Ok(r) => r,
            Err(e) => return WsEnd::Lost(e.to_string()),
        };
        let (Ok(auth), Ok(name)) = (HeaderValue::from_str(&format!("Bearer {}", self.token)), HeaderValue::from_str(&self.name)) else {
            return WsEnd::Lost("token or runner name isn't a valid header value".into());
        };
        req.headers_mut().insert("authorization", auth);
        req.headers_mut().insert("x-lorehouse-runner", name);
        let (socket, _) = match tokio_tungstenite::connect_async(req).await {
            Ok(s) => s,
            Err(tokio_tungstenite::tungstenite::Error::Http(res)) => {
                let code = res.status().as_u16();
                // 401 is a wrong token, not a transport problem: don't fall back, say so.
                if code == 401 {
                    return WsEnd::Lost("401: SANDBOXD_RUNNER_TOKEN doesn't match the app's SANDBOX_RUNNER_TOKEN".into());
                }
                return WsEnd::Refused(format!("HTTP {code}"));
            }
            Err(e) => return WsEnd::Lost(e.to_string()),
        };
        eprintln!("sandboxd: connected to {} over WebSocket as {}", self.app_url, self.name);
        let (mut sink, mut stream) = socket.split();
        let (out, mut out_rx) = mpsc::channel::<Message>(64);
        // One writer: status every 20 s, and results as jobs finish.
        let writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });
        let ticker = {
            let (me, out) = (self.clone(), out.clone());
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(20));
                loop {
                    tick.tick().await;
                    let s = status_json(&me.vms, &me.name).await.to_string();
                    if out.send(Message::text(s)).await.is_err() {
                        break;
                    }
                }
            })
        };
        let end = loop {
            match stream.next().await {
                Some(Ok(Message::Text(t))) => {
                    #[derive(Deserialize)]
                    struct Frame {
                        #[serde(rename = "type")]
                        kind: String,
                        job: Option<Job>,
                    }
                    let Ok(Frame { kind, job: Some(job) }) = serde_json::from_str::<Frame>(&t) else { continue };
                    if kind != "job" {
                        continue;
                    }
                    let (vms, out) = (self.vms.clone(), out.clone());
                    tokio::spawn(async move {
                        let result = execute(&vms, job).await;
                        let frame = serde_json::json!({ "type": "result", "result": result }).to_string();
                        let _ = out.send(Message::text(frame)).await;
                    });
                }
                Some(Ok(Message::Close(_))) | None => break "closed by the app".to_string(),
                Some(Ok(_)) => {}
                Some(Err(e)) => break e.to_string(),
            }
        };
        ticker.abort();
        drop(out);
        writer.abort();
        WsEnd::Lost(end)
    }

    /// Long poll until an error, which it returns. Each poll is held by the app up to ~25 s.
    async fn poll_session(self: Arc<Self>) -> String {
        match self.poll_loop().await {
            Ok(never) => match never {},
            Err(e) => e,
        }
    }

    async fn poll_loop(self: Arc<Self>) -> Result<std::convert::Infallible, String> {
        let http = reqwest::Client::builder().timeout(Duration::from_secs(40)).build().map_err(|e| e.to_string())?;
        let auth = format!("Bearer {}", self.token);
        eprintln!("sandboxd: polling {} as {}", self.app_url, self.name);
        loop {
            let res = http
                .post(format!("{}/runners/poll", self.app_url))
                .header("authorization", &auth)
                .header("x-lorehouse-runner", &self.name)
                .json(&status_json(&self.vms, &self.name).await)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("poll: HTTP {}", res.status().as_u16()));
            }
            #[derive(Deserialize)]
            struct Batch {
                jobs: Vec<Job>,
            }
            let batch: Batch = res.json().await.map_err(|e| format!("poll body: {e}"))?;
            for job in batch.jobs {
                let (me, http, auth) = (self.clone(), http.clone(), auth.clone());
                tokio::spawn(async move {
                    let result = execute(&me.vms, job).await;
                    let body = serde_json::json!({ "results": [result] });
                    for attempt in 0..3 {
                        let sent = http
                            .post(format!("{}/runners/results", me.app_url))
                            .header("authorization", &auth)
                            .header("x-lorehouse-runner", &me.name)
                            .json(&body)
                            .send()
                            .await;
                        if matches!(&sent, Ok(r) if r.status().is_success()) {
                            return;
                        }
                        tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                    }
                    eprintln!("sandboxd: couldn't deliver a result to {}", me.app_url);
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::allowed;

    #[test]
    fn only_the_three_guest_calls_are_allowed() {
        assert!(allowed("POST", "/exec").is_some());
        assert!(allowed("GET", "/file?path=%2Fw%2Fa").is_some());
        assert!(allowed("PUT", "/file?path=%2Fw%2Fa").is_some());
        assert!(allowed("GET", "/exec").is_none());
        assert!(allowed("DELETE", "/file?path=x").is_none());
        assert!(allowed("GET", "/file").is_none()); // no path given
        assert!(allowed("GET", "/healthz").is_none());
        assert!(allowed("POST", "/exec/../admin").is_none());
    }
}
