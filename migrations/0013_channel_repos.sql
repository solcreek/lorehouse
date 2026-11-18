-- A channel's default repo (#126, src/channel-repos.ts): the GitHub repo workspace_clone
-- gets when a request in that channel names none, and optionally the branch a fresh clone
-- starts on (NULL: the repo's own default branch). One row per channel, set and cleared by
-- an admin through the admin API (PUT/DELETE /api/v1/channels/{id}/repo), never by the
-- model. Only a channel on AGENT_CHANNELS can have one, and the row goes with the rest of
-- what is kept for a channel when it leaves the list (src/purge.ts). It is install data:
-- it holds no message text and names no person.
CREATE TABLE channel_repos (
  channel  TEXT PRIMARY KEY,
  owner    TEXT NOT NULL,
  name     TEXT NOT NULL,
  branch   TEXT,
  set_at   TEXT NOT NULL
);
