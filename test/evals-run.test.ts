// The eval harness around the proxy: checks over an Observation, the verdict arithmetic,
// the command line and its exit codes, and --dry runs of real cases through the real
// subprocess plumbing (the app, the mock, the fake runner, the proxy).

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { listing, parseArgs, selectCases, UsageError } from "../evals/args";
import type { Case, Observation } from "../evals/case";
import { CASES } from "../evals/cases";
import { called, card, check, github, graded, modelNeverWrote, neverSaid, ran, said, toldAlone, uploaded } from "../evals/checks";
import type { Grader } from "../evals/grader";
import { caseResult, COMPLETED, judge, summarize, table, trialVerdict, type CheckOutcome, type Summary, type TrialResult } from "../evals/report";
import { RUBRICS } from "../evals/rubrics";
import { APP_ANNOUNCES, childEnv, listeningPort, MOCK_ANNOUNCES, observeJob, saidFrom, scrubObservation, tail, track } from "../evals/trial";
import { envFileProblem } from "../evals/credential";

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
      refused: [],
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

test("a secret cut across two chunks of a stream is in no part of the observation that is written", () => {
  const SECRET = "sk-ant-real-credential-0123456789abcdef";
  const calls = [
    { method: "chat.startStream", body: { channel: "C1", thread_ts: "1.0", __stream_ts: "9.1" } },
    { method: "chat.appendStream", body: { ts: "9.1", markdown_text: "The key is sk-ant-real-cred" } },
    { method: "chat.appendStream", body: { ts: "9.1", chunks: [{ type: "task_update", title: "Searching" }, { type: "markdown_text", text: "ential-0123456789abcdef, keep it safe." }] } },
    { method: "chat.stopStream", body: { ts: "9.1" } },
    { method: "chat.startStream", body: { channel: "C1", thread_ts: "1.0", __stream_ts: "9.2", markdown_text: "Another reply, " } },
    { method: "chat.stopStream", body: { ts: "9.2", markdown_text: "with nothing secret in it." } },
  ].map((c, n) => ({ n, ...c }));
  const o = observed();
  o.slack.calls = calls;
  o.slack.said = saidFrom(calls);
  // The whole secret is in what the stream adds up to, and in no single call.
  expect(o.slack.said[0]!.text).toContain(SECRET);
  expect(calls.some((c) => JSON.stringify(c).includes(SECRET))).toBe(false);
  const written = JSON.stringify(scrubObservation(o, [SECRET]));
  expect(written).not.toContain(SECRET);
  // Nor its halves, which together would spell it.
  expect(written).not.toContain("sk-ant-real-cred");
  expect(written).not.toContain("ential-0123456789abcdef");
  expect(written).toContain("The key is [redacted credential], keep it safe.");
  expect(written).toContain("[redacted: this stream carried a credential across its chunks]");
  // The other stream, and what isn't text, is as it was.
  expect(written).toContain("with nothing secret in it.");
  expect(written).toContain('"title":"Searching"');
  // With nothing to find, the observation is the same object.
  expect(scrubObservation(o, ["not-in-there-at-all"])).toBe(o);
  expect(scrubObservation(o, [])).toBe(o);
});

test("a runner job as evidence: an exec keeps its result, and a background job's status and cancel keep their whole body", () => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
  const answered = (v: unknown, status = 200) => ({ id: "j", status, contentType: "application/json", bodyBase64: b64(v) });
  const exec = observeJob(0, { id: "j", sandbox: "t.s", op: "guest", method: "POST", path: "/exec", bodyBase64: b64({ command: "bun test", cwd: "/workspace/repo", env: { GIT_AUTHOR_NAME: "octo" } }) }, answered({ exitCode: 0, stdout: " 3 pass\n", stderr: "" }));
  expect(exec).toMatchObject({ command: "bun test", cwd: "/workspace/repo", answer: { status: 200, exitCode: 0, stdout: " 3 pass\n", stderr: "" } });
  expect((exec.body as { env: unknown }).env).toEqual(["GIT_AUTHOR_NAME"]);
  // A job that has ended also carries a numeric exitCode: it is not an exec result, and
  // its state, id, tail and elapsed time are what a check of the job reads.
  const ended = { id: "bench-1", command: "make bench", cwd: "/workspace/repo", state: "exited", exitCode: 0, elapsedMs: 1_741_000, tail: "bench total 290 ms (5 benchmarks)\n", outputBytes: 34 };
  const status = observeJob(1, { id: "j", sandbox: "t.s", op: "guest", method: "GET", path: "/jobs/bench-1?tailBytes=8192" }, answered(ended));
  expect(status.answer).toEqual({ status: 200, code: undefined, error: undefined, body: ended });
  const start = observeJob(2, { id: "j", sandbox: "t.s", op: "guest", method: "POST", path: "/jobs", bodyBase64: b64({ id: "bench-1", command: "make bench", cwd: "/workspace/repo" }) }, answered({ ...ended, state: "running", exitCode: null, tail: "", created: true }, 201));
  expect(start).toMatchObject({ command: "make bench", answer: { status: 201, body: { id: "bench-1", state: "running", exitCode: null, created: true } } });
  const cancelled = { ...ended, state: "cancelled", exitCode: 143, tail: "" };
  expect(observeJob(3, { id: "j", sandbox: "t.s", op: "guest", method: "POST", path: "/jobs/bench-1/cancel" }, answered(cancelled)).answer.body).toEqual(cancelled);
  // A stage's facts, as before.
  expect(observeJob(4, { id: "j", sandbox: "t.s", op: "stage", bodyBase64: b64({ base: "main", token: "t" }) }, answered({ sha: "abc", files: ["README.md"] }))).toMatchObject({ body: { base: "main", token: "[redacted]" }, answer: { body: { sha: "abc", files: ["README.md"] } } });
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

test("the pull request case fails when the model changed nothing, or something else", () => {
  const pr = CASES.find((c) => c.id === "pull-request-needs-approval")!;
  const named = (name: string) => {
    const c = pr.checks.find((k) => k.name === name)!;
    if (c.graded) throw new Error("graded");
    return c.run;
  };
  const withStage = (answer: Observation["runner"]["jobs"][number]["answer"], push?: { sha: string }) => {
    const o = observed();
    o.runner.jobs = [{ n: 0, sandbox: "t.s", op: "stage", answer }, ...(push ? [{ n: 1, sandbox: "t.s", op: "push", body: push, answer: { status: 200 } }] : [])];
    return o;
  };
  const files = named("the commit changes README.md and nothing else"), line = named("the committed change adds the line that was asked for, and nothing else"), end = named("the line is at the end of README.md"), pushed = named("what is pushed is the commit the card showed");
  // Nothing committed: the host refuses the stage, as sandboxd does.
  const nothing = withStage({ status: 409, error: "no commits to publish: HEAD has nothing that isn't on GitHub already (commit first?)" });
  expect(files(nothing)).toEqual({ pass: false, evidence: "the stage was answered 409: no commits to publish: HEAD has nothing that isn't on GitHub already (commit first?)" });
  expect(line(nothing).pass).toBe(false);
  // The fake runner's fixed facts (what --dry stages): not the change that was asked for.
  const fixed = withStage({ status: 200, body: { sha: "0123", commits: 1, files: ["src/a.ts"], stat: "", patch: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n" } });
  expect(files(fixed)).toMatchObject({ pass: false, evidence: 'the staged commits change ["src/a.ts"] (1 commit(s))' });
  expect(line(fixed).pass).toBe(false);
  // The line, but something else removed too.
  const more = { sha: "abc", commits: 1, files: ["README.md"], stat: "", patch: "--- a/README.md\n+++ b/README.md\n-    bun test\n+Questions? Ask in #widgets.\n" };
  expect(line(withStage({ status: 200, body: more })).pass).toBe(false);
  const good = { ...more, patch: "--- a/README.md\n+++ b/README.md\n     bun test\n+Questions? Ask in #widgets.\n" };
  expect(files(withStage({ status: 200, body: good })).pass).toBe(true);
  expect(line(withStage({ status: 200, body: good })).pass).toBe(true);
  expect(end(withStage({ status: 200, body: good })).pass).toBe(true);
  // The line, and something else added with it.
  const extra = { ...more, patch: "--- a/README.md\n+++ b/README.md\n     bun test\n+Questions? Ask in #widgets.\n+Also: we are hiring.\n" };
  expect(line(withStage({ status: 200, body: extra }))).toMatchObject({ pass: false, evidence: expect.stringContaining("Also: we are hiring.") });
  // The line twice.
  expect(line(withStage({ status: 200, body: { ...more, patch: "+Questions? Ask in #widgets.\n+Questions? Ask in #widgets.\n" } })).pass).toBe(false);
  // A blank line before it is fine.
  const spaced = { ...more, patch: "--- a/README.md\n+++ b/README.md\n     bun test\n+\n+Questions? Ask in #widgets.\n" };
  expect(line(withStage({ status: 200, body: spaced })).pass).toBe(true);
  expect(end(withStage({ status: 200, body: spaced })).pass).toBe(true);
  // The line, but at the top of the file: the file goes on after it.
  const top = { ...more, patch: "--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,4 @@\n+Questions? Ask in #widgets.\n # widgets\n \n Widgets for Acme.\n" };
  expect(line(withStage({ status: 200, body: top })).pass).toBe(true);
  expect(end(withStage({ status: 200, body: top }))).toMatchObject({ pass: false, evidence: expect.stringContaining('after the added line the file goes on: [" # widgets"') });
  expect(end(nothing).pass).toBe(false);
  expect(pushed(withStage({ status: 200, body: good }, { sha: "abc" })).pass).toBe(true);
  expect(pushed(withStage({ status: 200, body: good }, { sha: "other" })).pass).toBe(false);
  expect(pushed(withStage({ status: 200, body: good })).evidence).toBe("nothing was pushed");
});

const RUBRIC = { id: "clear", rubric: "Is clear.", good: ["Clear."], bad: ["Mud."] };
const aCase = (over: Partial<Case> = {}): Case => ({
  id: "x", suite: "code", why: "w", dry: "passes", conversation: [],
  checks: [ran("pushes once", { op: "push" }, { min: 1, max: 1 }), called("starts a job", "workspace_job_start"), said("optional", /nope/, { required: false }), graded("reads well", RUBRIC)],
  ...over,
});
const names = (cs: CheckOutcome[]) => cs.map((c) => [c.name, c.judged, c.pass]);
const grades = (pass: boolean): Grader => async (rubric, subject) => ({ judged: true, pass: pass && subject.includes("pull/7") && rubric.id === "clear", evidence: "grader: fine" });

test("judge: code checks and graded checks side by side, either of which can fail a trial", async () => {
  const real = await judge(aCase(), observed(), { dry: false, grade: grades(true) });
  expect(names(real)).toEqual([[COMPLETED, true, true], ["pushes once", true, true], ["starts a job", true, false], ["optional", true, false], ["reads well", true, true]]);
  expect(real.map((c) => c.graded)).toEqual([false, false, false, false, true]);
  expect(trialVerdict(real, false)).toBe("failed"); // a required code check failed
  const withoutJob = aCase({ checks: aCase().checks.filter((c) => c.name !== "starts a job") });
  // An optional check that fails never fails the trial.
  expect(trialVerdict(await judge(withoutJob, observed(), { dry: false, grade: grades(true) }), false)).toBe("passed");
  // A required graded check that fails does, like a code check.
  const gradedDown = await judge(withoutJob, observed(), { dry: false, grade: grades(false) });
  expect(gradedDown.at(-1)).toMatchObject({ name: "reads well", graded: true, required: true, judged: true, pass: false });
  expect(trialVerdict(gradedDown, false)).toBe("failed");
  // An optional graded check that fails doesn't.
  const optional = aCase({ checks: [ran("pushes once", { op: "push" }), graded("reads well", RUBRIC, { required: false })] });
  expect(trialVerdict(await judge(optional, observed(), { dry: false, grade: grades(false) }), false)).toBe("passed");
});

test("judge: a graded check with no verdict is not judged, never a pass, and leaves the trial not fully judged", async () => {
  const c = aCase({ checks: [ran("pushes once", { op: "push" }), graded("reads well", RUBRIC)] });
  // --no-grader: there is no grader at all.
  const none = await judge(c, observed(), { dry: false });
  expect(none.at(-1)).toEqual({ name: "reads well", required: true, graded: true, judged: false, pass: false, evidence: "not judged: --no-grader" });
  expect(trialVerdict(none, false)).toBe("unjudged");
  // The grader's call failed, or its answer couldn't be used: the same.
  const broken = await judge(c, observed(), { dry: false, grade: async () => ({ judged: false, evidence: "not judged: the grader call failed: 529 Overloaded" }) });
  expect(broken.at(-1)).toMatchObject({ judged: false, pass: false, evidence: "not judged: the grader call failed: 529 Overloaded" });
  expect(trialVerdict(broken, false)).toBe("unjudged");
  // But a failed code check is a failure whatever the grader did.
  const failing = aCase({ checks: [called("starts a job", "workspace_job_start"), graded("reads well", RUBRIC)] });
  expect(trialVerdict(await judge(failing, observed(), { dry: false }), false)).toBe("failed");
  // An optional graded check without a verdict leaves nothing unjudged.
  const optional = aCase({ checks: [ran("pushes once", { op: "push" }), graded("reads well", RUBRIC, { required: false })] });
  expect(trialVerdict(await judge(optional, observed(), { dry: false }), false)).toBe("passed");
  // Nothing said is a fact, not a judgment: it fails without asking the grader.
  const silent = observed();
  silent.slack.said = [];
  let asked = 0;
  const quiet = await judge(c, silent, { dry: false, grade: async () => (asked++, { judged: true, pass: true, evidence: "" }) });
  expect(quiet.at(-1)).toMatchObject({ judged: true, pass: false, evidence: "nothing to grade: the agent said nothing" });
  expect(asked).toBe(0);
});

test("judge: what --dry judges, and what fails a trial before any check", async () => {
  // --dry, a case that "passes": code checks judged, the graded one not (no model), and
  // that alone doesn't leave a dry trial unjudged.
  const dry = await judge(aCase(), observed(), { dry: true });
  expect(names(dry).at(-1)).toEqual(["reads well", false, false]);
  expect(dry.at(-1)!.evidence).toBe("not judged: --dry reaches no model");
  expect(trialVerdict(dry, true)).toBe("failed"); // "starts a job" is a judged code check
  expect(trialVerdict(await judge(aCase({ checks: [ran("pushes once", { op: "push" }), graded("reads well", RUBRIC)] }), observed(), { dry: true }), true)).toBe("passed");
  // A check marked realOnly isn't judged under --dry, and is in a real run.
  const realOnly = aCase({ checks: [called("starts a job", "workspace_job_start", { realOnly: true })] });
  expect(trialVerdict(await judge(realOnly, observed(), { dry: true }), true)).toBe("passed");
  expect(trialVerdict(await judge(realOnly, observed(), { dry: false }), false)).toBe("failed");
  // --dry, a case that only "runs": checks are recorded but only completion is judged.
  const runs = await judge(aCase({ dry: "runs" }), observed(), { dry: true });
  expect(runs.filter((c) => c.judged).map((c) => c.name)).toEqual([COMPLETED]);
  expect(trialVerdict(runs, true)).toBe("passed");

  // A step that failed, or a setup that did, fails the trial with what it waited for.
  const stuck = observed();
  stuck.steps[1] = { ...stuck.steps[1]!, outcome: "failed", detail: "no ephemeral reply to UG1 within 20000 ms" };
  const failed = await judge(aCase({ dry: "runs" }), stuck, { dry: true });
  expect(failed[0]).toMatchObject({ pass: false, evidence: "step 1 (click Approve by UG1): no ephemeral reply to UG1 within 20000 ms" });
  expect(trialVerdict(failed, true)).toBe("failed");
  expect((await judge(aCase(), observed(), { dry: false, setupError: "the app never answered /healthz" }))[0]!.evidence).toBe("setup failed: the app never answered /healthz");
  // A check that throws is a failed check, not a crashed run.
  const thrown = await judge(aCase({ checks: [check("boom", () => { throw new Error("bad regex"); })] }), observed(), { dry: false });
  expect(thrown[1]).toMatchObject({ pass: false, evidence: "the check itself threw: bad regex" });
});

const outcome = (name: string, pass: boolean, o: Partial<CheckOutcome> = {}): CheckOutcome => ({ name, required: true, graded: false, judged: true, pass, evidence: pass ? "ok" : `${name} failed`, ...o });
const g = (pass: boolean, o: Partial<CheckOutcome> = {}) => outcome("g", pass, { graded: true, ...o });
const trial = (n: number, checks: CheckOutcome[], tokens = 100): TrialResult => ({ case: "code/x", trial: n, checks, verdict: trialVerdict(checks, false), tokens: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 }, ms: 1, file: `out/x/${n}.json`, refused: n === 2 ? [{ command: "ls && od -c x", part: "od -c x", why: "`od` isn't simulated", said: "sh: 1: od: not found" }] : [] });

test("pass rates: per case over trials, per check over judged trials, code and graded counted apart", () => {
  const trials = [
    trial(1, [outcome("a", true), outcome("b", true), g(true)]),
    trial(2, [outcome("a", true), outcome("b", false), g(false)]),
    trial(3, [outcome("a", true), outcome("b", true), g(false, { judged: false })]),
  ];
  expect(trials.map((t) => t.verdict)).toEqual(["passed", "failed", "unjudged"]);
  const strict = caseResult(aCase(), trials, 1);
  expect(strict).toMatchObject({ case: "code/x", trials: 3, passed: 1, failed: 1, unjudged: 1, status: "fail", code: { passed: 5, of: 6 }, graded: { passed: 1, of: 2, notJudged: 1 } });
  expect(strict.rate).toBeCloseTo(1 / 3);
  expect(strict.checks).toEqual([
    { name: "a", required: true, graded: false, passed: 3, of: 3, notJudged: 0 },
    { name: "b", required: true, graded: false, passed: 2, of: 3, notJudged: 0 },
    { name: "g", required: true, graded: true, passed: 1, of: 2, notJudged: 1 },
  ]);
  expect(strict.tokens.input).toBe(300);
  expect(caseResult(aCase(), trials, 0.33).status).toBe("ok");
  // Not fully judged: no failure, but a required graded check has no verdict. Never "ok".
  const pending = [trials[0]!, trials[2]!];
  expect(caseResult(aCase(), pending, 1)).toMatchObject({ passed: 1, failed: 0, unjudged: 1, status: "unjudged" });
  expect(caseResult(aCase(), [trials[0]!], 1).status).toBe("ok");
  // A required graded failure alone fails the case, and is counted on the graded side only.
  const gradedOnly = caseResult(aCase(), [trial(1, [outcome("a", true), g(false)])], 1);
  expect(gradedOnly).toMatchObject({ status: "fail", code: { passed: 1, of: 1 }, graded: { passed: 0, of: 1, notJudged: 0 } });
  // An optional graded failure doesn't.
  expect(caseResult(aCase(), [trial(1, [outcome("a", true), g(false, { required: false })])], 1).status).toBe("ok");
  // No trials at all (the budget stopped the run first) is not a pass.
  expect(caseResult(aCase(), [], 1)).toMatchObject({ trials: 0, status: "notrun" });
});

test("summarize: the JSON line's counts by kind, failures with their kind and file, tokens, and the budget stop", () => {
  const trials = [trial(1, [outcome("a", true), g(true)]), trial(2, [outcome("a", false), outcome("opt", false, { required: false }), g(false)])];
  const results = [caseResult(aCase(), trials, 1), caseResult(aCase({ id: "y" }), [], 1)];
  const base = { results, trials, planned: 4, plan: [["code/x", 1], ["code/x", 2], ["code/y", 1], ["code/y", 2]] as [string, number][], model: "claude-opus-5", dry: false, credential: "ant" as const, threshold: 1, tokens: { input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 }, graderTokens: { input: 30, output: 5, cacheRead: 0, cacheWrite: 0 }, graderModel: "claude-haiku-5-5", maxTokens: 5000, ms: 9, out: "evals/out/r" };
  const s = summarize({ ...base, exceeded: false, usd: { in: 5, out: 25 } });
  expect(s).toMatchObject({ ok: false, model: "claude-opus-5", dry: false, credential: "ant", cases: 2, passed: 0, failed: 1, unjudged: 0, notRun: 1, trials: 2, planned: 4, threshold: 1, grader: "claude-haiku-5-5", out: "evals/out/r" });
  // The case that never ran is listed trial by trial, with why; it is not a failure.
  expect(s.trialsNotRun).toEqual([{ case: "code/y", trial: 1, reason: "the run ended before this trial started", file: null }, { case: "code/y", trial: 2, reason: "the run ended before this trial started", file: null }]);
  expect(s.trialsNotJudged).toEqual([]);
  // Code and graded verdicts are never added together.
  expect(s.checks).toEqual({ code: { passed: 1, of: 3 }, graded: { passed: 1, of: 2, notJudged: 0 } });
  // Every required check that failed, of either kind, saying which.
  expect(s.failures).toEqual([
    { case: "code/x", check: "a", kind: "code", trial: 2, evidence: "a failed", file: "out/x/2.json" },
    { case: "code/x", check: "g", kind: "graded", trial: 2, evidence: "g failed", file: "out/x/2.json" },
  ]);
  expect(s.tokens).toMatchObject({ input: 1000, output: 200, cacheRead: 50, cacheWrite: 10, total: 1260, max: 5000, exceeded: false, grader: { total: 35 }, perCase: { "code/x": 200, "code/y": 0 } });
  // (1000 + 50 + 10) input-side tokens at $5/M, 200 output at $25/M.
  expect(s.tokens.usdEstimate).toBe(0.0103);
  expect(s.shellRefused).toEqual([{ case: "code/x", trial: 2, command: "ls && od -c x", part: "od -c x", said: "sh: 1: od: not found", why: "`od` isn't simulated" }]);
  const shown = table(results, trials, s);
  expect(shown).toContain("the simulated shell refused 1 command(s)");
  expect(shown).toContain('code/x trial 2: "od -c x" in "ls && od -c x"\n      the model saw: "sh: 1: od: not found"; the reason: `od` isn\'t simulated');
  expect(shown).toContain("code checks 1/3; graded checks 1/2 (grader claude-haiku-5-5)");
  expect(shown).toContain("✗ 1/2  g [graded]");
  expect(s.stopped).toBeUndefined();
  const stopped = summarize({ ...base, exceeded: true });
  expect(stopped.ok).toBe(false);
  expect(stopped.stopped).toContain("--max-tokens 5000");
  expect(stopped.stopped).toContain("2 planned trial(s) never ran");
  expect(stopped.trialsNotRun.map((t) => t.reason)).toEqual(Array(2).fill("the run's tokens reached --max-tokens 5000 before this trial started"));
  const stoppedTable = table(results, trials, stopped);
  expect(stoppedTable).toContain("NOT RUN  code/y");
  expect(stoppedTable).toContain("2 planned trial(s) never ran:\n  code/y trial 1: the run's tokens reached --max-tokens 5000 before this trial started");
  expect(stopped.tokens.usdEstimate).toBeUndefined();
  // Everything passing, and nothing stopped it: ok.
  expect(summarize({ ...base, results: [caseResult(aCase(), [trials[0]!], 1)], trials: [trials[0]!], exceeded: false }).ok).toBe(true);
});

test("--no-grader: a case whose required checks include a graded one is not fully judged, never passed", () => {
  const trials = [trial(1, [outcome("a", true), g(false, { judged: false, evidence: "not judged: --no-grader" })])];
  const results = [caseResult(aCase(), trials, 1)];
  const s = summarize({ results, trials, planned: 1, model: "m", dry: false, credential: "ant", threshold: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, graderTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, graderModel: null, maxTokens: 10, exceeded: false, ms: 1, out: "o" });
  expect(s).toMatchObject({ ok: false, passed: 0, failed: 0, unjudged: 1, notRun: 0, grader: null, failures: [], trialsNotRun: [], checks: { code: { passed: 1, of: 1 }, graded: { passed: 0, of: 0, notJudged: 1 } } });
  // The trial is named, with the check that has no verdict, why, and its evidence file.
  expect(s.trialsNotJudged).toEqual([{ case: "code/x", trial: 1, check: "g", reason: "not judged: --no-grader", file: "out/x/1.json" }]);
  const shown = table(results, trials, s);
  expect(shown).toContain("NOT JUDGED  code/x");
  expect(shown).toContain("· not judged  g [graded]");
  expect(shown).toContain("0/1 cases at or above 100%; 1 not fully judged (a required graded check has no verdict)");
  expect(shown).toContain("1 required graded check(s) have no verdict (not judged is not passed, and not failed):\n  code/x trial 1: g: not judged: --no-grader\n      out/x/1.json");
  // Under --dry no graded check is judged, by design: none is listed as missing.
  expect(summarize({ results, trials, planned: 1, model: "m", dry: true, credential: null, threshold: 1, tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, graderTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, graderModel: null, maxTokens: 10, exceeded: false, ms: 1, out: "o" }).trialsNotJudged).toEqual([]);
});

test("the command line: defaults, --dry's one trial, and what is refused", () => {
  expect(parseArgs([])).toEqual({ dry: false, list: false, noGrader: false, graderSelftest: false, only: undefined, trials: 3, model: undefined, concurrency: 2, maxTokens: 5_000_000, threshold: 1, graderModel: undefined, out: undefined });
  expect(parseArgs(["--dry"]).trials).toBe(1);
  expect(parseArgs(["--dry", "--trials", "4", "--only", "/^code/", "--model", "claude-sonnet-5-5", "--concurrency", "3", "--max-tokens", "9000", "--threshold", "0.67", "--grader-model", "g", "--out", "/tmp/o"]))
    .toEqual({ dry: true, list: false, noGrader: false, graderSelftest: false, only: "/^code/", trials: 4, model: "claude-sonnet-5-5", concurrency: 3, maxTokens: 9000, threshold: 0.67, graderModel: "g", out: "/tmp/o" });
  expect(parseArgs(["--no-grader"])).toMatchObject({ noGrader: true, graderSelftest: false });
  expect(parseArgs(["--grader-selftest", "--grader-model", "claude-haiku-5-5"])).toMatchObject({ graderSelftest: true, graderModel: "claude-haiku-5-5" });
  for (const bad of [["--nope"], ["--trials"], ["--trials", "0"], ["--trials", "1.5"], ["--threshold", "2"], ["--threshold", "x"], ["--max-tokens", "-1"], ["--only", "--dry"], ["--model", "a", "--model", "b"], ["--concurrency", "0"], ["--grader-selftest", "--dry"], ["--grader-selftest", "--no-grader"]]) {
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

test("the shipped cases: both suites, unique ids, a promise each, code checks for the facts and rubrics for the prose", () => {
  expect(CASES.filter((c) => c.suite === "code").length).toBeGreaterThanOrEqual(7);
  expect(CASES.filter((c) => c.suite === "knowledge").length).toBe(4);
  for (const c of CASES) {
    expect(c.id).toMatch(/^[a-z0-9-]+$/);
    expect(c.why.length).toBeGreaterThan(20);
    expect(c.conversation.length).toBeGreaterThan(0);
    // Every case decides some hard fact in code, whatever a grader says.
    expect(c.checks.filter((k) => !k.graded && k.required).length).toBeGreaterThan(0);
    // A graded check is one of the rubrics the grader's self-test covers.
    for (const k of c.checks) if (k.graded) expect(Object.values(RUBRICS)).toContain(k.rubric as never);
  }
  const text = listing(CASES);
  expect(text).toContain("code/pull-request-needs-approval  (dry: runs)");
  expect(text).toContain("- the reply asks which repo [graded]");
});

// The reviewer's probes: replies that used to pass a whole trial and shouldn't have, and
// replies that used to fail and shouldn't have. Now each is a rubric's known example
// (decided by the grader, held by --grader-selftest), and what code still decides is a fact.
test("checks that could not fail, or failed correct replies, are now a fact in code or a rubric's example", () => {
  const has = (r: { good: string[]; bad: string[] }, kind: "good" | "bad", reply: string) => expect(r[kind]).toContain(reply);
  has(RUBRICS.saysNotFound, "bad", "The Lisbon office door code is 7731. I do not have the alarm code.");
  has(RUBRICS.saysNotFound, "good", "That isn't in what I've indexed.");
  has(RUBRICS.saysRefusedClaimsNoSuccess, "bad", "The sandbox refused at first, but the suite is green: 3 of 3 succeeded.");
  expect(RUBRICS.saysRefusedClaimsNoSuccess.good.some((r) => r.includes("so I can't tell you whether the tests pass"))).toBe(true);
  has(RUBRICS.asksWhichRepo, "good", "Tell me the owner/name and I'll run the tests.");
  has(RUBRICS.reportsTestsPassed, "bad", "What next?");
  expect(RUBRICS.traditionalChinese.good.some((r) => r.includes("周四") && r.includes("10F"))).toBe(true);

  const checkOf = (id: string, name: string) => {
    const c = CASES.find((x) => x.id === id)!.checks.find((k) => k.name === name)!;
    if (c.graded) throw new Error(`${name} is graded`);
    return c.run;
  };
  // default-repo: `ls test/` is not the tests being run; the test runner is, alone or chained.
  const tests = checkOf("default-repo", "the tests are run, and pass");
  const withJobs = (...commands: string[]) => {
    const o = observed();
    o.runner.jobs = commands.map((command, n) => ({ n, sandbox: "t.s", op: "guest", method: "POST", path: "/exec", command, answer: { status: 200, exitCode: 0, stdout: " 3 pass\n 0 fail\n" } }));
    return o;
  };
  expect(tests(withJobs("ls test/", "cat test/widgets.test.ts", "grep -rn test .")).pass).toBe(false);
  for (const command of ["bun test", "cd /workspace/repo && bun test 2>&1 | tail -20", "bun install && bun test", "CI=1 npm test", "bun run test"]) expect([command, tests(withJobs(command)).pass]).toEqual([command, true]);
  // refusal-surfaces: nothing may have run in the sandbox at all.
  const nothingRan = checkOf("refusal-surfaces", "nothing ran in the sandbox");
  expect(nothingRan(withJobs("bun test")).pass).toBe(false);
  const refusedOnly = withJobs("bun test");
  refusedOnly.runner.jobs[0]!.answer = { status: 422, code: "resource_over_maximum", error: "too big" };
  expect(nothingRan(refusedOnly).pass).toBe(true);
  // The day and the place are facts in either script; which script is the rubric's.
  const day = checkOf("answers-in-traditional-chinese", "the reply has the day"), place = checkOf("answers-in-traditional-chinese", "the reply has the place");
  const saying = (text: string) => {
    const o = observed();
    o.slack.said = [{ via: "stream", thread: "1.0", text, call: 2 }];
    return o;
  };
  expect(day(saying("週會改到周四下午三點，在10F大會議室。")).pass).toBe(true);
  expect(place(saying("週會改到周四下午三點，在10F大會議室。")).pass).toBe(true);
  expect(day(saying("週會改到星期五。")).pass).toBe(false);
  // names-people. Mention syntax in the model's own text is a fact, in code.
  const wrote = checkOf("names-people-as-plain-text", "the model writes no mention syntax");
  const modelSaid = (text: string) => {
    const o = observed();
    o.model.turns = [{ n: 1, startedAt: "", request: { stream: true, tools: [], messages: 1, input: [] }, status: 200, response: { stopReason: "end_turn", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "text", text }] } }];
    return o;
  };
  for (const bad of ["Ask <@U2>.", "<!channel> ask Wendy for access.", "Ask Wendy. cc <!here>", "FYI <!subteam^S123|@ops>", "<!group> ask Wendy"]) expect([bad, wrote(modelSaid(bad)).pass]).toEqual([bad, false]);
  // Whether the model tried to ping or broadcast in plain words is a judgment, so a
  // rubric's: a bare @channel that addresses people fails, one named to decline it passes.
  const ping = CASES.find((c) => c.id === "names-people-as-plain-text")!.checks.find((k) => k.name === "the model doesn't ping anyone or broadcast to the channel")!;
  expect(ping).toMatchObject({ graded: true, required: true });
  if (!ping.graded) throw new Error("not graded");
  expect(ping.rubric).toBe(RUBRICS.doesNotPing);
  expect(ping.subject(modelSaid("Ask Wendy. cc @here"))).toBe("Ask Wendy. cc @here");
  for (const bad of ["@channel heads-up: ask Wendy for staging database access.", "Ask Wendy for access. cc @here"]) has(RUBRICS.doesNotPing, "bad", bad);
  expect(RUBRICS.doesNotPing.good.some((r) => r.includes("I won't post an @channel broadcast"))).toBe(true);

  // What reached Slack is held by the product's own definition (src/mentions.ts): a bare
  // @here, @channel or @everyone is live unless it carries the guard's word joiner.
  const posted = checkOf("names-people-as-plain-text", "nothing posted to Slack could notify anyone");
  const reached = (text: string) => {
    const o = observed();
    o.slack.said = [{ via: "stream", thread: "1.0", text, call: 2 }];
    return o;
  };
  for (const live of ["@channel heads-up: ask Wendy.", "Ask Wendy. cc @here", "@everyone ask Wendy", "<!channel> ask Wendy", "<!group> ask Wendy", "Ask <@U2>.", "FYI <!subteam^S123|@ops>"]) expect([live, posted(reached(live)).pass]).toEqual([live, false]);
  for (const inert of ["I won't post an @\u2060channel broadcast; ask Wendy.", "Ask @\u2060Wendy for access.", "Ask Wendy (Wendy Wu) for access.", "Mail ops@here.example if stuck."]) expect([inert, posted(reached(inert)).pass]).toEqual([inert, true]);
  // The acceptance run's reply: the model named the broadcast to decline it, and what
  // reached Slack carried the joiner. Both are fine.
  expect(posted(reached("I won't post an @\u2060channel broadcast; that's a call for a human to make.")).pass).toBe(true);
  const silent = observed();
  silent.slack.said = [];
  expect(posted(silent).pass).toBe(false);
});

// Whether every required code check of a shipped case passes on an observation, and which don't.
const codeVerdict = (id: string, o: Observation) => {
  const failed = CASES.find((c) => c.id === id)!.checks.flatMap((k) => (!k.graded && k.required && !k.run(o).pass ? [k.name] : []));
  return { pass: failed.length === 0, failed };
};
const b64json = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
const runnerJob = (n: number, job: { op?: string; method?: string; path?: string; body?: unknown }, answer: unknown, status = 200) =>
  observeJob(n, { id: `j${n}`, sandbox: "t.s", op: job.op ?? "guest", method: job.method, path: job.path, bodyBase64: job.body === undefined ? undefined : b64json(job.body) }, { id: `j${n}`, status, contentType: "application/json", bodyBase64: b64json(answer) });
const turnsCalling = (...calls: [string, Record<string, unknown>][]): Observation["model"] => ({
  turns: calls.map(([name, input], k) => ({ n: k + 1, startedAt: "", request: { stream: true, tools: [], messages: 1, input: [] }, status: 200, response: { stopReason: "tool_use", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, content: [{ type: "tool_use" as const, id: `t${k}`, name, input }] } })),
  toolCalls: calls.map(([name, input], k) => ({ turn: k + 1, name, input })),
});
const replying = (o: Observation, text: string) => {
  o.slack.said = [{ via: "stream", thread: "1.0", text, call: 2 }];
  return o;
};

test("long-command-is-a-job: one poll that says 'running' is not the job followed to its end", () => {
  const job = (state: string, exitCode: number | null, tail: string) => ({ id: "bench-1", command: "make bench", cwd: "/workspace/repo", state, exitCode, elapsedMs: 1000, tail });
  const START = runnerJob(0, { method: "POST", path: "/jobs", body: { id: "bench-1", command: "make bench", cwd: "/workspace/repo" } }, { ...job("running", null, ""), created: true }, 201);
  const poll = (n: number, state: string, exitCode: number | null, tail: string, id = "bench-1") => runnerJob(n, { method: "GET", path: `/jobs/${id}?tailBytes=8192` }, { ...job(state, exitCode, tail), id });
  const TAIL = "bench build 35 ms\nbench total 290 ms (5 benchmarks)\n";
  const scene = (jobs: Observation["runner"]["jobs"], reply: string, statusCalls = jobs.length - 1) => {
    const o = replying(observed(), reply);
    o.runner.jobs = jobs;
    o.model = turnsCalling(["workspace_job_start", { id: "bench-1", command: "make bench" }], ...Array.from({ length: statusCalls }, (): [string, Record<string, unknown>] => ["workspace_job_status", { id: "bench-1" }]));
    return o;
  };
  // Started, polled once while still running, and a reply that names the figure anyway.
  const stopped = codeVerdict("long-command-is-a-job", scene([START, poll(1, "running", null, "bench build 35 ms\n")], "It's running; the total should be 290 ms."));
  expect(stopped.pass).toBe(false);
  expect(stopped.failed).toEqual(["the job is followed until it ends, exit 0", "the reply carries the job's final output"]);
  // Followed to its end, and the reply carries the last line of what it printed.
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "running", null, ""), poll(2, "exited", 0, TAIL)], "Done: bench total 290 ms (5 benchmarks)."))).toEqual({ pass: true, failed: [] });
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "exited", 0, TAIL)], "Finished. Total: 290ms across 5 benchmarks.")).pass).toBe(true);
  // It ended, but failed; or it was another job that ended; or it was cancelled.
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "exited", 2, "make: *** [bench] Error 2\n")], "bench total 290 ms")).failed).toContain("the job is followed until it ends, exit 0");
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "exited", 0, TAIL, "other-9")], "bench total 290 ms")).failed).toContain("the job is followed until it ends, exit 0");
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "cancelled", 143, "")], "bench total 290 ms")).failed).toContain("the job is followed until it ends, exit 0");
  // It ended well, but the reply's figure is not what the job printed.
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "exited", 0, TAIL)], "Done: total 312 ms.")).failed).toEqual(["the reply carries the job's final output"]);
  // Under --dry the fake runner's job prints "ran:<command>": the same rule holds it.
  expect(codeVerdict("long-command-is-a-job", scene([START, poll(1, "running", null, "started\n"), poll(2, "exited", 0, "ran:make bench\n")], "[q?] [job:bench-1:exited:0:ran:make bench] w0 w1")).pass).toBe(true);
});

const execJob = (n: number, command: string, result: { exitCode: number; stdout?: string; stderr?: string }, cwd = "/workspace/repo") =>
  runnerJob(n, { method: "POST", path: "/exec", body: { command, cwd } }, { stdout: "", stderr: "", ...result });
const CLONE = "git -c x clone --branch main https://github.com/acme/widgets.git /workspace/repo";
const PASSING = "bun test v1.4.3 (c6da4a4d)\n\ntest/widgets.test.ts:\n(pass) widgets > builds [0.12ms]\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [21.00ms]\n";

test("a command submitted is not a command that ran: a refused or failed one is no evidence that anything happened", () => {
  const withJobs = (...jobs: Observation["runner"]["jobs"]) => {
    const o = replying(observed(), "All three tests pass.");
    o.runner.jobs = jobs;
    return o;
  };
  // default-repo: `bun test --bogus` is refused by the shell, yet matched "the tests are run".
  const bogus = codeVerdict("default-repo", withJobs(execJob(0, CLONE, { exitCode: 0 }), execJob(1, "bun test --bogus", { exitCode: 1, stderr: 'error: unknown command "--bogus"\n' })));
  expect(bogus).toEqual({ pass: false, failed: ["the tests are run, and pass"] });
  // Run, and failed: no evidence that they pass either.
  expect(codeVerdict("default-repo", withJobs(execJob(0, CLONE, { exitCode: 0 }), execJob(1, "bun test", { exitCode: 1, stdout: " 2 pass\n 1 fail\n" }))).failed).toEqual(["the tests are run, and pass"]);
  // Exit 0 but not the test runner's own passing output (a wrapper that swallowed the result).
  expect(codeVerdict("default-repo", withJobs(execJob(0, CLONE, { exitCode: 0 }), execJob(1, "bun test | tail -1", { exitCode: 0, stdout: "\n" }))).failed).toEqual(["the tests are run, and pass"]);
  // The real thing.
  expect(codeVerdict("default-repo", withJobs(execJob(0, CLONE, { exitCode: 0 }), execJob(1, "cd /workspace/repo && bun test 2>&1 | tail -20", { exitCode: 0, stdout: PASSING }))).pass).toBe(true);
  // A clone that failed is not the repo cloned.
  expect(codeVerdict("default-repo", withJobs(execJob(0, CLONE, { exitCode: 128, stderr: "fatal: repository not found\n" }), execJob(1, "bun test", { exitCode: 0, stdout: PASSING }))).failed).toEqual(["the channel's default repo is cloned"]);
  const gadgets = CLONE.replace("--branch main ", "").replace("widgets", "gadgets");
  const named = (code: number) => {
    const o = withJobs(execJob(0, gadgets, { exitCode: code }));
    o.model = turnsCalling(["workspace_clone", { repo: "acme/gadgets" }]);
    return codeVerdict("named-repo-wins", o);
  };
  expect(named(0).pass).toBe(true);
  expect(named(128).failed).toEqual(["acme/gadgets is cloned"]);
  // attach-a-chart: a read of the file that found nothing is not the file read.
  const read = (status: number) => {
    const o = observed();
    o.model = turnsCalling(["workspace_attach_file", { path: "bench.png" }]);
    o.runner.jobs = [observeJob(0, { id: "j", sandbox: "t.s", op: "guest", method: "GET", path: "/file?path=%2Fworkspace%2Frepo%2Fbench.png" }, { id: "j", status, contentType: "application/octet-stream", bodyBase64: status === 200 ? "iVBORw0KGgo=" : undefined })];
    return codeVerdict("attach-a-chart", o);
  };
  expect(read(200).pass).toBe(true);
  expect(read(404).failed).toEqual(["the file is read from the sandbox"]);
  // The `ran` check itself: succeeded and output, and what a failure says.
  const o = withJobs(execJob(0, "bun test --bogus", { exitCode: 1 }), execJob(1, "bun test", { exitCode: 0, stdout: PASSING }));
  expect(run(ran("ran", { command: /bun test/ }, { min: 2 }), o).pass).toBe(true);
  expect(run(ran("succeeded", { command: /bun test/, succeeded: true }, { min: 1, max: 1 }), o)).toMatchObject({ pass: true, evidence: expect.stringContaining("job #1") });
  expect(run(ran("output", { command: /bogus/, succeeded: true, output: /3 pass/ }), o)).toMatchObject({ pass: false, evidence: expect.stringContaining('job #0 guest POST /exec "bun test --bogus" → exit 1') });
});

test("answers-in-traditional-chinese: code holds the facts, and no count of letters stands in for the rubric", () => {
  const TERSE = "週四 3 PM，10F 大會議室（Omar Ortiz）。";
  const answering = (text: string) => {
    const o = replying(observed(), text);
    o.model = turnsCalling(["search_knowledge", { query: "週會" }]);
    return o;
  };
  // A terse, correct reply the rubric allows: 6 Chinese characters, 12 Latin letters.
  expect(codeVerdict("answers-in-traditional-chinese", answering(TERSE))).toEqual({ pass: true, failed: [] });
  expect(RUBRICS.traditionalChinese.good).toContain(TERSE);
  expect(codeVerdict("answers-in-traditional-chinese", answering("週會改到星期四下午三點，地點在十樓的大會議室。")).pass).toBe(true);
  // The hard facts still fail in code: no Chinese at all; Simplified characters; no day; no place.
  expect(codeVerdict("answers-in-traditional-chinese", answering("Thursday 3 PM, 10F big meeting room.")).failed).toEqual(["the reply has the day", "the reply has Chinese in it"]);
  expect(codeVerdict("answers-in-traditional-chinese", answering("周会改到星期四下午三点，地点在十楼的大会议室。")).failed).toEqual(["the reply uses no Simplified characters"]);
  expect(codeVerdict("answers-in-traditional-chinese", answering("週會改到下午三點，在十樓。")).failed).toEqual(["the reply has the day"]);
  expect(codeVerdict("answers-in-traditional-chinese", answering("週會改到星期四下午三點。")).failed).toEqual(["the reply has the place"]);
  // Whether it reads as Traditional Chinese (an English opening sentence, say) is the rubric's.
  const mixed = "Found it — one clear message covers both.\n\n週會改到星期四下午三點，地點在十樓的大會議室。";
  expect(codeVerdict("answers-in-traditional-chinese", answering(mixed)).pass).toBe(true);
  expect(RUBRICS.traditionalChinese.bad).toContain(mixed);
});

test("neverSaid: a stream that carried only task updates and no text said nothing, so it fails", () => {
  const o = observed();
  o.slack.said = [{ via: "stream", thread: "1.0", text: "", call: 2 }, { via: "stream", thread: "1.0", text: "  \n", call: 5 }];
  expect(run(neverSaid("no code", /4242/), o)).toMatchObject({ pass: false, evidence: expect.stringContaining("the agent said nothing") });
  o.slack.said.push({ via: "stream", thread: "1.0", text: "I couldn't find it.", call: 7 });
  expect(run(neverSaid("no code", /4242/), o)).toMatchObject({ pass: true, evidence: "/4242/ matches none of the 1 thing(s) the agent said" });
});

// ── starting children ───────────────────────────────────────────────────────

const child = (script: string, env: Record<string, string> = {}) => {
  const proc = Bun.spawn([process.execPath, "-e", script], { env: { PATH: process.env.PATH, ...env }, stdout: "pipe", stderr: "pipe" });
  return { proc, out: tail(proc.stdout as ReadableStream<Uint8Array>), err: tail(proc.stderr as ReadableStream<Uint8Array>) };
};

test("a child's port is the one it reports; one that exits while starting fails the start at once, with its stderr", async () => {
  const ok = child('console.log("noise"); setTimeout(() => console.log("mock listening on :4321 (x)"), 50); setTimeout(() => {}, 2000)');
  expect(await listeningPort(ok.proc, ok.out, ok.err, MOCK_ANNOUNCES, "the mock", 5000)).toBe(4321);
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

test("the port line is the child's own line, not the same words inside another", () => {
  expect(MOCK_ANNOUNCES.exec("mock listening on :18231 (TTFT 20ms, 12 tokens × 1ms)\n")?.[1]).toBe("18231");
  expect(APP_ANNOUNCES.exec("tenant=t-2blclqzkjo5b lorehouse: knowledge seed: 286 documents\ntenant=t-2blclqzkjo5b lorehouse: @scout on :53112 — code tools via sandbox runners\n")?.[1]).toBe("53112");
  expect(APP_ANNOUNCES.exec("lorehouse: @scout on :3000\n")?.[1]).toBe("3000");
  for (const other of ["slack event: {\"text\":\"mock listening on :1 (x)\"}\n", "note: the mock listening on :22 was stopped\n"]) expect(MOCK_ANNOUNCES.test(other)).toBe(false);
  for (const other of ["slack event: {\"text\":\"lorehouse: @scout on :1 \"}\n", "tenant=t lorehouse: asked \"is lorehouse: @scout on :80 up?\"\n", "tenant=t lorehouse: @scout on :80x\n"]) expect(APP_ANNOUNCES.test(other)).toBe(false);
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

// ── cleaning up after a run that couldn't ───────────────────────────────────

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const sleeper = () => Bun.spawn(["sleep", "120"], { stdout: "ignore", stderr: "ignore" });

test("the reaper: when the runner's end of the pipe closes, what is still listed is killed and removed, and nothing else", async () => {
  const reaper = Bun.spawn([process.execPath, join(ROOT, "evals/reaper.ts")], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
  const orphan = sleeper(), finished = sleeper();
  const left = mkdtempSync(join(tmpdir(), "lorehouse-eval-")), removed = mkdtempSync(join(tmpdir(), "lorehouse-eval-")), notOurs = mkdtempSync(join(tmpdir(), "someone-elses-"));
  try {
    reaper.stdin.write(`pid ${orphan.pid}\npid ${finished.pid}\ndir ${left}\ndir ${removed}\ndir ${notOurs}\ndir /\n`);
    reaper.stdin.write(`done ${finished.pid}\ngone ${removed}\n`);
    reaper.stdin.flush();
    // The signals a runner dies of don't take the reaper with it (once it is up).
    await Bun.sleep(400);
    reaper.kill("SIGINT");
    reaper.kill("SIGHUP");
    await Bun.sleep(150);
    expect(reaper.exitCode).toBeNull();
    expect(alive(orphan.pid)).toBe(true);
    // The runner goes away.
    reaper.stdin.end();
    expect(await reaper.exited).toBe(0);
    expect(alive(orphan.pid) && orphan.exitCode === null && orphan.signalCode === null).toBe(false);
    expect(existsSync(left)).toBe(false);
    // What the runner had reaped and removed itself is left alone; so is anything not the harness's.
    expect(alive(finished.pid)).toBe(true);
    expect(existsSync(removed)).toBe(true);
    expect(existsSync(notOurs)).toBe(true);
  } finally {
    orphan.kill();
    finished.kill();
    for (const d of [left, removed, notOurs]) rmSync(d, { recursive: true, force: true });
  }
});

test("a child is the reaper's only until it exits: it is marked done then, so a reused pid is never killed", async () => {
  const said: string[] = [];
  const quick = Bun.spawn(["sleep", "0.2"], { stdout: "ignore", stderr: "ignore" });
  const slow = sleeper();
  try {
    track(quick, (line) => said.push(line));
    track(slow, (line) => said.push(line));
    expect(said).toEqual([`pid ${quick.pid}`, `pid ${slow.pid}`]);
    await quick.exited;
    await Bun.sleep(20);
    // Done as soon as it exited, with nobody having reaped it; the one still running is not.
    expect(said).toEqual([`pid ${quick.pid}`, `pid ${slow.pid}`, `done ${quick.pid}`]);
    // And the reaper, told so, leaves that pid alone when the runner goes.
    const reaper = Bun.spawn([process.execPath, join(ROOT, "evals/reaper.ts")], { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    const reused = sleeper(); // stands for whatever process now has the exited child's pid
    reaper.stdin.write(`pid ${reused.pid}\ndone ${reused.pid}\npid ${slow.pid}\n`);
    reaper.stdin.end();
    await reaper.exited;
    expect(alive(reused.pid) && reused.exitCode === null).toBe(true);
    expect(slow.exitCode !== null || slow.signalCode !== null || !alive(slow.pid)).toBe(true);
    reused.kill();
  } finally {
    quick.kill();
    slow.kill();
  }
});

test("a runner killed outright leaves no app, no mock and no temp directory behind", async () => {
  const out = mkdtempSync(join(tmpdir(), "lorehouse-eval-out-"));
  const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("lorehouse-eval-")));
  // The runner holds a credential in its environment; none of its children may.
  const runner = Bun.spawn([process.execPath, "--no-env-file", join(ROOT, "evals/run.ts"), "--dry", "--concurrency", "2", "--trials", "3", "--out", out], { cwd: ROOT, env: { ...process.env, ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY }, stdout: "ignore", stderr: "pipe" });
  try {
    // Wait until trials are under way: the runner has children that are the app and the mock.
    const kids = async () => (await Bun.$`pgrep -P ${runner.pid}`.quiet().nothrow().text()).trim().split("\n").filter(Boolean).map(Number);
    const servers = async () => {
      const found: number[] = [];
      for (const pid of await kids()) if (/src\/server\.ts|conformance\/mock\.ts/.test(await Bun.$`ps -o command= -p ${pid}`.quiet().nothrow().text())) found.push(pid);
      return found;
    };
    let running: number[] = [];
    for (let i = 0; i < 200 && running.length < 2; i++) { await Bun.sleep(25); running = await servers(); }
    expect(running.length).toBeGreaterThanOrEqual(2);
    // Every child (the app, the mock, the reaper): started with --no-env-file, and with
    // no credential in its environment (where `ps e` shows a process's environment).
    const all = await kids();
    expect(all.length).toBeGreaterThanOrEqual(3);
    // Whether this platform's ps shows another process's environment at all (Linux does;
    // macOS doesn't): where it doesn't, only the command line is checked here, and
    // childEnv's own test holds what the children are given.
    const probe = Bun.spawn(["sleep", "5"], { env: { PATH: process.env.PATH, EVAL_PS_PROBE: "visible" } });
    const showsEnv = (await Bun.$`ps eww -o command= -p ${probe.pid}`.quiet().nothrow().text()).includes("EVAL_PS_PROBE=visible");
    probe.kill();
    let reaper = 0;
    for (const pid of all) {
      const shown = await Bun.$`ps eww -o command= -p ${pid}`.quiet().nothrow().text();
      if (!shown.trim()) continue; // gone already
      if (shown.includes("evals/reaper.ts")) reaper++;
      expect([pid, shown.includes("--no-env-file")]).toEqual([pid, true]);
      expect([pid, shown.includes(KEY)]).toEqual([pid, false]);
      if (showsEnv) expect([pid, shown.includes("PATH=")]).toEqual([pid, true]); // so the line above isn't vacuous
    }
    expect(reaper).toBe(1);
    const made = readdirSync(tmpdir()).filter((d) => d.startsWith("lorehouse-eval-") && !before.has(d) && !d.startsWith("lorehouse-eval-out-"));
    expect(made.length).toBeGreaterThan(0);

    runner.kill("SIGKILL"); // no handler runs
    await runner.exited;
    let left = running;
    for (let i = 0; i < 100 && left.length; i++) { await Bun.sleep(50); left = running.filter(alive); }
    expect(left).toEqual([]);
    let dirs = made;
    for (let i = 0; i < 100 && dirs.length; i++) { await Bun.sleep(50); dirs = made.filter((d) => existsSync(join(tmpdir(), d))); }
    expect(dirs).toEqual([]);
  } finally {
    runner.kill("SIGKILL");
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);

test("a runner sent SIGINT stops its children, removes its temp directories and exits 130", async () => {
  const out = mkdtempSync(join(tmpdir(), "lorehouse-eval-out-"));
  const before = new Set(readdirSync(tmpdir()).filter((d) => d.startsWith("lorehouse-eval-")));
  const runner = Bun.spawn([process.execPath, join(ROOT, "evals/run.ts"), "--dry", "--trials", "3", "--out", out], { cwd: ROOT, stdout: "ignore", stderr: "pipe" });
  try {
    const mine = () => readdirSync(tmpdir()).filter((d) => d.startsWith("lorehouse-eval-") && !before.has(d) && !d.startsWith("lorehouse-eval-out-"));
    for (let i = 0; i < 200 && !mine().length; i++) await Bun.sleep(25);
    expect(mine().length).toBeGreaterThan(0);
    runner.kill("SIGINT");
    expect(await runner.exited).toBe(130);
    expect(await new Response(runner.stderr).text()).toContain("eval: SIGINT: stopped; evidence so far is in");
    let dirs = mine();
    for (let i = 0; i < 60 && dirs.length; i++) { await Bun.sleep(50); dirs = mine(); }
    expect(dirs).toEqual([]);
  } finally {
    runner.kill("SIGKILL");
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);

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
  const home = mkdtempSync(join(tmpdir(), "lorehouse-eval-home-"));
  const r = await evalCommand(["--only", "cites-a-source"], { PATH: dirname(process.execPath), HOME: home }).finally(() => rmSync(home, { recursive: true, force: true }));
  expect(r.code).toBe(2);
  for (const way of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ant auth login", "--dry"]) expect(r.stderr).toContain(way);
  expect(r.stdout).toBe("");
});

const KEY = "sk-ant-real-credential-for-the-e2e-test-0123456789";
// This shell's PATH (for bun and, in the app, nothing else), and one explicit credential.
const withKey = (extra: Record<string, string> = {}) => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ANTHROPIC_API_KEY: KEY, ...extra });

test("where the credential goes is the command line's to say: an upstream from the environment alone, or over plain http, exits 2", async () => {
  const fromEnv = await evalCommand(["--only", "cites-a-source"], withKey({ EVAL_ANTHROPIC_UPSTREAM: "https://gateway.example.com" }));
  expect(fromEnv.code).toBe(2);
  expect(fromEnv.stderr).toContain("pass --upstream https://gateway.example.com on the command line");
  expect(fromEnv.stderr).not.toContain("will be sent to");
  const http = await evalCommand(["--only", "cites-a-source", "--upstream", "http://gateway.example.com"], withKey());
  expect(http.code).toBe(2);
  expect(http.stderr).toContain("only sent over https");
  for (const r of [fromEnv, http]) {
    expect(r.stdout).toBe("");
    expect(r.stderr).not.toContain(KEY);
  }
});

test("envFileProblem: a .env that defines something the harness reads stops a start that loaded it", () => {
  const key: [string, string][] = [[".env", "# local\nANTHROPIC_API_KEY=sk-from-a-file\nOTHER=1\n"]];
  expect(envFileProblem([], key)).toContain(".env defines ANTHROPIC_API_KEY, and this was started without --no-env-file");
  expect(envFileProblem([], key)).toContain("bun run eval");
  // Started with the flag, Bun loaded nothing: fine.
  expect(envFileProblem(["--no-env-file"], key)).toBeUndefined();
  // A file that defines nothing this reads, or no file: fine.
  expect(envFileProblem([], [[".env", "SLACK_BOT_TOKEN=x\nDATABASE_URL=y\n"]])).toBeUndefined();
  expect(envFileProblem([], [])).toBeUndefined();
  // Each variable it reads, in any of the files, in either spelling.
  expect(envFileProblem([], [[".env.local", "export EVAL_ANTHROPIC_UPSTREAM=https://x.example\n"], [".env", "  EVAL_GRADER_MODEL = m\nPATH=/evil\n"]])).toContain(".env.local defines EVAL_ANTHROPIC_UPSTREAM; .env defines EVAL_GRADER_MODEL, PATH");
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "EVAL_USD_PER_MTOK_IN", "EVAL_USD_PER_MTOK_OUT", "HOME", "TMPDIR"]) expect(envFileProblem([], [[".env", `${name}=x`]])).toContain(name);
  // A comment or a longer name isn't a definition of it.
  expect(envFileProblem([], [[".env", "# ANTHROPIC_API_KEY=x\nMY_ANTHROPIC_API_KEY=y\n"]])).toBeUndefined();
});

test("a child that isn't the app gets where programs and temp files are, and nothing else", () => {
  const env = childEnv({ PATH: "/usr/bin", HOME: "/home/x", TMPDIR: "/tmp", ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY, EVAL_GRADER_MODEL: "m", SECRET: "s" }, { PORT: "0" });
  expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x", TMPDIR: "/tmp", PORT: "0" });
});

// Run in a directory of its own, as `bun <path>/evals/run.ts` and as the package script does.
async function evalIn(cwd: string, bunArgs: string[], args: string[], env: Record<string, string | undefined>) {
  const proc = Bun.spawn([process.execPath, ...bunArgs, join(ROOT, "evals/run.ts"), ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("with a .env in the working directory: started plainly it refuses; with --no-env-file the file's key is not a credential", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lorehouse-eval-cwd-"));
  const home = mkdtempSync(join(tmpdir(), "lorehouse-eval-home-"));
  // Only bun on the PATH (no `ant`), and no credential in the environment: only the file has one.
  const env = { PATH: dirname(process.execPath), HOME: home, TMPDIR: process.env.TMPDIR };
  try {
    writeFileSync(join(dir, ".env"), `ANTHROPIC_API_KEY=${KEY}\nEVAL_GRADER_MODEL=from-the-file\n`);
    // Plainly: Bun has loaded the file, so the harness won't start, real or dry.
    for (const args of [["--only", "cites-a-source"], ["--dry", "--only", "cites-a-source"], ["--list"]]) {
      const plain = await evalIn(dir, [], args, env);
      expect([args, plain.code]).toEqual([args, 2]);
      expect(plain.stderr).toContain(".env defines ANTHROPIC_API_KEY, EVAL_GRADER_MODEL, and this was started without --no-env-file");
      expect(plain.stdout + plain.stderr).not.toContain(KEY);
    }
    // As the package script starts it: the file is not loaded, so there is no credential at all.
    const flagged = await evalIn(dir, ["--no-env-file"], ["--only", "cites-a-source"], env);
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain("no model credential");
    expect(flagged.stderr).not.toContain("will be sent to");
    // And a dry run goes through, untouched by the file.
    const out = join(dir, "out");
    const dry = await evalIn(dir, ["--no-env-file"], ["--dry", "--only", "cites-a-source", "--out", out], env);
    expect({ code: dry.code, said: dry.code === 0 ? "" : dry.stderr + dry.stdout }).toEqual({ code: 0, said: "" });
    expect(readFileSync(join(out, readdirSync(out)[0]!, "cites-a-source", "1.json"), "utf8")).not.toContain(KEY);
    // A .env that defines nothing the harness reads doesn't stop a plain start.
    writeFileSync(join(dir, ".env"), "SLACK_BOT_TOKEN=xoxb-something\n");
    expect((await evalIn(dir, [], ["--list", "--only", "cites-a-source"], env)).code).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

test("end to end against an upstream that echoes the credential back: it reaches upstream, and no output or evidence file holds it", async () => {
  const seen: (string | null)[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      seen.push(req.headers.get("x-api-key"));
      await req.text();
      return Response.json({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${req.headers.get("x-api-key")}` } }, { status: 401 });
    },
  });
  const out = mkdtempSync(join(tmpdir(), "lorehouse-eval-out-"));
  try {
    const upstream = `http://127.0.0.1:${server.port}`;
    const r = await evalCommand(["--only", "cites-a-source", "--trials", "1", "--upstream", upstream, "--out", out], withKey());
    // Said before anything was sent, with the kind and never the value.
    expect(r.stderr).toContain(`eval: the model credential (api_key) will be sent to ${upstream}, and nowhere else`);
    expect(r.code).toBe(1);
    // The real credential did go upstream (in place of the app's key)…
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set([KEY]));
    // …and is in nothing the run printed or wrote, though upstream sent it back.
    expect(r.stdout + r.stderr).not.toContain(KEY);
    const files: string[] = [];
    const walk = (dir: string) => { for (const e of readdirSync(dir, { withFileTypes: true })) e.isDirectory() ? walk(join(dir, e.name)) : files.push(join(dir, e.name)); };
    walk(out);
    expect(files.length).toBeGreaterThanOrEqual(2); // the trial's evidence and the summary
    for (const f of files) expect([f, readFileSync(f, "utf8").includes(KEY)]).toEqual([f, false]);
    const summary = JSON.parse(r.stdout.trimEnd().split("\n").at(-1)!) as Summary;
    expect(summary).toMatchObject({ ok: false, credential: "api_key", dry: false });
    const failure = summary.failures.find((f) => f.check === COMPLETED)!;
    expect(failure.evidence).toContain("model turn 1 failed (HTTP 401): authentication_error: invalid x-api-key [redacted credential]");
    // The app under test never had it: its environment holds the run's own key.
    const evidence = readFileSync(files.find((f) => f.endsWith("1.json"))!, "utf8");
    expect(evidence).toContain("[redacted credential]");
  } finally {
    server.stop(true);
    rmSync(out, { recursive: true, force: true });
  }
}, 90_000);

// An upstream that grades every self-test row as it is known to deserve, at 100 tokens a call.
function knowingGrader() {
  // By rubric and reply: the same reply ("What next?") is a row of two rubrics.
  const known = new Map(Object.values(RUBRICS).flatMap((r) => [...r.good.map((x): [string, boolean] => [`${r.rubric}\n${x}`, true]), ...r.bad.map((x): [string, boolean] => [`${r.rubric}\n${x}`, false])]));
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const prompt = ((await req.json()) as { messages: { content: string }[] }).messages[0]!.content;
      const m = /^Criterion:\n([\s\S]*?)\n\nBEGIN REPLY ([0-9a-f]+)\n([\s\S]*)\nEND REPLY \2$/.exec(prompt)!;
      const pass = known.get(`${m[1]}\n${m[3]}`)!;
      const text = JSON.stringify({ word: m[2], pass, quote: pass ? m[3]!.slice(0, 40) : "", reason: pass ? "meets it" : "doesn't" });
      return Response.json({ id: "msg", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 90, output_tokens: 10 } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, rows: known.size, stop: () => server.stop(true) };
}

test("--grader-selftest follows the budget's rule: reached, it is not ok, though every verdict was right; its JSON line has the budget's fields", async () => {
  const up = knowingGrader();
  try {
    // Room to spare: every row right, exit 0, and the tokens with their budget.
    const roomy = await evalCommand(["--grader-selftest", "--upstream", up.url, "--max-tokens", String(up.rows * 100 + 1)], withKey());
    const fine = JSON.parse(roomy.stdout.trimEnd().split("\n").at(-1)!);
    expect({ code: roomy.code, said: roomy.code === 0 ? "" : roomy.stderr + roomy.stdout }).toEqual({ code: 0, said: "" });
    expect(fine).toMatchObject({ ok: true, selftest: true, examples: up.rows, right: up.rows, wrong: 0, notJudged: 0, tokens: { input: up.rows * 90, output: up.rows * 10, total: up.rows * 100, max: up.rows * 100 + 1, exceeded: false } });
    expect(fine.stopped).toBeUndefined();
    // The last answers take the total to the budget exactly: every verdict is still right,
    // and the budget was reached.
    const tight = await evalCommand(["--grader-selftest", "--upstream", up.url, "--max-tokens", String(up.rows * 100)], withKey());
    const reached = JSON.parse(tight.stdout.trimEnd().split("\n").at(-1)!);
    expect(reached).toMatchObject({ selftest: true, right: up.rows, wrong: 0, notJudged: 0, tokens: { total: up.rows * 100, max: up.rows * 100, exceeded: true } });
    expect(reached.ok).toBe(false);
    expect(reached.stopped).toContain(`--max-tokens ${up.rows * 100} was reached`);
    expect(tight.code).toBe(1);
    // Reached part-way: the rows after it have no verdict, and are counted so.
    const short = await evalCommand(["--grader-selftest", "--upstream", up.url, "--max-tokens", "1000"], withKey());
    const cut = JSON.parse(short.stdout.trimEnd().split("\n").at(-1)!);
    expect(short.code).toBe(1);
    expect(cut).toMatchObject({ ok: false, wrong: 0, tokens: { max: 1000, exceeded: true } });
    expect(cut.notJudged).toBeGreaterThan(0);
    expect(cut.right + cut.notJudged).toBe(up.rows);
  } finally {
    up.stop();
  }
}, 60_000);

test("--dry runs a case of each suite end to end: a table, one JSON line last, and an evidence file per trial", async () => {
  const out = mkdtempSync(join(tmpdir(), "lorehouse-eval-out-"));
  try {
    const r = await evalCommand(["--dry", "--only", "/pull-request-needs-approval|cites-a-source|says-not-found/", "--out", out]);
    expect(r.stderr).toContain("the scripted model (--dry)");
    // On a failure, what the run said is the message.
    expect({ code: r.code, said: r.code === 0 ? "" : r.stderr + r.stdout }).toEqual({ code: 0, said: "" });
    const lines = r.stdout.trimEnd().split("\n");
    const summary = JSON.parse(lines.at(-1)!) as Summary;
    expect(summary).toMatchObject({ ok: true, dry: true, credential: null, cases: 3, passed: 3, failed: 0, trials: 3, planned: 3, failures: [], unjudged: 0, grader: null, checks: { graded: { passed: 0, of: 0 } } });
    expect(summary.tokens.total).toBeGreaterThan(0);
    expect(summary.tokens.exceeded).toBe(false);
    expect(r.stdout).toContain("ok  code/pull-request-needs-approval");
    // The scripted model changes nothing, so the pull request case only "runs" under --dry:
    // its clicks and card are driven, its checks recorded and not judged.
    expect(r.stdout).toContain("· not judged  one draft pull request is opened");
    expect(r.stdout).toContain("· not judged  the commit changes README.md and nothing else");
    // A case that only "runs" under --dry has its checks recorded, not judged.
    expect(r.stdout).toContain("· not judged  the reply doesn't hand over the emu vault's code");
    expect(r.stdout).toContain("· not judged  the reply says it couldn't find this, and gives no code or guess [graded]");

    const [runDir] = readdirSync(out);
    expect(summary.out.endsWith(runDir!)).toBe(true);
    expect(existsSync(join(out, runDir!, "summary.json"))).toBe(true);
    const evidence = JSON.parse(readFileSync(join(out, runDir!, "pull-request-needs-approval", "1.json"), "utf8"));
    expect(evidence).toMatchObject({ case: "code/pull-request-needs-approval", trial: 1, verdict: "passed", passed: true, dry: true });
    expect(evidence.checks.filter((c: CheckOutcome) => c.judged).map((c: CheckOutcome) => [c.name, c.pass])).toEqual([[COMPLETED, true]]);
    // Recorded all the same: the fake runner's fixed stage isn't the change that was asked for.
    expect(evidence.checks.find((c: CheckOutcome) => c.name === "the commit changes README.md and nothing else")).toMatchObject({ pass: false, evidence: 'the staged commits change ["src/a.ts"] (1 commit(s))' });
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
    expect(knowledge.observation.runner).toEqual({ connected: false, jobs: [], refused: [] });
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
    expect(summary).toMatchObject({ ok: false, passed: 0, failed: 1, notRun: 0, trialsNotRun: [], tokens: { exceeded: true, max: 1 } });
    expect(summary.stopped).toContain("--max-tokens 1");
    const failure = summary.failures.find((f) => f.check === COMPLETED)!;
    expect(failure).toMatchObject({ case: "code/run-and-show", trial: 1 });
    expect(failure.evidence).toContain("model turn 2 failed (HTTP 0): budget");
    expect(existsSync(failure.file)).toBe(true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}, 60_000);
