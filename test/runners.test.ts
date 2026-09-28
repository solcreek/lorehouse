// Sandbox runners that connect in: delivery over both transports, placement, failures.

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { RunnerHub, type Job, type JobResult } from "../src/runners/hub";

const status = (runner: string, capacity = 4, running = 0) => ({ runner, capacity, running });
const b64 = (s: string) => Buffer.from(s).toString("base64");
const ok = (job: Job, body: unknown, status = 200): JobResult => ({ id: job.id, status, bodyBase64: b64(typeof body === "string" ? body : JSON.stringify(body)) });
const hubWith = (opts: ConstructorParameters<typeof RunnerHub>[1] = {}) => new RunnerHub(openKnowledge(":memory:"), opts);

// A WebSocket runner whose sent jobs are collected.
function wsRunner(hub: RunnerHub, name: string, capacity = 4, running = 0) {
  const sent: Job[] = [];
  const link = hub.attachWs(name, (j) => sent.push(j));
  link.status(status(name, capacity, running));
  return { sent, link };
}

describe("over WebSocket", () => {
  test("a job is pushed at once, and its result resolves the call", async () => {
    const hub = hubWith();
    const { sent, link } = wsRunner(hub, "r1");
    const done = hub.sandbox("s1").exec("echo hi", { cwd: "/w", timeoutMs: 5000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ sandbox: "s1", op: "guest", method: "POST", path: "/exec", timeoutMs: 5000 });
    expect(JSON.parse(Buffer.from(sent[0]!.op === "guest" ? sent[0]!.bodyBase64! : "", "base64").toString())).toEqual({ command: "echo hi", cwd: "/w", timeoutMs: 5000 });
    link.result(ok(sent[0]!, { exitCode: 0, stdout: "hi\n", stderr: "" }));
    expect(await done).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
  });

  test("a closed connection's jobs fail if the runner doesn't come back within the grace", async () => {
    const hub = hubWith({ reconnectGraceMs: 30 });
    const { link } = wsRunner(hub, "r1");
    const done = hub.sandbox("s1").exec("sleep 100");
    link.closed();
    await expect(done).rejects.toThrow(/r1 disconnected and didn't come back/);
  });

  test("a runner that comes back within the grace delivers the result of a job from before the drop", async () => {
    const hub = hubWith({ reconnectGraceMs: 30 });
    const before = wsRunner(hub, "r1");
    const done = hub.sandbox("s1").exec("make build");
    before.link.closed();
    const after = hub.attachWs("r1", () => {});
    after.status({ ...status("r1"), jobs: [before.sent[0]!.id] }); // it still holds the job
    after.result(ok(before.sent[0]!, { exitCode: 0, stdout: "built", stderr: "" }));
    expect((await done).stdout).toBe("built");
  });

  test("a newer connection with the same name replaces the old; the old one closing later changes nothing", async () => {
    const hub = hubWith();
    const old = wsRunner(hub, "r1");
    const fresh = wsRunner(hub, "r1");
    const done = hub.sandbox("s1").exec("true");
    old.link.closed();
    expect(fresh.sent).toHaveLength(1);
    fresh.link.result(ok(fresh.sent[0]!, { exitCode: 0, stdout: "", stderr: "" }));
    expect((await done).exitCode).toBe(0);
  });
});

describe("a replaced connection", () => {
  test("its late frames are ignored: a status can't overwrite the new one's, a result can't settle the new one's job", async () => {
    const hub = hubWith();
    const old = wsRunner(hub, "r1", 4, 0);
    const fresh = wsRunner(hub, "r1", 4, 1);
    old.link.status(status("r1", 4, 4)); // stale: would claim the runner is full
    expect(hub.status()[0]).toMatchObject({ capacity: 4, running: 1 });
    const done = hub.sandbox("s1").exec("true");
    old.link.result(ok(fresh.sent[0]!, { exitCode: 0, stdout: "stale", stderr: "" }));
    fresh.link.result(ok(fresh.sent[0]!, { exitCode: 0, stdout: "fresh", stderr: "" }));
    expect((await done).stdout).toBe("fresh");
  });

  test("a job the runner still holds survives the takeover, and its result arrives on the new connection", async () => {
    const hub = hubWith();
    const old = wsRunner(hub, "r1");
    const inFlight = hub.sandbox("s1").exec("npm test", { timeoutMs: 600_000 });
    const fresh = hub.attachWs("r1", () => {});
    fresh.status({ ...status("r1"), jobs: [old.sent[0]!.id] });
    fresh.result(ok(old.sent[0]!, { exitCode: 0, stdout: "ran once", stderr: "" }));
    expect((await inFlight).stdout).toBe("ran once");
  });

  test("a job the runner doesn't hold after a reconnect was lost in transit, never ran: it fails at once, safe to retry", async () => {
    const hub = hubWith();
    wsRunner(hub, "r1");
    const inFlight = hub.sandbox("s1").exec("npm test", { timeoutMs: 600_000 });
    hub.attachWs("r1", () => {}).status({ ...status("r1"), jobs: [] });
    await expect(inFlight).rejects.toThrow(/lost when the connection to r1 dropped; it never ran/);
  });

  test("a poll can't displace a live WebSocket", async () => {
    const hub = hubWith({ pollWaitMs: 20 });
    const ws = wsRunner(hub, "r1");
    expect(await hub.poll(status("r1"))).toEqual([]); // a stale poller with the same name
    expect(hub.status()[0]).toMatchObject({ transport: "ws" });
    void hub.sandbox("s1").exec("true");
    expect(ws.sent).toHaveLength(1); // the socket still gets the work
  });
});

describe("over long poll", () => {
  test("a held poll returns as soon as a job arrives, and posted results resolve the call", async () => {
    const hub = hubWith({ pollWaitMs: 5000 });
    const polled = hub.poll(status("r1"));
    const done = hub.sandbox("s1").readFile("/w/a.txt");
    const jobs = await polled;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ op: "guest", method: "GET", path: "/file?path=%2Fw%2Fa.txt" });
    hub.results("r1", [ok(jobs[0]!, "content")]);
    expect(await done).toBe("content");
  });

  test("a job submitted between polls waits in the queue for the next one", async () => {
    const hub = hubWith({ pollWaitMs: 20 });
    expect(await hub.poll(status("r1"))).toEqual([]); // times out empty; the runner is known now
    const done = hub.sandbox("s1").writeFile("/w/b.txt", "data");
    const jobs = await hub.poll(status("r1"));
    expect(jobs[0]).toMatchObject({ op: "guest", method: "PUT", path: "/file?path=%2Fw%2Fb.txt", bodyBase64: b64("data") });
    hub.results("r1", [{ id: jobs[0]!.id, status: 204 }]);
    await done;
  });

  test("a poll answer the runner never got is handed out again; one it acknowledged is not", async () => {
    const hub = hubWith({ pollWaitMs: 20 });
    await hub.poll({ ...status("r1"), received: [] });
    const done = hub.sandbox("s1").exec("true");
    const first = await hub.poll({ ...status("r1"), received: [] }); // this answer is lost on the way
    expect(first).toHaveLength(1);
    const again = await hub.poll({ ...status("r1"), received: [] }); // the runner says it got nothing
    expect(again.map((j) => j.id)).toEqual([first[0]!.id]);
    expect(await hub.poll({ ...status("r1"), received: [first[0]!.id] })).toEqual([]); // acknowledged: not again
    hub.results("r1", [ok(first[0]!, { exitCode: 0, stdout: "", stderr: "" })]);
    await done;
  });

  test("a job that times out while queued is never delivered: the caller was told it failed", async () => {
    const hub = hubWith({ pollWaitMs: 20 });
    await hub.poll(status("r1")); // known, but not polling right now
    const late = hub.submit("s1", { op: "guest", method: "PUT", path: "/file?path=%2Fw%2Fa", bodyBase64: b64("x") }, -59_950); // deadline ≈ 50 ms
    await expect(late).rejects.toThrow(/timed out/);
    expect(await hub.poll(status("r1"))).toEqual([]); // the runner comes back: the write is not handed out
  });

  test("a poll aborted while waiting leaves the job queued for the next poll", async () => {
    const hub = hubWith({ pollWaitMs: 5000 });
    const abort = new AbortController();
    const first = hub.poll(status("r1"), abort.signal);
    abort.abort();
    expect(await first).toEqual([]);
    const done = hub.sandbox("s1").exec("true");
    const jobs = await hub.poll(status("r1"));
    expect(jobs).toHaveLength(1);
    hub.results("r1", [ok(jobs[0]!, { exitCode: 0, stdout: "", stderr: "" })]);
    await done;
  });

  test("a newer poll supersedes an older one still waiting (which returns empty)", async () => {
    const hub = hubWith({ pollWaitMs: 5000 });
    const older = hub.poll(status("r1"));
    const newer = hub.poll(status("r1"));
    expect(await older).toEqual([]);
    const done = hub.sandbox("s1").exec("true");
    const jobs = await newer;
    hub.results("r1", [ok(jobs[0]!, { exitCode: 0, stdout: "", stderr: "" })]);
    await done;
  });

  test("a runner whose last poll is too old is offline", async () => {
    let now = 1_000_000;
    const hub = hubWith({ pollWaitMs: 1, onlineMs: 45_000, now: () => now });
    await hub.poll(status("r1"));
    now += 46_000;
    expect(() => hub.submit("s1", { op: "destroy" }, 1000)).toThrow(/no sandbox runner is connected/);
  });
});

describe("placement", () => {
  test("a new sandbox goes to the runner with the most room; later jobs stay there", async () => {
    const hub = hubWith();
    const busy = wsRunner(hub, "busy", 4, 3);
    const idle = wsRunner(hub, "idle", 4, 0);
    void hub.sandbox("s1").exec("a");
    expect(idle.sent).toHaveLength(1);
    idle.link.status(status("idle", 4, 4)); // now the other has more room…
    void hub.sandbox("s1").exec("b");
    expect(idle.sent).toHaveLength(2); // …but s1's disk is on idle
    expect(busy.sent).toHaveLength(0);
  });

  test("a sandbox whose runner is offline fails rather than moving; with no runner at all, a new one fails", () => {
    const hub = hubWith();
    const r = wsRunner(hub, "r1");
    void hub.sandbox("s1").exec("a").catch(() => {});
    r.link.closed();
    wsRunner(hub, "r2");
    expect(() => hub.submit("s1", { op: "destroy" }, 1000)).toThrow(/sandbox's host \(r1\) is offline/);
    expect(() => hubWith().submit("s9", { op: "destroy" }, 1000)).toThrow(/no sandbox runner is connected/);
  });

  test("only a runner with room is chosen: not a full one, nor a socket that hasn't reported yet", () => {
    const hub = hubWith();
    const quiet = { sent: [] as Job[] };
    hub.attachWs("quiet", (j) => quiet.sent.push(j)); // connected, no status yet: capacity 0
    const full = wsRunner(hub, "full", 2, 2);
    expect(() => hub.submit("s1", { op: "destroy" }, 1000)).toThrow(/every sandbox runner is full/);
    expect(quiet.sent).toHaveLength(0);
    expect(full.sent).toHaveLength(0);
    // Nothing was recorded, so once room appears the same sandbox lands where the room is.
    full.link.status(status("full", 2, 1));
    void hub.submit("s1", { op: "destroy" }, 1000);
    expect(full.sent).toHaveLength(1);
  });

  test("placements survive a restart of Lorehouse (they are in the database)", () => {
    const db = openKnowledge(":memory:");
    const a = new RunnerHub(db);
    const sent: Job[] = [];
    a.attachWs("r1", (j) => sent.push(j)).status(status("r1"));
    void a.sandbox("s1").exec("a");
    const b = new RunnerHub(db); // a new process, same database; r1 hasn't reconnected yet
    b.attachWs("r2", () => {}).status(status("r2"));
    expect(() => b.submit("s1", { op: "destroy" }, 1000)).toThrow(/\(r1\) is offline/);
  });
});

describe("results and failures", () => {
  test("a result counts only from the runner the job went to", async () => {
    const hub = hubWith();
    const r1 = wsRunner(hub, "r1");
    const r2 = wsRunner(hub, "r2", 1, 1);
    const done = hub.sandbox("s1").exec("true", { timeoutMs: 1 });
    r2.link.result(ok(r1.sent[0]!, { exitCode: 0, stdout: "forged", stderr: "" }));
    r1.link.result(ok(r1.sent[0]!, { exitCode: 0, stdout: "real", stderr: "" }));
    expect((await done).stdout).toBe("real");
  });

  test("the Sandbox behaves like the direct client: a missing file, and an error status", async () => {
    const hub = hubWith();
    const { sent, link } = wsRunner(hub, "r1");
    const read = hub.sandbox("s1").readFile("/nope");
    link.result({ id: sent[0]!.id, status: 404 });
    await expect(read).rejects.toThrow("no such file: /nope");
    const exec = hub.sandbox("s1").exec("true");
    link.result({ id: sent[1]!.id, status: 503, error: "all 4 sandboxes are busy; try again later" });
    await expect(exec).rejects.toThrow("sandbox POST /exec: 503 all 4 sandboxes are busy");
  });

  test("with no result by the deadline (its timeout plus boot time), the call fails", async () => {
    const hub = hubWith();
    wsRunner(hub, "r1");
    const t0 = Date.now();
    const slow = hub.submit("s1", { op: "destroy" }, -59_950); // deadline = timeout + 60 s boot slack ≈ 50 ms
    await expect(slow).rejects.toThrow(/timed out on r1/);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test("/status lists runners by transport, room and freshness", async () => {
    const hub = hubWith({ pollWaitMs: 1 });
    wsRunner(hub, "ws1", 4, 1);
    await hub.poll({ runner: "poll1", capacity: 2, running: 0, version: "0.1.0" });
    expect(hub.status().map(({ lastSeenSecs: _, ...r }) => r)).toEqual([
      { runner: "ws1", transport: "ws", online: true, capacity: 4, running: 1, version: undefined },
      { runner: "poll1", transport: "poll", online: true, capacity: 2, running: 0, version: "0.1.0" },
    ]);
  });
});
