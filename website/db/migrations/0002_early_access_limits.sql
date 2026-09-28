-- Sign-up attempts per client per hour, so join_early_access can't be used to flood
-- the list. `client` is a SHA-256 of the caller's IP (never the IP itself), or '*'
-- for the site-wide total. Rows older than a day are deleted as new hours start.
CREATE TABLE early_access_attempts (
  client TEXT NOT NULL,
  hour   TEXT NOT NULL,          -- UTC, 'YYYY-MM-DDTHH'
  count  INTEGER NOT NULL,
  PRIMARY KEY (client, hour)
);
