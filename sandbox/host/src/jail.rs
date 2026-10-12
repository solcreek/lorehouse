//! Every VM runs under Firecracker's jailer: its own uid and gid, chrooted into a
//! directory that holds only its disk, its kernel and its sockets, and in its own cgroup
//! with CPU, memory, pids and IO limits. Firecracker's default seccomp filter stays on.
//! There is no way to run a VM without it (docs/adr/0003-sandbox-host-isolation.md).
//!
//! Layout, per sandbox (`<state>/<id>`):
//!   rootfs.ext4                               the disk, kept across stops
//!   jail/<exec>/lorehouse-<slot>/root/        the chroot while the VM runs, rebuilt at
//!       rootfs.ext4  (a hard link: the same      every boot and removed at every stop
//!       vmlinux, vm.json, firecracker,           file, so nothing is copied)
//!       api.sock, vsock.sock, dev/
//! The chroot sits inside the sandbox's own directory so the hard link stays on one file
//! system, and on one btrfs subvolume or XFS project, whatever a quota is attached to.
//!
//! The uid and the jailer id are per slot (`SANDBOXD_JAIL_UID_BASE + slot`): two VMs
//! running at once never share a uid, and the uids in use are a fixed, small range.
//! Network namespaces aren't used: the taps and nftables rules stay in the host's
//! namespace, as before. Firecracker's own seccomp filter only lets it open AF_UNIX
//! sockets, so it can't use the host's network itself (the ADR has the tradeoff).

use crate::config::Config;
use std::ffi::CString;
use std::path::{Path, PathBuf};

/// Under each sandbox's directory: the jailer's `--chroot-base-dir`.
pub const JAIL_DIR: &str = "jail";
/// The controllers each VM's cgroup limits.
const CONTROLLERS: [&str; 4] = ["cpu", "io", "memory", "pids"];
/// A VM's processes: one thread per vCPU plus Firecracker's own few. 5 at 2 vCPUs.
const PIDS_MAX: u32 = 64;
/// Half the default weight (100), so the host's own work wins IO contention. It only
/// takes effect where the IO controller acts on weights (BFQ, or iocost enabled).
const IO_WEIGHT: u32 = 50;
const CGROUP_ROOT: &str = "/sys/fs/cgroup";
/// sandboxd moves itself into this child of its own cgroup, so the VMs can have siblings
/// with controllers enabled (cgroup v2: a cgroup with processes can't delegate them).
const SUPERVISOR: &str = "supervisor";
const VMS: &str = "vms";

/// What the jail needs at run time, resolved and checked once at start.
#[derive(Clone, Debug)]
pub struct Host {
    pub jailer: PathBuf,
    pub firecracker: PathBuf,
    /// The Firecracker binary's file name: the jailer names the chroot after it.
    pub exec_name: String,
    /// Every VM's cgroup goes under this one, relative to the cgroup2 mount.
    pub cgroup_parent: String,
    pub uid_base: u32,
    pub mem_headroom_mib: u32,
}

/// One VM's jail: where it is and who it runs as.
pub struct Jail<'a> {
    host: &'a Host,
    sandbox_dir: &'a Path,
    slot: usize,
}

impl<'a> Jail<'a> {
    pub fn new(host: &'a Host, sandbox_dir: &'a Path, slot: usize) -> Jail<'a> {
        Jail { host, sandbox_dir, slot }
    }

    /// The jailer's `--id`: alphanumerics and hyphens, at most 64.
    pub fn id(&self) -> String {
        jail_id(self.slot)
    }

    pub fn uid(&self) -> u32 {
        self.host.uid_base + self.slot as u32
    }

    /// The jailer's `--chroot-base-dir`.
    pub fn base(&self) -> PathBuf {
        self.sandbox_dir.join(JAIL_DIR)
    }

    /// The VM's `/`, as the host sees it.
    pub fn root(&self) -> PathBuf {
        self.base().join(&self.host.exec_name).join(self.id()).join("root")
    }

    /// guestd's vsock socket, as the host sees it.
    pub fn uds(&self) -> PathBuf {
        self.root().join("vsock.sock")
    }

    /// The VM's own cgroup, absolute.
    pub fn cgroup(&self) -> PathBuf {
        Path::new(CGROUP_ROOT).join(&self.host.cgroup_parent).join(self.id())
    }

    /// Everything after `jailer`: the jail, then (after `--`) Firecracker's own arguments,
    /// which name paths inside the chroot.
    pub fn args(&self, vcpus: u32, mem_mib: u32) -> Vec<String> {
        let mut args: Vec<String> = vec![
            "--id".into(),
            self.id(),
            "--exec-file".into(),
            self.host.firecracker.display().to_string(),
            "--uid".into(),
            self.uid().to_string(),
            "--gid".into(),
            self.uid().to_string(),
            "--chroot-base-dir".into(),
            self.base().display().to_string(),
            "--cgroup-version".into(),
            "2".into(),
            "--parent-cgroup".into(),
            self.host.cgroup_parent.clone(),
        ];
        for (file, value) in cgroup_limits(vcpus, mem_mib, self.host.mem_headroom_mib) {
            args.push("--cgroup".into());
            args.push(format!("{file}={value}"));
        }
        args.extend(["--resource-limit".into(), "no-file=2048".into()]);
        args.extend(["--".into(), "--api-sock".into(), "/api.sock".into(), "--config-file".into(), "/vm.json".into()]);
        args
    }

    /// Build the chroot before the jailer runs: it starts from nothing every time, so
    /// nothing a previous VM left in its jail (it owned that directory) survives into the
    /// next one. Then the disk goes in as a hard link owned by this VM's uid, and the
    /// kernel and the VM's config as root-owned, read-only copies.
    pub fn build(&self, rootfs: &Path, kernel: &Path, vm_json: &[u8]) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        let base = self.base();
        remove_tree(&base).map_err(|e| format!("old jail {}: {e}", base.display()))?;
        let root = self.root();
        std::fs::create_dir_all(&root).map_err(|e| format!("jail {}: {e}", root.display()))?;
        // The disk may still belong to a uid from a run that crashed: root's again before
        // it is linked (fs.protected_hardlinks), then the VM's.
        chown(rootfs, 0, 0)?;
        let disk = root.join("rootfs.ext4");
        std::fs::hard_link(rootfs, &disk).map_err(|e| format!("link the disk into the jail: {e}"))?;
        // Mode first, while root still owns it: chmod on another uid's file would need
        // CAP_FOWNER, which the unit doesn't grant.
        std::fs::set_permissions(&disk, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("disk mode: {e}"))?;
        chown(&disk, self.uid(), self.uid())?;
        let vmlinux = root.join("vmlinux");
        std::fs::copy(kernel, &vmlinux).map_err(|e| format!("kernel {} into the jail: {e}", kernel.display()))?;
        std::fs::set_permissions(&vmlinux, std::fs::Permissions::from_mode(0o444)).map_err(|e| format!("kernel mode: {e}"))?;
        let config = root.join("vm.json");
        std::fs::write(&config, vm_json).map_err(|e| format!("vm.json: {e}"))?;
        std::fs::set_permissions(&config, std::fs::Permissions::from_mode(0o444)).map_err(|e| format!("vm.json mode: {e}"))?;
        Ok(())
    }

    /// After the VM is gone: the jail removed (the disk's other name stays), the disk
    /// root's again, and the VM's cgroup removed. Best effort; the next boot starts clean
    /// whatever is left.
    pub async fn release(&self, rootfs: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = remove_tree(&self.base());
        // Root's again, and 0600 again: the VM's uid owned it, and could have chmodded it.
        let _ = chown(rootfs, 0, 0);
        let _ = std::fs::set_permissions(rootfs, std::fs::Permissions::from_mode(0o600));
        // An exited process leaves its cgroup a moment later.
        let cgroup = self.cgroup();
        for _ in 0..20 {
            match std::fs::remove_dir(&cgroup) {
                Err(e) if e.raw_os_error() == Some(libc::EBUSY) => tokio::time::sleep(std::time::Duration::from_millis(50)).await,
                _ => break,
            }
        }
    }
}

pub fn jail_id(slot: usize) -> String {
    format!("lorehouse-{slot}")
}

/// Each VM's cgroup files and values. CPU: its vCPUs plus one for Firecracker's own
/// threads (device emulation, the API). Memory: the guest's RAM plus headroom, for
/// Firecracker itself and the host page cache its disk IO is charged with (reclaimed,
/// not killed for, at the limit).
pub fn cgroup_limits(vcpus: u32, mem_mib: u32, headroom_mib: u32) -> Vec<(&'static str, String)> {
    let period = 100_000u64;
    vec![
        ("cpu.max", format!("{} {period}", (vcpus as u64 + 1) * period)),
        ("memory.max", ((mem_mib as u64 + headroom_mib as u64) << 20).to_string()),
        ("pids.max", PIDS_MAX.to_string()),
        ("io.weight", IO_WEIGHT.to_string()),
    ]
}

/// rm -rf that is fine with nothing there.
fn remove_tree(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

fn chown(path: &Path, uid: u32, gid: u32) -> Result<(), String> {
    std::os::unix::fs::chown(path, Some(uid), Some(gid)).map_err(|e| format!("chown {}: {e}", path.display()))
}

/// The cgroup v2 path in /proc/self/cgroup's contents ("0::/system.slice/x.service").
pub fn parse_cgroup(proc_cgroup: &str) -> Option<String> {
    proc_cgroup.lines().find_map(|l| l.strip_prefix("0::")).map(|p| p.trim().to_string())
}

/// The jail id of a Firecracker process from a previous run, if it is one of ours: its
/// argv[0] names Firecracker and its cgroup sits under our VMs' parent.
pub fn jailed_vmm(args: &[String], proc_cgroup: &str, cgroup_parent: &str) -> Option<String> {
    if !args.first().is_some_and(|a| a.ends_with("firecracker")) {
        return None;
    }
    let path = parse_cgroup(proc_cgroup)?;
    let id = path.strip_prefix('/')?.strip_prefix(cgroup_parent)?.strip_prefix('/')?;
    (!id.is_empty() && !id.contains('/')).then(|| id.to_string())
}

/// `name` as found on PATH, or `path` itself when it has a slash.
fn resolve(name_or_path: &Path) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let executable = |p: &Path| std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0);
    if name_or_path.components().count() > 1 {
        return executable(name_or_path).then(|| name_or_path.to_path_buf());
    }
    std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).map(|d| d.join(name_or_path)).find(|p| executable(p))
}

/// "v1.10.1" from `firecracker --version` / `jailer --version`.
pub fn version_of(output: &str) -> Option<String> {
    output.split_whitespace().find(|w| w.starts_with('v') && w[1..].starts_with(|c: char| c.is_ascii_digit())).map(String::from)
}

async fn version(bin: &Path) -> Result<String, String> {
    let out = tokio::process::Command::new(bin).arg("--version").output().await.map_err(|e| format!("{}: {e}", bin.display()))?;
    version_of(&String::from_utf8_lossy(&out.stdout)).ok_or_else(|| format!("{} --version: no version in its output", bin.display()))
}

/// Users or groups that already own an id the jail would use: a VM must never run as
/// someone who exists.
fn taken_ids(base: u32, count: usize) -> Vec<u32> {
    (base..base + count as u32)
        .filter(|&id| unsafe {
            // SAFETY: getpwuid/getgrgid return a pointer to static storage or null; only
            // the null check reads it, at start, before any other thread looks users up.
            !libc::getpwuid(id).is_null() || !libc::getgrgid(id).is_null()
        })
        .collect()
}

#[cfg(not(target_os = "linux"))]
fn getxattr(_: &Path, _: &str) -> Option<Vec<u8>> {
    None // no cgroups, so no jail: prepare() refuses
}

#[cfg(target_os = "linux")]
fn getxattr(path: &Path, name: &str) -> Option<Vec<u8>> {
    use std::os::unix::ffi::OsStrExt;
    let p = CString::new(path.as_os_str().as_bytes()).ok()?;
    let n = CString::new(name).ok()?;
    let mut buf = [0u8; 16];
    // SAFETY: both strings are NUL-terminated and buf's length is passed.
    let len = unsafe { libc::getxattr(p.as_ptr(), n.as_ptr(), buf.as_mut_ptr().cast(), buf.len()) };
    (len >= 0).then(|| buf[..len as usize].to_vec())
}

/// sandboxd's cgroup, set up for the VMs': sandboxd moves into `<own>/supervisor` and
/// the VMs go under `<own>/vms`, both with the controllers the limits use. The cgroup
/// must have been delegated (sandboxd.service has Delegate=yes); anything else is
/// refused, so sandboxd never writes into a cgroup tree that isn't its own.
async fn setup_cgroups() -> Result<String, String> {
    let own = parse_cgroup(&tokio::fs::read_to_string("/proc/self/cgroup").await.map_err(|e| format!("/proc/self/cgroup: {e}"))?)
        .ok_or("no cgroup v2 in /proc/self/cgroup: the jail needs the unified hierarchy")?;
    // Started again inside the supervisor cgroup (not the usual way): its parent is ours.
    let own = own.strip_suffix(&format!("/{SUPERVISOR}")).unwrap_or(&own).to_string();
    let dir = Path::new(CGROUP_ROOT).join(own.trim_start_matches('/'));
    let delegated = ["trusted.delegate", "user.delegate"].iter().any(|x| getxattr(&dir, x).as_deref() == Some(b"1"));
    if !delegated {
        return Err(format!(
            "cgroup {own} isn't delegated to sandboxd, so it can't give each VM its own: run it from sandboxd.service (Delegate=yes), or under `systemd-run -p Delegate=yes`"
        ));
    }
    let available = std::fs::read_to_string(dir.join("cgroup.controllers")).unwrap_or_default();
    let missing: Vec<&str> = CONTROLLERS.iter().copied().filter(|c| !available.split_whitespace().any(|a| a == *c)).collect();
    if !missing.is_empty() {
        return Err(format!("cgroup {own} lacks the {} controller(s) the VM limits need", missing.join(", ")));
    }
    let write = |path: PathBuf, value: String| std::fs::write(&path, value).map_err(|e| format!("{}: {e}", path.display()));
    let supervisor = dir.join(SUPERVISOR);
    let _ = std::fs::create_dir(&supervisor);
    write(supervisor.join("cgroup.procs"), std::process::id().to_string())?;
    let enable = CONTROLLERS.iter().map(|c| format!("+{c}")).collect::<Vec<_>>().join(" ");
    write(dir.join("cgroup.subtree_control"), enable.clone())?;
    let vms = dir.join(VMS);
    let _ = std::fs::create_dir(&vms);
    write(vms.join("cgroup.subtree_control"), enable)?;
    // The limits the jailer writes must exist here, or every boot would fail on them.
    // io.weight, for one, needs the kernel's iocost or BFQ.
    for (file, _) in cgroup_limits(1, 128, 64) {
        if !vms.join(file).exists() {
            return Err(format!("cgroup {own}/{VMS} has no {file}: this kernel can't apply that VM limit"));
        }
    }
    Ok(format!("{}/{VMS}", own.trim_start_matches('/')))
}

/// Everything the jail needs, checked at start; any problem refuses the start (fail
/// closed: no VM ever runs unjailed).
pub async fn prepare(cfg: &Config) -> Result<Host, String> {
    let jailer = resolve(&cfg.jail.jailer).ok_or_else(|| {
        format!("jailer {:?} isn't on PATH or executable (SANDBOXD_JAILER): sandboxd runs every VM under Firecracker's jailer and won't start without it", cfg.jail.jailer)
    })?;
    let firecracker =
        resolve(&cfg.jail.firecracker).ok_or_else(|| format!("firecracker {:?} isn't on PATH or executable (SANDBOXD_FIRECRACKER)", cfg.jail.firecracker))?;
    let firecracker = std::fs::canonicalize(&firecracker).map_err(|e| format!("{}: {e}", firecracker.display()))?;
    let exec_name = firecracker.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    if !exec_name.contains("firecracker") {
        return Err(format!("the jailer only runs a binary whose name contains \"firecracker\", got {}", firecracker.display()));
    }
    let (jv, fv) = (version(&jailer).await?, version(&firecracker).await?);
    if jv != fv {
        return Err(format!("jailer {jv} and firecracker {fv} differ: the jailer must come from the same Firecracker release"));
    }
    let taken = taken_ids(cfg.jail.uid_base, cfg.max_vms);
    if !taken.is_empty() {
        return Err(format!("SANDBOXD_JAIL_UID_BASE: the VMs' ids {taken:?} belong to existing users or groups; pick a free range of {}", cfg.max_vms));
    }
    let cgroup_parent = setup_cgroups().await?;
    eprintln!(
        "sandboxd: VMs run under the jailer ({}, Firecracker {fv}) as uids {}..{}, in cgroup {cgroup_parent}",
        jailer.display(),
        cfg.jail.uid_base,
        cfg.jail.uid_base + cfg.max_vms as u32 - 1
    );
    Ok(Host { jailer, firecracker, exec_name, cgroup_parent, uid_base: cfg.jail.uid_base, mem_headroom_mib: cfg.jail.mem_headroom_mib })
}

#[cfg(test)]
pub mod tests {
    use super::*;

    pub fn host() -> Host {
        Host {
            jailer: "/usr/local/bin/jailer".into(),
            firecracker: "/usr/local/bin/firecracker".into(),
            exec_name: "firecracker".into(),
            cgroup_parent: "system.slice/sandboxd.service/vms".into(),
            uid_base: 1_900_000_000,
            mem_headroom_mib: 512,
        }
    }

    #[test]
    fn each_slot_has_its_own_uid_chroot_and_cgroup() {
        let h = host();
        let dir = Path::new("/var/lib/lorehouse-sandboxes/slack_C1_1.2");
        let (a, b) = (Jail::new(&h, dir, 0), Jail::new(&h, dir, 3));
        assert_eq!((a.uid(), b.uid()), (1_900_000_000, 1_900_000_003));
        assert_eq!(b.id(), "lorehouse-3");
        assert_eq!(b.root(), Path::new("/var/lib/lorehouse-sandboxes/slack_C1_1.2/jail/firecracker/lorehouse-3/root"));
        assert_eq!(b.uds(), b.root().join("vsock.sock"));
        assert_eq!(b.cgroup(), Path::new("/sys/fs/cgroup/system.slice/sandboxd.service/vms/lorehouse-3"));
        // The jailer's id rule: alphanumerics and hyphens, ≤ 64, for every slot there is.
        let id = jail_id(63);
        assert!(id.len() <= 64 && id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'), "{id}");
    }

    #[test]
    fn the_jailer_drops_to_the_slot_uid_with_limits_and_seccomp_on() {
        let h = host();
        let dir = Path::new("/s/x");
        let args = Jail::new(&h, dir, 1).args(2, 2048);
        let joined = args.join(" ");
        assert_eq!(
            joined,
            "--id lorehouse-1 --exec-file /usr/local/bin/firecracker --uid 1900000001 --gid 1900000001 \
             --chroot-base-dir /s/x/jail --cgroup-version 2 --parent-cgroup system.slice/sandboxd.service/vms \
             --cgroup cpu.max=300000 100000 --cgroup memory.max=2684354560 --cgroup pids.max=64 --cgroup io.weight=50 \
             --resource-limit no-file=2048 -- --api-sock /api.sock --config-file /vm.json"
        );
        // Firecracker's default seccomp filter stays on; it stays attached to sandboxd's
        // process tree (no daemonizing, which would also hide it from kill_on_drop).
        for flag in ["--no-seccomp", "--seccomp-filter", "--daemonize", "--new-pid-ns"] {
            assert!(!args.iter().any(|a| a == flag), "{flag}");
        }
        // cpu.max's value is one argument: the jailer splits on the first '='.
        assert!(args.iter().any(|a| a == "cpu.max=300000 100000"));
    }

    #[test]
    fn limits_follow_the_vm_size() {
        assert_eq!(
            cgroup_limits(4, 8192, 256),
            vec![("cpu.max", "500000 100000".to_string()), ("memory.max", ((8192u64 + 256) << 20).to_string()), ("pids.max", "64".into()), ("io.weight", "50".into())]
        );
        // The memory limit is above the guest's RAM, so a full guest is not OOM-killed.
        let mem: u64 = cgroup_limits(2, 2048, 512)[1].1.parse().unwrap();
        assert!(mem > 2048 << 20);
    }

    #[test]
    fn a_jailed_vmm_is_found_by_its_cgroup() {
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let parent = "system.slice/sandboxd.service/vms";
        let fc = args(&["/firecracker", "--id", "lorehouse-2", "--api-sock", "/api.sock"]);
        assert_eq!(jailed_vmm(&fc, "0::/system.slice/sandboxd.service/vms/lorehouse-2\n", parent).as_deref(), Some("lorehouse-2"));
        // Someone else's Firecracker (another cgroup), or not Firecracker at all: not ours.
        assert_eq!(jailed_vmm(&fc, "0::/system.slice/firerunner.service/vm-1\n", parent), None);
        assert_eq!(jailed_vmm(&fc, "0::/system.slice/sandboxd.service/vms-old/lorehouse-2\n", parent), None);
        assert_eq!(jailed_vmm(&fc, "0::/system.slice/sandboxd.service/vms\n", parent), None);
        assert_eq!(jailed_vmm(&args(&["/usr/bin/bash"]), "0::/system.slice/sandboxd.service/vms/lorehouse-2\n", parent), None);
        assert_eq!(parse_cgroup("0::/user.slice/a.scope\n").as_deref(), Some("/user.slice/a.scope"));
        assert_eq!(parse_cgroup("12:cpu:/x\n"), None);
    }

    #[test]
    fn versions_are_read_from_either_binary() {
        assert_eq!(version_of("Firecracker v1.10.1\n\n").as_deref(), Some("v1.10.1"));
        assert_eq!(version_of("Jailer v1.10.1\n").as_deref(), Some("v1.10.1"));
        assert_eq!(version_of("jailer: very verbose\n"), None);
    }

    #[test]
    fn the_jail_is_rebuilt_from_nothing() {
        // As root this would also chown; unprivileged, building must at least get as far
        // as wiping what a previous VM left (it owned its jail and could plant links).
        let tmp = std::env::temp_dir().join(format!("sandboxd-jail-{}", std::process::id()));
        let h = host();
        let jail = Jail::new(&h, &tmp, 0);
        std::fs::create_dir_all(jail.root()).unwrap();
        std::os::unix::fs::symlink("/etc/passwd", jail.root().join("firecracker")).unwrap();
        let rootfs = tmp.join("rootfs.ext4");
        std::fs::write(&rootfs, b"disk").unwrap();
        let _ = jail.build(&rootfs, Path::new("/nonexistent"), b"{}");
        assert!(std::fs::symlink_metadata(jail.root().join("firecracker")).is_err(), "the planted link survived");
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
