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
  // Code tools are on only when all three are set.
  sandbox?: { url: string; token: string; githubToken: string };
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
  const sandboxKeys = ["SANDBOX_URL", "SANDBOX_TOKEN", "GITHUB_TOKEN"] as const;
  const set = sandboxKeys.filter((k) => env[k]);
  if (set.length === sandboxKeys.length) {
    config.sandbox = { url: env.SANDBOX_URL!, token: env.SANDBOX_TOKEN!, githubToken: env.GITHUB_TOKEN! };
  } else if (set.length > 0) {
    missing.push(...sandboxKeys.filter((k) => !env[k]).map((k) => `${k} (code tools need all of ${sandboxKeys.join(", ")})`));
  }
  if (config.agent.dm === "answer" && config.sandbox) missing.push("DM_MODE=answer (not with code tools: code work stays in public channels)");
  if (missing.length) throw new Error(`lorehouse: missing or invalid configuration: ${missing.join(", ")}`);
  return config;
}
