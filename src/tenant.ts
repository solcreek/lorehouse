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
// The tenant id is TENANT_ID when set. Otherwise it is the one tenant directory found in
// <data>, and with none, a new id is made at the first start and kept as that directory's
// tenant.json. It is not derived from Slack: it stays the same when the Slack app is
// reinstalled, or another chat platform is added, and it is known before anything asks Slack.
//
// An install laid out as before (<data>/lorehouse.db, <data>/sessions.db) upgrades in place
// on its first start: each database moves into its tenant's directory by rename(2), its
// -wal, -shm and -journal before it, then both directories are fsynced. Nothing is copied.
// Each old path is left a symlink to the file's new place, so a version from before
// tenants, rolled back to, opens the same database; removing the links is a later,
// deliberate cleanup. A start that dies part-way finishes the move on the next one; a
// second start moves nothing. A LOREHOUSE_DB or SESSIONS_DB an operator set is used where
// it is and never moved.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

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
    return validTenantId(env.TENANT_ID) ? at(env.TENANT_ID, "configured") : { problem: `TENANT_ID (${TENANT_ID_RULE}; got ${JSON.stringify(env.TENANT_ID)})` };
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

// A database's files besides itself. Moved before it: until the database itself has moved,
// the old place is the one to finish from, and a database never arrives without its WAL.
const SIDE_FILES = ["-wal", "-shm", "-journal"];

// One database to move from the old layout into the tenant's directory.
export type Move = { from: string; to: string };

export class UpgradeError extends Error {}

// Where a file being moved stands, by what is at its old path (never followed):
//   file   a real file: still to move
//   moved  a symlink to its place in the tenant's directory: moved (dangling is fine:
//          SQLite removes a -wal on close, and makes it again beside the target)
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
// The link made beside the old path before the rename, then renamed over it: until that
// last rename, its being there says a move of this file is under way.
const linkTemp = (from: string) => `${from}.tenant-link`;

// One file: a symlink to its new place made beside it, the file renamed into the tenant's
// directory, then the symlink renamed onto the old path. The old path is never a missing
// file except between those two renames, and a start that died there finds the temp link
// and finishes. Returns whether this start moved it.
function moveOne(from: string, to: string): boolean {
  const tmp = linkTemp(from);
  const now = standing(from, to);
  if (now === "moved") {
    rmSync(tmp, { force: true });
    return false;
  }
  if (now === "other") throw new UpgradeError(`${from} is a symlink, not to ${to}: move the file it points at yourself with the app stopped, or set LOREHOUSE_DB to where it is`);
  if (now === "none") {
    if (!lexists(tmp)) return false;
    if (!lexists(to)) {
      rmSync(tmp, { force: true }); // a link made, nothing renamed: nothing to finish
      return false;
    }
    renameSync(tmp, from); // died between the renames: finish
    return true;
  }
  rmSync(tmp, { force: true });
  symlinkSync(relative(dirname(from), to), tmp);
  try {
    renameSync(from, to);
  } catch (e) {
    rmSync(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code === "EXDEV") throw new UpgradeError(`${from} and ${dirname(to)} are on different filesystems: a rename can't move it, and it is never copied. Move it yourself with the app stopped, or set LOREHOUSE_DB to where it is`);
    throw e;
  }
  renameSync(tmp, from);
  return true;
}

// Moves each database still at its old place, with its side files, by rename only, and
// leaves at each old path a symlink to the file's new place; then fsyncs both directories.
// The symlinks keep a version from before tenants working: it still names the old paths,
// and SQLite opens the file a symlink points at (its -wal and -shm go beside that), so a
// rollback finds the same database, and a later start finds every file moved already.
// Refuses, moving nothing more, where the tenant's directory already has a file by that
// name and the old path holds a real one (two copies: an operator decides which is the
// data), or the rename would cross filesystems (it would be a copy). Returns what moved, as
// "lorehouse.db (+ -wal, -shm)". Run before either database is opened.
export function upgradeLayout(moves: Move[]): string[] {
  const moved: string[] = [];
  const dirs = new Set<string>();
  for (const { from, to } of moves) {
    const main = standing(from, to);
    if (main === "moved" && !lexists(linkTemp(from))) continue; // moved already
    if (main === "none" && !lexists(linkTemp(from))) continue; // a new install
    if (main === "other") throw new UpgradeError(`${from} is a symlink, not to ${to}: move the file it points at yourself with the app stopped, or set LOREHOUSE_DB to where it is`);
    const files = [...SIDE_FILES, ""];
    for (const s of files) {
      if (standing(from + s, to + s) === "file" && lexists(to + s)) {
        throw new UpgradeError(s
          ? `both ${from + s} and ${to + s} exist: keep the one that belongs to ${from} (stop the app, move or remove the other), then start again`
          : `both ${from} and ${to} exist: keep the one that holds the data (stop the app, move or remove the other), then start again`);
      }
    }
    mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
    const sides = SIDE_FILES.filter((s) => moveOne(from + s, to + s));
    const itself = moveOne(from, to);
    dirs.add(dirname(from)).add(dirname(to));
    if (itself || sides.length) moved.push(basename(to) + (sides.length ? ` (+ ${sides.join(", ")})` : ""));
  }
  for (const dir of dirs) syncDir(dir);
  return moved;
}

// The databases still to move, for the doctor: those whose old path is a real file, or
// whose move is under way.
export function pendingMoves(moves: Move[]): Move[] {
  return moves.filter((m) => standing(m.from, m.to) === "file" || lexists(linkTemp(m.from)));
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

// Every line the process logs starts with its tenant: console.log, info, warn, error and
// debug each get "tenant=<id>" as their first word. Installed once, by the serve command
// (server.ts); a second call changes the id. Returns what puts the console back.
const ORIGINAL = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
export function logAsTenant(id: string): () => void {
  const prefix = `tenant=${id}`;
  const keys = Object.keys(ORIGINAL) as (keyof typeof ORIGINAL)[];
  for (const k of keys) {
    const write = ORIGINAL[k];
    console[k] = (...args: unknown[]) => write.call(console, prefix, ...args);
  }
  return () => {
    for (const k of keys) console[k] = ORIGINAL[k];
  };
}
