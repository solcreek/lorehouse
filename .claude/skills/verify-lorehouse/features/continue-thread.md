# Continue a thread

Continuing a thread lets a teammate reply, without a new mention, in a thread where `@scout` already answered a mention, and get one answer there. A reply in a thread the agent was never asked into gets nothing, and a mention it refused (a guest's) does not ask it in.

## Sub-features

- `thread-followup` answers one plain reply in a thread the agent was asked into.
- `thread-unasked` stays silent in a thread it was never asked into.
- `thread-followup-during-lookup` answers a plain reply that arrives while Slack is still saying who the person that opened the thread is, once that mention is accepted. When that person is a guest, the reply gets nothing and the thread is never joined.

## How to get to it (user POV)

- Mention `@scout` in `C1`, then send a plain reply in that same thread.
- In some other thread in `C1`, reply without ever having mentioned `@scout`.
- Someone `@scout` has not heard from lately mentions it, and a teammate it answered a moment ago replies in that thread right away.

## Driving it with verify-lorehouse

Preconditions:

- `doctor` exits 0 for this run.
- You have the `ts` from an `ask` in this run. That `ts` is the thread.

- **Open the thread.** Ask once. Run `bun .claude/skills/verify-lorehouse/control.ts ask --text "where is the wombat review" --evidence continue-thread/open.json`. `ok` is true. Keep `ts`.
- **Follow up.** Clear the call log and reply without a mention. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts reply --thread <ts> --text "and which floor is that on?" --evidence continue-thread/follow-up.json`. `ok` is true.
- **See the answer.** Wait on the same thread. Run `bun .claude/skills/verify-lorehouse/control.ts wait --thread <ts> --evidence continue-thread/answer.json`. `ok` is true, `reply.text` is non-empty, and `methods` includes `chat.stopStream`.
- **Unasked thread.** Clear the call log and reply in a thread that does not exist yet. Run `bun .claude/skills/verify-lorehouse/control.ts reset-log` and `bun .claude/skills/verify-lorehouse/control.ts reply --thread 1995000099.000100 --text "unrelated thread, no mention" --evidence continue-thread/unasked.json`. Then run `bun .claude/skills/verify-lorehouse/control.ts quiet --ms 1500 --evidence continue-thread/unasked-quiet.json`. `stats.modelCalls` is 0 and `stats.byMethod` has no `chat.stopStream`.

`thread-followup-during-lookup` needs a fresh `launch`: a membership verdict is cached for ten minutes, and `U1` must not have one yet. Do not `ask` before it in the run.

- **Have U2 known.** Run `bun .claude/skills/verify-lorehouse/control.ts mention --user U2 --text "[q1] where is the wombat review"`, then `wait --thread <its ts>`. `ok` is true. U2's membership is now cached.
- **Make U1's lookup slow, and open a thread.** Run `reset-log`, then `hold-lookup --user U1 --state on`, then `mention --text "[q2] when is the quarterly wombat review"`. Keep its `ts`. Run `hold-lookup --user U1 --state on` again: `waiting` is 1, so the mention is waiting on Slack.
- **Follow up while it waits.** Run `reply --thread <ts> --user U2 --text "and which floor is that on?"`, then `stats --evidence continue-thread/during-lookup-held.json`. `modelCalls` is 0 and `posts` is empty: nothing is said before the asker is known.
- **Let the lookup finish.** Run `hold-lookup --user U1 --state off`, then `quiet --ms 3000 --evidence continue-thread/during-lookup-answers.json`. `stats.byMethod` has `chat.stopStream` 2: the mention's answer, then the follow-up's.
- **A guest opens the thread.** Run `reset-log`, `hold-lookup --user UG1 --state on`, `mention --user UG1 --text "[q3] when is the quarterly wombat review"` (keep its `ts`), `reply --thread <ts> --user U2 --text "and which floor is that on?"`, `hold-lookup --user UG1 --state off`, then `quiet --ms 2000 --evidence continue-thread/during-lookup-guest.json`. `stats.posts` is the one-line refusal in that thread, `stats.modelCalls` is 0, and `admin --path "/api/v1/threads?limit=50"` does not list the guest's `ts`.

## Gotchas

- Wait on the thread you asked in, not on the follow-up message's own `ts`. The reply is streamed into the thread.
- `reset-log` between the opening ask and the follow-up is what makes "one answer" visible. Without it, the opening stream is still in the log.
- The follow-up's wording is not the citation proof. Citation is [Ask in the public channel](./ask-in-channel.md). This feature proves a reply was posted, and that the unasked thread got none.
- `1995000099.000100` must not be a thread you already asked in. If a previous recipe used it, pick another unused ts and say so in the evidence.
