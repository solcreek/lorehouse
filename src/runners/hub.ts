// hub.ts — sandbox runners that connect in, and the jobs Lorehouse hands them.
//
// A runner (sandboxd on a KVM host) dials out to Lorehouse over WebSocket or long poll
// and asks for work, so sandbox hosts need no inbound port and the sandbox API is never on
// the internet. This file is transport-independent: the HTTP/WebSocket plumbing in
// routes.ts feeds it. Protocol: docs/sandbox-runners.md.

import type { Database } from "bun:sqlite";
import type { ExecOptions, ExecResult, Sandbox } from "../tools/workspace";

export type RunnerStatus = { runner: string; capacity: number; running: number; version?: string };

type JobBody =
  | { op: "guest"; method: "POST" | "GET" | "PUT"; path: string; bodyBase64?: string }
  | { op: "destroy" };
export type Job = JobBody & { id: string; sandbox: string; timeoutMs: number };
export type JobResult = { id: string; status: number; contentType?: string; bodyBase64?: string; error?: string };

// How a job reaches the runner: pushed down its WebSocket, or queued for its next poll.
type Link =
  | { kind: "ws"; send: (job: Job) => void }
  | { kind: "poll"; queue: Job[]; waiter?: (jobs: Job[]) => void };

type Runner = { name: string; status: RunnerStatus; link: Link; lastSeen: number };
// `link` is the connection the job went out on: only a result arriving on that same
// connection settles it, so a replaced socket's late frames can't touch the new one's jobs.
type Pending = { runner: string; link: Link; resolve: (r: JobResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

// A boot can precede the work: a job's deadline is its own timeout plus this.
const BOOT_SLACK_MS = 60_000;

export class RunnerHub {
  private runners = new Map<string, Runner>();
  private pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly db: Database,
    private readonly opts: { pollWaitMs?: number; onlineMs?: number; now?: () => number; log?: (m: string) => void } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private online(r: Runner): boolean {
    return r.link.kind === "ws" || this.now() - r.lastSeen < (this.opts.onlineMs ?? 45_000);
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────────────

  // A runner's socket opened. Returns what the socket's handlers call. Each handler acts
  // only while this socket is still the runner's connection: once a newer one with the
  // same name replaces it, its late frames are ignored.
  attachWs(name: string, send: (job: Job) => void) {
    const link: Link = { kind: "ws", send };
    this.replace(name, link);
    const current = () => this.runners.get(name)?.link === link;
    return {
      status: (s: RunnerStatus) => {
        if (current()) this.touch(name, s);
      },
      result: (r: JobResult) => this.settle(name, link, r),
      closed: () => {
        if (!current()) return; // already replaced by a newer connection
        this.runners.delete(name);
        this.failJobsVia(link, `sandbox runner ${name} disconnected`);
        this.opts.log?.(`runners: ${name} disconnected`);
      },
    };
  }

  // ── long poll ──────────────────────────────────────────────────────────────────────

  // One poll: the jobs waiting for this runner, or, after pollWaitMs, none. If the request
  // is aborted while it waits, jobs stay queued for the next poll rather than going to a
  // connection that's gone.
  //
  // A poll never displaces a live WebSocket with the same name (a stale poller from an
  // older process would otherwise kick the runner off): it idles for pollWaitMs and
  // returns nothing. If that socket is in fact dead, it closes on its idle timeout, and
  // the next poll takes over.
  poll(status: RunnerStatus, signal?: AbortSignal): Promise<Job[]> {
    let r = this.runners.get(status.runner);
    if (r?.link.kind === "ws") return idle(this.opts.pollWaitMs ?? 25_000, signal);
    if (r?.link.kind !== "poll") r = this.replace(status.runner, { kind: "poll", queue: [] });
    this.touch(status.runner, status);
    const link = r.link as Extract<Link, { kind: "poll" }>;
    if (link.queue.length) return Promise.resolve(link.queue.splice(0));
    link.waiter?.([]); // a newer poll supersedes an older one still waiting
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (link.waiter === wake) link.waiter = undefined;
        resolve(link.queue.splice(0));
      }, this.opts.pollWaitMs ?? 25_000);
      const wake = (jobs: Job[]) => {
        clearTimeout(timer);
        link.waiter = undefined;
        resolve(jobs);
      };
      link.waiter = wake;
      signal?.addEventListener("abort", () => {
        if (link.waiter !== wake) return;
        clearTimeout(timer);
        link.waiter = undefined;
        resolve([]);
      });
    });
  }

  // Results posted by a polling runner settle only jobs that went out by poll to it.
  results(runner: string, results: JobResult[]): void {
    const link = this.runners.get(runner)?.link;
    if (link?.kind !== "poll") return;
    for (const r of results) this.settle(runner, link, r);
  }

  // ── both ───────────────────────────────────────────────────────────────────────────

  // A new connection for a name takes over; jobs that went out on the old one can't come
  // back on it any more, so they fail now rather than at their deadline.
  private replace(name: string, link: Link): Runner {
    const old = this.runners.get(name);
    if (old?.link.kind === "poll") old.link.waiter?.([]);
    if (old && old.link !== link) this.failJobsVia(old.link, `sandbox runner ${name} reconnected; the job's connection is gone`);
    const r: Runner = { name, link, lastSeen: this.now(), status: old?.status ?? { runner: name, capacity: 0, running: 0 } };
    this.runners.set(name, r);
    if (!old) this.opts.log?.(`runners: ${name} connected (${link.kind})`);
    return r;
  }

  private touch(name: string, status: RunnerStatus): void {
    const r = this.runners.get(name);
    if (!r) return;
    r.status = { ...status, runner: name };
    r.lastSeen = this.now();
  }

  // A result counts only from the runner, and the connection, the job was sent on.
  private settle(runner: string, via: Link, result: JobResult): void {
    const p = this.pending.get(result.id);
    if (!p || p.runner !== runner || p.link !== via) return;
    clearTimeout(p.timer);
    this.pending.delete(result.id);
    p.resolve(result);
  }

  private failJobsVia(link: Link, why: string): void {
    for (const [id, p] of this.pending) {
      if (p.link !== link) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(why));
    }
  }

  // Where a sandbox lives: where it was placed, or (new) the online runner with the most room.
  private place(sandbox: string): Runner {
    const placed = (this.db.query("SELECT runner FROM sandbox_placements WHERE sandbox = ?").get(sandbox) as { runner: string } | null)?.runner;
    if (placed) {
      const r = this.runners.get(placed);
      if (r && this.online(r)) return r;
      throw new Error(`the sandbox's host (${placed}) is offline; its checkout lives there, so it can't move`);
    }
    // Only a runner with room: a full one would answer 503, and the placement below would
    // pin the sandbox to it for good. A socket that hasn't sent its status yet reports no
    // capacity, so it isn't chosen until it does. When every runner is full, nothing is
    // recorded and the caller can try again.
    const free = (r: Runner) => r.status.capacity - r.status.running;
    const online = [...this.runners.values()].filter((r) => this.online(r));
    if (!online.length) throw new Error("no sandbox runner is connected");
    const best = online.filter((r) => free(r) > 0).sort((a, b) => free(b) - free(a) || a.name.localeCompare(b.name))[0];
    if (!best) throw new Error("every sandbox runner is full; try again in a few minutes");
    this.db.query("INSERT INTO sandbox_placements (sandbox, runner, placed_at) VALUES (?, ?, ?)").run(sandbox, best.name, new Date(this.now()).toISOString());
    return best;
  }

  submit(sandbox: string, body: JobBody, timeoutMs: number): Promise<JobResult> {
    const runner = this.place(sandbox);
    const job = { ...body, id: `j_${this.now().toString(36)}_${++this.seq}`, sandbox, timeoutMs } as Job;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        reject(new Error(`sandbox job timed out on ${runner.name}`));
      }, timeoutMs + BOOT_SLACK_MS);
      this.pending.set(job.id, { runner: runner.name, link: runner.link, resolve, reject, timer });
      if (runner.link.kind === "ws") runner.link.send(job);
      else if (runner.link.waiter) runner.link.waiter([job]);
      else runner.link.queue.push(job);
    });
  }

  // A Sandbox (the tools' seam) whose calls become jobs. Same behavior as the direct HTTP
  // client (sandbox-client.ts), so the tools can't tell them apart.
  sandbox(id: string): Sandbox {
    const guest = async (method: "POST" | "GET" | "PUT", path: string, body: string | undefined, timeoutMs: number) => {
      const r = await this.submit(id, { op: "guest", method, path, bodyBase64: body === undefined ? undefined : Buffer.from(body).toString("base64") }, timeoutMs);
      if ((r.status < 200 || r.status > 299) && r.status !== 404) {
        throw new Error(`sandbox ${method} ${path}: ${r.status} ${(r.error ?? decode(r)).slice(0, 200)}`);
      }
      return r;
    };
    return {
      async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
        const r = await guest("POST", "/exec", JSON.stringify({ command, cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs }), o.timeoutMs ?? 60_000);
        return JSON.parse(decode(r)) as ExecResult;
      },
      async readFile(path: string): Promise<string> {
        const r = await guest("GET", `/file?path=${encodeURIComponent(path)}`, undefined, 30_000);
        if (r.status === 404) throw new Error(`no such file: ${path}`);
        return decode(r);
      },
      async writeFile(path: string, content: string): Promise<void> {
        await guest("PUT", `/file?path=${encodeURIComponent(path)}`, content, 30_000);
      },
    };
  }

  // For GET /status: who is connected and how busy.
  status() {
    return [...this.runners.values()].map((r) => ({
      runner: r.name,
      transport: r.link.kind,
      online: this.online(r),
      capacity: r.status.capacity,
      running: r.status.running,
      version: r.status.version,
      lastSeenSecs: Math.round((this.now() - r.lastSeen) / 1000),
    }));
  }
}

// An empty poll answer after `ms`, or at once if the request is aborted.
function idle(ms: number, signal?: AbortSignal): Promise<Job[]> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve([]), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve([]);
    });
  });
}

function decode(r: JobResult): string {
  return r.bodyBase64 ? Buffer.from(r.bodyBase64, "base64").toString("utf8") : "";
}
