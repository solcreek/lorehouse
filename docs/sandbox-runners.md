# Sandbox runners

A sandbox runs code the model chose, so the API that drives it is remote code execution
by design. It must not be reachable from the internet, and the hosts that run sandboxes
should need no inbound port at all: they sit in a data center, a company network, or
behind NAT at home.

So the sandbox host **connects out** to Lorehouse and asks for work, the way CI runners
do. Lorehouse is the only party that can hand out work, and the runner holds no open
port.

```
 Slack ──▶ Lorehouse (Fly, Render, your server) ◀── WebSocket or long poll ── runner (sandboxd)
                                                                              └─ Firecracker VMs
```

## Two transports, one protocol

Deployment environments differ in what a long-lived connection can do, so a runner can
use either transport. Jobs and results are the same JSON either way.

| | WebSocket | Long poll |
|---|---|---|
| endpoint | `GET /runners/connect` (upgrade) | `POST /runners/poll`, `POST /runners/results` |
| latency | a job is pushed at once | a held poll returns at once when a job arrives |
| works through | hosts and proxies that pass WebSocket upgrades (Fly, Render, a VPS behind Caddy) | anything that speaks HTTP/1.1, including corporate proxies that block upgrades and platforms with short request limits (each poll is held ≤ 25 s) |
| overhead | one connection, a status frame every 20 s | one request per 25 s when idle |

A runner configured for `auto` tries WebSocket first. If the upgrade fails (a 4xx, or a
proxy that strips it), it falls back to long poll.

## Authentication

Every request carries:

- `Authorization: Bearer <SANDBOX_RUNNER_TOKEN>`, compared in constant time;
- `X-Lorehouse-Runner: <name>`, 1–64 characters of `[A-Za-z0-9_.-]`.

On the runner's side, sandboxd reads the token from the systemd credential
`runner-token` (`LoadCredential=runner-token:<file>`, a root-only file), falling back to
`SANDBOXD_RUNNER_TOKEN` with a deprecation warning: a credential is never in any
process's environment ([`sandbox/host/README.md`](../sandbox/host/README.md#tokens)).

A second connection with the same name replaces the first, with two exceptions: a poll
never displaces a live WebSocket, and a poll from an older runner process (by the status's
`started`) never displaces a newer one's.

## Messages

A **status** says who the runner is and how busy it is. Lorehouse uses it to place new
sandboxes on the runner with the most free room.

```json
{ "type": "status", "runner": "starship", "capacity": 4, "running": 1, "version": "0.1.0",
  "sandboxes": ["slack_C1_1790000001.000100"], "jobs": ["j_…"], "received": ["j_…"],
  "session": "18f3a…-2c41", "started": 1790000000000 }
```

- `jobs` lists the ids the runner holds: running, or finished with a result not yet
  delivered. After a reconnect, it tells Lorehouse which jobs survived the drop (see
  [Delivery](#delivery)).
- `received` is for long poll only. It lists the ids in the last poll answer the runner
  got.
- `session` and `started` identify the runner process: an id, and when it started (unix
  ms). While an old process is being replaced by a new one with the same name, the old
  one's polls are ignored, so it can't take the new one's jobs.
- `sandboxes` lists the sandboxes whose VM is up, each counted in `running` (see
  [Placement](#placement-and-failure)).
- `mirrors` is the host's publish mirrors (see [Publishing](#publishing)) as it last
  measured them: `count`, `bytes`, `maxBytes`, `perMirrorMaxBytes`, `fsFreeBytes`,
  `garbageBytes`, `stageRefs`, `records`, `largest` (`repo`, `bytes`), `oldestIdleSecs`,
  `lastGc` (`at`, `ms`, `reclaimedBytes`), and since the runner started `evicted` (mirrors
  dropped, for retention or to make room), `refusedForSpace` and `refreshTimeouts`.
  Lorehouse only shows it, in `/status` and `/api/v1/runners`; an object over 2 KB of JSON
  is dropped (not the status).
- All of these are optional. A runner that omits them loses the guarantees they give but
  still works. A list that is present must be an array of strings, or the whole status
  is refused.

A **job** is one request to the sandbox's guest agent, the removal of a sandbox, or a
publishing step (`stage`, `push`; see [Publishing](#publishing)):

```json
{ "id": "j_…", "sandbox": "slack_C1_1790000001.000100", "op": "guest",
  "method": "POST", "path": "/exec", "bodyBase64": "…", "timeoutMs": 600000,
  "deadlineMs": 659000 }
{ "id": "j_…", "sandbox": "…", "op": "destroy", "timeoutMs": …, "deadlineMs": … }
```

`timeoutMs` is the command's own limit. `deadlineMs` is how long Lorehouse will still wait
for the result, as of handing the job out. It is relative, so the clocks needn't agree.

A runner accepts only these guest calls, and refuses anything else:

- `POST /exec`, `GET /file?path=…` and `PUT /file?path=…`;
- a background job's (see [Background jobs](#background-jobs)): `POST /jobs` with no query,
  `GET /jobs/<job>` with at most `waitMs` and `tailBytes` (digits) in its query, and
  `POST /jobs/<job>/cancel`, where `<job>` is 1–64 of `[A-Za-z0-9_.-]` starting with a
  letter or digit. `GET /jobs`, the list, isn't one: sandboxd asks it itself, for the idle
  stop.

A **result** answers one job with an HTTP-like status:

```json
{ "id": "j_…", "status": 200, "contentType": "application/json", "bodyBase64": "…" }
{ "id": "j_…", "status": 503, "error": "all 4 sandboxes are busy; try again later" }
```

### Over WebSocket

- The runner sends a `status` frame first, then every 20 s.
- Lorehouse sends `{ "type": "job", "job": … }`.
- The runner sends `{ "type": "result", "result": … }`, in any order, as jobs finish.
- A frame may be up to 24 MiB, enough for the largest file guestd reads (16 MiB, ~21.4 MiB
  as base64). A larger frame closes the connection.

### Over long poll

- `POST /runners/poll` with a `status` body, including `received`. Lorehouse holds the
  request until jobs are waiting (≤ 25 s), then answers `200 { "jobs": [...] }`, which may
  be empty.
- The runner polls again at once and runs the jobs concurrently.
- `POST /runners/results` with `{ "results": [...] }` returns `204`. The runner posts each
  result as soon as it has it.
- A runner counts as online while its last poll is under 45 s old.

## Placement and failure

- **Sticky placement.** A sandbox's disk lives on one runner, so Lorehouse records where
  each sandbox was placed. Every later job goes to that runner.
- **Placed runner offline.** The job fails with "the sandbox's host is offline". It is not
  silently moved, because moving it would lose the checkout.
- **New sandbox.** It goes to the online runner with free capacity, the most first. A
  runner that hasn't sent a status yet has none. A sandbox just placed takes a slot of its
  runner's room until a status lists it in `sandboxes` (from then on `running` counts it),
  or 90 s pass without that (its VM never started, or already stopped). Several new
  sandboxes at once then spread out rather than all landing on one runner between two
  statuses.
  - With none online, the job fails with "no sandbox runner is connected".
  - With all full, it fails with "every sandbox runner is full". Nothing is recorded, so a
    retry can land wherever room appears.
- **Deadline.** A job has one: its `timeoutMs` plus 60 s for a boot. It fails if no result
  arrives by then. A job that hasn't gone out by its deadline never goes out.
- **A job stops at its deadline.** Once Lorehouse has told the caller a job timed out, the
  job must not go on changing the checkout. The runner stops the guest call just before
  `deadlineMs` runs out and answers 504. Closing the guest connection stops the work: an
  exec's process group is killed, and a write whose body didn't all arrive isn't made. A
  call that would start after the deadline isn't made.

## Delivery

Jobs write files and run commands, so a job must not run twice, and a result must not be
lost because a connection dropped while the job ran.

- **The runner keeps results until delivered.** A result finished on a connection that
  dropped is sent on the next one. An undelivered result is kept at least until the job's
  deadline at Lorehouse has passed (its `timeoutMs` plus boot slack, and no less than 10
  minutes), so a reconnect before then still lists it in `jobs`. Lorehouse accepts a result from the runner on the job's
  connection or any newer one, never an older one.
- **The runner runs a job id once.** It remembers recent job ids and skips one it has
  already taken, so a job handed out again doesn't run twice.
- **Long poll acknowledges.** A job in a poll answer the runner never got (missing from its
  next `received`) is handed out again.
- **After a reconnect, `jobs` settles the rest.** A job sent on an older connection that
  isn't listed never reached the runner and never ran, so it fails at once and is safe to
  retry. A listed job stays pending until its result arrives. Only the process a job went
  to can say it never got it: a job sent to a replaced process waits for its result or its
  deadline.
- **A runner restart keeps all of this.** sandboxd records each job it takes on disk
  (`<SANDBOXD_STATE>/.runner-jobs/`) before running it, and its result when it finishes.
  The next process delivers results not yet delivered and never runs a recorded job
  again. A job that was running when the process stopped went down with its VM, so it is
  answered with a 500 that says it may have partly run, rather than left to its deadline
  or retried blindly. A job that can't be recorded first isn't run at all.
- **A runner that disconnects** has 60 s to come back before its pending jobs fail.

## Background jobs

A command that runs longer than one job should (a benchmark, a test suite, a build) runs as
a background job in the sandbox: guestd starts it and answers at once, and later calls ask
how it is doing. Each is an ordinary `guest` job, with its own short deadline.

```json
POST /jobs              → { "id": "bench-1", "command": "make bench", "cwd": "/workspace/repo", "env": {…}, "timeoutMs": 3600000 }
                        ← 201 (200: that id was started already) a job
GET  /jobs/bench-1?waitMs=60000&tailBytes=8192 ← 200 a job, once it ends or waitMs passes
POST /jobs/bench-1/cancel                     ← 200 a job, once stopped (≤ 12 s)

a job: { "id", "command", "cwd", "state": "running" | "exited" | "cancelled" | "timed_out" | "lost",
         "exitCode": 0 | null, "startedAt", "endedAt": … | null, "elapsedMs", "timeoutMs",
         "outputBytes", "tail", "tailTruncated", "reason"?, "created"?, "persistError"? }
```

- **An id runs once.** Starting an id that ran before in that sandbox returns that job,
  whatever its state, and doesn't start a second copy. Lorehouse re-runs a tool call that
  was in flight when it stopped, so a start can arrive twice. The same id with another
  command or directory is refused (409). That holds past the 256 jobs whose output is
  kept: an older finished job's output is removed, and its record cut to a tombstone (its
  id, directory, state, times and the command's SHA-256, not its text) that stays as long
  as the sandbox does.
- **Its process group.** The command runs as `bash -lc`, stdin closed, in a process group
  of its own. Cancel and the timeout (default 1 h, at most 6 h) send it SIGTERM, then SIGKILL
  10 s later. When the command exits, anything it left running in its group is killed too.
- **Its output** (stdout and stderr together) goes to a file on the VM's disk, and its
  record when it starts and ends. At least the last 8 MiB are kept (up to 16). The env is never recorded.
  If the end can't be written (a full disk), guestd keeps it in memory, answers with it
  and a `persistError`, and tries the write again on each later call, whichever job it names.
- **It counts as activity.** An idle VM isn't stopped while guestd says a job runs, for up
  to `SANDBOXD_JOB_HOLD_SECS` (default 6 h) after the VM's last request.
- **It dies with its VM.** Whatever stops the VM (that hold running out, sandboxd stopping,
  the network rules failing closed) stops its jobs. The next status boots the VM again and
  reads `lost`, with the output up to then. A `destroy` deletes the disk, and the jobs with
  it: a status after that is a 404.
- **Failures** are JSON `{ "error" }` that say what to do: 400 (a bad id, cwd or timeout),
  404 (no such job; the message lists the latest ids), 409 (the id names another run), 429
  (8 jobs already running in the sandbox).

## Publishing

The agent's commits reach GitHub without a write token ever entering the sandbox. The
model controls everything inside it, the `git` binary included, so the host does the
verifying and the pushing. Two job ops do it, `stage` and `push`. A job carries the request
as base64 JSON in `bodyBase64`, and its result is JSON. In serve mode, the same requests
are `POST /v1/sandboxes/{id}/stage` and `/push`, with the JSON as the plain request body:

```json
stage → { "owner": "acme", "name": "widgets", "base": "main", "branch": "scout/x", "token": "<read token>" }
     ← { "stage": "<id>", "sha": "…", "baseSha": "…", "commits": 1, "stat": "…", "authors": ["bot <…>|bot <…>"],
         "files": ["…"], "patch": "…", "patchTruncated": false, "diffSha256": "…" }
push → { "stage": "<id>", "owner": "acme", "name": "widgets", "sha": "…", "branch": "scout/x", "token": "<write token>" }
     ← { "sha": "…", "branch": "scout/x" }
```

- **stage**, before a human approves:
  1. The host refreshes its bare mirror of the repo from GitHub (`<SANDBOXD_STATE>/.mirrors/`).
  2. It has the VM bundle what the checkout has that `origin` doesn't, and reads the bundle out in 12 MiB parts, at most 96 MiB in all.
  3. It fetches the bundle into `refs/stage/<id>`, with fsck on, no tags and only that one ref. A forged bundle, a `.git` tree entry, or a tag or replace ref riding along never reaches the mirror.
  4. The facts the approval shows (diff, files, authors) are computed in the mirror, never taken from the VM.
     `files` is every path the commits change, complete: a rename is listed as both its
     old and its new path (no rename detection), and no path is quoted or escaped. What
     the approval card warns about is decided on this list. `patch` is an excerpt (64 KiB at
     most); `diffSha256` is the SHA-256 of the complete diff, which an approval binds. It is
     taken with whole blob ids (`--full-index`, which bind binary changes too) and pinned
     diff options, so it depends on the two commits, not on the mirror or git's defaults.
  5. Only once all of that has succeeded, the host writes a stage record (sandbox, repo,
     base, branch, commit, time) under an unguessable id, synced to disk, and returns the
     id. A stage that fails, or is cut off by its deadline or cancelled, writes none.
- **push**, after approval: the host pushes the commit a stage record names to the branch
  it names, and nothing else, to `refs/heads/<branch>`. It never forces and never deletes.
  The record is the only authorization (a `refs/stage/` ref alone authorizes nothing):
  - The request must restate the record's sandbox, repo, commit and branch.
  - A record is single-use: push removes it (synced, so it can't come back after a crash)
    before checking or pushing anything, so it covers one attempt whatever its outcome. A
    failed push needs a new stage; Lorehouse stages on every run of `open_pull_request`,
    so a replay stages again.
  - A record expires 24 h after it was made. Expired records and refs, and refs with no
    record, are dropped by the host's housekeeping.
- **Every git command** on the host runs with no user or system config, no prompts, no
  replace objects and no hooks, isolated from sandboxd: a uid of its own per run, a mount
  namespace with only its mirror and git's binaries, no network, a cgroup of its own
  killed whole after it ([`sandbox/host/README.md`](../sandbox/host/README.md#publishings-git)).
  A fetch or push reaches GitHub only through sandboxd, which forwards that one repo's
  upload-pack or receive-pack and adds the token itself: no git process ever holds a
  token. Tokens are in jobs only, never logged or recorded.
- **A mirror is written by one job at a time**, under its lock. Git's automatic maintenance
  is off (`maintenance.auto=false`, `gc.auto=0`): it runs detached, after the lock is
  released, and a gc from outside the lock was seen to wedge a mirror (#76). A git command
  that times out or whose job is cut off is stopped with its helpers (its process group:
  SIGTERM, then SIGKILL within 2 s), and the lock is held until none of them is left, so
  none writes to the mirror after the lock is released. After a stage
  or push that runs to its end, and after a failed refresh, the housekeeping also removes
  what a git process that died or was killed left once it is older than 10 minutes (partial
  packs `tmp_pack_*` and `tmp_idx_*`, lock files `*.lock`, stage bundles), and any
  `refs/stage/` ref whose object is missing. A lock file or such a ref fails every fetch
  until it is gone, so a failed refresh that removed one is retried once. A mirror with no
  refs yet (its first fetch failed or was cut off) is removed.
- **The mirrors' upkeep** (#76; `sandbox/host/src/publish/upkeep.rs`), always under the
  mirror's lock, a busy mirror skipped and never waited for:
  - `git gc --prune=now` after a stage whose bundle was over 8 MiB failed, was cut off, or
    expired unpushed; and once a day for a mirror used since its last gc, once it has had
    no job for 10 minutes. Its own deadline: 600 s; after a gc fails, that mirror's next
    one waits an hour. The gc after a failed stage runs before the stage answers (under the
    lock), so that answer can take as long as the gc (13 s measured at 2.7 GB).
  - A mirror is dropped 14 days after its last stage or push
    (`SANDBOXD_MIRROR_RETENTION_DAYS`), never while a stage record younger than 24 h
    names it.
  - Quotas, failing closed: a mirror may use 4 GiB (`SANDBOXD_MIRROR_MAX_GIB`), all of them
    24 GiB (`SANDBOXD_MIRRORS_MAX_GIB`), and the filesystem keeps 10% or 20 GiB free,
    whichever is larger (`SANDBOXD_MIRRORS_FREE_PCT`, `SANDBOXD_MIRRORS_FREE_GIB`).
    Checked before the refresh (a new mirror counts at its cap, against the total and the
    free space over the floor), after it, and after the bundle fetch; a mirror over its cap
    is removed, unless a live stage record names it (its push needs it). Before refusing,
    mirrors idle for over 24 h are dropped, least recently used first, down to 80% of the
    total.
  - New mirrors are made one at a time on a host: admitted, fetched and measured before
    the next one is admitted, so two can't count on the same room. A stage of a second new
    repo waits for the first's fetch (within its own deadline). Stages of existing mirrors
    never wait for it and run at once, so mirrors growing together can pass the total by
    what those stages fetch (their refresh and their bundle: about 10 KB for a typical
    stage, measured in #76, more for an artifact-sized one). A check that finds it over
    refuses the stage: its bundle is collected by the gc (at once if artifact-sized), and
    its refresh stays with the mirror until it is evicted or dropped.
  - Every mirror is measured at start, before any job is taken. The upkeep runs then and
    every 5 minutes, plus after every stage and push.
- **Failures** come back as statuses with a reason:
  - 409: nothing new to publish, or a branch that has moved on.
  - 404: the base isn't on GitHub, or the stage isn't there (never completed, already
    used, or dropped).
  - 403: the push doesn't match its stage's record (nothing pushed, the stage is used up).
  - 410: the stage has expired.
  - 500: the record can't be read, is malformed, or can't be consumed (nothing pushed).
  - 422: the bundle was refused.
  - 413: the commits are too large, or what the approval shows (stat, files, authors) is
    over 1 MiB each. The host reads only that much of any of it; the patch is cut at 64 KiB.
  - 507: no room for the repo's mirror on the host (over its own cap, over the total, or
    the filesystem under its floor): nothing was staged, and the message says which and
    what an operator can raise or free.
