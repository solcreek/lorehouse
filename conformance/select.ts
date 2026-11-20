// select.ts — run.ts's command line, and which scenarios `--only` picks. Kept apart from
// run.ts, which starts processes as it loads, so test/ can check it directly.
//
//   --app <path>      the executable under test (default: `bun src/server.ts`)
//   --only <pattern>  run only the scenarios whose name matches, plus what they need:
//                     TEXT    a name containing TEXT
//                     ^TEXT   a name that starts with TEXT
//                     TEXT$   a name that ends with TEXT
//                     ^TEXT$  the name TEXT
//                     A|B     a name that A or B matches, each one of the forms above
//                     All ignore case. The pattern is compared as text and never compiled
//                     into a regular expression: every other character is only itself,
//                     so what a command line carries can't become a pattern that is
//                     malformed, slow, or means more than it reads.

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
    if (args[key] !== undefined) throw new UsageError(`${flag} given twice; one ${key === "only" ? "pattern (use a|b for several)" : "app"} per run`);
    args[key] = value;
  }
  return args;
}

// A scenario may need earlier ones to have run first (it checks what they left behind).
export type Selectable = { name: string; needs?: string[] };

const FORMS = "TEXT, ^TEXT, TEXT$, ^TEXT$, and A|B for either";

// One alternative of a pattern: TEXT, ^TEXT, TEXT$ or ^TEXT$. `^` means something only as
// its first character and `$` only as its last; anywhere else they are themselves.
function alternative(pattern: string, part: string): (name: string) => boolean {
  const fromStart = part.startsWith("^");
  const rest = fromStart ? part.slice(1) : part;
  const toEnd = rest.endsWith("$");
  const text = (toEnd ? rest.slice(0, -1) : rest).toLowerCase();
  if (!text) throw new UsageError(`--only ${JSON.stringify(pattern)}: ${part ? `${JSON.stringify(part)} has no text to match` : "an alternative is empty"} (a pattern is ${FORMS})`);
  if (fromStart && toEnd) return (name) => name === text;
  if (fromStart) return (name) => name.startsWith(text);
  if (toEnd) return (name) => name.endsWith(text);
  return (name) => name.includes(text);
}

// Whether a name matches the pattern (the forms at the top of this file), ignoring case.
// Plain string comparison throughout: nothing here is compiled from the pattern.
export function nameMatcher(pattern: string): (name: string) => boolean {
  const alternatives = pattern.split("|").map((part) => alternative(pattern, part));
  return (name) => {
    const lower = name.toLowerCase();
    return alternatives.some((matches) => matches(lower));
  };
}

// What to say when a pattern written as the /RE/ this once took matches nothing.
export function regexHint(pattern: string): string {
  const looksLikeOne = pattern.length > 2 && pattern.startsWith("/") && pattern.endsWith("/");
  return looksLikeOne ? ". A /regular expression/ is not taken: write ^TEXT for a name that starts with it, TEXT$ for one that ends with it, A|B for either" : "";
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
  if (!matched.size) throw new UsageError(`--only ${JSON.stringify(only)} matches none of the ${all.length} scenarios; nothing ran${regexHint(only)}`);
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
