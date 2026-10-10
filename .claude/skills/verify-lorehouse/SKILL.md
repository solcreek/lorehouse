---
name: verify-lorehouse
description: "Drive an isolated Lorehouse the way a Slack teammate does: mention @scout in the allowed public channel, continue a thread, or send a DM. Use when proving a Slack-facing behavior change, before claiming a mention, reply, DM, or knowledge update works, or when maintaining this feature map. The marketing site in website/ is a separate app and is outside this skill."
---

# Verify Lorehouse

Lorehouse's user surface is Slack. A teammate mentions `@scout` in an allowed public channel, continues that thread, or opens a DM. This skill drives that path against one isolated process. Slack and Anthropic are the stand-in in `conformance/mock.ts`, reached through `SLACK_API_URL` and `ANTHROPIC_BASE_URL` — the same boundary a real workspace uses. The scripted model echoes the first search hit as `[cite:…]` and `[src:…]`. A passing drive proves Lorehouse retrieved that document and posted the reply. It does not prove a hosted model's prose.

The marketing site (`website/`, `bun run dev` on port 3000) and a developer's own `bun start` are not this instance. Never send events to them. Code tools stay off: this instance sets no sandbox or GitHub variables.

Run every command from the repo root. The helper is `.claude/skills/verify-lorehouse/control.ts`. Its stdout is one JSON object. Tokens, ports, and the debounce are the constants and the launch env in that file (`SIGNING_SECRET`, `STATUS_TOKEN`, `ADMIN_TOKEN`, `CHANNEL` = `C1`, `AGENT` = `scout`, `INGEST_DEBOUNCE_MS` = `200`).

## Launch

`bun install` once, from the repo root, when `node_modules/` is missing. Then:

```bash
bun .claude/skills/verify-lorehouse/control.ts launch
```

Launch starts a new process group for the mock and another for `src/server.ts`. It picks free ports, a sqlite file under `/tmp/lorehouse-verify/<runId>/`, and the fixture history in `conformance/fixtures/slack-history.json`. It does not set `KNOWLEDGE_SEED`. It returns when `GET /healthz` is `ok`, this run's pid owns the app port, `GET /status` reports `knowledge.state` `ready`, and the admin API serves `slack:C1:1790000001.000100` containing `quarterly wombat review`.

The JSON includes `runId`, `app`, `mock`, `db`, and `evidence`. The evidence directory is `.claude/skills/verify-lorehouse/artifacts/<runId>/`. Launch writes `/tmp/lorehouse-verify/current`. A second launch starts a second instance and moves `current`. Pass `--run <runId>` to talk to an older one.

Ready does not mean a developer's `.env` was read. The child environment sets every Lorehouse variable itself so an existing `.env` cannot attach this process to a real workspace.

## Doctor

Run this before driving whenever a reply, status code, or port looks wrong:

```bash
bun .claude/skills/verify-lorehouse/control.ts doctor
```

Exit 0 means this run is worth driving. The report checks the recorded pids are alive, their command lines are this repo's `src/server.ts` and `conformance/mock.ts`, those pids own the recorded ports, `/healthz` is `ok`, unauthenticated `/status` is 401, `/status` with the helper's status token shows `@scout` and `knowledge.state` `ready`, the wombat document is indexed, the status token is rejected by the admin API, and the mock's `/stats` answers. Anything else: stop, and do not point the helper at another port.

## Drive

Drive from `features/`. The helper speaks Slack's Events API to this instance and reads the reply the stand-in recorded.

- `ask --text "..."` posts an `app_mention` in `C1` from `U1` and waits until the stand-in finishes the thread stream. It prefixes the Slack text with `[qN]` so the scripted model echoes that nonce. The question a person typed is `--text`. The reply's `cite` and `src` are what the user would see quoted.
- `mention`, `reply`, `dm`, `post`, `edit`, and `delete` perform one Slack action and return. `post`, `edit`, and `delete` also update the stand-in's channel history, which is the Slack history Lorehouse reads back, and deliver the event Slack would deliver.
- `wait --thread <ts>` reads the streamed reply in that thread.
- `quiet --ms 1500` waits, then returns the mock call log. Use it to prove the agent stayed silent.
- `settle --ms 1000` waits past the 200ms ingest debounce, then returns `/status` and the call log.
- `reset-log` clears the mock's recorded calls. Fixtures and `lorehouse.db` stay. Run it before a step whose proof is "no call" or "exactly these posts".
- `status` and `admin --path /api/v1/...` are the operator's read-only views of the same instance. Use them as the second view of a side effect, not as a substitute for the Slack action.
- `stats` is the raw mock call log.

A drive that only calls `admin` or `status` did not exercise the feature.

## Evidence

Pass `--evidence <feature>/<name>.json` on the command whose result is the proof. The helper writes that JSON under the run's evidence directory and adds an `evidence` field with the absolute path.

Capture the action and the resulting state. For a mention, keep the `ask` JSON (the question, the Slack text, the reply, `cite`, `src`) and the admin document for that id. For a DM, keep the `dm` JSON (the posted text, `modelCalls`, `readChannels`, `documents`) and a `status` from before the DM. For silence, keep the `quiet` JSON. For a live message, keep the `post` or `delete` JSON, the `settle` status, and the following `ask` or admin read.

`bun run conformance` is the full contract. One feature drive does not replace it.

The safe path is this isolated instance with the stand-ins. Confirm it did not escape: `db` is under `/tmp/lorehouse-verify/<runId>/`, `mock` is `127.0.0.1`, and doctor reports those pids. A real `SLACK_API_URL` or a browser window means it is not this path.

## Cleanup

```bash
bun .claude/skills/verify-lorehouse/control.ts cleanup
bun .claude/skills/verify-lorehouse/control.ts cleanup --run <runId>
```

Cleanup signals the process groups whose pids are stored for that run and whose command lines are still this repo's server and mock. It then deletes that run's directory, including its sqlite files. It does not delete the evidence directory. After cleanup, the `evidence` path from launch must still be a directory. `list` shows every run still on disk.

Run cleanup after a failed launch too. Launch already does this when it fails itself. An agent that kills the helper mid-launch should `cleanup --run <runId>` so the recorded groups do not keep the ports.

## Helpers

All of these are `bun .claude/skills/verify-lorehouse/control.ts <command>` from the repo root. Repeat `--run <runId>` when `current` is not the instance you intend.

| command | what it does |
|---|---|
| `launch` | start a new isolated instance; print `runId`, URLs, `db`, `evidence` |
| `doctor` | read-only "worth driving?" report; exit 1 when any check fails |
| `ask --text "..."` | mention `@scout` in `C1` and wait for the streamed reply |
| `mention --text "..." [--channel C9] [--channel-type group]` | deliver an `app_mention` without waiting |
| `reply --thread <ts> --text "..."` | deliver a threaded `message` |
| `dm --text "..."` | deliver a DM and wait up to 1500ms for a post or a model call |
| `post --text "..."` | put a person's message in the channel history and deliver it |
| `edit --ts <ts> --text "..."` | edit that Slack message and deliver `message_changed` |
| `delete --ts <ts>` | delete that Slack message and deliver `message_deleted` |
| `wait --thread <ts>` | read the streamed reply for that thread |
| `quiet --ms 1500` | wait, then print the mock call log |
| `settle --ms 1000` | wait past the ingest debounce, then print `/status` and the call log |
| `reset-log` | clear the mock call log only |
| `status` | `GET /status` with this run's status token |
| `admin --path /api/v1/...` | `GET` that admin path with this run's admin token; a 404 is still exit 0 |
| `stats` | mock `GET /stats` |
| `list` | every run directory, and whether its pids are alive |
| `cleanup [--run <runId>]` | stop that run's processes and delete its scratch files; keep evidence |
