# Continue a thread

Continuing a thread lets a teammate reply, without a new mention, in a thread where they already mentioned `@scout`, and get one answer there. A reply in a thread the agent was never asked into gets nothing.

## Sub-features

- `thread-followup` answers one plain reply in a thread the agent was asked into.
- `thread-unasked` stays silent in a thread it was never asked into.

## How to get to it (user POV)

- Mention `@scout` in `C1`, then send a plain reply in that same thread.
- In some other thread in `C1`, reply without ever having mentioned `@scout`.

## Driving it with verify-lorehouse

Preconditions:

- `doctor` exits 0 for this run.
- You have the `ts` from an `ask` in this run. That `ts` is the thread.

- **Open the thread.** Ask once. Run `bun .claude/skills/verify-lorehouse/control.ts ask --text "where is the wombat review" --evidence continue-thread/open.json`. `ok` is true. Keep `ts`.
- **Follow up.** Clear the call log and reply without a mention. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts reply --thread <ts> --text "and which floor is that on?" --evidence continue-thread/follow-up.json`. `ok` is true.
- **See the answer.** Wait on the same thread. Run `bun .claude/skills/verify-lorehouse/control.ts wait --thread <ts> --evidence continue-thread/answer.json`. `ok` is true, `reply.text` is non-empty, and `methods` includes `chat.stopStream`.
- **Unasked thread.** Clear the call log and reply in a thread that does not exist yet. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts reply --thread 1995000099.000100 --text "unrelated thread, no mention" --evidence continue-thread/unasked.json`. Then run `bun .claude/skills/verify-lorehouse/control.ts quiet --ms 1500 --evidence continue-thread/unasked-quiet.json`. `stats.modelCalls` is 0 and `stats.byMethod` has no `chat.stopStream`.

## Gotchas

- Wait on the thread you asked in, not on the follow-up message's own `ts`. The reply is streamed into the thread.
- `reset-log` between the opening ask and the follow-up is what makes "one answer" visible. Without it, the opening stream is still in the log.
- The follow-up's wording is not the citation proof. Citation is [Ask in the public channel](./ask-in-channel.md). This feature proves a reply was posted, and that the unasked thread got none.
- `1995000099.000100` must not be a thread you already asked in. If a previous recipe used it, pick another unused ts and say so in the evidence.
