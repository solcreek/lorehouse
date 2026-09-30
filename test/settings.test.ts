import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSettings, writeSettings } from "../src/settings";

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
