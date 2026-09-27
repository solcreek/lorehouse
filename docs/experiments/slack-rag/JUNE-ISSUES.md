# June issues found by the slack-rag experiment (2026-09-25)

Versions: `@junejs/core@0.2.0-dev.39`, `@junejs/server@1.0.0-dev.20`, Bun 1.3.6, macOS.
All of these are on the **native host** (`createNativeRuntime` + `mountAgent`) with
`slackChannel`. Repros use `harness/mock.ts` (Slack + Anthropic mock) from this directory.

---

## 1. Native host livelocks under a burst of Slack mentions (severity: high)

**Symptom.** A burst of concurrent `app_mention` webhooks leaves every turn stuck after
its first model call. The process sits at ~100% CPU and the event loop is blocked
(timers stop firing). `sample` shows the main thread in `sqlite3_step` (btree scans,
memcmp) under JIT frames.

**The threshold depends on per-request work.** With the FTS5 search tool it starts at
≥6 concurrent, and sometimes only on the 2nd or 3rd burst in one process. With a
trivial tool it starts at ≥100 concurrent. It is timing-sensitive: synchronous tracing
made one reproduction pass.

**Ruled out** (each control passes at N=100):
- `@anthropic-ai/sdk` on Bun against the mock (`harness/diag/concurrency.ts`)
- the engine alone, `createAgentRuntime` native and memory, with and without the real
  FTS tool (`ts/diag-engine.ts`)
- the `runStream` workaround: it also hangs with `stream` off
- a missing index: adding `CREATE INDEX … agent_messages(session_id, seq)` doesn't fix it

**Narrowed to:** the `slackChannel` → `mountAgent` path on the native host. A begin/end
trace wrapping every `query`/`prepare` statement shows each one returning, so the
spinning call is not a wrapped statement. Suspects: an unwrapped `db.exec`
(BEGIN/COMMIT/ROLLBACK in `SqliteSessionStore.tx`), or something the channel-driven
turn does that the direct engine call doesn't (the `event` on the turn,
`channelInstructions`, the channel capability tools in `agent.tools`).

**Repro:**
```bash
PORT=8930 bun harness/mock.ts &
cd ts && PORT=8836 DIAG_FAKETOOL=1 SLACK_SIGNING_SECRET=test-signing-secret SLACK_BOT_TOKEN=x \
  SLACK_API_URL=http://localhost:8930/slack/api ANTHROPIC_API_KEY=t \
  ANTHROPIC_BASE_URL=http://localhost:8930/anthropic CORPUS=../corpus.jsonl bun diag.ts &
bun harness/diag/fire.ts http://localhost:8836/slack/events http://localhost:8930 100 8000
# → {"slackCalls":0,"modelCalls":100}  (N=50 passes; drop DIAG_FAKETOOL to fail at N≈6–20)
```
`harness/diag/fire.ts` sends N signed mentions at once and prints the mock's counters;
`harness/diag/concurrency.ts` is the plain-SDK control (needs `@anthropic-ai/sdk`).

**Separate perf issue, found along the way.** `agent_messages` has no index on
`session_id`. `messages()` does a full scan and a full `JSON.parse` of the transcript,
and `hasOpeningMessage`, `result()` and `foldEvents()` each call it, so the cost grows
with all messages across all sessions. Worth an index regardless.

## 2. `slackChannel({ stream: true })` silently does nothing on the native host

`mountAgent` builds a `ChannelContext` with only `run`, `runDetached` and
`resetSession`: no `runStream` and no `runDelivered`. The channel then falls through to
a single `chat.postMessage`, with no warning. Only `durableChannelSurface` (DO)
provides them. Workaround (~20 lines, in `ts/app.ts`): bridge `runStream` from
`session.start()` + `observe({ turnId })` + `result()`. **Fix:** provide `runStream`
in `mountAgent`, or at least warn when `stream: true` has no stream-capable host.

## 3. Slack retries (`x-slack-retry-num`) start a second turn

A retried delivery runs the turn again and posts a duplicate answer. **Fix:** ack
retries with 200 without a turn, or dedupe on `event_id`.

## 4. `anthropic()`'s lazy SDK import defeats `bun build --compile`

The non-literal specifier means the bundler can't see `@anthropic-ai/sdk`, so a
compiled binary would need `node_modules` at runtime. Workaround: pass
`client: new Anthropic({ … })`. **Fix:** document it, or accept a static import path.

## 5. Tool results are JSON-encoded twice when a tool returns a string

The adapter `JSON.stringify`s every result, so a tool that returns a JSON string sends
a quoted string. **Fix:** pass strings through as-is.

## 6. Tools and instructions are declared twice

`defineAgent({ tools, instructions })` feeds `mountAgent`, and
`createNativeRuntime({ name: { model, tools, instructions } })` feeds the engine, but
nothing ties the two together, so they can drift.
**Fix:** build the runtime from the `AgentDefinition`.

## 7. `NativeRuntime` never evicts sessions

`actors` is a Map that grows by one `AgentSession` per Slack thread, forever.
**Fix:** LRU or idle eviction; the durable state is in SQLite anyway.

## 8. Text from every model step is streamed, not only the final answer

If the model writes "Let me search…" before a `tool_use`, that text reaches Slack.
(The Go version has the same gap.) **Fix:** an option to stream only the final step,
or to render intermediate text as task/status lines.

## 9. `anthropic({ client })` rejects the latest SDK at the type level

Found 2026-09-27 while wiring Lorehouse: it runs `tsc`, and the experiments ran on Bun,
which doesn't type-check. Seen with `@anthropic-ai/sdk@0.128.0`, the current `latest`.
`AnthropicStreamEvent.delta` is `{ type?; text?; thinking? }`, all optional, so
TypeScript applies its weak-type check. The SDK's `RawMessageDeltaEvent.delta`
(`stop_reason`, `stop_sequence`, …) shares none of those keys, so `new Anthropic()` is
not assignable to `AnthropicClient`. Runtime behavior is fine.
**Fix:** give `delta` an index signature (`[k: string]: unknown`), or a union that
includes the message_delta shape. Keep a compile-time assertion against the current
SDK so an SDK bump that breaks it fails CI.
