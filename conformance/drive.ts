// drive.ts — load + conformance driver. Sends signed Slack app_mention webhooks to an
// implementation, waits (via the mock) for each thread's stream to stop, and reports
// latency, throughput, memory and conformance.
//
//   bun harness/drive.ts --target http://localhost:8801/slack/events --n 200 --c 20 \
//        [--pid 12345] [--mock http://localhost:8900] [--secret test-signing-secret] [--out r.json]
//
// Per request it checks the Slack-side contract: exactly one startStream (in the
// event's thread, with recipient ids), ≥1 appendStream, exactly one stopStream, and the
// concatenated text is the scripted answer for THIS question (nonce + a chunk citation).

import { createHmac } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).reduce<[string, string][]>((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1] ?? ""]] : acc), []),
);
const TARGET = args.target ?? "http://localhost:8801/slack/events";
const MOCK = args.mock ?? "http://localhost:8900";
const N = Number(args.n ?? 50);
const C = Number(args.c ?? 5);
const SECRET = args.secret ?? "test-signing-secret";
const PID = args.pid ? Number(args.pid) : undefined;
const TOKENS = Number(args.tokens ?? 80);

export const QUESTIONS = [
  "how does soft navigation work",
  "what is juno and when should I use it",
  "how are static files served",
  "how do I integrate authentication",
  "how does the google drive integration authenticate",
  "how does styling with tailwind work",
  "what are the navigation tiers",
  "how does the data layer boundary work",
  "how is juno sqlite performance",
  "what does the june cli do",
  "how do islands hydrate on the client",
  "how is markdown served without drift",
  "how does the built in mcp server work",
  "how do I deploy to cloudflare workers",
  "what is the runtime convergence plan",
  "how does the turn as a live process rfc work",
  "how do og images render",
  "how does i18n routing work",
  "how does caching invalidate after a write",
  "what is the client router persist option",
];

const sign = (ts: string, body: string) => "v0=" + createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex");

function pct(xs: number[], p: number) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function rssKb(pid: number): Promise<number> {
  // RSS of the process AND its children (bun/go both may fork helpers; be fair)
  const out = await Bun.$`ps -A -o pid=,ppid=,rss=`.quiet().text();
  const rows = out.trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number) as [number, number, number]);
  const tree = new Set([pid]);
  let grew = true;
  while (grew) { grew = false; for (const [p, pp] of rows) if (tree.has(pp) && !tree.has(p)) { tree.add(p); grew = true; } }
  return rows.filter(([p]) => tree.has(p)).reduce((s, [, , r]) => s + r, 0);
}

type Result = { i?: number; ok: boolean; ack: number; e2e: number; firstText: number; appends: number; cite?: string; error?: string };

let seq = 0;
// Real Slack never reuses an event_id or a message ts. Earlier runs restarted both at
// 1 on every drive invocation, so consecutive runs against one process landed in the
// SAME sessions (with the mock's tool ids also restarting) — which is what surfaced
// June #167 — and would now trip June's event_id dedupe (#170). Unique per run.
const RUN = String(Date.now() % 1_000_000).padStart(6, "0");
async function one(i: number): Promise<Result> {
  const n = ++seq;
  const q = QUESTIONS[i % QUESTIONS.length]!;
  const ts = `${1800000000 + n}.${RUN}`;
  const body = JSON.stringify({
    token: "x", team_id: "T1", api_app_id: "A1", type: "event_callback", event_id: `Ev${RUN}-${n}`, event_time: Math.floor(Date.now() / 1000),
    event: { type: "app_mention", user: "U1", text: `<@UBOT> [q${n}] ${q}`, ts, channel: "C1", event_ts: ts, team: "T1", channel_type: "channel" },
  });
  const now = String(Math.floor(Date.now() / 1000));
  const t0 = Date.now();
  let ack = NaN;
  try {
    const res = await fetch(TARGET, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": now, "x-slack-signature": sign(now, body) }, body });
    ack = Date.now() - t0;
    if (res.status !== 200) return { ok: false, ack, e2e: NaN, firstText: NaN, appends: 0, error: `webhook ${res.status}` };
    const w = await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=60000`);
    const s = (await w.json()) as { methods: string[]; appends: number; text: string; stopAt: number; startAt: number; recipients: { team?: string; user?: string }; timeout?: boolean };
    if (s.timeout) return { ok: false, ack, e2e: NaN, firstText: NaN, appends: 0, error: `stream never stopped (${JSON.stringify(s)})` };
    const problems: string[] = [];
    const count = (m: string) => s.methods.filter((x) => x === m).length;
    if (count("chat.startStream") !== 1) problems.push(`startStream×${count("chat.startStream")}`);
    if (count("chat.stopStream") !== 1) problems.push(`stopStream×${count("chat.stopStream")}`);
    if (s.appends < 1 && !s.text) problems.push("no text");
    if (s.recipients.team !== "T1" || s.recipients.user !== "U1") problems.push(`recipients=${JSON.stringify(s.recipients)}`);
    const text = s.text.trim();
    const cite = text.match(/\[cite:(c\d+|none)\]/)?.[1];
    if (!text.startsWith(`[q${n}]`)) problems.push(`nonce missing: ${JSON.stringify(text.slice(0, 40))}`);
    if (!cite || cite === "none") problems.push("no chunk cited (retrieval didn't reach the model)");
    if (!text.endsWith(`w${TOKENS - 1}`)) problems.push(`text truncated: …${JSON.stringify(text.slice(-20))}`);
    return { ok: problems.length === 0, ack, e2e: s.stopAt - t0, firstText: s.startAt - t0, appends: s.appends, cite, error: problems.join("; ") || undefined };
  } catch (e) {
    return { ok: false, ack, e2e: NaN, firstText: NaN, appends: 0, error: String(e) };
  }
}

await fetch(`${MOCK}/reset`, { method: "POST" });
const rss: number[] = [];
const idleRss = PID ? await rssKb(PID) : undefined;
let sampling = true;
const sampler = (async () => { while (sampling && PID) { rss.push(await rssKb(PID)); await Bun.sleep(100); } })();

const started = Date.now();
const results: Result[] = [];
let next = 0;
await Promise.all(Array.from({ length: C }, async () => {
  while (next < N) { const i = next++; results.push({ ...(await one(i)), i }); }
}));
const wall = Date.now() - started;
sampling = false;
await sampler;

const ok = results.filter((r) => r.ok);
const errors = results.filter((r) => !r.ok);
const summary = {
  target: TARGET, n: N, c: C, wallMs: wall, throughputPerSec: +(N / (wall / 1000)).toFixed(2),
  ok: ok.length, failed: errors.length,
  ackMs: { p50: pct(ok.map((r) => r.ack), 50), p95: pct(ok.map((r) => r.ack), 95), p99: pct(ok.map((r) => r.ack), 99), max: Math.max(...ok.map((r) => r.ack)) },
  firstStreamMs: { p50: pct(ok.map((r) => r.firstText), 50), p95: pct(ok.map((r) => r.firstText), 95) },
  e2eMs: { p50: pct(ok.map((r) => r.e2e), 50), p95: pct(ok.map((r) => r.e2e), 95), p99: pct(ok.map((r) => r.e2e), 99) },
  appendsPerReply: { p50: pct(ok.map((r) => r.appends), 50), max: Math.max(0, ...ok.map((r) => r.appends)) },
  rssMb: PID ? { idle: +((idleRss ?? 0) / 1024).toFixed(1), peak: +(Math.max(...rss) / 1024).toFixed(1) } : undefined,
  // question index → cited chunk: both implementations must agree (same FTS5 query → same top hit)
  cites: Object.fromEntries(QUESTIONS.map((q, i) => [q, results.find((r) => r.ok && (r.i ?? -1) % QUESTIONS.length === i)?.cite])),
  sampleErrors: [...new Set(errors.map((e) => e.error))].slice(0, 5),
};
console.log(JSON.stringify(summary, null, 2));
if (args.out) await Bun.write(args.out, JSON.stringify(summary, null, 2));
