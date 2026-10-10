# AGENTS.md

Guidance for coding agents (Claude Code, Cursor, Codex, …) working in this repository.

## What this is

Lorehouse is a Slack agent ("company brain", default handle `scout`) that indexes the
threads of allowed **public** channels into SQLite and answers mentions from them with
permalink citations. An experimental side clones repos, runs code and opens PRs inside a
Firecracker sandbox. TypeScript on Bun and the [June](https://june.build) agent framework.

## Commands

```bash
bun install
bun run typecheck                    # tsc --noEmit over src/, test/, conformance/
bun run test                         # bun test test/
bun test test/core.test.ts           # one file
bun test test/core.test.ts -t "migrations apply"   # one test by name
bun run conformance                  # black-box contract against `bun src/server.ts`
bun run build                        # → dist/lorehouse (single compiled binary)
bun run conformance --app ./dist/lorehouse          # the same contract against the binary
bun start                            # serve (needs Slack/Anthropic env, see README)
bun run doctor                       # check Slack/Anthropic/GitHub/sandbox setup; exits 1 on failure
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, conformance on source, build, and
conformance on the binary; plus the sandbox guest (`go vet/test/build` in
`sandbox/guest`), host (`cargo clippy -D warnings`, `cargo test --locked` in
`sandbox/host`) and the website build. A merge to `main` deploys to Fly.io.
`conformance/run.ts` has no scenario filter; it runs everything.

## Architecture

**The contract is behavior, not code** (`docs/adr/0001-…`). `conformance/run.ts` starts
the app as a subprocess, speaks only HTTP to it, and inspects what a mocked Slack +
Anthropic (`conformance/mock.ts`, reached via `SLACK_API_URL` / `ANTHROPIC_BASE_URL`)
observed. Its scripted model echoes the top search hit as `[cite:…]`/`[src:…]`.
`conformance/fixtures/expected-cites.json` pins the search ranking. A user-visible
behavior change means a conformance scenario change, reviewed like an API change.

**Entry and wiring.** `src/server.ts` dispatches `lorehouse` (serve), `lorehouse setup`
(`src/setup.ts`) and `lorehouse doctor` (`src/doctor.ts`). With setup-provided secrets
missing it serves a "setup mode" instead of crashing. `src/app.ts` is the **only** file
that wires June (agent definition, Slack channel, routes for `/slack/events`, `/status`,
`/api/v1` admin, sandbox runners). Tools, policy, prompts and the knowledge store must not
import June session internals.

**Embedded assets.** `prompts/*.md` and `migrations/*.sql` are imported as text
(`with { type: "text" }`); `slack/manifest.yaml` is imported with no attribute, and Bun
parses it into an object (`src/text-imports.d.ts`). Either way `bun build --compile`
embeds them; the binary conformance run proves it. Consequences:
- A new migration must be added to the list in `src/migrations.ts`; never edit an applied one.
- A new tool prompt must be registered in `src/prompts.ts`. Templates use
  `{{placeholder}}`; an unknown placeholder throws.
- Lorehouse's own data lives in its migrations/DB (`LOREHOUSE_DB`), never in June's
  session tables (`SESSIONS_DB`).
- Contract hygiene: IDs and Slack `ts` are strings; unions are tagged.

**Knowledge.** `src/ingest/slack.ts` backfills each allowed channel on first start
(`INGEST_BACKFILL_DAYS`), re-checks recent threads on every start (`INGEST_REFRESH_DAYS`)
to catch edits/deletes made while down, and re-indexes a thread live after it goes quiet
(`INGEST_DEBOUNCE_MS`). One document per thread (`slack:<channel>:<root ts>`).
`src/knowledge.ts` is SQLite FTS with CJK bigram indexing. Deleted messages must stop being
quotable. DMs are never indexed.

**Policy.** `src/policy.ts` restricts to public channels in `AGENT_CHANNELS`; `src/threads.ts`
decides follow-ups (reply in a joined thread without a new mention, but not when it
mentions someone else/@channel); `src/dm.ts` handles `DM_MODE`. People are named as plain
text, never @-mentioned (`src/tools/slack-names.ts`).

**Configuration** (`src/settings.ts`, `src/config.ts`): per key, first non-empty of the
process env, `LOREHOUSE_ENV_FILE` (default `/etc/lorehouse/lorehouse.env`, written by
`scripts/install.sh`), then `settings.json` beside the DB (written by `lorehouse setup`
and the OAuth install).

**Sandbox (experimental).** Code tools (`src/tools/workspace.ts`, `clone.ts`,
`pull-request.ts`) are on only with `SANDBOX_RUNNER_TOKEN` (hosts connect *out* to
`src/runners/`, over WebSocket or long poll; `docs/sandbox-runners.md`) or
`SANDBOX_URL`/`SANDBOX_TOKEN` (direct, `src/sandbox-client.ts`). `sandbox/host` is the
Rust `sandboxd` (one Firecracker microVM per thread); `sandbox/guest` is the Go in-VM
agent over vsock. GitHub access (`src/github-auth.ts`) is a GitHub App, with a
short-lived token per repo and write access only after an Approve in the thread; or, for
development only, one long-lived `GITHUB_TOKEN`. `src/config.ts` rejects both together.

`website/` is a separate June app (the landing page) with its own `package.json`; see
`website/README.md`.

## Verifying Slack-facing changes

`.claude/skills/verify-lorehouse/SKILL.md` drives an isolated instance against the mocks
as a Slack teammate would. Run from the repo root:

```bash
bun .claude/skills/verify-lorehouse/control.ts launch     # isolated app + mock, DB under /tmp/lorehouse-verify/
bun .claude/skills/verify-lorehouse/control.ts ask --text "..."
bun .claude/skills/verify-lorehouse/control.ts cleanup
```

Never point it at a developer's `bun start` or the website dev server. A drive that only
calls `admin`/`status` did not exercise the feature, and one feature drive does not
replace `bun run conformance`.

## How we work

Given an issue number: `gh issue view <n>`, branch from `main`, do it, run the checks
below for what you touched, open a PR that closes the issue.

**Issues are the work queue.** Write one so an agent can start without a briefing:
`## Goal`, `## Context` (what exists now, with numbers and dates if measured),
`## Where` (files), `## Done when`, `## Verify`.

**Branches, commits, PRs.** One topic per PR, on `<type>/<topic>` (`feat/`, `fix/`,
`docs/`, `chore/`). Commits are atomic and titled like the log: `type(scope): what is
true now`. PRs merge with a merge commit, so each commit should stand alone. To catch up
with `main`, merge it in; never force-push. The PR description:

- `## Why` — the problem, and anything found on the way.
- `## Scope` — one line per commit, then what is out of scope.
- `## Tradeoffs` — what was chosen over what, and the cost.
- `## Blast Radius` — what else changes: the contract, deploys, data, other callers.
- `## Verification` — the commands run and their counts; what isn't verified yet, and
  how to check it after the deploy.

**Stacked PRs.** Base the PR on the branch below it and say so in the first line:
"Stacked on #31. Retarget to `main` once it merges." When the base merges, retarget
it: `gh pr edit <n> --base main`.

**Checks by change.** CI runs all of them on every PR except the verify-lorehouse drive,
which is manual; run the ones you touched first.

| change | run |
|---|---|
| TypeScript (`src/`, `test/`, `conformance/`) | `bun run typecheck`, `bun run test`, `bun run conformance` |
| user-visible behavior | the above, with a conformance scenario changed or added; Slack-facing: also verify-lorehouse (see "Verifying Slack-facing changes" above) |
| `prompts/`, `migrations/`, `slack/manifest.yaml` | the above, then `bun run build` and `bun run conformance --app ./dist/lorehouse` |
| a migration | also `bun test test/core.test.ts -t "migrations apply"` |
| `sandbox/guest` | `go vet ./...`, `go test ./...`, `CGO_ENABLED=0 go build ./...` in that directory. Linux only: on a Mac, vet and build with `GOOS=linux`; `go test` runs in CI |
| `sandbox/host` | `cargo clippy --locked -- -D warnings`, `cargo test --locked` in that directory |
| `website/` | `bun install`, `bun run typecheck`, `bun run build` in that directory |
| `bun.lock`, `go.sum`, `flake.nix`, `nix/` | `nix flake check`; new hashes per `docs/nix.md`. Without Nix (Intel Macs have none), CI's `nix` job runs it |

The mock's scripted model answers from the question, not the prompts: conformance proves
a prompt is embedded and loads, not that its wording works. Say in Verification what
still needs a real model.

**Decisions.** A decision that later work must follow (the contract, where data lives,
a new language or service, a security rule) gets an ADR: `docs/adr/NNNN-<slug>.md`
with Status, Context, Decision and Consequences, as in 0001. A decision made in chat or
in review is written down before it counts: in an ADR, the PR's Tradeoffs, or the issue.
