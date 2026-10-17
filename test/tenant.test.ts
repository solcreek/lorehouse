// The tenant (ADR 0005 §1): its id in every path, sandbox id and log line, and an install
// laid out before tenants moved into its tenant's directory on the first start.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  const rows = (path: string) => {
    const db = new Database(path, { readwrite: true, create: false });
    try {
      return (db.query("SELECT COUNT(*) AS n FROM walrows").get() as { n: number }).n;
    } finally {
      db.close();
    }
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
    expect(readdirSync(d).sort()).toEqual([config.tenant.id, "settings.json"].sort());
    expect(readdirSync(t).sort()).toEqual(["lorehouse.db", "lorehouse.db-shm", "lorehouse.db-wal", "sessions.db", "sessions.db-shm", "sessions.db-wal", "tenant.json"]);
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
    expect(pendingMoves(again.config.db.upgrade)).toEqual([]);
    expect(rows(join(t, "lorehouse.db"))).toBe(25);
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
    const later = start(d);
    expect(later.config.tenant.id).toBe(config.tenant.id);
    expect(later.moved).toEqual(["lorehouse.db (+ -wal, -shm)", "sessions.db (+ -wal, -shm)"]);
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
