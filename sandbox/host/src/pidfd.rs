//! A process held by a pidfd (Linux 5.3+): a descriptor for one process, not a number.
//! Signalling through it reaches that process or fails with ESRCH once it is gone; it
//! never reaches whatever process gets the number next. Its exit is seen by polling it,
//! whoever reaps it. sandboxd tracks every VMM this way, so no path (a failed wait, a drop
//! at shutdown, a stray from a crashed run) can signal a reused pid.

use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::time::Duration;
use tokio::io::unix::AsyncFd;

pub struct Pidfd(AsyncFd<OwnedFd>);

impl Pidfd {
    /// The process now holding `pid`. For a child not yet waited for, that is certainly
    /// the child (an unreaped pid can't be reused); for any other process, check after
    /// opening that it is the one meant (/proc/<pid> then describes the same process).
    #[cfg(target_os = "linux")]
    pub fn open(pid: u32) -> io::Result<Pidfd> {
        // SAFETY: a plain syscall; the result is checked. pidfd_open sets O_CLOEXEC.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: fd was just returned by pidfd_open and nothing else owns it.
        Ok(Pidfd(AsyncFd::new(unsafe { OwnedFd::from_raw_fd(fd as i32) })?))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn open(_: u32) -> io::Result<Pidfd> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "pidfds are Linux only"))
    }

    /// SIGKILL to this process. ESRCH once it has exited: never anyone else.
    #[cfg(target_os = "linux")]
    pub fn kill(&self) -> io::Result<()> {
        // SAFETY: a plain syscall on a pidfd we own; no siginfo.
        let r = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, self.0.as_raw_fd(), libc::SIGKILL, std::ptr::null::<libc::siginfo_t>(), 0) };
        if r < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(())
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn kill(&self) -> io::Result<()> {
        Err(io::Error::new(io::ErrorKind::Unsupported, "pidfds are Linux only"))
    }

    /// Whether it has exited, now (a pidfd turns readable at exit, reaped or not).
    pub fn exited(&self) -> bool {
        let mut p = libc::pollfd { fd: self.0.as_raw_fd(), events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd, no wait.
        unsafe { libc::poll(&mut p, 1, 0) == 1 && p.revents & libc::POLLIN != 0 }
    }

    /// Whether it exits within `grace`.
    pub async fn wait(&self, grace: Duration) -> bool {
        self.exited() || matches!(tokio::time::timeout(grace, self.0.readable()).await, Ok(Ok(_)))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::Pidfd;
    use std::time::Duration;

    #[tokio::test]
    async fn a_process_reaped_elsewhere_is_seen_gone_and_never_signalled() {
        let mut child = std::process::Command::new("sleep").arg("60").spawn().unwrap();
        let pidfd = Pidfd::open(child.id()).unwrap();
        assert!(!pidfd.exited());
        assert!(!pidfd.wait(Duration::from_millis(100)).await);
        pidfd.kill().unwrap();
        child.wait().unwrap(); // reaped here, behind the pidfd's back: the pid is free again
        assert!(pidfd.wait(Duration::from_millis(500)).await, "the exit is seen through the pidfd");
        // The number may now belong to anyone; the pidfd still names the dead process.
        assert_eq!(pidfd.kill().unwrap_err().raw_os_error(), Some(libc::ESRCH));
    }
}
