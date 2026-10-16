package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func manager(t *testing.T) *jobManager {
	t.Helper()
	m, err := newJobManager(filepath.Join(t.TempDir(), "jobs"))
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func start(t *testing.T, m *jobManager, id, command string) jobView {
	t.Helper()
	v, created, err := m.start(startReq{ID: id, Command: command, Cwd: t.TempDir()})
	if err != nil {
		t.Fatalf("start %s: %v", id, err)
	}
	if !created {
		t.Fatalf("start %s: not created", id)
	}
	return v
}

func finished(t *testing.T, m *jobManager, id string) jobView {
	t.Helper()
	v, err := m.status(id, 20*time.Second, defaultTail, nil)
	if err != nil {
		t.Fatal(err)
	}
	if v.State == stateRunning {
		t.Fatalf("%s still running after 20 s", id)
	}
	return v
}

func status(err error) int {
	var je *jobError
	if errors.As(err, &je) {
		return je.status
	}
	return 0
}

func TestAJobRunsInTheBackgroundAndRecordsItsExitAndOutput(t *testing.T) {
	m := manager(t)
	v := start(t, m, "j1", "echo out; echo err >&2; sleep 0.3; exit 3")
	if v.State != stateRunning || v.ExitCode != nil {
		t.Fatalf("at start: %+v", v)
	}
	v = finished(t, m, "j1")
	if v.State != stateExited || v.ExitCode == nil || *v.ExitCode != 3 {
		t.Fatalf("finished: state %s exit %v", v.State, v.ExitCode)
	}
	if v.Tail != "out\nerr\n" || v.TailTruncated || v.OutputBytes != 8 {
		t.Fatalf("tail %q truncated %v bytes %d", v.Tail, v.TailTruncated, v.OutputBytes)
	}
	if v.ElapsedMs < 300 || v.EndedAt == nil {
		t.Fatalf("elapsed %d ended %v", v.ElapsedMs, v.EndedAt)
	}
}

func TestStartingAnIdAgainAttachesInsteadOfRunningASecondCopy(t *testing.T) {
	m := manager(t)
	cwd := t.TempDir()
	req := startReq{ID: "bench", Command: "echo run >> " + filepath.Join(cwd, "runs") + "; sleep 0.5", Cwd: cwd}
	if _, created, err := m.start(req); err != nil || !created {
		t.Fatalf("first start: %v %v", created, err)
	}
	again, created, err := m.start(req) // a replayed tool call
	if err != nil || created || again.State != stateRunning {
		t.Fatalf("second start: created %v state %s err %v", created, again.State, err)
	}
	finished(t, m, "bench")
	after, created, err := m.start(req) // and after it finished: the same, finished job
	if err != nil || created || after.State != stateExited {
		t.Fatalf("start after the end: created %v state %s err %v", created, after.State, err)
	}
	if b, _ := os.ReadFile(filepath.Join(cwd, "runs")); string(b) != "run\n" {
		t.Fatalf("the command ran %q, want once", b)
	}
	other := req
	other.Command = "echo something else"
	if _, _, err := m.start(other); status(err) != 409 || !strings.Contains(err.Error(), "choose a new id") {
		t.Fatalf("the same id for another command: %v", err)
	}
}

func TestCancelKillsTheWholeProcessGroup(t *testing.T) {
	m := manager(t)
	cwd := t.TempDir()
	pidFile := filepath.Join(cwd, "child.pid")
	// A child in the background, and a parent that ignores nothing: both must go.
	v, _, err := m.start(startReq{ID: "long", Command: "sleep 300 & echo $! > " + pidFile + "; wait", Cwd: cwd})
	if err != nil || v.State != stateRunning {
		t.Fatal(err)
	}
	var child int
	for i := 0; i < 100 && child == 0; i++ {
		b, _ := os.ReadFile(pidFile)
		json.Unmarshal([]byte(strings.TrimSpace(string(b))), &child)
		time.Sleep(20 * time.Millisecond)
	}
	if child == 0 {
		t.Fatal("the child never started")
	}
	v, err = m.cancel("long")
	if err != nil || v.State != stateCancelled || v.ExitCode == nil {
		t.Fatalf("cancel: %+v %v", v, err)
	}
	time.Sleep(100 * time.Millisecond)
	if err := unix.Kill(child, 0); err == nil {
		t.Fatalf("the job's child %d outlived the cancel", child)
	}
	// Cancelling again, or a finished job: its state, not an error.
	if v, err = m.cancel("long"); err != nil || v.State != stateCancelled {
		t.Fatalf("second cancel: %+v %v", v, err)
	}
	if _, err := m.cancel("nope"); status(err) != 404 || !strings.Contains(err.Error(), "long") {
		t.Fatalf("an unknown id: %v (want a 404 naming the jobs that exist)", err)
	}
}

func TestAJobIsStoppedAtItsTimeout(t *testing.T) {
	m := manager(t)
	if _, _, err := m.start(startReq{ID: "t", Command: "sleep 30", Cwd: t.TempDir(), TimeoutMs: 200}); err != nil {
		t.Fatal(err)
	}
	if v := finished(t, m, "t"); v.State != stateTimedOut || !strings.Contains(v.Reason, "timeout") {
		t.Fatalf("%+v", v)
	}
	if _, _, err := m.start(startReq{ID: "t2", Command: "true", Cwd: t.TempDir(), TimeoutMs: maxJobTimeout.Milliseconds() + 1}); status(err) != 400 {
		t.Fatalf("over the longest timeout: %v", err)
	}
}

func TestAJobThatWasRunningWhenGuestdStoppedIsLost(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "jobs")
	os.MkdirAll(filepath.Join(dir, "gone"), 0o700)
	rec := jobRecord{ID: "gone", Command: "make bench", Cwd: "/", State: stateRunning, StartedAt: time.Now().Add(-time.Minute)}
	b, _ := json.Marshal(rec)
	os.WriteFile(filepath.Join(dir, "gone", "meta.json"), b, 0o600)
	os.WriteFile(filepath.Join(dir, "gone", "output.log"), []byte("iteration 1\n"), 0o600)
	m, err := newJobManager(dir) // the VM booted again
	if err != nil {
		t.Fatal(err)
	}
	v, err := m.status("gone", time.Second, defaultTail, nil)
	if err != nil || v.State != stateLost || v.Tail != "iteration 1\n" || !strings.Contains(v.Reason, "VM stopped") {
		t.Fatalf("%+v %v", v, err)
	}
	if _, created, err := m.start(startReq{ID: "gone", Command: "make bench", Cwd: "/"}); err != nil || created {
		t.Fatalf("a lost id is not started again: created %v err %v", created, err)
	}
}

func TestStatusWaitsForTheEndButNoLongerThanAsked(t *testing.T) {
	m := manager(t)
	start(t, m, "w", "sleep 0.3; echo done")
	t0 := time.Now()
	v, err := m.status("w", 10*time.Second, defaultTail, nil)
	if err != nil || v.State != stateExited || time.Since(t0) > 5*time.Second {
		t.Fatalf("a wait for a job that ends: %+v after %s", v, time.Since(t0))
	}
	start(t, m, "w2", "sleep 30")
	t0 = time.Now()
	if v, _ = m.status("w2", 200*time.Millisecond, defaultTail, nil); v.State != stateRunning || time.Since(t0) > 5*time.Second {
		t.Fatalf("a wait for a job that doesn't end: %s after %s", v.State, time.Since(t0))
	}
	m.cancel("w2")
}

func TestRefusalsSayWhatToDo(t *testing.T) {
	m := manager(t)
	for _, c := range []struct {
		req  startReq
		code int
		says string
	}{
		{startReq{ID: "../x", Command: "true", Cwd: "/"}, 400, "job id"},
		{startReq{ID: "a", Command: " ", Cwd: "/"}, 400, "command is empty"},
		{startReq{ID: "a", Command: "true", Cwd: "/no/such/dir"}, 400, "clone the repo first"},
	} {
		if _, _, err := m.start(c.req); status(err) != c.code || !strings.Contains(err.Error(), c.says) {
			t.Errorf("%+v: %v", c.req, err)
		}
	}
	for i := 0; i < maxRunningJobs; i++ {
		start(t, m, "r"+string(rune('a'+i)), "sleep 30")
	}
	if _, _, err := m.start(startReq{ID: "one-more", Command: "true", Cwd: "/"}); status(err) != 429 || !strings.Contains(err.Error(), "cancel one") {
		t.Errorf("past the running limit: %v", err)
	}
	if n, list := m.list(); n != maxRunningJobs || len(list) != maxRunningJobs {
		t.Errorf("list: %d running, %d listed", n, len(list))
	}
	for i := 0; i < maxRunningJobs; i++ {
		m.cancel("r" + string(rune('a'+i)))
	}
}

func TestTheTailStartsAtAWholeCharacterAndSpansARotation(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "output.log.1"), []byte("old-old-ab"), 0o600)
	os.WriteFile(filepath.Join(dir, "output.log"), []byte("界new"), 0o600)
	if got, trunc := readTail(dir, 8); got != "ab界new" || !trunc {
		t.Fatalf("%q %v", got, trunc)
	}
	if got, _ := readTail(dir, 4); got != "new" { // the cut lands inside 界: dropped
		t.Fatalf("%q", got)
	}
	if got, trunc := readTail(dir, 100); got != "old-old-ab界new" || trunc {
		t.Fatalf("%q %v", got, trunc)
	}
}

func TestTheHTTPRoutes(t *testing.T) {
	m := manager(t)
	mux := http.NewServeMux()
	m.routes(mux)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	body := `{"id":"h","command":"echo hi","cwd":"/"}`
	for i, want := range []int{201, 200} {
		r, err := http.Post(srv.URL+"/jobs", "application/json", strings.NewReader(body))
		if err != nil || r.StatusCode != want {
			t.Fatalf("start %d: %v %v", i, r.StatusCode, err)
		}
	}
	r, _ := http.Get(srv.URL + "/jobs/h?waitMs=10000&tailBytes=100")
	var v jobView
	json.NewDecoder(r.Body).Decode(&v)
	if r.StatusCode != 200 || v.State != stateExited || v.Tail != "hi\n" {
		t.Fatalf("status: %d %+v", r.StatusCode, v)
	}
	if r, _ := http.Get(srv.URL + "/jobs/h?waitMs=999999999"); r.StatusCode != 400 {
		t.Fatalf("a wait past the limit: %d", r.StatusCode)
	}
	r, _ = http.Get(srv.URL + "/jobs/missing")
	var e struct{ Error string }
	json.NewDecoder(r.Body).Decode(&e)
	if r.StatusCode != 404 || !strings.Contains(e.Error, "h") {
		t.Fatalf("missing: %d %q", r.StatusCode, e.Error)
	}
	r, _ = http.Get(srv.URL + "/jobs")
	var l struct {
		Running int
		Jobs    []jobSummary
	}
	json.NewDecoder(r.Body).Decode(&l)
	if l.Running != 0 || len(l.Jobs) != 1 || l.Jobs[0].ID != "h" {
		t.Fatalf("list: %+v", l)
	}
}

func TestARetriedStartWithNoCwdAttachesToTheSameJob(t *testing.T) {
	m := manager(t)
	req := startReq{ID: "nocwd", Command: "true"} // cwd left out: guestd runs it in /
	if _, created, err := m.start(req); err != nil || !created {
		t.Fatalf("first start: %v %v", created, err)
	}
	again, created, err := m.start(req)
	if err != nil || created || again.Cwd != "/" {
		t.Fatalf("the identical retry: created %v cwd %q err %v (want the same job, not a 409)", created, again.Cwd, err)
	}
	finished(t, m, "nocwd")
}
