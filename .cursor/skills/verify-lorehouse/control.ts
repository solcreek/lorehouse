#!/usr/bin/env bun
// Drive one isolated Lorehouse. Slack and Anthropic are the conformance stand-ins
// (conformance/mock.ts), which is the same boundary SLACK_API_URL and ANTHROPIC_BASE_URL
// already are. Each run has its own ports, sqlite files, and process group.
//
// Stdout is one JSON object. Diagnostics go to stderr. Run from anywhere; paths are
// resolved from this file. Tokens live only in the constants below.

import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const SERVER = join(REPO, "src/server.ts");
const MOCK = join(REPO, "conformance/mock.ts");
const FIXTURES = join(REPO, "conformance/fixtures/slack-history.json");
const RUNS_ROOT = "/tmp/lorehouse-verify";
const CURRENT = join(RUNS_ROOT, "current");

export const SIGNING_SECRET = "verify-signing-secret";
export const STATUS_TOKEN = "verify-status-token-000000000000";
export const ADMIN_TOKEN = "verify-admin-token-0000000000000";
export const CHANNEL = "C1";
export const AGENT = "scout";
export const WOMBAT_ID = "slack:C1:1790000001.000100";
const DEBOUNCE_MS = "200";

type Proc = { pid: number; port: number; log: string };
type State = {
  version: 1;
  runId: string;
  repo: string;
  dir: string;
  evidence: string;
  db: string;
  channel: typeof CHANNEL;
  agent: typeof AGENT;
  app: Proc;
  mock: Proc;
  seq: number;
  ready: boolean;
};

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function emit(body: unknown, code = 0): never {
  console.log(JSON.stringify(body, null, 2));
  process.exit(code);
}

function fail(error: string, extra: Record<string, unknown> = {}): never {
  emit({ ok: false, error, ...extra }, 1);
}

function statePath(runId: string): string {
  return join(RUNS_ROOT, runId, "state.json");
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function readState(runId: string): State {
  const path = statePath(runId);
  if (!existsSync(path)) throw new Error(`no state for run ${runId}`);
  return JSON.parse(readText(path)) as State;
}

function saveState(state: State): void {
  writeFileSync(statePath(state.runId), JSON.stringify(state, null, 2) + "\n");
}

function selectedRunId(): string {
  const fromFlag = flag("run");
  if (fromFlag) return fromFlag;
  if (!existsSync(CURRENT)) fail("no verification run is current; launch one");
  return readText(CURRENT).trim();
}

function loadSelected(): State {
  const runId = selectedRunId();
  try {
    const state = readState(runId);
    if (state.version !== 1) fail(`run ${runId} has state version ${state.version}; this helper expects 1`);
    return state;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), { runId });
  }
}

function childEnv(overrides: Record<string, string>): Record<string, string> {
  // Bun loads .env from cwd and does not override variables that are already set.
  // Start from a clean allowlist and set every Lorehouse key, so a developer .env
  // or a parent shell cannot point this instance at a real workspace.
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const key of [
    "SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "SLACK_API_URL", "SLACK_BOT_USER_ID",
    "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL",
    "AGENT_NAME", "AGENT_CHANNELS", "AGENT_CO_AUTHOR", "DM_MODE",
    "LOREHOUSE_DB", "SESSIONS_DB", "KNOWLEDGE_SEED",
    "INGEST_BACKFILL_DAYS", "INGEST_REFRESH_DAYS", "INGEST_DEBOUNCE_MS",
    "STATUS_TOKEN", "ADMIN_TOKEN", "USAGE_RECORD_PEOPLE", "LOG_SLACK_EVENTS",
    "SANDBOX_RUNNER_TOKEN", "SANDBOX_URL", "SANDBOX_TOKEN",
    "GITHUB_TOKEN", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY",
    "PORT",
  ]) env[key] = "";
  return { ...env, ...overrides };
}

function spawnDetached(cmd: string[], env: Record<string, string>, log: string): number {
  const proc = Bun.spawn([process.execPath, ...cmd], {
    cwd: REPO,
    env,
    detached: true,
    stdin: "ignore",
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });
  proc.unref();
  return proc.pid;
}

function commandOf(pid: number): string {
  const result = Bun.spawnSync(["ps", "-p", String(pid), "-ww", "-o", "args="], { stdout: "pipe", stderr: "ignore" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : "";
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port: number): number[] {
  const result = Bun.spawnSync(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
  if (result.exitCode !== 0) return [];
  return result.stdout.toString().trim().split("\n").filter(Boolean).map((s) => Number(s));
}

async function waitHttp(url: string, ms: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* not up yet */ }
    await Bun.sleep(30);
  }
  return false;
}

function clip(path: string, fromEnd: boolean): string {
  try {
    const lines = readText(path).split("\n");
    return (fromEnd ? lines.slice(-40) : lines.slice(0, 20)).join("\n");
  } catch {
    return "";
  }
}

function base(state: State): { app: string; mock: string } {
  return { app: `http://127.0.0.1:${state.app.port}`, mock: `http://127.0.0.1:${state.mock.port}` };
}

async function appFetch(state: State, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown; text: string }> {
  const response = await fetch(`${base(state).app}${path}`, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* healthz is plain text */ }
  return { status: response.status, body, text };
}

async function statusOf(state: State, auth?: string) {
  const headers = auth ? { authorization: auth } : {};
  return appFetch(state, "/status", { headers });
}

async function adminOf(state: State, path: string, token = ADMIN_TOKEN) {
  return appFetch(state, path, { headers: { authorization: `Bearer ${token}` } });
}

function sign(body: string, secret = SIGNING_SECRET): { timestamp: string; signature: string } {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return { timestamp, signature };
}

function allocateTs(state: State): string {
  state.seq += 1;
  saveState(state);
  return `${2_000_000_000 + state.seq}.000100`;
}

async function sendEvent(state: State, event: Record<string, unknown>, opts: { badSig?: boolean } = {}): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: `EvVerify${Date.now()}-${state.seq}`,
    event,
  });
  const signed = sign(payload, opts.badSig ? "wrong-secret" : SIGNING_SECRET);
  const response = await fetch(`${base(state).app}/slack/events`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-slack-request-timestamp": signed.timestamp,
      "x-slack-signature": signed.signature,
    },
    body: payload,
  });
  const text = await response.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* empty or plain */ }
  return { status: response.status, body };
}

async function mockJson(state: State, path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base(state).mock}${path}`, init);
  return { status: response.status, body: await response.json() };
}

type Reply = { text?: string; methods?: string[]; timeout?: boolean; calls?: string[] };

async function waitReply(state: State, thread: string, timeoutMs: number): Promise<{ status: number; body: Reply }> {
  return mockJson(state, `/wait?thread_ts=${encodeURIComponent(thread)}&timeout_ms=${timeoutMs}`);
}

function cited(reply: Reply): { text: string; cite?: string; src?: string } {
  const text = reply.text ?? "";
  return {
    text,
    cite: text.match(/\[cite:([^\]\s]+)\]/)?.[1],
    src: text.match(/\[src:([^\]\s]+)\]/)?.[1],
  };
}

async function finish(state: State, body: Record<string, unknown>, code = 0): Promise<never> {
  const evidence = flag("evidence");
  if (evidence) {
    if (evidence.includes("..") || evidence.startsWith("/")) fail("--evidence must be a relative path inside this run's artifact directory");
    const path = join(state.evidence, evidence.endsWith(".json") ? evidence : `${evidence}.json`);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n");
    body = { ...body, evidence: path };
  }
  emit(body, code);
}

function signalStarted(pid: number, script: string): void {
  const commandLine = commandOf(pid);
  if (!commandLine.includes(script)) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone, or not a group */ }
}

async function stopPid(pid: number, script: string): Promise<boolean> {
  if (!alive(pid)) return true;
  // A reused pid is not a process this run started.
  if (!commandOf(pid).includes(script)) return true;
  signalStarted(pid, script);
  const start = Date.now();
  while (alive(pid) && commandOf(pid).includes(script) && Date.now() - start < 3000) await Bun.sleep(50);
  if (alive(pid) && commandOf(pid).includes(script)) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* group already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    await Bun.sleep(100);
  }
  return !alive(pid) || !commandOf(pid).includes(script);
}

async function launch(): Promise<never> {
  if (!Bun.file(join(REPO, "node_modules/@junejs/server/package.json")).size) {
    fail("dependencies are missing; run `bun install` from the repo root");
  }
  if (!Bun.file(FIXTURES).size) fail(`missing Slack fixture ${FIXTURES}`);

  const runId = `verify-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${crypto.randomUUID().slice(0, 8)}`;
  const dir = join(RUNS_ROOT, runId);
  const evidence = join(REPO, ".cursor/skills/verify-lorehouse/artifacts", runId);
  mkdirSync(dir, { recursive: true });
  mkdirSync(evidence, { recursive: true });
  const db = join(dir, "lorehouse.db");
  const mockLog = join(dir, "mock.log");
  const appLog = join(dir, "app.log");

  const mockPort = await reservedPort();
  const appPort = await reservedPort();
  const mockPid = spawnDetached([MOCK], childEnv({
    PORT: String(mockPort),
    TTFT_MS: "20",
    TOKEN_DELAY_MS: "1",
    TOKENS: "8",
    SLACK_FIXTURES: FIXTURES,
  }), mockLog);

  const state: State = {
    version: 1,
    runId,
    repo: REPO,
    dir,
    evidence,
    db,
    channel: CHANNEL,
    agent: AGENT,
    app: { pid: 0, port: appPort, log: appLog },
    mock: { pid: mockPid, port: mockPort, log: mockLog },
    seq: 0,
    ready: false,
  };
  saveState(state);

  const mockUp = await waitHttp(`http://127.0.0.1:${mockPort}/stats`, 8000);
  if (!mockUp) {
    await cleanupRun(state);
    fail("mock never answered /stats", { runId, log: clip(mockLog, true) });
  }

  state.app.pid = spawnDetached([SERVER], childEnv({
    PORT: String(appPort),
    SLACK_SIGNING_SECRET: SIGNING_SECRET,
    SLACK_BOT_TOKEN: "xoxb-verify",
    SLACK_API_URL: `http://127.0.0.1:${mockPort}/slack/api`,
    ANTHROPIC_API_KEY: "verify",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockPort}/anthropic`,
    AGENT_NAME: AGENT,
    AGENT_CHANNELS: CHANNEL,
    DM_MODE: "redirect",
    LOREHOUSE_DB: db,
    SESSIONS_DB: join(dir, "sessions.db"),
    INGEST_BACKFILL_DAYS: "36500",
    INGEST_REFRESH_DAYS: "36500",
    INGEST_DEBOUNCE_MS: DEBOUNCE_MS,
    STATUS_TOKEN,
    ADMIN_TOKEN,
  }), appLog);
  saveState(state);

  const health = await waitHttp(`http://127.0.0.1:${appPort}/healthz`, 15000);
  const owners = listenerPids(appPort);
  if (!health || !owners.includes(state.app.pid)) {
    const log = clip(appLog, true);
    await cleanupRun(state);
    fail("app never became the listener on its port", { runId, owners, log });
  }

  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 20000) {
    const status = await statusOf(state, `Bearer ${STATUS_TOKEN}`).catch(() => undefined);
    if (status?.status === 200 && (status.body as { knowledge?: { state?: string } })?.knowledge?.state === "ready") {
      ready = true;
      break;
    }
    await Bun.sleep(50);
  }
  if (!ready) {
    const log = clip(appLog, true);
    await cleanupRun(state);
    fail("ingest never became ready", { runId, log });
  }

  const wombat = await adminOf(state, `/api/v1/documents/${WOMBAT_ID}`);
  const wombatText = JSON.stringify(wombat.body);
  if (wombat.status !== 200 || !wombatText.includes("quarterly wombat review")) {
    await cleanupRun(state);
    fail("backfill did not index the wombat review thread", { runId, status: wombat.status, body: wombat.body });
  }

  state.ready = true;
  saveState(state);
  writeFileSync(CURRENT, runId + "\n");
  await finish(state, {
    ok: true,
    runId,
    agent: AGENT,
    channel: CHANNEL,
    app: `http://127.0.0.1:${appPort}`,
    mock: `http://127.0.0.1:${mockPort}`,
    db,
    evidence,
    debounceMs: Number(DEBOUNCE_MS),
    appPid: state.app.pid,
    mockPid: state.mock.pid,
  });
}

async function reservedPort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

async function doctor(): Promise<never> {
  const state = loadSelected();
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const appCmd = commandOf(state.app.pid);
  const mockCmd = commandOf(state.mock.pid);
  check("app-process", alive(state.app.pid) && appCmd.includes(SERVER), appCmd || `pid ${state.app.pid} is not running`);
  check("app-port", listenerPids(state.app.port).includes(state.app.pid), `listeners on ${state.app.port}: ${listenerPids(state.app.port).join(",") || "none"}`);
  check("mock-process", alive(state.mock.pid) && mockCmd.includes(MOCK), mockCmd || `pid ${state.mock.pid} is not running`);
  check("mock-port", listenerPids(state.mock.port).includes(state.mock.pid), `listeners on ${state.mock.port}: ${listenerPids(state.mock.port).join(",") || "none"}`);
  check("db", state.db.startsWith(join(RUNS_ROOT, state.runId)) && Bun.file(state.db).size > 0, state.db);

  try {
    const health = await appFetch(state, "/healthz");
    check("healthz", health.status === 200 && health.text === "ok", `${health.status} ${health.text}`);
  } catch (error) {
    check("healthz", false, String(error));
  }

  try {
    const closed = await statusOf(state);
    check("status-closed", closed.status === 401, `unauthenticated /status returned ${closed.status}`);
    const open = await statusOf(state, `Bearer ${STATUS_TOKEN}`);
    const body = open.body as { agent?: string; knowledge?: { state?: string; documents?: number } };
    check("status", open.status === 200 && body.agent === AGENT && body.knowledge?.state === "ready" && (body.knowledge.documents ?? 0) >= 1, `${open.status} agent=${body.agent} state=${body.knowledge?.state} documents=${body.knowledge?.documents}`);
  } catch (error) {
    check("status", false, String(error));
  }

  try {
    const doc = await adminOf(state, `/api/v1/documents/${WOMBAT_ID}`);
    check("wombat-indexed", doc.status === 200 && JSON.stringify(doc.body).includes("quarterly wombat review"), `admin document ${doc.status}`);
    const wrong = await adminOf(state, `/api/v1/documents/${WOMBAT_ID}`, STATUS_TOKEN);
    check("admin-token-separate", wrong.status === 401, `status token on the admin API returned ${wrong.status}`);
  } catch (error) {
    check("wombat-indexed", false, String(error));
  }

  try {
    const stats = await mockJson(state, "/stats");
    check("mock-stats", stats.status === 200 && typeof stats.body.slackCalls === "number", `mock /stats ${stats.status}`);
  } catch (error) {
    check("mock-stats", false, String(error));
  }

  const log = clip(state.app.log, false);
  check("ready-line", log.includes(`lorehouse: @${AGENT} on :${state.app.port}`), log.trim() ? log : "app log is empty");

  const ok = checks.every((item) => item.ok);
  await finish(state, { ok, runId: state.runId, app: base(state).app, db: state.db, evidence: state.evidence, checks }, ok ? 0 : 1);
}

async function ask(): Promise<never> {
  const state = loadSelected();
  const text = flag("text");
  if (!text) fail("ask needs --text");
  const ts = allocateTs(state);
  const nonce = `[q${state.seq}]`;
  const slackText = `<@${"UBOT"}> ${nonce} ${text}`;
  const posted = await sendEvent(state, {
    type: "app_mention",
    user: "U1",
    team: "T1",
    text: slackText,
    ts,
    event_ts: ts,
    channel: flag("channel") ?? state.channel,
  });
  const timeoutMs = Number(flag("timeout-ms") ?? 20000);
  const waited = await waitReply(state, ts, timeoutMs);
  const reply = cited(waited.body);
  const ok = posted.status === 200 && waited.status === 200 && !waited.body.timeout && !!reply.text;
  await finish(state, {
    ok,
    ts,
    channel: flag("channel") ?? state.channel,
    question: text,
    nonce,
    slackText,
    postStatus: posted.status,
    reply,
    methods: waited.body.methods ?? [],
    timeout: waited.body.timeout === true,
  }, ok ? 0 : 1);
}

async function mention(): Promise<never> {
  const state = loadSelected();
  const text = flag("text");
  if (!text) fail("mention needs --text");
  const channel = flag("channel") ?? state.channel;
  const ts = allocateTs(state);
  const event: Record<string, unknown> = {
    type: "app_mention",
    user: "U1",
    team: "T1",
    text: `<@UBOT> ${text}`,
    ts,
    event_ts: ts,
    channel,
  };
  const channelType = flag("channel-type");
  if (channelType) event.channel_type = channelType;
  const posted = await sendEvent(state, event);
  await finish(state, { ok: posted.status === 200, status: posted.status, ts, channel, event }, posted.status === 200 ? 0 : 1);
}

async function reply(): Promise<never> {
  const state = loadSelected();
  const thread = flag("thread");
  const text = flag("text");
  if (!thread || !text) fail("reply needs --thread and --text");
  const ts = allocateTs(state);
  const posted = await sendEvent(state, {
    type: "message",
    channel: flag("channel") ?? state.channel,
    channel_type: "channel",
    user: "U1",
    text,
    ts,
    event_ts: ts,
    thread_ts: thread,
  });
  await finish(state, { ok: posted.status === 200, status: posted.status, ts, thread, text }, posted.status === 200 ? 0 : 1);
}

async function dm(): Promise<never> {
  const state = loadSelected();
  const text = flag("text");
  if (!text) fail("dm needs --text");
  const before = await mockJson(state, "/stats");
  const ts = allocateTs(state);
  const posted = await sendEvent(state, {
    type: "message",
    channel: "D1",
    channel_type: "im",
    user: "U1",
    text,
    ts,
    event_ts: ts,
  });
  const timeoutMs = Number(flag("timeout-ms") ?? 1500);
  const start = Date.now();
  let stats = before.body;
  while (Date.now() - start < timeoutMs) {
    stats = (await mockJson(state, "/stats")).body;
    const posts = (stats.posts ?? []) as { channel?: string; text?: string }[];
    if (posts.some((post) => post.channel === "D1") || (stats.modelCalls ?? 0) > (before.body.modelCalls ?? 0)) break;
    await Bun.sleep(50);
  }
  if ((stats.modelCalls ?? 0) === (before.body.modelCalls ?? 0) && !((stats.posts ?? []) as { channel?: string }[]).some((post) => post.channel === "D1")) {
    await Bun.sleep(Math.max(0, timeoutMs - (Date.now() - start)));
    stats = (await mockJson(state, "/stats")).body;
  }
  const knowledge = await statusOf(state, `Bearer ${STATUS_TOKEN}`);
  await finish(state, {
    ok: posted.status === 200,
    ts,
    postStatus: posted.status,
    posts: stats.posts ?? [],
    modelCalls: stats.modelCalls ?? 0,
    readChannels: stats.readChannels ?? [],
    documents: (knowledge.body as { knowledge?: { documents?: number } })?.knowledge?.documents,
  }, posted.status === 200 ? 0 : 1);
}

async function postMessage(): Promise<never> {
  const state = loadSelected();
  const text = flag("text");
  if (!text) fail("post needs --text");
  const channel = flag("channel") ?? state.channel;
  const ts = allocateTs(state);
  const fixture = await mockJson(state, "/fixtures/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, message: { ts, user: "U6", text } }),
  });
  const posted = await sendEvent(state, {
    type: "message",
    channel,
    channel_type: flag("channel-type") ?? "channel",
    user: "U6",
    text,
    ts,
    event_ts: ts,
  });
  const ok = fixture.status === 200 && posted.status === 200;
  await finish(state, { ok, ts, channel, text, fixtureStatus: fixture.status, postStatus: posted.status }, ok ? 0 : 1);
}

async function editMessage(): Promise<never> {
  const state = loadSelected();
  const ts = flag("ts");
  const text = flag("text");
  if (!ts || !text) fail("edit needs --ts and --text");
  const channel = flag("channel") ?? state.channel;
  const editedTs = allocateTs(state);
  const fixture = await mockJson(state, "/fixtures/edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, ts, text, editedTs }),
  });
  const posted = await sendEvent(state, {
    type: "message",
    subtype: "message_changed",
    hidden: true,
    channel,
    channel_type: "channel",
    ts: editedTs,
    event_ts: editedTs,
    message: { ts, user: "U7", text, edited: { user: "U7", ts: editedTs } },
    previous_message: { ts },
  });
  const ok = fixture.status === 200 && posted.status === 200;
  await finish(state, { ok, ts, editedTs, channel, text, fixtureStatus: fixture.status, postStatus: posted.status }, ok ? 0 : 1);
}

async function deleteMessage(): Promise<never> {
  const state = loadSelected();
  const ts = flag("ts");
  if (!ts) fail("delete needs --ts");
  const channel = flag("channel") ?? state.channel;
  const fixture = await mockJson(state, "/fixtures/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ channel, ts }),
  });
  const now = allocateTs(state);
  const posted = await sendEvent(state, {
    type: "message",
    subtype: "message_deleted",
    hidden: true,
    channel,
    channel_type: "channel",
    ts: now,
    event_ts: now,
    deleted_ts: ts,
    previous_message: { ts },
  });
  const ok = fixture.status === 200 && posted.status === 200;
  await finish(state, { ok, ts, channel, fixtureStatus: fixture.status, postStatus: posted.status }, ok ? 0 : 1);
}

async function wait(): Promise<never> {
  const state = loadSelected();
  const thread = flag("thread");
  if (!thread) fail("wait needs --thread");
  const timeoutMs = Number(flag("timeout-ms") ?? 20000);
  const waited = await waitReply(state, thread, timeoutMs);
  const reply = cited(waited.body);
  const ok = waited.status === 200 && !waited.body.timeout;
  await finish(state, { ok, thread, reply, methods: waited.body.methods ?? [], timeout: waited.body.timeout === true }, ok ? 0 : 1);
}

async function observe(includeStatus: boolean): Promise<never> {
  const state = loadSelected();
  const ms = Number(flag("ms") ?? (includeStatus ? 1000 : 1500));
  await Bun.sleep(ms);
  const stats = await mockJson(state, "/stats");
  const body: Record<string, unknown> = { ok: true, sleptMs: ms, stats: stats.body };
  if (includeStatus) {
    const status = await statusOf(state, `Bearer ${STATUS_TOKEN}`);
    body.status = status.body;
    body.statusCode = status.status;
  }
  await finish(state, body);
}

async function stats(): Promise<never> {
  const state = loadSelected();
  const result = await mockJson(state, "/stats");
  await finish(state, { ok: result.status === 200, ...result.body }, result.status === 200 ? 0 : 1);
}

async function status(): Promise<never> {
  const state = loadSelected();
  const result = await statusOf(state, `Bearer ${STATUS_TOKEN}`);
  await finish(state, { ok: result.status === 200, status: result.status, body: result.body }, result.status === 200 ? 0 : 1);
}

async function admin(): Promise<never> {
  const state = loadSelected();
  const path = flag("path");
  if (!path || !path.startsWith("/api/")) fail("admin needs --path /api/v1/...");
  const result = await adminOf(state, path);
  await finish(state, { ok: true, status: result.status, body: result.body });
}

async function resetLog(): Promise<never> {
  const state = loadSelected();
  const result = await mockJson(state, "/reset", { method: "POST" });
  await finish(state, { ok: result.status === 200, cleared: "mock call log; fixtures and lorehouse.db are unchanged" });
}

function list(): never {
  mkdirSync(RUNS_ROOT, { recursive: true });
  const current = existsSync(CURRENT) ? readText(CURRENT).trim() : null;
  const runs = readdirSync(RUNS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        const state = readState(entry.name);
        return {
          runId: state.runId,
          current: state.runId === current,
          ready: state.ready,
          appPid: state.app.pid,
          appAlive: alive(state.app.pid),
          mockPid: state.mock.pid,
          mockAlive: alive(state.mock.pid),
          app: `http://127.0.0.1:${state.app.port}`,
          evidence: state.evidence,
        };
      } catch {
        return { runId: entry.name, unreadable: true };
      }
    });
  emit({ ok: true, current, runs });
}

async function cleanup(): Promise<never> {
  const runId = flag("run") ?? (existsSync(CURRENT) ? readText(CURRENT).trim() : "");
  if (!runId) emit({ ok: true, removed: false, reason: "no run" });
  let state: State;
  try {
    state = readState(runId);
  } catch {
    emit({ ok: true, removed: false, runId, reason: "no state" });
  }
  const evidence = state.evidence;
  await cleanupRun(state);
  const evidenceStillThere = exists(evidence);
  emit({
    ok: evidenceStillThere,
    removed: true,
    runId,
    evidence,
    evidenceStillThere,
  }, evidenceStillThere ? 0 : 1);
}

function exists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

async function cleanupRun(state: State): Promise<void> {
  if (state.evidence.startsWith(state.dir)) fail("refusing to clean up: evidence directory is inside the run directory");
  const appGone = state.app.pid ? await stopPid(state.app.pid, SERVER) : true;
  const mockGone = state.mock.pid ? await stopPid(state.mock.pid, MOCK) : true;
  for (const port of [state.app.port, state.mock.port]) {
    for (const pid of listenerPids(port)) {
      const commandLine = commandOf(pid);
      if (commandLine.includes(state.dir) || commandLine.includes(SERVER) && pid === state.app.pid || commandLine.includes(MOCK) && pid === state.mock.pid) {
        await stopPid(pid, commandLine.includes(MOCK) ? MOCK : SERVER);
      }
    }
  }
  if (!appGone || !mockGone) fail("a process this run started is still alive", { runId: state.runId, appGone, mockGone });
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(state.db + suffix, { force: true });
    rmSync(join(state.dir, "sessions.db") + suffix, { force: true });
  }
  rmSync(state.dir, { recursive: true, force: true });
  if (existsSync(CURRENT) && readText(CURRENT).trim() === state.runId) rmSync(CURRENT, { force: true });
}

const commands: Record<string, () => Promise<never> | never> = {
  launch,
  doctor,
  ask,
  mention,
  reply,
  dm,
  post: postMessage,
  edit: editMessage,
  delete: deleteMessage,
  wait,
  quiet: () => observe(false),
  settle: () => observe(true),
  stats,
  status,
  admin,
  "reset-log": resetLog,
  list,
  cleanup,
};

const run = command ? commands[command] : undefined;
if (!run) {
  fail(`unknown command ${command ?? "(none)"}`, { commands: Object.keys(commands) });
}
await run();
