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
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

const stats = async () => (await (await fetch(`${MOCK}/stats`)).json()) as { slackCalls: number; modelCalls: number; byMethod: Record<string, number>; readChannels: string[]; posts: { channel: string; thread_ts?: string; text: string }[] };
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

type Status = { agent: string; knowledge: { state: string; documents: number; channels: Record<string, { cursor?: string; threads: number }>; reconciled: { refreshed: number; removed: number } } };
const STATUS_TOKEN = "conformance-status";
const statusAs = (auth?: string) => fetch(`http://localhost:${APP_PORT}/status`, { headers: auth ? { authorization: auth } : {} });
const status = async () => (await (await statusAs(`Bearer ${STATUS_TOKEN}`)).json()) as Status;

// A person's DM to the bot, as Slack delivers it: a `message` event with channel_type
// "im" (a DM never produces an app_mention). Returns its ts.
async function directMessage(text: string, extra: Record<string, unknown> = {}): Promise<string> {
  const ts = `${1990000000 + ++seq}.000100`;
  await sendEvent({ type: "message", channel: "D1", channel_type: "im", user: "U1", text, ts, event_ts: ts, ...extra });
  return ts;
}

// Run a scenario with the app restarted under other settings, then restart it on the
// defaults, pass or fail, so later scenarios see the usual app.
async function inMode(env: Record<string, string>, run: () => Promise<string | null>): Promise<string | null> {
  await stopApp();
  await startApp(env);
  try {
    return await run();
  } finally {
    await stopApp();
    await startApp();
  }
}

// Post a message into Slack's history, then deliver the Events API event for it.
async function liveMessage(channel: string, channelType: string, text: string): Promise<string> {
  const ts = `${1980000000 + ++seq}.000100`;
  await fetch(`${MOCK}/fixtures/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel, message: { ts, user: "U6", text } }) });
  await sendEvent({ type: "message", channel, channel_type: channelType, user: "U6", text, ts, event_ts: ts });
  return ts;
}

const post = (path: string, body: unknown) => fetch(`${MOCK}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// Edit / delete a message in Slack's history; `announce` also delivers the event, as
// Slack would to a running app (off = the change happened while the app was down).
async function editMessage(channel: string, ts: string, text: string, announce = true): Promise<void> {
  const editedTs = `${1990000000 + ++seq}.000100`;
  await post("/fixtures/edit", { channel, ts, text, editedTs });
  if (announce) await sendEvent({ type: "message", subtype: "message_changed", hidden: true, channel, channel_type: "channel", ts: editedTs, event_ts: editedTs, message: { ts, user: "U7", text, edited: { user: "U7", ts: editedTs } }, previous_message: { ts } });
}
async function deleteMessage(channel: string, ts: string, announce = true): Promise<void> {
  await post("/fixtures/delete", { channel, ts });
  const now = `${1990000000 + ++seq}.000100`;
  if (announce) await sendEvent({ type: "message", subtype: "message_deleted", hidden: true, channel, channel_type: "channel", ts: now, event_ts: now, deleted_ts: ts, previous_message: { ts } });
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
      // The search contract: the same question must surface the same top chunk. Only
      // questions with a clear winner are pinned. "how does the built in mcp server work"
      // is asked but not pinned: its top two (c16, c174) are within 0.0002 bm25, so any
      // legitimate change to corpus statistics (a new fixture document, CJK bigrams)
      // flips them. The closest pinned question has a margin above 0.1.
      const expected = (await Bun.file(join(HERE, "fixtures/expected-cites.json")).json()) as Record<string, string>;
      const wrong = Object.entries(expected).filter(([q, id]) => r.cites[q] !== id);
      return wrong.length ? `top hit differs for ${wrong.length} question(s), e.g. "${wrong[0]![0]}": got ${r.cites[wrong[0]![0]]}, want ${wrong[0]![1]}` : null;
    },
  },
  {
    name: "reports ingest state and document count at GET /status",
    run: async () => {
      const s = await status();
      // seeds + wombat thread, password, ibex, emu and the Chinese message; the bot post and the join are not documents
      const want = SEED_DOCS + 5;
      if (s.knowledge.state !== "ready") return `state ${s.knowledge.state}, want ready`;
      return s.knowledge.documents === want ? null : `documents ${s.knowledge.documents}, want ${want}`;
    },
  },
  {
    name: "GET /status needs the bearer token; /healthz stays open",
    run: async () => {
      // /status names the channels it reads and when it last saw a message, so it is
      // closed to anyone without STATUS_TOKEN.
      for (const [auth, what] of [[undefined, "no token"], ["Bearer wrong", "a wrong token"], [STATUS_TOKEN, "the token without the Bearer scheme"]] as const) {
        const r = await statusAs(auth);
        if (r.status !== 401) return `${what}: got ${r.status}, want 401`;
        if ((await r.text()).includes("knowledge")) return `${what}: the refusal leaked the status`;
      }
      const ok = await statusAs(`Bearer ${STATUS_TOKEN}`);
      if (ok.status !== 200) return `the right token: got ${ok.status}, want 200`;
      const health = await fetch(`http://localhost:${APP_PORT}/healthz`);
      return health.status === 200 ? null : `/healthz: got ${health.status}, want 200`;
    },
  },
  {
    name: "GET /status is closed (404) when no STATUS_TOKEN is set",
    run: async () => {
      // A restart without the token: nothing to wait on /status for, so it waits on /healthz.
      await stopApp();
      await startApp({ STATUS_TOKEN: "" }, { waitReady: false });
      try {
        const r = await statusAs(`Bearer ${STATUS_TOKEN}`);
        return r.status === 404 ? null : `got ${r.status}, want 404`;
      } finally {
        await stopApp();
        await startApp();
      }
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
    name: "answers a question asked in Chinese from Chinese history",
    run: async () => {
      // CJK has no spaces between words: a whole sentence must not become one token
      const doc = "slack:C1:1790000065.000100";
      const a = await ask("週會什麼時候開");
      if (a.cite !== doc) return `cited ${a.cite}, want ${doc}`;
      const b = await ask("會議室在幾樓");
      return b.cite === doc ? null : `a word from the middle of the sentence: cited ${b.cite}, want ${doc}`;
    },
  },
  {
    name: "knows people by name: asking by name alone finds what they wrote or were named in",
    run: async () => {
      // "Wendy" appears in no message text; only users.info knows U2 is Wendy. Asked by
      // the name alone (no other word to match), so this fails when names aren't resolved.
      const wendys = [WOMBAT_THREAD, "slack:C1:1790000010.000100"]; // she wrote the first, is mentioned in the second
      const a = await ask("Wendy");
      return a.cite && wendys.includes(a.cite) ? null : `cited ${a.cite}, want one of ${wendys.join(", ")}`;
    },
  },
  {
    name: "knows people by their real name too, when it differs from their display name",
    run: async () => {
      // U2 displays as "Wendy"; only her real name, "Wendy Wu", has "Wu". A speaker is
      // labeled "Wendy (Wendy Wu)", so her own thread is found by "Wu"; a thread that only
      // mentions her is not (mentions use the display name).
      const a = await ask("Wu");
      return a.cite === WOMBAT_THREAD ? null : `cited ${a.cite}, want ${WOMBAT_THREAD}`;
    },
  },
  {
    name: "looking up someone the question mentions, it gets the one name knowledge uses",
    run: async () => {
      // The question arrives as Slack's raw text, so a person it mentions is a <@U…> the
      // model must look up. Slack's users.info gives a handle, a display and a real name;
      // the model gets the single name the rest of knowledge uses for that person.
      const { text } = await ask("[whois] what did <@U2> say about the review");
      const got = text.match(/\[whois:(\{.*?\})\]/)?.[1];
      return got === JSON.stringify({ name: "Wendy (Wendy Wu)" }) ? null : `looked up ${got}, want {"name":"Wendy (Wendy Wu)"}`;
    },
  },
  {
    name: "answers an overview question from the most recently active thread",
    run: async () => {
      // "what's been discussed lately?" has no keywords to search for; the answer is the
      // newest threads. The newest fixture thread at this point is the Chinese message.
      const want = "slack:C1:1790000065.000100";
      const a = await ask("[recent] what has the team been discussing lately");
      return a.cite === want ? null : `cited ${a.cite}, want the newest thread ${want}`;
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
    name: "does not learn from questions put to the agent",
    run: async () => {
      // Slack delivers a mention as a `message` event too; it is a question, not knowledge.
      const ts = await liveMessage(ALLOWED, "channel", "<@UBOT> what is the pelican budget for next quarter?");
      await Bun.sleep(1000);
      const a = await ask("pelican budget next quarter");
      return a.cite === `slack:${ALLOWED}:${ts}` ? "cited the question itself as knowledge" : null;
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
    name: "reflects an edit: the new text is cited, the old text no longer is",
    run: async () => {
      const doc = "slack:C1:1790000050.000100";
      await editMessage("C1", "1790000050.000100", "The ibex standup moved to the falcon room");
      await Bun.sleep(1000);
      const now = await ask("which room is the ibex standup in falcon");
      if (now.cite !== doc) return `after the edit, cited ${now.cite}, want ${doc}`;
      // only the old text had "bluebird" (the new one still says "room", so don't ask that)
      const old = await ask("bluebird");
      return old.cite === doc ? "the edited-away text (bluebird) still cites the message" : null;
    },
  },
  {
    name: "forgets a deleted message: it is no longer cited or counted",
    run: async () => {
      const doc = "slack:C1:1790000055.000100";
      const before = await ask("temporary emu vault code");
      if (before.cite !== doc) return `before deleting, cited ${before.cite}, want ${doc}`;
      const docs = (await status()).knowledge.documents;
      await deleteMessage("C1", "1790000055.000100");
      await Bun.sleep(1000);
      const after = await ask("temporary emu vault code");
      if (after.cite === doc) return "the deleted message is still cited";
      const now = (await status()).knowledge.documents;
      return now === docs - 1 ? null : `documents ${docs} → ${now}, want ${docs - 1}`;
    },
  },
  {
    name: "catches up after a restart on changes made while it was down",
    run: async () => {
      await stopApp();
      // While down: a new reply to an old thread, and a message deleted outright.
      await post("/fixtures/messages", { channel: "C1", message: { ts: "1790000090.000100", thread_ts: "1790000001.000100", user: "U5", text: "The wombat review now covers the koala budget too" } });
      await deleteMessage("C1", "1790000010.000100", false);
      await startApp();
      const s = await status();
      if (s.knowledge.reconciled.refreshed < 1 || s.knowledge.reconciled.removed < 1) return `reconciled ${JSON.stringify(s.knowledge.reconciled)}, want ≥1 refreshed and ≥1 removed`;
      const reply = await ask("koala budget");
      if (reply.cite !== WOMBAT_THREAD) return `the reply added while down: cited ${reply.cite}, want ${WOMBAT_THREAD}`;
      const gone = await ask("staging database password rotates");
      return gone.cite === "slack:C1:1790000010.000100" ? "the message deleted while down is still cited" : null;
    },
  },
  {
    name: "points a DM to the public channel: one reply, no model call, nothing read or indexed (DM_MODE=redirect, the default)",
    run: async () => {
      await reset();
      const docs = (await status()).knowledge.documents;
      await directMessage("where is the wombat review?");
      await Bun.sleep(1500);
      const s = await stats();
      if (s.modelCalls) return `called the model ${s.modelCalls}×`;
      if (s.posts.length !== 1 || s.posts[0]!.channel !== "D1" || !s.posts[0]!.text.includes(`<#${ALLOWED}>`)) return `posts ${JSON.stringify(s.posts)}, want one in D1 linking <#${ALLOWED}>`;
      if (s.readChannels.includes("D1")) return "read the DM's history";
      return (await status()).knowledge.documents === docs ? null : "indexed the DM";
    },
  },
  {
    name: "does not answer its own reply in a DM, or an edit there",
    run: async () => {
      await reset();
      await directMessage("I only answer in public…", { bot_id: "BBOT", user: "UBOT" });
      await directMessage("", { subtype: "message_changed" });
      await Bun.sleep(1500);
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `ran anyway: ${JSON.stringify(s)}` : null;
    },
  },
  {
    name: "DM_MODE=ignore: a DM gets nothing at all",
    run: () => inMode({ DM_MODE: "ignore" }, async () => {
      await reset();
      await directMessage("where is the wombat review?");
      await Bun.sleep(1500);
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `ran anyway: ${JSON.stringify(s)}` : null;
    }),
  },
  {
    name: "DM_MODE=answer: a DM is answered from public knowledge, a channel message still starts no turn",
    run: () => inMode({ DM_MODE: "answer" }, async () => {
      const docs = (await status()).knowledge.documents;
      await reset();
      // a public-channel message without a mention: knowledge only, never a turn
      await liveMessage(ALLOWED, "channel", "the platypus offsite is in march");
      await Bun.sleep(1500);
      if ((await stats()).modelCalls) return "a channel message started a turn";
      const ts = await directMessage(`[q${++seq}] when does the quarterly wombat review happen`);
      const { text = "" } = (await (await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=15000`)).json()) as { text?: string };
      const cite = text.match(/\[cite:([^\]\s]+)\]/)?.[1];
      if (cite !== WOMBAT_THREAD) return `the DM's answer cited ${cite}, want ${WOMBAT_THREAD}`;
      if ((await stats()).readChannels.includes("D1")) return "read the DM's history";
      // the channel message above is new knowledge (+1); the DM is not
      return (await status()).knowledge.documents === docs + 1 ? null : `documents ${docs} → ${(await status()).knowledge.documents}, want ${docs + 1}`;
    }),
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
  {
    // Last: it adds the newest thread to Slack's history, which earlier scenarios would see.
    name: "reading the thread it was asked in, it sees who wrote each message by name",
    run: async () => {
      // A thread's raw replies carry only user ids. Given an id it can't name while
      // search results name people, a model guesses who wrote what; the author must
      // arrive named, and mentions must read as names.
      const root = `${1985000000 + ++seq}.000100`;
      await post("/fixtures/messages", { channel: ALLOWED, message: { ts: root, user: "U2", text: "<@U3> can you check the heron budget" } });
      const ts = `${1985000000 + ++seq}.000100`;
      await sendEvent({ type: "app_mention", user: "U1", team: "T1", text: `<@UBOT> [q${seq}] [thread] who asked about the heron budget`, ts, event_ts: ts, thread_ts: root, channel: ALLOWED });
      const { text = "" } = (await (await fetch(`${MOCK}/wait?thread_ts=${root}&timeout_ms=15000`)).json()) as { text?: string };
      const author = text.match(/\[author:([^\]]*)\]/)?.[1];
      const said = text.match(/\[text:([^\]]*)\]/)?.[1];
      if (author !== "Wendy (Wendy Wu)") return `author ${JSON.stringify(author)}, want "Wendy (Wendy Wu)"`;
      return said === "@Omar Ortiz can you check the heron budget" ? null : `text ${JSON.stringify(said)}, want mentions as names`;
    },
  },
];

// ── run ─────────────────────────────────────────────────────────────────────

const mock = Bun.spawn(["bun", join(HERE, "mock.ts")], {
  env: { ...process.env, PORT: String(MOCK_PORT), TTFT_MS: "50", TOKEN_DELAY_MS: "2", SLACK_FIXTURES: join(HERE, "fixtures/slack-history.json") },
  stdout: "ignore",
  stderr: "inherit",
});
// A file, not :memory:, so the restart scenario comes back to the same knowledge.
const DB = join(tmpdir(), `lorehouse-conformance-${process.pid}.db`);
const removeDb = () => { for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true }); };
removeDb();

let app: ReturnType<typeof Bun.spawn> | undefined;

// Start the app and wait until it listens, owns its port, and (unless waitReady is off,
// for a start where /status is closed) has finished its Slack backfill/reconcile
// (GET /status → ready).
async function startApp(extraEnv: Record<string, string> = {}, { waitReady = true } = {}): Promise<void> {
  const proc = Bun.spawn(APP_CMD, {
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
      LOREHOUSE_DB: DB,
      // Fixture timestamps are fixed, so look back far enough that they never age out.
      INGEST_BACKFILL_DAYS: "36500",
      INGEST_REFRESH_DAYS: "36500",
      INGEST_DEBOUNCE_MS: "200",
      STATUS_TOKEN,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  app = proc;
  if (!(await waitHttp(`http://localhost:${APP_PORT}/healthz`, 15000))) throw new Error(`app never answered /healthz\n${await new Response(proc.stderr as ReadableStream).text()}`);
  const owners = await listenerPids(APP_PORT);
  if (!owners.includes(String(proc.pid))) throw new Error(`:${APP_PORT} is held by ${owners.join(",")}, not the app under test (${proc.pid})`);
  if (!waitReady) return;
  const t0 = Date.now();
  while ((await status().catch(() => undefined))?.knowledge.state !== "ready") {
    if (Date.now() - t0 > 15000) throw new Error(`ingest never became ready: ${JSON.stringify(await status().catch((e) => String(e)))}`);
    await Bun.sleep(50);
  }
}

async function stopApp(): Promise<void> {
  if (!app) return;
  app.kill();
  await app.exited;
  app = undefined;
  // wait until the port is free, so the next start can't be answered by a dying process
  const t0 = Date.now();
  while ((await listenerPids(APP_PORT)).length && Date.now() - t0 < 5000) await Bun.sleep(20);
}

let failed = 0;
try {
  if (!(await waitHttp(`${MOCK}/stats`, 5000))) throw new Error("mock never came up");
  await startApp();

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
  await stopApp();
  mock.kill();
  removeDb();
}
console.log(failed ? `\n${failed} failed` : `\nall ${scenarios.length} scenarios passed`);
process.exit(failed ? 1 : 0);
