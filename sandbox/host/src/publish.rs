//! Publishing: the agent's commits leave the sandbox without a write token ever entering it
//! (docs/sandbox-runners.md, "Publishing").
//!
//! stage, before a human approves: the VM bundles the commits it has that GitHub doesn't.
//! The host reads that bundle and verifies it into a bare mirror of the repo: fsck on, one
//! ref, no tags. What the approval shows (the diff, the authors) is computed from the mirror,
//! never from anything the VM reports. Only once all of that has succeeded does the host
//! write a stage record, and the stage's id goes back with the facts.
//!
//! push, after: the host pushes exactly the commit a stage record names, to the branch it
//! names, with the write token, never forced. The VM takes no part.
//!
//! The stage record is the only thing that authorizes a push (see "Stage records" below).
//! The mirror's refs/stage/<id> refs exist for git's sake (they keep a stage's objects from
//! being collected); they authorize nothing.
//!
//! Every git command here runs with no user or system config, no prompts, no replace objects,
//! no hooks and no maintenance of git's own, and isolated from sandboxd (gitjail.rs): its
//! own uid, a mount namespace holding only its mirror and git's binaries, no network, its
//! own cgroup. A command that talks to the remote reaches it only through sandboxd, which
//! adds the token (remote.rs): no git ever holds one, in argv, its environment or a file.
//!
//! A mirror is only ever written by one job at a time, under its lock: a stage, a push, and
//! the housekeeping after either (prune). Git's automatic maintenance is off, because it runs
//! detached, after the lock is released: a `gc --prune=now` from outside the lock was seen to
//! leave a `refs/stage/<id>` pointing at a pack it had removed, after which every fetch into
//! the mirror failed (#76).

mod remote;
mod upkeep;

use remote::{Access, Grant, Remote};
pub use upkeep::{Policy, GIB};
use upkeep::{Disk, RealDisk, Stats};

use crate::gitjail::{self, Confined, GitJail};
use crate::vm::{self, Manager};
use crate::vsock;
use bytes::Bytes;
use hyper::Method;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};

/// The bundle comes out of the VM in parts, each under guestd's 16 MiB file limit.
const PART: u64 = 12 << 20;
/// The most a stage reads out of a VM.
pub const MAX_BUNDLE: u64 = 96 << 20;
/// How much of the patch the approval gets, at most.
const MAX_PATCH: usize = 64 << 10;
/// How long a stage can be pushed after it was made. Past it, push refuses it and the
/// housekeeping drops its record and ref.
const STAGE_TTL: Duration = Duration::from_secs(24 * 3600);
/// How far in the future a record's creation time may be (the clock stepped back) before
/// push treats the record as bad.
const CLOCK_SLACK: u64 = 300;
const GIT_LOCAL: Duration = Duration::from_secs(120);
const GIT_NETWORK: Duration = Duration::from_secs(600);
/// How old a temporary file in a mirror (git's partial packs, a stage's bundle) must be
/// before prune() removes it. Nothing else writes to a mirror while its lock is held (a git
/// command that is cut off is stopped with its helpers before the lock is released,
/// Running); this is a margin.
const GARBAGE_AGE: Duration = Duration::from_secs(10 * 60);
/// `gc --auto` as push runs it: git's own thresholds (6700 loose objects, 50 packs), which
/// the guarded environment turns off for every other command (gc.auto=0). In the foreground
/// (gc.autoDetach=false, also from the environment), so it finishes under the lock.
const GC_AUTO: &[&str] = &["-c", "gc.auto=6700", "gc", "--auto", "-q"];
/// Where the checkout lives in every VM (Lorehouse's WORKDIR).
const WORKDIR: &str = "/workspace/repo";

#[derive(Deserialize)]
pub struct StageRequest {
    pub owner: String,
    pub name: String,
    /// The branch the commits are to be compared with (and the pull request is opened against).
    pub base: String,
    /// The branch the commits are to be pushed to, if approved. Recorded, and push must
    /// name the same one.
    pub branch: String,
    /// A read token for the repo; none for a public one.
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Serialize, Debug)]
pub struct Staged {
    /// The stage's id: what push takes.
    pub stage: String,
    pub sha: String,
    #[serde(rename = "baseSha")]
    pub base_sha: String,
    pub commits: usize,
    pub stat: String,
    /// "author <email>|committer <email>", one per commit.
    pub authors: Vec<String>,
    /// Every path the commits change, complete: a rename is listed as both of its paths (git
    /// detects no renames here), and no path is quoted or escaped (bytes that aren't UTF-8
    /// become U+FFFD). What the approval warns about is decided on this list.
    pub files: Vec<String>,
    pub patch: String,
    #[serde(rename = "patchTruncated")]
    pub patch_truncated: bool,
    /// SHA-256 (hex) of the complete diff against the base, with whole blob ids
    /// (`--full-index`, which bind binary changes too) and pinned diff options, so it
    /// depends on the two commits, not the mirror or the git release's defaults: what an
    /// approval binds. Two diffs that differ only past the excerpt differ here.
    #[serde(rename = "diffSha256")]
    pub diff_sha256: String,
}

/// A push names its stage, and restates what it pushes: each must match the stage's record.
#[derive(Deserialize)]
pub struct PushRequest {
    pub stage: String,
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
    /// Runs every git command, isolated; its remote is https://github.com in production, a
    /// file:// directory in tests.
    git: Git,
    /// REVIEW_CAP; smaller in tests.
    review_cap: usize,
    locks: Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>,
    /// Held by a stage making a new mirror, from its admission to its first fetch measured
    /// (upkeep.rs, Quotas): one new mirror at a time, host-wide. Taken after the mirror's
    /// own lock.
    new_mirrors: tokio::sync::Mutex<()>,
    /// The mirrors' quotas, retention and gc (upkeep.rs).
    policy: Policy,
    /// Where mirror and filesystem sizes come from; the disk outside tests.
    disk: Arc<dyn Disk>,
    /// Unix seconds, for the upkeep and the housekeeping; the system clock outside tests.
    clock: Arc<dyn Fn() -> u64 + Send + Sync>,
    stats: Mutex<Stats>,
    /// Tests only: after verifying, just before its record is written, a stage signals the
    /// first and waits on the second (never signalled), so a test can cut it off at exactly
    /// that moment, however long verifying took.
    #[cfg(test)]
    before_record: Option<(Arc<tokio::sync::Notify>, Arc<tokio::sync::Notify>)>,
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

/// Stands for the remote's URL in a git command's arguments: the run puts its own there
/// (the proxy's, or a file:// remote's).
const REMOTE: &str = "\u{0}remote";

/// What a git command may reach of the remote.
enum Net<'a> {
    /// Nothing: no network at all.
    Off,
    /// The repo's upload-pack, with a read token (or none, for a public repo).
    Fetch { owner: &'a str, name: &'a str, token: Option<&'a str> },
    /// The repo's receive-pack, for exactly one update, with the write token.
    Push { owner: &'a str, name: &'a str, token: &'a str, old: &'a str, new: &'a str, refname: &'a str },
}

/// Runs publishing's git commands: each isolated from sandboxd (gitjail.rs), with the
/// remote reached through sandboxd (remote.rs). Only tests run git unisolated, as their
/// own user: a build without cfg(test) can't make a Git without a GitJail.
pub struct Git {
    jail: Option<Arc<GitJail>>,
    remote: Remote,
    client: reqwest::Client,
    /// What every run's proxy may hold of requests' bodies at once (remote.rs).
    budget: Arc<remote::Budget>,
}

impl Git {
    fn new(jail: Option<Arc<GitJail>>, remote_base: &str) -> Git {
        // No redirects: a run's requests go to its repo at the remote, nowhere else.
        let client = reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(30)).build().unwrap_or_default();
        Git { jail, remote: Remote::new(remote_base), client, budget: remote::Budget::new(remote::BODY_BUDGET) }
    }

    /// Start one git command in `dir`, in the guarded environment (git_command).
    async fn spawn(&self, dir: &Path, args: &[&str], net: Net<'_>) -> Result<Running, String> {
        let (mut url, mut netns, mut bind, mut proxy, mut grant) = (None, None, None, None, None);
        match (&net, &self.remote) {
            (Net::Off, _) => {}
            (Net::Fetch { owner, name, .. } | Net::Push { owner, name, .. }, Remote::File(base)) => {
                let repo = base.join(owner).join(format!("{name}.git"));
                url = Some(format!("file://{}", repo.display()));
                bind = Some((repo, matches!(net, Net::Push { .. })));
            }
            (Net::Fetch { owner, name, .. } | Net::Push { owner, name, .. }, Remote::Http(base)) => {
                let g = match &net {
                    Net::Push { token, old, new, refname, .. } => Grant::new(owner, name, Some(token), Access::Push { old: old.to_string(), new: new.to_string(), refname: refname.to_string() }),
                    Net::Fetch { token, .. } => Grant::new(owner, name, *token, Access::Fetch),
                    Net::Off => unreachable!(),
                };
                // Isolated, the listener is the only thing in the run's network namespace.
                let (fd, listener) = if self.jail.is_some() {
                    let (fd, l) = gitjail::proxied_netns().map_err(|e| format!("isolating git (its network): {e}"))?;
                    (Some(fd), l)
                } else {
                    (None, std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("git's proxy: {e}"))?)
                };
                let addr = listener.local_addr().map_err(|e| format!("git's proxy: {e}"))?;
                url = Some(format!("http://{addr}/{owner}/{name}.git"));
                proxy = Some(remote::serve(listener, self.client.clone(), base.clone(), g.clone(), self.budget.clone()).map_err(|e| format!("git's proxy: {e}"))?);
                netns = fd;
                grant = Some(g);
            }
        }
        let mut owned: Vec<String> = Vec::with_capacity(args.len());
        for a in args {
            owned.push(if *a == REMOTE { url.clone().ok_or("git: a remote with no network for it")? } else { a.to_string() });
        }
        let bound = bind.is_some();
        let (mut cmd, confined) = match &self.jail {
            Some(jail) => {
                let net = match (netns, bind) {
                    (Some(fd), _) => gitjail::Net::Proxied(fd),
                    (None, Some((repo, writable))) => gitjail::Net::Dir(repo, writable),
                    (None, None) => gitjail::Net::Off,
                };
                let (cmd, confined) = jail.command(dir, net).await?;
                // A path in the mirror (a stage's bundle) is under /repo there.
                let prefix = format!("{}/", dir.display());
                for a in owned.iter_mut() {
                    if let Some(rest) = a.strip_prefix(&prefix) {
                        *a = format!("{}/{rest}", gitjail::REPO);
                    }
                }
                (cmd, Some(confined))
            }
            None => {
                let mut cmd = crate::child::command("git");
                cmd.arg("-C").arg(dir);
                (cmd, None)
            }
        };
        let home = if confined.is_some() { Path::new(gitjail::REPO) } else { dir };
        // Isolated, a file:// remote (testing) belongs to another uid than the run's: the
        // run's own global config, which names only that repo safe (gitjail::SAFE_CONFIG).
        let global = if confined.is_some() && bound { gitjail::SAFE_CONFIG } else { "/dev/null" };
        git_command(&mut cmd, home, &owned, global);
        if confined.is_none() {
            // Unisolated (tests): still no capabilities.
            #[cfg(target_os = "linux")]
            // SAFETY: drop_capabilities only makes async-signal-safe syscalls.
            unsafe {
                cmd.pre_exec(crate::jail::drop_capabilities);
            }
        }
        let child = cmd.spawn().map_err(|e| gitjail::explain(&e))?;
        let group = child.id().and_then(|id| libc::pid_t::try_from(id).ok());
        Ok(Running { child, group, _confined: confined, _proxy: proxy, grant })
    }

    /// Whether a mirror has never been fetched into: not there, or no refs (a first fetch that
    /// failed or was cut off, by a sandboxd that then stopped). New only when git said so: a
    /// for-each-ref that couldn't run or failed says nothing about the mirror, and a failed
    /// refresh mustn't remove one that has been fetched.
    async fn is_new(&self, dir: &Path) -> bool {
        !has_head(dir) || matches!(self.run(dir, &["for-each-ref", "--count=1", "--format=%(refname)"], GIT_LOCAL).await, Ok(refs) if refs.trim().is_empty())
    }

    /// One git command with no network, in `dir`; its stdout, which must fit OUTPUT_CAP.
    async fn run(&self, dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
        self.run_net(dir, args, Net::Off, limit).await
    }

    /// One git command, in `dir`, reaching what `net` allows; its stdout, which must fit
    /// OUTPUT_CAP.
    async fn run_net(&self, dir: &Path, args: &[&str], net: Net<'_>, limit: Duration) -> Result<String, String> {
        match self.capped(dir, args, net, limit, OUTPUT_CAP).await? {
            (out, false) => Ok(out),
            (_, true) => Err(format!("git {}: more than {OUTPUT_CAP} bytes of output", args[0])),
        }
    }

    /// One git command, in `dir`; at most `cap` bytes of its stdout, and whether there was
    /// more (the command is stopped there, never read to the end).
    async fn capped(&self, dir: &Path, args: &[&str], net: Net<'_>, limit: Duration, cap: usize) -> Result<(String, bool), String> {
        use tokio::io::AsyncReadExt;
        let work = async {
            let mut child = self.spawn(dir, args, net).await?;
            let (Some(stdout), Some(stderr)) = (child.child.stdout.take(), child.child.stderr.take()) else {
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
                child.stop();
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
                return Err(child.failed(args[0], &err));
            }
            Ok((String::from_utf8_lossy(&out).into_owned(), false))
        };
        match tokio::time::timeout(limit, work).await {
            Err(_) => Err(format!("git {} took over {} s", args[0], limit.as_secs())),
            Ok(r) => r,
        }
    }

    /// One git command with no network, in `dir`, for its answer alone: whether it
    /// succeeded, or None if it couldn't run or didn't finish within GIT_LOCAL.
    async fn says(&self, dir: &Path, args: &[&str]) -> Option<bool> {
        let work = async {
            use tokio::io::AsyncReadExt;
            let mut child = self.spawn(dir, args, Net::Off).await.ok()?;
            // Read and dropped, up to a cap: a pipe closed instead would kill a git that
            // writes a warning (SIGPIPE), and its answer would read as "no".
            let drain = |pipe: Option<Box<dyn tokio::io::AsyncRead + Send + Unpin>>| {
                tokio::spawn(async move {
                    if let Some(p) = pipe {
                        let _ = tokio::io::copy(&mut p.take(STDERR_CAP), &mut tokio::io::sink()).await;
                    }
                })
            };
            let out = drain(child.child.stdout.take().map(|p| Box::new(p) as _));
            let err = drain(child.child.stderr.take().map(|p| Box::new(p) as _));
            let status = child.wait().await.ok().map(|s| s.success());
            out.abort();
            err.abort();
            status
        };
        tokio::time::timeout(GIT_LOCAL, work).await.ok().flatten()
    }

    /// One git command with no network, in `dir`: the SHA-256 (hex) of all of its stdout,
    /// however long, read as it comes and never kept.
    async fn sha256(&self, dir: &Path, args: &[&str], limit: Duration) -> Result<String, String> {
        use sha2::{Digest, Sha256};
        use tokio::io::AsyncReadExt;
        let work = async {
            let mut child = self.spawn(dir, args, Net::Off).await?;
            let (Some(mut stdout), Some(stderr)) = (child.child.stdout.take(), child.child.stderr.take()) else {
                return Err("git: no pipes".to_string());
            };
            let errors = tokio::spawn(async move {
                let mut err = Vec::new();
                let _ = stderr.take(STDERR_CAP).read_to_end(&mut err).await;
                err
            });
            let mut hash = Sha256::new();
            let mut buf = vec![0u8; 64 << 10];
            loop {
                let n = stdout.read(&mut buf).await.map_err(|e| format!("git {}: {e}", args[0]))?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
            let status = child.wait().await.map_err(|e| format!("git: {e}"))?;
            let err = errors.await.unwrap_or_default();
            if !status.success() {
                return Err(child.failed(args[0], &err));
            }
            Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
        };
        match tokio::time::timeout(limit, work).await {
            Err(_) => Err(format!("git {} took over {} s", args[0], limit.as_secs())),
            Ok(r) => r,
        }
    }
}

/// git's own settings for every command: no user or system config, no prompts, no replace
/// objects, no hooks, fsck on fetch, no automatic maintenance, no credential helper;
/// stdout and stderr piped. No token: the remote is reached through sandboxd (remote.rs),
/// which adds it.
fn git_command(cmd: &mut Command, home: &Path, args: &[String], global_config: &str) {
    use std::process::Stdio;
    cmd.args(args);
    cmd.env("HOME", home)
        .env("GIT_CONFIG_GLOBAL", global_config)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_ATTR_NOSYSTEM", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_NO_REPLACE_OBJECTS", "1");
    let config: [(&str, &str); 10] = [
        ("core.hooksPath", "/dev/null"),
        ("fetch.fsckObjects", "true"),
        ("transfer.fsckObjects", "true"),
        ("credential.helper", ""),
        // No maintenance git starts on its own: a fetch ends with a detached `git
        // maintenance run --auto` (traced on git 2.55 in #76), which would write to the
        // mirror after the lock is released. A gc sandboxd asks for runs in the foreground,
        // so under the lock.
        ("maintenance.auto", "false"),
        ("gc.auto", "0"),
        ("gc.autoDetach", "false"),
        ("maintenance.autoDetach", "false"),
        // The remote is reached over plain HTTP to sandboxd's listener, never via a proxy
        // a mirror's config names.
        ("http.proxy", ""),
        // A push's whole request in one buffer: over http.postBuffer (1 MiB by default),
        // remote-curl would first probe receive-pack with a bare flush-pkt and then stream
        // the request chunked. The proxy reads at most this much anyway (remote.rs).
        ("http.postBuffer", remote::MAX_PUSH_REQUEST_STR),
    ];
    cmd.env("GIT_CONFIG_COUNT", config.len().to_string());
    for (i, (k, v)) in config.iter().enumerate() {
        cmd.env(format!("GIT_CONFIG_KEY_{i}"), k).env(format!("GIT_CONFIG_VALUE_{i}"), v);
    }
    // In a process group of its own, so a command that is cut off is stopped with all of
    // its helpers (Running), and, isolated, in a cgroup of its own, killed whole after it.
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).process_group(0);
}

/// How long a cut-off git command's process group has after SIGTERM before it gets SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(2);
/// After SIGKILL, how long before a group still not gone is logged (it is waited for anyway).
const STOP_LOG_AFTER: Duration = Duration::from_secs(5);

/// A running git command, the leader of a process group of its own (git_command). Dropped
/// before it was waited for (it timed out, or its job was cut off) or stopped, the whole
/// group is stopped: SIGTERM, SIGKILL once the leader exits or after STOP_GRACE, and drop()
/// returns only once no process of the group is left, however long that takes. Killing the
/// command alone would leave its helpers (a fetch's git-remote-https and index-pack, a gc's
/// repack) writing to the mirror. A job's future holds the mirror's lock longer than the command it is running
/// (the lock is taken first, so it is dropped last), so the lock is never released with one
/// of them alive. drop() blocks its thread for that while: until the leader exits, two
/// seconds at most, unless a process then can't die even of SIGKILL.
///
/// Isolated, the run's cgroup is then killed whole and removed (Confined), however the
/// command ended: a process that left the group (setsid) is gone too, before the uid is
/// free again and before the mirror's lock is released.
struct Running {
    child: Child,
    /// None once the command has been waited for (its id may then be reused) or stopped.
    group: Option<libc::pid_t>,
    /// Held for the run, and dropped after the group is stopped (fields drop after
    /// Drop::drop), in this order: the cgroup killed and the uid freed, then the proxy.
    _confined: Option<Confined>,
    /// The run's way to the remote, closed once it is over.
    _proxy: Option<remote::Proxy>,
    grant: Option<Arc<Grant>>,
}

impl Running {
    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let status = self.child.wait().await?;
        self.group = None;
        Ok(status)
    }

    /// A failed command's error: the end of its stderr, and why sandboxd refused one of its
    /// requests to the remote, if it did.
    fn failed(&self, what: &str, stderr: &[u8]) -> String {
        match self.grant.as_ref().and_then(|g| g.refused()) {
            Some(why) => format!("git {what}: {}; sandboxd refused it: {why}", tail(stderr)),
            None => format!("git {what}: {}", tail(stderr)),
        }
    }

    /// Stop the whole group, and wait until it is gone. The leader is reaped only once both
    /// signals are sent: until then it holds the group's id (as a zombie, if it has exited),
    /// so neither signal can reach a group that reused the id.
    fn stop(&mut self) {
        let Some(group) = self.group.take() else { return };
        let sleep = || std::thread::sleep(Duration::from_millis(10));
        // SAFETY: killpg() signals the group this command leads, whose id its unreaped leader
        // holds.
        unsafe { libc::killpg(group, libc::SIGTERM) };
        // STOP_GRACE to stop on SIGTERM; cut short when the leader has exited, as git does at
        // once (its helpers got the same signal at the same moment).
        let start = std::time::Instant::now();
        while !exited(group) && start.elapsed() < STOP_GRACE {
            sleep();
        }
        // SAFETY: as above; the leader is still unreaped.
        unsafe { libc::killpg(group, libc::SIGKILL) };
        let start = std::time::Instant::now();
        let mut logged = false;
        loop {
            // Reap the leader: a zombie still counts in its group.
            let _ = self.child.try_wait();
            // SAFETY: kill() with signal 0 only checks whether the group has a process left.
            let left = unsafe { libc::kill(-group, 0) };
            if left != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
                return;
            }
            if !logged && start.elapsed() >= STOP_LOG_AFTER {
                logged = true;
                eprintln!("sandboxd: git process group {group} is still there {} s after SIGKILL; its mirror stays locked until it is gone", STOP_LOG_AFTER.as_secs());
            }
            sleep();
        }
    }
}

/// Whether process `pid`, a child of this one, has exited, without reaping it.
fn exited(pid: libc::pid_t) -> bool {
    // SAFETY: waitid() writes into the zeroed struct it is given; WNOWAIT leaves the child
    // unreaped.
    unsafe {
        let mut info: libc::siginfo_t = std::mem::zeroed();
        libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOHANG | libc::WNOWAIT) == 0 && info.si_pid() != 0
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A file removed when this is dropped.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Sync a directory, so the entries just created, renamed or removed in it survive a crash.
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

// ── What sandboxd reads in a mirror ────────────────────────────────────────────────────
//
// A mirror's contents are written by its git runs, which run as an untrusted uid
// (gitjail.rs). sandboxd (root, outside any jail) touches a mirror only while no run of it
// is alive (under the mirror's lock, runs killed whole before it is released), so nothing
// changes under it, but anything a run left there may be planted: a link anywhere on the
// host, a FIFO no one writes, a file of any size. So sandboxd, in a mirror:
// - never follows a link: presence is lstat (has_head), walks use DirEntry's no-follow
//   metadata and recurse only into real directories (remove_garbage, RealDisk::usage,
//   gitjail::own), a directory is read only after lstat says it is one;
// - opens a file only with read_in_mirror: O_NOFOLLOW | O_NONBLOCK, fstat'd to be a
//   regular file, and read up to a cap;
// - writes only new files (create_new: the bundle) and removes with unlink (remove_file,
//   remove_dir_all), neither of which follows a link;
// - leaves everything else, refs and objects included, to a jailed git run.

/// A file in a mirror, as sandboxd reads one: not through a link, not a FIFO or device
/// (opened O_NOFOLLOW | O_NONBLOCK, then fstat'd), and at most `cap` bytes. None if it
/// isn't there, isn't a regular file, or is longer.
pub(crate) fn read_in_mirror(path: &Path, cap: u64) -> Option<Vec<u8>> {
    use std::os::unix::fs::OpenOptionsExt;
    let f = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK).open(path).ok()?;
    let meta = f.metadata().ok()?;
    if !meta.is_file() || meta.len() > cap {
        return None;
    }
    let mut out = Vec::new();
    f.take(cap + 1).read_to_end(&mut out).ok()?;
    (out.len() as u64 <= cap).then_some(out)
}

/// What in a mirror would make git see another history than its commits' own, if any:
/// grafts, a shallow file, alternates, or replace refs (loose or packed). Read as sandboxd
/// reads a mirror (no links followed, packed-refs capped; one it can't read counts).
pub(crate) fn rewritten_history(dir: &Path) -> Option<&'static str> {
    for file in ["info/grafts", "shallow", "objects/info/alternates", "objects/info/http-alternates", "refs/replace"] {
        if std::fs::symlink_metadata(dir.join(file)).is_ok() {
            return Some(file);
        }
    }
    let packed = dir.join("packed-refs");
    if std::fs::symlink_metadata(&packed).is_ok() {
        match read_in_mirror(&packed, 64 << 20) {
            None => return Some("an unreadable packed-refs"),
            Some(p) if p.windows(14).any(|w| w == b" refs/replace/") => return Some("packed replace refs"),
            Some(_) => {}
        }
    }
    None
}

/// Whether a mirror has a HEAD (git made it one), without following it if it is a link.
pub(crate) fn has_head(dir: &Path) -> bool {
    std::fs::symlink_metadata(dir.join("HEAD")).is_ok()
}

/// Remove a mirror. Its owner's directory stays: another repo of the same owner may be
/// creating its mirror in it, under its own lock.
fn remove_mirror(dir: &Path) {
    let _ = std::fs::remove_dir_all(dir);
    // Its upkeep state goes with it: a new mirror of the repo starts afresh.
    let _ = std::fs::remove_file(upkeep::state_path(dir));
}

/// A mirror whose first fetch hasn't completed, removed when this is dropped unless it was
/// kept: a first fetch that fails, times out or is cut off by the job's deadline leaves no
/// partial pack behind (one of next.js was 2.3 GB, #76). Dropped under the mirror's lock.
struct NewMirror<'a>(Option<&'a Path>);

impl Drop for NewMirror<'_> {
    fn drop(&mut self) {
        if let Some(dir) = self.0 {
            remove_mirror(dir);
        }
    }
}

/// Remove what a git process that died or was killed leaves in a mirror, once it is older
/// than GARBAGE_AGE: its partial packs (`objects/pack/tmp_pack_*`, `tmp_idx_*`, up to the
/// size of what it was fetching), its lock files (`*.lock`: a `refs/heads/<b>.lock` or
/// `packed-refs.lock` fails every later fetch), and stage bundles a crash left. Each name is
/// matched only where that file lives: a branch may be called `tmp_pack_x` or
/// `stage-x.bundle`, but no ref name ends in `.lock`. Whether it removed a lock file.
fn remove_garbage(dir: &Path, now: SystemTime) -> bool {
    fn walk(top: &Path, place: &Path, now: SystemTime, unlocked: &mut bool) {
        let packs = place == top.join("objects").join("pack");
        for entry in std::fs::read_dir(place).into_iter().flatten().flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                walk(top, &entry.path(), now, unlocked);
                continue;
            }
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let lock = name.ends_with(".lock");
            let garbage = lock
                || (packs && (name.starts_with("tmp_pack_") || name.starts_with("tmp_idx_")))
                || (place == top && name.starts_with("stage-") && name.ends_with(".bundle"));
            let old = || entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > GARBAGE_AGE));
            if garbage && kind.is_file() && old() && std::fs::remove_file(entry.path()).is_ok() {
                *unlocked |= lock;
            }
        }
    }
    let mut unlocked = false;
    walk(dir, dir, now, &mut unlocked);
    unlocked
}

fn unix_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

// ── Stage records ──────────────────────────────────────────────────────────────────────
//
// A stage record is what authorizes a push, and nothing else does. One JSON file per
// stage, `<mirrors>/.stages/<id>.json` (the dot keeps it apart from the owners' mirror
// directories, whose names can't start with one):
//
// - Written only after verification has completed (stage_and_record), atomically: a
//   temporary file, synced, then renamed into place. A stage that fails, or is cut off
//   by its deadline or cancelled at any point before that, writes none, so nothing it
//   left behind (a ref, objects) is pushable.
// - Single use. Push consumes the record (removes it) before it checks anything else or
//   pushes: a record authorizes one push attempt, whatever its outcome. If it can't be
//   removed, nothing is pushed. A failed push (a diverged branch, GitHub down) needs a new
//   stage; Lorehouse stages on every run of open_pull_request anyway, a replay included,
//   so a replay after a push stages again and pushes the same commit, which is a no-op.
// - Fails closed. Push refuses on a record that is missing, unreadable, malformed, older
//   than STAGE_TTL (or from the future), or that names a different sandbox, repo, commit
//   or branch than the push asks for.
// - Its id is unguessable (128 random bits), so a record only the host wrote can't be
//   named by anyone the stage's answer didn't reach. It starts with the creation time, for
//   the housekeeping: expired records and refs are dropped by name, and a failure there
//   only leaves garbage, since push checks the age itself.

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
struct StageRecord {
    id: String,
    sandbox: String,
    owner: String,
    name: String,
    base: String,
    #[serde(rename = "baseSha")]
    base_sha: String,
    branch: String,
    sha: String,
    /// The staged diff's digest (Staged::diff_sha256), kept with what was approved.
    #[serde(rename = "diffSha256")]
    diff_sha256: String,
    /// Unix seconds.
    #[serde(rename = "createdAt")]
    created_at: u64,
}

/// A new stage id: `<unix seconds>-<32 hex digits from the OS's random source>`.
#[cfg(test)]
fn new_stage_id() -> Result<String, String> {
    new_stage_id_at(unix_secs())
}

/// A new stage id made at `secs` (the publisher's clock).
fn new_stage_id_at(secs: u64) -> Result<String, String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes)).map_err(|e| format!("random stage id: {e}"))?;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!("{secs}-{hex}"))
}

/// A stage id as new_stage_id makes them; nothing else is ever a file or ref name.
fn stage_id(s: &str) -> bool {
    stage_secs(s).is_some()
}

/// The creation time a well-formed stage id starts with.
fn stage_secs(s: &str) -> Option<u64> {
    let (secs, rand) = s.split_once('-')?;
    let ok = (1..=20).contains(&secs.len()) && secs.bytes().all(|b| b.is_ascii_digit()) && rand.len() == 32 && rand.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
    if ok {
        secs.parse().ok()
    } else {
        None
    }
}

/// Older than STAGE_TTL, or from further in the future than the clock could have stepped.
fn expired(created_at: u64, now: u64) -> bool {
    created_at > now + CLOCK_SLACK || now.saturating_sub(created_at) > STAGE_TTL.as_secs()
}

impl Publisher {
    /// A publisher whose git runs isolated in `jail` (gitjail.rs): the only kind there is
    /// outside tests.
    pub fn new(mirrors: PathBuf, remote_base: String, jail: Arc<GitJail>) -> Publisher {
        Publisher::with_git(mirrors, Git::new(Some(jail), &remote_base))
    }

    /// A publisher whose git runs unisolated, as the test's own user.
    #[cfg(test)]
    pub fn unconfined(mirrors: PathBuf, remote_base: String) -> Publisher {
        Publisher::with_git(mirrors, Git::new(None, &remote_base))
    }

    fn with_git(mirrors: PathBuf, git: Git) -> Publisher {
        Publisher {
            mirrors,
            git,
            review_cap: REVIEW_CAP,
            locks: Mutex::default(),
            new_mirrors: tokio::sync::Mutex::new(()),
            policy: Policy::default(),
            disk: Arc::new(RealDisk),
            clock: Arc::new(unix_secs),
            stats: Mutex::default(),
            #[cfg(test)]
            before_record: None,
        }
    }

    fn records(&self) -> PathBuf {
        self.mirrors.join(".stages")
    }

    /// Where a stage's record is; `id` must be a stage_id().
    fn record_path(&self, id: &str) -> PathBuf {
        self.records().join(format!("{id}.json"))
    }

    fn mirror(&self, owner: &str, name: &str) -> PathBuf {
        self.mirrors.join(owner).join(format!("{name}.git"))
    }

    /// One job at a time per mirror.
    fn lock(&self, dir: &Path) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock().unwrap_or_else(|e| e.into_inner());
        locks.entry(dir.to_path_buf()).or_default().clone()
    }

    /// The mirror, created if new, with GitHub's branches as they are now.
    async fn refresh(&self, dir: &Path, owner: &str, name: &str, token: Option<&str>) -> Result<(), String> {
        if !has_head(dir) {
            tokio::fs::create_dir_all(dir).await.map_err(|e| format!("mirror dir: {e}"))?;
            self.git.run(dir, &["init", "-q", "--bare"], GIT_LOCAL).await?;
        }
        self.git.run_net(dir, &["fetch", "-q", "--prune", "--no-tags", REMOTE, "+refs/heads/*:refs/heads/*"], Net::Fetch { owner, name, token }, GIT_NETWORK).await?;
        Ok(())
    }

    /// refresh(), and what a failed one needs, under the mirror's lock: the housekeeping
    /// (prune), and once more if that removed what fails every fetch into the mirror until
    /// it is gone (a stage ref to a missing object, a lock file a killed git left). A mirror
    /// with no refs yet (its first fetch didn't complete), failed or cut off, is removed.
    async fn update_mirror(&self, dir: &Path, owner: &str, name: &str, token: Option<&str>) -> Result<(), String> {
        let mut new = NewMirror(self.git.is_new(dir).await.then_some(dir));
        let mut updated = self.refresh(dir, owner, name, token).await;
        if updated.is_err() && self.prune(dir).await {
            updated = self.refresh(dir, owner, name, token).await;
        }
        if updated.is_ok() {
            new.0 = None;
        }
        updated
    }

    /// Stage the commits the sandbox has that GitHub doesn't: read, verify, describe, and
    /// record the stage.
    pub async fn stage(&self, vms: &Manager, sandbox: &str, req: StageRequest) -> Result<Staged, Failure> {
        if !vm::valid_id(sandbox) || !plain_name(&req.owner) || !plain_name(&req.name) || !plain_ref(&req.base) || !plain_ref(&req.branch) {
            return Err((400, "stage: a plain sandbox id, owner, name, base branch and branch are needed".into()));
        }
        self.stage_with(sandbox, &req, |to| async move { bundle_from(vms, sandbox, &to).await }).await
    }

    /// stage(), with the bundle written to the path given to `read` (by the VM; in tests, by
    /// hand). Under the mirror's lock: the quotas (upkeep.rs) before and after the refresh,
    /// the refresh, the bundle, the stage; then the housekeeping and the upkeep after a job.
    async fn stage_with<F, R>(&self, sandbox: &str, req: &StageRequest, read: F) -> Result<Staged, Failure>
    where
        F: FnOnce(PathBuf) -> R,
        R: std::future::Future<Output = Result<(), Failure>>,
    {
        let dir = self.mirror(&req.owner, &req.name);
        let lock = self.lock(&dir);
        let _held = lock.lock().await;
        let new = self.git.is_new(&dir).await;
        // A new mirror is admitted, fetched and measured one at a time, so the next one is
        // admitted against what the last one measured, not against the same room.
        let first = if new { Some(self.new_mirrors.lock().await) } else { None };
        self.admit(&dir, &req.owner, &req.name, new)?;
        if let Err(e) = self.update_mirror(&dir, &req.owner, &req.name, req.token.as_deref()).await {
            self.refresh_failed(&dir, &e);
            return Err((502, format!("updating the mirror of {}/{} from GitHub: {e}", req.owner, req.name)));
        }
        if let Err(e) = self.check_size(&dir, &req.owner, &req.name) {
            // A mirror just made for this stage doesn't stay to hold space it had no room for.
            if new {
                self.drop_mirror(&dir);
            }
            return Err(e);
        }
        drop(first);
        let id = new_stage_id_at(self.now()).map_err(|e| (500, e))?;
        // Removed however this ends, a deadline that drops this future included.
        let bundle = TempFile(dir.join(format!("stage-{id}.bundle")));
        let staged = match read(bundle.0.clone()).await {
            Ok(()) => {
                self.mark_heavy(&dir, &bundle.0, &id);
                self.stage_and_record(&dir, &bundle.0, sandbox, req, &id).await
            }
            Err(e) => Err(e),
        };
        drop(bundle);
        self.prune(&dir).await;
        self.after_job(&dir, None).await;
        staged
    }

    /// Verify and describe a bundle (stage_bundle), then write the stage's record. Separate
    /// so it can be tested without a VM.
    async fn stage_and_record(&self, dir: &Path, bundle: &Path, sandbox: &str, req: &StageRequest, id: &str) -> Result<Staged, Failure> {
        let mut staged = self.stage_bundle(dir, bundle, &req.base, id).await?;
        // The bundle is in the mirror now: it must still fit (upkeep.rs). Measured without the
        // bundle's file, which would count twice: a stage's own file (stage_with), in the
        // mirror, is removed here, as soon as its objects are in.
        if bundle.starts_with(dir) {
            let _ = std::fs::remove_file(bundle);
        }
        if let Err(e) = self.check_size(dir, &req.owner, &req.name) {
            let _ = self.git.run(dir, &["update-ref", "-d", &format!("refs/stage/{id}")], GIT_LOCAL).await;
            return Err(e);
        }
        #[cfg(test)]
        if let Some((reached, gate)) = &self.before_record {
            reached.notify_one();
            gate.notified().await;
        }
        // No await from here on: a stage cut off by its deadline or cancelled is cut off at
        // an await, so before this point, and writes no record. Once the record is written
        // the future completes with it.
        let record = StageRecord {
            id: id.to_string(),
            sandbox: sandbox.to_string(),
            owner: req.owner.clone(),
            name: req.name.clone(),
            base: req.base.clone(),
            base_sha: staged.base_sha.clone(),
            branch: req.branch.clone(),
            sha: staged.sha.clone(),
            diff_sha256: staged.diff_sha256.clone(),
            created_at: self.now(),
        };
        self.write_record(&record).map_err(|e| (500, format!("recording the stage: {e}")))?;
        staged.stage = id.to_string();
        Ok(staged)
    }

    /// Write a record atomically and durably: a temporary file, synced, renamed into place,
    /// and the directory synced, so a stage that was answered survives a crash. Synchronous
    /// on purpose (see stage_and_record).
    fn write_record(&self, record: &StageRecord) -> std::io::Result<()> {
        let dir = self.records();
        // The directory's own entry is synced every time, not only by whoever created it: a
        // stage of another repo may have created it and not synced it yet.
        std::fs::create_dir_all(&dir)?;
        sync_dir(&self.mirrors)?;
        let tmp = TempFile(dir.join(format!(".{}.tmp", record.id)));
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&tmp.0)?;
        f.write_all(&serde_json::to_vec(record)?)?;
        f.sync_all()?;
        drop(f);
        let path = self.record_path(&record.id);
        std::fs::rename(&tmp.0, &path)?;
        if let Err(e) = sync_dir(&dir) {
            // Not known to be durable: not answered, so not left behind either.
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
        Ok(())
    }

    /// Take a stage's record for one push: read it, then remove it, before anything else is
    /// checked. Any error is a refusal.
    fn claim(&self, id: &str) -> Result<StageRecord, Failure> {
        let path = self.record_path(id);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err((404, format!("stage {id} isn't here: it never completed, was already used, or expired; stage again")));
            }
            Err(e) => return Err((500, format!("stage {id} can't be read ({e}); nothing was pushed, stage again"))),
        };
        // Removed, and the removal synced: a consumed record can't come back after a crash.
        if let Err(e) = std::fs::remove_file(&path).and_then(|()| sync_dir(&self.records())) {
            return Err((500, format!("stage {id} can't be consumed ({e}); nothing was pushed")));
        }
        match serde_json::from_slice::<StageRecord>(&bytes) {
            Ok(r) if r.id == id => Ok(r),
            Ok(_) => Err((500, format!("stage {id}'s record names another stage; nothing was pushed, stage again"))),
            Err(e) => Err((500, format!("stage {id}'s record is malformed ({e}); nothing was pushed, stage again"))),
        }
    }

    /// The host half of stage: fetch a bundle into refs/stage/<id> and describe it against
    /// the base branch. Separate so it can be tested without a VM.
    async fn stage_bundle(&self, dir: &Path, bundle: &Path, base: &str, id: &str) -> Result<Staged, Failure> {
        let staged_ref = format!("refs/stage/{id}");
        let bundle = bundle.to_string_lossy();
        // One ref, from the bundle's HEAD; no tags; fsck on (git_command). Nothing else in the
        // bundle (tags, replace refs, other branches) can land in the mirror.
        self.git.run(dir, &["fetch", "-q", "--no-tags", &bundle, &format!("HEAD:{staged_ref}")], GIT_LOCAL)
            .await
            .map_err(|e| (422, format!("the sandbox's commits were refused: {e}")))?;
        let sha = match self.git.run(dir, &["rev-parse", "--verify", &format!("{staged_ref}^{{commit}}")], GIT_LOCAL).await {
            Ok(sha) => sha.trim().to_string(),
            Err(e) => {
                let _ = self.git.run(dir, &["update-ref", "-d", &staged_ref], GIT_LOCAL).await;
                return Err((422, format!("the sandbox's HEAD isn't a commit: {e}")));
            }
        };
        // The ref names the commit itself, not a tag that peels to it: the one the record
        // will name, whose objects the ref keeps.
        self.git.run(dir, &["update-ref", &staged_ref, &sha], GIT_LOCAL).await.map_err(|e| (500, e))?;
        let base_ref = format!("refs/heads/{base}");
        let Ok(base_sha) = self.git.run(dir, &["rev-parse", "--verify", "-q", &format!("{base_ref}^{{commit}}")], GIT_LOCAL).await else {
            let _ = self.git.run(dir, &["update-ref", "-d", &staged_ref], GIT_LOCAL).await;
            return Err((404, format!("the base branch {base} isn't on GitHub")));
        };
        let base_sha = base_sha.trim().to_string();
        let range = format!("{base_sha}..{sha}");
        let three_dot = format!("{base_sha}...{sha}");
        // What the approval shows, each read only so far: all of it, or the stage is refused
        // (a cut list of files or authors would hide what is past the cut).
        let review_cap = self.review_cap;
        let git = &self.git;
        let fact = |what: &'static str, args: Vec<&str>| {
            let dir = dir.to_path_buf();
            let args: Vec<String> = args.into_iter().map(String::from).collect();
            async move {
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                match git.capped(&dir, &args, Net::Off, GIT_LOCAL, review_cap).await {
                    Ok((out, false)) => Ok(out),
                    Ok((_, true)) => Err((413, format!("too much to review: the {what} come to over {review_cap} bytes"))),
                    Err(e) => Err((500, e)),
                }
            }
        };
        let described = async {
            let authors: Vec<String> = fact("authors", vec!["log", "--format=%an <%ae>|%cn <%ce>", &range]).await?.lines().map(String::from).collect();
            let stat = fact("stat", vec!["diff", "--no-ext-diff", "--no-textconv", "--stat", &three_dot]).await?;
            // --no-renames: a rename is a delete and an add, so the path it moves away from is
            // listed too. -z: one NUL after each path, none quoted (a newline in a name stays).
            let files: Vec<String> = fact("files", vec!["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", &three_dot]).await?.split('\0').filter(|f| !f.is_empty()).map(String::from).collect();
            // The patch is only an excerpt: cut, not refused.
            let (patch, patch_truncated) = self.git.capped(dir, &["diff", "--no-ext-diff", "--no-textconv", &three_dot], Net::Off, GIT_LOCAL, MAX_PATCH).await.map_err(|e| (500, e))?;
            // The same diff in full, hashed as it streams: what an approval binds, the
            // part past the excerpt included. --full-index: whole blob ids, not abbreviations
            // whose length depends on the mirror (its size, its core.abbrev); a binary change
            // is bound by its blob ids too. No --binary: its deflated data depends on
            // core.compression and the zlib build. Renames, the algorithm and the heuristic
            // are pinned, not left to the git release's defaults (a rename limit's, say).
            // What is left is how a git release prints a diff, which is stable.
            let diff_sha256 = self.git.sha256(dir, &["diff", "--no-ext-diff", "--no-textconv", "--full-index", "--no-renames", "--diff-algorithm=myers", "--indent-heuristic", &three_dot], GIT_LOCAL).await.map_err(|e| (500, e))?;
            Ok::<_, Failure>((authors, stat, files, patch, patch_truncated, diff_sha256))
        };
        let (authors, stat, files, patch, patch_truncated, diff_sha256) = match described.await {
            Ok(d) => d,
            Err(e) => {
                let _ = self.git.run(dir, &["update-ref", "-d", &staged_ref], GIT_LOCAL).await;
                return Err(e);
            }
        };
        if authors.is_empty() {
            let _ = self.git.run(dir, &["update-ref", "-d", &staged_ref], GIT_LOCAL).await;
            return Err((409, format!("no commits to publish: HEAD has nothing that isn't on {base} already")));
        }
        Ok(Staged { stage: String::new(), sha, base_sha, commits: authors.len(), stat, authors, files, patch, patch_truncated, diff_sha256 })
    }

    /// Push the commit a stage recorded to the branch it recorded: never forced, never
    /// anything a completed stage didn't record, never twice for one stage.
    pub async fn push(&self, sandbox: &str, req: PushRequest) -> Result<Pushed, Failure> {
        if !vm::valid_id(sandbox) || !stage_id(&req.stage) || !plain_name(&req.owner) || !plain_name(&req.name) || !commit_id(&req.sha) || !plain_ref(&req.branch) {
            return Err((400, "push: a plain sandbox id, stage id, owner, name, commit id and branch are needed".into()));
        }
        let dir = self.mirror(&req.owner, &req.name);
        let lock = self.lock(&dir);
        let _held = lock.lock().await;
        // Consumed first: from here on this stage authorizes nothing more, whatever happens.
        let record = self.claim(&req.stage)?;
        if expired(record.created_at, self.now()) {
            return Err((410, format!("stage {} has expired (a stage can be pushed for {} h); stage again", req.stage, STAGE_TTL.as_secs() / 3600)));
        }
        let asked = (sandbox, req.owner.as_str(), req.name.as_str(), req.sha.as_str(), req.branch.as_str());
        let recorded = (record.sandbox.as_str(), record.owner.as_str(), record.name.as_str(), record.sha.as_str(), record.branch.as_str());
        if asked != recorded {
            return Err((403, format!("the push doesn't match stage {}: it was {} of {}/{} to {} from sandbox {}; nothing was pushed", req.stage, record.sha, record.owner, record.name, record.branch, record.sandbox)));
        }
        let pushed = self.send(&dir, &record, &req.token).await;
        // The stage's ref is done with either way (its record is gone).
        let _ = self.git.run(&dir, &["update-ref", "-d", &format!("refs/stage/{}", record.id)], GIT_LOCAL).await;
        self.prune(&dir).await;
        // gc before the mirror is measured, so the size kept is what the push left.
        if pushed.is_ok() {
            let _ = self.git.run(&dir, GC_AUTO, GIT_LOCAL).await;
        }
        self.after_job(&dir, pushed.as_ref().ok().map(|_| record.id.as_str())).await;
        if let Err(e) = pushed {
            let status = if e.contains("non-fast-forward") || e.contains("[rejected]") || e.contains("fetch first") { 409 } else { 502 };
            return Err((status, format!("push to {}: {e}", record.branch)));
        }
        Ok(Pushed { sha: record.sha, branch: record.branch })
    }

    /// The push itself, as a git run that never sees the token. To an HTTP remote, sandboxd
    /// first reads where the branch is there and checks the push is a fast-forward from it;
    /// the run may then send only that one update (remote.rs). A file:// remote (tests) is
    /// pushed to directly, and git's own check refuses a non-fast-forward.
    async fn send(&self, dir: &Path, record: &StageRecord, token: &str) -> Result<String, String> {
        let (owner, name, sha) = (record.owner.as_str(), record.name.as_str(), record.sha.as_str());
        let refname = format!("refs/heads/{}", record.branch);
        let refspec = format!("{sha}:{refname}");
        let zero = "0".repeat(sha.len());
        let old = match &self.git.remote {
            Remote::File(_) => zero,
            Remote::Http(base) => {
                let at = tokio::time::timeout(GIT_NETWORK, remote::branch_at(&self.git.client, base, owner, name, token, &refname)).await.map_err(|_| "reading the remote's branches took too long".to_string())??;
                match at {
                    None => zero,
                    Some(old) if !commit_id(&old) => return Err(format!("the remote says {refname} is at {old:?}, not a commit id")),
                    Some(old) => {
                        // Never forced: what the branch is at must be in the mirror, and an
                        // ancestor of what is pushed. A git that couldn't answer refuses too.
                        // The mirror is an earlier run's to write: one that rewrites history
                        // for git (grafts, shallow, replace refs, alternates) is refused, and
                        // the check reads the commits themselves, not a commit-graph.
                        if let Some(what) = rewritten_history(dir) {
                            // Only a git run could have put it there: the mirror goes.
                            self.drop_mirror(dir);
                            return Err(format!("the mirror's history isn't the commits' own ({what}): nothing was pushed, and the mirror was dropped; stage again"));
                        }
                        let off = ["-c", "core.commitGraph=false", "-c", "core.useReplaceRefs=false"];
                        match self.git.says(dir, &[&off[..], &["cat-file", "-e", &format!("{old}^{{commit}}")]].concat()).await {
                            Some(true) => {}
                            Some(false) => return Err(format!("[rejected] {refname} (fetch first): the branch is at {old}, which the stage doesn't have")),
                            None => return Err("checking the branch's commit: git didn't answer".into()),
                        }
                        match self.git.says(dir, &[&off[..], &["merge-base", "--is-ancestor", &old, sha]].concat()).await {
                            Some(true) => {}
                            Some(false) => return Err(format!("[rejected] {refname} (non-fast-forward): the branch is at {old}, which {sha} doesn't follow")),
                            None => return Err("checking the push is a fast-forward: git didn't answer".into()),
                        }
                        old
                    }
                }
            }
        };
        self.git.run_net(dir, &["push", "-q", REMOTE, &refspec], Net::Push { owner, name, token, old: &old, new: sha, refname: &refname }, GIT_NETWORK).await
    }

    /// Housekeeping, never authorization: drop expired records (all repos'), this mirror's
    /// stage refs that are expired, have no record (a stage that failed, was cut off, or was
    /// pushed) or name a missing object, and what dead git processes left (remove_garbage).
    /// Runs under the mirror's lock, so no stage of this mirror is between its ref and its
    /// record, and no git command is running in it. Any failure here only leaves garbage
    /// behind. Whether it removed something that fails every fetch (a ref to a missing
    /// object, a lock file).
    async fn prune(&self, dir: &Path) -> bool {
        let now = self.now();
        let mut repaired = remove_garbage(dir, SystemTime::now());
        if let Ok(entries) = std::fs::read_dir(self.records()) {
            for entry in entries.flatten() {
                let file = entry.file_name();
                let file = file.to_string_lossy();
                let id = file.strip_suffix(".json").or_else(|| file.strip_prefix('.').and_then(|f| f.strip_suffix(".tmp")));
                if id.and_then(stage_secs).is_some_and(|t| expired(t, now)) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
        // for-each-ref lists a ref whose object is missing too, with the id it names.
        for line in self.git.run(dir, &["for-each-ref", "--format=%(refname) %(objectname)", "refs/stage/"], GIT_LOCAL).await.unwrap_or_default().lines() {
            let Some((name, oid)) = line.split_once(' ') else { continue };
            let id = name.trim_start_matches("refs/stage/");
            let stale = match stage_secs(id) {
                Some(t) => expired(t, now) || matches!(std::fs::metadata(self.record_path(id)), Err(e) if e.kind() == std::io::ErrorKind::NotFound),
                None => true,
            };
            // Missing only when git ran and said so; a git that couldn't run or timed out
            // says nothing about the ref.
            let missing = self.git.says(dir, &["cat-file", "-e", oid]).await == Some(false);
            if (stale || missing) && self.git.run(dir, &["update-ref", "-d", name], GIT_LOCAL).await.is_ok() {
                repaired |= missing;
            }
        }
        repaired
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
    // Bounded like every other guest call: the guest is untrusted, and an answer it never
    // sends would otherwise hold this stage, and the repo's lock, for good.
    let _ = tokio::time::timeout(Duration::from_secs(35), vsock::request(&uds, Method::POST, "/exec", Bytes::from(cleanup))).await;
    // A new file, never one already there: the mirror is writable by the uid its git runs
    // as (gitjail.rs), and a link planted at this name must not be followed.
    let write = async {
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::OpenOptions::new().write(true).create_new(true).open(to).await?;
        f.write_all(&out).await?;
        f.flush().await
    };
    write.await.map_err(|e| (500, format!("bundle file: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SANDBOX: &str = "slack_C1_1790000001.000100";

    /// git and whatever it starts (here, a shell alias) run with no capabilities and
    /// no_new_privs, so an exec can't hand root's capabilities back. Only meaningful from a
    /// process that has capabilities: so git_runs_without_capabilities runs this inside a
    /// user namespace, where the test is root with every capability.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "run by git_runs_without_capabilities, in a user namespace"]
    async fn git_without_capabilities_in_userns() {
        let field = |status: &str, name: &str| status.lines().find_map(|l| l.strip_prefix(name)).map(str::trim).unwrap_or_else(|| panic!("no {name} in {status}")).to_string();
        let own = std::fs::read_to_string("/proc/self/status").unwrap();
        assert_ne!(field(&own, "CapEff:"), "0000000000000000", "the test itself has no capabilities to drop");
        let dir = std::env::temp_dir();
        let status = Git::new(None, "file:///").run(&dir, &["-c", "alias.status-of-proc=!cat /proc/self/status", "status-of-proc"], GIT_LOCAL).await.unwrap();
        assert_eq!(field(&status, "NoNewPrivs:"), "1");
        for cap in ["CapInh:", "CapPrm:", "CapEff:", "CapAmb:"] {
            assert_eq!(field(&status, cap), "0000000000000000", "{cap}");
        }
    }

    /// Run one ignored test of this module in a user namespace, where the test is root with
    /// every capability, as sandboxd is: it must pass there.
    #[cfg(target_os = "linux")]
    fn in_userns(test: &str) {
        crate::gitjail::tests::in_userns(&format!("publish::tests::{test}"), false);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn git_runs_without_capabilities() {
        in_userns("git_without_capabilities_in_userns");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn isolated_git_sees_only_its_mirror_and_no_network() {
        in_userns("isolated_git_in_userns");
    }

    /// Stage and push with git isolated (gitjail.rs) but for the uid and the cgroup, which
    /// take real root (the lab checks those, sandbox/lab): its own mount namespace with only
    /// its mirror and git's binaries, no network but sandboxd's proxy.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "run by isolated_git_sees_only_its_mirror_and_no_network, in a user namespace"]
    async fn isolated_git_in_userns() {
        let mut s = scratch("isolated");
        let jail = Arc::new(GitJail::unprivileged(&s.root.join("state")).unwrap());
        s.publisher.git = Git::new(Some(jail.clone()), &format!("file://{}", s.root.display()));
        // A stage and its push, all through isolated runs (a file:// remote is bound in).
        sh(&s.vm, "echo iso > iso && git add iso && git commit -qm iso");
        let staged = s.stage_all(request("scout/iso"), || {}).await.unwrap();
        s.publisher.push(SANDBOX, s.push(&staged, "scout/iso")).await.unwrap();
        assert_eq!(s.remote("scout/iso").as_deref(), Some(staged.sha.as_str()));
        // What a run sees: /usr and the links into it, a few devices, ld.so.cache, its
        // mirror at /repo, its own /tmp. Not /proc, not /etc's files, not the other mirror.
        sh(&s.root, "git clone -q --bare acme/gadgets.git mirrors/acme/gadgets.git");
        let other = s.publisher.mirror("acme", "gadgets");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let script = format!(
            "ls -A /; echo --; ls -A /etc; echo --; ls -A /dev; echo --; cat /proc/self/status 2>/dev/null || echo no-proc; test -e {} && echo other-mirror; test -w /repo/HEAD && echo repo-writable; git ls-remote -q http://127.0.0.1:{port}/x 2>&1 | tail -1",
            other.display()
        );
        let out = s.publisher.git.run(&s.dir(), &["-c", &format!("alias.look=!{script}"), "look"], GIT_LOCAL).await.unwrap_or_else(|e| e);
        eprintln!("what an isolated run sees:\n{out}");
        let parts: Vec<&str> = out.split("--\n").collect();
        assert_eq!(parts.len(), 4, "{out}");
        for entry in parts[0].lines() {
            assert!(["bin", "sbin", "lib", "lib32", "lib64", "libx32", "usr", "nix", "etc", "dev", "tmp", "repo"].contains(&entry), "/ holds {entry}: {out}");
        }
        assert!(parts[1].lines().all(|e| e == "ld.so.cache"), "/etc: {out}");
        assert!(parts[2].lines().all(|e| ["null", "zero", "full", "random", "urandom"].contains(&e)), "/dev: {out}");
        let rest = parts[3];
        assert!(rest.contains("no-proc"), "{out}");
        assert!(!rest.contains("other-mirror"), "{out}");
        assert!(rest.contains("repo-writable"), "{out}");
        // No network: not even the host's loopback, where something listens.
        listener.set_nonblocking(true).unwrap();
        assert!(listener.accept().is_err(), "the run reached the host's loopback: {out}");
        assert!(rest.contains("unreachable") || rest.contains("Couldn't connect") || rest.contains("Failed to connect"), "{out}");
        // No IPC object outlives its run: a SysV segment one run makes isn't there for the
        // next (cgroup.kill doesn't remove one; an IPC namespace of its own does).
        if std::process::Command::new("ipcmk").arg("--help").output().is_ok() {
            let made = s.publisher.git.run(&s.dir(), &["-c", "alias.mk=!ipcmk -M 4096", "mk"], GIT_LOCAL).await.unwrap();
            let id = made.split_whitespace().last().unwrap().to_string();
            let removed = s.publisher.git.run(&s.dir(), &["-c", &format!("alias.drop=!ipcrm -m {id} && echo removed-by-a-later-run"), "drop"], GIT_LOCAL).await.unwrap_or_else(|e| e);
            assert!(!removed.contains("removed-by-a-later-run"), "segment {id}, made by one run, was there for the next: {removed}");
        }
        // A run that talks to an HTTP remote reaches only sandboxd's proxy, which forwards
        // to the remote with the token; the run itself never sees the token.
        let (url, seen, _server) = smart_http(s.root.clone()).await;
        s.publisher.git = Git::new(Some(jail), &url);
        let staged = s.stage_all(request("scout/iso2"), || {}).await.unwrap();
        let mut req = s.push(&staged, "scout/iso2");
        req.token = "tok-only-for-the-proxy".into();
        s.publisher.push(SANDBOX, req).await.unwrap();
        assert_eq!(s.remote("scout/iso2").as_deref(), Some(staged.sha.as_str()));
        let seen = seen.lock().unwrap().join("\n");
        assert!(seen.contains(&format!("POST /acme/widgets.git/git-receive-pack auth={}", basic("tok-only-for-the-proxy"))), "{seen}");
    }

    /// The processes whose real uid is in git's range: (pid, uid).
    #[cfg(target_os = "linux")]
    fn git_uid_processes(base: u32) -> Vec<(u32, u32)> {
        let mut found = Vec::new();
        for entry in std::fs::read_dir("/proc").unwrap().flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
            let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else { continue };
            let uid = status.lines().find_map(|l| l.strip_prefix("Uid:")).and_then(|v| v.split_whitespace().next()).and_then(|v| v.parse::<u32>().ok());
            if let Some(uid) = uid.filter(|u| (base..base + gitjail::GIT_UIDS).contains(u)) {
                found.push((pid, uid));
            }
        }
        found
    }

    /// All of the isolation, the uid and the cgroup included: as root, in a delegated cgroup,
    /// as sandboxd runs. The lab runs it (sandbox/lab/README.md):
    /// `systemd-run --scope -p Delegate=yes cargo test -- --ignored as_root`.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "needs root and a delegated cgroup: the lab runs it"]
    async fn isolated_git_as_root() {
        const BASE: u32 = 1_900_100_000;
        assert_eq!(unsafe { libc::geteuid() }, 0, "run as root");
        let vms = crate::jail::setup_cgroups().await.expect("a delegated cgroup (systemd-run --scope -p Delegate=yes)");
        let cgroups = Path::new("/sys/fs/cgroup").join(vms.strip_suffix("/vms").unwrap()).join("git");
        let mut s = scratch("asroot");
        let jail = Arc::new(GitJail::prepare(&s.root.join("state"), cgroups.clone(), BASE, 1536 << 20).unwrap());
        // The file:// "GitHub" is the test's, so any uid may write it.
        sh(&s.root, "chmod -R a+rwX acme && chmod a+rx .");
        s.publisher.git = Git::new(Some(jail.clone()), &format!("file://{}", s.root.display()));
        sh(&s.vm, "echo root > root && git add root && git commit -qm root");
        let staged = s.stage_all(request("scout/root"), || {}).await.unwrap();
        s.publisher.push(SANDBOX, s.push(&staged, "scout/root")).await.unwrap();
        assert_eq!(s.remote("scout/root").as_deref(), Some(staged.sha.as_str()));
        // The mirror belongs to the last run's uid, one of git's.
        let owner = std::os::unix::fs::MetadataExt::uid(&std::fs::metadata(s.dir().join("HEAD")).unwrap());
        assert!((BASE..BASE + gitjail::GIT_UIDS).contains(&owner), "the mirror isn't a git uid's");
        // A run, seen from outside while it runs: its uid, no capabilities, no_new_privs, its
        // own cgroup under git/, its own mount and network namespaces, a root with no /etc
        // of the host's in it.
        let hold = {
            let git = Git::new(Some(jail.clone()), "file:///nonexistent");
            let dir = s.dir();
            tokio::spawn(async move { git.run(&dir, &["-c", "alias.hold=!sleep 3; git ls-remote -q http://1.1.1.1/x 2>&1 | tail -1", "hold"], GIT_LOCAL).await })
        };
        let mut seen = Vec::new();
        for _ in 0..200 {
            seen = git_uid_processes(BASE);
            if !seen.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let (pid, uid) = *seen.first().expect("a git run to look at");
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
        let field = |name: &str| status.lines().find_map(|l| l.strip_prefix(name)).map(str::trim).unwrap_or_default().to_string();
        eprintln!("pid {pid}, a git uid: CapEff {} CapPrm {} NoNewPrivs {}", field("CapEff:"), field("CapPrm:"), field("NoNewPrivs:"));
        assert_ne!(uid, 0);
        assert_eq!(field("Uid:").split_whitespace().collect::<Vec<_>>(), vec![uid.to_string(); 4]);
        assert_eq!(field("CapEff:"), "0000000000000000");
        assert_eq!(field("CapPrm:"), "0000000000000000");
        assert_eq!(field("NoNewPrivs:"), "1");
        let cgroup = std::fs::read_to_string(format!("/proc/{pid}/cgroup")).unwrap();
        eprintln!("cgroup {}", cgroup.trim());
        assert!(cgroup.trim().ends_with(&format!("/git/u{uid}")), "{cgroup}");
        let run_cgroup = Path::new("/sys/fs/cgroup").join(cgroup.trim().trim_start_matches("0::/"));
        let limit = |f: &str| std::fs::read_to_string(run_cgroup.join(f)).unwrap_or_default().trim().to_string();
        eprintln!("memory.max {} memory.swap.max {} memory.oom.group {} pids.max {}", limit("memory.max"), limit("memory.swap.max"), limit("memory.oom.group"), limit("pids.max"));
        assert_eq!((limit("memory.max"), limit("memory.oom.group")), ((1536u64 << 20).to_string(), "1".to_string()));
        // Under sandboxd.service's confinement (no CAP_SYS_PTRACE) another uid's namespaces
        // and root can't be looked into at all; as plain root they can.
        if std::fs::read_link(format!("/proc/{pid}/ns/mnt")).is_err() {
            eprintln!("its namespaces and root aren't readable from here (no CAP_SYS_PTRACE): not checked");
        } else {
            for ns in ["mnt", "net"] {
                let theirs = std::fs::read_link(format!("/proc/{pid}/ns/{ns}")).unwrap();
                let ours = std::fs::read_link(format!("/proc/self/ns/{ns}")).unwrap();
                eprintln!("{ns}: {} (sandboxd's: {})", theirs.display(), ours.display());
                assert_ne!(theirs, ours, "{ns}");
            }
            let root: Vec<String> = std::fs::read_dir(format!("/proc/{pid}/root")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            let etc: Vec<String> = std::fs::read_dir(format!("/proc/{pid}/root/etc")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            eprintln!("its /: {root:?}; its /etc: {etc:?}");
            assert!(etc.iter().all(|e| e == "ld.so.cache"), "{etc:?}");
            assert!(std::fs::metadata(format!("/proc/{pid}/root/etc/lorehouse")).is_err());
            assert!(std::fs::metadata(format!("/proc/{pid}/root/run")).is_err());
            assert!(std::fs::metadata(format!("/proc/{pid}/root/sys")).is_err());
            assert!(std::fs::metadata(format!("/proc/{pid}/root/proc")).is_err());
        }
        // And no network: not even an address on the internet.
        let held = hold.await.unwrap().unwrap();
        eprintln!("its network: {}", held.trim());
        assert!(held.contains("unreachable") || held.contains("connect"), "{held}");
        // A process that leaves git's process group (setsid) is killed with the run's cgroup,
        // before its uid is used again.
        let git = Git::new(Some(jail.clone()), "file:///nonexistent");
        git.run(&s.dir(), &["-c", "alias.escape=!setsid sleep 300 </dev/null >/dev/null 2>&1 & echo started", "escape"], GIT_LOCAL).await.unwrap();
        let left = git_uid_processes(BASE);
        assert!(left.is_empty(), "a process of git's uids was left after the run");
        let cgroups_left: Vec<_> = std::fs::read_dir(&cgroups).unwrap().flatten().filter(|e| e.file_type().unwrap().is_dir()).map(|e| e.file_name()).collect();
        assert!(cgroups_left.is_empty(), "{cgroups_left:?}");
        // Two runs at once never share a uid.
        let (other, dir) = (Git::new(Some(jail.clone()), "file:///nonexistent"), s.dir());
        let (a, b) = tokio::join!(git.run(&dir, &["-c", "alias.me=!id -u; sleep 1", "me"], GIT_LOCAL), other.run(&dir, &["-c", "alias.me=!id -u; sleep 1", "me"], GIT_LOCAL));
        let (a, b) = (a.unwrap(), b.unwrap());
        eprintln!("two runs at once: uids {} and {}", a.trim(), b.trim());
        assert_ne!(a.trim(), b.trim());
    }

    fn basic(token: &str) -> String {
        use base64::{engine::general_purpose::STANDARD as B64, Engine};
        format!("Basic {}", B64.encode(format!("x-access-token:{token}")))
    }

    /// A smart-HTTP git server over the bare repos in `root` (`git http-backend`), standing in
    /// for GitHub: its URL, and every request it got (`<method> <path?query> auth=<header>`).
    async fn smart_http(root: PathBuf) -> (String, Arc<Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let log = seen.clone();
        let app = axum::Router::new().fallback(move |req: axum::extract::Request| {
            let (root, log) = (root.clone(), log.clone());
            async move {
                use tokio::io::AsyncWriteExt;
                let (parts, body) = req.into_parts();
                let header = |n: &str| parts.headers.get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                log.lock().unwrap().push(format!("{} {} auth={}", parts.method, parts.uri, if header("authorization").is_empty() { "-".into() } else { header("authorization") }));
                let body = axum::body::to_bytes(body, usize::MAX).await.unwrap();
                let mut cgi = tokio::process::Command::new("git");
                cgi.arg("http-backend")
                    .env("GIT_PROJECT_ROOT", &root)
                    .env("GIT_HTTP_EXPORT_ALL", "1")
                    .env("GIT_CONFIG_GLOBAL", "/dev/null")
                    .env("GIT_CONFIG_NOSYSTEM", "1")
                    .env("REMOTE_USER", "test")
                    .env("REQUEST_METHOD", parts.method.as_str())
                    .env("PATH_INFO", parts.uri.path())
                    .env("QUERY_STRING", parts.uri.query().unwrap_or(""))
                    .env("CONTENT_TYPE", header("content-type"))
                    .env("CONTENT_LENGTH", body.len().to_string())
                    .env("HTTP_GIT_PROTOCOL", header("git-protocol"))
                    .env("HTTP_CONTENT_ENCODING", header("content-encoding"))
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped());
                let mut child = cgi.spawn().unwrap();
                let mut stdin = child.stdin.take().unwrap();
                stdin.write_all(&body).await.unwrap();
                drop(stdin);
                let out = child.wait_with_output().await.unwrap().stdout;
                let split = out.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, 4)).or_else(|| out.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2))).unwrap();
                let mut resp = axum::response::Response::builder();
                for line in String::from_utf8_lossy(&out[..split.0]).lines() {
                    let Some((k, v)) = line.split_once(':') else { continue };
                    if k.eq_ignore_ascii_case("status") {
                        resp = resp.status(v.trim()[..3].parse::<u16>().unwrap());
                    } else {
                        resp = resp.header(k.trim(), v.trim());
                    }
                }
                resp.body(axum::body::Body::from(out[split.0 + split.1..].to_vec())).unwrap()
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        (url, seen, task)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_http_remote_is_reached_only_through_sandboxd_which_adds_the_token() {
        let mut s = scratch("proxied");
        let (url, seen, _server) = smart_http(s.root.clone()).await;
        s.publisher.git = Git::new(None, &url);
        let head = sh(&s.vm, "echo p > p && git add p && git commit -qm p && git rev-parse HEAD");
        let mut req = request("scout/p");
        req.token = Some("read-tok".into());
        let staged = s.stage_all(req, || {}).await.unwrap();
        let mut push = s.push(&staged, "scout/p");
        push.token = "write-tok".into();
        s.publisher.push(SANDBOX, push).await.unwrap();
        assert_eq!(s.remote("scout/p").as_deref(), Some(head.as_str()));
        let log = seen.lock().unwrap().join("\n");
        // The fetch with the read token, the push with the write token, sandboxd's own read
        // of the branches before the push with it too.
        assert!(log.contains(&format!("GET /acme/widgets.git/info/refs?service=git-upload-pack auth={}", basic("read-tok"))), "{log}");
        assert!(log.contains(&format!("POST /acme/widgets.git/git-receive-pack auth={}", basic("write-tok"))), "{log}");
        assert_eq!(log.matches("GET /acme/widgets.git/info/refs?service=git-receive-pack").count(), 2, "{log}");
        // And git itself never had it: what a push run's environment holds.
        let zero = "0".repeat(40);
        let net = Net::Push { owner: "acme", name: "widgets", token: "write-tok", old: &zero, new: &head, refname: "refs/heads/scout/q" };
        let env = s.publisher.git.run_net(&s.dir(), &["-c", "alias.env=!env; git config --list", "env"], net, GIT_LOCAL).await.unwrap();
        assert!(!env.contains("write-tok") && !env.contains(&basic("write-tok")[6..]) && !env.to_lowercase().contains("authorization"), "{env}");
    }

    #[tokio::test]
    async fn sandboxd_reads_a_mirror_without_following_links_or_waiting_on_a_fifo() {
        // A mirror's files are git's (an untrusted uid's) to write: what sandboxd reads
        // there, as root, may be a link anywhere or a FIFO no one writes.
        let s = scratch("planted");
        let dir = s.dir();
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        let outside = s.root.join("outside");
        std::fs::create_dir_all(outside.join("stage")).unwrap();
        std::fs::write(outside.join("stage/a"), b"").unwrap();
        std::fs::write(outside.join("packed"), format!("{} refs/stage/x\n", "1".repeat(40)).repeat(3)).unwrap();
        std::fs::create_dir_all(dir.join("refs")).unwrap();
        let _ = std::fs::remove_dir_all(dir.join("refs/stage"));
        std::os::unix::fs::symlink(outside.join("stage"), dir.join("refs/stage")).unwrap();
        let _ = std::fs::remove_file(dir.join("packed-refs"));
        std::os::unix::fs::symlink(outside.join("packed"), dir.join("packed-refs")).unwrap();
        assert_eq!(upkeep::count_stage_refs(&dir), 0, "counted through links");
        // A FIFO: read without waiting (before, measure() blocked on it for good).
        std::fs::remove_file(dir.join("packed-refs")).unwrap();
        let fifo = std::ffi::CString::new(dir.join("packed-refs").to_string_lossy().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let (tx, rx) = std::sync::mpsc::channel();
        let d = dir.clone();
        std::thread::spawn(move || tx.send(upkeep::count_stage_refs(&d)));
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)), Ok(0), "reading a FIFO in the mirror blocked");
        // Nor a file past its cap: a packed-refs of more than 64 MiB isn't read.
        std::fs::remove_file(dir.join("packed-refs")).unwrap();
        std::fs::File::create(dir.join("packed-refs")).unwrap().set_len(65 << 20).unwrap();
        assert_eq!(read_in_mirror(&dir.join("packed-refs"), 64 << 20), None);
        // HEAD as a link (to nothing) is a mirror's HEAD all the same; nothing follows it.
        std::fs::remove_file(dir.join("packed-refs")).unwrap();
        std::fs::remove_file(dir.join("HEAD")).unwrap();
        std::os::unix::fs::symlink(s.root.join("nothing"), dir.join("HEAD")).unwrap();
        assert!(has_head(&dir));
        // A heavy-stage check doesn't follow a link at the bundle's name.
        std::fs::File::create(outside.join("big")).unwrap().set_len(1 << 30).unwrap();
        std::os::unix::fs::symlink(outside.join("big"), dir.join("stage-x.bundle")).unwrap();
        s.publisher.mark_heavy(&dir, &dir.join("stage-x.bundle"), "x");
        assert!(upkeep::read_state(&dir).is_none_or(|st| st.heavy.is_empty()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_mirror_whose_history_was_rewritten_is_never_pushed_from_over_the_branch() {
        // The branch moved on at GitHub to a commit the staged one doesn't follow; a mirror
        // that grafts it under the staged commit would pass the fast-forward check, and the
        // push would replace the branch.
        let mut s = scratch("grafted");
        let (url, _seen, _server) = smart_http(s.root.clone()).await;
        s.publisher.git = Git::new(None, &url);
        let staged_head = sh(&s.vm, "echo g > g && git add g && git commit -qm g && git rev-parse HEAD");
        let staged = s.stage("scout/g").await.unwrap();
        let theirs = sh(&s.root, "git clone -q acme/widgets.git other && cd other && echo o > o && git add o && git -c user.name=x -c user.email=x@x commit -qm o && git push -q origin HEAD:refs/heads/scout/g && git rev-parse HEAD");
        s.publisher.refresh(&s.dir(), "acme", "widgets", None).await.unwrap();
        let dir = s.dir();
        for (name, plant) in [
            ("info/grafts", format!("std:info/grafts:{staged_head} {theirs}\n")),
            ("shallow", format!("std:shallow:{theirs}\n")),
            ("objects/info/alternates", "std:objects/info/alternates:/nonexistent\n".to_string()),
            ("refs/replace", format!("git:replace -f {staged_head} {theirs}")),
        ] {
            let stage = if name == "info/grafts" { staged.stage.clone() } else { s.stage("scout/g").await.unwrap().stage };
            match plant.split_once(':').unwrap() {
                ("std", rest) => {
                    let (file, content) = rest.split_once(':').unwrap();
                    std::fs::create_dir_all(dir.join(file).parent().unwrap()).unwrap();
                    std::fs::write(dir.join(file), content).unwrap();
                }
                (_, cmd) => drop(sh(&dir, &format!("git {cmd}"))),
            }
            let mut req = s.push(&staged, "scout/g");
            req.stage = stage;
            let err = s.publisher.push(SANDBOX, req).await.unwrap_err();
            assert!(err.0 == 409 || err.0 == 502, "{name}: {err:?}");
            assert_eq!(s.remote("scout/g").as_deref(), Some(theirs.as_str()), "{name}: the branch was replaced");
            let _ = std::fs::remove_file(dir.join(name));
            let _ = std::fs::remove_dir_all(dir.join(name));
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_push_over_a_mebibyte_goes_through_the_proxy() {
        // Over http.postBuffer's default (1 MiB), git's remote-curl would first probe
        // receive-pack with a bare flush-pkt, which a strict check refuses.
        let mut s = scratch("bigpush");
        let (url, _seen, _server) = smart_http(s.root.clone()).await;
        s.publisher.git = Git::new(None, &url);
        let head = sh(&s.vm, "head -c 3000000 /dev/urandom > big.bin && git add big.bin && git commit -qm big && git rev-parse HEAD");
        let staged = s.stage("scout/big").await.unwrap();
        s.publisher.push(SANDBOX, s.push(&staged, "scout/big")).await.unwrap();
        assert_eq!(s.remote("scout/big").as_deref(), Some(head.as_str()));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_push_run_may_send_only_the_update_sandboxd_checked() {
        let mut s = scratch("narrow");
        let (url, seen, _server) = smart_http(s.root.clone()).await;
        s.publisher.git = Git::new(None, &url);
        let main = s.remote("main").unwrap();
        sh(&s.vm, "echo n > n && git add n && git commit -qm n");
        let staged = s.stage("scout/n").await.unwrap();
        let zero = "0".repeat(40);
        let narrow = || Net::Push { owner: "acme", name: "widgets", token: "t", old: &zero, new: &staged.sha, refname: "refs/heads/scout/n" };
        // A git that pushes another branch (main) than its grant: refused, nothing forwarded.
        let err = s.publisher.git.run_net(&s.dir(), &["push", "-q", REMOTE, &format!("{}:refs/heads/main", staged.sha)], narrow(), GIT_NETWORK).await.unwrap_err();
        assert!(err.contains("sandboxd refused it"), "{err}");
        assert_eq!(s.remote("main"), Some(main));
        assert!(!seen.lock().unwrap().iter().any(|l| l.starts_with("POST /acme/widgets.git/git-receive-pack")), "{:?}", seen.lock().unwrap());
        // A fetch run can't push at all.
        let fetch = Net::Fetch { owner: "acme", name: "widgets", token: None };
        let err = s.publisher.git.run_net(&s.dir(), &["push", "-q", REMOTE, &format!("{}:refs/heads/scout/n", staged.sha)], fetch, GIT_NETWORK).await.unwrap_err();
        assert!(err.contains("sandboxd refused it"), "{err}");
        assert_eq!(s.remote("scout/n"), None);
        // The update its grant names goes through.
        s.publisher.git.run_net(&s.dir(), &["push", "-q", REMOTE, &format!("{}:refs/heads/scout/n", staged.sha)], narrow(), GIT_NETWORK).await.unwrap();
        assert_eq!(s.remote("scout/n").as_deref(), Some(staged.sha.as_str()));
        sh(&s.root, "git -C acme/widgets.git update-ref -d refs/heads/scout/n");
        // A branch that moved on at the remote to a commit the stage doesn't follow: refused
        // before git runs (never forced).
        sh(&s.root, "git clone -q acme/widgets.git elsewhere && cd elsewhere && echo e > e && git add e && git -c user.name=x -c user.email=x@x commit -qm e && git push -q origin HEAD:refs/heads/scout/n");
        let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/n")).await.unwrap_err();
        assert_eq!(err.0, 409, "{}", err.1);
        assert!(err.1.contains("fetch first"), "{}", err.1);
    }

    /// A scratch area: a bare "GitHub" remote with main, a clone standing in for the VM's
    /// checkout, and a Publisher whose remote base is the scratch directory.
    struct Scratch {
        root: PathBuf,
        vm: PathBuf,
        publisher: Publisher,
        /// The sizes the publisher's quotas see.
        disk: Arc<FakeDisk>,
        /// How far ahead of the system clock the publisher's clock is, in seconds.
        later: Arc<std::sync::atomic::AtomicU64>,
    }

    /// Sizes set by hand: a mirror (by "owner/name") uses what `sizes` says, else what is on
    /// disk; the filesystem is what `fs` says (free, size), or unknown (no floor).
    #[derive(Default)]
    struct FakeDisk {
        sizes: Mutex<HashMap<String, u64>>,
        fs: Mutex<Option<(u64, u64)>>,
        /// Once this mirror is measured, the filesystem becomes this.
        fs_on_measure: Mutex<Option<(String, (u64, u64))>>,
        /// Run once this mirror is measured.
        on_measure: Mutex<Option<(String, Hook)>>,
    }

    type Hook = Box<dyn FnOnce() + Send>;

    impl Disk for FakeDisk {
        fn usage(&self, dir: &Path) -> (u64, u64) {
            let repo = format!("{}/{}", dir.parent().unwrap().file_name().unwrap().to_string_lossy(), dir.file_name().unwrap().to_string_lossy().trim_end_matches(".git"));
            if let Some((_, fs)) = self.fs_on_measure.lock().unwrap().as_ref().filter(|(r, _)| *r == repo) {
                *self.fs.lock().unwrap() = Some(*fs);
            }
            let hook = self.on_measure.lock().unwrap().take_if(|(r, _)| *r == repo);
            if let Some((_, run)) = hook {
                run();
            }
            match self.sizes.lock().unwrap().get(&repo) {
                Some(&bytes) => (bytes, 0),
                None => RealDisk.usage(dir),
            }
        }
        fn fs(&self, _: &Path) -> Option<(u64, u64)> {
            *self.fs.lock().unwrap()
        }
    }

    /// The scratch area is removed when the test ends, passed or failed (a panic unwinds
    /// through this too).
    impl Drop for Scratch {
        fn drop(&mut self) {
            if std::fs::remove_dir_all(&self.root).is_err() {
                // A test that failed mid-way can leave a directory read-only: make every
                // directory writable again, then retry.
                #[cfg(unix)]
                writable(&self.root);
                let _ = std::fs::remove_dir_all(&self.root);
            }
        }
    }

    #[cfg(unix)]
    fn writable(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                writable(&entry.path());
            }
        }
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
        sh(&root, "git init -q --bare acme/widgets.git && git init -q --bare acme/gadgets.git && git init -q -b main vm && cd vm && echo a > a && git add a && git commit -qm base && git remote add origin ../acme/widgets.git && git push -q origin main && git push -q ../acme/gadgets.git main && git fetch -q origin");
        let vm = root.join("vm");
        let mut publisher = Publisher::unconfined(root.join("mirrors"), format!("file://{}", root.display()));
        let disk = Arc::new(FakeDisk::default());
        publisher.disk = disk.clone();
        let later = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let ahead = later.clone();
        publisher.clock = Arc::new(move || unix_secs() + ahead.load(std::sync::atomic::Ordering::SeqCst));
        Scratch { root, vm, publisher, disk, later }
    }

    fn request(branch: &str) -> StageRequest {
        StageRequest { owner: "acme".into(), name: "widgets".into(), base: "main".into(), branch: branch.into(), token: None }
    }

    impl Scratch {
        fn dir(&self) -> PathBuf {
            self.publisher.mirror("acme", "widgets")
        }
        /// A bundle of what the VM's checkout has that origin doesn't, and the mirror refreshed.
        async fn bundle(&self) -> PathBuf {
            let bundle = self.root.join(format!("{}.bundle", new_stage_id().unwrap()));
            sh(&self.vm, &format!("git bundle create -q {} HEAD --not --remotes=origin", bundle.display()));
            self.publisher.refresh(&self.dir(), "acme", "widgets", None).await.unwrap();
            bundle
        }
        /// What stage does with a VM, minus the VM: bundle, verify, record.
        async fn stage(&self, branch: &str) -> Result<Staged, Failure> {
            let bundle = self.bundle().await;
            self.publisher.stage_and_record(&self.dir(), &bundle, SANDBOX, &request(branch), &new_stage_id().unwrap()).await
        }
        /// All of stage but the VM (the quotas, the refresh, the housekeeping and the upkeep
        /// after it included), with `during` run while the bundle is read.
        async fn stage_all(&self, req: StageRequest, during: impl FnOnce()) -> Result<Staged, Failure> {
            let bundle = self.root.join(format!("{}.bundle", new_stage_id().unwrap()));
            sh(&self.vm, &format!("git bundle create -q {} HEAD --not --remotes=origin", bundle.display()));
            self.publisher
                .stage_with(SANDBOX, &req, |to| async move {
                    during();
                    std::fs::copy(&bundle, &to).map(|_| ()).map_err(|e| (500, e.to_string()))
                })
                .await
        }
        /// Move the publisher's clock on.
        fn advance(&self, secs: u64) {
            self.later.fetch_add(secs, std::sync::atomic::Ordering::SeqCst);
        }
        fn size(&self, repo: &str, bytes: u64) {
            self.disk.sizes.lock().unwrap().insert(repo.to_string(), bytes);
        }
        /// Whether a mirror has an object.
        fn has(&self, name: &str, oid: &str) -> bool {
            std::process::Command::new("git").args(["-C", &self.publisher.mirror("acme", name).to_string_lossy(), "cat-file", "-e", oid]).env("GIT_CONFIG_GLOBAL", "/dev/null").env("GIT_CONFIG_NOSYSTEM", "1").status().unwrap().success()
        }
        fn refs(&self) -> Vec<String> {
            sh(&self.dir(), "git for-each-ref --format='%(refname)'").lines().map(String::from).collect()
        }
        fn stage_refs(&self) -> Vec<String> {
            self.refs().into_iter().filter(|r| r.starts_with("refs/stage/")).collect()
        }
        /// The stage records on disk (temporary files included).
        fn records(&self) -> Vec<String> {
            std::fs::read_dir(self.publisher.records()).map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default()
        }
        fn push(&self, staged: &Staged, branch: &str) -> PushRequest {
            PushRequest { stage: staged.stage.clone(), owner: "acme".into(), name: "widgets".into(), sha: staged.sha.clone(), branch: branch.into(), token: "unused-for-file-remotes".into() }
        }
        /// The commit a branch is at on "GitHub", if it exists.
        fn remote(&self, branch: &str) -> Option<String> {
            let out = std::process::Command::new("git").args(["-C", "acme/widgets.git", "rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).current_dir(&self.root).output().unwrap();
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    }

    #[tokio::test]
    async fn stage_describes_the_commits_and_push_sends_exactly_the_staged_one() {
        let s = scratch("happy");
        let head = sh(&s.vm, "echo hello > POC.md && git add POC.md && git commit -qm poc && git rev-parse HEAD");
        let staged = s.stage("scout/poc").await.unwrap();
        assert!(stage_id(&staged.stage), "{}", staged.stage);
        assert_eq!(staged.sha, head);
        assert_eq!(staged.commits, 1);
        assert_eq!(staged.files, vec!["POC.md"]);
        assert!(staged.stat.contains("POC.md | 1 +"));
        assert_eq!(staged.authors, vec!["bot <1+bot@users.noreply.github.com>|bot <1+bot@users.noreply.github.com>"]);
        assert!(staged.patch.contains("+hello") && !staged.patch_truncated);
        assert_eq!(s.records(), vec![format!("{}.json", staged.stage)], "one record, no temporary file");
        let pushed = s.publisher.push(SANDBOX, s.push(&staged, "scout/poc")).await.unwrap();
        assert_eq!(pushed.sha, head);
        assert_eq!(s.remote("scout/poc").as_deref(), Some(head.as_str()));
        assert!(s.stage_refs().is_empty(), "a pushed stage's ref is dropped");
        assert!(s.records().is_empty(), "and its record consumed");
    }

    #[tokio::test]
    async fn a_ref_without_a_record_is_not_pushable() {
        // Verified into refs/stage/<id>, with no record written: the state a stage cut off
        // between the two is in. The ref names the commit, and still authorizes nothing.
        let s = scratch("norecord");
        let head = sh(&s.vm, "echo x > x && git add x && git commit -qm x && git rev-parse HEAD");
        let bundle = s.bundle().await;
        let id = new_stage_id().unwrap();
        let mut staged = s.publisher.stage_bundle(&s.dir(), &bundle, "main", &id).await.unwrap();
        staged.stage = id.clone();
        assert_eq!(sh(&s.dir(), &format!("git rev-parse refs/stage/{id}")), head);
        let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/x")).await.unwrap_err();
        assert_eq!(err.0, 404, "{}", err.1);
        assert_eq!(s.remote("scout/x"), None);
        // Nor is a commit no stage produced, under a made-up stage id.
        let main = sh(&s.vm, "git rev-parse origin/main");
        let made_up = Staged { stage: new_stage_id().unwrap(), sha: main, ..staged };
        assert_eq!(s.publisher.push(SANDBOX, s.push(&made_up, "scout/x")).await.unwrap_err().0, 404);
        assert_eq!(s.remote("scout/x"), None);
    }

    #[tokio::test]
    async fn a_stage_cut_off_by_its_deadline_or_cancelled_writes_no_record() {
        let mut s = scratch("cutoff");
        let head = sh(&s.vm, "echo c > c && git add c && git commit -qm c && git rev-parse HEAD");
        // Every stage stops after verifying, right before its record: the last moment a
        // deadline or a cancel can land. `reached` says a stage is there.
        let reached = Arc::new(tokio::sync::Notify::new());
        s.publisher.before_record = Some((reached.clone(), Arc::new(tokio::sync::Notify::new())));
        let bundle = s.bundle().await;
        let dir = s.dir();
        let req = request("scout/c");

        // The deadline: the runner's timeout drops the stage, once it is at the gate.
        let id = new_stage_id().unwrap();
        {
            let stage = s.publisher.stage_and_record(&dir, &bundle, SANDBOX, &req, &id);
            tokio::pin!(stage);
            tokio::select! {
                _ = &mut stage => panic!("the gate holds the stage"),
                _ = reached.notified() => {}
            }
            let cut = tokio::time::timeout(Duration::from_millis(50), &mut stage).await;
            assert!(cut.is_err(), "the stage was cut off");
        }
        assert_eq!(sh(&dir, &format!("git rev-parse refs/stage/{id}")), head, "verification finished");
        assert!(s.records().is_empty(), "{:?}", s.records());
        let staged = Staged { stage: id, sha: head.clone(), base_sha: String::new(), commits: 1, stat: String::new(), authors: vec![], files: vec![], patch: String::new(), patch_truncated: false, diff_sha256: String::new() };
        let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/c")).await.unwrap_err();
        assert_eq!(err.0, 404, "{}", err.1);

        // A cancel: the stage future is dropped at the gate.
        let id = new_stage_id().unwrap();
        tokio::select! {
            _ = s.publisher.stage_and_record(&dir, &bundle, SANDBOX, &req, &id) => panic!("the gate holds the stage"),
            _ = reached.notified() => {}
        }
        assert_eq!(sh(&dir, &format!("git rev-parse refs/stage/{id}")), head, "verification finished");
        assert!(s.records().is_empty(), "{:?}", s.records());
        let staged = Staged { stage: id, ..staged };
        let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/c")).await.unwrap_err();
        assert_eq!(err.0, 404, "{}", err.1);
        assert_eq!(s.remote("scout/c"), None);
        // The refs left behind are dropped by the next housekeeping.
        s.publisher.prune(&dir).await;
        assert!(s.stage_refs().is_empty(), "{:?}", s.stage_refs());
    }

    #[tokio::test]
    async fn a_record_is_used_once_and_a_replay_stages_again() {
        let s = scratch("once");
        let head = sh(&s.vm, "echo r > r && git add r && git commit -qm r && git rev-parse HEAD");
        let first = s.stage("scout/r").await.unwrap();
        s.publisher.push(SANDBOX, s.push(&first, "scout/r")).await.unwrap();
        // The same stage again: consumed.
        let err = s.publisher.push(SANDBOX, s.push(&first, "scout/r")).await.unwrap_err();
        assert_eq!(err.0, 404, "{}", err.1);
        // A replay (Lorehouse re-runs open_pull_request after a restart): the checkout's
        // origin/* doesn't know about the push, so the same commits stage again, under a new
        // id, and pushing them again is a no-op.
        let replay = s.stage("scout/r").await.unwrap();
        assert_eq!(replay.sha, head);
        assert_ne!(replay.stage, first.stage);
        s.publisher.push(SANDBOX, s.push(&replay, "scout/r")).await.unwrap();
        assert_eq!(s.remote("scout/r").as_deref(), Some(head.as_str()));
    }

    #[tokio::test]
    async fn a_push_that_does_not_match_its_stage_is_refused_and_uses_the_stage_up() {
        let s = scratch("mismatch");
        sh(&s.vm, "echo m > m && git add m && git commit -qm m");
        let other_sha = sh(&s.vm, "git rev-parse origin/main");
        type Alter = fn(&mut PushRequest, &mut String, &str);
        let cases: [(&str, Alter); 5] = [
            ("sha", |p, _, other| p.sha = other.to_string()),
            ("branch", |p, _, _| p.branch = "scout/elsewhere".into()),
            ("repo name", |p, _, _| p.name = "gadgets".into()),
            ("repo owner", |p, _, _| p.owner = "acne".into()),
            ("sandbox", |_, sandbox, _| *sandbox = "slack_C1_1790000002.000100".into()),
        ];
        for (what, alter) in cases {
            let staged = s.stage("scout/m").await.unwrap();
            let mut req = s.push(&staged, "scout/m");
            let mut sandbox = SANDBOX.to_string();
            alter(&mut req, &mut sandbox, &other_sha);
            let err = s.publisher.push(&sandbox, req).await.unwrap_err();
            assert_eq!(err.0, 403, "{what}: {}", err.1);
            assert_eq!(s.remote("scout/m"), None, "{what}");
            assert_eq!(s.remote("scout/elsewhere"), None, "{what}");
            // The stage is used up: the right push now finds nothing.
            let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/m")).await.unwrap_err();
            assert_eq!(err.0, 404, "{what}: {}", err.1);
        }
        assert!(sh(&s.root, "git -C acme/gadgets.git for-each-ref --format='%(refname)'").lines().all(|r| r == "refs/heads/main"));
    }

    #[tokio::test]
    async fn a_stage_past_its_ttl_is_not_pushed() {
        let s = scratch("ttl");
        sh(&s.vm, "echo old > old && git add old && git commit -qm old");
        for (what, age) in [("expired", -(STAGE_TTL.as_secs() as i64) - 60), ("from the future", CLOCK_SLACK as i64 + 60)] {
            let staged = s.stage("scout/old").await.unwrap();
            // Its record says it was made long ago (or later than now), with nothing else changed.
            let path = s.publisher.record_path(&staged.stage);
            let mut record: StageRecord = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            record.created_at = (unix_secs() as i64 + age) as u64;
            std::fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
            let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/old")).await.unwrap_err();
            assert_eq!(err.0, 410, "{what}: {}", err.1);
            assert_eq!(s.remote("scout/old"), None, "{what}");
            assert!(!path.exists(), "{what}: the expired record is consumed too");
        }
    }

    #[tokio::test]
    async fn expired_records_and_refs_are_dropped_by_name() {
        let s = scratch("prune");
        sh(&s.vm, "echo p > p && git add p && git commit -qm p");
        let live = s.stage("scout/p").await.unwrap();
        // A stage made over a day ago, by its id.
        let old_id = format!("{}-{}", unix_secs() - STAGE_TTL.as_secs() - 60, "0".repeat(32));
        let bundle = s.bundle().await;
        s.publisher.stage_and_record(&s.dir(), &bundle, SANDBOX, &request("scout/p"), &old_id).await.unwrap();
        assert_eq!(s.records().len(), 2);
        s.publisher.prune(&s.dir()).await;
        assert_eq!(s.records(), vec![format!("{}.json", live.stage)]);
        assert_eq!(s.stage_refs(), vec![format!("refs/stage/{}", live.stage)]);
    }

    #[tokio::test]
    async fn an_unreadable_or_malformed_record_is_refused() {
        let s = scratch("badrecord");
        sh(&s.vm, "echo u > u && git add u && git commit -qm u");
        type Corrupt = fn(&Path, &str);
        let corrupt: [(&str, Corrupt); 4] = [
            // A directory where the file was: the read fails, whoever runs the test.
            ("unreadable", |p, _| {
                std::fs::remove_file(p).unwrap();
                std::fs::create_dir(p).unwrap();
            }),
            ("not JSON", |p, _| std::fs::write(p, b"{\"id\":").unwrap()),
            ("a field missing", |p, _| {
                let mut v: serde_json::Value = serde_json::from_slice(&std::fs::read(p).unwrap()).unwrap();
                v.as_object_mut().unwrap().remove("branch");
                std::fs::write(p, v.to_string()).unwrap();
            }),
            ("another stage's record", |p, id| {
                let other = std::fs::read_to_string(p).unwrap().replace(id, &new_stage_id().unwrap());
                std::fs::write(p, other).unwrap();
            }),
        ];
        for (what, corrupt) in corrupt {
            let staged = s.stage("scout/u").await.unwrap();
            corrupt(&s.publisher.record_path(&staged.stage), &staged.stage);
            let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/u")).await.unwrap_err();
            assert_eq!(err.0, 500, "{what}: {}", err.1);
            assert_eq!(s.remote("scout/u"), None, "{what}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_record_that_cannot_be_consumed_is_not_pushed() {
        use std::os::unix::fs::PermissionsExt;
        let s = scratch("noconsume");
        sh(&s.vm, "echo n > n && git add n && git commit -qm n");
        let staged = s.stage("scout/n").await.unwrap();
        // The records directory read-only: the record reads, but can't be removed.
        let records = s.publisher.records();
        std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o555)).unwrap();
        if std::fs::write(records.join("probe"), b"").is_ok() {
            // Root ignores the mode; there is no way to make removal fail here.
            std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o755)).unwrap();
            eprintln!("skipped: running as root");
            return;
        }
        let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/n")).await.unwrap_err();
        std::fs::set_permissions(&records, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(err.0, 500, "{}", err.1);
        assert!(err.1.contains("can't be consumed"), "{}", err.1);
        assert_eq!(s.remote("scout/n"), None);
    }

    #[tokio::test]
    async fn tags_and_replace_refs_in_the_bundle_never_reach_the_mirror() {
        let s = scratch("refs");
        sh(&s.vm, "echo b > b && git add b && git commit -qm b && fake=$(git commit-tree HEAD^{tree} -p HEAD -m fake) && git replace HEAD $fake && git tag -a t1 -m t1 HEAD");
        // The VM bundles everything it has, refs/replace and refs/tags included.
        let bundle = s.root.join("all.bundle");
        sh(&s.vm, &format!("git bundle create -q {} --all --not --remotes=origin", bundle.display()));
        s.publisher.refresh(&s.dir(), "acme", "widgets", None).await.unwrap();
        let id = new_stage_id().unwrap();
        s.publisher.stage_and_record(&s.dir(), &bundle, SANDBOX, &request("scout/b"), &id).await.unwrap();
        assert_eq!(s.refs(), vec!["refs/heads/main".to_string(), format!("refs/stage/{id}")]);
    }

    #[tokio::test]
    async fn a_tree_entry_named_dot_git_is_refused() {
        let s = scratch("dotgit");
        sh(&s.vm, "b=$(echo x | git hash-object -w --stdin) && t=$(printf '100644 blob %s\\t.git\\n' $b | git mktree) && c=$(git commit-tree $t -p HEAD -m dotgit) && git update-ref HEAD $c");
        let err = s.stage("scout/d").await.unwrap_err();
        assert_eq!(err.0, 422);
        assert!(err.1.contains("hasDotgit"), "{}", err.1);
        assert_eq!(s.refs(), vec!["refs/heads/main"]);
        assert!(s.records().is_empty());
    }

    #[tokio::test]
    async fn nothing_new_is_a_409_and_leaves_nothing_staged() {
        let s = scratch("empty");
        // A bundle of something GitHub already has: its HEAD is main itself.
        sh(&s.vm, "git checkout -q -b side && echo s > s && git add s && git commit -qm s && git push -q origin side && git fetch -q origin && git checkout -q main && git merge -q --ff-only side && git push -q origin main && git fetch -q origin");
        let bundle = s.root.join("same.bundle");
        sh(&s.vm, &format!("git bundle create -q {} HEAD ^origin/main~1", bundle.display()));
        s.publisher.refresh(&s.dir(), "acme", "widgets", None).await.unwrap();
        let err = s.publisher.stage_and_record(&s.dir(), &bundle, SANDBOX, &request("scout/e"), &new_stage_id().unwrap()).await.unwrap_err();
        assert_eq!(err.0, 409);
        assert!(s.stage_refs().is_empty());
        assert!(s.records().is_empty());
    }

    #[tokio::test]
    async fn a_push_never_goes_over_a_diverged_branch_and_a_refused_one_needs_a_new_stage() {
        let s = scratch("push");
        // Stage and push one commit, then a diverged one to the same branch: refused, not forced.
        let first = sh(&s.vm, "echo 1 > one && git add one && git commit -qm one && git rev-parse HEAD");
        let staged = s.stage("scout/x").await.unwrap();
        s.publisher.push(SANDBOX, s.push(&staged, "scout/x")).await.unwrap();
        sh(&s.vm, "git reset -q --hard origin/main && echo 2 > two && git add two && git commit -qm two");
        let other = s.stage("scout/x").await.unwrap();
        let err = s.publisher.push(SANDBOX, s.push(&other, "scout/x")).await.unwrap_err();
        assert_eq!(err.0, 409, "{}", err.1);
        assert_eq!(s.remote("scout/x").as_deref(), Some(first.as_str()));
        // The refused attempt used the stage up.
        assert_eq!(s.publisher.push(SANDBOX, s.push(&other, "scout/x")).await.unwrap_err().0, 404);
    }

    #[tokio::test]
    async fn what_the_approval_shows_is_read_only_up_to_a_cap() {
        let mut s = scratch("cap");
        s.publisher.review_cap = 4096;
        // 400 files: their names alone are over the cap. Refused, not cut: a cut list would
        // hide files from the approver.
        sh(&s.vm, "for i in $(seq 1 400); do echo $i > file-with-a-long-name-$i; done && git add . && git commit -qm many");
        let err = s.stage("scout/g").await.unwrap_err();
        assert_eq!(err.0, 413, "{}", err.1);
        assert!(err.1.contains("too much to review"), "{}", err.1);
        assert!(s.stage_refs().is_empty(), "nothing is left staged");
        assert!(s.records().is_empty());
        // The patch is an excerpt: cut at MAX_PATCH, and the stage goes on.
        s.publisher.review_cap = REVIEW_CAP;
        sh(&s.vm, "git reset -q --hard origin/main && seq 1 200000 > big && git add big && git commit -qm big");
        let staged = s.stage("scout/h").await.unwrap();
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
    async fn the_digest_covers_the_whole_diff_and_is_recorded() {
        // Two diffs past the patch cap that share the commit's place: each digest is the
        // SHA-256 of its complete diff, the same diff gives the same digest, and the record
        // keeps it. Then the same commits once the mirror abbreviates differently: the
        // same digest.
        use sha2::{Digest, Sha256};
        let s = scratch("digest");
        // The diff as a reviewer would get it from the mirror, untrimmed, with no user config.
        let full = |s: &Scratch, sha: &str| -> String {
            let out = std::process::Command::new("git")
                .args(["-C", &s.dir().to_string_lossy(), "diff", "--no-ext-diff", "--no-textconv", "--full-index", "--no-renames", "--diff-algorithm=myers", "--indent-heuristic", &format!("main...{sha}")])
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .output()
                .unwrap();
            assert!(out.status.success());
            Sha256::digest(&out.stdout).iter().map(|b| format!("{b:02x}")).collect()
        };
        sh(&s.vm, "seq 1 200000 > big && git add big && git commit -qm big");
        let one = s.stage("scout/d").await.unwrap();
        assert!(one.patch_truncated);
        assert_eq!(one.diff_sha256, full(&s, &one.sha));
        let record: StageRecord = serde_json::from_slice(&std::fs::read(s.publisher.record_path(&one.stage)).unwrap()).unwrap();
        assert_eq!(record.diff_sha256, one.diff_sha256);
        assert_eq!(s.stage("scout/d").await.unwrap().diff_sha256, one.diff_sha256, "the same diff, the same digest");
        // The same file, changed only at its end: far past what the patch shows.
        sh(&s.vm, "git reset -q --hard origin/main && (seq 1 199999; echo last) > big && git add big && git commit -qm big");
        let two = s.stage("scout/d").await.unwrap();
        assert!(two.patch_truncated);
        assert_ne!(two.diff_sha256, one.diff_sha256);
        assert_eq!(two.diff_sha256, full(&s, &two.sha));
        // The same commits once the mirror abbreviates blob ids differently (as it does when
        // it grows): the excerpt's index lines change, the digest doesn't.
        sh(&s.vm, "git reset -q --hard origin/main && printf 'a\\000b' > blob.bin && git add blob.bin && git commit -qm bin");
        let before = s.stage("scout/d").await.unwrap();
        sh(&s.dir(), "git config core.abbrev 20");
        let after = s.stage("scout/d").await.unwrap();
        assert_ne!(before.patch, after.patch, "the excerpt's abbreviations changed");
        assert_eq!(before.diff_sha256, after.diff_sha256);
        assert_eq!(after.diff_sha256, full(&s, &after.sha));
    }

    #[tokio::test]
    async fn the_digest_is_sha256_in_lowercase_hex() {
        // Known answers, independent of the hashing crate: what the app checks the digest
        // against (/^[0-9a-f]{64}$/ in src/tools/pull-request.ts) and what a reviewer can
        // recompute with sha256sum. The million-byte one spans many reads of the pipe.
        let s = scratch("known-digest");
        let blob = |content: &str| sh(&s.vm, &format!("{content} | git hash-object -w --stdin"));
        for (content, want) in [
            ("printf abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            ("printf ''", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            ("head -c 1000000 /dev/zero | tr '\\000' a", "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"),
        ] {
            let oid = blob(content);
            assert_eq!(s.publisher.git.sha256(&s.vm, &["cat-file", "blob", &oid], GIT_LOCAL).await.unwrap(), want, "{content}");
        }
    }

    #[tokio::test]
    async fn a_head_that_is_a_tag_stages_its_commit_and_a_non_commit_leaves_nothing() {
        let s = scratch("tag");
        let dir = s.dir();
        s.publisher.refresh(&dir, "acme", "widgets", None).await.unwrap();
        // A bundle whose HEAD is an annotated tag that peels to a new commit.
        let head = sh(&s.vm, "echo t > t && git add t && git commit -qm t && git tag -a t1 -m t1 && git rev-parse HEAD");
        let bundle = s.root.join("tag.bundle");
        let b = bundle.display();
        sh(&s.vm, &format!("git bundle create -q {b} refs/tags/t1 --not --remotes=origin"));
        advertise_as_head(&bundle, "refs/tags/t1");
        let id = new_stage_id().unwrap();
        let staged = s.publisher.stage_and_record(&dir, &bundle, SANDBOX, &request("scout/tag"), &id).await.unwrap();
        assert_eq!(staged.sha, head);
        assert_eq!(sh(&dir, &format!("git rev-parse refs/stage/{id}")), head, "the stage ref is the commit, not the tag");
        s.publisher.push(SANDBOX, s.push(&staged, "scout/tag")).await.unwrap();
        assert_eq!(s.remote("scout/tag").as_deref(), Some(head.as_str()));
        // A HEAD that peels to a blob: refused, and no stage ref or record left behind.
        let blob = s.root.join("blob.bundle");
        let b = blob.display();
        sh(&s.vm, &format!("x=$(echo x | git hash-object -w --stdin) && git tag -a tb -m tb $x && git bundle create -q {b} refs/tags/tb"));
        advertise_as_head(&blob, "refs/tags/tb");
        let err = s.publisher.stage_and_record(&dir, &blob, SANDBOX, &request("scout/tag"), &new_stage_id().unwrap()).await.unwrap_err();
        assert_eq!(err.0, 422, "{}", err.1);
        assert!(s.stage_refs().is_empty(), "{:?}", s.refs());
        assert!(s.records().is_empty());
    }

    #[tokio::test]
    async fn a_record_that_cannot_be_written_fails_the_stage_and_leaves_nothing_pushable() {
        let s = scratch("nowrite");
        let head = sh(&s.vm, "echo w > w && git add w && git commit -qm w && git rev-parse HEAD");
        let bundle = s.bundle().await;
        // A non-empty directory where the record goes: the temporary file is written and
        // synced, and the rename into place fails, whoever runs the test.
        let id = new_stage_id().unwrap();
        let path = s.publisher.record_path(&id);
        std::fs::create_dir_all(path.join("in-the-way")).unwrap();
        let err = s.publisher.stage_and_record(&s.dir(), &bundle, SANDBOX, &request("scout/w"), &id).await.unwrap_err();
        assert_eq!(err.0, 500, "{}", err.1);
        assert!(err.1.contains("recording the stage"), "{}", err.1);
        assert_eq!(s.records(), vec![format!("{id}.json")], "no temporary file is left behind");
        std::fs::remove_dir_all(&path).unwrap();
        let staged = Staged { stage: id, sha: head, base_sha: String::new(), commits: 1, stat: String::new(), authors: vec![], files: vec![], patch: String::new(), patch_truncated: false, diff_sha256: String::new() };
        let err = s.publisher.push(SANDBOX, s.push(&staged, "scout/w")).await.unwrap_err();
        assert_eq!(err.0, 404, "{}", err.1);
        assert_eq!(s.remote("scout/w"), None);
    }

    #[tokio::test]
    async fn files_lists_both_paths_of_a_rename_unquoted() {
        // The approval warns on paths GitHub acts on; a rename away from one must show it.
        let s = scratch("renames");
        sh(&s.vm, "mkdir -p .github/workflows docs && echo ci > .github/workflows/ci.yml && echo '* @acme/owners' > docs/CODEOWNERS && git add . && git commit -qm sensitive && git push -q origin main && git fetch -q origin");
        sh(&s.vm, "mkdir -p old && git mv .github/workflows/ci.yml old/ci.yml && git mv docs/CODEOWNERS old/CODEOWNERS && printf x > \"$(printf 'we\\tird\\n\"\\303\\251')\" && git add . && git commit -qm moved");
        let staged = s.stage("scout/renames").await.unwrap();
        let mut files = staged.files.clone();
        files.sort();
        assert_eq!(files, vec![".github/workflows/ci.yml", "docs/CODEOWNERS", "old/CODEOWNERS", "old/ci.yml", "we\tird\n\"é"]);
    }

    /// Set a file's modification time `secs` seconds back.
    fn age(path: &Path, secs: u64) {
        let f = std::fs::OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    }

    fn packs(dir: &Path) -> usize {
        std::fs::read_dir(dir.join("objects/pack")).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".pack")).count()
    }

    #[tokio::test]
    async fn no_git_command_starts_maintenance_of_its_own() {
        // A fetch ends with a detached `git maintenance run --auto` (gc --auto on older
        // gits) unless the config says not to; detached, it outlives the mirror's lock.
        let s = scratch("maintenance");
        s.publisher.refresh(&s.dir(), "acme", "widgets", None).await.unwrap();
        for (key, want) in [("maintenance.auto", "false"), ("gc.auto", "0"), ("gc.autoDetach", "false"), ("maintenance.autoDetach", "false")] {
            let got = s.publisher.git.run(&s.dir(), &["config", "--get", key], GIT_LOCAL).await;
            assert_eq!(got.as_deref().map(str::trim), Ok(want), "{key}");
        }
    }

    #[tokio::test]
    async fn a_push_is_measured_after_its_gc() {
        let s = scratch("gcmeasure");
        sh(&s.vm, "echo m > m && git add m && git commit -qm m");
        let staged = s.stage("scout/m").await.unwrap();
        sh(&s.dir(), "for i in $(seq 1 55); do echo $i | git hash-object --stdin -w | git pack-objects -q objects/pack/pack >/dev/null; done");
        s.publisher.push(SANDBOX, s.push(&staged, "scout/m")).await.unwrap();
        assert!(packs(&s.dir()) <= 2, "{}", packs(&s.dir()));
        assert_eq!(s.publisher.status()["bytes"].as_u64().unwrap(), RealDisk.usage(&s.dir()).0, "the size kept is the size after gc");
    }

    #[tokio::test]
    async fn a_failed_refresh_measures_the_mirror_again() {
        let s = scratch("refreshmeasure");
        sh(&s.vm, "echo r > r && git add r && git commit -qm r");
        s.size("acme/widgets", GIB);
        s.stage_all(request("scout/r"), || {}).await.unwrap();
        assert_eq!(s.publisher.status()["bytes"].as_u64().unwrap(), GIB);
        s.size("acme/widgets", 2 * GIB);
        std::fs::rename(s.root.join("acme/widgets.git"), s.root.join("acme/gone.git")).unwrap();
        s.stage_all(request("scout/r2"), || {}).await.unwrap_err();
        assert_eq!(s.publisher.status()["bytes"].as_u64().unwrap(), 2 * GIB, "measured again after the failed refresh");
    }

    #[tokio::test]
    async fn a_push_still_collects_a_mirror_with_many_packs_before_it_answers() {
        // gc.auto=0 everywhere else; push's own `gc --auto` keeps git's thresholds, and runs
        // in the foreground, under the lock.
        let s = scratch("gcauto");
        sh(&s.vm, "echo g > g && git add g && git commit -qm g");
        let staged = s.stage("scout/g").await.unwrap();
        sh(&s.dir(), "for i in $(seq 1 55); do echo $i | git hash-object --stdin -w | git pack-objects -q objects/pack/pack >/dev/null; done");
        assert!(packs(&s.dir()) > 50, "{}", packs(&s.dir()));
        s.publisher.push(SANDBOX, s.push(&staged, "scout/g")).await.unwrap();
        assert!(packs(&s.dir()) <= 2, "{}", packs(&s.dir()));
    }

    #[tokio::test]
    async fn a_stage_ref_to_a_missing_object_and_stale_garbage_are_cleared_by_the_next_stage() {
        // What an out-of-lock gc left in #76: a refs/stage ref whose pack was removed, which
        // fails every fetch into the mirror. With it, git's partial packs and a bundle a crash
        // left behind.
        let s = scratch("dangling");
        sh(&s.vm, "echo d > d && git add d && git commit -qm d");
        let live = s.stage("scout/d").await.unwrap();
        let dir = s.dir();
        // A live-looking stage (a record, a fresh id), whose ref names a missing object.
        let id = new_stage_id().unwrap();
        std::fs::write(s.publisher.record_path(&id), b"{}").unwrap();
        std::fs::write(dir.join(format!("refs/stage/{id}")), format!("{}\n", "1".repeat(40))).unwrap();
        let err = s.publisher.refresh(&dir, "acme", "widgets", None).await.unwrap_err();
        assert!(err.contains("refs/stage/"), "the mirror is wedged: {err}");
        let pack = dir.join("objects/pack");
        let garbage = [pack.join("tmp_pack_old"), pack.join("tmp_idx_old"), dir.join(format!("stage-{}.bundle", new_stage_id().unwrap())), dir.join("packed-refs.lock")];
        for g in &garbage {
            std::fs::write(g, b"x").unwrap();
            age(g, GARBAGE_AGE.as_secs() + 60);
        }
        let fresh = pack.join("tmp_pack_fresh");
        std::fs::write(&fresh, b"x").unwrap();
        age(&fresh, 60);
        // The next stage's refresh: it fails, the housekeeping drops the ref, and it is retried.
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        assert_eq!(s.stage_refs(), vec![format!("refs/stage/{}", live.stage)], "the live stage's ref is kept");
        for g in &garbage {
            assert!(!g.exists(), "{}", g.display());
        }
        assert!(fresh.exists(), "younger than GARBAGE_AGE: kept");
        // The housekeeping after every job drops such a ref too, before any fetch trips on it.
        std::fs::write(dir.join(format!("refs/stage/{id}")), format!("{}\n", "1".repeat(40))).unwrap();
        s.publisher.prune(&dir).await;
        assert_eq!(s.stage_refs(), vec![format!("refs/stage/{}", live.stage)]);
        // And the stage goes on.
        sh(&s.vm, "echo e > e && git add e && git commit -qm e");
        s.stage("scout/d").await.unwrap();
    }

    #[tokio::test]
    async fn a_first_fetch_that_fails_or_is_cut_off_leaves_no_mirror_and_a_later_one_keeps_it() {
        let s = scratch("firstfetch");
        let missing = s.publisher.mirror("acme", "missing");
        // No such repo: the fetch fails.
        s.publisher.update_mirror(&missing, "acme", "missing", None).await.unwrap_err();
        assert!(!missing.exists());
        // A fetch that hangs (a server that never answers), cut off by the job's deadline.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let held = tokio::spawn(async move {
            let mut conns = Vec::new();
            while let Ok((c, _)) = listener.accept().await {
                conns.push(c);
            }
        });
        let hanging = Publisher::unconfined(s.root.join("mirrors"), format!("http://{addr}"));
        let dir = hanging.mirror("acme", "slow");
        let cut = tokio::time::timeout(Duration::from_millis(1500), hanging.update_mirror(&dir, "acme", "slow", None)).await;
        assert!(cut.is_err(), "the fetch was cut off: {cut:?}");
        assert!(!dir.exists());
        held.abort();
        // A mirror that has been fetched once stays when a later fetch fails, packed or not
        // (a fetch of under 100 objects leaves them loose).
        s.publisher.update_mirror(&s.dir(), "acme", "widgets", None).await.unwrap();
        sh(&s.dir(), "for p in objects/pack/*.pack; do mv $p unpack.tmp && rm -f ${p%.pack}.* && git unpack-objects -q < unpack.tmp && rm unpack.tmp; done");
        std::fs::rename(s.root.join("acme/widgets.git"), s.root.join("acme/gone.git")).unwrap();
        s.publisher.update_mirror(&s.dir(), "acme", "widgets", None).await.unwrap_err();
        sh(&s.dir(), "git rev-parse --verify -q refs/heads/main");
    }

    #[tokio::test]
    async fn a_fetched_mirror_whose_refs_cant_be_read_is_kept_when_its_refresh_fails() {
        let s = scratch("unreadable");
        let dir = s.dir();
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        // for-each-ref fails (git won't read a packed-refs with a line it doesn't know, as
        // any user, root included), and so does the fetch.
        sh(&dir, "git pack-refs --all");
        let packed = dir.join("packed-refs");
        let refs = std::fs::read(&packed).unwrap();
        std::fs::write(&packed, [refs.as_slice(), b"not a ref\n"].concat()).unwrap();
        assert!(s.publisher.git.run(&dir, &["for-each-ref"], GIT_LOCAL).await.is_err(), "for-each-ref fails");
        std::fs::rename(s.root.join("acme/widgets.git"), s.root.join("acme/gone.git")).unwrap();
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap_err();
        assert!(packed.exists(), "the mirror is still there");
        std::fs::write(&packed, refs).unwrap();
        sh(&dir, "git rev-parse --verify -q refs/heads/main");
    }

    /// Whether any process of a group is left (a zombie included).
    fn group_left(group: libc::pid_t) -> bool {
        // SAFETY: signal 0 only checks.
        unsafe { libc::kill(-group, 0) == 0 }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_cut_off_command_is_gone_with_its_helpers_before_the_mirror_lock_is_released() {
        let s = scratch("stopgroup");
        let dir = s.dir();
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        // A git command whose helper ignores SIGTERM (as a stuck index-pack might not answer
        // it): only SIGKILL stops it. It says its pid and its group's: git's, the shell's
        // parent (no `ps`, which a build sandbox may not have).
        let ids = s.root.join("helper.ids");
        let alias = format!("alias.hang=!trap '' TERM; sleep 60 & echo $! $PPID > {}.tmp; mv {0}.tmp {0}; wait", ids.display());
        let lock = s.publisher.lock(&dir);
        let job = tokio::spawn({
            let (lock, dir) = (lock.clone(), dir.clone());
            async move {
                let _held = lock.lock().await;
                Git::new(None, "file:///").run(&dir, &["-c", &alias, "hang"], Duration::from_secs(120)).await
            }
        });
        let started = std::time::Instant::now();
        while !ids.exists() {
            assert!(started.elapsed() < Duration::from_secs(20), "the helper started");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let text = std::fs::read_to_string(&ids).unwrap();
        let [helper, group]: [libc::pid_t; 2] = text.split_whitespace().map(|n| n.parse().unwrap()).collect::<Vec<_>>().try_into().unwrap();
        // SAFETY: getpgid() only reads.
        assert_eq!(unsafe { libc::getpgid(helper) }, group, "the helper is in the command's group");
        // Whoever takes the lock next looks at once: is anything of that command left?
        let next = tokio::spawn({
            let lock = lock.clone();
            async move {
                let _held = lock.lock().await;
                group_left(group)
            }
        });
        tokio::time::sleep(Duration::from_millis(50)).await;
        // The job is cut off (its deadline drops it).
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
        assert!(!next.await.unwrap(), "a process of the cut-off command was alive when the lock was released");
        // SAFETY: signal 0 only checks.
        assert_ne!(unsafe { libc::kill(helper, 0) }, 0, "the helper that ignored SIGTERM is gone");
        // And the housekeeping right after has nothing live to step around.
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
    }

    #[tokio::test]
    async fn a_fetch_that_is_cut_off_is_stopped_with_its_helpers() {
        // The connection to the server is held by git-remote-http, a child of the fetch:
        // it closes only when that helper is gone too.
        let s = scratch("helpers");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let hanging = Publisher::unconfined(s.root.join("mirrors"), format!("http://{addr}"));
        let dir = hanging.mirror("acme", "slow");
        let fetch = tokio::spawn(async move { hanging.update_mirror(&dir, "acme", "slow", None).await });
        // Cut off once it has connected: the job's future is dropped.
        let accepted = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await;
        fetch.abort();
        let (mut conn, _) = accepted.expect("the fetch connects").unwrap();
        assert!(fetch.await.unwrap_err().is_cancelled(), "the fetch was cut off");
        let closed = tokio::time::timeout(Duration::from_secs(10), async {
            use tokio::io::AsyncReadExt;
            let mut buf = [0u8; 4096];
            while conn.read(&mut buf).await.is_ok_and(|n| n > 0) {}
        })
        .await;
        assert!(closed.is_ok(), "a helper of the fetch still holds the connection");
    }

    #[tokio::test]
    async fn a_lock_file_a_killed_git_left_is_cleared_and_the_refresh_retried() {
        let s = scratch("lockfile");
        let dir = s.dir();
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        // GitHub's main moves on, and a killed git left the mirror's main locked.
        let head = sh(&s.vm, "echo l > l && git add l && git commit -qm l && git push -q origin main && git rev-parse HEAD");
        let lock = dir.join("refs/heads/main.lock");
        std::fs::write(&lock, b"").unwrap();
        // A young lock may be a git still running: left alone, and the refresh fails.
        age(&lock, 60);
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap_err();
        assert!(lock.exists());
        age(&lock, GARBAGE_AGE.as_secs() + 60);
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        assert!(!lock.exists());
        assert_eq!(sh(&dir, "git rev-parse refs/heads/main"), head);
    }

    // ── The mirrors' upkeep (upkeep.rs) ──────────────────────────────────────────────────

    fn on(name: &str, base: &str, branch: &str) -> StageRequest {
        StageRequest { owner: "acme".into(), name: name.into(), base: base.into(), branch: branch.into(), token: None }
    }

    /// A commit of a 64 KiB file no mirror has; the file's blob.
    fn heavy_commit(s: &Scratch, file: &str) -> String {
        sh(&s.vm, &format!("git reset -q --hard origin/main && head -c 65536 /dev/urandom > {file} && git add {file} && git commit -qm {file} && git rev-parse HEAD:{file}"))
    }

    #[tokio::test]
    async fn a_failed_stage_that_brought_a_heavy_bundle_is_collected_before_it_answers() {
        let mut s = scratch("heavyfail");
        s.publisher.policy.heavy_bundle = 32 << 10;
        // A base branch that isn't there: refused (404) once the bundle is in the mirror.
        let blob = heavy_commit(&s, "big.bin");
        assert_eq!(s.stage_all(on("widgets", "nope", "scout/h"), || {}).await.unwrap_err().0, 404);
        assert!(!s.has("widgets", &blob), "collected before the stage answered");
        // Under the threshold, what a failed stage brought stays (for the daily gc).
        s.publisher.policy.heavy_bundle = 1 << 20;
        let light = heavy_commit(&s, "small.bin");
        assert_eq!(s.stage_all(on("widgets", "nope", "scout/h"), || {}).await.unwrap_err().0, 404);
        assert!(s.has("widgets", &light));
    }

    #[tokio::test]
    async fn a_heavy_stage_cut_off_or_expired_unpushed_is_collected_by_the_upkeep() {
        let mut s = scratch("heavycut");
        s.publisher.policy.heavy_bundle = 32 << 10;
        // No daily gc here: only the heavy stages' rule collects.
        s.publisher.policy.gc_idle = Duration::from_secs(365 * 86_400);
        let reached = Arc::new(tokio::sync::Notify::new());
        s.publisher.before_record = Some((reached.clone(), Arc::new(tokio::sync::Notify::new())));
        let blob = heavy_commit(&s, "cut.bin");
        {
            let stage = s.stage_all(request("scout/cut"), || {});
            tokio::pin!(stage);
            tokio::select! {
                _ = &mut stage => panic!("the gate holds the stage"),
                _ = reached.notified() => {}
            }
        } // cut off: dropped right before its record
        assert!(s.has("widgets", &blob));
        s.publisher.maintain().await;
        assert!(!s.has("widgets", &blob), "cut off: collected by the next upkeep pass");
        // Recorded, never pushed, expired.
        s.publisher.before_record = None;
        let blob = heavy_commit(&s, "old.bin");
        s.stage_all(request("scout/old"), || {}).await.unwrap();
        s.publisher.maintain().await;
        assert!(s.has("widgets", &blob), "a live stage's objects stay");
        s.advance(STAGE_TTL.as_secs() + 3600);
        s.publisher.maintain().await;
        assert!(!s.has("widgets", &blob), "expired unpushed: collected");
        // Pushed: nothing to collect, and nothing pending.
        let blob = heavy_commit(&s, "pushed.bin");
        let staged = s.stage_all(request("scout/pushed"), || {}).await.unwrap();
        s.publisher.push(SANDBOX, s.push(&staged, "scout/pushed")).await.unwrap();
        assert!(upkeep_state(&s.dir()).heavy.is_empty());
        assert!(s.has("widgets", &blob));
    }

    fn upkeep_state(dir: &Path) -> upkeep::MirrorState {
        upkeep::read_state(dir).expect("the mirror's upkeep state")
    }

    #[tokio::test]
    async fn a_mirror_used_since_its_last_gc_is_collected_once_a_day_after_ten_idle_minutes() {
        let s = scratch("daily");
        // What a failed stage leaves: unreachable, kept by git for 2 weeks.
        let blob = sh(&s.vm, "echo residue > r && git add r && git commit -qm r && git rev-parse HEAD:r");
        assert_eq!(s.stage_all(on("widgets", "nope", "scout/d"), || {}).await.unwrap_err().0, 404);
        assert!(s.has("widgets", &blob));
        s.advance(5 * 60);
        s.publisher.maintain().await;
        assert!(s.has("widgets", &blob), "idle for 5 minutes: not yet");
        s.advance(6 * 60);
        s.publisher.maintain().await;
        assert!(!s.has("widgets", &blob), "idle for 11 minutes, never collected: collected");
        assert!(s.publisher.status()["lastGc"]["at"].is_u64());
        // Used again and idle again, but collected less than a day ago: left for later.
        let blob = sh(&s.vm, "git reset -q --hard origin/main && echo again > g && git add g && git commit -qm g && git rev-parse HEAD:g");
        assert_eq!(s.stage_all(on("widgets", "nope", "scout/d"), || {}).await.unwrap_err().0, 404);
        s.advance(11 * 60);
        s.publisher.maintain().await;
        assert!(s.has("widgets", &blob), "collected under a day ago");
        s.advance(86_400);
        s.publisher.maintain().await;
        assert!(!s.has("widgets", &blob), "a day later: collected");
    }

    #[tokio::test]
    async fn a_mirror_is_dropped_two_weeks_after_its_last_stage_unless_a_live_stage_names_it_or_it_is_busy() {
        let s = scratch("retention");
        sh(&s.vm, "echo r > r && git add r && git commit -qm r");
        s.stage_all(request("scout/r"), || {}).await.unwrap();
        s.advance(13 * 86_400);
        s.stage_all(on("gadgets", "main", "scout/r"), || {}).await.unwrap();
        s.publisher.maintain().await;
        assert!(s.dir().exists(), "13 days: kept");
        s.advance(2 * 86_400);
        // 15 days, and a stage of it an hour old: kept.
        let now = s.publisher.now();
        let live = StageRecord { id: format!("{}-{}", now - 3600, "a".repeat(32)), sandbox: SANDBOX.into(), owner: "acme".into(), name: "widgets".into(), base: "main".into(), base_sha: String::new(), branch: "scout/r".into(), sha: "a".repeat(40), diff_sha256: String::new(), created_at: now - 3600 };
        s.publisher.write_record(&live).unwrap();
        s.publisher.maintain().await;
        assert!(s.dir().exists(), "a live stage names it");
        std::fs::remove_file(s.publisher.record_path(&live.id)).unwrap();
        // Busy: never waited for, never dropped.
        let lock = s.publisher.lock(&s.dir());
        let held = lock.lock().await;
        s.publisher.maintain().await;
        assert!(s.dir().exists(), "its lock is held");
        drop(held);
        s.publisher.maintain().await;
        assert!(!s.dir().exists(), "15 days idle: dropped");
        assert!(s.publisher.mirror("acme", "gadgets").exists(), "used 2 days ago: kept");
        assert_eq!(s.publisher.status()["evicted"], 1);
    }

    #[tokio::test]
    async fn two_new_mirrors_staged_at_once_are_admitted_one_after_the_other() {
        let mut s = scratch("newatonce");
        s.publisher.policy.mirrors_max = 6 * GIB;
        sh(&s.vm, "echo a2 > a2 && git add a2 && git commit -qm a2");
        s.size("acme/widgets", 3 * GIB);
        s.size("acme/gadgets", GIB);
        // Both start before either has fetched. The second is admitted only once the first
        // is measured: 3 GiB used, and a new mirror counts at 4, over the 6.
        let (first, second) = tokio::join!(s.stage_all(request("scout/a"), || {}), s.stage_all(on("gadgets", "main", "scout/a"), || {}));
        first.unwrap();
        let err = second.unwrap_err();
        assert!(err.0 == 507 && err.1.contains("mirrors use 3 of 6 GiB"), "{err:?}");
        assert!(!s.publisher.mirror("acme", "gadgets").exists(), "never fetched");
    }

    #[tokio::test]
    async fn a_stage_of_an_existing_mirror_doesnt_wait_for_a_new_mirrors_first_fetch() {
        let s = scratch("newwait");
        sh(&s.vm, "echo e2 > e2 && git add e2 && git commit -qm e2");
        s.stage_all(request("scout/e"), || {}).await.unwrap();
        // A new mirror's first fetch is under way (it holds new_mirrors).
        let fetching = s.publisher.new_mirrors.lock().await;
        sh(&s.vm, "echo e3 > e3 && git add e3 && git commit -qm e3");
        let staged = tokio::time::timeout(Duration::from_secs(60), s.stage_all(request("scout/e2"), || {})).await;
        assert!(staged.expect("not blocked by the first fetch").is_ok());
        // A new one waits for it.
        let new = tokio::time::timeout(Duration::from_millis(500), s.stage_all(on("gadgets", "main", "scout/e"), || {})).await;
        assert!(new.is_err(), "a second new mirror waits for the first's fetch");
        drop(fetching);
        s.stage_all(on("gadgets", "main", "scout/e"), || {}).await.unwrap();
    }

    #[tokio::test]
    async fn a_restarted_host_counts_the_mirrors_on_disk_before_it_takes_a_stage() {
        let mut s = scratch("inventory");
        s.publisher.policy.mirrors_max = 6 * GIB;
        sh(&s.vm, "echo i > i && git add i && git commit -qm i");
        s.size("acme/gadgets", 3 * GIB);
        s.stage_all(on("gadgets", "main", "scout/i"), || {}).await.unwrap();
        // A new sandboxd over the same mirrors: until they are measured it knows of none.
        let mut restarted = Publisher::unconfined(s.root.join("mirrors"), format!("file://{}", s.root.display())).with_policy(s.publisher.policy.clone());
        restarted.disk = s.disk.clone();
        restarted.inventory();
        // 3 GiB used, and a new mirror counts at 4: over the 6.
        let err = restarted.admit(&restarted.mirror("acme", "widgets"), "acme", "widgets", true).unwrap_err();
        assert!(err.0 == 507 && err.1.contains("mirrors use 3 of 6 GiB"), "{err:?}");
    }

    #[tokio::test]
    async fn a_mirror_made_during_an_upkeep_pass_stays_counted() {
        let s = scratch("passnew");
        sh(&s.vm, "echo p > p && git add p && git commit -qm p");
        s.size("acme/widgets", GIB);
        s.size("acme/gadgets", 2 * GIB);
        s.stage_all(request("scout/p"), || {}).await.unwrap();
        s.stage_all(on("gadgets", "main", "scout/p"), || {}).await.unwrap();
        // gadgets is made (here: put back) after the pass listed the mirrors, and measured
        // by its stage.
        let (gadgets, aside) = (s.publisher.mirror("acme", "gadgets"), s.root.join("aside.git"));
        std::fs::rename(&gadgets, &aside).unwrap();
        let back = gadgets.clone();
        *s.disk.on_measure.lock().unwrap() = Some(("acme/widgets".into(), Box::new(move || std::fs::rename(&aside, &back).unwrap())));
        s.publisher.maintain().await;
        assert!(gadgets.exists());
        let status = s.publisher.status();
        assert_eq!((status["count"].as_u64(), status["bytes"].as_u64()), (Some(2), Some(3 * GIB)));
    }

    #[tokio::test]
    async fn retention_looks_for_a_live_stage_again_once_it_holds_the_mirrors_lock() {
        let mut s = scratch("retentionlive");
        sh(&s.vm, "echo q > q && git add q && git commit -qm q");
        s.stage_all(request("scout/q"), || {}).await.unwrap();
        // 15 days on. The pass reads the clock first for the records it starts from, then
        // once it holds the mirror's lock: a stage of it records itself in between.
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let (seen, records) = (calls.clone(), s.publisher.records());
        s.publisher.clock = Arc::new(move || {
            let now = unix_secs() + 15 * 86_400;
            if seen.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                let id = format!("{now}-{}", "c".repeat(32));
                let record = StageRecord { id: id.clone(), sandbox: SANDBOX.into(), owner: "acme".into(), name: "widgets".into(), base: "main".into(), base_sha: String::new(), branch: "scout/q2".into(), sha: "c".repeat(40), diff_sha256: String::new(), created_at: now };
                std::fs::write(records.join(format!("{id}.json")), serde_json::to_vec(&record).unwrap()).unwrap();
            }
            now
        });
        s.publisher.maintain().await;
        assert!(calls.load(std::sync::atomic::Ordering::SeqCst) >= 2, "the record was written during the pass");
        assert!(s.dir().exists(), "a live stage names it");
    }

    #[tokio::test]
    async fn a_mirror_over_its_cap_after_the_refresh_or_the_bundle_is_removed_with_a_507() {
        let s = scratch("overcap");
        sh(&s.vm, "echo o > o && git add o && git commit -qm o");
        let over = (507, "the mirror of acme/widgets is 5 GiB, over the 4 GiB a repo may use on this sandbox host: nothing was staged. An operator can raise SANDBOXD_MIRROR_MAX_GIB.".to_string());
        // After the refresh: refused before the bundle is read out of the VM.
        s.size("acme/widgets", 5 * GIB);
        let read = std::cell::Cell::new(false);
        assert_eq!(s.stage_all(request("scout/o"), || read.set(true)).await.unwrap_err(), over);
        assert!(!read.get(), "no bundle was read");
        assert!(!s.dir().exists());
        // After the bundle: the refresh fits, the bundle takes it over.
        s.disk.sizes.lock().unwrap().clear();
        assert_eq!(s.stage_all(request("scout/o"), || s.size("acme/widgets", 5 * GIB)).await.unwrap_err(), over);
        assert!(!s.dir().exists());
        assert!(s.records().is_empty());
        assert_eq!(s.publisher.status()["refusedForSpace"], 2);
        // Back under the cap, it stages again (from a new mirror).
        s.disk.sizes.lock().unwrap().clear();
        s.stage_all(request("scout/o"), || {}).await.unwrap();
    }

    #[tokio::test]
    async fn a_mirror_over_its_cap_stays_while_a_live_stage_names_it() {
        let s = scratch("overcaplive");
        sh(&s.vm, "echo v > v && git add v && git commit -qm v");
        let live = s.stage_all(request("scout/v"), || {}).await.unwrap();
        // Over its cap, with that stage not pushed yet: refused, but its push still works.
        s.size("acme/widgets", 5 * GIB);
        sh(&s.vm, "echo w > w && git add w && git commit -qm w");
        assert_eq!(s.stage_all(request("scout/v2"), || {}).await.unwrap_err().0, 507);
        assert!(s.dir().exists(), "a live stage names it");
        s.publisher.push(SANDBOX, s.push(&live, "scout/v")).await.unwrap();
        assert_eq!(s.remote("scout/v"), Some(live.sha.clone()));
        // No record names it now: the next stage removes it.
        assert_eq!(s.stage_all(request("scout/v2"), || {}).await.unwrap_err().0, 507);
        assert!(!s.dir().exists());
    }

    #[tokio::test]
    async fn a_new_mirror_needs_room_for_its_cap_and_idle_mirrors_make_room_least_recently_used_first_down_to_80_percent() {
        let mut s = scratch("total");
        s.publisher.policy.mirrors_max = 10 * GIB;
        sh(&s.root, "git clone -q --bare acme/gadgets.git acme/gizmos.git && git clone -q --bare acme/gadgets.git acme/gears.git");
        sh(&s.vm, "echo t > t && git add t && git commit -qm t");
        let half = GIB / 2;
        // Used in this order, an hour apart: 1.5 + 4 + 1.5 = 7 GiB.
        for (name, size) in [("gadgets", GIB + half), ("gizmos", 4 * GIB), ("gears", GIB + half)] {
            s.size(&format!("acme/{name}"), size);
            s.stage_all(on(name, "main", "scout/t"), || {}).await.unwrap();
            s.advance(3600);
        }
        // A new mirror counts at its cap (4): 11 of 10. None is idle yet: refused.
        let err = s.stage_all(request("scout/t"), || {}).await.unwrap_err();
        assert_eq!(err, (507, "the sandbox host has no room for the mirror of acme/widgets (mirrors use 7 of 10 GiB, and this one would need up to 4 GiB): nothing was staged. Try again later, or ask an operator to raise SANDBOXD_MIRRORS_MAX_GIB or free space on the host.".to_string()));
        assert!(!s.dir().exists());
        // A day later all are idle. Least recently used first: gadgets (then 9.5 GiB with the
        // new one, which fits but is over 80%), then gizmos (5.5 GiB); gears stays.
        s.advance(86_400);
        s.stage_all(request("scout/t"), || {}).await.unwrap();
        let exists = |name: &str| s.publisher.mirror("acme", name).exists();
        assert_eq!((exists("gadgets"), exists("gizmos"), exists("gears")), (false, false, true));
        let status = s.publisher.status();
        assert_eq!((status["count"].as_u64(), status["evicted"].as_u64(), status["refusedForSpace"].as_u64()), (Some(2), Some(2), Some(1)));
    }

    #[tokio::test]
    async fn eviction_skips_a_mirror_a_live_stage_names_or_a_busy_one_and_a_new_mirror_without_room_goes() {
        let mut s = scratch("evictguard");
        s.publisher.policy.mirror_max = 8 * GIB;
        s.publisher.policy.mirrors_max = 20 * GIB;
        sh(&s.vm, "echo g > g && git add g && git commit -qm g");
        s.size("acme/gadgets", 5 * GIB);
        s.stage_all(on("gadgets", "main", "scout/g"), || {}).await.unwrap();
        // A new mirror, admitted, but once fetched the filesystem is under its floor (another
        // writer filled it): refused, and the new mirror doesn't stay.
        *s.disk.fs_on_measure.lock().unwrap() = Some(("acme/widgets".into(), (GIB, 100 * GIB)));
        let err = s.stage_all(request("scout/w"), || {}).await.unwrap_err();
        assert_eq!(err.0, 507, "{}", err.1);
        assert!(!s.dir().exists());
        *s.disk.fs_on_measure.lock().unwrap() = None;
        *s.disk.fs.lock().unwrap() = None;
        // An existing mirror over the total after the bundle: refused, nothing staged, kept.
        s.stage_all(request("scout/w"), || {}).await.unwrap();
        s.publisher.policy.mirrors_max = 10 * GIB;
        sh(&s.vm, "echo h > h && git add h && git commit -qm h");
        let err = s.stage_all(request("scout/w2"), || s.size("acme/widgets", 6 * GIB)).await.unwrap_err();
        assert!(err.0 == 507 && err.1.contains("mirrors use 11 of 10 GiB"), "{err:?}");
        assert!(s.dir().exists());
        assert_eq!(s.records().len(), 2, "the two earlier stages' records, none for this one");
        // Two days on, gadgets is idle, and widgets (11 of 10 with it) needs it gone.
        s.advance(2 * 86_400);
        // But a stage of it an hour old (by the clock) names it: kept, and refused.
        let now = s.publisher.now();
        let live = StageRecord { id: format!("{}-{}", now - 3600, "b".repeat(32)), sandbox: SANDBOX.into(), owner: "acme".into(), name: "gadgets".into(), base: "main".into(), base_sha: String::new(), branch: "scout/g".into(), sha: "b".repeat(40), diff_sha256: String::new(), created_at: now - 3600 };
        s.publisher.write_record(&live).unwrap();
        assert_eq!(s.stage_all(request("scout/w3"), || {}).await.unwrap_err().0, 507);
        assert!(s.publisher.mirror("acme", "gadgets").exists());
        std::fs::remove_file(s.publisher.record_path(&live.id)).unwrap();
        // Busy: its lock is held. Kept, and never waited for.
        {
            let lock = s.publisher.lock(&s.publisher.mirror("acme", "gadgets"));
            let _held = lock.lock().await;
            assert_eq!(s.stage_all(request("scout/w3"), || {}).await.unwrap_err().0, 507);
            assert!(s.publisher.mirror("acme", "gadgets").exists());
        }
        // Neither: it goes, and the stage goes through.
        s.stage_all(request("scout/w3"), || {}).await.unwrap();
        assert!(!s.publisher.mirror("acme", "gadgets").exists());
    }

    #[tokio::test]
    async fn the_filesystem_keeps_ten_percent_or_twenty_gib_free() {
        let s = scratch("floor");
        sh(&s.vm, "echo f > f && git add f && git commit -qm f");
        let low = |free: u64, floor: u64| (507, format!("the sandbox host is low on disk space ({free} GiB free, under the {floor} GiB it keeps free), so it has no room for the mirror of acme/widgets: nothing was staged. Try again later, or ask an operator to free space on the host."));
        // 20 GiB is more than 10% of 100 GiB.
        *s.disk.fs.lock().unwrap() = Some((15 * GIB, 100 * GIB));
        assert_eq!(s.stage_all(request("scout/f"), || {}).await.unwrap_err(), low(15, 20));
        // 10% of 500 GiB is more than 20 GiB.
        *s.disk.fs.lock().unwrap() = Some((40 * GIB, 500 * GIB));
        assert_eq!(s.stage_all(request("scout/f"), || {}).await.unwrap_err(), low(40, 50));
        *s.disk.fs.lock().unwrap() = Some((60 * GIB, 500 * GIB));
        s.stage_all(request("scout/f"), || {}).await.unwrap();
    }

    #[tokio::test]
    async fn a_stage_is_measured_without_its_bundle_file() {
        let mut s = scratch("bundlesize");
        heavy_commit(&s, "big.bin");
        s.stage_all(request("scout/b"), || {}).await.unwrap();
        // The same commits again: they are in the mirror already, so it grows by the ref and
        // the bundle file (64 KiB) only. A cap with half the bundle to spare holds.
        let size = RealDisk.usage(&s.dir()).0;
        s.publisher.policy.mirror_max = size + (32 << 10);
        s.stage_all(request("scout/b2"), || {}).await.unwrap();
    }

    #[tokio::test]
    async fn a_mirror_with_no_refs_yet_is_new_and_goes_when_its_first_fetch_has_no_room() {
        let s = scratch("norefs");
        sh(&s.vm, "echo z > z && git add z && git commit -qm z");
        s.stage_all(request("scout/z"), || {}).await.unwrap();
        // What a first fetch cut off by a stopping sandboxd leaves: an empty mirror, which
        // the quotas already know.
        let dir = s.dir();
        std::fs::remove_dir_all(&dir).unwrap();
        sh(&s.root, &format!("git init -q --bare {}", dir.display()));
        // Fetched, the filesystem is under its floor: refused, and the mirror doesn't stay.
        *s.disk.fs_on_measure.lock().unwrap() = Some(("acme/widgets".into(), (GIB, 100 * GIB)));
        let err = s.stage_all(request("scout/z2"), || {}).await.unwrap_err();
        assert_eq!(err.0, 507, "{}", err.1);
        assert!(!dir.exists(), "a mirror with no refs before this stage is new");
    }

    #[tokio::test]
    async fn a_new_mirror_needs_its_cap_free_above_the_floor() {
        let s = scratch("floornew");
        sh(&s.vm, "echo n > n && git add n && git commit -qm n");
        // 23 GiB free, over the 20 GiB floor, but not with a new mirror's 4 GiB: refused.
        *s.disk.fs.lock().unwrap() = Some((23 * GIB, 100 * GIB));
        let err = s.stage_all(request("scout/n"), || {}).await.unwrap_err();
        assert_eq!(err, (507, "the sandbox host is low on disk space for the mirror of acme/widgets (23 GiB free, and it keeps 20 GiB free; this one would need up to 4 GiB): nothing was staged. Try again later, or ask an operator to free space on the host.".to_string()));
        assert!(!s.dir().exists());
        *s.disk.fs.lock().unwrap() = Some((24 * GIB, 100 * GIB));
        s.stage_all(request("scout/n"), || {}).await.unwrap();
        // Once it exists, it needs only the floor.
        *s.disk.fs.lock().unwrap() = Some((21 * GIB, 100 * GIB));
        sh(&s.vm, "echo m > m && git add m && git commit -qm m");
        s.stage_all(request("scout/n2"), || {}).await.unwrap();
    }

    #[tokio::test]
    async fn the_status_reports_the_mirrors_as_last_measured() {
        let s = scratch("status");
        sh(&s.vm, "echo s > s && git add s && git commit -qm s");
        s.size("acme/widgets", GIB);
        *s.disk.fs.lock().unwrap() = Some((300 * GIB, 1000 * GIB));
        s.stage_all(request("scout/s"), || {}).await.unwrap();
        s.advance(60);
        let mut status = s.publisher.status();
        let idle = status["oldestIdleSecs"].as_u64().unwrap();
        assert!((60..=120).contains(&idle), "{idle}");
        status["oldestIdleSecs"] = 60.into();
        assert_eq!(
            status,
            serde_json::json!({
                "count": 1, "bytes": GIB, "maxBytes": 24 * GIB, "perMirrorMaxBytes": 4 * GIB, "fsFreeBytes": 300 * GIB,
                "garbageBytes": 0, "stageRefs": 1, "records": 1, "largest": { "repo": "acme/widgets", "bytes": GIB },
                "oldestIdleSecs": 60, "lastGc": null, "evicted": 0, "refusedForSpace": 0, "refreshTimeouts": 0,
            })
        );
    }

    #[tokio::test]
    async fn branches_named_like_git_garbage_are_kept_however_old() {
        // GitHub allows a branch called tmp_pack_x or stage-x.bundle; only where git and a
        // stage put such files are they garbage.
        let s = scratch("garbagenames");
        let dir = s.dir();
        sh(&s.vm, "for b in tmp_pack_release tmp_idx_release stage-1.bundle; do git push -q origin HEAD:refs/heads/$b; done");
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        let refs = ["refs/heads/tmp_pack_release", "refs/heads/tmp_idx_release", "refs/heads/stage-1.bundle"];
        for r in refs {
            let loose = dir.join(r);
            assert!(loose.is_file(), "{r} is a loose ref");
            age(&loose, GARBAGE_AGE.as_secs() + 60);
        }
        s.publisher.prune(&dir).await;
        for r in refs {
            assert!(dir.join(r).is_file(), "{r}");
        }
    }

    #[tokio::test]
    async fn garbage_is_counted_only_where_git_and_a_stage_leave_it() {
        let s = scratch("garbagebytes");
        let dir = s.dir();
        sh(&s.vm, "git push -q origin HEAD:refs/heads/tmp_pack_release");
        s.publisher.update_mirror(&dir, "acme", "widgets", None).await.unwrap();
        assert!(dir.join("refs/heads/tmp_pack_release").is_file());
        assert_eq!(RealDisk.usage(&dir).1, 0, "a branch is not garbage");
        std::fs::write(dir.join("objects/pack/tmp_pack_x"), [0u8; 100]).unwrap();
        std::fs::write(dir.join("stage-x.bundle"), [0u8; 10]).unwrap();
        assert_eq!(RealDisk.usage(&dir).1, 110);
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
        let id = new_stage_id().unwrap();
        assert!(stage_id(&id) && id != new_stage_id().unwrap());
        let hex = "0".repeat(32);
        for bad in ["", "123", &format!("x-{hex}"), &format!("123-{}", "A".repeat(32)), &format!("123-{hex}0"), &format!("../{hex}"), &format!("123-{hex}/..")] {
            assert!(!stage_id(bad), "{bad}");
        }
    }
}
