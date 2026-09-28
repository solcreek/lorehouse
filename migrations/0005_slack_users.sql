-- Slack user id → the name people see, so knowledge reads "Wendy: …" instead of
-- "@U02ABC: …". Names are cached here because every thread re-read would otherwise
-- call users.info for each author.
CREATE TABLE slack_users (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,       -- display name, else real name, else the handle
  updated_at TEXT NOT NULL  -- RFC 3339; refreshed after a day
);
