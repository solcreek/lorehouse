// The driver layer (src/sqlite.ts): Lorehouse's databases moved from bun:sqlite to
// better-sqlite3-multiple-ciphers with no change in behavior. What bun:sqlite gave for
// free and the addon doesn't (a statement cache, null for no row, its connection
// defaults) is the layer's, and checked here.

import { describe, expect, test } from "bun:test";
import { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { Database, STATEMENT_CACHE_SIZE } from "../src/sqlite";

function withDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lh-sqlite-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const PRAGMAS = [
  "journal_mode", "synchronous", "busy_timeout", "foreign_keys", "secure_delete", "cache_size", "temp_store",
  "mmap_size", "wal_autocheckpoint", "journal_size_limit", "auto_vacuum", "page_size", "locking_mode",
  "recursive_triggers", "trusted_schema", "automatic_index", "cell_size_check", "query_only",
  "defer_foreign_keys", "reverse_unordered_selects", "legacy_alter_table", "fullfsync", "checkpoint_fullfsync",
  "ignore_check_constraints", "encoding", "threads",
] as const;

function pragmas(db: { query(sql: string): { get(): unknown } }): Record<string, unknown> {
  return Object.fromEntries(PRAGMAS.map((p) => [p, Object.values(db.query(`PRAGMA ${p}`).get() as object)[0]]));
}

// What a knowledge connection ran with under bun:sqlite 1.4.3 on Linux (its bundled
// SQLite), which is what every deployment runs.
const BUN_LINUX = {
  journal_mode: "wal", synchronous: 2, busy_timeout: 0, foreign_keys: 0, secure_delete: 1, cache_size: -2000, temp_store: 0,
  mmap_size: 0, wal_autocheckpoint: 1000, journal_size_limit: -1, auto_vacuum: 0, page_size: 4096, locking_mode: "normal",
  recursive_triggers: 0, trusted_schema: 1, automatic_index: 1, cell_size_check: 0, query_only: 0,
  defer_foreign_keys: 0, reverse_unordered_selects: 0, legacy_alter_table: 0, fullfsync: 0, checkpoint_fullfsync: 0,
  ignore_check_constraints: 0, encoding: "UTF-8", threads: 0,
};

describe("sqlite driver", () => {
  test("a knowledge connection runs with the pragmas bun:sqlite gave it (synchronous FULL, no busy wait, no foreign keys, 2 MB cache)", () => {
    withDir((dir) => {
      const db = openKnowledge(join(dir, "lorehouse.db"));
      expect(pragmas(db)).toEqual(BUN_LINUX);
      db.close();
    });
  });

  // macOS's bun:sqlite is the system SQLite, built with other defaults; the pinned table
  // above is the contract there.
  test.if(process.platform === "linux")("and the same as bun:sqlite's on this machine, opened as openKnowledge opened it", () => {
    withDir((dir) => {
      // Another file: two SQLite libraries in one process must never share one.
      const bun = new BunDatabase(join(dir, "bun.db"));
      bun.exec("PRAGMA journal_mode = WAL");
      bun.exec("PRAGMA secure_delete = ON");
      const db = openKnowledge(join(dir, "lorehouse.db"));
      expect(pragmas(db)).toEqual(pragmas(bun));
      bun.close();
      db.close();
    });
  });

  test("every connection starts with them, not only the knowledge store's", () => {
    const db = new Database(":memory:");
    expect(db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
    expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 0 });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
    expect(db.query("PRAGMA cache_size").get()).toEqual({ cache_size: -2000 });
    db.close();
  });

  test("query() prepares a statement once per SQL text; prepare() every time", () => {
    const db = new Database(":memory:");
    expect(db.query("SELECT 1 AS n")).toBe(db.query("SELECT 1 AS n"));
    expect(db.query("SELECT 1 AS n")).not.toBe(db.query("SELECT 2 AS n"));
    expect(db.prepare("SELECT 1 AS n")).not.toBe(db.prepare("SELECT 1 AS n"));
    expect(db.cachedStatements).toBe(2);
    db.close();
  });

  test("the statement cache is bounded, and the least recently used goes first", () => {
    const db = new Database(":memory:");
    const first = db.query("SELECT 0 AS n");
    const second = db.query("SELECT 1 AS n");
    for (let i = 2; i < STATEMENT_CACHE_SIZE; i++) db.query(`SELECT ${i} AS n`);
    expect(db.cachedStatements).toBe(STATEMENT_CACHE_SIZE);
    expect(db.query("SELECT 0 AS n")).toBe(first); // used again: now the most recent
    db.query("SELECT 'one more' AS n");
    expect(db.cachedStatements).toBe(STATEMENT_CACHE_SIZE);
    expect(db.query("SELECT 0 AS n")).toBe(first);
    expect(db.query("SELECT 1 AS n")).not.toBe(second); // evicted, prepared anew
    expect(db.query("SELECT 1 AS n").get()).toEqual({ n: 1 });
    db.close();
  });

  test("get() is null when there is no row, as bun:sqlite's was", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)");
    db.query("INSERT INTO t VALUES (?, ?)").run("a", "1");
    expect(db.query("SELECT v FROM t WHERE k = ?").get("a")).toEqual({ v: "1" });
    expect(db.query("SELECT v FROM t WHERE k = ?").get("b")).toBeNull();
    expect(db.query("SELECT v FROM t WHERE k = ?").all("b")).toEqual([]);
    db.close();
  });

  test("named parameters bind from an object without the prefix", () => {
    const db = new Database(":memory:");
    expect(db.query("SELECT @a AS a, @a IS NULL AS none, @b AS b").get({ a: null, b: 2 })).toEqual({ a: null, none: 1, b: 2 });
    db.close();
  });

  test("run() reports changes; a transaction commits, rolls back on a throw, and nests", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (n INTEGER)");
    expect(db.query("INSERT INTO t VALUES (?)").run(1)).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(() =>
      db.transaction(() => {
        db.query("INSERT INTO t VALUES (?)").run(2);
        throw new Error("no");
      })(),
    ).toThrow("no");
    const added = db.transaction((n: number) => {
      db.transaction(() => db.query("INSERT INTO t VALUES (?)").run(n))();
      return db.inTransaction;
    })(3);
    expect(added).toBe(true);
    expect(db.inTransaction).toBe(false);
    expect(db.query("SELECT n FROM t ORDER BY n").all()).toEqual([{ n: 1 }, { n: 3 }]);
    db.close();
  });

  test("mustExist refuses a missing file and doesn't create it (bun:sqlite's { readwrite: true, create: false })", () => {
    withDir((dir) => {
      const path = join(dir, "missing.db");
      expect(() => new Database(path, { mustExist: true })).toThrow();
      expect(existsSync(path)).toBe(false);
    });
  });

  test("readonly opens an existing file and refuses writes", () => {
    withDir((dir) => {
      const path = join(dir, "ro.db");
      const w = new Database(path);
      w.exec("CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1)");
      w.close();
      const r = new Database(path, { readonly: true });
      expect(r.query("SELECT n FROM t").all()).toEqual([{ n: 1 }]);
      expect(() => r.exec("INSERT INTO t VALUES (2)")).toThrow(/readonly/);
      r.close();
    });
  });

  test("close() is final and can be called twice; open says so", () => {
    const db = new Database(":memory:");
    const s = db.query("SELECT 1 AS n");
    expect(db.open).toBe(true);
    db.close();
    db.close();
    expect(db.open).toBe(false);
    expect(() => s.get()).toThrow();
  });

  test("FTS5 and the CJK bigram index work through it", () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "d1", kind: "seed", source: "s", title: "部署失敗", text: "rollback the 廣告公司 deploy" });
    upsertDocument(db, { docId: "d2", kind: "seed", source: "s", title: "other", text: "nothing here" });
    const search = searcher(db);
    expect(search("公司").map((c) => c.id)).toEqual(["d1"]);
    expect(search("rollback").map((c) => c.id)).toEqual(["d1"]);
    db.close();
  });
});
