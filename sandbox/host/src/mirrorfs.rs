//! How sandboxd (root, outside any jail) reads a publishing mirror: never leaving it, never
//! through a link.
//!
//! A mirror's contents are written by its git runs, an untrusted uid (gitjail.rs). sandboxd
//! touches a mirror only while no run of it is alive (under the mirror's lock; a run's
//! cgroup is killed before the lock is released), so nothing changes underneath, but what a
//! run left may be planted anywhere in it: a link (as the file, or as a directory on the way
//! to it), a FIFO no one writes, a file of any size.
//!
//! So every read of a mirror's content goes through a `Mirror`: an `O_PATH` handle to its
//! root, and paths resolved under it by openat2 with `RESOLVE_BENEATH |
//! RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS` (Linux 5.6+), or, where openat2 doesn't
//! exist, one component at a time with `openat(O_NOFOLLOW)`. A file is opened
//! `O_NONBLOCK`, must be a regular file by fstat, and is read up to a cap. Walks open each
//! directory from its parent's handle the same way and act on entries by name
//! (fstatat/unlinkat/fchownat with no-follow), so a link is seen as a link and never
//! entered. Any other failure of a single read is "not there".
//!
//! **A mirror is a cache of GitHub: host traversal is bounded, and any anomaly drops it.**
//! Walks and listings stream entries (never a whole listing in memory), hold one open
//! directory per level of depth, and stop at caps on entries per directory, entries in all,
//! depth and bytes (`Caps`). Going past a cap, or any error on the way (a directory that
//! can't be opened or read, an entry that can't be looked at), is an `Anomaly`: never a
//! partial answer. Callers drop the mirror on one (publish.rs).

use std::ffi::{CString, OsStr, OsString};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// How far a walk of a mirror may go before it is an anomaly.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Caps {
    /// Entries in one directory (a git directory holds a few hundred; loose objects at
    /// most 256 fan-out directories of a few thousand, loose refs as many as a repo has).
    pub per_dir: u64,
    /// Entries in all (SANDBOXD_MIRROR_MAX_ENTRIES).
    pub entries: u64,
    /// Directories deep (a ref name is at most 200 bytes, so at most 100 components).
    pub depth: usize,
    /// Bytes of the files seen (twice the mirror's own quota: one over its quota is
    /// refused as that, not as an anomaly).
    pub bytes: u64,
}

impl Default for Caps {
    fn default() -> Caps {
        Caps { per_dir: 262_144, entries: 1_000_000, depth: 128, bytes: 8 << 30 }
    }
}

static CAPS: std::sync::OnceLock<Caps> = std::sync::OnceLock::new();

/// The caps every Mirror::open gets, set once at start from the configuration.
pub fn set_caps(caps: Caps) {
    let _ = CAPS.set(caps);
}

/// What made a walk stop short: the mirror can't be trusted to be what git left.
#[derive(Debug, Clone, PartialEq)]
pub struct Anomaly(pub String);

impl std::fmt::Display for Anomaly {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// A mirror's root, held open.
pub struct Mirror {
    root: OwnedFd,
    caps: Caps,
}

/// What an entry is, without following it.
pub struct Stat {
    pub kind: Kind,
    pub len: u64,
    pub mtime: i64,
    pub uid: u32,
    pub gid: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    File,
    Dir,
    /// A link, a FIFO, a socket, a device.
    Other,
}

fn errno() -> std::io::Error {
    std::io::Error::last_os_error()
}

fn c(name: &OsStr) -> std::io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))
}

#[cfg(target_os = "linux")]
fn openat2_beneath(root: BorrowedFd, rel: &CString, flags: libc::c_int) -> std::io::Result<OwnedFd> {
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_BENEATH: u64 = 0x08;
    let how = OpenHow { flags: (flags | libc::O_CLOEXEC) as u64, mode: 0, resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS };
    // SAFETY: the path is NUL-terminated and how is open_how's layout (version 0, 24 bytes).
    let fd = unsafe { libc::syscall(libc::SYS_openat2, root.as_raw_fd(), rel.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>()) };
    if fd < 0 {
        return Err(errno());
    }
    // SAFETY: a new descriptor of ours.
    Ok(unsafe { OwnedFd::from_raw_fd(fd as libc::c_int) })
}

#[cfg(not(target_os = "linux"))]
fn openat2_beneath(_: BorrowedFd, _: &CString, _: libc::c_int) -> std::io::Result<OwnedFd> {
    Err(std::io::Error::from_raw_os_error(libc::ENOSYS))
}

fn openat(dir: BorrowedFd, name: &CString, flags: libc::c_int) -> std::io::Result<OwnedFd> {
    // SAFETY: a NUL-terminated name relative to a descriptor we hold.
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 {
        return Err(errno());
    }
    // SAFETY: a new descriptor of ours.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
const O_PATH: libc::c_int = libc::O_PATH;
#[cfg(not(target_os = "linux"))]
const O_PATH: libc::c_int = 0;

fn stat_of(st: &libc::stat) -> Stat {
    let kind = match st.st_mode & libc::S_IFMT {
        libc::S_IFREG => Kind::File,
        libc::S_IFDIR => Kind::Dir,
        _ => Kind::Other,
    };
    #[allow(clippy::unnecessary_cast)]
    Stat { kind, len: st.st_size as u64, mtime: st.st_mtime as i64, uid: st.st_uid, gid: st.st_gid }
}

fn fstat(fd: BorrowedFd) -> std::io::Result<Stat> {
    // SAFETY: fstat writes into the struct it is given.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd.as_raw_fd(), &mut st) } != 0 {
        return Err(errno());
    }
    Ok(stat_of(&st))
}

/// An entry of directory `dir`, by name, without following it.
pub fn stat_at(dir: BorrowedFd, name: &OsStr) -> std::io::Result<Stat> {
    let name = c(name)?;
    // SAFETY: as fstat; the name is NUL-terminated.
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatat(dir.as_raw_fd(), name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(errno());
    }
    Ok(stat_of(&st))
}

/// Remove a file (or link, or FIFO) of `dir` by name: the entry itself, never what it names.
pub fn unlink_at(dir: BorrowedFd, name: &OsStr) -> std::io::Result<()> {
    let name = c(name)?;
    // SAFETY: a NUL-terminated name relative to a descriptor we hold.
    if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(errno());
    }
    Ok(())
}

/// Give an entry of `dir`, by name, to `uid`/`gid`: the entry itself, a link included.
pub fn chown_at(dir: BorrowedFd, name: &OsStr, uid: u32, gid: u32) -> std::io::Result<()> {
    let name = c(name)?;
    // SAFETY: as unlink_at.
    if unsafe { libc::fchownat(dir.as_raw_fd(), name.as_ptr(), uid, gid, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
        return Err(errno());
    }
    Ok(())
}

#[cfg(target_os = "linux")]
unsafe fn errno_location() -> *mut libc::c_int {
    libc::__errno_location()
}

#[cfg(not(target_os = "linux"))]
unsafe fn errno_location() -> *mut libc::c_int {
    libc::__error()
}

/// A directory being read, one entry at a time: its one descriptor is the stream's.
struct Listing {
    dir: *mut libc::DIR,
}

impl Listing {
    /// `fd` (a directory opened O_RDONLY) as a stream; the stream owns it.
    fn new(fd: OwnedFd) -> std::io::Result<Listing> {
        use std::os::fd::IntoRawFd;
        let raw = fd.into_raw_fd();
        // SAFETY: fdopendir takes ownership of raw on success; on failure it is ours to close.
        let dir = unsafe { libc::fdopendir(raw) };
        if dir.is_null() {
            let e = errno();
            unsafe { libc::close(raw) };
            return Err(e);
        }
        Ok(Listing { dir })
    }

    fn fd(&self) -> BorrowedFd<'_> {
        // SAFETY: the stream's descriptor, valid while it is open (as long as self).
        unsafe { BorrowedFd::borrow_raw(libc::dirfd(self.dir)) }
    }

    /// The next name (not `.` or `..`), None at the end, or the error readdir gave.
    fn next(&mut self) -> Option<std::io::Result<OsString>> {
        loop {
            // SAFETY: errno is cleared first so that a null return is told apart (end or
            // error); the entry is read before the next readdir.
            unsafe {
                *errno_location() = 0;
                let entry = libc::readdir(self.dir);
                if entry.is_null() {
                    let e = *errno_location();
                    return (e != 0).then(|| Err(std::io::Error::from_raw_os_error(e)));
                }
                let name = std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()).to_bytes();
                if name != b"." && name != b".." {
                    return Some(Ok(OsStr::from_bytes(name).to_os_string()));
                }
            }
        }
    }
}

impl Drop for Listing {
    fn drop(&mut self) {
        // SAFETY: the stream we opened, closed once.
        unsafe { libc::closedir(self.dir) };
    }
}

impl Mirror {
    /// The mirror whose directory is `dir` (sandboxd's own: `<mirrors>/<owner>/<name>.git`,
    /// under directories only root writes). Not a link.
    pub fn open(dir: &Path) -> std::io::Result<Mirror> {
        Mirror::open_with(dir, CAPS.get().copied().unwrap_or_default())
    }

    /// open(), with these caps.
    pub fn open_with(dir: &Path, caps: Caps) -> std::io::Result<Mirror> {
        let path = CString::new(dir.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
        // SAFETY: a NUL-terminated path.
        let fd = unsafe { libc::open(path.as_ptr(), O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(errno());
        }
        // SAFETY: a new descriptor of ours.
        Ok(Mirror { root: unsafe { OwnedFd::from_raw_fd(fd) }, caps })
    }

    /// `rel` (plain names joined by `/`) opened under the root, never leaving it, never
    /// through a link (the last component included: with `O_PATH`, a link is opened as
    /// itself).
    fn at(&self, rel: &str, flags: libc::c_int) -> std::io::Result<OwnedFd> {
        self.resolve(rel, flags, true)
    }

    fn resolve(&self, rel: &str, flags: libc::c_int, openat2: bool) -> std::io::Result<OwnedFd> {
        let parts: Vec<&str> = rel.split('/').collect();
        if rel.is_empty() || parts.iter().any(|p| p.is_empty() || *p == "." || *p == "..") {
            return Err(std::io::Error::from_raw_os_error(libc::EINVAL));
        }
        let crel = CString::new(rel).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
        if openat2 {
            match openat2_beneath(self.root.as_fd_borrowed(), &crel, flags | libc::O_NOFOLLOW) {
                // No openat2 (Linux < 5.6, or a seccomp filter that refuses it with EPERM,
                // which resolving a path never returns): the walk below, as safe. Any other
                // error is the answer.
                Err(e) if matches!(e.raw_os_error(), Some(libc::ENOSYS) | Some(libc::EPERM)) => {}
                other => return other,
            }
        }
        // Before Linux 5.6: one component at a time, each a real directory.
        let mut dir = openat(self.root.as_fd_borrowed(), &CString::new(".").unwrap_or_default(), O_PATH | libc::O_DIRECTORY)?;
        for (i, part) in parts.iter().enumerate() {
            let name = CString::new(*part).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
            let last = i + 1 == parts.len();
            dir = openat(dir.as_fd_borrowed(), &name, if last { flags } else { O_PATH | libc::O_DIRECTORY })?;
        }
        Ok(dir)
    }

    /// Whether `rel` is there (as anything, a link included).
    pub fn exists(&self, rel: &str) -> bool {
        self.at(rel, O_PATH).is_ok()
    }

    /// What `rel` is, without following it.
    pub fn stat(&self, rel: &str) -> Option<Stat> {
        fstat(self.at(rel, O_PATH).ok()?.as_fd_borrowed()).ok()
    }

    /// The bytes of regular file `rel`, if it is one of at most `cap` bytes.
    pub fn read(&self, rel: &str, cap: u64) -> Option<Vec<u8>> {
        use std::io::Read;
        let fd = self.at(rel, libc::O_RDONLY | libc::O_NONBLOCK).ok()?;
        let st = fstat(fd.as_fd_borrowed()).ok()?;
        if st.kind != Kind::File || st.len > cap {
            return None;
        }
        let mut out = Vec::new();
        std::fs::File::from(fd).take(cap + 1).read_to_end(&mut out).ok()?;
        (out.len() as u64 <= cap).then_some(out)
    }

    /// How many entries directory `rel` has: None if it isn't there or isn't a real
    /// directory, an anomaly past the per-directory cap or if it can't be read through.
    pub fn count(&self, rel: &str) -> Result<Option<u64>, Anomaly> {
        let Ok(fd) = self.at(rel, libc::O_RDONLY | libc::O_DIRECTORY) else { return Ok(None) };
        let mut listing = Listing::new(fd).map_err(|e| Anomaly(format!("{rel}: {e}")))?;
        let mut n = 0;
        while let Some(name) = listing.next() {
            name.map_err(|e| Anomaly(format!("{rel}: {e}")))?;
            n += 1;
            if n > self.caps.per_dir {
                return Err(Anomaly(format!("{rel} holds more than {} entries", self.caps.per_dir)));
            }
        }
        Ok(Some(n))
    }

    /// Every entry under the root, depth first, as `f(directory's path relative to the root,
    /// its handle, entry name, what the entry is)`, streamed: one open directory per level,
    /// nothing listed whole. Only real directories are entered, each opened from its
    /// parent's handle without following a link. An entry `f` removes is gone before the
    /// walk would enter it. Past a cap, or on any error, it stops: an anomaly.
    pub fn walk(&self, mut f: impl FnMut(&Path, BorrowedFd, &OsStr, &Stat)) -> Result<(), Anomaly> {
        let caps = self.caps;
        let top = openat(self.root.as_fd_borrowed(), &CString::new(".").unwrap_or_default(), libc::O_RDONLY | libc::O_DIRECTORY).map_err(|e| Anomaly(format!("the mirror: {e}")))?;
        let mut stack: Vec<(PathBuf, Listing, u64)> = vec![(PathBuf::new(), Listing::new(top).map_err(|e| Anomaly(format!("the mirror: {e}")))?, 0)];
        let (mut entries, mut bytes) = (0u64, 0u64);
        loop {
            let level = stack.len();
            let Some((rel, listing, here)) = stack.last_mut() else { break };
            let name = match listing.next() {
                None => {
                    stack.pop();
                    continue;
                }
                Some(Err(e)) => return Err(Anomaly(format!("{}: {e}", rel.display()))),
                Some(Ok(name)) => name,
            };
            *here += 1;
            entries += 1;
            if *here > caps.per_dir {
                return Err(Anomaly(format!("{} holds more than {} entries", rel.display(), caps.per_dir)));
            }
            if entries > caps.entries {
                return Err(Anomaly(format!("the mirror holds more than {} entries", caps.entries)));
            }
            let at = listing.fd();
            let st = stat_at(at, &name).map_err(|e| Anomaly(format!("{}: {e}", rel.join(&name).display())))?;
            if st.kind == Kind::File {
                bytes += st.len;
                if bytes > caps.bytes {
                    return Err(Anomaly(format!("the mirror's files come to more than {} bytes", caps.bytes)));
                }
            }
            f(rel, at, &name, &st);
            if st.kind == Kind::Dir {
                let path = rel.join(&name);
                if level >= caps.depth {
                    return Err(Anomaly(format!("{} is more than {} directories deep", path.display(), caps.depth)));
                }
                let cname = c(&name).map_err(|e| Anomaly(format!("{}: {e}", path.display())))?;
                let sub = openat(at, &cname, libc::O_RDONLY | libc::O_DIRECTORY).map_err(|e| Anomaly(format!("{}: {e}", path.display())))?;
                let sub = Listing::new(sub).map_err(|e| Anomaly(format!("{}: {e}", path.display())))?;
                stack.push((path, sub, 0));
            }
        }
        Ok(())
    }
}

/// `as_fd` under a name that doesn't need the AsFd trait in scope.
trait Borrow {
    fn as_fd_borrowed(&self) -> BorrowedFd<'_>;
}

impl Borrow for OwnedFd {
    fn as_fd_borrowed(&self) -> BorrowedFd<'_> {
        use std::os::fd::AsFd;
        self.as_fd()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let top = std::env::temp_dir().join(format!("mirrorfs-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&top);
        let (mirror, host) = (top.join("m.git"), top.join("host"));
        std::fs::create_dir_all(mirror.join("refs/stage")).unwrap();
        std::fs::create_dir_all(host.join("stage")).unwrap();
        std::fs::write(host.join("stage/x"), b"").unwrap();
        std::fs::write(host.join("secret"), b"host").unwrap();
        (top, mirror, host)
    }

    #[test]
    fn without_openat2_a_path_is_resolved_a_component_at_a_time_with_the_same_answers() {
        let (top, mirror, host) = tree("walk");
        std::fs::write(mirror.join("HEAD"), b"x").unwrap();
        std::os::unix::fs::symlink(&host, mirror.join("objects")).unwrap();
        let m = Mirror::open(&mirror).unwrap();
        for openat2 in [true, false] {
            assert!(m.resolve("HEAD", libc::O_RDONLY, openat2).is_ok(), "{openat2}");
            assert!(m.resolve("objects/secret", libc::O_RDONLY, openat2).is_err(), "{openat2}");
            assert!(m.resolve("objects", libc::O_RDONLY, openat2).is_err(), "{openat2}");
            assert!(m.resolve("objects", O_PATH, openat2).is_ok(), "a link, as itself: {openat2}");
            assert!(m.resolve("../host/secret", libc::O_RDONLY, openat2).is_err(), "{openat2}");
            assert!(m.resolve("refs/stage", libc::O_RDONLY | libc::O_DIRECTORY, openat2).is_ok(), "{openat2}");
        }
        std::fs::remove_dir_all(&top).unwrap();
    }

    fn open_fds() -> usize {
        std::fs::read_dir("/proc/self/fd").map_or(0, |d| d.count())
    }

    #[test]
    fn a_wide_tree_is_walked_holding_one_directory_open_per_level() {
        // Before, every sibling directory was opened before any was visited.
        let (top, mirror, _) = tree("wide");
        for i in 0..400 {
            std::fs::create_dir_all(mirror.join(format!("objects/{i:03}"))).unwrap();
            std::fs::write(mirror.join(format!("objects/{i:03}/x")), b"").unwrap();
        }
        let m = Mirror::open(&mirror).unwrap();
        let before = open_fds();
        let mut most = 0;
        let mut seen = 0;
        let _ = m.walk(|_, _, _, _| {
            seen += 1;
            most = most.max(open_fds());
        });
        assert!(seen >= 800, "{seen}");
        // Other tests run at once and open their own: a margin, far under 400.
        assert!(most < before + 60, "{most} descriptors open during the walk, {before} before");
        std::fs::remove_dir_all(&top).unwrap();
    }

    #[test]
    fn a_directory_that_cant_be_read_stops_the_walk_rather_than_being_skipped() {
        if unsafe { libc::geteuid() } == 0 {
            eprintln!("skipped: root reads any directory");
            return;
        }
        use std::os::unix::fs::PermissionsExt;
        let (top, mirror, _) = tree("unreadable");
        std::fs::create_dir_all(mirror.join("objects/ab")).unwrap();
        std::fs::write(mirror.join("objects/ab/cd"), b"x").unwrap();
        std::fs::set_permissions(mirror.join("objects/ab"), std::fs::Permissions::from_mode(0o000)).unwrap();
        let walked = Mirror::open(&mirror).unwrap().walk(|_, _, _, _| {});
        std::fs::set_permissions(mirror.join("objects/ab"), std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(walked.is_err(), "a subtree that couldn't be read was skipped");
        std::fs::remove_dir_all(&top).unwrap();
    }

    #[test]
    fn past_any_cap_a_walk_or_a_count_is_an_anomaly_not_a_partial_answer() {
        let (top, mirror, _) = tree("caps");
        for i in 0..6 {
            std::fs::write(mirror.join(format!("refs/stage/{i}")), b"0123456789").unwrap();
        }
        let mut deep = mirror.join("objects");
        for i in 0..5 {
            deep = deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(&deep).unwrap();
        let roomy = Caps { per_dir: 100, entries: 100, depth: 16, bytes: 1000 };
        let m = |caps| Mirror::open_with(&mirror, caps).unwrap();
        assert!(m(roomy).walk(|_, _, _, _| {}).is_ok());
        assert_eq!(m(roomy).count("refs/stage"), Ok(Some(6)));
        // Entries in one directory, in all, depth, bytes: each an anomaly naming it.
        let per_dir = m(Caps { per_dir: 5, ..roomy });
        assert!(per_dir.walk(|_, _, _, _| {}).is_err_and(|a| a.0.contains("more than 5 entries")));
        assert!(per_dir.count("refs/stage").is_err());
        assert!(m(Caps { entries: 8, ..roomy }).walk(|_, _, _, _| {}).is_err_and(|a| a.0.contains("more than 8 entries")));
        assert!(m(Caps { depth: 4, ..roomy }).walk(|_, _, _, _| {}).is_err_and(|a| a.0.contains("directories deep")));
        assert!(m(Caps { bytes: 50, ..roomy }).walk(|_, _, _, _| {}).is_err_and(|a| a.0.contains("bytes")));
        std::fs::remove_dir_all(&top).unwrap();
    }

    #[test]
    fn a_path_never_leaves_the_mirror_nor_goes_through_a_link() {
        let (top, mirror, host) = tree("beneath");
        std::fs::write(mirror.join("HEAD"), b"ref: refs/heads/main\n").unwrap();
        std::os::unix::fs::symlink(&host, mirror.join("objects")).unwrap();
        std::os::unix::fs::symlink(host.join("secret"), mirror.join("packed-refs")).unwrap();
        let m = Mirror::open(&mirror).unwrap();
        assert_eq!(m.read("HEAD", 100).as_deref(), Some(&b"ref: refs/heads/main\n"[..]));
        assert_eq!(m.read("HEAD", 3), None, "past the cap");
        // Through a link as the file, as a directory on the way, or out of the mirror: not read.
        assert_eq!(m.read("packed-refs", 100), None);
        assert_eq!(m.read("objects/secret", 100), None);
        assert_eq!(m.count("objects/stage"), Ok(None));
        assert!(m.at("../host/secret", libc::O_RDONLY).is_err());
        assert!(m.at("/etc/passwd", libc::O_RDONLY).is_err());
        // A link is there, as a link.
        assert!(m.exists("packed-refs"));
        assert_eq!(m.stat("packed-refs").map(|s| s.kind), Some(Kind::Other));
        assert_eq!(m.count("refs/stage"), Ok(Some(0)));
        // Nor a FIFO: not waited on.
        let fifo = CString::new(mirror.join("fifo").as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        assert_eq!(m.read("fifo", 100), None);
        // The walk sees the links as entries and never enters them.
        let mut seen = Vec::new();
        m.walk(|rel, _, name, st| seen.push((rel.join(name), st.kind))).unwrap();
        assert!(seen.contains(&(PathBuf::from("objects"), Kind::Other)), "{seen:?}");
        assert!(!seen.iter().any(|(p, _)| p.to_string_lossy().starts_with("objects/")), "walked into a link: {seen:?}");
        std::fs::remove_dir_all(&top).unwrap();
    }
}
