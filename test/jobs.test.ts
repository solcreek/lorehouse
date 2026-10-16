// Background jobs: the tools (start is idempotent, status waits, who may cancel), and both
// sandbox backends' calls (runner jobs, the direct daemon API).

import { describe, expect, test } from "bun:test";
import type { ToolContext } from "@junejs/core/agent-runtime";
import { openKnowledge } from "../src/knowledge";
import { RunnerHub, type Job } from "../src/runners/hub";
import { remoteSandbox } from "../src/sandbox-client";
import { formatElapsed, jobStore, jobTools, type JobAuthority } from "../src/tools/jobs";
import { WORKDIR, jobReply, type JobStart, type Sandbox, type SandboxJob } from "../src/tools/workspace";

const job = (o: Partial<SandboxJob> = {}): SandboxJob => ({
  id: "bench-1", command: "make bench", cwd: WORKDIR, state: "running", exitCode: null,
  startedAt: "2026-10-16T00:00:00Z", endedAt: null, elapsedMs: 65_000, timeoutMs: 3_600_000,
  outputBytes: 12, tail: "iteration 3\n", tailTruncated: false, ...o,
});

// A sandbox whose jobs answer from memory, recording each call.
function fakeJobs() {
  const calls: { op: string; arg: unknown }[] = [];
  const started = new Set<string>();
  const sb = {
    jobs: {
      async start(o: JobStart) {
        calls.push({ op: "start", arg: o });
        const created = !started.has(o.id);
        started.add(o.id);
        return job({ id: o.id, command: o.command, cwd: o.cwd, created });
      },
      async status(id: string, o?: { waitMs?: number; tailBytes?: number }) {
        calls.push({ op: "status", arg: { id, ...o } });
        return job({ id, state: "exited", exitCode: 0, tail: "done\n" });
      },
      async cancel(id: string) {
        calls.push({ op: "cancel", arg: id });
        return job({ id, state: "cancelled", exitCode: 143, reason: "cancelled on request" });
      },
    },
  } as unknown as Sandbox;
  return { sb, calls };
}

const ctxFor = (user?: string, o: { attested?: boolean; session?: string } = {}) =>
  ({
    sessionId: o.session ?? "slack:C1:1790000000.000100",
    event: user ? { source: "slack", kind: "app_mention", channelId: "C1", threadId: "1790000000.000100", ts: "1790000100.000100", user: { id: user, attested: o.attested ?? true } } : undefined,
  }) as unknown as ToolContext;

const NAMES: Record<string, string> = { U1: "Kai", U2: "Wendy", U9: "Ada" };
const authority = (messages: Record<string, string> = {}, admins: string[] = []): JobAuthority => ({
  authorOf: async (_c, _t, ts) => messages[ts],
  isAdmin: async (u) => admins.includes(u),
  nameOf: async (u) => NAMES[u],
});

function tools(o: { authority?: JobAuthority; sb?: Sandbox } = {}) {
  const { sb, calls } = o.sb ? { sb: o.sb, calls: [] } : fakeJobs();
  const store = jobStore(openKnowledge(":memory:"));
  const list = jobTools(() => sb, { store, authority: o.authority ?? authority(), commitAs: async () => ({ name: "bot", email: "bot@example.com" }) });
  const run = (name: string, input: unknown, ctx: ToolContext) => list.find((t) => t.spec.name === name)!.run(input, ctx) as Promise<Record<string, unknown>>;
  return { run, calls, store };
}

describe("workspace_job_start", () => {
  test("starts in the checkout as the bot's author, with the timeout asked for, and records who started it", async () => {
    const { run, calls, store } = tools();
    const r = await run("workspace_job_start", { id: "bench-1", command: "make bench", timeoutMinutes: 90 }, ctxFor("U1"));
    expect(r).toMatchObject({ id: "bench-1", state: "running", exitCode: null, elapsed: "1m 5s", started: "started", next: expect.stringContaining("workspace_job_status") });
    expect(calls[0]!.arg).toEqual({ id: "bench-1", command: "make bench", cwd: WORKDIR, timeoutMs: 90 * 60_000, env: { GIT_AUTHOR_NAME: "bot", GIT_AUTHOR_EMAIL: "bot@example.com", GIT_COMMITTER_NAME: "bot", GIT_COMMITTER_EMAIL: "bot@example.com" } });
    expect(store.get("slack:C1:1790000000.000100", "bench-1")?.startedBy).toBe("U1");
  });

  test("a replayed start says it is the same job, and keeps the first starter", async () => {
    const { run, store } = tools();
    await run("workspace_job_start", { id: "bench-1", command: "make bench" }, ctxFor("U1"));
    const again = await run("workspace_job_start", { id: "bench-1", command: "make bench" }, ctxFor("U2"));
    expect(again.started).toContain("not a second copy");
    expect(store.get("slack:C1:1790000000.000100", "bench-1")?.startedBy).toBe("U1");
  });

  test("a bad id or timeout is refused before anything runs, saying what is allowed", async () => {
    const { run, calls } = tools();
    expect((await run("workspace_job_start", { id: "../x", command: "true" }, ctxFor("U1"))).error).toContain("e.g. \"bench-1\"");
    expect((await run("workspace_job_start", { id: "a", command: "true", timeoutMinutes: 9999 }, ctxFor("U1"))).error).toContain("at most 360");
    expect(calls).toHaveLength(0);
  });

  test("a backend without jobs says to use workspace_exec", async () => {
    const { run } = tools({ sb: {} as Sandbox });
    expect((await run("workspace_job_start", { id: "a", command: "true" }, ctxFor("U1"))).error).toContain("workspace_exec");
  });
});

describe("workspace_job_status", () => {
  test("waits a minute by default, up to five, and reports how it ended", async () => {
    const { run, calls } = tools();
    expect(await run("workspace_job_status", { id: "bench-1" }, ctxFor("U1"))).toMatchObject({ state: "exited", exitCode: 0, tail: "done\n" });
    await run("workspace_job_status", { id: "bench-1", waitSeconds: 300 }, ctxFor("U1"));
    expect(calls.map((c) => c.arg)).toEqual([{ id: "bench-1", waitMs: 60_000, tailBytes: 8192 }, { id: "bench-1", waitMs: 300_000, tailBytes: 8192 }]);
    expect((await run("workspace_job_status", { id: "bench-1", waitSeconds: 301 }, ctxFor("U1"))).error).toContain("0 to 300");
  });
});

describe("workspace_job_cancel", () => {
  async function started(by: string | undefined, auth?: JobAuthority) {
    const t = tools({ authority: auth });
    await t.run("workspace_job_start", { id: "bench-1", command: "make bench" }, ctxFor(by));
    return t;
  }

  test("the starter may cancel; the answer is the job as it ended", async () => {
    const { run, calls } = await started("U1");
    expect(await run("workspace_job_cancel", { id: "bench-1" }, ctxFor("U1"))).toMatchObject({ state: "cancelled", exitCode: 143, cancelledFor: "Kai" });
    expect(calls.at(-1)).toEqual({ op: "cancel", arg: "bench-1" });
  });

  test("someone else is refused by name, and the job keeps running; an admin may", async () => {
    const { run, calls } = await started("U1", authority({}, ["U9"]));
    const refused = await run("workspace_job_cancel", { id: "bench-1" }, ctxFor("U2"));
    expect(refused.error).toBe("only Kai, who started job bench-1, or a workspace admin may cancel it; Wendy asked. Say so in the thread; the job keeps running");
    expect(calls.some((c) => c.op === "cancel")).toBe(false);
    expect((await run("workspace_job_cancel", { id: "bench-1" }, ctxFor("U9"))).state).toBe("cancelled");
  });

  test("a later message's author is looked up in Slack, not taken from the model", async () => {
    const later = (s: number) => `${Math.floor(Date.now() / 1000) + s}.000100`;
    const auth = authority({ [later(10)]: "U1", [later(20)]: "U2", "1600000000.000100": "U1" });
    const { run } = await started("U1", auth);
    // The turn's speaker is someone else; the message that asked is the starter's.
    expect((await run("workspace_job_cancel", { id: "bench-1", requestTs: later(10) }, ctxFor("U2"))).state).toBe("cancelled");
    const { run: run2 } = await started("U1", auth);
    expect((await run2("workspace_job_cancel", { id: "bench-1", requestTs: later(20) }, ctxFor("U1"))).error).toContain("Wendy asked");
    expect((await run2("workspace_job_cancel", { id: "bench-1", requestTs: "1600000000.000100" }, ctxFor("U2"))).error).toContain("from before job bench-1 started");
    expect((await run2("workspace_job_cancel", { id: "bench-1", requestTs: later(99) }, ctxFor("U1"))).error).toContain(`no message with ts ${later(99)} in this thread`);
    expect((await run2("workspace_job_cancel", { id: "bench-1", requestTs: "yesterday" }, ctxFor("U1"))).error).toContain("a Slack message ts");
  });

  test("a job whose starter Slack didn't vouch for may be cancelled by anyone in the thread", async () => {
    const t = tools();
    await t.run("workspace_job_start", { id: "j", command: "sleep 600" }, ctxFor("U1", { attested: false }));
    expect((await t.run("workspace_job_cancel", { id: "j" }, ctxFor("U2"))).state).toBe("cancelled");
  });
});

describe("job answers", () => {
  test("guestd's reason is passed on; a host that predates jobs is named as such", () => {
    expect(jobReply("start", 201, JSON.stringify(job()))).toMatchObject({ id: "bench-1" });
    expect(() => jobReply("start", 409, JSON.stringify({ error: "job id \"a\" already names another run" }))).toThrow("job start: job id \"a\" already names another run");
    expect(() => jobReply("status", 404, "404 page not found\n")).toThrow(/guest agent predates background jobs/);
    expect(() => jobReply("start", 400, JSON.stringify({ error: "guest call not allowed: POST /jobs" }))).toThrow(/sandboxd predates background jobs/);
  });

  test("guestd's word that a job's end isn't on disk yet reaches the model", async () => {
    const sb = { jobs: { status: async (id: string) => job({ id, state: "exited", exitCode: 0, persistError: "the job's end couldn't be saved (no space left on device)" }) } } as unknown as Sandbox;
    const { run } = tools({ sb });
    expect(await run("workspace_job_status", { id: "bench-1" }, ctxFor("U1"))).toMatchObject({ state: "exited", persistError: expect.stringContaining("no space left") });
  });

  test("elapsed reads like a person would say it", () => {
    expect([formatElapsed(4_000), formatElapsed(65_000), formatElapsed(3_725_000)]).toEqual(["4s", "1m 5s", "1h 2m"]);
  });

  test("over a runner: guest calls on /jobs, each with its own deadline", async () => {
    const hub = new RunnerHub(openKnowledge(":memory:"));
    const sent: Job[] = [];
    const link = hub.attachWs("r1", (j) => sent.push(j));
    link.status({ runner: "r1", capacity: 4, running: 0 });
    const answer = (status: number, body: unknown) => link.result({ id: sent.at(-1)!.id, status, bodyBase64: Buffer.from(JSON.stringify(body)).toString("base64") });
    const jobs = hub.sandbox("s1").jobs!;

    const start = jobs.start({ id: "bench-1", command: "make bench", cwd: "/w" });
    expect(sent.at(-1)).toMatchObject({ op: "guest", method: "POST", path: "/jobs", timeoutMs: 30_000 });
    answer(201, job({ created: true }));
    expect((await start).created).toBe(true);

    const status = jobs.status("bench-1", { waitMs: 60_000, tailBytes: 4096 });
    expect(sent.at(-1)).toMatchObject({ method: "GET", path: "/jobs/bench-1?waitMs=60000&tailBytes=4096", timeoutMs: 90_000 });
    answer(200, job({ state: "exited", exitCode: 0 }));
    expect((await status).exitCode).toBe(0);

    const cancel = jobs.cancel("bench-1");
    expect(sent.at(-1)).toMatchObject({ method: "POST", path: "/jobs/bench-1/cancel" });
    link.result({ id: sent.at(-1)!.id, status: 400, error: "guest call not allowed: POST /jobs/bench-1/cancel" });
    await expect(cancel).rejects.toThrow(/sandboxd predates background jobs/);
  });

  test("direct: the daemon's /v1/sandboxes/{id}/jobs API", async () => {
    const reqs: { url: string; method: string; body?: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      reqs.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
      return url.includes("missing") ? Response.json({ error: "no job \"missing\" in this sandbox; the latest jobs here: bench-1" }, { status: 404 }) : Response.json(job(), { status: url.endsWith("/jobs") ? 201 : 200 });
    }) as typeof fetch;
    const jobs = remoteSandbox("s1", { url: "https://fb.example", token: "t", fetch: f }).jobs!;
    await jobs.start({ id: "bench-1", command: "make bench", cwd: "/w" });
    await jobs.status("bench-1", { waitMs: 1000 });
    await jobs.cancel("bench-1");
    await expect(jobs.status("missing")).rejects.toThrow("the latest jobs here: bench-1");
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST https://fb.example/v1/sandboxes/s1/jobs",
      "GET https://fb.example/v1/sandboxes/s1/jobs/bench-1?waitMs=1000&tailBytes=8192",
      "POST https://fb.example/v1/sandboxes/s1/jobs/bench-1/cancel",
      "GET https://fb.example/v1/sandboxes/s1/jobs/missing?tailBytes=8192",
    ]);
    expect(JSON.parse(reqs[0]!.body!)).toEqual({ id: "bench-1", command: "make bench", cwd: "/w" });
  });

  test("records older than two days are pruned", () => {
    const store = jobStore(openKnowledge(":memory:"));
    store.record("s", "old", "U1", new Date("2026-10-01T00:00:00Z"));
    store.record("s", "new", "U1", new Date("2026-10-15T00:00:00Z"));
    expect(store.prune(new Date("2026-10-16T00:00:00Z"))).toBe(1);
    expect([store.get("s", "old"), store.get("s", "new")?.startedBy]).toEqual([undefined, "U1"]);
  });
});
