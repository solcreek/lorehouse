// sse.ts — reading a Messages API response as the model's turn: what it said, which tools
// it called with what input, why it stopped, and what it cost in tokens. The event shapes
// are the SDK's (RawMessageStreamEvent in @anthropic-ai/sdk); the stream also carries
// `ping` and `error` events, which aren't in that union.

import type Anthropic from "@anthropic-ai/sdk";

type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

// Tokens, as the API counts them. Input a request is billed for is input + cacheRead +
// cacheWrite: `input` alone is what came after the last cache breakpoint.
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };
export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export const totalTokens = (t: Tokens) => t.input + t.output + t.cacheRead + t.cacheWrite;
export function addTokens(a: Tokens, b: Tokens): Tokens {
  return { input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite };
}

// One block of the model's turn. `input` is the tool call's parsed JSON; when the JSON the
// stream carried doesn't parse (a turn cut off at max_tokens), `input` is null and
// `inputRaw` is what arrived.
export type TurnBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown; inputRaw?: string }
  | { type: "thinking"; chars: number }
  | { type: "other"; kind: string };

export type ModelResponse = {
  id?: string;
  model?: string;
  // null: the stream ended before the API said why (cut off, or an `error` event).
  stopReason: string | null;
  content: TurnBlock[];
  tokens: Tokens;
  // An `error` event in the stream, or an error body: the API's type and message.
  error?: { type: string; message: string };
};

type UsageLike = { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

// A usage object laid over what is known so far: message_start carries the input side,
// message_delta the cumulative output (and repeats the input side when it has it); a
// null or absent field leaves what was known.
function mergeUsage(t: Tokens, u: UsageLike | null | undefined): Tokens {
  if (!u) return t;
  return {
    input: u.input_tokens ?? t.input,
    output: u.output_tokens ?? t.output,
    cacheRead: u.cache_read_input_tokens ?? t.cacheRead,
    cacheWrite: u.cache_creation_input_tokens ?? t.cacheWrite,
  };
}

function blockOf(b: { type: string; text?: string; id?: string; name?: string; input?: unknown; thinking?: string }): TurnBlock {
  if (b.type === "text") return { type: "text", text: b.text ?? "" };
  if (b.type === "tool_use" || b.type === "server_tool_use") return { type: "tool_use", id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} };
  if (b.type === "thinking" || b.type === "redacted_thinking") return { type: "thinking", chars: (b.thinking ?? "").length };
  return { type: "other", kind: b.type };
}

// A whole (non-streamed) response body, or an error body.
export function responseFromJson(body: unknown): ModelResponse {
  const o = (body ?? {}) as { type?: string; id?: string; model?: string; stop_reason?: string | null; content?: unknown; usage?: UsageLike; error?: { type?: string; message?: string } };
  if (o.type === "error" || (o.error && !o.content)) {
    return { stopReason: null, content: [], tokens: noTokens(), error: { type: o.error?.type ?? "error", message: o.error?.message ?? JSON.stringify(body).slice(0, 500) } };
  }
  const content = Array.isArray(o.content) ? (o.content as Parameters<typeof blockOf>[0][]).map(blockOf) : [];
  return { id: o.id, model: o.model, stopReason: o.stop_reason ?? null, content, tokens: mergeUsage(noTokens(), o.usage) };
}

// A streamed response, event by event.
export class StreamedMessage {
  private id?: string;
  private model?: string;
  private stopReason: string | null = null;
  private tokens = noTokens();
  private error?: { type: string; message: string };
  private blocks = new Map<number, TurnBlock>();
  private json = new Map<number, string>();

  // `event` is the SSE event name; `data` its JSON.
  feed(event: string, data: string): void {
    if (event === "ping") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // not JSON: nothing of the message
    }
    if (event === "error" || (parsed as { type?: string }).type === "error") {
      const e = (parsed as { error?: { type?: string; message?: string } }).error;
      this.error = { type: e?.type ?? "error", message: e?.message ?? data.slice(0, 500) };
      return;
    }
    const ev = parsed as StreamEvent;
    switch (ev.type) {
      case "message_start":
        this.id = ev.message.id;
        this.model = ev.message.model;
        this.tokens = mergeUsage(this.tokens, ev.message.usage);
        return;
      case "content_block_start":
        this.blocks.set(ev.index, blockOf(ev.content_block as Parameters<typeof blockOf>[0]));
        return;
      case "content_block_delta": {
        const block = this.blocks.get(ev.index);
        if (!block) return;
        const d = ev.delta;
        if (d.type === "text_delta" && block.type === "text") block.text += d.text;
        else if (d.type === "input_json_delta" && block.type === "tool_use") this.json.set(ev.index, (this.json.get(ev.index) ?? "") + d.partial_json);
        else if (d.type === "thinking_delta" && block.type === "thinking") block.chars += d.thinking.length;
        return;
      }
      case "content_block_stop":
        this.closeToolInput(ev.index);
        return;
      case "message_delta":
        this.stopReason = ev.delta.stop_reason ?? this.stopReason;
        this.tokens = mergeUsage(this.tokens, ev.usage);
        return;
      case "message_stop":
        return;
    }
  }

  // A tool call's input is the JSON its deltas spelled; none means the input the block
  // started with (an empty object).
  private closeToolInput(index: number): void {
    const block = this.blocks.get(index);
    const raw = this.json.get(index);
    if (block?.type !== "tool_use" || raw === undefined) return;
    this.json.delete(index);
    if (raw === "") return;
    try {
      block.input = JSON.parse(raw);
    } catch {
      block.input = null;
      block.inputRaw = raw;
    }
  }

  // The turn as far as the stream got. A stream cut off mid-block still yields the blocks
  // that arrived, a tool call's unfinished input as `inputRaw`.
  result(): ModelResponse {
    for (const index of [...this.json.keys()]) this.closeToolInput(index);
    const content = [...this.blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
    return { id: this.id, model: this.model, stopReason: this.stopReason, content, tokens: this.tokens, ...(this.error ? { error: this.error } : {}) };
  }
}

// Server-sent events out of bytes that arrive in any chunking: a line may be split across
// chunks (so may a UTF-8 character), lines end in \n, \r\n or \r, a blank line ends an
// event, several `data:` lines join with \n, and a line starting with ":" is a comment.
export class SseReader {
  private decoder = new TextDecoder();
  private buffer = "";
  private event = "";
  private data: string[] = [];

  constructor(private onEvent: (event: string, data: string) => void) {}

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain(false);
  }

  end(): void {
    this.buffer += this.decoder.decode();
    this.drain(true);
    this.dispatch(); // an event the stream ended without a blank line after
  }

  private drain(final: boolean): void {
    for (;;) {
      const at = this.buffer.search(/[\r\n]/);
      if (at < 0) break;
      // A \r at the very end may be half of a \r\n: wait for the next chunk.
      if (this.buffer[at] === "\r" && at === this.buffer.length - 1 && !final) break;
      const line = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + (this.buffer[at] === "\r" && this.buffer[at + 1] === "\n" ? 2 : 1));
      this.line(line);
    }
    if (final && this.buffer) {
      this.line(this.buffer);
      this.buffer = "";
    }
  }

  private line(line: string): void {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
  }

  private dispatch(): void {
    if (this.data.length) this.onEvent(this.event || "message", this.data.join("\n"));
    this.event = "";
    this.data = [];
  }
}
