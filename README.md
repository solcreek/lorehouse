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
- **Carries on the conversation.** Once it's mentioned in a thread, a plain reply there
  gets an answer, no new mention needed. It stays out of threads it wasn't asked into,
  and out of replies that mention someone else, a group, or @channel / @here.
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

The sandbox is separate. It runs on hosts with KVM, such as bare metal or a VM with nested
virtualization. Those hosts **connect out** to Lorehouse, the way CI runners do, over
WebSocket or long poll, whichever your network allows. So they need no open port, and the
sandbox API is never on the internet. They can sit in a data center, a company network or
behind NAT. The host running Lorehouse itself needs no KVM. See
[sandbox runners](docs/sandbox-runners.md) and [`sandboxd`](sandbox/host/README.md).

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

Then point the Slack app at `https://<app>.fly.dev/slack/events`, in two places: **Event
Subscriptions** (the Request URL) and, with the code tools on, **Interactivity** (the same
URL; without it the Approve/Deny buttons on a pull request answer "This app is not
configured to handle interactive responses"). A fresh
volume backfills from Slack on first start, so nothing needs copying over. Keep the
`STATUS_TOKEN` you set: without it `/status` is closed to you too.

To check the deployment, run the doctor on the machine itself, where the secrets are
already in its environment:

```bash
fly ssh console -a <app> -C "lorehouse doctor --url https://<app>.fly.dev"
```

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
bun start                       # POST /slack/events, GET /healthz, GET /status (with STATUS_TOKEN), /api/v1 (with ADMIN_TOKEN)

bun run build                   # → dist/lorehouse, a single binary
```

Before starting, and whenever something doesn't answer, run the doctor with the same
environment. It asks Slack, Anthropic, GitHub and the sandbox host directly, and says what
to fix: a bot not invited to a channel, a missing scope, a model that doesn't exist, a
GitHub App that can't open pull requests. With `--url` it also checks the running
deployment: that it answers Slack's URL check with the same signing secret, and what
`/status` reports.

```bash
bun run doctor                          # or: lorehouse doctor
lorehouse doctor --url https://<app>    # also the running deployment
```

It exits 1 if anything failed, so it can gate a deploy.

**After upgrading, run it again.** A new version can need more from Slack than the app you
installed was granted. When `slack/manifest.yaml` gains a scope (as `reactions:read` came
with usage feedback), the doctor fails on it until you add the scope under **OAuth &
Permissions** and reinstall the app. The doctor can't see event subscriptions with a bot
token, so compare yours with the events in step 2 below, too.

To set up Slack:

1. Create the app from [`slack/manifest.yaml`](slack/manifest.yaml). It lists the scopes
   and why each is needed.
2. Subscribe to the events `app_mention`, `message.channels`, `message.im`, and
   `reaction_added` and `reaction_removed` (the 👍/👎 in [usage](docs/admin-api.md#usage)).
3. Invite the bot to each allowed channel. Slack won't serve history to a non-member, so
   the backfill fails with `not_in_channel`, and `GET /status` shows the error.
   `lorehouse doctor` checks all three before you start.

[`docs/live-slack.md`](docs/live-slack.md) walks through it end to end.

| env | default | |
|---|---|---|
| `AGENT_NAME` | `scout` | the agent's handle; must match the Slack app's display name |
| `AGENT_CHANNELS` | (none) | channel ids it may answer mentions in. It never works in private channels |
| `DM_MODE` | `redirect` | what a DM gets: `redirect` (a one-line pointer to the public channel, no model call), `ignore`, or `answer` (from public knowledge; not with the code tools). A DM is never indexed |
| `STATUS_TOKEN` | (none) | bearer token for `GET /status` (`Authorization: Bearer …`). Unset, `/status` is closed (404). `/healthz` is always open and says only `ok` |
| `ADMIN_TOKEN` | (none) | bearer token for the read-only [admin API](docs/admin-api.md) under `/api/v1`: the indexed threads and their text, search, the agent's threads, the sandboxes. 32+ characters, and not the `STATUS_TOKEN`. Unset, `/api/` is closed (404) |
| `USAGE_RECORD_PEOPLE` | (off) | `1` makes [usage](docs/admin-api.md#usage) record who asks the agent things; each channel is told, and turning it off erases them. Off, usage never says who asked |
| `LOREHOUSE_DB` | `lorehouse.db` | Lorehouse's own data (knowledge index) |
| `SESSIONS_DB` | `:memory:` | the agent framework's conversation state |
| `KNOWLEDGE_SEED` | (none) | JSONL of `{id, source, title, text}` to index on first start |
| `INGEST_BACKFILL_DAYS` | `90` | how far back to read each allowed channel's history on first start (`0` = live only) |
| `INGEST_REFRESH_DAYS` | `14` | on each start, re-check threads this recent for replies, edits and deletions made while the app was down |
| `INGEST_DEBOUNCE_MS` | `5000` | how long a thread must go quiet before a live change re-indexes it |
| `SANDBOX_RUNNER_TOKEN` | (off) | code tools and pull requests, with sandbox hosts connecting in ([runners](docs/sandbox-runners.md)); 32+ characters |
| `SANDBOX_URL` `SANDBOX_TOKEN` | (off) | code tools with one sandbox host Lorehouse calls, e.g. on the same machine; not together with `SANDBOX_RUNNER_TOKEN` |
| `GITHUB_APP_ID` `GITHUB_APP_PRIVATE_KEY` | (none) | the GitHub App the code tools clone and open pull requests as: a short-lived token per repo, and write access only once a pull request is approved ([setup](docs/github-app.md)). Required with a sandbox |
| `GITHUB_TOKEN` | (none) | instead of an App, for development only: one long-lived token with everything it can reach |

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

## License

[MIT](LICENSE), © SolCreek, Inc.
