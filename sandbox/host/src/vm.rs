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

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') && !id.starts_with('.')
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

struct Running {
    vmm: Vmm,
    slot: usize,
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
pub struct Use(Arc<Sandbox>);
impl Drop for Use {
    fn drop(&mut self) {
        self.0.last_used.store(now_secs(), Ordering::SeqCst);
        self.0.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct Manager {
    cfg: Config,
    host: Arc<Host>,
    /// The nftables table, checked before every boot.
    fw: Arc<net::Firewall>,
    quota: Quota,
    sandboxes: Mutex<HashMap<String, Arc<Sandbox>>>,
    slots: Mutex<Vec<bool>>, // true = taken
    /// Each running VMM's pidfd by slot, from the moment it runs until its slot is
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
}

impl Manager {
    pub fn new(cfg: Config, host: Arc<Host>, quota: Quota, fw: Arc<net::Firewall>) -> Arc<Manager> {
        let slots = vec![false; cfg.max_vms];
        Arc::new(Manager { cfg, host, fw, quota, sandboxes: Mutex::new(HashMap::new()), slots: Mutex::new(slots), vmms: std::sync::Mutex::new(HashMap::new()) })
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

    /// Boot the sandbox if it isn't running, and mark it in use. Errors are client-facing.
    pub async fn acquire(&self, id: &str) -> Result<(Use, PathBuf), (u16, String)> {
        let sb = self.get(id).await;
        sb.in_flight.fetch_add(1, Ordering::SeqCst);
        let guard = Use(sb.clone());
        let mut running = sb.running.lock().await;
        let alive = match running.as_mut() {
            // An error reading its state is not proof it's gone: treat it as alive.
            Some(r) => !r.vmm.exited(),
            None => false,
        };
        if !alive {
            if let Some(dead) = running.take() {
                self.release(&sb, dead.slot).await;
            }
            let Some(slot) = self.take_slot().await else {
                self.forget_if_never_created(&sb).await;
                return Err((503, format!("all {} sandboxes are busy; try again later", self.cfg.max_vms)));
            };
            match self.boot(&sb, slot).await {
                Ok(vmm) => *running = Some(self.track(vmm, slot)),
                Err(BootError { msg, unstopped: Some(vmm) }) => {
                    // A VMM whose exit couldn't be confirmed keeps its slot, jail and disk
                    // (as in stop_locked); the next request finds it and tries again.
                    eprintln!("sandboxd: {}: its VMM's exit couldn't be confirmed after a failed boot; it keeps slot {slot} until it is", sb.id);
                    *running = Some(self.track(*vmm, slot));
                    return Err((500, msg));
                }
                Err(BootError { msg, unstopped: None }) => {
                    self.release(&sb, slot).await;
                    self.forget_if_never_created(&sb).await;
                    return Err((500, msg));
                }
            }
        }
        sb.last_used.store(now_secs(), Ordering::SeqCst);
        let slot = running.as_ref().map(|r| r.slot).unwrap_or_default();
        Ok((guard, self.jail(&sb, slot).uds()))
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

    async fn boot(&self, sb: &Sandbox, slot_index: usize) -> Result<Vmm, BootError> {
        let t0 = Instant::now();
        let slot = Slot { index: slot_index };
        // No VM boots unfiltered: the table is checked (and loaded again if it was flushed)
        // first. If it can't be, the running VMs are stopped too (main's watch, woken here).
        if let Err(e) = self.fw.ensure().await {
            self.fw.alarm.notify_one();
            return Err(e.into());
        }
        quota::prepare_dir(&self.quota, &sb.dir).await?;
        let rootfs = sb.rootfs();
        if !rootfs.exists() {
            let out = crate::child::command("cp").arg("--reflink=always").arg(&self.cfg.golden).arg(&rootfs).output().await.map_err(|e| format!("cp: {e}"))?;
            if !out.status.success() {
                return Err(format!("reflink golden: {}", String::from_utf8_lossy(&out.stderr).trim()).into());
            }
        }
        // The jail, rebuilt from nothing (a few ms: the disk is a hard link, the kernel a
        // copy of a few tens of MB), off the async workers.
        let (host, dir, kernel, vm) = (self.host.clone(), sb.dir.clone(), self.cfg.kernel.clone(), vm_config(&self.cfg, slot_index).to_string());
        tokio::task::spawn_blocking(move || Jail::new(&host, &dir, slot_index).build(&dir.join("rootfs.ext4"), &kernel, vm.as_bytes()))
            .await
            .map_err(|e| format!("jail: {e}"))??;
        let jail = self.jail(sb, slot_index);
        net::tap_up(&slot, jail.uid()).await?;
        let console = std::fs::File::create(sb.dir.join("console.log")).map_err(|e| format!("console.log: {e}"))?;
        let mut vmm = Vmm::spawn(&mut vmm_command(&self.host.jailer, &jail.args(self.cfg.vcpus, self.cfg.mem_mib), console)?)?;
        let uds = jail.uds();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if vmm.exited() {
                return Err(format!("the jailer or firecracker exited during boot; see {}/console.log", sb.dir.display()).into());
            }
            // Each probe is bounded, so a guest that accepts but never answers can't hold
            // the slot past the deadline.
            if uds.exists() && tokio::time::timeout(Duration::from_secs(2), vsock::healthy(&uds)).await.unwrap_or(false) {
                eprintln!("sandboxd: {} booted in slot {} in {} ms", sb.id, slot_index, t0.elapsed().as_millis());
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

    /// Stop every running VM that has been idle longer than the configured idle time.
    pub async fn reap(&self) {
        let list: Vec<Arc<Sandbox>> = self.sandboxes.lock().await.values().cloned().collect();
        let now = now_secs();
        for sb in list {
            // Check idleness while holding the lock every request takes to reach the VM: a
            // request that arrives after this point waits, then boots the VM again.
            let mut running = sb.running.lock().await;
            let idle = now.saturating_sub(sb.last_used.load(Ordering::SeqCst));
            if running.is_some() && sb.in_flight.load(Ordering::SeqCst) == 0 && idle >= self.cfg.idle.as_secs() {
                let _ = self.stop_locked(&sb, &mut running).await;
            }
        }
    }

    /// A VMM now running in `slot`, its pidfd recorded for fail_closed.
    fn track(&self, vmm: Vmm, slot: usize) -> Running {
        self.vmms.lock().unwrap_or_else(|e| e.into_inner()).insert(slot, vmm.pidfd.clone());
        Running { vmm, slot }
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
            out.push(Listing {
                id: sb.id.clone(),
                running: sb.running.lock().await.is_some(),
                idle_secs: now.saturating_sub(sb.last_used.load(Ordering::SeqCst)),
                in_flight: sb.in_flight.load(Ordering::SeqCst),
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
                out.push(Listing { id, running: false, idle_secs: now.saturating_sub(changed), in_flight: 0 });
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
/// there): Firecracker runs chrooted and can't see the host's.
fn vm_config(cfg: &Config, slot_index: usize) -> serde_json::Value {
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
        "machine-config": { "vcpu_count": cfg.vcpus, "mem_size_mib": cfg.mem_mib },
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
mod tests {
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
            vcpus: 2,
            mem_mib: 2048,
            github_url: "https://github.com".into(),
            mirrors: crate::publish::Policy::default(),
            jail: crate::config::JailConfig { jailer: "jailer".into(), firecracker: "firecracker".into(), uid_base: 1_900_000_000, mem_headroom_mib: 512 },
            limits: crate::config::Limits::default(),
            net_check: Duration::from_secs(10),
        }
    }

    #[test]
    fn the_vm_sees_only_paths_inside_its_jail() {
        let vm = super::vm_config(&config(std::path::Path::new("/var/lib/lorehouse-sandboxes")), 1);
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
            *sb.running.lock().await = Some(vms.track(vmm, slot));
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
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_vm_has_its_network_and_disk_rates_capped() {
        let mut cfg = config(std::path::Path::new("/s"));
        let vm = super::vm_config(&cfg, 0);
        let mib = 1u64 << 20;
        let bucket = |per_sec: u64| serde_json::json!({ "size": per_sec, "one_time_burst": per_sec * 5, "refill_time": 1000 });
        assert_eq!(vm["network-interfaces"][0]["rx_rate_limiter"], serde_json::json!({ "bandwidth": bucket(50 * mib) }));
        assert_eq!(vm["network-interfaces"][0]["tx_rate_limiter"], serde_json::json!({ "bandwidth": bucket(10 * mib) }));
        assert_eq!(vm["drives"][0]["rate_limiter"], serde_json::json!({ "bandwidth": bucket(200 * mib), "ops": bucket(5000) }));
        // 0 is unlimited: the limiter, or its bucket, is left out.
        cfg.limits.net_rx_mibps = 0;
        cfg.limits.disk_iops = 0;
        let vm = super::vm_config(&cfg, 0);
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
