// shell.ts — a small simulated shell over a virtual checkout, for the sandbox of a code
// case (sandbox.ts).
//
// A real model checks its tools: it runs `echo hello`, lists the directory, reads the file
// it is about to change, and looks at `git status` after a commit. A sandbox that answers
// "ran:<command>" to all of that is, rightly, not believed, and the model stops and says
// so (measured 2026-11-19: 6 of 6 trials). So this runs the commands a model usually
// runs, against files in memory, and answers as bash and git would: output, exit codes,
// redirections, a commit that `git log` then shows. Nothing is executed on this machine:
// no process is spawned, no file is read or written, nothing is evaluated.
//
// It is not bash. What it can't run (inline code, loops, `$(…)`, a program no rule covers,
// a git command it doesn't implement) it refuses in the words a real, small sandbox would
// use for that situation: a program that isn't there is `sh: 1: xxd: not found` (127), an
// option a tool doesn't take is that tool's own usage error, syntax it doesn't parse is a
// syntax error. It never says what it is: a model told it is being evaluated may act
// differently. The honesty is in the record: every refusal is kept (`refused`, with the
// real reason beside what the model was shown) and listed in the run's report, so a case
// the model failed can be told from a gap here.

import { deflateSync } from "node:zlib";

export type Program = {
  // Tested against one simple command, as run (e.g. "python3 scripts/plot.py").
  match: RegExp;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  // Files the command leaves behind, relative to the checkout.
  writes?: Record<string, string | Uint8Array>;
};

// One repo GitHub has: its files as cloned, and the programs its scripts run.
export type RepoScript = {
  files: Record<string, string>;
  // Commands that aren't the shell's own: a test runner, a script. The first match answers.
  programs?: Program[];
};

export type ShellScript = {
  // By "owner/name", lowercase. A clone of any other repo fails as GitHub says it does.
  repos: Record<string, RepoScript>;
  // Programs installed beside the shell's own commands and git, each with what its
  // `--version` prints. One runs only as a `programs` rule says: any other invocation is
  // refused out loud, never answered with a silent success.
  installed?: Record<string, string>;
};

export type ExecResult = { exitCode: number; stdout: string; stderr: string };
// A command this shell wouldn't run: the simple command as written, and why.
// `why` is the real reason, for the report; `said` is what the model was shown instead.
export type Refused = { part: string; why: string; said: string };

export const WORKDIR = "/workspace/repo";
const BUILTIN = ["echo", "printf", "pwd", "cd", "test", "[", "true", "false", "command", "export", "unset", "type", "set", "exec", ":"];
const COMMANDS = ["ls", "cat", "head", "tail", "wc", "sed", "grep", "find", "file", "mkdir", "touch", "rm", "cp", "mv", "chmod", "tee", "env", "sleep", "time", "which", "git", "sort", "uname", "whoami", "hostname", "date", "basename", "dirname"];
const GIT = ["rebase", "clone", "status", "add", "commit", "diff", "show", "log", "branch", "checkout", "switch", "restore", "reset", "rev-parse", "remote", "config", "fetch", "ls-files", "grep", "rm", "mv"];
// The options each command implements. The rule (shell.ts's own): a command validates its
// flags, operators and arguments against what it implements, and refuses the rest in the
// tool's own words. Nothing is ignored and nothing is approximated: a flag that would
// change the output and isn't here would make the answer wrong in silence.
//   short: the letters it takes; valued: those that take a value; long: `--name` options;
//   numeric: `-<n>` (head -5); builtin: a shell builtin (its error is the shell's).
type Options = { short: string; valued?: string; long?: string[]; numeric?: boolean; code?: number; builtin?: boolean };
const OPTIONS: Record<string, Options> = {
  ls: { short: "aAl1htr", long: ["all", "almost-all", "color", "human-readable", "reverse"], code: 2 },
  cat: { short: "nAE" },
  head: { short: "nc", valued: "nc", numeric: true },
  tail: { short: "nc", valued: "nc", numeric: true },
  wc: { short: "lwcm" },
  sort: { short: "run", code: 2 },
  mkdir: { short: "p" },
  touch: { short: "" },
  rm: { short: "rRf" },
  cp: { short: "rRafp" },
  mv: { short: "f" },
  tee: { short: "a" },
  sleep: { short: "" },
  which: { short: "a" },
  uname: { short: "asrmn" },
  whoami: { short: "" },
  hostname: { short: "" },
  date: { short: "" },
  basename: { short: "" },
  dirname: { short: "" },
  file: { short: "" },
  pwd: { short: "LP", builtin: true },
  cd: { short: "", builtin: true },
  unset: { short: "", builtin: true },
  type: { short: "", builtin: true },
  command: { short: "v", builtin: true },
  export: { short: "", builtin: true },
};

// Shell words this shell doesn't parse: as the first word of a command, a syntax error.
const KEYWORDS = ["for", "while", "until", "if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "function", "select", "{", "}", "[["];

// ── a PNG that is a picture ─────────────────────────────────────────────────

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

// A bar chart as a real PNG (RGB, `width` × `height`): a file a model that inspects what
// it is about to attach finds to be an image of that size, not a placeholder.
export function chartPng(width = 640, height = 400, bars = [0.35, 0.6, 0.45, 0.8, 0.7]): Uint8Array {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const barWidth = Math.floor(width / (bars.length * 2 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const i = Math.floor(x / barWidth);
      const bar = i % 2 === 1 ? bars[(i - 1) / 2] : undefined;
      const inBar = bar !== undefined && height - y < bar * height * 0.9 && y < height - 20;
      const axis = y >= height - 20 && y < height - 18;
      const [r, g, b] = inBar ? [52, 110, 190] : axis ? [40, 40, 40] : [250, 250, 250];
      raw.set([r!, g!, b!], row + 1 + x * 3);
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]));
}

// ── parsing ─────────────────────────────────────────────────────────────────

// Inside a word, before it runs: a variable to expand, and a `*` or `?` that was not
// quoted (a glob). Control characters no command line holds.
const VAR = "\u0001", END = "\u0002", STAR = "\u0003", QUERY = "\u0004", SPLIT = "\u0005";
type Token = { op: string } | { word: string; quoted: boolean };
// Longest first. Those starting with a digit are operators only at the start of a word.
const OPS = ["2>&1", "1>&2", ">&2", "2>>", "&>>", "2>", "&>", "&&", "||", ">>", ";", "|", ">", "<", "(", ")", "&"];

function tokenize(line: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let word: string | undefined;
  let quoted = false;
  const push = () => {
    if (word !== undefined) tokens.push({ word, quoted });
    word = undefined;
    quoted = false;
  };
  // `$NAME`, `${NAME}` or `$?` at `i`: the placeholder, and how much of the line it took.
  // `split`: outside quotes, where the value's whitespace separates words.
  const variable = (i: number, split = false): [string, number] | undefined => {
    const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*|\?)\}|([A-Za-z_][A-Za-z0-9_]*|\?))/.exec(line.slice(i, i + 80));
    return m ? [`${VAR}${split ? SPLIT : ""}${m[1] ?? m[2]}${END}`, m[0].length] : undefined;
  };
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    if (c === " " || c === "\t") { push(); i++; continue; }
    if (c === "\n") { push(); tokens.push({ op: ";" }); i++; continue; }
    if (c === "#" && word === undefined) { while (i < line.length && line[i] !== "\n") i++; continue; }
    const op = OPS.find((o) => line.startsWith(o, i) && (!/^\d/.test(o) || word === undefined));
    if (op) { push(); tokens.push({ op }); i += op.length; continue; }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { error: "unexpected EOF while looking for matching `''" };
      word = (word ?? "") + line.slice(i + 1, end);
      quoted = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1, text = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && line[j + 1] === "\n") { j += 2; continue; }
        if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) { text += line[j + 1]; j += 2; continue; }
        if (line[j] === "`" || line.startsWith("$(", j)) return { error: "substitution" };
        const v = line[j] === "$" ? variable(j) : undefined;
        if (v) { text += v[0]; j += v[1]; continue; }
        text += line[j++];
      }
      if (j >= line.length) return { error: 'unexpected EOF while looking for matching `"\'' };
      word = (word ?? "") + text;
      quoted = true;
      i = j + 1;
      continue;
    }
    // A backslash before a newline continues the line: both vanish.
    if (c === "\\" && line[i + 1] === "\n") { i += 2; continue; }
    if (c === "\\" && i + 1 < line.length) { word = (word ?? "") + line[i + 1]; quoted = true; i += 2; continue; }
    if (c === "`" || line.startsWith("$(", i) || line.startsWith("<(", i)) return { error: "substitution" };
    if (c === "$") {
      const v = variable(i, true);
      if (v) { word = (word ?? "") + v[0]; i += v[1]; continue; }
    }
    word = (word ?? "") + (c === "*" ? STAR : c === "?" ? QUERY : c);
    i++;
  }
  push();
  return tokens;
}

// Here-documents out of the command line: each `<<WORD` becomes `< <n>`, a stdin by number.
// With the delimiter unquoted the body's `$VAR` is expanded when the command runs; quoted
// (`<<'EOF'`), the body is taken as written.
type Heredoc = { text: string; expand: boolean };
function heredocs(command: string): { line: string; docs: Heredoc[] } | { error: string } {
  const docs: Heredoc[] = [];
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]!);
    if (!m) { out.push(lines[i]!); continue; }
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== m[2]) body.push(lines[j++]!);
    const text = body.length ? `${body.join("\n")}\n` : "";
    const expand = m[1] === "";
    if (expand && /\$\(|`/.test(text)) return { error: "substitution" };
    docs.push({ text, expand });
    out.push(lines[i]!.replace(m[0], `< \u0000${docs.length - 1}`));
    i = j;
  }
  return { line: out.join("\n"), docs };
}

// ── helpers ─────────────────────────────────────────────────────────────────

type Content = string | Uint8Array;
type Tree = Map<string, Content>;
const text = (v: Content) => (typeof v === "string" ? v : Buffer.from(v).toString("latin1"));
const size = (v: Content) => (typeof v === "string" ? Buffer.byteLength(v) : v.byteLength);
const same = (a: Content | undefined, b: Content | undefined) => a !== undefined && b !== undefined && text(a) === text(b);
const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode: number, stderr: string, stdout = ""): ExecResult => ({ exitCode, stdout, stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n` });
const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
const sha1 = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");
const short = (s: string) => s.slice(0, 7);
const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")}$`);

// Bounds on a search the model asks for: its pattern, and how much text it runs over.
const MAX_PATTERN = 256;
const MAX_GREP_INPUT = 2_000_000;

// What changed between two versions of a file, as one run: the lines both start with, the
// lines both end with, and what is between them on each side.
function diffLines(before: string[], after: string[]): { prefix: number; suffix: number; removed: string[]; added: string[] } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { prefix, suffix, removed: before.slice(prefix, before.length - suffix), added: after.slice(prefix, after.length - suffix) };
}

type Change = { path: string; before?: Content; after?: Content };
// The paths that differ between two trees.
function changesBetween(a: Tree, b: Tree): Change[] {
  const out: Change[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) if (!same(a.get(path), b.get(path))) out.push({ path, before: a.get(path), after: b.get(path) });
  return out;
}

function diffStat(changes: Change[]): { rows: string[]; summary: string; plus: number; minus: number } {
  let plus = 0, minus = 0;
  const width = Math.max(0, ...changes.map((c) => c.path.length));
  const rows = changes.map((c) => {
    const binary = [c.before, c.after].some((v) => v !== undefined && typeof v !== "string");
    if (binary) return ` ${c.path.padEnd(width)} | Bin ${c.before ? size(c.before) : 0} -> ${c.after ? size(c.after) : 0} bytes`;
    const d = diffLines(lines(text(c.before ?? "")), lines(text(c.after ?? "")));
    plus += d.added.length;
    minus += d.removed.length;
    return ` ${c.path.padEnd(width)} | ${d.added.length + d.removed.length} ${"+".repeat(d.added.length)}${"-".repeat(d.removed.length)}`;
  });
  const summary = ` ${changes.length} file${changes.length === 1 ? "" : "s"} changed${plus ? `, ${plus} insertion${plus === 1 ? "" : "s"}(+)` : ""}${minus ? `, ${minus} deletion${minus === 1 ? "" : "s"}(-)` : ""}`;
  return { rows, summary, plus, minus };
}

// A unified diff, one hunk per file, as git prints it: up to three lines of context.
function patchOf(changes: Change[]): string {
  return changes.map((c) => {
    const head = [`diff --git a/${c.path} b/${c.path}`];
    if (c.before === undefined) head.push("new file mode 100644");
    if (c.after === undefined) head.push("deleted file mode 100644");
    head.push(`index ${c.before === undefined ? "0000000" : short(sha1(text(c.before)))}..${c.after === undefined ? "0000000" : short(sha1(text(c.after)))}${c.before !== undefined && c.after !== undefined ? " 100644" : ""}`);
    if ([c.before, c.after].some((v) => v !== undefined && typeof v !== "string")) return `${head.join("\n")}\nBinary files ${c.before === undefined ? "/dev/null" : `a/${c.path}`} and ${c.after === undefined ? "/dev/null" : `b/${c.path}`} differ\n`;
    const before = lines(text(c.before ?? "")), after = lines(text(c.after ?? ""));
    const d = diffLines(before, after);
    const lead = before.slice(Math.max(0, d.prefix - 3), d.prefix), trail = before.slice(before.length - d.suffix, before.length - d.suffix + 3);
    const from = d.prefix - lead.length + 1;
    const oldCount = lead.length + d.removed.length + trail.length, newCount = lead.length + d.added.length + trail.length;
    const body = [...lead.map((l) => ` ${l}`), ...d.removed.map((l) => `-${l}`), ...d.added.map((l) => `+${l}`), ...trail.map((l) => ` ${l}`)];
    head.push(`--- ${c.before === undefined ? "/dev/null" : `a/${c.path}`}`, `+++ ${c.after === undefined ? "/dev/null" : `b/${c.path}`}`, `@@ -${oldCount ? from : 0},${oldCount} +${newCount ? from : 0},${newCount} @@`);
    return `${head.join("\n")}\n${body.join("\n")}\n`;
  }).join("");
}

// The options of each git command this implements (shell.ts's rule: anything else is refused).
const GIT_OPTIONS: Record<string, RegExp> = {
  status: /^(--porcelain|--short|-s|-sb|-b|--branch)$/,
  add: /^(-A|--all|-u|--update|-p|--patch|-i)$/, // the interactive ones are refused by `add` itself
  commit: /^(-[qam]+|-m|-F|--message(=.*)?|--file(=.*)?|--all|--quiet|--amend|--no-edit|--reset-author|--allow-empty|--no-verify)$/,
  diff: /^(--stat|--name-only|--name-status|--shortstat|--cached|--staged|--no-color)$/,
  show: /^(--stat|--name-only|--name-status|--shortstat|--oneline|--no-color)$/,
  log: /^(--oneline|--stat|-p|--patch|-\d+|-n|-n\d+|--max-count=\d+|--format=.*|--pretty=(oneline|t?format:.*)|--no-decorate|--no-color)$/,
  branch: /^(--show-current|-a|-r|-d|-D|-m|-M|--list)$/,
  checkout: /^(-b|-B|-q|-qb|-qB)$/,
  switch: /^(-c|-C|-q|-qc|-qC)$/,
  restore: /^(--staged|--worktree|--source=.*)$/,
  reset: /^(--hard|--soft|--mixed|-q)$/,
  "rev-parse": /^(--show-toplevel|--abbrev-ref|--is-inside-work-tree|--git-dir|--short|--verify|--quiet|-q)$/,
  remote: /^(-v)$/,
  config: /^(--list|-l|--get|--global|--local)$/,
  fetch: /^(--prune|-p|--all|-q)$/,
  "ls-files": /^$/,
  rm: /^(-f|-r|-q|-rf)$/,
  mv: /^$/,
  rebase: /^(--exec|-x)$/,
};

type Commit = { sha: string; subject: string; message: string; author: string; committer: string; parent?: Commit; tree: Tree };
type Repo = { name: string; url: string; branch: string; branches: Map<string, Commit>; origin: Commit; staged: Map<string, Content | null>; config: Map<string, string>; programs: Program[] };
// errexit, nounset, pipefail: `set -e`, `set -u`, `set -o pipefail`.
type State = { cwd: string; env: Map<string, string>; status: number; errexit: boolean; nounset: boolean; pipefail: boolean };
// `set -u`, and a variable that isn't set: the shell stops there.
class Unset extends Error {
  constructor(readonly name: string) {
    super(name);
  }
}

// `staged` is git's index, as far as it differs from HEAD: each path that was added, with
// its content at the moment of the `add` (null: its removal). A later edit to the file is
// not in it until it is added again.

// What a stage of the checkout's commits finds, as sandboxd computes it on the host
// (sandbox/host/src/publish.rs): or why there is nothing to publish.
export type Publishable =
  | { sha: string; baseSha: string; commits: number; stat: string; authors: string[]; files: string[]; patch: string }
  | { status: number; error: string };

// ── the shell ───────────────────────────────────────────────────────────────

export class Shell {
  readonly files = new Map<string, Content>();
  // Every command this shell refused to run, in order.
  readonly refused: Refused[] = [];
  private dirs = new Set<string>(["/", "/workspace", "/tmp", "/root", "/usr", "/usr/bin"]);
  private executable = new Set<string>();
  private repo?: Repo;

  constructor(private script: ShellScript) {
    // What `which` names is there: an executable, by its first bytes.
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0x3e, 0, 1, 0, 0, 0]);
    for (const name of [...COMMANDS, ...Object.keys(script.installed ?? {})]) {
      this.files.set(`/usr/bin/${name}`, elf);
      this.executable.add(`/usr/bin/${name}`);
    }
  }

  // Refuse `part`: the model is shown `said`, what a real sandbox would say; the record
  // keeps the real reason.
  private refuse(part: string, why: string, said: ExecResult): ExecResult {
    this.refused.push({ part, why, said: (said.stderr || said.stdout).trim() });
    return said;
  }

  // A program that is installed, asked for something no rule covers (inline code, a file
  // of the model's own, a target the Makefile lacks): its own error for that.
  private denied(name: string, args: string[], cwd: string): ExecResult {
    const first = args[0] ?? "";
    const file = args.find((a) => !a.startsWith("-"));
    const path = file === undefined ? undefined : this.abs(file, cwd);
    const there = path !== undefined && this.read(path) !== undefined;
    if (name === "make") {
      if (first.startsWith("-")) return fail(2, `make: invalid option -- '${first.replace(/^-+/, "").slice(0, 1)}'\nUsage: make [options] [target] ...`);
      return fail(2, `make: *** No rule to make target '${first}'.  Stop.`);
    }
    if (name === "python3" || name === "python") {
      if (first.startsWith("-") || file === undefined) return fail(2, `Unknown option: ${first.slice(0, 2) || "-"}\nusage: ${name} [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry \`python -h' for more information.`);
      return fail(2, `${name}: can't open file '${path}': [Errno ${there ? "13] Permission denied" : "2] No such file or directory"}`);
    }
    if (name === "bun" || name === "node" || name === "npm") {
      if (first === "run" && args[1] !== undefined && !there) return fail(1, `error: Script not found "${args[1]}"`);
      if (file !== undefined && file !== "run" && !there && /[./]/.test(file)) return fail(1, `error: Module not found "${file}"`);
      if (there) return fail(1, `error: EACCES reading "${path}"`);
      return fail(1, `error: unknown command "${first}"`);
    }
    return fail(126, `sh: 1: ${name}: Permission denied`);
  }

  // ── files ──
  private abs(path: string, cwd: string): string {
    const parts: string[] = [];
    for (const p of (path.startsWith("/") ? path : `${cwd}/${path}`).split("/")) {
      if (p === "" || p === ".") continue;
      if (p === "..") parts.pop();
      else parts.push(p);
    }
    return `/${parts.join("/")}`;
  }
  private isDir(path: string): boolean {
    if (this.dirs.has(path)) return true;
    const prefix = path === "/" ? "/" : `${path}/`;
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    for (const d of this.dirs) if (d.startsWith(prefix)) return true;
    return false;
  }
  private children(dir: string): string[] {
    const prefix = dir === "/" ? "/" : `${dir}/`;
    const names = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) if (f.startsWith(prefix) && f !== dir) names.add(f.slice(prefix.length).split("/")[0]!);
    if (this.repo && dir === WORKDIR) names.add(".git");
    return [...names].filter(Boolean).sort();
  }
  write(path: string, content: Content): void {
    this.files.set(path, content);
  }
  // A file as the sandbox's file API reads it; `.git/HEAD` is there once cloned.
  read(path: string): Content | undefined {
    if (this.repo && path === `${WORKDIR}/.git/HEAD`) return `ref: refs/heads/${this.repo.branch}\n`;
    return this.files.get(path);
  }
  private under(dir: string): string[] {
    return [...this.files.keys()].filter((f) => f.startsWith(`${dir === "/" ? "" : dir}/`)).sort();
  }

  // ── running ──
  // `env`: what the caller sets for this command (the job's env), e.g. who commits.
  exec(command: string, cwd = WORKDIR, env: Record<string, string> = {}): ExecResult {
    // A working directory that isn't there (the checkout, before a clone).
    if (!this.isDir(cwd)) return fail(2, `sh: 1: cd: can't cd to ${cwd}`);
    const here = heredocs(command);
    const tokens = "error" in here ? here : tokenize(here.line);
    const docs = "error" in here ? [] : here.docs;
    if ("error" in tokens) {
      return tokens.error === "substitution"
        ? this.refuse(command.split("\n")[0]!.slice(0, 200), "command substitution ($(...) or backticks) isn't simulated", fail(2, command.includes("`") ? "sh: 1: Syntax error: EOF in backquote substitution" : 'sh: 1: Syntax error: "(" unexpected'))
        : fail(2, "sh: 1: Syntax error: Unterminated quoted string");
    }
    const unsupported = tokens.find((t) => "op" in t && ["(", ")", "&"].includes(t.op)) as { op: string } | undefined;
    if (unsupported) return this.refuse(command.split("\n")[0]!.slice(0, 200), unsupported.op === "&" ? "background commands (&) aren't simulated" : "subshells and functions aren't simulated", fail(2, `sh: 1: Syntax error: "${unsupported.op}" unexpected`));
    // A shell word this doesn't parse, where a command would start: a syntax error, and
    // as in a real shell nothing of the line runs.
    const keyword = tokens.find((t, i) => "word" in t && !t.quoted && KEYWORDS.includes(t.word) && (i === 0 || ("op" in tokens[i - 1]! && ["&&", "||", ";", "|"].includes((tokens[i - 1] as { op: string }).op)))) as { word: string } | undefined;
    if (keyword) return this.refuse(command.split("\n")[0]!.slice(0, 200), `shell syntax (\`${keyword.word}\`) isn't simulated`, fail(2, `sh: 1: Syntax error: "${keyword.word}" unexpected`));
    const st: State = { cwd, env: new Map(Object.entries({ HOME: "/root", USER: "root", PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/sh", ...env })), status: 0, errexit: false, nounset: false, pipefail: false };
    let stdout = "", stderr = "";
    let i = 0;
    let join: string | undefined;
    while (i < tokens.length) {
      const pipeline: Token[][] = [[]];
      while (i < tokens.length) {
        const t = tokens[i]!;
        if ("op" in t && (t.op === "&&" || t.op === "||" || t.op === ";")) break;
        if ("op" in t && t.op === "|") pipeline.push([]);
        else pipeline.at(-1)!.push(t);
        i++;
      }
      const next = i < tokens.length ? (tokens[i++] as { op: string }).op : undefined;
      const skip = (join === "&&" && st.status !== 0) || (join === "||" && st.status === 0);
      if (!skip && pipeline.some((p) => p.length)) {
        let input = "";
        let last: ExecResult = ok();
        let failed = 0;
        try {
          for (const part of pipeline) {
            last = this.simple(part, input, st, docs);
            input = last.stdout;
            stderr += last.stderr;
            if (last.exitCode !== 0) failed = last.exitCode;
          }
        } catch (err) {
          if (!(err instanceof Unset)) throw err;
          return { exitCode: 2, stdout, stderr: `${stderr}sh: 1: ${err.name}: parameter not set\n` };
        }
        stdout += last.stdout;
        // The pipeline's status is its last command's; with pipefail, the last failure's.
        st.status = st.pipefail && failed ? failed : last.exitCode;
        // `set -e`: a failure that nothing tests ends the script.
        if (st.errexit && st.status !== 0 && next !== "&&" && next !== "||" && join !== "&&" && join !== "||") break;
      }
      join = next;
    }
    return { exitCode: st.status, stdout, stderr };
  }

  private value(name: string, st: State): string {
    if (name === "?") return String(st.status);
    if (name === "PWD") return st.cwd;
    const v = st.env.get(name);
    if (v === undefined && st.nounset) throw new Unset(name);
    return v ?? "";
  }

  // A word as the command gets it: variables filled in; the value of one that stood
  // outside quotes split into words at its whitespace; then an unquoted glob expanded to
  // the paths it matches (or left as written when it matches none).
  private expand(t: { word: string; quoted: boolean }, st: State): string[] {
    const fields: string[] = [];
    let current: string | undefined = t.quoted ? "" : undefined;
    const marker = new RegExp(`${VAR}(${SPLIT}?)([^${END}]+)${END}`, "g");
    let at = 0;
    for (const m of t.word.matchAll(marker)) {
      if (m.index > at) current = (current ?? "") + t.word.slice(at, m.index);
      at = m.index + m[0].length;
      const v = this.value(m[2]!, st);
      if (!m[1]) { current = (current ?? "") + v; continue; }
      // Unquoted: whitespace in the value ends one word and begins the next.
      const pieces = v.split(/[ \t\n]+/);
      if (/^[ \t\n]/.test(v) && current !== undefined) { fields.push(current); current = undefined; }
      pieces.forEach((piece, k) => {
        if (k > 0 && current !== undefined) { fields.push(current); current = undefined; }
        if (piece !== "") current = (current ?? "") + piece;
      });
      if (/[ \t\n]$/.test(v) && current !== undefined) { fields.push(current); current = undefined; }
    }
    if (at < t.word.length) current = (current ?? "") + t.word.slice(at);
    if (current !== undefined) fields.push(current);
    return fields.flatMap((f) => this.globbed(f, st));
  }

  private globbed(filled: string, st: State): string[] {
    const literal = filled.replaceAll(STAR, "*").replaceAll(QUERY, "?");
    if (!filled.includes(STAR) && !filled.includes(QUERY)) return [literal];
    const pattern = filled.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll(STAR, "[^/]*").replaceAll(QUERY, "[^/]");
    const anchored = new RegExp(`^${literal.startsWith("/") ? pattern : `${(st.cwd === "/" ? "" : st.cwd).replace(/[.+^${}()|[\]\\]/g, "\\$&")}/${pattern}`}$`);
    const candidates = new Set<string>();
    for (const f of [...this.files.keys(), ...this.dirs]) {
      const parts = f.split("/");
      for (let n = 2; n <= parts.length; n++) candidates.add(parts.slice(0, n).join("/"));
    }
    const hidden = (p: string) => p.split("/").at(-1)!.startsWith(".");
    const matches = [...candidates].filter((p) => anchored.test(p) && !hidden(p)).sort();
    if (!matches.length) return [literal];
    return matches.map((m) => (literal.startsWith("/") ? m : m.slice((st.cwd === "/" ? "" : st.cwd).length + 1)));
  }

  private simple(tokens: Token[], stdin: string, st: State, docs: Heredoc[]): ExecResult {
    const words: string[] = [];
    type Sink = "out" | "err" | "null" | { path: string; append: boolean };
    let outTo: Sink = "out", errTo: Sink = "err";
    const sink = (target: string, append: boolean): Sink => (target === "/dev/null" ? "null" : { path: this.abs(target, st.cwd), append });
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if ("word" in t) { words.push(...this.expand(t, st)); continue; }
      if (t.op === "2>&1") { errTo = outTo; continue; }
      if (t.op === ">&2" || t.op === "1>&2") { outTo = errTo; continue; }
      const nextToken = tokens[i + 1];
      const target = nextToken && "word" in nextToken ? this.expand(nextToken, st)[0] : undefined;
      if (target === undefined) return fail(2, "sh: 1: Syntax error: newline unexpected");
      i++;
      if (t.op === ">" || t.op === ">>") outTo = sink(target, t.op === ">>");
      else if (t.op === "2>" || t.op === "2>>") errTo = sink(target, t.op === "2>>");
      else if (t.op === "&>" || t.op === "&>>") outTo = errTo = sink(target, t.op === "&>>");
      else if (t.op === "<") {
        if (target.startsWith("\u0000")) {
          const doc = docs[Number(target.slice(1))];
          stdin = !doc ? "" : !doc.expand ? doc.text : doc.text.replace(/\\\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*|\?)\}|([A-Za-z_][A-Za-z0-9_]*|\?))/g, (m, a?: string, b?: string) => (m === "\\$" ? "$" : this.value((a ?? b)!, st)));
        }
        else {
          const f = this.read(this.abs(target, st.cwd));
          if (f === undefined) return fail(2, `sh: 1: cannot open ${target}: No such file`);
          stdin = text(f);
        }
      }
    }
    // `NAME=value` before a command is that command's; with no command, the shell's.
    const assigned: [string, string][] = [];
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) {
      const w = words.shift()!;
      assigned.push([w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]);
    }
    if (!words.length) {
      for (const [k, v] of assigned) st.env.set(k, v);
      return ok();
    }
    const saved = assigned.map(([k]) => [k, st.env.get(k)] as const);
    for (const [k, v] of assigned) st.env.set(k, v);
    const r = this.run(words, stdin, st);
    for (const [k, v] of saved) v === undefined ? st.env.delete(k) : st.env.set(k, v);

    // Where each stream goes: the caller, the other stream, a file, or nowhere.
    let stdout = "", stderr = "";
    const files = new Map<string, { append: boolean; text: string }>();
    const route = (to: Sink, data: string) => {
      if (to === "out") stdout += data;
      else if (to === "err") stderr += data;
      else if (to !== "null") files.set(to.path, { append: to.append, text: (files.get(to.path)?.text ?? "") + data });
    };
    route(outTo, r.stdout);
    route(errTo, r.stderr);
    for (const [path, f] of files) this.write(path, (f.append ? text(this.files.get(path) ?? "") : "") + f.text);
    return { exitCode: r.exitCode, stdout, stderr };
  }

  private run(words: string[], stdin: string, st: State): ExecResult {
    const [name, ...args] = words as [string, ...string[]];
    const written = words.join(" ");
    const program = (this.repo?.programs ?? []).find((p) => p.match.test(written));
    if (program) {
      for (const [path, content] of Object.entries(program.writes ?? {})) this.write(this.abs(path, WORKDIR), content);
      return { exitCode: program.exitCode ?? 0, stdout: program.stdout ?? "", stderr: program.stderr ?? "" };
    }
    // Its options, checked against what it implements: one it doesn't take is refused in
    // the tool's own words, never ignored.
    const spec = OPTIONS[name];
    if (spec) {
      const unknown = (text: string): ExecResult =>
        this.refuse(written, `\`${name}\` is simulated without \`${text}\``, spec.builtin ? fail(2, `sh: 1: ${name}: Illegal option ${text.slice(0, 2)}`) : fail(spec.code ?? 1, `${name}: ${text.startsWith("--") ? `unrecognized option '${text}'` : `invalid option -- '${text.slice(1)}'`}\nTry '${name} --help' for more information.`));
      for (let k = 0; k < args.length; k++) {
        const a = args[k]!;
        if (a === "--") break;
        if (a.startsWith("--")) { if (!(spec.long ?? []).includes(a.slice(2).split("=")[0]!)) return unknown(a); continue; }
        if (!a.startsWith("-") || a === "-") continue;
        if (/^-\d+$/.test(a)) { if (!spec.numeric) return unknown(a.slice(0, 2)); continue; }
        for (let c = 1; c < a.length; c++) {
          if (!spec.short.includes(a[c]!)) return unknown(`-${a[c]}`);
          if ((spec.valued ?? "").includes(a[c]!)) { if (c === a.length - 1) k++; break; } // its value: the rest, or the next word
        }
      }
    }
    // Flags are the words before `--` that start with a dash; a word after a valued flag is its value.
    const dashes = args.indexOf("--");
    const optional = dashes < 0 ? args : args.slice(0, dashes);
    const valueAt = new Set<number>();
    optional.forEach((a, k) => { if (spec?.valued && /^-[A-Za-z]+$/.test(a) && spec.valued.includes(a.at(-1)!)) valueAt.add(k + 1); });
    const flags = optional.filter((a) => /^-[A-Za-z0-9]+$/.test(a) || /^--[a-z]/.test(a));
    const has = (letter: string) => flags.some((f) => !f.startsWith("--") && f.includes(letter));
    const operands = [...optional.filter((a, k) => !valueAt.has(k) && !(/^-[A-Za-z0-9]+$/.test(a) || /^--[a-z]/.test(a))), ...(dashes < 0 ? [] : args.slice(dashes + 1))];
    const errors: string[] = [];
    const done = (stdout: string, code = 1): ExecResult => ({ exitCode: errors.length ? code : 0, stdout, stderr: errors.length ? `${errors.join("\n")}\n` : "" });
    // The content of each operand (or stdin when there is none), for the reading commands.
    const inputs = (cmd: string): [string, string][] => {
      if (!operands.length) return [["", stdin]];
      const texts: [string, string][] = [];
      for (const p of operands) {
        const path = this.abs(p, st.cwd);
        const f = this.read(path);
        if (f !== undefined) texts.push([p, text(f)]);
        else errors.push(this.isDir(path) ? `${cmd}: ${p}: Is a directory` : `${cmd}: ${p}: No such file or directory`);
      }
      return texts;
    };
    const count = (flag: string, fallback: number): number => {
      const i = args.indexOf(flag);
      if (i >= 0 && args[i + 1] !== undefined) return Number(args[i + 1]);
      const joined = args.find((a) => a.startsWith(flag) && a.length > flag.length);
      return joined ? Number(joined.slice(flag.length)) : fallback;
    };
    const known = [...BUILTIN, ...COMMANDS, ...Object.keys(this.script.installed ?? {})];

    switch (name) {
      case ":":
      case "true": return ok();
      case "false": return { exitCode: 1, stdout: "", stderr: "" };
      case "sleep":
        if (operands.length !== 1 || !/^\d+(\.\d+)?[smh]?$/.test(operands[0]!)) return fail(1, operands.length ? `sleep: invalid time interval '${operands[0]}'` : "sleep: missing operand");
        return ok();
      case "set": {
        // -e, -u and -o pipefail (and +e, +u, +o pipefail), alone or together.
        for (let k = 0; k < args.length; k++) {
          const m = /^([-+])([euo]+)$/.exec(args[k]!);
          if (!m) return this.refuse(written, `\`set ${args[k]}\` isn't simulated (only -e, -u, -o pipefail)`, fail(2, `sh: 1: set: Illegal option ${args[k]!.slice(0, 2)}`));
          const on = m[1] === "-";
          if (m[2]!.includes("e")) st.errexit = on;
          if (m[2]!.includes("u")) st.nounset = on;
          if (m[2]!.includes("o")) {
            if (args[++k] !== "pipefail") return this.refuse(written, `\`set -o ${args[k] ?? ""}\` isn't simulated (only pipefail)`, fail(2, `sh: 1: set: Illegal option -o ${args[k] ?? ""}`));
            st.pipefail = on;
          }
        }
        return ok();
      }
      case "exec":
        return args.length ? this.run(args, stdin, st) : ok();
      case "export":
        for (const a of operands) if (a.includes("=")) st.env.set(a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1));
        return ok();
      case "unset":
        for (const a of operands) st.env.delete(a);
        return ok();
      case "env": {
        if (args[0]?.startsWith("-")) return this.refuse(written, `\`env ${args[0]}\` isn't simulated`, fail(125, `env: invalid option -- '${args[0].replace(/^-+/, "").slice(0, 1)}'\nTry 'env --help' for more information.`));
        const rest = [...args];
        const extra: [string, string][] = [];
        while (rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) { const w = rest.shift()!; extra.push([w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]); }
        if (!rest.length) return ok([...st.env, ...extra].map(([k, v]) => `${k}=${v}\n`).join(""));
        const saved = extra.map(([k]) => [k, st.env.get(k)] as const);
        for (const [k, v] of extra) st.env.set(k, v);
        const r = this.run(rest, stdin, st);
        for (const [k, v] of saved) v === undefined ? st.env.delete(k) : st.env.set(k, v);
        return r;
      }
      case "time": {
        if (!args.length) return ok();
        if (args[0]!.startsWith("-")) return this.refuse(written, `\`time ${args[0]}\` isn't simulated`, fail(127, `sh: 1: ${args[0]}: not found`));
        const r = this.run(args, stdin, st);
        return { ...r, stderr: `${r.stderr}\nreal\t0m0.214s\nuser\t0m0.162s\nsys\t0m0.041s\n` };
      }
      case "echo": {
        // -n, -e and the two together; any other first word is text, as echo prints it.
        const opt = /^-[ne]+$/.test(args[0] ?? "") ? args[0]! : "";
        const body = (opt ? args.slice(1) : args).join(" ");
        const escaped = opt.includes("e") ? body.replace(/\\([ntr\\])/g, (_m, c: string) => ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[c]!) : body;
        return ok(escaped + (opt.includes("n") ? "" : "\n"));
      }
      case "printf": {
        const [format, ...rest] = args;
        if (format === undefined) return fail(2, "sh: 1: printf: usage: printf format [arg ...]");
        if (format.startsWith("-") && format !== "--") return this.refuse(written, `\`printf ${format}\` isn't simulated`, fail(2, `sh: 1: printf: Illegal option ${format.slice(0, 2)}`));
        // %s, %d and %%; \\n, \\t, \\\\. Anything else isn't formatted here, so isn't printed wrong.
        const directive = /%(.)/g;
        for (const m of format.matchAll(directive)) if (!"sd%".includes(m[1]!)) return this.refuse(written, `printf's \`%${m[1]}\` isn't simulated (only %s, %d, %%)`, fail(1, `sh: 1: printf: %${m[1]}: invalid directive`));
        const consumes = (format.replace(/%%/g, "").match(/%[sd]/g) ?? []).length;
        const once = (argv: string[]): string | ExecResult => {
          let k = 0, bad: string | undefined;
          const out = format.replace(/\\([ntr\\])|%([sd%])/g, (_m, esc?: string, d?: string) => {
            if (esc) return ({ n: "\n", t: "\t", r: "\r", "\\": "\\" })[esc]!;
            if (d === "%") return "%";
            const v = argv[k++] ?? (d === "d" ? "0" : "");
            if (d === "d" && !/^-?\d+$/.test(v)) bad ??= v;
            return v;
          });
          return bad === undefined ? out : fail(1, `sh: 1: printf: ${bad}: expected numeric value`);
        };
        // The format is reused until the arguments run out.
        let out = "";
        for (let k = 0; k === 0 || (consumes > 0 && k < rest.length); k += Math.max(1, consumes)) {
          const piece = once(rest.slice(k, k + consumes));
          if (typeof piece !== "string") return piece;
          out += piece;
        }
        return ok(out);
      }
      case "pwd": return ok(`${st.cwd}\n`);
      case "whoami": return ok("root\n");
      case "hostname": return ok("sandbox\n");
      case "uname": {
        if (operands.length) return fail(1, `uname: extra operand '${operands[0]}'\nTry 'uname --help' for more information.`);
        const parts = has("a") ? ["Linux", "sandbox", "6.8.0", "#1 SMP", "x86_64", "GNU/Linux"] : [(has("s") || !flags.length) && "Linux", has("n") && "sandbox", has("r") && "6.8.0", has("m") && "x86_64"].filter(Boolean);
        return ok(`${parts.join(" ")}\n`);
      }
      case "date":
        if (operands.length) return this.refuse(written, "`date` is simulated without arguments", fail(1, `date: invalid date '${operands[0]}'`));
        return ok("Thu Nov 19 10:00:00 UTC 2026\n");
      case "basename": return ok(`${(operands[0] ?? "").split("/").filter(Boolean).at(-1) ?? ""}\n`);
      case "dirname": return ok(`${(operands[0] ?? "").includes("/") ? (operands[0]!.slice(0, operands[0]!.lastIndexOf("/")) || "/") : "."}\n`);
      case "cd": {
        const to = this.abs(operands[0] ?? "/root", st.cwd);
        if (!this.isDir(to)) return fail(2, `sh: 1: cd: can't cd to ${operands[0]}`);
        st.cwd = to;
        return ok();
      }
      case "mkdir":
        if (!operands.length) return fail(1, "mkdir: missing operand\nTry 'mkdir --help' for more information.");
        for (const p of operands) {
          const path = this.abs(p, st.cwd);
          const parent = path.slice(0, path.lastIndexOf("/")) || "/";
          if (this.read(path) !== undefined || (this.isDir(path) && !has("p"))) errors.push(`mkdir: cannot create directory '${p}': File exists`);
          else if (!has("p") && !this.isDir(parent)) errors.push(`mkdir: cannot create directory '${p}': No such file or directory`);
          else this.dirs.add(path);
        }
        return done("");
      case "touch":
        for (const p of operands) if (!this.files.has(this.abs(p, st.cwd))) this.write(this.abs(p, st.cwd), "");
        return ok();
      case "rm":
        for (const p of operands) {
          const path = this.abs(p, st.cwd);
          if (this.files.delete(path)) continue;
          if (this.isDir(path) && (has("r") || has("R"))) {
            for (const f of this.under(path)) this.files.delete(f);
            for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
          } else if (!has("f")) errors.push(this.isDir(path) ? `rm: cannot remove '${p}': Is a directory` : `rm: cannot remove '${p}': No such file or directory`);
        }
        return done("");
      case "cp":
      case "mv": {
        if (operands.length < 2) return fail(1, `${name}: missing destination file operand after '${operands[0] ?? ""}'`);
        const dest = this.abs(operands.at(-1)!, st.cwd);
        const into = this.isDir(dest);
        if (operands.length > 2 && !into) return fail(1, `${name}: target '${operands.at(-1)}' is not a directory`);
        for (const p of operands.slice(0, -1)) {
          const from = this.abs(p, st.cwd);
          const to = into ? `${dest}/${from.split("/").at(-1)}` : dest;
          const moved: [string, string][] = [];
          if (this.files.has(from)) moved.push([from, to]);
          else if (this.isDir(from)) {
            if (name === "cp" && !has("r") && !has("R") && !has("a")) { errors.push(`cp: -r not specified; omitting directory '${p}'`); continue; }
            for (const f of this.under(from)) moved.push([f, `${to}${f.slice(from.length)}`]);
          } else { errors.push(`${name}: cannot stat '${p}': No such file or directory`); continue; }
          for (const [a, b] of moved) {
            this.write(b, this.files.get(a)!);
            if (this.executable.has(a)) this.executable.add(b);
            if (name === "mv") { this.files.delete(a); this.executable.delete(a); }
          }
        }
        return done("");
      }
      case "chmod": {
        // The mode is the first word (it may start with a dash: -x), unless that is -R.
        const words = args[0] === "-R" ? args.slice(1) : args;
        const [mode, ...paths] = words;
        if (mode === undefined || !paths.length) return fail(1, `chmod: missing operand${mode === undefined ? "" : ` after '${mode}'`}\nTry 'chmod --help' for more information.`);
        const octal = /^[0-7]{3,4}$/.test(mode), symbolic = /^[ugoa]*[-+=][rwxX]*(,[ugoa]*[-+=][rwxX]*)*$/.test(mode);
        if (!octal && !symbolic) return fail(1, `chmod: invalid mode: '${mode}'\nTry 'chmod --help' for more information.`);
        for (const p of paths) {
          const path = this.abs(p, st.cwd);
          if (this.read(path) === undefined && !this.isDir(path)) { errors.push(`chmod: cannot access '${p}': No such file or directory`); continue; }
          if (octal) Number(mode.at(-3)) & 1 ? this.executable.add(path) : this.executable.delete(path);
          else for (const clause of mode.split(",")) {
            const m = /^([ugoa]*)([-+=])([rwxX]*)$/.exec(clause)!;
            if (m[1] !== "" && !/[ua]/.test(m[1]!)) continue; // group and other bits aren't shown apart from the owner's
            if (m[2] === "+" && /x/i.test(m[3]!)) this.executable.add(path);
            else if (m[2] === "-" && /x/i.test(m[3]!)) this.executable.delete(path);
            else if (m[2] === "=") /x/i.test(m[3]!) ? this.executable.add(path) : this.executable.delete(path);
          }
        }
        return done("");
      }
      case "tee": {
        for (const p of operands) {
          const path = this.abs(p, st.cwd);
          this.write(path, (has("a") ? text(this.files.get(path) ?? "") : "") + stdin);
        }
        return ok(stdin);
      }
      case "type": {
        const out: string[] = [];
        for (const p of operands) {
          if (BUILTIN.includes(p)) out.push(`${p} is a shell builtin`);
          else if (known.includes(p)) out.push(`${p} is /usr/bin/${p}`);
          else errors.push(`${p}: not found`);
        }
        return done(out.length ? `${out.join("\n")}\n` : "");
      }
      case "which":
      case "command": {
        const found: string[] = [];
        let code = 0;
        for (const p of operands) {
          if (known.includes(p)) found.push(BUILTIN.includes(p) && name !== "which" ? p : `/usr/bin/${p}`);
          else code = 1;
        }
        return { exitCode: code, stdout: found.length ? `${found.join("\n")}\n` : "", stderr: "" };
      }
      case "test":
      case "[": {
        if (name === "[" && args.at(-1) !== "]") return fail(2, "sh: 1: [: missing ]");
        const a = name === "[" ? args.slice(0, -1) : [...args];
        let negate = false;
        while (a[0] === "!") { negate = !negate; a.shift(); }
        const bad = (op: string) => this.refuse(written, `\`${name}\`'s \`${op}\` isn't simulated`, fail(2, `sh: 1: ${name}: ${op}: unexpected operator`));
        const num = (v: string) => (/^-?\d+$/.test(v) ? Number(v) : undefined);
        let yes: boolean;
        if (a.length === 0) yes = false;
        else if (a.length === 1) yes = a[0] !== "";
        else if (a.length === 2) {
          const path = this.abs(a[1]!, st.cwd);
          const f = this.read(path);
          switch (a[0]) {
            case "-f": yes = f !== undefined; break;
            case "-d": yes = this.isDir(path); break;
            case "-e": yes = f !== undefined || this.isDir(path); break;
            case "-r": case "-w": yes = f !== undefined || this.isDir(path); break;
            case "-x": yes = this.executable.has(path) || this.isDir(path); break;
            case "-s": yes = f !== undefined && size(f) > 0; break;
            case "-n": yes = a[1] !== ""; break;
            case "-z": yes = a[1] === ""; break;
            default: return bad(a[0]!);
          }
        } else if (a.length === 3) {
          const [l, op, r] = a as [string, string, string];
          if (op === "=" || op === "==") yes = l === r;
          else if (op === "!=") yes = l !== r;
          else if (["-eq", "-ne", "-gt", "-ge", "-lt", "-le"].includes(op)) {
            const x = num(l), y = num(r);
            if (x === undefined || y === undefined) return fail(2, `sh: 1: ${name}: Illegal number: ${x === undefined ? l : r}`);
            yes = op === "-eq" ? x === y : op === "-ne" ? x !== y : op === "-gt" ? x > y : op === "-ge" ? x >= y : op === "-lt" ? x < y : x <= y;
          } else return bad(op);
        } else return bad(a.find((w) => w === "-a" || w === "-o") ?? a[1]!);
        return { exitCode: yes !== negate ? 0 : 1, stdout: "", stderr: "" };
      }
      case "ls": {
        const all = has("a") || has("A"), long = has("l");
        const entry = (path: string, label: string) => {
          if (!long) return label;
          const f = this.read(path);
          const human = (n: number) => (!has("h") || n < 1024 ? String(n) : `${(n / 1024).toFixed(1)}K`);
          return f === undefined ? `drwxr-xr-x 2 root root ${human(4096).padStart(5)} Nov 19 10:00 ${label}` : `${this.executable.has(path) ? "-rwxr-xr-x" : "-rw-r--r--"} 1 root root ${human(size(f)).padStart(5)} Nov 19 10:00 ${label}`;
        };
        const targets = operands.length ? operands : ["."];
        const out: string[] = [];
        for (const p of targets) {
          const path = this.abs(p, st.cwd);
          if (this.read(path) !== undefined) { out.push(entry(path, p)); continue; }
          if (!this.isDir(path)) { errors.push(`ls: cannot access '${p}': No such file or directory`); continue; }
          if (targets.length > 1) out.push(`${out.length ? "\n" : ""}${p}:`);
          // -t: every file here has the one mtime, so the order is the names'. -r reverses it.
          const names = this.children(path).filter((n) => all || !n.startsWith("."));
          if (has("r")) names.reverse();
          if (long) out.push(`total ${names.length * 4}`);
          if (all) out.push(entry(path, "."), entry(path, ".."));
          for (const n of names) out.push(entry(`${path === "/" ? "" : path}/${n}`, n));
        }
        return done(out.length ? `${out.join("\n")}\n` : "", 2);
      }
      case "cat": {
        let out = inputs("cat").map(([, t]) => t).join("");
        if (has("A") || has("E")) out = out.replace(/\t/g, "^I").replace(/\n/g, "$\n");
        if (has("n")) out = lines(out).map((l, i) => `${String(i + 1).padStart(6)}\t${l}\n`).join("");
        return done(out);
      }
      case "sort": {
        let rows = lines(inputs("sort").map(([, t]) => t).join(""));
        rows = has("n") ? rows.sort((x, y) => (parseFloat(x) || 0) - (parseFloat(y) || 0) || x.localeCompare(y)) : rows.sort();
        if (has("u")) rows = rows.filter((l, k) => k === 0 || l !== rows[k - 1]);
        if (has("r")) rows.reverse();
        return done(rows.map((l) => `${l}\n`).join(""), 2);
      }
      case "head":
      case "tail": {
        // The count: -n N, -nN, -N (lines) or -c N (bytes). `tail -n +N` is from line N on;
        // `head -n -N` is all but the last N.
        // `-5` is a count of its own, unless it is the value of -n or -c (`head -n -5`).
        const numeric = args.find((a, k) => /^-\d+$/.test(a) && !/^-[a-z]*[nc]$/.test(args[k - 1] ?? ""));
        const bytes = flags.some((f) => /^-[a-z]*c/.test(f));
        const letter = bytes ? "c" : "n";
        const at = args.findIndex((a) => /^-[a-z]+$/.test(a) && a.endsWith(letter));
        const joined = args.find((a) => new RegExp(`^-${letter}.+`).test(a));
        const raw = numeric ? numeric.slice(1).replace(/^-/, "") : joined ? joined.slice(2) : at >= 0 ? args[at + 1] : "10";
        if (raw === undefined || !/^[-+]?\d+$/.test(raw)) return fail(1, `${name}: invalid number of ${bytes ? "bytes" : "lines"}: '${raw ?? ""}'`);
        const n = Math.abs(Number(raw));
        const fromLine = name === "tail" && raw.startsWith("+"), allBut = name === "head" && raw.startsWith("-");
        const texts: [string, string][] = [];
        if (!operands.length) texts.push(["", stdin]);
        for (const p of operands) {
          const f = this.read(this.abs(p, st.cwd));
          if (f === undefined) errors.push(`${name}: cannot open '${p}' for reading: No such file or directory`);
          else texts.push([p, text(f)]);
        }
        const cut = (t: string) => {
          if (bytes) return fromLine ? t.slice(Math.max(0, n - 1)) : allBut ? t.slice(0, Math.max(0, t.length - n)) : name === "head" ? t.slice(0, n) : n ? t.slice(-n) : "";
          const ls = lines(t);
          const kept = fromLine ? ls.slice(Math.max(0, n - 1)) : allBut ? ls.slice(0, Math.max(0, ls.length - n)) : name === "head" ? ls.slice(0, n) : n ? ls.slice(-n) : [];
          return kept.map((l) => `${l}\n`).join("");
        };
        return done(texts.map(([p, t]) => (texts.length > 1 ? `==> ${p} <==\n` : "") + cut(t)).join(""));
      }
      case "wc": {
        const texts = inputs("wc");
        const l = has("l"), c = has("c"), w = has("w"), m = has("m");
        const row = (p: string, t: string) => {
          const counts = [(t.match(/\n/g) ?? []).length, t.split(/\s+/).filter(Boolean).length, Buffer.byteLength(t, "latin1")];
          const picked = l || c || w || m ? [l && counts[0], w && counts[1], m && [...Buffer.from(t, "latin1").toString("utf8")].length, c && counts[2]].filter((x) => x !== false) : counts;
          return `${picked.join(" ")}${p ? ` ${p}` : ""}\n`;
        };
        return done(texts.map(([p, t]) => row(p, t)).join(""));
      }
      case "sed": {
        const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(operands[0] ?? "");
        if (!flags.includes("-n") || !m) {
          const script = operands[0] ?? "";
          const at = Math.max(1, script.search(/[A-Za-z]/) + 1);
          return this.refuse(written, "sed is simulated only as `sed -n 'N,Mp'`", flags.some((f) => f !== "-n") ? fail(1, `sed: invalid option -- '${flags.find((f) => f !== "-n")!.slice(1, 2)}'\nUsage: sed [OPTION]... {script-only-if-no-other-script} [input-file]...`) : fail(1, `sed: -e expression #1, char ${at}: unknown command: \`${script[at - 1] ?? ""}'`));
        }
        const f = operands[1] === undefined ? stdin : this.read(this.abs(operands[1], st.cwd));
        if (f === undefined) return fail(2, `sed: can't read ${operands[1]}: No such file or directory`);
        const ls = lines(text(f));
        const to = m[2] === undefined ? Number(m[1]) : m[2] === "$" ? ls.length : Number(m[2]);
        return ok(ls.slice(Number(m[1]) - 1, to).map((x) => `${x}\n`).join(""));
      }
      case "file": {
        const out = operands.map((p) => {
          const f = this.read(this.abs(p, st.cwd));
          if (f === undefined) return this.isDir(this.abs(p, st.cwd)) ? `${p}: directory` : `${p}: cannot open \`${p}' (No such file or directory)`;
          const b = typeof f === "string" ? Buffer.from(f) : Buffer.from(f);
          if (b.length >= 4 && b.subarray(0, 4).toString("latin1") === "\u007fELF") return `${p}: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, stripped`;
          if (b.length > 24 && b.subarray(1, 4).toString("latin1") === "PNG") return `${p}: PNG image data, ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}, 8-bit/color RGB, non-interlaced`;
          if (b.subarray(0, 2).toString() === "#!") return `${p}: POSIX shell script, ASCII text executable`;
          return `${p}: ${b.length ? (/\.json$/.test(p) ? "JSON text data" : "ASCII text") : "empty"}`;
        });
        return ok(`${out.join("\n")}\n`);
      }
      case "find": {
        // find [path...] [-name GLOB] [-type f|d] [-maxdepth N]: each path printed under the
        // start point as it was given (`src/widgets.ts` for `find src`).
        const starts: string[] = [];
        let k = 0;
        while (k < args.length && !args[k]!.startsWith("-")) starts.push(args[k++]!);
        let pattern: RegExp | undefined, kind: string | undefined, depth = Infinity;
        for (; k < args.length; k += 2) {
          const pred = args[k]!, v = args[k + 1];
          const refused = (said: string) => this.refuse(written, `find's \`${pred}\` isn't simulated (only -name, -type f|d, -maxdepth)`, fail(1, said));
          if (!["-name", "-type", "-maxdepth"].includes(pred)) return refused(`find: unknown predicate \`${pred}'`);
          if (v === undefined) return fail(1, `find: missing argument to \`${pred}'`);
          if (pred === "-name") pattern = glob(v);
          else if (pred === "-type") { if (v !== "f" && v !== "d") return refused(`find: Unknown argument to -type: ${v}`); kind = v; }
          else { if (!/^\d+$/.test(v)) return fail(1, `find: Expected a positive decimal integer argument to -maxdepth, but got ‘${v}’`); depth = Number(v); }
        }
        const out: string[] = [];
        for (const start of starts.length ? starts : ["."]) {
          const root = this.abs(start, st.cwd);
          if (this.read(root) !== undefined) { if (kind !== "d" && (!pattern || pattern.test(root.split("/").at(-1)!))) out.push(start); continue; }
          if (!this.isDir(root)) { errors.push(`find: ‘${start}’: No such file or directory`); continue; }
          const files = this.under(root);
          const dirs = [...new Set(files.flatMap((f) => { const parts = f.slice(root.length + 1).split("/").slice(0, -1); return parts.map((_x, n) => `${root}/${parts.slice(0, n + 1).join("/")}`); }))];
          const entries = [...(kind === "d" ? [] : files.map((f) => [f, "f"] as const)), ...(kind === "f" ? [] : [[root, "d"] as const, ...dirs.map((d) => [d, "d"] as const)])];
          const base = start.replace(/\/+$/, "") || "/";
          for (const [path] of entries.sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
            const rel = path === root ? "" : path.slice(root === "/" ? 1 : root.length + 1);
            if (rel !== "" && rel.split("/").length > depth) continue;
            if (pattern && !pattern.test(rel === "" ? base.split("/").at(-1)! : rel.split("/").at(-1)!)) continue;
            out.push(rel === "" ? base : `${base === "/" ? "" : base}/${rel}`);
          }
        }
        return done(out.map((l) => `${l}\n`).join(""));
      }
      case "grep": return this.grep(args, stdin, st.cwd, false, written);
      case "git": return this.git(args, stdin, st, written);
    }
    const versions = this.script.installed ?? {};
    if (name in versions) {
      if (args.length === 1 && ["--version", "-V", "-v", "version"].includes(args[0]!)) return ok(`${versions[name]}\n`);
      return this.refuse(written, `\`${name}\` is simulated only for the repository's own scripts and targets (its \`programs\`), not for \`${written.slice(0, 120)}\``, this.denied(name, args, st.cwd));
    }
    if (name.includes("/")) {
      // A path: there or not, as a shell says. A file of the checkout that no rule runs can't be run here.
      if (this.read(this.abs(name, st.cwd)) === undefined) return fail(127, `sh: 1: ${name}: not found`);
      return this.refuse(written, `\`${name}\` isn't one of the scripts the case's \`programs\` run`, fail(126, `sh: 1: ${name}: Permission denied`));
    }
    return this.refuse(written, `\`${name}\` isn't simulated`, fail(127, `sh: 1: ${name}: not found`));
  }

  // grep [-inrRlcvoqEFwHhs] [-A n] [-B n] [-C n] [-e PATTERN] PATTERN [FILE...]. Any other
  // option is refused in grep's own words: one that changed which lines match, ignored,
  // would be a wrong answer.
  private grep(args: string[], stdin: string, cwd: string, tracked: boolean, written = `grep ${args.join(" ")}`): ExecResult {
    let after = 0, before = 0;
    const flags = new Set<string>();
    const plain: string[] = [];
    let pattern: string | undefined;
    const unknown = (text: string) => this.refuse(written, `\`grep\` is simulated without \`${text}\``, fail(2, `grep: ${text.startsWith("--") ? `unrecognized option '${text}'` : `invalid option -- '${text.slice(1)}'`}\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.`));
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === "--") { plain.push(...args.slice(i + 1)); break; }
      if (a.startsWith("--")) {
        if (a === "--color" || a.startsWith("--color=")) continue; // there is no color here either way
        return unknown(a);
      }
      if (!a.startsWith("-") || a === "-") { plain.push(a); continue; }
      for (let c = 1; c < a.length; c++) {
        const ch = a[c]!;
        if ("ABCe".includes(ch)) {
          const v = c < a.length - 1 ? a.slice(c + 1) : args[++i];
          if (v === undefined) return fail(2, `grep: option requires an argument -- '${ch}'`);
          if (ch === "e") pattern = pattern === undefined ? v : `${pattern}\n${v}`;
          else {
            if (!/^\d+$/.test(v)) return fail(2, `grep: ${v}: invalid context length argument`);
            if (ch !== "B") after = Number(v);
            if (ch !== "A") before = Number(v);
          }
          break;
        }
        if (!"inrRlcvoqEFwHhs".includes(ch)) return unknown(`-${ch}`);
        flags.add(ch);
      }
    }
    const has = (ch: string) => flags.has(ch);
    if (pattern === undefined) pattern = plain.shift();
    const paths = plain;
    if (pattern === undefined) return fail(2, "Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.");
    let re: RegExp;
    try {
      // grep's basic patterns: ( ) { } | + ? are themselves unless escaped, the reverse of -E.
      const basic = (p: string) => p.replace(/\\?[(){}|+?]/g, (m) => (m.length === 2 ? m[1]! : `\\${m}`));
      const one = (p: string) => (has("F") ? p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : has("E") ? p : basic(p));
      const source = pattern.split("\n").map(one).join("|");
      // The pattern is the model's, and it runs in the runner's own process, beside the
      // proxy and the other trials: one that could take forever to fail (a repeated group
      // or an alternation inside a repeated group: `(a+)+$`, `(a|aa)+$`) or is very long is
      // not run at all.
      if (pattern.length > MAX_PATTERN || /\((?:[^()\\]|\\.)*[+*|](?:[^()\\]|\\.)*\)[+*{]/.test(source)) {
        return this.refuse(written, "a pattern this long, or with a repeat or an alternation inside a repeated group, isn't run: it could stall the runner", fail(2, "grep: regular expression is too large"));
      }
      re = new RegExp(has("w") ? `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])` : source, `g${has("i") ? "i" : ""}`);
    } catch {
      return fail(2, "grep: Unmatched ( or \\(");
    }
    const recursive = has("r") || has("R");
    const sources: [string, string][] = [];
    if (tracked) {
      const roots = paths.length ? paths.map((p) => this.abs(p, cwd)) : [WORKDIR];
      for (const f of this.under(WORKDIR)) if (roots.some((r) => f === r || f.startsWith(`${r}/`))) sources.push([f.slice(WORKDIR.length + 1), text(this.files.get(f)!)]);
    } else if (!paths.length && !recursive) sources.push(["", stdin]);
    else for (const p of paths.length ? paths : ["."]) {
      const path = this.abs(p, cwd);
      const f = this.read(path);
      if (f !== undefined) sources.push([p, text(f)]);
      else if (this.isDir(path)) {
        if (!recursive) { if (!has("s")) return fail(2, `grep: ${p}: Is a directory`); continue; }
        for (const child of this.under(path)) sources.push([`${p === "." ? "" : `${p.replace(/\/$/, "")}/`}${child.slice(path.length + 1)}`, text(this.files.get(child)!)]);
      } else if (!has("s")) return fail(2, `grep: ${p}: No such file or directory`);
    }
    if (sources.reduce((n, [, t]) => n + t.length, 0) > MAX_GREP_INPUT) return this.refuse(written, "this much input isn't searched (the search runs in the runner's own process)", fail(2, "grep: memory exhausted"));
    // The file's name before each line: with several files, or -H; never with -h.
    const named = !has("h") && (has("H") || sources.length > 1 || tracked || recursive) && !(sources.length === 1 && sources[0]![0] === "");
    const out: string[] = [];
    let any = false;
    for (const [p, t] of sources) {
      if (t.includes("\u0000")) continue; // binary
      const all = lines(t);
      const matches = all.map((l) => [...l.matchAll(re)].map((m) => m[0]).filter((m) => m !== ""));
      const hits = all.map((l, n) => (matches[n]!.length > 0 || (l === "" && new RegExp(re.source, re.flags.replace("g", "")).test(l))) !== has("v"));
      const count = hits.filter(Boolean).length;
      if (count) any = true;
      if (has("c")) { out.push(`${named ? `${p}:` : ""}${count}`); continue; }
      if (has("l")) { if (count) out.push(p); continue; }
      all.forEach((l, n) => {
        const near = !hits[n] && (after || before) && hits.some((h, k) => h && ((k < n && n - k <= after) || (k > n && k - n <= before)));
        if (!hits[n] && !near) return;
        const sep = hits[n] ? ":" : "-";
        const prefix = `${named ? `${p}${sep}` : ""}${has("n") ? `${n + 1}${sep}` : ""}`;
        // -o: each match on a line of its own (and nothing of the lines around).
        if (has("o")) { if (hits[n] && !has("v")) for (const m of matches[n]!) out.push(`${prefix}${m}`); return; }
        out.push(`${prefix}${l}`);
      });
    }
    return { exitCode: any ? 0 : 1, stdout: has("q") ? "" : out.map((l) => `${l}\n`).join(""), stderr: "" };
  }

  // ── git ──
  // The checkout as a clone of `url` leaves it: that repo's files, on `branch`.
  private checkout(name: string, url: string, branch = "main"): void {
    const script = this.script.repos[name]!;
    const tree: Tree = new Map(Object.entries(script.files));
    for (const [rel, content] of tree) {
      this.write(`${WORKDIR}/${rel}`, content);
      if (rel.endsWith(".sh")) this.executable.add(`${WORKDIR}/${rel}`);
    }
    const who = "A. Maintainer <maintainer@example.com>";
    const first: Commit = { sha: sha1(`${name}:first`), subject: "Initial commit", message: "Initial commit", author: who, committer: who, tree: new Map([...tree].filter(([p]) => !p.includes("/"))) };
    const tip: Commit = { sha: sha1(`${name}:tip`), subject: "Add sources, tests and scripts", message: "Add sources, tests and scripts", author: who, committer: who, parent: first, tree };
    this.repo = { name, url, branch, branches: new Map([[branch, tip]]), origin: tip, staged: new Map(), config: new Map(), programs: script.programs ?? [] };
  }

  private head(): Commit {
    return this.repo!.branches.get(this.repo!.branch)!;
  }
  private worktree(): Tree {
    const tree: Tree = new Map();
    for (const f of this.under(WORKDIR)) tree.set(f.slice(WORKDIR.length + 1), this.files.get(f)!);
    return tree;
  }
  // What `git status` lists: each path that differs from HEAD, or isn't in it.
  private changes(): { path: string; kind: "modified" | "untracked" | "deleted" }[] {
    const head = this.head().tree;
    return changesBetween(head, this.worktree()).map((c) => ({ path: c.path, kind: c.before === undefined ? ("untracked" as const) : c.after === undefined ? ("deleted" as const) : ("modified" as const) }));
  }
  private ancestors(c: Commit | undefined): Commit[] {
    const out: Commit[] = [];
    for (let x = c; x; x = x.parent) out.push(x);
    return out;
  }
  // A commit by name: HEAD, HEAD~n, HEAD^, a branch, origin/<branch>, or a commit id.
  private rev(name: string): Commit | undefined {
    const repo = this.repo!;
    const m = /^(.*?)(?:~(\d+)|(\^+))?$/.exec(name)!;
    const base = m[1] === "HEAD" || m[1] === "@" ? this.head() : repo.branches.get(m[1]!) ?? (/^origin\/(HEAD|main)$/.test(m[1]!) ? repo.origin : undefined) ?? (/^[0-9a-f]{4,40}$/.test(m[1]!) ? [...repo.branches.values(), repo.origin].flatMap((c) => this.ancestors(c)).find((c) => c.sha.startsWith(m[1]!)) : undefined);
    let c = base;
    for (let n = m[2] ? Number(m[2]) : (m[3]?.length ?? 0); n > 0 && c; n--) c = c.parent;
    return c;
  }

  // What the host would stage for a pull request against `base`: the commits HEAD has that
  // GitHub's `base` doesn't, and the diff they make.
  publishable(base: string): Publishable {
    const repo = this.repo;
    if (!repo) return { status: 409, error: `${WORKDIR} isn't a git checkout: clone the repo first (workspace_clone)` };
    if (base !== "main") return { status: 409, error: `the base branch ${base} isn't on GitHub` };
    const onGithub = new Set(this.ancestors(repo.origin).map((c) => c.sha));
    const ahead = this.ancestors(this.head()).filter((c) => !onGithub.has(c.sha));
    if (!ahead.length) return { status: 409, error: "no commits to publish: HEAD has nothing that isn't on GitHub already (commit first?)" };
    const changes = changesBetween(repo.origin.tree, this.head().tree);
    const stat = diffStat(changes);
    return {
      sha: this.head().sha, baseSha: repo.origin.sha, commits: ahead.length,
      stat: `${stat.rows.join("\n")}\n${stat.summary}\n`,
      authors: ahead.reverse().map((c) => `${c.author}|${c.committer}`),
      files: changes.map((c) => c.path), patch: patchOf(changes),
    };
  }

  private git(all: string[], stdin: string, st: State, written: string): ExecResult {
    const args = [...all];
    let cwd = st.cwd;
    // Whether the command carries Lorehouse's credential helper (src/tools/git-credential.ts):
    // only workspace_clone's own clone and fetch do, and only they reach GitHub.
    let authed = false;
    while (args[0] === "-c" || args[0] === "-C" || args[0] === "--no-pager") {
      if (args[0] === "--no-pager") { args.splice(0, 1); continue; }
      if (args[0] === "-C") cwd = this.abs(args[1] ?? ".", cwd);
      else if ((args[1] ?? "").startsWith("credential.helper=!")) authed = true;
      args.splice(0, 2);
    }
    const NO_ACCESS = "fatal: could not read Username for 'https://github.com': No such device or address";
    const [sub, ...rest] = args;
    if (sub === "--version" || sub === "version") return ok("git version 2.43.0\n");
    if (sub === "clone") {
      const valued = ["--branch", "-b", "--depth", "--origin"];
      const operands = rest.filter((a, i) => !a.startsWith("-") && !valued.includes(rest[i - 1] ?? ""));
      const [url, dest] = operands;
      const at = rest.findIndex((a) => a === "--branch" || a === "-b");
      if (!url) return fail(129, "usage: git clone [<options>] [--] <repo> [<dir>]");
      const to = this.abs(dest ?? url.split("/").at(-1)!.replace(/\.git$/, ""), cwd);
      if (to !== WORKDIR) return fail(128, `fatal: could not create work tree dir '${dest ?? to}': Permission denied`);
      if (this.repo) return fail(128, `fatal: destination path '${dest}' already exists and is not an empty directory.`);
      if (!authed) return fail(128, `Cloning into '${to}'...\n${NO_ACCESS}`);
      const name = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1]?.toLowerCase() ?? "";
      if (!this.script.repos[name]) return fail(128, `Cloning into '${to}'...\nremote: Repository not found.\nfatal: repository '${url}' not found`);
      this.checkout(name, url, at >= 0 ? rest[at + 1] : undefined);
      return { exitCode: 0, stdout: "", stderr: `Cloning into '${to}'...\n` };
    }
    const repo = this.repo;
    if (!repo || !(cwd === WORKDIR || cwd.startsWith(`${WORKDIR}/`))) return fail(128, "fatal: not a git repository (or any of the parent directories): .git");
    const dashes = rest.indexOf("--");
    // Options are the words before `--` that start with a dash; a lone "-" (stdin) and the
    // word after an option that takes a value (a message, a count) are not.
    const valued = /^(-[a-zA-Z]*[mF]|--message|--file|-n)$/;
    const before = dashes < 0 ? rest : rest.slice(0, dashes);
    const isValue = (k: number) => k > 0 && valued.test(before[k - 1]!) && (sub === "commit" || sub === "log");
    const flags = before.filter((a, k) => a.startsWith("-") && a !== "-" && !isValue(k));
    const operands = [...before.filter((a, k) => (!a.startsWith("-") || a === "-") && !(isValue(k) && sub === "commit")), ...(dashes < 0 ? [] : rest.slice(dashes + 1))];
    const pathsAfterDashes = dashes < 0 ? undefined : rest.slice(dashes + 1);
    const rel = (p: string) => this.abs(p, cwd).slice(WORKDIR.length + 1);
    const flag = (...names: string[]) => flags.some((f) => names.includes(f));
    const head = this.head();
    const me = () => {
      const name = st.env.get("GIT_AUTHOR_NAME") ?? repo.config.get("user.name"), email = st.env.get("GIT_AUTHOR_EMAIL") ?? repo.config.get("user.email");
      const cn = st.env.get("GIT_COMMITTER_NAME") ?? name, ce = st.env.get("GIT_COMMITTER_EMAIL") ?? email;
      return name && email ? { author: `${name} <${email}>`, committer: `${cn} <${ce}>` } : undefined;
    };
    // The working tree as far as git tracks it: what HEAD has, as it is now, and what was added.
    const stage = (path: string) => repo.staged.set(path, this.files.get(`${WORKDIR}/${path}`) ?? null);
    // HEAD's tree with what was added laid over it: what a commit made now would hold.
    const index = (): Tree => {
      const tree: Tree = new Map(head.tree);
      for (const [path, content] of repo.staged) content === null ? tree.delete(path) : tree.set(path, content);
      return tree;
    };
    const tracked = (): Tree => {
      const work = this.worktree();
      const tree: Tree = new Map();
      for (const [p, v] of work) if (head.tree.has(p) || repo.staged.has(p)) tree.set(p, v);
      return tree;
    };
    const only = (changes: Change[], paths: string[] | undefined) => (paths?.length ? changes.filter((c) => paths.some((p) => c.path === rel(p) || c.path.startsWith(`${rel(p)}/`) || rel(p) === "")) : changes);
    const render = (changes: Change[]): ExecResult => {
      if (!changes.length) return ok("");
      if (flag("--name-only")) return ok(changes.map((c) => `${c.path}\n`).join(""));
      if (flag("--name-status")) return ok(changes.map((c) => `${c.before === undefined ? "A" : c.after === undefined ? "D" : "M"}\t${c.path}\n`).join(""));
      const s = diffStat(changes);
      if (flag("--shortstat")) return ok(`${s.summary}\n`);
      if (flag("--stat")) return ok(`${s.rows.join("\n")}\n${s.summary}\n`);
      return ok(patchOf(changes));
    };
    const header = (c: Commit) => `commit ${c.sha}\nAuthor: ${c.author}\nDate:   Thu Nov 19 10:00:00 2026 +0000\n\n${c.message.split("\n").map((l) => `    ${l}`).join("\n")}\n`;
    const parentTree = (c: Commit): Tree => c.parent?.tree ?? new Map();
    const unknown = (name: string) => fail(128, `fatal: ambiguous argument '${name}': unknown revision or path not in the working tree.`);
    // The options each command implements; another is refused as git refuses one it
    // doesn't know, never ignored.
    const allowed = GIT_OPTIONS[sub ?? ""];
    if (allowed) {
      const bad = flags.find((f) => !allowed.test(f));
      if (bad) return this.refuse(written, `\`git ${sub}\` is simulated without \`${bad}\``, fail(129, `error: unknown ${bad.startsWith("--") ? "option" : "switch"} \`${bad.replace(/^-+/, "").slice(0, bad.startsWith("--") ? 80 : 1)}'\nusage: git ${sub} [<options>]`));
    }

    switch (sub) {
      case "config": {
        if (flag("--list", "-l")) return ok([...repo.config].map(([k, v]) => `${k}=${v}\n`).join(""));
        if (operands.length >= 2) { repo.config.set(operands[0]!, operands.slice(1).join(" ")); return ok(); }
        const v = operands[0] ? repo.config.get(operands[0]) : undefined;
        return v === undefined ? { exitCode: 1, stdout: "", stderr: "" } : ok(`${v}\n`);
      }
      case "remote":
        if (operands[0] === "get-url") return ok(`${repo.url}\n`);
        return ok(flag("-v") ? `origin\t${repo.url} (fetch)\norigin\t${repo.url} (push)\n` : "origin\n");
      case "fetch":
        return authed ? ok() : fail(128, NO_ACCESS);
      case "pull":
      case "push":
        return fail(128, NO_ACCESS);
      case "ls-files": return ok([...tracked().keys()].sort().map((f) => `${f}\n`).join(""));
      case "grep": return this.grep(rest.filter((a) => a !== "--"), stdin, cwd, true);
      case "status": {
        const work = this.worktree(), idx = index();
        // For each path: X, the index against HEAD; Y, the file against the index.
        const rows = [...new Set([...head.tree.keys(), ...idx.keys(), ...work.keys()])].sort().flatMap((path) => {
          const h = head.tree.get(path), i = idx.get(path), w = work.get(path);
          if (h === undefined && i === undefined) return w === undefined ? [] : [{ path, x: "?", y: "?" }];
          const x = h === undefined ? "A" : i === undefined ? "D" : same(h, i) ? " " : "M";
          const y = i === undefined ? " " : w === undefined ? "D" : same(i, w) ? " " : "M";
          return x === " " && y === " " ? [] : [{ path, x, y }];
        });
        if (flag("--porcelain", "--short", "-s", "-sb")) return ok((flag("-sb") ? `## ${repo.branch}...origin/main\n` : "") + rows.map((r) => `${r.x}${r.y} ${r.path}\n`).join(""));
        const ahead = this.ancestors(head).filter((c) => !this.ancestors(repo.origin).includes(c)).length;
        const out = [`On branch ${repo.branch}`];
        if (repo.branch === "main") out.push(ahead ? `Your branch is ahead of 'origin/main' by ${ahead} commit${ahead === 1 ? "" : "s"}.\n` : "Your branch is up to date with 'origin/main'.\n");
        const word = (c: string) => (c === "A" ? "new file" : c === "D" ? "deleted" : "modified");
        const staged = rows.filter((r) => "AMD".includes(r.x)), unstaged = rows.filter((r) => "MD".includes(r.y)), untracked = rows.filter((r) => r.x === "?");
        if (staged.length) out.push("Changes to be committed:", '  (use "git restore --staged <file>..." to unstage)', ...staged.map((r) => `\t${word(r.x)}:   ${r.path}`), "");
        if (unstaged.length) out.push("Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', ...unstaged.map((r) => `\t${word(r.y)}:   ${r.path}`), "");
        if (untracked.length) out.push("Untracked files:", '  (use "git add <file>..." to include in what will be committed)', ...untracked.map((r) => `\t${r.path}`), "");
        if (!rows.length) out.push("nothing to commit, working tree clean");
        else if (!staged.length) out.push(unstaged.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing added to commit but untracked files present (use "git add" to track)');
        return ok(`${out.join("\n")}\n`);
      }
      case "add": {
        if (flag("-p", "--patch", "-i")) return this.refuse(written, "interactive staging isn't simulated", fail(129, `error: unknown option \`${flags.find((f) => ["-p", "--patch", "-i"].includes(f))!.replace(/^-+/, "")}'\nusage: git add [<options>] [--] <pathspec>...`));
        const changes = this.changes();
        const everything = flag("-A", "--all", "-u") || operands.includes(".");
        for (const p of operands.filter((o) => o !== ".")) {
          const path = rel(p);
          const under = changes.filter((c) => c.path === path || c.path.startsWith(`${path}/`));
          if (!under.length && !head.tree.has(path) && this.read(`${WORKDIR}/${path}`) === undefined && !this.isDir(`${WORKDIR}/${path}`)) return fail(128, `fatal: pathspec '${p}' did not match any files`);
          for (const c of under) stage(c.path);
          // Already added, then edited: the new content replaces the snapshot.
          for (const staged of [...repo.staged.keys()]) if (staged === path || staged.startsWith(`${path}/`)) stage(staged);
        }
        if (everything) {
          for (const c of changes) stage(c.path);
          for (const staged of [...repo.staged.keys()]) stage(staged);
        }
        return ok();
      }
      case "rm":
      case "mv": {
        if (sub === "rm") for (const p of operands) { this.files.delete(`${WORKDIR}/${rel(p)}`); stage(rel(p)); }
        else if (operands.length === 2) {
          const [a, b] = operands.map(rel) as [string, string];
          const f = this.files.get(`${WORKDIR}/${a}`);
          if (f === undefined) return fail(128, `fatal: bad source, source=${a}, destination=${b}`);
          this.write(`${WORKDIR}/${b}`, f);
          this.files.delete(`${WORKDIR}/${a}`);
          stage(a);
          stage(b);
        }
        return ok();
      }
      case "commit": {
        const changes = this.changes();
        // -a: every tracked file as it is now.
        if (flags.some((f) => /^-[a-zA-Z]*a[a-zA-Z]*$/.test(f) || f === "--all")) for (const c of changes) if (c.kind !== "untracked") stage(c.path);
        const messages: string[] = [];
        for (let k = 0; k < rest.length; k++) {
          const a = rest[k]!;
          if (/^-[a-z]*m$/.test(a) || a === "--message") { if (rest[k + 1] !== undefined) messages.push(rest[++k]!); }
          else if (a.startsWith("--message=")) messages.push(a.slice(10));
          else if (/^-[a-z]*F$/.test(a) || a === "--file" || a.startsWith("--file=")) {
            // -F <file>, or -F - for the message on stdin.
            const from = a.startsWith("--file=") ? a.slice(7) : rest[++k];
            if (from === undefined) return fail(129, "error: switch `F' requires a value");
            const body = from === "-" ? stdin : this.read(this.abs(from, cwd));
            if (body === undefined) return fail(128, `fatal: could not read log file '${from}': No such file or directory`);
            messages.push(text(body).replace(/\n+$/, ""));
          }
        }
        const amend = flag("--amend");
        // What is committed is the index: each added path as it was when it was added.
        const staged = [...repo.staged].filter(([path, content]) => (content === null ? head.tree.has(path) : !same(head.tree.get(path), content)));
        if (!staged.length && !amend && !flag("--allow-empty")) return { exitCode: 1, stdout: `On branch ${repo.branch}\n${changes.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : "nothing to commit, working tree clean"}\n`, stderr: "" };
        const message = messages.length ? messages.join("\n\n") : amend ? head.message : undefined;
        if (!message?.trim()) return fail(1, messages.length ? "Aborting commit due to empty commit message." : "error: Terminal is dumb, but EDITOR unset\nPlease supply the message using either -m or -F option.");
        const who = me();
        if (!who) return fail(128, "Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: unable to auto-detect email address");
        const tree = index();
        repo.staged.clear();
        const parent = amend ? head.parent : head;
        const subject = message.split("\n")[0]!;
        const author = amend && !flag("--reset-author") ? head.author : who.author;
        const commit: Commit = { sha: sha1(`${parent?.sha}\n${message}\n${author}\n${[...tree].map(([p, v]) => `${p}:${sha1(text(v))}`).join(",")}`), subject, message, author, committer: who.committer, parent, tree };
        repo.branches.set(repo.branch, commit);
        const stat = diffStat(changesBetween(parentTree(commit), tree));
        return ok(flags.some((f) => f === "--quiet" || /^-[a-zA-Z]*q[a-zA-Z]*$/.test(f)) ? "" : `[${repo.branch} ${short(commit.sha)}] ${subject}\n${stat.summary}\n`);
      }
      case "checkout":
      case "switch":
      case "restore": {
        const create = flags.some((f) => /^-q?[bcBC]$/.test(f));
        const to = operands[0];
        // Files: `checkout -- <file>`, `checkout <file>`, `restore <file>`, `restore --staged <file>`.
        const files = pathsAfterDashes ?? (sub === "restore" || (to !== undefined && !create && !repo.branches.has(to) && !this.rev(to)) ? operands : undefined);
        if (files?.length) {
          const source = flags.find((f) => f.startsWith("--source="))?.slice(9);
          const from = source ? this.rev(source) : head;
          if (!from) return unknown(source!);
          for (const p of files) {
            const path = rel(p);
            const matched = [...new Set([...from.tree.keys(), ...this.worktree().keys()])].filter((f) => f === path || f.startsWith(`${path}/`) || path === "");
            if (!matched.some((f) => from.tree.has(f))) return fail(1, `error: pathspec '${p}' did not match any file(s) known to git`);
            for (const f of matched) {
              if (flag("--staged")) { repo.staged.delete(f); continue; }
              // From the index (what was last added), unless a --source was named.
              const was = source ? from.tree.get(f) : index().get(f);
              if (was !== undefined) this.write(`${WORKDIR}/${f}`, was);
              repo.staged.delete(f);
            }
          }
          return ok();
        }
        if (!to) return fail(128, sub === "restore" ? "fatal: you must specify path(s) to restore" : "fatal: missing branch or commit argument");
        if (create) {
          if (repo.branches.has(to) && !flags.some((f) => /^-q?[BC]$/.test(f))) return fail(128, `fatal: a branch named '${to}' already exists`);
          const start = operands[1] ? this.rev(operands[1]) : head;
          if (!start) return unknown(operands[1]!);
          repo.branches.set(to, start);
          repo.branch = to;
          return { exitCode: 0, stdout: "", stderr: `Switched to a new branch '${to}'\n` };
        }
        const target = repo.branches.get(to);
        if (!target) return fail(1, `error: pathspec '${to}' did not match any file(s) known to git`);
        // The files that are as HEAD has them move to the other branch's; edits stay.
        for (const c of changesBetween(head.tree, target.tree)) {
          if (!same(this.files.get(`${WORKDIR}/${c.path}`), c.before) && !(c.before === undefined && !this.files.has(`${WORKDIR}/${c.path}`))) continue;
          if (c.after === undefined) this.files.delete(`${WORKDIR}/${c.path}`);
          else this.write(`${WORKDIR}/${c.path}`, c.after);
        }
        repo.branch = to;
        return { exitCode: 0, stdout: "", stderr: `Switched to branch '${to}'\n` };
      }
      case "reset": {
        const target = operands[0] && this.rev(operands[0]);
        if (operands[0] && !target && !flag("--hard", "--soft", "--mixed")) {
          for (const p of operands) repo.staged.delete(rel(p)); // `git reset <file>`: unstage it
          return ok();
        }
        if (operands[0] && !target) return unknown(operands[0]);
        const to = target || head;
        if (flag("--soft")) {
          for (const c of changesBetween(to.tree, head.tree)) if (!repo.staged.has(c.path)) repo.staged.set(c.path, c.after ?? null);
          repo.branches.set(repo.branch, to);
          return ok();
        }
        if (flag("--hard")) {
          for (const p of new Set([...head.tree.keys(), ...to.tree.keys()])) {
            const v = to.tree.get(p);
            if (v === undefined) this.files.delete(`${WORKDIR}/${p}`);
            else this.write(`${WORKDIR}/${p}`, v);
          }
          repo.staged.clear();
          repo.branches.set(repo.branch, to);
          return ok(`HEAD is now at ${short(to.sha)} ${to.subject}\n`);
        }
        repo.staged.clear();
        repo.branches.set(repo.branch, to);
        const left = this.changes().filter((c) => c.kind !== "untracked");
        return ok(left.length ? `Unstaged changes after reset:\n${left.map((c) => `${c.kind === "deleted" ? "D" : "M"}\t${c.path}\n`).join("")}` : "");
      }
      case "branch": {
        if (flag("--show-current")) return ok(`${repo.branch}\n`);
        if (flag("-d", "-D")) {
          for (const b of operands) {
            if (b === repo.branch) return fail(1, `error: cannot delete branch '${b}' used by worktree at '${WORKDIR}'`);
            if (!repo.branches.delete(b)) return fail(1, `error: branch '${b}' not found`);
          }
          return ok();
        }
        if (flag("-m", "-M") && operands.length) {
          const [from, to] = operands.length === 1 ? [repo.branch, operands[0]!] : (operands as [string, string]);
          const c = repo.branches.get(from);
          if (!c) return fail(1, `error: branch '${from}' not found`);
          repo.branches.delete(from);
          repo.branches.set(to, c);
          if (repo.branch === from) repo.branch = to;
          return ok();
        }
        if (operands[0]) { repo.branches.set(operands[0], (operands[1] && this.rev(operands[1])) || head); return ok(); }
        return ok([...repo.branches.keys()].sort().map((b) => `${b === repo.branch ? "*" : " "} ${b}\n`).join("") + (flag("-a", "-r") ? "  remotes/origin/HEAD -> origin/main\n  remotes/origin/main\n" : ""));
      }
      case "log": {
        // `A..B`: what B has that A doesn't. Otherwise everything from a revision (HEAD) back.
        const range = operands.find((o) => o.includes(".."));
        const single = operands.find((o) => !o.includes("..") && this.rev(o));
        let commits: Commit[];
        if (range) {
          const [a, b] = range.split(/\.{2,3}/) as [string, string];
          const from = this.rev(a || "HEAD"), to = this.rev(b || "HEAD");
          if (!from || !to) return unknown(range);
          const exclude = new Set(this.ancestors(from).map((c) => c.sha));
          commits = this.ancestors(to).filter((c) => !exclude.has(c.sha));
        } else commits = this.ancestors(single ? this.rev(single) : head);
        const n = flags.find((f) => /^-\d+$/.test(f))?.slice(1) ?? (flag("-n") ? rest[rest.indexOf("-n") + 1] : flags.find((f) => /^-n\d+$/.test(f))?.slice(2) ?? flags.find((f) => f.startsWith("--max-count="))?.slice(12));
        if (n !== undefined) commits = commits.slice(0, Number(n));
        const format = flags.find((f) => f.startsWith("--format=") || f.startsWith("--pretty=format:") || f.startsWith("--pretty=tformat:"))?.replace(/^--(format=|pretty=t?format:)/, "");
        const statOf = (c: Commit) => { const s = diffStat(changesBetween(parentTree(c), c.tree)); return `${s.rows.join("\n")}\n${s.summary}\n`; };
        if (format !== undefined) {
          const field = (c: Commit, f: string) => ({ H: c.sha, h: short(c.sha), s: c.subject, B: c.message, b: c.message.split("\n").slice(2).join("\n"), an: c.author.replace(/ <.*$/, ""), ae: c.author.replace(/^.*<|>$/g, ""), cn: c.committer.replace(/ <.*$/, ""), ce: c.committer.replace(/^.*<|>$/g, ""), ad: "Thu Nov 19 10:00:00 2026 +0000", cd: "Thu Nov 19 10:00:00 2026 +0000", ar: "2 hours ago", cr: "2 hours ago", n: "\n", P: c.parent?.sha ?? "", p: c.parent ? short(c.parent.sha) : "", d: "" })[f];
          return ok(commits.map((c) => `${format.replace(/%(an|ae|cn|ce|ad|cd|ar|cr|[HhsBbnPpd])/g, (m, f: string) => field(c, f) ?? m)}\n`).join(""));
        }
        if (flag("--oneline") || flags.some((f) => f.startsWith("--pretty=oneline"))) return ok(commits.map((c) => `${short(c.sha)} ${c.subject}\n${flag("--stat") ? statOf(c) : ""}`).join(""));
        return ok(commits.map((c) => `${header(c)}${flag("--stat") ? `\n${statOf(c)}` : flag("-p", "--patch") ? `\n${patchOf(changesBetween(parentTree(c), c.tree))}` : ""}`).join("\n"));
      }
      case "rev-parse": {
        if (flag("--show-toplevel")) return ok(`${WORKDIR}\n`);
        if (flag("--is-inside-work-tree")) return ok("true\n");
        if (flag("--git-dir")) return ok(".git\n");
        const name = operands[0] ?? "HEAD";
        if (flag("--abbrev-ref")) return ok(`${name === "origin/HEAD" ? "origin/main" : name === "HEAD" ? repo.branch : name}\n`);
        const c = this.rev(name);
        if (!c) return flag("--verify", "--quiet") ? { exitCode: 1, stdout: "", stderr: flag("--quiet") ? "" : "fatal: Needed a single revision\n" } : unknown(name);
        return ok(`${flag("--short") ? short(c.sha) : c.sha}\n`);
      }
      case "show": {
        const at = /^([^:]+):(.+)$/.exec(operands[0] ?? "");
        if (at) {
          const c = this.rev(at[1]!);
          if (!c) return unknown(at[1]!);
          const f = c.tree.get(at[2]!.replace(/^\.\//, ""));
          return f === undefined ? fail(128, `fatal: path '${at[2]}' does not exist in '${at[1]}'`) : ok(text(f));
        }
        const c = this.rev(operands[0] ?? "HEAD");
        if (!c) return unknown(operands[0]!);
        const changes = changesBetween(parentTree(c), c.tree);
        if (flag("--name-only", "--name-status", "--stat", "--shortstat")) return ok(`${flag("--oneline") ? `${short(c.sha)} ${c.subject}\n` : `${header(c)}\n`}${render(changes).stdout}`);
        return ok(`${header(c)}\n${patchOf(changes)}`);
      }
      case "rebase": {
        // Two forms. `git rebase <upstream>` when HEAD already has upstream (history here
        // is a line, so it does unless a branch was reset): nothing to do. And
        // `git rebase --exec '<command>' <upstream>` with the one command the product
        // tells the model to run when a commit's author is wrong
        // (src/tools/pull-request.ts): each commit ahead of upstream is made again by
        // whoever commits now.
        const at = rest.findIndex((a) => a === "--exec" || a === "-x");
        const command = at < 0 ? undefined : rest[at + 1];
        const upstreamName = rest.filter((a, k) => !a.startsWith("-") && k !== at + 1 || (at < 0 && !a.startsWith("-")))[0];
        const upstream = upstreamName === undefined ? undefined : this.rev(upstreamName);
        if (!upstream) return fail(128, upstreamName === undefined ? "fatal: no upstream configured for the current branch" : `fatal: invalid upstream '${upstreamName}'`);
        const line = this.ancestors(head);
        const cut = line.findIndex((c) => c.sha === upstream.sha);
        if (cut < 0) return this.refuse(written, "a rebase onto a commit HEAD doesn't have isn't simulated", fail(128, `fatal: invalid upstream '${upstreamName}'`));
        if (command === undefined) return ok(`Current branch ${repo.branch} is up to date.\n`);
        if (command.replace(/\s+/g, " ").trim() !== "git commit --amend --no-edit --reset-author") {
          return this.refuse(written, "`git rebase --exec` is simulated for `git commit --amend --no-edit --reset-author` only", fail(1, `Executing: ${command}\nwarning: execution failed: ${command}\nYou can fix the problem, and then run\n\n  git rebase --continue`));
        }
        const who = me();
        if (!who) return fail(128, "Author identity unknown\n\nfatal: unable to auto-detect email address");
        let parent = upstream;
        const ahead = line.slice(0, cut).reverse();
        for (const c of ahead) {
          parent = { ...c, author: who.author, committer: who.committer, parent, sha: sha1(`${parent.sha}\n${c.message}\n${who.author}\n${[...c.tree].map(([p, v]) => `${p}:${sha1(text(v))}`).join(",")}`) };
        }
        repo.branches.set(repo.branch, parent);
        return { exitCode: 0, stdout: ahead.map(() => `Executing: ${command}\n`).join(""), stderr: `Successfully rebased and updated refs/heads/${repo.branch}.\n` };
      }
      case "diff": {
        const cached = flag("--cached", "--staged");
        const revs = (pathsAfterDashes ? rest.slice(0, dashes) : rest).filter((a) => !a.startsWith("-"));
        const range = revs.find((r) => r.includes(".."));
        const named = revs.filter((r) => !r.includes("..") && this.rev(r));
        const paths = pathsAfterDashes ?? revs.filter((r) => !r.includes("..") && !this.rev(r));
        if (range) {
          const three = range.includes("...");
          const [a, b] = range.split(/\.{2,3}/) as [string, string];
          const from = this.rev(a || "HEAD"), to = this.rev(b || "HEAD");
          if (!from || !to) return unknown(range);
          // `A...B`: from where the two parted (here, the newest commit both have).
          const shared = new Set(this.ancestors(to).map((c) => c.sha));
          const base = three ? (this.ancestors(from).find((c) => shared.has(c.sha)) ?? from) : from;
          return render(only(changesBetween(base.tree, to.tree), paths));
        }
        if (named.length >= 2) return render(only(changesBetween(this.rev(named[0]!)!.tree, this.rev(named[1]!)!.tree), paths));
        if (named.length === 1) return render(only(changesBetween(this.rev(named[0]!)!.tree, tracked()), paths));
        // `--cached`: the index against HEAD. Plain `git diff`: the files against the index.
        if (cached) return render(only(changesBetween(head.tree, index()), paths));
        const idx = index(), work = this.worktree();
        const files: Tree = new Map();
        for (const path of idx.keys()) if (work.has(path)) files.set(path, work.get(path)!);
        return render(only(changesBetween(idx, files), paths));
      }
    }
    return this.refuse(written, `\`git ${sub ?? ""}\` isn't simulated`, fail(1, `git: '${sub ?? ""}' is not a git command. See 'git --help'.`));
  }
}
