// Prompt caching (#193): the marks a request carries, and that nothing the model reads moves.
import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@junejs/core/agent-models";
import { withCacheMarks, withPromptCaching, type MessagesClient } from "../src/prompt-cache";

type Params = Parameters<typeof withCacheMarks>[0];

const request = (over: Partial<Params> = {}): Params => ({
  model: "claude-opus-5",
  max_tokens: 4096,
  system: "You are scout.",
  tools: [{ name: "search_knowledge", description: "Search.", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "what did we decide?" }],
  ...over,
});

describe("withCacheMarks", () => {
  test("marks the system prompt and the request, and nothing else", () => {
    const body = request();
    const marked = withCacheMarks(body);
    expect(marked.system).toEqual([{ type: "text", text: "You are scout.", cache_control: { type: "ephemeral" } }]);
    expect(marked.cache_control).toEqual({ type: "ephemeral" });
    // Everything else is the same object the caller built: the model reads what it read.
    const { system: _s, cache_control: _c, ...rest } = marked;
    const { system: _bs, ...before } = body;
    expect(rest).toEqual(before);
    expect(marked.tools).toBe(body.tools);
    expect(marked.messages).toBe(body.messages);
  });

  test("does not change the request it was given", () => {
    const body = request();
    const copy = structuredClone(body);
    withCacheMarks(body);
    expect(body).toEqual(copy);
  });

  test("the system text is byte for byte what June sent", () => {
    const system = "Line one.\n\n  Indented 「中文」 line.\n";
    const marked = withCacheMarks(request({ system }));
    expect(Array.isArray(marked.system) && marked.system.map((b) => b.text).join("")).toBe(system);
  });

  test("a request with no system prompt, or an empty one, is marked on the request only", () => {
    const { system: _s, ...bare } = request();
    const marked = withCacheMarks(bare);
    expect("system" in marked).toBe(false);
    expect(marked.cache_control).toEqual({ type: "ephemeral" });
    // An empty text block is refused by the API: the empty string stays as it was.
    expect(withCacheMarks(request({ system: "" })).system).toBe("");
  });

  test("a request that already says how it is cached is left as written", () => {
    const blocks = [{ type: "text" as const, text: "a" }, { type: "text" as const, text: "b", cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }];
    const marked = withCacheMarks(request({ system: blocks, cache_control: { type: "ephemeral", ttl: "1h" } }));
    expect(marked.system).toBe(blocks);
    expect(marked.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  });

  test("system blocks are never rewritten, and the request is still marked", () => {
    const blocks = [{ type: "text" as const, text: "a" }, { type: "text" as const, text: "b" }];
    const marked = withCacheMarks(request({ system: blocks }));
    expect(marked.system).toBe(blocks);
    expect(blocks).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
    expect(marked.cache_control).toEqual({ type: "ephemeral" });
  });

  test("a request with its own setting on the request gets no mark on its system prompt", () => {
    // A five-minute mark on the system prompt ahead of a one-hour mark on the request is
    // refused by the API (a longer lifetime must come first): the string stays a string.
    const hour = request({ cache_control: { type: "ephemeral", ttl: "1h" } });
    expect(withCacheMarks(hour)).toBe(hour);
    expect(withCacheMarks(hour).system).toBe("You are scout.");
    // An explicit null is the caller turning caching off for the request: nothing is added.
    const off = request({ cache_control: null });
    expect(withCacheMarks(off)).toBe(off);
    expect(withCacheMarks(off).cache_control).toBeNull();
  });
});

describe("withPromptCaching", () => {
  // A client that keeps what it was sent and answers with an empty reply.
  function recording(): { client: MessagesClient; sent: Params[] } {
    const sent: Params[] = [];
    const reply = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
    const stream = { async *[Symbol.asyncIterator]() {}, finalMessage: async () => reply };
    const client = { messages: { stream: (body: Params) => (sent.push(body), stream) } } as unknown as MessagesClient;
    return { client, sent };
  }

  test("every request June's adapter sends goes out marked, with what the model reads unchanged", async () => {
    const plain = recording();
    const cached = recording();
    const tools = [{ name: "search_knowledge", description: "Search.", input: { type: "object" } }];
    const msgs = [{ role: "user" as const, turnId: "t1", text: "what did we decide?" }];
    for (const client of [plain.client, withPromptCaching(cached.client)]) {
      const model = anthropic({ model: "claude-opus-5", maxTokens: 4096, client });
      for await (const _ of model(msgs, tools, { system: "You are scout." })) void _;
    }
    expect(plain.sent).toHaveLength(1);
    expect(cached.sent).toHaveLength(1);
    const before = plain.sent[0]!;
    const after = cached.sent[0]!;
    expect(before.system).toBe("You are scout.");
    expect("cache_control" in before).toBe(false);
    expect(after.system).toEqual([{ type: "text", text: "You are scout.", cache_control: { type: "ephemeral" } }]);
    expect(after.cache_control).toEqual({ type: "ephemeral" });
    const { system: _a, cache_control: _c, ...restAfter } = after;
    const { system: _b, ...restBefore } = before;
    expect(restAfter).toEqual(restBefore);
  });

  test("a caller's request options reach the client as given", () => {
    const got: unknown[] = [];
    const inner = { messages: { stream: (_body: Params, options?: unknown) => (got.push(options), {}) } } as unknown as MessagesClient;
    const options = { timeout: 1234 };
    withPromptCaching(inner).messages.stream(request(), options);
    withPromptCaching(inner).messages.stream(request());
    expect(got[0]).toBe(options);
    expect(got[1]).toBeUndefined();
  });

  test("the SDK's own client is one it can wrap, and June takes the wrapped one", () => {
    // Types are the test: no cast on either line. Nothing is sent.
    const wrapped = withPromptCaching(new Anthropic({ apiKey: "test", baseURL: "http://127.0.0.1:9" }));
    const model = anthropic({ client: wrapped });
    expect(typeof model).toBe("function");
  });
});
