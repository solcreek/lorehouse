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

The Nix flake (`nix develop`, `nix build`; see `docs/nix.md`) covers Linux and Apple
Silicon only. **Intel Macs (`x86_64-darwin`) are not supported by the flake**: nixpkgs
dropped the platform in 26.11. On an Intel Mac, install Bun from Homebrew
(`brew install bun`) or bun.sh and run the commands above directly. Run them through
`bun`, never `node`/`npx`: a Mac with both nvm and Homebrew Node can have two Node ABIs
on the `PATH`, and a run under the wrong one fails in ways that look like regressions.
(`bun run typecheck` still runs `tsc` under the first `node` on the `PATH`, as its
shebang asks; `tsc` has no native modules, so either Node gives the same result.)

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
