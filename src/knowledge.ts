// knowledge.ts — Lorehouse's own store: the SQL in /migrations applied in order and
// recorded in `lorehouse_migrations`, the documents the agent searches, and where each
// ingest source got to.

import { Database } from "./sqlite";
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
  sourceVersion?: string; // freshness in the source's terms (Slack: newest message/edit ts)
};

// ── the index text contract (see migrations/0004_cjk_index.sql) ─────────────────

// Scripts written without spaces between words. FTS5's default tokenizer would treat a
// whole run of them as one token, so they are split into overlapping bigrams.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
// Bump when indexText changes: every index row is rebuilt on the next start.
export const INDEX_VERSION = "cjk-bigram-1";

export function indexText(s: string): string {
  return s.replace(CJK_RUN, (run) => {
    const chars = [...run];
    const grams = chars.length === 1 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
    return ` ${grams.join(" ")} `;
  });
}

// `key`: the tenant's data key, when its files are encrypted (src/tenant-key.ts).
export function openKnowledge(path: string, migrations = MIGRATIONS, wal: WalOptions = {}, key?: Uint8Array): Database {
  const db = new Database(path, { key });
  db.exec("PRAGMA journal_mode = WAL");
  // Freed pages are zeroed, not left holding what was deleted (a pragma lasts one
  // connection, so it is set on every open). See migrations/0010_fts_secure_delete.sql.
  db.exec("PRAGMA secure_delete = ON");
  db.exec("CREATE TABLE IF NOT EXISTS lorehouse_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  const applied = new Set((db.query("SELECT version FROM lorehouse_migrations").all() as { version: number }[]).map((r) => r.version));
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.query("INSERT INTO lorehouse_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, new Date().toISOString());
    })();
  }
  if (hasTable(db, "knowledge_index_meta")) {
    ensureIndex(db);
    if (path !== ":memory:") compactOnce(db);
  }
  if (path !== ":memory:" && path !== "") {
    const c = new WalCheckpoint(db, wal);
    checkpoints.set(db, c);
    // A WAL left by a stop that couldn't checkpoint (busy, or killed) may hold removed text:
    // empty it once on every open, as soon as the event loop is free.
    c.request(0);
  }
  return db;
}

// ── removed text leaves the WAL too (#89) ───────────────────────────────────────
//
// secure_delete zeroes what a delete or an overwrite frees, in the page it rewrites. But in
// WAL mode that page is written to lorehouse.db-wal first, and the frames written before
// the delete still hold the old page, text and all, until the WAL is checkpointed and
// truncated: SQLite's own checkpoints copy the frames back but leave the file's bytes, and
// the WAL is only removed when the last connection closes cleanly. So whatever removes
// text (a deleted or edited message, a purged channel, erased usage) asks for a TRUNCATE
// checkpoint here, and closeKnowledge runs one before closing.
//
// A request arms one timer: a burst of deletes within `delayMs` shares a checkpoint, and a
// steady stream of them can't put it off (the first request sets when it runs). A busy
// checkpoint (another connection reading) is logged and tried again `retryMs` later; it
// never throws into the write that asked for it. Every open asks for one too, for a WAL
// an earlier process left behind.

export type WalOptions = { delayMs?: number; retryMs?: number; log?: (msg: string) => void };

class WalCheckpoint {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly log: (msg: string) => void;
  runs = 0; // checkpoints attempted, for tests

  constructor(private readonly db: Database, opts: WalOptions) {
    this.delayMs = opts.delayMs ?? 1000;
    this.retryMs = opts.retryMs ?? 30_000;
    this.log = opts.log ?? ((m) => console.error(m));
  }

  request(delayMs = this.delayMs): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.now(true)) this.request(this.retryMs);
    }, delayMs);
    // Never what keeps a process alive: closeKnowledge checkpoints on the way out.
    (this.timer as { unref?: () => void }).unref?.();
  }

  // Checkpoint and truncate now. True when the WAL is empty afterwards. `retrying` says
  // whether a failure will be tried again (the timer) or not (closing).
  now(retrying: boolean): boolean {
    this.runs++;
    const then = retrying ? "trying again" : "the next open tries again";
    // Closed under it (a plain db.close()): nothing left to checkpoint, and never will be.
    if (!this.db.open) {
      this.stop();
      return true;
    }
    try {
      const { busy } = this.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
      if (!busy) return true;
      this.log(`knowledge: couldn't empty the WAL of removed text (the database is in use); ${then}`);
    } catch (err) {
      this.log(`knowledge: couldn't empty the WAL of removed text; ${then}: ${err}`);
    }
    return false;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

const checkpoints = new WeakMap<Database, WalCheckpoint>();

// Text was removed from `db`: have it leave the WAL soon (a no-op for :memory:).
export function checkpointSoon(db: Database): void {
  checkpoints.get(db)?.request();
}

// How many checkpoints `db` has attempted since it was opened (tests).
export function checkpointRuns(db: Database): number {
  return checkpoints.get(db)?.runs ?? 0;
}

// Close the knowledge store for good: no checkpoint pending, the WAL checkpointed and
// truncated, then the connection closed. False when the checkpoint was busy (logged): the
// WAL then keeps its frames until the next openKnowledge checkpoints it.
export function closeKnowledge(db: Database): boolean {
  const c = checkpoints.get(db);
  c?.stop();
  checkpoints.delete(db);
  const done = c ? c.now(false) : true;
  db.close();
  return done;
}

// PRAGMA secure_delete is not retroactive: rows deleted before it was on (by a build
// without it) left their bytes in free pages. Rewriting the whole file once removes them.
// It is its own step after the migrations, never one of them, so a failure here can't hold
// back or reorder the migrations: it is marked done only once VACUUM and a full checkpoint
// (the .db file itself rewritten, not only the WAL) both succeed, and retried on the next
// open otherwise, e.g. while another process holds a read.
const COMPACTED = "secure-delete-1";

function compactOnce(db: Database): void {
  // Only once secure_delete governs the file (migration 10): compacting earlier would be
  // undone by the next delete.
  if (!db.query("SELECT 1 FROM lorehouse_migrations WHERE version = 10").get()) return;
  const row = db.query("SELECT value FROM knowledge_index_meta WHERE key = 'compacted'").get() as { value: string } | null;
  if (row?.value === COMPACTED) return;
  try {
    db.exec("VACUUM");
    const { busy } = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    if (busy) {
      console.error("knowledge: the one-time compaction couldn't checkpoint (the database is in use); retrying on the next start");
      return;
    }
    db.query("INSERT INTO knowledge_index_meta (key, value) VALUES ('compacted', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(COMPACTED);
  } catch (err) {
    console.error("knowledge: the one-time compaction failed; retrying on the next start:", err);
  }
}

function hasTable(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(name);
}

// Rebuild every index row when the index text contract changed (or was never built).
function ensureIndex(db: Database): void {
  const row = db.query("SELECT value FROM knowledge_index_meta WHERE key = 'version'").get() as { value: string } | null;
  if (row?.value === INDEX_VERSION) return;
  db.transaction(() => {
    db.exec("DELETE FROM knowledge_fts");
    const insert = db.prepare("INSERT INTO knowledge_fts (rowid, title, text) VALUES (?, ?, ?)");
    for (const d of db.query("SELECT id, title, text FROM knowledge_documents").all() as { id: number; title: string; text: string }[]) {
      insert.run(d.id, indexText(d.title), indexText(d.text));
    }
    db.query("INSERT INTO knowledge_index_meta (key, value) VALUES ('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(INDEX_VERSION);
  })();
}

// Insert, or replace in place (a Slack thread grows; its id doesn't change). The document
// and its index row change together. A replaced document whose text changed may have lost
// some (a deleted reply, an edit), so it asks for a checkpoint, as a delete does.
export function upsertDocument(db: Database, doc: Document): void {
  const replaced = db.transaction(() => {
    const old = db.query("SELECT title, text FROM knowledge_documents WHERE doc_id = ?").get(doc.docId) as { title: string; text: string } | null;
    const { id } = db.query(
      `INSERT INTO knowledge_documents (doc_id, kind, source, title, text, updated_at, source_version) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(doc_id) DO UPDATE SET kind = excluded.kind, source = excluded.source, title = excluded.title,
         text = excluded.text, updated_at = excluded.updated_at, source_version = excluded.source_version
       RETURNING id`,
    ).get(doc.docId, doc.kind, doc.source, doc.title, doc.text, new Date().toISOString(), doc.sourceVersion ?? null) as { id: number };
    db.query("DELETE FROM knowledge_fts WHERE rowid = ?").run(id);
    db.query("INSERT INTO knowledge_fts (rowid, title, text) VALUES (?, ?, ?)").run(id, indexText(doc.title), indexText(doc.text));
    return !!old && (old.title !== doc.title || old.text !== doc.text);
  })();
  if (replaced) checkpointSoon(db);
}

// Remove a document and its index row; its text leaves the WAL soon after (checkpointSoon).
// True if it existed.
export function deleteDocument(db: Database, docId: string): boolean {
  const removed = db.transaction(() => {
    const row = db.query("DELETE FROM knowledge_documents WHERE doc_id = ? RETURNING id").get(docId) as { id: number } | null;
    if (row) db.query("DELETE FROM knowledge_fts WHERE rowid = ?").run(row.id);
    return !!row;
  })();
  if (removed) checkpointSoon(db);
  return removed;
}

export function documentVersion(db: Database, docId: string): string | null | undefined {
  const row = db.query("SELECT source_version FROM knowledge_documents WHERE doc_id = ?").get(docId) as { source_version: string | null } | null;
  return row ? row.source_version : undefined; // undefined = no such document; null = version unknown
}

export function docIdsWithPrefix(db: Database, prefix: string): string[] {
  return (db.query("SELECT doc_id FROM knowledge_documents WHERE doc_id >= ? AND doc_id < ?").all(prefix, `${prefix}￿`) as { doc_id: string }[]).map((r) => r.doc_id);
}

// All documents, or only those whose id starts with `prefix`.
export function countDocuments(db: Database, prefix?: string): number {
  if (prefix === undefined) return (db.query("SELECT count(*) AS n FROM knowledge_documents").get() as { n: number }).n;
  return (db.query("SELECT count(*) AS n FROM knowledge_documents WHERE doc_id >= ? AND doc_id < ?").get(prefix, `${prefix}￿`) as { n: number }).n;
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

// The most recently active documents, newest first — for "what's been discussed
// lately?", which no keyword search can answer. Recency is the source's own
// (source_version: for Slack, the thread's newest message or edit); documents without
// one (seeds) never count as recent. `sinceSec` is a Unix timestamp lower bound.
export function recentDocuments(db: Database, opts: { limit: number; sinceSec?: number; sourcePrefix?: string }): (Chunk & { activeAt: string })[] {
  const rows = db.query(
    `SELECT doc_id AS id, title, source, text, source_version AS v FROM knowledge_documents
     WHERE source_version IS NOT NULL AND CAST(source_version AS REAL) >= ? AND doc_id >= ? AND doc_id < ?
     ORDER BY CAST(source_version AS REAL) DESC LIMIT ?`,
  ).all(opts.sinceSec ?? 0, opts.sourcePrefix ?? "", `${opts.sourcePrefix ?? ""}￿`, opts.limit) as (Chunk & { v: string })[];
  return rows.map(({ v, ...c }) => ({ ...c, activeAt: new Date(Number(v) * 1000).toISOString() }));
}

// See the query contract in migrations/0004_cjk_index.sql. Each token is quoted so a
// word like NOT can never be read as an operator.
export function matchExpression(query: string): string | null {
  const t = indexText(query).toLowerCase();
  const tokens = [
    ...(t.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 2),
    ...(t.match(CJK_RUN) ?? []),
  ];
  return tokens.length ? tokens.map((w) => `"${w}"`).join(" OR ") : null;
}

// The agent's search_knowledge takes the top 5; the admin API may ask for more, in the
// same order.
export function searcher(db: Database, limit = 5) {
  const stmt = db.prepare(
    `SELECT d.doc_id AS id, d.title, d.source, d.text
     FROM knowledge_fts JOIN knowledge_documents d ON d.id = knowledge_fts.rowid
     WHERE knowledge_fts MATCH ? ORDER BY bm25(knowledge_fts) LIMIT ${Math.trunc(limit)}`,
  );
  return (query: string): Chunk[] => {
    const expr = matchExpression(query);
    return expr ? (stmt.all(expr) as Chunk[]) : [];
  };
}

// ── browsing the index (the admin API) ──────────────────────────────────────────

// When a document was last active in its source (Slack: the thread's newest message or
// edit, a Unix ts), or null when the source has no clock (seeds).
function activeAt(version: string | null): string | null {
  const sec = version === null ? NaN : Number(version);
  return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

// A document without its text. `rowid` and `updatedAt` are its place in a page.
export type DocumentSummary = { id: string; kind: string; source: string; title: string; updatedAt: string; activeAt: string | null; chars: number; rowid: number };

// Documents, most recently (re)indexed first. `prefix` narrows by id ("slack:C0123:");
// `after` continues from the last row of the previous page.
export function listDocuments(db: Database, opts: { limit: number; prefix?: string; kind?: string; after?: { updatedAt: string; rowid: number } }): DocumentSummary[] {
  const prefix = opts.prefix ?? "";
  const rows = db.query(
    // Qualified: SQLite would read a bare `id` in WHERE or ORDER BY as the doc_id alias.
    `SELECT d.id AS rowid, d.doc_id AS id, d.kind, d.source, d.title, d.updated_at AS updatedAt, d.source_version AS v, length(d.text) AS chars
     FROM knowledge_documents d
     WHERE d.doc_id >= @from AND d.doc_id < @to AND (@kind IS NULL OR d.kind = @kind) AND (@at IS NULL OR (d.updated_at, d.id) < (@at, @rowid))
     ORDER BY d.updated_at DESC, d.id DESC LIMIT @limit`,
  ).all({ from: prefix, to: `${prefix}￿`, kind: opts.kind ?? null, at: opts.after?.updatedAt ?? null, rowid: opts.after?.rowid ?? null, limit: opts.limit }) as (Omit<DocumentSummary, "activeAt"> & { v: string | null })[];
  return rows.map(({ v, ...d }) => ({ ...d, activeAt: activeAt(v) }));
}

export type StoredDocument = { id: string; kind: string; source: string; title: string; text: string; updatedAt: string; activeAt: string | null };

export function getDocument(db: Database, docId: string): StoredDocument | undefined {
  const row = db.query("SELECT doc_id AS id, kind, source, title, text, updated_at AS updatedAt, source_version AS v FROM knowledge_documents WHERE doc_id = ?").get(docId) as
    | (Omit<StoredDocument, "activeAt"> & { v: string | null })
    | null;
  if (!row) return undefined;
  const { v, ...d } = row;
  return { ...d, activeAt: activeAt(v) };
}
