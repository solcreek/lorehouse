// config.ts — everything comes from the environment; missing required settings fail
// at startup with every problem listed at once, not one at a time.

// What a direct message to the agent gets. Whatever the mode, a DM is never knowledge
// and an answer only draws on public channels.
//   redirect  one short reply pointing to the public channel(s), no model call (default:
//             work in public, so everyone learns from everyone's questions)
//   ignore    nothing
//   answer    an answer in the DM (not with code tools: code work stays public)
export const DM_MODES = ["redirect", "ignore", "answer"] as const;
export type DmMode = (typeof DM_MODES)[number];

export type Config = {
  port: number;
  slack: { signingSecret: string; botToken: string; apiUrl?: string; botUserId?: string };
  anthropic: { apiKey: string; baseUrl?: string; model: string };
  agent: { name?: string; coAuthor?: string; channels: Set<string>; dm: DmMode };
  // Lorehouse's own database (knowledge, migrations) — separate from the framework's
  // session store on purpose. The session store defaults to a file beside it (sessionsDbFor).
  db: { lorehouse: string; sessions: string; knowledgeSeed?: string };
  // Slack history → knowledge, for the allowlisted channels. backfillDays 0 = live only.
  ingest: { backfillDays: number; refreshDays: number; debounceMs: number };
  // Print every Slack event the policy lets through, raw, to stdout. For checking what
  // real Slack sends against what the conformance mock assumes. Off by default.
  logSlackEvents: boolean;
  // Bearer token for GET /status. Unset: /status is closed (404).
  statusToken?: string;
  // Bearer token for the admin API (/api/v1, src/admin.ts), which returns message text.
  // Unset: /api/ is closed (404).
  adminToken?: string;
  // Whether usage records who asked (USAGE_RECORD_PEOPLE=1). Off by default: usage is for
  // improving the agent, not for seeing who uses it (src/usage.ts).
  usage: { recordPeople: boolean };
  // Code tools, on when a sandbox is configured, with GitHub credentials:
  //   runners  sandbox hosts connect in (SANDBOX_RUNNER_TOKEN); see docs/sandbox-runners.md
  //   direct   one sandbox host Lorehouse calls (SANDBOX_URL + SANDBOX_TOKEN), e.g. on the
  //            same machine over loopback
  sandbox?: ({ mode: "runners"; runnerToken: string } | { mode: "direct"; url: string; token: string }) & { github: GithubCredentials };
  // GitHub's REST API, for the code tools' credentials and pull requests (GITHUB_API_URL,
  // default https://api.github.com). Like SLACK_API_URL, it points the app at a mock.
  githubApiUrl?: string;
};

// A GitHub App (GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY): short-lived tokens per repo, a bot
// identity, owned by the org. Or a plain token (GITHUB_TOKEN), for development.
export type GithubCredentials = { kind: "app"; appId: string; privateKey: string } | { kind: "token"; token: string };

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { normalizePem } from "./github-auth";

// Where the framework's sessions live when SESSIONS_DB is unset: sessions.db beside
// LOREHOUSE_DB, so a turn parked on an Approve, or a durable automation, survives a
// restart (ADR 0002 §8). Lorehouse's own data in memory means a throwaway instance (a
// test): its sessions stay in memory too.
export function sessionsDbFor(lorehouseDb: string): string {
  return lorehouseDb === ":memory:" ? ":memory:" : join(dirname(lorehouseDb), "sessions.db");
}

// Whether two paths name one file: equal once normalized, through a symlinked directory
// above it (the file existing or not), through a symlink to the file once the file exists,
// or as hard links to one inode. A link to a file not yet created isn't seen.
function sameFile(a: string, b: string): boolean {
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      try {
        return join(realpathSync(dirname(resolve(p))), basename(p));
      } catch {
        return resolve(p);
      }
    }
  };
  if (canonical(a) === canonical(b)) return true;
  try {
    const x = statSync(a), y = statSync(b);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

// Every problem with the environment, one per entry; the message lists them all.
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`lorehouse: missing or invalid configuration: ${problems.join(", ")}`);
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const missing: string[] = [];
  const need = (key: string) => {
    const v = env[key];
    if (!v) missing.push(key);
    return v ?? "";
  };
  const nonNegative = (key: string, fallback: number) => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) missing.push(`${key} (must be a number ≥ 0, got "${raw}")`);
    return n;
  };
  const dmMode = (raw: string | undefined): DmMode => {
    if (raw === undefined || raw === "") return "redirect";
    if ((DM_MODES as readonly string[]).includes(raw)) return raw as DmMode;
    missing.push(`DM_MODE (one of ${DM_MODES.join(", ")}, got "${raw}")`);
    return "redirect";
  };
  const config: Config = {
    port: Number(env.PORT ?? 3000),
    slack: {
      signingSecret: need("SLACK_SIGNING_SECRET"),
      botToken: need("SLACK_BOT_TOKEN"),
      apiUrl: env.SLACK_API_URL || undefined,
      botUserId: env.SLACK_BOT_USER_ID || undefined,
    },
    anthropic: {
      apiKey: need("ANTHROPIC_API_KEY"),
      baseUrl: env.ANTHROPIC_BASE_URL || undefined,
      model: env.ANTHROPIC_MODEL || "claude-opus-5",
    },
    agent: {
      name: env.AGENT_NAME,
      coAuthor: env.AGENT_CO_AUTHOR,
      channels: new Set((env.AGENT_CHANNELS ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
      dm: dmMode(env.DM_MODE),
    },
    db: {
      lorehouse: env.LOREHOUSE_DB || "lorehouse.db",
      sessions: env.SESSIONS_DB || sessionsDbFor(env.LOREHOUSE_DB || "lorehouse.db"),
      knowledgeSeed: env.KNOWLEDGE_SEED || undefined,
    },
    ingest: {
      backfillDays: nonNegative("INGEST_BACKFILL_DAYS", 90),
      refreshDays: nonNegative("INGEST_REFRESH_DAYS", 14),
      debounceMs: nonNegative("INGEST_DEBOUNCE_MS", 5000),
    },
    logSlackEvents: env.LOG_SLACK_EVENTS === "1",
    statusToken: env.STATUS_TOKEN || undefined,
    adminToken: env.ADMIN_TOKEN || undefined,
    usage: { recordPeople: env.USAGE_RECORD_PEOPLE === "1" },
    githubApiUrl: env.GITHUB_API_URL || undefined,
  };
  // One file for both would put June's session tables in Lorehouse's database: say so,
  // rather than let a LOREHOUSE_DB named sessions.db, or a link to it, quietly share it.
  if (config.db.sessions !== ":memory:" && sameFile(config.db.sessions, config.db.lorehouse)) missing.push(`SESSIONS_DB (must be a different file from LOREHOUSE_DB, got "${config.db.sessions}" for both)`);
  if (![undefined, "", "0", "1"].includes(env.USAGE_RECORD_PEOPLE)) missing.push(`USAGE_RECORD_PEOPLE (1 to record who asks, or unset; got "${env.USAGE_RECORD_PEOPLE}")`);
  // The admin token reads what people wrote: long, and never the status token, which is
  // the one handed to monitors.
  if (config.adminToken && config.adminToken.length < 32) missing.push("ADMIN_TOKEN (at least 32 characters)");
  if (config.adminToken && config.adminToken === config.statusToken) missing.push("ADMIN_TOKEN (must differ from STATUS_TOKEN: the status token only reads counts)");
  // GitHub credentials: an App, or a plain token, never both.
  const app = !!(env.GITHUB_APP_ID || env.GITHUB_APP_PRIVATE_KEY);
  let github: GithubCredentials | undefined;
  if (app && env.GITHUB_TOKEN) missing.push("GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY or GITHUB_TOKEN (one GitHub credential, not both)");
  else if (app) {
    if (!env.GITHUB_APP_ID || !/^\d+$/.test(env.GITHUB_APP_ID)) missing.push("GITHUB_APP_ID (the App's numeric id)");
    const key = normalizePem(env.GITHUB_APP_PRIVATE_KEY ?? "");
    if (!/-----BEGIN (RSA )?PRIVATE KEY-----/.test(key)) missing.push("GITHUB_APP_PRIVATE_KEY (the App's .pem private key)");
    github = { kind: "app", appId: env.GITHUB_APP_ID ?? "", privateKey: key };
  } else if (env.GITHUB_TOKEN) github = { kind: "token", token: env.GITHUB_TOKEN };

  const runners = !!env.SANDBOX_RUNNER_TOKEN;
  const direct = !!(env.SANDBOX_URL || env.SANDBOX_TOKEN);
  const needGithub = "GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (a GitHub App), or GITHUB_TOKEN (code tools need GitHub credentials)";
  if (runners && direct) {
    missing.push("SANDBOX_RUNNER_TOKEN or SANDBOX_URL/SANDBOX_TOKEN (one sandbox mode, not both)");
  } else if (runners) {
    if (env.SANDBOX_RUNNER_TOKEN!.length < 32) missing.push("SANDBOX_RUNNER_TOKEN (at least 32 characters)");
    if (!github) missing.push(needGithub);
    else config.sandbox = { mode: "runners", runnerToken: env.SANDBOX_RUNNER_TOKEN!, github };
  } else if (direct) {
    const absent = (["SANDBOX_URL", "SANDBOX_TOKEN"] as const).filter((k) => !env[k]);
    if (absent.length) missing.push(...absent.map((k) => `${k} (the direct sandbox mode needs SANDBOX_URL and SANDBOX_TOKEN)`));
    if (!github) missing.push(needGithub);
    if (!absent.length && github) config.sandbox = { mode: "direct", url: env.SANDBOX_URL!, token: env.SANDBOX_TOKEN!, github };
  } else if (github) {
    missing.push("SANDBOX_RUNNER_TOKEN or SANDBOX_URL + SANDBOX_TOKEN (GitHub credentials are set, but no sandbox)");
  }
  if (config.agent.dm === "answer" && config.sandbox) missing.push("DM_MODE=answer (not with code tools: code work stays in public channels)");
  if (missing.length) throw new ConfigError(missing);
  return config;
}
