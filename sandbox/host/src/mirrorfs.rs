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
//! entered. Any other failure is "not there".

use std::ffi::{CString, OsStr, OsString};
use std::os::fd::{AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// A mirror's root, held open.
pub struct Mirror {
    root: OwnedFd,
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

/// The names in a directory (not `.` or `..`).
fn names(dir: BorrowedFd) -> std::io::Result<Vec<OsString>> {
    // SAFETY: fdopendir takes a duplicate we own (closedir closes it); readdir's entries are
    // read before the next call.
    unsafe {
        let dup = libc::fcntl(dir.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0);
        if dup < 0 {
            return Err(errno());
        }
        let d = libc::fdopendir(dup);
        if d.is_null() {
            let e = errno();
            libc::close(dup);
            return Err(e);
        }
        let mut out = Vec::new();
        loop {
            let entry = libc::readdir(d);
            if entry.is_null() {
                break;
            }
            let name = std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()).to_bytes();
            if name != b"." && name != b".." {
                out.push(OsStr::from_bytes(name).to_os_string());
            }
        }
        libc::closedir(d);
        Ok(out)
    }
}

impl Mirror {
    /// The mirror whose directory is `dir` (sandboxd's own: `<mirrors>/<owner>/<name>.git`,
    /// under directories only root writes). Not a link.
    pub fn open(dir: &Path) -> std::io::Result<Mirror> {
        let path = CString::new(dir.as_os_str().as_bytes()).map_err(|_| std::io::Error::from_raw_os_error(libc::EINVAL))?;
        // SAFETY: a NUL-terminated path.
        let fd = unsafe { libc::open(path.as_ptr(), O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(errno());
        }
        // SAFETY: a new descriptor of ours.
        Ok(Mirror { root: unsafe { OwnedFd::from_raw_fd(fd) } })
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

    /// How many entries directory `rel` has, if it is a real directory.
    pub fn count(&self, rel: &str) -> Option<u64> {
        let fd = self.at(rel, libc::O_RDONLY | libc::O_DIRECTORY).ok()?;
        names(fd.as_fd_borrowed()).ok().map(|n| n.len() as u64)
    }

    /// Every entry under the root, depth first, as `f(directory's path relative to the root,
    /// its handle, entry name, what the entry is)`. Only real directories are entered, each
    /// opened from its parent's handle without following a link. Entries `f` removes are
    /// gone before the walk would enter them.
    pub fn walk(&self, mut f: impl FnMut(&Path, BorrowedFd, &OsStr, &Stat)) -> std::io::Result<()> {
        let top = openat(self.root.as_fd_borrowed(), &CString::new(".").unwrap_or_default(), libc::O_RDONLY | libc::O_DIRECTORY)?;
        let mut stack: Vec<(PathBuf, OwnedFd)> = vec![(PathBuf::new(), top)];
        while let Some((rel, dir)) = stack.pop() {
            for name in names(dir.as_fd_borrowed())? {
                let Ok(st) = stat_at(dir.as_fd_borrowed(), &name) else { continue };
                f(&rel, dir.as_fd_borrowed(), &name, &st);
                if st.kind == Kind::Dir {
                    if let Ok(cname) = c(&name) {
                        if let Ok(sub) = openat(dir.as_fd_borrowed(), &cname, libc::O_RDONLY | libc::O_DIRECTORY) {
                            stack.push((rel.join(&name), sub));
                        }
                    }
                }
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
        assert_eq!(m.count("objects/stage"), None);
        assert!(m.at("../host/secret", libc::O_RDONLY).is_err());
        assert!(m.at("/etc/passwd", libc::O_RDONLY).is_err());
        // A link is there, as a link.
        assert!(m.exists("packed-refs"));
        assert_eq!(m.stat("packed-refs").map(|s| s.kind), Some(Kind::Other));
        assert_eq!(m.count("refs/stage"), Some(0));
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
