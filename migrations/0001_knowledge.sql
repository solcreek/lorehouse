-- The knowledge index: chunks of company text the agent searches.
--
-- This is Lorehouse's own data, in plain SQL any implementation can apply, and kept in
-- Lorehouse's database. It is never inside the agent framework's session tables: those
-- are an implementation detail of whatever runtime drives the agent.
--
-- Search contract (every implementation must match it; conformance checks the top hit):
-- lowercase the query, take the [a-z0-9]+ tokens of 2+ characters, join them with
-- " OR ", then
--   SELECT id, title, source, text FROM knowledge_chunks
--   WHERE knowledge_chunks MATCH ? ORDER BY bm25(knowledge_chunks) LIMIT 5
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_chunks USING fts5(
  id UNINDEXED,
  source UNINDEXED,
  title,
  text
);
