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
bun start                                           # :3000
cloudflared tunnel --url http://localhost:3000     # prints https://<random>.trycloudflare.com
```

## 3. Point Slack at it

In the app's settings, using the tunnel URL:

- **Event Subscriptions** → on → Request URL `https://<tunnel>/slack/events`.
  It should turn **Verified**. That proves the signature check and the
  `url_verification` echo work.
  - **Subscribe to bot events:** `app_mention`, `message.channels` → Save → reinstall
    if Slack asks.
- **Interactivity** → on → the same URL. Only needed for Approve/Deny on pull requests.

The quick tunnel's URL changes every time `cloudflared` restarts. Update both URLs
when it does.

## 4. Check, in order

Record what you see next to each item. Each one maps to an assumption in
`conformance/mock.ts`.

| # | Do | Expect | Mock assumption it checks |
|---|---|---|---|
| 1 | `curl localhost:3000/status` | `state: "ready"`, `documents` = the threads you posted | `auth.test` returns `url`; `conversations.history`/`replies` shapes, pagination |
| 2 | `@scout` ask about a fact from the history | A streamed reply in the thread, citing the right thread; its permalink opens that thread | `chat.startStream` needs `recipient_team_id`/`recipient_user_id`; the permalink format |
| 3 | Ask about a fact that only a **reply** holds | Cites the thread | `conversations.replies` returns root + replies |
| 4 | Post a new fact, wait a few seconds, then ask about it | Cites the new message | the `message` event has `channel_type: "channel"` (the policy needs it) |
| 5 | Edit that message, then ask about the new wording | The new text is cited | `message_changed` carries `message.ts` (and `thread_ts` for replies) |
| 6 | Delete a message, then ask about it; `curl …/status` | Not cited any more; `documents` drops by 1 | `message_deleted` carries `deleted_ts` and `previous_message` |
| 7 | Delete a root that has replies | Replies still found; the root's text is gone | a root with replies becomes a `tombstone` |
| 8 | DM the bot, or mention it in a private channel it's in | No reply | the policy on `channel_type: "im"`/`"group"`, and `app_mention` without `channel_type` |
| 9 | Stop the app. Reply in an old thread, delete another message. Start again; `curl …/status` | `reconciled` shows ≥1 refreshed and ≥1 removed; the reply is found, the deleted one isn't | `latest_reply` on history roots; deleted messages vanish from history |

With `LOG_SLACK_EVENTS=1`, every event the policy lets through is printed raw
(`slack event: {…}`). Compare those shapes with what `conformance/run.ts` sends. Any
field the mock gets wrong is a conformance fix.
