# Experiment: Slack RAG agent — TypeScript (June) vs Go

Build the same minimal service twice, once per language, and measure both against
identical mocked upstreams. This file is the contract both implementations follow.

## The scenario

Someone @-mentions the bot in a public Slack channel. The service:

1. **Verifies** the Slack request signature (v0 HMAC-SHA256 over `v0:{timestamp}:{body}`
   with `SLACK_SIGNING_SECRET`; reject timestamps more than 5 minutes old). Bad
   signature → `401`.
2. **Acks fast**: returns `200` within 3 s without waiting for the answer. Answers
   `url_verification` with its `challenge`. Deliveries carrying an `x-slack-retry-num`
   header are acked with `200` and otherwise ignored.
3. For an `app_mention` event, **in the background**, runs a tool-use loop against the
   Anthropic Messages API:
   - model `claude-opus-5`, `max_tokens` 4096, **streaming** on every model call
   - system prompt (exactly): `You answer questions about the June framework. Always call search_knowledge first, then answer citing chunk ids.`
   - one tool, `search_knowledge`, with input schema `{ "query": string }` (required)
   - the user message is the mention text as received (including the `<@UBOT>` prefix)
   - loop until `stop_reason` is not `tool_use`
4. **`search_knowledge`** queries an SQLite FTS5 index and returns the top 5 hits as a
   JSON array of `{ "id", "title", "source", "text" }`, with `text` cut to its first
   500 characters. The tool_result content is that JSON string.
5. **Streams the answer into the thread** with Slack's streaming API:
   - `chat.startStream` with `channel`, `thread_ts` = the event's `ts`,
     `recipient_team_id` = the event's `team`, `recipient_user_id` = the event's `user`
   - `chat.appendStream` (`channel`, `ts` = the stream ts, `markdown_text`) as text
     arrives from the model
   - `chat.stopStream` (`channel`, `ts`) when the model is done
   - the concatenation of all streamed text must equal the model's final answer text
     exactly

The first model turn always calls the tool; only the final turn's text goes to Slack.

## The index

- Load `CORPUS` (a JSONL file, one `{id, source, title, text}` per line) at startup into
  an **in-memory** SQLite database:
  `CREATE VIRTUAL TABLE chunks USING fts5(id UNINDEXED, source UNINDEXED, title, text)`
- Build the MATCH expression from the query: lowercase it, take every `[a-z0-9]+` token,
  drop tokens shorter than 2 characters, join with ` OR `.
- `SELECT id, title, source, text FROM chunks WHERE chunks MATCH ? ORDER BY bm25(chunks) LIMIT 5`
- Both implementations must produce the same top hit for the same query. The harness
  checks this.

## Interface

| env | meaning |
|---|---|
| `PORT` | HTTP port |
| `SLACK_SIGNING_SECRET` | webhook signing secret (the harness uses `test-signing-secret`) |
| `SLACK_BOT_TOKEN` | bot token (any string; the mock ignores it) |
| `SLACK_API_URL` | Slack Web API base, e.g. `http://localhost:8910/slack/api` (default `https://slack.com/api`) |
| `ANTHROPIC_API_KEY` | any string for the mock |
| `ANTHROPIC_BASE_URL` | e.g. `http://localhost:8910/anthropic` |
| `CORPUS` | path to `corpus.jsonl` |

- `POST /slack/events`: the webhook
- `GET /healthz`: `200 ok` once the index is loaded (the harness times startup against it)

## Stack rules

**TypeScript (`ts/`)**: must be built on **June**, used as an external consumer from npm:
`@junejs/core@0.2.0-dev.39` and `@junejs/server@1.0.0-dev.20`, never the June source
tree. Use June's Slack channel (`slackChannel`, `stream: true`), its agent runtime and
its `anthropic()` model adapter. Where June already does something (signature checks,
acking, retries, the tool loop, streaming to Slack), use it and do not rewrite it. Use
`bun:sqlite` for FTS5. Run on Bun. If June cannot do something the spec requires, write
the smallest workaround and record it in `NOTES.md`. That is a finding, not a failure.

**Go (`go/`)**: `github.com/anthropics/anthropic-sdk-go` (the official SDK),
`github.com/slack-go/slack` (verification, event parsing, Web API), a pure-Go SQLite
with FTS5 (`modernc.org/sqlite`, so the binary stays static), and the standard library
`net/http`. Coalesce streamed text so `chat.appendStream` is called at most every
250 ms, plus a final flush. If slack-go lacks a streaming method, call the Web API
directly and record it in `NOTES.md`.

## Deliverables (in your directory)

- the source
- `build.sh`: produces a single executable at `dist/app` (TS: `bun build --compile`;
  Go: `CGO_ENABLED=0 go build`)
- `run.sh`: runs `dist/app`, taking config from the environment
- `NOTES.md`: what you hit. Include SDK or framework gaps, workarounds, anything the
  spec asked for that the stack made hard or easy, what happens to an in-flight answer
  if the process crashes, and your honest take on the developer experience. Keep it
  under 60 lines.

## Done means

With the mock running and your service running, this passes with `ok` equal to `n` and
zero failures:

```bash
bun harness/mock.ts                          # PORT, TTFT_MS, TOKENS, TOKEN_DELAY_MS env
bun harness/drive.ts --target http://localhost:<port>/slack/events --mock http://localhost:<mockport> --n 40 --c 4
```

Do not change anything under `harness/`. If you believe the harness is wrong, say so in
`NOTES.md` and stop. Do not work around it.
