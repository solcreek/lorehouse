// run.ts — `bun run eval`: drive Lorehouse as a Slack teammate would, end to end, against
// a real model, with Slack, GitHub and the sandbox mocked. See evals/README.md.
//
// Progress goes to stderr; the per-case table to stdout; the LAST stdout line is one JSON
// object (report.ts, Summary). Exit 0: every case at or above the threshold; 1: not; 2: a
// usage or setup error (a bad argument, an --only that matches nothing, no credential
// without --dry), decided before anything starts.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { listing, parseArgs, selectCases, UsageError, type Args } from "./args";
import type { Case } from "./case";
import { CASES } from "./cases";
import { DEFAULT_UPSTREAM, envFileProblem, noCredential, resolveCredential, resolveUpstream, scrub, type Credential } from "./credential";
import { DEFAULT_GRADER_MODEL, grader, selftest } from "./grader";
import { RUBRICS } from "./rubrics";
import { startProxy } from "./proxy";
import { caseResult, judge, summarize, table, trialVerdict, type TrialResult } from "./report";
import { cleanUpNow, runTrial, startReaper } from "./trial";

const ROOT = join(import.meta.dir, "..");
const exit2 = (message: string): never => {
  console.error(`eval: ${message}`);
  process.exit(2);
};

// ── decided before anything starts ──────────────────────────────────────────
// Started without --no-env-file, with a .env here that defines something this reads: refuse.
{
  const files = readdirSync(process.cwd(), { withFileTypes: true }).filter((e) => e.isFile() && /^\.env(\..+)?$/.test(e.name)).map((e): [string, string] => [e.name, readFileSync(join(process.cwd(), e.name), "utf8")]);
  const problem = envFileProblem(process.execArgv, files);
  if (problem) exit2(problem);
}
let args: Args;
let cases: Case[];
try {
  args = parseArgs(process.argv.slice(2));
  cases = selectCases(CASES, args.only);
} catch (e) {
  if (!(e instanceof UsageError)) throw e;
  exit2(e.message);
  throw e;
}
if (args.list) {
  console.log(listing(cases));
  process.exit(0);
}
let credential: Credential = noCredential;
if (!args.dry) {
  const resolved = await resolveCredential(process.env);
  if ("problem" in resolved) exit2(resolved.problem);
  else credential = resolved;
}
// Where the credential goes is decided here, once, and said before anything is sent.
let upstream = DEFAULT_UPSTREAM;
if (!args.dry) {
  const resolved = resolveUpstream(args.upstream, process.env);
  if ("problem" in resolved) exit2(resolved.problem);
  else upstream = resolved.url;
  console.error(`eval: the model credential (${credential.kind}) will be sent to ${upstream}, and nowhere else`);
}
const usdIn = Number(process.env.EVAL_USD_PER_MTOK_IN), usdOut = Number(process.env.EVAL_USD_PER_MTOK_OUT);
const usd = Number.isFinite(usdIn) && Number.isFinite(usdOut) && process.env.EVAL_USD_PER_MTOK_IN && process.env.EVAL_USD_PER_MTOK_OUT ? { in: usdIn, out: usdOut } : undefined;

// ── the run ─────────────────────────────────────────────────────────────────
const started = Date.now();
const stamp = new Date(started).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
const runId = `${stamp}-${Math.random().toString(36).slice(2, 6)}`;
const outDir = resolve(args.out ?? join(ROOT, "evals/out"), runId);
mkdirSync(outDir, { recursive: true });
const shown = (path: string) => {
  const rel = relative(process.cwd(), path) || ".";
  return rel.startsWith("..") ? path : rel;
};
// Nothing written or printed holds the credential: the last line of defense (credential.ts).
const clean = (text: string) => scrub(text, credential.secrets());
const log = (line: string) => console.error(clean(line));
// An error nobody caught is printed through the same scrub, never raw.
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (err: unknown) => {
    console.error(clean(`eval: crashed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`));
    cleanUpNow();
    process.exit(1);
  });
}

const proxy = startProxy({ credential, maxTokens: args.maxTokens });
const graderModel = args.dry || args.noGrader ? null : (args.graderModel ?? process.env.EVAL_GRADER_MODEL ?? DEFAULT_GRADER_MODEL);
const hasGraded = args.graderSelftest || cases.some((c) => c.checks.some((k) => k.graded));
const grade = graderModel && hasGraded ? grader(proxy.open("grader", upstream), proxy.key, graderModel) : undefined;

// ── --grader-selftest: is the grader itself right? ──────────────────────────
// Every rubric's known-good and known-bad replies (rubrics.ts), graded by the real grader
// model. No case runs. Exit 0 when every verdict is the one the example deserves.
if (args.graderSelftest) {
  log(`eval: grader self-test: ${Object.values(RUBRICS).reduce((n, r) => n + r.good.length + r.bad.length, 0)} known replies over ${Object.keys(RUBRICS).length} rubrics, grader ${graderModel} through ${upstream} (credential: ${credential.kind})`);
  const rows = await selftest(grade!, Object.values(RUBRICS));
  await proxy.stop();
  for (const r of rows) console.log(clean(`${r.right ? "ok   " : "WRONG"} ${r.rubric}: known to ${r.expect}, graded ${r.got}: ${JSON.stringify(r.reply.length > 90 ? `${r.reply.slice(0, 90)}…` : r.reply)}${r.right ? "" : `\n      ${r.evidence}`}`));
  const wrong = rows.filter((r) => !r.right);
  const t = proxy.tokens("grader");
  const result = { ok: wrong.length === 0, selftest: true, grader: graderModel, credential: credential.kind, examples: rows.length, right: rows.length - wrong.length, wrong: wrong.filter((r) => r.got !== "not judged").length, notJudged: wrong.filter((r) => r.got === "not judged").length, tokens: { ...t, total: t.input + t.output + t.cacheRead + t.cacheWrite }, failures: wrong.map((r) => ({ rubric: r.rubric, expect: r.expect, got: r.got, reply: r.reply, evidence: r.evidence })), ms: Date.now() - started };
  console.log(clean(JSON.stringify(result)));
  process.exit(result.ok ? 0 : 1);
}

// Stopped from outside: the children are killed and the trials' temp directories removed.
// A runner that can't run this (SIGKILL, a crash) is cleaned up after by the reaper.
startReaper();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => {
    cleanUpNow();
    console.error(`eval: ${signal}: stopped; evidence so far is in ${shown(outDir)}`);
    process.exit(130);
  });
}

log(`eval: ${cases.length} case(s) × ${args.trials} trial(s), ${args.dry ? "the scripted model (--dry)" : `a real model through ${upstream} (credential: ${credential.kind})`}, concurrency ${args.concurrency}, budget ${args.maxTokens.toLocaleString("en-US")} tokens`);
log(`eval: evidence in ${shown(outDir)}`);

const planned = cases.flatMap((c) => Array.from({ length: args.trials }, (_, i) => ({ c, trial: i + 1 })));
const results: TrialResult[] = [];
let next = 0;
let modelSeen: string | undefined;
await Promise.all(
  Array.from({ length: Math.min(args.concurrency, planned.length) }, async () => {
    while (next < planned.length && !proxy.exceeded()) {
      const seq = next++;
      const { c, trial } = planned[seq]!;
      const name = `${c.suite}/${c.id}`;
      const id = `${c.suite}.${c.id}.${trial}`;
      const run = await runTrial(c, id, { dry: args.dry, model: args.model, proxy, upstream, seq: seq + 1, quietMs: args.dry ? 300 : 1500, deadlineMs: args.dry ? 20_000 : 150_000, log });
      const checks = await judge(c, run.observation, { dry: args.dry, setupError: run.setupError, grade });
      const verdict = trialVerdict(checks, args.dry);
      const passed = verdict === "passed";
      modelSeen ??= run.observation.model.turns.find((t) => t.response?.model)?.response?.model;
      const file = join(outDir, c.id, `${trial}.json`);
      mkdirSync(join(outDir, c.id), { recursive: true });
      const tokens = proxy.tokens(id);
      const result: TrialResult = { case: name, trial, verdict, checks, tokens, ms: run.ms, file: shown(file), refused: run.observation.runner.refused };
      // What a reader needs first comes first: the verdict and the checks, then the
      // transcript (the model's turns in order), then everything observed.
      const evidence = {
        case: name, why: c.why, trial, verdict, passed, dry: args.dry, model: args.model ?? modelSeen ?? null, ms: run.ms, tokens,
        checks,
        conversation: c.conversation.map((step, n) => ({ ...step, ...run.observation.steps[n] })),
        transcript: run.observation.model.turns,
        observation: { ...run.observation, model: { toolCalls: run.observation.model.toolCalls } },
      };
      writeFileSync(file, clean(JSON.stringify(evidence, (_k, v) => (v instanceof RegExp ? String(v) : v), 2)) + "\n");
      results.push(result);
      const failing = checks.filter((k) => k.required && (k.judged ? !k.pass : k.graded && !args.dry));
      log(`${verdict === "passed" ? "✓" : verdict === "failed" ? "✗" : "?"} ${name} trial ${trial}${verdict === "unjudged" ? " not fully judged" : ""} (${(run.ms / 1000).toFixed(1)} s, ${(tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite).toLocaleString("en-US")} tokens)${failing.length ? `\n${failing.map((k) => `    ${k.judged ? "✗" : "?"} ${k.name}${k.graded ? " [graded]" : ""}: ${k.evidence}`).join("\n")}\n    ${shown(file)}` : ""}`);
    }
  }),
);

results.sort((a, b) => planned.findIndex((p) => `${p.c.suite}/${p.c.id}` === a.case && p.trial === a.trial) - planned.findIndex((p) => `${p.c.suite}/${p.c.id}` === b.case && p.trial === b.trial));
const perCase = cases.map((c) => caseResult(c, results.filter((r) => r.case === `${c.suite}/${c.id}`), args.threshold));
const summary = summarize({
  results: perCase, trials: results, planned: planned.length,
  model: args.dry ? "scripted (conformance/mock.ts)" : (args.model ?? modelSeen ?? "the app's default"),
  dry: args.dry, credential: args.dry ? null : credential.kind, threshold: args.threshold,
  tokens: proxy.tokens(), graderTokens: proxy.tokens("grader"), graderModel: grade ? graderModel : null,
  maxTokens: args.maxTokens, exceeded: proxy.exceeded(), ms: Date.now() - started, out: shown(outDir), usd,
});
await proxy.stop();
writeFileSync(join(outDir, "summary.json"), clean(JSON.stringify({ ...summary, results: perCase }, null, 2)) + "\n");
console.log(clean(table(perCase, results, summary)));
console.log(clean(JSON.stringify(summary)));
process.exit(summary.ok ? 0 : 1);
