// proxy.ts — the recording proxy between the app under test and the model.
//
// The app's ANTHROPIC_BASE_URL is `<proxy>/t/<trial>`; the proxy forwards each
// `POST /v1/messages` to the trial's upstream (the real API, or with --dry the conformance
// mock's scripted model) and records the turn: the model asked for, what the model was
// handed (the newest message: the question, or the tool results), every text block and
// tool call it answered with, why it stopped, and the tokens. The response passes
// through, streamed as it arrives.
//
// The real credential lives here and nowhere else, and only this run can spend it:
//   - the proxy listens on loopback only;
//   - every request must carry the run's own key (`key`: random per run, what the app and
//     the grader are given in place of a credential); without it, 401 and nothing is sent;
//   - only `POST /v1/messages` of an open trial is forwarded; anything else is a 404 and
//     nothing is sent;
//   - whatever auth the request carried is dropped and the real header set; no header is
//     ever recorded;
//   - a redirect from upstream is not followed (the credential would go with it): it is
//     an upstream error;
//   - what is recorded, and a non-streamed body handed back, is scrubbed of the
//     credential, should an upstream ever echo it.
//
// The budget: once the run's tokens reach `maxTokens`, further model calls are refused
// (HTTP 400, `x-should-retry: false`, so the SDK doesn't retry) and `exceeded()` is true.

import { randomBytes } from "node:crypto";
import { scrub, type Credential } from "./credential";
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
  now?: () => number;
};

export type Proxy = {
  port: number;
  // What a request must carry as `x-api-key`: this run's own, made up at start. Not a
  // credential anywhere but here.
  key: string;
  // Start recording a trial whose model is at `upstream` (an origin, or an origin and a
  // path prefix: `/v1/messages` is appended). Returns the app's ANTHROPIC_BASE_URL.
  open(trial: string, upstream: string): string;
  turns(trial: string): ModelTurn[];
  // Requests of this trial not yet answered in full.
  inFlight(trial: string): number;
  // Whether the trial's model is still at work: a request in flight, or one just answered
  // with a status the SDK retries (429, 5xx), for as long as it may wait before it does.
  busy(trial: string): boolean;
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

// How long the SDK may wait before retrying a status it retries: what `retry-after` says
// (the SDK honors it up to a minute), else its own backoff, which tops out at 8 s. A
// little margin, and a bound: a turn is never held busy longer than this by one answer.
const RETRY_DEFAULT_MS = 10_000;
const RETRY_MAX_MS = 65_000;
export function retryWaitMs(status: number, headers: Headers): number {
  const retried = status === 408 || status === 409 || status === 429 || status >= 500;
  if (!retried || headers.get("x-should-retry") === "false") return 0;
  const ms = Number(headers.get("retry-after-ms"));
  const secs = Number(headers.get("retry-after"));
  const said = headers.get("retry-after-ms") !== null && Number.isFinite(ms) ? ms : headers.get("retry-after") !== null && Number.isFinite(secs) ? secs * 1000 : undefined;
  return Math.min(RETRY_MAX_MS, said === undefined ? RETRY_DEFAULT_MS : Math.max(0, said) + 2000);
}

export function startProxy(opts: ProxyOptions): Proxy {
  const f = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const key = `sk-eval-${randomBytes(24).toString("base64url")}`;
  const trials = new Map<string, { upstream: string; turns: ModelTurn[]; inFlight: number; retryUntil: number }>();
  let spent = noTokens();
  let exceeded = false;
  // Nothing recorded or handed back holds the credential, whatever upstream said.
  const clean = (text: string) => scrub(text, opts.credential.secrets());

  const refusal = (status: number, type: string, message: string) =>
    Response.json({ type: "error", error: { type, message } }, { status, headers: { "x-should-retry": "false" } });

  async function forward(req: Request, trialId: string, search: string): Promise<Response> {
    const trial = trials.get(trialId)!;
    const raw = await req.text();
    let body: { model?: string; max_tokens?: number; stream?: boolean; tools?: { name?: string }[]; messages?: unknown; system?: unknown } = {};
    try {
      body = JSON.parse(raw);
    } catch { /* recorded as an empty request; upstream will say what is wrong with it */ }
    const turn: ModelTurn = {
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
    const t0 = now();
    trial.inFlight++;
    let settled = false;
    const settle = (response?: ModelResponse, error?: string) => {
      if (settled) return;
      settled = true;
      trial.inFlight--;
      turn.ms = now() - t0;
      if (response) {
        turn.response = response;
        spent = addTokens(spent, response.tokens);
        if (response.error && !error) error = `${response.error.type}: ${response.error.message}`;
      }
      if (error) turn.error = clean(error);
    };

    const send = () => {
      const headers = new Headers();
      req.headers.forEach((value, name) => {
        if (!DROPPED_REQUEST.has(name.toLowerCase())) headers.set(name, value);
      });
      const [name, value] = opts.credential.header();
      headers.set(name, value);
      // A redirect is never followed: the credential would go wherever it points.
      return { sent: value, response: f(`${trial.upstream}/v1/messages${search}`, { method: "POST", headers, body: raw, redirect: "manual" }) };
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
      turn.status = 0;
      settle(undefined, `upstream unreachable: ${err instanceof Error ? err.message : String(err)}`);
      return refusal(502, "api_error", "eval proxy: the model upstream could not be reached");
    }
    turn.status = upstream.status;
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => {});
      let to = "elsewhere";
      try {
        to = new URL(upstream.headers.get("location") ?? "", trial.upstream).origin;
      } catch { /* no usable Location */ }
      settle(undefined, `upstream answered ${upstream.status}, a redirect to ${to}: not followed, since the credential would go with it. Point --upstream at the endpoint itself`);
      return refusal(502, "api_error", "eval proxy: the model upstream answered with a redirect, which is not followed");
    }
    // A status the SDK retries: the turn isn't over, though nothing is in flight meanwhile.
    const wait = retryWaitMs(upstream.status, upstream.headers);
    if (wait) trial.retryUntil = Math.max(trial.retryUntil, now() + wait);

    const headers = new Headers();
    upstream.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE.has(name.toLowerCase())) headers.set(name, value);
    });

    const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
    if (!streamed || !upstream.body) {
      let text: string;
      try {
        text = clean(await upstream.text());
      } catch (err) {
        // The body was cut off: the request is over all the same.
        settle(undefined, `upstream's answer (${upstream.status}) was cut off: ${err instanceof Error ? err.message : String(err)}`);
        return refusal(502, "api_error", "eval proxy: the model upstream's answer was cut off");
      }
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
      if (response.error) response.error.message = clean(response.error.message);
      settle(response, error ?? (response.stopReason === null && !response.error ? "the stream ended before the model said why it stopped" : undefined));
    };
    const stream = new ReadableStream<Uint8Array>({
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
    return new Response(stream, { status: upstream.status, headers });
  }

  const server = Bun.serve({
    port: 0,
    // Loopback only: nothing off this machine reaches the credential through here.
    hostname: "127.0.0.1",
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      // This run's key, on every request: no other local process spends the credential.
      if (req.headers.get("x-api-key") !== key) return refusal(401, "authentication_error", "eval proxy: this request doesn't carry the run's key; nothing was sent upstream");
      const m = /^\/t\/([^/]+)\/v1\/messages$/.exec(url.pathname);
      const trialId = m ? decodeURIComponent(m[1]!) : undefined;
      if (req.method !== "POST" || !trialId || !trials.has(trialId)) return refusal(404, "not_found_error", "eval proxy: only POST /t/<open trial>/v1/messages is forwarded; nothing was sent upstream");
      return forward(req, trialId, url.search);
    },
  });

  return {
    port: server.port!,
    key,
    open(trial, upstream) {
      trials.set(trial, { upstream: upstream.replace(/\/+$/, ""), turns: [], inFlight: 0, retryUntil: 0 });
      return `http://127.0.0.1:${server.port}/t/${encodeURIComponent(trial)}`;
    },
    turns: (trial) => trials.get(trial)?.turns ?? [],
    inFlight: (trial) => trials.get(trial)?.inFlight ?? 0,
    busy: (trial) => {
      const t = trials.get(trial);
      return !!t && (t.inFlight > 0 || now() < t.retryUntil);
    },
    tokens: (trial) =>
      trial === undefined ? spent : (trials.get(trial)?.turns ?? []).reduce((sum, t) => (t.response ? addTokens(sum, t.response.tokens) : sum), noTokens()),
    exceeded: () => exceeded || totalTokens(spent) > opts.maxTokens,
    stop: async () => {
      await server.stop(true);
    },
  };
}
