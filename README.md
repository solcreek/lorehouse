# Lorehouse

An open-source company brain. It lives in your team's public Slack channels. It answers
from what the company already knows, directs agents, and runs proofs of concept in a
sandbox of its own.

The agent's name is set per install. It defaults to `scout`.

> Status: pre-alpha, not yet usable.

## Run it

```bash
bun install
SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… ANTHROPIC_API_KEY=… \
AGENT_CHANNELS=C0123456 KNOWLEDGE_SEED=./my-docs.jsonl \
bun start                       # POST /slack/events, GET /healthz, GET /status
```

What it knows: every thread in the allowed channels (the root and its replies), read
back `INGEST_BACKFILL_DAYS` on first start and kept current from live messages, edits
and deletions. A deleted message stops being quotable. Changes made while the app was
down are reconciled on the next start. Bot and system messages are left out. Answers
cite the thread's permalink. The Slack app needs
the bot scopes `channels:history`, `app_mentions:read` and `chat:write`, and must be
subscribed to `message.channels` and `app_mention`. Invite the bot to each allowed
channel first. Slack won't serve history to a non-member, so the backfill fails with
`not_in_channel`, and `GET /status` shows the error.

| env | default | |
|---|---|---|
| `AGENT_NAME` | `scout` | the agent's handle; must match the Slack app's display name |
| `AGENT_CHANNELS` | (none) | channel ids it may answer mentions in. It never works in private channels |
| `DM_MODE` | `redirect` | what a DM gets: `redirect` (a one-line pointer to the public channel, no model call), `ignore`, or `answer` (from public knowledge; not with the code tools). A DM is never indexed |
| `LOREHOUSE_DB` | `lorehouse.db` | Lorehouse's own data (knowledge index) |
| `SESSIONS_DB` | `:memory:` | the agent framework's conversation state |
| `KNOWLEDGE_SEED` | (none) | JSONL of `{id, source, title, text}` to index on first start |
| `INGEST_BACKFILL_DAYS` | `90` | how far back to read each allowed channel's history on first start (`0` = live only) |
| `INGEST_REFRESH_DAYS` | `14` | on each start, re-check threads this recent for replies, edits and deletions made while the app was down |
| `INGEST_DEBOUNCE_MS` | `5000` | how long a thread must go quiet before a live change re-indexes it |
| `SANDBOX_URL` `SANDBOX_TOKEN` `GITHUB_TOKEN` | (off) | set all three to enable the code tools and pull requests |

## Layout

| path | what |
|---|---|
| `src/` | the TypeScript implementation (on [June](https://june.build)) |
| `prompts/` | the system prompt and tool descriptions, as Markdown |
| `migrations/` | Lorehouse's own data, as plain SQL |
| `conformance/` | the behavioral contract: a mocked Slack + Anthropic, and black-box scenarios |
| `sandbox/` | the Firecracker sandbox's in-VM agent (Go) and a feasibility spike |
| `docs/adr/` | decisions, starting with [why TypeScript first](docs/adr/0001-typescript-first-conformance-as-contract.md) |

## Check it

```bash
bun run typecheck && bun run test
bun run conformance                          # against the source
bun run build && bun run conformance --app ./dist/lorehouse
```
