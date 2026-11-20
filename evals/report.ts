// report.ts — verdicts and arithmetic: a trial out of its check results, a case out of its
// trials, the run out of its cases; the table for people and the one JSON line for agents.
//
// Two kinds of check, never one number. Code checks decide hard facts (which jobs ran,
// which digits appear); graded checks are a model's judgment of prose against a rubric.
// Either kind may be required. A trial
//   fails     when a required check that was judged did not pass;
//   is not fully judged when none failed but a required graded check has no verdict
//             (--no-grader, or the grader's answer couldn't be used): never a pass;
//   passes    otherwise.
// A case's rate is its passing trials over its trials; it is ok at or above the
// threshold. The table and the JSON line count code and graded checks apart, and every
// failure says which kind it was.

import type { Case, Check, CheckResult, Observation } from "./case";
import type { CredentialKind } from "./credential";
import type { Grader } from "./grader";
import { addTokens, noTokens, totalTokens, type Tokens } from "./sse";

export type CheckOutcome = {
  name: string;
  required: boolean;
  graded: boolean;
  // judged: counts toward a verdict. Under --dry a case that only "runs" has its checks
  // evaluated and recorded but not judged; a graded check with no verdict is not judged.
  judged: boolean;
  pass: boolean;
  evidence: string;
};

export type Verdict = "passed" | "failed" | "unjudged";

export type TrialResult = {
  case: string;
  trial: number;
  verdict: Verdict;
  checks: CheckOutcome[];
  tokens: Tokens;
  ms: number;
  // The evidence file, relative to the working directory.
  file: string;
  // Commands the case's simulated shell refused to run in this trial (shell.ts).
  refused: { command: string; part: string; why: string; said: string }[];
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

// `grade`: the grader, or undefined when there is none (--dry, --no-grader).
export async function judge(c: Case, o: Observation, opts: { dry: boolean; setupError?: string; grade?: Grader }): Promise<CheckOutcome[]> {
  const judged = !opts.dry || c.dry === "passes";
  const out: CheckOutcome[] = [{ name: COMPLETED, required: true, graded: false, judged: true, ...completed(o, opts.setupError) }];
  for (const check of c.checks as Check[]) {
    if (check.graded) {
      const base = { name: check.name, required: check.required, graded: true };
      if (!opts.grade) {
        out.push({ ...base, judged: false, pass: false, evidence: opts.dry ? "not judged: --dry reaches no model" : "not judged: --no-grader" });
        continue;
      }
      const subject = check.subject(o);
      // Nothing said is a fact, not a judgment: it fails without asking anyone.
      const v = subject.trim() ? await opts.grade(check.rubric, subject) : { judged: true as const, pass: false, evidence: "nothing to grade: the agent said nothing" };
      out.push({ ...base, judged: v.judged, pass: v.judged && v.pass, evidence: v.evidence });
      continue;
    }
    let r: CheckResult;
    try {
      r = check.run(o);
    } catch (err) {
      r = { pass: false, evidence: `the check itself threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    out.push({ name: check.name, required: check.required, graded: false, judged: judged && !(opts.dry && check.realOnly), ...r });
  }
  return out;
}

// Under --dry no graded check has a verdict, by design: a dry run is judged on its code
// checks alone, so a missing verdict doesn't leave it "not fully judged".
export function trialVerdict(checks: CheckOutcome[], dry: boolean): Verdict {
  if (checks.some((c) => c.judged && c.required && !c.pass)) return "failed";
  if (!dry && checks.some((c) => c.graded && c.required && !c.judged)) return "unjudged";
  return "passed";
}

export type CheckRate = { name: string; required: boolean; graded: boolean; passed: number; of: number; notJudged: number };
type Count = { passed: number; of: number };
export type CaseResult = {
  case: string;
  suite: string;
  trials: number;
  passed: number;
  failed: number;
  // Trials with no failure but a required graded check left without a verdict.
  unjudged: number;
  // Passing trials over trials.
  rate: number;
  // ok: at or above the threshold. unjudged: it would be, if its unjudged trials passed.
  status: "ok" | "fail" | "unjudged";
  checks: CheckRate[];
  // Check verdicts across the case's trials, by kind: passed over judged.
  code: Count;
  graded: Count & { notJudged: number };
  tokens: Tokens;
};

export function caseResult(c: Case, trials: TrialResult[], threshold: number): CaseResult {
  const count = (v: Verdict) => trials.filter((t) => t.verdict === v).length;
  const passed = count("passed"), unjudged = count("unjudged");
  const names = [...new Set(trials.flatMap((t) => t.checks.map((x) => x.name)))];
  const checks = names.map((name): CheckRate => {
    const all = trials.flatMap((t) => t.checks.filter((x) => x.name === name));
    const judged = all.filter((x) => x.judged);
    return { name, required: all[0]!.required, graded: all[0]!.graded, passed: judged.filter((x) => x.pass).length, of: judged.length, notJudged: all.length - judged.length };
  });
  const sum = (kind: boolean) => checks.filter((x) => x.graded === kind).reduce((n, x) => ({ passed: n.passed + x.passed, of: n.of + x.of, notJudged: n.notJudged + x.notJudged }), { passed: 0, of: 0, notJudged: 0 });
  const rate = trials.length ? passed / trials.length : 0;
  const code = sum(false);
  return {
    case: `${c.suite}/${c.id}`, suite: c.suite, trials: trials.length, passed, failed: count("failed"), unjudged, rate,
    // No trials (the budget stopped the run first) is not a pass.
    status: trials.length > 0 && rate >= threshold ? "ok" : trials.length > 0 && (passed + unjudged) / trials.length >= threshold ? "unjudged" : "fail",
    checks, code: { passed: code.passed, of: code.of }, graded: sum(true),
    tokens: trials.reduce((n, t) => addTokens(n, t.tokens), noTokens()),
  };
}

export type Failure = { case: string; check: string; kind: "code" | "graded"; trial: number; evidence: string; file: string };

export type Summary = {
  ok: boolean;
  model: string;
  dry: boolean;
  // Which kind of credential reached the model (never its value); null under --dry.
  credential: CredentialKind | null;
  cases: number;
  passed: number;
  failed: number;
  // Cases not fully judged: no failure, but a required graded check has no verdict.
  unjudged: number;
  // Trials run, of those planned.
  trials: number;
  planned: number;
  threshold: number;
  // Check verdicts across the run, by kind: passed over judged, never added together.
  checks: { code: Count; graded: Count & { notJudged: number } };
  // The grader's model, or null when nothing was graded (--dry, --no-grader).
  grader: string | null;
  tokens: Tokens & {
    total: number;
    max: number;
    exceeded: boolean;
    // The grader's share of the above, counted apart.
    grader: Tokens & { total: number };
    perCase: Record<string, number>;
    usdEstimate?: number;
  };
  // Every required check that failed, by trial, with its kind.
  failures: Failure[];
  // Every command the simulated shell (evals/shell.ts) refused to run, by trial: a failed
  // case beside one of these may be a gap in the shell, not the model's doing.
  // `said` is what the model saw (a real sandbox's words); `why` is the real reason.
  shellRefused: { case: string; trial: number; command: string; part: string; said: string; why: string }[];
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
    t.checks.filter((c) => c.judged && c.required && !c.pass).map((c) => ({ case: t.case, check: c.name, kind: c.graded ? ("graded" as const) : ("code" as const), trial: t.trial, evidence: c.evidence, file: t.file })),
  );
  const status = (s: CaseResult["status"]) => o.results.filter((r) => r.status === s).length;
  const withTotal = (t: Tokens) => ({ ...t, total: totalTokens(t) });
  const input = o.tokens.input + o.tokens.cacheRead + o.tokens.cacheWrite;
  const add = (a: Count, b: Count) => ({ passed: a.passed + b.passed, of: a.of + b.of });
  return {
    ok: !o.exceeded && o.results.length > 0 && o.results.every((r) => r.status === "ok"),
    model: o.model, dry: o.dry, credential: o.credential,
    cases: o.results.length, passed: status("ok"), failed: status("fail"), unjudged: status("unjudged"),
    trials: o.trials.length, planned: o.planned, threshold: o.threshold,
    checks: {
      code: o.results.reduce((n, r) => add(n, r.code), { passed: 0, of: 0 }),
      graded: { ...o.results.reduce((n, r) => add(n, r.graded), { passed: 0, of: 0 }), notJudged: o.results.reduce((n, r) => n + r.graded.notJudged, 0) },
    },
    grader: o.graderModel,
    tokens: {
      ...withTotal(o.tokens), max: o.maxTokens, exceeded: o.exceeded, grader: withTotal(o.graderTokens),
      perCase: Object.fromEntries(o.results.map((r) => [r.case, totalTokens(r.tokens)])),
      ...(o.usd ? { usdEstimate: Math.round(((input * o.usd.in + o.tokens.output * o.usd.out) / 1e6) * 10000) / 10000 } : {}),
    },
    failures,
    shellRefused: o.trials.flatMap((t) => t.refused.map((r) => ({ case: t.case, trial: t.trial, command: r.command, part: r.part, said: r.said, why: r.why }))),
    ...(o.exceeded ? { stopped: `budget: --max-tokens ${o.maxTokens} was reached; ${o.planned - o.trials.length} planned trial(s) never ran and later model calls were refused` } : {}),
    ms: o.ms, out: o.out,
  };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const num = (n: number) => n.toLocaleString("en-US");
const ratio = (c: Count) => (c.of ? `${c.passed}/${c.of}` : "-");

// The table for people: one row per case (code and graded check counts in columns of
// their own), then each case's checks with their rates and, for a failing one, the first
// failure's evidence and file.
export function table(results: CaseResult[], trials: TrialResult[], summary: Summary): string {
  const label = { ok: "ok", fail: "FAIL", unjudged: "NOT JUDGED" };
  const rows = results.map((r) => [label[r.status], r.case, `${r.passed}/${r.trials}`, ratio(r.code), `${ratio(r.graded)}${r.graded.notJudged ? ` (+${r.graded.notJudged} not judged)` : ""}`, num(totalTokens(r.tokens))]);
  const head = ["", "case", "trials", "code checks", "graded checks", "tokens"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((row) => row[i]!.length)));
  const line = (row: string[]) => row.map((cell, i) => (i >= 2 ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!))).join("  ").trimEnd();
  const out = [line(head), line(widths.map((w) => "-".repeat(w))), ...rows.map(line), ""];
  for (const r of results) {
    out.push(`${r.case}  ${r.passed}/${r.trials} trials${r.unjudged ? `, ${r.unjudged} not fully judged` : ""}`);
    for (const c of r.checks) {
      const tags = [c.graded ? "graded" : "", c.required ? "" : "optional"].filter(Boolean);
      const mark = c.of === 0 ? "·" : c.passed === c.of ? "✓" : "✗";
      out.push(`  ${mark} ${c.of === 0 ? "not judged" : `${c.passed}/${c.of}`}  ${c.name}${tags.length ? ` [${tags.join(", ")}]` : ""}${c.of && c.notJudged ? ` (${c.notJudged} not judged)` : ""}`);
      const wanted = (k: CheckOutcome) => k.name === c.name && (k.judged ? !k.pass : c.graded && c.of > 0);
      if ((c.of && c.passed < c.of) || (c.graded && c.of && c.notJudged)) {
        const t = trials.find((x) => x.case === r.case && x.checks.some(wanted));
        const k = t?.checks.find(wanted);
        if (t && k) out.push(`      trial ${t.trial}: ${k.evidence}\n      ${t.file}`);
      }
    }
  }
  const t = summary.tokens, k = summary.checks;
  out.push("", `${summary.passed}/${summary.cases} cases at or above ${pct(summary.threshold)}${summary.unjudged ? `; ${summary.unjudged} not fully judged (a required graded check has no verdict)` : ""}`);
  out.push(`code checks ${ratio(k.code)}; graded checks ${ratio(k.graded)}${k.graded.notJudged ? `, ${k.graded.notJudged} not judged` : ""}${summary.grader ? ` (grader ${summary.grader})` : ""}`);
  out.push(`tokens: ${num(t.total)} of ${num(t.max)} (input ${num(t.input)}, output ${num(t.output)}, cache read ${num(t.cacheRead)}, cache write ${num(t.cacheWrite)}; grader ${num(t.grader.total)} of them)${t.usdEstimate !== undefined ? `; about $${t.usdEstimate} at EVAL_USD_PER_MTOK_IN/OUT` : ""}`);
  if (summary.shellRefused.length) {
    out.push("", `the simulated shell refused ${summary.shellRefused.length} command(s) (evals/shell.ts; a failure beside one may be the shell's gap, not the model's):`);
    for (const r of summary.shellRefused) out.push(`  ${r.case} trial ${r.trial}: ${JSON.stringify(r.part)}${r.part === r.command ? "" : ` in ${JSON.stringify(r.command.length > 160 ? `${r.command.slice(0, 160)}…` : r.command)}`}\n      the model saw: ${JSON.stringify(r.said.split("\n")[0])}; the reason: ${r.why}`);
  }
  if (summary.stopped) out.push(`STOPPED: ${summary.stopped}`);
  return out.join("\n");
}
