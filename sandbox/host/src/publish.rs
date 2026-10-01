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

/// One git command, in `dir`, in the guarded environment; its stdout.
async fn git(dir: &Path, args: &[&str], token: Option<&str>, limit: Duration) -> Result<String, String> {
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
    cmd.kill_on_drop(true);
    let out = match tokio::time::timeout(limit, cmd.output()).await {
        Err(_) => return Err(format!("git {} took over {} s", args[0], limit.as_secs())),
        Ok(Err(e)) => return Err(format!("git: {e}")),
        Ok(Ok(o)) => o,
    };
    if !out.status.success() {
        return Err(format!("git {}: {}", args[0], tail(&out.stderr)));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn unix_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

impl Publisher {
    pub fn new(mirrors: PathBuf, remote_base: String) -> Publisher {
        Publisher { mirrors, remote_base: remote_base.trim_end_matches('/').to_string(), locks: Mutex::default() }
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
        let bundle = dir.join(format!("stage-{id}.bundle"));
        let read = bundle_from(vms, sandbox, &bundle).await;
        let staged = match read {
            Ok(()) => self.stage_bundle(&dir, &bundle, &req.base, &id).await,
            Err(e) => Err(e),
        };
        let _ = tokio::fs::remove_file(&bundle).await;
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
        let sha = git(dir, &["rev-parse", "--verify", &format!("{staged_ref}^{{commit}}")], None, GIT_LOCAL).await.map_err(|e| (422, e))?.trim().to_string();
        let base_ref = format!("refs/heads/{base}");
        let Ok(base_sha) = git(dir, &["rev-parse", "--verify", "-q", &format!("{base_ref}^{{commit}}")], None, GIT_LOCAL).await else {
            let _ = git(dir, &["update-ref", "-d", &staged_ref], None, GIT_LOCAL).await;
            return Err((404, format!("the base branch {base} isn't on GitHub")));
        };
        let base_sha = base_sha.trim().to_string();
        let range = format!("{base_sha}..{sha}");
        let three_dot = format!("{base_sha}...{sha}");
        let local = |args: Vec<&str>| {
            let dir = dir.to_path_buf();
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            async move {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                git(&dir, &args, None, GIT_LOCAL).await.map_err(|e| (500, e))
            }
        };
        let authors: Vec<String> = local(vec!["log", "--format=%an <%ae>|%cn <%ce>", &range]).await?.lines().map(String::from).collect();
        if authors.is_empty() {
            let _ = git(dir, &["update-ref", "-d", &staged_ref], None, GIT_LOCAL).await;
            return Err((409, format!("no commits to publish: HEAD has nothing that isn't on {base} already")));
        }
        let stat = local(vec!["diff", "--no-ext-diff", "--no-textconv", "--stat", &three_dot]).await?;
        let files = local(vec!["diff", "--no-ext-diff", "--no-textconv", "--name-only", &three_dot]).await?.lines().map(String::from).collect();
        let mut patch = local(vec!["diff", "--no-ext-diff", "--no-textconv", &three_dot]).await?;
        let patch_truncated = patch.len() > MAX_PATCH;
        if patch_truncated {
            let mut cut = MAX_PATCH;
            while !patch.is_char_boundary(cut) {
                cut -= 1;
            }
            patch.truncate(cut);
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
        // Only what a stage produced (what an approval was about) goes out.
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
        let staged = s.stage("1-a").await.unwrap();
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
        s.publisher.stage_bundle(&dir, &bundle, "main", "1-b").await.unwrap();
        assert_eq!(s.refs(), vec!["refs/heads/main", "refs/stage/1-b"]);
    }

    #[tokio::test]
    async fn a_tree_entry_named_dot_git_is_refused() {
        let s = scratch("dotgit");
        sh(&s.vm, "b=$(echo x | git hash-object -w --stdin) && t=$(printf '100644 blob %s\\t.git\\n' $b | git mktree) && c=$(git commit-tree $t -p HEAD -m dotgit) && git update-ref HEAD $c");
        let err = s.stage("1-c").await.unwrap_err();
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
        let err = s.publisher.stage_bundle(&dir, &bundle, "main", "1-d").await.unwrap_err();
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
        s.stage("1-e").await.unwrap();
        s.publisher.push(s.push(&first, "scout/x")).await.unwrap();
        let other = sh(&s.vm, "git reset -q --hard origin/main && echo 2 > two && git add two && git commit -qm two && git rev-parse HEAD");
        s.stage("1-f").await.unwrap();
        let err = s.publisher.push(s.push(&other, "scout/x")).await.unwrap_err();
        assert_eq!(err.0, 409, "{}", err.1);
        assert_eq!(sh(&s.root, "git -C acme/widgets.git rev-parse scout/x"), first);
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
