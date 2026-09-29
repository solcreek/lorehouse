-- How the agent is used, to improve it: where it is asked things, which of its searches
-- found nothing, and the 👍/👎 on its replies. Read through the admin API
-- (GET /api/v1/usage, ADMIN_TOKEN), never GET /status. Public channels only; a DM is never
-- recorded. See src/usage.ts.
--
-- By default no row says who asked. Usage is for finding what the agent is missing or gets
-- wrong, not for seeing who uses it: a record of who asks in public would make people
-- think twice before asking there, and public questions are the point. An install can opt
-- in (USAGE_RECORD_PEOPLE=1): then asks keep the asker, the agent says so in each of its
-- channels, and turning it off erases them again.

-- One row per message that started a turn. Keyed by the message, so Slack redelivering
-- it after a restart is not counted twice. user_id stays NULL unless the install opted in.
CREATE TABLE agent_asks (
  channel    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  user_id    TEXT,
  asked_at   TEXT NOT NULL,  -- RFC 3339
  PRIMARY KEY (channel, ts)
);

-- The channels told that asks now record who asked, so each hears it once, and hears
-- again when it stops.
CREATE TABLE usage_people_notices (
  channel      TEXT PRIMARY KEY,
  notified_at  TEXT NOT NULL
);

-- One row per search_knowledge call, with how many documents it returned.
CREATE TABLE agent_searches (
  id           INTEGER PRIMARY KEY,
  channel      TEXT NOT NULL,
  thread_ts    TEXT NOT NULL,
  query        TEXT NOT NULL,
  hits         INTEGER NOT NULL,
  searched_at  TEXT NOT NULL
);

-- A 👍/👎 on one of the agent's replies; removing the reaction deletes the row. `rater`
-- tells one person's reaction from another's (so each counts once, and taking it back
-- removes the right one) without saying who: a keyed hash of their Slack id, keyed by a
-- secret that is not in this database (src/usage.ts, raterKey).
CREATE TABLE agent_feedback (
  channel     TEXT NOT NULL,
  message_ts  TEXT NOT NULL,
  rater       TEXT NOT NULL,
  rating      TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  reacted_at  TEXT NOT NULL,
  PRIMARY KEY (channel, message_ts, rater, rating)
);

-- The usage summary reads each table over a recent window, and pruning by age.
CREATE INDEX agent_asks_asked_at ON agent_asks (asked_at);
CREATE INDEX agent_searches_searched_at ON agent_searches (searched_at);
CREATE INDEX agent_feedback_reacted_at ON agent_feedback (reacted_at);
-- Each thread's counts in GET /api/v1/threads, and forgetting a deleted thread root.
CREATE INDEX agent_asks_thread ON agent_asks (channel, thread_ts);
CREATE INDEX agent_searches_thread ON agent_searches (channel, thread_ts);
