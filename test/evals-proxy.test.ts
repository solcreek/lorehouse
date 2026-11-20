// The eval harness's recording proxy (evals/proxy.ts) and what it reads responses with
// (evals/sse.ts), against an upstream that answers with hand-written responses in the
// Messages API's streaming format (the event shapes are the SDK's RawMessageStreamEvent).
// The real SDK client is the app's side of each exchange, as it is in the app.

import Anthropic from "@anthropic-ai/sdk";
import { afterEach, expect, test } from "bun:test";
import { antToken, noCredential, resolveCredential, resolveUpstream, scrub, type Credential } from "../evals/credential";
import { retryWaitMs, startProxy, type Proxy } from "../evals/proxy";
import { SseReader, StreamedMessage, totalTokens } from "../evals/sse";
import { trialAppEnv } from "../evals/trial";

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
const client = (proxy: Proxy, trial: string, upstreamUrl: string) => new Anthropic({ apiKey: proxy.key, baseURL: proxy.open(trial, upstreamUrl), maxRetries: 2 });
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
  const final = await client(proxy, "t1", up.url).messages.stream(REQUEST).finalMessage();
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
  const reply = await client(proxy, "t", up.url).messages.create({
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
    const c = client(proxy, "t", up.url);
    await c.messages.stream(REQUEST).finalMessage();
    expect(await c.messages.create(REQUEST).catch((e) => e)).toBeInstanceOf(Anthropic.BadRequestError);

    for (const seen of up.seen) {
      expect(seen.headers).toMatchObject(header);
      expect(Object.keys(seen.headers).filter((h) => h === "x-api-key" || h === "authorization").join()).toBe(Object.keys(header).join());
      expect(JSON.stringify(seen.headers)).not.toContain(proxy.key);
      expect(seen.headers["anthropic-version"]).toBe("2023-06-01");
    }
    expect(proxy.turns("t")).toHaveLength(2);
    expect(proxy.turns("t")[1]).toMatchObject({ status: 400, error: "invalid_request_error: bad request" });
    expect(JSON.stringify(proxy.turns("t"))).not.toContain(REAL);
    expect(credential.secrets()).toEqual([REAL]);
    // And the app's environment never has it, whatever this shell holds.
    const appEnv = trialAppEnv({ ...env, PATH: "/usr/bin", ANTHROPIC_API_KEY: REAL, ANTHROPIC_AUTH_TOKEN: REAL }, { mock: "http://localhost:2", db: "/tmp/x/lorehouse.db", sessions: "/tmp/x/sessions.db", modelBase: "http://127.0.0.1:3/t/t", modelKey: proxy.key, code: true });
    expect(JSON.stringify(appEnv)).not.toContain(REAL);
    expect(appEnv.ANTHROPIC_API_KEY).toBe(proxy.key);
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
  const final = await client(proxy, "t", up.url).messages.stream(REQUEST).finalMessage();
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
  expect(await client(proxy, "t", up.url).messages.create(REQUEST).catch((e) => e)).toBeInstanceOf(Anthropic.AuthenticationError);
  expect(up.seen).toHaveLength(1);
  expect(asked).toBe(2);
});

test("the budget: once the run's tokens reach --max-tokens, model calls are refused without reaching upstream", async () => {
  const up = upstream(() => streamed(TOOL_TURN));
  const proxy = proxyFor(key(), 3000); // one turn is 3692 tokens
  const c = client(proxy, "a", up.url);
  await c.messages.stream(REQUEST).finalMessage();
  expect(proxy.exceeded()).toBe(true); // over the line already: that call cost 3692
  // Another trial's call counts against the same budget, and isn't retried by the SDK.
  const other = client(proxy, "b", up.url);
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
  const failed = await new Anthropic({ apiKey: proxy.key, baseURL: proxy.open("t", "http://127.0.0.1:1"), maxRetries: 0 }).messages.create(REQUEST).catch((e) => e);
  expect(failed).toBeInstanceOf(Anthropic.APIError);
  expect(proxy.turns("t")[0]!.status).toBe(0);
  expect(proxy.turns("t")[0]!.error).toContain("upstream unreachable");
  expect(proxy.inFlight("t")).toBe(0);
});

test("scrub replaces a credential wherever it turns up", () => {
  expect(scrub(`{"error":"key ${REAL} is invalid","again":"${REAL}"}`, [REAL])).toBe('{"error":"key [redacted credential] is invalid","again":"[redacted credential]"}');
  expect(scrub("nothing here", noCredential.secrets())).toBe("nothing here");
});

// ── only this run spends the credential, and only on model calls ─────────────

test("a request without the run's key is refused and nothing goes upstream; the key is random per run", async () => {
  const up = upstream(() => streamed(TOOL_TURN));
  const proxy = proxyFor(key());
  const base = proxy.open("t", up.url);
  for (const headers of [{}, { "x-api-key": "eval-placeholder-key" }, { "x-api-key": REAL }, { authorization: `Bearer ${proxy.key}` }] as Record<string, string>[]) {
    const r = await fetch(`${base}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(REQUEST) });
    expect(r.status).toBe(401);
    expect(await r.text()).toContain("doesn't carry the run's key");
  }
  expect(up.seen).toHaveLength(0);
  expect(proxy.turns("t")).toHaveLength(0);
  expect(proxy.tokens()).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const other = proxyFor(key());
  expect(proxy.key).toMatch(/^sk-eval-[A-Za-z0-9_-]{32}$/);
  expect(other.key).not.toBe(proxy.key);
});

test("only POST /v1/messages of an open trial is forwarded: any other path, method or trial is a 404 and nothing is sent", async () => {
  const up = upstream(() => Response.json({ data: [] }));
  const proxy = proxyFor(key());
  const base = proxy.open("t", up.url);
  const auth = { "x-api-key": proxy.key, "content-type": "application/json" };
  const tries: [string, string][] = [
    ["GET", `${base}/v1/models`], ["POST", `${base}/v1/messages/count_tokens`], ["POST", `${base}/v1/messages/batches`], ["GET", `${base}/v1/messages`],
    ["POST", `${base}/v1/files`], ["POST", `http://127.0.0.1:${proxy.port}/t/unopened/v1/messages`], ["POST", `http://127.0.0.1:${proxy.port}/v1/messages`], ["POST", `${base}/v1/messages/../models`],
  ];
  for (const [method, url] of tries) {
    const r = await fetch(url, { method, headers: auth, body: method === "POST" ? "{}" : undefined });
    expect([method, url, r.status]).toEqual([method, url, 404]);
  }
  expect(up.seen).toHaveLength(0);
  expect(proxy.turns("t")).toHaveLength(0);
});

test("a redirect from upstream is not followed: the credential would go with it", async () => {
  const elsewhere = upstream(() => streamed(TOOL_TURN));
  const up = upstream(() => new Response(null, { status: 307, headers: { location: `${elsewhere.url}/v1/messages` } }));
  const proxy = proxyFor(key());
  const failed = await new Anthropic({ apiKey: proxy.key, baseURL: proxy.open("t", up.url), maxRetries: 2 }).messages.create(REQUEST).catch((e) => e);
  expect(failed).toBeInstanceOf(Anthropic.APIError);
  expect(up.seen).toHaveLength(1); // not retried either
  expect(elsewhere.seen).toHaveLength(0);
  expect(proxy.turns("t")[0]).toMatchObject({ status: 307 });
  expect(proxy.turns("t")[0]!.error).toContain(`a redirect to ${elsewhere.url}: not followed`);
  expect(proxy.inFlight("t")).toBe(0);
});

test("an upstream that echoes the credential back: it is in no record and not in what the app is handed", async () => {
  const echo = `Invalid API key ${REAL} (header x-api-key: ${REAL})`;
  const up = upstream((_s, n) =>
    n === 1 ? Response.json({ type: "error", error: { type: "authentication_error", message: echo } }, { status: 403 })
    : n === 2 ? new Response(`<html>bad gateway for ${REAL}</html>`, { status: 400, headers: { "content-type": "text/html" } })
    : new Response(sse([["message_start", TOOL_TURN[0]![1]], ["error", { type: "error", error: { type: "overloaded_error", message: `overloaded for ${REAL}` } }]]), { headers: { "content-type": "text/event-stream" } }));
  const proxy = proxyFor(key());
  const c = new Anthropic({ apiKey: proxy.key, baseURL: proxy.open("t", up.url), maxRetries: 0 });
  const first = await c.messages.create(REQUEST).catch((e) => e);
  const second = await c.messages.create(REQUEST).catch((e) => e);
  await c.messages.stream(REQUEST).finalMessage().catch((e) => e);
  expect(first).toBeInstanceOf(Anthropic.PermissionDeniedError);
  // What the app was handed (and may log) for the two bodies the proxy read whole.
  for (const err of [first, second]) expect(`${err.message} ${JSON.stringify(err.error ?? "")}`).not.toContain(REAL);
  expect(String(first.message)).toContain("Invalid API key [redacted credential]");
  // What was recorded, of all three.
  const records = JSON.stringify(proxy.turns("t"));
  expect(proxy.turns("t").map((t) => t.status)).toEqual([403, 400, 200]);
  expect(records).not.toContain(REAL);
  expect(proxy.turns("t")[0]!.error).toBe("authentication_error: Invalid API key [redacted credential] (header x-api-key: [redacted credential])");
  expect(proxy.turns("t")[1]!.error).toContain("<html>bad gateway for [redacted credential]</html>");
  expect(proxy.turns("t")[2]!.error).toBe("overloaded_error: overloaded for [redacted credential]");
});

test("resolveUpstream: api.anthropic.com unless --upstream says otherwise; https, or http to this machine only", () => {
  const ok = (flag: string | undefined, env: Record<string, string>, url: string) => expect(resolveUpstream(flag, env)).toEqual({ url });
  ok(undefined, {}, "https://api.anthropic.com");
  ok(undefined, { EVAL_ANTHROPIC_UPSTREAM: "https://api.anthropic.com/" }, "https://api.anthropic.com");
  ok("https://gateway.example.com/anthropic/", {}, "https://gateway.example.com/anthropic");
  ok("http://localhost:8080", {}, "http://localhost:8080");
  ok("http://127.0.0.1:9000/x", {}, "http://127.0.0.1:9000/x");
  ok("http://[::1]:9000", {}, "http://[::1]:9000");
  // The command line wins over the environment, and is the only thing that can name another host.
  ok("https://gateway.example.com", { EVAL_ANTHROPIC_UPSTREAM: "https://other.example.com" }, "https://gateway.example.com");
  const refused: [string | undefined, Record<string, string>, string][] = [
    [undefined, { EVAL_ANTHROPIC_UPSTREAM: "https://gateway.example.com" }, "pass --upstream https://gateway.example.com on the command line"],
    [undefined, { EVAL_ANTHROPIC_UPSTREAM: "http://localhost:8080" }, "pass --upstream http://localhost:8080 on the command line"],
    [undefined, { EVAL_ANTHROPIC_UPSTREAM: "http://evil.example.com" }, "only sent over https"],
    ["http://gateway.example.com", {}, "only sent over https"],
    ["http://127.0.0.1.evil.example.com", {}, "only sent over https"],
    ["http://192.168.1.10:8080", {}, "only sent over https"],
    ["ftp://api.anthropic.com", {}, "only sent over https"],
    ["https://user:pw@gateway.example.com", {}, "no credentials, query or fragment"],
    ["https://gateway.example.com/?key=1", {}, "no credentials, query or fragment"],
    ["not a url", {}, "isn't a URL"],
  ];
  for (const [flag, env, why] of refused) {
    const r = resolveUpstream(flag, env);
    if (!("problem" in r)) throw new Error(`resolved ${JSON.stringify([flag, env])} to ${r.url}`);
    expect(r.problem).toContain(why);
  }
});

// ── the budget, a cut-off answer, and a call the SDK is about to retry ───────

test("the budget is exceeded as soon as the total is over it, not only when another call arrives", async () => {
  const up = upstream(() => streamed(TOOL_TURN));
  const proxy = proxyFor(key(), 3000); // one turn is 3692 tokens
  expect(proxy.exceeded()).toBe(false);
  await client(proxy, "a", up.url).messages.stream(REQUEST).finalMessage();
  expect(totalTokens(proxy.tokens())).toBe(3692);
  expect(proxy.exceeded()).toBe(true);
  // At the line exactly is not over it.
  const exact = proxyFor(key(), 3692);
  await client(exact, "a", up.url).messages.stream(REQUEST).finalMessage();
  expect(exact.exceeded()).toBe(false);
});

test("a non-streamed answer that is cut off ends the request: nothing stays in flight", async () => {
  // A server that promises more body than it sends, then hangs up.
  const cut = Bun.listen({
    hostname: "127.0.0.1", port: 0,
    socket: { data(socket) { socket.write('HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"id":"msg_cut","type":"message","content":[{"type":"te'); socket.end(); } },
  });
  stops.push(() => cut.stop(true));
  const proxy = proxyFor(key());
  const failed = await new Anthropic({ apiKey: proxy.key, baseURL: proxy.open("t", `http://127.0.0.1:${cut.port}`), maxRetries: 0 }).messages.create(REQUEST).catch((e) => e);
  expect(failed).toBeInstanceOf(Anthropic.APIError);
  expect(proxy.inFlight("t")).toBe(0);
  expect(proxy.busy("t")).toBe(false);
  expect(proxy.turns("t")[0]!.error).toMatch(/was cut off|upstream unreachable/);
});

test("retryWaitMs: how long the SDK may wait before it retries a status it retries", () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  expect(retryWaitMs(200, h())).toBe(0);
  expect(retryWaitMs(400, h({ "retry-after": "30" }))).toBe(0);
  expect(retryWaitMs(401, h())).toBe(0);
  expect(retryWaitMs(429, h({ "retry-after": "20" }))).toBe(22_000);
  expect(retryWaitMs(529, h({ "retry-after-ms": "1500" }))).toBe(3500);
  expect(retryWaitMs(429, h())).toBe(10_000); // the SDK's own backoff tops out at 8 s
  expect(retryWaitMs(500, h())).toBe(10_000);
  expect(retryWaitMs(429, h({ "retry-after": "3600" }))).toBe(65_000); // bounded
  expect(retryWaitMs(429, h({ "retry-after": "20", "x-should-retry": "false" }))).toBe(0);
});

test("a call answered 429 with a retry-after keeps the turn busy until the SDK has retried, though nothing is in flight", async () => {
  let clock = 1_000_000;
  const up = upstream((_s, n) => (n === 1 ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429, headers: { "retry-after": "20" } }) : streamed(TOOL_TURN)));
  const proxy = startProxy({ credential: key(), maxTokens: 1_000_000, now: () => clock });
  stops.push(() => proxy.stop());
  const base = proxy.open("t", up.url);
  const call = () => fetch(`${base}/v1/messages`, { method: "POST", headers: { "x-api-key": proxy.key, "content-type": "application/json" }, body: JSON.stringify(REQUEST) });
  expect(proxy.busy("t")).toBe(false);
  expect((await call()).status).toBe(429);
  // Answered: nothing in flight. But the SDK will be back within its retry-after.
  expect(proxy.inFlight("t")).toBe(0);
  expect(proxy.busy("t")).toBe(true);
  clock += 15_000; // longer than the trial's idle rule (10 s): still busy
  expect(proxy.busy("t")).toBe(true);
  // The retry arrives and is answered: busy only until the retry-after has run out.
  const retried = await call();
  await retried.text();
  expect(retried.status).toBe(200);
  clock += 8_000;
  expect(proxy.busy("t")).toBe(false);
  // Had it never retried, the turn is held busy no longer than that either.
  expect(proxy.turns("t").map((t) => t.status)).toEqual([429, 200]);
});
