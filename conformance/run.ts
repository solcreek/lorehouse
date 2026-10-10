// run.ts — the behavioral contract. Black-box: it only speaks HTTP to the app and reads
// what a mocked Slack + Anthropic observed. Any implementation, in any language, that
// passes this is interchangeable with the one in this repo.
//
//   bun conformance/run.ts                        # runs `bun src/server.ts`
//   bun conformance/run.ts --app ./dist/lorehouse # or any executable
//   bun conformance/run.ts --only usage           # only scenarios named like it (select.ts)
//
// The app is configured with env: PORT, SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN,
// SLACK_API_URL, ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, AGENT_CHANNELS, KNOWLEDGE_SEED,
// LOREHOUSE_DB, INGEST_BACKFILL_DAYS, INGEST_REFRESH_DAYS, INGEST_DEBOUNCE_MS,
// STATUS_TOKEN, ADMIN_TOKEN, LOREHOUSE_ENV_FILE (a missing file, so no installed settings
// leak in), and per scenario DM_MODE, SANDBOX_RUNNER_TOKEN, GITHUB_TOKEN
// and GITHUB_API_URL (GitHub's REST API, mocked). SESSIONS_DB is never set: the app
// keeps its sessions in a file beside LOREHOUSE_DB, so they survive a restart. It must answer GET /healthz (open)
// once listening, and GET /status with { knowledge: { state: "ready", … } } once its Slack
// backfill is done, but only to `Authorization: Bearer <STATUS_TOKEN>` (401 otherwise;
// 404 when STATUS_TOKEN is unset). The admin API under /api/v1 (docs/admin-api.md) answers
// only to ADMIN_TOKEN, the same way.

import { $ } from "bun";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pollRunner, wsRunner } from "./fake-runner";
import { parseArgs, selectScenarios, UsageError, type Args } from "./select";

const ROOT = join(import.meta.dir, "..");
const HERE = import.meta.dir;
// A bad command line exits 2 before anything starts.
const orExit2 = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`conformance: ${e.message}`);
    process.exit(2);
  }
};
const ARGS: Args = orExit2(() => parseArgs(process.argv.slice(2)));
// Absolute, because an external app runs with its own directory as cwd (see below).
const APP_CMD = ARGS.app ? [resolve(ARGS.app)] : ["bun", join(ROOT, "src/server.ts")];

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

type Block = { type: string; elements?: { type: string; text?: { text: string }; action_id?: string; value?: string }[] };
type Stats = {
  slackCalls: number; modelCalls: number; byMethod: Record<string, number>; readChannels: string[];
  posts: { channel: string; thread_ts?: string; text: string; blocks?: Block[]; ts: string }[];
  updates: { channel: string; ts: string; text: string }[];
  github: { method: string; path: string; body?: unknown }[];
};
const stats = async () => (await (await fetch(`${MOCK}/stats`)).json()) as Stats;
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

type Usage = {
  since: string; asks: number; channels: number; threads: number;
  emptySearches: { threads: number; of: number; queries: string[] };
  feedback: { up: number; down: number; raters: number; downMessages: { channel: string; ts: string }[] };
};
type Status = { agent: string; knowledge: { state: string; documents: number; channels: Record<string, { cursor?: string; threads: number }>; reconciled: { refreshed: number; removed: number } } };
const STATUS_TOKEN = "conformance-status";
const APP = `http://localhost:${APP_PORT}`;
// Runner mode: sandbox hosts connect in (docs/sandbox-runners.md).
const RUNNER_TOKEN = "conformance-runner-token-000000000000";
const RUNNER_ENV = { SANDBOX_RUNNER_TOKEN: RUNNER_TOKEN, GITHUB_TOKEN: "conformance-github" };
const statusAs = (auth?: string) => fetch(`http://localhost:${APP_PORT}/status`, { headers: auth ? { authorization: auth } : {} });
const status = async () => (await (await statusAs(`Bearer ${STATUS_TOKEN}`)).json()) as Status;
// The admin API (docs/admin-api.md): message text, behind its own token.
const ADMIN_TOKEN = "conformance-admin-token-000000000000";
const adminAs = (path: string, auth: string | null = `Bearer ${ADMIN_TOKEN}`, init: RequestInit = {}) =>
  fetch(`http://localhost:${APP_PORT}${path}`, { ...init, headers: auth ? { authorization: auth } : {} });
const admin = async <T = Record<string, any>>(path: string) => (await (await adminAs(path)).json()) as T;
// Usage is the admin API's (who asked, what was searched), never /status's.
const usage = () => admin<Usage>("/api/v1/usage");
type DocumentList = { documents: { id: string; kind: string; source: string }[]; next: string | null };
// Every document id the admin API lists, page by page.
async function allDocumentIds(limit = 50): Promise<string[]> {
  const ids: string[] = [];
  let next: string | null = null;
  do {
    const page: DocumentList = await admin<DocumentList>(`/api/v1/documents?limit=${limit}${next ? `&cursor=${next}` : ""}`);
    ids.push(...page.documents.map((d) => d.id));
    next = page.next;
  } while (next);
  return ids;
}

// A mention that starts a new thread in the allowed channel; resolves once it's answered.
async function mentionAndWait(question: string, { inHistory = false } = {}): Promise<string> {
  const ts = `${1995000000 + ++seq}.000100`;
  const text = `<@UBOT> [q${seq}] ${question}`;
  // In Slack's history too, as a real mention is: a restart's reconcile then finds it still there.
  if (inHistory) await fetch(`${MOCK}/fixtures/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channel: ALLOWED, message: { ts, user: "U1", text } }) });
  await sendEvent({ type: "app_mention", user: "U1", team: "T1", text, ts, event_ts: ts, channel: ALLOWED });
  await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=15000`);
  return ts;
}

// A button click, as Slack's interactivity delivers one: form-encoded `payload=<json>`,
// signed like an event, to the same URL.
async function sendInteraction(payload: Record<string, unknown>) {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const now = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", SECRET).update(`v0:${now}:${body}`).digest("hex");
  return fetch(TARGET, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": now, "x-slack-signature": sig }, body });
}

// The first truthy value check() returns within ms, or undefined.
async function until<T>(check: () => Promise<T | undefined>, ms = 15000): Promise<T | undefined> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await check();
    if (v) return v;
    await Bun.sleep(50);
  }
  return undefined;
}

// A reply in a thread, as Slack delivers one: a `message` event with thread_ts.
async function threadReply(threadTs: string, text: string, extra: Record<string, unknown> = {}): Promise<void> {
  const ts = `${1995000000 + ++seq}.000100`;
  await sendEvent({ type: "message", channel: ALLOWED, channel_type: "channel", user: "U1", text, ts, event_ts: ts, thread_ts: threadTs, ...extra });
}

// How many answers were streamed since the last reset(), once things settle.
async function answersAfter(ms: number): Promise<number> {
  await Bun.sleep(ms);
  return (await stats()).byMethod["chat.stopStream"] ?? 0;
}

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

// Run a usage scenario from zero: the app restarted on a database of its own, deleted
// after, and then restarted on the usual one.
async function withFreshDb(run: () => Promise<string | null>, env: Record<string, string> = {}): Promise<string | null> {
  const db = freshDb();
  try {
    return await inMode({ ...env, LOREHOUSE_DB: db }, run);
  } finally {
    removeDb(db);
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

// null = pass, string = why it failed. `needs` names earlier scenarios whose leftovers this
// one checks; `--only` runs them first, so a scenario run alone is judged as in a full run.
type Scenario = { name: string; needs?: string[]; run: () => Promise<string | null> };

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
    name: "the admin API needs ADMIN_TOKEN: the status token doesn't open it, and it only reads",
    run: async () => {
      // It returns what people wrote; a monitor holding STATUS_TOKEN must not read it.
      for (const [auth, what] of [[null, "no token"], ["Bearer wrong", "a wrong token"], [`Bearer ${STATUS_TOKEN}`, "the status token"]] as const) {
        const r = await adminAs("/api/v1/documents", auth);
        if (r.status !== 401) return `${what}: got ${r.status}, want 401`;
        if ((await r.text()).includes("documents")) return `${what}: the refusal leaked documents`;
      }
      const post = await adminAs("/api/v1/documents", `Bearer ${ADMIN_TOKEN}`, { method: "POST" });
      if (post.status !== 405) return `POST: got ${post.status}, want 405`;
      const ok = await adminAs("/api/v1/documents");
      return ok.status === 200 ? null : `the admin token: got ${ok.status}, want 200`;
    },
  },
  {
    name: "the admin API is closed (404) when no ADMIN_TOKEN is set",
    run: () => inMode({ ADMIN_TOKEN: "" }, async () => {
      const r = await adminAs("/api/v1/documents");
      return r.status === 404 ? null : `got ${r.status}, want 404`;
    }),
  },
  {
    name: "the admin API lists every document /status counts, once, and serves a thread's text",
    run: async () => {
      const ids = await allDocumentIds(7); // small pages, so paging is exercised
      const counted = (await status()).knowledge.documents;
      if (ids.length !== counted) return `listed ${ids.length}, /status counts ${counted}`;
      if (new Set(ids).size !== ids.length) return "a document was listed twice";
      const doc = await admin<{ id: string; source: string; text: string }>(`/api/v1/documents/${WOMBAT_THREAD}`);
      if (!/wombat review/i.test(doc.text ?? "")) return `the wombat thread's text: ${JSON.stringify(doc.text)?.slice(0, 80)}`;
      return doc.source === "https://acme.slack.com/archives/C1/p1790000001000100" ? null : `source ${doc.source}`;
    },
  },
  {
    name: "the admin API's search finds what the agent finds, in Chinese too",
    run: async () => {
      const { results } = await admin<{ results: { id: string }[] }>(`/api/v1/search?q=${encodeURIComponent("週會什麼時候開")}`);
      const want = "slack:C1:1790000065.000100";
      if (results[0]?.id !== want) return `top result ${results[0]?.id}, want ${want}`;
      const wombat = await admin<{ results: { id: string }[] }>("/api/v1/search?q=when%20is%20the%20quarterly%20wombat%20review");
      return wombat.results[0]?.id === WOMBAT_THREAD ? null : `top result ${wombat.results[0]?.id}, want ${WOMBAT_THREAD}`;
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
    name: "the admin API forgets deleted messages too: not served, listed or found",
    needs: ["forgets a deleted message: it is no longer cited or counted", "catches up after a restart on changes made while it was down"],
    run: async () => {
      // Deleted above: one live, and one (a pasted password) while the app was down.
      const ids = await allDocumentIds();
      for (const [doc, q] of [["slack:C1:1790000055.000100", "temporary emu vault code"], ["slack:C1:1790000010.000100", "staging database password rotates"]] as const) {
        const r = await adminAs(`/api/v1/documents/${doc}`);
        if (r.status !== 404) return `${doc}: got ${r.status}, want 404`;
        if (ids.includes(doc)) return `${doc} is still listed`;
        const { results } = await admin<{ results: { id: string }[] }>(`/api/v1/search?q=${encodeURIComponent(q)}`);
        if (results.some((x) => x.id === doc)) return `${doc} is still found by "${q}"`;
      }
      return null;
    },
  },
  {
    name: "carries on a thread it was asked into: a plain reply there is answered, without a new mention",
    run: async () => {
      const thread = await mentionAndWait("where is the wombat review");
      await reset();
      await threadReply(thread, "and which floor is that on?");
      const n = await answersAfter(2500);
      return n === 1 ? null : `answered the follow-up ${n}×, want once`;
    },
  },
  {
    name: "the admin API lists the threads the agent was asked into, newest first",
    run: async () => {
      const thread = await mentionAndWait("what is the wombat review about");
      const { threads } = await admin<{ threads: { channel: string; threadTs: string }[] }>("/api/v1/threads?limit=5");
      const first = threads[0];
      return first?.channel === ALLOWED && first.threadTs === thread ? null : `newest thread ${JSON.stringify(first)}, want ${ALLOWED} ${thread}`;
    },
  },
  {
    name: "stays out of threads it wasn't asked into, and of people talking to each other",
    run: async () => {
      const thread = await mentionAndWait("where is the wombat review");
      await reset();
      await threadReply(`${1995000000 + ++seq}.000100`, "unrelated thread, no mention"); // never asked in
      await threadReply(thread, "<@U2> what do you think?"); // someone else, in its own thread
      await liveMessage(ALLOWED, "channel", "a top-level message, no mention");
      const n = await answersAfter(2500);
      return n === 0 ? null : `answered ${n}×, want none`;
    },
  },
  {
    name: "a reply that mentions it in its own thread is answered once, not twice",
    run: async () => {
      // Slack sends such a reply both as a message and as an app_mention.
      const thread = await mentionAndWait("where is the wombat review");
      await reset();
      const ts = `${1995000000 + ++seq}.000100`;
      const text = "<@UBOT> and which floor is that on?";
      await sendEvent({ type: "message", channel: ALLOWED, channel_type: "channel", user: "U1", text, ts, event_ts: ts, thread_ts: thread });
      await sendEvent({ type: "app_mention", user: "U1", team: "T1", text, ts, event_ts: ts, thread_ts: thread, channel: ALLOWED });
      const n = await answersAfter(2500);
      return n === 1 ? null : `answered ${n}×, want once`;
    },
  },
  {
    name: "reports usage at GET /api/v1/usage: two asks in one thread are 2 asks, 1 thread, 1 channel; an answered DM is not counted",
    run: () => withFreshDb(async () => {
      const thread = await mentionAndWait("where is the wombat review"); // U1
      await threadReply(thread, "and which floor is that on?", { user: "U2" });
      const dm = await directMessage(`[q${++seq}] where is the wombat review`, { user: "U3" });
      await fetch(`${MOCK}/wait?thread_ts=${dm}&timeout_ms=15000`);
      await Bun.sleep(1000);
      const u = await usage();
      return u.asks === 2 && u.threads === 1 && u.channels === 1 ? null : `asks ${u.asks}, threads ${u.threads}, channels ${u.channels}; want 2, 1, 1`;
    }, { DM_MODE: "answer" }),
  },
  {
    name: "reports empty searches: the thread whose every search found nothing, and its query",
    run: () => withFreshDb(async () => {
      await mentionAndWait("where is the wombat review");
      await mentionAndWait("qxzv jjkw"); // no document has either word
      const { emptySearches } = await usage();
      return emptySearches.threads === 1 && emptySearches.of === 2 && JSON.stringify(emptySearches.queries) === JSON.stringify(["qxzv jjkw"])
        ? null
        : `emptySearches ${JSON.stringify(emptySearches)}, want 1 of 2 threads and the query "qxzv jjkw"`;
    }),
  },
  {
    name: "GET /status carries no usage: who asked and what was searched stay behind ADMIN_TOKEN",
    run: () => withFreshDb(async () => {
      await mentionAndWait("qxzv jjkw");
      const raw = await (await statusAs(`Bearer ${STATUS_TOKEN}`)).text();
      if (raw.includes("usage") || raw.includes("qxzv")) return `/status holds usage: ${raw.slice(0, 160)}`;
      const r = await adminAs("/api/v1/usage", `Bearer ${STATUS_TOKEN}`);
      if (r.status !== 401) return `the status token on /api/v1/usage: got ${r.status}, want 401`;
      return (await usage()).emptySearches.queries.includes("qxzv jjkw") ? null : "the admin API doesn't have the query either";
    }),
  },
  {
    name: "by default usage never says who asked: no people or askers, and /status says it doesn't record them",
    run: () => withFreshDb(async () => {
      await mentionAndWait("where is the wombat review");
      const u = (await usage()) as Usage & Record<string, unknown>;
      if (u.asks !== 1) return `asks ${u.asks}, want 1`;
      if ("people" in u || "askers" in u) return `usage names people: ${JSON.stringify(u).slice(0, 160)}`;
      const s = (await status()) as unknown as { recordsWhoAsks?: boolean };
      return s.recordsWhoAsks === false ? null : `/status recordsWhoAsks ${s.recordsWhoAsks}, want false`;
    }),
  },
  {
    name: "USAGE_RECORD_PEOPLE=1 records who asks and says so in the channel, once; turned off, it says so and erases them",
    run: async () => {
      const db = freshDb();
      const notices = async () => (await stats()).posts.filter((p) => p.channel === ALLOWED && !p.thread_ts).map((p) => p.text);
      type People = Usage & { people?: number; askers?: { user: string; asks: number }[] };
      const restart = async (env: Record<string, string>) => { await stopApp(); await reset(); await startApp({ LOREHOUSE_DB: db, ...env }); };
      try {
        await restart({ USAGE_RECORD_PEOPLE: "1" });
        if (!(await notices()).some((t) => t.includes("I now record who asks me things"))) return `turned on, the channel wasn't told: ${JSON.stringify(await notices())}`;
        await mentionAndWait("where is the wombat review", { inHistory: true }); // U1, still in Slack after restarts
        let u = (await usage()) as People;
        if (u.people !== 1 || u.askers?.[0]?.user !== "U1" || u.askers[0].asks !== 1) return `on: people ${u.people}, askers ${JSON.stringify(u.askers)}; want U1 with 1 ask`;
        if (!((await status()) as unknown as { recordsWhoAsks?: boolean }).recordsWhoAsks) return "on: /status recordsWhoAsks isn't true";
        await restart({ USAGE_RECORD_PEOPLE: "1" });
        if ((await notices()).length) return `a restart told the channel again: ${JSON.stringify(await notices())}`;
        await restart({});
        if (!(await notices()).some((t) => t.includes("I no longer record who asks me things"))) return `turned off, the channel wasn't told: ${JSON.stringify(await notices())}`;
        u = (await usage()) as People;
        if ("people" in u || u.asks !== 1) return `off: ${JSON.stringify(u).slice(0, 160)}; want the ask and no people`;
        await restart({ USAGE_RECORD_PEOPLE: "1" });
        u = (await usage()) as People;
        return u.people === 0 ? null : `on again: people ${u.people}, want 0 (the askers were erased when it was off)`;
      } finally {
        await stopApp();
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    name: "forgets in usage a question deleted while it was down; one still in Slack stays",
    run: async () => {
      const db = freshDb();
      try {
        await stopApp();
        await startApp({ LOREHOUSE_DB: db });
        const kept = await mentionAndWait("where is the wombat review", { inHistory: true });
        const gone = await mentionAndWait("qxzv jjkw", { inHistory: true });
        const before = await usage();
        if (before.asks !== 2 || !before.emptySearches.queries.includes("qxzv jjkw")) return `before: ${JSON.stringify(before).slice(0, 200)}`;
        await stopApp();
        await post("/fixtures/delete", { channel: ALLOWED, ts: gone }); // deleted while down: no event
        await startApp({ LOREHOUSE_DB: db });
        const after = await usage();
        if (after.asks !== 1) return `after the restart: asks ${after.asks}, want 1 (the deleted one forgotten, ${kept} kept)`;
        return after.emptySearches.queries.includes("qxzv jjkw") ? "the deleted question's search is still listed" : null;
      } finally {
        await stopApp();
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    name: "forgets a deleted question in usage: its ask, and as a thread root, the searches run for it",
    run: () => withFreshDb(async () => {
      const ts = await mentionAndWait("qxzv jjkw");
      const before = await usage();
      if (before.asks !== 1 || !before.emptySearches.queries.includes("qxzv jjkw")) return `before deleting: ${JSON.stringify(before)}`;
      const now = `${1990000000 + ++seq}.000100`;
      await sendEvent({ type: "message", subtype: "message_deleted", hidden: true, channel: ALLOWED, channel_type: "channel", ts: now, event_ts: now, deleted_ts: ts, previous_message: { ts } });
      await Bun.sleep(500);
      const after = await usage();
      return after.asks === 0 && after.emptySearches.of === 0 && after.emptySearches.queries.length === 0 ? null : `after deleting: ${JSON.stringify(after)}`;
    }),
  },
  {
    name: "counts a 👎 on its own reply as feedback, not one on a person's message or outside the allowlist, and answers no reaction",
    run: async () => {
      await reset();
      const reaction = (type: string, extra: Record<string, unknown> = {}) => {
        const ts = `${1995000000 + ++seq}.000100`;
        return { type, user: "U2", reaction: "-1", item_user: "UBOT", item: { type: "message", channel: ALLOWED, ts: "1995000001.000100" }, event_ts: ts, ...extra };
      };
      const down = async () => { await Bun.sleep(500); return (await usage()).feedback.down; };
      const before = await down();
      await sendEvent(reaction("reaction_added"));
      let now = await down();
      if (now !== before + 1) return `a 👎 on its reply: down ${now}, want ${before + 1}`;
      await sendEvent(reaction("reaction_removed"));
      now = await down();
      if (now !== before) return `the 👎 taken back: down ${now}, want ${before}`;
      await sendEvent(reaction("reaction_added", { item_user: "U1" })); // a person's message
      await sendEvent(reaction("reaction_added", { item: { type: "message", channel: "C9", ts: "1995000001.000100" } })); // not allowlisted
      now = await down();
      if (now !== before) return `down ${now}, want ${before}: counted a 👎 on a person's message or outside the allowlist`;
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `a reaction got a response: ${JSON.stringify(s)}` : null;
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
    name: "sandbox runners: the endpoints refuse a missing token or runner name; a plain GET isn't an upgrade",
    run: () => inMode(RUNNER_ENV, async () => {
      const post = (headers: Record<string, string>) => fetch(`${APP}/runners/poll`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ capacity: 1, running: 0 }) });
      const noToken = await post({ "x-lorehouse-runner": "r1" });
      if (noToken.status !== 401) return `no token: got ${noToken.status}, want 401`;
      const wrong = await post({ authorization: "Bearer wrong", "x-lorehouse-runner": "r1" });
      if (wrong.status !== 401) return `a wrong token: got ${wrong.status}, want 401`;
      const noName = await post({ authorization: `Bearer ${RUNNER_TOKEN}` });
      if (noName.status !== 400) return `no runner name: got ${noName.status}, want 400`;
      // A malformed job list is refused whole, never read as an empty (authoritative) one.
      for (const bad of [{ jobs: [1, 2] }, { jobs: "j_1" }, { received: [null] }]) {
        const r = await fetch(`${APP}/runners/poll`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${RUNNER_TOKEN}`, "x-lorehouse-runner": "r1" }, body: JSON.stringify({ capacity: 1, running: 0, ...bad }) });
        if (r.status !== 400) return `a status with ${JSON.stringify(bad)}: got ${r.status}, want 400`;
      }
      const plain = await fetch(`${APP}/runners/connect`, { headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "x-lorehouse-runner": "r1" } });
      return plain.status === 426 ? null : `a GET without an upgrade: got ${plain.status}, want 426 (so a runner knows to fall back to long poll)`;
    }),
  },
  {
    name: "sandbox runners over WebSocket: a command reaches the runner and its output reaches the model; with no runner, the model is told",
    run: () => inMode(RUNNER_ENV, async () => {
      const none = await ask("[exec] echo hi");
      if (!/\[toolerror:[^\]]*no sandbox runner is connected/.test(none.text)) return `with no runner: ${none.text.slice(0, 160)}`;
      const runner = await wsRunner(APP, RUNNER_TOKEN, "r-ws");
      try {
        const a = await ask("[exec] echo hi");
        if (!a.text.includes("[exec:0:ran:echo hi]")) return `answer ${a.text.slice(0, 160)}, want the runner's output`;
        if (!/^slack_C1_\d+\.\d+$/.test(runner.jobs[0]?.sandbox ?? "")) return `the job's sandbox ${runner.jobs[0]?.sandbox}, want one per thread (slack_C1_<ts>)`;
        const listed = (await status() as unknown as { runners?: { runner: string; transport: string; online: boolean }[] }).runners;
        return listed?.some((r) => r.runner === "r-ws" && r.transport === "ws" && r.online) ? null : `/status runners ${JSON.stringify(listed)}`;
      } finally {
        await runner.stop();
      }
    }),
  },
  {
    name: "sandbox runners over long poll: the same command, the same output",
    run: () => inMode(RUNNER_ENV, async () => {
      const runner = pollRunner(APP, RUNNER_TOKEN, "r-poll");
      try {
        await Bun.sleep(200); // the first poll registers the runner
        const a = await ask("[exec] echo hi");
        if (!a.text.includes("[exec:0:ran:echo hi]")) return `answer ${a.text.slice(0, 160)}, want the runner's output`;
        const listed = (await status() as unknown as { runners?: { runner: string; transport: string }[] }).runners;
        return listed?.some((r) => r.runner === "r-poll" && r.transport === "poll") ? null : `/status runners ${JSON.stringify(listed)}`;
      } finally {
        await runner.stop();
      }
    }),
  },
  {
    // ADR 0002 §8: sessions persist by default, so a restart (a deploy, a crash) between
    // the prompt and the click loses nothing.
    name: "a turn parked on Approve survives a restart: approved after it, the pull request opens and the turn completes",
    run: () => {
      const env = { ...RUNNER_ENV, GITHUB_API_URL: `${MOCK}/github` };
      return inMode(env, async () => {
        const runner = pollRunner(APP, RUNNER_TOKEN, "r-approve"); // keeps polling across the restart
        try {
          await Bun.sleep(200); // the first poll registers the runner
          await reset();
          const n = ++seq;
          const thread = `${1970000000 + n}.000100`;
          await sendEvent({ type: "app_mention", user: "U1", team: "T1", text: `<@UBOT> [q${n}] [pr] scout/conformance-approve`, ts: thread, event_ts: thread, channel: ALLOWED });
          const prompt = await until(async () => (await stats()).posts.find((p) => p.channel === ALLOWED && p.thread_ts === thread && p.blocks?.length));
          if (!prompt) return `no Approve/Deny prompt in the thread: ${JSON.stringify((await stats()).posts).slice(0, 300)}`;
          const approve = prompt.blocks!.flatMap((b) => b.elements ?? []).find((e) => e.type === "button" && e.text?.text === "Approve");
          if (!approve?.action_id) return `the prompt has no Approve button: ${JSON.stringify(prompt.blocks).slice(0, 300)}`;
          if ((await stats()).github.some((c) => c.method === "POST")) return "a pull request was opened before anyone approved";

          // A restart while the turn waits, as a deploy would do.
          await stopApp();
          await startApp(env);
          await reset();
          // The runner comes back on its next poll; a click before that finds its host
          // offline, which is a different scenario from this one.
          const back = await until(async () => ((await status()) as unknown as { runners?: { runner: string; online: boolean }[] }).runners?.some((r) => r.runner === "r-approve" && r.online));
          if (!back) return `after the restart the runner never came back: ${JSON.stringify(((await status()) as unknown as { runners?: unknown }).runners)}`;

          await sendInteraction({
            type: "block_actions", user: { id: "U1" }, team: { id: "T1" }, channel: { id: ALLOWED },
            message: { ts: prompt.ts, thread_ts: thread }, actions: [{ type: "button", action_id: approve.action_id, value: approve.value }],
          });
          const done = await until(async () => (await stats()).updates.find((u) => u.ts === prompt.ts && u.text.includes("[pr:")));
          if (!done) return `approved after the restart, the turn never finished: updates ${JSON.stringify((await stats()).updates).slice(0, 300)}`;
          if (!done.text.includes(`[q${n}] [pr:opened:https://github.com/acme/widgets/pull/7]`)) return `the turn ended with ${done.text.slice(0, 160)}, want the opened pull request`;
          const opened = (await stats()).github.filter((c) => c.method === "POST" && c.path === "/repos/acme/widgets/pulls");
          return opened.length === 1 ? null : `pull requests opened: ${opened.length}, want 1`;
        } finally {
          await runner.stop();
        }
      });
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

// Chosen before anything starts, so a pattern matching nothing fails at once.
const { run: selected, prerequisites } = orExit2(() => selectScenarios(scenarios, ARGS.only));
if (ARGS.only !== undefined) {
  const extra = prerequisites.size ? `, ${prerequisites.size} of them only because the others need them` : "";
  console.log(`--only ${JSON.stringify(ARGS.only)}: running ${selected.length} of ${scenarios.length} scenarios${extra}\n`);
}

const mock = Bun.spawn(["bun", join(HERE, "mock.ts")], {
  env: { ...process.env, PORT: String(MOCK_PORT), TTFT_MS: "50", TOKEN_DELAY_MS: "2", SLACK_FIXTURES: join(HERE, "fixtures/slack-history.json") },
  stdout: "ignore",
  stderr: "inherit",
});
// A file, not :memory:, so the restart scenario comes back to the same knowledge. Each
// database gets a directory of its own: SESSIONS_DB is left unset, so the app keeps its
// sessions beside it, and no two runs (or two databases in one run) share them.
const freshDb = () => join(mkdtempSync(join(tmpdir(), "lorehouse-conformance-")), "lorehouse.db");
const DB = freshDb();
const removeDb = (path = DB) => rmSync(dirname(path), { recursive: true, force: true });

let app: ReturnType<typeof Bun.spawn> | undefined;
// Never this shell's SESSIONS_DB: where sessions go by default is part of the contract.
// Nor its settings files, which the app reads after the environment and could fill
// SESSIONS_DB back in: LOREHOUSE_ENV_FILE points at a missing file beside the database
// (startApp), and LOREHOUSE_SETTINGS is left to its default, also beside the database.
const { SESSIONS_DB: _sessions, LOREHOUSE_ENV_FILE: _envFile, LOREHOUSE_SETTINGS: _settings, ...inherited } = process.env;

// Start the app and wait until it listens, owns its port, and (unless waitReady is off,
// for a start where /status is closed) has finished its Slack backfill/reconcile
// (GET /status → ready).
async function startApp(extraEnv: Record<string, string> = {}, { waitReady = true } = {}): Promise<void> {
  const proc = Bun.spawn(APP_CMD, {
    // An external app runs from its own directory, so a binary that quietly reads files
    // from this repo (prompts, migrations) fails here instead of passing by accident.
    cwd: ARGS.app ? dirname(APP_CMD[0]!) : ROOT,
    env: {
      ...inherited,
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
      ADMIN_TOKEN,
      LOREHOUSE_ENV_FILE: join(dirname(extraEnv.LOREHOUSE_DB ?? DB), "lorehouse.env"),
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

  for (const s of selected) {
    const t0 = Date.now();
    const why = await s.run().catch((e) => String(e));
    if (why) failed++;
    console.log(`${why ? "✗" : "✓"} ${s.name} (${Date.now() - t0} ms)${prerequisites.has(s) ? " [needed]" : ""}${why ? `\n    ${why}` : ""}`);
  }
} catch (e) {
  failed++;
  console.log(`✗ setup: ${e instanceof Error ? e.message : e}`);
} finally {
  await stopApp();
  mock.kill();
  removeDb();
}
// A filtered run never reads as a full one.
const skipped = scenarios.length - selected.length;
console.log(failed ? `\n${failed} failed` : skipped ? `\n${selected.length} of ${scenarios.length} scenarios passed (${skipped} not run: --only)` : `\nall ${scenarios.length} scenarios passed`);
process.exit(failed ? 1 : 0);
