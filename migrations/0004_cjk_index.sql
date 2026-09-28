-- The full-text index moves from trigger-maintained external content to an index the
-- application writes, because what it indexes is no longer the raw text: runs of
-- Chinese, Japanese and Korean are split into overlapping bigrams first. FTS5's default
-- tokenizer treats a whole unspaced CJK run ("分享之前看到廣告公司推") as one token, so
-- no word inside it could be found.
--
-- Index text contract (every implementation must produce the same, byte for byte):
--   Each maximal run of Han, Hiragana, Katakana or Hangul characters is replaced by
--   its overlapping bigrams, space-separated and padded with a space on each side
--   ("廣告公司" → " 廣告 告公 公司 "). A one-character run stays as that one character.
--   All other text is unchanged.
-- Query contract: apply the same transform to the query, lowercase it, take its tokens
-- (runs of [a-z0-9] of 2+ characters, and the CJK bigrams or single characters), and
-- join them with " OR ". Rank with bm25 over (title, text), top 5.
--
-- Rows are (re)filled by the application on start whenever
-- knowledge_index_meta.version differs from the version it builds.

DROP TRIGGER IF EXISTS knowledge_documents_ai;
DROP TRIGGER IF EXISTS knowledge_documents_ad;
DROP TRIGGER IF EXISTS knowledge_documents_au;
DROP TABLE IF EXISTS knowledge_fts;

-- rowid = knowledge_documents.id; title/text hold the TRANSFORMED text.
CREATE VIRTUAL TABLE knowledge_fts USING fts5(title, text);

CREATE TABLE knowledge_index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
