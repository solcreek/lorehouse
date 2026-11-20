// report.ts — verdicts and arithmetic: a trial out of its check results, a case out of its
// trials, the run out of its cases; the table for people and the one JSON line for agents.
//
// Code checks and graded checks never share a rate. A trial passes when it completed and
// every required code check passed; a case's rate is its passing trials over its trials,
// and it is ok at or above the threshold. Graded checks have their own rate, reported
// beside it, and decide nothing.

import type { Case, Check, CheckResult, Observation } from "./case";
import type { CredentialKind } from "./credential";
import type { Grader } from "./grader";
import { addTokens, noTokens, totalTokens, type Tokens } from "./sse";

export type CheckOutcome = {
  name: string;
  required: boolean;
  graded: boolean;
  // judged: counts toward a verdict. Under --dry a case that only "runs" has its checks
  // evaluated and recorded but not judged; a graded check is skipped (no model).
  judged: boolean;
  pass: boolean;
  evidence: string;
};

export type TrialResult = {
  case: string;
  trial: number;
  passed: boolean;
  checks: CheckOutcome[];
  tokens: Tokens;
  ms: number;
  // The evidence file, relative to the working directory.
  file: string;
  // Commands the case's simulated shell refused to run in this trial (shell.ts).
  refused: { command: string; part: string; why: string }[];
};

// The check every trial has: the conversation ran to its end.
export function completed(o: Observation, setupError?: string): CheckResult {
  if (setupError) return { pass: false, evidence: `setup failed: ${setupError}` };
  const failed = o.steps.find((s) => s.outcome === "failed");
  if (failed) return { pass: false, evidence: `step ${failed.n} (${failed.step}): ${failed.detail}` };
  // A model call that failed for good: the app answers "the turn failed" in the thread,
  // which would read as a reply. A call the SDK retried and then got through is fine.
  const turns = o.model.turns;
  const fatal = turns.find((t) => t.error && (t.status === 0 || (t.status !== undefined && t.status >= 400 && t.status < 500 && ![408, 409, 429].includes(t.status)))) ?? (turns.at(-1)?.error ? turns.at(-1) : undefined);
  if (fatal) return { pass: false, evidence: `model turn ${fatal.n} failed (HTTP ${fatal.status}): ${fatal.error}` };
  return { pass: true, evidence: `all ${o.steps.length} step(s) ran` };
}
export const COMPLETED = "the conversation ran to its end";

export async function judge(c: Case, o: Observation, opts: { dry: boolean; setupError?: string; grade?: Grader }): Promise<CheckOutcome[]> {
  const judged = !opts.dry || c.dry === "passes";
  const out: CheckOutcome[] = [{ name: COMPLETED, required: true, graded: false, judged: true, ...completed(o, opts.setupError) }];
  for (const check of c.checks as Check[]) {
    if (check.graded) {
      if (!opts.grade) {
        out.push({ name: check.name, required: false, graded: true, judged: false, pass: false, evidence: opts.dry ? "not graded: --dry reaches no model" : "not graded" });
        continue;
      }
      const subject = check.subject(o);
      const r = subject.trim() ? await opts.grade(check.rubric, subject) : { pass: false, evidence: "nothing to grade: the agent said nothing" };
      out.push({ name: check.name, required: false, graded: true, judged: true, ...r });
      continue;
    }
    let r: CheckResult;
    try {
      r = check.run(o);
    } catch (err) {
      r = { pass: false, evidence: `the check itself threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    out.push({ name: check.name, required: check.required, graded: false, judged, ...r });
  }
  return out;
}

// A trial passes when every judged, required code check passed.
export const trialPassed = (checks: CheckOutcome[]) => checks.every((c) => c.graded || !c.judged || !c.required || c.pass);

export type CheckRate = { name: string; required: boolean; graded: boolean; passed: number; of: number };
export type CaseResult = {
  case: string;
  suite: string;
  trials: number;
  passed: number;
  // Passing trials over trials: code checks only.
  rate: number;
  ok: boolean;
  checks: CheckRate[];
  // Graded checks, apart: passed over judged, across the case's trials.
  graded: { passed: number; of: number };
  tokens: Tokens;
};

export function caseResult(c: Case, trials: TrialResult[], threshold: number): CaseResult {
  const passed = trials.filter((t) => t.passed).length;
  const names = [...new Set(trials.flatMap((t) => t.checks.map((x) => x.name)))];
  const checks = names.map((name): CheckRate => {
    const all = trials.flatMap((t) => t.checks.filter((x) => x.name === name));
    const judged = all.filter((x) => x.judged);
    return { name, required: all[0]!.required, graded: all[0]!.graded, passed: judged.filter((x) => x.pass).length, of: judged.length };
  });
  const gradedChecks = checks.filter((x) => x.graded);
  const rate = trials.length ? passed / trials.length : 0;
  return {
    case: `${c.suite}/${c.id}`, suite: c.suite, trials: trials.length, passed, rate,
    // No trials (the budget stopped the run first) is not a pass.
    ok: trials.length > 0 && rate >= threshold,
    checks,
    graded: { passed: gradedChecks.reduce((n, x) => n + x.passed, 0), of: gradedChecks.reduce((n, x) => n + x.of, 0) },
    tokens: trials.reduce((sum, t) => addTokens(sum, t.tokens), noTokens()),
  };
}

export type Failure = { case: string; check: string; trial: number; evidence: string; file: string };

export type Summary = {
  ok: boolean;
  model: string;
  dry: boolean;
  // Which kind of credential reached the model (never its value); null under --dry.
  credential: CredentialKind | null;
  cases: number;
  passed: number;
  failed: number;
  // Trials run, of those planned.
  trials: number;
  planned: number;
  threshold: number;
  tokens: Tokens & {
    total: number;
    max: number;
    exceeded: boolean;
    // The grader's share of the above, counted apart.
    grader: Tokens & { total: number };
    perCase: Record<string, number>;
    usdEstimate?: number;
  };
  graded: { model: string | null; passed: number; of: number };
  failures: Failure[];
  // Every command the simulated shell (evals/shell.ts) refused to run, by trial: a failed
  // case beside one of these may be a gap in the shell, not the model's doing.
  shellRefused: { case: string; trial: number; command: string; part: string }[];
  // Why the run stopped early, when it did.
  stopped?: string;
  ms: number;
  out: string;
};

export function summarize(o: {
  results: CaseResult[]; trials: TrialResult[]; planned: number; model: string; dry: boolean; credential: CredentialKind | null; threshold: number;
  tokens: Tokens; graderTokens: Tokens; graderModel: string | null; maxTokens: number; exceeded: boolean; ms: number; out: string; usd?: { in: number; out: number };
}): Summary {
  const failures: Failure[] = o.trials.flatMap((t) =>
    t.checks.filter((c) => !c.graded && c.judged && c.required && !c.pass).map((c) => ({ case: t.case, check: c.name, trial: t.trial, evidence: c.evidence, file: t.file })),
  );
  const passed = o.results.filter((r) => r.ok).length;
  const withTotal = (t: Tokens) => ({ ...t, total: totalTokens(t) });
  const input = o.tokens.input + o.tokens.cacheRead + o.tokens.cacheWrite;
  return {
    ok: !o.exceeded && o.results.every((r) => r.ok),
    model: o.model, dry: o.dry, credential: o.credential,
    cases: o.results.length, passed, failed: o.results.length - passed,
    trials: o.trials.length, planned: o.planned, threshold: o.threshold,
    tokens: {
      ...withTotal(o.tokens), max: o.maxTokens, exceeded: o.exceeded, grader: withTotal(o.graderTokens),
      perCase: Object.fromEntries(o.results.map((r) => [r.case, totalTokens(r.tokens)])),
      ...(o.usd ? { usdEstimate: Math.round(((input * o.usd.in + o.tokens.output * o.usd.out) / 1e6) * 10000) / 10000 } : {}),
    },
    graded: { model: o.graderModel, passed: o.results.reduce((n, r) => n + r.graded.passed, 0), of: o.results.reduce((n, r) => n + r.graded.of, 0) },
    failures,
    shellRefused: o.trials.flatMap((t) => t.refused.map((r) => ({ case: t.case, trial: t.trial, command: r.command, part: r.part }))),
    ...(o.exceeded ? { stopped: `budget: --max-tokens ${o.maxTokens} was reached; ${o.planned - o.trials.length} planned trial(s) never ran and later model calls were refused` } : {}),
    ms: o.ms, out: o.out,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => n.toLocaleString("en-US");

// The table for people: one row per case, then each case's checks with their rates and,
// for a failing one, the first failure's evidence and file.
export function table(results: CaseResult[], trials: TrialResult[], summary: Summary): string {
  const rows = results.map((r) => [r.ok ? "ok" : "FAIL", r.case, `${r.passed}/${r.trials}`, pct(r.rate), r.graded.of ? `${r.graded.passed}/${r.graded.of}` : "-", num(totalTokens(r.tokens))]);
  const head = ["", "case", "trials", "code", "graded", "tokens"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((cell, i) => (i >= 2 ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd();
  const out = [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line), ""];
  for (const r of results) {
    out.push(`${r.case}  ${r.passed}/${r.trials} trials`);
    for (const c of r.checks) {
      const tag = c.graded ? "graded" : c.required ? "" : "optional";
      const mark = c.of === 0 ? "·" : c.passed === c.of ? "✓" : "✗";
      out.push(`  ${mark} ${c.of === 0 ? "not judged" : `${c.passed}/${c.of}`}  ${c.name}${tag ? ` [${tag}]` : ""}`);
      if (c.of && c.passed < c.of) {
        const t = trials.find((x) => x.case === r.case && x.checks.some((k) => k.name === c.name && k.judged && !k.pass));
        const k = t?.checks.find((x) => x.name === c.name);
        if (t && k) out.push(`      trial ${t.trial}: ${k.evidence}\n      ${t.file}`);
      }
    }
  }
  const t = summary.tokens;
  out.push("", `${summary.passed}/${summary.cases} cases at or above ${pct(summary.threshold)} (code checks); graded checks ${summary.graded.of ? `${summary.graded.passed}/${summary.graded.of}` : "none"}`);
  out.push(`tokens: ${num(t.total)} of ${num(t.max)} (input ${num(t.input)}, output ${num(t.output)}, cache read ${num(t.cacheRead)}, cache write ${num(t.cacheWrite)}; grader ${num(t.grader.total)} of them)${t.usdEstimate !== undefined ? `; about $${t.usdEstimate} at EVAL_USD_PER_MTOK_IN/OUT` : ""}`);
  if (summary.shellRefused.length) {
    out.push("", `the simulated shell refused ${summary.shellRefused.length} command(s) (evals/shell.ts; a failure beside one may be the shell's gap, not the model's):`);
    for (const r of summary.shellRefused) out.push(`  ${r.case} trial ${r.trial}: ${JSON.stringify(r.part)}${r.part === r.command ? "" : ` in ${JSON.stringify(r.command.length > 160 ? `${r.command.slice(0, 160)}…` : r.command)}`}`);
  }
  if (summary.stopped) out.push(`STOPPED: ${summary.stopped}`);
  return out.join("\n");
}
