// select.ts — run.ts's command line, and which scenarios `--only` picks. Kept apart from
// run.ts, which starts processes as it loads, so test/ can check it directly.
//
//   --app <path>      the executable under test (default: `bun src/server.ts`)
//   --only <pattern>  run only the scenarios whose name matches, plus what they need:
//                     TEXT matches a name containing TEXT; /RE/ (a leading and a trailing
//                     slash) matches a name the regular expression RE finds. Both ignore case.

export class UsageError extends Error {}

export type Args = { app?: string; only?: string };

export function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag !== "--app" && flag !== "--only") throw new UsageError(`unknown argument ${JSON.stringify(flag)} (want --app <path> or --only <pattern>)`);
    const value = argv[++i];
    if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    const key = flag.slice(2) as keyof Args;
    if (args[key] !== undefined) throw new UsageError(`${flag} given twice; one ${key === "only" ? "pattern (use /a|b/ for several)" : "app"} per run`);
    args[key] = value;
  }
  return args;
}

// A scenario may need earlier ones to have run first (it checks what they left behind).
export type Selectable = { name: string; needs?: string[] };

export function nameMatcher(pattern: string): (name: string) => boolean {
  if (pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    let re: RegExp;
    try {
      re = new RegExp(pattern.slice(1, -1), "i");
    } catch (e) {
      throw new UsageError(`--only ${pattern}: ${e instanceof Error ? e.message : e}`);
    }
    return (name) => re.test(name);
  }
  const text = pattern.toLowerCase();
  return (name) => name.toLowerCase().includes(text);
}

// The scenarios to run, in their original order: those matching `only` (all, without it)
// and, transitively, the ones they need. `prerequisites` are the ones run only for that.
export function selectScenarios<S extends Selectable>(all: S[], only?: string): { run: S[]; prerequisites: Set<S> } {
  const index = new Map(all.map((s, i) => [s.name, i]));
  if (index.size !== all.length) throw new Error("two scenarios share a name");
  all.forEach((s, i) => {
    for (const need of s.needs ?? []) {
      const at = index.get(need);
      if (at === undefined) throw new Error(`"${s.name}" needs "${need}", which is no scenario`);
      if (at >= i) throw new Error(`"${s.name}" needs "${need}", which runs after it`);
    }
  });
  if (only === undefined) return { run: all, prerequisites: new Set() };

  const matches = nameMatcher(only);
  const matched = new Set(all.filter((s) => matches(s.name)));
  if (!matched.size) throw new UsageError(`--only ${JSON.stringify(only)} matches none of the ${all.length} scenarios; nothing ran`);
  const chosen = new Set(matched);
  const stack = [...matched];
  while (stack.length) {
    for (const need of stack.pop()!.needs ?? []) {
      const s = all[index.get(need)!]!;
      if (!chosen.has(s)) { chosen.add(s); stack.push(s); }
    }
  }
  return { run: all.filter((s) => chosen.has(s)), prerequisites: new Set([...chosen].filter((s) => !matched.has(s))) };
}
