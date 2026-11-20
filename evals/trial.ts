// trial.ts — one trial of one case: a fresh, isolated instance (its own temp directory,
// databases and ports), the conformance mock for Slack and GitHub, the fake runner for the
// sandbox, and the model behind the recording proxy. The conversation is driven as Slack
// would deliver it; what everything observed becomes the trial's Observation.
//
// Nothing waits on a fixed sleep alone: each step waits for something observable (a
// stream stopped, a card posted) and then for quiet (no model call in flight, and nothing
// new seen for a while), under a deadline that fails the trial naming what it waited for.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wsRunner, type FakeRunner, type Job, type JobAnswer } from "../conformance/fake-runner";
import { appEnv, buttonOn, postEvent, postInteraction, waitHttp, type Block, type Stats } from "../conformance/harness";
import type { Case, Observation, RunnerJob, Said, SlackCall, Step, StepMark, ToolCall, Until } from "./case";
import type { Proxy } from "./proxy";
import { commandOf, scriptedSandbox } from "./sandbox";

const ROOT = join(import.meta.dir, "..");
const FIXTURES = join(ROOT, "conformance/fixtures");

export const CHANNEL = "C1";
export const DM_CHANNEL = "D1";
const SECRET = "eval-signing-secret";
const STATUS_TOKEN = "eval-status-token";
const ADMIN_TOKEN = "eval-admin-token-00000000000000000000";
const RUNNER_TOKEN = "eval-runner-token-0000000000000000000";
// What the app is given in place of the model credential: the proxy holds the real one.
export const PLACEHOLDER_KEY = "eval-placeholder-key";
// How long nothing may happen, with a turn begun and no model call in flight, before a
// step still waiting is given up on.
const IDLE_MS = 10_000;

export type TrialOptions = {
  dry: boolean;
  // The app's ANTHROPIC_MODEL; unset, the app's own default.
  model?: string;
  proxy: Proxy;
  // Where the real model is (ignored with `dry`, whose model is the trial's own mock).
  upstream: string;
  // Unique in this process: the trial's Slack timestamps come from it, so no two trials
  // share a thread (or a sandbox id).
  seq: number;
  quietMs: number;
  deadlineMs: number;
  log: (line: string) => void;
};

export type TrialRun = { observation: Observation; ms: number; setupError?: string };

// Every process this run started and hasn't reaped, for a signal handler to kill.
export const children = new Set<ReturnType<typeof Bun.spawn>>();

// A local port nothing listens on: bound, then let go.
// Never one this process already handed out: two trials starting together must not be
// given the same port before either has bound it.
const handedOut = new Set<number>();
async function freePort(): Promise<number> {
  for (;;) {
    const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = server.port;
    server.stop(true);
    if (handedOut.has(port)) continue;
    handedOut.add(port);
    return port;
  }
}

// The environment the app under test starts with. Only what a process needs from this
// shell (PATH and the like) is inherited: never its model credential, which the proxy
// holds, nor anything else that would configure Lorehouse.
export function trialAppEnv(
  shell: Record<string, string | undefined>,
  o: { port: number; mock: string; db: string; sessions: string; modelBase: string; model?: string; code: boolean; extra?: Record<string, string> },
): Record<string, string | undefined> {
  const inherited = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "USER"].flatMap((k) => (shell[k] ? [[k, shell[k]!]] : [])));
  return appEnv(
    inherited,
    { port: o.port, secret: SECRET, mock: o.mock, channels: CHANNEL, seed: join(FIXTURES, "corpus.jsonl"), db: o.db, statusToken: STATUS_TOKEN, adminToken: ADMIN_TOKEN },
    {
      ANTHROPIC_API_KEY: PLACEHOLDER_KEY,
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: o.modelBase,
      ANTHROPIC_MODEL: o.model ?? "",
      SESSIONS_DB: o.sessions,
      // Everything a checkout's .env or this shell could otherwise decide.
      DM_MODE: "", PR_APPROVER: "", AGENT_NAME: "", AGENT_CO_AUTHOR: "", SLACK_BOT_USER_ID: "", LOG_SLACK_EVENTS: "", USAGE_RECORD_PEOPLE: "",
      SANDBOX_URL: "", SANDBOX_TOKEN: "", GITHUB_APP_ID: "", GITHUB_APP_PRIVATE_KEY: "",
      SANDBOX_RUNNER_TOKEN: o.code ? RUNNER_TOKEN : "",
      GITHUB_TOKEN: o.code ? "eval-github-placeholder" : "",
      GITHUB_API_URL: o.code ? `${o.mock}/github` : "",
      ...o.extra,
    },
  );
}

const describe = (s: Step): string =>
  "mention" in s ? `mention by ${s.user ?? "U1"}` : "reply" in s ? `reply by ${s.user ?? "U1"}` : "dm" in s ? `DM by ${s.user ?? "U1"}` : "click" in s ? `click ${s.click} by ${s.user}` : `quiet ${s.quiet} ms`;

// A stream call's text, whether sent as markdown_text or as markdown chunks.
function streamText(body: Record<string, unknown>): string {
  let text = typeof body.markdown_text === "string" ? body.markdown_text : "";
  for (const c of (Array.isArray(body.chunks) ? body.chunks : []) as { type?: string; text?: string }[]) if (c?.type === "markdown_text" && c.text) text += c.text;
  return text;
}

// The text of a message's blocks (a card's sections), beside its `text`.
function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return (blocks as { text?: { text?: string } }[]).map((b) => b?.text?.text ?? "").filter(Boolean).join("\n");
}

// What the agent put in front of people, out of the raw Slack calls.
export function saidFrom(calls: SlackCall[]): Said[] {
  const out: Said[] = [];
  const streams = new Map<string, Said>();
  for (const c of calls) {
    const b = c.body;
    if (c.method === "chat.startStream") {
      const s: Said = { via: "stream", channel: b.channel as string, thread: b.thread_ts as string | undefined, ts: String(b.__stream_ts), text: streamText(b), call: c.n, open: true };
      streams.set(String(b.__stream_ts), s);
      out.push(s);
    } else if (c.method === "chat.appendStream" || c.method === "chat.stopStream") {
      const s = streams.get(String(b.ts));
      if (!s) continue;
      s.text += streamText(b);
      s.call = c.n;
      if (c.method === "chat.stopStream") delete s.open;
    } else if (c.method === "chat.postMessage") {
      const text = [typeof b.text === "string" ? b.text : "", blocksText(b.blocks)].filter(Boolean).join("\n");
      out.push({ via: "post", channel: b.channel as string, thread: b.thread_ts as string | undefined, ts: b.__ts as string | undefined, text, ...(Array.isArray(b.blocks) ? { blocks: b.blocks } : {}), call: c.n });
    } else if (c.method === "chat.update") {
      const text = [typeof b.text === "string" ? b.text : "", blocksText(b.blocks)].filter(Boolean).join("\n");
      out.push({ via: "update", channel: b.channel as string, ts: b.ts as string | undefined, text, call: c.n });
    } else if (c.method === "response_url" || c.method === "chat.postEphemeral") {
      out.push({ via: "ephemeral", channel: b.channel as string | undefined, text: typeof b.text === "string" ? b.text : "", path: b.__path as string | undefined, call: c.n });
    }
  }
  return out;
}

// A job as the observation keeps it: decoded, and with any token replaced.
function observeJob(n: number, job: Job, answer: JobAnswer): RunnerJob {
  const decode = (b64?: string): unknown => {
    if (!b64) return undefined;
    const text = Buffer.from(b64, "base64").toString();
    try {
      return JSON.parse(text);
    } catch {
      return text.length > 2000 ? `${text.slice(0, 2000)}… [${text.length - 2000} more chars]` : text;
    }
  };
  let body = decode(job.bodyBase64);
  if (body && typeof body === "object") {
    const b = { ...(body as Record<string, unknown>) };
    if ("token" in b) b.token = "[redacted]";
    if (b.env && typeof b.env === "object") b.env = Object.keys(b.env as object); // names only
    body = b;
  }
  const result = answer.contentType === "application/json" ? decode(answer.bodyBase64) : undefined;
  const exec = result && typeof result === "object" ? (result as { exitCode?: number; stdout?: string; stderr?: string }) : undefined;
  const fields = body && typeof body === "object" ? (body as { cwd?: string }) : undefined;
  return {
    n, sandbox: job.sandbox, op: job.op, method: job.method, path: job.path, timeoutMs: job.timeoutMs,
    command: commandOf(job), cwd: fields?.cwd, body,
    answer: {
      status: answer.status, code: answer.code, error: answer.error,
      ...(typeof exec?.exitCode === "number" ? { exitCode: exec.exitCode, stdout: exec.stdout, stderr: exec.stderr } : result !== undefined ? { body: result } : {}),
    },
  };
}

// The tail of a process's output, read as it runs.
function tail(stream: ReadableStream<Uint8Array> | undefined, max = 60_000): { text: () => string; done: Promise<void> } {
  let text = "";
  const done = (async () => {
    if (!stream) return;
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > max * 2) text = text.slice(-max);
    }
  })().catch(() => {});
  return { text: () => text.slice(-max), done };
}

export async function runTrial(c: Case, id: string, opts: TrialOptions): Promise<TrialRun> {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "lorehouse-eval-"));
  const code = c.suite === "code";
  const jobs: RunnerJob[] = [];
  const marks: StepMark[] = c.conversation.map((s, n) => ({ n, as: s.as, step: describe(s), slack: 0, jobs: 0, github: 0, turns: 0, outcome: "skipped" as const }));
  let mock: ReturnType<typeof Bun.spawn> | undefined;
  let app: ReturnType<typeof Bun.spawn> | undefined;
  let runner: FakeRunner | undefined;
  let appOut = { text: () => "", done: Promise.resolve() };
  let appErr = { text: () => "", done: Promise.resolve() };
  let mockUrl = "";
  let thread: string | undefined;
  let setupError: string | undefined;
  let exit: number | null = null;
  let seq = 0;
  // Slack timestamps of this trial: no two trials of a run share one.
  const nextTs = () => `${1_900_000_000 + opts.seq * 100 + ++seq}.000100`;

  const calls = async (): Promise<SlackCall[]> =>
    ((await (await fetch(`${mockUrl}/calls`)).json()) as { calls: { method: string; body: Record<string, unknown> }[] }).calls.map((x, n) => ({ n, method: x.method, body: x.body }));
  const stats = async () => (await (await fetch(`${mockUrl}/stats`)).json()) as Stats;
  const turns = () => opts.proxy.turns(id);

  try {
    const mockPort = await freePort();
    const appPort = await freePort();
    mockUrl = `http://localhost:${mockPort}`;
    const target = `http://localhost:${appPort}/slack/events`;
    mock = Bun.spawn(["bun", join(ROOT, "conformance/mock.ts")], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(mockPort), TTFT_MS: "20", TOKEN_DELAY_MS: "1", TOKENS: "12", SLACK_FIXTURES: join(FIXTURES, "slack-history.json") },
      stdout: "ignore", stderr: "ignore",
    });
    children.add(mock);
    if (!(await waitHttp(`${mockUrl}/stats`, 10_000))) throw new Error("the mock (conformance/mock.ts) never came up");
    const fixture = (path: string, body: unknown) => fetch(`${mockUrl}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    for (const m of c.setup?.messages ?? []) await fixture("/fixtures/messages", m);

    const modelBase = opts.proxy.open(id, opts.dry ? `${mockUrl}/anthropic` : opts.upstream);
    const proc = Bun.spawn(["bun", join(ROOT, "src/server.ts")], {
      // Its own directory: the checkout's .env is never loaded.
      cwd: dir,
      env: trialAppEnv(process.env, { port: appPort, mock: mockUrl, db: join(dir, "lorehouse.db"), sessions: join(dir, "sessions.db"), modelBase, model: opts.model, code, extra: c.setup?.env }),
      stdout: "pipe", stderr: "pipe",
    });
    app = proc;
    children.add(proc);
    appOut = tail(proc.stdout as ReadableStream<Uint8Array>);
    appErr = tail(proc.stderr as ReadableStream<Uint8Array>);
    const appUrl = `http://localhost:${appPort}`;
    const up = await Promise.race([waitHttp(`${appUrl}/healthz`, 30_000), proc.exited.then(() => false)]);
    if (!up) throw new Error(`the app never answered /healthz${proc.exitCode !== null ? ` (it exited ${proc.exitCode})` : ""}: ${appErr.text().slice(-600)}`);
    const status = async () => (await (await fetch(`${appUrl}/status`, { headers: { authorization: `Bearer ${STATUS_TOKEN}` } })).json()) as { knowledge?: { state?: string }; runners?: { runner: string; online: boolean }[] };
    const ready = Date.now();
    while ((await status().catch(() => undefined))?.knowledge?.state !== "ready") {
      if (Date.now() - ready > 30_000) throw new Error(`the app's ingest never became ready: ${JSON.stringify(await status().catch((e) => String(e)))}`);
      await Bun.sleep(50);
    }

    if (code) {
      const script = scriptedSandbox(c.setup?.sandbox, { dry: opts.dry });
      runner = await wsRunner(appUrl, RUNNER_TOKEN, "eval-runner", { answer: script, onAnswer: (job, answer) => jobs.push(observeJob(jobs.length, job, answer)) });
      const online = Date.now();
      while (!(await status()).runners?.some((r) => r.runner === "eval-runner" && r.online)) {
        if (Date.now() - online > 10_000) throw new Error("the fake runner connected but /status never listed it online");
        await Bun.sleep(50);
      }
    }
    if (c.setup?.defaultRepo) {
      if (!code) throw new Error("setup.defaultRepo needs the code suite (code tools are off in the knowledge suite)");
      const r = await fetch(`${appUrl}/api/v1/channels/${CHANNEL}/repo`, { method: "PUT", headers: { authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify(c.setup.defaultRepo) });
      if (r.status !== 200) throw new Error(`setting the channel's default repo through the admin API: ${r.status} ${(await r.text()).slice(0, 300)}`);
    }

    // ── the conversation ──────────────────────────────────────────────────
    let clicks = 0;
    for (const [n, step] of c.conversation.entries()) {
      const mark = marks[n]!;
      const began = Date.now();
      const before = await calls();
      Object.assign(mark, { slack: before.length, jobs: jobs.length, github: (await stats()).github.length, turns: turns().length });
      const deadline = began + (step.deadlineMs ?? opts.deadlineMs);
      let until: Until = step.until ?? "quiet";
      let cardTs: string | undefined;
      let clicker: string | undefined;
      let channel = CHANNEL;

      if ("mention" in step || "reply" in step || "dm" in step) {
        const user = step.user ?? "U1";
        const written = "mention" in step ? step.mention : "reply" in step ? step.reply : step.dm;
        const text = opts.dry && step.dry !== undefined ? step.dry : written;
        const ts = nextTs();
        if ("dm" in step) {
          channel = DM_CHANNEL;
          until = step.until ?? "post";
          await postEvent(target, SECRET, `EvEval${opts.seq}-${seq}`, { type: "message", channel: DM_CHANNEL, channel_type: "im", user, text, ts, event_ts: ts });
        } else {
          until = step.until ?? "reply";
          const mention = "mention" in step;
          if (!mention && !thread) throw new Error(`step ${n} is a reply, but no mention has started a thread yet`);
          const full = mention ? `<@UBOT> ${text}` : text;
          // In Slack's history too, as a real message is: a tool that reads the thread finds it.
          await fixture("/fixtures/messages", { channel: CHANNEL, message: { ts, user, text: full, ...(thread ? { thread_ts: thread } : {}) } });
          const event = mention
            ? { type: "app_mention", user, team: "T1", text: full, ts, event_ts: ts, channel: CHANNEL, ...(thread ? { thread_ts: thread } : {}) }
            : { type: "message", channel: CHANNEL, channel_type: "channel", user, text: full, ts, event_ts: ts, thread_ts: thread };
          thread ??= ts;
          const r = await postEvent(target, SECRET, `EvEval${opts.seq}-${seq}`, event);
          if (r.status !== 200) throw new Error(`step ${n} (${mark.step}): the app answered the Slack event with ${r.status}`);
        }
      } else if ("click" in step) {
        until = step.until ?? "update";
        clicker = step.user;
        const posted = saidFrom(before).filter((s) => s.via === "post" && s.thread === thread && buttonOn(s.blocks as Block[] | undefined, step.click));
        const on = posted.at(-1);
        const button = buttonOn(on?.blocks as Block[] | undefined, step.click);
        if (!on || !button?.action_id) {
          Object.assign(mark, { outcome: "failed", detail: `there is no card with a ${step.click} button in the thread to click`, ms: Date.now() - began });
          break;
        }
        cardTs = on.ts;
        await postInteraction(target, SECRET, {
          type: "block_actions", user: { id: step.user }, team: { id: "T1" }, channel: { id: CHANNEL },
          message: { ts: on.ts, thread_ts: thread }, response_url: `${mockUrl}/slack/response/${step.user}-${++clicks}`,
          actions: [{ type: "button", action_id: button.action_id, value: button.value }],
        });
      }

      // Wait for what the step waits for, then for quiet.
      const quietMs = "quiet" in step ? step.quiet : opts.quietMs;
      const met = (all: SlackCall[]): boolean => {
        const fresh = all.slice(mark.slack);
        const said = saidFrom(all).filter((s) => s.call >= mark.slack);
        switch (until) {
          case "reply": return said.some((s) => s.via === "stream" && s.thread === thread && !s.open);
          case "card": return said.some((s) => s.via === "post" && s.thread === thread && buttonOn(s.blocks as Block[] | undefined, "Approve"));
          case "update": return fresh.some((x) => x.method === "chat.update" && x.body.ts === cardTs);
          case "ephemeral": return fresh.some((x) => x.method === "response_url" && String(x.body.__path).startsWith(`/slack/response/${clicker}-`));
          case "post": return fresh.some((x) => x.method === "chat.postMessage" && x.body.channel === channel);
          case "quiet": return true;
        }
      };
      const waitingFor: Record<Until, string> = {
        reply: `the agent's streamed reply in thread ${thread} to end`, card: `an Approve/Deny card in thread ${thread}`,
        update: `a chat.update of the clicked card ${cardTs}`, ephemeral: `an ephemeral reply to ${clicker}`, post: `a message posted to ${channel}`, quiet: "quiet",
      };
      let seen = -1;
      let changedAt = Date.now();
      // A model call just answered is followed by what the app does with the answer (the
      // reply's last append, the card's update): quiet is counted from then, too.
      let busyAt = 0;
      let fatalAt: number | undefined;
      let failure: string | undefined;
      for (;;) {
        const all = await calls();
        const now = Date.now();
        const count = all.length + jobs.length + turns().length;
        if (count !== seen) { seen = count; changedAt = now; }
        const ok = met(all);
        if (opts.proxy.inFlight(id) > 0) busyAt = now;
        if (ok && opts.proxy.inFlight(id) === 0 && now - Math.max(changedAt, busyAt) >= quietMs) break;
        // A model call that failed for good (not one the SDK retries): the turn can't go on.
        const fatal = turns().slice(mark.turns).find((t) => t.error && (t.status === 0 || (t.status! >= 400 && t.status! < 500 && ![408, 409, 429].includes(t.status!))));
        if (fatal && !ok) fatalAt ??= now;
        const since = () => `Since the step began: Slack calls [${all.slice(mark.slack).map((x) => x.method).join(", ")}]; ${jobs.length - mark.jobs} runner job(s); ${turns().length - mark.turns} model turn(s), ${opts.proxy.inFlight(id)} in flight${turns().at(-1)?.response ? `, the last stopped with ${turns().at(-1)!.response!.stopReason}` : ""}`;
        if (fatal && !ok && now - fatalAt! > 2000) { failure = `a model call failed (turn ${fatal.n}, HTTP ${fatal.status}): ${fatal.error}. Was waiting for ${waitingFor[until]}. ${since()}`; break; }
        // The turn is over and what the step waits for never came: the model answered
        // some other way (a reply and no card). No need to sit out the deadline.
        if (!ok && turns().length > mark.turns && opts.proxy.inFlight(id) === 0 && now - Math.max(changedAt, busyAt) >= IDLE_MS) { failure = `no ${waitingFor[until]}: the turn ended without it (nothing new for ${IDLE_MS} ms and no model call in flight). ${since()}`; break; }
        if (app.exitCode !== null) { failure = `the app exited (${app.exitCode}) while waiting for ${waitingFor[until]}: ${appErr.text().slice(-400)}`; break; }
        if (now > deadline) { failure = `${ok ? "it never went quiet" : `no ${waitingFor[until]}`} within ${step.deadlineMs ?? opts.deadlineMs} ms. ${since()}`; break; }
        await Bun.sleep(50);
      }
      mark.ms = Date.now() - began;
      if (failure) { Object.assign(mark, { outcome: "failed", detail: failure }); break; }
      mark.outcome = "done";
    }
  } catch (err) {
    setupError = err instanceof Error ? err.message : String(err);
  }

  // ── what was observed ───────────────────────────────────────────────────
  const all = mockUrl ? await calls().catch(() => [] as SlackCall[]) : [];
  const final = mockUrl ? await stats().catch(() => undefined) : undefined;
  await runner?.stop().catch(() => {});
  if (app) {
    app.kill();
    if ((await Promise.race([app.exited, Bun.sleep(8000).then(() => "timeout" as const)])) === "timeout") {
      app.kill("SIGKILL");
      await app.exited;
    }
    exit = app.exitCode;
    await Promise.race([Promise.all([appOut.done, appErr.done]), Bun.sleep(1000)]);
    children.delete(app);
  }
  if (mock) {
    mock.kill();
    await mock.exited;
    children.delete(mock);
  }
  rmSync(dir, { recursive: true, force: true });

  const modelTurns = turns();
  const toolCalls: ToolCall[] = modelTurns.flatMap((t) => (t.response?.content ?? []).flatMap((b) => (b.type === "tool_use" ? [{ turn: t.n, name: b.name, input: b.input }] : [])));
  const observation: Observation = {
    channel: CHANNEL,
    thread,
    steps: marks,
    slack: {
      calls: all,
      said: saidFrom(all),
      uploads: final?.uploads ?? [],
      reactions: all.filter((x) => x.method === "reactions.add").map((x) => ({ name: String(x.body.name), channel: x.body.channel as string | undefined, ts: x.body.timestamp as string | undefined, call: x.n })),
    },
    runner: { connected: !!runner, jobs },
    github: { calls: (final?.github ?? []).map((g, n) => ({ ...g, n })) },
    model: { turns: modelTurns, toolCalls },
    app: { exit, stderr: appErr.text(), stdout: appOut.text() },
  };
  return { observation, ms: Date.now() - t0, setupError };
}
