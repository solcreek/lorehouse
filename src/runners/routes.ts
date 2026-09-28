// routes.ts — the runner endpoints: WebSocket and long poll over the same hub.
//
//   GET  /runners/connect   WebSocket upgrade: status/result frames in, job frames out
//   POST /runners/poll      a status body; held ≤ pollWaitMs; → { jobs }
//   POST /runners/results   { results } → 204
//
// Every request needs `Authorization: Bearer <SANDBOX_RUNNER_TOKEN>` and
// `X-Lorehouse-Runner: <name>`. Protocol: docs/sandbox-runners.md.

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { bearerMatches, unauthorized } from "../status-auth";
import type { Job, JobResult, RunnerHub, RunnerStatus } from "./hub";

export type RunnerSocketData = { runner: string; hub?: ReturnType<RunnerHub["attachWs"]> };

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function runnerName(req: Request): string | undefined {
  const n = req.headers.get("x-lorehouse-runner") ?? "";
  return NAME.test(n) ? n : undefined;
}

// A status from a runner, checked field by field: numbers are whole and ≥ 0.
function parseStatus(runner: string, v: unknown): RunnerStatus | undefined {
  const o = v as Partial<RunnerStatus> | undefined;
  const whole = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 10_000;
  if (!o || !whole(o.capacity) || !whole(o.running)) return undefined;
  return { runner, capacity: o.capacity!, running: o.running!, version: typeof o.version === "string" ? o.version.slice(0, 40) : undefined };
}

function parseResult(v: unknown): JobResult | undefined {
  const o = v as Partial<JobResult> | undefined;
  if (!o || typeof o.id !== "string" || typeof o.status !== "number") return undefined;
  const str = (s: unknown) => (typeof s === "string" ? s : undefined);
  return { id: o.id, status: o.status, contentType: str(o.contentType), bodyBase64: str(o.bodyBase64), error: str(o.error) };
}

const bad = (why: string) => new Response(why, { status: 400 });

export function runnerRoutes(hub: RunnerHub, token: string) {
  // undefined: not a runner path; the caller goes on routing.
  async function handle(req: Request, server?: Server<RunnerSocketData>): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/runners/")) return undefined;
    if (!bearerMatches(req, token)) return unauthorized();
    const runner = runnerName(req);
    if (!runner) return bad("X-Lorehouse-Runner: 1–64 of [A-Za-z0-9_.-]");

    if (path === "/runners/connect" && req.method === "GET") {
      if (server?.upgrade(req, { data: { runner } satisfies RunnerSocketData })) return new Response(null); // Bun answers the upgrade
      return new Response("WebSocket upgrade expected", { status: 426 });
    }
    if (path === "/runners/poll" && req.method === "POST") {
      const status = parseStatus(runner, await req.json().catch(() => undefined));
      if (!status) return bad("poll body: a status { capacity, running }");
      return Response.json({ jobs: await hub.poll(status, req.signal) });
    }
    if (path === "/runners/results" && req.method === "POST") {
      const body = (await req.json().catch(() => undefined)) as { results?: unknown[] } | undefined;
      if (!Array.isArray(body?.results)) return bad("results body: { results: [...] }");
      const results = body.results.map(parseResult);
      if (results.some((r) => !r)) return bad("each result needs an id and a status");
      hub.results(runner, results as JobResult[]);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  const websocket: WebSocketHandler<RunnerSocketData> = {
    open(ws: ServerWebSocket<RunnerSocketData>) {
      ws.data.hub = hub.attachWs(ws.data.runner, (job: Job) => ws.send(JSON.stringify({ type: "job", job })));
    },
    message(ws: ServerWebSocket<RunnerSocketData>, raw: string | Buffer) {
      let msg: { type?: string; result?: unknown } & Record<string, unknown>;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
      } catch {
        return ws.close(1003, "frames are JSON");
      }
      if (msg.type === "status") {
        const s = parseStatus(ws.data.runner, msg);
        if (s) ws.data.hub?.status(s);
      } else if (msg.type === "result") {
        const r = parseResult(msg.result);
        if (r) ws.data.hub?.result(r);
      }
    },
    close(ws: ServerWebSocket<RunnerSocketData>) {
      ws.data.hub?.closed();
    },
    // Fly and most proxies drop a connection idle for ~60 s; the runner's status frames
    // every 20 s keep it alive, and Bun pings as well.
    idleTimeout: 120,
  };

  return { handle, websocket };
}
