-- Keep both of a person's names. A display name is often a handle ("hkato"); alone,
-- a reader (or a model) can mistake it for someone else's handle. Knowledge now names
-- people as "display (real name)" when the two differ.
-- Rows cached before this migration have neither column; they count as stale and are
-- re-fetched on next use.
ALTER TABLE slack_users ADD COLUMN display_name TEXT;
ALTER TABLE slack_users ADD COLUMN real_name TEXT;
