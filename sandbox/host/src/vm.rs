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
use crate::vsock;
use bytes::Bytes;
use hyper::Method;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Firecracker processes a previous run left behind (a crash or SIGKILL gives
/// kill_on_drop no chance). Under sandboxd.service this is a backstop: when sandboxd dies,
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
        if !args.first().is_some_and(|a| a.ends_with("firecracker")) {
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
        eprintln!("sandboxd: stopping a VMM left by a previous run (pid {pid}; {} socket(s) that may be its)", candidates.len());
        // Several sandboxes can hold a leftover jail for the same slot; only the live VM's
        // socket answers, so each is tried until one does.
        for uds in candidates {
            let body = Bytes::from_static(br#"{"command":"sync && (sleep 0.2; reboot -f) &","timeoutMs":10000}"#);
            if let Ok(Ok(_)) = tokio::time::timeout(Duration::from_secs(10), vsock::request(&uds, Method::POST, "/exec", body)).await {
                break;
            }
        }
        for _ in 0..50 {
            if tokio::fs::metadata(format!("/proc/{pid}")).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if tokio::fs::metadata(format!("/proc/{pid}")).await.is_ok() {
            let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status().await;
            for _ in 0..20 {
                if tokio::fs::metadata(format!("/proc/{pid}")).await.is_err() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
    // Their cgroups, once empty. The jails themselves are rebuilt at each sandbox's next boot.
    let parent = Path::new("/sys/fs/cgroup").join(&host.cgroup_parent);
    if let Ok(mut dirs) = tokio::fs::read_dir(&parent).await {
        while let Ok(Some(entry)) = dirs.next_entry().await {
            if entry.file_type().await.is_ok_and(|t| t.is_dir()) {
                let _ = tokio::fs::remove_dir(entry.path()).await;
            }
        }
    }
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

pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.') && !id.starts_with('.')
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

struct Running {
    child: Child,
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
    sandboxes: Mutex<HashMap<String, Arc<Sandbox>>>,
    slots: Mutex<Vec<bool>>, // true = taken
}

#[derive(serde::Serialize)]
pub struct Listing {
    id: String,
    running: bool,
    idle_secs: u64,
    in_flight: usize,
}

impl Manager {
    pub fn new(cfg: Config, host: Arc<Host>) -> Arc<Manager> {
        let slots = vec![false; cfg.max_vms];
        Arc::new(Manager { cfg, host, sandboxes: Mutex::new(HashMap::new()), slots: Mutex::new(slots) })
    }

    fn jail<'a>(&'a self, sb: &'a Sandbox, slot: usize) -> Jail<'a> {
        Jail::new(&self.host, &sb.dir, slot)
    }

    /// Everything a VM in `slot` held, given back once its process is gone: its tap, its
    /// jail (the disk root's again) and the slot.
    async fn release(&self, sb: &Sandbox, slot: usize) {
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
            Some(r) => !matches!(r.child.try_wait(), Ok(Some(_))),
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
                Ok(child) => *running = Some(Running { child, slot }),
                Err(e) => {
                    self.release(&sb, slot).await;
                    self.forget_if_never_created(&sb).await;
                    return Err((500, e));
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

    async fn boot(&self, sb: &Sandbox, slot_index: usize) -> Result<Child, String> {
        let t0 = Instant::now();
        let slot = Slot { index: slot_index };
        tokio::fs::create_dir_all(&sb.dir).await.map_err(|e| format!("state dir: {e}"))?;
        let rootfs = sb.rootfs();
        if !rootfs.exists() {
            let out = Command::new("cp").arg("--reflink=always").arg(&self.cfg.golden).arg(&rootfs).output().await.map_err(|e| format!("cp: {e}"))?;
            if !out.status.success() {
                return Err(format!("reflink golden: {}", String::from_utf8_lossy(&out.stderr).trim()));
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
        let mut child = Command::new(&self.host.jailer)
            .args(jail.args(self.cfg.vcpus, self.cfg.mem_mib))
            .stdin(std::process::Stdio::null())
            .stdout(console.try_clone().map_err(|e| e.to_string())?)
            .stderr(console)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("jailer: {e}"))?;
        let uds = jail.uds();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("the jailer or firecracker exited during boot ({status}); see {}/console.log", sb.dir.display()));
            }
            // Each probe is bounded, so a guest that accepts but never answers can't hold
            // the slot past the deadline.
            if uds.exists() && tokio::time::timeout(Duration::from_secs(2), vsock::healthy(&uds)).await.unwrap_or(false) {
                eprintln!("sandboxd: {} booted in slot {} in {} ms", sb.id, slot_index, t0.elapsed().as_millis());
                return Ok(child);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = child.kill().await;
        Err(format!("guestd never answered within 60 s; see {}/console.log", sb.dir.display()))
    }

    /// Flush the guest's disk cache, reboot it (reboot=k makes that exit the VMM), and
    /// fall back to a kill if it doesn't go.
    async fn stop(&self, sb: &Sandbox) {
        let mut running = sb.running.lock().await;
        self.stop_locked(sb, &mut running).await;
    }

    /// `stop` for a caller already holding the sandbox's `running` lock. Every request
    /// takes that lock to reach the VM, so while it's held nothing new can start using it.
    async fn stop_locked(&self, sb: &Sandbox, running: &mut Option<Running>) {
        let Some(mut r) = running.take() else { return };
        let body = Bytes::from_static(br#"{"command":"sync && (sleep 0.2; reboot -f) &","timeoutMs":10000}"#);
        // Bounded too: a hung guest still gets killed below.
        let _ = tokio::time::timeout(Duration::from_secs(10), vsock::request(&self.jail(sb, r.slot).uds(), Method::POST, "/exec", body)).await;
        if tokio::time::timeout(Duration::from_secs(5), r.child.wait()).await.is_err() {
            let _ = r.child.kill().await;
        }
        self.release(sb, r.slot).await;
        eprintln!("sandboxd: {} stopped (disk kept)", sb.id);
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
            self.stop_locked(&sb, &mut running).await;
        }
        self.sandboxes.lock().await.remove(id);
        match tokio::fs::remove_dir_all(&sb.dir).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {}: {e}", sb.dir.display())),
        }
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
                self.stop_locked(&sb, &mut running).await;
            }
        }
    }

    /// Stop every VM at once, not one after another, so shutdown takes about as long as
    /// the slowest stop (≤ 15 s) however many are running.
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

/// The VM's Firecracker config. Every path is inside its jail (jail.rs puts the files
/// there): Firecracker runs chrooted and can't see the host's.
fn vm_config(cfg: &Config, slot_index: usize) -> serde_json::Value {
    let slot = Slot { index: slot_index };
    serde_json::json!({
        "boot-source": {
            "kernel_image_path": "/vmlinux",
            "boot_args": format!("console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd root=/dev/vda rw {}", slot.kernel_ip_arg()),
        },
        "drives": [{ "drive_id": "rootfs", "path_on_host": "/rootfs.ext4", "is_root_device": true, "is_read_only": false }],
        "machine-config": { "vcpu_count": cfg.vcpus, "mem_size_mib": cfg.mem_mib },
        "network-interfaces": [{ "iface_id": "eth0", "host_dev_name": slot.tap(), "guest_mac": slot.guest_mac() }],
        // Firecracker's vsock is a host-side Unix socket per VM, so CIDs never meet on the
        // host and the same one works for every VM (two ran at once in the acceptance run).
        // A distinct CID per slot costs nothing and keeps that true under vhost-vsock too.
        "vsock": { "guest_cid": 3 + slot_index, "uds_path": "/vsock.sock" },
    })
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
        }
    }

    #[test]
    fn the_vm_sees_only_paths_inside_its_jail() {
        let vm = super::vm_config(&config(std::path::Path::new("/var/lib/lorehouse-sandboxes")), 1);
        assert_eq!(vm["boot-source"]["kernel_image_path"], "/vmlinux");
        assert_eq!(vm["drives"][0]["path_on_host"], "/rootfs.ext4");
        assert_eq!(vm["vsock"]["uds_path"], "/vsock.sock");
        assert_eq!(vm["network-interfaces"][0]["host_dev_name"], "lhtap1");
        // No host path leaks in: not the state directory, the golden or the kernel's.
        let text = vm.to_string();
        for host_path in ["/var/lib", "/usr/local"] {
            assert!(!text.contains(host_path), "{host_path} in {text}");
        }
    }
}
