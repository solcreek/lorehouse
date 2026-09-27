// knowledge.ts — Lorehouse's own store: the migrations in /migrations, applied in order
// and recorded in `lorehouse_migrations`, plus the knowledge search.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "./migrations";

export type Chunk = { id: string; source: string; title: string; text: string };

export function openKnowledge(path: string, migrations = MIGRATIONS): Database {
  const db = new Database(path);
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

// Seed from a JSONL file of chunks — only when the index is empty, so a restart against
// a persistent database doesn't duplicate everything.
export function seedFromJsonl(db: Database, path: string): number {
  const { n } = db.query("SELECT count(*) AS n FROM knowledge_chunks").get() as { n: number };
  if (n > 0) return 0;
  const insert = db.prepare("INSERT INTO knowledge_chunks (id, source, title, text) VALUES (?, ?, ?, ?)");
  let count = 0;
  db.transaction(() => {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const c = JSON.parse(line) as Chunk;
      insert.run(c.id, c.source, c.title, c.text);
      count++;
    }
  })();
  return count;
}

// See the search contract in migrations/0001_knowledge.sql.
export function matchExpression(query: string): string | null {
  const tokens = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 2);
  return tokens.length ? tokens.join(" OR ") : null;
}

export function searcher(db: Database) {
  const stmt = db.prepare("SELECT id, title, source, text FROM knowledge_chunks WHERE knowledge_chunks MATCH ? ORDER BY bm25(knowledge_chunks) LIMIT 5");
  return (query: string): Chunk[] => {
    const expr = matchExpression(query);
    return expr ? (stmt.all(expr) as Chunk[]) : [];
  };
}
