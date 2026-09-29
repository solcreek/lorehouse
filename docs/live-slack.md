# Running against real Slack

The conformance suite runs against a mock of Slack. This runbook connects Lorehouse to a
real workspace and checks, one by one, the assumptions that mock makes.

Use a test workspace. The agent calls the real Anthropic API.

## 1. Create the app

1. api.slack.com/apps → **Create New App** → **From an app manifest** → pick the
   workspace → paste `slack/manifest.yaml`.
2. **Install to Workspace**.
3. Collect:
   - **Basic Information** → Signing Secret
   - **OAuth & Permissions** → Bot User OAuth Token (`xoxb-…`)
4. Create a public test channel. Post a few facts in it, some with replies, so there
   is history to learn. Then `/invite @scout` there. Copy the channel id: channel
   name → **About** → at the bottom, `C…`.

## 2. Configure and start

Put the secrets in `.env` at the repo root. It is gitignored, and Bun loads it
automatically:

```bash
SLACK_SIGNING_SECRET=…
SLACK_BOT_TOKEN=xoxb-…
AGENT_CHANNELS=C…            # the test channel
LOREHOUSE_DB=live.db         # gitignored (*.db)
LOG_SLACK_EVENTS=1           # print raw events, to compare with the mock
INGEST_DEBOUNCE_MS=2000
# ANTHROPIC_API_KEY=…        # if not already in your environment
```

```bash
bun run doctor                                      # every ✗ names its fix
bun start                                           # :3000
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```

## 3. Point Slack at it

In the app's settings, using the tunnel URL:

- **Event Subscriptions** → on → Request URL `https://<tunnel>/slack/events`.
  It should turn **Verified**. That proves the signature check and the
  `url_verification` echo work.
  - **Subscribe to bot events:** `app_mention`, `message.channels`, `reaction_added`,
    `reaction_removed` (👍/👎 feedback), and `message.im` unless `DM_MODE=ignore` → Save
    → reinstall if Slack asks.
- **App Home** → Messages Tab on, **and** tick "Allow users to send Slash commands and
  messages from the messages tab" (unless `DM_MODE=ignore`). Without the tick, a DM
  reads "Sending messages to this app has been turned off". Reload Slack (⌘R) after.
- **Interactivity** → on → the same URL. Only needed for Approve/Deny on pull requests.

The quick tunnel's URL changes every time `cloudflared` restarts. Update both URLs
when it does.

`bun run doctor --url https://<tunnel>` then checks the path Slack takes: the tunnel
reaches the app, and the app answers Slack's URL check with your signing secret.

## 4. Check, in order

Record what you see next to each item. Each one maps to an assumption in
`conformance/mock.ts`.

| # | Do | Expect | Mock assumption it checks |
|---|---|---|---|
| 1 | `curl -H "Authorization: Bearer $STATUS_TOKEN" localhost:3000/status` (set `STATUS_TOKEN` first; without it `/status` is closed) | `state: "ready"`, `documents` = the threads you posted | `auth.test` returns `url`; `conversations.history`/`replies` shapes, pagination |
| 2 | `@scout` ask about a fact from the history | A streamed reply in the thread, citing the right thread; its permalink opens that thread | `chat.startStream` needs `recipient_team_id`/`recipient_user_id`; the permalink format |
| 3 | Ask about a fact that only a **reply** holds | Cites the thread | `conversations.replies` returns root + replies |
| 4 | Post a new fact, wait a few seconds, then ask about it | Cites the new message | the `message` event has `channel_type: "channel"` (the policy needs it) |
| 5 | Edit that message, then ask about the new wording | The new text is cited | `message_changed` carries `message.ts` (and `thread_ts` for replies) |
| 6 | Delete a message, then ask about it; `curl …/status` | Not cited any more; `documents` drops by 1 | `message_deleted` carries `deleted_ts` and `previous_message` |
| 7 | Delete a root that has replies | Replies still found; the root's text is gone | a root with replies becomes a `tombstone` |
| 8 | DM the bot; mention it in a private channel it's in | The DM gets one line pointing to the public channel, and nothing else (`DM_MODE=redirect`); the private channel gets no reply | a DM is a `message` event with `channel_type: "im"` (never an `app_mention`); `app_mention` carries no `channel_type` |
| 9 | Stop the app. Reply in an old thread, delete another message. Start again; `curl …/status` | `reconciled` shows ≥1 refreshed and ≥1 removed; the reply is found, the deleted one isn't | `latest_reply` on history roots; deleted messages vanish from history |

With `LOG_SLACK_EVENTS=1`, every event the policy lets through is printed raw
(`slack event: {…}`). Compare those shapes with what `conformance/run.ts` sends. Any
field the mock gets wrong is a conformance fix.

## 5. Results

Run 2026-09-27 on a real workspace (one public test channel, about 20 threads of
Chinese and English history), native Bun host behind a quick tunnel.

| # | Result | Seen |
|---|---|---|
| 1 | pass | `ready`, one document per thread |
| 2 | pass | streamed reply in the thread, cited permalink opens it |
| 3 | pass | a fact only a reply held was found by search from a top-level question |
| 4 | pass | the `message` event carried `channel_type: "channel"`; cited 14 s after posting |
| 5 | pass | `message_changed` carried `message.ts` and `edited.ts`; only the new wording cited |
| 6 | pass | `message_deleted` carried `deleted_ts` and `previous_message`; `documents` −1 |
| 7 | pass | root deletion arrived as `message_changed` with `message.subtype: "tombstone"`; the reply stayed findable, the root's text did not |
| 8 | pass | before DM_MODE: no reply in a DM or a private channel. With `DM_MODE=redirect` (after enabling the App Home messages tab, `im:history`, `message.im`): the DM arrived as a `message` with `channel_type: "im"`, got one line linking the channel, the agent's own reply came back with `bot_id` and was skipped, and `documents` did not change |
| 9 | pass | after a restart, `reconciled: { refreshed: 1, removed: 1 }`; the reply made while down was indexed, the deleted one was gone |

Every event shape matched `conformance/mock.ts`. What the run found instead was in
how the model uses what it's given; each is fixed with a test:

- Chinese questions found nothing (CJK tokenization) → bigram index.
- "What has been discussed lately?" has no keywords → `recent_knowledge`.
- Answers named people by user id → names from `users.info`.
- A message was credited to the wrong colleague, the two names merged into one →
  speaker lines with both names, and a named `slack_read_thread`.
- `/status` showed `threads: 0` for a full channel after a restart (it counted what
  that run had read) → it now counts what the index holds.

A message that says it is a test ("test: the budget is 42k") is cited but not trusted
as an answer: word live test facts as plain statements.
