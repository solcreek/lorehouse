// guestd — the in-VM half of the lorehouse sandbox. Runs inside each Firecracker microVM and
// serves a tiny HTTP API over vsock, so the host never needs a network path
// into the guest to drive it:
//
//	POST /exec   {"command","cwd","env","timeoutMs"} → {"exitCode","stdout","stderr"}
//	GET  /file?path=…                                 → raw bytes (404 if absent)
//	PUT  /file?path=…   body = raw bytes              → 204 (parents created)
//	GET  /healthz                                     → "ok"
//
// Commands run as bash -lc so the model gets a normal shell (pipes, &&, globs).
// The host side reaches this through Firecracker's vsock UDS with the
// "CONNECT <port>\n" handshake.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

const port = 1024

// Output a command can return, per stream. A command like `yes` must not exhaust the
// guest's memory or the host's: past the limit only the tail is kept (a failing test
// run's summary is at the end), with a marker saying how much was dropped.
const maxOutput = 4 << 20

// Largest file GET /file returns.
const maxFile = 16 << 20

type tailBuffer struct {
	buf     []byte
	dropped int
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - maxOutput; over > 0 {
		t.dropped += over
		t.buf = append(t.buf[:0:0], t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	if t.dropped == 0 {
		return string(t.buf)
	}
	return fmt.Sprintf("[guestd: %d earlier bytes dropped]\n%s", t.dropped, t.buf)
}

type execReq struct {
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMs int               `json:"timeoutMs"`
}

type execRes struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

func main() {
	ln, err := listenVsock(port)
	if err != nil {
		log.Fatalf("guestd: listen vsock:%d: %v", port, err)
	}
	log.Printf("guestd: listening on vsock:%d", port)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "ok") })
	mux.HandleFunc("POST /exec", handleExec)
	mux.HandleFunc("GET /file", handleRead)
	mux.HandleFunc("PUT /file", handleWrite)
	log.Fatal(http.Serve(ln, mux))
}

func handleExec(w http.ResponseWriter, r *http.Request) {
	var req execReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Command == "" {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	timeout := 10 * time.Minute
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	ctx, cancel := context.WithTimeout(r.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-lc", req.Command)
	cmd.Dir = req.Cwd
	if cmd.Dir != "" {
		if _, err := os.Stat(cmd.Dir); err != nil {
			cmd.Dir = "/" // a not-yet-cloned workdir must not fail the clone that creates it
		}
	}
	cmd.Env = os.Environ()
	for k, v := range req.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	// Kill the whole process group on timeout — a test runner's children must not outlive it.
	cmd.SysProcAttr = &unix.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return unix.Kill(-cmd.Process.Pid, unix.SIGKILL) }
	cmd.WaitDelay = 5 * time.Second

	var stdout, stderr tailBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	res := execRes{}
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		switch {
		case errors.As(err, &ee):
			res.ExitCode = ee.ExitCode()
		default:
			res.ExitCode = 127
			stderr.Write([]byte(err.Error()))
		}
		if ctx.Err() == context.DeadlineExceeded {
			res.ExitCode = 124
			stderr.Write([]byte("\n[guestd] command timed out"))
		}
	}
	res.Stdout, res.Stderr = stdout.String(), stderr.String()
	w.Header().Set("content-type", "application/json")
	json.NewEncoder(w).Encode(res)
}

func handleRead(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if info, err := os.Stat(path); err == nil && info.Size() > maxFile {
		http.Error(w, fmt.Sprintf("file is %d bytes; the limit is %d", info.Size(), maxFile), http.StatusRequestEntityTooLarge)
		return
	}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Write(b)
}

func handleWrite(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Query().Get("path")
	if !filepath.IsAbs(p) {
		http.Error(w, "path must be absolute", http.StatusBadRequest)
		return
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	b, err := io.ReadAll(r.Body)
	if err == nil {
		err = os.WriteFile(p, b, 0o644)
	}
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ── vsock listener (stdlib net has no AF_VSOCK) ───────────────────────────────

type vsockListener struct{ fd int }

func listenVsock(port uint32) (net.Listener, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: port}); err != nil {
		unix.Close(fd)
		return nil, err
	}
	if err := unix.Listen(fd, 64); err != nil {
		unix.Close(fd)
		return nil, err
	}
	return &vsockListener{fd: fd}, nil
}

func (l *vsockListener) Accept() (net.Conn, error) {
	// NONBLOCK so os.NewFile registers the fd with the runtime poller — that is
	// what makes the deadlines net/http sets actually work.
	nfd, _, err := unix.Accept4(l.fd, unix.SOCK_CLOEXEC|unix.SOCK_NONBLOCK)
	if err != nil {
		return nil, err
	}
	// Not net.FileConn: it rejects address families net doesn't know (EINVAL).
	return vsockConn{os.NewFile(uintptr(nfd), "vsock")}, nil
}

type vsockConn struct{ *os.File }

func (vsockConn) LocalAddr() net.Addr  { return vsockAddr{} }
func (vsockConn) RemoteAddr() net.Addr { return vsockAddr{} }

func (l *vsockListener) Close() error   { return unix.Close(l.fd) }
func (l *vsockListener) Addr() net.Addr { return vsockAddr{} }

type vsockAddr struct{}

func (vsockAddr) Network() string { return "vsock" }
func (vsockAddr) String() string  { return "vsock:1024" }
