-- Threads the agent has been asked into (an @-mention in them). A later reply in such a
-- thread continues the conversation without a new mention; see src/threads.ts.
CREATE TABLE agent_threads (
  channel    TEXT NOT NULL,
  thread_ts  TEXT NOT NULL,
  joined_at  TEXT NOT NULL,
  PRIMARY KEY (channel, thread_ts)
);
