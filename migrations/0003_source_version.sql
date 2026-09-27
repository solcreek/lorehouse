-- How fresh a document is, in its source's own terms, so a restart can tell which
-- documents changed while the app was down. For a Slack thread it is the newest
-- message-or-edit timestamp in the thread. NULL means unknown (seeds, older rows),
-- which a reconcile treats as stale.
ALTER TABLE knowledge_documents ADD COLUMN source_version TEXT;
