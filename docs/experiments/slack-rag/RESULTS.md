# Results: TypeScript (June) vs Go

## Current state: Linux, 2026-09-27

Host: Ryzen 7 8745HS, 16 threads, Arch Linux, load average ~0.3 (quiet).
June core 0.2.0-dev.44 / server 1.0.0-dev.24. The TS binaries were cross-compiled on
macOS (`--target=bun-linux-x64`, embedding Bun 1.3.6). The harness runs on the host's
Bun 1.3.14. Raw JSON results are kept outside the repo.

| | ts (v1) | ts-v2 | ts-v2 compiled with `--smol` | go |
|---|---|---|---|---|
| c=1…100 | all OK (1,720) | all OK | all OK | all OK |
| RSS peak c=1 / 10 / 50 / 100 | 114 / 133 / 214 / 310 | 113 / 129 / 198 / 307 | 113 / 129 / 204 / 304 | **25 / 28 / 39 / 50** |
| idle RSS at start → before c=100 | 71 → 200 MB | 70 → 179 MB | 68 → 188 MB | 20 → 33 MB |
| e2e p95 c=100 | 1912 ms | 1885 ms | 1887 ms | 1887 ms |
| ack p99 c=100 | 51 ms | 42 ms | 38 ms | 36 ms |
| CPU time, 4 loads | 26 s | 26 s | 26 s | **9 s** |
| startup to /healthz | 35 ms | 36 ms | 36 ms | 9 ms |
| binary (linux-x64) | 96.4 MB | 96.4 MB | 96.4 MB | 15.3 MB |

**Linux widens the resource gap.** TS uses about 6× Go's memory at c=100 (vs ~6× on
the Mac too), and about **2.9× its CPU** (vs 1.7× on the Mac). The linux-x64 Bun
binary is almost twice the macOS one. Latency is the same, because the mock bounds it.

### Does `--smol` help? Only at low load, and only when it actually applies

Same host Bun (1.3.14), running from source, with and without `--smol`
(`ts-v2-src` vs `ts-v2-smolsrc`, back to back; smolsrc reproduced within ±4% of an
earlier run):

| c | no `--smol` | `--smol` | change |
|---|---|---|---|
| 1 | 112 MB | 85 MB | **−25%** |
| 10 | 128 MB | 117 MB | −9% |
| 50 | 197 MB | 198 MB | 0 |
| 100 | 291 MB | 286 MB | −2% |

- `--smol` trims the low-load footprint and does nothing under load: the working set
  is live data, not garbage waiting for collection.
- **Baking it into the binary with `bun build --compile --compile-exec-argv=--smol`
  had no measurable effect** (c=1: 112.9 vs 113.1 MB). The flag does reach
  `process.execArgv` (verified), but the binary's memory matched the build without it.
  For compiled binaries on Bun 1.3.6 it doesn't seem to change the GC. To get the
  low-load saving, run the app from source with `bun --smol`.
- Bun 1.3.14 from source vs the 1.3.6 compiled binary: 291 vs 307 MB at c=100. That is
  within noise; the Bun version is not the lever either.

---

## Run 2 on the Mac (2026-09-27, June core 0.2.0-dev.44 / server 1.0.0-dev.24)

MacBook Air M3, same mock (TTFT 300 ms, 80 tokens × 15 ms, so e2e has a ~1.8 s
floor). `ts` is the run-1 app unchanged. `ts-v2` removes the workarounds dev.44 made
unnecessary.

| | ts (v1, workarounds) | ts-v2 (dev.44 idioms) | go |
|---|---|---|---|
| c=1 / 10 / 50 / 100 | 20/20, 200/200, 500/500, 1000/1000 | all OK | all OK |
| e2e p95 at c=100 | 1930 ms | 1941 ms | 1911 ms |
| ack p99 at c=100 | 16 ms | 37 ms | 16 ms |
| RSS peak c=10 / 50 / 100 | 101 / 207 / 318 MB | 91 / 194 / 323 MB | 33 / 44 / 55 MB |
| idle RSS after c=50 load | 207 MB | 191 MB | 44 MB |
| CPU time, all 4 loads | 16.5 s | 16.5 s | 10.2 s |
| binary | 55.8 MB | 55.8 MB | 14.8 MB |
| LOC (app file) | 89 | **65** | 363 |
| Slack appends per reply | 3 | 3 | 7 |

- **The dev.39 "livelock" is gone:** 1,720/1,720 per TS variant. Its root cause was
  June #167 (a tool-step key collision → synchronous spin). Our harness triggered it
  because run numbers restarted: the same thread ts and the same mock tool ids were
  reused across runs. `drive.ts` now makes `event_id`/`ts` unique per run (Slack
  never reuses them).
- **Redelivery dedupe (#170)** was verified with `harness/diag/retry.ts`: the event
  plus its `x-slack-retry-num` redelivery ran 1 turn and 1 stream.
- **Startup times this run aren't comparable** (ts 199 ms, ts-v2 168 ms, go 334 ms
  vs 42/56 ms in run 1). Another session's benchmark overlapped part of it, and the
  numbers moved in ways a single process can't explain. Treat startup as "well under
  1 s" for both until a quiet rerun.
- **The first attempt at run 2 was contaminated** by a concurrent session's stale app
  holding :8801 (RSS read 0→0). `bench.ts` now refuses to measure unless the listener
  on the app and mock ports is the process it spawned. `results-dev44-go-valid-ts-contaminated.json`
  keeps that attempt: its go rows are valid, its ts rows are not.
- **Memory:** TS holds ~4–6× the RSS of Go under load and stays high after it.
  Sessions are retained up to `maxSessions` (default 1000), so idle RSS reflects
  cached sessions too, not only heap.

### Memory tuning (2026-09-27, `results-mac-m3-dev44-tuning.json`)

Same machine, load average ~4.8 (other sessions active), so treat ±10% as noise.

| variant | RSS peak c=50 / c=100 | ack p99 c=100 | e2e p95 c=100 | CPU (4 loads) |
|---|---|---|---|---|
| ts-v2 (maxSessions 1000, `:memory:` store) | 204 / 331 MB | 21 ms | 1971 ms | 16.8 s |
| ts-v2, maxSessions=50 | 191 / 300 MB | 36 ms | 1994 ms | 17.3 s |
| ts-v2, maxSessions=50 + file store | 203 / 307 MB | **230 ms** | **2287 ms** | 20.9 s |
| go | 43 / 55 MB | 17 ms | 1974 ms | 9.5 s |

- **The session cache is a small share of TS memory.** Cutting `maxSessions` from 1000
  to 50 saved about 10% at c=100 (331 → 300 MB), within this run's noise. The rest is
  the Bun/JSC runtime and per-request heap (the SDK, SSE streams, Slack streaming).
  JSC keeps it after load: idle stays ~175 MB.
- **A file-backed store costs latency, not memory.** Synchronous SQLite writes block the
  event loop: ack p99 rises to 100–230 ms and e2e p95 by about 300 ms. That is the
  price of durability on the native host. The ack stays far inside Slack's 3 s limit,
  but it grows with load.
- **Startup is noisy:** ts-v2 1508 ms on its first cold start, 37–78 ms for the others,
  go 74 ms. Not a differentiator.

---

# Run 1: MacBook Air M3, 2026-09-25 (June dev.39, superseded)

Mocked upstreams (`harness/mock.ts`: TTFT 300 ms, 80 tokens × 15 ms), so end-to-end
time has a floor of about 1.8 s that no implementation can beat. Raw numbers are in
the raw JSON (outside the repo). A Linux rerun came later: see Current state.

## Correctness
Both passed the harness contract at c=1 (20/20). The 20 questions cited the same
chunks in both (0/20 mismatches), so the FTS5 query is equivalent.

## Load
| | TS (June, native Bun host) | Go |
|---|---|---|
| c=1 (n=20) | 20/20; ack p99 5 ms; e2e p50 1900 ms | 20/20; ack p99 2 ms; e2e p50 1899 ms |
| c=10 (n=200) | **0/200: livelock (see below)** | 200/200; e2e p95 1933 ms |
| c=50 (n=500) | **0/500** | 500/500; e2e p95 1968 ms; 26 req/s |
| RSS idle → peak | 39 → 84 MB (c=1) | 26 → 43 MB (c=50) |
| startup to /healthz | 42 ms | 56 ms |
| binary | 55.8 MB (`bun build --compile`) | 14.8 MB (static, `-s -w`) |
| LOC (non-blank, non-comment) | 89 | 363 |
| appends per reply | 3 (June coalesces at 500 ms) | 7 (spec: 250 ms) |

## The TS failure: a June native-host bug, not TypeScript
- **Symptom:** a burst of concurrent Slack mentions leaves every turn stuck after its
  first model call. The process sits at ~100% CPU with its event loop blocked, and
  stacks show time in `sqlite3_step`.
- **Threshold:** the load at which it starts varies with how much work each request
  does: ≥6 concurrent with the FTS tool, ≥100 with a trivial tool. It is also timing
  dependent; synchronous tracing made one reproduction pass.
- **Ruled out, each by a passing control at N=100:**
  - the Anthropic SDK on Bun against the mock
  - June's engine alone (`diag-engine.ts`, native and memory backends, with and
    without the real FTS tool)
  - the streaming workaround: it also hangs with `stream` off
  - a missing index on `agent_messages(session_id)`: it hangs with the index added
- **Where it is:** the `slackChannel` + `mountAgent` native path. The exact line is not
  isolated. A SQL begin/end trace shows every traced June-store query returning, so
  the spin is in an unwrapped call (`db.exec` BEGIN/COMMIT?) or outside the store.
- **Repro:** `ts/diag.ts` (DIAG_* toggles) with `harness/mock.ts`; fire ≥50 signed
  mentions at once.

## Stack gaps found while building
- **TS (June):**
  - `stream: true` is a silent no-op on the native host (no `runStream`)
  - `x-slack-retry-num` retries are not handled
  - the lazy SDK import breaks `bun build --compile`
  - tool results get JSON-encoded twice
  - tools and instructions have to be declared twice
  - sessions are never evicted
  - text from every step is streamed to Slack (pre-tool text leaks)
- **Go:**
  - slack-go's `AppMentionEvent` has no `team` field
  - `OptionAPIURL` needs a trailing slash
  - `ParseEvent` wants a verification token unless `OptionNoVerifyToken`
  - no SDK tool loop that also streams text (hand-written, ~40 lines)
  - modernc `:memory:` + `database/sql` pooling gives each connection its own empty DB
  - pre-tool text also streams
- **Both:** an in-flight answer is lost on a crash, and the Slack stream is left open.

## Dev cost (one agent per side, same spec)
TS: 41 tool calls, 202 s, 122k tokens. Go: 34 tool calls, 210 s, 83k tokens.
