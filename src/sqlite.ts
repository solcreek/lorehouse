// sqlite.ts — the one SQLite driver Lorehouse's own databases are opened with:
// better-sqlite3-multiple-ciphers (SQLite3MultipleCiphers in a Node-API addon), so the
// tenant's files can later be encrypted at rest (#148). Nothing else in src/ imports a
// driver; June's SESSIONS_DB is still opened by June, with its own.
//
// The surface is the part of bun:sqlite Lorehouse used, so callers didn't change:
//
// - `query(sql)` caches the prepared statement by its text, as bun:sqlite's does
//   (better-sqlite3 has only `prepare`, which compiles every call). The cache is bounded:
//   the app's SQL is a finite set of strings, but a bug that built SQL from data must not
//   grow it without end. `prepare(sql)` never caches.
// - `get()` returns null when there is no row, as bun:sqlite did (better-sqlite3 returns
//   undefined). Callers test `!== null` and `?? undefined`; one place normalises it, not
//   every caller.
// - A connection starts with the pragmas bun:sqlite's gave Lorehouse on Linux (and
//   `test/sqlite.test.ts` compares them): the addon is built with different defaults
//   (synchronous NORMAL in WAL, foreign_keys ON, a 16 MB page cache, a 5 s busy timeout).
//   A busy timeout in particular would block the event loop: a checkpoint that finds a
//   reader must return busy at once and be retried later (src/knowledge.ts).
//
// Differences that remain, for whoever writes new SQL here:
// - Parameters are `?` (positional) or named (`@name`, `:name`, `$name`), bound from an
//   object whose keys have no prefix: `.all({ limit: 5 })`. Numbered ones (`?1`) are
//   named too ("1"), so a positional call can't bind them; use names.
// - Only numbers, strings, bigints, Buffers/Uint8Arrays and null bind: a boolean throws.
// - `get()`/`all()` on a statement that returns no rows (an INSERT without RETURNING)
//   throws; use `run()`.
// - Double-quoted strings are identifiers only (SQLITE_DQS=0); string literals take '.
//
// The addon: `bun build --compile` embeds a `.node` file only when it's required by a
// literal path, and folds `process.platform`/`process.arch` for its `--target`, so the
// branch below leaves exactly one target's addon in a binary, also when cross-compiling
// (release.yml builds linux-arm64 on x64). At run time the binary writes that addon to
// $TMPDIR (else /tmp) and loads it from there, so TMPDIR must be writable and allow
// exec (not mounted noexec). Under `bun src/server.ts` and `bun test` it's loaded from
// node_modules. Linux needs glibc 2.34 and libstdc++.so.6.

// The addon's surface Lorehouse uses. Declared here: the package's own index.d.ts isn't
// reachable through its "exports", and `require` gives no types anyway.
type NativeStatement = {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
};
type Native = {
  prepare(sql: string): NativeStatement;
  exec(sql: string): unknown;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): unknown;
  readonly open: boolean;
  readonly inTransaction: boolean;
};
type NativeOptions = { readonly: boolean; fileMustExist: boolean; timeout: number };

// Bun 1.3 panics loading the addon (NAPI FATAL ERROR), past any catch: say why first.
if (!Bun.semver.satisfies(Bun.version, ">=1.4.3")) {
  throw new Error(`Lorehouse needs Bun 1.4.3 or newer for its SQLite driver; this is Bun ${Bun.version}`);
}

const NativeDatabase: new (path: string, opts: NativeOptions) => Native =
  process.platform === "darwin"
    ? process.arch === "arm64"
      ? require("better-sqlite3-multiple-ciphers/darwin-arm64")
      : require("better-sqlite3-multiple-ciphers/darwin-x64")
    : process.arch === "arm64"
      ? require("better-sqlite3-multiple-ciphers/linux-arm64")
      : require("better-sqlite3-multiple-ciphers/linux-x64");

export type Binding = string | number | bigint | null | Uint8Array;
// Positional values, or one object of named ones.
export type Params = Binding[] | [Record<string, Binding>];

export type RunResult = { changes: number; lastInsertRowid: number | bigint };

export interface Statement<R = unknown, P extends unknown[] = Params> {
  get(...params: P): R | null;
  all(...params: P): R[];
  run(...params: P): RunResult;
}

class WrappedStatement<R, P extends unknown[]> implements Statement<R, P> {
  constructor(private readonly s: NativeStatement) {}
  get(...params: P): R | null {
    return (this.s.get(...params) as R | undefined) ?? null;
  }
  all(...params: P): R[] {
    return this.s.all(...params) as R[];
  }
  run(...params: P): RunResult {
    return this.s.run(...params);
  }
}

export type OpenOptions = {
  // Fail instead of creating the file (bun:sqlite's { readwrite: true, create: false }).
  mustExist?: boolean;
  readonly?: boolean;
};

// The pragmas every connection starts with: bun:sqlite's effective values on Linux.
const CONNECTION_PRAGMAS = [
  "PRAGMA synchronous = FULL", // the addon's default in WAL mode is NORMAL
  "PRAGMA foreign_keys = OFF", // the addon is built with foreign keys on
  "PRAGMA cache_size = -2000", // 2 MB; the addon's default is 16 MB
];

export const STATEMENT_CACHE_SIZE = 256;

export class Database {
  private readonly db: Native;
  private readonly cache = new Map<string, Statement<any, any>>();

  constructor(path: string, opts: OpenOptions = {}) {
    // timeout 0: no busy handler, as bun:sqlite (the addon's default is 5 s).
    this.db = new NativeDatabase(path, { readonly: opts.readonly ?? false, fileMustExist: opts.mustExist ?? false, timeout: 0 });
    for (const p of CONNECTION_PRAGMAS) this.db.exec(p);
  }

  // A statement prepared once per SQL text and reused (least recently used goes first).
  query<R = unknown, P extends unknown[] = Params>(sql: string): Statement<R, P> {
    const hit = this.cache.get(sql);
    if (hit) {
      this.cache.delete(sql);
      this.cache.set(sql, hit);
      return hit;
    }
    const s = this.prepare<R, P>(sql);
    this.cache.set(sql, s);
    if (this.cache.size > STATEMENT_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    return s;
  }

  // A statement prepared now and not cached: for SQL the caller keeps.
  prepare<R = unknown, P extends unknown[] = Params>(sql: string): Statement<R, P> {
    return new WrappedStatement<R, P>(this.db.prepare(sql));
  }

  // Run one or more statements, no parameters, no rows.
  exec(sql: string): void {
    this.db.exec(sql);
  }

  // `fn` in a transaction (a savepoint when nested), committed when it returns and rolled
  // back when it throws. As bun:sqlite's: returns a function to call.
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return this.db.transaction(fn);
  }

  get open(): boolean {
    return this.db.open;
  }

  get inTransaction(): boolean {
    return this.db.inTransaction;
  }

  // How many statements `query` holds (tests).
  get cachedStatements(): number {
    return this.cache.size;
  }

  close(): void {
    this.cache.clear();
    if (this.db.open) this.db.close();
  }
}
