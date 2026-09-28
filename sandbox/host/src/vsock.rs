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

async fn connect(uds: &Path) -> Result<UnixStream, String> {
    let mut stream = UnixStream::connect(uds).await.map_err(|e| format!("vsock connect: {e}"))?;
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
