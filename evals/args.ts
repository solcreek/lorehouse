// args.ts — run.ts's command line and which cases `--only` picks. Kept apart from run.ts,
// which starts processes, so test/ can check it directly.

import { nameMatcher, UsageError } from "../conformance/select";
import type { Case } from "./case";

export { UsageError };

export const USAGE = `bun run eval [--dry] [--only <pattern>] [--trials <n>] [--model <id>] [--concurrency <n>]
             [--max-tokens <n>] [--threshold <0..1>] [--grader-model <id>] [--out <dir>] [--list]

  --dry               the scripted model of conformance/mock.ts: no credential, no network.
                      Judges each case by its \`dry\` field. Default --trials 1.
  --only <pattern>    cases whose "<suite>/<id>" contains TEXT, or that /RE/ matches (any case)
  --trials <n>        trials per case (default 3)
  --model <id>        the app's ANTHROPIC_MODEL (default: the app's own default)
  --concurrency <n>   trials at once (default 2)
  --max-tokens <n>    total tokens the run may use before model calls are refused (default 5000000)
  --threshold <x>     a case is ok when its passing trials / trials >= x, code checks only (default 1)
  --grader-model <id> the model for graded checks (default claude-haiku-5-5)
  --out <dir>         where evidence goes (default evals/out)
  --list              print the cases and exit`;

export type Args = { dry: boolean; list: boolean; only?: string; trials: number; model?: string; concurrency: number; maxTokens: number; threshold: number; graderModel?: string; out?: string };

const VALUED = ["--only", "--trials", "--model", "--concurrency", "--max-tokens", "--threshold", "--grader-model", "--out"] as const;

export function parseArgs(argv: string[]): Args {
  const raw: Record<string, string> = {};
  let dry = false, list = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--dry") { dry = true; continue; }
    if (flag === "--list") { list = true; continue; }
    if (!(VALUED as readonly string[]).includes(flag)) throw new UsageError(`unknown argument ${JSON.stringify(flag)}\n\n${USAGE}`);
    const value = argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    if (raw[flag] !== undefined) throw new UsageError(`${flag} given twice`);
    raw[flag] = value;
  }
  const int = (flag: string, fallback: number, min: number) => {
    if (raw[flag] === undefined) return fallback;
    const n = Number(raw[flag]);
    if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} ${raw[flag]}: a whole number, at least ${min}`);
    return n;
  };
  let threshold = 1;
  if (raw["--threshold"] !== undefined) {
    threshold = Number(raw["--threshold"]);
    if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new UsageError(`--threshold ${raw["--threshold"]}: a number from 0 to 1 (1 means every trial must pass)`);
  }
  return {
    dry, list, only: raw["--only"],
    trials: int("--trials", dry ? 1 : 3, 1),
    model: raw["--model"],
    concurrency: int("--concurrency", 2, 1),
    maxTokens: int("--max-tokens", 5_000_000, 1),
    threshold,
    graderModel: raw["--grader-model"],
    out: raw["--out"],
  };
}

// The cases to run, in their listed order. Ids are unique; a pattern that matches nothing
// is a usage error, so a typo never reads as a pass.
export function selectCases(all: Case[], only?: string): Case[] {
  const names = all.map((c) => `${c.suite}/${c.id}`);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) throw new Error(`two cases are named ${twice}`);
  if (only === undefined) return all;
  const matches = nameMatcher(only);
  const chosen = all.filter((c) => matches(`${c.suite}/${c.id}`));
  if (!chosen.length) throw new UsageError(`--only ${JSON.stringify(only)} matches none of the ${all.length} cases (bun run eval --list names them); nothing ran`);
  return chosen;
}

export function listing(cases: Case[]): string {
  return cases
    .map((c) => [`${c.suite}/${c.id}  (dry: ${c.dry})`, `  ${c.why}`, ...c.checks.map((k) => `    - ${k.name}${k.graded ? " [graded]" : k.required ? "" : " [optional]"}`)].join("\n"))
    .join("\n\n");
}
