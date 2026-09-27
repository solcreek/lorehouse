-- Knowledge as documents: one row per unit a human would open (a Slack thread, a doc
-- page, a seeded chunk), updatable in place. 0001's flat FTS table could only be
-- appended to; a thread that grows needs an upsert.
--
-- Search contract (unchanged in effect; conformance checks the top hit):
-- lowercase the query, take the [a-z0-9]+ tokens of 2+ characters, join with " OR ", then
--   SELECT d.doc_id, d.title, d.source, d.text
--   FROM knowledge_fts JOIN knowledge_documents d ON d.id = knowledge_fts.rowid
--   WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT 5
-- Only title and text are indexed, as in 0001, so rankings carry over.

CREATE TABLE knowledge_documents (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL UNIQUE,  -- stable: "slack:C0123:1700000000.000100", or a seed id
  kind TEXT NOT NULL,           -- 'slack_thread' | 'seed'
  source TEXT NOT NULL,         -- where a human opens it (a URL, or a path for seeds)
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL      -- RFC 3339
);

CREATE VIRTUAL TABLE knowledge_fts USING fts5(
  title, text, content = 'knowledge_documents', content_rowid = 'id'
);

CREATE TRIGGER knowledge_documents_ai AFTER INSERT ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
END;
CREATE TRIGGER knowledge_documents_ad AFTER DELETE ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts (knowledge_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
END;
CREATE TRIGGER knowledge_documents_au AFTER UPDATE ON knowledge_documents BEGIN
  INSERT INTO knowledge_fts (knowledge_fts, rowid, title, text) VALUES ('delete', old.id, old.title, old.text);
  INSERT INTO knowledge_fts (rowid, title, text) VALUES (new.id, new.title, new.text);
END;

-- Carry 0001's chunks over as seeds, keeping their ids (the search contract cites them).
INSERT INTO knowledge_documents (doc_id, kind, source, title, text, updated_at)
  SELECT id, 'seed', source, title, text, strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM knowledge_chunks;
DROP TABLE knowledge_chunks;

-- Where each ingest source got to, so a restart resumes instead of re-reading history.
CREATE TABLE ingest_cursors (
  source TEXT PRIMARY KEY,      -- e.g. "slack:C0123"
  cursor TEXT NOT NULL,         -- source-specific; for Slack, the newest message ts seen
  updated_at TEXT NOT NULL
);
