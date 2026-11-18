//! Sandboxes: one Firecracker microVM per id.
//!
//! First use reflinks the golden rootfs into the sandbox's directory (a copy-on-write
//! clone: milliseconds, and only what the sandbox changes takes space), then boots it.
//! An idle VM is stopped but its disk is kept, so a thread that comes back hours later
//! finds the same checkout. Stopping always flushes the guest's page cache first: a bare
//! kill once lost a clone that had just finished (the spike, 2026-09-25).
//!
//! Every VM runs under Firecracker's jailer, as its slot's uid, chrooted, in its own
//! cgroup (jail.rs).

use crate::config::Config;
use crate::jail::{self, Host, Jail};
use crate::net::{self, Slot};
use crate::quota::{self, Quota};
use crate::resources::{self, Granted, Policy, Refusal, Request};
use crate::vsock;
use bytes::Bytes;
use hyper::Method;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use crate::pidfd::Pidfd;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Firecracker processes a previous run left behind (a crash or SIGKILL gives the
/// VMMs' kill-on-drop no chance). Under sandboxd.service this is a backstop: when sandboxd dies,
/// systemd SIGKILLs what is left in its cgroup before the restart (KillMode=mixed; seen on
/// starship, 2026-10-12), and won't start it again while a VMM remains there. Ours are the
/// jailed ones in our VMs' cgroup, and, from builds before the jail, unjailed ones with an
/// --api-sock under our state directory.
/// Each is asked to sync and reboot through its vsock, then killed if it's still there,
/// so a restarted daemon never boots a disk an old VMM still holds.
pub async fn stop_stale_vmms(state_dir: &Path, host: &Host) {
    let Ok(mut procs) = tokio::fs::read_dir("/proc").await else { return }; // not Linux
    while let Ok(Some(entry)) = procs.next_entry().await {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(cmdline) = tokio::fs::read(format!("/proc/{pid}/cmdline")).await else { continue };
        let args: Vec<String> = cmdline.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        if !args.first().is_some_and(|a| jail::is_firecracker(a)) {
            continue;
        }
        let cgroup = tokio::fs::read_to_string(format!("/proc/{pid}/cgroup")).await.unwrap_or_default();
        let candidates = if let Some(id) = jail::jailed_vmm(&args, &cgroup, &host.cgroup_parent) {
            jailed_uds(state_dir, &host.exec_name, &id).await
        } else {
            let Some(api) = args.iter().position(|a| a == "--api-sock").and_then(|i| args.get(i + 1)) else { continue };
            let api = Path::new(api);
            if !api.starts_with(state_dir) {
                continue;
            }
            vec![api.parent().unwrap_or(state_dir).join("vsock.sock")]
        };
        // Held by a pidfd from here on, and checked again through it: if the process the
        // scan saw is gone and its number reused, the check reads the newcomer and skips it.
        let Ok(pidfd) = Pidfd::open(pid) else { continue };
        let still_it = tokio::fs::read(format!("/proc/{pid}/cmdline")).await.is_ok_and(|c| c == cmdline);
        if !still_it || pidfd.exited() {
            continue;
        }
        eprintln!("sandboxd: stopping a VMM left by a previous run (pid {pid}; {} socket(s) that may be its)", candidates.len());
        // Several sandboxes can hold a leftover jail for the same slot; only the live VM's
        // socket answers, so each is tried until one does.
        for uds in candidates {
            let body = Bytes::from_static(br#"{"command":"sync && (sleep 0.2; reboot -f) &","timeoutMs":10000}"#);
            if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_secs(10), vsock::request(&uds, Method::POST, "/exec", body)).await {
                break;
            }
        }
        if !pidfd.wait(Duration::from_secs(5)).await {
            let _ = pidfd.kill();
            let _ = pidfd.wait(Duration::from_secs(1)).await;
        }
    }
    // Their cgroups, once empty.
    let parent = Path::new("/sys/fs/cgroup").join(&host.cgroup_parent);
    if let Ok(mut dirs) = tokio::fs::read_dir(&parent).await {
        while let Ok(Some(entry)) = dirs.next_entry().await {
            if entry.file_type().await.is_ok_and(|t| t.is_dir()) {
                let _ = tokio::fs::remove_dir(entry.path()).await;
            }
        }
    }
    // And their jails: the disks root's again now, not at each sandbox's next boot, which
    // may never come.
    let state = state_dir.to_path_buf();
    let released = tokio::task::spawn_blocking(move || release_leftover_jails(&state)).await.unwrap_or(0);
    if released > 0 {
        eprintln!("sandboxd: removed {released} jail(s) a previous run left");
    }
}

/// jail::release_leftover for each sandbox's directory, and nothing else in the state
/// directory (`.mirrors/<owner>` is not a sandbox, even for an owner named "jail").
fn release_leftover_jails(state_dir: &Path) -> usize {
    let Ok(dirs) = std::fs::read_dir(state_dir) else { return 0 };
    dirs.flatten()
        .filter(|e| e.file_name().to_str().is_some_and(valid_id) && e.file_type().is_ok_and(|t| t.is_dir()) && jail::release_leftover(&e.path()))
        .count()
}

/// Every vsock socket left in a jail named `jail_id`, whichever sandbox's directory holds it.
async fn jailed_uds(state_dir: &Path, exec_name: &str, jail_id: &str) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let Ok(mut dirs) = tokio::fs::read_dir(state_dir).await else { return found };
    while let Ok(Some(entry)) = dirs.next_entry().await {
        let uds = entry.path().join(jail::JAIL_DIR).join(exec_name).join(jail_id).join("root/vsock.sock");
        if tokio::fs::symlink_metadata(&uds).await.is_ok() {
            found.push(uds);
        }
    }
    found
}

/// A running VMM (the jailer, which execs Firecracker in place), held by a pidfd opened
/// right after the spawn, before anything could reap it. Its exit is seen and its kill is
/// sent through the pidfd only, so neither can ever reach a reused pid: not after a failed
/// wait, not when it is dropped (at shutdown, or with a boot that was given up on).
pub(crate) struct Vmm {
    /// Shared with Manager::vmms, so fail_closed can kill it without its sandbox's lock.
    pidfd: Arc<Pidfd>,
    /// Kept only to be reaped (no kill_on_drop: a dropped Child is reaped by tokio).
    child: Child,
}

impl Vmm {
    fn spawn(cmd: &mut Command) -> Result<Vmm, String> {
        let mut child = cmd.kill_on_drop(false).spawn().map_err(|e| format!("jailer: {e}"))?;
        let opened = child.id().ok_or_else(|| "jailer: no pid".to_string()).and_then(|pid| Pidfd::open(pid).map_err(|e| format!("pidfd: {e}")));
        match opened {
            Ok(pidfd) => Ok(Vmm { pidfd: Arc::new(pidfd), child }),
            Err(e) => {
                // Not waited for yet, so the pid is still this child's: safe to signal.
                let _ = child.start_kill();
                Err(e)
            }
        }
    }

    fn exited(&mut self) -> bool {
        let gone = self.pidfd.exited();
        if gone {
            let _ = self.child.try_wait(); // reap; an error just means someone else did
        }
        gone
    }

    async fn wait(&mut self, grace: Duration) -> bool {
        let gone = self.pidfd.wait(grace).await;
        if gone {
            let _ = self.child.try_wait();
        }
        gone
    }
}

impl Drop for Vmm {
    fn drop(&mut self) {
        let _ = self.pidfd.kill(); // ESRCH if it has exited: the pidfd names nothing else
    }
}

/// A boot that failed; `unstopped` is its VMM when that one's exit couldn't be confirmed.
struct BootError {
    msg: String,
    unstopped: Option<Box<Vmm>>,
}

impl From<String> for BootError {
    fn from(msg: String) -> BootError {
        BootError { msg, unstopped: None }
    }
}

/// Wait up to `grace` for the VMM to exit, then SIGKILL it and wait as long again. True
/// only once its exit has been seen through its pidfd.
async fn exited_or_killed(vmm: &mut Vmm, grace: Duration) -> bool {
    if vmm.wait(grace).await {
        return true;
    }
    let _ = vmm.pidfd.kill();
    vmm.wait(grace).await
}

/// Whether an idle VM with `jobs` running is kept up: while its last request is under
/// `hold` ago.
fn held_by_jobs(jobs: u64, idle_secs: u64, hold: Duration) -> bool {
    jobs > 0 && idle_secs < hold.as_secs()
}

/// A background job's id, as guestd takes it: 1–64 of [A-Za-z0-9_.-], starting with a
/// letter or digit (so never `.` or `..` as a path segment).
pub fn valid_job_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.as_bytes()[0].is_ascii_alphanumeric() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

/// A job's guestd path from its parts, or None if any part isn't one guestd takes: `GET
/// /jobs/{job}` with only `waitMs` and `tailBytes` (digits) in its query, `POST
/// /jobs/{job}/cancel` with none, `POST /jobs` with none. The runner's allow list and the
/// serve API both go through this.
pub fn job_call(method: &str, path: &str) -> Option<Method> {
    let (route, query) = match path.split_once('?') {
        Some((r, q)) => (r, Some(q)),
        None => (path, None),
    };
    let numeric_params = |q: Option<&str>| {
        q.is_none_or(|q| {
            q.split('&').all(|kv| match kv.split_once('=') {
                Some(("waitMs" | "tailBytes", v)) => !v.is_empty() && v.len() <= 9 && v.bytes().all(|b| b.is_ascii_digit()),
                _ => false,
            })
        })
    };
    match (method, route) {
        ("POST", "/jobs") if query.is_none() => Some(Method::POST),
        (_, r) => {
            let rest = r.strip_prefix("/jobs/")?;
            match (method, rest.split_once('/')) {
                ("GET", None) if valid_job_id(rest) && numeric_params(query) => Some(Method::GET),
                ("POST", Some((job, "cancel"))) if valid_job_id(job) && query.is_none() => Some(Method::POST),
                _ => None,
            }
        }
    }
}

pub const BAD_JOB_ID: &str = "bad job id: use 1–64 of [A-Za-z0-9_.-], starting with a letter or digit";

/// Why job_call refused a call, as a sentence the caller can act on: the job id, or the query.
pub fn job_call_refusal(path: &str) -> &'static str {
    let route = path.split_once('?').map_or(path, |(r, _)| r);
    let job = route.strip_prefix("/jobs/").map(|r| r.split_once('/').map_or(r, |(j, _)| j));
    match job {
        Some(j) if !valid_job_id(j) => BAD_JOB_ID,
        Some(_) if path.contains('?') && !route.ends_with("/cancel") => "bad status query: it takes only waitMs and tailBytes, each in digits",
        _ => "not a job call: POST /jobs, GET /jobs/<id>?waitMs=&tailBytes=, or POST /jobs/<id>/cancel (with no query)",
    }
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') && !id.starts_with('.')
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

struct Running {
    vmm: Vmm,
    slot: usize,
    /// What this VM was booted with: its sandbox's resources (resources.rs).
    granted: Granted,
}

/// Why a sandbox couldn't be reached, for the caller: a request for resources refused
/// (with its code), or anything else (all slots busy, a failed boot).
#[derive(Debug)]
pub enum AcquireError {
    Refused(Refusal),
    Failed(u16, String),
}

impl AcquireError {
    pub fn status(&self) -> u16 {
        match self {
            AcquireError::Refused(r) => r.status,
            AcquireError::Failed(status, _) => *status,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            AcquireError::Refused(r) => &r.message,
            AcquireError::Failed(_, msg) => msg,
        }
    }

    pub fn code(&self) -> Option<&'static str> {
        match self {
            AcquireError::Refused(r) => Some(r.code),
            AcquireError::Failed(..) => None,
        }
    }

    /// The serve API's error body: `{ "error" }`, and for a refusal its code and detail.
    pub fn body(&self) -> serde_json::Value {
        match self {
            AcquireError::Refused(r) => r.body(),
            AcquireError::Failed(_, msg) => serde_json::json!({ "error": msg }),
        }
    }
}

impl From<Refusal> for AcquireError {
    fn from(r: Refusal) -> AcquireError {
        AcquireError::Refused(r)
    }
}

pub struct Sandbox {
    pub id: String,
    dir: PathBuf,
    running: Mutex<Option<Running>>,
    last_used: AtomicU64,
    in_flight: AtomicUsize,
}

impl Sandbox {
    fn rootfs(&self) -> PathBuf {
        self.dir.join("rootfs.ext4")
    }
}

/// Marks a sandbox busy for the lifetime of one request; the reaper never stops a busy VM.
/// Its end is the sandbox's last use, unless the request was refused before it reached
/// the VM (`refused`): a caller repeating a request the VM can't serve must not keep the
/// VM from the idle stop that would let the request through.
pub struct Use {
    sandbox: Arc<Sandbox>,
    counts: bool,
}
impl Use {
    fn refused(mut self) {
        self.counts = false;
    }
}
impl Drop for Use {
    fn drop(&mut self) {
        if self.counts {
            self.sandbox.last_used.store(now_secs(), Ordering::SeqCst);
        }
        self.sandbox.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What a boot is to give a sandbox, and whether that is news.
struct Plan {
    granted: Granted,
    /// Record it beside the disk: a request decided it, and it isn't what is recorded.
    keep: bool,
    /// What the sandbox had until now, when it existed and this differs (for the log).
    from: Option<Granted>,
}

pub struct Manager {
    cfg: Config,
    host: Arc<Host>,
    /// The nftables table, checked before every boot.
    fw: Arc<net::Firewall>,
    quota: Quota,
    /// What a sandbox gets by default and at most (resources.rs).
    policy: Policy,
    sandboxes: Mutex<HashMap<String, Arc<Sandbox>>>,
    slots: Mutex<Vec<bool>>, // true = taken
    /// Each VMM's pidfd by slot, from its spawn (boot included) until its slot is
    /// released: fail_closed kills through it at once, even while a stop or a request
    /// holds that sandbox's lock.
    vmms: std::sync::Mutex<HashMap<usize, Arc<Pidfd>>>,
}

#[derive(serde::Serialize)]
pub struct Listing {
    id: String,
    running: bool,
    idle_secs: u64,
    in_flight: usize,
    /// What it runs with now, or (stopped) what its record says its last request came to:
    /// null for a stopped sandbox with no record, which follows the host's defaults.
    resources: Option<Granted>,
}

/// The defaults and maxima in force: the configuration's, and for the disk what this
/// host can enforce (`quota`, detected at start). With the quota off no size is granted.
pub fn policy(cfg: &Config, quota: &Quota) -> Policy {
    let disk_gib = match quota {
        Quota::Btrfs { bytes } => Some(bytes >> 30),
        Quota::Off => None,
    };
    let mut maxima = cfg.maxima.clone();
    if disk_gib.is_none() {
        maxima.disk_gib = 0;
    }
    Policy {
        defaults: Granted { vcpus: cfg.vcpus as u64, mem_mib: cfg.mem_mib as u64, disk_gib, pids: resources::DEFAULT_PIDS, command_timeout_secs: resources::DEFAULT_COMMAND_TIMEOUT_SECS },
        maxima,
    }
}

impl Manager {
    pub fn new(cfg: Config, host: Arc<Host>, quota: Quota, fw: Arc<net::Firewall>) -> Arc<Manager> {
        let slots = vec![false; cfg.max_vms];
        let policy = policy(&cfg, &quota);
        Arc::new(Manager { cfg, host, fw, quota, policy, sandboxes: Mutex::new(HashMap::new()), slots: Mutex::new(slots), vmms: std::sync::Mutex::new(HashMap::new()) })
    }

    /// What a sandbox gets here by default and at most.
    pub fn policy(&self) -> &Policy {
        &self.policy
    }

    fn jail<'a>(&'a self, sb: &'a Sandbox, slot: usize) -> Jail<'a> {
        Jail::new(&self.host, &sb.dir, slot)
    }

    /// Everything a VM in `slot` held, given back once its process is gone: its tap, its
    /// jail (the disk root's again) and the slot.
    async fn release(&self, sb: &Sandbox, slot: usize) {
        self.vmms.lock().unwrap_or_else(|e| e.into_inner()).remove(&slot);
        net::tap_down(&Slot { index: slot }).await;
        self.jail(sb, slot).release(&sb.rootfs()).await;
        self.free_slot(slot).await;
    }

    async fn get(&self, id: &str) -> Arc<Sandbox> {
        let mut map = self.sandboxes.lock().await;
        map.entry(id.to_string())
            .or_insert_with(|| {
                Arc::new(Sandbox {
                    id: id.to_string(),
                    dir: self.cfg.state_dir.join(id),
                    running: Mutex::new(None),
                    last_used: AtomicU64::new(now_secs()),
                    in_flight: AtomicUsize::new(0),
                })
            })
            .clone()
    }

    async fn take_slot(&self) -> Option<usize> {
        let mut slots = self.slots.lock().await;
        let i = slots.iter().position(|taken| !taken)?;
        slots[i] = true;
        Some(i)
    }

    async fn free_slot(&self, i: usize) {
        self.slots.lock().await[i] = false;
    }

    /// `acquire_with` for a caller that asks for no resources (publishing, which works on a
    /// sandbox that exists): the sandbox as it is.
    pub async fn acquire(&self, id: &str) -> Result<(Use, PathBuf), (u16, String)> {
        match self.acquire_with(id, None).await {
            Ok((guard, uds, _)) => Ok((guard, uds)),
            Err(e) => Err((e.status(), e.message().to_string())),
        }
    }

    /// Boot the sandbox if it isn't running, and mark it in use. Errors are client-facing.
    ///
    /// `request`: the resources the caller asks for (resources.rs). A sandbox whose VM
    /// isn't running is booted with them, within this install's maxima; one whose VM runs
    /// must already have them. Either is decided before anything is made, booted or
    /// changed, a refusal is logged, and a refused call is not a use of the sandbox.
    /// Returns what the sandbox has.
    pub async fn acquire_with(&self, id: &str, request: Option<&Request>) -> Result<(Use, PathBuf, Granted), AcquireError> {
        self.acquire_for(id, request, false).await
    }

    /// `acquire_with`, for a call that says what it is. `watching`: the call only reads or
    /// stops something a running VM already has (a job's status, a job's cancel, a file
    /// read): it starts no work and makes nothing, so a VM running with other resources
    /// than `request` comes to serves it as it is. Otherwise a job started before a
    /// profile's request changed could be neither watched nor cancelled for as long as it
    /// holds its VM up (SANDBOXD_JOB_HOLD_SECS, 6 h by default). With the VM stopped the
    /// call boots it like any other, with the request.
    pub async fn acquire_for(&self, id: &str, request: Option<&Request>, watching: bool) -> Result<(Use, PathBuf, Granted), AcquireError> {
        let sb = self.get(id).await;
        sb.in_flight.fetch_add(1, Ordering::SeqCst);
        let guard = Use { sandbox: sb.clone(), counts: true };
        let mut running = sb.running.lock().await;
        let alive = match running.as_mut() {
            // An error reading its state is not proof it's gone: treat it as alive.
            Some(r) => !r.vmm.exited(),
            None => false,
        };
        let request = request.filter(|r| !r.is_empty());
        let plan = match self.resources_for(&sb, running.as_ref().filter(|_| alive).map(|r| &r.granted), request, watching).await {
            Ok(v) => v,
            Err(e) => {
                eprintln!("sandboxd: {}: refused ({}): {}", sb.id, e.code().unwrap_or("error"), e.message());
                if running.is_none() {
                    self.forget_if_never_created(&sb).await;
                }
                // Not a use of the VM: it never reached it.
                drop(running);
                guard.refused();
                return Err(e);
            }
        };
        let granted = plan.granted.clone();
        if !alive {
            if let Some(dead) = running.take() {
                self.release(&sb, dead.slot).await;
            }
            let Some(slot) = self.take_slot().await else {
                self.forget_if_never_created(&sb).await;
                return Err(AcquireError::Failed(503, format!("all {} sandboxes are busy; try again later", self.cfg.max_vms)));
            };
            match self.boot(&sb, slot, &plan).await {
                Ok(vmm) => *running = Some(self.track(vmm, slot, granted.clone())),
                Err(BootError { msg, unstopped: Some(vmm) }) => {
                    // A VMM whose exit couldn't be confirmed keeps its slot, jail and disk
                    // (as in stop_locked); the next request finds it and tries again.
                    eprintln!("sandboxd: {}: its VMM's exit couldn't be confirmed after a failed boot; it keeps slot {slot} until it is", sb.id);
                    *running = Some(self.track(*vmm, slot, granted));
                    return Err(AcquireError::Failed(500, msg));
                }
                Err(BootError { msg, unstopped: None }) => {
                    self.release(&sb, slot).await;
                    self.forget_if_never_created(&sb).await;
                    return Err(AcquireError::Failed(500, msg));
                }
            }
        }
        sb.last_used.store(now_secs(), Ordering::SeqCst);
        let slot = running.as_ref().map(|r| r.slot).unwrap_or_default();
        Ok((guard, self.jail(&sb, slot).uds(), granted))
    }

    /// What the sandbox's VM has, or is to be booted with, given what the caller asks for.
    /// Called under the sandbox's lock; makes and changes nothing (the boot does).
    ///
    /// `up`: the grant of its VM, when that runs now. Resources are fixed while it does: a
    /// request must come to what the VM has, unless the call only watches or stops what it
    /// runs (`watching`). With the VM stopped (or never booted) a
    /// request is granted afresh against the maxima in force and becomes the sandbox's
    /// from that boot on, except less disk than the sandbox already uses, which is never
    /// applied. No request: the sandbox as it is (its record, held to the rules a request
    /// is; or the host's defaults for one that has none).
    async fn resources_for(&self, sb: &Sandbox, up: Option<&Granted>, request: Option<&Request>, watching: bool) -> Result<Plan, AcquireError> {
        if let Some(has) = up {
            // A call that only watches or stops what the VM runs is served as the VM is.
            if let Some(req) = request.filter(|_| !watching) {
                self.policy.check_running(&sb.id, has, req, self.cfg.idle.as_secs())?;
            }
            return Ok(Plan { granted: has.clone(), keep: false, from: None });
        }
        let created = sb.rootfs().exists();
        let stored = if created { resources::read_stored(&sb.dir).map_err(|e| AcquireError::Failed(500, e))? } else { None };
        let Some(req) = request else {
            if let Some(stored) = &stored {
                self.policy.validate(&sb.id, stored)?;
            }
            return Ok(Plan { granted: stored.unwrap_or_else(|| self.policy.defaults.clone()), keep: false, from: None });
        };
        let want = self.policy.grant(req)?;
        if !created {
            return Ok(Plan { granted: want, keep: true, from: None });
        }
        let has = stored.clone().unwrap_or_else(|| self.policy.defaults.clone());
        let capped = quota::capped(&self.quota, &sb.dir);
        // A size for a directory no limit holds on (made before the quota was on).
        if let Some(asked) = req.disk_gib.filter(|_| !capped) {
            return Err(resources::uncapped_directory(&sb.id, asked).into());
        }
        // Less disk than it had: only if what it has written fits. Usage that can't be
        // read is not taken to fit.
        if let Some(new) = want.disk_gib.filter(|new| capped && has.disk_gib.is_none_or(|old| *new < old)) {
            let used = quota::used_bytes(&sb.dir).await.map_err(|e| AcquireError::Failed(500, format!("sandbox {}'s disk usage couldn't be read, so its cap is not lowered to {new} GiB: {e}", sb.id)))?;
            if used > new << 30 {
                return Err(resources::disk_in_use(&sb.id, new, used).into());
            }
        }
        Ok(Plan { keep: stored.as_ref() != Some(&want), from: (has != want).then_some(has), granted: want })
    }

    /// A sandbox that was refused before it ever got a disk leaves no trace in the listing,
    /// but only when this failed acquisition is its sole user and it is still the entry in
    /// the map. Removing it under a request that is waiting on the same `running` lock would
    /// let the next request create a second entry for the same directory and boot it twice.
    async fn forget_if_never_created(&self, sb: &Arc<Sandbox>) {
        let mut map = self.sandboxes.lock().await;
        let current = map.get(&sb.id).is_some_and(|e| Arc::ptr_eq(e, sb));
        if current && sb.in_flight.load(Ordering::SeqCst) == 1 && !sb.dir.join("rootfs.ext4").exists() {
            map.remove(&sb.id);
        }
    }

    /// `plan.granted`: what the VM gets (its size, its cgroup's limits, its disk's cap).
    /// `plan.keep`: record it beside the disk first, as the sandbox's resources from now on.
    async fn boot(&self, sb: &Sandbox, slot_index: usize, plan: &Plan) -> Result<Vmm, BootError> {
        let granted = &plan.granted;
        let t0 = Instant::now();
        let slot = Slot { index: slot_index };
        // No VM boots unfiltered: the table is checked (and loaded again if it was flushed)
        // first. If it can't be, the running VMs are stopped too (main's watch, woken here).
        if let Err(e) = self.fw.ensure().await {
            self.fw.alarm.notify_one();
            return Err(e.into());
        }
        quota::prepare_dir(&self.quota, &sb.dir, granted.disk_bytes()).await?;
        let rootfs = sb.rootfs();
        // The record goes down after the disk's cap is set and before the disk is made or
        // the VM started: what a sandbox runs with is always what its record says. One
        // created with no request keeps none (and loses one a creation that failed before
        // its disk was made left), and follows the host's defaults at every boot.
        if plan.keep {
            resources::store(&sb.dir, granted)?;
            if let Some(from) = &plan.from {
                eprintln!("sandboxd: {}: resources changed from ({}) to ({}), as its request asks; they apply from this boot", sb.id, from.describe(), granted.describe());
            }
        } else if !rootfs.exists() {
            let _ = std::fs::remove_file(sb.dir.join(resources::FILE));
        }
        if !rootfs.exists() {
            let out = crate::child::command("cp").arg("--reflink=always").arg(&self.cfg.golden).arg(&rootfs).output().await.map_err(|e| format!("cp: {e}"))?;
            if !out.status.success() {
                return Err(format!("reflink golden: {}", String::from_utf8_lossy(&out.stderr).trim()).into());
            }
        }
        // The jail, rebuilt from nothing (a few ms: the disk is a hard link, the kernel a
        // copy of a few tens of MB), off the async workers.
        let (host, dir, kernel, vm) = (self.host.clone(), sb.dir.clone(), self.cfg.kernel.clone(), vm_config(&self.cfg, slot_index, granted).to_string());
        tokio::task::spawn_blocking(move || Jail::new(&host, &dir, slot_index).build(&dir.join("rootfs.ext4"), &kernel, vm.as_bytes()))
            .await
            .map_err(|e| format!("jail: {e}"))??;
        let jail = self.jail(sb, slot_index);
        net::tap_up(&slot, jail.uid()).await?;
        let console = std::fs::File::create(sb.dir.join("console.log")).map_err(|e| format!("console.log: {e}"))?;
        // Tracked from its spawn, not only once it answers: the rules can go during the boot.
        let mut vmm = self.spawn_tracked(&mut vmm_command(&self.host.jailer, &jail.args(granted), console)?, slot_index)?;
        let uds = jail.uds();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if vmm.exited() {
                return Err(format!("the jailer or firecracker exited during boot; see {}/console.log", sb.dir.display()).into());
            }
            // Each probe is bounded, so a guest that accepts but never answers can't hold
            // the slot past the deadline.
            if uds.exists() && tokio::time::timeout(Duration::from_secs(2), vsock::healthy(&uds)).await.unwrap_or(false) {
                eprintln!("sandboxd: {} booted in slot {} in {} ms ({})", sb.id, slot_index, t0.elapsed().as_millis(), granted.describe());
                return Ok(vmm);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        // A guest that never answered won't exit by itself: killed now, then waited for.
        let _ = vmm.pidfd.kill();
        let msg = format!("guestd never answered within 60 s; see {}/console.log", sb.dir.display());
        let unstopped = (!vmm.wait(Duration::from_secs(5)).await).then(|| Box::new(vmm));
        Err(BootError { msg, unstopped })
    }

    /// Flush the guest's disk cache, reboot it (reboot=k makes that exit the VMM), and
    /// fall back to a kill if it doesn't go.
    async fn stop(&self, sb: &Sandbox) {
        let mut running = sb.running.lock().await;
        let _ = self.stop_locked(sb, &mut running).await;
    }

    /// `stop` for a caller already holding the sandbox's `running` lock. Every request
    /// takes that lock to reach the VM, so while it's held nothing new can start using it.
    /// Whether the VM is gone: false leaves it running, in its slot, with its jail.
    async fn stop_locked(&self, sb: &Sandbox, running: &mut Option<Running>) -> bool {
        let Some(mut r) = running.take() else { return true };
        let body = Bytes::from_static(br#"{"command":"sync && (sleep 0.2; reboot -f) &","timeoutMs":10000}"#);
        // Bounded too: a hung guest still gets killed below.
        let _ = tokio::time::timeout(Duration::from_secs(10), vsock::request(&self.jail(sb, r.slot).uds(), Method::POST, "/exec", body)).await;
        if !exited_or_killed(&mut r.vmm, Duration::from_secs(5)).await {
            // Releasing now would re-own the disk, delete the jail and give the slot (and
            // its uid) to the next VM while this VMM may still run. Kept for the next try.
            eprintln!("sandboxd: {}: its VMM's exit couldn't be confirmed; it keeps slot {} until it is", sb.id, r.slot);
            *running = Some(r);
            return false;
        }
        self.release(sb, r.slot).await;
        eprintln!("sandboxd: {} stopped (disk kept)", sb.id);
        true
    }

    /// Stop the VM and delete its disk.
    pub async fn destroy(&self, id: &str) -> Result<(), String> {
        let sb = self.get(id).await;
        {
            // Decide and stop under the lock every request takes, so none slips in between.
            let mut running = sb.running.lock().await;
            if sb.in_flight.load(Ordering::SeqCst) > 0 {
                return Err("sandbox is busy".into());
            }
            if !self.stop_locked(&sb, &mut running).await {
                return Err("sandbox's VM could not be stopped".into());
            }
        }
        self.sandboxes.lock().await.remove(id);
        let removed = match tokio::fs::remove_dir_all(&sb.dir).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {}: {e}", sb.dir.display())),
        };
        quota::after_destroy(&self.quota, &self.cfg.state_dir).await;
        removed
    }

    /// Stop every running VM that has been idle longer than the configured idle time. A
    /// running background job counts as activity (guestd says how many run), for up to
    /// SANDBOXD_JOB_HOLD_SECS after the VM's last request: past that a job is taken to be
    /// abandoned, or a guest to be claiming one to keep its slot, and the VM is stopped
    /// with its jobs (their status reads "lost" from then on).
    pub async fn reap(&self) {
        let list: Vec<Arc<Sandbox>> = self.sandboxes.lock().await.values().cloned().collect();
        let now = now_secs();
        for sb in list {
            // Check idleness while holding the lock every request takes to reach the VM: a
            // request that arrives after this point waits, then boots the VM again.
            let mut running = sb.running.lock().await;
            let idle = now.saturating_sub(sb.last_used.load(Ordering::SeqCst));
            let Some(slot) = running.as_ref().map(|r| r.slot) else { continue };
            if sb.in_flight.load(Ordering::SeqCst) > 0 || idle < self.cfg.idle.as_secs() {
                continue;
            }
            // Asked only of a VM about to be stopped, and bounded: a guest that doesn't
            // answer is stopped as before.
            let jobs = if self.cfg.job_hold.is_zero() { 0 } else { vsock::running_jobs(&self.jail(&sb, slot).uds()).await.unwrap_or(0) };
            if held_by_jobs(jobs, idle, self.cfg.job_hold) {
                continue;
            }
            if jobs > 0 {
                eprintln!("sandboxd: {}: stopping with {jobs} running job(s): no request for {idle} s, past SANDBOXD_JOB_HOLD_SECS ({} s)", sb.id, self.cfg.job_hold.as_secs());
            }
            let _ = self.stop_locked(&sb, &mut running).await;
        }
    }

    /// A VMM now running in `slot`, its pidfd recorded for fail_closed.
    fn track(&self, vmm: Vmm, slot: usize, granted: Granted) -> Running {
        self.vmms.lock().unwrap_or_else(|e| e.into_inner()).insert(slot, vmm.pidfd.clone());
        Running { vmm, slot, granted }
    }

    /// Vmm::spawn for a boot into `slot`, its pidfd recorded at once: a boot holds its
    /// sandbox's lock for up to a minute, and fail_closed must reach that VMM meanwhile.
    /// Every way out of a failed boot releases the slot, which forgets it again.
    fn spawn_tracked(&self, cmd: &mut Command, slot: usize) -> Result<Vmm, String> {
        let vmm = Vmm::spawn(cmd)?;
        self.vmms.lock().unwrap_or_else(|e| e.into_inner()).insert(slot, vmm.pidfd.clone());
        Ok(vmm)
    }

    /// The network rules are gone for good and every tap was told to go down (`taps`).
    /// Isolation comes before the disk only where the cut isn't confirmed: a VM whose tap
    /// is confirmed down is stopped gracefully (its guest syncs first), one whose tap isn't
    /// is SIGKILLed through its pidfd at once, without a sync, and reported. Then every VM
    /// is stopped and released as usual (a killed one only reaped). Which VMs it killed.
    pub async fn fail_closed(self: &Arc<Self>, taps: &net::TapsDown) -> Vec<usize> {
        let unconfirmed: Vec<(usize, Arc<Pidfd>)> = {
            let vmms = self.vmms.lock().unwrap_or_else(|e| e.into_inner());
            let mut v: Vec<_> = vmms.iter().filter(|(slot, _)| !taps.confirmed(&Slot { index: **slot }.tap())).map(|(s, p)| (*s, p.clone())).collect();
            v.sort_by_key(|(s, _)| *s);
            v
        };
        let mut killed = Vec::new();
        for (slot, pidfd) in unconfirmed {
            match pidfd.kill() {
                Ok(()) => {
                    eprintln!("sandboxd: ALERT: slot {slot}'s VMM killed (SIGKILL, no sync): its tap {} couldn't be confirmed down", Slot { index: slot }.tap());
                    killed.push(slot);
                }
                Err(e) if e.raw_os_error() == Some(libc::ESRCH) => {} // already gone
                Err(e) => eprintln!("sandboxd: ALERT: slot {slot}'s VMM couldn't be killed ({e}); its tap isn't confirmed down"),
            }
        }
        self.stop_all().await;
        killed
    }

    /// Stop every VM at once, not one after another, so shutdown takes about as long as
    /// the slowest stop (≤ 20 s: the sync request, the exit, a kill) however many are running.
    pub async fn stop_all(self: &Arc<Self>) {
        let list: Vec<Arc<Sandbox>> = self.sandboxes.lock().await.values().cloned().collect();
        let mut stops = tokio::task::JoinSet::new();
        for sb in list {
            let me = self.clone();
            stops.spawn(async move { me.stop(&sb).await });
        }
        while stops.join_next().await.is_some() {}
    }

    /// VMs running now (for a runner's status: Lorehouse places new sandboxes by free room).
    pub async fn running_count(&self) -> usize {
        self.slots.lock().await.iter().filter(|taken| **taken).count()
    }

    /// Sandboxes whose VM is up now, each already counted in running_count (for a runner's
    /// status: Lorehouse holds a new sandbox's room until it is listed). One whose VM is
    /// booting, or being checked by a request right now, is left out: holding its room a
    /// little longer is the safe side.
    pub async fn running_ids(&self) -> Vec<String> {
        let list: Vec<Arc<Sandbox>> = self.sandboxes.lock().await.values().cloned().collect();
        list.iter().filter(|sb| sb.running.try_lock().is_ok_and(|r| r.is_some())).map(|sb| sb.id.clone()).collect()
    }

    pub fn capacity(&self) -> usize {
        self.cfg.max_vms
    }

    /// Requests being served right now, across all sandboxes (shutdown waits on these).
    pub async fn in_flight(&self) -> usize {
        self.sandboxes.lock().await.values().map(|sb| sb.in_flight.load(Ordering::SeqCst)).sum()
    }

    /// Every sandbox that exists: those used since this process started, and the disks
    /// kept from earlier runs (not running; idle since their disk last changed).
    pub async fn list(&self) -> Vec<Listing> {
        let list: Vec<Arc<Sandbox>> = self.sandboxes.lock().await.values().cloned().collect();
        let now = now_secs();
        let mut out = Vec::new();
        for sb in &list {
            let up = sb.running.lock().await.as_ref().map(|r| r.granted.clone());
            out.push(Listing {
                id: sb.id.clone(),
                running: up.is_some(),
                idle_secs: now.saturating_sub(sb.last_used.load(Ordering::SeqCst)),
                in_flight: sb.in_flight.load(Ordering::SeqCst),
                resources: up.or_else(|| resources::read_stored(&sb.dir).ok().flatten()),
            });
        }
        if let Ok(mut dirs) = tokio::fs::read_dir(&self.cfg.state_dir).await {
            while let Ok(Some(entry)) = dirs.next_entry().await {
                let Some(id) = entry.file_name().to_str().map(String::from) else { continue };
                if !valid_id(&id) || list.iter().any(|sb| sb.id == id) {
                    continue;
                }
                let Ok(meta) = tokio::fs::metadata(entry.path().join("rootfs.ext4")).await else { continue };
                let changed = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(now);
                let resources = resources::read_stored(&entry.path()).ok().flatten();
                out.push(Listing { id, running: false, idle_secs: now.saturating_sub(changed), in_flight: 0, resources });
            }
        }
        out
    }
}

/// The jailer's command line, which execs Firecracker in place: both run with a clean
/// environment (child::command), so neither ever holds sandboxd's tokens.
fn vmm_command(jailer: &Path, args: &[String], console: std::fs::File) -> Result<Command, String> {
    let mut cmd = crate::child::command(jailer);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(console.try_clone().map_err(|e| e.to_string())?).stderr(console);
    Ok(cmd)
}

/// The VM's Firecracker config. Every path is inside its jail (jail.rs puts the files
/// there): Firecracker runs chrooted and can't see the host's. Its vCPUs and memory are
/// the sandbox's own (`granted`); the rates are the host's, the same for every VM.
fn vm_config(cfg: &Config, slot_index: usize, granted: &Granted) -> serde_json::Value {
    let slot = Slot { index: slot_index };
    let l = &cfg.limits;
    let mut drive = serde_json::json!({ "drive_id": "rootfs", "path_on_host": "/rootfs.ext4", "is_root_device": true, "is_read_only": false });
    if let Some(limiter) = rate_limiter(l.disk_mibps << 20, l.disk_iops) {
        drive["rate_limiter"] = limiter;
    }
    let mut nic = serde_json::json!({ "iface_id": "eth0", "host_dev_name": slot.tap(), "guest_mac": slot.guest_mac() });
    if let Some(limiter) = rate_limiter(l.net_rx_mibps << 20, 0) {
        nic["rx_rate_limiter"] = limiter;
    }
    if let Some(limiter) = rate_limiter(l.net_tx_mibps << 20, 0) {
        nic["tx_rate_limiter"] = limiter;
    }
    serde_json::json!({
        "boot-source": {
            "kernel_image_path": "/vmlinux",
            // ipv6.disable=1: the guest has no IPv6 at all, not even link-local. The host's
            // rules drop it anyway (net.rs); this keeps the guest from trying.
            "boot_args": format!("console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd ipv6.disable=1 root=/dev/vda rw {}", slot.kernel_ip_arg()),
        },
        "drives": [drive],
        "machine-config": { "vcpu_count": granted.vcpus, "mem_size_mib": granted.mem_mib },
        "network-interfaces": [nic],
        // Firecracker's vsock is a host-side Unix socket per VM, so CIDs never meet on the
        // host and the same one works for every VM (two ran at once in the acceptance run).
        // A distinct CID per slot costs nothing and keeps that true under vhost-vsock too.
        "vsock": { "guest_cid": 3 + slot_index, "uds_path": "/vsock.sock" },
    })
}

/// A Firecracker rate limiter: token buckets refilled every second with one second's
/// worth, plus a one-time burst of five seconds' worth for a boot or the start of a
/// clone. 0 leaves that bucket out (unlimited); both 0, no limiter.
fn rate_limiter(bytes_per_sec: u64, ops_per_sec: u64) -> Option<serde_json::Value> {
    let bucket = |per_sec: u64| serde_json::json!({ "size": per_sec, "one_time_burst": per_sec * 5, "refill_time": 1000 });
    let mut limiter = serde_json::json!({});
    if bytes_per_sec > 0 {
        limiter["bandwidth"] = bucket(bytes_per_sec);
    }
    if ops_per_sec > 0 {
        limiter["ops"] = bucket(ops_per_sec);
    }
    (bytes_per_sec > 0 || ops_per_sec > 0).then_some(limiter)
}

#[cfg(test)]
pub mod tests {
    use crate::config::{Config, Mode};
    use std::time::Duration;

    fn config(dir: &std::path::Path) -> Config {
        Config {
            mode: Mode::Serve { listen: "127.0.0.1:0".into(), token: "t".into() },
            state_dir: dir.join("state"),
            golden: "/var/lib/lorehouse-golden.ext4".into(),
            kernel: "/usr/local/lib/lorehouse/vmlinux".into(),
            uplink: "lo".into(),
            max_vms: 2,
            idle: Duration::from_secs(60),
            job_hold: Duration::from_secs(6 * 3600),
            vcpus: 2,
            mem_mib: 2048,
            maxima: crate::resources::Maxima::of_defaults(2, 2048, 8),
            github_url: "https://github.com".into(),
            mirrors: crate::publish::Policy::default(),
            jail: crate::config::JailConfig { jailer: "jailer".into(), firecracker: "firecracker".into(), uid_base: 1_900_000_000, git_uid_base: 1_900_100_000, git_mem_mib: 2048, mem_headroom_mib: 512 },
            limits: crate::config::Limits::default(),
            net_check: Duration::from_secs(10),
        }
    }

    /// What a sandbox created with no request gets under `config`.
    fn stock() -> crate::resources::Granted {
        crate::resources::Granted { vcpus: 2, mem_mib: 2048, disk_gib: Some(8), pids: 64, command_timeout_secs: 600 }
    }

    fn request(v: serde_json::Value) -> crate::resources::Request {
        crate::resources::parse(&v).unwrap()
    }

    /// A manager whose every boot stops at its first step (the network rules can't be
    /// loaded), before anything is made: an acquire that gets that far passed the policy.
    fn never_boots(dir: &std::path::Path, raise: bool, quota: crate::quota::Quota) -> std::sync::Arc<super::Manager> {
        manager(dir, raise, quota, false)
    }

    /// A manager whose boots get past the network rules and the sandbox's directory and
    /// record, and fail after: a new sandbox's at its disk (there is no golden to
    /// reflink), an existing one's at its jail (the disk can't be given to root's uid,
    /// or, as root, at its tap). No VM ever starts.
    fn boots_as_far_as_the_disk(dir: &std::path::Path) -> std::sync::Arc<super::Manager> {
        manager(dir, true, crate::quota::Quota::Off, true)
    }

    fn manager(dir: &std::path::Path, raise: bool, quota: crate::quota::Quota, rules_load: bool) -> std::sync::Arc<super::Manager> {
        use crate::net::fake::{Fake, Shared};
        let fake = std::sync::Arc::new(Fake::default());
        fake.fail.store(!rules_load, std::sync::atomic::Ordering::SeqCst);
        let mut cfg = config(dir);
        if raise {
            cfg.maxima = crate::resources::tests::roomy().maxima;
        }
        super::Manager::new(cfg, std::sync::Arc::new(crate::jail::tests::host()), quota, crate::net::Firewall::with("lo", 2, Box::new(Shared(fake))))
    }

    /// (status, code) of an acquire that didn't come up.
    async fn outcome(vms: &super::Manager, id: &str, req: Option<serde_json::Value>) -> (u16, Option<&'static str>) {
        let req = req.map(request);
        match vms.acquire_with(id, req.as_ref()).await {
            Ok(_) => panic!("{id} booted"),
            Err(e) => (e.status(), e.code()),
        }
    }

    /// A stopped sandbox on disk: its directory and disk, and the grant it was created with.
    fn on_disk(dir: &std::path::Path, id: &str, grant: Option<&crate::resources::Granted>) {
        let sb = dir.join("state").join(id);
        std::fs::create_dir_all(&sb).unwrap();
        std::fs::write(sb.join("rootfs.ext4"), b"disk").unwrap();
        if let Some(g) = grant {
            crate::resources::store(&sb, g).unwrap();
        }
    }

    const PASSED: (u16, Option<&'static str>) = (500, None); // the policy let it through to the boot

    #[test]
    fn the_defaults_and_maxima_follow_the_configuration_and_what_the_host_can_cap() {
        use crate::quota::Quota;
        let cfg = config(std::path::Path::new("/s"));
        let on = super::policy(&cfg, &Quota::Btrfs { bytes: 8 << 30 });
        assert_eq!(on.defaults, stock());
        assert_eq!(on.maxima, crate::resources::Maxima { vcpus: 2, mem_mib: 2048, disk_gib: 8, pids: 64, command_timeout_secs: 600 });
        // The quota off (set to 0, or a filesystem with none): disks are uncapped, and no
        // size can be granted, whatever the maximum was set to.
        let off = super::policy(&cfg, &Quota::Off);
        assert_eq!((off.defaults.disk_gib, off.maxima.disk_gib), (None, 0));
        assert_eq!(off.grant(&request(serde_json::json!({ "diskGib": 4 }))).unwrap_err().code, crate::resources::NO_DISK_QUOTA);
    }

    #[test]
    fn a_vm_is_sized_by_its_sandboxs_grant_not_the_hosts_default() {
        let cfg = config(std::path::Path::new("/s"));
        assert_eq!(super::vm_config(&cfg, 0, &stock())["machine-config"], serde_json::json!({ "vcpu_count": 2, "mem_size_mib": 2048 }));
        let big = crate::resources::Granted { vcpus: 4, mem_mib: 4096, ..stock() };
        let vm = super::vm_config(&cfg, 1, &big);
        assert_eq!(vm["machine-config"], serde_json::json!({ "vcpu_count": 4, "mem_size_mib": 4096 }));
        // Two VMs on one host, each with its own size; the rates stay the host's.
        assert_eq!(vm["drives"][0]["rate_limiter"], super::vm_config(&cfg, 0, &stock())["drives"][0]["rate_limiter"]);
    }

    #[tokio::test]
    async fn a_request_is_decided_before_anything_is_made() {
        use crate::quota::Quota;
        use crate::resources::{INVALID_STORED, NO_DISK_QUOTA, OVER_MAXIMUM};
        let dir = std::env::temp_dir().join(format!("sandboxd-resources-vm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vms = never_boots(&dir, true, Quota::Btrfs { bytes: 8 << 30 });
        let j = |v: serde_json::Value| Some(v);

        // A new sandbox, over a maximum: refused, and nothing is left: no directory, no
        // slot, no entry in the listing.
        assert_eq!(outcome(&vms, "new", j(serde_json::json!({ "memMib": 8193 }))).await, (422, Some(OVER_MAXIMUM)));
        assert_eq!(outcome(&vms, "new", j(serde_json::json!({ "commandTimeoutSecs": 3601 }))).await, (422, Some(OVER_MAXIMUM)));
        assert!(!dir.join("state/new").exists(), "a refused sandbox left a directory");
        assert_eq!(vms.running_count().await, 0);
        assert!(vms.list().await.is_empty(), "a refused sandbox is listed");
        // Within them, with none, or with an empty one: on to the boot.
        for req in [j(serde_json::json!({ "vcpus": 8, "memMib": 8192, "diskGib": 32, "pids": 256, "commandTimeoutSecs": 3600 })), j(serde_json::json!({})), None] {
            assert_eq!(outcome(&vms, "new", req).await, PASSED);
        }

        // A stopped sandbox created with a request. Another request, more or less, is
        // granted afresh (its VM isn't running, so nothing is resized under it); one over a
        // maximum is refused as for a new sandbox; none leaves it as it is.
        let grant = crate::resources::Granted { vcpus: 4, mem_mib: 4096, disk_gib: Some(8), pids: 64, command_timeout_secs: 1800 };
        on_disk(&dir, "kept", Some(&grant));
        for req in [j(serde_json::json!({ "vcpus": 2 })), j(serde_json::json!({ "vcpus": 8, "memMib": 8192 })), j(serde_json::json!({ "vcpus": 4, "memMib": 4096, "commandTimeoutSecs": 1800 })), None] {
            assert_eq!(outcome(&vms, "kept", req).await, PASSED);
        }
        assert_eq!(outcome(&vms, "kept", j(serde_json::json!({ "vcpus": 9 }))).await, (422, Some(OVER_MAXIMUM)));
        // A request that got no further than this changes no record.
        assert_eq!(crate::resources::read_stored(&dir.join("state/kept")), Ok(Some(grant.clone())));
        assert_eq!(vms.list().await.iter().find(|l| l.id == "kept").and_then(|l| l.resources.clone()), Some(grant.clone()));

        // One created with no request: any request this host can grant is fine too.
        on_disk(&dir, "plain", None);
        assert_eq!(outcome(&vms, "plain", j(serde_json::json!({ "memMib": 4096 }))).await, PASSED);
        // A disk size its directory can't hold it to (made before the quota, not a
        // subvolume): refused, though the number is the default's.
        assert_eq!(outcome(&vms, "plain", j(serde_json::json!({ "diskGib": 8 }))).await, (422, Some(NO_DISK_QUOTA)));

        // The maxima lowered since (an install that sets none): with no request to replace
        // it, a recorded grant over them isn't booted; a request within them is.
        let lowered = never_boots(&dir, false, Quota::Btrfs { bytes: 8 << 30 });
        assert_eq!(outcome(&lowered, "kept", None).await, (422, Some(OVER_MAXIMUM)));
        assert_eq!(outcome(&lowered, "kept", j(serde_json::json!({ "vcpus": 2 }))).await, PASSED);
        assert_eq!(outcome(&lowered, "plain", None).await, PASSED);
        // The quota off: a disk size is refused for a new sandbox and an existing one.
        let uncapped = never_boots(&dir, true, Quota::Off);
        assert_eq!(outcome(&uncapped, "new2", j(serde_json::json!({ "diskGib": 4 }))).await, (422, Some(NO_DISK_QUOTA)));
        assert_eq!(outcome(&uncapped, "plain", j(serde_json::json!({ "diskGib": 8 }))).await, (422, Some(NO_DISK_QUOTA)));
        assert_eq!(outcome(&uncapped, "new2", j(serde_json::json!({ "memMib": 4096 }))).await, PASSED);
        // A record no request could have been granted (vcpus 0, 1 MiB, no pids, no time):
        // read, and refused with its code.
        std::fs::write(dir.join("state/kept/resources.json"), r#"{"vcpus":0,"memMib":1,"diskGib":null,"pids":0,"commandTimeoutSecs":0}"#).unwrap();
        assert_eq!(outcome(&vms, "kept", None).await, (500, Some(INVALID_STORED)));
        // A record that can't be read at all: not booted on a guess.
        std::fs::write(dir.join("state/kept/resources.json"), "{").unwrap();
        assert_eq!(outcome(&vms, "kept", None).await.0, 500);
        let Err(e) = vms.acquire_with("kept", None).await else { panic!("booted") };
        assert!(e.message().contains("resources.json"), "{}", e.message());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_request_for_a_stopped_sandbox_is_recorded_before_its_disk_is_made_or_its_vm_started() {
        use crate::resources::{read_stored, Granted};
        let dir = std::env::temp_dir().join(format!("sandboxd-resources-boot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let vms = boots_as_far_as_the_disk(&dir);
        let failed = |r: Result<(super::Use, std::path::PathBuf, Granted), super::AcquireError>| match r {
            Ok(_) => panic!("a VM booted in a unit test"),
            Err(e) => (e.status(), e.code(), e.message().to_string()),
        };

        // A new sandbox created with a request: the record is down before the disk is made
        // (here the disk can't be: there is no golden), whole.
        let asked = request(serde_json::json!({ "vcpus": 4, "memMib": 4096, "commandTimeoutSecs": 1800 }));
        let (status, code, msg) = failed(vms.acquire_with("fresh", Some(&asked)).await);
        assert_eq!((status, code), (500, None), "{msg}");
        assert!(msg.contains("reflink golden") || msg.starts_with("cp:"), "the boot didn't get as far as the disk: {msg}");
        let granted = Granted { vcpus: 4, mem_mib: 4096, disk_gib: None, pids: 64, command_timeout_secs: 1800 };
        assert_eq!(read_stored(&dir.join("state/fresh")), Ok(Some(granted.clone())));
        // Created again with no request: it follows the host's defaults, so the record a
        // creation that failed left is removed, not inherited.
        failed(vms.acquire_with("fresh", None).await);
        assert_eq!(read_stored(&dir.join("state/fresh")), Ok(None));

        // A stopped sandbox with a disk, created with `granted`. No request, or the same
        // one again: its record stays as it is.
        on_disk(&dir, "old", Some(&granted));
        for req in [None, Some(&asked)] {
            failed(vms.acquire_with("old", req).await);
            assert_eq!(read_stored(&dir.join("state/old")), Ok(Some(granted.clone())));
        }
        // Another request: granted afresh (what it names, the defaults for the rest), and
        // recorded as the sandbox's resources before the VM is started with them.
        let more = request(serde_json::json!({ "memMib": 8192, "pids": 128 }));
        failed(vms.acquire_with("old", Some(&more)).await);
        let now = Granted { vcpus: 2, mem_mib: 8192, disk_gib: None, pids: 128, command_timeout_secs: 600 };
        assert_eq!(read_stored(&dir.join("state/old")), Ok(Some(now.clone())));
        assert_eq!(vms.list().await.iter().find(|l| l.id == "old").and_then(|l| l.resources.clone()), Some(now));
        // One created with no request (no record) gets one with its first request.
        on_disk(&dir, "plain", None);
        failed(vms.acquire_with("plain", Some(&asked)).await);
        assert_eq!(read_stored(&dir.join("state/plain")), Ok(Some(granted.clone())));
        // No VM, no slot and no request in flight is left by any of it.
        assert_eq!((vms.running_count().await, vms.in_flight().await), (0, 0));

        // Two first requests for one id at once, each asking for something else: one after
        // the other under the sandbox's lock, never interleaved. The record is one
        // request's grant, whole, and nothing is left held.
        let (a, b) = (request(serde_json::json!({ "vcpus": 4 })), request(serde_json::json!({ "memMib": 8192 })));
        let (ra, rb) = tokio::join!(vms.acquire_with("twice", Some(&a)), vms.acquire_with("twice", Some(&b)));
        failed(ra);
        failed(rb);
        let one_of = [Granted { vcpus: 4, mem_mib: 2048, disk_gib: None, pids: 64, command_timeout_secs: 600 }, Granted { vcpus: 2, mem_mib: 8192, disk_gib: None, pids: 64, command_timeout_secs: 600 }];
        let recorded = read_stored(&dir.join("state/twice")).unwrap().expect("no record");
        assert!(one_of.contains(&recorded), "{recorded:?}");
        assert_eq!((vms.running_count().await, vms.in_flight().await), (0, 0));
        assert!(!vms.list().await.iter().any(|l| l.id == "twice"), "a sandbox with no disk is listed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A manager (raised maxima, no disk quota) with one sandbox, `up`, whose VM "runs": a
    /// stand-in process in slot 0, booted with 4 vCPUs, 4096 MiB and a 30-minute command
    /// timeout. Its guestd socket doesn't exist, so a call that gets as far as the VM
    /// fails there (a 502), which tells it from one refused before (a 409).
    pub async fn one_running(dir: &std::path::Path) -> (std::sync::Arc<super::Manager>, crate::resources::Granted) {
        let vms = never_boots(dir, true, crate::quota::Quota::Off);
        let grant = crate::resources::Granted { vcpus: 4, mem_mib: 4096, disk_gib: None, pids: 64, command_timeout_secs: 1800 };
        on_disk(dir, "up", Some(&grant));
        let sb = vms.get("up").await;
        let vmm = super::Vmm::spawn(tokio::process::Command::new("sleep").arg("60")).unwrap();
        vms.slots.lock().await[0] = true;
        *sb.running.lock().await = Some(vms.track(vmm, 0, grant.clone()));
        (vms, grant)
    }

    #[tokio::test]
    async fn an_explicit_request_for_the_defaults_regrants_a_stopped_sandbox_whose_record_is_over_a_lowered_maximum() {
        use crate::resources::{read_stored, Granted, OVER_MAXIMUM};
        let dir = std::env::temp_dir().join(format!("sandboxd-resources-regrant-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // An install that sets no maximum now (2 vCPUs, 2048 MiB); the sandbox's record is
        // from when it allowed more, and its profile has since stopped asking.
        let vms = manager(&dir, false, crate::quota::Quota::Off, true);
        on_disk(&dir, "big", Some(&Granted { vcpus: 4, mem_mib: 4096, disk_gib: None, pids: 64, command_timeout_secs: 600 }));
        // Asked for nothing, it keeps its record, and the record is over the maximum:
        // refused every time, saying what to send.
        for _ in 0..2 {
            let Err(e) = vms.acquire_with("big", None).await else { panic!("booted over the maximum") };
            assert_eq!((e.status(), e.code()), (422, Some(OVER_MAXIMUM)));
            assert!(e.message().contains(r#"name them ({ "vcpus": 2, "memMib": 2048, "pids": 64, "commandTimeoutSecs": 600 })"#), "{}", e.message());
        }
        // The defaults, named: granted afresh and recorded, before the boot (which fails
        // later here, for want of a jail).
        let defaults = request(serde_json::json!({ "vcpus": 2, "memMib": 2048, "pids": 64, "commandTimeoutSecs": 600 }));
        let Err(e) = vms.acquire_with("big", Some(&defaults)).await else { panic!("a VM booted in a unit test") };
        assert_eq!(e.code(), None, "{}", e.message());
        assert_eq!(read_stored(&dir.join("state/big")), Ok(Some(Granted { vcpus: 2, mem_mib: 2048, disk_gib: None, pids: 64, command_timeout_secs: 600 })));
        // From then on a call that asks for nothing is no longer refused for the record.
        let Err(e) = vms.acquire_with("big", None).await else { panic!("a VM booted in a unit test") };
        assert_eq!(e.code(), None, "{}", e.message());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_call_that_only_watches_or_stops_what_a_running_vm_has_is_served_whatever_it_asks() {
        let dir = std::env::temp_dir().join(format!("sandboxd-resources-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let (vms, grant) = one_running(&dir).await;
        // The profile's request changed at a deploy; a job started before it still runs.
        let changed = request(serde_json::json!({ "vcpus": 2, "commandTimeoutSecs": 600 }));
        // A status, a cancel or a file read: the VM as it is, with what it has.
        let (_use, uds, has) = vms.acquire_for("up", Some(&changed), true).await.unwrap_or_else(|e| panic!("{}", e.message()));
        assert_eq!(has, grant);
        assert!(uds.ends_with("jail/firecracker/lorehouse-0/root/vsock.sock"));
        // A call that starts work or writes: refused, saying what can still be done.
        let Err(e) = vms.acquire_for("up", Some(&changed), false).await else { panic!("served") };
        assert_eq!((e.status(), e.code()), (409, Some(crate::resources::MISMATCH)));
        assert!(e.message().contains("can still be watched and cancelled, and files read"), "{}", e.message());
        // Neither changed the record or the VM.
        assert_eq!(crate::resources::read_stored(&dir.join("state/up")), Ok(Some(grant)));
        assert_eq!(vms.running_count().await, 1);
        // A stopped sandbox: a watching call is like any other; one over a maximum is refused.
        on_disk(&dir, "stopped", None);
        let over = request(serde_json::json!({ "vcpus": 9 }));
        let Err(e) = vms.acquire_for("stopped", Some(&over), true).await else { panic!("booted") };
        assert_eq!((e.status(), e.code()), (422, Some(crate::resources::OVER_MAXIMUM)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_running_sandbox_keeps_its_resources_and_a_refused_request_is_not_activity() {
        use std::sync::atomic::Ordering;
        let dir = std::env::temp_dir().join(format!("sandboxd-resources-up-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A running VMM (a stand-in), booted with 4 vCPUs and a 30-minute command timeout,
        // last used a while ago: idle for longer than SANDBOXD_IDLE_SECS (60 s here).
        let (vms, grant) = one_running(&dir).await;
        let sb = vms.get("up").await;
        let long_ago = super::now_secs() - 1000;
        sb.last_used.store(long_ago, Ordering::SeqCst);

        // A request for other resources: refused, saying it runs with its earlier ones and
        // when they can change. The VM is left as it is, and the call is not a use of it:
        // it is as idle as it was, so the idle stop that lets the request through still comes.
        for other in [serde_json::json!({ "vcpus": 2 }), serde_json::json!({ "vcpus": 4, "commandTimeoutSecs": 1800, "memMib": 8192 }), serde_json::json!({ "vcpus": 4 })] {
            let other = request(other);
            let Err(e) = vms.acquire_with("up", Some(&other)).await else { panic!("resized?") };
            assert_eq!((e.status(), e.code()), (409, Some(crate::resources::MISMATCH)));
            assert_eq!(e.body()["idleSecs"], 60);
            assert!(e.message().contains("is running with its earlier resources") && e.message().contains("stops after 60 s without a request"), "{}", e.message());
        }
        assert_eq!(sb.last_used.load(Ordering::SeqCst), long_ago, "a refused request counted as activity");
        assert_eq!((vms.running_count().await, vms.in_flight().await), (1, 0));
        assert_eq!(crate::resources::read_stored(&dir.join("state/up")), Ok(Some(grant.clone())), "a refused request changed the record");
        let idle = super::now_secs() - sb.last_used.load(Ordering::SeqCst);
        assert!(idle >= vms.cfg.idle.as_secs(), "the reaper would not stop it");

        // No request, or the same one again: its socket, and what it has (the caller caps
        // each command's timeout with it). That is a use.
        for req in [None, Some(request(serde_json::json!({ "vcpus": 4, "memMib": 4096, "commandTimeoutSecs": 1800 })))] {
            sb.last_used.store(long_ago, Ordering::SeqCst);
            let (used, uds, has) = vms.acquire_with("up", req.as_ref()).await.unwrap_or_else(|e| panic!("{}", e.message()));
            assert_eq!(has, grant);
            assert!(uds.ends_with("jail/firecracker/lorehouse-0/root/vsock.sock"), "{}", uds.display());
            drop(used);
            assert!(sb.last_used.load(Ordering::SeqCst) > long_ago, "a served request is activity");
        }
        assert_eq!(vms.list().await[0].resources, Some(grant));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_job_calls_guestd_serves_pass() {
        use super::job_call;
        assert!(job_call("POST", "/jobs").is_some());
        assert!(job_call("GET", "/jobs/bench-1").is_some());
        assert!(job_call("GET", "/jobs/bench-1?waitMs=60000&tailBytes=8192").is_some());
        assert!(job_call("POST", "/jobs/bench-1/cancel").is_some());
        for (m, p) in [
            ("GET", "/jobs"), // the list is for sandboxd's own idle check
            ("POST", "/jobs?x=1"),
            ("DELETE", "/jobs/a"),
            ("GET", "/jobs/../exec"),
            ("GET", "/jobs/.hidden"),
            ("GET", "/jobs/a/b"),
            ("GET", "/jobs/a?waitMs=-1"),
            ("GET", "/jobs/a?waitMs=1&path=/etc/passwd"),
            ("GET", "/jobs/a?waitMs=9999999999"),
            ("POST", "/jobs/a/cancel?now=1"),
            ("POST", "/jobs/a/kill"),
            ("GET", &format!("/jobs/{}", "a".repeat(65))),
        ] {
            assert!(job_call(m, p).is_none(), "{m} {p}");
        }
    }

    #[test]
    fn a_refused_job_call_says_whether_the_id_or_the_query_was_wrong() {
        use super::job_call_refusal;
        assert!(job_call_refusal("/jobs/.hidden").starts_with("bad job id"));
        assert!(job_call_refusal(&format!("/jobs/{}?waitMs=1", "a".repeat(65))).starts_with("bad job id"));
        assert!(job_call_refusal("/jobs/bench-1?tailBytes=abc").starts_with("bad status query"));
        assert!(job_call_refusal("/jobs/bench-1?waitMs=1&path=/etc/passwd").starts_with("bad status query"));
        assert!(job_call_refusal("/jobs/bench-1/cancel?now=1").starts_with("not a job call"));
        assert!(job_call_refusal("/jobs/bench-1/kill").starts_with("not a job call"));
    }

    #[test]
    fn a_running_job_holds_an_idle_vm_up_until_the_hold_runs_out() {
        use super::held_by_jobs;
        let hold = Duration::from_secs(6 * 3600);
        assert!(held_by_jobs(1, 900, hold), "a job running, the VM idle past SANDBOXD_IDLE_SECS: kept");
        assert!(!held_by_jobs(0, 900, hold), "no job: stopped as before");
        assert!(!held_by_jobs(3, 6 * 3600, hold), "no request for the whole hold: stopped, jobs and all");
        assert!(!held_by_jobs(1, 900, Duration::ZERO), "SANDBOXD_JOB_HOLD_SECS=0: jobs don't hold a VM");
    }

    #[test]
    fn the_vm_sees_only_paths_inside_its_jail() {
        let vm = super::vm_config(&config(std::path::Path::new("/var/lib/lorehouse-sandboxes")), 1, &stock());
        assert_eq!(vm["boot-source"]["kernel_image_path"], "/vmlinux");
        assert_eq!(vm["drives"][0]["path_on_host"], "/rootfs.ext4");
        assert_eq!(vm["vsock"]["uds_path"], "/vsock.sock");
        assert_eq!(vm["network-interfaces"][0]["host_dev_name"], "lhtap1");
        // No IPv6 in the guest: not even a link-local address to reach the host's tap with.
        let boot_args = vm["boot-source"]["boot_args"].as_str().unwrap();
        assert!(boot_args.split_whitespace().any(|a| a == "ipv6.disable=1"), "{boot_args}");
        // No host path leaks in: not the state directory, the golden or the kernel's.
        let text = vm.to_string();
        for host_path in ["/var/lib", "/usr/local"] {
            assert!(!text.contains(host_path), "{host_path} in {text}");
        }
    }

    #[test]
    fn the_vmm_never_sees_sandboxds_tokens() {
        // sandboxd's environment holds them (EnvironmentFile=); the jailer, and the
        // Firecracker it execs, must not. A name no other test touches stands in for them.
        std::env::set_var("SANDBOXD_VMM_ENV_PROBE", "secret");
        let dir = std::env::temp_dir().join(format!("sandboxd-vmm-env-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let console = dir.join("console.log");
        // `env` in the jailer's place, no arguments: it prints what the jailer would get.
        let cmd = super::vmm_command(std::path::Path::new("env"), &[], std::fs::File::create(&console).unwrap()).unwrap();
        let _ = crate::child::names_seen_by_a_child(cmd);
        let printed = std::fs::read_to_string(&console).unwrap();
        let names: Vec<&str> = printed.lines().filter_map(|l| l.split_once('=').map(|(k, _)| k)).collect();
        assert!(!names.is_empty(), "env printed nothing");
        assert!(!names.iter().any(|n| n.starts_with("SANDBOXD_")), "{names:?}");
        assert!(names.iter().all(|n| crate::child::ALLOWED.contains(n)), "{names:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn no_vm_boots_while_the_network_rules_are_gone() {
        use crate::net::fake::{Fake, Shared};
        let dir = std::env::temp_dir().join(format!("sandboxd-fw-boot-{}", std::process::id()));
        let fake = std::sync::Arc::new(Fake::default());
        // The table was never loaded and can't be: every boot is refused before anything
        // (disk, jail, tap, VMM) is made, and main's watch is woken to stop the rest.
        fake.fail.store(true, std::sync::atomic::Ordering::SeqCst);
        let fw = crate::net::Firewall::with("lo", 2, Box::new(Shared(fake.clone())));
        let vms = super::Manager::new(config(&dir), std::sync::Arc::new(crate::jail::tests::host()), crate::quota::Quota::Off, fw.clone());
        let Err((status, msg)) = vms.acquire("t1").await else { panic!("booted without rules") };
        assert_eq!(status, 500);
        assert!(msg.contains("network rules"), "{msg}");
        assert!(!dir.join("state/t1").exists(), "a disk was made");
        assert_eq!(vms.running_count().await, 0, "the slot was given back");
        tokio::time::timeout(Duration::from_secs(1), fw.alarm.notified()).await.expect("the watch was woken");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_vm_whose_tap_isnt_confirmed_down_is_killed_the_others_stopped_gracefully() {
        let dir = std::env::temp_dir().join(format!("sandboxd-fail-closed-{}", std::process::id()));
        let vms = super::Manager::new(config(&dir), std::sync::Arc::new(crate::jail::tests::host()), crate::quota::Quota::Off, crate::net::Firewall::new("lo", 2));
        // Two running VMMs (stand-ins that ignore everything but a kill), slots 0 and 1.
        let mut watch = Vec::new();
        for (id, slot) in [("a", 0), ("b", 1)] {
            let sb = vms.get(id).await;
            let vmm = super::Vmm::spawn(tokio::process::Command::new("sleep").arg("60")).unwrap();
            watch.push(super::Pidfd::open(vmm.child.id().unwrap()).unwrap());
            vms.slots.lock().await[slot] = true;
            *sb.running.lock().await = Some(vms.track(vmm, slot, stock()));
        }
        // The fake: lhtap0 went down, lhtap1 couldn't be confirmed.
        let taps = crate::net::all_down(Ok(vec!["lhtap0".into(), "lhtap1".into()]), |tap: String| async move {
            if tap == "lhtap1" {
                Err("ip: no answer within 10 s".to_string())
            } else {
                Ok(())
            }
        })
        .await;
        let run = { let vms = vms.clone(); tokio::spawn(async move { vms.fail_closed(&taps).await }) };
        // Slot 1 is killed at once; slot 0 is on the graceful path (asked to sync, then
        // given 5 s to exit), so it is still there a second later.
        assert!(watch[1].wait(Duration::from_secs(1)).await, "the VM on an unconfirmed tap wasn't killed at once");
        assert!(!watch[0].exited(), "the VM on a confirmed tap didn't get the graceful stop");
        assert_eq!(run.await.unwrap(), vec![1]);
        assert!(watch[0].exited(), "the graceful stop still ends in a stopped VM");
        assert_eq!(vms.running_count().await, 0);
        assert!(vms.vmms.lock().unwrap().is_empty());

        // A VM still booting (spawned, not yet answering: its sandbox's lock is held by the
        // boot, and it isn't Running yet) is reached too, and killed. boot() can't run here
        // (a jail and a tap need root), so its spawn is pinned to spawn_tracked in the
        // source, and spawn_tracked is exercised below.
        let src = include_str!("vm.rs");
        let boot = &src[src.find("    async fn boot(").unwrap()..];
        let boot = &boot[..boot.find("\n    }\n").unwrap()];
        assert!(boot.contains("self.spawn_tracked(") && !boot.contains(&["Vmm::", "spawn("].concat()), "boot() spawns its VMM untracked");
        let booting = vms.spawn_tracked(tokio::process::Command::new("sleep").arg("60"), 1).unwrap();
        let held = vms.get("c").await;
        let lock = held.running.lock().await;
        let none_down = crate::net::all_down(Err("ip: no answer within 10 s".into()), |_: String| async { Ok(()) }).await;
        let run = { let vms = vms.clone(); tokio::spawn(async move { vms.fail_closed(&none_down).await }) };
        // Killed while the boot still holds the lock...
        assert!(booting.pidfd.wait(Duration::from_secs(1)).await, "the booting VMM wasn't killed");
        // ...and the rest (stop_all) goes on once the boot lets go.
        drop(lock);
        assert_eq!(tokio::time::timeout(Duration::from_secs(5), run).await.expect("fail_closed hung").unwrap(), vec![1]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_vm_has_its_network_and_disk_rates_capped() {
        let mut cfg = config(std::path::Path::new("/s"));
        let vm = super::vm_config(&cfg, 0, &stock());
        let mib = 1u64 << 20;
        let bucket = |per_sec: u64| serde_json::json!({ "size": per_sec, "one_time_burst": per_sec * 5, "refill_time": 1000 });
        assert_eq!(vm["network-interfaces"][0]["rx_rate_limiter"], serde_json::json!({ "bandwidth": bucket(50 * mib) }));
        assert_eq!(vm["network-interfaces"][0]["tx_rate_limiter"], serde_json::json!({ "bandwidth": bucket(10 * mib) }));
        assert_eq!(vm["drives"][0]["rate_limiter"], serde_json::json!({ "bandwidth": bucket(200 * mib), "ops": bucket(5000) }));
        // 0 is unlimited: the limiter, or its bucket, is left out.
        cfg.limits.net_rx_mibps = 0;
        cfg.limits.disk_iops = 0;
        let vm = super::vm_config(&cfg, 0, &stock());
        assert!(vm["network-interfaces"][0].get("rx_rate_limiter").is_none());
        assert_eq!(vm["drives"][0]["rate_limiter"], serde_json::json!({ "bandwidth": bucket(200 * mib) }));
    }

    #[test]
    fn only_sandbox_directories_have_their_jails_released() {
        let dir = std::env::temp_dir().join(format!("sandboxd-sweep-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mirror = dir.join(".mirrors/jail/widgets.git");
        std::fs::create_dir_all(&mirror).unwrap();
        std::fs::create_dir_all(dir.join("slack_C1_1.2/jail/firecracker/lorehouse-0/root")).unwrap();
        assert_eq!(super::release_leftover_jails(&dir), 1);
        assert!(mirror.exists(), "a mirror owner named jail was removed");
        assert!(!dir.join("slack_C1_1.2/jail").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_vmm_is_seen_and_signalled_through_its_pidfd_only() {
        use super::Vmm;
        let grace = Duration::from_millis(500);
        let mut quick = Vmm::spawn(&mut tokio::process::Command::new("true")).unwrap();
        assert!(super::exited_or_killed(&mut quick, grace).await);
        let mut hung = Vmm::spawn(tokio::process::Command::new("sleep").arg("60")).unwrap();
        assert!(!hung.exited());
        assert!(super::exited_or_killed(&mut hung, grace).await, "a hung VMM is killed");
        // Reaped behind tokio's back, so its pid is free for anyone. Its exit is still seen,
        // and the kill after it (and the one when it's dropped) reaches nothing: ESRCH.
        let mut lost = Vmm::spawn(tokio::process::Command::new("sleep").arg("60")).unwrap();
        let pid = lost.child.id().unwrap() as libc::pid_t;
        // SAFETY: plain syscalls on our own child.
        unsafe {
            libc::kill(pid, libc::SIGKILL);
            libc::waitpid(pid, std::ptr::null_mut(), 0);
        }
        assert!(super::exited_or_killed(&mut lost, grace).await, "its exit is seen through the pidfd");
        assert_eq!(lost.pidfd.kill().unwrap_err().raw_os_error(), Some(libc::ESRCH));
        // Dropped while running: killed, as kill_on_drop did, but through the pidfd.
        let alive = Vmm::spawn(tokio::process::Command::new("sleep").arg("60")).unwrap();
        let watch = super::Pidfd::open(alive.child.id().unwrap()).unwrap();
        drop(alive);
        assert!(watch.wait(Duration::from_secs(2)).await, "a dropped VMM is killed");
        // Outside its tests, vm.rs signals no process by number: no kill_on_drop(true)
        // (tokio's kill by pid), no kill(1), no kill(2).
        let src = include_str!("vm.rs");
        let code = &src[..src.find(&["#[cfg(", "test)]"].concat()).unwrap()];
        for by_number in [["kill_on_drop(", "true)"].concat(), ["Command::new(\"kill", "\")"].concat(), ["libc::", "kill("].concat()] {
            assert!(!code.contains(&by_number), "{by_number}");
        }
    }
}
