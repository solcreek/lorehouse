// Shared harness for the session-redaction POC (#66). Starts, in a scratch directory:
//   - conformance/mock.ts (Slack + scripted Anthropic), with a synthetic fixture,
//   - a logging proxy in front of the mock's Anthropic endpoint, so every model request
//     body (what June sends the model) is kept as JSONL,
//   - Lorehouse itself (src/server.ts, unchanged) with the verify-lorehouse environment,
//     but ANTHROPIC_BASE_URL pointed at the proxy.
// Drives it with signed Slack events, like .claude/skills/verify-lorehouse/control.ts.
// No real Slack, no real model, no secrets.

import { createHmac } from "node:crypto";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_TOKEN, SIGNING_SECRET, appEnv } from "../../../.claude/skills/verify-lorehouse/control.ts";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const CHANNEL = "C1";

export type Fixture = Record<string, unknown[]>;
export type Run = {
  dir: string;
  app: string;
  mock: string;
  modelLog: string;
  sessionsDb: string;
  lorehouseDb: string;
  stop: () => Promise<void>;
};

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const p = s.port!;
  s.stop(true);
  return p;
}

async function waitHttp(url: string, ms: number, ok: (r: Response) => Promise<boolean> = async (r) => r.ok): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (await ok(await fetch(url, { headers: { authorization: `Bearer verify-status-token-000000000000` } }))) return true;
    } catch { /* not up */ }
    await Bun.sleep(50);
  }
  return false;
}

// Start mock + proxy + app over `dir` (created if missing; an existing sessions.db is reused,
// which is how a restart on a redacted DB is driven).
export async function start(dir: string, fixture: Fixture, opts: { quiet?: boolean; env?: Record<string, string> } = {}): Promise<Run> {
  mkdirSync(dir, { recursive: true });
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const mockPort = await freePort();
  const appPort = await freePort();
  const mockLog = Bun.file(join(dir, "mock.log"));
  const mock = Bun.spawn([process.execPath, join(REPO, "conformance/mock.ts")], {
    cwd: REPO,
    env: { PATH: process.env.PATH!, PORT: String(mockPort), SLACK_FIXTURES: fixturePath, TTFT_MS: "0", TOKEN_DELAY_MS: "0", TOKENS: "40" },
    stdout: mockLog, stderr: mockLog,
  });
  if (!(await waitHttp(`http://127.0.0.1:${mockPort}/stats`, 10000))) throw new Error("mock did not start");

  // The proxy: logs the request body, forwards to the mock, streams the answer back.
  const modelLog = join(dir, "model-requests.jsonl");
  const proxy = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      appendFileSync(modelLog, JSON.stringify({ t: Date.now(), path: url.pathname, body: JSON.parse(body) }) + "\n");
      const upstream = await fetch(`http://127.0.0.1:${mockPort}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
    },
  });

  const env = appEnv(dir, appPort, mockPort);
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxy.port}/anthropic`;
  Object.assign(env, opts.env ?? {});
  const appLog = Bun.file(join(dir, "app.log"));
  const app = Bun.spawn([process.execPath, join(REPO, "src/server.ts")], { cwd: REPO, env, stdout: appLog, stderr: appLog });
  const appUrl = `http://127.0.0.1:${appPort}`;
  const ready = await waitHttp(`${appUrl}/status`, 30000, async (r) => r.ok && (await r.json() as { knowledge?: { state?: string } }).knowledge?.state === "ready");
  if (!ready) throw new Error(`app not ready; see ${join(dir, "app.log")}`);
  if (!opts.quiet) console.error(`[harness] app ${appUrl} mock :${mockPort} proxy :${proxy.port} dir ${dir}`);
  return {
    dir,
    app: appUrl,
    mock: `http://127.0.0.1:${mockPort}`,
    modelLog,
    sessionsDb: env.SESSIONS_DB!,
    lorehouseDb: env.LOREHOUSE_DB!,
    async stop() {
      app.kill("SIGTERM");
      await app.exited;
      mock.kill("SIGTERM");
      await mock.exited;
      proxy.stop(true);
    },
  };
}

let seq = 0;
// Unique per process run, like Slack's ts (never reused).
export function nextTs(): string {
  seq += 1;
  return `${2_000_000_000 + Math.floor(Date.now() / 1000) % 100000 * 100 + seq}.000100`;
}

export async function sendEvent(run: Run, event: Record<string, unknown>): Promise<number> {
  const payload = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: `EvPoc${Date.now()}-${seq}-${Math.random()}`, event });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", SIGNING_SECRET).update(`v0:${timestamp}:${payload}`).digest("hex");
  const r = await fetch(`${run.app}/slack/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-request-timestamp": timestamp, "x-slack-signature": signature },
    body: payload,
  });
  await r.text();
  return r.status;
}

async function stops(run: Run): Promise<number> {
  const s = (await (await fetch(`${run.mock}/stats`)).json()) as { byMethod: Record<string, number> };
  return s.byMethod["chat.stopStream"] ?? 0;
}

// Mention the agent (a new thread, or in `thread`) and wait until one more stream stopped.
export async function mention(run: Run, text: string, thread?: string): Promise<{ ts: string; reply: string }> {
  const before = await stops(run);
  const ts = nextTs();
  const status = await sendEvent(run, { type: "app_mention", user: "U1", team: "T1", text: `<@UBOT> ${text}`, ts, event_ts: ts, channel: CHANNEL, ...(thread ? { thread_ts: thread } : {}) });
  if (status !== 200) throw new Error(`mention → ${status}`);
  const start = Date.now();
  while ((await stops(run)) <= before) {
    if (Date.now() - start > 20000) throw new Error("no reply within 20 s");
    await Bun.sleep(20);
  }
  const w = (await (await fetch(`${run.mock}/wait?thread_ts=${thread ?? ts}&timeout_ms=1000`)).json()) as { text?: string };
  return { ts, reply: w.text ?? "" };
}

// A person's message in the channel: into Slack's history and delivered as an event.
export async function post(run: Run, text: string, user = "U6"): Promise<string> {
  const ts = nextTs();
  await fetch(`${run.mock}/fixtures/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: CHANNEL, message: { ts, user, text } }) });
  await sendEvent(run, { type: "message", channel: CHANNEL, channel_type: "channel", user, text, ts, event_ts: ts });
  return ts;
}

export async function del(run: Run, ts: string): Promise<void> {
  await fetch(`${run.mock}/fixtures/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: CHANNEL, ts }) });
  const now = nextTs();
  await sendEvent(run, { type: "message", subtype: "message_deleted", hidden: true, channel: CHANNEL, channel_type: "channel", ts: now, event_ts: now, deleted_ts: ts, previous_message: { ts } });
}

export async function admin(run: Run, path: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${run.app}${path}`, { headers: { authorization: `Bearer ${ADMIN_TOKEN}` } });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// Every model request the proxy logged, in order.
export async function modelRequests(run: Run): Promise<{ t: number; body: { system?: unknown; tools?: unknown[]; messages: AnthropicMsg[] } }[]> {
  const text = await Bun.file(run.modelLog).text().catch(() => "");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export type Block = { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown };
export type AnthropicMsg = { role: "user" | "assistant"; content: string | Block[] };

// The Messages API's pairing rule, checked on a request body: every tool_use in an assistant
// message is answered by a tool_result with its id in the next (user) message, tool_result
// blocks come first in it, and no tool_result answers an unknown id. (Duplicate ids across
// the transcript are reported apart, by duplicateToolUseIds: the mock numbers its ids per
// process, so a restarted mock reuses them; the real API never does.)
export function duplicateToolUseIds(messages: AnthropicMsg[]): string[] {
  const seen = new Set<string>(), dup: string[] = [];
  for (const m of messages) if (typeof m.content !== "string") for (const b of m.content) if (b.type === "tool_use") { if (seen.has(b.id!)) dup.push(b.id!); seen.add(b.id!); }
  return dup;
}
export function pairingErrors(messages: AnthropicMsg[]): string[] {
  const errors: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const uses = m.content.filter((b) => b.type === "tool_use").map((b) => b.id!);
    if (!uses.length) continue;
    const next = messages[i + 1];
    if (!next || next.role !== "user" || typeof next.content === "string") { errors.push(`msg ${i}: tool_use without a following tool_result message`); continue; }
    const results = next.content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id!);
    for (const id of uses) if (!results.includes(id)) errors.push(`msg ${i}: tool_use ${id} unanswered`);
    for (const id of results) if (!uses.includes(id)) errors.push(`msg ${i + 1}: tool_result for unknown ${id}`);
    const firstText = next.content.findIndex((b) => b.type !== "tool_result");
    const lastResult = next.content.map((b) => b.type).lastIndexOf("tool_result");
    if (firstText >= 0 && firstText < lastResult) errors.push(`msg ${i + 1}: text before a tool_result`);
  }
  for (let i = 1; i < messages.length; i++) if (messages[i]!.role === messages[i - 1]!.role) errors.push(`msg ${i}: two ${messages[i]!.role} messages in a row`);
  return errors;
}
