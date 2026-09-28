//! Sandboxes: one Firecracker microVM per id.
//!
//! First use reflinks the golden rootfs into the sandbox's directory (a copy-on-write
//! clone: milliseconds, and only what the sandbox changes takes space), then boots it.
//! An idle VM is stopped but its disk is kept, so a thread that comes back hours later
//! finds the same checkout. Stopping always flushes the guest's page cache first: a bare
//! kill once lost a clone that had just finished (the spike, 2026-09-25).

use crate::config::Config;
use crate::net::{self, Slot};
use crate::vsock;
use bytes::Bytes;
use hyper::Method;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// Firecracker processes a previous run left behind (a crash or SIGKILL gives
/// kill_on_drop no chance), found by their --api-sock under our state directory. Each is
/// asked to sync and reboot through its vsock, then killed if it's still there, so a
/// restarted daemon never boots a disk an old VMM still holds.
pub async fn stop_stale_vmms(state_dir: &std::path::Path) {
    let Ok(mut procs) = tokio::fs::read_dir("/proc").await else { return }; // not Linux
    while let Ok(Some(entry)) = procs.next_entry().await {
        let Some(pid) = entry.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
        let Ok(cmdline) = tokio::fs::read(format!("/proc/{pid}/cmdline")).await else { continue };
        let args: Vec<String> = cmdline.split(|b| *b == 0).map(|a| String::from_utf8_lossy(a).into_owned()).collect();
        if !args.first().is_some_and(|a| a.ends_with("firecracker")) {
            continue;
        }
        let Some(api) = args.iter().position(|a| a == "--api-sock").and_then(|i| args.get(i + 1)) else { continue };
        let api = std::path::Path::new(api);
        if !api.starts_with(state_dir) {
            continue;
        }
        let dir = api.parent().unwrap_or(state_dir);
        eprintln!("sandboxd: stopping a VMM left by a previous run (pid {pid}, {})", dir.display());
        let body = Bytes::from_static(br#"{"command":"sync && (sleep 0.2; reboot -f) &","timeoutMs":10000}"#);
        let _ = tokio::time::timeout(Duration::from_secs(10), vsock::request(&dir.join("vsock.sock"), Method::POST, "/exec", body)).await;
        for _ in 0..50 {
            if tokio::fs::metadata(format!("/proc/{pid}")).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        if tokio::fs::metadata(format!("/proc/{pid}")).await.is_ok() {
            let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status().await;
        }
    }
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
    fn uds(&self) -> PathBuf {
        self.dir.join("vsock.sock")
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
    pub fn new(cfg: Config) -> Arc<Manager> {
        let slots = vec![false; cfg.max_vms];
        Arc::new(Manager { cfg, sandboxes: Mutex::new(HashMap::new()), slots: Mutex::new(slots) })
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
            Some(r) => matches!(r.child.try_wait(), Ok(None)),
            None => false,
        };
        if !alive {
            if let Some(dead) = running.take() {
                net::tap_down(&Slot { index: dead.slot }).await;
                self.free_slot(dead.slot).await;
            }
            let Some(slot) = self.take_slot().await else {
                self.forget_if_never_created(&sb).await;
                return Err((503, format!("all {} sandboxes are busy; try again later", self.cfg.max_vms)));
            };
            match self.boot(&sb, slot).await {
                Ok(child) => *running = Some(Running { child, slot }),
                Err(e) => {
                    net::tap_down(&Slot { index: slot }).await;
                    self.free_slot(slot).await;
                    self.forget_if_never_created(&sb).await;
                    return Err((500, e));
                }
            }
        }
        sb.last_used.store(now_secs(), Ordering::SeqCst);
        Ok((guard, sb.uds()))
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
        let rootfs = sb.dir.join("rootfs.ext4");
        if !rootfs.exists() {
            let out = Command::new("cp").arg("--reflink=always").arg(&self.cfg.golden).arg(&rootfs).output().await.map_err(|e| format!("cp: {e}"))?;
            if !out.status.success() {
                return Err(format!("reflink golden: {}", String::from_utf8_lossy(&out.stderr).trim()));
            }
        }
        for sock in ["vsock.sock", "api.sock"] {
            let _ = tokio::fs::remove_file(sb.dir.join(sock)).await;
        }
        net::tap_up(&slot).await?;
        let vm = serde_json::json!({
            "boot-source": {
                "kernel_image_path": self.cfg.kernel,
                "boot_args": format!("console=ttyS0 reboot=k panic=1 pci=off i8042.noaux i8042.nomux i8042.nopnp i8042.dumbkbd root=/dev/vda rw {}", slot.kernel_ip_arg()),
            },
            "drives": [{ "drive_id": "rootfs", "path_on_host": rootfs, "is_root_device": true, "is_read_only": false }],
            "machine-config": { "vcpu_count": self.cfg.vcpus, "mem_size_mib": self.cfg.mem_mib },
            "network-interfaces": [{ "iface_id": "eth0", "host_dev_name": slot.tap(), "guest_mac": slot.guest_mac() }],
            // Firecracker's vsock is a host-side Unix socket per VM, so CIDs never meet on the
            // host and the same one works for every VM (two ran at once in the acceptance run).
            // A distinct CID per slot costs nothing and keeps that true under vhost-vsock too.
            "vsock": { "guest_cid": 3 + slot_index, "uds_path": sb.uds() },
        });
        let config = sb.dir.join("vm.json");
        tokio::fs::write(&config, vm.to_string()).await.map_err(|e| format!("vm.json: {e}"))?;
        let console = std::fs::File::create(sb.dir.join("console.log")).map_err(|e| format!("console.log: {e}"))?;
        let mut child = Command::new("firecracker")
            .arg("--api-sock")
            .arg(sb.dir.join("api.sock"))
            .arg("--config-file")
            .arg(&config)
            .stdout(console.try_clone().map_err(|e| e.to_string())?)
            .stderr(console)
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("firecracker: {e}"))?;
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("firecracker exited during boot ({status}); see {}/console.log", sb.dir.display()));
            }
            // Each probe is bounded, so a guest that accepts but never answers can't hold
            // the slot past the deadline.
            let uds = sb.uds();
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
        let _ = tokio::time::timeout(Duration::from_secs(10), vsock::request(&sb.uds(), Method::POST, "/exec", body)).await;
        if tokio::time::timeout(Duration::from_secs(5), r.child.wait()).await.is_err() {
            let _ = r.child.kill().await;
        }
        net::tap_down(&Slot { index: r.slot }).await;
        self.free_slot(r.slot).await;
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

    pub async fn stop_all(&self) {
        let list: Vec<Arc<Sandbox>> = self.sandboxes.lock().await.values().cloned().collect();
        for sb in list {
            self.stop(&sb).await;
        }
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
