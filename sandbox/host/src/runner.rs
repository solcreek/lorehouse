//! Runner mode: connect out to Lorehouse and ask for work (docs/sandbox-runners.md).
//!
//! The host holds no open port. Over WebSocket, jobs are pushed as they come; over long
//! poll, each POST /runners/poll is held until there's work. `auto` tries WebSocket and
//! falls back to long poll when the upgrade is refused (a 426, or a proxy that strips
//! it). Either way a lost connection is retried with backoff, and jobs run concurrently.
//!
//! Delivery (the protocol's "Delivery" section): jobs write files and run commands, so a
//! job id runs once, even if it's handed out again, and a result is kept until it has
//! been delivered, so a connection that drops while a job runs doesn't lose it. The ledger
//! below holds both, across connections.

use crate::config::Transport;
use crate::vm::{self, Manager};
use crate::vsock;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use hyper::Method;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, http::HeaderValue, Message};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How many recent job ids are remembered, so a job handed out again doesn't run twice.
const SEEN_IDS: usize = 2048;
/// How long a finished result is kept for delivery on a later connection, at least: longer
/// for a job whose deadline at Lorehouse is later (see `keep_for`).
const KEEP_RESULTS: Duration = Duration::from_secs(10 * 60);
/// Lorehouse waits for a result until the job's `timeoutMs` plus this (boot time).
const APP_BOOT_SLACK: Duration = Duration::from_secs(60);

#[derive(Deserialize, Debug)]
struct Job {
    id: String,
    sandbox: String,
    op: String,
    method: Option<String>,
    path: Option<String>,
    #[serde(rename = "bodyBase64")]
    body_base64: Option<String>,
    #[serde(rename = "timeoutMs")]
    timeout_ms: Option<u64>,
    /// How long Lorehouse will still wait for this job, as of handing it out.
    #[serde(rename = "deadlineMs")]
    deadline_ms: Option<u64>,
}

/// The guest call stops this much before Lorehouse's deadline, so its answer (a timeout)
/// can still get there.
const DEADLINE_MARGIN: Duration = Duration::from_secs(2);

impl Job {
    /// How long Lorehouse waits for this job from when it arrived here. An older app that
    /// doesn't send `deadlineMs`: its timeout plus boot slack. Neither: the host's backstop.
    fn app_deadline(&self) -> Duration {
        let d = match (self.deadline_ms, self.timeout_ms) {
            (Some(ms), _) => Duration::from_millis(ms),
            (None, Some(ms)) => Duration::from_millis(ms) + APP_BOOT_SLACK,
            (None, None) => crate::REQUEST_DEADLINE,
        };
        d.min(Duration::from_secs(24 * 3600))
    }
}

/// How long to keep a job's result once it's done: past the job's deadline at Lorehouse
/// (counted from when it arrived, so from when it finished is more than enough), and never
/// less than KEEP_RESULTS. Lorehouse still waits for it until then, and a reconnect's `jobs`
/// must still list it.
fn keep_for(app_deadline: Duration) -> Duration {
    (app_deadline + Duration::from_secs(60)).max(KEEP_RESULTS)
}

/// How long the guest call may take, `elapsed` after the job arrived (a boot may have come
/// first): until just before Lorehouse stops waiting, and never past the host's backstop.
/// Zero: don't start it.
fn guest_budget(app_deadline: Duration, elapsed: Duration) -> Duration {
    app_deadline.saturating_sub(DEADLINE_MARGIN).saturating_sub(elapsed).min(crate::REQUEST_DEADLINE)
}

#[derive(Serialize, Debug, Clone, PartialEq)]
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

async fn execute(vms: &Manager, job: Job, arrived: Instant) -> JobResult {
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
            // Bounded by the job's deadline at Lorehouse: once it has told the caller the job
            // timed out, the job must not go on changing the checkout. Dropping the request
            // closes the vsock connection, and guestd stops: an exec's process group is killed
            // with its request's context, and a write whose body didn't all arrive isn't made.
            let budget = guest_budget(job.app_deadline(), arrived.elapsed());
            if budget.is_zero() {
                return JobResult::error(&job.id, 504, "Lorehouse's deadline for this job passed before it could start");
            }
            match tokio::time::timeout(budget, vsock::request(&uds, method, p, body)).await {
                Ok(Ok(r)) => JobResult {
                    id: job.id,
                    status: r.status.as_u16(),
                    content_type: r.content_type,
                    body_base64: Some(B64.encode(&r.body)),
                    error: None,
                },
                Ok(Err(e)) => JobResult::error(&job.id, 502, e),
                Err(_) => JobResult::error(&job.id, 504, format!("stopped: the guest didn't answer within {} s (the job's deadline)", budget.as_secs())),
            }
        }
        other => JobResult::error(&job.id, 400, format!("unknown op {other:?}")),
    }
}

// ── the ledger: which jobs ran, and which results still need delivering ─────────────────

struct Held {
    /// None while the job runs.
    result: Option<JobResult>,
    done_at: Option<Instant>,
    /// How long the result is kept once done.
    keep: Duration,
    /// The connection (session) it was last sent on; 0 = not sent.
    sent_in: u64,
}

#[derive(Default)]
struct Ledger {
    seen: VecDeque<String>,
    seen_set: HashSet<String>,
    held: HashMap<String, Held>,
}

impl Ledger {
    /// Whether to run this job: false for an id already taken (a redelivery).
    fn accept(&mut self, id: &str, keep: Duration) -> bool {
        if self.seen_set.contains(id) {
            return false;
        }
        self.seen.push_back(id.to_string());
        self.seen_set.insert(id.to_string());
        while self.seen.len() > SEEN_IDS {
            if let Some(old) = self.seen.pop_front() {
                self.seen_set.remove(&old);
            }
        }
        self.held.insert(id.to_string(), Held { result: None, done_at: None, keep, sent_in: 0 });
        true
    }

    fn finish(&mut self, result: JobResult, now: Instant) {
        if let Some(h) = self.held.get_mut(&result.id) {
            h.result = Some(result);
            h.done_at = Some(now);
        }
    }

    /// Finished results not yet sent on `session`, marked as sent on it.
    fn take_unsent(&mut self, session: u64) -> Vec<JobResult> {
        let mut out = Vec::new();
        for h in self.held.values_mut() {
            if let Some(r) = &h.result {
                if h.sent_in != session {
                    h.sent_in = session;
                    out.push(r.clone());
                }
            }
        }
        out
    }

    /// Lorehouse confirmed these (an HTTP 204): no need to keep them.
    fn delivered(&mut self, ids: &[String]) {
        for id in ids {
            self.held.remove(id);
        }
    }

    /// Sending these failed: try again.
    fn unsend(&mut self, ids: &[String]) {
        for id in ids {
            if let Some(h) = self.held.get_mut(id) {
                h.sent_in = 0;
            }
        }
    }

    /// Ids held (running, or a result kept for delivery), for the status's `jobs`.
    fn ids(&mut self, now: Instant) -> Vec<String> {
        self.held.retain(|_, h| h.done_at.is_none_or(|t| now.duration_since(t) < h.keep));
        self.held.keys().cloned().collect()
    }
}

// ── the runner ────────────────────────────────────────────────────────────────────────────

pub struct Runner {
    vms: Arc<Manager>,
    app_url: String,
    token: String,
    name: String,
    transport: Transport,
    ledger: Mutex<Ledger>,
    /// Signalled when a job finishes, so its result goes out at once.
    finished: Notify,
    sessions: AtomicU64,
    /// This process, for Lorehouse: an id and its start time (unix ms). Of two processes with
    /// one name, the later-started one is the runner.
    process: String,
    started: u64,
}

enum WsEnd {
    /// The server doesn't take WebSocket here: long poll instead.
    Refused(String),
    /// The connection dropped or failed: retry.
    Lost(String),
}

impl Runner {
    pub fn new(vms: Arc<Manager>, app_url: String, token: String, name: String, transport: Transport) -> Arc<Runner> {
        let started = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        let process = format!("{started:x}-{:x}", std::process::id());
        Arc::new(Runner { vms, app_url, token, name, transport, ledger: Mutex::default(), finished: Notify::new(), sessions: AtomicU64::new(0), process, started })
    }

    fn ledger(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Run a job handed out by Lorehouse, unless this id already ran here.
    fn take(self: &Arc<Self>, job: Job) {
        let arrived = Instant::now();
        if !self.ledger().accept(&job.id, keep_for(job.app_deadline())) {
            return;
        }
        let me = self.clone();
        tokio::spawn(async move {
            let result = execute(&me.vms, job, arrived).await;
            me.ledger().finish(result, Instant::now());
            me.finished.notify_one();
        });
    }

    async fn status_json(&self) -> serde_json::Value {
        let jobs = self.ledger().ids(Instant::now());
        serde_json::json!({ "type": "status", "runner": self.name, "capacity": self.vms.capacity(), "running": self.vms.running_count().await, "version": VERSION, "jobs": jobs, "session": self.process, "started": self.started })
    }

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
        let session = self.sessions.fetch_add(1, Ordering::SeqCst) + 1;
        eprintln!("sandboxd: connected to {} over WebSocket as {}", self.app_url, self.name);
        let (mut sink, mut stream) = socket.split();
        let (out, mut out_rx) = mpsc::channel::<Message>(64);
        // One writer. It ends when a send fails, and the read loop below watches for that:
        // a connection that can no longer be written to must end the session (and
        // reconnect) even if nothing more is read.
        let mut writer = tokio::spawn(async move {
            while let Some(m) = out_rx.recv().await {
                if sink.send(m).await.is_err() {
                    break;
                }
            }
        });
        // Status first (it lists the jobs held, which settles jobs from before a drop),
        // then every 20 s.
        let ticker = {
            let (me, out) = (self.clone(), out.clone());
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs(20));
                loop {
                    tick.tick().await;
                    if out.send(Message::text(me.status_json().await.to_string())).await.is_err() {
                        break;
                    }
                }
            })
        };
        // Results, as jobs finish, including any a dropped connection didn't deliver.
        let flusher = {
            let (me, out) = (self.clone(), out.clone());
            tokio::spawn(async move {
                loop {
                    let ready = me.ledger().take_unsent(session);
                    for result in ready {
                        let frame = serde_json::json!({ "type": "result", "result": result }).to_string();
                        if out.send(Message::text(frame)).await.is_err() {
                            return;
                        }
                    }
                    tokio::select! {
                        _ = me.finished.notified() => {}
                        _ = tokio::time::sleep(Duration::from_secs(5)) => {}
                    }
                }
            })
        };
        let end = loop {
            let next = tokio::select! {
                next = stream.next() => next,
                _ = &mut writer => break "writing to the app failed".to_string(),
            };
            match next {
                Some(Ok(Message::Text(t))) => {
                    #[derive(Deserialize)]
                    struct Frame {
                        #[serde(rename = "type")]
                        kind: String,
                        job: Option<Job>,
                    }
                    let Ok(Frame { kind, job: Some(job) }) = serde_json::from_str::<Frame>(&t) else { continue };
                    if kind == "job" {
                        self.take(job);
                    }
                }
                Some(Ok(Message::Close(_))) | None => break "closed by the app".to_string(),
                Some(Ok(_)) => {}
                Some(Err(e)) => break e.to_string(),
            }
        };
        ticker.abort();
        flusher.abort();
        drop(out);
        writer.abort();
        WsEnd::Lost(end)
    }

    /// Long poll until an error, which it returns. Each poll is held by the app up to ~25 s.
    async fn poll_session(self: Arc<Self>) -> String {
        let session = self.sessions.fetch_add(1, Ordering::SeqCst) + 1;
        let http = match reqwest::Client::builder().timeout(Duration::from_secs(40)).build() {
            Ok(c) => c,
            Err(e) => return e.to_string(),
        };
        // Results go out as jobs finish; a 2xx confirms them, a failure sends them again.
        let poster = {
            let (me, http) = (self.clone(), http.clone());
            tokio::spawn(async move {
                loop {
                    let ready = me.ledger().take_unsent(session);
                    if !ready.is_empty() {
                        let ids: Vec<String> = ready.iter().map(|r| r.id.clone()).collect();
                        let sent = me.post(&http, "/runners/results", &serde_json::json!({ "results": ready })).await;
                        match sent {
                            Ok(res) if res.status().is_success() => me.ledger().delivered(&ids),
                            _ => me.ledger().unsend(&ids),
                        }
                    }
                    tokio::select! {
                        _ = me.finished.notified() => {}
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                    }
                }
            })
        };
        let err = self.poll_loop(&http).await;
        poster.abort();
        err
    }

    async fn poll_loop(self: &Arc<Self>, http: &reqwest::Client) -> String {
        eprintln!("sandboxd: polling {} as {}", self.app_url, self.name);
        // Ids from the last poll answer received: jobs Lorehouse handed out but that never
        // arrived here are then handed out again.
        let mut received: Vec<String> = Vec::new();
        loop {
            let mut body = self.status_json().await;
            body["received"] = serde_json::json!(received);
            let res = match self.post(http, "/runners/poll", &body).await {
                Ok(r) => r,
                Err(e) => return e.to_string(),
            };
            if !res.status().is_success() {
                return format!("poll: HTTP {}", res.status().as_u16());
            }
            #[derive(Deserialize)]
            struct Batch {
                jobs: Vec<Job>,
            }
            let batch: Batch = match res.json().await {
                Ok(b) => b,
                Err(e) => return format!("poll body: {e}"),
            };
            received = batch.jobs.iter().map(|j| j.id.clone()).collect();
            for job in batch.jobs {
                self.take(job);
            }
        }
    }

    async fn post(&self, http: &reqwest::Client, path: &str, body: &serde_json::Value) -> reqwest::Result<reqwest::Response> {
        http.post(format!("{}{path}", self.app_url))
            .header("authorization", format!("Bearer {}", self.token))
            .header("x-lorehouse-runner", &self.name)
            .json(body)
            .send()
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::{allowed, guest_budget, keep_for, Job, JobResult, Ledger, KEEP_RESULTS, SEEN_IDS};
    use std::time::{Duration, Instant};

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

    fn done(id: &str) -> JobResult {
        JobResult { id: id.into(), status: 200, content_type: None, body_base64: None, error: None }
    }

    #[test]
    fn a_job_handed_out_again_runs_once() {
        let mut l = Ledger::default();
        assert!(l.accept("j1", KEEP_RESULTS));
        assert!(!l.accept("j1", KEEP_RESULTS));
        // the memory is bounded, oldest first
        for i in 0..SEEN_IDS {
            l.accept(&format!("x{i}"), KEEP_RESULTS);
        }
        assert!(l.accept("j1", KEEP_RESULTS));
    }

    #[test]
    fn a_result_goes_out_once_per_connection_and_again_on_the_next() {
        let mut l = Ledger::default();
        let now = Instant::now();
        l.accept("j1", KEEP_RESULTS);
        assert!(l.take_unsent(1).is_empty()); // still running
        l.finish(done("j1"), now);
        assert_eq!(l.take_unsent(1), vec![done("j1")]);
        assert!(l.take_unsent(1).is_empty()); // not twice on one connection
        assert_eq!(l.take_unsent(2), vec![done("j1")]); // but again on a new one
        l.unsend(&["j1".into()]);
        assert_eq!(l.take_unsent(2), vec![done("j1")]); // a failed send retries
        l.delivered(&["j1".into()]);
        assert!(l.take_unsent(3).is_empty()); // confirmed: gone
    }

    #[test]
    fn held_ids_list_running_jobs_and_kept_results_until_they_expire() {
        let mut l = Ledger::default();
        let now = Instant::now();
        l.accept("running", KEEP_RESULTS);
        l.accept("finished", KEEP_RESULTS);
        l.finish(done("finished"), now);
        let mut ids = l.ids(now);
        ids.sort();
        assert_eq!(ids, vec!["finished", "running"]);
        assert_eq!(l.ids(now + KEEP_RESULTS + Duration::from_secs(1)), vec!["running"]);
    }

    #[test]
    fn a_result_is_kept_past_its_jobs_deadline_at_the_app() {
        // A 10-minute job Lorehouse waits 11 minutes for: finished at once, its result must
        // still be held (and listed) at 10.5 minutes.
        let keep = keep_for(job(None, Some(10 * 60 * 1000)).app_deadline());
        assert!(keep > Duration::from_secs(11 * 60));
        let mut l = Ledger::default();
        let now = Instant::now();
        l.accept("long", keep);
        l.finish(done("long"), now);
        assert_eq!(l.ids(now + Duration::from_secs(10 * 60 + 30)), vec!["long"]);
        assert!(l.ids(now + keep + Duration::from_secs(1)).is_empty());
        // short jobs keep the floor; no deadline or timeout means the host's backstop
        assert_eq!(keep_for(job(Some(30_000), None).app_deadline()), KEEP_RESULTS);
        assert!(keep_for(job(None, None).app_deadline()) > crate::REQUEST_DEADLINE);
    }

    fn job(deadline_ms: Option<u64>, timeout_ms: Option<u64>) -> Job {
        Job { id: "j".into(), sandbox: "s".into(), op: "guest".into(), method: None, path: None, body_base64: None, timeout_ms, deadline_ms }
    }

    #[test]
    fn a_guest_call_stops_just_before_lorehouse_stops_waiting() {
        // A file write Lorehouse waits 90 s for (30 s + boot slack), just handed out.
        let deadline = job(Some(90_000), Some(30_000)).app_deadline();
        assert_eq!(guest_budget(deadline, Duration::from_secs(0)), Duration::from_secs(88));
        // a 20 s boot came first: less is left for the call itself
        assert_eq!(guest_budget(deadline, Duration::from_secs(20)), Duration::from_secs(68));
        // the deadline passed while it booted: the call isn't made
        assert!(guest_budget(deadline, Duration::from_secs(89)).is_zero());
        // never past the host's backstop
        assert_eq!(guest_budget(Duration::from_secs(3600), Duration::ZERO), crate::REQUEST_DEADLINE);
        // an app that sends no deadlineMs: timeout plus boot slack
        assert_eq!(job(None, Some(30_000)).app_deadline(), Duration::from_secs(90));
    }
}
