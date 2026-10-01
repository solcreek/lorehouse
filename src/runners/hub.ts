// hub.ts — sandbox runners that connect in, and the jobs Lorehouse hands them.
//
// A runner (sandboxd on a KVM host) dials out to Lorehouse over WebSocket or long poll
// and asks for work, so sandbox hosts need no inbound port and the sandbox API is never on
// the internet. This file is transport-independent: the HTTP/WebSocket plumbing in
// routes.ts feeds it. Protocol: docs/sandbox-runners.md.
//
// Delivery: a job runs at most once, and its result isn't lost to a dropped connection.
// The runner remembers job ids (so a job handed out twice runs once) and keeps results
// until delivered, on whatever connection comes next. Lorehouse accepts a result from the
// runner on the job's connection or a newer one, and after a reconnect fails at once the
// jobs the runner says it never got (they never ran, so a retry is safe).

import type { Database } from "bun:sqlite";
import { EXEC_TIMEOUT_MS, PUSH_TIMEOUT_MS, STAGE_TIMEOUT_MS, type ExecOptions, type ExecResult, type Sandbox, type Staged } from "../tools/workspace";

// `jobs`: ids the runner holds (running, or finished with a result not yet delivered).
// `received` (long poll only): ids from the last poll answer the runner got, so jobs whose
// answer never arrived are handed out again.
// `session` and `started` (unix ms) identify the runner process: of two with one name, the
// later-started one is the runner, and the other's polls are ignored.
// `sandboxes`: those whose VM is up (and counted in `running`).
export type RunnerStatus = { runner: string; capacity: number; running: number; version?: string; jobs?: string[]; received?: string[]; session?: string; started?: number; sandboxes?: string[] };

type JobBody =
  | { op: "guest"; method: "POST" | "GET" | "PUT"; path: string; bodyBase64?: string }
  | { op: "destroy" }
  // Publishing (sandbox/host/src/publish.rs): the request as JSON, answered with JSON.
  | { op: "stage" | "push"; bodyBase64: string };
// `deadlineMs`: set as a job goes out, how long Lorehouse will still wait for it.
export type Job = JobBody & { id: string; sandbox: string; timeoutMs: number; deadlineMs?: number };
export type JobResult = { id: string; status: number; contentType?: string; bodyBase64?: string; error?: string };

// How a job reaches the runner: pushed down its WebSocket, or queued for its next poll.
// `gen` orders a runner's connections: each new one gets a higher number.
type Link =
  | { gen: number; kind: "ws"; send: (job: Job) => void }
  | { gen: number; kind: "poll"; queue: Job[]; waiter?: (jobs: Job[]) => void; unacked: Map<string, Job> };

type Runner = { name: string; status: RunnerStatus; link: Link; lastSeen: number; session?: string; started?: number };
// `gen` is the connection the job went out on; `session`, the runner process it went to.
type Pending = { runner: string; gen: number; session?: string; deadline: number; resolve: (r: JobResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

// A boot can precede the work: a job's deadline is its own timeout plus this.
const BOOT_SLACK_MS = 60_000;
// How long a new sandbox's room stays reserved if no status lists it: a boot, plus a
// WebSocket runner's 20 s status interval, plus margin.
const RESERVE_MS = BOOT_SLACK_MS + 30_000;

export class RunnerHub {
  private runners = new Map<string, Runner>();
  private pending = new Map<string, Pending>();
  private gens = 0;
  // Sandboxes just placed whose VM a runner's status doesn't count yet, and when: each holds
  // a slot of room until a status from its runner lists it among `sandboxes` (from then on
  // `running` counts it), or RESERVE_MS passes without that (it never started, or already
  // stopped).
  private reserved = new Map<string, { runner: string; at: number }>();

  constructor(
    private readonly db: Database,
    private readonly opts: { pollWaitMs?: number; onlineMs?: number; reconnectGraceMs?: number; now?: () => number; log?: (m: string) => void } = {},
  ) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  private online(r: Runner): boolean {
    return r.link.kind === "ws" || this.now() - r.lastSeen < (this.opts.onlineMs ?? 45_000);
  }

  // ── WebSocket ──────────────────────────────────────────────────────────────────────

  // A runner's socket opened. Returns what the socket's handlers call. Status counts only
  // while this socket is still the runner's connection; results, from it or later (see
  // settle).
  attachWs(name: string, send: (job: Job) => void) {
    const link: Link = { gen: ++this.gens, kind: "ws", send };
    this.replace(name, link);
    const current = () => this.runners.get(name)?.link === link;
    return {
      status: (s: RunnerStatus) => {
        if (!current()) return;
        this.touch(name, s);
        this.reconcile(name, link, s.jobs, s.session);
      },
      result: (r: JobResult) => this.settle(name, link, r),
      closed: () => {
        if (!current()) return; // already replaced by a newer connection
        this.runners.delete(name);
        this.opts.log?.(`runners: ${name} disconnected`);
        // Its jobs may still be running there, with results to deliver on reconnect: give
        // it a grace to come back before failing them.
        setTimeout(() => {
          if (!this.runners.has(name)) this.failJobsOf(name, `sandbox runner ${name} disconnected and didn't come back`);
        }, this.opts.reconnectGraceMs ?? 60_000);
      },
    };
  }

  // ── long poll ──────────────────────────────────────────────────────────────────────

  // One poll: the jobs waiting for this runner, or, after pollWaitMs, none. If the request
  // is aborted while it waits, jobs stay queued for the next poll.
  //
  // Jobs handed out in an answer the runner never got (not in its `received`) go out
  // again; the runner's record of job ids keeps them from running twice. A runner that
  // doesn't send `received` is taken to have got everything.
  //
  // A poll never displaces a live WebSocket with the same name (a stale poller from an
  // older process would otherwise kick the runner off): it idles for pollWaitMs and
  // returns nothing. If that socket is in fact dead, it closes on its idle timeout, and
  // the next poll takes over.
  //
  // Nor does a poll from an older runner process (by `started`) displace a newer one's: a
  // process being replaced may keep polling for a while, and would otherwise take the
  // newer one's jobs. A newer process's first poll takes over from an older one.
  poll(status: RunnerStatus, signal?: AbortSignal): Promise<Job[]> {
    let r = this.runners.get(status.runner);
    if (r?.link.kind === "ws") return idle(this.opts.pollWaitMs ?? 25_000, signal);
    const otherProcess = !!(r?.session && status.session && r.session !== status.session);
    if (otherProcess && (status.started ?? 0) < (r!.started ?? 0)) return idle(this.opts.pollWaitMs ?? 25_000, signal);
    if (r?.link.kind !== "poll" || otherProcess) r = this.replace(status.runner, { gen: ++this.gens, kind: "poll", queue: [], unacked: new Map() });
    this.touch(status.runner, status);
    const link = r.link as Extract<Link, { kind: "poll" }>;
    this.reconcile(status.runner, link, status.jobs, status.session);
    if (status.received) {
      for (const id of status.received) link.unacked.delete(id);
      link.queue.unshift(...link.unacked.values());
    }
    link.unacked.clear();
    const deliver = (jobs: Job[]) => {
      const out = this.live(jobs);
      for (const j of out) link.unacked.set(j.id, j);
      return out.map((j) => this.outgoing(j));
    };
    if (link.queue.length) return Promise.resolve(deliver(link.queue.splice(0)));
    link.waiter?.([]); // a newer poll supersedes an older one still waiting
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (link.waiter === wake) link.waiter = undefined;
        resolve(deliver(link.queue.splice(0)));
      }, this.opts.pollWaitMs ?? 25_000);
      const wake = (jobs: Job[]) => {
        clearTimeout(timer);
        link.waiter = undefined;
        resolve(deliver(jobs));
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

  // Of queued jobs, those still awaited: one whose caller already gave up (its deadline
  // passed) is dropped rather than delivered.
  private live(jobs: Job[]): Job[] {
    return jobs.filter((j) => this.pending.has(j.id));
  }

  // A job as it goes out: with the time left until its deadline, so the runner stops it by
  // then (a relative time, so the two clocks needn't agree).
  private outgoing(job: Job): Job {
    const p = this.pending.get(job.id);
    return p ? { ...job, deadlineMs: Math.max(0, p.deadline - this.now()) } : job;
  }

  // Results posted over HTTP arrive on the runner's current connection.
  results(runner: string, results: JobResult[]): void {
    const link = this.runners.get(runner)?.link;
    if (!link) return;
    for (const r of results) this.settle(runner, link, r);
  }

  // ── both ───────────────────────────────────────────────────────────────────────────

  // A new connection for a name takes over. Jobs sent on the old one stay pending: the
  // runner may still be running them, and delivers their results on the new connection.
  // Its first status says which jobs it holds; the rest were lost in transit (reconcile).
  private replace(name: string, link: Link): Runner {
    const old = this.runners.get(name);
    if (old?.link.kind === "poll") old.link.waiter?.([]);
    const r: Runner = { name, link, lastSeen: this.now(), status: old?.status ?? { runner: name, capacity: 0, running: 0 } };
    this.runners.set(name, r);
    if (!old) this.opts.log?.(`runners: ${name} connected (${link.kind})`);
    return r;
  }

  private touch(name: string, status: RunnerStatus): void {
    const r = this.runners.get(name);
    if (!r) return;
    r.status = { runner: name, capacity: status.capacity, running: status.running, version: status.version };
    r.lastSeen = this.now();
    if (status.session) {
      r.session = status.session;
      r.started = status.started;
    }
    // Reservations this status settles: listed (now in `running`), or too old to wait for.
    const up = new Set(status.sandboxes ?? []);
    for (const [sandbox, v] of this.reserved) {
      if (v.runner === name && (up.has(sandbox) || this.now() - v.at >= RESERVE_MS)) this.reserved.delete(sandbox);
    }
  }

  // A result counts from the runner the job was sent to, arriving on that connection or a
  // newer one, never an older one: a replaced socket's late frames can't touch jobs sent
  // on its successor.
  private settle(runner: string, via: Link, result: JobResult): void {
    const p = this.pending.get(result.id);
    if (!p || p.runner !== runner || via.gen < p.gen) return;
    clearTimeout(p.timer);
    this.pending.delete(result.id);
    p.resolve(result);
  }

  // A runner's status on `link` lists the jobs it holds. A job sent to it on an older
  // connection that isn't listed never reached it (lost with that connection), so it never
  // ran: fail it now, safe to retry, instead of at its deadline. Only the process a job went
  // to can say it never got it: jobs sent to another (replaced) process wait for a result
  // or their deadline.
  private reconcile(runner: string, link: Link, held?: string[], session?: string): void {
    if (!held) return;
    const holds = new Set(held);
    for (const [id, p] of this.pending) {
      if (p.runner !== runner || p.gen >= link.gen || holds.has(id)) continue;
      if (p.session && session && p.session !== session) continue;
      clearTimeout(p.timer);
      this.pending.delete(id);
      p.reject(new Error(`the job was lost when the connection to ${runner} dropped; it never ran`));
    }
  }

  private failJobsOf(runner: string, why: string): void {
    for (const [id, p] of this.pending) {
      if (p.runner !== runner) continue;
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
    // recorded and the caller can try again. Room counts sandboxes placed since the status
    // was sent, so several new sandboxes at once don't all land on one runner.
    const taken = (r: Runner) => [...this.reserved.values()].filter((v) => v.runner === r.name).length;
    const free = (r: Runner) => r.status.capacity - r.status.running - taken(r);
    const online = [...this.runners.values()].filter((r) => this.online(r));
    if (!online.length) throw new Error("no sandbox runner is connected");
    const best = online.filter((r) => free(r) > 0).sort((a, b) => free(b) - free(a) || a.name.localeCompare(b.name))[0];
    if (!best) throw new Error("every sandbox runner is full; try again in a few minutes");
    this.db.query("INSERT INTO sandbox_placements (sandbox, runner, placed_at) VALUES (?, ?, ?)").run(sandbox, best.name, new Date(this.now()).toISOString());
    this.reserved.set(sandbox, { runner: best.name, at: this.now() });
    return best;
  }

  submit(sandbox: string, body: JobBody, timeoutMs: number): Promise<JobResult> {
    const runner = this.place(sandbox);
    // Random, not a counter: the runner remembers ids across Lorehouse restarts, and skips
    // one it has seen as a redelivery.
    const job = { ...body, id: `j_${crypto.randomUUID()}`, sandbox, timeoutMs } as Job;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(job.id);
        // A job still waiting to go out must never go out after this: the caller was told
        // it failed, so running it later (a write, say) would be a surprise.
        const link = this.runners.get(runner.name)?.link;
        if (link?.kind === "poll") {
          link.queue = link.queue.filter((j) => j.id !== job.id);
          link.unacked.delete(job.id);
        }
        reject(new Error(`sandbox job timed out on ${runner.name}`));
      }, timeoutMs + BOOT_SLACK_MS);
      const deadline = this.now() + timeoutMs + BOOT_SLACK_MS;
      this.pending.set(job.id, { runner: runner.name, gen: runner.link.gen, session: runner.session, deadline, resolve, reject, timer });
      if (runner.link.kind === "ws") runner.link.send(this.outgoing(job));
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
    // A publish op: the request (tokens included, so never logged) as JSON; the host's
    // answer as JSON, or its reason as the error.
    const publish = async (op: "stage" | "push", request: object, timeoutMs: number): Promise<unknown> => {
      const r = await this.submit(id, { op, bodyBase64: Buffer.from(JSON.stringify(request)).toString("base64") }, timeoutMs);
      if (r.status < 200 || r.status > 299) throw new Error(`${op}: ${r.status} ${r.error ?? decode(r)}`);
      return JSON.parse(decode(r));
    };
    return {
      async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
        // One timeout for both: the guest's limit, and (plus boot slack) this call's deadline.
        const timeoutMs = o.timeoutMs ?? EXEC_TIMEOUT_MS;
        const r = await guest("POST", "/exec", JSON.stringify({ command, cwd: o.cwd, env: o.env, timeoutMs }), timeoutMs);
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
      async stage(o): Promise<Staged> {
        const body = { owner: o.repo.owner, name: o.repo.name, base: o.base, token: o.token };
        return publish("stage", body, STAGE_TIMEOUT_MS) as Promise<Staged>;
      },
      async push(o) {
        const body = { owner: o.repo.owner, name: o.repo.name, sha: o.sha, branch: o.branch, token: o.token };
        return publish("push", body, PUSH_TIMEOUT_MS) as Promise<{ sha: string; branch: string }>;
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

// Where each sandbox lives, newest first (the admin API). A sandbox stays on the runner
// that first ran it, since its disk is there.
export type Placement = { sandbox: string; runner: string; placedAt: string; rowid: number };

export function listPlacements(db: Database, opts: { limit: number; after?: { placedAt: string; rowid: number } }): Placement[] {
  return db.query(
    `SELECT rowid, sandbox, runner, placed_at AS placedAt FROM sandbox_placements
     WHERE (?1 IS NULL OR (placed_at, rowid) < (?1, ?2))
     ORDER BY placed_at DESC, rowid DESC LIMIT ?3`,
  ).all(opts.after?.placedAt ?? null, opts.after?.rowid ?? null, opts.limit) as Placement[];
}
