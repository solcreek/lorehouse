// Background jobs: a command that outlives the request that started it.
//
//	POST /jobs                {"id","command","cwd","env","timeoutMs"} → 201 the job (200 if that id already ran it)
//	GET  /jobs/{id}?waitMs=…&tailBytes=…                            → the job (404 if no such id)
//	POST /jobs/{id}/cancel                                          → the job, once it has stopped (≤ 12 s)
//	GET  /jobs                                                      → {"running": n, "jobs": [{id, state, startedAt}]}
//
// An id names one run, ever, in this sandbox: starting an id again returns that job (its
// state, whatever it is) instead of starting a second copy, so a caller that retries a
// start (Lorehouse replays a tool call after a crash) attaches to the job it started. The
// same id with another command is refused (409).
//
// A job runs as bash -lc in a process group of its own, stdin closed, stdout and stderr
// together into a file under its directory (the last 2 × maxJobLog bytes are kept). Its
// record (meta.json) is written when it starts and when it ends, on the VM's disk, so it
// survives an idle stop of the VM. The processes don't: a job that was running when the VM
// stopped, or guestd restarted, is "lost" from then on, its output up to then kept. When
// its command exits, anything it left running in its process group is killed too.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf8"

	"golang.org/x/sys/unix"
)

const (
	defaultJobsDir = "/var/lib/guestd/jobs"
	// Jobs running at once in one sandbox.
	maxRunningJobs = 8
	// Job records kept; past this the oldest finished ones are removed.
	maxJobRecords = 256
	// Each output file's size before it is rotated (one previous file is kept).
	maxJobLog         = 8 << 20
	defaultJobTimeout = time.Hour
	maxJobTimeout     = 6 * time.Hour
	// How long a status may wait for a running job to finish.
	maxStatusWait = 5 * time.Minute
	defaultTail   = 8 << 10
	maxTail       = 64 << 10
	// SIGTERM, then SIGKILL this much later, for a cancel or a timeout.
	killGrace = 10 * time.Second
)

var jobID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`)

type jobState string

const (
	stateRunning   jobState = "running"
	stateExited    jobState = "exited"
	stateCancelled jobState = "cancelled"
	stateTimedOut  jobState = "timed_out"
	stateLost      jobState = "lost"
)

// What is kept on disk for a job (meta.json). Never the env: secrets go there.
type jobRecord struct {
	ID          string     `json:"id"`
	Command     string     `json:"command"`
	Cwd         string     `json:"cwd"`
	State       jobState   `json:"state"`
	ExitCode    *int       `json:"exitCode"`
	StartedAt   time.Time  `json:"startedAt"`
	EndedAt     *time.Time `json:"endedAt"`
	TimeoutMs   int64      `json:"timeoutMs"`
	OutputBytes int64      `json:"outputBytes"`
	Reason      string     `json:"reason,omitempty"`
}

// A job as an answer: its record, how long it has run, and the tail of its output.
type jobView struct {
	jobRecord
	ElapsedMs     int64  `json:"elapsedMs"`
	Tail          string `json:"tail"`
	TailTruncated bool   `json:"tailTruncated"`
	Created       *bool  `json:"created,omitempty"`
	// Set while the job's end couldn't be written to meta.json (a full disk): the state
	// here is right, it lives only in guestd's memory, and each later call tries again.
	PersistError string `json:"persistError,omitempty"`
}

type liveJob struct {
	rec       jobRecord // under jobManager.mu
	pgid      int
	done      chan struct{}
	cancelled bool
	timedOut  bool
	log       *jobLog
}

type jobManager struct {
	dir  string
	mu   sync.Mutex
	live map[string]*liveJob
	// Ended jobs whose final record failed to write: kept here, and over what meta.json
	// says (running), until a later call writes it.
	unsaved map[string]unsavedRecord
	now     func() time.Time
	persist func(jobRecord) error // writeRecord; a test makes it fail
}

type unsavedRecord struct {
	rec jobRecord
	err string
}

type jobError struct {
	status int
	msg    string
}

func (e *jobError) Error() string { return e.msg }

func errf(status int, format string, a ...any) error {
	return &jobError{status, fmt.Sprintf(format, a...)}
}

// newJobManager opens the jobs directory. A record still marked running belongs to a
// process that is gone (the VM stopped, or guestd restarted): it is marked lost.
func newJobManager(dir string) (*jobManager, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	m := &jobManager{dir: dir, live: map[string]*liveJob{}, unsaved: map[string]unsavedRecord{}, now: time.Now}
	m.persist = m.writeRecord
	for _, rec := range m.records() {
		if rec.State != stateRunning {
			continue
		}
		ended := rec.StartedAt
		if info, err := os.Stat(filepath.Join(dir, rec.ID, "output.log")); err == nil && info.ModTime().After(ended) {
			ended = info.ModTime()
		}
		rec.State, rec.EndedAt = stateLost, &ended
		rec.OutputBytes = logSize(filepath.Join(dir, rec.ID))
		rec.Reason = "the sandbox's VM stopped (or its agent restarted) while the job ran, and its processes went with it; the output up to then is kept"
		_ = m.persist(rec)
	}
	return m, nil
}

type startReq struct {
	ID        string            `json:"id"`
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd"`
	Env       map[string]string `json:"env"`
	TimeoutMs int64             `json:"timeoutMs"`
}

func (m *jobManager) start(req startReq) (jobView, bool, error) {
	if !jobID.MatchString(req.ID) {
		return jobView{}, false, errf(400, "job id %q: 1–64 of [A-Za-z0-9_.-], starting with a letter or digit", req.ID)
	}
	if strings.TrimSpace(req.Command) == "" {
		return jobView{}, false, errf(400, "command is empty")
	}
	timeout := defaultJobTimeout
	if req.TimeoutMs > 0 {
		timeout = time.Duration(req.TimeoutMs) * time.Millisecond
	}
	if req.TimeoutMs < 0 || timeout > maxJobTimeout {
		return jobView{}, false, errf(400, "timeoutMs %d: at most %d (%s)", req.TimeoutMs, maxJobTimeout.Milliseconds(), maxJobTimeout)
	}
	// Before the lookup, so a retry that leaves cwd out compares equal to the run it started.
	if req.Cwd == "" {
		req.Cwd = "/"
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	// An id that ran before: the same job, never a second copy.
	if rec, ok := m.find(req.ID); ok {
		if rec.Command != req.Command || rec.Cwd != req.Cwd {
			return jobView{}, false, errf(409, "job id %q already names another run in this sandbox (command %q in %s, started %s, %s); an id names one run: choose a new id, or check that one's status", req.ID, rec.Command, rec.Cwd, rec.StartedAt.UTC().Format(time.RFC3339), rec.State)
		}
		return m.viewLocked(rec, defaultTail), false, nil
	}
	if running := m.runningIDs(); len(running) >= maxRunningJobs {
		return jobView{}, false, errf(429, "%d jobs are already running in this sandbox (%s); wait for one to finish, or cancel one", len(running), strings.Join(running, ", "))
	}
	if info, err := os.Stat(req.Cwd); err != nil || !info.IsDir() {
		return jobView{}, false, errf(400, "cwd %s isn't a directory in the sandbox; clone the repo first, or give a directory that exists", req.Cwd)
	}

	jobDir := filepath.Join(m.dir, req.ID)
	if err := os.MkdirAll(jobDir, 0o700); err != nil {
		return jobView{}, false, errf(500, "job directory: %v", err)
	}
	log, err := openJobLog(jobDir)
	if err != nil {
		os.RemoveAll(jobDir)
		return jobView{}, false, errf(500, "job output file: %v", err)
	}
	cmd := exec.Command("bash", "-lc", req.Command)
	cmd.Dir = req.Cwd
	cmd.Env = os.Environ()
	for k, v := range req.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Stdout, cmd.Stderr = log, log
	cmd.SysProcAttr = &unix.SysProcAttr{Setpgid: true}
	// A child the command left behind may hold the output open: once the command has
	// exited, wait this long for it, then stop reading (the group is killed just after).
	cmd.WaitDelay = 2 * time.Second

	rec := jobRecord{ID: req.ID, Command: req.Command, Cwd: req.Cwd, State: stateRunning, StartedAt: m.now(), TimeoutMs: timeout.Milliseconds()}
	if err := m.persist(rec); err != nil {
		log.Close()
		os.RemoveAll(jobDir)
		return jobView{}, false, errf(500, "job record: %v", err)
	}
	if err := cmd.Start(); err != nil {
		log.Close()
		os.RemoveAll(jobDir)
		return jobView{}, false, errf(500, "start: %v", err)
	}
	j := &liveJob{rec: rec, pgid: cmd.Process.Pid, done: make(chan struct{}), log: log}
	m.live[req.ID] = j
	timer := time.AfterFunc(timeout, func() { m.stop(j, true) })
	go m.wait(j, cmd, timer)
	m.pruneLocked()
	return m.viewLocked(rec, defaultTail), true, nil
}

// wait records how the job ended, once its command has exited.
func (m *jobManager) wait(j *liveJob, cmd *exec.Cmd, timer *time.Timer) {
	err := cmd.Wait()
	timer.Stop()
	// What the command left running in its group goes with it.
	_ = unix.Kill(-j.pgid, unix.SIGKILL)
	code := 0
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code = ee.ExitCode()
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			code = 128 + int(ws.Signal())
		}
	} else if errors.Is(err, exec.ErrWaitDelay) {
		code = cmd.ProcessState.ExitCode() // exited; a child it left held the output open
	} else if err != nil {
		code = 127
		fmt.Fprintf(j.log, "\n[guestd] %v\n", err)
	}
	j.log.Close()
	m.mu.Lock()
	defer m.mu.Unlock()
	ended := m.now()
	j.rec.EndedAt, j.rec.ExitCode, j.rec.OutputBytes = &ended, &code, j.log.written()
	switch {
	case j.cancelled:
		j.rec.State, j.rec.Reason = stateCancelled, "cancelled on request"
	case j.timedOut:
		j.rec.State, j.rec.Reason = stateTimedOut, fmt.Sprintf("stopped at its timeout (%s)", time.Duration(j.rec.TimeoutMs)*time.Millisecond)
	default:
		j.rec.State = stateExited
	}
	if err := m.persist(j.rec); err != nil {
		// Leaving it to meta.json would read "running" from now on: keep the end here.
		fmt.Fprintf(os.Stderr, "guestd: job %s ended (%s) but its record wasn't written: %v\n", j.rec.ID, j.rec.State, err)
		m.unsaved[j.rec.ID] = unsavedRecord{j.rec, err.Error()}
	}
	delete(m.live, j.rec.ID)
	close(j.done)
}

// stop signals the job's process group: SIGTERM, then SIGKILL after killGrace.
func (m *jobManager) stop(j *liveJob, timedOut bool) {
	m.mu.Lock()
	select {
	case <-j.done:
		m.mu.Unlock()
		return
	default:
	}
	if timedOut {
		j.timedOut = true
	} else {
		j.cancelled = true
	}
	m.mu.Unlock()
	_ = unix.Kill(-j.pgid, unix.SIGTERM)
	go func() {
		select {
		case <-j.done:
		case <-time.After(killGrace):
			_ = unix.Kill(-j.pgid, unix.SIGKILL)
		}
	}()
}

func (m *jobManager) cancel(id string) (jobView, error) {
	m.mu.Lock()
	j, live := m.live[id]
	if !live {
		defer m.mu.Unlock()
		rec, ok := m.find(id)
		if !ok {
			return jobView{}, m.notFound(id)
		}
		return m.viewLocked(rec, defaultTail), nil // already over: its state says how
	}
	m.mu.Unlock()
	m.stop(j, false)
	select {
	case <-j.done:
	case <-time.After(killGrace + 2*time.Second):
	}
	return m.status(id, 0, defaultTail, nil)
}

// status: the job now, or, with wait > 0 and the job running, once it ends or wait passes.
func (m *jobManager) status(id string, wait time.Duration, tail int, gone <-chan struct{}) (jobView, error) {
	m.mu.Lock()
	j, live := m.live[id]
	m.mu.Unlock()
	if live && wait > 0 {
		t := time.NewTimer(wait)
		defer t.Stop()
		select {
		case <-j.done:
		case <-t.C:
		case <-gone:
		}
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	rec, ok := m.find(id)
	if !ok {
		return jobView{}, m.notFound(id)
	}
	return m.viewLocked(rec, tail), nil
}

type jobSummary struct {
	ID        string    `json:"id"`
	State     jobState  `json:"state"`
	StartedAt time.Time `json:"startedAt"`
}

func (m *jobManager) list() (int, []jobSummary) {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := []jobSummary{}
	for _, rec := range m.records() {
		if j, ok := m.live[rec.ID]; ok {
			rec = j.rec
		}
		out = append(out, jobSummary{rec.ID, rec.State, rec.StartedAt})
	}
	return len(m.live), out
}

// ── under m.mu ──────────────────────────────────────────────────────────────────────────

func (m *jobManager) find(id string) (jobRecord, bool) {
	if j, ok := m.live[id]; ok {
		return j.rec, true
	}
	if u, ok := m.unsaved[id]; ok {
		if err := m.persist(u.rec); err != nil {
			m.unsaved[id] = unsavedRecord{u.rec, err.Error()}
		} else {
			delete(m.unsaved, id)
		}
		return u.rec, true
	}
	if !jobID.MatchString(id) {
		return jobRecord{}, false
	}
	b, err := os.ReadFile(filepath.Join(m.dir, id, "meta.json"))
	if err != nil {
		return jobRecord{}, false
	}
	var rec jobRecord
	if json.Unmarshal(b, &rec) != nil || rec.ID != id {
		return jobRecord{}, false
	}
	return rec, true
}

func (m *jobManager) notFound(id string) error {
	recs := m.records()
	if len(recs) == 0 {
		return errf(404, "no job %q in this sandbox, and none was ever started here (a deleted sandbox's jobs go with it); start it with workspace_job_start", id)
	}
	ids := []string{}
	for i := len(recs) - 1; i >= 0 && len(ids) < 10; i-- {
		ids = append(ids, recs[i].ID)
	}
	return errf(404, "no job %q in this sandbox; the latest jobs here: %s", id, strings.Join(ids, ", "))
}

func (m *jobManager) runningIDs() []string {
	ids := make([]string, 0, len(m.live))
	for id := range m.live {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Every record on disk, oldest first, with an unsaved end over what the disk says.
func (m *jobManager) records() []jobRecord {
	entries, _ := os.ReadDir(m.dir)
	out := []jobRecord{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		b, err := os.ReadFile(filepath.Join(m.dir, e.Name(), "meta.json"))
		var rec jobRecord
		if err == nil && json.Unmarshal(b, &rec) == nil && rec.ID == e.Name() {
			if u, ok := m.unsaved[rec.ID]; ok {
				rec = u.rec
			}
			out = append(out, rec)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].StartedAt.Before(out[b].StartedAt) })
	return out
}

func (m *jobManager) writeRecord(rec jobRecord) error {
	b, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	path := filepath.Join(m.dir, rec.ID, "meta.json")
	if err := os.WriteFile(path+".tmp", b, 0o600); err != nil {
		return err
	}
	return os.Rename(path+".tmp", path)
}

// The oldest finished records beyond maxJobRecords are removed.
func (m *jobManager) pruneLocked() {
	recs := m.records()
	for i := 0; len(recs)-i > maxJobRecords && i < len(recs); i++ {
		_, live := m.live[recs[i].ID]
		_, unsaved := m.unsaved[recs[i].ID]
		if !live && !unsaved && recs[i].State != stateRunning {
			os.RemoveAll(filepath.Join(m.dir, recs[i].ID))
		}
	}
}

func (m *jobManager) viewLocked(rec jobRecord, tail int) jobView {
	end := m.now()
	if rec.EndedAt != nil {
		end = *rec.EndedAt
	}
	v := jobView{jobRecord: rec, ElapsedMs: end.Sub(rec.StartedAt).Milliseconds()}
	if j, ok := m.live[rec.ID]; ok {
		v.OutputBytes = j.log.written()
	}
	if u, ok := m.unsaved[rec.ID]; ok {
		v.PersistError = "the job's end couldn't be saved to the sandbox's disk (" + u.err + "); it is right here, but would read lost after a restart. Free some disk space"
	}
	v.Tail, v.TailTruncated = readTail(filepath.Join(m.dir, rec.ID), tail)
	return v
}

// ── output ──────────────────────────────────────────────────────────────────────────────

// jobLog is a job's stdout and stderr: output.log, rotated to output.log.1 past maxJobLog.
type jobLog struct {
	dir   string
	mu    sync.Mutex
	f     *os.File
	size  int64
	total int64
}

func openJobLog(dir string) (*jobLog, error) {
	f, err := os.OpenFile(filepath.Join(dir, "output.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	return &jobLog{dir: dir, f: f}, nil
}

func (l *jobLog) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return len(p), nil
	}
	if l.size+int64(len(p)) > maxJobLog && l.size > 0 {
		l.f.Close()
		cur := filepath.Join(l.dir, "output.log")
		_ = os.Rename(cur, cur+".1")
		f, err := os.OpenFile(cur, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			l.f = nil
			return len(p), nil // the job goes on; its output is lost from here
		}
		l.f, l.size = f, 0
	}
	n, _ := l.f.Write(p)
	l.size += int64(n)
	l.total += int64(len(p))
	return len(p), nil
}

func (l *jobLog) written() int64 {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.total
}

func (l *jobLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return nil
	}
	err := l.f.Close()
	l.f = nil
	return err
}

func logSize(dir string) int64 {
	var n int64
	for _, name := range []string{"output.log.1", "output.log"} {
		if info, err := os.Stat(filepath.Join(dir, name)); err == nil {
			n += info.Size()
		}
	}
	return n
}

// The last n bytes of a job's output (from the rotated file too, if the current one is
// shorter), starting at a whole UTF-8 character; and whether there was more before.
func readTail(dir string, n int) (string, bool) {
	var chunks [][]byte
	left := int64(n)
	truncated := false
	for _, name := range []string{"output.log", "output.log.1"} {
		if left <= 0 {
			if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
				truncated = true
			}
			break
		}
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		info, _ := f.Stat()
		size := info.Size()
		from := size - left
		if from > 0 {
			truncated = true
		} else {
			from = 0
		}
		b := make([]byte, size-from)
		_, _ = f.ReadAt(b, from)
		f.Close()
		chunks = append([][]byte{b}, chunks...)
		left -= int64(len(b))
	}
	out := []byte{}
	for _, c := range chunks {
		out = append(out, c...)
	}
	if truncated {
		for len(out) > 0 && !utf8.RuneStart(out[0]) {
			out = out[1:]
		}
	}
	return string(out), truncated
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	var je *jobError
	if errors.As(err, &je) {
		writeJSON(w, je.status, map[string]string{"error": je.msg})
		return
	}
	writeJSON(w, 500, map[string]string{"error": err.Error()})
}

func intParam(r *http.Request, key string, def, max int) (int, error) {
	s := r.URL.Query().Get(key)
	if s == "" {
		return def, nil
	}
	n, err := strconv.Atoi(s)
	if err != nil || n < 0 || n > max {
		return 0, errf(400, "%s: a whole number from 0 to %d, got %q", key, max, s)
	}
	return n, nil
}

func (m *jobManager) routes(mux *http.ServeMux) {
	mux.HandleFunc("POST /jobs", func(w http.ResponseWriter, r *http.Request) {
		var req startReq
		if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req); err != nil {
			writeErr(w, errf(400, "body: {id, command, cwd, env, timeoutMs} as JSON: %v", err))
			return
		}
		v, created, err := m.start(req)
		if err != nil {
			writeErr(w, err)
			return
		}
		v.Created = &created
		status := http.StatusOK
		if created {
			status = http.StatusCreated
		}
		writeJSON(w, status, v)
	})
	mux.HandleFunc("GET /jobs", func(w http.ResponseWriter, _ *http.Request) {
		running, jobs := m.list()
		writeJSON(w, 200, map[string]any{"running": running, "jobs": jobs})
	})
	mux.HandleFunc("GET /jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		wait, err := intParam(r, "waitMs", 0, int(maxStatusWait.Milliseconds()))
		if err == nil {
			var tail int
			if tail, err = intParam(r, "tailBytes", defaultTail, maxTail); err == nil {
				var v jobView
				if v, err = m.status(r.PathValue("id"), time.Duration(wait)*time.Millisecond, tail, r.Context().Done()); err == nil {
					writeJSON(w, 200, v)
					return
				}
			}
		}
		writeErr(w, err)
	})
	mux.HandleFunc("POST /jobs/{id}/cancel", func(w http.ResponseWriter, r *http.Request) {
		v, err := m.cancel(r.PathValue("id"))
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
}
