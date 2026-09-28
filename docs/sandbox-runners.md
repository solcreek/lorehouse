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

A second connection with the same name replaces the first.

## Messages

A **status** says who the runner is and how busy it is. Lorehouse uses it to place new
sandboxes on the runner with the most free room.

```json
{ "type": "status", "runner": "starship", "capacity": 4, "running": 1, "version": "0.1.0" }
```

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

- `POST /runners/poll` with a `status` body. Lorehouse holds the request until jobs are
  waiting (≤ 25 s), then answers `200 { "jobs": [...] }`, which may be empty.
- The runner polls again at once and runs the jobs concurrently.
- `POST /runners/results` with `{ "results": [...] }` returns `204`. The runner posts each
  result as soon as it has it.
- A runner counts as online while its last poll is under 45 s old.

## Placement and failure

- **Sticky placement.** A sandbox's disk lives on one runner, so Lorehouse records where
  each sandbox was placed. Every later job goes to that runner.
- **Placed runner offline.** The job fails with "the sandbox's host is offline". It is not
  silently moved, because moving it would lose the checkout.
- **New sandbox.** It goes to the online runner with the most free capacity. With none
  online, the job fails with "no sandbox runner is connected".
- **Deadline.** A job has one: its `timeoutMs` plus 60 s for a boot. It fails if no result
  arrives by then.
- **Lost connection.** A WebSocket that closes fails its runner's jobs in flight at once.
