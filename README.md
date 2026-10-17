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
  - An edit is reflected, and a deleted message leaves the knowledge index, so no new
    search finds it, including a secret someone pasted and then removed. Its text leaves
    `LOREHOUSE_DB`'s files too, the `-wal` included.
  - Changes made while it was down are caught up on the next start.
  - A channel taken off `AGENT_CHANNELS` is forgotten the same way on the next start: its
    threads leave the index and `LOREHOUSE_DB`'s files, and it stops answering follow-ups
    in threads it was asked into there.
  - Other copies can remain after a deletion or an unlisting. Among them:
    - usage records (that a question was asked, and the agent's search queries, which can
      repeat its words): until usage's 90-day retention prunes them, sooner in some
      cases ([#98](https://github.com/solcreek/lorehouse/issues/98) tracks clearing them on every deletion);
    - the agent's saved conversations (`SESSIONS_DB`): every turn's full tool results
      (whole search results, not only what was quoted) and its answers, in any thread, so
      a later turn there can bring the text up again, until June supports redaction
      ([junebuild/june#360](https://github.com/junebuild/june/issues/360)). To erase them now, stop the app and delete `SESSIONS_DB`: every thread's
      memory goes with it.

    The agent's own replies in Slack keep what they quoted until they are deleted there.
- **Works in your team's languages.** Chinese, Japanese and Korean are searchable word by
  word, not only in English. It replies in the language it was asked in.
- **Knows people by name, and never pings them.**
  - It credits each message to whoever wrote it, by name.
  - It names people as plain text. A summary never @-mentions everyone in it.
- **Carries on the conversation.** Once it's mentioned in a thread, a plain reply there
  gets an answer, no new mention needed. It stays out of threads it wasn't asked into,
  and out of replies that mention someone else, a group, or @channel / @here.
- **Learns procedures you review.** A skill is a Markdown file in `prompts/skills/`:
  frontmatter with `name`, `description` and `when-to-use`, then the steps. The agent sees
  every skill's name, description and when-to-use, and loads the steps with `read_skill`
  when a request fits. Add one in a pull request, with its import in the `SKILLS` map of
  `src/prompts.ts` (a test fails when a file is missing there); it goes live with the next
  deploy. The first, `channel-digest`, fixes the shape of a "what's been discussed lately"
  report.
- **Public by default.** It works only in public channels, so everyone learns from
  everyone's questions. A DM gets a one-line pointer to the public channel. It can also be
  set to answer DMs, or to ignore them. Either way, a DM never becomes knowledge.
- **Directs agents, in a sandbox** *(experimental)*. With a sandbox attached, it can
  clone a repo, run the tests and open a pull request. The pull request waits for an
  Approve in the thread. The sandbox is designed as one Firecracker microVM per thread; so
  far it has only been proven in a spike. Reading needs no Approve: installing its GitHub
  App on a repository, private or not, lets anyone in the agent's channels have it read that
  repository and quote it in the thread ([what that allows](docs/github-app.md#what-installing-on-a-repository-allows)).

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
| **Render** | image and disk proven, not yet with Slack | the [`render.yaml`](render.yaml) Blueprint: the published image and a disk ([steps](docs/nix.md#render)) |
| **Railway** | image and volume proven, not yet with Slack | the published image and a volume, with the CLI ([steps](docs/nix.md#railway)) |
| **Cloudflare Workers** | exploring | needs June's edge host and Durable Object storage instead of a SQLite file |
| **Your laptop** | works today | `bun start` behind a quick tunnel, for trying it out ([runbook](docs/live-slack.md)) |

Every host needs the same few things:

- a writable data directory (`LOREHOUSE_DATA_DIR`): the SQLite files go in its tenant's directory under it (a `LOREHOUSE_DB` or `SESSIONS_DB` set elsewhere needs its own directory writable too)
- the Slack and Anthropic secrets as environment variables
- outbound HTTPS to Slack and Anthropic

The sandbox is separate. It runs on hosts with KVM, such as bare metal or a VM with nested
virtualization. Those hosts **connect out** to Lorehouse, the way CI runners do, over
WebSocket or long poll, whichever your network allows. So they need no open port, and the
sandbox API is never on the internet. They can sit in a data center, a company network or
behind NAT. The host running Lorehouse itself needs no KVM. See
[sandbox runners](docs/sandbox-runners.md) and [`sandboxd`](sandbox/host/README.md).

### On Fly.io

[`fly.toml`](fly.toml) runs the published image, `ghcr.io/solcreek/lorehouse:main` (about
50 MB to pull; [Nix](docs/nix.md#hosts)), so nothing is built. For your own install,
`:latest`, the newest release, is the steadier choice. The volume is the data directory,
`/data`: `settings.json` in it, the SQLite files in `/data/<tenant>/`. An image from before
tenants kept them in `/data` itself; the first start of a newer one moves them (checkpointed, then by hard link and rename),
leaving a symlink at each old path, so rolling back to the older image is safe
(see `LOREHOUSE_DATA_DIR` below). Set `app` in `fly.toml` to your own name, then:

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
2. In Settings → Environments, create `production`, set "Deployment branches and tags"
   to `main` only, and store the token there as the `FLY_API_TOKEN` environment secret
   (`gh secret set FLY_API_TOKEN --env production`), not as a repository secret: then
   only jobs on `main` that name the `production` environment (in this repository,
   just `deploy`) can read it.
3. In [`ci.yml`](.github/workflows/ci.yml), change the repository check on both the
   `image` and the `deploy` job: deploy runs the image that the `image` job publishes
   to your repository's `ghcr.io/<owner>/<repo>`.
4. After the first publish, make that package public
   ([how](docs/nix.md#hosts)), so Fly can pull it.

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
`/status` reports, and that it serves the same tenant.

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
| `AGENT_CHANNELS` | (none) | the public channel ids it works in: answers mentions and follow-ups, counts reactions, and learns from. Empty means **nowhere**. Only public channels: on start, each one is looked up (`conversations.info`, needs `channels:read`) and the app **refuses to start** while any is private, archived, or can't be looked up, naming each; a channel that turns private or is archived while the app runs (Slack then answers that it's private, archived, or not visible to the bot) is found at the next recheck (`INGEST_CHANNEL_RECHECK_MS`), then no longer read and its mentions refused (best effort for work already running at that moment: a turn admitted before the close finishes, and may still read its own thread; a reconcile in progress may finish its reads); what was learned there goes once it is taken off this list. ⚠️ On each start, what was learned from a channel no longer listed is purged from `LOREHOUSE_DB`: its threads leave the index (and `LOREHOUSE_DB`'s files, the `-wal` included), with the threads it was asked into there, its ingest cursor, and usage's asks and searches there. Seeded documents stay, as do 👍/👎 counts (no text). Other copies of its text can remain, among them usage records, until usage's 90-day retention prunes them ([#98](https://github.com/solcreek/lorehouse/issues/98)), and the agent's saved conversations in `SESSIONS_DB` (below), until June supports redaction ([junebuild/june#360](https://github.com/junebuild/june/issues/360)). **An empty list purges every thread learned from Slack.** `lorehouse doctor` shows what the next start would purge |
| `DM_MODE` | `redirect` | what a DM gets: `redirect` (a one-line pointer to the public channel, no model call, nothing read), `ignore`, or `answer` (from the knowledge index, the same as a public answer, plus the DM conversation itself; not with the code tools). A DM is never indexed |
| `STATUS_TOKEN` | (none) | bearer token for `GET /status` (`Authorization: Bearer …`). Unset, `/status` is closed (404). `/healthz` is always open and says only `ok` |
| `ADMIN_TOKEN` | (none) | bearer token for the read-only [admin API](docs/admin-api.md) under `/api/v1`: the indexed threads and their text, search, the agent's threads, the sandboxes. 32+ characters, and not the `STATUS_TOKEN`. Unset, `/api/` is closed (404) |
| `USAGE_RECORD_PEOPLE` | (off) | `1` makes [usage](docs/admin-api.md#usage) record who asks the agent things; each channel is told, and turning it off erases them. Off, usage never says who asked |
| `PDF_REPLIES` | (off) | `1` lets the agent attach a PDF to its reply when asked for a report or document (`render_pdf`). Needs the `files:write` scope (in `slack/manifest.yaml`; `lorehouse doctor` checks it while this or code tools are on) |
| `PDF_FONTS` | `local` | where PDF fonts come from, which decides where a document's text goes. `local`: Noto Sans TC, bundled in the binary and image (~11 MB); rendering contacts no one. `google`: Noto Sans TC subsets from Google Fonts, so fonts.googleapis.com and fonts.gstatic.com see every distinct non-ASCII character of each document, in the order each first appears. Either way, a character no font covers fails the PDF with an error the agent passes on, never a PDF with it missing. `lorehouse doctor` says which is in use |
| `FILE_STORE` | `memory` | where a file the agent attaches (a PDF, or a file from the sandbox) waits until it is uploaded to the thread: `memory`, in the process and never on disk. It stays after the upload until 64 MiB of newer files push it out or the process restarts. `blob` (kept on disk) is planned, not yet available |
| `TENANT_ID` | the one found, or a new one | the tenant this install serves: one organization, whose files are its own ([ADR 0005](docs/adr/0005-tenancy-and-extension-points.md) §1). Its id is in every database path, sandbox id and log line (`tenant=<id> …`), and `GET /status`, the admin API and `lorehouse doctor` name it. 1–32 lowercase letters, digits or inner hyphens. Unset, it is the one tenant directory in `LOREHOUSE_DATA_DIR` (named by its `tenant.json`), and with none, a new id (`t-…`) made on the first start and kept there. It isn't taken from Slack, so reinstalling the Slack app never changes it. With two tenant directories and none chosen, the app refuses to start. So does a `TENANT_ID` that has no directory yet in a data directory holding another tenant's (a changed id would otherwise start on empty data), unless `TENANT_NEW` is set |
| `TENANT_NEW` | (off) | `1` lets a `TENANT_ID` with no directory yet start empty beside another tenant's directory. The files of the layout before tenants (`lorehouse.db` and `sessions.db` at the top of the data directory, or the links a move left there) belong to the first tenant only: a tenant made this way never moves, links over or refuses anything there, and its `tenant.json` says so (`"legacy": false`). Only that first start needs it: once the tenant has its own directory, the start and `lorehouse doctor` take it without, and the doctor warns that the other tenant's directory is there |
| `LOREHOUSE_DATA_DIR` | the directory `LOREHOUSE_DB` names, else the working directory | the install's data directory: `settings.json`, and each tenant's files in `<dir>/<tenant>/` (`tenant.json`, `lorehouse.db`, `sessions.db`). `GET /status` shows it (`dataDir`). An install from before tenants, with `lorehouse.db` and `sessions.db` in this directory and `LOREHOUSE_DB` unset, upgrades in place on its first start: each database is checkpointed where it is (its `-wal` emptied), then moves into the tenant's directory by hard link and rename, its `-wal` and `-shm` after it, logged as `storage: moved …`. The old path is never missing, and nothing is copied. A `-wal`, `-shm` or `-journal` in the tenant's directory that isn't the database's own is renamed aside (`….stale-<time>`), never replayed; a start that dies part-way finishes the move on the next; a second start moves nothing. Each old path is left a symlink to the file's new place, so an older version, which still names `<dir>/lorehouse.db`, opens the same database (SQLite puts its `-wal` and `-shm` beside the file itself): rolling back is safe, and rolling forward again finds everything moved. Removing those symlinks is a later, deliberate cleanup, once no older version will run. Where the tenant's directory already has a file and the old path holds a real one too, an old path is a symlink to anywhere else, or the move would cross filesystems, the app refuses to start and says which. `lorehouse doctor` shows what the next start moves |
| `LOREHOUSE_DB` | `lorehouse.db` in the tenant's directory | Lorehouse's own data (knowledge index). Set, it is used where it is and never moved, and `SESSIONS_DB` defaults to a file beside it |
| `SESSIONS_DB` | `sessions.db` beside `LOREHOUSE_DB` | the agent framework's conversation state, including a turn waiting on an Approve, so it survives a restart. `:memory:` keeps it in memory (lost on every restart), as it is when `LOREHOUSE_DB` is `:memory:`. It keeps every turn whole: its tools' full results (whole search results, not only what was quoted) and its answers, in every conversation. A message deleted in Slack, or from a channel taken off `AGENT_CHANNELS`, stays there, and a later turn in that conversation can bring it up again, until June supports redaction ([junebuild/june#360](https://github.com/junebuild/june/issues/360)). To erase it now, stop the app and delete this file: every thread's memory goes, a turn waiting on an Approve too |
| `KNOWLEDGE_SEED` | (none) | JSONL of `{id, source, title, text}` to index on first start |
| `INGEST_BACKFILL_DAYS` | `90` | how far back to read each allowed channel's history on first start (`0` = live only) |
| `INGEST_REFRESH_DAYS` | `14` | on each start, re-check threads this recent for replies, edits and deletions made while the app was down |
| `INGEST_DEBOUNCE_MS` | `5000` | how long a thread must go quiet before a live change re-indexes it |
| `INGEST_CHANNEL_RECHECK_MS` | `3600000` | how often each `AGENT_CHANNELS` channel is looked up again, to close one turned private or archived while running; `0` never looks again (the start still checks) |
| `SANDBOX_RUNNER_TOKEN` | (off) | code tools and pull requests, with sandbox hosts connecting in ([runners](docs/sandbox-runners.md)); 32+ characters. Code tools attach files from the sandbox, so they need the `files:write` scope |
| `SANDBOX_URL` `SANDBOX_TOKEN` | (off) | code tools with one sandbox host Lorehouse calls, e.g. on the same machine; `https://`, or `http://` only to this machine (localhost, 127.0.0.0/8, `[::1]`); not together with `SANDBOX_RUNNER_TOKEN` |
| `GITHUB_APP_ID` `GITHUB_APP_PRIVATE_KEY` | (none) | the GitHub App the code tools clone and open pull requests as: a short-lived token per repo, and write access only once a pull request is approved ([setup](docs/github-app.md)). Required with a sandbox |
| `GITHUB_TOKEN` | (none) | instead of an App, for development only: one long-lived token with everything it can reach |
| `PR_APPROVER` | `requester` | who may click Approve or Deny on a pull request card: only the `requester`; `anyone` in the thread, the requester included; or `not-requester`, anyone but the requester (who can't click Deny either). The requester is the person whose message got the agent to post the card. Approve opens a draft pull request; merging it is up to GitHub's review. `GET /status` shows it (`pullRequestApprover`), and `lorehouse doctor` says it |

## One contract, more than one implementation

The behavior is pinned by a black-box conformance suite, not by the code. It drives a
mocked Slack and a mocked model through the same HTTP interface any implementation
serves. Examples:

- a Chinese question finds a Chinese message
- a deleted message stops being cited, and its text leaves the database's files
- a DM is never indexed
- a restart catches up on what it missed

Today's implementation is TypeScript on [June](https://june.build). The suite is what a
Go or Rust version would have to pass
([why TypeScript first](docs/adr/0001-typescript-first-conformance-as-contract.md)).

## Layout

| path | what |
|---|---|
| `src/` | the TypeScript implementation (on [June](https://june.build)) |
| `prompts/` | the system prompt, tool descriptions and skills (`skills/`), as Markdown |
| `migrations/` | Lorehouse's own data, as plain SQL |
| `conformance/` | the behavioral contract: a mocked Slack + Anthropic, and black-box scenarios |
| `slack/` | the Slack app manifest |
| `sandbox/` | the sandbox: the host daemon ([`host/`](sandbox/host/README.md), Rust), the in-VM agent (`guest/`, Go) and the feasibility spike |
| `docs/` | the live-Slack runbook and its results, decisions (`adr/`) and experiments |
| `flake.nix`, `nix/` | the pinned toolchain (`nix develop`), the binary and the container image ([Nix](docs/nix.md)) |

## Check it

With [Nix](docs/nix.md), `nix develop` gives the toolchain, and `nix flake check` runs
the contract against the binary Nix builds.

```bash
bun run typecheck && bun run test
bun run conformance                          # against the source
bun run build && bun run conformance --app ./dist/lorehouse
```

## License

[MIT](LICENSE), © SolCreek, Inc.
