// The eval harness around the proxy: checks over an Observation, the verdict arithmetic,
// the command line and its exit codes, and --dry runs of real cases through the real
// subprocess plumbing (the app, the mock, the fake runner, the proxy).

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listing, parseArgs, selectCases, UsageError } from "../evals/args";
import type { Case, Observation } from "../evals/case";
import { CASES } from "../evals/cases";
import { called, card, check, github, graded, modelNeverWrote, neverSaid, ran, said, toldAlone, uploaded } from "../evals/checks";
import { caseResult, COMPLETED, judge, summarize, trialPassed, type CheckOutcome, type Summary, type TrialResult } from "../evals/report";
import { listeningPort, saidFrom, tail } from "../evals/trial";

const ROOT = join(import.meta.dir, "..");

// A pull request conversation, as a trial would observe it: a mention that ends on a
// card, a guest's click (refused), a member's click (pushed and opened).
function observed(): Observation {
  const calls = [
    { method: "chat.startStream", body: { channel: "C1", thread_ts: "1.0", __stream_ts: "9.1" } },
    { method: "chat.appendStream", body: { ts: "9.1", markdown_text: "Committed on " } },
    { method: "chat.stopStream", body: { ts: "9.1", chunks: [{ type: "markdown_text", text: "scout/x." }, { type: "task_update", title: "ignored" }] } },
    { method: "chat.postMessage", body: { channel: "C1", thread_ts: "1.0", text: "Open a pull request?", __ts: "9.2", blocks: [{ type: "section", text: { text: "*Open a pull request?*" } }, { type: "actions", elements: [{ type: "button", text: { text: "Approve" }, action_id: "a", value: "v" }] }] } },
    { method: "response_url", body: { __path: "/slack/response/UG1-1", text: "Only full members can approve.", response_type: "ephemeral" } },
    { method: "chat.update", body: { channel: "C1", ts: "9.2", text: "Opened https://github.com/acme/widgets/pull/7" } },
  ].map((c, n) => ({ n, ...c }));
  return {
    channel: "C1",
    thread: "1.0",
    steps: [
      { n: 0, step: "mention by U1", slack: 0, jobs: 0, github: 0, turns: 0, outcome: "done" },
      { n: 1, as: "guest", step: "click Approve by UG1", slack: 4, jobs: 2, github: 1, turns: 2, outcome: "done" },
      { n: 2, as: "member", step: "click Approve by U2", slack: 5, jobs: 2, github: 1, turns: 2, outcome: "done" },
    ],
    slack: { calls, said: saidFrom(calls), uploads: [{ fileId: "F1", filename: "bench.png", length: 70, bytes: 70, contentType: "image/png", head: "\u0089PNG\r", channel: "C1", thread_ts: "1.0" }], reactions: [] },
    runner: {
      connected: true,
      jobs: [
        { n: 0, sandbox: "t.s", op: "guest", method: "POST", path: "/exec", command: "git -c x clone --branch main https://github.com/acme/widgets.git /workspace/repo", answer: { status: 200, exitCode: 0, stdout: "" } },
        { n: 1, sandbox: "t.s", op: "stage", answer: { status: 200 } },
        { n: 2, sandbox: "t.s", op: "push", answer: { status: 200 } },
      ],
    },
    github: { calls: [{ n: 0, method: "GET", path: "/user", auth: "token" }, { n: 1, method: "POST", path: "/repos/acme/widgets/pulls", body: { title: "x", draft: true }, auth: "token" }] },
    model: {
      turns: [
        { n: 1, startedAt: "", request: { stream: true, tools: [], messages: 1, input: [] }, status: 200, response: { stopReason: "tool_use", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "workspace_clone", input: {} }] } },
        { n: 2, startedAt: "", request: { stream: true, tools: [], messages: 3, input: [] }, status: 200, response: { stopReason: "tool_use", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "tool_use", id: "t2", name: "open_pull_request", input: { branch: "scout/x", title: "x" } }] } },
        { n: 3, startedAt: "", request: { stream: true, tools: [], messages: 5, input: [] }, status: 200, response: { stopReason: "end_turn", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text: "Opened it, thanks <@U2>." }] } },
      ],
      toolCalls: [{ turn: 1, name: "workspace_clone", input: {} }, { turn: 2, name: "open_pull_request", input: { branch: "scout/x", title: "x" } }],
    },
    app: { exit: 0, stderr: "", stdout: "" },
  };
}
const run = (c: ReturnType<typeof ran>, o = observed()) => {
  if (c.graded) throw new Error("a graded check");
  return c.run(o);
};

test("saidFrom: a stream's text is its markdown, a card's its sections, an update and an ephemeral their text", () => {
  const s = observed().slack.said;
  expect(s.map((x) => [x.via, x.text, x.call])).toEqual([
    ["stream", "Committed on scout/x.", 2],
    ["post", "Open a pull request?\n*Open a pull request?*", 3],
    ["ephemeral", "Only full members can approve.", 4],
    ["update", "Opened https://github.com/acme/widgets/pull/7", 5],
  ]);
  expect(s[0]).toMatchObject({ thread: "1.0", ts: "9.1" });
  expect(s[0]!.open).toBeUndefined();
  expect(saidFrom([{ n: 0, method: "chat.startStream", body: { thread_ts: "1.0", __stream_ts: "9.9" } }])[0]!.open).toBe(true);
});

test("checks: each passes on what was observed, with evidence that points at the record", () => {
  const passing = [
    ran("clone", { command: / clone .*acme\/widgets\.git/ }),
    ran("one push", { op: "push" }, { min: 1, max: 1 }),
    ran("no push before the member", { op: "push" }, { max: 0, before: "guest" }),
    ran("the push is after the member's click", { op: "push" }, { min: 1, after: "member" }),
    called("asks for a PR", "open_pull_request", { input: (i) => String(i.branch).startsWith("scout/") }),
    called("no job", "workspace_job_start", { max: 0 }),
    said("links it", /pull\/7/, { after: "member" }),
    neverSaid("no mention posted", /<@U/),
    github("a draft", { method: "POST", path: /\/pulls$/, body: (b) => b.draft === true }, { min: 1, max: 1 }),
    github("none before the guest… of the POSTs", { method: "POST", path: /\/pulls$/ }, { max: 0, before: 0 }),
    uploaded("a png", { filename: /\.png$/, contentType: /^image\/png$/, head: /PNG/ }),
    card("a card", "Approve", { before: "guest" }),
    toldAlone("the guest is told", "UG1", { matching: /full members/ }),
    check("custom", (o) => ({ pass: o.app.exit === 0, evidence: "exit 0" })),
  ];
  for (const c of passing) expect([c.name, run(c).pass]).toEqual([c.name, true]);
  expect(run(passing[0]!).evidence).toContain("job #0");
  expect(run(passing[4]!).evidence).toContain("turn 2 open_pull_request");
  expect(run(passing[6]!).evidence).toContain("slack call #5");
});

test("checks: each fails when it should, saying what there was instead", () => {
  const failing: [ReturnType<typeof ran>, string][] = [
    [ran("gadgets", { command: /acme\/gadgets/ }), "The runner was sent: job #0 guest POST /exec"],
    [ran("no push at all", { op: "push" }, { max: 0 }), "1 runner job(s) matching push, want exactly 0. Found: job #2 push"],
    [ran("pushed before the member", { op: "push" }, { min: 1, before: "member" }), "before step \"member\""],
    [called("a job", "workspace_job_start"), "The model called: turn 1 workspace_clone {}"],
    [called("a clone naming a repo", "workspace_clone", { input: (i) => typeof i.repo === "string" }), "0 call(s) of workspace_clone with the wanted input"],
    [said("links it before the click", /pull\/7/, { before: "member" }), "matches nothing the agent said before step \"member\""],
    [neverSaid("never says pull", /pull request/i), "post (slack call #3)"],
    [modelNeverWrote("the model mentions nobody", /<@U[A-Z0-9]+>/), "the model's text in turn 3"],
    [github("two PRs", { method: "POST", path: /\/pulls$/ }, { min: 2 }), "want at least 2"],
    [uploaded("a pdf", { filename: /\.pdf$/ }), "bench.png"],
    [card("a Deny-only card", "Deny"), "0 card(s) with a Deny button"],
    [toldAlone("the member is told", "U2"), "/slack/response/UG1-1"],
    [ran("a step that isn't there", { op: "push" }, { before: "nope" }), "no step \"nope\" in this conversation"],
  ];
  for (const [c, evidence] of failing) {
    const r = run(c);
    expect([c.name, r.pass]).toEqual([c.name, false]);
    expect(r.evidence).toContain(evidence);
  }
  // Silence never passes a "never said".
  const silent = observed();
  silent.slack.said = [];
  expect(run(neverSaid("x", /y/), silent)).toMatchObject({ pass: false });
});

test("checks: a step that never began bounds nothing after it and everything before it", () => {
  const o = observed();
  o.steps[2] = { ...o.steps[2]!, outcome: "skipped", slack: 0, jobs: 0, github: 0, turns: 0 };
  expect(run(ran("after a step that never ran", { op: "push" }, { min: 1, after: "member" }), o).pass).toBe(false);
  expect(run(ran("before a step that never ran", { op: "push" }, { max: 0, before: "member" }), o).pass).toBe(false);
});

const aCase = (over: Partial<Case> = {}): Case => ({
  id: "x", suite: "code", why: "w", dry: "passes", conversation: [],
  checks: [ran("pushes once", { op: "push" }, { min: 1, max: 1 }), called("starts a job", "workspace_job_start"), said("optional", /nope/, { required: false }), graded("reads well", "Is clear.")],
  ...over,
});

test("judge: code checks, graded checks apart, and what --dry judges", async () => {
  const names = (cs: CheckOutcome[]) => cs.map((c) => [c.name, c.judged, c.pass]);
  const real = await judge(aCase(), observed(), { dry: false, grade: async (rubric, subject) => ({ pass: subject.includes("pull/7") && rubric === "Is clear.", evidence: "grader: fine" }) });
  expect(names(real)).toEqual([[COMPLETED, true, true], ["pushes once", true, true], ["starts a job", true, false], ["optional", true, false], ["reads well", true, true]]);
  expect(trialPassed(real)).toBe(false); // a required code check failed
  expect(trialPassed(real.filter((c) => c.name !== "starts a job"))).toBe(true); // an optional one, or a graded one, never fails it

  // --dry, a case that "passes": code checks judged, the graded one skipped.
  const dry = await judge(aCase(), observed(), { dry: true });
  expect(names(dry).at(-1)).toEqual(["reads well", false, false]);
  expect(trialPassed(dry)).toBe(false);
  // --dry, a case that only "runs": checks are recorded but only completion is judged.
  const runs = await judge(aCase({ dry: "runs" }), observed(), { dry: true });
  expect(runs.filter((c) => c.judged).map((c) => c.name)).toEqual([COMPLETED]);
  expect(trialPassed(runs)).toBe(true);

  // A step that failed, or a setup that did, fails the trial with what it waited for.
  const stuck = observed();
  stuck.steps[1] = { ...stuck.steps[1]!, outcome: "failed", detail: "no ephemeral reply to UG1 within 20000 ms" };
  const failed = await judge(aCase({ dry: "runs" }), stuck, { dry: true });
  expect(failed[0]).toMatchObject({ pass: false, evidence: "step 1 (click Approve by UG1): no ephemeral reply to UG1 within 20000 ms" });
  expect(trialPassed(failed)).toBe(false);
  expect((await judge(aCase(), observed(), { dry: false, setupError: "the app never answered /healthz" }))[0]!.evidence).toBe("setup failed: the app never answered /healthz");
  // A check that throws is a failed check, not a crashed run.
  const thrown = await judge(aCase({ checks: [check("boom", () => { throw new Error("bad regex"); })] }), observed(), { dry: false });
  expect(thrown[1]).toMatchObject({ pass: false, evidence: "the check itself threw: bad regex" });
});

const outcome = (name: string, pass: boolean, o: Partial<CheckOutcome> = {}): CheckOutcome => ({ name, required: true, graded: false, judged: true, pass, evidence: pass ? "ok" : `${name} failed`, ...o });
const trial = (n: number, checks: CheckOutcome[], tokens = 100): TrialResult => ({ case: "code/x", trial: n, checks, passed: trialPassed(checks), tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1, file: `out/x/${n}.json` });

test("pass rates: per case over trials, per check over judged trials, graded apart, against the threshold", () => {
  const trials = [
    trial(1, [outcome("a", true), outcome("b", true), outcome("g", true, { graded: true, required: false })]),
    trial(2, [outcome("a", true), outcome("b", false), outcome("g", false, { graded: true, required: false })]),
    trial(3, [outcome("a", true), outcome("b", true), outcome("g", false, { graded: true, required: false, judged: false })]),
  ];
  const strict = caseResult(aCase(), trials, 1);
  expect(strict).toMatchObject({ case: "code/x", trials: 3, passed: 2, ok: false, graded: { passed: 1, of: 2 } });
  expect(strict.rate).toBeCloseTo(2 / 3);
  expect(strict.checks).toEqual([
    { name: "a", required: true, graded: false, passed: 3, of: 3 },
    { name: "b", required: true, graded: false, passed: 2, of: 3 },
    { name: "g", required: false, graded: true, passed: 1, of: 2 },
  ]);
  expect(strict.tokens.input).toBe(300);
  expect(caseResult(aCase(), trials, 0.66).ok).toBe(true);
  expect(caseResult(aCase(), trials, 0.67).ok).toBe(false);
  // A graded failure alone never fails a trial or a case.
  expect(caseResult(aCase(), [trials[0]!, trial(2, [outcome("a", true), outcome("g", false, { graded: true, required: false })])], 1).ok).toBe(true);
  // No trials at all (the budget stopped the run first) is not a pass.
  expect(caseResult(aCase(), [], 1)).toMatchObject({ trials: 0, ok: false });
});

test("summarize: the JSON line's counts, failures with their files, tokens, and the budget stop", () => {
  const trials = [trial(1, [outcome("a", true)]), trial(2, [outcome("a", false), outcome("opt", false, { required: false }), outcome("g", false, { graded: true, required: false })])];
  const results = [caseResult(aCase(), trials, 1), caseResult(aCase({ id: "y" }), [], 1)];
  const base = { results, trials, planned: 4, model: "claude-opus-5", dry: false, credential: "ant" as const, threshold: 1, tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 }, graderTokens: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 }, graderModel: "claude-haiku-5-5", maxTokens: 5000, ms: 9, out: "evals/out/r" };
  const s = summarize({ ...base, exceeded: false, usd: { in: 5, out: 25 } });
  expect(s).toMatchObject({ ok: false, model: "claude-opus-5", dry: false, credential: "ant", cases: 2, passed: 0, failed: 2, trials: 2, planned: 4, threshold: 1, out: "evals/out/r" });
  // Only required code checks that were judged are failures.
  expect(s.failures).toEqual([{ case: "code/x", check: "a", trial: 2, evidence: "a failed", file: "out/x/2.json" }]);
  expect(s.tokens).toMatchObject({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, total: 1260, max: 5000, exceeded: false, grader: { total: 35 }, perCase: { "code/x": 200, "code/y": 0 } });
  // (1000 + 50 + 10) input-side tokens at $5/M, 200 output at $25/M.
  expect(s.tokens.usdEstimate).toBe(0.0103);
  expect(s.graded).toEqual({ model: "claude-haiku-5-5", passed: 0, of: 1 });
  expect(s.stopped).toBeUndefined();
  const stopped = summarize({ ...base, exceeded: true });
  expect(stopped.ok).toBe(false);
  expect(stopped.stopped).toContain("--max-tokens 5000");
  expect(stopped.stopped).toContain("2 planned trial(s) never ran");
  expect(stopped.tokens.usdEstimate).toBeUndefined();
  // Everything passing, and nothing stopped it: ok.
  expect(summarize({ ...base, results: [caseResult(aCase(), [trials[0]!], 1)], trials: [trials[0]!], exceeded: false }).ok).toBe(true);
});

test("the command line: defaults, --dry's one trial, and what is refused", () => {
  expect(parseArgs([])).toEqual({ dry: false, list: false, only: undefined, trials: 3, model: undefined, concurrency: 2, maxTokens: 5_000_000, threshold: 1, graderModel: undefined, out: undefined });
  expect(parseArgs(["--dry"]).trials).toBe(1);
  expect(parseArgs(["--dry", "--trials", "4", "--only", "/^code/", "--model", "claude-sonnet-5-5", "--concurrency", "3", "--max-tokens", "9000", "--threshold", "0.67", "--grader-model", "g", "--out", "/tmp/o"]))
    .toEqual({ dry: true, list: false, only: "/^code/", trials: 4, model: "claude-sonnet-5-5", concurrency: 3, maxTokens: 9000, threshold: 0.67, graderModel: "g", out: "/tmp/o" });
  for (const bad of [["--nope"], ["--trials"], ["--trials", "0"], ["--trials", "1.5"], ["--threshold", "2"], ["--threshold", "x"], ["--max-tokens", "-1"], ["--only", "--dry"], ["--model", "a", "--model", "b"], ["--concurrency", "0"]]) {
    expect(() => parseArgs(bad)).toThrow(UsageError);
  }
});

test("--only picks cases by suite/id, and a pattern matching nothing is a usage error", () => {
  expect(selectCases(CASES).length).toBe(CASES.length);
  expect(selectCases(CASES, "knowledge/").every((c) => c.suite === "knowledge")).toBe(true);
  expect(selectCases(CASES, "knowledge/").length).toBe(4);
  expect(selectCases(CASES, "/^code\\/.*repo/").map((c) => c.id)).toEqual(["default-repo", "named-repo-wins"]);
  expect(selectCases(CASES, "DEFAULT-REPO").map((c) => c.id)).toEqual(["default-repo"]);
  expect(() => selectCases(CASES, "no-such-case")).toThrow(UsageError);
  expect(() => selectCases(CASES, "/(/")).toThrow(UsageError);
  expect(() => selectCases([CASES[0]!, CASES[0]!])).toThrow("two cases are named code/default-repo");
});

test("the shipped cases: both suites, unique ids, a promise each, and code checks that decide", () => {
  expect(CASES.filter((c) => c.suite === "code").length).toBeGreaterThanOrEqual(7);
  expect(CASES.filter((c) => c.suite === "knowledge").length).toBe(4);
  for (const c of CASES) {
    expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(c.why.length).toBeGreaterThan(20);
    expect(c.conversation.length).toBeGreaterThan(0);
    expect(c.checks.filter((k) => !k.graded && k.required).length).toBeGreaterThan(0);
    // A graded check is never required: it can't decide a verdict.
    expect(c.checks.filter((k) => k.graded && k.required)).toEqual([]);
  }
  const text = listing(CASES);
  expect(text).toContain("code/pull-request-needs-approval  (dry: passes)");
  expect(text).toContain("[graded]");
});

// ── starting children ───────────────────────────────────────────────────────

const child = (script: string, env: Record<string, string> = {}) => {
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe" });
  return { proc, out: tail(proc.stdout as ReadableStream<Uint8Array>), err: tail(proc.stderr as ReadableStream<Uint8Array>) };
};

test("a child's port is the one it reports; one that exits while starting fails the start at once, with its stderr", async () => {
  const ok = child('console.log("noise"); setTimeout(() => console.log("mock listening on :4321 (x)"), 50); setTimeout(() => {}, 2000)');
  expect(await listeningPort(ok.proc, ok.out, ok.err, /mock listening on :(\d+)/, "the mock", 5000)).toBe(4321);
  ok.proc.kill();

  const dead = child('console.error("error: Failed to start server. Is port 9 in use? EADDRINUSE"); process.exit(1)');
  const t0 = Date.now();
  const failed = await listeningPort(dead.proc, dead.out, dead.err, /mock listening on :(\d+)/, "the mock", 15_000).catch((e: Error) => e.message);
  expect(failed).toContain("the mock exited (1) while starting");
  expect(failed).toContain("EADDRINUSE");
  expect(Date.now() - t0).toBeLessThan(3000);

  const silent = child("setTimeout(() => {}, 3000)");
  expect(await listeningPort(silent.proc, silent.out, silent.err, /on :(\d+)/, "the app", 300).catch((e: Error) => e.message)).toContain("didn't say which port it listens on within 300 ms");
  silent.proc.kill();
});

test("the mock binds port 0 itself and says which port it got: two started together never collide", async () => {
  const start = () => {
    const proc = Bun.spawn([process.execPath, join(ROOT, "conformance/mock.ts")], { env: { PATH: process.env.PATH, PORT: "0" }, stdout: "pipe", stderr: "pipe" });
    return { proc, out: tail(proc.stdout as ReadableStream<Uint8Array>), err: tail(proc.stderr as ReadableStream<Uint8Array>) };
  };
  const mocks = Array.from({ length: 4 }, start);
  try {
    const ports = await Promise.all(mocks.map((m) => listeningPort(m.proc, m.out, m.err, /mock listening on :(\d+)/, "the mock", 15_000)));
    expect(new Set(ports).size).toBe(4);
    for (const port of ports) expect((await fetch(`http://localhost:${port}/stats`)).ok).toBe(true);
    // An upload URL the mock hands out names the port it really listens on.
    const reserved = (await (await fetch(`http://localhost:${ports[0]}/slack/api/files.getUploadURLExternal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ filename: "a.png", length: 1 }) })).json()) as { upload_url: string };
    expect(reserved.upload_url).toStartWith(`http://localhost:${ports[0]}/slack/upload/`);
  } finally {
    for (const m of mocks) m.proc.kill();
  }
});

// ── the command itself ──────────────────────────────────────────────────────

async function evalCommand(args: string[], env: Record<string, string | undefined> = { ...process.env }) {
  const proc = Bun.spawn([process.execPath, join(ROOT, "evals/run.ts"), ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("--list prints the cases and exits 0; a bad argument or an --only that matches nothing exits 2 before anything starts", async () => {
  const list = await evalCommand(["--list", "--only", "knowledge/"]);
  expect(list.code).toBe(0);
  expect(list.stdout).toContain("knowledge/cites-a-source");
  expect(list.stdout).not.toContain("code/");
  const flag = await evalCommand(["--nope"]);
  expect(flag.code).toBe(2);
  expect(flag.stderr).toContain('unknown argument "--nope"');
  const only = await evalCommand(["--dry", "--only", "no-such-case"]);
  expect(only.code).toBe(2);
  expect(only.stderr).toContain("matches none of the");
  expect(only.stdout).toBe("");
});

test("with no credential and no --dry, it exits 2 naming the three ways to provide one", async () => {
  // Only bun on the PATH: no `ant` to be logged in with.
  const r = await evalCommand(["--only", "cites-a-source"], { PATH: dirname(process.execPath), HOME: mkdtempSync(join(tmpdir(), "lorehouse-eval-home-")) });
  expect(r.code).toBe(2);
  for (const way of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ant auth login", "--dry"]) expect(r.stderr).toContain(way);
  expect(r.stdout).toBe("");
});

test("--dry runs a case of each suite end to end: a table, one JSON line last, and an evidence file per trial", async () => {
  const out = mkdtempSync(join(tmpdir(), "lorehouse-eval-out-"));
  try {
    const r = await evalCommand(["--dry", "--only", "/pull-request-needs-approval|cites-a-source|says-not-found/", "--out", out]);
    expect(r.stderr).toContain("the scripted model (--dry)");
    // On a failure, what the run said is the message.
    expect({ code: r.code, said: r.code === 0 ? "" : r.stderr + r.stdout }).toEqual({ code: 0, said: "" });
    const lines = r.stdout.trimEnd().split("\n");
    const summary = JSON.parse(lines.at(-1)!) as Summary;
    expect(summary).toMatchObject({ ok: true, dry: true, credential: null, cases: 3, passed: 3, failed: 0, trials: 3, planned: 3, failures: [], graded: { model: null, of: 0 } });
    expect(summary.tokens.total).toBeGreaterThan(0);
    expect(summary.tokens.exceeded).toBe(false);
    expect(r.stdout).toContain("ok  code/pull-request-needs-approval");
    expect(r.stdout).toContain("✓ 1/1  one draft pull request is opened");
    // A case that only "runs" under --dry has its checks recorded, not judged.
    expect(r.stdout).toContain("· not judged  the reply says it found nothing");

    const [runDir] = readdirSync(out);
    expect(summary.out.endsWith(runDir!)).toBe(true);
    expect(existsSync(join(out, runDir!, "summary.json"))).toBe(true);
    const evidence = JSON.parse(readFileSync(join(out, runDir!, "pull-request-needs-approval", "1.json"), "utf8"));
    expect(evidence).toMatchObject({ case: "code/pull-request-needs-approval", trial: 1, passed: true, dry: true });
    expect(evidence.checks.every((c: CheckOutcome) => c.pass)).toBe(true);
    expect(evidence.conversation.map((s: { outcome: string }) => s.outcome)).toEqual(["done", "done", "done"]);
    // The transcript: the scripted model asked for a pull request, then answered.
    expect(evidence.transcript[0].response.content[0]).toMatchObject({ type: "tool_use", name: "open_pull_request", input: { branch: "scout/eval-readme" } });
    expect(evidence.transcript[0].request.system).toContain("company's brain");
    expect(evidence.transcript.at(-1).response.stopReason).toBe("end_turn");
    // The observation: Slack's calls, the runner's jobs decoded, GitHub's requests, the app's exit.
    const o = evidence.observation as Observation;
    expect(o.slack.said.some((s) => s.via === "post" && JSON.stringify(s.blocks).includes("Approve"))).toBe(true);
    expect(o.slack.said.some((s) => s.via === "ephemeral" && s.path === "/slack/response/UG1-1")).toBe(true);
    expect(o.runner.jobs.map((j) => j.op)).toContain("push");
    expect(o.runner.jobs.find((j) => j.op === "push")!.body).toMatchObject({ token: "[redacted]" });
    expect(o.runner.jobs.find((j) => j.command === "git status --porcelain")).toMatchObject({ cwd: "/workspace/repo", answer: { status: 200, exitCode: 0 } });
    expect(o.github.calls.some((c) => c.method === "POST" && c.path === "/repos/acme/widgets/pulls")).toBe(true);
    expect(o.app.exit).toBe(0);
    const knowledge = JSON.parse(readFileSync(join(out, runDir!, "cites-a-source", "1.json"), "utf8"));
    expect(knowledge.observation.runner).toEqual({ connected: false, jobs: [] });
    expect(knowledge.observation.model.toolCalls[0]).toMatchObject({ turn: 1, name: "search_knowledge" });
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);

test("--dry: a run stopped by the budget says so, fails the trial on the refused model call, and exits 1", async () => {
  const out = mkdtempSync(join(tmpdir(), "lorehouse-eval-out-"));
  try {
    // A budget of one token: the first model call is made, every later one is refused.
    const r = await evalCommand(["--dry", "--only", "run-and-show", "--max-tokens", "1", "--out", out]);
    expect(r.code).toBe(1);
    const summary = JSON.parse(r.stdout.trimEnd().split("\n").at(-1)!) as Summary;
    expect(summary).toMatchObject({ ok: false, passed: 0, failed: 1, tokens: { exceeded: true, max: 1 } });
    expect(summary.stopped).toContain("--max-tokens 1");
    const failure = summary.failures.find((f) => f.check === COMPLETED)!;
    expect(failure).toMatchObject({ case: "code/run-and-show", trial: 1 });
    expect(failure.evidence).toContain("model turn 2 failed (HTTP 0): budget");
    expect(existsSync(failure.file)).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
