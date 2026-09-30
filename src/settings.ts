// settings.ts — where configuration comes from. For each key, the first non-empty value wins:
//
//   1. the process environment
//   2. the install's settings file, LOREHOUSE_ENV_FILE (default /etc/lorehouse/lorehouse.env),
//      written by install.sh and edited by people
//   3. settings.json beside the database, written by the app itself: `lorehouse setup` and
//      the Slack install put the Slack app's credentials and the bot token there, so nobody
//      copies a secret by hand
//
// An empty value (`SLACK_BOT_TOKEN=` in a template) counts as unset, so it never hides one
// the app wrote.

import { randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fchownSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Env = Record<string, string | undefined>;

export type Settings = {
  // Values under the environment's own names (SLACK_BOT_TOKEN, AGENT_CHANNELS, …).
  env: Record<string, string>;
  // The Slack app this install created and manages.
  slack?: {
    appId?: string;
    clientId?: string;
    clientSecret?: string;
    // An app configuration token pair: the access token lasts 12 hours; the refresh token
    // gets a new pair. Kept so the app can repoint Slack at a URL that changed.
    configToken?: string;
    configRefreshToken?: string;
    configExpiresAt?: number; // unix seconds
    oauthState?: string; // the pending install's state, checked on the OAuth callback
    channels?: string[]; // channel names to join once installed
    installedBy?: string; // the user id that clicked Allow
  };
  // Written by the running app: where Slack reaches it now.
  runtime?: { publicUrl?: string };
};

export const DEFAULT_ENV_FILE = "/etc/lorehouse/lorehouse.env";

// KEY=value lines; # comments and blank lines skipped; one layer of quotes removed.
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

function merge(...layers: Env[]): Env {
  const out: Env = {};
  for (const layer of layers.slice().reverse()) {
    for (const [k, v] of Object.entries(layer)) if (v) out[k] = v;
  }
  return out;
}

function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`can't read ${path}: ${(e as Error).message}`);
  }
}

export function settingsPath(env: Env): string {
  return env.LOREHOUSE_SETTINGS || join(dirname(resolve(env.LOREHOUSE_DB || "lorehouse.db")), "settings.json");
}

// Opened with O_NOFOLLOW: as root, a symlink planted here must not read another file in.
export function readSettings(path: string): Settings {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const s = JSON.parse(text) as Settings;
    return { ...s, env: s.env ?? {} };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { env: {} };
    throw new Error(`can't read ${path}: ${(e as Error).message}`);
  }
}

// Replaces the file atomically, readable by its owner only. Run as root (sudo lorehouse
// setup), it hands the file to whoever owns the directory, so the service can still write it.
// That directory is the service account's, so as root nothing here follows a path it could
// plant a symlink at: the temp name is random and created exclusively (O_EXCL never follows
// a link), and it is written and chowned through its descriptor.
export function writeSettings(path: string, s: Settings): void {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, JSON.stringify(s, null, 2) + "\n");
    const dir = statSync(dirname(path));
    if (process.getuid?.() === 0 && dir.uid !== 0) fchownSync(fd, dir.uid, dir.gid);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
}

// Read, change, write: for the few places that update settings.json.
export function updateSettings(path: string, change: (s: Settings) => void): Settings {
  const s = readSettings(path);
  change(s);
  writeSettings(path, s);
  return s;
}

export type Loaded = { env: Env; settingsPath: string; settings: Settings; envFile?: string };

// The environment the app and the doctor run with, and the settings behind it.
export function loadEnv(proc: Env = process.env): Loaded {
  const envFile = proc.LOREHOUSE_ENV_FILE || DEFAULT_ENV_FILE;
  const base = merge(proc, readEnvFile(envFile));
  const path = settingsPath(base);
  const settings = readSettings(path);
  return { env: merge(base, settings.env), settingsPath: path, settings, envFile: existsSync(envFile) ? envFile : undefined };
}
