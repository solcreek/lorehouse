# Direct message

A direct message, in the default install, gets one reply that points at the public channel. The agent does not call the model, does not read the DM history, and does not index the DM.

## Sub-features

- `dm-redirect` posts one reply in the DM naming `<#C1>`.
- `dm-no-model` makes no model call for that DM.
- `dm-not-indexed` leaves the document count unchanged and does not read channel `D1`.

## How to get to it (user POV)

- Open a DM with `@scout` and send `where is the wombat review?`.
- `DM_MODE=ignore` and `DM_MODE=answer` are different installs. This instance is `redirect`.

## Driving it with verify-lorehouse

Preconditions:

- `doctor` exits 0 for this run.
- Note `body.knowledge.documents` from `status` before the DM.

- **Count documents.** Run `bun .cursor/skills/verify-lorehouse/control.ts status --evidence direct-message/before.json`. Keep `body.knowledge.documents`.
- **Send the DM.** Clear the call log first. Run `bun .cursor/skills/verify-lorehouse/control.ts reset-log` and `bun .cursor/skills/verify-lorehouse/control.ts dm --text "where is the wombat review?" --evidence direct-message/dm.json`. `posts` has one item, its `channel` is `D1`, and its `text` is `I only answer in public, so everyone can learn from the question and the answer. Ask me in <#C1>.` `modelCalls` is 0. `readChannels` does not include `D1`. `documents` equals the count from `before.json`.

## Gotchas

- The redirect is a `chat.postMessage`, not a stream. `wait` does not observe it. `dm` reads the mock's posts.
- Without `reset-log`, an earlier post is still in `posts` and the assertion is about the wrong message.
- `documents` on the `dm` result is the count after the reply. Compare it to `before.json`. A matching count is the proof the DM was not indexed.
- This recipe does not switch `DM_MODE`. Ignore and answer are not this instance.
