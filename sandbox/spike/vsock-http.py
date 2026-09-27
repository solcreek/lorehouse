#!/usr/bin/env python3
"""One HTTP request to guestd through Firecracker's vsock UDS.

usage: vsock-http.py <uds> <METHOD> <path> [body]

Firecracker's host side of vsock is a unix socket: connect, send
"CONNECT <port>\\n", read "OK <n>\\n", then the stream is the guest's port.
"""
import socket
import sys

uds, method, path = sys.argv[1:4]
body = sys.argv[4].encode() if len(sys.argv) > 4 else b""

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(30)
s.connect(uds)
s.sendall(b"CONNECT 1024\n")
ack = b""
while not ack.endswith(b"\n"):
    chunk = s.recv(1)
    if not chunk:
        sys.exit("vsock: closed during handshake")
    ack += chunk
if not ack.startswith(b"OK"):
    sys.exit(f"vsock: bad handshake {ack!r}")

req = (
    f"{method} {path} HTTP/1.1\r\nHost: guest\r\nConnection: close\r\n"
    f"Content-Length: {len(body)}\r\n\r\n"
).encode() + body
s.sendall(req)
resp = b""
while True:
    chunk = s.recv(65536)
    if not chunk:
        break
    resp += chunk
head, _, payload = resp.partition(b"\r\n\r\n")
status = head.split(b" ", 2)[1].decode() if head else "000"
if "transfer-encoding: chunked" in head.decode().lower():
    out, rest = b"", payload
    while rest:
        size_line, _, rest = rest.partition(b"\r\n")
        size = int(size_line, 16)
        if size == 0:
            break
        out += rest[:size]
        rest = rest[size + 2 :]
    payload = out
sys.stdout.write(payload.decode(errors="replace"))
sys.exit(0 if status.startswith("2") else 1)
