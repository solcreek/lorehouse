# Lorehouse

An open-source company brain. It lives in your team's public Slack channels. It answers
from what the company already knows, directs agents, and runs proofs of concept in a
sandbox of its own.

You name it per install; it defaults to `scout`.

> Status: pre-alpha. The knowledge side runs against real Slack; the agent and sandbox
> side is experimental.

## What it does

- **Answers from your team's own Slack, and shows where.** Every thread in the channels
  you allow becomes knowledge: the root and its replies, from the past 90 days on first
  start, then live. Each answer cites the thread's permalink.
- **Stays true to Slack.**
  - An edit is reflected, and a deleted message stops being quotable, including a secret
    someone pasted and then removed.
  - Changes made while it was down are caught up on the next start.
- **Works in your team's languages.** Chinese, Japanese and Korean are searchable word by
  word, not only in English. It replies in the language it was asked in.
- **Knows people by name, and never pings them.**
  - It credits each message to whoever wrote it, by name.
  - It names people as plain text. A summary never @-mentions everyone in it.
- **Public by default.** It works only in public channels, so everyone learns from
  everyone's questions. A DM gets a one-line pointer to the public channel. It can also be
  set to answer DMs, or to ignore them. Either way, a DM never becomes knowledge.
- **Directs agents, in a sandbox** *(experimental)*. With a sandbox attached, it can
  clone a repo, run the tests and open a pull request. The pull request waits for an
  Approve in the thread. The sandbox is designed as one Firecracker microVM per thread; so
  far it has only been proven in a spike.

## Deploy it where you already run things

Lorehouse is meant to be easy to host. It needs:

- **One self-contained binary.** Prompts and database migrations are compiled in.
- **One SQLite file.** No database server, queue or cache to run beside it.
- **One HTTPS URL** that Slack can reach.

It tolerates restarts. Slack redelivers events it didn't get an answer to, and on start
Lorehouse reconciles whatever changed while it was down. A plain single-instance deploy
is enough; no zero-downtime setup is needed. A prototype of the same stack used about
70 MB idle and 310 MB with 100 concurrent conversations on Linux
([measurements](docs/experiments/slack-rag/RESULTS.md)).

| where | status | how |
|---|---|---|
| **Linux you run**: a server at home, a Hetzner box, any VPS | works today | the compiled binary under systemd; HTTPS from Caddy or a Cloudflare Tunnel. CI builds the Linux binary and runs the full conformance suite against it on every change |
| **Fly.io** | works today | one always-on machine with a volume for the SQLite files ([`fly.toml`](fly.toml), [below](#on-flyio)) |
| **Render** | planned | a web service with a persistent disk |
| **Cloudflare Workers** | exploring | needs June's edge host and Durable Object storage instead of a SQLite file |
| **Your laptop** | works today | `bun start` behind a quick tunnel, for trying it out ([runbook](docs/live-slack.md)) |

Every host needs the same few things:

- a writable path for the SQLite file (`LOREHOUSE_DB`, `SESSIONS_DB`)
- the Slack and Anthropic secrets as environment variables
- outbound HTTPS to Slack and Anthropic

The sandbox is separate. It needs a host with KVM, such as bare metal or a VM with nested
virtualization, and Lorehouse reaches it over `SANDBOX_URL`. The host running Lorehouse
itself needs no KVM.

### On Fly.io

The [`Dockerfile`](Dockerfile) packs the binary into a 178 MB image. The SQLite files go
under `/data`. Set `app` in `fly.toml` to your own name, then:

```bash
fly apps create <app>
fly volumes create lorehouse_data --region <region> --size 1 -a <app>
fly secrets set -a <app> --stage SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=… \
  ANTHROPIC_API_KEY=… AGENT_CHANNELS=C0123456 STATUS_TOKEN="$(openssl rand -hex 32)"
fly deploy
```

Then point the Slack app's Request URL at `https://<app>.fly.dev/slack/events`. A fresh
volume backfills from Slack on first start, so nothing needs copying over. Keep the
`STATUS_TOKEN` you set: without it `/status` is closed to you too.

CI deploys every merge to `main` that passes the conformance suite. To do the same:

1. Create a token that can deploy only this app: `fly tokens create deploy -a <app>`.
2. Store it as the `FLY_API_TOKEN` repository secret.
3. Change the repository check in [`ci.yml`](.github/workflows/ci.yml).

The deploy job pins its actions to commit SHAs, because it holds that token.

## Run it

```bash
bun install
SLACK_SIGNING_SECRET=… SLACK_BOT_TOKEN=xoxb-… ANTHROPIC_API_KEY=… \
AGENT_CHANNELS=C0123456 \
bun start                       # POST /slack/events, GET /healthz, GET /status (with STATUS_TOKEN)

bun run build                   # → dist/lorehouse, a single binary
```

To set up Slack:

1. Create the app from [`slack/manifest.yaml`](slack/manifest.yaml). It lists the scopes
   and why each is needed.
2. Subscribe to the events `app_mention`, `message.channels` and `message.im`.
3. Invite the bot to each allowed channel. Slack won't serve history to a non-member, so
   the backfill fails with `not_in_channel`, and `GET /status` shows the error.

[`docs/live-slack.md`](docs/live-slack.md) walks through it end to end.

| env | default | |
|---|---|---|
| `AGENT_NAME` | `scout` | the agent's handle; must match the Slack app's display name |
| `AGENT_CHANNELS` | (none) | channel ids it may answer mentions in. It never works in private channels |
| `DM_MODE` | `redirect` | what a DM gets: `redirect` (a one-line pointer to the public channel, no model call), `ignore`, or `answer` (from public knowledge; not with the code tools). A DM is never indexed |
| `STATUS_TOKEN` | (none) | bearer token for `GET /status` (`Authorization: Bearer …`). Unset, `/status` is closed (404). `/healthz` is always open and says only `ok` |
| `LOREHOUSE_DB` | `lorehouse.db` | Lorehouse's own data (knowledge index) |
| `SESSIONS_DB` | `:memory:` | the agent framework's conversation state |
| `KNOWLEDGE_SEED` | (none) | JSONL of `{id, source, title, text}` to index on first start |
| `INGEST_BACKFILL_DAYS` | `90` | how far back to read each allowed channel's history on first start (`0` = live only) |
| `INGEST_REFRESH_DAYS` | `14` | on each start, re-check threads this recent for replies, edits and deletions made while the app was down |
| `INGEST_DEBOUNCE_MS` | `5000` | how long a thread must go quiet before a live change re-indexes it |
| `SANDBOX_URL` `SANDBOX_TOKEN` `GITHUB_TOKEN` | (off) | set all three to enable the code tools and pull requests |

## One contract, more than one implementation

The behavior is pinned by a black-box conformance suite, not by the code. It drives a
mocked Slack and a mocked model through the same HTTP interface any implementation
serves. Examples:

- a Chinese question finds a Chinese message
- a deleted message stops being cited
- a DM is never indexed
- a restart catches up on what it missed

Today's implementation is TypeScript on [June](https://june.build). The suite is what a
Go or Rust version would have to pass
([why TypeScript first](docs/adr/0001-typescript-first-conformance-as-contract.md)).

## Layout

| path | what |
|---|---|
| `src/` | the TypeScript implementation (on [June](https://june.build)) |
| `prompts/` | the system prompt and tool descriptions, as Markdown |
| `migrations/` | Lorehouse's own data, as plain SQL |
| `conformance/` | the behavioral contract: a mocked Slack + Anthropic, and black-box scenarios |
| `slack/` | the Slack app manifest |
| `sandbox/` | the sandbox: the host daemon ([`host/`](sandbox/host/README.md), Rust), the in-VM agent (`guest/`, Go) and the feasibility spike |
| `docs/` | the live-Slack runbook and its results, decisions (`adr/`) and experiments |

## Check it

```bash
bun run typecheck && bun run test
bun run conformance                          # against the source
bun run build && bun run conformance --app ./dist/lorehouse
```
