# The admin API

A read-only view of what Lorehouse knows and runs: the indexed threads and their text,
search, each channel's ingest, the threads the agent was asked into, how people use it,
and the sandboxes.
It is for the people who run Lorehouse, and later for the Lorehouse app. Nothing in it
writes.

## Access

Set `ADMIN_TOKEN` (32 characters or more), and send it with every request:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>/api/v1/documents
```

- **Unset, all of `/api/` is closed:** every request gets a 404, as if the API didn't
  exist.
- **A missing or wrong token gets a 401.**
- **Anything but GET gets a 405.**

It has its own token because it returns what people wrote. `STATUS_TOKEN` reads only
counts, so it can go to a monitor or a status page; the admin token can't be the same
value, and Lorehouse refuses to start if it is. Anyone holding the admin token can read
every indexed message, the same as a member of those public channels, so keep it with
the other secrets.

Answers are JSON. An error, a 401 or a 405 included, is `{ "error": "…" }` saying what
was wrong; a 401 also carries `WWW-Authenticate: Bearer` and a 405 `Allow: GET`. A bad
parameter gets a 400. The one exception is the closed API: its 404 is the same plain
`not found` as any path the app doesn't serve, so it doesn't say there is an API there.

Every answer, refusals included, carries `Cache-Control: no-store`. An answer holds
message text, and a cached refusal could outlive the token it was about: a proxy could
keep serving the closed 404 after `ADMIN_TOKEN` is set.

## Endpoints

| endpoint | returns |
|---|---|
| `GET /api/v1/documents` | the index, most recently (re)indexed first, without text |
| `GET /api/v1/documents/{id}` | one document, with its text |
| `GET /api/v1/search?q=` | what the agent's `search_knowledge` finds, in its order |
| `GET /api/v1/channels` | each allowed channel's ingest |
| `GET /api/v1/threads` | the threads the agent was asked into, newest first |
| `GET /api/v1/runners` | the connected sandbox runners |
| `GET /api/v1/sandboxes` | which runner each sandbox lives on, newest first |
| `GET /api/v1/usage` | who asks the agent things, which searches found nothing, and the 👍/👎 on its replies |

### Documents

`GET /api/v1/documents?kind=&channel=&limit=&cursor=`

- `kind`: `slack_thread` or `seed`.
- `channel`: a channel id. Only that channel's threads.
- `limit`: 1–200, default 50.

```json
{
  "documents": [
    { "id": "slack:C0123:1790000001.000100", "kind": "slack_thread",
      "source": "https://acme.slack.com/archives/C0123/p1790000001000100",
      "title": "#general", "updatedAt": "2026-09-28T10:00:00.000Z",
      "activeAt": "2026-09-21T14:13:21.000Z", "chars": 412 }
  ],
  "next": "WyIyMDI2LTA5LTI4VDEwOjAwOjAwLjAwMFoiLDQyXQ"
}
```

- `id`: a thread is `slack:<channel>:<thread ts>`.
- `source`: where a person opens it (a Slack thread's permalink).
- `updatedAt`: when Lorehouse last indexed it.
- `activeAt`: the thread's newest message or edit, or `null` for a seed.
- `chars`: the text's length.

`GET /api/v1/documents/{id}` returns the same fields plus `text`, without `chars`. It
takes the id as it is (`slack:C0123:1790000001.000100`) or percent-encoded, and gives a
404 for an id that isn't indexed. A deleted message is gone from the index, so it gives a
404 here too.

### Search

`GET /api/v1/search?q=&limit=`

- `q`: up to 500 characters.
- `limit`: 1–50, default 10.

It runs the same search, in the same order, as the agent's `search_knowledge`, which takes
the top 5. Chinese, Japanese and Korean work as they do for the agent. Each result is
`{ id, source, title, excerpt }`, where `excerpt` is the first 300 characters of the text.

### Channels

`GET /api/v1/channels`

```json
{ "state": "ready",
  "channels": [ { "id": "C0123", "threads": 24, "lastMessageAt": "2026-09-28T09:58:00.000Z" } ] }
```

- `state`: `idle`, `backfilling`, `ready` or `error`; with `error`, an `error` field says
  what failed.
- `lastMessageAt`: the newest message ingest has seen in the channel, or `null` before the
  first.
- No `AGENT_CHANNELS` means no ingest: `{ "state": "idle", "channels": [] }`.

### Threads

`GET /api/v1/threads?limit=&cursor=` (limit 1–200, default 50)

```json
{ "threads": [
    { "channel": "C0123", "threadTs": "1790000001.000100", "joinedAt": "2026-09-28T09:00:00.000Z",
      "document": "slack:C0123:1790000001.000100",
      "source": "https://acme.slack.com/archives/C0123/p1790000001000100",
      "asks": 3, "searches": 4, "emptySearches": 1 } ],
  "next": null }
```

A thread joins when someone mentions the agent in it. `document` and `source` are `null`
when the thread isn't indexed: a thread that holds only a question to the agent isn't
knowledge. `asks`, `searches` and `emptySearches` come from [usage](#usage): the messages
that asked the agent something there, its `search_knowledge` calls, and how many of those
found nothing.

### Usage

`GET /api/v1/usage?days=` (1–90 whole days, default 7; anything else, such as `3days`,
`7.9` or `-5`, is a 400)

```json
{ "days": 7, "since": "2026-09-21T18:00:00.000Z",
  "asks": 23, "channels": 2, "threads": 9,
  "emptySearches": { "threads": 2, "of": 8, "queries": ["okapi budget"] },
  "feedback": { "up": 6, "down": 1, "raters": 4,
                "downMessages": [ { "channel": "C0123", "ts": "1790000009.000100" } ] } }
```

It is there to improve the agent: what its lore is missing, and which answers people
thought were wrong. How much and how widely it is asked says whether it is becoming part of
how people work. Who asked is not part of it:

- **`asks`, `channels`, `threads`:** the messages the agent answered (a mention, or a plain
  reply in a thread it was asked into), and in how many channels and threads.
- **`emptySearches`:** threads where every search found nothing, out of the threads that
  searched (`of`), and the latest distinct queries that found nothing (up to 10). It is a
  floor for "couldn't answer", not a count of it: search matches any of the words, so a
  question with no real answer usually still gets hits.
- **`feedback`:** the 👍 and 👎 on the agent's own messages, from how many distinct
  `raters` (one person or many), and the latest messages given a 👎 (up to 10). A reaction
  is recorded and never answered.

What is recorded, and for how long:

- **Nobody's Slack id, by default.** An ask keeps where it was asked, not by whom. A
  reaction keeps a keyed hash of the person (an HMAC under the app's signing secret, which
  isn't in the database), only so each person counts once and taking a reaction back
  removes the right one.
- **A DM is never recorded**, whatever `DM_MODE` is.
- **Rows are kept 90 days,** the longest window this reports, then pruned (on start and
  daily).
- **A question deleted in Slack is forgotten:** its ask goes, and when it was a thread's
  root, so do the searches run for it. The same as a deleted message leaving the index,
  and the same after downtime: on start, a question in the refresh window
  (`INGEST_REFRESH_DAYS`) that Slack no longer has is forgotten too.
- **None of it is in `GET /status`,** which holds counts safe for a monitor. `/status`
  says only whether askers are recorded (`recordsWhoAsks`).

Feedback needs the `reactions:read` scope and the `reaction_added` and
`reaction_removed` events ([setup](live-slack.md)); `lorehouse doctor` fails while the
scope is missing.

#### Recording who asks (off by default)

Lorehouse's view is that usage is for improving the agent, not for seeing who uses it and
who doesn't. Counting people turns asking into something people are counted on (Goodhart's
law), and a record of who asks in public makes people think twice before asking there,
which is the behavior the agent depends on. Some organizations want the numbers anyway, so
an install can opt in with `USAGE_RECORD_PEOPLE=1`, in the open:

- **Each allowlisted channel is told,** once, that the agent now records who asks, and
  **its askers are recorded only after that notice is posted**: a question asked while the
  notices are still going out keeps no asker. Turning it off tells them again, and erases
  every asker kept.
- **The usage adds `people` and `askers`:** how many people asked, and each asker
  (`{ user, name, asks }`, most asks first). Asks from before opting in have no asker.
  `name` comes from the names Lorehouse has already cached (it caches an asker's when
  recording them), so reading usage never calls Slack; it is `null` when none is cached.
- **Reactions stay anonymous** either way: a named 👎 is one people hold back.
- **`/status` says `recordsWhoAsks: true`,** and `lorehouse doctor` notes it.

### Runners and sandboxes

`GET /api/v1/runners` returns `{ "mode": "off" | "direct" | "runners", "runners": [...] }`.
Each runner is `{ runner, transport, online, capacity, running, version, lastSeenSecs }`,
as in `/status`. The list is empty unless sandbox hosts connect in
([runners](sandbox-runners.md)).

`GET /api/v1/sandboxes?limit=&cursor=` returns `{ sandboxes: [{ sandbox, runner, placedAt }],
next }`. A sandbox stays on the runner that first ran it, because its disk is there.

## Pages

Lists return at most `limit` items and a `next` cursor. Pass `next` back as `cursor` for
the following page; `null` means there are no more. A cursor is opaque. A page continues
after the last item of the one before it, so an item added or changed meanwhile moves to
the front instead of appearing twice.

## Checking it

`lorehouse doctor --url https://<app>`, with `ADMIN_TOKEN` set, checks that the running
app's admin API answers to the same token. The conformance suite pins the rest: the
tokens, paging through every document `/status` counts, search, deleted messages, the
agent's threads, and usage (counted right, forgotten with a deleted question, and never in
`/status`).
