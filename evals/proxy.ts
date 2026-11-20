// proxy.ts — the recording proxy between the app under test and the model.
//
// The app's ANTHROPIC_BASE_URL is `<proxy>/t/<trial>`; the proxy forwards each request to
// the trial's upstream (the real API, or with --dry the conformance mock's scripted model)
// and records the turn: the model asked for, what the model was handed (the newest
// message: the question, or the tool results), every text block and tool call it
// answered with, why it stopped, and the tokens. The response passes through unchanged,
// streamed as it arrives.
//
// The real credential lives here and nowhere else. Whatever auth the app sent (its key is
// a placeholder) is dropped and the real header set; no header is ever recorded.
//
// The budget: once the run's tokens reach `maxTokens`, further model calls are refused
// (HTTP 400, `x-should-retry: false`, so the SDK doesn't retry) and `exceeded()` is true.

import type { Credential } from "./credential";
import { addTokens, noTokens, responseFromJson, SseReader, StreamedMessage, totalTokens, type ModelResponse, type Tokens } from "./sse";

// What the model was handed in a request's newest message.
export type TurnInput =
  | { type: "text"; role: string; text: string }
  | { type: "tool_result"; toolUseId: string; isError: boolean; content: string };

export type ModelTurn = {
  // 1-based, in the order the trial's requests arrived.
  n: number;
  startedAt: string;
  ms?: number;
  request: {
    model?: string;
    maxTokens?: number;
    stream: boolean;
    // The tools offered, by name.
    tools: string[];
    messages: number;
    // The system prompt, on the trial's first turn only (it is the same on the rest).
    system?: string;
    input: TurnInput[];
  };
  // The upstream's HTTP status; absent while in flight, 0 when upstream wasn't reached.
  status?: number;
  response?: ModelResponse;
  // Why there is no usable response: the budget, upstream unreachable, a stream cut off.
  error?: string;
};

export type ProxyOptions = {
  credential: Credential;
  // Total tokens (input + output + cache read + cache write) the run may use.
  maxTokens: number;
  fetch?: typeof fetch;
};

export type Proxy = {
  port: number;
  // Start recording a trial whose model is at `upstream` (an origin, or an origin and a
  // path prefix: `/v1/messages` is appended). Returns the app's ANTHROPIC_BASE_URL.
  open(trial: string, upstream: string): string;
  turns(trial: string): ModelTurn[];
  // Requests of this trial not yet answered in full.
  inFlight(trial: string): number;
  tokens(trial?: string): Tokens;
  exceeded(): boolean;
  stop(): Promise<void>;
};

const CLIP = 6000;
const clip = (s: string) => (s.length <= CLIP ? s : `${s.slice(0, CLIP)}… [${s.length - CLIP} more chars]`);

// A message's content as text: a string, or its text blocks joined.
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content.map((b) => (b && typeof b === "object" && (b as { type?: string }).type === "text" ? String((b as { text?: unknown }).text ?? "") : JSON.stringify(b))).join("");
}

function inputOf(messages: unknown): TurnInput[] {
  const last = Array.isArray(messages) ? (messages.at(-1) as { role?: string; content?: unknown } | undefined) : undefined;
  if (!last) return [];
  if (typeof last.content === "string") return [{ type: "text", role: last.role ?? "user", text: clip(last.content) }];
  if (!Array.isArray(last.content)) return [];
  return (last.content as { type?: string; text?: string; tool_use_id?: string; is_error?: boolean; content?: unknown }[]).flatMap((b): TurnInput[] => {
    if (b.type === "text") return [{ type: "text", role: last.role ?? "user", text: clip(b.text ?? "") }];
    if (b.type === "tool_result") return [{ type: "tool_result", toolUseId: b.tool_use_id ?? "", isError: b.is_error === true, content: clip(textOf(b.content)) }];
    return [];
  });
}

const systemOf = (system: unknown): string | undefined => (system === undefined ? undefined : textOf(system));

// Headers of the app's request that go upstream: everything but its auth, and what
// describes the connection or the body's encoding (fetch sets those itself).
const DROPPED_REQUEST = new Set(["host", "x-api-key", "authorization", "content-length", "connection", "accept-encoding", "transfer-encoding", "keep-alive"]);
// fetch has already decoded the upstream body: these would describe bytes that aren't sent.
const DROPPED_RESPONSE = new Set(["content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive"]);

export function startProxy(opts: ProxyOptions): Proxy {
  const f = opts.fetch ?? fetch;
  const trials = new Map<string, { upstream: string; turns: ModelTurn[]; inFlight: number }>();
  let spent = noTokens();
  let exceeded = false;

  const refusal = (status: number, type: string, message: string) =>
    Response.json({ type: "error", error: { type, message } }, { status, headers: { "x-should-retry": "false" } });

  async function forward(req: Request, trialId: string, path: string, search: string): Promise<Response> {
    const trial = trials.get(trialId);
    if (!trial) return refusal(404, "not_found_error", `eval proxy: no trial ${JSON.stringify(trialId)} is open`);
    const raw = await req.text();
    const isMessages = req.method === "POST" && path === "/v1/messages";
    let turn: ModelTurn | undefined;
    if (isMessages) {
      let body: { model?: string; max_tokens?: number; stream?: boolean; tools?: { name?: string }[]; messages?: unknown; system?: unknown } = {};
      try {
        body = JSON.parse(raw);
      } catch { /* recorded as an empty request; upstream will say what is wrong with it */ }
      turn = {
        n: trial.turns.length + 1,
        startedAt: new Date().toISOString(),
        request: {
          model: body.model,
          maxTokens: body.max_tokens,
          stream: body.stream === true,
          tools: (body.tools ?? []).map((t) => t.name ?? "?"),
          messages: Array.isArray(body.messages) ? body.messages.length : 0,
          ...(trial.turns.length === 0 ? { system: systemOf(body.system) } : {}),
          input: inputOf(body.messages),
        },
      };
      trial.turns.push(turn);
      if (exceeded || totalTokens(spent) >= opts.maxTokens) {
        exceeded = true;
        turn.status = 0;
        turn.error = `budget: the run's ${totalTokens(spent)} tokens reached --max-tokens ${opts.maxTokens}; this model call was not made`;
        return refusal(400, "invalid_request_error", `eval budget exceeded: ${turn.error}`);
      }
    }
    const t0 = Date.now();
    trial.inFlight++;
    let settled = false;
    const settle = (response?: ModelResponse, error?: string) => {
      if (settled) return;
      settled = true;
      trial.inFlight--;
      if (!turn) return;
      turn.ms = Date.now() - t0;
      if (response) {
        turn.response = response;
        spent = addTokens(spent, response.tokens);
        if (response.error && !error) error = `${response.error.type}: ${response.error.message}`;
      }
      if (error) turn.error = error;
    };

    const send = () => {
      const headers = new Headers();
      req.headers.forEach((value, name) => {
        if (!DROPPED_REQUEST.has(name.toLowerCase())) headers.set(name, value);
      });
      const [name, value] = opts.credential.header();
      headers.set(name, value);
      return { sent: value, response: f(`${trial.upstream}${path}${search}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : raw }) };
    };

    let upstream: Response;
    try {
      let attempt = send();
      upstream = await attempt.response;
      // A refused credential: one that can be had again (ant's, refreshed since) is, once.
      if (upstream.status === 401 && (opts.credential.header()[1] !== attempt.sent || (await opts.credential.refresh()))) {
        await upstream.body?.cancel().catch(() => {});
        attempt = send();
        upstream = await attempt.response;
      }
    } catch (err) {
      if (turn) turn.status = 0;
      settle(undefined, `upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return refusal(502, "api_error", "eval proxy: the model upstream could not be reached");
    }
    if (turn) turn.status = upstream.status;

    const headers = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE.has(name.toLowerCase())) headers.set(name, value);
    });

    const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!streamed || !upstream.body) {
      const text = await upstream.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch { /* not JSON */ }
      settle(parsed === undefined ? undefined : responseFromJson(parsed), parsed === undefined ? `upstream answered ${upstream.status} with a body that isn't JSON: ${text.slice(0, 300)}` : undefined);
      return new Response(text, { status: upstream.status, headers });
    }

    // Streamed: each chunk goes to the app as it arrives, and is read here on the way.
    const message = new StreamedMessage();
    const sse = new SseReader((event, data) => message.feed(event, data));
    const reader = upstream.body.getReader();
    const finish = (error?: string) => {
      sse.end();
      const response = message.result();
      settle(response, error ?? (response.stopReason === null && !response.error ? "the stream ended before the model said why it stopped" : undefined));
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            finish();
            controller.close();
            return;
          }
          sse.push(value);
          controller.enqueue(value);
        } catch (err) {
          finish(`the stream broke: ${err instanceof Error ? err.message : String(err)}`);
          controller.error(err);
        }
      },
      cancel() {
        finish("the app stopped reading the stream");
        return reader.cancel().catch(() => {});
      },
    });
    return new Response(body, { status: upstream.status, headers });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const m = /^\/t\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!m) return refusal(404, "not_found_error", "eval proxy: paths are /t/<trial>/…");
      return forward(req, decodeURIComponent(m[1]!), m[2]!, url.search);
    },
  });

  return {
    port: server.port!,
    open(trial, upstream) {
      trials.set(trial, { upstream: upstream.replace(/\/+$/, ""), turns: [], inFlight: 0 });
      return `http://127.0.0.1:${server.port}/t/${encodeURIComponent(trial)}`;
    },
    turns: (trial) => trials.get(trial)?.turns ?? [],
    inFlight: (trial) => trials.get(trial)?.inFlight ?? 0,
    tokens: (trial) =>
      trial === undefined ? spent : (trials.get(trial)?.turns ?? []).reduce((sum, t) => (t.response ? addTokens(sum, t.response.tokens) : sum), noTokens()),
    exceeded: () => exceeded,
    stop: async () => {
      await server.stop(true);
    },
  };
}
