-- People who asked to hear when hosted Lorehouse opens.
CREATE TABLE early_access (
  email      TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
