// The eval harness's recording proxy (evals/proxy.ts) and what it reads responses with
// (evals/sse.ts), against an upstream that answers with hand-written responses in the
// Messages API's streaming format (the event shapes are the SDK's RawMessageStreamEvent).
// The real SDK client is the app's side of each exchange, as it is in the app.

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, expect, test } from "bun:test";
import { antToken, noCredential, resolveCredential, scrub, type Credential } from "../evals/credential";
import { grader, parseVerdict } from "../evals/grader";
import { startProxy, type Proxy } from "../evals/proxy";
import { SseReader, StreamedMessage, totalTokens } from "../evals/sse";
import { PLACEHOLDER_KEY, trialAppEnv } from "../evals/trial";

const sse = (events: [string, unknown][]) => events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");

// A turn that says a line, then calls two tools: one whose input arrives in pieces, one
// with no input at all.
const TOOL_TURN: [string, unknown][] = [
  ["message_start", { type: "message_start", message: { id: "msg_01A", type: "message", role: "assistant", model: "claude-opus-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2105, cache_creation_input_tokens: 300, cache_read_input_tokens: 1200, output_tokens: 3 } } }],
  ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
  ["ping", { type: "ping" }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "I'll get the repo — 先看一下" } }],
  ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " 🙂." } }],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_01", name: "workspace_clone", input: {} } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "" } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"repo": "acme' } }],
  ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '/gadgets"}' } }],
  ["content_block_stop", { type: "content_block_stop", index: 1 }],
  ["content_block_start", { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_02", name: "recent_knowledge", input: {} } }],
  ["content_block_stop", { type: "content_block_stop", index: 2 }],
  ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 87 } }],
  ["message_stop", { type: "message_stop" }],
];
const WANT_CONTENT = [
  { type: "text", text: "I'll get the repo — 先看一下 🙂." },
  { type: "tool_use", id: "toolu_01", name: "workspace_clone", input: { repo: "acme/gadgets" } },
  { type: "tool_use", id: "toolu_02", name: "recent_knowledge", input: {} },
];
const WANT_TOKENS = { input: 2105, output: 87, cacheRead: 1200, cacheWrite: 300 };

const REAL = "sk-ant-real-credential-0123456789abcdef";
const key = (value = REAL): Credential => ({ kind: "api_key", header: () => ["x-api-key", value], refresh: async () => false, secrets: () => [value] });

type Seen = { path: string; headers: Record<string, string>; body: string };
const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

// An upstream that answers every request with `answer`, and keeps what it was sent.
function upstream(answer: (seen: Seen, n: number) => Response): { url: string; seen: Seen[] } {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const s = { path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() };
      seen.push(s);
      return answer(s, seen.length);
    },
  });
  stops.push(() => server.stop(true));
  return { url: `http://localhost:${server.port}`, seen };
}
const streamed = (events: [string, unknown][]) => new Response(sse(events), { headers: { "content-type": "text/event-stream" } });
function proxyFor(credential: Credential, maxTokens = 1_000_000): Proxy {
  const proxy = startProxy({ credential, maxTokens });
  stops.push(() => proxy.stop());
  return proxy;
}
// The app's side: the SDK, holding a placeholder key, pointed at the proxy.
const client = (baseURL: string) => new Anthropic({ apiKey: PLACEHOLDER_KEY, baseURL, maxRetries: 2 });
const REQUEST = { model: "claude-opus-5", max_tokens: 4096, system: "You are scout.", tools: [{ name: "workspace_clone", description: "clone", input_schema: { type: "object" as const, properties: {} } }], messages: [{ role: "user" as const, content: "run the tests in acme/gadgets" }] };

test("SseReader: events survive any chunking, CRLF, comments and multi-line data", () => {
  const text = `: a comment\r\nevent: a\r\ndata: {"x":"先"}\r\n\r\nevent: b\ndata: one\ndata: two\n\ndata: no event name\n\nevent: last\ndata: unterminated`;
  const bytes = new TextEncoder().encode(text);
  for (const size of [1, 2, 3, 7, bytes.length]) {
    const got: [string, string][] = [];
    const reader = new SseReader((event, data) => got.push([event, data]));
    for (let i = 0; i < bytes.length; i += size) reader.push(bytes.slice(i, i + size));
    reader.end();
    expect(got).toEqual([["a", '{"x":"先"}'], ["b", "one\ntwo"], ["message", "no event name"], ["last", "unterminated"]]);
  }
});

test("StreamedMessage: text, tool calls with their parsed input, the stop reason and tokens", () => {
  const m = new StreamedMessage();
  for (const [event, data] of TOOL_TURN) m.feed(event, JSON.stringify(data));
  const r = m.result();
  expect(r.content).toEqual(WANT_CONTENT as never);
  expect(r.stopReason).toBe("tool_use");
  expect(r.model).toBe("claude-opus-5");
  expect(r.tokens).toEqual(WANT_TOKENS);
  expect(totalTokens(r.tokens)).toBe(3692);
});

test("StreamedMessage: a message_delta that restates the input side replaces it; thinking is counted, not kept", () => {
  const m = new StreamedMessage();
  m.feed("message_start", JSON.stringify({ type: "message_start", message: { id: "m", model: "x", usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: null, cache_creation_input_tokens: null } } }));
  m.feed("content_block_start", JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }));
  m.feed("content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm, hm" } }));
  m.feed("content_block_delta", JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } }));
  m.feed("message_delta", JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { input_tokens: 12, cache_read_input_tokens: 40, cache_creation_input_tokens: null, output_tokens: 9 } }));
  expect(m.result()).toMatchObject({ stopReason: "end_turn", content: [{ type: "thinking", chars: 7 }], tokens: { input: 12, output: 9, cacheRead: 40, cacheWrite: 0 } });
});

test("StreamedMessage: a stream cut off mid tool call keeps what arrived; an error event is the turn's error", () => {
  const cut = new StreamedMessage();
  for (const [event, data] of TOOL_TURN.slice(0, 9)) cut.feed(event, JSON.stringify(data));
  const r = cut.result();
  expect(r.stopReason).toBeNull();
  expect(r.content[1]).toEqual({ type: "tool_use", id: "toolu_01", name: "workspace_clone", input: null, inputRaw: '{"repo": "acme' });

  const failed = new StreamedMessage();
  failed.feed("message_start", JSON.stringify(TOOL_TURN[0]![1]));
  failed.feed("error", JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
  expect(failed.result().error).toEqual({ type: "overloaded_error", message: "Overloaded" });
});

test("the proxy passes a streamed response through intact and records the turn", async () => {
  const up = upstream(() => streamed(TOOL_TURN));
  const proxy = proxyFor(key());
  const final = await client(proxy.open("t1", up.url)).messages.stream(REQUEST).finalMessage();
  // The app got exactly what upstream sent.
  expect(final.stop_reason).toBe("tool_use");
  expect(final.content.map((b) => (b.type === "tool_use" ? { name: b.name, input: b.input } : b.type === "text" ? b.text : b.type))).toEqual(["I'll get the repo — 先看一下 🙂.", { name: "workspace_clone", input: { repo: "acme/gadgets" } }, { name: "recent_knowledge", input: {} }]);

  const [turn] = proxy.turns("t1");
  expect(proxy.turns("t1")).toHaveLength(1);
  expect(turn!.status).toBe(200);
  expect(turn!.request).toMatchObject({ model: "claude-opus-5", maxTokens: 4096, stream: true, tools: ["workspace_clone"], messages: 1, system: "You are scout.", input: [{ type: "text", role: "user", text: "run the tests in acme/gadgets" }] });
  expect(turn!.response).toMatchObject({ id: "msg_01A", model: "claude-opus-5", stopReason: "tool_use", content: WANT_CONTENT, tokens: WANT_TOKENS });
  expect(turn!.error).toBeUndefined();
  expect(proxy.inFlight("t1")).toBe(0);
  expect(proxy.tokens("t1")).toEqual(WANT_TOKENS);
  expect(proxy.tokens()).toEqual(WANT_TOKENS);
  expect(up.seen[0]!.path).toBe("/v1/messages");
});

test("the proxy records the tool results a later turn hands the model, and a non-streamed answer", async () => {
  const body = { id: "msg_02", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 50, output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } };
  const up = upstream(() => Response.json(body));
  const proxy = proxyFor(key());
  const reply = await client(proxy.open("t", up.url)).messages.create({
    model: "claude-haiku-5-5", max_tokens: 100,
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_9", name: "workspace_exec", input: { command: "ls" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_9", content: '{"exitCode":0,"stdout":"README.md"}' }, { type: "tool_result", tool_use_id: "toolu_10", is_error: true, content: [{ type: "text", text: "no such file" }] }] },
    ],
  });
  expect(reply.content).toEqual(body.content as never);
  const [turn] = proxy.turns("t");
  expect(turn!.request.input).toEqual([
    { type: "tool_result", toolUseId: "toolu_9", isError: false, content: '{"exitCode":0,"stdout":"README.md"}' },
    { type: "tool_result", toolUseId: "toolu_10", isError: true, content: "no such file" },
  ]);
  expect(turn!.request.stream).toBe(false);
  expect(turn!.response).toMatchObject({ stopReason: "end_turn", content: [{ type: "text", text: "Done." }], tokens: { input: 50, output: 4, cacheRead: 0, cacheWrite: 0 } });
});

// Each kind of credential: upstream gets the real one in its own header and never the
// app's placeholder; no record holds it.
for (const [kind, env, header] of [
  ["api_key", { ANTHROPIC_API_KEY: REAL }, { "x-api-key": REAL }],
  ["auth_token", { ANTHROPIC_AUTH_TOKEN: REAL }, { authorization: `Bearer ${REAL}` }],
  ["ant", {}, { authorization: `Bearer ${REAL}` }],
] as const) {
  test(`credential ${kind}: sent upstream in place of the app's key, and in no record`, async () => {
    const credential = await resolveCredential(env, async () => REAL);
    if ("problem" in credential) throw new Error(credential.problem);
    expect(credential.kind).toBe(kind);
    // An upstream that echoes the credential back in an error body, the worst case.
    const up = upstream((_s, n) => (n === 1 ? streamed(TOOL_TURN) : Response.json({ type: "error", error: { type: "invalid_request_error", message: "bad request" } }, { status: 400 })));
    const proxy = proxyFor(credential);
    const c = client(proxy.open("t", up.url));
    await c.messages.stream(REQUEST).finalMessage();
    expect(await c.messages.create(REQUEST).catch((e) => e)).toBeInstanceOf(Anthropic.BadRequestError);

    for (const seen of up.seen) {
      expect(seen.headers).toMatchObject(header);
      expect(Object.keys(seen.headers).filter((h) => h === "x-api-key" || h === "authorization").join()).toBe(Object.keys(header).join());
      expect(JSON.stringify(seen.headers)).not.toContain(PLACEHOLDER_KEY);
      expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    }
    expect(proxy.turns("t")).toHaveLength(2);
    expect(proxy.turns("t")[1]).toMatchObject({ status: 400, error: "invalid_request_error: bad request" });
    expect(JSON.stringify(proxy.turns("t"))).not.toContain(REAL);
    expect(credential.secrets()).toEqual([REAL]);
    // And the app's environment never has it, whatever this shell holds.
    const appEnv = trialAppEnv({ ...env, PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL, ANTHROPIC_AUTH_TOKEN: REAL }, { port: 1, mock: "http://localhost:2", db: "/tmp/x/lorehouse.db", sessions: "/tmp/x/sessions.db", modelBase: "http://127.0.0.1:3/t/t", code: true });
    expect(JSON.stringify(appEnv)).not.toContain(REAL);
    expect(appEnv.ANTHROPIC_API_KEY).toBe(PLACEHOLDER_KEY);
    expect(appEnv.ANTHROPIC_AUTH_TOKEN).toBe("");
  });
}

test("resolveCredential: the API key first, then the bearer token, then ant; none of them names all three", async () => {
  const none = async () => undefined;
  expect(await resolveCredential({ ANTHROPIC_API_KEY: "k-0123456789abcdef", ANTHROPIC_AUTH_TOKEN: "t" }, none)).toMatchObject({ kind: "api_key" });
  expect(await resolveCredential({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "t-0123456789abcdef" }, none)).toMatchObject({ kind: "auth_token" });
  const missing = await resolveCredential({}, none);
  if (!("problem" in missing)) throw new Error("resolved a credential out of nothing");
  for (const way of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ant auth login", "--dry"]) expect(missing.problem).toContain(way);
  // A command that isn't there is "not logged in", not a crash.
  expect(await antToken("/nonexistent/ant-for-this-test")).toBeUndefined();
});

test("credential ant: a 401 fetches the token once more and retries that request once", async () => {
  const tokens = ["old-token-0123456789abcdef", "new-token-0123456789abcdef"];
  let asked = 0;
  const credential = await resolveCredential({}, async () => tokens[Math.min(asked++, 1)]);
  if ("problem" in credential) throw new Error(credential.problem);
  const up = upstream((s) => (s.headers.authorization === `Bearer ${tokens[1]}` ? streamed(TOOL_TURN) : Response.json({ type: "error", error: { type: "authentication_error", message: "expired" } }, { status: 401 })));
  const proxy = proxyFor(credential);
  const final = await client(proxy.open("t", up.url)).messages.stream(REQUEST).finalMessage();
  expect(final.stop_reason).toBe("tool_use");
  expect(up.seen.map((s) => s.headers.authorization)).toEqual([`Bearer ${tokens[0]}`, `Bearer ${tokens[1]}`]);
  expect(asked).toBe(2);
  // One turn, as the app saw it: the retry isn't a second turn.
  expect(proxy.turns("t")).toHaveLength(1);
  expect(proxy.turns("t")[0]!.status).toBe(200);
  expect(credential.secrets()).toEqual(tokens);
  expect(JSON.stringify(proxy.turns("t"))).not.toContain("token-0123456789abcdef");
});

test("credential ant: a 401 with nothing newer to send is passed on, after asking once", async () => {
  let asked = 0;
  const credential = await resolveCredential({}, async () => (asked++, "same-token-0123456789abcdef"));
  if ("problem" in credential) throw new Error(credential.problem);
  const up = upstream(() => Response.json({ type: "error", error: { type: "authentication_error", message: "revoked" } }, { status: 401 }));
  const proxy = proxyFor(credential);
  expect(await client(proxy.open("t", up.url)).messages.create(REQUEST).catch((e) => e)).toBeInstanceOf(Anthropic.AuthenticationError);
  expect(up.seen).toHaveLength(1);
  expect(asked).toBe(2);
});

test("the budget: once the run's tokens reach --max-tokens, model calls are refused without reaching upstream", async () => {
  const up = upstream(() => streamed(TOOL_TURN));
  const proxy = proxyFor(key(), 3000); // one turn is 3692 tokens
  const c = client(proxy.open("a", up.url));
  await c.messages.stream(REQUEST).finalMessage();
  expect(proxy.exceeded()).toBe(false);
  // Another trial's call counts against the same budget, and isn't retried by the SDK.
  const other = client(proxy.open("b", up.url));
  const refused = await other.messages.create(REQUEST).catch((e) => e);
  expect(refused).toBeInstanceOf(Anthropic.BadRequestError);
  expect(String(refused.message)).toContain("eval budget exceeded");
  expect(proxy.exceeded()).toBe(true);
  expect(up.seen).toHaveLength(1);
  expect(proxy.turns("b")).toHaveLength(1);
  expect(proxy.turns("b")[0]).toMatchObject({ status: 0 });
  expect(proxy.turns("b")[0]!.error).toContain("--max-tokens 3000");
  expect(totalTokens(proxy.tokens())).toBe(3692);
});

test("an upstream that can't be reached is the turn's error, and the app is told", async () => {
  const proxy = proxyFor(key());
  const failed = await new Anthropic({ apiKey: PLACEHOLDER_KEY, baseURL: proxy.open("t", "http://127.0.0.1:1"), maxRetries: 0 }).messages.create(REQUEST).catch((e) => e);
  expect(failed).toBeInstanceOf(Anthropic.APIError);
  expect(proxy.turns("t")[0]!.status).toBe(0);
  expect(proxy.turns("t")[0]!.error).toContain("upstream unreachable");
  expect(proxy.inFlight("t")).toBe(0);
});

test("scrub replaces a credential wherever it turns up", () => {
  expect(scrub(`{"error":"key ${REAL} is invalid","again":"${REAL}"}`, [REAL])).toBe('{"error":"key [redacted credential] is invalid","again":"[redacted credential]"}');
  expect(scrub("nothing here", noCredential.secrets())).toBe("nothing here");
});

test("the grader's verdict is strict JSON, and anything else counts as not passed", () => {
  expect(parseVerdict(' {"pass": true, "reason": "says it found nothing"}\n')).toEqual({ pass: true, evidence: "grader: says it found nothing" });
  expect(parseVerdict('{"pass": false, "reason": "invents a code"}')).toEqual({ pass: false, evidence: "grader: invents a code" });
  for (const bad of ['```json\n{"pass": true, "reason": "x"}\n```', '{"pass": "yes", "reason": "x"}', '{"pass": true}', "PASS", ""]) {
    const v = parseVerdict(bad);
    expect(v.pass).toBe(false);
    expect(v.evidence).toContain("counts as not passed");
  }
});

test("the grader asks through the proxy: its tokens are counted under its own name, and it holds no credential", async () => {
  const answer = (text: string) => Response.json({ id: "msg_g", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 200, output_tokens: 20 } });
  const up = upstream((_s, n) => (n === 1 ? answer('{"pass": true, "reason": "it says so plainly"}') : answer("I think it passes.")));
  const proxy = proxyFor(key());
  const grade = grader(proxy.open("grader", up.url), "claude-haiku-5-5");
  expect(await grade("Says it found nothing.", "I couldn't find that.")).toEqual({ pass: true, evidence: "grader: it says so plainly" });
  expect((await grade("Says it found nothing.", "I couldn't find that.")).pass).toBe(false);
  const sent = JSON.parse(up.seen[0]!.body) as { model: string; system: string; messages: { content: string }[] };
  expect(sent.model).toBe("claude-haiku-5-5");
  expect(sent.system).toContain('{"pass": true or false');
  expect(sent.messages[0]!.content).toContain("Criterion:\nSays it found nothing.");
  expect(sent.messages[0]!.content).toContain("<reply>\nI couldn't find that.\n</reply>");
  expect(up.seen[0]!.headers["x-api-key"]).toBe(REAL);
  expect(proxy.tokens("grader")).toEqual({ input: 400, output: 40, cacheRead: 0, cacheWrite: 0 });
});
