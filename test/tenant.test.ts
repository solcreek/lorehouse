// The tenant (ADR 0005 §1): its id in every path, sandbox id and log line, and an install
// laid out before tenants moved into its tenant's directory on the first start.

import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { closeKnowledge, countDocuments, openKnowledge } from "../src/knowledge";
import { settingsPath } from "../src/settings";
import { logAsTenant, newTenantId, pendingMoves, prepareTenant, resolveTenant, sandboxIdFor, SANDBOX_ID_MAX, tenantsIn, upgradeLayout, UpgradeError, validTenantId, type Tenant } from "../src/tenant";

const base = { SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "t", ANTHROPIC_API_KEY: "k" };
const dir = () => mkdtempSync(join(tmpdir(), "lorehouse-tenant-"));
const tenantOf = (env: Record<string, string>): Tenant => {
  const t = resolveTenant(env);
  if ("problem" in t) throw new Error(t.problem);
  return t;
};
// sandboxd's own rule (sandbox/host/src/vm.rs, valid_id).
const sandboxdTakes = (id: string) => id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_.-]+$/.test(id) && !id.startsWith(".");

describe("tenant ids", () => {
  test("safe as one path segment and inside a sandbox id: lowercase letters, digits, inner hyphens, at most 32", () => {
    for (const ok of ["a", "t-3f9k2abc", "acme", "acme-corp-2", "x".repeat(32)]) expect([ok, validTenantId(ok)]).toEqual([ok, true]);
    for (const bad of ["", ".", "..", "a/b", "a.b", "a_b", "Acme", "-a", "a-", "x".repeat(33), "a b", "é"]) expect([bad, validTenantId(bad)]).toEqual([bad, false]);
  });

  test("a new one is valid, and not the same twice", () => {
    const ids = new Set(Array.from({ length: 200 }, newTenantId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect([id, validTenantId(id), id.startsWith("t-")]).toEqual([id, true, true]);
  });

  test("TENANT_ID wins; an invalid one is a configuration problem", () => {
    expect(tenantOf({ TENANT_ID: "acme", LOREHOUSE_DATA_DIR: "/data" })).toEqual({ id: "acme", source: "configured", dataDir: "/data", dir: "/data/acme" });
    expect(resolveTenant({ TENANT_ID: "../etc" })).toEqual({ problem: expect.stringContaining('TENANT_ID (1–32 lowercase letters, digits or inner hyphens; got "../etc")') });
    expect(() => loadConfig({ ...base, TENANT_ID: "Acme" })).toThrow(/TENANT_ID \(1–32 lowercase/);
  });

  test("unset: the one tenant directory found, else a new id; several found and none chosen is a problem", () => {
    const d = dir();
    expect(tenantOf({ LOREHOUSE_DATA_DIR: d }).source).toBe("new");
    const t = tenantOf({ LOREHOUSE_DATA_DIR: d });
    expect(prepareTenant(t)).toBe(true);
    expect(prepareTenant(t)).toBe(false); // kept: made once
    expect(JSON.parse(readFileSync(join(d, t.id, "tenant.json"), "utf8")).id).toBe(t.id);
    expect(statSync(join(d, t.id)).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(d, t.id))).toEqual(["tenant.json"]); // no temp file left
    expect(tenantOf({ LOREHOUSE_DATA_DIR: d })).toEqual({ ...t, source: "found" });
    // A directory that doesn't name itself (no tenant.json, or another id in it) isn't one.
    mkdirSync(join(d, "t-stray"));
    mkdirSync(join(d, "t-other"));
    writeFileSync(join(d, "t-other", "tenant.json"), JSON.stringify({ id: "t-else" }));
    expect(tenantsIn(d)).toEqual([t.id]);
    prepareTenant({ ...t, id: "t-second", dir: join(d, "t-second") });
    expect(resolveTenant({ LOREHOUSE_DATA_DIR: d })).toEqual({ problem: expect.stringContaining(`holds 2 tenants, ${[t.id, "t-second"].sort().join(", ")}: set TENANT_ID`) });
    expect(tenantOf({ LOREHOUSE_DATA_DIR: d, TENANT_ID: "t-second" }).source).toBe("configured");
  });

  // A TENANT_ID changed on an install whose data is in another tenant's directory would
  // start on empty data, quietly: refused, unless TENANT_NEW=1 says that is the point.
  test("a TENANT_ID with no directory yet, beside another tenant's, is refused unless TENANT_NEW=1", () => {
    const d = dir();
    const old = tenantOf({ LOREHOUSE_DATA_DIR: d });
    prepareTenant(old);
    expect(resolveTenant({ LOREHOUSE_DATA_DIR: d, TENANT_ID: "acme" })).toEqual({ problem: `TENANT_ID (acme has no directory in ${d} yet, and ${d} holds tenant ${old.id}: unset TENANT_ID to serve ${old.id}, or set TENANT_NEW=1 to start acme, empty, beside it)` });
    expect(() => loadConfig({ ...base, LOREHOUSE_DATA_DIR: d, TENANT_ID: "acme" })).toThrow(/TENANT_ID \(acme has no directory/);
    expect(tenantOf({ LOREHOUSE_DATA_DIR: d, TENANT_ID: "acme", TENANT_NEW: "1" }).source).toBe("configured");
    expect(tenantOf({ LOREHOUSE_DATA_DIR: d, TENANT_ID: old.id }).source).toBe("configured");
    expect(() => loadConfig({ ...base, LOREHOUSE_DATA_DIR: d, TENANT_ID: "acme", TENANT_NEW: "yes" })).toThrow(/TENANT_NEW \(1 to start/);
    // Once made, it is that tenant's directory: no override needed again.
    prepareTenant(tenantOf({ LOREHOUSE_DATA_DIR: d, TENANT_ID: "acme", TENANT_NEW: "1" }));
    expect(tenantOf({ LOREHOUSE_DATA_DIR: d, TENANT_ID: "acme" }).source).toBe("configured");
  });

  test("LOREHOUSE_DB in memory: an id for this process, nothing kept", () => {
    const t = tenantOf({ LOREHOUSE_DB: ":memory:" });
    expect(t.source).toBe("throwaway");
    expect(prepareTenant(t)).toBe(false);
    expect(existsSync(t.dir)).toBe(false);
  });
});

describe("where the files go", () => {
  test("unset, both databases in <data>/<tenant>/, settings.json in <data>", () => {
    const c = loadConfig({ ...base, LOREHOUSE_DATA_DIR: "/data", TENANT_ID: "acme" });
    expect(c.db).toMatchObject({ lorehouse: "/data/acme/lorehouse.db", sessions: "/data/acme/sessions.db" });
    expect(c.db.upgrade).toEqual([{ from: "/data/lorehouse.db", to: "/data/acme/lorehouse.db" }, { from: "/data/sessions.db", to: "/data/acme/sessions.db" }]);
    expect(settingsPath({ LOREHOUSE_DATA_DIR: "/data" })).toBe("/data/settings.json");
  });

  test("the data directory is, by default, where LOREHOUSE_DB was: settings.json stays where it was", () => {
    expect(loadConfig({ ...base, LOREHOUSE_DB: "/data/lorehouse.db", TENANT_ID: "acme" }).tenant.dataDir).toBe("/data");
    expect(settingsPath({ LOREHOUSE_DB: "/data/lorehouse.db" })).toBe("/data/settings.json");
  });

  test("a LOREHOUSE_DB or SESSIONS_DB set is used where it is, and never moved", () => {
    const explicit = loadConfig({ ...base, LOREHOUSE_DB: "/data/lorehouse.db", TENANT_ID: "acme" });
    expect(explicit.db).toMatchObject({ lorehouse: "/data/lorehouse.db", sessions: "/data/sessions.db", upgrade: [] });
    const sessions = loadConfig({ ...base, LOREHOUSE_DATA_DIR: "/data", SESSIONS_DB: "/state/june.db", TENANT_ID: "acme" });
    expect(sessions.db).toMatchObject({ lorehouse: "/data/acme/lorehouse.db", sessions: "/state/june.db", upgrade: [{ from: "/data/lorehouse.db", to: "/data/acme/lorehouse.db" }] });
    expect(loadConfig({ ...base, LOREHOUSE_DB: ":memory:" }).db).toMatchObject({ lorehouse: ":memory:", sessions: ":memory:", upgrade: [] });
  });
});

// A process that writes rows in WAL mode and is killed (SIGKILL) before any checkpoint:
// the rows are only in `path`-wal, which is what a stop that couldn't checkpoint leaves.
async function killedWriter(path: string, rows: number): Promise<void> {
  const code = `
    const { Database } = require("bun:sqlite");
    const db = new Database(${JSON.stringify(path)});
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA wal_autocheckpoint = 0");
    db.exec("CREATE TABLE IF NOT EXISTS walrows (n INTEGER, word TEXT)");
    for (let i = 0; i < ${rows}; i++) db.query("INSERT INTO walrows VALUES (?, 'onlyinthewal')").run(i);
    console.log("written");
    setInterval(() => {}, 1000);`;
  const proc = Bun.spawn(["bun", "-e", code], { stdout: "pipe", stderr: "inherit" });
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("written");
  proc.kill("SIGKILL");
  await proc.exited;
}

const holds = (file: string, word: string) => existsSync(file) && readFileSync(file).toString("latin1").includes(word);

describe("an install laid out before tenants upgrades in place", () => {
  // Today's layout: <data>/lorehouse.db with knowledge in it, <data>/sessions.db, both with
  // a -wal holding writes no checkpoint reached, and settings.json beside them.
  async function todaysLayout(): Promise<string> {
    const d = dir();
    // Made by another process, as the app before this one did: a connection this process
    // had opened on the old path would still be in SQLite's per-file state, which macOS's
    // SQLite refuses once the file is renamed (SQLITE_IOERR_VNODE). A start never opens a
    // database before it moves it.
    const knowledge = JSON.stringify(join(import.meta.dir, "../src/knowledge.ts"));
    const made = Bun.spawnSync(["bun", "-e", `const k = require(${knowledge}); const db = k.openKnowledge(${JSON.stringify(join(d, "lorehouse.db"))}); k.upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "https://x/p11", title: "#c1", text: "the wombat review is on Thursday" }); k.closeKnowledge(db);`], { stderr: "inherit" });
    expect(made.exitCode).toBe(0);
    await killedWriter(join(d, "lorehouse.db"), 25);
    await killedWriter(join(d, "sessions.db"), 7);
    writeFileSync(join(d, "settings.json"), "{}\n");
    for (const f of ["lorehouse.db-wal", "lorehouse.db-shm", "sessions.db-wal", "sessions.db-shm"]) expect([f, existsSync(join(d, f))]).toEqual([f, true]);
    // What proves the -wal moved: these rows are in it, and not in the database file.
    expect(holds(join(d, "lorehouse.db-wal"), "onlyinthewal")).toBe(true);
    expect(holds(join(d, "lorehouse.db"), "onlyinthewal")).toBe(false);
    return d;
  }
  // Read in a process of its own, as the next start would: this one then never holds
  // SQLite state for a file a later step renames. Its close may checkpoint the WAL and
  // remove the side files (Linux's SQLite does), so what a later start moves is whatever is
  // there then (movedLabel).
  const rows = (path: string) => {
    const r = Bun.spawnSync(["bun", "-e", `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(path)}, { readwrite: true, create: false }); console.log(db.query("SELECT COUNT(*) AS n FROM walrows").get().n); db.close();`], { stderr: "inherit" });
    return Number(r.stdout.toString().trim());
  };
  // What upgradeLayout reports moving for `name` in `d`, from the side files there now.
  const movedLabel = (d: string, name: string) => {
    const sides = ["-wal", "-shm", "-journal"].filter((s) => existsSync(join(d, name + s)));
    return name + (sides.length ? ` (+ ${sides.join(", ")})` : "");
  };
  // A start, as far as storage goes: the tenant resolved and made, then the upgrade.
  const start = (d: string) => {
    const config = loadConfig({ ...base, LOREHOUSE_DATA_DIR: d });
    prepareTenant(config.tenant);
    return { config, moved: upgradeLayout(config.db.upgrade) };
  };

  test("its files move into the tenant's directory, -wal and -shm with them, intact; a second start moves nothing", async () => {
    const d = await todaysLayout();
    const { config, moved } = start(d);
    const t = config.tenant.dir;
    expect(moved).toEqual(["lorehouse.db (+ -wal, -shm)", "sessions.db (+ -wal, -shm)"]);
    const FILES = ["lorehouse.db", "lorehouse.db-shm", "lorehouse.db-wal", "sessions.db", "sessions.db-shm", "sessions.db-wal"];
    expect(readdirSync(t).sort()).toEqual([...FILES, "tenant.json"]);
    // Each old path is now a symlink to the file's new place, relative to the data directory.
    expect(readdirSync(d).sort()).toEqual([...FILES, config.tenant.id, "settings.json"].sort());
    for (const f of FILES) expect([f, lstatSync(join(d, f)).isSymbolicLink(), readlinkSync(join(d, f))]).toEqual([f, true, `${config.tenant.id}/${f}`]);
    // The writes only the WAL held are there: the -wal came along.
    expect(rows(join(t, "lorehouse.db"))).toBe(25);
    expect(rows(join(t, "sessions.db"))).toBe(7);
    const k = openKnowledge(config.db.lorehouse);
    expect(countDocuments(k)).toBe(1);
    closeKnowledge(k);
    // Idempotent: the same tenant is found, and nothing is left to move.
    const again = start(d);
    expect(again.config.tenant).toEqual({ ...config.tenant, source: "found" });
    expect(again.moved).toEqual([]);
    expect(pendingMoves(config.db.upgrade)).toEqual([]);
    expect(rows(join(t, "lorehouse.db"))).toBe(25);
  });

  // Rolling back: a version from before tenants still names <data>/lorehouse.db and
  // <data>/sessions.db. Through the symlinks it opens the same files, and SQLite puts
  // their -wal and -shm beside the files themselves, in the tenant's directory.
  test("after the move, the old paths open the same databases: reads and writes land in the tenant's files, the WAL beside them", async () => {
    const d = await todaysLayout();
    const { config } = start(d);
    const t = config.tenant.dir;
    // A process holding the old path open, writing without a checkpoint, while another
    // reads the new path: both see one database.
    await killedWriter(join(d, "lorehouse.db"), 5);
    // Its writes are in the WAL beside the target (a read's close may checkpoint it after).
    expect(lstatSync(join(t, "lorehouse.db-wal")).isFile()).toBe(true);
    expect(statSync(join(t, "lorehouse.db-wal")).size).toBeGreaterThan(0);
    expect(rows(join(t, "lorehouse.db"))).toBe(30);
    expect(rows(join(d, "lorehouse.db"))).toBe(30);
    // Nothing real appeared at the old place: every name there is still a link.
    for (const f of readdirSync(d).filter((f) => f.startsWith("lorehouse.db") || f.startsWith("sessions.db"))) expect([f, lstatSync(join(d, f)).isSymbolicLink()]).toEqual([f, true]);
  });

  test("a rollback (the old path opened, written, closed) then a roll forward: the start succeeds, moves nothing, and has the write", async () => {
    const d = await todaysLayout();
    const { config } = start(d);
    // The old version: open the old path, write, close (its close may checkpoint and
    // remove the -wal, leaving the link to it dangling).
    const r = Bun.spawnSync(["bun", "-e", `const { Database } = require("bun:sqlite"); const db = new Database(${JSON.stringify(join(d, "lorehouse.db"))}); db.exec("PRAGMA journal_mode = WAL"); db.query("INSERT INTO walrows VALUES (99, 'rolledback')").run(); db.close();`], { stderr: "inherit" });
    expect(r.exitCode).toBe(0);
    const forward = start(d);
    expect(forward.config.tenant.id).toBe(config.tenant.id);
    expect(forward.moved).toEqual([]);
    expect(rows(forward.config.db.lorehouse)).toBe(26);
    expect(pendingMoves(forward.config.db.upgrade)).toEqual([]);
  });

  test("a start that died between moving a file and linking it finishes on the next: the link made, nothing refused", async () => {
    const d = await todaysLayout();
    const config = loadConfig({ ...base, LOREHOUSE_DATA_DIR: d });
    prepareTenant(config.tenant);
    // As moveOne leaves it when it dies after the rename: the temp link beside the old
    // path, the file already in the tenant's directory.
    symlinkSync(`${config.tenant.id}/lorehouse.db`, join(d, "lorehouse.db.tenant-link"));
    renameSync(join(d, "lorehouse.db"), config.db.lorehouse);
    expect(pendingMoves(config.db.upgrade).map((m) => m.from)).toEqual([join(d, "lorehouse.db"), join(d, "sessions.db")]);
    expect(upgradeLayout(config.db.upgrade)).toEqual(["lorehouse.db (+ -wal, -shm)", "sessions.db (+ -wal, -shm)"]);
    expect(readlinkSync(join(d, "lorehouse.db"))).toBe(`${config.tenant.id}/lorehouse.db`);
    expect(existsSync(join(d, "lorehouse.db.tenant-link"))).toBe(false);
    expect(rows(config.db.lorehouse)).toBe(25);
    expect(upgradeLayout(config.db.upgrade)).toEqual([]);
  });

  test("an old path that is a symlink to somewhere else is refused, never followed or moved", async () => {
    const d = await todaysLayout();
    const config = loadConfig({ ...base, LOREHOUSE_DATA_DIR: d });
    prepareTenant(config.tenant);
    renameSync(join(d, "sessions.db"), join(d, "elsewhere.db"));
    symlinkSync("elsewhere.db", join(d, "sessions.db"));
    expect(() => upgradeLayout(config.db.upgrade)).toThrow(/sessions\.db is a symlink, not to /);
    expect(existsSync(join(d, "elsewhere.db"))).toBe(true);
  });

  test("a start that died part-way (the -wal moved, the database not yet) finishes the move", async () => {
    const d = await todaysLayout();
    const config = loadConfig({ ...base, LOREHOUSE_DATA_DIR: d });
    prepareTenant(config.tenant);
    renameSync(join(d, "lorehouse.db-wal"), join(config.tenant.dir, "lorehouse.db-wal"));
    expect(upgradeLayout(config.db.upgrade)).toEqual(["lorehouse.db (+ -shm)", "sessions.db (+ -wal, -shm)"]);
    expect(rows(config.db.lorehouse)).toBe(25);
  });

  test("a database already in the tenant's directory and at the old place is refused, and nothing moves", async () => {
    const d = await todaysLayout();
    const config = loadConfig({ ...base, LOREHOUSE_DATA_DIR: d });
    prepareTenant(config.tenant);
    writeFileSync(config.db.lorehouse, "");
    expect(() => upgradeLayout(config.db.upgrade)).toThrow(UpgradeError);
    expect(() => upgradeLayout(config.db.upgrade)).toThrow(/both .*lorehouse\.db and .*lorehouse\.db exist/);
    expect(existsSync(join(d, "lorehouse.db-wal"))).toBe(true);
    expect(existsSync(join(d, "sessions.db"))).toBe(true);
  });

  test("a LOREHOUSE_DB set stays where it is", async () => {
    const d = await todaysLayout();
    const config = loadConfig({ ...base, LOREHOUSE_DB: join(d, "lorehouse.db") });
    prepareTenant(config.tenant);
    expect(upgradeLayout(config.db.upgrade)).toEqual([]);
    expect(rows(join(d, "lorehouse.db"))).toBe(25);
    expect(config.db.sessions).toBe(join(d, "sessions.db"));
    // Its tenant is kept in the data directory all the same, and found by a later start
    // that unsets LOREHOUSE_DB: that one moves the files.
    expect(tenantsIn(d)).toEqual([config.tenant.id]);
    const sides = ["-wal", "-shm", "-journal"].flatMap((s) => ["lorehouse.db", "sessions.db"].map((f) => f + s)).filter((f) => existsSync(join(d, f)));
    const want = [movedLabel(d, "lorehouse.db"), movedLabel(d, "sessions.db")];
    const later = start(d);
    expect(later.config.tenant.id).toBe(config.tenant.id);
    expect(later.moved).toEqual(want);
    // Each side file that was there moved with its database, and none appeared from nowhere.
    for (const f of sides) expect([f, existsSync(join(later.config.tenant.dir, f))]).toEqual([f, true]);
    for (const f of ["-wal", "-shm", "-journal"].flatMap((s) => ["lorehouse.db", "sessions.db"].map((x) => x + s))) {
      if (!sides.includes(f)) expect([f, existsSync(join(later.config.tenant.dir, f))]).toEqual([f, false]);
    }
    expect(rows(later.config.db.lorehouse)).toBe(25);
    expect(rows(later.config.db.sessions)).toBe(7);
  });
});

describe("sandbox ids", () => {
  test("<tenant>.<session>, as sandboxd takes them", () => {
    expect(sandboxIdFor("t-abc", "slack:C1:1790000001.000100")).toBe("t-abc.slack_C1_1790000001.000100");
    expect(sandboxdTakes(sandboxIdFor("t-abc", "slack:C1:1790000001.000100"))).toBe(true);
    // Two tenants' same thread never share one.
    expect(sandboxIdFor("acme", "slack:C1:1.1")).not.toBe(sandboxIdFor("globex", "slack:C1:1.1"));
  });

  test("a long session is cut to sandboxd's 128 characters, with a hash so two never collide", () => {
    const a = sandboxIdFor("x".repeat(32), `slack:C1:${"9".repeat(200)}a`);
    const b = sandboxIdFor("x".repeat(32), `slack:C1:${"9".repeat(200)}b`);
    expect(a.length).toBe(SANDBOX_ID_MAX);
    expect(sandboxdTakes(a) && sandboxdTakes(b)).toBe(true);
    expect(a).not.toBe(b);
    expect(a.startsWith(`${"x".repeat(32)}.slack_C1_`)).toBe(true);
  });
});

describe("log lines", () => {
  test("every console line starts with tenant=<id>, and the console can be put back", () => {
    const original = console.log;
    logAsTenant("t-abc")();
    expect(console.log).toBe(original);
    // In a process of its own, as the serve command installs it.
    const proc = Bun.spawnSync(["bun", "-e", `const { logAsTenant } = require(${JSON.stringify(join(import.meta.dir, "../src/tenant.ts"))}); logAsTenant("t-abc"); console.log("lorehouse: up"); console.error("ingest:", new Error("boom")); console.warn("w")`]);
    const out = proc.stdout.toString().trim().split("\n");
    expect(out).toEqual(["tenant=t-abc lorehouse: up"]);
    const err = proc.stderr.toString();
    expect(err.startsWith("tenant=t-abc ingest:")).toBe(true);
    expect(err).toContain("tenant=t-abc w");
  });
});
