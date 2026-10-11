import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SETTINGS = join(import.meta.dir, "..", "src", "settings.ts");
// Loaded by path at run time: tsc's include stops at src/, test/ and conformance/, and the
// skill's CLI isn't written to pass it.
const CONTROL = join(import.meta.dir, "..", ".claude", "skills", "verify-lorehouse", "control.ts");
const { appEnv } = (await import(CONTROL)) as { appEnv: (dir: string, appPort: number, mockPort: number) => Record<string, string> };

// The verify-lorehouse app must see only what the harness gives it. Besides the process
// environment, the app reads LOREHOUSE_ENV_FILE and settings.json (src/settings.ts), and
// Bun loads `.env` from the working directory (the repo root, where a developer keeps real
// credentials) for every variable not already set. So a `.env` naming another env file or
// settings file must not reach a real workspace's settings.
describe("verify-lorehouse launches the app isolated from installed settings", () => {
  test("a LOREHOUSE_ENV_FILE or LOREHOUSE_SETTINGS from the working directory's .env is never read", () => {
    const root = mkdtempSync(join(tmpdir(), "lorehouse-verify-isolation-"));
    const run = join(root, "run");
    const cwd = join(root, "checkout");
    mkdirSync(run);
    mkdirSync(cwd);
    const fakeEnv = join(root, "installed.env");
    const fakeSettings = join(root, "installed-settings.json");
    writeFileSync(fakeEnv, "GITHUB_TOKEN=leaked-from-env-file\nUSAGE_RECORD_PEOPLE=leaked-from-env-file\n");
    writeFileSync(fakeSettings, JSON.stringify({ env: { SANDBOX_URL: "http://leaked-from-settings" } }));
    writeFileSync(join(cwd, ".env"), `LOREHOUSE_ENV_FILE=${fakeEnv}\nLOREHOUSE_SETTINGS=${fakeSettings}\n`);

    // What the app does first (src/server.ts: loadEnv()), in a fresh Bun with the env the
    // harness passes and a working directory holding that .env.
    const script = `import { loadEnv } from ${JSON.stringify(SETTINGS)}; const l = loadEnv(); console.log(JSON.stringify({ env: l.env, envFile: l.envFile ?? null, settingsPath: l.settingsPath }));`;
    const r = Bun.spawnSync([process.execPath, "-e", script], { cwd, env: appEnv(run, 1, 2), stdout: "pipe", stderr: "pipe" });
    expect(r.stderr.toString()).toBe("");
    const loaded = JSON.parse(r.stdout.toString()) as { env: Record<string, string>; envFile: string | null; settingsPath: string };

    expect(Object.entries(loaded.env).filter(([, v]) => v?.includes("leaked"))).toEqual([]);
    expect(loaded.envFile).toBeNull();
    expect(loaded.settingsPath).toBe(join(run, "settings.json"));
  });

  test("the env file is a path in the run directory that doesn't exist, never the install's default", () => {
    // Left unset or blank, it falls back to /etc/lorehouse/lorehouse.env: a real install's
    // credentials on any machine that has one. (A test can't plant a file there.)
    const run = mkdtempSync(join(tmpdir(), "lorehouse-verify-isolation-"));
    const env = appEnv(run, 1, 2);
    expect(env.LOREHOUSE_ENV_FILE).toBe(join(run, "lorehouse.env"));
    expect(existsSync(env.LOREHOUSE_ENV_FILE!)).toBe(false);
    expect(env.LOREHOUSE_SETTINGS).toBe(join(run, "settings.json"));
  });
});
