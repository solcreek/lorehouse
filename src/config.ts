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
  // session store on purpose.
  db: { lorehouse: string; sessions: string; knowledgeSeed?: string };
  // Slack history → knowledge, for the allowlisted channels. backfillDays 0 = live only.
  ingest: { backfillDays: number; refreshDays: number; debounceMs: number };
  // Print every Slack event the policy lets through, raw, to stdout. For checking what
  // real Slack sends against what the conformance mock assumes. Off by default.
  logSlackEvents: boolean;
  // Bearer token for GET /status. Unset: /status is closed (404).
  statusToken?: string;
  // Code tools, on when a sandbox is configured (plus GITHUB_TOKEN for pull requests):
  //   runners  sandbox hosts connect in (SANDBOX_RUNNER_TOKEN); see docs/sandbox-runners.md
  //   direct   one sandbox host Lorehouse calls (SANDBOX_URL + SANDBOX_TOKEN), e.g. on the
  //            same machine over loopback
  sandbox?: { mode: "runners"; runnerToken: string; githubToken: string } | { mode: "direct"; url: string; token: string; githubToken: string };
};

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
      sessions: env.SESSIONS_DB || ":memory:",
      knowledgeSeed: env.KNOWLEDGE_SEED || undefined,
    },
    ingest: {
      backfillDays: nonNegative("INGEST_BACKFILL_DAYS", 90),
      refreshDays: nonNegative("INGEST_REFRESH_DAYS", 14),
      debounceMs: nonNegative("INGEST_DEBOUNCE_MS", 5000),
    },
    logSlackEvents: env.LOG_SLACK_EVENTS === "1",
    statusToken: env.STATUS_TOKEN || undefined,
  };
  const runners = !!env.SANDBOX_RUNNER_TOKEN;
  const direct = !!(env.SANDBOX_URL || env.SANDBOX_TOKEN);
  if (runners && direct) {
    missing.push("SANDBOX_RUNNER_TOKEN or SANDBOX_URL/SANDBOX_TOKEN (one sandbox mode, not both)");
  } else if (runners) {
    if (env.SANDBOX_RUNNER_TOKEN!.length < 32) missing.push("SANDBOX_RUNNER_TOKEN (at least 32 characters)");
    if (!env.GITHUB_TOKEN) missing.push("GITHUB_TOKEN (code tools need it with SANDBOX_RUNNER_TOKEN)");
    config.sandbox = { mode: "runners", runnerToken: env.SANDBOX_RUNNER_TOKEN!, githubToken: env.GITHUB_TOKEN ?? "" };
  } else if (direct || env.GITHUB_TOKEN) {
    const keys = ["SANDBOX_URL", "SANDBOX_TOKEN", "GITHUB_TOKEN"] as const;
    const absent = keys.filter((k) => !env[k]);
    if (absent.length === 0) config.sandbox = { mode: "direct", url: env.SANDBOX_URL!, token: env.SANDBOX_TOKEN!, githubToken: env.GITHUB_TOKEN! };
    else missing.push(...absent.map((k) => `${k} (code tools need SANDBOX_RUNNER_TOKEN, or all of ${keys.join(", ")}, with GITHUB_TOKEN)`));
  }
  if (config.agent.dm === "answer" && config.sandbox) missing.push("DM_MODE=answer (not with code tools: code work stays in public channels)");
  if (missing.length) throw new Error(`lorehouse: missing or invalid configuration: ${missing.join(", ")}`);
  return config;
}
