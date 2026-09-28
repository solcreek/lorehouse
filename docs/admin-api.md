# The admin API

A read-only view of what Lorehouse knows and runs: the indexed threads and their text,
search, each channel's ingest, the threads the agent was asked into, and the sandboxes.
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

Answers are JSON with `Cache-Control: no-store`. An error is `{ "error": "…" }` saying
what was wrong. A bad parameter gets a 400.

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
      "source": "https://acme.slack.com/archives/C0123/p1790000001000100" } ],
  "next": null }
```

A thread joins when someone mentions the agent in it. `document` and `source` are `null`
when the thread isn't indexed: a thread that holds only a question to the agent isn't
knowledge.

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
tokens, paging through every document `/status` counts, search, deleted messages, and the
agent's threads.
