// harness.ts — what driving an app under test takes, shared by the conformance suite
// (run.ts) and the evals (evals/): Slack's signed deliveries, waiting on something
// observable, the app's environment, and what the mock reports. No state and nothing
// started on import: each caller passes its own target, secret and ports.

import { $ } from "bun";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";

// Whether `url` answered 2xx within `ms`.
export async function waitHttp(url: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await Bun.sleep(20);
  }
  return false;
}

// The pids listening on a local port.
export async function listenerPids(port: number): Promise<string[]> {
  const lsof = await $`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`.quiet().nothrow();
  if (lsof.exitCode === 0) return lsof.text().trim().split("\n").filter(Boolean);
  const ss = await $`ss -ltnpH sport = :${port}`.quiet().nothrow().text();
  return [...ss.matchAll(/pid=(\d+)/g)].map((m) => m[1]!);
}

// The first truthy value check() returns within ms, or undefined.
export async function until<T>(check: () => Promise<T | undefined>, ms = 15000): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await check();
    if (v) return v;
    await Bun.sleep(50);
  }
  return undefined;
}

// A body POSTed as Slack signs one: v0 HMAC-SHA256 of "v0:<timestamp>:<body>".
export function signedPost(target: string, secret: string, body: string, contentType: string, extra: Record<string, string> = {}): Promise<Response> {
  const now = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", secret).update(`v0:${now}:${body}`).digest("hex");
  return fetch(target, { method: "POST", headers: { "content-type": contentType, "x-slack-request-timestamp": now, "x-slack-signature": sig, ...extra }, body });
}

// An Events API delivery. `retry`: Slack's redelivery header; `badSig`: signed with the
// wrong secret.
export function postEvent(target: string, secret: string, eventId: string, event: Record<string, unknown>, opts: { retry?: string; badSig?: boolean } = {}): Promise<Response> {
  const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: eventId, event });
  return signedPost(target, opts.badSig ? "wrong" : secret, body, "application/json", opts.retry ? { "x-slack-retry-num": opts.retry } : {});
}

// A button click, as Slack's interactivity delivers one: form-encoded `payload=<json>`,
// signed like an event, to the same URL.
export function postInteraction(target: string, secret: string, payload: Record<string, unknown>): Promise<Response> {
  return signedPost(target, secret, `payload=${encodeURIComponent(JSON.stringify(payload))}`, "application/x-www-form-urlencoded");
}

export type Block = { type: string; elements?: { type: string; text?: { text: string }; action_id?: string; value?: string }[] };
// The mock's GET /stats.
export type Stats = {
  slackCalls: number; modelCalls: number; cacheMarkedModelCalls: number; byMethod: Record<string, number>; readChannels: string[]; reactionChannels: string[];
  posts: { channel: string; thread_ts?: string; text: string; blocks?: Block[]; ts: string }[];
  updates: { channel: string; ts: string; text: string }[];
  responses: { path: string; text?: string; response_type?: string; replace_original?: boolean }[];
  github: { method: string; path: string; body?: unknown; auth?: string }[];
  uploads: { fileId: string; filename: string; length: number; bytes?: number; contentType?: string; head?: string; channel?: string; thread_ts?: string; title?: string }[];
};

// The button labelled `label` on a message's blocks (an Approve/Deny card).
export function buttonOn(blocks: Block[] | undefined, label: string): { action_id?: string; value?: string } | undefined {
  return (blocks ?? []).flatMap((b) => b.elements ?? []).find((e) => e.type === "button" && e.text?.text === label);
}

// The environment an app under test starts with, against the mock at `mock`: nothing of
// this shell's settings files, tenant or PDF settings leaks in. `db` is LOREHOUSE_DB; the
// env file and settings.json are named beside it (missing unless a scenario writes them).
// `extra` is laid over it.
export function appEnv(
  inherited: Record<string, string | undefined>,
  o: { port: number; secret: string; mock: string; channels: string; seed: string; db: string; statusToken: string; adminToken: string },
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    ...inherited,
    PORT: String(o.port),
    SLACK_SIGNING_SECRET: o.secret,
    SLACK_BOT_TOKEN: "xoxb-conformance",
    SLACK_API_URL: `${o.mock}/slack/api`,
    ANTHROPIC_API_KEY: "conformance",
    ANTHROPIC_BASE_URL: `${o.mock}/anthropic`,
    AGENT_CHANNELS: o.channels,
    KNOWLEDGE_SEED: o.seed,
    LOREHOUSE_DB: o.db,
    // Fixture timestamps are fixed, so look back far enough that they never age out.
    INGEST_BACKFILL_DAYS: "36500",
    INGEST_REFRESH_DAYS: "36500",
    INGEST_DEBOUNCE_MS: "200",
    STATUS_TOKEN: o.statusToken,
    ADMIN_TOKEN: o.adminToken,
    LOREHOUSE_ENV_FILE: join(dirname(extra.LOREHOUSE_DB ?? o.db), "lorehouse.env"),
    // Set, not left to its default: the app's Bun loads the checkout's .env for every
    // variable not set here, and one naming a settings file would fill in the rest.
    LOREHOUSE_SETTINGS: join(dirname(extra.LOREHOUSE_DB ?? o.db), "settings.json"),
    // The PDF settings at their defaults (empty is unset), never this shell's or the .env's:
    // the PDF scenarios test PDF replies off by default and PDF_FONTS=local, which an
    // inherited PDF_FONTS=google would turn into a test of Google Fonts over the network.
    PDF_REPLIES: "",
    PDF_FONTS: "",
    FILE_STORE: "",
    // The tenant from the data directory LOREHOUSE_DB names, never this shell's or the .env's.
    TENANT_ID: "",
    TENANT_NEW: "",
    LOREHOUSE_DATA_DIR: "",
    // Plaintext files unless a scenario gives the tenant a Strongroom (the mock's).
    STRONGROOM_URL: "",
    STRONGROOM_TOKEN: "",
    STRONGROOM_KEY: "",
    ...extra,
  };
}
