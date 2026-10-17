//! The git that reads what a VM produced runs isolated from sandboxd (ADR 0003, layer 3).
//! A git bug a VM's bundle or objects reach then gets one repo's mirror and nothing more.
//!
//! Every git command publishing runs (publish.rs) is set up here, between fork and exec:
//!
//! - **Its own uid**, leased from `SANDBOXD_GIT_UID_BASE .. + GIT_UIDS` for that one run
//!   and returned once nothing of the run is left. Not 0, not a VM's; sandboxd refuses to
//!   start if any of them is a user or group. Two git commands running at once never share
//!   a uid, so neither can signal, trace or read the other.
//! - **Its own mount namespace**, whose root is an empty tmpfs holding only `/usr` (and
//!   `/nix/store` where git comes from there) read-only, the merged-usr links, `ld.so.cache`,
//!   `/dev/null`, `zero`, `full`, `random` and `urandom`, a private `/tmp`, and the mirror
//!   it works on at `/repo` (noexec). Nothing else of the host: no `/etc/lorehouse`, no
//!   `/run/credentials`, no `/proc`, `/sys` or cgroup tree, no other mirror, no sandbox.
//!   The mirror is chowned to the run's uid first.
//! - **Its own network namespace.** Empty (not even loopback up), except for a run that
//!   talks to the remote: that one gets a namespace whose only address is a listener
//!   sandboxd made on its loopback, behind which sandboxd itself talks to the remote
//!   (publish/remote.rs). No git ever holds a token or reaches anything else.
//! - **Its own cgroup** (`<sandboxd.service>/git/u<uid>`, beside `vms/`), killed whole once
//!   the run is over however it ended, so a process that left git's process group (setsid)
//!   doesn't outlive it.
//! - **Its own IPC namespace**, so no SysV or POSIX IPC object a run makes outlives it
//!   (cgroup.kill doesn't remove one) for a later run of the same uid to attach to.
//! - **No capabilities and `no_new_privs`** (jail::drop_capabilities), and no core dumps.
//!
//! None of this can be turned off: sandboxd doesn't start when it can't be set up (a probe
//! run at start), and a run that can't be set up doesn't run.

use std::ffi::{CString, OsStr};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// How many uids the leases come from: as many git commands can run at once.
pub const GIT_UIDS: u32 = 32;
/// Where the mirror is, as the run sees it.
pub const REPO: &str = "/repo";
/// What the remover's find is given (GitJail::remover): every entry under the tree, deepest
/// first, deleted as itself (a link never followed).
pub const REMOVE_ARGS: [&str; 4] = [REPO, "-mindepth", "1", "-delete"];
/// The run's global git config when a file:// remote is bound in (testing): it names that
/// repo safe, and holds nothing else.
pub const SAFE_CONFIG: &str = "/etc/safe.gitconfig";
/// Each run's tasks (threads count: pack-objects runs one per CPU).
const PIDS_MAX: u32 = 512;
/// How long a killed run's cgroup has to empty before its uid is given up for good.
const EMPTY_WAIT: Duration = Duration::from_secs(10);
/// Device nodes a run gets (standard pseudo-devices only).
const DEVICES: [&str; 5] = ["null", "zero", "full", "random", "urandom"];
/// Top-level names a merged-usr host has as links into /usr (or as directories otherwise).
const TOP: [&str; 6] = ["bin", "sbin", "lib", "lib32", "lib64", "libx32"];

/// What of the host a run sees, resolved once at start.
#[derive(Debug, Clone)]
enum Entry {
    /// A directory, bound read-only at the same path.
    Dir(PathBuf),
    /// A file, bound read-only at the same path.
    File(PathBuf),
    /// A symbolic link at `.0`, pointing where the host's does.
    Link(PathBuf, PathBuf),
}

/// The uids runs are leased.
struct Pool {
    /// How many uids there are.
    size: usize,
    free: Mutex<Vec<u32>>,
    available: tokio::sync::Semaphore,
}

pub struct GitJail {
    /// git, canonical: the absolute path that is inside a run's root and the same there.
    git: PathBuf,
    /// find, likewise: what empties a dropped mirror (remover).
    find: PathBuf,
    /// An empty directory a run's tmpfs root is mounted on (in its own namespace).
    mountpoint: PathBuf,
    entries: Vec<Entry>,
    devices: Vec<PathBuf>,
    /// `<sandboxd.service>/git`, absolute; None only in tests run unprivileged.
    cgroups: Option<PathBuf>,
    /// None only in tests run unprivileged (in a user namespace, as root there).
    uids: Option<Pool>,
    /// Each run's memory.max, in bytes (SANDBOXD_GIT_MEM_MIB); unused without cgroups.
    mem_max: u64,
    /// Where a run's trees go when the run can't be stopped (Publisher::new sets it:
    /// `<mirrors>/.drop`).
    graveyard: std::sync::OnceLock<PathBuf>,
    /// Runs whose cgroup didn't empty: their uid, and their cgroup, killed again before
    /// each new run; the uid is free again only once that succeeds.
    stuck: Mutex<Vec<Held>>,
    /// Tests only: every run's cgroup fails to empty.
    #[cfg(test)]
    fail_kills: std::sync::atomic::AtomicBool,
    /// Tests only: what is held stays held.
    #[cfg(test)]
    keep_stuck: std::sync::atomic::AtomicBool,
}

impl std::fmt::Debug for GitJail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GitJail").field("git", &self.git).field("cgroups", &self.cgroups).finish_non_exhaustive()
    }
}

/// What a run is given of the remote, beyond its mirror.
pub enum Net {
    /// No network at all.
    Off,
    /// The network namespace (a handle to it) whose only address is sandboxd's listener.
    Proxied(OwnedFd),
    /// A file:// remote's repository (testing without GitHub): bound at its own path,
    /// writable for a push. No network.
    Dir(PathBuf, bool),
    /// A mirror another run wrote, bound read-only at its own path and given to this run's
    /// uid, for a fresh repo in `dir` to fetch from (publish.rs, Publisher::follows).
    Source(PathBuf),
}

impl GitJail {
    /// Everything a run needs, checked once at start: git, what of the host goes into a run,
    /// the cgroup the runs go under (created by jail::setup_cgroups), and the uids, which
    /// must belong to no user or group. Any problem refuses the start.
    pub fn prepare(state_dir: &Path, cgroups: PathBuf, uid_base: u32, mem_max: u64) -> Result<GitJail, String> {
        let taken = crate::jail::taken_ids(uid_base, GIT_UIDS as usize)?;
        if !taken.is_empty() {
            return Err(format!("SANDBOXD_GIT_UID_BASE: the ids publishing's git would run as, {taken:?}, belong to existing users or groups; pick a free range of {GIT_UIDS}"));
        }
        let mut jail = GitJail::unprivileged(state_dir)?;
        clear_cgroups(&cgroups, mem_max)?;
        jail.cgroups = Some(cgroups);
        jail.mem_max = mem_max;
        jail.uids = Some(Pool { size: GIT_UIDS as usize, free: Mutex::new((uid_base..uid_base + GIT_UIDS).rev().collect()), available: tokio::sync::Semaphore::new(GIT_UIDS as usize) });
        Ok(jail)
    }

    /// The namespaces without the uid and cgroup: for tests run in a user namespace. Also
    /// the part of prepare() that finds git and what a run sees of the host.
    pub fn unprivileged(state_dir: &Path) -> Result<GitJail, String> {
        let git = crate::jail::resolve(Path::new("git")).ok_or("git isn't on PATH: publishing needs it")?;
        GitJail::with_git(state_dir, &git)
    }

    /// unprivileged(), with git at `git`.
    fn with_git(state_dir: &Path, git: &Path) -> Result<GitJail, String> {
        let real = std::fs::canonicalize(git).map_err(|e| format!("{}: {e}", git.display()))?;
        let mut entries = Vec::new();
        if !std::fs::metadata("/usr").is_ok_and(|m| m.is_dir()) {
            return Err("no /usr: publishing's git runs with /usr read-only and nothing else of the host".into());
        }
        entries.push(Entry::Dir("/usr".into()));
        for name in TOP {
            let path = Path::new("/").join(name);
            match std::fs::symlink_metadata(&path) {
                Ok(m) if m.file_type().is_symlink() => entries.push(Entry::Link(path.clone(), std::fs::read_link(&path).map_err(|e| format!("{}: {e}", path.display()))?)),
                Ok(m) if m.is_dir() => entries.push(Entry::Dir(path)),
                _ => {}
            }
        }
        // A Nix-built git (and its libraries) lives in the store.
        if real.starts_with("/nix/store") {
            entries.push(Entry::Dir("/nix/store".into()));
        }
        if std::fs::metadata("/etc/ld.so.cache").is_ok_and(|m| m.is_file()) {
            entries.push(Entry::File("/etc/ld.so.cache".into()));
        }
        // git itself must be inside: under a directory that goes in (a link resolved).
        let inside = |p: &Path| entries.iter().any(|e| matches!(e, Entry::Dir(d) if p.starts_with(d)));
        if !inside(&real) {
            return Err(format!("git is {} ({}), outside what its isolated runs see (/usr, /nix/store)", git.display(), real.display()));
        }
        let find = crate::jail::resolve(Path::new("find")).and_then(|f| std::fs::canonicalize(f).ok()).filter(|f| inside(f)).ok_or("find isn't on PATH under /usr: a dropped mirror is emptied with it, in a jailed run")?;
        let devices = DEVICES.iter().map(|d| Path::new("/dev").join(d)).filter(|p| std::fs::metadata(p).is_ok_and(|m| std::os::unix::fs::FileTypeExt::is_char_device(&m.file_type()))).collect();
        let mountpoint = state_dir.join(".git-root");
        std::fs::create_dir_all(&mountpoint).map_err(|e| format!("{}: {e}", mountpoint.display()))?;
        if !std::fs::symlink_metadata(&mountpoint).is_ok_and(|m| m.is_dir()) {
            return Err(format!("{} isn't a directory", mountpoint.display()));
        }
        // The path that passed the check above is the one runs exec: a link to it (on PATH)
        // isn't inside a run's root.
        Ok(GitJail {
            git: real,
            find,
            mountpoint,
            entries,
            devices,
            cgroups: None,
            uids: None,
            mem_max: 0,
            graveyard: Default::default(),
            stuck: Mutex::default(),
            #[cfg(test)]
            fail_kills: Default::default(),
            #[cfg(test)]
            keep_stuck: Default::default(),
        })
    }

    /// Where a run's trees go if the run can't be stopped (`<mirrors>/.drop`).
    pub fn set_graveyard(&self, graveyard: PathBuf) {
        let _ = self.graveyard.set(graveyard);
    }

    /// Kill again what runs left that didn't stop; each uid whose cgroup is empty now is
    /// free again.
    fn reap_stuck(&self) {
        let mut stuck = self.stuck.lock().unwrap_or_else(|e| e.into_inner());
        stuck.retain(|Held { uid, cgroup, .. }| {
            #[cfg(test)]
            if self.fail_kills.load(std::sync::atomic::Ordering::SeqCst) || self.keep_stuck.load(std::sync::atomic::Ordering::SeqCst) {
                return true;
            }
            if cgroup.as_deref().is_some_and(|c| kill_cgroup(c).is_err()) {
                return true;
            }
            if let Some(pool) = &self.uids {
                pool.free.lock().unwrap_or_else(|e| e.into_inner()).push(*uid);
                pool.available.add_permits(1);
            }
            false
        });
    }

    /// A command for one isolated run of git in `dir` (the caller adds the arguments,
    /// environment and pipes), and what holds the run's uid, cgroup and namespaces until
    /// it is dropped. Waits for a free uid.
    pub async fn command(self: &Arc<Self>, dir: &Path, net: Net, stuck: Arc<std::sync::atomic::AtomicBool>) -> Result<(tokio::process::Command, Confined), String> {
        self.run_for(dir, net, false, stuck).await
    }

    /// A command that empties `dir`, a dropped mirror, in a jailed run like git's: `find
    /// /repo -mindepth 1 -delete` (the caller adds the arguments), as a leased uid, in its own
    /// cgroup. Unlike git's, the tree isn't chowned to it first (sandboxd never walks a
    /// dropped tree): the run keeps CAP_DAC_OVERRIDE and CAP_FOWNER. What it sees: that tree
    /// at /repo (writable), /usr, the merged-usr links and /etc/ld.so.cache (read-only bind
    /// mounts, which the capabilities don't make writable), a /tmp tmpfs of its own and an
    /// empty /dev: no device node of the host's (plan_for). So the capabilities reach only
    /// the tree it deletes.
    pub async fn remover(self: &Arc<Self>, dir: &Path, stuck: Arc<std::sync::atomic::AtomicBool>) -> Result<(tokio::process::Command, Confined), String> {
        self.run_for(dir, Net::Off, true, stuck).await
    }

    /// `stuck` is set if, once dropped, the run's cgroup can't be emptied: then the run's
    /// trees have been moved out of use and the job must fail.
    async fn run_for(self: &Arc<Self>, dir: &Path, net: Net, remove: bool, stuck: Arc<std::sync::atomic::AtomicBool>) -> Result<(tokio::process::Command, Confined), String> {
        self.reap_stuck();
        let lease = match &self.uids {
            Some(pool) => {
                // A free uid is taken. With none free: refused at once if every uid is held
                // by a run that couldn't be stopped (they may never be free); otherwise one
                // that is busy now frees up, and is waited for (callers bound the wait).
                match pool.available.try_acquire() {
                    Ok(permit) => permit.forget(),
                    Err(_) => {
                        let held = self.stuck.lock().unwrap_or_else(|e| e.into_inner()).len();
                        if held >= pool.size {
                            return Err(format!("no git uid is free: {held} runs couldn't be stopped (their cgroups didn't empty), and their uids are held until they do"));
                        }
                        pool.available.acquire().await.map_err(|e| format!("git uids: {e}"))?.forget();
                    }
                }
                let uid = pool.free.lock().unwrap_or_else(|e| e.into_inner()).pop();
                match uid {
                    Some(uid) => Some(Lease { jail: self.clone(), uid }),
                    None => {
                        pool.available.add_permits(1);
                        return Err("git uids: none free".into());
                    }
                }
            }
            None => None,
        };
        let uid = lease.as_ref().map(|l| l.uid);
        let mut confined = Confined { lease, cgroup: None, net: None, trees: vec![dir.to_path_buf()], stuck, jail: self.clone() };
        if let Some(uid) = uid.filter(|_| !remove) {
            // A tree that can't be walked whole within the caps (mirrorfs) is never half
            // given to the run: it is taken out of use, as a cache that can't be trusted.
            if let Err(e) = own(dir, uid, uid) {
                if let Some(graveyard) = self.graveyard.get() {
                    bury(dir, graveyard);
                }
                return Err(format!("giving the mirror to its run's uid: {e}; the mirror was taken out of use, stage again"));
            }
        }
        if let Some(parent) = &self.cgroups {
            let cgroup = parent.join(format!("u{}", uid.unwrap_or(0)));
            make_cgroup(&cgroup, self.mem_max)?;
            confined.cgroup = Some(cgroup);
        }
        let (netns, remote) = match net {
            Net::Off => (None, None),
            Net::Proxied(fd) => {
                let raw = fd.as_raw_fd();
                confined.net = Some(fd);
                (Some(raw), None)
            }
            Net::Dir(path, writable) => (None, Some((path, writable))),
            Net::Source(path) => {
                confined.trees.push(path.clone());
                if let Some(uid) = uid {
                    own(&path, uid, uid).map_err(|e| format!("giving the source mirror to its run's uid: {e}"))?;
                }
                (None, Some((path, false)))
            }
        };
        let plan = self.plan_for(dir, uid, confined.cgroup.as_deref(), netns, remote.as_ref().map(|(p, w)| (p.as_path(), *w)), remove)?;
        let mut cmd = crate::child::command(if remove { &self.find } else { &self.git });
        // SAFETY: Plan::enter makes only async-signal-safe system calls on memory prepared
        // before the fork, as pre_exec requires.
        unsafe {
            cmd.pre_exec(move || plan.enter());
        }
        Ok((cmd, confined))
    }

    /// A git run's plan, or the remover's: no device nodes at all (`find -delete` opens
    /// none, and with its capabilities it could change the host's), and its capabilities
    /// kept.
    fn plan_for(&self, dir: &Path, uid: Option<u32>, cgroup: Option<&Path>, netns: Option<RawFd>, remote: Option<(&Path, bool)>, remove: bool) -> Result<Plan, String> {
        let mut plan = self.plan(dir, uid, cgroup, netns, remote, !remove)?;
        plan.keep_delete = remove;
        Ok(plan)
    }

    #[cfg(not(target_os = "linux"))]
    fn plan(&self, _: &Path, _: Option<u32>, _: Option<&Path>, _: Option<RawFd>, _: Option<(&Path, bool)>, _: bool) -> Result<Plan, String> {
        let _ = (&self.mountpoint, &self.entries, &self.devices, &self.find, SAFE_CONFIG);
        Err("git isolation is Linux only".into())
    }

    /// Everything a run's setup does, prepared here (paths, flags) so the child only makes
    /// system calls.
    #[cfg(target_os = "linux")]
    fn plan(&self, dir: &Path, uid: Option<u32>, cgroup: Option<&Path>, netns: Option<RawFd>, remote: Option<(&Path, bool)>, devices: bool) -> Result<Plan, String> {
        let root = self.mountpoint.clone();
        let at = |p: &Path| root.join(p.strip_prefix("/").unwrap_or(p));
        let mut ops = vec![Op::mount(Some(OsStr::new("tmpfs")), &root, Some("tmpfs"), libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, Some("mode=0755,size=1m"))?];
        let mut made: Vec<PathBuf> = vec![root.clone()];
        let mut mkdirs = |ops: &mut Vec<Op>, path: &Path| -> Result<(), String> {
            let mut so_far = root.clone();
            for part in path.strip_prefix("/").unwrap_or(path).components() {
                so_far.push(part);
                if !made.contains(&so_far) {
                    ops.push(Op::Mkdir(cstr(&so_far)?));
                    made.push(so_far.clone());
                }
            }
            Ok(())
        };
        for entry in &self.entries {
            match entry {
                Entry::Dir(d) => {
                    mkdirs(&mut ops, d)?;
                    ops.push(Op::mount(Some(d.as_os_str()), &at(d), None, libc::MS_BIND, None)?);
                    ops.push(Op::mount(None, &at(d), None, libc::MS_REMOUNT | libc::MS_BIND | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | kept_flags(d), None)?);
                }
                Entry::File(f) => {
                    mkdirs(&mut ops, f.parent().unwrap_or(Path::new("/")))?;
                    ops.push(Op::Touch(cstr(&at(f))?));
                    ops.push(Op::mount(Some(f.as_os_str()), &at(f), None, libc::MS_BIND, None)?);
                    ops.push(Op::mount(None, &at(f), None, libc::MS_REMOUNT | libc::MS_BIND | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | kept_flags(f), None)?);
                }
                Entry::Link(link, target) => ops.push(Op::Symlink(cstr(target)?, cstr(&at(link))?)),
            }
        }
        mkdirs(&mut ops, Path::new("/dev"))?;
        for dev in self.devices.iter().filter(|_| devices) {
            ops.push(Op::Touch(cstr(&at(dev))?));
            ops.push(Op::mount(Some(dev.as_os_str()), &at(dev), None, libc::MS_BIND, None)?);
        }
        mkdirs(&mut ops, Path::new("/tmp"))?;
        ops.push(Op::mount(Some(OsStr::new("tmpfs")), &at(Path::new("/tmp")), Some("tmpfs"), libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC, Some("mode=1777,size=16m"))?);
        if let Some((path, writable)) = remote {
            mkdirs(&mut ops, path)?;
            ops.push(Op::mount(Some(path.as_os_str()), &at(path), None, libc::MS_BIND, None)?);
            let ro = if writable { 0 } else { libc::MS_RDONLY };
            ops.push(Op::mount(None, &at(path), None, libc::MS_REMOUNT | libc::MS_BIND | ro | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC | kept_flags(path), None)?);
            // That repo belongs to whoever made it, not to the run's uid, and git refuses a
            // repo another uid owns unless the global config (the only one that can say so
            // and reaches the remote's upload-pack) names it.
            mkdirs(&mut ops, Path::new("/etc"))?;
            let config = CString::new(format!("[safe]\n\tdirectory = {}\n", path.display())).map_err(|_| "a NUL in the remote's path".to_string())?;
            ops.push(Op::Write(cstr(&at(Path::new(SAFE_CONFIG)))?, config));
        }
        let repo = Path::new(REPO);
        mkdirs(&mut ops, repo)?;
        ops.push(Op::mount(Some(dir.as_os_str()), &at(repo), None, libc::MS_BIND, None)?);
        ops.push(Op::mount(None, &at(repo), None, libc::MS_REMOUNT | libc::MS_BIND | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC | kept_flags(dir), None)?);
        Ok(Plan {
            cgroup_procs: cgroup.map(|c| cstr(&c.join("cgroup.procs"))).transpose()?,
            root: cstr(&root)?,
            ops,
            netns,
            uid,
            keep_delete: false,
        })
    }

    /// A run that does nothing but start git, through all of the above: at start, so a host
    /// that can't isolate git doesn't start (fail closed).
    pub async fn probe(self: &Arc<Self>, scratch: &Path) -> Result<String, String> {
        std::fs::create_dir_all(scratch).map_err(|e| format!("{}: {e}", scratch.display()))?;
        let (mut cmd, confined) = self.command(scratch, Net::Off, Default::default()).await?;
        cmd.arg("version").stdin(std::process::Stdio::null());
        let out = cmd.output().await.map_err(|e| explain(&e));
        drop(confined);
        let _ = std::fs::remove_dir_all(scratch);
        let out = out?;
        if !out.status.success() {
            return Err(format!("git version, isolated: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
}

/// A run's uid while it is leased: back in the pool when dropped, unless the run's cgroup
/// couldn't be emptied (Confined), in which case it is never used again.
struct Lease {
    jail: Arc<GitJail>,
    uid: u32,
}

impl Lease {
    fn release(self) {
        if let Some(pool) = &self.jail.uids {
            pool.free.lock().unwrap_or_else(|e| e.into_inner()).push(self.uid);
            pool.available.add_permits(1);
        }
    }
}

/// A run that couldn't be stopped: its uid, its cgroup (killed again before each new run),
/// and since when (unix seconds).
struct Held {
    uid: u32,
    cgroup: Option<PathBuf>,
    since: u64,
}

impl GitJail {
    /// How many uids are held by runs that couldn't be stopped, and since when the oldest.
    pub fn held(&self) -> (usize, Option<u64>) {
        let stuck = self.stuck.lock().unwrap_or_else(|e| e.into_inner());
        (stuck.len(), stuck.iter().map(|h| h.since).min())
    }
}

/// What one run holds: its uid, its cgroup, its network namespace. Dropped (after the run's
/// process group has been stopped and its leader reaped), the cgroup is killed whole and
/// removed, and only then is the uid free for another run. Blocks the thread for that while:
/// a SIGKILL'd process is gone in milliseconds.
pub struct Confined {
    lease: Option<Lease>,
    cgroup: Option<PathBuf>,
    net: Option<OwnedFd>,
    /// What the run could write: its mirror (or check repo), and a source mirror it read.
    trees: Vec<PathBuf>,
    stuck: Arc<std::sync::atomic::AtomicBool>,
    jail: Arc<GitJail>,
}

impl Drop for Confined {
    /// Fail closed when the run can't be stopped: its processes may still be writing what
    /// it could write. Its trees are moved out of use at once (into the graveyard: no
    /// further run or host read of them), its uid isn't used again until its cgroup is
    /// found empty (reap_stuck), and the job that ran it fails (`stuck`).
    fn drop(&mut self) {
        #[allow(unused_mut)]
        let mut emptied = match &self.cgroup {
            Some(c) => kill_cgroup(c).map_err(|e| format!("git's cgroup {}: {e}", c.display())),
            None => Ok(()),
        };
        #[cfg(test)]
        if self.jail.fail_kills.load(std::sync::atomic::Ordering::SeqCst) {
            emptied = Err("a kill that failed, as a test asked".into());
        }
        self.net = None;
        match emptied {
            Ok(()) => {
                if let Some(lease) = self.lease.take() {
                    lease.release();
                }
            }
            Err(e) => {
                eprintln!("sandboxd: ALERT: {e}; the run's trees are taken out of use and its uid held until its cgroup is empty");
                self.stuck.store(true, std::sync::atomic::Ordering::SeqCst);
                if let Some(graveyard) = self.jail.graveyard.get() {
                    for tree in &self.trees {
                        bury(tree, graveyard);
                    }
                }
                if let Some(lease) = self.lease.take() {
                    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                    self.jail.stuck.lock().unwrap_or_else(|e| e.into_inner()).push(Held { uid: lease.uid, cgroup: self.cgroup.clone(), since });
                }
            }
        }
    }
}

/// Move a tree a run wrote (a mirror, a check's repo) into `graveyard`, one rename, O(1):
/// sandboxd never walks it to delete it. A jailed run empties it later
/// (Publisher::empty_graveyard). Nothing there: nothing to do.
pub(crate) fn bury(tree: &Path, graveyard: &Path) -> Option<PathBuf> {
    let mut id = [0u8; 16];
    let random = std::fs::File::open("/dev/urandom").and_then(|mut f| std::io::Read::read_exact(&mut f, &mut id));
    let name = if random.is_ok() { id.iter().map(|b| format!("{b:02x}")).collect::<String>() } else { format!("{}", std::process::id()) };
    let to = graveyard.join(name);
    let moved = std::fs::create_dir_all(graveyard).and_then(|()| std::fs::rename(tree, &to));
    match moved {
        Ok(()) => return Some(to),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("sandboxd: ALERT: couldn't move {} out of use ({e}); it stays where it is", tree.display()),
    }
    None
}

/// Make `dir` and everything in it owned by `uid` and `gid` (a run's are the same id),
/// without following a link. Run before every run, while nothing of a run is alive: the
/// files are the previous run's (another uid), or sandboxd's own (a bundle, a new mirror).
fn own(dir: &Path, uid: u32, gid: u32) -> std::io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    // The mirror's own directory is sandboxd's to name (its parent is root's); what is in it
    // is a run's, walked through mirrorfs, each entry chowned by name, a link as itself.
    let meta = std::fs::symlink_metadata(dir)?;
    if !meta.is_dir() {
        return Err(std::io::Error::other(format!("{} isn't a directory", dir.display())));
    }
    if meta.uid() != uid || meta.gid() != gid {
        std::os::unix::fs::lchown(dir, Some(uid), Some(gid))?;
    }
    let mut failed = None;
    crate::mirrorfs::Mirror::open(dir)?.walk(|_, at, name, st| {
        if (st.uid != uid || st.gid != gid) && failed.is_none() {
            if let Err(e) = crate::mirrorfs::chown_at(at, name, uid, gid) {
                failed = Some(e);
            }
        }
    })
    .map_err(|a| std::io::Error::other(a.to_string()))?;
    failed.map_or(Ok(()), Err)
}

fn cstr(p: &Path) -> Result<CString, String> {
    CString::new(p.as_os_str().as_bytes()).map_err(|_| format!("a NUL in {}", p.display()))
}

/// The mount flags of the file system `path` is on that a bind of it must keep (in a user
/// namespace they are locked: a remount that drops one is refused).
#[cfg(target_os = "linux")]
fn kept_flags(path: &Path) -> libc::c_ulong {
    // statvfs's ST_* bits; ST_RELATIME (4096) isn't in every libc's bindings.
    const ST_RELATIME: libc::c_ulong = 4096;
    let Ok(p) = cstr(path) else { return 0 };
    // SAFETY: statvfs writes into the struct it is given and reads a NUL-terminated path.
    let mut s: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(p.as_ptr(), &mut s) } != 0 {
        return 0;
    }
    #[allow(clippy::unnecessary_cast)]
    let f = s.f_flag as libc::c_ulong;
    let mut out = 0;
    for (st, ms) in [(libc::ST_RDONLY, libc::MS_RDONLY), (libc::ST_NOSUID, libc::MS_NOSUID), (libc::ST_NODEV, libc::MS_NODEV), (libc::ST_NOEXEC, libc::MS_NOEXEC), (libc::ST_NOATIME, libc::MS_NOATIME), (libc::ST_NODIRATIME, libc::MS_NODIRATIME), (ST_RELATIME, libc::MS_RELATIME)] {
        #[allow(clippy::unnecessary_cast)]
        if f & st as libc::c_ulong != 0 {
            out |= ms;
        }
    }
    out
}

/// A run's cgroup, new: one a crashed run left with the same name is killed and reused.
/// Its limits: tasks, and memory (`mem_max` bytes, no swap). At the memory limit the
/// kernel's OOM killer acts inside the run only, and kills all of it (memory.oom.group),
/// never sandboxd or a VM.
fn make_cgroup(path: &Path, mem_max: u64) -> Result<(), String> {
    match std::fs::create_dir(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => kill_cgroup(path).and_then(|()| std::fs::create_dir(path).map_err(|e| e.to_string())).map_err(|e| format!("git's cgroup {}: {e}", path.display()))?,
        Err(e) => return Err(format!("git's cgroup {}: {e}", path.display())),
    }
    let write = |file: &str, value: String| std::fs::write(path.join(file), value).map_err(|e| format!("{}/{file}: {e}", path.display()));
    write("pids.max", PIDS_MAX.to_string())?;
    write("memory.max", mem_max.to_string())?;
    write("memory.oom.group", "1".into())?;
    // Absent where the kernel doesn't account swap per cgroup (then there is no swap limit
    // to set); written wherever it is there.
    if let Err(e) = write("memory.swap.max", "0".into()) {
        if path.join("memory.swap.max").exists() {
            return Err(e);
        }
    }
    Ok(())
}

/// Kill everything in a cgroup (cgroup.kill: SIGKILL to every process, those that left
/// their process group included), wait until it is empty, and remove it.
fn kill_cgroup(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    std::fs::write(path.join("cgroup.kill"), "1").map_err(|e| format!("cgroup.kill: {e}"))?;
    let start = std::time::Instant::now();
    loop {
        let events = std::fs::read_to_string(path.join("cgroup.events")).unwrap_or_default();
        if events.lines().any(|l| l.trim() == "populated 0") {
            break;
        }
        if start.elapsed() > EMPTY_WAIT {
            return Err(format!("still populated {} s after cgroup.kill", EMPTY_WAIT.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    // An exited process leaves its cgroup a moment after it is gone.
    for _ in 0..200 {
        match std::fs::remove_dir(path) {
            Err(e) if e.raw_os_error() == Some(libc::EBUSY) => std::thread::sleep(Duration::from_millis(5)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            other => return other.map_err(|e| format!("rmdir: {e}")),
        }
    }
    Err("rmdir: still busy".into())
}

/// At start: what a previous sandboxd's runs left under `<unit>/git` killed and removed,
/// and the per-run cgroups checked to have what a run needs (cgroup.kill: Linux 5.14).
fn clear_cgroups(parent: &Path, mem_max: u64) -> Result<(), String> {
    for entry in std::fs::read_dir(parent).map_err(|e| format!("git's cgroup {}: {e}", parent.display()))?.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            kill_cgroup(&entry.path()).map_err(|e| format!("a previous run's git cgroup {}: {e}", entry.path().display()))?;
        }
    }
    let probe = parent.join("probe");
    let made = make_cgroup(&probe, mem_max);
    let has_kill = probe.join("cgroup.kill").exists();
    let _ = std::fs::remove_dir(&probe);
    made?;
    if !has_kill {
        return Err("this kernel has no cgroup.kill (Linux 5.14+): a git run couldn't be killed whole".into());
    }
    Ok(())
}

/// A network namespace with loopback up and a listener on it, for a run that talks to the
/// remote through sandboxd: the listener's socket lives in that namespace, sandboxd accepts
/// on it from its own, and the run joins it (setns). Made on a thread of its own, which is
/// all unshare(CLONE_NEWNET) moves.
#[cfg(target_os = "linux")]
pub fn proxied_netns() -> std::io::Result<(OwnedFd, std::net::TcpListener)> {
    std::thread::spawn(|| -> std::io::Result<(OwnedFd, std::net::TcpListener)> {
        use std::os::fd::FromRawFd;
        // SAFETY: plain system calls on this thread; the ifreq is zeroed and named.
        unsafe {
            if libc::unshare(libc::CLONE_NEWNET) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let sock = libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0);
            if sock < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let sock = OwnedFd::from_raw_fd(sock);
            let mut req: libc::ifreq = std::mem::zeroed();
            for (i, b) in b"lo".iter().enumerate() {
                req.ifr_name[i] = *b as libc::c_char;
            }
            req.ifr_ifru.ifru_flags = (libc::IFF_UP | libc::IFF_RUNNING) as libc::c_short;
            if libc::ioctl(sock.as_raw_fd(), libc::SIOCSIFFLAGS as _, &req) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            let ns = libc::open(c"/proc/thread-self/ns/net".as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC);
            if ns < 0 {
                return Err(std::io::Error::last_os_error());
            }
            let ns = OwnedFd::from_raw_fd(ns);
            let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
            Ok((ns, listener))
        }
    })
    .join()
    .map_err(|_| std::io::Error::other("the namespace thread panicked"))?
}

#[cfg(not(target_os = "linux"))]
pub fn proxied_netns() -> std::io::Result<(OwnedFd, std::net::TcpListener)> {
    Err(std::io::Error::other("network namespaces are Linux only"))
}

/// One step of a run's mount setup, its paths ready.
enum Op {
    Mkdir(CString),
    /// An empty file to bind a file or a device node onto.
    Touch(CString),
    /// A symbolic link: target, link.
    Symlink(CString, CString),
    /// A new file and what it holds.
    Write(CString, CString),
    Mount { src: Option<CString>, dst: CString, fstype: Option<CString>, flags: libc::c_ulong, data: Option<CString> },
}

impl Op {
    fn mount(src: Option<&OsStr>, dst: &Path, fstype: Option<&str>, flags: libc::c_ulong, data: Option<&str>) -> Result<Op, String> {
        let c = |s: &[u8]| CString::new(s).map_err(|_| "a NUL in a mount argument".to_string());
        Ok(Op::Mount {
            src: src.map(|s| c(s.as_bytes())).transpose()?,
            dst: cstr(dst)?,
            fstype: fstype.map(|s| c(s.as_bytes())).transpose()?,
            flags,
            data: data.map(|s| c(s.as_bytes())).transpose()?,
        })
    }
}

/// A run's whole setup, done in the child between fork and exec.
struct Plan {
    cgroup_procs: Option<CString>,
    root: CString,
    ops: Vec<Op>,
    /// The namespace to join; None: a new, empty one.
    netns: Option<RawFd>,
    /// None only in a test run in a user namespace, where only uid 0 is mapped.
    uid: Option<u32>,
    /// The remover's run (GitJail::remover): CAP_DAC_OVERRIDE and CAP_FOWNER kept, as
    /// ambient capabilities, through the uid change and the exec.
    keep_delete: bool,
}

// Steps, for the error a failed setup returns (step << 16 | errno): explain() reads it.
const STEPS: [&str; 15] = [
    "",
    "join the run's cgroup",
    "no core dumps",
    "new namespaces",
    "join the network namespace",
    "make mounts private",
    "enter the new root",
    "pivot_root",
    "detach the old root",
    "chdir /",
    "make the root read-only",
    "chdir /repo",
    "drop supplementary groups",
    "set the gid",
    "set the uid",
];
const STEP_CAPS: i32 = 15;
const STEP_OPS: i32 = 16;

#[cfg(target_os = "linux")]
impl Plan {
    /// Between fork and exec (pre_exec): only system calls, on memory made before the fork.
    fn enter(&self) -> std::io::Result<()> {
        use std::ptr::null;
        fn fail(step: i32) -> std::io::Error {
            let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
            std::io::Error::from_raw_os_error((step << 16) | (errno & 0xffff))
        }
        let ok = |rc: libc::c_long, step: i32| if rc < 0 { Err(fail(step)) } else { Ok(()) };
        let opt = |c: &Option<CString>| c.as_ref().map_or(null(), |c| c.as_ptr());
        // SAFETY: system calls only; every pointer is a NUL-terminated string or struct
        // owned by self, which outlives the calls.
        unsafe {
            if let Some(procs) = &self.cgroup_procs {
                let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                ok(fd as _, 1)?;
                let n = libc::write(fd, b"0".as_ptr().cast(), 1);
                libc::close(fd);
                ok(n as _, 1)?;
            }
            // The root's directories must be searchable by the run's uid: sandboxd's umask
            // (the unit's UMask=0077) would make them 0700. Restored before the exec.
            let umask = libc::umask(0o022);
            let none = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            ok(libc::setrlimit(libc::RLIMIT_CORE, &none) as _, 2)?;
            // Its own IPC namespace too: a SysV or POSIX IPC object outlives cgroup.kill, and a
            // later run with the same leased uid could attach to it.
            let flags = libc::CLONE_NEWNS | libc::CLONE_NEWIPC | if self.netns.is_none() { libc::CLONE_NEWNET } else { 0 };
            ok(libc::unshare(flags) as _, 3)?;
            if let Some(fd) = self.netns {
                ok(libc::setns(fd, libc::CLONE_NEWNET) as _, 4)?;
            }
            ok(libc::mount(null(), c"/".as_ptr(), null(), libc::MS_REC | libc::MS_PRIVATE, null()) as _, 5)?;
            for (i, op) in self.ops.iter().enumerate() {
                let step = STEP_OPS + i as i32;
                match op {
                    Op::Mkdir(p) => ok(libc::mkdir(p.as_ptr(), 0o755) as _, step)?,
                    Op::Touch(p) => {
                        let fd = libc::open(p.as_ptr(), libc::O_CREAT | libc::O_WRONLY | libc::O_CLOEXEC, 0o644);
                        ok(fd as _, step)?;
                        libc::close(fd);
                    }
                    Op::Symlink(target, link) => ok(libc::symlink(target.as_ptr(), link.as_ptr()) as _, step)?,
                    Op::Write(p, content) => {
                        let fd = libc::open(p.as_ptr(), libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_CLOEXEC, 0o644);
                        ok(fd as _, step)?;
                        let bytes = content.as_bytes();
                        let n = libc::write(fd, bytes.as_ptr().cast(), bytes.len());
                        libc::close(fd);
                        if n != bytes.len() as isize {
                            return Err(fail(step));
                        }
                    }
                    Op::Mount { src, dst, fstype, flags, data } => ok(libc::mount(opt(src), dst.as_ptr(), opt(fstype), *flags, opt(data).cast()) as _, step)?,
                }
            }
            ok(libc::chdir(self.root.as_ptr()) as _, 6)?;
            ok(libc::syscall(libc::SYS_pivot_root, c".".as_ptr(), c".".as_ptr()), 7)?;
            ok(libc::umount2(c".".as_ptr(), libc::MNT_DETACH) as _, 8)?;
            ok(libc::chdir(c"/".as_ptr()) as _, 9)?;
            let ro = libc::MS_REMOUNT | libc::MS_BIND | libc::MS_RDONLY | libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
            ok(libc::mount(null(), c"/".as_ptr(), null(), ro, null()) as _, 10)?;
            ok(libc::chdir(c"/repo".as_ptr()) as _, 11)?;
            libc::umask(umask);
            if self.keep_delete {
                ok(libc::prctl(libc::PR_SET_KEEPCAPS, 1, 0, 0, 0) as _, STEP_CAPS)?;
            }
            if let Some(uid) = self.uid {
                ok(libc::setgroups(0, null()) as _, 12)?;
                ok(libc::setresgid(uid, uid, uid) as _, 13)?;
                ok(libc::setresuid(uid, uid, uid) as _, 14)?;
            }
        }
        if self.keep_delete {
            return keep_only_delete().map_err(|_| fail(STEP_CAPS));
        }
        crate::jail::drop_capabilities().map_err(|_| fail(STEP_CAPS))
    }
}

/// For the remover, between fork and exec: of all capabilities only CAP_DAC_OVERRIDE and
/// CAP_FOWNER, permitted, effective, inheritable and ambient (so they survive the exec of
/// a file with none, as a non-root uid), and no_new_privs.
#[cfg(target_os = "linux")]
fn keep_only_delete() -> std::io::Result<()> {
    #[repr(C)]
    struct Header {
        version: u32,
        pid: libc::c_int,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Data {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    const CAP_DAC_OVERRIDE: u32 = 1;
    const CAP_FOWNER: u32 = 3;
    let mask = (1 << CAP_DAC_OVERRIDE) | (1 << CAP_FOWNER);
    let mut header = Header { version: 0x2008_0522, pid: 0 };
    let data = [Data { effective: mask, permitted: mask, inheritable: mask }, Data { effective: 0, permitted: 0, inheritable: 0 }];
    // SAFETY: plain system calls on this process, capset's version-3 layout.
    unsafe {
        if libc::syscall(libc::SYS_capset, &mut header as *mut Header, data.as_ptr()) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        for cap in [CAP_DAC_OVERRIDE, CAP_FOWNER] {
            if libc::prctl(libc::PR_CAP_AMBIENT, libc::PR_CAP_AMBIENT_RAISE, cap as libc::c_ulong, 0, 0) != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
impl Plan {
    fn enter(&self) -> std::io::Result<()> {
        let _ = (&self.cgroup_procs, &self.root, &self.ops, self.netns, self.uid, self.keep_delete);
        Err(std::io::Error::other("git isolation is Linux only"))
    }
}

/// A spawn error, with the setup step that failed when it was one (Plan::enter).
pub fn explain(e: &std::io::Error) -> String {
    match e.raw_os_error() {
        Some(code) if code >> 16 > 0 => {
            let (step, errno) = (code >> 16, code & 0xffff);
            let what = match step {
                STEP_CAPS => "drop capabilities".to_string(),
                s if s >= STEP_OPS => format!("mount setup step {}", s - STEP_OPS),
                s => STEPS.get(s as usize).copied().unwrap_or("?").to_string(),
            };
            format!("isolating git ({what}): {}", std::io::Error::from_raw_os_error(errno))
        }
        _ => format!("git: {e}"),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn a_runs_cgroup_caps_its_memory_with_no_swap_and_is_killed_whole_on_oom() {
        // A plain directory standing in for the cgroup: what make_cgroup writes there.
        let dir = std::env::temp_dir().join(format!("gitjail-cg-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = dir.join("u1");
        make_cgroup(&run, 1536 << 20).unwrap();
        let read = |f: &str| std::fs::read_to_string(run.join(f)).unwrap();
        assert_eq!(read("pids.max"), PIDS_MAX.to_string());
        assert_eq!(read("memory.max"), (1536u64 << 20).to_string());
        assert_eq!(read("memory.swap.max"), "0");
        assert_eq!(read("memory.oom.group"), "1");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_setup_error_names_its_step() {
        let e = std::io::Error::from_raw_os_error((7 << 16) | libc::EPERM);
        assert!(explain(&e).contains("pivot_root"), "{}", explain(&e));
        let e = std::io::Error::from_raw_os_error((STEP_OPS + 3) << 16 | libc::ENOENT);
        assert!(explain(&e).contains("mount setup step 3"), "{}", explain(&e));
        assert_eq!(explain(&std::io::Error::from_raw_os_error(libc::ENOENT)), format!("git: {}", std::io::Error::from_raw_os_error(libc::ENOENT)));
    }

    /// Run one ignored test (its full path) in a user namespace where the test is root with
    /// every capability, as sandboxd is: it must pass there. With `more_ids`, ids 1..65536
    /// are mapped too (`--map-auto`: the user's subuids), so the test can chown to another
    /// id. Skipped where unprivileged user namespaces (or subuids) aren't available.
    #[cfg(target_os = "linux")]
    pub(crate) fn in_userns(test: &str, more_ids: bool) {
        userns_run("unshare", test, more_ids, std::env::var_os("SANDBOXD_REQUIRE_USERNS").is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_required_user_namespace_test_fails_rather_than_skips_without_unshare() {
        let missing = || userns_run("/nonexistent/unshare", "gitjail::tests::own_in_userns", false, true);
        assert!(std::panic::catch_unwind(missing).is_err(), "required, with no unshare(1), it passed");
        // Not required: said aloud, and skipped.
        userns_run("/nonexistent/unshare", "gitjail::tests::own_in_userns", false, false);
    }

    /// in_userns, with `unshare` as `program`; `require`: a skip is a failure.
    #[cfg(target_os = "linux")]
    fn userns_run(program: &str, test: &str, more_ids: bool, require: bool) {
        let me = std::env::current_exe().unwrap();
        let mut cmd = std::process::Command::new(program);
        cmd.arg("--user").arg("--map-root-user");
        if more_ids {
            cmd.arg("--map-auto");
        }
        let Ok(out) = cmd.arg(&me).args([test, "--exact", "--ignored", "--nocapture"]).output() else {
            eprintln!("NOTE: {test} skipped: no unshare(1)");
            assert!(!require, "{test} skipped (no unshare(1)), but SANDBOXD_REQUIRE_USERNS is set");
            return;
        };
        let stderr = String::from_utf8_lossy(&out.stderr);
        // Hosts that forbid unprivileged user namespaces (Ubuntu's AppArmor default), or
        // have no subuids for --map-auto: the inner test never started.
        if stderr.starts_with("unshare:") {
            eprintln!("NOTE: {test} skipped: {}", stderr.trim());
            assert!(!require, "{test} skipped, but SANDBOXD_REQUIRE_USERNS is set: {}", stderr.trim());
            return;
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success() && stdout.contains("1 passed"), "{stdout}\n{stderr}");
        // The inner test can still skip (a user namespace without capabilities, as on
        // Ubuntu's runners): said aloud, and a failure where SANDBOXD_REQUIRE_USERNS is set
        // (starship), so a host that can run it never passes it silently.
        if let Some(line) = stdout.lines().chain(stderr.lines()).find(|l| l.starts_with("skipped:")) {
            eprintln!("NOTE: {test} skipped inside its user namespace: {line}");
            assert!(!require, "{test} skipped, but SANDBOXD_REQUIRE_USERNS is set: {line}");
        }
    }

    /// A git on PATH that is a link into /usr (a /opt/bin/git, a Nix profile's): the run
    /// execs where it leads, which is inside the run's root; the link itself isn't.
    #[cfg(target_os = "linux")]
    #[test]
    fn a_linked_git_on_path_is_run_by_where_it_leads() {
        let Some(real) = crate::jail::resolve(Path::new("git")).and_then(|g| std::fs::canonicalize(g).ok()).filter(|g| g.starts_with("/usr")) else {
            eprintln!("skipped: no git under /usr here");
            return;
        };
        let tmp = std::env::temp_dir().join(format!("gitjail-link-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("bin")).unwrap();
        std::os::unix::fs::symlink(&real, tmp.join("bin/git")).unwrap();
        let jail = GitJail::with_git(&tmp.join("state"), &tmp.join("bin/git")).unwrap();
        assert_eq!(jail.git, real);
        std::fs::remove_dir_all(&tmp).unwrap();
        in_userns("gitjail::tests::linked_git_in_userns", false);
    }

    /// The probe run, with git found through a link outside what the run sees.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "run by a_linked_git_on_path_is_run_by_where_it_leads, in a user namespace"]
    async fn linked_git_in_userns() {
        let tmp = std::env::temp_dir().join(format!("gitjail-link-{}", std::process::id()));
        std::fs::create_dir_all(tmp.join("bin")).unwrap();
        let real = std::fs::canonicalize(crate::jail::resolve(Path::new("git")).unwrap()).unwrap();
        std::os::unix::fs::symlink(&real, tmp.join("bin/git")).unwrap();
        let jail = Arc::new(GitJail::with_git(&tmp.join("state"), &tmp.join("bin/git")).unwrap());
        let version = jail.probe(&tmp.join("probe")).await;
        std::fs::remove_dir_all(&tmp).unwrap();
        assert!(version.as_deref().is_ok_and(|v| v.starts_with("git version")), "{version:?}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_mirror_is_given_to_the_runs_uid_without_following_links() {
        in_userns("gitjail::tests::own_in_userns", true);
    }

    /// A jail for tests in a user namespace with subuids: these uids, no cgroups.
    pub(crate) fn with_uids(state: &Path, uids: Vec<u32>) -> Arc<GitJail> {
        let mut jail = GitJail::unprivileged(state).unwrap();
        let n = uids.len();
        jail.uids = Some(Pool { size: n, free: Mutex::new(uids), available: tokio::sync::Semaphore::new(n) });
        Arc::new(jail)
    }

    impl GitJail {
        pub(crate) fn fail_kills(&self, on: bool) {
            self.fail_kills.store(on, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) fn keep_stuck(&self, on: bool) {
            self.keep_stuck.store(on, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) fn free_uids(&self) -> usize {
            self.uids.as_ref().map_or(0, |p| p.free.lock().unwrap().len())
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_dropped_tree_is_emptied_by_a_jailed_run_never_by_sandboxd() {
        in_userns("gitjail::tests::remover_in_userns", true);
    }

    /// The remover, as root in a user namespace with ids 1..65536 mapped: its run is a leased
    /// uid (100) that owns nothing of the tree, which belongs to ids 5 and 6, with a
    /// directory no one may read and a sticky one. Its links point at what the run does see,
    /// /usr/lib and /etc/ld.so.cache (read-only there: a remover that followed one would
    /// fail on it), and at a host file it doesn't. The tree is emptied, every link as a link,
    /// and the run had exactly CAP_DAC_OVERRIDE and CAP_FOWNER, as seen from outside it.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    #[ignore = "run by a_dropped_tree_is_emptied_by_a_jailed_run_never_by_sandboxd, in a user namespace"]
    async fn remover_in_userns() {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(unsafe { libc::geteuid() }, 0, "root in the user namespace");
        let top = std::env::temp_dir().join(format!("gitjail-remover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        let (tree, host) = (top.join("drop/x"), top.join("host"));
        std::fs::create_dir_all(tree.join("objects/locked")).unwrap();
        std::fs::create_dir_all(tree.join("refs/sticky")).unwrap();
        std::fs::create_dir_all(&host).unwrap();
        std::fs::write(host.join("keep"), b"host").unwrap();
        std::fs::write(tree.join("objects/locked/a"), b"a").unwrap();
        std::fs::write(tree.join("refs/sticky/b"), b"b").unwrap();
        std::os::unix::fs::symlink(host.join("keep"), tree.join("link")).unwrap();
        std::os::unix::fs::symlink("/usr/lib", tree.join("usr-link")).unwrap();
        std::os::unix::fs::symlink("/etc/ld.so.cache", tree.join("objects/cache-link")).unwrap();
        let probe = top.join("probe");
        std::fs::write(&probe, b"").unwrap();
        if std::os::unix::fs::lchown(&probe, Some(5), Some(5)).is_err() {
            eprintln!("skipped: this user namespace may not chown");
            std::fs::remove_dir_all(&top).unwrap();
            return;
        }
        for p in ["", "objects", "objects/locked", "objects/locked/a", "refs", "refs/sticky", "link", "usr-link", "objects/cache-link"] {
            std::os::unix::fs::lchown(tree.join(p), Some(5), Some(5)).unwrap();
        }
        std::os::unix::fs::lchown(tree.join("refs/sticky/b"), Some(6), Some(6)).unwrap();
        std::fs::set_permissions(tree.join("refs/sticky"), std::fs::Permissions::from_mode(0o1777)).unwrap();
        std::fs::set_permissions(tree.join("objects/locked"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let jail = with_uids(&top.join("state"), vec![100]);
        // Its capabilities, read from outside while it waits (there is no /proc inside).
        let (mut cmd, confined) = jail.remover(&tree, Default::default()).await.unwrap();
        let mut waiting = cmd.args([REPO, "-maxdepth", "0", "-exec", "sleep", "2", ";"]).spawn().unwrap();
        let mut caps = None;
        for _ in 0..300 {
            for entry in std::fs::read_dir("/proc").unwrap().flatten() {
                let Ok(status) = std::fs::read_to_string(entry.path().join("status")) else { continue };
                let field = |k: &str| status.lines().find_map(|l| l.strip_prefix(k)).map(|v| v.trim().to_string()).unwrap_or_default();
                if field("Uid:").starts_with("100\t") {
                    caps = Some((field("CapEff:"), field("CapPrm:"), field("CapAmb:"), field("NoNewPrivs:")));
                }
            }
            if caps.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        waiting.wait().await.unwrap();
        drop(confined);
        let mask = "000000000000000a".to_string(); // CAP_DAC_OVERRIDE (1) | CAP_FOWNER (3)
        assert_eq!(caps, Some((mask.clone(), mask.clone(), mask, "1".to_string())), "the remover's capabilities");
        // The removal itself, as Git::empty runs it.
        let (mut cmd, confined) = jail.remover(&tree, Default::default()).await.unwrap();
        let out = cmd.args(REMOVE_ARGS).output().await.unwrap();
        drop(confined);
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_dir(&tree).unwrap().count(), 0, "the tree wasn't emptied");
        assert_eq!(std::fs::read(host.join("keep")).unwrap(), b"host");
        std::fs::remove_dir_all(&top).unwrap();
    }

    /// own() as root, giving a mirror to id 1: every entry, links included, becomes id 1's,
    /// and nothing a link points at (a file, a directory, what is in that directory) changes
    /// or is walked into.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "run by a_mirror_is_given_to_the_runs_uid_without_following_links, in a user namespace"]
    fn own_in_userns() {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(unsafe { libc::geteuid() }, 0, "root in the user namespace");
        let top = std::env::temp_dir().join(format!("gitjail-own-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        let (mirror, outside) = (top.join("mirror.git"), top.join("outside"));
        std::fs::create_dir_all(mirror.join("objects/ab")).unwrap();
        std::fs::write(mirror.join("objects/ab/cd"), b"x").unwrap();
        std::fs::create_dir_all(outside.join("dir")).unwrap();
        std::fs::write(outside.join("file"), b"host").unwrap();
        std::fs::write(outside.join("dir/inner"), b"host").unwrap();
        std::os::unix::fs::symlink(outside.join("file"), mirror.join("link-to-file")).unwrap();
        std::os::unix::fs::symlink(outside.join("dir"), mirror.join("objects/link-to-dir")).unwrap();
        // Ubuntu's AppArmor lets newuidmap map the ids but denies a user namespace its
        // capabilities: nothing to check there.
        let probe = top.join("probe");
        std::fs::write(&probe, b"").unwrap();
        if std::os::unix::fs::lchown(&probe, Some(1), Some(1)).is_err_and(|e| e.raw_os_error() == Some(libc::EPERM)) {
            eprintln!("skipped: this user namespace may not chown");
            std::fs::remove_dir_all(&top).unwrap();
            return;
        }
        own(&mirror, 1, 1).unwrap();
        let ids = |p: &Path| {
            let m = std::fs::symlink_metadata(p).unwrap();
            (m.uid(), m.gid())
        };
        for p in ["", "objects", "objects/ab", "objects/ab/cd", "link-to-file", "objects/link-to-dir"] {
            assert_eq!(ids(&mirror.join(p)), (1, 1), "{p}");
        }
        for p in ["file", "dir", "dir/inner"] {
            assert_eq!(ids(&outside.join(p)), (0, 0), "{p}, outside the mirror, changed owner");
        }
        // A file isn't a mirror.
        assert!(own(&mirror.join("objects/ab/cd"), 1, 1).is_err());
        std::fs::remove_dir_all(&top).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_run_sees_usr_and_its_mirror_and_nothing_else_of_the_host() {
        // A build sandbox (Nix's) may have no /usr: then there is no plan to look at.
        if !Path::new("/usr/bin").is_dir() {
            eprintln!("skipped: no /usr here");
            return;
        }
        let tmp = std::env::temp_dir().join(format!("gitjail-plan-{}", std::process::id()));
        let jail = GitJail::unprivileged(&tmp).unwrap();
        let plan = jail.plan(Path::new("/var/lib/x/.mirrors/acme/w.git"), Some(1_900_100_000), Some(Path::new("/sys/fs/cgroup/s/git/u1")), None, None, true).unwrap();
        let root = jail.mountpoint.to_string_lossy().into_owned();
        let mut sources = Vec::new();
        let mut targets = Vec::new();
        for op in &plan.ops {
            if let Op::Mount { src: Some(s), dst, flags, .. } = op {
                if flags & libc::MS_BIND != 0 {
                    sources.push(s.to_string_lossy().into_owned());
                    targets.push(dst.to_string_lossy().trim_start_matches(&root).to_string());
                }
            }
        }
        assert!(sources.contains(&"/usr".to_string()), "{sources:?}");
        assert!(sources.contains(&"/var/lib/x/.mirrors/acme/w.git".to_string()));
        assert!(targets.contains(&"/repo".to_string()));
        // Nothing from /etc but the linker's cache, nothing from /run, /proc, /sys, /home.
        for s in &sources {
            let allowed = s == "/usr" || s == "/nix/store" || s == "/etc/ld.so.cache" || s.starts_with("/dev/") || s.starts_with("/var/lib/x/.mirrors/acme/w.git") || TOP.iter().any(|t| s == &format!("/{t}"));
            assert!(allowed, "{s} goes into a run");
        }
        // Every bind of the host but the mirror and the devices is remounted read-only.
        let ro: Vec<String> = plan.ops.iter().filter_map(|op| match op { Op::Mount { src: None, dst, flags, .. } if flags & libc::MS_REMOUNT != 0 && flags & libc::MS_RDONLY != 0 => Some(dst.to_string_lossy().trim_start_matches(&root).to_string()), _ => None }).collect();
        assert!(ro.contains(&"/usr".to_string()), "{ro:?}");
        assert!(!ro.contains(&"/repo".to_string()));
        assert_eq!(plan.uid, Some(1_900_100_000));
        assert_eq!(plan.cgroup_procs.as_deref().map(|c| c.to_string_lossy().into_owned()).as_deref(), Some("/sys/fs/cgroup/s/git/u1/cgroup.procs"));
        // No network namespace given: the run makes an empty one.
        assert!(plan.netns.is_none());
        // The remover's run gets no device node of the host's, and keeps its capabilities.
        let remover = jail.plan_for(Path::new("/var/lib/x/.mirrors/.drop/t"), Some(1_900_100_000), None, None, None, true).unwrap();
        let devices: Vec<String> = remover.ops.iter().filter_map(|op| match op { Op::Mount { src: Some(s), .. } if s.to_string_lossy().starts_with("/dev") => Some(s.to_string_lossy().into_owned()), _ => None }).collect();
        assert!(devices.is_empty(), "{devices:?}");
        assert!(remover.keep_delete);
        assert!(!plan.keep_delete);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
