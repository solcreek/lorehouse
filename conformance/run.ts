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
// STATUS_TOKEN, ADMIN_TOKEN, TENANT_ID and LOREHOUSE_DATA_DIR (empty: unset, except in the
// scenarios about them), LOREHOUSE_ENV_FILE (a missing file, so no installed settings
// leak in), LOREHOUSE_SETTINGS (settings.json beside LOREHOUSE_DB), and per scenario DM_MODE, INGEST_CHANNEL_RECHECK_MS, SANDBOX_RUNNER_TOKEN, GITHUB_TOKEN,
// PR_APPROVER and GITHUB_API_URL (GitHub's REST API, mocked). SESSIONS_DB is never set: the app
// keeps its sessions in a file beside LOREHOUSE_DB, so they survive a restart. It must answer GET /healthz (open)
// once listening, and GET /status with { knowledge: { state: "ready", … } } once its Slack
// backfill is done, but only to `Authorization: Bearer <STATUS_TOKEN>` (401 otherwise;
// 404 when STATUS_TOKEN is unset), naming its tenant and data directory. The admin API under /api/v1 (docs/admin-api.md) answers
// only to ADMIN_TOKEN, the same way. On SIGTERM it must exit 0 within 5 s (one during
// start-up: once the start is through, without serving), and a deleted message's text
// must not stay in LOREHOUSE_DB's files (the -wal included).

import { $ } from "bun";
import { createHmac } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CHART_PNG, MIRRORS, pollRunner, wsRunner } from "./fake-runner";
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
  slackCalls: number; modelCalls: number; byMethod: Record<string, number>; readChannels: string[]; reactionChannels: string[];
  posts: { channel: string; thread_ts?: string; text: string; blocks?: Block[]; ts: string }[];
  updates: { channel: string; ts: string; text: string }[];
  responses: { path: string; text?: string; response_type?: string; replace_original?: boolean }[];
  github: { method: string; path: string; body?: unknown }[];
  uploads: { fileId: string; filename: string; length: number; bytes?: number; contentType?: string; head?: string; channel?: string; thread_ts?: string; title?: string }[];
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
type Status = { agent: string; knowledge: { state: string; documents: number; channels: Record<string, { cursor?: string; threads: number; closed?: string }>; reconciled: { refreshed: number; removed: number } } };
const STATUS_TOKEN = "conformance-status";
const APP = `http://localhost:${APP_PORT}`;
// Runner mode: sandbox hosts connect in (docs/sandbox-runners.md).
const RUNNER_TOKEN = "conformance-runner-token-000000000000";
const RUNNER_ENV = { SANDBOX_RUNNER_TOKEN: RUNNER_TOKEN, GITHUB_TOKEN: "conformance-github" };
// A tenant id (src/tenant.ts): what /status may name.
const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
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

// U1 asks for a pull request from `branch` in a new thread; resolves to the Approve/Deny
// card posted there, or why there is none. Needs code tools (RUNNER_ENV) and a runner.
type Card = { nonce: string; thread: string; prompt: Stats["posts"][number] };
async function prCard(branch: string, requester = "U1"): Promise<Card | string> {
  const n = ++seq;
  const thread = `${1970000000 + n}.000100`;
  await sendEvent({ type: "app_mention", user: requester, team: "T1", text: `<@UBOT> [q${n}] [pr] ${branch}`, ts: thread, event_ts: thread, channel: ALLOWED });
  const prompt = await until(async () => (await stats()).posts.find((p) => p.channel === ALLOWED && p.thread_ts === thread && p.blocks?.length));
  if (!prompt) return `no Approve/Deny prompt in the thread: ${JSON.stringify((await stats()).posts).slice(0, 300)}`;
  return { nonce: `[q${n}]`, thread, prompt };
}

// `user` clicks a button on the card, with a response_url of their own on the mock.
let clicks = 0;
async function click(user: string, card: Card, label: "Approve" | "Deny") {
  const button = card.prompt.blocks!.flatMap((b) => b.elements ?? []).find((e) => e.type === "button" && e.text?.text === label);
  if (!button?.action_id) throw new Error(`the prompt has no ${label} button: ${JSON.stringify(card.prompt.blocks).slice(0, 300)}`);
  await sendInteraction({
    type: "block_actions", user: { id: user }, team: { id: "T1" }, channel: { id: ALLOWED },
    message: { ts: card.prompt.ts, thread_ts: card.thread }, response_url: `${MOCK}/slack/response/${user}-${++clicks}`,
    actions: [{ type: "button", action_id: button.action_id, value: button.value }],
  });
}

// `user` clicks Approve, then Deny, on the card, and each is refused: a reply to them alone
// (ephemeral, beside the card), nothing pushed, no pull request, the card unchanged. Null
// when so, else why not. `who` names them in the message.
async function refusedFor(user: string, who: string, card: Card, runner: { jobs: { op: string }[] }): Promise<string | null> {
  for (const [i, button] of (["Approve", "Deny"] as const).entries()) {
    await click(user, card, button);
    const refused = await until(async () => {
      const r = (await stats()).responses.filter((x) => x.path.startsWith(`/slack/response/${user}-`));
      return r.length > i ? r[i] : undefined;
    });
    if (!refused) return `${who}'s ${button} got no reply of its own: responses ${JSON.stringify((await stats()).responses)}`;
    if (refused.response_type !== "ephemeral" || refused.replace_original !== false) return `the refusal of ${who}'s ${button} isn't ephemeral beside the card: ${JSON.stringify(refused)}`;
  }
  await Bun.sleep(300); // a click that was let through would have started pushing by now
  const after = await stats();
  if (runner.jobs.some((j) => j.op === "push")) return `${who}'s click pushed the branch`;
  if (after.github.some((c) => c.method === "POST")) return `${who}'s click opened a pull request`;
  if (after.updates.some((u) => u.ts === card.prompt.ts)) return `${who}'s click changed the card: ${JSON.stringify(after.updates).slice(0, 300)}`;
  return null;
}

// Exactly one push and one pull request since the last reset, the PR naming its approver
// by name (never by Slack id), or (approver null) nobody; null when so.
async function openedBy(runner: { jobs: { op: string }[] }, approver: string | null): Promise<string | null> {
  const pushes = runner.jobs.filter((j) => j.op === "push").length;
  if (pushes !== 1) return `pushes: ${pushes}, want 1`;
  const opened = (await stats()).github.filter((c) => c.method === "POST" && c.path === "/repos/acme/widgets/pulls");
  if (opened.length !== 1) return `pull requests opened: ${opened.length}, want 1`;
  const body = String((opened[0]!.body as { body?: string }).body);
  const want = approver ? `approved there by ${approver}.` : "approved there.";
  return body.includes(want) && !/U\d/.test(body) ? null : `the pull request's body ${JSON.stringify(body.slice(-160))}, want "${want}"`;
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

// A scenario across a restart on a database of its own: `setup` runs with the `before`
// settings and hands back the check, which runs after a restart with the `after` ones.
// Then the usual app again. With no channels there is no ingest, so /status never says
// ready: that start waits on /healthz (the start-up purge is done before the app listens).
async function withRestart(
  before: Record<string, string>,
  after: Record<string, string>,
  setup: () => Promise<() => Promise<string | null>>,
): Promise<string | null> {
  const db = freshDb();
  try {
    await stopApp();
    await startApp({ ...before, LOREHOUSE_DB: db });
    const check = await setup();
    await stopApp();
    await startApp({ ...after, LOREHOUSE_DB: db }, { waitReady: after.AGENT_CHANNELS !== "" });
    return await check();
  } finally {
    await stopApp();
    removeDb(db);
    await startApp();
  }
}

// The agent asked into a thread of a second channel, REMOVED, which is then taken off
// AGENT_CHANNELS; `check` runs after the restart on the shorter list. The thread holds
// a word found nowhere else, so a search for it finds that thread or nothing.
const REMOVED = "C2";
async function withRemovedChannel(check: (t: { thread: string; word: string; listedThreads: number }) => Promise<string | null>): Promise<string | null> {
  const word = `quokka${++seq}`;
  const thread = `${1975000000 + ++seq}.000100`;
  const reply = `${1975000000 + ++seq}.000100`;
  await post("/fixtures/messages", { channel: REMOVED, message: { ts: thread, user: "U6", text: `where does the ${word} paddock budget live?` } });
  await post("/fixtures/messages", { channel: REMOVED, message: { ts: reply, thread_ts: thread, user: "U7", text: `the ${word} paddock budget is in the shared drive` } });
  return withRestart({ AGENT_CHANNELS: `${ALLOWED},${REMOVED}` }, { AGENT_CHANNELS: ALLOWED }, async () => {
    const ts = `${1975000000 + ++seq}.000100`;
    await sendEvent({ type: "app_mention", user: "U1", team: "T1", text: `<@UBOT> [q${seq}] where does the ${word} paddock budget live`, ts, event_ts: ts, thread_ts: thread, channel: REMOVED });
    await fetch(`${MOCK}/wait?thread_ts=${thread}&timeout_ms=15000`);
    // While listed, the thread is indexed and joined: what the restart must undo.
    const { results } = await admin<{ results: { id: string }[] }>(`/api/v1/search?q=${word}`);
    const { threads } = await admin<{ threads: { channel: string; threadTs: string }[] }>("/api/v1/threads?limit=50");
    const listedThreads = (await status()).knowledge.channels[ALLOWED]?.threads ?? 0;
    if (results[0]?.id !== `slack:${REMOVED}:${thread}`) return async () => `before the restart, "${word}" found ${JSON.stringify(results.map((x) => x.id))}, want slack:${REMOVED}:${thread}`;
    if (!threads.some((t) => t.channel === REMOVED && t.threadTs === thread)) return async () => `before the restart, ${REMOVED} ${thread} wasn't joined`;
    return () => check({ thread, word, listedThreads });
  });
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
    // ADR 0005 §2: the tenant id is in every key, path and log line, and /status names it
    // with the install's data directory. LOREHOUSE_DB is set here, so the data directory is
    // the one it names; the tenant is kept there (<dataDir>/<tenant>/tenant.json), and the
    // same one comes back after a restart.
    name: "GET /status names the tenant and the data directory, the same across a restart; the admin API names it too",
    run: async () => {
      const s = (await status()) as Status & { tenant?: unknown; dataDir?: unknown };
      if (typeof s.tenant !== "string" || !TENANT_ID.test(s.tenant)) return `/status tenant ${JSON.stringify(s.tenant)}, want an id like ${TENANT_ID}`;
      if (s.dataDir !== resolve(dirname(DB))) return `/status dataDir ${JSON.stringify(s.dataDir)}, want ${resolve(dirname(DB))}`;
      if (!existsSync(join(dirname(DB), s.tenant, "tenant.json"))) return `no ${s.tenant}/tenant.json in the data directory`;
      const docs = await admin("/api/v1/documents?limit=1");
      if (docs.tenant !== s.tenant) return `the admin API's tenant ${JSON.stringify(docs.tenant)}, /status's ${s.tenant}`;
      await stopApp();
      await startApp();
      const again = ((await status()) as Status & { tenant?: unknown }).tenant;
      return again === s.tenant ? null : `after a restart, tenant ${JSON.stringify(again)}, want ${s.tenant}`;
    },
  },
  {
    name: "TENANT_ID names the tenant /status reports; one that isn't 1–32 lowercase letters, digits or inner hyphens, or a new one beside another tenant's data, is refused at start",
    run: async () => {
      const r = await withFreshDb(async () => {
        const t = ((await status()) as Status & { tenant?: unknown }).tenant;
        return t === "acme-1" ? null : `/status tenant ${JSON.stringify(t)}, want "acme-1"`;
      }, { TENANT_ID: "acme-1" });
      if (r) return r;
      await stopApp();
      try {
        for (const bad of ["../etc", "Acme", "a.b"]) {
          const refused = await refusedStart({ TENANT_ID: bad });
          if (typeof refused === "string") return `TENANT_ID=${bad}: ${refused}`;
          if (!refused.stderr.includes("TENANT_ID (")) return `TENANT_ID=${bad}: stderr doesn't name TENANT_ID: ${refused.stderr.slice(0, 300)}`;
        }
        // A valid TENANT_ID new to a data directory holding another tenant's data (the
        // usual app's) would start on empty data: refused, naming the way to ask for it.
        const fresh = await refusedStart({ TENANT_ID: "acme-2" });
        if (typeof fresh === "string") return `TENANT_ID=acme-2 beside the usual tenant: ${fresh}`;
        if (!fresh.stderr.includes("acme-2 has no directory") || !fresh.stderr.includes("TENANT_NEW=1")) return `TENANT_ID=acme-2 beside the usual tenant: stderr ${fresh.stderr.slice(0, 300)}`;
        return null;
      } finally {
        await startApp();
      }
    },
  },
  {
    // An install laid out before tenants (the databases in the data directory, as
    // LOREHOUSE_DB named them) started with LOREHOUSE_DB unset and LOREHOUSE_DATA_DIR set:
    // the first start moves both databases into the tenant's directory, by rename, leaving a
    // symlink at each old path, and what they held comes along (a thread the agent was
    // asked into is the agent's own record, never rebuilt from Slack); a second start moves
    // nothing.
    name: "an install laid out before tenants moves into its tenant's directory on the first start, once, with what it holds",
    run: async () => {
      const db = freshDb();
      const dir = dirname(db);
      // LOREHOUSE_SETTINGS unset (empty): the app finds settings.json in the data directory
      // by itself, where it was before tenants.
      const tenantLayout = { LOREHOUSE_DB: "", LOREHOUSE_DATA_DIR: dir, LOREHOUSE_ENV_FILE: join(dir, "lorehouse.env"), LOREHOUSE_SETTINGS: "" };
      // A value only settings.json provides (the environment leaves PR_APPROVER unset), and
      // /status shows: read where the install kept it, before the move and after.
      writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { PR_APPROVER: "anyone" } }));
      const approver = async () => ((await status()) as Status & { pullRequestApprover?: string }).pullRequestApprover;
      const joined = async () => JSON.stringify((await admin("/api/v1/threads?limit=200")).threads ?? []);
      try {
        await stopApp();
        await startApp({ LOREHOUSE_DB: db });
        const ts = await mentionAndWait("where is the wombat review");
        const before = (await status()) as Status & { tenant?: string };
        if ((await approver()) !== "anyone") return `before: pullRequestApprover ${await approver()}, want "anyone" from ${join(dir, "settings.json")}`;
        if (!(await joined()).includes(ts)) return `before: the thread ${ts} isn't listed as joined`;
        if (!existsSync(db) || !existsSync(join(dir, "sessions.db"))) return "before: the databases aren't where LOREHOUSE_DB put them";
        for (let start = 1; start <= 2; start++) {
          await stopApp();
          await startApp(tenantLayout);
          const s = (await status()) as Status & { tenant?: string; dataDir?: string };
          const at = join(dir, before.tenant ?? "");
          if (s.tenant !== before.tenant) return `start ${start}: tenant ${s.tenant}, want ${before.tenant} (the one kept in the data directory)`;
          if (s.dataDir !== resolve(dir)) return `start ${start}: dataDir ${s.dataDir}, want ${resolve(dir)}`;
          for (const f of ["lorehouse.db", "sessions.db"]) {
            // Moved, and the old path left a symlink to it, so an older version still opens it.
            if (!lstatSync(join(at, f), { throwIfNoEntry: false })?.isFile()) return `start ${start}: no ${f} in ${at}`;
            const old = lstatSync(join(dir, f), { throwIfNoEntry: false });
            if (!old?.isSymbolicLink() || resolve(dir, readlinkSync(join(dir, f))) !== join(at, f)) return `start ${start}: ${join(dir, f)} isn't a symlink to ${join(at, f)}`;
          }
          if (!lstatSync(join(dir, "settings.json"), { throwIfNoEntry: false })?.isFile() || existsSync(join(at, "settings.json"))) return `start ${start}: settings.json isn't a file in the data directory alone`;
          if ((await approver()) !== "anyone") return `start ${start}: pullRequestApprover ${await approver()}, want "anyone": settings.json in the data directory wasn't read`;
          if (!(await joined()).includes(ts)) return `start ${start}: the thread the agent was asked into before the move is gone: ${(await joined()).slice(0, 200)}`;
          if (s.knowledge.documents !== before.knowledge.documents) return `start ${start}: ${s.knowledge.documents} documents, want ${before.knowledge.documents}`;
        }
        return null;
      } finally {
        await stopApp();
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    // #148: with the tenant's Strongroom set, its databases are encrypted under its data
    // key, the plaintext ones it had encrypted in place on that start; what was readable in
    // the files before isn't after. The key is kept only wrapped: a start without
    // Strongroom, or with the KMS key disabled or destroyed, fails instead of opening them.
    name: "with Strongroom set, the tenant's databases are encrypted at rest, and a start without the key fails",
    run: async () => {
      const db = freshDb();
      const dir = dirname(db);
      const keyed = { LOREHOUSE_DB: db, STRONGROOM_URL: MOCK, STRONGROOM_TOKEN: "s".repeat(32), STRONGROOM_KEY: "tenant" };
      // Every byte of both databases, -wal and -shm included.
      const onDisk = () => ["lorehouse.db", "sessions.db"].flatMap((f) => ["", "-wal", "-shm"].map((x) => join(dir, f + x))).filter((f) => existsSync(f)).map((f) => readFileSync(f).toString("latin1")).join("");
      const kms = (key: string) => fetch(`${MOCK}/fixtures/strongroom`, { method: "POST", body: JSON.stringify({ key }) });
      try {
        await stopApp();
        await startApp({ LOREHOUSE_DB: db });
        await mentionAndWait("where is the wombat review");
        const plain = (await status()) as Status & { encrypted?: boolean; tenant?: string };
        if (plain.encrypted !== false) return `plaintext start: /status encrypted ${plain.encrypted}, want false`;
        await stopApp();
        // The control: the seeded corpus and the question are readable on disk without a key.
        if (!onDisk().includes("scaffolder") || !onDisk().includes("wombat review")) return "plaintext start: the corpus or the question isn't in the files, so their absence below would prove nothing";
        await startApp(keyed);
        await mentionAndWait("where is the wombat review, again");
        const s = (await status()) as Status & { encrypted?: boolean };
        if (s.encrypted !== true) return `/status encrypted ${s.encrypted}, want true`;
        if (s.knowledge.documents !== plain.knowledge.documents) return `${s.knowledge.documents} documents after encrypting, want ${plain.knowledge.documents}`;
        const keyFile = join(dir, plain.tenant ?? "", "key.json");
        if (!existsSync(keyFile)) return `no ${keyFile}`;
        if (onDisk().includes("scaffolder") || onDisk().includes("wombat review")) return "encrypted: the corpus or a question is still readable in the files";
        await stopApp();
        if (onDisk().includes("scaffolder") || onDisk().includes("wombat review")) return "encrypted, after shutdown: the corpus or a question is readable in the files";
        const unkeyed = await refusedStart({ LOREHOUSE_DB: db });
        if (typeof unkeyed === "string") return `without Strongroom: ${unkeyed}`;
        if (!unkeyed.stderr.includes("files are encrypted")) return `without Strongroom: refused, but not for the key: ${unkeyed.stderr.slice(-300)}`;
        for (const state of ["disabled", "destroyed"]) {
          await kms(state);
          const r = await refusedStart(keyed);
          if (typeof r === "string") return `KMS key ${state}: ${r}`;
          if (!r.stderr.includes("KMS_KEY_UNAVAILABLE")) return `KMS key ${state}: refused, but not for the key: ${r.stderr.slice(-300)}`;
        }
        await kms("enabled");
        await startApp(keyed);
        const again = (await status()) as Status & { encrypted?: boolean };
        if (again.encrypted !== true || again.knowledge.documents !== plain.knowledge.documents) return `restarted with the key: encrypted ${again.encrypted}, ${again.knowledge.documents} documents`;
        return null;
      } finally {
        await kms("enabled");
        await stopApp();
        removeDb(db);
        await startApp();
      }
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
    name: "loads a skill: read_skill hands the model each skill's own instructions",
    run: async () => {
      // Skills are prompts/skills/*.md, embedded like the other prompts; the model asks for
      // one by name and must get its body, from source and from the compiled binary alike.
      const want: [string, string][] = [
        ["channel-digest", "Report what the company"],
        ["write-a-skill", "Draft a skill a"],
      ];
      for (const [name, start] of want) {
        const { text } = await ask(`[skill:${name}] help with this`);
        const got = text.match(/\[skill:([^\]]*)\]/)?.[1];
        if (got !== `${name}:${start}`) return `read_skill for ${name} gave ${JSON.stringify(got ?? text.slice(0, 120))}`;
      }
      return null;
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
    // Someone typed Slack's mention syntax as text (Slack delivers it escaped), so the
    // knowledge holds it; a model quoting the source must still ping nobody.
    name: "never @-mentions anyone: a quoted source's <!channel>, <!here>, <@U…> and <!subteam^…> reach Slack as plain names",
    run: async () => {
      const ts = await liveMessage(ALLOWED, "channel", "The quokka launch moved to May &lt;!channel&gt; &lt;!here|here&gt;, ask &lt;@U2&gt; or &lt;!subteam^S1|@launch-crew&gt;");
      await Bun.sleep(1000); // > INGEST_DEBOUNCE_MS
      const a = await ask("[quote] when is the quokka launch");
      if (a.cite !== `slack:${ALLOWED}:${ts}`) return `cited ${a.cite}, want slack:${ALLOWED}:${ts}`;
      if (!a.text.includes("[quote:")) return "the reply didn't quote its source";
      const live = a.text.match(/<[@!][^>]*>/g);
      if (live) return `the reply carries live mention markup: ${live.join(" ")}`;
      // Each name keeps its "@", with an invisible word joiner (U+2060) after it so no
      // Slack format can read it as a mention again.
      for (const name of ["channel", "here", "Wendy", "launch-crew"]) if (!a.text.includes(`@\u2060${name}`)) return `the reply lost the name @${name}: ${a.text.slice(0, 300)}`;
      return null;
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
    name: "reads a thread only in a channel it reads: asked for a DM's thread, it reads nothing there",
    run: async () => {
      // The model takes channel ids from what it reads, so a planted id must not pull a
      // DM or an unlisted channel into a public reply.
      await reset();
      const a = await ask("[thread:D1] what did they say");
      if (!a.text.includes("[toolerror:not a channel I read: D1]")) return `the model was told ${JSON.stringify(a.text.slice(0, 120))}`;
      return (await stats()).readChannels.includes("D1") ? "read the DM's thread" : null;
    },
  },
  {
    name: "lists reactions only in a channel it reads: asked for an unlisted channel's, it is refused and Slack is never asked",
    run: async () => {
      // June's slack_list_reactions names who reacted how; outside the allowlist that's
      // not the agent's to read (#83).
      await reset();
      const a = await ask("[reactions:C7] who reacted to the launch post");
      if (!a.text.includes("[toolerror:not a channel I read: C7]")) return `the model was told ${JSON.stringify(a.text.slice(0, 120))}`;
      const s = await stats();
      return s.reactionChannels.length ? `Slack was asked for reactions in ${s.reactionChannels.join(",")}` : null;
    },
  },
  {
    name: "lists reactions in a channel it reads: the model gets them",
    run: async () => {
      await reset();
      const a = await ask(`[reactions:${ALLOWED}] who reacted to the launch post`);
      if (!a.text.includes("[reactions:tada,eyes]")) return `the model was told ${JSON.stringify(a.text.slice(0, 120))}`;
      const s = await stats();
      return s.reactionChannels.join(",") === ALLOWED ? null : `Slack was asked for reactions in ${JSON.stringify(s.reactionChannels)}`;
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
    // #89: secure_delete (#65) clears the database file, but the WAL's earlier frames held
    // the text until a checkpoint truncated it, and a stop never ran one. A backup of the
    // directory carried what was deleted.
    name: "a deleted message leaves LOREHOUSE_DB's files, its -wal too; a stop (SIGTERM) exits 0 within 5 s and leaves none",
    run: async () => {
      const db = freshDb();
      const wal = `${db}-wal`;
      const copies = (file: string, word: string) => (existsSync(file) ? readFileSync(file).toString("latin1").split(word).length - 1 : 0);
      const inFiles = (word: string) => copies(db, word) + copies(wal, word);
      const until = async (ok: () => boolean | Promise<boolean>, ms = 5000) => {
        const t0 = Date.now();
        while (!(await ok())) {
          if (Date.now() - t0 > ms) return false;
          await Bun.sleep(50);
        }
        return true;
      };
      return inMode({ LOREHOUSE_DB: db }, async () => {
        // A message alone (its document is deleted), and a reply in a thread that stays (its
        // document is rewritten without it).
        const alone = `okapiwalone${++seq}`;
        const reply = `okapiwalreply${++seq}`;
        const aloneTs = await liveMessage(ALLOWED, "channel", `the okapi vault code is ${alone}, keep it here`);
        const root = await liveMessage(ALLOWED, "channel", "where is the okapi vault runbook?");
        const replyTs = `${1980000000 + ++seq}.000100`;
        const replyText = `the okapi runbook password is ${reply}`;
        await post("/fixtures/messages", { channel: ALLOWED, message: { ts: replyTs, thread_ts: root, user: "U7", text: replyText } });
        await sendEvent({ type: "message", channel: ALLOWED, channel_type: "channel", user: "U7", text: replyText, ts: replyTs, thread_ts: root, event_ts: replyTs });
        const found = async (word: string) => (await admin<{ results: { id: string }[] }>(`/api/v1/search?q=${word}`)).results.length > 0;
        if (!(await until(async () => (await found(alone)) && (await found(reply))))) return "the messages were never indexed";
        // What this checks is there to begin with: the files hold both words.
        if (!inFiles(alone) || !inFiles(reply)) return `before deleting, LOREHOUSE_DB's files hold ${inFiles(alone)}/${inFiles(reply)} copies; want some of each (the check below would prove nothing)`;
        await deleteMessage(ALLOWED, aloneTs);
        // A reply's deletion names its thread, as Slack's does.
        await post("/fixtures/delete", { channel: ALLOWED, ts: replyTs });
        const now = `${1990000000 + ++seq}.000100`;
        await sendEvent({ type: "message", subtype: "message_deleted", hidden: true, channel: ALLOWED, channel_type: "channel", ts: now, event_ts: now, deleted_ts: replyTs, previous_message: { ts: replyTs, thread_ts: root } });
        if (!(await until(async () => !(await found(alone)) && !(await found(reply))))) return "the deleted messages are still found";
        // Removed from the index; out of both files within seconds, while the app runs.
        if (!(await until(() => inFiles(alone) + inFiles(reply) === 0))) {
          return `while running, the deleted text is still in LOREHOUSE_DB's files: file ${copies(db, alone)}+${copies(db, reply)}, -wal ${copies(wal, alone)}+${copies(wal, reply)}`;
        }
        // Delete one more and stop straight away, before the checkpoint it asked for has run:
        // the stop must do it.
        const last = `okapiwallast${++seq}`;
        const lastTs = await liveMessage(ALLOWED, "channel", `the okapi door code is ${last}`);
        if (!(await until(() => found(last)))) return "the last message was never indexed";
        await deleteMessage(ALLOWED, lastTs);
        await deleteMessage(ALLOWED, root); // nothing of this scenario stays in Slack's history
        if (!(await until(async () => !(await found(last))))) return "the last deleted message is still found";
        const proc = app!;
        const t0 = Date.now();
        proc.kill("SIGTERM");
        const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "timeout" as const)]);
        if (code === "timeout") {
          proc.kill("SIGKILL");
          await proc.exited;
          app = undefined;
          return "still running 5 s after SIGTERM (the length of Fly's default kill_timeout)";
        }
        app = undefined;
        const t0Free = Date.now();
        while ((await listenerPids(APP_PORT)).length && Date.now() - t0Free < 5000) await Bun.sleep(20);
        if (code !== 0) return `exited ${code} (signal ${proc.signalCode}) on SIGTERM, want 0`;
        const left = [alone, reply, last].map((w) => `${copies(db, w)}/${copies(wal, w)}`);
        return [alone, reply, last].every((w) => inFiles(w) === 0) ? null : `after the stop (${Date.now() - t0} ms), copies in file/-wal: ${left.join(", ")}; want 0`;
      }).finally(() => removeDb(db));
    },
  },
  {
    // A stop that comes while the app is still starting (here: held on its channel check,
    // before the database is opened and purged) waits for the start, then shuts down as
    // any stop does: it never serves, and it exits 0 with LOREHOUSE_DB's WAL emptied.
    name: "a stop (SIGTERM) during start-up waits for it, then exits 0 with LOREHOUSE_DB's -wal empty, never serving",
    run: async () => {
      const db = freshDb();
      const hold = async (on: boolean) => ((await (await post("/fixtures/hold", { method: "conversations.info", hold: on })).json()) as { waiting: number }).waiting;
      await stopApp();
      await hold(true);
      const proc = Bun.spawn(APP_CMD, { cwd: ARGS.app ? dirname(APP_CMD[0]!) : ROOT, env: appEnv({ LOREHOUSE_DB: db }), stdout: "pipe", stderr: "pipe" });
      const stdout = new Response(proc.stdout as ReadableStream).text();
      const stderr = new Response(proc.stderr as ReadableStream).text();
      try {
        const t0 = Date.now();
        while (!(await hold(true))) {
          if (Date.now() - t0 > 15000) return "the app never looked its channels up";
          await Bun.sleep(20);
        }
        proc.kill("SIGTERM");
        await Bun.sleep(300);
        await hold(false);
        const code = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "timeout" as const)]);
        if (code === "timeout") return "still running 5 s after its start-up was let through";
        if (code !== 0) return `exited ${code} (signal ${proc.signalCode}) on a SIGTERM during start-up, want 0: ${(await stderr).slice(0, 300)}`;
        const wal = `${db}-wal`;
        if (existsSync(wal) && readFileSync(wal).length) return `LOREHOUSE_DB's -wal holds ${readFileSync(wal).length} bytes after the stop, want 0`;
        return / on :\d+/.test(await stdout) ? "it started serving after the stop" : null;
      } finally {
        await hold(false);
        if (proc.exitCode === null && proc.signalCode === null) {
          proc.kill("SIGKILL");
          await proc.exited;
        }
        removeDb(db);
        await startApp();
      }
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
    name: "PDF replies are off by default: render_pdf isn't offered, and nothing is uploaded",
    run: async () => {
      await reset();
      const ts = await mentionAndWait("[pdf] make me a report");
      const { text = "" } = (await (await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=15000`)).json()) as { text?: string };
      if (text.includes("[pdf:")) return `render_pdf ran with PDF_REPLIES unset: ${text.slice(0, 120)}`;
      const s = await stats();
      return s.uploads.length || s.byMethod["files.completeUploadExternal"] ? `uploaded a file with PDF replies off: ${JSON.stringify(s.uploads)}` : null;
    },
  },
  {
    // The report has Chinese in it, and the default fonts (PDF_FONTS=local) are bundled: a
    // character no font covers fails the render, so this passes only if the font shipped.
    name: "PDF_REPLIES=1: render_pdf typesets the report, Chinese included, and the PDF is uploaded into the asker's thread",
    run: () => inMode({ PDF_REPLIES: "1" }, async () => {
      await reset();
      const ts = await mentionAndWait("[pdf] make me a report");
      const { text = "" } = (await (await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=15000`)).json()) as { text?: string };
      const told = text.match(/\[pdf:([^:\]]+):(\d+)\]/);
      if (!told) return `the model wasn't handed an attached file: ${text.slice(0, 160)}`;
      // The upload follows the reply (after chat.stopStream), so it may land after /wait.
      const up = await until(async () => (await stats()).uploads.find((u) => u.thread_ts === ts && u.channel));
      if (!up) return `no file shared into the thread: ${JSON.stringify((await stats()).uploads)}`;
      if (up.channel !== ALLOWED) return `shared to ${up.channel}, want ${ALLOWED}`;
      if (up.filename !== "conformance-report.pdf" || told[1] !== up.filename) return `file named ${up.filename} (model told ${told[1]}), want conformance-report.pdf`;
      if (up.head !== "%PDF-" || up.contentType !== "application/pdf") return `uploaded bytes aren't a PDF: head ${JSON.stringify(up.head)}, content-type ${up.contentType}`;
      if (up.bytes !== up.length || String(up.bytes) !== told[2]) return `sizes disagree: reserved ${up.length}, sent ${up.bytes}, model told ${told[2]}`;
      return (await stats()).uploads.length === 1 ? null : `want one upload, got ${(await stats()).uploads.length}`;
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
  // Only full members of the workspace are answered (#145): a guest, or someone from
  // another workspace, can't open every channel an answer may quote. Slack's users.info says
  // which: in the fixtures UG1 is a multi-channel guest, UG2 a single-channel one, UX1 from
  // workspace T9, and U404 no one Slack knows (user_not_found: fails closed).
  {
    name: "answers only full members: a guest's mention or follow-up, someone from another workspace, or a sender Slack doesn't know gets one line in the thread, with no search or model call",
    run: async () => {
      const thread = await mentionAndWait("where is the wombat review"); // a member's: the thread is joined
      await reset();
      const asks = (await usage()).asks;
      const at = (user: string, team = "T1") => {
        const ts = `${1996000000 + ++seq}.000100`;
        return { ts, event: { type: "app_mention", user, team, text: `<@UBOT> [q${seq}] when is the quarterly wombat review`, ts, event_ts: ts, channel: ALLOWED } };
      };
      const guest = at("UG1"), outsider = at("UX1", "T9"), unknown = at("U404");
      for (const m of [guest, outsider, unknown]) await sendEvent(m.event);
      await threadReply(thread, "and which floor is that on?", { user: "UG2" }); // a guest's follow-up
      const GUEST = "I only answer full members of this workspace: my answers draw on every channel I read, and not all of them are open to you as a guest.";
      const want: [string, string][] = [
        [guest.ts, GUEST],
        [outsider.ts, "I only answer full members of this workspace: my answers draw on every channel I read, and not all of them are open to you."],
        [unknown.ts, "I couldn't check that you're a full member of this workspace, so I can't answer right now; try again in a minute."],
        [thread, GUEST],
      ];
      const posts = await until(async () => { const p = (await stats()).posts; return p.length >= want.length ? p : undefined; }, 5000);
      if (!posts) return `posts ${JSON.stringify((await stats()).posts)}, want ${want.length} one-line refusals`;
      for (const [threadTs, text] of want) {
        const got = posts.filter((p) => p.channel === ALLOWED && p.thread_ts === threadTs);
        if (got.length !== 1 || got[0]!.text !== text) return `in thread ${threadTs}: ${JSON.stringify(got)}, want one post ${JSON.stringify(text)}`;
      }
      await Bun.sleep(500);
      const s = await stats();
      if (s.modelCalls || s.byMethod["chat.startStream"]) return `answered anyway: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}`;
      if (s.posts.length !== want.length) return `posted ${s.posts.length}×, want ${want.length}`;
      if ((await usage()).asks !== asks) return "a refused question was counted as an ask";
      // A member is still answered.
      const a = await ask("when is the quarterly wombat review");
      return a.cite === WOMBAT_THREAD ? null : `a member got ${JSON.stringify(a.text.slice(0, 120))}, want a cite of ${WOMBAT_THREAD}`;
    },
  },
  {
    name: "DM_MODE=answer: a guest's DM gets one line instead of an answer, with no search or model call",
    run: () => inMode({ DM_MODE: "answer" }, async () => {
      await reset();
      await directMessage(`[q${++seq}] when does the quarterly wombat review happen`, { user: "UG1" });
      const posts = await until(async () => { const p = (await stats()).posts; return p.length ? p : undefined; }, 5000);
      if (posts?.length !== 1 || posts[0]!.channel !== "D1" || !posts[0]!.text.startsWith("I only answer full members of this workspace")) return `posts ${JSON.stringify(posts)}, want one refusal in D1`;
      await Bun.sleep(500);
      const s = await stats();
      return s.modelCalls || s.byMethod["chat.startStream"] ? `answered anyway: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}` : null;
    }),
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
  // Every listed channel must be public, as Slack's conversations.info says: a start with
  // one that is private, archived, or can't be looked up is refused, naming each (#86).
  {
    name: "refuses to start with a private channel in AGENT_CHANNELS, naming each, before reading Slack or purging anything",
    run: async () => {
      // A joined thread in the listed channel: a start that purged before refusing would drop it.
      const thread = await mentionAndWait("where is the wombat review");
      await stopApp();
      try {
        await reset();
        // C7 is private with a C… id, as Slack's newer private channels are; G1 an older one.
        // The app's token has no groups:read, so Slack answers missing_scope for them.
        const r = await refusedStart({ AGENT_CHANNELS: "C7,G1" });
        if (typeof r === "string") return r;
        for (const want of ["C7 couldn't be looked up, so it counts as not public: conversations.info said missing_scope", "G1 couldn't be looked up, so it counts as not public: conversations.info said missing_scope"]) {
          if (!r.stderr.includes(want)) return `stderr doesn't say "${want}": ${r.stderr.slice(0, 400)}`;
        }
        const s = await stats();
        const others = Object.keys(s.byMethod).filter((m) => m !== "conversations.info");
        if (others.length) return `called Slack beyond conversations.info before refusing: ${JSON.stringify(s.byMethod)}`;
        // A token that may see private channels gets is_private: named as private.
        const seen = await refusedStart({ AGENT_CHANNELS: "C7,G1", SLACK_BOT_TOKEN: "xoxb-with-groups-read" });
        if (typeof seen === "string") return `with groups:read: ${seen}`;
        for (const want of ["C7 (#board-only) is a private channel", "G1 (#secret-merger) is a private channel"]) {
          if (!seen.stderr.includes(want)) return `with groups:read, stderr doesn't say "${want}": ${seen.stderr.slice(0, 400)}`;
        }
      } finally {
        await startApp();
      }
      const { threads } = await admin<{ threads: { channel: string; threadTs: string }[] }>("/api/v1/threads?limit=200");
      return threads.some((t) => t.channel === ALLOWED && t.threadTs === thread) ? null : `the refused start purged ${ALLOWED}'s joined thread ${thread}`;
    },
  },
  {
    name: "refuses to start with an archived channel in AGENT_CHANNELS, naming it and not the public one",
    run: async () => {
      const db = freshDb();
      await stopApp();
      try {
        const r = await refusedStart({ AGENT_CHANNELS: `${ALLOWED},C8`, LOREHOUSE_DB: db });
        if (typeof r === "string") return r;
        if (!r.stderr.includes("C8 (#old-launch) is archived")) return `stderr doesn't name C8 as archived: ${r.stderr.slice(0, 400)}`;
        return r.stderr.includes(`${ALLOWED} (#general)`) ? `stderr names the public ${ALLOWED} too: ${r.stderr.slice(0, 400)}` : null;
      } finally {
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    name: "a channel lookup that fails refuses the start (fails closed): not found, a token without channels:read, Slack unreachable",
    run: async () => {
      const db = freshDb();
      await stopApp();
      try {
        const cases: [Record<string, string>, string][] = [
          [{ AGENT_CHANNELS: `${ALLOWED},C404` }, "C404 couldn't be looked up, so it counts as not public: conversations.info said channel_not_found"],
          [{ SLACK_BOT_TOKEN: "xoxb-without-channels-read" }, `${ALLOWED} couldn't be looked up, so it counts as not public: conversations.info said missing_scope`],
          [{ SLACK_API_URL: `http://127.0.0.1:${await closedPort()}/api` }, `${ALLOWED} couldn't be looked up, so it counts as not public: conversations.info said `],
        ];
        for (const [env, want] of cases) {
          const r = await refusedStart({ ...env, LOREHOUSE_DB: db });
          if (typeof r === "string") return `${JSON.stringify(env)}: ${r}`;
          if (!r.stderr.includes(want)) return `${JSON.stringify(env)}: stderr doesn't say "${want}": ${r.stderr.slice(0, 400)}`;
        }
        return null;
      } finally {
        removeDb(db);
        await startApp();
      }
    },
  },
  // A public channel shared beyond the workspace has readers who can't open the other
  // listed channels: refused like a private one (#145).
  {
    name: "refuses to start with a channel shared beyond the workspace in AGENT_CHANNELS (Slack Connect, a pending invitation, Enterprise Grid), naming each and why",
    run: async () => {
      const db = freshDb();
      await stopApp();
      try {
        const r = await refusedStart({ AGENT_CHANNELS: `${ALLOWED},C3,C4,C5`, LOREHOUSE_DB: db });
        if (typeof r === "string") return r;
        for (const want of [
          "C3 (#acme-partners) is shared with another organization (Slack Connect), so its readers include people who can't open the other listed channels",
          "C4 (#grid-all-hands) is shared with other workspaces of this Enterprise Grid organization",
          "C5 (#vendor-invite) has a pending Slack Connect invitation",
        ]) {
          if (!r.stderr.includes(want)) return `stderr doesn't say "${want}": ${r.stderr.slice(0, 600)}`;
        }
        return r.stderr.includes(`${ALLOWED} (#general)`) ? `stderr names the public ${ALLOWED} too: ${r.stderr.slice(0, 400)}` : null;
      } finally {
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    name: "starts when every listed channel is public, after looking each one up",
    run: async () => {
      const db = freshDb();
      await stopApp();
      try {
        await reset();
        await startApp({ AGENT_CHANNELS: `${ALLOWED},${REMOVED}`, LOREHOUSE_DB: db });
        const s = await stats();
        if ((s.byMethod["conversations.info"] ?? 0) < 2) return `conversations.info called ${s.byMethod["conversations.info"] ?? 0} time(s), want one per channel at least`;
        const { knowledge } = await status();
        // Read: its backfill left a cursor.
        return knowledge.channels[REMOVED]?.cursor ? null : `${REMOVED} wasn't read: ${JSON.stringify(knowledge.channels)}`;
      } finally {
        await stopApp();
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    name: "a listed channel turned private while running is closed at the next recheck: a mention there gets no reply and no model call; the other channel still answers",
    run: async () => {
      const db = freshDb();
      const PUBLIC_C2 = { name: "random", is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };
      await stopApp();
      try {
        await startApp({ AGENT_CHANNELS: `${ALLOWED},${REMOVED}`, LOREHOUSE_DB: db, INGEST_CHANNEL_RECHECK_MS: "300" });
        await post("/fixtures/channel", { channel: REMOVED, info: { ...PUBLIC_C2, is_private: true } });
        const closed = await until(async () => (await status()).knowledge.channels[REMOVED]?.closed, 5000);
        if (!closed) return `${REMOVED} never closed: ${JSON.stringify((await status()).knowledge.channels)}`;
        await reset();
        await sendEvent(mention(REMOVED));
        await Bun.sleep(1500);
        const s = await stats();
        const asked = s.modelCalls || s.byMethod["chat.startStream"] || s.byMethod["chat.postMessage"];
        if (asked) return `answered in the closed channel: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}`;
        const a = await ask("when is the quarterly wombat review");
        return a.cite === WOMBAT_THREAD ? null : `${ALLOWED} answered ${JSON.stringify(a.text.slice(0, 120))}, want a cite of ${WOMBAT_THREAD}`;
      } finally {
        await post("/fixtures/channel", { channel: REMOVED, info: PUBLIC_C2 });
        await stopApp();
        removeDb(db);
        await startApp();
      }
    },
  },
  {
    name: "a listed channel shared with another organization while running (Slack Connect) is closed at the next recheck, as one turned private: a mention there gets no reply",
    run: async () => {
      const db = freshDb();
      const PUBLIC_C2 = { name: "random", is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };
      await stopApp();
      try {
        await startApp({ AGENT_CHANNELS: `${ALLOWED},${REMOVED}`, LOREHOUSE_DB: db, INGEST_CHANNEL_RECHECK_MS: "300" });
        await post("/fixtures/channel", { channel: REMOVED, info: { ...PUBLIC_C2, is_shared: true, is_ext_shared: true } });
        const closed = await until(async () => (await status()).knowledge.channels[REMOVED]?.closed, 5000);
        if (closed !== "shared") return `${REMOVED} closed as ${JSON.stringify(closed)}, want "shared": ${JSON.stringify((await status()).knowledge.channels)}`;
        await reset();
        await sendEvent(mention(REMOVED));
        await Bun.sleep(1500);
        const s = await stats();
        const asked = s.modelCalls || s.byMethod["chat.startStream"] || s.byMethod["chat.postMessage"];
        return asked ? `answered in the shared channel: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}` : null;
      } finally {
        await post("/fixtures/channel", { channel: REMOVED, info: PUBLIC_C2 });
        await stopApp();
        removeDb(db);
        await startApp();
      }
    },
  },
  // An empty AGENT_CHANNELS means nowhere, for every event kind; a channel taken off the
  // list leaves the knowledge index on the next start (#82).
  {
    name: "an empty AGENT_CHANNELS means nowhere: after a restart, a follow-up in a thread it joined gets no reply and no model call, and only the seeds stay",
    run: () => withRestart({ AGENT_CHANNELS: ALLOWED }, { AGENT_CHANNELS: "" }, async () => {
      const thread = await mentionAndWait("where is the wombat review");
      return async () => {
        await reset();
        await threadReply(thread, "and which floor is that on?");
        await Bun.sleep(2500);
        const s = await stats();
        if (s.modelCalls || s.slackCalls) return `answered anyway: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}`;
        const docs = (await status()).knowledge.documents;
        return docs === SEED_DOCS ? null : `documents ${docs}, want ${SEED_DOCS}: everything learned from Slack is purged, the seeds stay`;
      };
    }),
  },
  {
    name: "an empty AGENT_CHANNELS means nowhere: a mention is still refused",
    run: () => withRestart({ AGENT_CHANNELS: ALLOWED }, { AGENT_CHANNELS: "" }, async () => async () => {
      await reset();
      await sendEvent(mention(ALLOWED));
      await Bun.sleep(1500);
      const s = await stats();
      return s.modelCalls || s.slackCalls ? `ran anyway: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}` : null;
    }),
  },
  {
    name: "a channel taken off AGENT_CHANNELS: after a restart, a follow-up in a thread it joined there gets no reply, and the thread is no longer listed as joined",
    run: () => withRemovedChannel(async ({ thread }) => {
      await reset();
      await threadReply(thread, "and which floor is that on?", { channel: REMOVED });
      await Bun.sleep(2500);
      const s = await stats();
      if (s.modelCalls || s.slackCalls) return `answered anyway: ${s.modelCalls} model call(s), Slack ${JSON.stringify(s.byMethod)}`;
      const { threads } = await admin<{ threads: { channel: string }[] }>("/api/v1/threads?limit=50");
      return threads.some((t) => t.channel === REMOVED) ? `${REMOVED}'s joined thread is still listed: ${JSON.stringify(threads)}` : null;
    }),
  },
  {
    name: "a channel taken off AGENT_CHANNELS leaves the index on restart: not found, not served (404); seeds and listed channels untouched",
    run: () => withRemovedChannel(async ({ thread, word, listedThreads }) => {
      const doc = `slack:${REMOVED}:${thread}`;
      const r = await adminAs(`/api/v1/documents/${doc}`);
      if (r.status !== 404) return `${doc}: got ${r.status}, want 404`;
      const { results } = await admin<{ results: { id: string }[] }>(`/api/v1/search?q=${encodeURIComponent(word)}`);
      if (results.some((x) => x.id.startsWith(`slack:${REMOVED}:`))) return `"${word}" still finds ${JSON.stringify(results.map((x) => x.id))}`;
      const { documents } = await admin<DocumentList>(`/api/v1/documents?channel=${REMOVED}&limit=50`);
      if (documents.length) return `${REMOVED} still lists ${documents.length} document(s)`;
      const { knowledge } = await status();
      if (knowledge.channels[ALLOWED]?.threads !== listedThreads) return `${ALLOWED} threads ${knowledge.channels[ALLOWED]?.threads}, want ${listedThreads} (untouched)`;
      if (knowledge.documents !== SEED_DOCS + listedThreads) return `documents ${knowledge.documents}, want ${SEED_DOCS} seeds + ${listedThreads} from ${ALLOWED}`;
      const answer = await ask("when is the quarterly wombat review");
      return answer.cite === WOMBAT_THREAD ? null : `the listed channel's answer cited ${answer.cite}, want ${WOMBAT_THREAD}`;
    }),
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
        // One per thread, and the tenant's: "<tenant>.<thread>", so two tenants' threads
        // never share a sandbox on one host (ADR 0005 §2).
        const tenant = ((await status()) as Status & { tenant?: string }).tenant;
        const sandbox = runner.jobs[0]?.sandbox ?? "";
        if (!sandbox.startsWith(`${tenant}.`) || !/^slack_C1_\d+\.\d+$/.test(sandbox.slice(`${tenant}.`.length))) return `the job's sandbox ${sandbox}, want one per thread of this tenant (${tenant}.slack_C1_<ts>)`;
        const listed = (await status() as unknown as { runners?: { runner: string; transport: string; online: boolean; mirrors?: unknown }[] }).runners;
        // The runner's mirrors block, as it sent it.
        return listed?.some((r) => r.runner === "r-ws" && r.transport === "ws" && r.online && JSON.stringify(r.mirrors) === JSON.stringify(MIRRORS)) ? null : `/status runners ${JSON.stringify(listed)}`;
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
        const listed = (await status() as unknown as { runners?: { runner: string; transport: string; mirrors?: unknown }[] }).runners;
        return listed?.some((r) => r.runner === "r-poll" && r.transport === "poll" && JSON.stringify(r.mirrors) === JSON.stringify(MIRRORS)) ? null : `/status runners ${JSON.stringify(listed)}`;
      } finally {
        await runner.stop();
      }
    }),
  },
  {
    // #124: a command longer than one tool call runs as a background job. The scripted
    // model starts it, checks on it until it ends, then answers with how it ended; with
    // "[jobcancel]", the asker cancels it instead.
    name: "sandbox runners: a background job starts, is checked on until it ends, and the asker can cancel one",
    run: () => inMode(RUNNER_ENV, async () => {
      const runner = pollRunner(APP, RUNNER_TOKEN, "r-jobs");
      try {
        await Bun.sleep(200); // the first poll registers the runner
        const a = await ask("[job] bench-1 sleep 1; echo done");
        if (!a.text.includes("[job:bench-1:exited:0:ran:sleep 1; echo done]")) return `answer ${a.text.slice(0, 200)}, want the job as it ended`;
        const calls = runner.jobs.filter((j) => j.path?.startsWith("/jobs")).map((j) => `${j.method} ${j.path}`);
        const want = ["POST /jobs", "GET /jobs/bench-1?tailBytes=8192", "GET /jobs/bench-1?tailBytes=8192"];
        if (JSON.stringify(calls) !== JSON.stringify(want)) return `guest calls ${JSON.stringify(calls)}, want ${JSON.stringify(want)}`;
        const start = JSON.parse(Buffer.from(runner.jobs.find((j) => j.path === "/jobs")!.bodyBase64 ?? "", "base64").toString()) as { id?: string; cwd?: string; timeoutMs?: number };
        if (start.id !== "bench-1" || start.cwd !== "/workspace/repo" || start.timeoutMs !== 3_600_000) return `the start asked for ${JSON.stringify({ id: start.id, cwd: start.cwd, timeoutMs: start.timeoutMs })}, want bench-1 in /workspace/repo for an hour`;
        const c = await ask("[jobcancel] long-1 sleep 600");
        if (!c.text.includes("[job:long-1:cancelled:143:")) return `cancel: ${c.text.slice(0, 200)}, want the job cancelled by its starter`;
        return runner.jobs.some((j) => j.path === "/jobs/long-1/cancel") ? null : "no cancel reached the runner";
      } finally {
        await runner.stop();
      }
    }),
  },
  {
    name: "workspace_attach_file over a runner: a PNG made in the sandbox is uploaded into the asker's thread; an SVG is refused, uploading nothing",
    run: () => inMode(RUNNER_ENV, async () => {
      const runner = await wsRunner(APP, RUNNER_TOKEN, "r-attach");
      try {
        await reset();
        const ts = await mentionAndWait("[attach] /tmp/out/chart.png");
        const { text = "" } = (await (await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=15000`)).json()) as { text?: string };
        const told = text.match(/\[file:([^:\]]+):(\d+):([^\]]+)\]/);
        if (!told) return `the model wasn't handed an attached file: ${text.slice(0, 160)}`;
        const read = runner.jobs.find((j) => j.op === "guest" && j.method === "GET");
        if (read?.path !== "/file?path=%2Ftmp%2Fout%2Fchart.png") return `the file was read as ${read?.path}, want /file?path=%2Ftmp%2Fout%2Fchart.png`;
        // The upload follows the reply (after chat.stopStream), so it may land after /wait.
        const up = await until(async () => (await stats()).uploads.find((u) => u.thread_ts === ts && u.channel));
        if (!up) return `no file shared into the thread: ${JSON.stringify((await stats()).uploads)}`;
        if (up.channel !== ALLOWED) return `shared to ${up.channel}, want ${ALLOWED}`;
        if (up.filename !== "Conformance chart.png" || told[1] !== up.filename) return `file named ${up.filename} (model told ${told[1]}), want "Conformance chart.png"`;
        if (told[3] !== "image/png" || !up.head?.includes("PNG") || up.contentType !== "image/png") return `uploaded bytes aren't the PNG: head ${JSON.stringify(up.head)}, content-type ${up.contentType}, model told ${told[3]}`;
        if (up.bytes !== CHART_PNG.byteLength || up.bytes !== up.length || String(up.bytes) !== told[2]) return `sizes disagree: the PNG is ${CHART_PNG.byteLength}, reserved ${up.length}, sent ${up.bytes}, model told ${told[2]}`;
        if ((await stats()).uploads.length !== 1) return `want one upload, got ${(await stats()).uploads.length}`;

        await reset();
        const svgTs = await mentionAndWait("[attach] /tmp/out/chart.svg");
        const svg = (await (await fetch(`${MOCK}/wait?thread_ts=${svgTs}&timeout_ms=15000`)).json()) as { text?: string };
        if (!/\[toolerror:SVG isn't attached:[^\]]*PNG/.test(svg.text ?? "")) return `an SVG wasn't refused with why and what to do instead: ${(svg.text ?? "").slice(0, 200)}`;
        await Bun.sleep(300); // an upload would follow the reply
        const after = await stats();
        return after.uploads.length || after.byMethod["files.completeUploadExternal"] ? `uploaded something for the SVG: ${JSON.stringify(after.uploads)}` : null;
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
    // ADR 0002 §6: by default only the requester may approve (June's own default for a
    // Slack turn). Someone else's clicks change nothing; the requester's opens it (the
    // scenario above has the requester approve after a restart).
    name: "PR_APPROVER unset (requester): someone else's Approve and Deny are refused and nothing is pushed; the requester's Approve opens it",
    run: () => {
      const env = { ...RUNNER_ENV, GITHUB_API_URL: `${MOCK}/github` };
      return inMode(env, async () => {
        const runner = pollRunner(APP, RUNNER_TOKEN, "r-requester");
        try {
          await Bun.sleep(200); // the first poll registers the runner
          await reset();
          const rule = ((await status()) as unknown as { pullRequestApprover?: string }).pullRequestApprover;
          if (rule !== "requester") return `/status pullRequestApprover ${JSON.stringify(rule)}, want "requester"`;
          const card = await prCard("scout/conformance-requester", "U4"); // Kai, named in the fixtures
          if (typeof card === "string") return card;
          if (JSON.stringify(card.prompt).includes("someone other than")) return "under requester, the card says someone else must approve";
          const refused = await refusedFor("U2", "someone else", card, runner);
          if (refused) return refused;
          await click("U4", card, "Approve");
          const done = await until(async () => (await stats()).updates.find((u) => u.ts === card.prompt.ts && u.text.includes("[pr:")));
          if (!done) return `approved by the requester, the turn never finished: responses ${JSON.stringify((await stats()).responses)}`;
          if (!done.text.includes(`${card.nonce} [pr:opened:https://github.com/acme/widgets/pull/7]`)) return `the turn ended with ${done.text.slice(0, 160)}, want the opened pull request`;
          return openedBy(runner, "Kai");
        } finally {
          await runner.stop();
        }
      });
    },
  },
  {
    // ADR 0002 §6: an install may widen it to anyone in the thread; here someone other than
    // the requester approves, and is named.
    name: "PR_APPROVER=anyone: someone other than the requester approves, and the pull request names them",
    run: () => {
      const env = { ...RUNNER_ENV, GITHUB_API_URL: `${MOCK}/github`, PR_APPROVER: "anyone" };
      return inMode(env, async () => {
        const runner = pollRunner(APP, RUNNER_TOKEN, "r-anyone");
        try {
          await Bun.sleep(200); // the first poll registers the runner
          await reset();
          const rule = ((await status()) as unknown as { pullRequestApprover?: string }).pullRequestApprover;
          if (rule !== "anyone") return `/status pullRequestApprover ${JSON.stringify(rule)}, want "anyone"`;
          const card = await prCard("scout/conformance-anyone");
          if (typeof card === "string") return card;
          if (JSON.stringify(card.prompt).includes("someone other than")) return "under anyone, the card says someone else must approve";
          await click("U2", card, "Approve");
          const done = await until(async () => (await stats()).updates.find((u) => u.ts === card.prompt.ts && u.text.includes("[pr:")));
          if (!done) return `approved by someone else, the turn never finished: responses ${JSON.stringify((await stats()).responses)}`;
          if (!done.text.includes(`${card.nonce} [pr:opened:https://github.com/acme/widgets/pull/7]`)) return `the turn ended with ${done.text.slice(0, 160)}, want the opened pull request`;
          return openedBy(runner, "Wendy (Wendy Wu)");
        } finally {
          await runner.stop();
        }
      });
    },
  },
  {
    // #145: whoever approves must be a full member of the workspace, under any rule. Even
    // with PR_APPROVER=anyone, a guest's Approve and Deny are refused and nothing is pushed;
    // a member's Approve then opens it.
    name: "PR_APPROVER=anyone: a guest's Approve and Deny are refused and nothing is pushed; a member's Approve opens it",
    run: () => {
      const env = { ...RUNNER_ENV, GITHUB_API_URL: `${MOCK}/github`, PR_APPROVER: "anyone" };
      return inMode(env, async () => {
        const runner = pollRunner(APP, RUNNER_TOKEN, "r-guest-approver");
        try {
          await Bun.sleep(200); // the first poll registers the runner
          await reset();
          const card = await prCard("scout/conformance-guest-approver");
          if (typeof card === "string") return card;
          const refused = await refusedFor("UG1", "a guest", card, runner);
          if (refused) return refused;
          await click("U2", card, "Approve");
          const done = await until(async () => (await stats()).updates.find((u) => u.ts === card.prompt.ts && u.text.includes("[pr:")));
          if (!done) return `approved by a member after the guest, the turn never finished: responses ${JSON.stringify((await stats()).responses)}`;
          return openedBy(runner, "Wendy (Wendy Wu)");
        } finally {
          await runner.stop();
        }
      });
    },
  },
  {
    // ADR 0002 §6: an install can require a second person. The requester's clicks change
    // nothing (they alone are told why), the card stays for someone else, and nothing is
    // pushed until someone else approves.
    name: "PR_APPROVER=not-requester: the requester's Approve and Deny are refused and nothing is pushed; someone else's Approve opens it",
    run: () => {
      const env = { ...RUNNER_ENV, GITHUB_API_URL: `${MOCK}/github`, PR_APPROVER: "not-requester" };
      return inMode(env, async () => {
        const runner = pollRunner(APP, RUNNER_TOKEN, "r-second");
        try {
          await Bun.sleep(200); // the first poll registers the runner
          await reset();
          const rule = ((await status()) as unknown as { pullRequestApprover?: string }).pullRequestApprover;
          if (rule !== "not-requester") return `/status pullRequestApprover ${JSON.stringify(rule)}, want "not-requester"`;
          const card = await prCard("scout/conformance-second");
          if (typeof card === "string") return card;
          if (!JSON.stringify(card.prompt).includes("someone other than the person who asked for it")) return `the card doesn't say someone else approves: ${JSON.stringify(card.prompt).slice(0, 300)}`;

          const refused = await refusedFor("U1", "the requester", card, runner);
          if (refused) return refused;

          await click("U2", card, "Approve");
          const done = await until(async () => (await stats()).updates.find((u) => u.ts === card.prompt.ts && u.text.includes("[pr:")));
          if (!done) return `approved by someone else, the turn never finished: updates ${JSON.stringify((await stats()).updates).slice(0, 300)}`;
          if (!done.text.includes(`${card.nonce} [pr:opened:https://github.com/acme/widgets/pull/7]`)) return `the turn ended with ${done.text.slice(0, 160)}, want the opened pull request`;
          return openedBy(runner, "Wendy (Wendy Wu)");
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
// (startApp), and LOREHOUSE_SETTINGS at settings.json, also beside the database.
// Nor its PR_APPROVER: a scenario that leaves it unset tests the default.
const { SESSIONS_DB: _sessions, LOREHOUSE_ENV_FILE: _envFile, LOREHOUSE_SETTINGS: _settings, PR_APPROVER: _prApprover, ...inherited } = process.env;

// Start the app and wait until it listens, owns its port, and (unless waitReady is off,
// for a start where /status is closed) has finished its Slack backfill/reconcile
// (GET /status → ready).
function appEnv(extraEnv: Record<string, string>): Record<string, string | undefined> {
  return {
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
    // Set, not left to its default: the app's Bun loads the checkout's .env for every
    // variable not set here, and one naming a settings file would fill in the rest.
    LOREHOUSE_SETTINGS: join(dirname(extraEnv.LOREHOUSE_DB ?? DB), "settings.json"),
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
    ...extraEnv,
  };
}

async function startApp(extraEnv: Record<string, string> = {}, { waitReady = true } = {}): Promise<void> {
  const proc = Bun.spawn(APP_CMD, {
    // An external app runs from its own directory, so a binary that quietly reads files
    // from this repo (prompts, migrations) fails here instead of passing by accident.
    cwd: ARGS.app ? dirname(APP_CMD[0]!) : ROOT,
    env: appEnv(extraEnv),
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

// A local port nothing listens on: bound, then let go.
async function closedPort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// Start the app with settings it must refuse: it must exit non-zero within 15 s without
// ever listening. Resolves to its exit code and what it wrote to stderr, or why not.
async function refusedStart(extraEnv: Record<string, string>): Promise<{ code: number; stderr: string } | string> {
  const proc = Bun.spawn(APP_CMD, { cwd: ARGS.app ? dirname(APP_CMD[0]!) : ROOT, env: appEnv(extraEnv), stdout: "ignore", stderr: "pipe" });
  const stderr = new Response(proc.stderr as ReadableStream).text(); // drained as it runs
  const exited = await Promise.race([proc.exited, Bun.sleep(15000).then(() => undefined)]);
  if (exited === undefined) {
    const listening = await fetch(`${APP}/healthz`).then((r) => r.ok, () => false);
    proc.kill();
    await proc.exited;
    const t0 = Date.now();
    while ((await listenerPids(APP_PORT)).length && Date.now() - t0 < 5000) await Bun.sleep(20);
    return listening ? "started and listened, want a refusal" : "neither started nor exited within 15 s";
  }
  const text = await stderr;
  return exited === 0 ? `exited 0, want a failure: ${text.slice(0, 300)}` : { code: exited, stderr: text };
}

async function stopApp(): Promise<void> {
  if (!app) return;
  app.kill();
  // A shutdown that wedges is killed after 8 s instead of hanging the run (the SIGTERM
  // scenario is what fails one that takes over 5 s).
  if ((await Promise.race([app.exited, Bun.sleep(8000).then(() => "timeout" as const)])) === "timeout") {
    console.log(`  (the app was still running 8 s after SIGTERM: killed)`);
    app.kill("SIGKILL");
    await app.exited;
  }
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
