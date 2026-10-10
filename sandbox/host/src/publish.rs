//! Publishing: the agent's commits leave the sandbox without a write token ever entering it
//! (docs/sandbox-runners.md, "Publishing").
//!
//! stage, before a human approves: the VM bundles the commits it has that GitHub doesn't.
//! The host reads that bundle and verifies it into a bare mirror of the repo: fsck on, one
//! ref, no tags. What the approval shows (the diff, the authors) is computed from the mirror,
//! never from anything the VM reports.
//!
//! push, after: the host pushes exactly the staged commit from the mirror to one branch with
//! the write token, never forced. The VM takes no part.
//!
//! Every git command here runs with no user or system config, no prompts, no replace objects
//! and no hooks. A token travels as an HTTP header in the command's environment, never in
//! argv or a file.

use crate::vm::{self, Manager};
use crate::vsock;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use bytes::Bytes;
use hyper::Method;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::Command;

/// The bundle comes out of the VM in parts, each under guestd's 16 MiB file limit.
const PART: u64 = 12 << 20;
/// The most a stage reads out of a VM.
pub const MAX_BUNDLE: u64 = 96 << 20;
/// How much of the patch the approval gets, at most.
const MAX_PATCH: usize = 64 << 10;
/// Staged refs nobody pushed are dropped after this.
const STAGE_TTL: Duration = Duration::from_secs(24 * 3600);
const GIT_LOCAL: Duration = Duration::from_secs(120);
const GIT_NETWORK: Duration = Duration::from_secs(600);
/// Where the checkout lives in every VM (Lorehouse's WORKDIR).
const WORKDIR: &str = "/workspace/repo";

#[derive(Deserialize)]
pub struct StageRequest {
    pub owner: String,
    pub name: String,
    /// The branch the commits are to be compared with (and the pull request is opened against).
    pub base: String,
    /// A read token for the repo; none for a public one.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Staged {
    pub sha: String,
    #[serde(rename = "baseSha")]
    pub base_sha: String,
    pub commits: usize,
    pub stat: String,
    /// "author <email>|committer <email>", one per commit.
    pub authors: Vec<String>,
    pub files: Vec<String>,
    pub patch: String,
    #[serde(rename = "patchTruncated")]
    pub patch_truncated: bool,
}

#[derive(Deserialize)]
pub struct PushRequest {
    pub owner: String,
    pub name: String,
    pub sha: String,
    pub branch: String,
    pub token: String,
}

#[derive(Serialize, Debug)]
pub struct Pushed {
    pub sha: String,
    pub branch: String,
}

/// An HTTP-like status and a message for Lorehouse (and the model) to read.
pub type Failure = (u16, String);

pub struct Publisher {
    mirrors: PathBuf,
    /// https://github.com in production; a file:// directory in tests.
    remote_base: String,
    /// REVIEW_CAP; smaller in tests.
    review_cap: usize,
    locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
}

fn plain_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && !s.starts_with('.') && !s.contains("..") && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

/// A branch name safe in a refspec (the same rule as Lorehouse's isPlainRef).
pub fn plain_ref(s: &str) -> bool {
    let first_ok = s.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_');
    first_ok
        && s.len() <= 200
        && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"_./-".contains(&b))
        && !s.contains("..")
        && !s.contains("//")
        && !s.ends_with('/')
        && !s.ends_with(".lock")
}

fn commit_id(s: &str) -> bool {
    (s.len() == 40 || s.len() == 64) && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn tail(s: &[u8]) -> String {
    let s = String::from_utf8_lossy(s);
    let s = s.trim();
    let start = s.char_indices().rev().nth(500).map_or(0, |(i, _)| i);
    s[start..].to_string()
}

/// The most of a git command's stdout that is read; past it the command is stopped. The
/// sandbox controls what is diffed, and a small bundle can expand into a huge diff.
const OUTPUT_CAP: usize = 16 << 20;
/// The most of each fact the approval shows (stat, files, authors) that a stage reads.
const REVIEW_CAP: usize = 1 << 20;
/// The most of a git command's stderr that is kept.
const STDERR_CAP: u64 = 64 << 10;

/// One git command, in `dir`, in the guarded environment; its stdout, which must fit
/// OUTPUT_CAP.
async fn git(dir: &Path, args: &[&str], token: Option<&str>, limit: Duration) -> Result<String, String> {
    match git_capped(dir, args, token, limit, OUTPUT_CAP).await? {
        (out, false) => Ok(out),
        (_, true) => Err(format!("git {}: more than {OUTPUT_CAP} bytes of output", args[0])),
    }
}

/// One git command, in `dir`, in the guarded environment; at most `cap` bytes of its stdout,
/// and whether there was more (the command is stopped there, never read to the end).
async fn git_capped(dir: &Path, args: &[&str], token: Option<&str>, limit: Duration, cap: usize) -> Result<(String, bool), String> {
    use std::process::Stdio;
    use tokio::io::AsyncReadExt;
    let mut cmd = Command::new("git");
    cmd.arg("-C").arg(dir).args(args);
    cmd.env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_else(|| "/usr/bin:/bin".into()))
        .env("HOME", dir)
        .env("LC_ALL", "C")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
    let mut config: Vec<(&str, String)> = vec![
        ("core.hooksPath", "/dev/null".into()),
        ("fetch.fsckObjects", "true".into()),
        ("transfer.fsckObjects", "true".into()),
        ("credential.helper", String::new()),
    ];
    if let Some(t) = token {
        config.push(("http.extraHeader", format!("Authorization: Basic {}", B64.encode(format!("x-access-token:{t}")))));
    }
    cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
    for (i, (k, v)) in config.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{i}"), k).env(format!("GIT_CONFIG_VALUE_{i}"), v);
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let work = async {
        let mut child = cmd.spawn().map_err(|e| format!("git: {e}"))?;
        let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
            return Err("git: no pipes".to_string());
        };
        // stderr on its own task, so a command stopped for too much stdout isn't left
        // blocked on it; past STDERR_CAP the pipe closes.
        let errors = tokio::spawn(async move {
            let mut err = Vec::new();
            let _ = stderr.take(STDERR_CAP).read_to_end(&mut err).await;
            err
        });
        let mut out = Vec::new();
        stdout.take(cap as u64 + 1).read_to_end(&mut out).await.map_err(|e| format!("git {}: {e}", args[0]))?;
        if out.len() > cap {
            let _ = child.kill().await;
            errors.abort();
            let mut cut = cap;
            while cut > 0 && (out[cut] & 0xC0) == 0x80 {
                cut -= 1;
            }
            out.truncate(cut);
            return Ok((String::from_utf8_lossy(&out).into_owned(), true));
        }
        let status = child.wait().await.map_err(|e| format!("git: {e}"))?;
        let err = errors.await.unwrap_or_default();
        if !status.success() {
            return Err(format!("git {}: {}", args[0], tail(&err)));
        }
        Ok((String::from_utf8_lossy(&out).into_owned(), false))
    };
    match tokio::time::timeout(limit, work).await {
        Err(_) => Err(format!("git {} took over {} s", args[0], limit.as_secs())),
        Ok(r) => r,
    }
}

/// A file removed when this is dropped.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn unix_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Publisher {
    pub fn new(mirrors: PathBuf, remote_base: String) -> Publisher {
        Publisher { mirrors, remote_base: remote_base.trim_end_matches('/').to_string(), review_cap: REVIEW_CAP, locks: Mutex::default() }
    }

    fn mirror(&self, owner: &str, name: &str) -> PathBuf {
        self.mirrors.join(owner).join(format!("{name}.git"))
    }

    fn url(&self, owner: &str, name: &str) -> String {
        format!("{}/{owner}/{name}.git", self.remote_base)
    }

    /// One job at a time per mirror.
    fn lock(&self, dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks.entry(dir.to_path_buf()).or_default().clone()
    }

    /// The mirror, created if new, with GitHub's branches as they are now.
    async fn refresh(&self, dir: &Path, owner: &str, name: &str, token: Option<&str>) -> Result<(), String> {
        if !dir.join("HEAD").exists() {
            tokio::fs::create_dir_all(dir).await.map_err(|e| format!("mirror dir: {e}"))?;
            git(dir, &["init", "-q", "--bare"], None, GIT_LOCAL).await?;
        }
        git(dir, &["fetch", "-q", "--prune", "--no-tags", &self.url(owner, name), "+refs/heads/*:refs/heads/*"], token, GIT_NETWORK).await?;
        Ok(())
    }

    /// Stage the commits the sandbox has that GitHub doesn't: read, verify, describe.
    pub async fn stage(&self, vms: &Manager, sandbox: &str, req: StageRequest) -> Result<Staged, Failure> {
        if !vm::valid_id(sandbox) || !plain_name(&req.owner) || !plain_name(&req.name) || !plain_ref(&req.base) {
            return Err((400, "stage: a plain sandbox id, owner, name and base branch are needed".into()));
        }
        let dir = self.mirror(&req.owner, &req.name);
        let lock = self.lock(&dir);
        let _held = lock.lock().await;
        self.refresh(&dir, &req.owner, &req.name, req.token.as_deref()).await.map_err(|e| (502, format!("updating the mirror of {}/{} from GitHub: {e}", req.owner, req.name)))?;
        let id = format!("{}-{:x}", unix_secs(), SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.subsec_nanos()));
        // Removed however this ends, a deadline that drops this future included.
        let bundle = TempFile(dir.join(format!("stage-{id}.bundle")));
        let read = bundle_from(vms, sandbox, &bundle.0).await;
        let staged = match read {
            Ok(()) => self.stage_bundle(&dir, &bundle.0, &req.base, &id).await,
            Err(e) => Err(e),
        };
        drop(bundle);
        self.prune_stale(&dir).await;
        staged
    }

    /// The host half of stage: fetch a bundle into refs/stage/<id> and describe it against
    /// the base branch. Separate so it can be tested without a VM.
    pub async fn stage_bundle(&self, dir: &Path, bundle: &Path, base: &str, id: &str) -> Result<Staged, Failure> {
        let staged_ref = format!("refs/stage/{id}");
        let bundle = bundle.to_string_lossy();
        // One ref, from the bundle's HEAD; no tags; fsck on (git()). Nothing else in the
        // bundle (tags, replace refs, other branches) can land in the mirror.
        git(dir, &["fetch", "-q", "--no-tags", &bundle, &format!("HEAD:{staged_ref}")], None, GIT_LOCAL)
            .await
            .map_err(|e| (422, format!("the sandbox's commits were refused: {e}")))?;
        let sha = match git(dir, &["rev-parse", "--verify", &format!("{staged_ref}^{{commit}}")], None, GIT_LOCAL).await {
            Ok(sha) => sha.trim().to_string(),
            Err(e) => {
                let _ = git(dir, &["update-ref", "-d", &staged_ref], None, GIT_LOCAL).await;
                return Err((422, format!("the sandbox's HEAD isn't a commit: {e}")));
            }
        };
        // The ref names the commit itself, not a tag that peels to it: push looks it up by
        // the commit id this stage reports.
        git(dir, &["update-ref", &staged_ref, &sha], None, GIT_LOCAL).await.map_err(|e| (500, e))?;
        let base_ref = format!("refs/heads/{base}");
        let Ok(base_sha) = git(dir, &["rev-parse", "--verify", "-q", &format!("{base_ref}^{{commit}}")], None, GIT_LOCAL).await else {
            let _ = git(dir, &["update-ref", "-d", &staged_ref], None, GIT_LOCAL).await;
            return Err((404, format!("the base branch {base} isn't on GitHub")));
        };
        let base_sha = base_sha.trim().to_string();
        let range = format!("{base_sha}..{sha}");
        let three_dot = format!("{base_sha}...{sha}");
        // What the approval shows, each read only so far: all of it, or the stage is refused
        // (a cut list of files or authors would hide what is past the cut).
        let review_cap = self.review_cap;
        let fact = |what: &'static str, args: Vec<&str>| {
            let dir = dir.to_path_buf();
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            async move {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                match git_capped(&dir, &args, None, GIT_LOCAL, review_cap).await {
                    Ok((out, false)) => Ok(out),
                    Ok((_, true)) => Err((413, format!("too much to review: the {what} come to over {review_cap} bytes"))),
                    Err(e) => Err((500, e)),
                }
            }
        };
        let described = async {
            let authors: Vec<String> = fact("authors", vec!["log", "--format=%an <%ae>|%cn <%ce>", &range]).await?.lines().map(String::from).collect();
            let stat = fact("stat", vec!["diff", "--no-ext-diff", "--no-textconv", "--stat", &three_dot]).await?;
            let files: Vec<String> = fact("files", vec!["diff", "--no-ext-diff", "--no-textconv", "--name-only", &three_dot]).await?.lines().map(String::from).collect();
            // The patch is only an excerpt: cut, not refused.
            let (patch, patch_truncated) = git_capped(dir, &["diff", "--no-ext-diff", "--no-textconv", &three_dot], None, GIT_LOCAL, MAX_PATCH).await.map_err(|e| (500, e))?;
            Ok::<_, Failure>((authors, stat, files, patch, patch_truncated))
        };
        let (authors, stat, files, patch, patch_truncated) = match described.await {
            Ok(d) => d,
            Err(e) => {
                let _ = git(dir, &["update-ref", "-d", &staged_ref], None, GIT_LOCAL).await;
                return Err(e);
            }
        };
        if authors.is_empty() {
            let _ = git(dir, &["update-ref", "-d", &staged_ref], None, GIT_LOCAL).await;
            return Err((409, format!("no commits to publish: HEAD has nothing that isn't on {base} already")));
        }
        Ok(Staged { sha, base_sha, commits: authors.len(), stat, authors, files, patch, patch_truncated })
    }

    /// Push a staged commit to one branch: never forced, never anything not staged.
    pub async fn push(&self, req: PushRequest) -> Result<Pushed, Failure> {
        if !plain_name(&req.owner) || !plain_name(&req.name) || !commit_id(&req.sha) || !plain_ref(&req.branch) {
            return Err((400, "push: a plain owner, name, commit id and branch are needed".into()));
        }
        let dir = self.mirror(&req.owner, &req.name);
        let lock = self.lock(&dir);
        let _held = lock.lock().await;
        // Only what a stage produced (what an approval was about) goes out, and only while
        // it is fresh: an expired stage is dropped here, not just at the next stage.
        self.prune_stale(&dir).await;
        let staged = git(&dir, &["for-each-ref", "--format=%(objectname)", "refs/stage/"], None, GIT_LOCAL).await.unwrap_or_default();
        if !staged.lines().any(|l| l == req.sha) {
            return Err((404, format!("{} wasn't staged here; stage it first", req.sha)));
        }
        let refspec = format!("{}:refs/heads/{}", req.sha, req.branch);
        if let Err(e) = git(&dir, &["push", "-q", &self.url(&req.owner, &req.name), &refspec], Some(&req.token), GIT_NETWORK).await {
            let status = if e.contains("non-fast-forward") || e.contains("[rejected]") || e.contains("fetch first") { 409 } else { 502 };
            return Err((status, format!("push to {}: {e}", req.branch)));
        }
        // Pushed: its stage refs are done with.
        for line in git(&dir, &["for-each-ref", "--format=%(objectname) %(refname)", "refs/stage/"], None, GIT_LOCAL).await.unwrap_or_default().lines() {
            if let Some((sha, name)) = line.split_once(' ') {
                if sha == req.sha {
                    let _ = git(&dir, &["update-ref", "-d", name], None, GIT_LOCAL).await;
                }
            }
        }
        let _ = git(&dir, &["gc", "--auto", "-q"], None, GIT_LOCAL).await;
        Ok(Pushed { sha: req.sha, branch: req.branch })
    }

    /// Drop staged refs older than STAGE_TTL (their names start with the unix time).
    async fn prune_stale(&self, dir: &Path) {
        let now = unix_secs();
        for name in git(dir, &["for-each-ref", "--format=%(refname)", "refs/stage/"], None, GIT_LOCAL).await.unwrap_or_default().lines() {
            let secs = name.trim_start_matches("refs/stage/").split('-').next().and_then(|s| s.parse::<u64>().ok());
            if secs.is_some_and(|t| now.saturating_sub(t) > STAGE_TTL.as_secs()) {
                let _ = git(dir, &["update-ref", "-d", name], None, GIT_LOCAL).await;
            }
        }
    }
}

/// Have the VM bundle what it has that GitHub doesn't (HEAD, minus everything reachable from
/// origin's branches), and read the bundle out in parts. The VM is not trusted for any of
/// it: the size is capped here, and the content is verified when it is fetched.
async fn bundle_from(vms: &Manager, sandbox: &str, to: &Path) -> Result<(), Failure> {
    let (_use, uds) = vms.acquire(sandbox).await?;
    let script = format!(
        "set -e; cd {WORKDIR}; rm -f /tmp/lorehouse-stage.*; \
         git bundle create -q /tmp/lorehouse-stage.bundle HEAD --not --remotes=origin; \
         s=$(stat -c %s /tmp/lorehouse-stage.bundle); \
         if [ \"$s\" -gt {MAX_BUNDLE} ]; then echo \"the commits come to $s bytes, over {MAX_BUNDLE}\" >&2; exit 3; fi; \
         split -b {PART} -d -a 3 /tmp/lorehouse-stage.bundle /tmp/lorehouse-stage.part.; rm -f /tmp/lorehouse-stage.bundle; \
         ls /tmp/lorehouse-stage.part.*"
    );
    let body = serde_json::json!({ "command": script, "timeoutMs": 300_000 }).to_string();
    let reply = tokio::time::timeout(Duration::from_secs(330), vsock::request(&uds, Method::POST, "/exec", Bytes::from(body)))
        .await
        .map_err(|_| (504, "bundling in the sandbox took too long".to_string()))?
        .map_err(|e| (502, e))?;
    #[derive(Deserialize)]
    struct Exec {
        #[serde(rename = "exitCode")]
        exit_code: i64,
        stdout: String,
        stderr: String,
    }
    let r: Exec = serde_json::from_slice(&reply.body).map_err(|e| (502, format!("bundling in the sandbox: {e}")))?;
    if r.exit_code != 0 {
        if r.stderr.contains("empty bundle") {
            return Err((409, "no commits to publish: HEAD has nothing that isn't on GitHub already (commit first?)".into()));
        }
        if r.exit_code == 3 {
            return Err((413, tail(r.stderr.as_bytes())));
        }
        return Err((422, format!("bundling in the sandbox failed: {}", tail(r.stderr.as_bytes()))));
    }
    // The parts, in order, named exactly as split names them.
    let parts: Vec<&str> = r.stdout.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if parts.is_empty() || parts.len() as u64 > MAX_BUNDLE / PART + 1 {
        return Err((502, "bundling in the sandbox: unexpected parts".into()));
    }
    let mut out = Vec::new();
    for (i, part) in parts.iter().enumerate() {
        let want = format!("/tmp/lorehouse-stage.part.{i:03}");
        if *part != want {
            return Err((502, "bundling in the sandbox: unexpected parts".into()));
        }
        let got = tokio::time::timeout(Duration::from_secs(120), vsock::request(&uds, Method::GET, &format!("/file?path=%2Ftmp%2Florehouse-stage.part.{i:03}"), Bytes::new()))
            .await
            .map_err(|_| (504, "reading the bundle took too long".to_string()))?
            .map_err(|e| (502, e))?;
        if !got.status.is_success() {
            return Err((502, format!("reading the bundle: {}", got.status)));
        }
        out.extend_from_slice(&got.body);
        if out.len() as u64 > MAX_BUNDLE {
            return Err((413, format!("the commits come to over {MAX_BUNDLE} bytes")));
        }
    }
    let cleanup = serde_json::json!({ "command": "rm -f /tmp/lorehouse-stage.*", "timeoutMs": 30_000 }).to_string();
    let _ = vsock::request(&uds, Method::POST, "/exec", Bytes::from(cleanup)).await;
    tokio::fs::write(to, out).await.map_err(|e| (500, format!("bundle file: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch area: a bare "GitHub" remote with main, a clone standing in for the VM's
    /// checkout, and a Publisher whose remote base is the scratch directory.
    struct Scratch {
        root: PathBuf,
        vm: PathBuf,
        publisher: Publisher,
    }

    fn sh(dir: &Path, script: &str) -> String {
        let out = std::process::Command::new("sh")
            .arg("-c")
            .arg(script)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "bot")
            .env("GIT_AUTHOR_EMAIL", "1+bot@users.noreply.github.com")
            .env("GIT_COMMITTER_NAME", "bot")
            .env("GIT_COMMITTER_EMAIL", "1+bot@users.noreply.github.com")
            .output()
            .expect("sh");
        assert!(out.status.success(), "{script}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// A stage id made now, as stage() makes them (an id's leading number is its age).
    fn fresh(tag: &str) -> String {
        format!("{}-{tag}", unix_secs())
    }

    fn scratch(name: &str) -> Scratch {
        let root = std::env::temp_dir().join(format!("publish-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("acme")).unwrap();
        sh(&root, "git init -q --bare acme/widgets.git && git init -q -b main vm && cd vm && echo a > a && git add a && git commit -qm base && git remote add origin ../acme/widgets.git && git push -q origin main && git fetch -q origin");
        let vm = root.join("vm");
        let publisher = Publisher::new(root.join("mirrors"), format!("file://{}", root.display()));
        Scratch { root, vm, publisher }
    }

    impl Scratch {
        /// What stage does with a VM, minus the VM: bundle what origin doesn't have.
        async fn stage(&self, id: &str) -> Result<Staged, Failure> {
            let bundle = self.root.join(format!("{id}.bundle"));
            sh(&self.vm, &format!("git bundle create -q {} HEAD --not --remotes=origin", bundle.display()));
            let dir = self.publisher.mirror("acme", "widgets");
            self.publisher.refresh(&dir, "acme", "widgets", None).await.map_err(|e| (502, e))?;
            self.publisher.stage_bundle(&dir, &bundle, "main", id).await
        }
        fn refs(&self) -> Vec<String> {
            sh(&self.publisher.mirror("acme", "widgets"), "git for-each-ref --format='%(refname)'").lines().map(String::from).collect()
        }
        fn push(&self, sha: &str, branch: &str) -> PushRequest {
            PushRequest { owner: "acme".into(), name: "widgets".into(), sha: sha.into(), branch: branch.into(), token: "unused-for-file-remotes".into() }
        }
    }

    #[tokio::test]
    async fn stage_describes_the_commits_and_push_sends_exactly_the_staged_one() {
        let s = scratch("happy");
        let head = sh(&s.vm, "echo hello > POC.md && git add POC.md && git commit -qm poc && git rev-parse HEAD");
        let staged = s.stage(&fresh("a")).await.unwrap();
        assert_eq!(staged.sha, head);
        assert_eq!(staged.commits, 1);
        assert_eq!(staged.files, vec!["POC.md"]);
        assert!(staged.stat.contains("POC.md | 1 +"));
        assert_eq!(staged.authors, vec!["bot <1+bot@users.noreply.github.com>|bot <1+bot@users.noreply.github.com>"]);
        assert!(staged.patch.contains("+hello") && !staged.patch_truncated);
        let pushed = s.publisher.push(s.push(&head, "scout/poc")).await.unwrap();
        assert_eq!(pushed.sha, head);
        assert_eq!(sh(&s.root, "git -C acme/widgets.git rev-parse scout/poc"), head);
        assert!(s.refs().iter().all(|r| !r.starts_with("refs/stage/")), "pushed stage refs are dropped");
    }

    #[tokio::test]
    async fn tags_and_replace_refs_in_the_bundle_never_reach_the_mirror() {
        let s = scratch("refs");
        sh(&s.vm, "echo b > b && git add b && git commit -qm b && fake=$(git commit-tree HEAD^{tree} -p HEAD -m fake) && git replace HEAD $fake && git tag -a t1 -m t1 HEAD");
        // The VM bundles everything it has, refs/replace and refs/tags included.
        let bundle = s.root.join("all.bundle");
        sh(&s.vm, &format!("git bundle create -q {} --all --not --remotes=origin", bundle.display()));
        let dir = s.publisher.mirror("acme", "widgets");
        s.publisher.refresh(&dir, "acme", "widgets", None).await.unwrap();
        let id = fresh("b");
        s.publisher.stage_bundle(&dir, &bundle, "main", &id).await.unwrap();
        assert_eq!(s.refs(), vec!["refs/heads/main".to_string(), format!("refs/stage/{id}")]);
    }

    #[tokio::test]
    async fn a_tree_entry_named_dot_git_is_refused() {
        let s = scratch("dotgit");
        sh(&s.vm, "b=$(echo x | git hash-object -w --stdin) && t=$(printf '100644 blob %s\\t.git\\n' $b | git mktree) && c=$(git commit-tree $t -p HEAD -m dotgit) && git update-ref HEAD $c");
        let err = s.stage(&fresh("c")).await.unwrap_err();
        assert_eq!(err.0, 422);
        assert!(err.1.contains("hasDotgit"), "{}", err.1);
        assert_eq!(s.refs(), vec!["refs/heads/main"]);
    }

    #[tokio::test]
    async fn nothing_new_is_a_409_and_leaves_nothing_staged() {
        let s = scratch("empty");
        // A bundle of something GitHub already has: its HEAD is main itself.
        sh(&s.vm, "git checkout -q -b side && echo s > s && git add s && git commit -qm s && git push -q origin side && git fetch -q origin && git checkout -q main && git merge -q --ff-only side && git push -q origin main && git fetch -q origin");
        let bundle = s.root.join("same.bundle");
        sh(&s.vm, &format!("git bundle create -q {} HEAD ^origin/main~1", bundle.display()));
        let dir = s.publisher.mirror("acme", "widgets");
        s.publisher.refresh(&dir, "acme", "widgets", None).await.unwrap();
        let err = s.publisher.stage_bundle(&dir, &bundle, "main", &fresh("d")).await.unwrap_err();
        assert_eq!(err.0, 409);
        assert!(s.refs().iter().all(|r| !r.starts_with("refs/stage/")));
    }

    #[tokio::test]
    async fn only_a_staged_commit_is_pushed_and_never_over_a_diverged_branch() {
        let s = scratch("push");
        let main = sh(&s.vm, "git rev-parse HEAD");
        let dir = s.publisher.mirror("acme", "widgets");
        s.publisher.refresh(&dir, "acme", "widgets", None).await.unwrap();
        // main is in the mirror, but no stage produced it.
        assert_eq!(s.publisher.push(s.push(&main, "scout/x")).await.unwrap_err().0, 404);
        // Stage and push one commit, then a diverged one to the same branch: refused, not forced.
        let first = sh(&s.vm, "echo 1 > one && git add one && git commit -qm one && git rev-parse HEAD");
        s.stage(&fresh("e")).await.unwrap();
        s.publisher.push(s.push(&first, "scout/x")).await.unwrap();
        let other = sh(&s.vm, "git reset -q --hard origin/main && echo 2 > two && git add two && git commit -qm two && git rev-parse HEAD");
        s.stage(&fresh("f")).await.unwrap();
        let err = s.publisher.push(s.push(&other, "scout/x")).await.unwrap_err();
        assert_eq!(err.0, 409, "{}", err.1);
        assert_eq!(sh(&s.root, "git -C acme/widgets.git rev-parse scout/x"), first);
    }

    #[tokio::test]
    async fn a_stage_past_its_ttl_is_not_pushed_even_with_no_stage_since() {
        let s = scratch("ttl");
        let head = sh(&s.vm, "echo old > old && git add old && git commit -qm old && git rev-parse HEAD");
        let old = format!("{}-old", unix_secs() - STAGE_TTL.as_secs() - 60);
        s.stage(&old).await.unwrap();
        let err = s.publisher.push(s.push(&head, "scout/old")).await.unwrap_err();
        assert_eq!(err.0, 404, "{}", err.1);
        assert!(s.refs().iter().all(|r| !r.starts_with("refs/stage/")), "the expired stage is dropped");
    }

    #[tokio::test]
    async fn what_the_approval_shows_is_read_only_up_to_a_cap() {
        let mut s = scratch("cap");
        s.publisher.review_cap = 4096;
        // 400 files: their names alone are over the cap. Refused, not cut: a cut list would
        // hide files from the approver.
        sh(&s.vm, "for i in $(seq 1 400); do echo $i > file-with-a-long-name-$i; done && git add . && git commit -qm many");
        let err = s.stage(&fresh("g")).await.unwrap_err();
        assert_eq!(err.0, 413, "{}", err.1);
        assert!(err.1.contains("too much to review"), "{}", err.1);
        assert!(s.refs().iter().all(|r| !r.starts_with("refs/stage/")), "nothing is left staged");
        // The patch is an excerpt: cut at MAX_PATCH, and the stage goes on.
        s.publisher.review_cap = REVIEW_CAP;
        sh(&s.vm, "git reset -q --hard origin/main && seq 1 200000 > big && git add big && git commit -qm big");
        let staged = s.stage(&fresh("h")).await.unwrap();
        assert!(staged.patch_truncated && staged.patch.len() <= MAX_PATCH && staged.patch.contains("+1\n"));
    }

    /// Rename a ref in a bundle's header to HEAD, as a forged bundle could.
    fn advertise_as_head(bundle: &Path, name: &str) {
        let bytes = std::fs::read(bundle).unwrap();
        let from = format!("{name}\n").into_bytes();
        let at = bytes.windows(from.len()).position(|w| w == from.as_slice()).expect("ref in the header");
        let mut out = bytes[..at].to_vec();
        out.extend_from_slice(b"HEAD\n");
        out.extend_from_slice(&bytes[at + from.len()..]);
        std::fs::write(bundle, out).unwrap();
    }

    #[tokio::test]
    async fn a_head_that_is_a_tag_stages_its_commit_and_a_non_commit_leaves_nothing() {
        let s = scratch("tag");
        let dir = s.publisher.mirror("acme", "widgets");
        s.publisher.refresh(&dir, "acme", "widgets", None).await.unwrap();
        // A bundle whose HEAD is an annotated tag that peels to a new commit.
        let head = sh(&s.vm, "echo t > t && git add t && git commit -qm t && git tag -a t1 -m t1 && git rev-parse HEAD");
        let bundle = s.root.join("tag.bundle");
        let b = bundle.display();
        sh(&s.vm, &format!("git bundle create -q {b} refs/tags/t1 --not --remotes=origin"));
        advertise_as_head(&bundle, "refs/tags/t1");
        let id = fresh("i");
        let staged = s.publisher.stage_bundle(&dir, &bundle, "main", &id).await.unwrap();
        assert_eq!(staged.sha, head);
        assert_eq!(sh(&dir, &format!("git rev-parse refs/stage/{id}")), head, "the stage ref is the commit, not the tag");
        s.publisher.push(s.push(&head, "scout/tag")).await.unwrap();
        // A HEAD that peels to a blob: refused, and no stage ref left behind.
        let blob = s.root.join("blob.bundle");
        let b = blob.display();
        sh(&s.vm, &format!("x=$(echo x | git hash-object -w --stdin) && git tag -a tb -m tb $x && git bundle create -q {b} refs/tags/tb"));
        advertise_as_head(&blob, "refs/tags/tb");
        let err = s.publisher.stage_bundle(&dir, &blob, "main", &fresh("j")).await.unwrap_err();
        assert_eq!(err.0, 422, "{}", err.1);
        assert!(s.refs().iter().all(|r| !r.starts_with("refs/stage/")), "{:?}", s.refs());
    }

    #[test]
    fn a_temp_file_is_removed_when_dropped() {
        let path = std::env::temp_dir().join(format!("publish-tempfile-{}", std::process::id()));
        std::fs::write(&path, b"x").unwrap();
        drop(TempFile(path.clone()));
        assert!(!path.exists());
    }

    #[test]
    fn names_refs_and_ids_are_checked() {
        for ok in ["main", "release/1.2", "scout/fix-a_b.c"] {
            assert!(plain_ref(ok));
        }
        for bad in ["", "-x", "/x", "a..b", "a//b", "a/", "x.lock", "a b", "a;b", "$(id)"] {
            assert!(!plain_ref(bad), "{bad}");
        }
        assert!(plain_name("lorehouse-playground") && !plain_name("..") && !plain_name(".git") && !plain_name("a/b"));
        assert!(commit_id(&"a".repeat(40)) && !commit_id(&"A".repeat(40)) && !commit_id("abc"));
    }
}
