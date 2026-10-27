// sqlite.ts — the one SQLite driver Lorehouse's own databases are opened with:
// better-sqlite3-multiple-ciphers (SQLite3MultipleCiphers in a Node-API addon), so the
// tenant's files can be encrypted at rest (#148). Nothing else in src/ imports a driver.
// June's SESSIONS_DB is opened by June with its own driver, except when the tenant's files
// are encrypted: then it is opened here too, through June's `open` hook (src/app.ts).
//
// Encryption: a connection opened with `key` (the tenant's 32-byte data key,
// src/tenant-key.ts) reads and writes its file, -wal included, under AEGIS-256. The key
// is given raw, as SQLite3MultipleCiphers' x'<hex>' form, so there is no KDF on open
// (a passphrase would run Argon2 on every open). The hex is built in a buffer, never a
// string, and wiped after; SQLite keeps its own copy of the key for the connection.
// A file that the key doesn't open fails the open (KeyMismatchError), and so does a
// plaintext one: `encryptInPlace` is what turns a plaintext file into an encrypted one.
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

import { existsSync, statSync } from "node:fs";

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
  key(key: Buffer): unknown;
  rekey(key: Buffer): unknown;
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
  // The tenant's data key: the file is encrypted under it (see the top of this file).
  key?: Uint8Array;
};

// SQLite3MultipleCiphers' name for AEGIS; its default variant is AEGIS-256.
export const CIPHER = "aegis";
export const KEY_BYTES = 32;

// The file isn't readable with the key given: encrypted under another key, plaintext, or
// not a database.
export class KeyMismatchError extends Error {
  constructor(readonly path: string) {
    super(`${path} can't be opened with the tenant's key: it is encrypted under another key, not encrypted, or not a database`);
    this.name = "KeyMismatchError";
  }
}

const isNotADatabase = (e: unknown) => (e as { code?: string } | null)?.code === "SQLITE_NOTADB";

// `x'<64 hex digits>'`, SQLite3MultipleCiphers' raw-key form, as bytes.
function rawKeyLiteral(key: Uint8Array): Uint8Array {
  if (key.length !== KEY_BYTES) throw new Error(`a database key is ${KEY_BYTES} bytes, got ${key.length}`);
  const digits = "0123456789abcdef";
  const out = new Uint8Array(3 + key.length * 2);
  out[0] = 0x78; // x
  out[1] = out[out.length - 1] = 0x27; // '
  for (let i = 0; i < key.length; i++) {
    out[2 + 2 * i] = digits.charCodeAt(key[i]! >> 4);
    out[3 + 2 * i] = digits.charCodeAt(key[i]! & 15);
  }
  return out;
}

// Give `db` the key, with `set` (key, or rekey to encrypt a plaintext file), the hex wiped
// after. The cipher is chosen before anything reads the file: once a connection has read
// it, SQLite3MultipleCiphers refuses a rekey.
function applyKey(db: Native, key: Uint8Array, set: "key" | "rekey"): void {
  const literal = rawKeyLiteral(key);
  try {
    db[set](Buffer.from(literal.buffer, literal.byteOffset, literal.byteLength));
  } finally {
    literal.fill(0);
  }
}

// What encryptInPlace found: a plaintext file, now encrypted under the key; a file that
// isn't plaintext (left alone: opening it with the key is what checks it); or no file yet.
export type EncryptResult = "encrypted" | "not-plaintext" | "no-file";

// Encrypt a plaintext database file in place under `key`, its -wal checkpointed into it
// first. Run before anything else opens the file. A file that isn't plaintext SQLite is
// left as it is.
export function encryptInPlace(path: string, key: Uint8Array): EncryptResult {
  if (path === ":memory:" || !existsSync(path) || statSync(path).size === 0) return "no-file";
  const db = new NativeDatabase(path, { readonly: false, fileMustExist: true, timeout: 0 });
  try {
    db.exec(`PRAGMA cipher = '${CIPHER}'`);
    try {
      db.prepare("SELECT count(*) FROM sqlite_master").get();
    } catch (e) {
      if (isNotADatabase(e)) return "not-plaintext";
      throw e;
    }
    const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | undefined;
    if (r?.busy) throw new Error(`${path} is in use (its checkpoint was blocked), so it can't be encrypted: stop whatever has it open, then start again`);
    // A rekey rewrites every page; SQLite3MultipleCiphers does it only outside WAL, so the
    // file leaves WAL for it and goes back after.
    const mode = (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
    if (mode === "wal") db.exec("PRAGMA journal_mode = DELETE");
    applyKey(db, key, "rekey");
    if (mode === "wal") db.exec("PRAGMA journal_mode = WAL");
    return "encrypted";
  } finally {
    db.close();
  }
}

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
    try {
      if (opts.key) {
        // The key is the connection's first statement; reading the schema proves it opens the file.
        this.db.exec(`PRAGMA cipher = '${CIPHER}'`);
        applyKey(this.db, opts.key, "key");
        try {
          this.db.prepare("SELECT count(*) FROM sqlite_master").get();
        } catch (e) {
          throw isNotADatabase(e) ? new KeyMismatchError(path) : e;
        }
      }
      for (const p of CONNECTION_PRAGMAS) this.db.exec(p);
    } catch (e) {
      this.db.close();
      throw e;
    }
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
