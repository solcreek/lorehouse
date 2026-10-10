# Stay quiet

Staying quiet means `@scout` does not answer a mention in a channel it is not allowed to use, a mention in a private channel, or a message in `C1` that does not mention it and is not in a thread it was asked into.

## Sub-features

- `quiet-outside` ignores an `app_mention` in channel `C9`.
- `quiet-private` ignores an `app_mention` in private channel `G1`.
- `quiet-no-mention` ignores a top-level message in `C1` that does not mention the agent.

## How to get to it (user POV)

- Mention `@scout` in a public channel that is not on the allowlist.
- Mention `@scout` in a private channel.
- Post in `C1` without mentioning `@scout`, outside any thread the agent has joined.

## Driving it with verify-lorehouse

Preconditions:

- `doctor` exits 0 for this run.
- This run's allowlist is only `C1`.

- **Outside the allowlist.** Clear the call log and mention the agent in `C9`. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts mention --channel C9 --text "when is the quarterly wombat review" --evidence stay-quiet/outside.json`. Then run `bun .claude/skills/verify-lorehouse/control.ts quiet --ms 1500 --evidence stay-quiet/outside-quiet.json`. `stats.modelCalls` is 0 and `stats.slackCalls` is 0.
- **Private channel.** Clear the call log and mention the agent in `G1`. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts mention --channel G1 --channel-type group --text "when is the quarterly wombat review" --evidence stay-quiet/private.json`. Then run `bun .claude/skills/verify-lorehouse/control.ts quiet --ms 1500 --evidence stay-quiet/private-quiet.json`. `stats.modelCalls` is 0 and `stats.slackCalls` is 0.
- **No mention.** Clear the call log and post an ordinary message. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts post --text "a top-level message, no mention" --evidence stay-quiet/plain.json`. Then run `bun .claude/skills/verify-lorehouse/control.ts quiet --ms 1500 --evidence stay-quiet/plain-quiet.json`. `stats.modelCalls` is 0. `stats.byMethod` has no `chat.startStream` and no `chat.postMessage`.

## Gotchas

- `quiet` has to start from a cleared call log. An earlier mention's `slackCalls` would make a silent step look active.
- The plain message is still ingested after the debounce. Ingest reads Slack, so `stats.slackCalls` may be non-zero. The silence proof for that step is no model call and no chat post. Do not require `slackCalls` 0 there.
- `post` on the plain message adds it to the index. That is live knowledge, not an answer. [Live knowledge](./live-knowledge.md) covers citation.
- A follow-up inside a thread this run already asked in is [Continue a thread](./continue-thread.md), and it should be answered. Do not use that thread as the no-mention case.
