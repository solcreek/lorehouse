# Live knowledge

Live knowledge lets a message someone posts in the allowed public channel become something `@scout` can cite, and lets a deletion remove it from later answers and from the admin API.

## Sub-features

- `live-index` cites a message that was posted while the agent was running.
- `live-delete` stops citing that message after it is deleted, and the admin API returns 404 for it.

## How to get to it (user POV)

- In `C1`, post `Reminder: the kangaroo deploy freeze starts Friday at noon`, wait a moment, then mention `@scout` and ask when the kangaroo deploy freeze starts.
- Delete that reminder, wait a moment, and ask again.

## Driving it with verify-lorehouse

Preconditions:

- `doctor` exits 0 for this run.
- No message in this run already says `kangaroo deploy freeze`. The fixture history does not.

- **Post the reminder.** Run `bun .cursor/skills/verify-lorehouse/control.ts post --text "Reminder: the kangaroo deploy freeze starts Friday at noon" --evidence live-knowledge/post.json`. `ok` is true. Keep `ts`.
- **Let ingest catch up.** Run `bun .cursor/skills/verify-lorehouse/control.ts settle --ms 1000 --evidence live-knowledge/settled.json`. `status.knowledge.state` is `ready`.
- **Ask.** Run `bun .cursor/skills/verify-lorehouse/control.ts ask --text "when does the kangaroo deploy freeze start" --evidence live-knowledge/ask.json`. `reply.cite` is `slack:C1:` plus the posted `ts`.
- **Delete it.** Run `bun .cursor/skills/verify-lorehouse/control.ts delete --ts <ts> --evidence live-knowledge/delete.json`. `ok` is true.
- **Let the deletion catch up.** Run `bun .cursor/skills/verify-lorehouse/control.ts settle --ms 1000 --evidence live-knowledge/deleted-settled.json`. `status.knowledge.state` is `ready`.
- **Ask again.** Run `bun .cursor/skills/verify-lorehouse/control.ts ask --text "when does the kangaroo deploy freeze start" --evidence live-knowledge/ask-after.json`. `reply.cite` is not `slack:C1:` plus that `ts`.
- **Confirm it is gone.** Run `bun .cursor/skills/verify-lorehouse/control.ts admin --path /api/v1/documents/slack:C1:<ts> --evidence live-knowledge/gone.json`. `status` is 404.

## Gotchas

- `settle --ms 1000` is the wait. The verification instance debounces live ingest for 200ms. A shorter wait can observe the index before the message lands, or before the deletion leaves it.
- `post` and `delete` update the stand-in's Slack history and deliver the event. The history write is what Lorehouse reads back when it re-indexes. Skipping it posts an event whose message Slack no longer has.
- The second ask may cite some other document. The proof is that it does not cite the deleted id, and that the admin read is 404.
- The reminder is a person's message (`U6`). A message that mentions `@scout` is a question and is not indexed. Do not use `ask` as the way to add the fact.
