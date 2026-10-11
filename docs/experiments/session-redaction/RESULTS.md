# Results: deleted Slack text in June's session history (#66)

## Current state: macOS Intel, 2026-10-11

Versions: `@junejs/core@0.2.0-dev.65`, `@junejs/server@1.0.0-dev.45` (what `bun.lock` pins),
Bun 1.3.14, the system SQLite 3.51.0 that `bun:sqlite` loads. Machine: iMac i9 (Intel),
load average 11–13 from other sessions during the scale run, so treat its timings as
±30%. Everything ran against `conformance/mock.ts`: no real Slack, no real model, no
real data. The marker words (`ZEBRAQUARTZ`, `OKAPIMARKER`, `NARWHALMARKER`) are synthetic.

**Answer.**

1. **Where the text lives.** A quoted message ends up in **4 rows of `SESSIONS_DB`** per
   quoting turn: the search result (`agent_messages` role `tool`, `$.result`) and the
   answer (`agent_messages` role `assistant`, `$.text`), and a copy of each in the
   step cache (`agent_steps` `tool:<n>:<callId>` and `model:<n>`). June sends the
   **whole** transcript to the model on every call, with no cap, no compaction and no
   cache. After the message was deleted, Lorehouse's index forgot it (404, 0 hits), but
   the next turn's model request still carried it in the `tool_result` and the earlier
   answer. The file kept 6 copies of the marker after a clean stop.
2. **Option (a), redact by thread, works** as a June API. A prototype in a scratch copy
   of June dropped the deleted thread's hit from the stored search result and kept the
   other 4 hits. It replaced the answer that cited it. Then the real app ran a follow-up
   on the redacted file: **0 copies of the marker in the model request, tool pairing
   intact, 0 bytes left in the file**. `secure_delete` is what removes the bytes: with it
   off, 3 of 6 copies stayed in free space. At 1,000 threads × 20 turns (220 MB) a
   redaction across all sessions took **2.4 s to scan and 0.6 s to write** (652 rows,
   plus 268 answers rewritten by turn scope), and VACUUM took another 3.6 s. Limited to
   one session it took 13 ms + 39 ms.
3. **Option (b), a history cap, doesn't solve #66.** The model input grows by about
   **4.3k chars (≈1.1k tokens, estimated) per turn**. A 50-turn thread reaches 214k chars
   (≈55k tokens) on its last call. A cap of 3/5/10 turns holds it at ≈4.8k/6.9k/12.3k
   tokens. But a cap removes nothing from disk, and the text stays quotable until it
   falls out of the window. It's a cost control, not an erasure.
4. **Channel removal (#85).** A purge by session key prefix took 4.5 s + 3.8 s VACUUM
   for 250 threads (35k rows; the file went from 220 to 164 MB). That isn't enough on its
   own. **The removed channel's text also stays in threads of channels that remain
   listed**, wherever a search there returned it. The drive showed it: after C2 was
   unlisted and purged from `LOREHOUSE_DB`, a follow-up in a C1 thread still sent C2's
   text to the model, 3 times per request. `src/purge.ts` says the sessions "are no
   longer reachable once the channel is unlisted". That holds only for threads *in* the
   channel.

**Recommendation.** Ask June for (a): `runtime.redact()` and `runtime.purgeSessions()`
on the native store, under `secure_delete`, plus an app callback for the rewrite. The
draft issue is in the appendix. Don't adopt (b) as the fix. Meanwhile Lorehouse
documents the gap and corrects the comment in `purge.ts`. It keeps its own record of
which sessions saw which thread, so that it can call the API the day it ships. See
[Recommendation](#recommendation).

---

## 1. Where the text lives

### From the code (node_modules, read 2026-10-11)

- **Schema** (`@junejs/server/src/agent-native.ts`, `initSchema`), one SQLite file
  (`SESSIONS_DB`):
  ```sql
  CREATE TABLE agent_sessions (session_id TEXT PRIMARY KEY, status TEXT)
  CREATE TABLE agent_messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, body TEXT)
  CREATE INDEX agent_messages_session ON agent_messages (session_id, seq)
  CREATE TABLE agent_steps (session_id TEXT, id TEXT, output TEXT, PRIMARY KEY (session_id, id))
  -- created lazily by the first session reset (#129):
  agent_messages_archive, agent_steps_archive, agent_session_generations
  ```
  `session_id` is `${agent}:${session}`. For Slack that is `lorehouse:slack:<channel>:<thread ts>`
  (`normalizeSlackEvent` in `@junejs/core/src/channels.ts`; reactions use the item ts).
- **What a turn writes** (`@junejs/core/src/agent-runtime.ts`): the opening `user`
  message (`{ role, turnId, text }`); per model call an `assistant` message
  (`text` + `toolCalls[{id, name, input}]`) **and** step `model:<n>` holding the same
  reply; per tool call a `tool` message (`toolCallId`, `name`, `result`) **and** step
  `tool:<n>:<callId>` holding the same result. Each body is `JSON.stringify(msg)`, so a
  tool's JSON-string result is escaped twice.
- **What the model sees**: `runTurn` calls `model(store.messages(), …)` with the full
  transcript on every model call. `toAnthropicMessages` maps it 1:1 (tool results folded
  into one user message). There's no window, no summarizer and no `cache_control`.
- **No Slack message ts is stored.** `turnId` is minted (`mintTurnId`), not derived
  from the event. Lorehouse's tool results name the **thread**, not the message: a hit
  is `{ id: "slack:<channel>:<root ts>", title, source: <permalink of the root>, text }`
  (`src/tools/search-knowledge.ts`; thread text is all messages joined,
  `src/ingest/slack.ts` `threadDocument`). So a store-side match can find "content from
  thread X", not "content from message Y".
- **Reset doesn't erase.** `AgentSession.reset()` (#129) moves rows into the archive
  tables, "never deleted". It hides history from the model and keeps the bytes.
- Connection pragmas: June sets none. The file is in rollback-journal mode
  (`journal_mode = delete`, no WAL). `secure_delete` is the library default, **2 (FAST)**
  on this macOS SQLite. Bun's bundled SQLite on Linux may differ (not checked).

### Measured (`01-where.ts`)

A person posts `… the papaya launch code word is ZEBRAQUARTZ …` in C1; @scout is
asked in a new thread with `[quote]`. The scripted model searches and quotes the hit. Then
the message is deleted, and a follow-up is asked in the same thread.

| step | `sessions.db` copies of the marker | Lorehouse view |
|---|---|---|
| after the answer | 6 | document indexed (200) |
| after the delete | 6 | `GET /api/v1/documents/<id>` 404, search 0 hits |
| after a clean stop | 6 | — |

The follow-up's two model requests (5 and 7 messages) both carried the marker at
`messages[2].content[0].tool_result` and `messages[3].content[0].text` (the earlier
answer). Pairing was valid. The rows holding it:

| table | key | role | where in the JSON | sample (marker shown as «MARKER») |
|---|---|---|---|---|
| agent_messages | seq=3 | tool | `$.result` | `…"Reminder for the offsite: the papaya launch code word is «MARKER», keep it…` |
| agent_messages | seq=4 | assistant | `$.text` | `… code word is «MARKER», keep it in this channel] w0 w1 …` |
| agent_steps | `tool:1:toolu_1` | — | `$` | same as seq=3 |
| agent_steps | `model:3` | — | `$.text` | same as seq=4 |

6 copies in 4 rows: the hit's `title` and `text` both hold it, in the tool row and in its step.

Not in `SESSIONS_DB`, but just as quotable: **the bot's own Slack reply** that quoted
the message stays in the thread. Ingest skips bot messages, so the index never sees it.
Lorehouse can edit its own message (`chat.update`), but neither option here covers it.

---

## 2. Option (a): redact by Slack thread

### The prototype

`june-redact.ts` is appended by `02-redact.ts` to a **scratch copy** of
`@junejs/server/src/agent-native.ts`, the file Bun runs: the package's `bun` export
condition points at `src/`. It adds `NativeRuntime.prototype.redact()` and
`purgeSessions()`. Lorehouse's `src/` and `node_modules/` are untouched.

`redact({ sessionPrefix?, needles, rewrite?, turnScope = true, secureDelete = true, vacuum? })`:

1. selects the rows of `agent_messages`, `agent_steps` and the archive tables whose text
   contains a needle, in raw, once-escaped and twice-escaped form (an `instr` scan, or a
   range on `session_id` with a prefix);
2. walks each JSON body and passes every string containing a needle to `rewrite`.
   Identity fields (`id`, `toolCallId`, `role`, `turnId`, `name`, `type`) are never
   touched, so each `tool_use` keeps its `tool_result`;
3. turn scope: in a turn where a tool result was rewritten, replaces the text of the
   assistant messages after it, and their `model:<index>` steps. An answer can paraphrase
   without citing;
4. runs it all in one transaction with `PRAGMA secure_delete = ON`, then optionally VACUUM.

Lorehouse's side is the `rewrite` callback (`lorehouseRewrite` in `02-redact.ts`). In a
`search_knowledge`/`recent_knowledge` result it drops only the hit whose `id` is the
thread and keeps the rest. Any other string naming it becomes
`[redacted: this content came from a message that no longer exists]`. The needles are
the doc id `slack:C1:<root ts>` and the permalink segment `p<root ts without dot>`.

### Measured on the real drive (`02-redact.ts`, the DB from `01-where.ts`)

| | rows rewritten | marker copies in the file | rows still holding it |
|---|---|---|---|
| before | — | 6 | 4 |
| redact, `secure_delete` OFF, no VACUUM | 2 messages + 2 steps | **3** | 0 |
| redact, `secure_delete` ON, no VACUUM | 2 messages + 2 steps | **0** | 0 |

Scan 0.2–0.3 ms, write 2–3 ms. The search result went from 5 hits to 4, and the answer
became the placeholder. Turn scope rewrote nothing more here (0), because the needle had
already caught the answer: it cited the thread.

Then **the real app was restarted on the redacted file** and asked a follow-up in the
same thread. Both model requests (9 and 11 messages) had **0 copies of the marker and 0
of the doc id**. The placeholder sat at `messages[3].content[0].text`, and the pairing
check found 0 errors: every `tool_use` answered in the next message, results first, no
orphans. The check flagged a duplicate `toolu_1`, which comes from the mock: it numbers
ids per process and was restarted. The real API never reuses ids. The file still held 0
copies afterwards.

### At scale (`03-scale.ts`)

1,000 threads × 20 turns (4 channels, 250 each), written by June's own `NativeRuntime`
(the scratch copy) with a scripted model. The search tool returns 5 hits of ≤500 chars
from 300 synthetic threads. The target thread came up in 297 tool results across 258
sessions. Build: 277 s, 220.1 MB, 80,000 messages, 60,000 steps.

| operation | rows | time |
|---|---|---|
| redact the target thread, all sessions | 258 sessions; 326 messages + 326 steps rewritten, 268 answers by turn scope | scan **2.43 s**, write **0.57 s** |
| VACUUM after it | file 220.1 → 218.5 MB | **3.61 s** |
| marker copies in the file | 708 → **0** | (after VACUUM; not measured without it at this size) |
| redact limited to one session's key | 1 + 1 rows, 1 by turn scope | scan 13 ms, write 39 ms |

The scan reads every message body (no index can find a substring), so it grows with the
file: about 11 ms per MB here. With the scan this cheap, June doesn't need a
"where was thread X quoted" index to start with. An app that knows the sessions can pass
`sessionPrefix`.

### What June would need (the API)

```ts
runtime.redact({
  agent?: string,                 // default: every agent
  sessions?: string[] | { prefix: string },
  match: { contains: string[] },  // needles, matched in every stored string
  rewrite?: (text: string, at: { table, session, role?, tool?, path }) => string, // default: placeholder
  scope?: "string" | "turn",      // "turn": also the answer(s) after a matched tool result
  vacuum?: boolean,
}): Promise<{ sessions: number; rows: number; … }>
runtime.purgeSessions({ prefix: string, vacuum?: boolean })
```

and the guarantees that go with it:

- **Serialized with turns.** A turn in flight holds its transcript in memory and would
  write after the rewrite. June should run it on each affected session's actor chain,
  as `reset()` does, and evict purged actors from the LRU.
- **Bytes leave the file.** `secure_delete = ON` on the connection for the rewrite
  (measured: OFF left 3 of 6 copies). Rollback-journal mode writes the old pages to
  `-journal` and then unlinks it, so the bytes are gone from the file, though perhaps
  not from the disk blocks. In WAL mode June would also need `wal_checkpoint(TRUNCATE)`;
  the side finding below shows why.
- **Archives included**, or a documented choice: reset's audit trail is "never deleted"
  today.
- **Durable Object store parity**: the same operation on `ctx.storage.sql`. Not looked at.

**Metadata**: none is strictly required for thread-level redaction, because Lorehouse's
results already name the thread. Message-level redaction (drop one deleted reply, keep the
rest of the thread in the history) would need either the tool result to carry each
message's ts (Lorehouse's choice, in its own tool output) or the deleted text. Slack
documents `previous_message.text` on `message_deleted`, but that wasn't verified here.
June itself has no Slack message ts to offer: `turnId` is minted. A June-side
`sourceIds` on a tool result would be a convenience, not a requirement.

---

## 3. Option (b): cap the history a turn sees

`04-cap.ts`: the real app, the mock and a synthetic channel (60 threads of 5 messages,
~900 chars each, so search's 500-char clip applies). Threads of 5, 20 and 50 mentions.
The size is the JSON length of the request's `messages`. Tokens are **estimated as
chars/4**: there was no API key, so no `count_tokens`, and twice-escaped JSON makes chars
overstate tokens somewhat. The system prompt and tool specs add a constant 6,523 chars.

| thread | first turn | last turn (messages) | last turn, est. tokens with system | growth per turn | Σ over the thread (est. tokens, one call per turn) |
|---|---|---|---|---|---|
| 5 turns | 3,952 | 21,079 (19) | 6,901 | 4,282 chars | 23,801 |
| 20 turns | 3,955 | 85,357 (79) | 22,970 | 4,284 chars | 255,877 |
| 50 turns | 3,955 | 213,911 (199) | 55,109 | 4,285 chars | 1,443,011 |

Each turn makes two model calls, and both carry the whole history. Billed input is
about twice the last column (an estimate).

Caps applied offline to the last turn of the 50-turn thread, dropping the oldest whole
turns. Every capped transcript passed the pairing check (0 errors):

| cap | turns kept | est. tokens |
|---|---|---|
| none | 50 | 55,109 |
| last 10 turns | 10 | 12,270 |
| last 5 turns | 5 | 6,910 |
| last 3 turns | 3 | 4,768 |
| 20k est. tokens | 17 | 19,770 |
| 8k est. tokens | 6 | 7,982 |

**Why it doesn't fix #66**: the text stays on disk, and it stays quotable for the next N
turns, or until the token budget pushes it out. A short thread (most Slack threads) never
reaches the cap. It could serve as a cost control, separately from this issue.

**What a cap would cost (qualitative; not measured).** It loses anaphora ("the second
option you listed", "that runbook"), corrections the user made earlier in the thread, the
original question in a long back-and-forth, and approvals or decisions given turns ago.
The model would search again where it can, which costs latency and tool calls, and can't
where the source was a person's words in the thread itself.

**The eval that would measure it** (belongs with #49, real model):
- 30–50 synthetic threads of 10–40 turns over a fixed corpus. At turn *k*, a question
  that depends on information introduced only at turn *j* (*k − j* = 2, 5, 10, 20): a
  reference, a correction, a constraint the user stated.
- Run each with no cap, last 3/5/10 turns and 8k/20k tokens. Same model, temperature 0,
  3 seeds.
- Score: answer correctness against a gold answer (rubric or LLM judge, spot-checked by
  hand), citation correctness (the permalink is the right thread), re-search rate (extra
  tool calls), input tokens and latency.
- The output is a curve of accuracy against cap per *k − j*. A cap is acceptable where it
  stays within noise of no cap for the distances real threads use.

---

## 4. Channel removal (#85)

**The leak** (`05-channel.ts`): with `AGENT_CHANNELS=C1,C2`, a C2 thread holds
`NARWHALMARKER`, and @scout asked in C1 quotes it. On restart with `AGENT_CHANNELS=C1`,
the log reads `purge: C2 is no longer in AGENT_CHANNELS: removed 1 document(s) …` and
the C2 document is 404. **A follow-up in the C1 thread then sent the marker to the model,
3 times in each of its 2 requests.** The 4 rows holding it are all in the C1 session.

What a per-channel purge needs:

1. **The channel's own threads**: delete every session whose key starts with
   `lorehouse:slack:<channel>:` (messages, steps, status, archives, generations), under
   `secure_delete`, then VACUUM. Measured: 250 sessions, 20,000 messages, 15,000 steps
   in **4.48 s**, VACUUM **3.79 s**, 220.1 → 164.2 MB, 0 rows left (`03-scale.ts`). This
   is `purgeSessions({ prefix })`.
2. **Its text quoted elsewhere**: the same `redact()` as for a deleted message, with the
   needle `slack:<channel>:` and a rewrite that drops every hit from that channel. That
   covers threads in listed channels and DMs. The cost should be like the all-sessions
   redaction above (one scan), plus one row per affected result. Not measured.
3. Actors evicted, and the same serialization as redaction.
4. Not covered by a key prefix: proactive sessions with caller-chosen keys, and DM
   sessions (`slack:D…`). Only (2) reaches them.

---

## Side finding: deleted text survives in `lorehouse.db-wal`

`01-where.ts` also counted the marker in Lorehouse's own DB. Main file: 0 at every
step. **`lorehouse.db-wal`: 4 copies after the answer, still 4 after the delete (the
document was already 404), still 4 after the app stopped.** The app has no SIGTERM
handler, so the WAL was neither checkpointed nor removed. #65's `secure_delete` zeroes
the page that a delete rewrites. The WAL frames written before the delete keep the old
page until the WAL is checkpointed **and** truncated or overwritten. Opening a copy of
the files with the `sqlite3` CLI and closing it (the last connection checkpoints and
deletes the WAL) left 0 copies. Possible fixes: `wal_checkpoint(TRUNCATE)` after a
delete batch, `journal_size_limit`, and closing the DBs on SIGTERM. This is a
Lorehouse issue and belongs in its own issue. Not fixed here.

---

## Recommendation

1. **File the June issue** (draft below) for (a): `redact` + `purgeSessions` on the
   native store, serialized with turns, under `secure_delete`, archives included, with an
   app `rewrite` callback. Thread-level matching needs no new metadata.
2. **Don't use (b) for #66.** A cap is worth considering for cost only, once the #49
   eval can say what it costs in answers.
3. **Lorehouse, meanwhile** (no June tables touched):
   - document it in the README. "What it does" says a deleted message "stops being
     quotable", which isn't true in a thread that already quoted it. The `SESSIONS_DB`
     and `AGENT_CHANNELS` rows should also say that a quoted message stays in that
     thread's conversation history (and reachable from it) after it is deleted or its
     channel is unlisted, until June supports redaction. An operator who must erase it
     now can stop the app and delete `SESSIONS_DB`, which resets every thread's memory;
   - correct the comment in `src/purge.ts`: a removed channel's text stays reachable from
     threads in listed channels and DMs that quoted it;
   - optionally, record which session each `search_knowledge`/`recent_knowledge` result
     went to, in `LOREHOUSE_DB` (its own tool output; `ToolContext.sessionId` is there).
     Then, when the API ships, Lorehouse can pass `sessions` instead of a full scan. The
     measurements say this is an optimization, not a prerequisite;
   - not recommended: calling `session.reset()` on the affected threads. It hides the
     text from the model but copies it into the archive tables, which are never deleted,
     and wipes the thread's memory;
   - separately: the bot's own Slack reply that quoted a deleted message (`chat.update`
     it), and the WAL residue above.

## What isn't measured

- Answer quality under a cap (needs the #49 eval and a real model). Real token counts
  (chars/4 is an estimate).
- Redaction on Linux, on Bun's bundled SQLite (its `secure_delete` default), and in WAL
  mode. The Durable Object store.
- Redaction while turns are running. The prototype runs on a closed app; the
  serialization is a design requirement here, not tested.
- Whether real Slack's `message_deleted` carries `previous_message.text` for every
  deletion (it would allow message-level redaction).
- The cross-channel redaction cost (needle `slack:<channel>:`) at scale.
- Free disk blocks after the rollback journal is unlinked (filesystem forensics, out of
  scope).
- Scale timings ran under load average 11–13, single run.

## Reproduce

From the repo root, Bun on the PATH, `bun install` done. Scratch files go under
`$TMPDIR/lorehouse-poc66/`. Each script prints one JSON object.

```bash
bun docs/experiments/session-redaction/01-where.ts             # Q1; keeps $TMPDIR/lorehouse-poc66/where
bun docs/experiments/session-redaction/02-redact.ts            # Q2 on that DB, then a follow-up on the real app
bun docs/experiments/session-redaction/03-scale.ts --sessions 1000 --turns 20   # ~5 min, ~450 MB peak scratch
bun docs/experiments/session-redaction/04-cap.ts               # Q3
bun docs/experiments/session-redaction/05-channel.ts           # Q4, the cross-channel leak
rm -rf "${TMPDIR:-/tmp}/lorehouse-poc66"                       # clean up
```

Files: `harness.ts` (starts the mock, a logging proxy in front of its Anthropic endpoint,
and `src/server.ts` with the verify-lorehouse environment; sends signed Slack events);
`june-redact.ts` (the prototype June API, appended to a scratch copy of June).

---

## Appendix: draft June issue (not filed)

> **Title:** Native store: redact or purge stored history (deleted sources, removed channels)
>
> **Context.** An agent that answers from a knowledge source keeps what its tools returned,
> and what it answered, in the session history (`agent_messages` and, a second time, in
> `agent_steps`). The full history goes to the model on every call. When the source is
> deleted (a Slack message, a document), the app can drop it from its own index, but the
> agent can still see and repeat it in every session that quoted it. The copies stay in
> the SQLite file. Apps can't fix this without writing June's tables. `reset()` doesn't
> help: it archives the rows, never deleted. Measured on core 0.2.0-dev.65 /
> server 1.0.0-dev.45 (Lorehouse #66 POC): 4 rows and 6 copies per quoting turn; after the
> source was deleted, the next turn's request still carried it in the `tool_result` and
> the earlier answer.
>
> **Ask.**
> 1. `runtime.redact({ agent?, sessions?: string[] | { prefix }, match: { contains: string[] }, rewrite?, scope?: "string" | "turn", vacuum? })`.
>    It rewrites every stored string (messages, steps, archives) that contains a needle,
>    keeping ids, roles and the tool_use/tool_result pairing; `rewrite(text, where)` lets
>    the app drop one item from a structured result instead of the whole result; `scope:
>    "turn"` also replaces the assistant text after a matched result in the same turn.
> 2. `runtime.purgeSessions({ agent?, prefix, vacuum? })`: delete every row of the
>    sessions under a key prefix (e.g. `slack:C123:` when a channel is removed), archives
>    and generations included.
> 3. Both: serialized with each affected session's turns (like `reset()`), purged actors
>    evicted, `PRAGMA secure_delete = ON` for the write (measured: OFF leaves 3 of 6
>    copies in free pages), and a checkpoint with TRUNCATE if the store ever uses WAL.
>    The same on the Durable Object store.
>
> **Prototype and numbers.** A ~220-line version over the native store (a scratch copy of
> `agent-native.ts`): 1,000 sessions × 20 turns, 220 MB. Redacting one source across all
> sessions: scan 2.4 s, write 0.6 s, 652 rows plus 268 turn-scoped answers, 708 → 0
> copies after VACUUM (3.6 s). Limited to one session: 13 ms + 39 ms. Purging 250
> sessions (35k rows): 4.5 s + 3.8 s VACUUM. After redaction a real follow-up turn sent
> 0 copies, and the transcript passed the pairing check.
>
> **Not asked:** a history window or summarization. It's a separate cost question and
> doesn't remove anything from disk.
