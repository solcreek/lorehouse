// knowledge.ts — Lorehouse's own store: the SQL in /migrations applied in order and
// recorded in `lorehouse_migrations`, the documents the agent searches, and where each
// ingest source got to.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "./migrations";

// What search returns (and the tool hands the model). `id` is the document's stable id.
export type Chunk = { id: string; source: string; title: string; text: string };

export type Document = {
  docId: string; // "slack:C0123:1700000000.000100", or a seed id
  kind: "slack_thread" | "seed";
  source: string; // where a human opens it
  title: string;
  text: string;
};

export function openKnowledge(path: string, migrations = MIGRATIONS): Database {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS lorehouse_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((db.query("SELECT version FROM lorehouse_migrations").all() as { version: number }[]).map((r) => r.version));
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO lorehouse_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    })();
  }
  return db;
}

// Insert, or replace in place (a Slack thread grows; its id doesn't change).
export function upsertDocument(db: Database, doc: Document): void {
  db.query(
    `INSERT INTO knowledge_documents (doc_id, kind, source, title, text, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, source = excluded.source, title = excluded.title,
       text = excluded.text, updated_at = excluded.updated_at`,
  ).run(doc.docId, doc.kind, doc.source, doc.title, doc.text, new Date().toISOString());
}

export function countDocuments(db: Database): number {
  return (db.query("SELECT count(*) AS n FROM knowledge_documents").get() as { n: number }).n;
}

export function getCursor(db: Database, source: string): string | undefined {
  return (db.query("SELECT cursor FROM ingest_cursors WHERE source = ?").get(source) as { cursor: string } | null)?.cursor;
}

export function setCursor(db: Database, source: string, cursor: string): void {
  db.query("INSERT INTO ingest_cursors (source, cursor, updated_at) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at")
    .run(source, cursor, new Date().toISOString());
}

// Seed from a JSONL file of {id, source, title, text} — only into an empty index, so a
// restart against a persistent database doesn't duplicate anything.
export function seedFromJsonl(db: Database, path: string): number {
  if (countDocuments(db) > 0) return 0;
  let count = 0;
  db.transaction(() => {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as Chunk;
      upsertDocument(db, { docId: c.id, kind: "seed", source: c.source, title: c.title, text: c.text });
      count++;
    }
  })();
  return count;
}

// See the search contract in migrations/0002_documents.sql.
export function matchExpression(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
  return tokens.length ? tokens.join(" OR ") : null;
}

export function searcher(db: Database) {
  const stmt = db.prepare(
    `SELECT d.doc_id AS id, d.title, d.source, d.text
     FROM knowledge_fts JOIN knowledge_documents d ON d.id = knowledge_fts.rowid
     WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT 5`,
  );
  return (query: string): Chunk[] => {
    const expr = matchExpression(query);
    return expr ? (stmt.all(expr) as Chunk[]) : [];
  };
}
