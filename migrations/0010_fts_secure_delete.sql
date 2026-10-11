-- Text removed from the knowledge index leaves the database file, not only the search
-- results. A message deleted or edited in Slack (a pasted secret, a mistake) already
-- stops being quotable; without this its words stayed on disk, and in every backup.
--
-- FTS5 deletes by writing a marker: the old terms stay in the index's segments until a
-- merge happens to rewrite them. With 'secure-delete' (SQLite 3.42+) each delete or
-- update removes its terms from the segments at once. The option is stored in the
-- table's config, so it holds for every later connection.
--
-- 'optimize' merges the segments into one, dropping what earlier deletes left behind.
-- The pages it frees are zeroed because the connection runs with PRAGMA secure_delete = ON
-- (set in openKnowledge before any migration; a pragma is per connection, not stored).
INSERT INTO knowledge_fts (knowledge_fts, rank) VALUES ('secure-delete', 1);
INSERT INTO knowledge_fts (knowledge_fts) VALUES ('optimize');
