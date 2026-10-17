//! How publishing's git reaches the remote (GitHub): only through sandboxd.
//!
//! A run that fetches from or pushes to the remote has no network of its own (gitjail.rs):
//! its network namespace holds one listener, served here, and git's remote URL is
//! `http://127.0.0.1:<port>/<owner>/<name>.git`. sandboxd forwards what git asks to the
//! remote over its own HTTPS, after checking it:
//!
//! - **One repo, one direction.** A fetch run may use that repo's upload-pack (the info/refs
//!   advertisement and the POST), a push run its receive-pack, and nothing else: no other
//!   path, repo, host or service.
//! - **The token is added here,** as the Authorization header of the forwarded request. It
//!   never reaches git: not in its environment, its config or a file, so a git that a VM's
//!   objects compromised (they are parsed again when a push packs them) has no token to
//!   steal.
//! - **A push updates exactly what its stage recorded.** Its request must hold exactly one
//!   command, `<old> <new> refs/heads/<branch>`, where new is the staged commit and old is
//!   what the branch was when sandboxd read the remote's refs itself, before the run, and
//!   checked that the push is a fast-forward (publish.rs, push). A git that sends anything
//!   else, another branch or a forced update, is refused before anything is forwarded.
//!
//! What comes back from the remote is passed through as it comes. A file:// remote (testing
//! without GitHub) needs none of this: its repository is bound into the run (gitjail::Net::Dir).

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bytes::Bytes;
use http_body_util::BodyExt;
use hyper::{header, Method, Request, Response};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// The most of a fetch's request git may send (its wants and haves).
const MAX_FETCH_REQUEST: usize = 16 << 20;
/// The most of a push's request git may send: the pack of the staged commits, which came
/// out of the VM as a bundle of at most MAX_BUNDLE.
const MAX_PUSH_REQUEST: usize = (super::MAX_BUNDLE as usize) + (32 << 20);
/// The most of the remote's ref advertisement sandboxd reads itself (push's pre-check).
const MAX_ADVERTISEMENT: usize = 64 << 20;
/// What git sends that is forwarded; nothing else of its request is.
const FORWARDED: [header::HeaderName; 4] = [header::CONTENT_TYPE, header::ACCEPT, header::USER_AGENT, header::HeaderName::from_static("git-protocol")];
/// What of the remote's answer goes back to git.
const RETURNED: [header::HeaderName; 3] = [header::CONTENT_TYPE, header::CONTENT_ENCODING, header::CACHE_CONTROL];

/// Where repos are fetched from and pushed to (SANDBOXD_GITHUB_URL).
#[derive(Clone, Debug)]
pub enum Remote {
    /// `https://github.com`, without a trailing slash.
    Http(String),
    /// A directory of bare repos (`file://`), for testing without GitHub.
    File(PathBuf),
}

impl Remote {
    pub fn new(base: &str) -> Remote {
        let base = base.trim_end_matches('/');
        match base.strip_prefix("file://") {
            Some(dir) => Remote::File(dir.into()),
            None => Remote::Http(base.to_string()),
        }
    }
}

/// What one run may do at the remote.
pub enum Access {
    Fetch,
    /// The one ref update the push may send.
    Push { old: String, new: String, refname: String },
}

/// One run's grant: its repo, its token (if any) and what it may do there.
pub struct Grant {
    owner: String,
    name: String,
    token: Option<String>,
    access: Access,
    /// Why the last refused request was refused, for the run's error.
    refused: Mutex<Option<String>>,
}

impl Grant {
    pub fn new(owner: &str, name: &str, token: Option<&str>, access: Access) -> Arc<Grant> {
        Arc::new(Grant { owner: owner.into(), name: name.into(), token: token.map(String::from), access, refused: Mutex::default() })
    }

    /// Why sandboxd refused one of the run's requests, if it did.
    pub fn refused(&self) -> Option<String> {
        self.refused.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }

    fn refuse(&self, status: u16, why: String) -> Response<axum::body::Body> {
        *self.refused.lock().unwrap_or_else(|e| e.into_inner()) = Some(why.clone());
        text(status, why)
    }
}

fn text(status: u16, body: String) -> Response<axum::body::Body> {
    let mut r = Response::new(axum::body::Body::from(body));
    *r.status_mut() = hyper::StatusCode::from_u16(status).unwrap_or(hyper::StatusCode::BAD_GATEWAY);
    r
}

fn basic(token: &str) -> String {
    format!("Basic {}", B64.encode(format!("x-access-token:{token}")))
}

/// The proxy of one run, serving its listener until dropped: then every connection it has
/// open is dropped too, its requests to the remote with them.
pub struct Proxy(tokio::task::JoinHandle<()>);

impl Drop for Proxy {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Serve `listener` (in the run's network namespace) for one run.
pub fn serve(listener: std::net::TcpListener, client: reqwest::Client, base: String, grant: Arc<Grant>) -> std::io::Result<Proxy> {
    listener.set_nonblocking(true)?;
    let listener = tokio::net::TcpListener::from_std(listener)?;
    let task = tokio::spawn(async move {
        // Owned here, so aborting this task drops (aborts) every connection.
        let mut conns = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((stream, _)) = accepted else { break };
                    let (client, base, grant) = (client.clone(), base.clone(), grant.clone());
                    conns.spawn(async move {
                        let service = hyper::service::service_fn(move |req| {
                            let (client, base, grant) = (client.clone(), base.clone(), grant.clone());
                            async move { Ok::<_, std::convert::Infallible>(forward(req, &client, &base, &grant).await) }
                        });
                        let _ = hyper::server::conn::http1::Builder::new().serve_connection(hyper_util::rt::TokioIo::new(stream), service).await;
                    });
                }
                Some(_) = conns.join_next(), if !conns.is_empty() => {}
            }
        }
    });
    Ok(Proxy(task))
}

/// One request of git's: checked against the grant, then forwarded with the token.
async fn forward(req: Request<hyper::body::Incoming>, client: &reqwest::Client, base: &str, grant: &Grant) -> Response<axum::body::Body> {
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(String::from);
    let method = req.method().clone();
    let Some(rest) = path.strip_prefix(&format!("/{}/{}.git/", grant.owner, grant.name)) else {
        return grant.refuse(403, format!("{method} {path}: not this run's repo"));
    };
    let (service, push) = match grant.access {
        Access::Fetch => ("git-upload-pack", false),
        Access::Push { .. } => ("git-receive-pack", true),
    };
    let allowed = match (&method, rest, query.as_deref()) {
        (&Method::GET, "info/refs", Some(q)) => q == format!("service={service}"),
        (&Method::POST, r, None) => r == service,
        _ => false,
    };
    if !allowed {
        return grant.refuse(403, format!("{method} {path}: not what this run may do ({service} only)"));
    }
    if push && req.headers().contains_key(header::CONTENT_ENCODING) {
        return grant.refuse(415, "a push's request is read as sent: no Content-Encoding".into());
    }
    let mut forwarded = reqwest::header::HeaderMap::new();
    for name in FORWARDED.iter().chain(if push { None } else { Some(&header::CONTENT_ENCODING) }) {
        if let Some(v) = req.headers().get(name) {
            forwarded.insert(name.clone(), v.clone());
        }
    }
    let limit = if push { MAX_PUSH_REQUEST } else { MAX_FETCH_REQUEST };
    let body = match http_body_util::Limited::new(req.into_body(), limit).collect().await {
        Ok(b) => b.to_bytes(),
        Err(e) => return grant.refuse(413, format!("the request: {e} (at most {limit} bytes)")),
    };
    if let (&Method::POST, Access::Push { old, new, refname }) = (&method, &grant.access) {
        if let Err(e) = check_push(&body, old, new, refname) {
            return grant.refuse(403, e);
        }
    }
    let url = format!("{base}{path}{}", query.map(|q| format!("?{q}")).unwrap_or_default());
    let mut up = client.request(method, url).headers(forwarded).body(body);
    if let Some(t) = &grant.token {
        up = up.header(header::AUTHORIZATION, basic(t));
    }
    let resp = match up.send().await {
        Ok(r) => r,
        // reqwest's message names the URL, which holds no secret.
        Err(e) => return text(502, format!("the remote: {e}")),
    };
    let mut out = Response::builder().status(resp.status().as_u16());
    for name in &RETURNED {
        if let Some(v) = resp.headers().get(name) {
            out = out.header(name, v);
        }
    }
    let stream = futures_util::stream::unfold(Some(resp), |r| async move {
        let mut r = r?;
        match r.chunk().await {
            Ok(Some(chunk)) => Some((Ok::<Bytes, reqwest::Error>(chunk), Some(r))),
            Ok(None) => None,
            Err(e) => Some((Err(e), None)),
        }
    });
    out.body(axum::body::Body::from_stream(stream)).unwrap_or_else(|e| text(502, format!("the remote's answer: {e}")))
}

/// One pkt-line: its payload (None for a flush-pkt) and what follows it.
fn pkt(buf: &[u8]) -> Result<(Option<&[u8]>, &[u8]), String> {
    let head = buf.get(..4).ok_or("a pkt-line cut short")?;
    let len = std::str::from_utf8(head).ok().and_then(|h| usize::from_str_radix(h, 16).ok()).ok_or("not a pkt-line")?;
    match len {
        0 => Ok((None, &buf[4..])),
        1..=3 => Err(format!("a pkt-line of length {len}")),
        _ => {
            let payload = buf.get(4..len).ok_or("a pkt-line cut short")?;
            Ok((Some(payload), &buf[len..]))
        }
    }
}

/// What receive-pack's request may ask for, beyond its one command.
fn allowed_capability(c: &str) -> bool {
    matches!(c, "report-status" | "report-status-v2" | "side-band-64k" | "side-band" | "quiet" | "atomic" | "ofs-delta") || ["agent=", "object-format=", "session-id="].iter().any(|p| c.starts_with(p))
}

/// A push request (receive-pack's POST body) holds exactly the one command allowed, with
/// only the capabilities a plain push asks for (no push options, no certificate, no
/// shallow lines), then the pack.
pub fn check_push(body: &[u8], old: &str, new: &str, refname: &str) -> Result<(), String> {
    let (first, rest) = pkt(body).map_err(|e| format!("the push request: {e}"))?;
    let line = first.ok_or("the push request has no command")?;
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let (command, caps) = match line.iter().position(|&b| b == 0) {
        Some(nul) => (&line[..nul], &line[nul + 1..]),
        None => (line, &b""[..]),
    };
    let command = std::str::from_utf8(command).map_err(|_| "the push's command isn't text")?;
    let want = format!("{old} {new} {refname}");
    if command != want {
        return Err(format!("the push asked for `{command}`; its stage allows only `{want}`"));
    }
    let caps = std::str::from_utf8(caps).map_err(|_| "the push's capabilities aren't text")?;
    if let Some(c) = caps.split(' ').find(|c| !c.is_empty() && !allowed_capability(c)) {
        return Err(format!("the push asked for {c}, which a push from here never needs"));
    }
    match pkt(rest).map_err(|e| format!("the push request: {e}"))? {
        (None, _) => Ok(()),
        (Some(_), _) => Err("the push asked for more than its one ref update".into()),
    }
}

/// The id `refname` has in a receive-pack ref advertisement (as `GET info/refs` answers it),
/// or None if the remote doesn't have it.
pub fn advertised_id(body: &[u8], refname: &str) -> Result<Option<String>, String> {
    let mut rest = body;
    while !rest.is_empty() {
        let (line, next) = pkt(rest).map_err(|e| format!("the remote's refs: {e}"))?;
        rest = next;
        let Some(line) = line else { continue };
        let line = line.strip_suffix(b"\n").unwrap_or(line);
        let line = line.split(|&b| b == 0).next().unwrap_or_default();
        let Ok(line) = std::str::from_utf8(line) else { continue };
        if line.starts_with('#') {
            continue;
        }
        if let Some((id, name)) = line.split_once(' ') {
            if name == refname {
                return Ok(Some(id.to_string()));
            }
        }
    }
    Ok(None)
}

/// What `refs/heads/<branch>` is at the remote now, read by sandboxd itself (with the
/// push's token) before a push: None if there is no such branch.
pub async fn branch_at(client: &reqwest::Client, base: &str, owner: &str, name: &str, token: &str, refname: &str) -> Result<Option<String>, String> {
    let url = format!("{base}/{owner}/{name}.git/info/refs?service=git-receive-pack");
    let resp = client.get(url).header(header::USER_AGENT, "git/2 (lorehouse-sandboxd)").header(header::AUTHORIZATION, basic(token)).send().await.map_err(|e| format!("reading the remote's branches: {e}"))?;
    let status = resp.status();
    let kind = resp.headers().get(header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    if !status.is_success() || kind != "application/x-git-receive-pack-advertisement" {
        return Err(format!("reading the remote's branches: HTTP {status} ({kind})"));
    }
    let mut resp = resp;
    let mut body = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("reading the remote's branches: {e}"))? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_ADVERTISEMENT {
            return Err(format!("the remote's branches come to over {MAX_ADVERTISEMENT} bytes"));
        }
    }
    advertised_id(&body, refname)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(s: &str) -> Vec<u8> {
        format!("{:04x}{s}", s.len() + 4).into_bytes()
    }

    const OLD: &str = "1111111111111111111111111111111111111111";
    const NEW: &str = "2222222222222222222222222222222222222222";

    fn push_body(command: &str, caps: &str, more: &[&str]) -> Vec<u8> {
        let mut b = line(&format!("{command}\0{caps}\n"));
        for m in more {
            b.extend(line(m));
        }
        b.extend(b"0000PACK....");
        b
    }

    #[test]
    fn a_push_may_send_only_the_one_update_its_stage_recorded() {
        let good = format!("{OLD} {NEW} refs/heads/lorehouse/x");
        let caps = "report-status side-band-64k quiet object-format=sha1 agent=git/2.43.0";
        assert_eq!(check_push(&push_body(&good, caps, &[]), OLD, NEW, "refs/heads/lorehouse/x"), Ok(()));
        // Another branch, another commit, a forced update (another old id), a delete.
        for bad in [format!("{OLD} {NEW} refs/heads/main"), format!("{OLD} {OLD} refs/heads/lorehouse/x"), format!("{NEW} {NEW} refs/heads/lorehouse/x"), format!("{OLD} {} refs/heads/lorehouse/x", "0".repeat(40))] {
            assert!(check_push(&push_body(&bad, caps, &[]), OLD, NEW, "refs/heads/lorehouse/x").is_err(), "{bad}");
        }
        // A second update, push options, a certificate, a shallow line.
        assert!(check_push(&push_body(&good, caps, &[&format!("{OLD} {NEW} refs/heads/main\n")]), OLD, NEW, "refs/heads/lorehouse/x").is_err());
        assert!(check_push(&push_body(&good, "report-status push-options", &[]), OLD, NEW, "refs/heads/lorehouse/x").is_err());
        assert!(check_push(&line("push-cert\0report-status\n"), OLD, NEW, "refs/heads/lorehouse/x").is_err());
        assert!(check_push(&line(&format!("shallow {OLD}\n")), OLD, NEW, "refs/heads/lorehouse/x").is_err());
        // Not pkt-lines at all.
        assert!(check_push(b"PACK", OLD, NEW, "refs/heads/lorehouse/x").is_err());
        assert!(check_push(b"", OLD, NEW, "refs/heads/lorehouse/x").is_err());
        assert!(check_push(b"0000", OLD, NEW, "refs/heads/lorehouse/x").is_err());
    }

    #[test]
    fn the_remotes_branch_is_read_from_its_advertisement() {
        let mut adv = line("# service=git-receive-pack\n");
        adv.extend(b"0000");
        adv.extend(line(&format!("{OLD} refs/heads/main\0report-status delete-refs\n")));
        adv.extend(line(&format!("{NEW} refs/heads/lorehouse/x\n")));
        adv.extend(b"0000");
        assert_eq!(advertised_id(&adv, "refs/heads/lorehouse/x"), Ok(Some(NEW.into())));
        assert_eq!(advertised_id(&adv, "refs/heads/main"), Ok(Some(OLD.into())));
        assert_eq!(advertised_id(&adv, "refs/heads/other"), Ok(None));
        // An empty repo advertises only its capabilities.
        let mut empty = line("# service=git-receive-pack\n");
        empty.extend(b"0000");
        empty.extend(line(&format!("{} capabilities^{{}}\0report-status\n", "0".repeat(40))));
        empty.extend(b"0000");
        assert_eq!(advertised_id(&empty, "refs/heads/main"), Ok(None));
        assert!(advertised_id(b"00", "refs/heads/main").is_err());
    }

    #[test]
    fn a_remote_is_a_url_or_a_directory() {
        assert!(matches!(Remote::new("https://github.com/"), Remote::Http(b) if b == "https://github.com"));
        assert!(matches!(Remote::new("file:///srv/remotes"), Remote::File(d) if d == std::path::Path::new("/srv/remotes")));
    }
}
