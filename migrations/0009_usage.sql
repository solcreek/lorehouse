-- How the agent is used, for GET /status: who asks it things, whether its searches
-- found anything, and the 👍/👎 people leave on its replies. Public channels only; a DM
-- is never recorded. See src/usage.ts.

-- One row per message that started a turn. Keyed by the message, so Slack redelivering
-- it after a restart is not counted twice.
CREATE TABLE agent_asks (
  channel    TEXT NOT NULL,
  ts         TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  user       TEXT NOT NULL,
  at         TEXT NOT NULL,  -- RFC 3339
  PRIMARY KEY (channel, ts)
);

-- One row per search_knowledge call, with how many documents it returned.
CREATE TABLE agent_searches (
  id         INTEGER PRIMARY KEY,
  channel    TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  query      TEXT NOT NULL,
  hits       INTEGER NOT NULL,
  at         TEXT NOT NULL
);

-- A 👍/👎 on one of the agent's replies; removing the reaction deletes the row.
CREATE TABLE agent_feedback (
  channel     TEXT NOT NULL,
  message_ts  TEXT NOT NULL,
  user        TEXT NOT NULL,
  rating      TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  at          TEXT NOT NULL,
  PRIMARY KEY (channel, message_ts, user, rating)
);

-- GET /status reads each table over a recent window.
CREATE INDEX agent_asks_at ON agent_asks (at);
CREATE INDEX agent_searches_at ON agent_searches (at);
CREATE INDEX agent_feedback_at ON agent_feedback (at);
