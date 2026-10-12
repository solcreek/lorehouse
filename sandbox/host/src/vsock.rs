//! HTTP to guestd inside a microVM, over Firecracker's vsock.
//!
//! Firecracker exposes the guest's vsock as a Unix socket on the host. A host-initiated
//! connection writes `CONNECT <port>\n`, reads back `OK <n>\n`, and from then on the
//! stream is a plain byte pipe to the guest port, here guestd's HTTP server.

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::{Method, Request, StatusCode};
use hyper_util::rt::TokioIo;
use std::path::Path;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;

pub const GUESTD_PORT: u32 = 1024;

/// Largest guestd response the host buffers. Two 4 MiB output streams, JSON-escaped at
/// worst (a control byte becomes six), fit.
const MAX_RESPONSE: usize = 64 << 20;

pub struct Reply {
    pub status: StatusCode,
    pub content_type: Option<String>,
    pub body: Bytes,
}

/// Connect to a VM's socket. It sits in the VM's jail, a directory its uid owns, so a VMM
/// that got out of its guest could swap the socket for a symlink to any other socket on
/// the host (another VM's, a daemon's), and sandboxd, as root, would follow it. So the
/// name is opened without following links (O_PATH | O_NOFOLLOW), must be a socket, and
/// is connected through that descriptor: /proc/self/fd/<n>. That also keeps the address
/// short. A Unix socket address holds 108 bytes, and
/// `<state>/<sandbox id>/jail/firecracker/lorehouse-N/root/vsock.sock` is 111 for a
/// Lorehouse thread id under the default state directory.
#[cfg(target_os = "linux")]
pub async fn connect_unix(path: &Path) -> std::io::Result<UnixStream> {
    use std::os::unix::{ffi::OsStrExt, fs::FileTypeExt, fs::OpenOptionsExt, io::AsRawFd, io::FromRawFd, io::OwnedFd};
    let (Some(dir), Some(name)) = (path.parent(), path.file_name()) else {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, format!("{}: not a socket path", path.display())));
    };
    let dir = std::fs::OpenOptions::new().read(true).custom_flags(libc::O_PATH | libc::O_DIRECTORY).open(dir)?;
    let name = std::ffi::CString::new(name.as_bytes())?;
    // SAFETY: dir is an open descriptor and name is NUL-terminated; the result is checked.
    let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: fd was just returned by openat and nothing else owns it.
    let socket = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    if !socket.metadata()?.file_type().is_socket() {
        return Err(std::io::Error::other(format!("{} is not a socket (a link, or swapped)", path.display())));
    }
    UnixStream::connect(format!("/proc/self/fd/{fd}")).await
}

#[cfg(not(target_os = "linux"))]
pub async fn connect_unix(path: &Path) -> std::io::Result<UnixStream> {
    UnixStream::connect(path).await
}

async fn connect(uds: &Path) -> Result<UnixStream, String> {
    let mut stream = connect_unix(uds).await.map_err(|e| format!("vsock connect: {e}"))?;
    stream.write_all(format!("CONNECT {GUESTD_PORT}\n").as_bytes()).await.map_err(|e| format!("vsock CONNECT: {e}"))?;
    // Read the one-line acknowledgement byte by byte: anything after the newline already
    // belongs to the HTTP exchange, so it must not be buffered away here.
    let mut ack = Vec::new();
    let mut reader = BufReader::with_capacity(1, &mut stream);
    reader.read_until(b'\n', &mut ack).await.map_err(|e| format!("vsock ack: {e}"))?;
    if !ack.starts_with(b"OK ") {
        return Err(format!("vsock refused: {:?}", String::from_utf8_lossy(&ack)));
    }
    Ok(stream)
}

/// One request to guestd. `path_and_query` is guestd's own path, e.g. `/exec`.
pub async fn request(uds: &Path, method: Method, path_and_query: &str, body: Bytes) -> Result<Reply, String> {
    let stream = connect(uds).await?;
    let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .map_err(|e| format!("guestd handshake: {e}"))?;
    tokio::spawn(async move {
        let _ = conn.await;
    });
    let req = Request::builder()
        .method(method)
        .uri(path_and_query)
        .header("host", "guestd")
        .body(Full::new(body))
        .map_err(|e| format!("guestd request: {e}"))?;
    let res = sender.send_request(req).await.map_err(|e| format!("guestd: {e}"))?;
    let status = res.status();
    let content_type = res.headers().get("content-type").and_then(|v| v.to_str().ok()).map(String::from);
    // Bounded before it is buffered: guestd keeps 4 MiB per output stream and serves files
    // up to 16 MiB, but the host must not trust the guest to hold to that.
    let body = http_body_util::Limited::new(res.into_body(), MAX_RESPONSE)
        .collect()
        .await
        .map_err(|e| format!("guestd response over {} MiB, or broken: {e}", MAX_RESPONSE >> 20))?
        .to_bytes();
    Ok(Reply { status, content_type, body })
}

/// Whether guestd answers /healthz yet.
pub async fn healthy(uds: &Path) -> bool {
    matches!(request(uds, Method::GET, "/healthz", Bytes::new()).await, Ok(r) if r.status.is_success())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_socket_deeper_than_sun_path_is_still_reached() {
        use std::os::unix::io::AsRawFd;
        let base = std::env::temp_dir().join(format!("sandboxd-vsock-{}", std::process::id()));
        let deep = base.join("slack_C0BLN6R7UAG_1791761255.844419").join("jail/firecracker/lorehouse-12/root").join("x".repeat(40));
        std::fs::create_dir_all(&deep).unwrap();
        let path = deep.join("vsock.sock");
        assert!(path.as_os_str().len() > 108, "{}", path.display());
        // Bound the same way, through the directory's descriptor.
        let dir = std::fs::File::open(&deep).unwrap();
        let listener = tokio::net::UnixListener::bind(format!("/proc/self/fd/{}/vsock.sock", dir.as_raw_fd())).unwrap();
        assert!(tokio::net::UnixStream::connect(&path).await.is_err(), "a plain connect fits now; the test proves nothing");
        let accept = tokio::spawn(async move { listener.accept().await.map(|_| ()) });
        super::connect_unix(&path).await.expect("connect through the directory");
        accept.await.unwrap().unwrap();
        std::fs::remove_dir_all(&base).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_socket_swapped_for_a_link_is_refused() {
        // What a VMM that owns its jail could do: point the name sandboxd connects to at
        // another socket on the host.
        let dir = std::env::temp_dir().join(format!("sandboxd-vsock-link-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let elsewhere = dir.join("someone-elses.sock");
        let _listener = tokio::net::UnixListener::bind(&elsewhere).unwrap();
        let link = dir.join("vsock.sock");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        assert!(tokio::net::UnixStream::connect(&link).await.is_ok(), "a plain connect follows the link");
        let refused = super::connect_unix(&link).await.expect_err("followed the link");
        assert!(refused.to_string().contains("not a socket"), "{refused}");
        super::connect_unix(&elsewhere).await.expect("the socket itself");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
