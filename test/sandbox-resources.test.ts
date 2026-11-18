// A profile's request for its sandbox's resources (#109): what loadProfiles accepts, how
// the request reaches the sandbox host over both transports, and how a refusal or a host
// too old to honor it comes back.

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { loadProfiles, LOREHOUSE, ProfileError, PROFILES, type Profile } from "../src/profiles";
import { RunnerHub, type Job, type JobResult } from "../src/runners/hub";
import { runnerRoutes } from "../src/runners/routes";
import { remoteSandbox } from "../src/sandbox-client";
import { ResourcesUnsupported, SandboxRefusal, resourceProblems, wireResources } from "../src/sandbox-resources";
import { EXEC_TIMEOUT_MS, JobCallError, workspaceTools } from "../src/tools/workspace";

const CATALOG = { prompts: ["lorehouse", "review"], tools: ["search_knowledge", "workspace_exec", "open_pull_request"], skills: [] };
const coder: Profile = { id: "lorehouse", mode: "interactive", prompt: "lorehouse", tools: ["workspace_exec"], skills: [], triggers: [{ kind: "slack", events: ["mention"] }], sandbox: "write" };
function problems(...profiles: unknown[]): string[] {
  try {
    loadProfiles(profiles, CATALOG);
    return [];
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return err.problems;
  }
}

// sandboxd's own sentence for a request over a maximum (sandbox/host/src/resources.rs).
const OVER = "resources.memMib 8192 is over this sandbox host's maximum of 4096 (MiB of memory; SANDBOXD_MAX_MEM_MIB). Ask for at most 4096, or have the host's operator raise SANDBOXD_MAX_MEM_MIB in sandboxd's environment. Nothing was created or changed";
const ASK = { vcpus: 4, memMib: 8192, commandTimeoutSecs: 1800 } as const;
const MEANS = " (seconds; it bounds every command run in the sandbox, a clone and a fetch included, so under a minute the code tools could not work; background jobs keep their own limits)";

describe("a profile's sandboxResources", () => {
  test("the shipped profiles ask for nothing, so their sandboxes are the host's defaults", () => {
    expect(PROFILES.map((p) => p.sandboxResources)).toEqual([undefined]);
    expect("sandboxResources" in LOREHOUSE).toBe(false);
  });

  test("any of the five, as whole numbers a host could grant, is accepted and frozen", () => {
    const all = { vcpus: 4, memMib: 4096, diskGib: 16, pids: 128, commandTimeoutSecs: 1800 };
    const [p] = loadProfiles([{ ...coder, sandboxResources: all }], CATALOG);
    expect(p!.sandboxResources).toEqual(all);
    expect(Object.isFrozen(p!.sandboxResources)).toBe(true);
    for (const one of [{ vcpus: 1 }, { memMib: 128 }, { diskGib: 65_536 }, { pids: 16 }, { commandTimeoutSecs: 21_600 }, { commandTimeoutSecs: 60 }]) expect(problems({ ...coder, sandboxResources: one }), JSON.stringify(one)).toEqual([]);
  });

  test("a wrong one stops the start, naming the field and what it allows", () => {
    const at = 'profile "lorehouse": sandboxResources';
    const cases: [unknown, string][] = [
      [{ vcpus: 0 }, `${at}.vcpus: must be a whole number from 1 to 32, got 0`],
      [{ vcpus: -2 }, `${at}.vcpus: must be a whole number from 1 to 32, got -2`],
      [{ vcpus: 33 }, `${at}.vcpus: must be a whole number from 1 to 32, got 33`],
      [{ memMib: 2048.5 }, `${at}.memMib: must be a whole number from 128 to 262144, got 2048.5`],
      [{ memMib: "4096" }, `${at}.memMib: must be a whole number from 128 to 262144, got "4096"`],
      [{ diskGib: null }, `${at}.diskGib: must be a whole number from 1 to 65536, got null`],
      [{ pids: 8 }, `${at}.pids: must be a whole number from 16 to 4096, got 8`],
      [{ commandTimeoutSecs: 86_400 }, `${at}.commandTimeoutSecs: must be a whole number from 60 to 21600${MEANS}, got 86400`],
      [{ commandTimeoutSecs: Number.NaN }, `${at}.commandTimeoutSecs: must be a whole number from 60 to 21600${MEANS}, got null`],
      // Under a minute no clone could finish: refused here, though sandboxd would take it.
      [{ commandTimeoutSecs: 59 }, `${at}.commandTimeoutSecs: must be a whole number from 60 to 21600${MEANS}, got 59`],
      // A name every object has is still not a resource: a problem, never a TypeError.
      [{ toString: 1 }, `${at}.toString: is not a sandbox resource (allowed: vcpus, memMib, diskGib, pids, commandTimeoutSecs)`],
      [{ constructor: 4 }, `${at}.constructor: is not a sandbox resource (allowed: vcpus, memMib, diskGib, pids, commandTimeoutSecs)`],
      [{ hasOwnProperty: 2 }, `${at}.hasOwnProperty: is not a sandbox resource (allowed: vcpus, memMib, diskGib, pids, commandTimeoutSecs)`],
      [JSON.parse('{"__proto__":1}'), `${at}.__proto__: is not a sandbox resource (allowed: vcpus, memMib, diskGib, pids, commandTimeoutSecs)`],
      [{ gpus: 1 }, `${at}.gpus: is not a sandbox resource (allowed: vcpus, memMib, diskGib, pids, commandTimeoutSecs)`],
      [{ mem_mib: 4096 }, `${at}.mem_mib: is not a sandbox resource (allowed: vcpus, memMib, diskGib, pids, commandTimeoutSecs)`],
      [{ vcpus: 16, pids: 16 }, `${at}.pids: must be at least 24 for 16 vCPUs (the VM's own threads count against it: one per vCPU and a few more), got 16`],
      [{}, `${at}: asks for nothing; leave it out to get the sandbox host's defaults`],
      ["big", `${at}: must be an object with any of vcpus, memMib, diskGib, pids, commandTimeoutSecs, got "big"`],
      [[4, 4096], `${at}: must be an object with any of vcpus, memMib, diskGib, pids, commandTimeoutSecs, got [4,4096]`],
      [null, `${at}: must be an object with any of vcpus, memMib, diskGib, pids, commandTimeoutSecs, got null`],
      [undefined, `${at}: is set to nothing; leave the field out to get the sandbox host's defaults`],
    ];
    for (const [value, problem] of cases) expect(problems({ ...coder, sandboxResources: value }), JSON.stringify(value)).toEqual([problem]);
    // Every problem at once, not only the first.
    expect(problems({ ...coder, sandboxResources: { vcpus: 0, gpus: 1 } })).toHaveLength(2);
  });

  test("nothing is accepted unless something honors it: no sandbox, or not the profile Slack starts, is refused", () => {
    expect(problems({ ...coder, tools: ["search_knowledge"], sandbox: "none", sandboxResources: { memMib: 4096 } })).toEqual([
      'profile "lorehouse": sandboxResources: needs a sandbox: this profile\'s sandbox is "none", so nothing would be created with them',
    ]);
    const review = { ...coder, id: "review", mode: "automation", prompt: "review", triggers: [], sandboxResources: { memMib: 4096 } };
    expect(problems(coder, review)).toEqual([
      'profile "review": sandboxResources: needs a trigger of kind "slack", for now: only the sandbox of the profile Slack starts is created with a request, so nothing would honor this one',
    ]);
    // The sandbox's access level is still the one word it was.
    expect(problems({ ...coder, sandbox: { access: "write", resources: { memMib: 4096 } } })[0]).toMatch(/sandbox: must be one of none, write/);
  });

  test("the checks stand alone, for any caller", () => {
    expect(resourceProblems({ vcpus: 2 }, "r")).toEqual([]);
    expect(resourceProblems({ vcpus: 2.5 }, "r")).toEqual(["r.vcpus: must be a whole number from 1 to 32, got 2.5"]);
    // Only what was asked goes out, in a fixed order.
    expect(JSON.stringify(wireResources({ commandTimeoutSecs: 60, vcpus: 2, memMib: undefined }))).toBe('{"vcpus":2,"commandTimeoutSecs":60}');
  });
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const hubWith = () => new RunnerHub(openKnowledge(":memory:"));
// A WebSocket runner: its sent jobs, and whether its sandboxd understands requests.
function wsRunner(hub: RunnerHub, name: string, features?: string[], version = "0.1.0") {
  const sent: Job[] = [];
  const link = hub.attachWs(name, (j) => sent.push(j));
  link.status({ runner: name, capacity: 4, running: 0, version, features });
  return { sent, link };
}
const exited = (job: Job): JobResult => ({ id: job.id, status: 200, bodyBase64: b64(JSON.stringify({ exitCode: 0, stdout: "", stderr: "" })) });
const refusedBy = (job: Job): JobResult => ({ id: job.id, status: 422, error: OVER, code: "resource_over_maximum" });

describe("the request over the runner protocol", () => {
  test("every guest job carries it, and a command waits as long as it asks; without one, jobs are as they were", async () => {
    const hub = hubWith();
    const { sent, link } = wsRunner(hub, "r1", ["resources"]);
    const sb = hub.sandbox("s1", { resources: ASK });
    const ran = sb.exec("make");
    void sb.writeFile("/w/a", "x");
    void sb.readFile("/w/a");
    void sb.jobs!.start({ id: "b1", command: "make bench", cwd: "/w" });
    expect(sent).toHaveLength(4);
    for (const job of sent) expect(job).toMatchObject({ op: "guest", resources: { vcpus: 4, memMib: 8192, commandTimeoutSecs: 1800 } });
    // No timeout named: the one asked for, as the job's own and in the body guestd reads.
    expect(sent[0]!.timeoutMs).toBe(1_800_000);
    expect(JSON.parse(Buffer.from((sent[0] as { bodyBase64: string }).bodyBase64, "base64").toString()).timeoutMs).toBe(1_800_000);
    link.result(exited(sent[0]!));
    expect((await ran).exitCode).toBe(0);
    // Publishing and removal act on a sandbox that exists: they carry none.
    void sb.stage({ repo: { owner: "acme", name: "widgets" }, base: "main", branch: "scout/x" }).catch(() => {});
    expect("resources" in sent[4]!).toBe(false);

    const plain = hubWith();
    const old = wsRunner(plain, "r1"); // an older sandboxd: no features
    void plain.sandbox("s1").exec("make");
    expect("resources" in old.sent[0]!).toBe(false);
    expect(old.sent[0]!.timeoutMs).toBe(EXEC_TIMEOUT_MS);
  });

  test("a refusal comes back whole, with its code, and reaches the model as a tool error, not a failed turn", async () => {
    const hub = hubWith();
    const { sent, link } = wsRunner(hub, "r1", ["resources"]);
    const sb = hub.sandbox("s1", { resources: ASK });
    const ran = sb.exec("make");
    link.result(refusedBy(sent[0]!));
    const err = await ran.catch((e) => e);
    expect(err).toBeInstanceOf(SandboxRefusal);
    expect(err).toMatchObject({ code: "resource_over_maximum", status: 422, reason: OVER });
    expect(err.message).toBe(`the sandbox host refused this call (resource_over_maximum): ${OVER}`);
    // A file read and a background job: the same reason; a job's as a 4xx (nothing started).
    const read = sb.readBytes("/w/chart.png");
    link.result(refusedBy(sent[1]!));
    await expect(read).rejects.toThrow(OVER);
    const started = sb.jobs!.start({ id: "b1", command: "make bench", cwd: "/w" });
    link.result(refusedBy(sent[2]!));
    const jobErr = await started.catch((e) => e);
    expect(jobErr).toBeInstanceOf(JobCallError);
    expect(jobErr).toMatchObject({ status: 422 });
    expect(jobErr.message).toContain(OVER);

    // workspace_exec: { error } with the whole sentence (over 200 characters, uncut).
    const [exec] = workspaceTools(() => sb);
    const result = exec!.run({ command: "make" }, { sessionId: "s1" } as never) as Promise<{ error: string }>;
    await new Promise((r) => setTimeout(r, 0)); // the tool's job goes out after its own awaits
    link.result(refusedBy(sent[3]!));
    expect(await result).toEqual({ error: `the sandbox host refused this call (resource_over_maximum): ${OVER}` });
  });

  test("a runner whose sandboxd would ignore the request is never sent it", async () => {
    const hub = hubWith();
    const old = wsRunner(hub, "old-box", undefined, "0.0.9");
    const sb = hub.sandbox("s1", { resources: ASK });
    const err = await sb.exec("make").catch((e) => e);
    expect(err).toBeInstanceOf(ResourcesUnsupported);
    expect(err.message).toBe('every connected sandbox runner: old-box (version 0.0.9) can\'t honor this profile\'s sandbox resources: none lists "resources" among its features, and each would run the sandbox with its defaults. Nothing was run there. Update sandboxd on that host (sandbox/host), or remove sandboxResources from the profile to run with the host\'s defaults');
    expect(old.sent).toEqual([]);
    // Nothing was placed: once a runner that honors it connects, the sandbox goes there.
    const able = wsRunner(hub, "new-box", ["resources"]);
    void sb.exec("make");
    expect(able.sent).toHaveLength(1);
    expect(old.sent).toEqual([]);

    // A sandbox that already lives on the old runner can't move: refused, naming it.
    const pinned = hubWith();
    const box = wsRunner(pinned, "old-box", undefined, "0.0.9");
    void pinned.sandbox("s2").exec("true"); // placed there by a job that asked for nothing
    const stuck = await pinned.sandbox("s2", { resources: ASK }).exec("make").catch((e) => e);
    expect(stuck).toBeInstanceOf(ResourcesUnsupported);
    expect(stuck.message).toContain('sandbox runner old-box can\'t honor this profile\'s sandbox resources: its sandboxd (version 0.0.9) doesn\'t list "resources"');
    expect(box.sent).toHaveLength(1);
    // The model sees it as a tool error too.
    const [exec] = workspaceTools(() => pinned.sandbox("s2", { resources: ASK }));
    expect(((await exec!.run({ command: "make" }, { sessionId: "s2" } as never)) as { error: string }).error).toContain("Nothing was run there");
  });

  test("a runner's features and a result's code survive the routes' parsing; a malformed list reads as none", async () => {
    const hubQuick = new RunnerHub(openKnowledge(":memory:"), { pollWaitMs: 5 });
    const quick = runnerRoutes(hubQuick, "tok");
    const poll = (body: unknown) => quick.handle(new Request("http://x/runners/poll", { method: "POST", headers: { authorization: "Bearer tok", "x-lorehouse-runner": "p1" }, body: JSON.stringify(body) }));
    await poll({ capacity: 4, running: 0, version: "0.1.0", features: "resources" }); // not a list
    expect(await hubQuick.sandbox("s1", { resources: ASK }).exec("make").catch((e) => e)).toBeInstanceOf(ResourcesUnsupported);
    await poll({ capacity: 4, running: 0, version: "0.1.0", features: ["resources"] });
    const ran = hubQuick.sandbox("s1", { resources: ASK }).exec("make");
    const { jobs } = (await (await poll({ capacity: 4, running: 0, version: "0.1.0", features: ["resources"] }))!.json()) as { jobs: Job[] };
    expect(jobs[0]).toMatchObject({ resources: { vcpus: 4, memMib: 8192, commandTimeoutSecs: 1800 } });
    const res = await quick.handle(new Request("http://x/runners/results", { method: "POST", headers: { authorization: "Bearer tok", "x-lorehouse-runner": "p1" }, body: JSON.stringify({ results: [refusedBy(jobs[0]!)] }) }));
    expect(res!.status).toBe(204);
    expect(await ran.catch((e) => e)).toMatchObject({ code: "resource_over_maximum", reason: OVER });
  });
});

describe("commandTimeoutSecs bounds every command the tools run, not only workspace_exec", () => {
  const TIMED_OUT = { exitCode: 124, stdout: "", stderr: "Cloning into '/workspace/repo'...\n[guestd] command timed out" };
  const NOTE = "\n[lorehouse] stopped at this sandbox's command timeout, 120 s (the profile's sandboxResources.commandTimeoutSecs): it bounds every command run in the sandbox, a clone or a fetch included. A command that needs longer can run as a background job (workspace_job_start)";
  const bodyOf = (job: Job) => JSON.parse(Buffer.from((job as { bodyBase64: string }).bodyBase64, "base64").toString()) as { timeoutMs: number };
  const reply = (job: Job, result: unknown): JobResult => ({ id: job.id, status: 200, bodyBase64: b64(JSON.stringify(result)) });

  test("through a runner: a tool's own longer timeout is cut to it, so the app never waits past what the host allows, and a stop there says which limit it was", async () => {
    const hub = hubWith();
    const { sent, link } = wsRunner(hub, "r1", ["resources"]);
    const sb = hub.sandbox("s1", { resources: { commandTimeoutSecs: 120 } });
    // workspace_clone's clone asks for 10 minutes: sent, and waited for, as 120 s.
    const clone = sb.exec("git clone https://github.com/acme/big /workspace/repo", { cwd: "/", timeoutMs: 10 * 60_000 });
    expect([sent[0]!.timeoutMs, bodyOf(sent[0]!).timeoutMs]).toEqual([120_000, 120_000]);
    link.result(reply(sent[0]!, TIMED_OUT));
    expect(await clone).toEqual({ ...TIMED_OUT, stderr: TIMED_OUT.stderr + NOTE });
    // A shorter one of its own stays, and a stop at it is the command's own, unremarked.
    const quick = sb.exec("git config user.name x", { timeoutMs: 30_000 });
    expect([sent[1]!.timeoutMs, bodyOf(sent[1]!).timeoutMs]).toEqual([30_000, 30_000]);
    link.result(reply(sent[1]!, TIMED_OUT));
    expect(await quick).toEqual(TIMED_OUT);
    // Any other exit at the limit is not a timeout.
    const failed = sb.exec("make");
    link.result(reply(sent[2]!, { exitCode: 2, stdout: "", stderr: "make: *** [all] Error 2" }));
    expect((await failed).stderr).toBe("make: *** [all] Error 2");

    // Asking for more than a tool's own limit doesn't lengthen the tool's: a clone keeps
    // its 10 minutes under a 30-minute command timeout; a command with none gets the 30.
    const long = hub.sandbox("s2", { resources: { commandTimeoutSecs: 1800 } });
    void long.exec("git clone …", { timeoutMs: 10 * 60_000 });
    void long.exec("make test");
    expect([sent[3]!.timeoutMs, sent[4]!.timeoutMs]).toEqual([600_000, 1_800_000]);
    // With no request, every timeout is what it was.
    void hub.sandbox("s3").exec("git fetch", { timeoutMs: 5 * 60_000 });
    void hub.sandbox("s3").exec("make");
    expect([sent[5]!.timeoutMs, sent[6]!.timeoutMs]).toEqual([300_000, EXEC_TIMEOUT_MS]);
  });

  test("called directly: the same cut, and the same sentence", async () => {
    const bodies: { timeoutMs: number }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/capabilities")) return Response.json({ features: ["resources"] });
      bodies.push(JSON.parse(init.body as string));
      return Response.json(TIMED_OUT);
    }) as typeof fetch;
    const sb = remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: f, resources: { commandTimeoutSecs: 120 } });
    expect(await sb.exec("git clone …", { timeoutMs: 10 * 60_000 })).toEqual({ ...TIMED_OUT, stderr: TIMED_OUT.stderr + NOTE });
    expect(await sb.exec("git config …", { timeoutMs: 30_000 })).toEqual(TIMED_OUT);
    expect(await sb.exec("make")).toEqual({ ...TIMED_OUT, stderr: TIMED_OUT.stderr + NOTE });
    expect(bodies.map((b) => b.timeoutMs)).toEqual([120_000, 30_000, 120_000]);
    const plain = remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: f });
    expect(await plain.exec("git clone …", { timeoutMs: 10 * 60_000 })).toEqual(TIMED_OUT);
    expect(bodies[3]!.timeoutMs).toBe(600_000);
  });
});

describe("the request over the direct API", () => {
  type Seen = { url: string; method: string; asked: string | null; body?: string };
  // A sandboxd: answers /v1/capabilities as given, and every other call with `answer`.
  function daemon(capabilities: () => Response, answer: (url: string) => Response = () => Response.json({ exitCode: 0, stdout: "", stderr: "" })) {
    const seen: Seen[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method ?? "GET", asked: new Headers(init.headers).get("x-lorehouse-sandbox-resources"), body: init.body as string | undefined });
      return url.endsWith("/v1/capabilities") ? capabilities() : answer(url);
    }) as typeof fetch;
    return { f, seen };
  }
  const able = () => Response.json({ version: "0.1.0", features: ["resources"], resources: {} });

  test("the daemon is asked once whether it honors requests, then every call that can create the sandbox carries one", async () => {
    const { f, seen } = daemon(able, (url) => (url.includes("/file") ? new Response("content") : Response.json({ exitCode: 0, stdout: "", stderr: "" })));
    const sb = remoteSandbox("s1", { url: "https://fb.example/", token: "tok", fetch: f, resources: ASK });
    await sb.exec("make");
    await sb.readFile("/w/a");
    await sb.writeFile("/w/b", "x");
    await sb.readBytes("/w/a");
    expect(seen.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["GET /v1/capabilities", "POST /v1/sandboxes/s1/exec", "GET /v1/sandboxes/s1/file", "PUT /v1/sandboxes/s1/file", "GET /v1/sandboxes/s1/file"]);
    for (const call of seen.slice(1)) expect(call.asked).toBe('{"vcpus":4,"memMib":8192,"commandTimeoutSecs":1800}');
    expect(JSON.parse(seen[1]!.body!).timeoutMs).toBe(1_800_000);
    // Another sandbox on the same daemon doesn't ask again.
    await remoteSandbox("s2", { url: "https://fb.example", token: "tok", fetch: f, resources: ASK }).exec("true");
    expect(seen.filter((s) => s.url.endsWith("/v1/capabilities"))).toHaveLength(1);

    // With no request: no question, no header, the timeout as it was.
    const plain = daemon(able);
    await remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: plain.f }).exec("make");
    expect(plain.seen.map((s) => [new URL(s.url).pathname, s.asked])).toEqual([["/v1/sandboxes/s1/exec", null]]);
    expect(JSON.parse(plain.seen[0]!.body!).timeoutMs).toBe(EXEC_TIMEOUT_MS);
  });

  test("a daemon that predates requests is never sent one, and is asked again next time", async () => {
    let updated = false;
    const { f, seen } = daemon(() => (updated ? able() : new Response("not found", { status: 404 })));
    const sb = remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: f, resources: ASK });
    const err = await sb.exec("make").catch((e) => e);
    expect(err).toBeInstanceOf(ResourcesUnsupported);
    expect(err.message).toContain("the sandbox host at https://fb.example can't honor this profile's sandbox resources: its sandboxd predates resource requests (no GET /v1/capabilities)");
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual(["/v1/capabilities"]);
    // One that answers without the feature, or not at all: nothing is run either.
    const silent = daemon(() => Response.json({ version: "0.1.0", features: [] }));
    await expect(remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: silent.f, resources: ASK }).writeFile("/w/a", "x")).rejects.toBeInstanceOf(ResourcesUnsupported);
    const down = daemon(() => new Response("bad gateway", { status: 502 }));
    await expect(remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: down.f, resources: ASK }).exec("make")).rejects.toThrow(/didn't say whether it honors sandbox resources \(GET \/v1\/capabilities: 502 bad gateway\), so nothing was run there/);
    expect(silent.seen.concat(down.seen).every((s) => s.url.endsWith("/v1/capabilities"))).toBe(true);
    // Updated since: the next call asks again and goes through.
    updated = true;
    expect((await sb.exec("make")).exitCode).toBe(0);
  });

  test("a refusal is thrown whole, with its code, from an exec, a file call and a job", async () => {
    const refuse = () => Response.json({ error: OVER, code: "resource_over_maximum", field: "memMib", asked: 8192, maximum: 4096 }, { status: 422 });
    const { f } = daemon(able, refuse);
    const sb = remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: f, resources: ASK });
    for (const call of [() => sb.exec("make"), () => sb.readFile("/w/a"), () => sb.writeFile("/w/a", "x"), () => sb.readBytes("/w/a")]) {
      const err = await call().catch((e) => e);
      expect(err).toBeInstanceOf(SandboxRefusal);
      expect(err).toMatchObject({ code: "resource_over_maximum", status: 422, reason: OVER });
    }
    const jobErr = await sb.jobs!.start({ id: "b1", command: "make bench", cwd: "/w" }).catch((e) => e);
    expect(jobErr).toBeInstanceOf(JobCallError);
    expect(jobErr).toMatchObject({ status: 422 });
    expect(jobErr.message).toBe(`job start: the sandbox host refused this call (resource_over_maximum): ${OVER}`);
    const [exec] = workspaceTools(() => sb);
    expect(await exec!.run({ command: "make" }, { sessionId: "s1" } as never)).toEqual({ error: `the sandbox host refused this call (resource_over_maximum): ${OVER}` });
    // A mismatch with the sandbox that exists reads the same way.
    const mismatch = daemon(able, () => Response.json({ error: "sandbox s1 already exists with vcpus 2, …", code: "resources_mismatch", field: "vcpus", asked: 4, has: 2 }, { status: 409 }));
    await expect(remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: mismatch.f, resources: ASK }).exec("make")).rejects.toMatchObject({ code: "resources_mismatch", status: 409 });
  });
});
