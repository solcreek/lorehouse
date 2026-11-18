# The admin API

What Lorehouse knows and runs: the indexed threads and their text, search, each channel's
ingest, the threads the agent was asked into, how people use it, and the sandboxes.
It is for the people who run Lorehouse and the agents they run it with, and later for the
Lorehouse app. It reads, with one exception: [a channel's default repo](#a-channels-default-repo),
which it also sets and clears.

## Access

Set `ADMIN_TOKEN` (32 characters or more), and send it with every request:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>/api/v1/documents
```

- **Unset, all of `/api/` is closed:** every request gets a 404, as if the API didn't
  exist.
- **A missing or wrong token gets a 401.**
- **Anything but GET gets a 405,** except on a channel's default repo, which also takes
  PUT and DELETE.

It has its own token because it returns what people wrote. `STATUS_TOKEN` reads only
counts, so it can go to a monitor or a status page; the admin token can't be the same
value, and Lorehouse refuses to start if it is. Anyone holding the admin token can read
every indexed message, the same as a member of those public channels, and can set which
repo a channel's requests work in, so keep it with the other secrets.

Answers are JSON. An error, a 401 or a 405 included, is `{ "error": "…" }` saying what
was wrong; a 401 also carries `WWW-Authenticate: Bearer` and a 405 `Allow` with the
methods the endpoint takes. A bad parameter gets a 400. A refusal from a channel's default
repo also has `"code"`, a stable name for the reason, to branch on instead of the message
([its codes](#refusals)).

Every answer to the admin token, errors included, also has `"tenant"`: the id of the
tenant whose data it is (`TENANT_ID`, [README](../README.md#run-it); ADR 0005 §2).
The examples below leave it out. A 401 doesn't have it: a refusal says nothing about the
install. The one exception is the closed API: its 404 is the same plain
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
| `GET /api/v1/channels` | each allowed channel's ingest, and its default repo |
| `GET /api/v1/channels/{id}/repo` | one channel's default repo |
| `PUT /api/v1/channels/{id}/repo` | sets it |
| `DELETE /api/v1/channels/{id}/repo` | clears it |
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
404 here too, as does every thread of a channel taken off `AGENT_CHANNELS` once the app
has restarted (the start purges them).

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
  "channels": [ { "id": "C0123", "threads": 24, "lastMessageAt": "2026-09-28T09:58:00.000Z",
                  "defaultRepo": { "repo": "acme/widgets", "branch": "main",
                                   "setAt": "2026-11-18T09:00:00.000Z" } } ] }
```

- `state`: `idle`, `backfilling`, `ready` or `error`; with `error`, an `error` field says
  what failed.
- `lastMessageAt`: the newest message ingest has seen in the channel, or `null` before the
  first.
- `defaultRepo`: the channel's default repo, as below, or `null` when it has none.
- No `AGENT_CHANNELS` means no ingest: `{ "state": "idle", "channels": [] }`.

### A channel's default repo

With one set, a request in that channel needs no repo name: "@scout run the benchmark"
works in the channel's repo. A repo named in the request still wins. With none set and
none named, the agent asks which repo. It needs code tools on
([sandbox runners](sandbox-runners.md), [the GitHub App](github-app.md)).

`{id}` is the Slack channel id (`C0123ABCD`), not its name. Only a channel on
`AGENT_CHANNELS` can have a default repo, so a DM never does. It is the admin's to set: the
model can't set or change it, and it is looked up from the channel a thread is in, never
from anything the model says. It is kept in `LOREHOUSE_DB`, and goes with the rest of what
is kept for a channel when the channel leaves `AGENT_CHANNELS` (the next start purges it).

All three answer with the channel's default repo as it now is:

```json
{ "channel": "C0123ABCD",
  "defaultRepo": { "repo": "acme/widgets", "branch": "main", "setAt": "2026-11-18T09:00:00.000Z" } }
```

- `defaultRepo` is `null` when the channel has none.
- `repo` is `owner/name`, spelt as GitHub spells it.
- `branch` is the branch a fresh clone starts on, or `null` for the repo's own default
  branch.
- `setAt` is when it last changed.
- `closed`, on a GET only, is there when the channel was closed since the start (found
  private, archived or shared while running), with why: `private`, `archived`, `shared`,
  or Slack's error. The default shown is still stored and is not used until the next
  start; a PUT is refused (`channel_closed`). `GET /api/v1/channels` has the same field.

**Read it:**

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>/api/v1/channels/C0123ABCD/repo
```

**Set it.** The body is the state wanted: `repo` as `owner/name` (not a URL), and
optionally `branch` (leave it out, or send `null`, for the repo's default branch). No
other field is taken.

```bash
curl -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
  -d '{ "repo": "acme/widgets", "branch": "main" }' \
  https://<app>/api/v1/channels/C0123ABCD/repo
```

Before anything is stored, GitHub is asked whether the install's credential can read the
repo now: that the GitHub App is installed on it (with the development `GITHUB_TOKEN`,
that the token can read it), and that the branch exists when one is given. A public repo
the App isn't installed on is refused too, though the agent could clone it by name: a
default is something the install vouches for. If the check fails, nothing is stored, and
a default already there stays as it was.

PUT is safe to repeat. Sending the state that is already there checks it again and answers
the same, `setAt` included; sending another replaces it.

**Clear it:**

```bash
curl -X DELETE -H "Authorization: Bearer $ADMIN_TOKEN" https://<app>/api/v1/channels/C0123ABCD/repo
```

It answers `"defaultRepo": null` whether or not there was one, and for a channel that
isn't on `AGENT_CHANNELS` too: there is none to clear.

#### Refusals

A refusal is `{ "error": "…", "code": "…" }`. `error` says what to do about it; `code`
doesn't change, so a script or an agent can branch on it.

| status | `code` | when | what to do |
|---|---|---|---|
| 405 | `method_not_allowed` | anything but GET, PUT or DELETE | use one of those (`Allow` lists them) |
| 400 | `invalid_channel` | `{id}` isn't a Slack channel id | use the id (`C0123ABCD`), not the name |
| 404 | `channel_not_listed` | GET or PUT for a channel that isn't on `AGENT_CHANNELS` (a DM, a private channel, one the agent doesn't work in) | add the channel to `AGENT_CHANNELS` and restart |
| 409 | `channel_closed` | PUT for a listed channel that was closed since the start: Lorehouse found it private, archived or shared with another workspace while running, stopped working there, and uses no default repo there until the next start | make the channel public and unshared again, or take it off `AGENT_CHANNELS`; then restart |
| 400 | `invalid_body` | PUT's body isn't a JSON object, is over 4096 bytes (refused by its `Content-Length` before it is read), or has a field other than `repo` and `branch` | send `{ "repo": "owner/name" }` |
| 400 | `invalid_repo` | `repo` is missing or isn't `owner/name` (an owner of up to 39 characters, a name of up to 100) | name the repo as `owner/name`, not its URL |
| 400 | `invalid_branch` | `branch` isn't a branch name Lorehouse takes: letters, digits and `. _ / -`, up to 255 characters, no part that is empty, starts with `.` or ends in `.lock`, no `..`, no leading `-`, no trailing `.` (stricter than git: a branch with other characters can't be a default) | name such a branch, or leave it out |
| 409 | `code_tools_off` | PUT on an install with no sandbox and no GitHub credential: there is nothing to check the repo with, and nothing would use it | turn code tools on, restart, set it again |
| 422 | `app_not_installed` | the GitHub App isn't installed on the repo | install the App on that repo, set it again |
| 422 | `repo_not_readable` | the credential gets no read of the repo (a 404, or a 403 that isn't a rate limit): there is no such repo, or it has no access | check the name, or give the credential access |
| 422 | `branch_not_found` | the repo is readable and has no branch of exactly that name (a renamed branch, which GitHub redirects to its new name, counts as gone) | name a branch that exists, or leave `branch` out |
| 502 | `credential_refused` | GitHub refused the install's own credential (a 401): `GITHUB_TOKEN` expired or revoked, or an App id and key that don't match | fix the credential (`lorehouse doctor` checks it) and restart; the repo's access is not the problem |
| 503 | `github_rate_limited` | GitHub is rate limiting the credential (a 429, or a 403 that says so) | wait, then set it again; `Retry-After` carries GitHub's own, in seconds, when it gave one |
| 502 | `github_unavailable` | GitHub didn't answer within 10 seconds, failed (a 5xx), or gave an answer that didn't confirm the repo or branch asked about | try again; if it keeps failing, `lorehouse doctor` |

The checks run in that order, and the first that fails answers; the last three can come
from any question to GitHub (the installation, the repo, then the branch), and none of
them is a verdict on the repo. With `code_tools_off`,
GET and DELETE still work.

Every attempt to write (anything but a GET, once past the token) leaves one line in the
app's log, under the tenant like every other line, whether it changed anything or not:

```
tenant=<id> admin: default repo PUT channel=C0123ABCD repo=acme/widgets branch=main outcome=set
tenant=<id> admin: default repo PUT channel=C0123ABCD repo=acme/secret outcome=refused code=app_not_installed
tenant=<id> admin: default repo DELETE channel=C0123ABCD outcome=cleared
```

`outcome` is `set`, `unchanged` (a PUT of what was already there), `cleared`, `none` (a
DELETE with nothing to clear) or `refused` with the `code`. A value is written only once it
has passed its check, so a line never holds the request's body or a token.

A default can go stale after it is set: the App uninstalled from the repo, the repo
renamed or deleted, the branch removed. Nothing is cleared for that; a request that
relies on it then fails with GitHub's reason, in the thread. `lorehouse doctor` lists each
channel's default repo and asks GitHub again, and fails while one can't be read.

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
found nothing. A channel taken off `AGENT_CHANNELS` takes its threads, and their asks
and searches, off this list on the next start.

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

## `GET /status`, beside it

`/status` is not part of the admin API: it has its own token (`STATUS_TOKEN`), and holds
settings and counts, never message text. Among them is the list of profiles, the agents
this install runs under its one name ([ADR 0002](adr/0002-profiles.md)):

```json
{
  "agent": "scout",
  "profiles": [
    { "id": "lorehouse", "mode": "interactive",
      "triggers": [{ "kind": "slack", "events": ["mention", "follow_up"] }] }
  ]
}
```

- **`id`** is the profile's durable id, a string matching `[a-z][a-z0-9-]{0,31}`. It is not
  the display name (`agent`), and renaming the agent doesn't change it.
- **`mode`** is `interactive` (a person starts it in Slack), `automation` (an outside
  event does) or `job` (a schedule or a command).
- **`triggers`** is what starts its turns on this install, each an object tagged by
  `kind`. The one kind yet is `slack`, with `events` out of `mention`, `follow_up` and
  `direct_message`; `direct_message` is listed only with `DM_MODE=answer`. `events` is a
  set: each event once, in no promised order. Read `kind` first: other kinds (a webhook, a
  schedule) will carry other fields.
- A profile's prompt, tools and skills are not here.

## Pages

Lists return at most `limit` items and a `next` cursor. Pass `next` back as `cursor` for
the following page; `null` means there are no more. A cursor is opaque. A page continues
after the last item of the one before it, so an item added or changed meanwhile moves to
the front instead of appearing twice.

## Checking it

`lorehouse doctor --url https://<app>`, with `ADMIN_TOKEN` set, checks that the running
app's admin API answers to the same token. The conformance suite pins the rest: the
tokens, paging through every document `/status` counts, search, deleted messages, the
agent's threads, usage (counted right, forgotten with a deleted question, and never in
`/status`), and a channel's default repo (set, read, cleared, kept across a restart, and
refused with its code).
