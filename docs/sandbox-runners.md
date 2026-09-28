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

A second connection with the same name replaces the first, with two exceptions: a poll
never displaces a live WebSocket, and a poll from an older runner process (by the status's
`started`) never displaces a newer one's.

## Messages

A **status** says who the runner is and how busy it is. Lorehouse uses it to place new
sandboxes on the runner with the most free room.

```json
{ "type": "status", "runner": "starship", "capacity": 4, "running": 1, "version": "0.1.0",
  "jobs": ["j_…"], "received": ["j_…"], "session": "18f3a…-2c41", "started": 1790000000000 }
```

- `jobs` lists the ids the runner holds: running, or finished with a result not yet
  delivered. After a reconnect, it tells Lorehouse which jobs survived the drop (see
  [Delivery](#delivery)).
- `received` is for long poll only. It lists the ids in the last poll answer the runner
  got.
- `session` and `started` identify the runner process: an id, and when it started (unix
  ms). While an old process is being replaced by a new one with the same name, the old
  one's polls are ignored, so it can't take the new one's jobs.
- All four are optional. A runner that omits them loses the guarantees in Delivery but
  still works.

A **job** is one request to the sandbox's guest agent, or the removal of a sandbox:

```json
{ "id": "j_…", "sandbox": "slack_C1_1790000001.000100", "op": "guest",
  "method": "POST", "path": "/exec", "bodyBase64": "…", "timeoutMs": 660000 }
{ "id": "j_…", "sandbox": "…", "op": "destroy" }
```

A runner accepts only these guest calls: `POST /exec`, `GET /file?path=…` and
`PUT /file?path=…`. It refuses anything else.

A **result** answers one job with an HTTP-like status:

```json
{ "id": "j_…", "status": 200, "contentType": "application/json", "bodyBase64": "…" }
{ "id": "j_…", "status": 503, "error": "all 4 sandboxes are busy; try again later" }
```

### Over WebSocket

- The runner sends a `status` frame first, then every 20 s.
- Lorehouse sends `{ "type": "job", "job": … }`.
- The runner sends `{ "type": "result", "result": … }`, in any order, as jobs finish.

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
  runner's room until its first job settles, so several new sandboxes at once spread out
  rather than all landing on one runner between two statuses.
  - With none online, the job fails with "no sandbox runner is connected".
  - With all full, it fails with "every sandbox runner is full". Nothing is recorded, so a
    retry can land wherever room appears.
- **Deadline.** A job has one: its `timeoutMs` plus 60 s for a boot. It fails if no result
  arrives by then. A job that hasn't gone out by its deadline never goes out.

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
- **A runner that disconnects** has 60 s to come back before its pending jobs fail.
