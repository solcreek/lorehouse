// run.ts — the behavioral contract. Black-box: it only speaks HTTP to the app and reads
// what a mocked Slack + Anthropic observed. Any implementation, in any language, that
// passes this is interchangeable with the one in this repo.
//
//   bun conformance/run.ts                        # runs `bun src/server.ts`
//   bun conformance/run.ts --app ./dist/lorehouse # or any executable
//
// The app is configured with env: PORT, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN,
// SLACK_API_URL, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, AGENT_CHANNELS, KNOWLEDGE_SEED,
// LOREHOUSE_DB, INGEST_BACKFILL_DAYS, INGEST_DEBOUNCE_MS. It must answer GET /healthz
// once listening, and GET /status with { knowledge: { state: "ready", … } } once its
// Slack backfill is done.

import { $ } from "bun";
import { createHmac } from "node:crypto";
import { dirname, join, resolve } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HERE = import.meta.dir;
const argv = process.argv.slice(2);
const appIdx = argv.indexOf("--app");
// Absolute, because an external app runs with its own directory as cwd (see below).
const APP_CMD = appIdx >= 0 ? [resolve(argv[appIdx + 1]!)] : ["bun", join(ROOT, "src/server.ts")];

const SECRET = "conformance-signing-secret";
const MOCK_PORT = 18000 + Math.floor(Math.random() * 1000);
const APP_PORT = MOCK_PORT + 1000;
const MOCK = `http://localhost:${MOCK_PORT}`;
const TARGET = `http://localhost:${APP_PORT}/slack/events`;
const ALLOWED = "C1"; // the one channel the app may work in

// ── helpers ─────────────────────────────────────────────────────────────────

async function waitHttp(url: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if ((await fetch(url)).ok) return true; } catch { /* not up yet */ }
    await Bun.sleep(20);
  }
  return false;
}

async function listenerPids(port: number): Promise<string[]> {
  const lsof = await $`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`.quiet().nothrow();
  if (lsof.exitCode === 0) return lsof.text().trim().split("\n").filter(Boolean);
  const ss = await $`ss -ltnpH sport = :${port}`.quiet().nothrow().text();
  return [...ss.matchAll(/pid=(\d+)/g)].map((m) => m[1]!);
}

let seq = 0;
async function sendEvent(event: Record<string, unknown>, opts: { eventId?: string; retry?: string; badSig?: boolean } = {}) {
  const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: opts.eventId ?? `EvConf${Date.now()}-${++seq}`, event });
  const now = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", opts.badSig ? "wrong" : SECRET).update(`v0:${now}:${body}`).digest("hex");
  const headers: Record<string, string> = { "content-type": "application/json", "x-slack-request-timestamp": now, "x-slack-signature": sig };
  if (opts.retry) headers["x-slack-retry-num"] = opts.retry;
  return fetch(TARGET, { method: "POST", headers, body });
}

const mention = (channel: string, extra: Record<string, unknown> = {}) => {
  const ts = `${1960000000 + ++seq}.000100`;
  return { type: "app_mention", user: "U1", team: "T1", text: "<@UBOT> [q1] how does soft navigation work", ts, event_ts: ts, channel, ...extra };
};

const stats = async () => (await (await fetch(`${MOCK}/stats`)).json()) as { slackCalls: number; modelCalls: number; byMethod: Record<string, number>; readChannels: string[] };
const reset = () => fetch(`${MOCK}/reset`, { method: "POST" });

// Ask the agent something in the allowed channel and read back what it cited.
async function ask(question: string): Promise<{ cite?: string; src?: string; text: string }> {
  const n = ++seq;
  const ts = `${1970000000 + n}.000100`;
  await sendEvent({ type: "app_mention", user: "U1", team: "T1", text: `<@UBOT> [q${n}] ${question}`, ts, event_ts: ts, channel: ALLOWED });
  const r = await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=15000`);
  const { text = "" } = (await r.json()) as { text?: string };
  return { cite: text.match(/\[cite:([^\]\s]+)\]/)?.[1], src: text.match(/\[src:([^\]\s]+)\]/)?.[1], text };
}

type Status = { agent: string; knowledge: { state: string; documents: number; channels: Record<string, { cursor?: string; threads: number }> } };
const status = async () => (await (await fetch(`http://localhost:${APP_PORT}/status`)).json()) as Status;

// Post a message into Slack's history, then deliver the Events API event for it.
async function liveMessage(channel: string, channelType: string, text: string): Promise<string> {
  const ts = `${1980000000 + ++seq}.000100`;
  await fetch(`${MOCK}/fixtures/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, message: { ts, user: "U6", text } }) });
  await sendEvent({ type: "message", channel, channel_type: channelType, user: "U6", text, ts, event_ts: ts });
  return ts;
}

const SEED_DOCS = (await Bun.file(join(HERE, "fixtures/corpus.jsonl")).text()).split("\n").filter((l) => l.trim()).length;
const WOMBAT_THREAD = "slack:C1:1790000001.000100";

// ── scenarios ───────────────────────────────────────────────────────────────

type Scenario = { name: string; run: () => Promise<string | null> }; // null = pass, string = why it failed

const scenarios: Scenario[] = [
  {
    name: "answers a mention: retrieval → streamed reply in the thread (40 requests, 4 concurrent)",
    run: async () => {
      const out = await $`bun ${join(HERE, "drive.ts")} --target ${TARGET} --mock ${MOCK} --secret ${SECRET} --n 40 --c 4`.quiet().nothrow();
      const r = JSON.parse(out.stdout.toString()) as { ok: number; failed: number; sampleErrors: string[]; cites: Record<string, string> };
      if (r.ok !== 40) return `${r.ok}/40 ok — ${r.sampleErrors.join(" | ")}`;
      // The search contract: the same question must surface the same top chunk.
      const expected = (await Bun.file(join(HERE, "fixtures/expected-cites.json")).json()) as Record<string, string>;
      const wrong = Object.entries(expected).filter(([q, id]) => r.cites[q] !== id);
      return wrong.length ? `top hit differs for ${wrong.length} question(s), e.g. "${wrong[0]![0]}": got ${r.cites[wrong[0]![0]]}, want ${wrong[0]![1]}` : null;
    },
  },
  {
    name: "reports ingest state and document count at GET /status",
    run: async () => {
      const s = await status();
      // seeds + the wombat thread + the password message; the bot post and the join are not documents
      const want = SEED_DOCS + 2;
      if (s.knowledge.state !== "ready") return `state ${s.knowledge.state}, want ready`;
      return s.knowledge.documents === want ? null : `documents ${s.knowledge.documents}, want ${want}`;
    },
  },
  {
    name: "answers from backfilled Slack history, citing the thread's permalink",
    run: async () => {
      const a = await ask("when is the quarterly wombat review");
      if (a.cite !== WOMBAT_THREAD) return `cited ${a.cite}, want ${WOMBAT_THREAD}`;
      const want = "https://acme.slack.com/archives/C1/p1790000001000100";
      return a.src === want ? null : `source ${a.src}, want ${want}`;
    },
  },
  {
    name: "indexes whole threads: an answer only a reply holds is found",
    run: async () => {
      const a = await ask("which floor is the ops room on");
      return a.cite === WOMBAT_THREAD ? null : `cited ${a.cite}, want ${WOMBAT_THREAD}`;
    },
  },
  {
    name: "leaves bot and system messages out of knowledge",
    run: async () => {
      const a = await ask("platypus build succeeded");
      return a.cite === "slack:C1:1790000020.000100" ? "cited the deploy bot's message" : null;
    },
  },
  {
    name: "indexes a live message in a public channel",
    run: async () => {
      const ts = await liveMessage(ALLOWED, "channel", "Reminder: the kangaroo deploy freeze starts Friday at noon");
      await Bun.sleep(1000); // > INGEST_DEBOUNCE_MS
      const a = await ask("when does the kangaroo deploy freeze start");
      return a.cite === `slack:${ALLOWED}:${ts}` ? null : `cited ${a.cite}, want slack:${ALLOWED}:${ts}`;
    },
  },
  {
    name: "never reads or indexes a private channel",
    run: async () => {
      await reset();
      await liveMessage("G1", "group", "Confidential: echidna merger talks resume next week");
      await Bun.sleep(1000);
      const s = await stats();
      if (s.readChannels.includes("G1")) return "read the private channel's history";
      const a = await ask("echidna merger talks");
      return a.cite?.startsWith("slack:G1") ? `cited ${a.cite}` : null;
    },
  },
  {
    name: "stays silent in a DM",
    run: async () => {
      await reset();
      await sendEvent(mention("D1", { channel_type: "im" }));
      await Bun.sleep(1500);
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `ran anyway: ${JSON.stringify(s)}` : null;
    },
  },
  {
    name: "stays silent in a private channel",
    run: async () => {
      await reset();
      await sendEvent(mention("G1", { channel_type: "group" }));
      await Bun.sleep(1500);
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `ran anyway: ${JSON.stringify(s)}` : null;
    },
  },
  {
    name: "stays silent on a mention outside the channel allowlist",
    run: async () => {
      await reset();
      await sendEvent(mention("C9")); // app_mention carries no channel_type
      await Bun.sleep(1500);
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `ran anyway: ${JSON.stringify(s)}` : null;
    },
  },
  {
    name: "answers a Slack redelivery only once",
    run: async () => {
      await reset();
      const event = mention(ALLOWED);
      const eventId = `EvRedeliver${Date.now()}`;
      const a = await sendEvent(event, { eventId });
      const b = await sendEvent(event, { eventId, retry: "1" });
      await Bun.sleep(3500);
      const s = await stats();
      if (a.status !== 200 || b.status !== 200) return `acks ${a.status}/${b.status}, want 200/200`;
      return s.byMethod["chat.startStream"] === 1 ? null : `startStream ×${s.byMethod["chat.startStream"] ?? 0}, want 1`;
    },
  },
  {
    name: "rejects a bad signature with 401",
    run: async () => {
      const r = await sendEvent(mention(ALLOWED), { badSig: true });
      return r.status === 401 ? null : `got ${r.status}`;
    },
  },
  {
    name: "echoes Slack's url_verification challenge",
    run: async () => {
      const body = JSON.stringify({ type: "url_verification", challenge: "conformance-challenge" });
      const now = String(Math.floor(Date.now() / 1000));
      const sig = "v0=" + createHmac("sha256", SECRET).update(`v0:${now}:${body}`).digest("hex");
      const r = await fetch(TARGET, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": now, "x-slack-signature": sig }, body });
      const text = await r.text();
      return r.status === 200 && text.includes("conformance-challenge") ? null : `got ${r.status} ${text.slice(0, 80)}`;
    },
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

const mock = Bun.spawn(["bun", join(HERE, "mock.ts")], {
  env: { ...process.env, PORT: String(MOCK_PORT), TTFT_MS: "50", TOKEN_DELAY_MS: "2", SLACK_FIXTURES: join(HERE, "fixtures/slack-history.json") },
  stdout: "ignore",
  stderr: "inherit",
});
const app = Bun.spawn(APP_CMD, {
  // An external app runs from its own directory, so a binary that quietly reads files
  // from this repo (prompts, migrations) fails here instead of passing by accident.
  cwd: appIdx >= 0 ? dirname(APP_CMD[0]!) : ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-conformance",
    SLACK_API_URL: `${MOCK}/slack/api`,
    ANTHROPIC_API_KEY: "conformance",
    ANTHROPIC_BASE_URL: `${MOCK}/anthropic`,
    AGENT_CHANNELS: ALLOWED,
    KNOWLEDGE_SEED: join(HERE, "fixtures/corpus.jsonl"),
    LOREHOUSE_DB: ":memory:",
    // Fixture timestamps are fixed, so backfill far enough back that they never age out.
    INGEST_BACKFILL_DAYS: "36500",
    INGEST_DEBOUNCE_MS: "200",
  },
  stdout: "ignore",
  stderr: "pipe",
});
const stop = () => { app.kill(); mock.kill(); };

let failed = 0;
try {
  if (!(await waitHttp(`${MOCK}/stats`, 5000))) throw new Error("mock never came up");
  if (!(await waitHttp(`http://localhost:${APP_PORT}/healthz`, 15000))) throw new Error(`app never answered /healthz\n${await new Response(app.stderr).text()}`);
  const owners = await listenerPids(APP_PORT);
  if (!owners.includes(String(app.pid))) throw new Error(`:${APP_PORT} is held by ${owners.join(",")}, not the app under test (${app.pid})`);
  // Scenarios assume the Slack backfill has finished; the app reports it at /status.
  const t0 = Date.now();
  while ((await status().catch(() => undefined))?.knowledge.state !== "ready") {
    if (Date.now() - t0 > 15000) throw new Error(`ingest never became ready: ${JSON.stringify(await status().catch((e) => String(e)))}`);
    await Bun.sleep(50);
  }

  for (const s of scenarios) {
    const t0 = Date.now();
    const why = await s.run().catch((e) => String(e));
    if (why) failed++;
    console.log(`${why ? "✗" : "✓"} ${s.name} (${Date.now() - t0} ms)${why ? `\n    ${why}` : ""}`);
  }
} catch (e) {
  failed++;
  console.log(`✗ setup: ${e instanceof Error ? e.message : e}`);
} finally {
  stop();
}
console.log(failed ? `\n${failed} failed` : `\nall ${scenarios.length} scenarios passed`);
process.exit(failed ? 1 : 0);
