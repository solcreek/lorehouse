# Lorehouse verification map

This directory is the maintained source for verifying what a Slack teammate can do with Lorehouse. Read this index, then drive the feature file that matches the behavior under test.

## Baseline preconditions

- Launch and doctor as [SKILL.md](../SKILL.md) describes. Drive only a run whose doctor exits 0.
- The instance's only allowed public channel is `C1`. The agent is `@scout`. Channel history is `conformance/fixtures/slack-history.json`.
- The thread `slack:C1:1790000001.000100` is Wendy's message that the quarterly wombat review moves to Thursdays. Its permalink is `https://acme.slack.com/archives/C1/p1790000001000100`.
- Commands run from the repo root through `bun .cursor/skills/verify-lorehouse/control.ts`.
- Pass `--run <runId>` when more than one verification run is up. `current` is only the latest launch.
- Never send these events to a `bun start` you did not launch here.

## Driving conventions

- Start each recipe from a doctor-clean run. A recipe that needs a thread says which command creates it.
- Run `reset-log` before a step whose proof is a count of posts, model calls, or silence. That clears the mock's call log. It does not change the channel history or the knowledge index.
- `ask` inserts a `[qN]` nonce into the Slack text. Assert `--text` as the question the person asked, and assert `cite` and `src` on the reply.
- Treat every command as literal. Keep quoted text and flags unchanged.
- Capture each listed proof with `--evidence`. Cleanup does not remove those files.

## Proof and skip reporting

- Record the feature file and the entry point you drove in the evidence JSON's command output.
- A mention proof is the reply posted in the thread plus a second read of the indexed document.
- A DM proof is the single Slack post and an unchanged document count.
- A silence proof is a `quiet` log with no model call and no new Slack post.
- Report an entry point you could not reach with the command you ran and the check that failed. Driving a different entry point does not verify the one you skipped.

## Feature entry contract

Each feature file starts with an H1 and one paragraph of user-visible behavior, then four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-lorehouse`, and `Gotchas`.

## Features

- [Ask in the public channel](./ask-in-channel.md) covers a mention that is answered with a citation, and a mention of the bot that does not become knowledge.
- [Continue a thread](./continue-thread.md) covers a plain follow-up in a thread the agent was asked into, and no answer in a thread it was not.
- [Direct message](./direct-message.md) covers the default redirect: one public-channel pointer, no model call, and nothing indexed.
- [Live knowledge](./live-knowledge.md) covers a new channel message becoming citable, and a deletion dropping out of answers and the admin API.
- [Stay quiet](./stay-quiet.md) covers a mention outside the allowlist, a mention in a private channel, and people talking without mentioning the agent.
