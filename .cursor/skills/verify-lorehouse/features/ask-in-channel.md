# Ask in the public channel

Asking in the public channel lets a teammate mention `@scout` with a question and get one reply in that thread. The reply cites the Slack thread the answer came from, as a permalink. The question itself does not become knowledge.

## Sub-features

- `ask-cite` answers a mention in `C1` by citing the matching thread and its permalink.
- `ask-stored` shows that same thread, with its text, from the admin API.
- `ask-not-indexed` leaves the mention itself out of the index.

## How to get to it (user POV)

- In the allowed public channel `C1`, mention `@scout` and ask `when is the quarterly wombat review`.
- There is no other entry. A DM, a private channel, and a channel outside the allowlist are different features.

## Driving it with verify-lorehouse

Preconditions:

- `doctor` exits 0 for this run.
- The indexed document `slack:C1:1790000001.000100` contains `quarterly wombat review`.

- **Ask.** Mention `@scout` with the question. Run `bun .cursor/skills/verify-lorehouse/control.ts ask --text "when is the quarterly wombat review" --evidence ask-in-channel/reply.json`. `ok` is true, `reply.cite` is `slack:C1:1790000001.000100`, and `reply.src` is `https://acme.slack.com/archives/C1/p1790000001000100`. `methods` includes `chat.startStream` and `chat.stopStream`.
- **Confirm the source.** Open that document. Run `bun .cursor/skills/verify-lorehouse/control.ts admin --path /api/v1/documents/slack:C1:1790000001.000100 --evidence ask-in-channel/document.json`. `status` is 200 and `body.text` contains `quarterly wombat review` and `Thursdays`.
- **Question is not knowledge.** Read the document id the mention would have if it had been indexed: `slack:C1:` plus the `ts` from the ask. Run `bun .cursor/skills/verify-lorehouse/control.ts admin --path /api/v1/documents/slack:C1:<ts> --evidence ask-in-channel/question-not-indexed.json`. `status` is 404.

## Gotchas

- `ask` adds `[qN]` in front of the question. The scripted model cites the first search hit for the question with that nonce removed. Assert `cite` and `src`, not the filler words after them.
- A `cite` without the admin document only proves the scripted model was willing to print an id. Read the document too.
- The permalink host `acme.slack.com` comes from the stand-in's `auth.test`. A different host means this run is not using that stand-in.
- A search for the nonce does not prove the mention was left out. The query parser drops a one-character token, so `[q1]` matches nothing even when the text is indexed. Read the document id instead.
