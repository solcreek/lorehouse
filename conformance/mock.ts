// mock.ts — one process standing in for BOTH external APIs, so the TS and Go
// implementations are measured against identical, deterministic upstreams.
//
//   /slack/api/<method>        Slack Web API (JSON or form bodies). Records every call.
//   /anthropic/v1/messages     Anthropic Messages API, streaming (SSE) or not.
//   GET  /wait?thread_ts=…     long-poll until that thread's stream is stopped
//   GET  /stats                all recorded Slack calls + model call count
//   POST /reset
//
// The scripted model: turn 1 → a search_knowledge tool_use whose query is the user's
// question; turn 2 (tool_result present) → a streamed answer that echoes the question's
// nonce and cites the first chunk id it finds in the tool_result, so the harness can
// check the retrieval actually reached the model.
//
// Env: PORT (8900), TTFT_MS (300) delay before the first event, TOKENS (80),
//      TOKEN_DELAY_MS (15) between text deltas.

const PORT = Number(process.env.PORT ?? 8900);
const TTFT_MS = Number(process.env.TTFT_MS ?? 300);
const TOKENS = Number(process.env.TOKENS ?? 80);
const TOKEN_DELAY_MS = Number(process.env.TOKEN_DELAY_MS ?? 15);

type SlackCall = { t: number; method: string; body: Record<string, unknown> };
let calls: SlackCall[] = [];
let modelCalls = 0;
const waiters = new Map<string, ((c: SlackCall[]) => void)[]>();
let nextTs = 1_700_000_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  if (type.includes("application/json")) return raw ? JSON.parse(raw) : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(raw)) {
    // slack-go sends structured fields (chunks, blocks) as JSON strings in form bodies
    out[k] = /^[\[{]/.test(v) ? safeJson(v) : v;
  }
  return out;
}
const safeJson = (s: string) => { try { return JSON.parse(s); } catch { return s; } };

// Text a stream call carries, whether sent as markdown_text or as markdown chunks.
function streamText(body: Record<string, unknown>): string {
  let text = typeof body.markdown_text === "string" ? body.markdown_text : "";
  const chunks = Array.isArray(body.chunks) ? body.chunks : [];
  for (const c of chunks as { type?: string; text?: string }[]) if (c?.type === "markdown_text" && c.text) text += c.text;
  return text;
}

function threadCalls(threadTs: string): SlackCall[] {
  // a stream is opened with thread_ts; later appends/stops reference the stream's ts
  const opened = calls.filter((c) => c.method === "chat.startStream" && c.body.thread_ts === threadTs);
  const streamTs = new Set(opened.map((c) => String(c.body.__stream_ts)));
  return calls.filter((c) => (c.method === "chat.startStream" && c.body.thread_ts === threadTs) || streamTs.has(String(c.body.ts)));
}

function slack(method: string, body: Record<string, unknown>): Response {
  // epoch ms, not performance.now(): the driver (another process) compares against it
  const call: SlackCall = { t: Date.now(), method, body };
  if (method === "chat.startStream") {
    const ts = `${++nextTs}.000100`;
    call.body.__stream_ts = ts;
    calls.push(call);
    return Response.json({ ok: true, channel: body.channel, ts });
  }
  calls.push(call);
  if (method === "chat.stopStream") {
    const open = calls.find((c) => c.method === "chat.startStream" && c.body.__stream_ts === body.ts);
    const thread = open ? String(open.body.thread_ts) : "";
    for (const w of waiters.get(thread) ?? []) w(threadCalls(thread));
    waiters.delete(thread);
  }
  if (method === "auth.test") return Response.json({ ok: true, user_id: "UBOT", team_id: "T1", bot_id: "B1" });
  return Response.json({ ok: true });
}

// ── Anthropic ────────────────────────────────────────────────────────────────

type Block = { type: string; text?: string; content?: unknown; tool_use_id?: string };
type Msg = { role: string; content: string | Block[] };

function lastUserHasToolResult(messages: Msg[]): Block | undefined {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || typeof last.content === "string") return undefined;
  return last.content.find((b) => b.type === "tool_result");
}

function firstUserText(messages: Msg[]): string {
  const m = messages.find((x) => x.role === "user");
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  return m.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
}

function answerFor(messages: Msg[], result: Block): string {
  const question = firstUserText(messages);
  const nonce = question.match(/\[q\d+\]/)?.[0] ?? "[q?]";
  const cite = JSON.stringify(result.content ?? "").match(/\bc\d+\b/)?.[0] ?? "none";
  const words = Array.from({ length: TOKENS }, (_, i) => `w${i}`);
  return `${nonce} [cite:${cite}] ${words.join(" ")}`;
}

function sse(events: [string, unknown][], firstDelay: number, gap: (i: number) => number): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      await sleep(firstDelay);
      for (let i = 0; i < events.length; i++) {
        const [event, data] = events[i]!;
        ctrl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        const g = gap(i);
        if (g) await sleep(g);
      }
      ctrl.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

function message(id: string, content: unknown[], stopReason: string) {
  return { id, type: "message", role: "assistant", model: "claude-opus-5", content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } };
}

async function anthropic(req: Request): Promise<Response> {
  modelCalls++;
  const body = (await req.json()) as { messages: Msg[]; stream?: boolean; tools?: { name: string }[] };
  const id = `msg_${modelCalls}`;
  const result = lastUserHasToolResult(body.messages);

  if (!result) {
    const query = firstUserText(body.messages).replace(/<@[A-Z0-9]+>/g, "").replace(/\[q\d+\]/, "").trim();
    const input = { query };
    if (!body.stream) {
      await sleep(TTFT_MS);
      return Response.json(message(id, [{ type: "tool_use", id: `toolu_${modelCalls}`, name: "search_knowledge", input }], "tool_use"));
    }
    const json = JSON.stringify(input);
    return sse([
      ["message_start", { type: "message_start", message: { ...message(id, [], null as unknown as string), stop_reason: null } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${modelCalls}`, name: "search_knowledge", input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(0, Math.ceil(json.length / 2)) } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(Math.ceil(json.length / 2)) } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
      ["message_stop", { type: "message_stop" }],
    ], TTFT_MS, () => 0);
  }

  const answer = answerFor(body.messages, result);
  if (!body.stream) {
    await sleep(TTFT_MS + TOKENS * TOKEN_DELAY_MS);
    return Response.json(message(id, [{ type: "text", text: answer }], "end_turn"));
  }
  const pieces = answer.split(/(?<= )/); // keep the spaces: concatenation must reproduce the answer
  const events: [string, unknown][] = [
    ["message_start", { type: "message_start", message: { ...message(id, [], null as unknown as string), stop_reason: null } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ...pieces.map((p): [string, unknown] => ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: p } }]),
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: pieces.length } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const firstDelta = 2, lastDelta = 2 + pieces.length - 1;
  return sse(events, TTFT_MS, (i) => (i >= firstDelta && i < lastDelta ? TOKEN_DELAY_MS : 0));
}

// ── server ───────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/slack/api/")) return slack(url.pathname.slice("/slack/api/".length), await parseBody(req));
    if (url.pathname === "/anthropic/v1/messages" && req.method === "POST") return anthropic(req);
    if (url.pathname === "/wait") {
      const thread = url.searchParams.get("thread_ts") ?? "";
      const timeout = Number(url.searchParams.get("timeout_ms") ?? 30000);
      const done = threadCalls(thread).some((c) => c.method === "chat.stopStream");
      if (done) return Response.json(summarize(threadCalls(thread)));
      const got = await Promise.race([
        new Promise<SlackCall[]>((r) => waiters.set(thread, [...(waiters.get(thread) ?? []), r])),
        sleep(timeout).then(() => null),
      ]);
      return got ? Response.json(summarize(got)) : Response.json({ timeout: true, calls: threadCalls(thread).map((c) => c.method) }, { status: 504 });
    }
    if (url.pathname === "/stats") return Response.json({ slackCalls: calls.length, modelCalls, byMethod: countBy(calls.map((c) => c.method)) });
    if (url.pathname === "/reset") { calls = []; modelCalls = 0; return Response.json({ ok: true }); }
    return new Response("not found", { status: 404 });
  },
});

function summarize(cs: SlackCall[]) {
  const start = cs.find((c) => c.method === "chat.startStream");
  const stop = cs.find((c) => c.method === "chat.stopStream");
  const text = cs.filter((c) => c.method.endsWith("Stream")).map((c) => streamText(c.body)).join("");
  return {
    methods: cs.map((c) => c.method),
    appends: cs.filter((c) => c.method === "chat.appendStream").length,
    text,
    startAt: start?.t,
    stopAt: stop?.t,
    recipients: { team: start?.body.recipient_team_id, user: start?.body.recipient_user_id },
  };
}
const countBy = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});

console.log(`mock listening on :${PORT} (TTFT ${TTFT_MS}ms, ${TOKENS} tokens × ${TOKEN_DELAY_MS}ms)`);
