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

// ── the seed file (KNOWLEDGE_SEED, #166) ────────────────────────────────────────
//
// A JSONL file of {id, source, title, text}, one document per line (blank lines skipped),
// read on every start. The `kind = 'seed'` documents follow it: an entry new to the index
// is added, one whose title, source or text changed is re-indexed, one unchanged isn't
// written (its updatedAt stays put), and a seed whose id is no longer in the file is
// deleted. Documents of any other kind (Slack threads) are never read, changed or removed.
//
// The whole file is checked before anything is written, and what is written is one
// transaction: a file with a wrong line, or one that can't be read, throws a SeedError
// naming each line, and the index is left exactly as it was.

// What one read of the seed file did. `entries` is how many the file holds.
export type SeedSync = { entries: number; added: number; updated: number; removed: number };

// The seed file can't be used as it is. The message says which file, which lines, what is
// wrong with each and what to do: it is what an operator sees when the start fails.
export class SeedError extends Error {
  override name = "SeedError";
}

const SEED_FIELDS = ["id", "source", "title", "text"] as const;
const SEED_LINE = '{"id": "…", "source": "…", "title": "…", "text": "…"}';
const SEED_PROBLEMS_SHOWN = 10;
const SLACK_ID_PREFIX = "slack:";

function seedError(path: string, problems: string[]): SeedError {
  const shown = problems.slice(0, SEED_PROBLEMS_SHOWN).map((p) => `\n  ${p}`).join("");
  const more = problems.length > SEED_PROBLEMS_SHOWN ? `\n  … and ${problems.length - SEED_PROBLEMS_SHOWN} more` : "";
  return new SeedError(
    `lorehouse: KNOWLEDGE_SEED ${path} was not read, and the index is as it was: ${problems.length} ${problems.length === 1 ? "line is" : "lines are"} wrong.${shown}${more}\n` +
      `Each line is one JSON object, ${SEED_LINE}, all four strings, with an id no other line has. ` +
      "Fix the file and start again, or unset KNOWLEDGE_SEED to start without reading it (the seed documents already indexed stay).",
  );
}

const jsonType = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

// The file's entries with the line each is on, or a SeedError naming every wrong line.
function readSeed(path: string): { line: number; doc: Chunk }[] {
  let file: string;
  try {
    file = readFileSync(path, "utf8");
  } catch (err) {
    throw new SeedError(
      `lorehouse: KNOWLEDGE_SEED ${path} can't be read, and the index is as it was: ${(err as Error).message}. ` +
        "Point KNOWLEDGE_SEED at a JSONL file this process can read, or unset it to start without one (the seed documents already indexed stay).",
    );
  }
  const entries: { line: number; doc: Chunk }[] = [];
  const problems: string[] = [];
  const firstLine = new Map<string, number>();
  // A byte order mark (an editor's, on Windows) is not part of the first line's JSON.
  (file.charCodeAt(0) === 0xfeff ? file.slice(1) : file).split("\n").forEach((text, i) => {
    const line = i + 1;
    if (!text.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (err) {
      problems.push(`line ${line}: not JSON (${(err as Error).message})`);
      return;
    }
    if (jsonType(value) !== "object") {
      problems.push(`line ${line}: a JSON ${jsonType(value)}, not an object`);
      return;
    }
    const entry = value as Record<string, unknown>;
    const wrong = SEED_FIELDS.flatMap((f) => (entry[f] === undefined ? [`"${f}" is missing`] : typeof entry[f] !== "string" ? [`"${f}" is a ${jsonType(entry[f])}, not a string`] : []));
    if (!wrong.length && !(entry.id as string).trim()) wrong.push('"id" is empty');
    // Half of a character (as a cut made through an emoji leaves, written "\ud83d") is not
    // stored as written, so the entry would never compare equal to what the index holds:
    // re-indexed on every start, or with it in the id, removed on every other one.
    if (!wrong.length) wrong.push(...SEED_FIELDS.filter((f) => !(entry[f] as string).isWellFormed()).map((f) => `"${f}" holds half of a character (a lone surrogate, as text cut through an emoji leaves): write the whole character or drop the half`));
    // "slack:" ids are Slack threads' (slack:<channel>:<root ts>): ingest writes and removes
    // documents under them whatever their kind, so a seed there would not stay a seed.
    if (!wrong.length && (entry.id as string).startsWith(SLACK_ID_PREFIX)) wrong.push(`id "${entry.id as string}" starts with "${SLACK_ID_PREFIX}", which is where Slack threads' ids are: give the entry another id`);
    if (wrong.length) {
      problems.push(`line ${line}: ${wrong.join("; ")}`);
      return;
    }
    const doc = entry as Chunk;
    const first = firstLine.get(doc.id);
    if (first !== undefined) {
      problems.push(`line ${line}: id "${doc.id}" is already used on line ${first}`);
      return;
    }
    firstLine.set(doc.id, line);
    entries.push({ line, doc: { id: doc.id, source: doc.source, title: doc.title, text: doc.text } });
  });
  if (problems.length) throw seedError(path, problems);
  return entries;
}

// Make the index's seed documents what the file at `path` holds (see above).
export function syncSeed(db: Database, path: string): SeedSync {
  const entries = readSeed(path);
  const result: SeedSync = { entries: entries.length, added: 0, updated: 0, removed: 0 };
  db.transaction(() => {
    const stored = db.query("SELECT kind, source, title, text FROM knowledge_documents WHERE doc_id = ?");
    const changed: Chunk[] = [];
    const taken: string[] = [];
    for (const { line, doc } of entries) {
      const old = stored.get(doc.id) as { kind: string; source: string; title: string; text: string } | null;
      if (!old) result.added++;
      // Never written over: a Slack thread's document is Slack's (and ingest would take it
      // back, so the entry would flip between the two on every start).
      else if (old.kind !== "seed") taken.push(`line ${line}: id "${doc.id}" is already the id of a ${old.kind} document, which a seed never replaces: give the entry another id`);
      else if (old.source !== doc.source || old.title !== doc.title || old.text !== doc.text) result.updated++;
      else continue;
      changed.push(doc);
    }
    if (taken.length) throw seedError(path, taken);
    const inFile = new Set(entries.map((e) => e.doc.id));
    const gone = (db.query("SELECT doc_id FROM knowledge_documents WHERE kind = 'seed'").all() as { doc_id: string }[]).filter((r) => !inFile.has(r.doc_id));
    for (const doc of changed) upsertDocument(db, { docId: doc.id, kind: "seed", source: doc.source, title: doc.title, text: doc.text });
    for (const { doc_id } of gone) deleteDocument(db, doc_id);
    result.removed = gone.length;
  })();
  // Old text was removed (an entry gone, or one replaced): it leaves the WAL too.
  if (result.updated || result.removed) checkpointSoon(db);
  return result;
}

// One line for the log: what this start's read of the seed file did.
export function describeSeed(path: string, s: SeedSync): string {
  return `lorehouse: seed: ${path}: ${s.entries} ${s.entries === 1 ? "entry" : "entries"}, ${s.added} added, ${s.updated} updated, ${s.removed} removed`;
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
