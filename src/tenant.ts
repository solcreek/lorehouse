// tenant.ts — who this install's data belongs to, and where it lives (ADR 0005 §1).
//
// A tenant is one customer organization. Its content lives in files of its own, and its
// id is part of every path, sandbox id and log line, in a single-tenant install too: a
// single-tenant install is the case with one tenant. The layout:
//
//   <data>/settings.json             the install's settings (settings.ts), not the tenant's
//   <data>/<tenant>/tenant.json      {"id": …}: the directory names its tenant
//   <data>/<tenant>/lorehouse.db     LOREHOUSE_DB, unless set (+ -wal, -shm)
//   <data>/<tenant>/sessions.db      SESSIONS_DB, unless set or LOREHOUSE_DB is
//
// <data> is LOREHOUSE_DATA_DIR, by default the directory LOREHOUSE_DB names (the working
// directory when that is unset too): where settings.json and the databases were before.
//
// The tenant id is TENANT_ID when set; one with no directory yet, in a data directory that
// holds another tenant's, is refused unless TENANT_NEW=1. Otherwise it is the one tenant directory found in
// <data>, and with none, a new id is made at the first start and kept as that directory's
// tenant.json. It is not derived from Slack: it stays the same when the Slack app is
// reinstalled, or another chat platform is added, and it is known before anything asks Slack.
//
// An install laid out as before (<data>/lorehouse.db, <data>/sessions.db) upgrades in place
// on its first start: each database is checkpointed where it is (its -wal emptied), then
// moves into its tenant's directory by hard link and rename, its -wal, -shm and -journal
// before it, the old path never missing; then both directories are fsynced. Nothing is
// copied.
// Each old path is left a symlink to the file's new place, so a version from before
// tenants, rolled back to, opens the same database; removing the links is a later,
// deliberate cleanup. A start that dies part-way finishes the move on the next one; a
// second start moves nothing. A LOREHOUSE_DB or SESSIONS_DB an operator set is used where
// it is and never moved.

import { createHash, randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { formatWithOptions } from "node:util";

type Env = Record<string, string | undefined>;

// A tenant id is safe as one path segment and inside a sandbox id (sandboxd takes up to 128
// of [A-Za-z0-9_.-], sandbox/host/src/vm.rs): lowercase letters, digits and inner hyphens, at
// most 32. Lowercase only, so two ids never name one directory on a case-insensitive disk;
// no dot, so never "." or "..", and the first dot in a sandbox id always ends the tenant.
export const TENANT_ID_RULE = "1–32 lowercase letters, digits or inner hyphens";
const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const validTenantId = (id: string): boolean => TENANT_ID.test(id);

// A new id: "t-" and 12 random base32 characters (60 bits).
export function newTenantId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  return "t-" + Array.from(randomBytes(12), (b) => alphabet[b & 31]).join("");
}

// Where the install keeps its files: LOREHOUSE_DATA_DIR, or the directory LOREHOUSE_DB
// names, as before tenants (settings.json was beside the database). Absolute.
export function dataDirOf(env: Env): string {
  return resolve(env.LOREHOUSE_DATA_DIR || dirname(resolve(env.LOREHOUSE_DB || "lorehouse.db")));
}

const MARKER = "tenant.json";

// The tenant directories in `dataDir`: those whose tenant.json names the directory itself.
// Read-only; a missing or unreadable data directory has none.
export function tenantsIn(dataDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return [];
  }
  return names.filter((name) => {
    if (!validTenantId(name)) return false;
    try {
      return (JSON.parse(readFileSync(join(dataDir, name, MARKER), "utf8")) as { id?: unknown }).id === name;
    } catch {
      return false;
    }
  }).sort();
}

// Where the tenant id came from:
//   configured  TENANT_ID
//   found       the one tenant directory in the data directory
//   new         none yet: this id becomes the tenant's at the first start (prepareTenant)
//   throwaway   LOREHOUSE_DB in memory: an id for this process only, nothing kept
export type TenantSource = "configured" | "found" | "new" | "throwaway";
export type Tenant = { id: string; source: TenantSource; dataDir: string; dir: string };

// The tenant this environment runs as, without writing anything. A problem (an invalid
// TENANT_ID, several tenants and none chosen) is returned as loadConfig words them.
export function resolveTenant(env: Env): Tenant | { problem: string } {
  const dataDir = dataDirOf(env);
  const at = (id: string, source: TenantSource): Tenant => ({ id, source, dataDir, dir: join(dataDir, id) });
  if (env.TENANT_ID) {
    const id = env.TENANT_ID;
    if (!validTenantId(id)) return { problem: `TENANT_ID (${TENANT_ID_RULE}; got ${JSON.stringify(id)})` };
    // A TENANT_ID new to a data directory that holds another tenant would start on empty
    // data beside it, quietly (a TENANT_ID changed on an install that made its own id):
    // refused, unless TENANT_NEW=1 asks for a new tenant there.
    const others = env.LOREHOUSE_DB === ":memory:" || existsSync(join(dataDir, id, MARKER)) ? [] : tenantsIn(dataDir).filter((t) => t !== id);
    if (others.length && env.TENANT_NEW !== "1") {
      return { problem: `TENANT_ID (${id} has no directory in ${dataDir} yet, and ${dataDir} holds tenant ${others.join(", ")}: unset TENANT_ID to serve ${others.length === 1 ? others[0] : "one of them"}, or set TENANT_NEW=1 to start ${id}, empty, beside it)` };
    }
    return at(id, "configured");
  }
  if (env.LOREHOUSE_DB === ":memory:") return at(newTenantId(), "throwaway");
  const found = tenantsIn(dataDir);
  if (found.length > 1) return { problem: `TENANT_ID (${dataDir} holds ${found.length} tenants, ${found.join(", ")}: set TENANT_ID to the one to serve)` };
  return found.length ? at(found[0]!, "found") : at(newTenantId(), "new");
}

// fsync a directory, so the names just created or renamed in it survive a crash.
function syncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Makes the tenant's directory and its tenant.json, if missing: the file written to a temp
// name, fsynced and renamed in, then the directories fsynced. Returns whether it made it.
// Nothing for a throwaway tenant.
export function prepareTenant(tenant: Tenant): boolean {
  if (tenant.source === "throwaway") return false;
  const marker = join(tenant.dir, MARKER);
  if (existsSync(marker)) return false;
  mkdirSync(tenant.dir, { recursive: true, mode: 0o700 });
  const tmp = `${marker}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ id: tenant.id, created: new Date().toISOString() }) + "\n");
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, marker);
  syncDir(tenant.dir);
  syncDir(tenant.dataDir);
  return true;
}

// A database's files besides itself. Moved after it: SQLite won't open a database whose
// -wal is a symlink, so the old path's side files stay real files until the database's old
// path is a symlink (SQLite then uses the side files beside the file it points at).
const SIDE_FILES = ["-wal", "-shm", "-journal"];

// One database to move from the old layout into the tenant's directory.
export type Move = { from: string; to: string };

export class UpgradeError extends Error {}

// Where a file being moved stands, by what is at its old path (never followed):
//   file   a real file: still to move, or its move under way (a hard link of it at `to`)
//   moved  a symlink to its place in the tenant's directory: moved (dangling is fine for a
//          side file: SQLite removes a -wal on close, and makes it again beside the target)
//   other  a symlink anywhere else: not ours to touch
//   none   nothing
type Standing = "file" | "moved" | "other" | "none";
function standing(from: string, to: string): Standing {
  let st;
  try {
    st = lstatSync(from);
  } catch {
    return "none";
  }
  if (!st.isSymbolicLink()) return "file";
  return resolve(dirname(from), readlinkSync(from)) === resolve(to) ? "moved" : "other";
}
const lexists = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
// Two names of one file: what `to` is while a move is under way (link(from, to), not yet
// the symlink over `from`).
function sameFile(a: string, b: string): boolean {
  try {
    const x = lstatSync(a), y = lstatSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}
// The symlink made beside the old path, then renamed over it once the file has its new name.
const linkTemp = (from: string) => `${from}.tenant-link`;

// Before anything moves, the database at its old path is checkpointed and its -wal
// emptied, so it is complete by itself and normally only the database file moves; a -wal
// that still holds frames afterwards means something else has it open.
function checkpointAt(path: string): void {
  let db: Database | undefined;
  try {
    db = new Database(path, { readwrite: true, create: false });
    db.query("SELECT COUNT(*) FROM sqlite_master").get(); // a hot -journal is rolled back here
    const r = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number } | null;
    if (r?.busy) throw new UpgradeError(`${path} is in use (its checkpoint was blocked): stop whatever has it open, then start again`);
  } catch (e) {
    if (e instanceof UpgradeError) throw e;
    throw new UpgradeError(`can't checkpoint ${path} before moving it: ${e instanceof Error ? e.message : e}`);
  } finally {
    db?.close();
  }
  const wal = `${path}-wal`;
  if (existsSync(wal) && statSync(wal).size > 0) throw new UpgradeError(`${wal} still holds frames after a checkpoint: stop whatever has ${path} open, then start again`);
}

// A side file that is no longer any database's own, renamed aside: never deleted, never
// used. At the new place, before the database moves: once it is checkpointed at the old
// path, the database is complete without it, and a -wal there would be replayed over newer
// pages (a start that died mid-move, then a rollback that wrote without it). At the old
// path, once the database has moved and the new place has its own: SQLite uses that one.
function setAside(path: string): string {
  const aside = `${path}.stale-${Date.now()}`;
  renameSync(path, aside);
  return aside;
}

// One file: a symlink to its new place made beside the old path, a hard link of the file
// at the new place (unless it is there already: a move under way), then the symlink
// renamed over the old path. The old path is never missing (a version from before tenants
// always finds the file there), and nothing is copied. A start that died between the two
// finds the old path still a real file, the same file as the one at `to`, and finishes.
function linkOver(from: string, to: string): void {
  const tmp = linkTemp(from);
  rmSync(tmp, { force: true });
  symlinkSync(relative(dirname(from), to), tmp);
  try {
    if (!lexists(to)) linkSync(from, to);
  } catch (e) {
    rmSync(tmp, { force: true });
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EXDEV") throw new UpgradeError(`${from} and ${dirname(to)} are on different filesystems: it can't be moved by name, and it is never copied. Move it yourself with the app stopped, or set LOREHOUSE_DB to where it is`);
    if (code === "EPERM" || code === "ENOTSUP") throw new UpgradeError(`${dirname(to)}'s filesystem doesn't take hard links (${code}): move ${from} yourself with the app stopped, or set LOREHOUSE_DB to where it is`);
    throw e;
  }
  renameSync(tmp, from);
}

const otherLink = (from: string, to: string) => new UpgradeError(`${from} is a symlink, not to ${to}: move the file it points at yourself with the app stopped, or set LOREHOUSE_DB to where it is`);

// Moves each database still at its old place into the tenant's directory, and leaves at
// each old path a symlink to the file's new place; then fsyncs both directories:
//   1. the database is checkpointed at its old path, so its -wal is empty and it is
//      complete by itself;
//   2. side files at the new place that aren't the old path's own are set aside;
//   3. the database moves (linkOver), then its side files.
// Nothing is copied. The symlinks keep a version from before tenants working: it still
// names the old paths, and SQLite opens the file a symlink points at (its -wal and -shm go
// beside that), so a rollback finds the same database, and a later start finds every file
// moved already. Refuses, moving nothing more, where the tenant's directory already has
// another database by that name (two copies: an operator decides which is the data), or
// the move would cross filesystems. Returns what moved, as "lorehouse.db (+ -wal, -shm)",
// and any stale side file set aside. Run before either database is opened.
export function upgradeLayout(moves: Move[]): string[] {
  const moved: string[] = [];
  const dirs = new Set<string>();
  for (const { from, to } of moves) {
    const main = standing(from, to);
    if (main === "none") continue; // a new install
    if (main === "other") throw otherLink(from, to);
    const aside: string[] = [];
    let itself = false;
    if (main === "file") {
      if (lexists(to) && !sameFile(from, to)) throw new UpgradeError(`both ${from} and ${to} exist: keep the one that holds the data (stop the app, move or remove the other), then start again`);
      checkpointAt(from);
      mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
      for (const s of SIDE_FILES) if (lexists(to + s) && !sameFile(from + s, to + s)) aside.push(setAside(to + s));
      linkOver(from, to);
      itself = true;
    } else {
      // The database's own link left dangling (its file gone, by hand or a bad restore):
      // opening it would make an empty database there, silently.
      if (!lexists(to)) throw new UpgradeError(`${from} is a symlink to ${to}, which doesn't exist: put the database back there (or the link's target back at ${from}), then start again`);
      rmSync(linkTemp(from), { force: true });
    }
    const sides: string[] = [];
    for (const s of SIDE_FILES) {
      const now = standing(from + s, to + s);
      if (now === "other") throw otherLink(from + s, to + s);
      if (now !== "file") {
        rmSync(linkTemp(from + s), { force: true });
        continue;
      }
      if (lexists(to + s) && !sameFile(from + s, to + s)) aside.push(setAside(from + s));
      else {
        linkOver(from + s, to + s);
        sides.push(s);
      }
    }
    if (itself || sides.length || aside.length) dirs.add(dirname(from)).add(dirname(to));
    if (itself || sides.length) moved.push(basename(to) + (sides.length ? ` (+ ${sides.join(", ")})` : ""));
    for (const x of aside) moved.push(`a stale ${basename(x).replace(/\.stale-\d+$/, "")} set aside as ${x}`);
  }
  for (const dir of dirs) syncDir(dir);
  return moved;
}

// What the next start would do with one database, by upgradeLayout's own rules, without
// doing it (for the doctor):
//   pending    still to move
//   under-way  a move a start began: the next one finishes it (the database at its new
//              place already, as the same file or with the old path a link to it, and
//              something left to do)
//   done       nothing to do (moved, or a new install)
// `refusal`: why the start would refuse instead. `setAside`: the side files it would rename
// aside (setAside): at the new place, those that aren't the old path's own, while the
// database is still to move; at the old place, those whose new place has its own, once the
// database has moved.
export type MovePlan = { state: "pending" | "under-way" | "done"; refusal?: string; setAside?: string[] };
export function planMove({ from, to }: Move): MovePlan {
  const main = standing(from, to);
  if (main === "other") return { state: "done", refusal: otherLink(from, to).message };
  if (main === "none") return { state: "done" };
  const sideOther = SIDE_FILES.find((s) => standing(from + s, to + s) === "other");
  if (sideOther) return { state: main === "file" ? "pending" : "under-way", refusal: otherLink(from + sideOther, to + sideOther).message };
  if (main === "file") {
    if (lexists(to) && !sameFile(from, to)) return { state: "pending", refusal: `both ${from} and ${to} exist: keep the one that holds the data (stop the app, move or remove the other), then start again` };
    const aside = SIDE_FILES.filter((s) => lexists(to + s) && !sameFile(from + s, to + s)).map((s) => to + s);
    return { state: lexists(to) || lexists(linkTemp(from)) ? "under-way" : "pending", ...(aside.length ? { setAside: aside } : {}) };
  }
  if (!lexists(to)) return { state: "done", refusal: `${from} is a symlink to ${to}, which doesn't exist: put the database back there (or the link's target back at ${from}), then start again` };
  const left = SIDE_FILES.some((s) => standing(from + s, to + s) === "file" || lexists(linkTemp(from + s))) || lexists(linkTemp(from));
  const aside = SIDE_FILES.filter((s) => standing(from + s, to + s) === "file" && lexists(to + s) && !sameFile(from + s, to + s)).map((s) => from + s);
  return { state: left ? "under-way" : "done", ...(aside.length ? { setAside: aside } : {}) };
}

// The databases still to move, for the doctor: those whose old path is a real file.
export function pendingMoves(moves: Move[]): Move[] {
  return moves.filter((m) => standing(m.from, m.to) === "file");
}

// A sandbox id for one thread of this tenant: "<tenant>.<session>", the session's
// characters outside [A-Za-z0-9_.-] as "_". The tenant has no dot, so the first dot ends
// it. Past sandboxd's 128 characters the session part is cut and a hash of the whole
// session added, so two long sessions never share a sandbox.
export const SANDBOX_ID_MAX = 128;
export function sandboxIdFor(tenant: string, sessionId: string): string {
  const id = `${tenant}.${sessionId.replace(/[^\w.-]/g, "_")}`;
  if (id.length <= SANDBOX_ID_MAX) return id;
  const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${id.slice(0, SANDBOX_ID_MAX - hash.length - 1)}-${hash}`;
}

// Every line the process logs starts with its tenant: what console.log, info, warn, error
// and debug print is rendered as they would (util.format: an Error as its stack, an object
// inspected), and each rendered line, not only the first, gets "tenant=<id> " in front.
// Installed once, by the serve command (server.ts); a second call changes the id. Returns
// what puts the console back.
const ORIGINAL = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
export function logAsTenant(id: string): () => void {
  const prefix = `tenant=${id}`;
  const keys = Object.keys(ORIGINAL) as (keyof typeof ORIGINAL)[];
  for (const k of keys) {
    const write = ORIGINAL[k];
    console[k] = (...args: unknown[]) => write.call(console, formatWithOptions({ colors: false }, ...args).split("\n").map((line) => `${prefix} ${line}`).join("\n"));
  }
  return () => {
    for (const k of keys) console[k] = ORIGINAL[k];
  };
}
