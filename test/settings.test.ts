import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, settingsPath, writeSettings } from "../src/settings";

const dir = () => mkdtempSync(join(tmpdir(), "lorehouse-settings-"));

describe("settings.json", () => {
  test("written atomically, owner-only, with no temp file left behind", () => {
    const d = dir();
    const path = join(d, "settings.json");
    writeSettings(path, { env: { A: "1" } });
    expect(readSettings(path).env.A).toBe("1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["settings.json"]);
  });

  test("a symlink in its place is never read through", () => {
    const d = dir();
    const target = join(d, "elsewhere.json");
    writeFileSync(target, JSON.stringify({ env: { SECRET: "x" } }));
    symlinkSync(target, join(d, "settings.json"));
    expect(() => readSettings(join(d, "settings.json"))).toThrow(/can't read/);
  });

  test("writing replaces a symlink rather than writing through it", () => {
    const d = dir();
    const target = join(d, "elsewhere.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(d, "settings.json"));
    writeSettings(join(d, "settings.json"), { env: {} });
    expect(readFileSync(target, "utf8")).toBe("untouched");
    expect(statSync(join(d, "settings.json")).isFile()).toBe(true);
  });
});

// A checkout is where `bun start` and `lorehouse setup` run in development, and the repo
// is public: what they write there must be ignored, or one `git add .` publishes it.
describe("secrets written into a checkout are gitignored", () => {
  const root = join(import.meta.dir, "..");
  const ignored = (path: string) =>
    Bun.spawnSync(["git", "check-ignore", "--quiet", "--no-index", path], { cwd: root }).exitCode === 0;

  test("settings.json at its default place (beside lorehouse.db: the working directory) or beside any LOREHOUSE_DB", () => {
    expect(settingsPath({})).toBe(join(process.cwd(), "settings.json"));
    expect(ignored("settings.json")).toBe(true);
    expect(ignored("data/settings.json")).toBe(true);
    // writeSettings' temp file, left behind if the process dies mid-write
    expect(ignored("settings.json.0123456789abcdef.tmp")).toBe(true);
  });

  test("env files, private keys and SQLite side files", () => {
    // A tenant's directory made in the checkout (src/tenant.ts) holds only these.
    for (const path of [".env", ".env.local", ".env.production", ".dev.vars", "lorehouse.env", "app.private-key.pem", "live.db", "live.db-wal", "live.db-shm", "live.db-journal", "t-abc/tenant.json", "t-abc/tenant.json.0123456789ab.tmp", "t-abc/lorehouse.db-wal", "t-abc/lorehouse.db-wal.stale-1792200000000", "t-abc/sessions.db-shm.stale-1792200000000", "t-abc/lorehouse.db-journal.stale-1", "lorehouse.db.tenant-link", "sessions.db-wal.tenant-link"]) {
      expect([path, ignored(path)]).toEqual([path, true]);
    }
  });

  test("project files with the same names are still tracked", () => {
    expect(ignored(".claude/settings.json")).toBe(false);
    expect(ignored("package.json")).toBe(false);
  });
});
