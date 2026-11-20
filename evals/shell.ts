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
const BUILTIN = ["echo", "printf", "pwd", "cd", "test", "[", "true", "false", "command", "export", "unset", "type", "set", ":"];
const COMMANDS = ["ls", "cat", "head", "tail", "wc", "sed", "grep", "find", "file", "mkdir", "touch", "rm", "cp", "mv", "chmod", "tee", "env", "sleep", "time", "which", "git", "sort", "uname", "whoami", "hostname", "date", "basename", "dirname"];
const GIT = ["clone", "status", "add", "commit", "diff", "show", "log", "branch", "checkout", "switch", "restore", "reset", "rev-parse", "remote", "config", "fetch", "ls-files", "grep", "rm", "mv"];
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
const VAR = "\u0001", END = "\u0002", STAR = "\u0003", QUERY = "\u0004";
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
  const variable = (i: number): [string, number] | undefined => {
    const m = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*|\?)\}|([A-Za-z_][A-Za-z0-9_]*|\?))/.exec(line.slice(i, i + 80));
    return m ? [`${VAR}${m[1] ?? m[2]}${END}`, m[0].length] : undefined;
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
    if (c === "\\" && i + 1 < line.length) { word = (word ?? "") + line[i + 1]; i += 2; continue; }
    if (c === "`" || line.startsWith("$(", i) || line.startsWith("<(", i)) return { error: "substitution" };
    if (c === "$") {
      const v = variable(i);
      if (v) { word = (word ?? "") + v[0]; i += v[1]; continue; }
    }
    word = (word ?? "") + (c === "*" ? STAR : c === "?" ? QUERY : c);
    i++;
  }
  push();
  return tokens;
}

// Here-documents out of the command line: each `<<WORD` becomes `< <n>`, a stdin by number.
function heredocs(command: string): { line: string; docs: string[] } {
  const docs: string[] = [];
  const lines = command.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(lines[i]!);
    if (!m) { out.push(lines[i]!); continue; }
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== m[2]) body.push(lines[j++]!);
    docs.push(body.length ? `${body.join("\n")}\n` : "");
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

type Commit = { sha: string; subject: string; message: string; author: string; committer: string; parent?: Commit; tree: Tree };
type Repo = { name: string; url: string; branch: string; branches: Map<string, Commit>; origin: Commit; staged: Set<string>; config: Map<string, string>; programs: Program[] };
type State = { cwd: string; env: Map<string, string>; status: number; errexit: boolean };

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
    const { line, docs } = heredocs(command);
    const tokens = tokenize(line);
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
    const st: State = { cwd, env: new Map(Object.entries({ HOME: "/root", USER: "root", PATH: "/usr/local/bin:/usr/bin:/bin", SHELL: "/bin/sh", ...env })), status: 0, errexit: false };
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
        for (const part of pipeline) {
          last = this.simple(part, input, st, docs);
          input = last.stdout;
          stderr += last.stderr;
        }
        stdout += last.stdout;
        st.status = last.exitCode;
        // `set -e`: a failure that nothing tests ends the script.
        if (st.errexit && st.status !== 0 && next !== "&&" && next !== "||" && join !== "&&" && join !== "||") break;
      }
      join = next;
    }
    return { exitCode: st.status, stdout, stderr };
  }

  // A word as the command gets it: variables filled in, then an unquoted glob expanded to
  // the paths it matches (or left as written when it matches none).
  private expand(t: { word: string; quoted: boolean }, st: State): string[] {
    const filled = t.word.replace(new RegExp(`${VAR}([^${END}]+)${END}`, "g"), (_m, name: string) => (name === "?" ? String(st.status) : name === "PWD" ? st.cwd : (st.env.get(name) ?? "")));
    if (filled === "" && !t.quoted && t.word !== "") return []; // an unset variable, unquoted: no word at all
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

  private simple(tokens: Token[], stdin: string, st: State, docs: string[]): ExecResult {
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
        if (target.startsWith("\u0000")) stdin = docs[Number(target.slice(1))] ?? "";
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
    const flags = args.filter((a) => /^-[A-Za-z0-9]+$/.test(a));
    const has = (letter: string) => flags.some((f) => f.includes(letter));
    const operands = args.filter((a) => !/^-[A-Za-z0-9]+$/.test(a) && !/^--[a-z]/.test(a));
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
      case "sleep": return ok();
      case "set":
        if (args.some((a) => /^-[a-z]*e/.test(a))) st.errexit = true;
        return ok();
      case "export":
        for (const a of operands) if (a.includes("=")) st.env.set(a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1));
        return ok();
      case "unset":
        for (const a of operands) st.env.delete(a);
        return ok();
      case "env": {
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
        const r = this.run(args, stdin, st);
        return { ...r, stderr: `${r.stderr}\nreal\t0m0.214s\nuser\t0m0.162s\nsys\t0m0.041s\n` };
      }
      case "echo": {
        const n = args[0] === "-n", e = args[0] === "-e";
        const body = (n || e ? args.slice(1) : args).join(" ");
        return ok((e ? body.replace(/\\n/g, "\n").replace(/\\t/g, "\t") : body) + (n ? "" : "\n"));
      }
      case "printf": {
        const [format = "", ...rest] = args;
        let k = 0;
        return ok(format.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/%[sd]/g, () => rest[k++] ?? ""));
      }
      case "pwd": return ok(`${st.cwd}\n`);
      case "whoami": return ok("root\n");
      case "hostname": return ok("sandbox\n");
      case "uname": return ok(args.includes("-a") ? "Linux sandbox 6.8.0 #1 SMP x86_64 GNU/Linux\n" : "Linux\n");
      case "date": return ok("Thu Nov 19 10:00:00 UTC 2026\n");
      case "basename": return ok(`${(operands[0] ?? "").split("/").filter(Boolean).at(-1) ?? ""}\n`);
      case "dirname": return ok(`${(operands[0] ?? "").includes("/") ? (operands[0]!.slice(0, operands[0]!.lastIndexOf("/")) || "/") : "."}\n`);
      case "cd": {
        const to = this.abs(operands[0] ?? "/root", st.cwd);
        if (!this.isDir(to)) return fail(2, `sh: 1: cd: can't cd to ${operands[0]}`);
        st.cwd = to;
        return ok();
      }
      case "mkdir":
        for (const p of operands) this.dirs.add(this.abs(p, st.cwd));
        return ok();
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
        const [mode, ...paths] = operands.length ? operands : [args[0] ?? ""];
        // `+x` arrives as a flag-less operand; `-x` looks like a flag.
        const spec = mode ?? "";
        for (const p of paths.length ? paths : []) {
          const path = this.abs(p, st.cwd);
          if (this.read(path) === undefined && !this.isDir(path)) { errors.push(`chmod: cannot access '${p}': No such file or directory`); continue; }
          if (/^[0-7]{3,4}$/.test(spec)) Number(spec.at(-3)) & 1 ? this.executable.add(path) : this.executable.delete(path);
          else if (/\+[rw]*x/.test(spec)) this.executable.add(path);
          else if (/-[rw]*x/.test(spec)) this.executable.delete(path);
        }
        if (flags.includes("-x")) for (const p of operands) this.executable.delete(this.abs(p, st.cwd));
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
        const a = args.filter((x) => x !== "]");
        const negate = a[0] === "!";
        if (negate) a.shift();
        const path = a[1] === undefined ? "" : this.abs(a[1], st.cwd);
        const yes = a[0] === "-f" ? this.read(path) !== undefined : a[0] === "-d" ? this.isDir(path) : a[0] === "-e" ? this.read(path) !== undefined || this.isDir(path) : a[0] === "-x" ? this.executable.has(path) : a[0] === "-s" ? size(this.read(path) ?? "") > 0 : a[0] === "-n" ? !!a[1] : a[0] === "-z" ? !a[1] : a[1] === "=" || a[1] === "==" ? a[0] === a[2] : a[1] === "!=" ? a[0] !== a[2] : !!a[0];
        return { exitCode: yes !== negate ? 0 : 1, stdout: "", stderr: "" };
      }
      case "ls": {
        const all = has("a") || has("A"), long = has("l");
        const entry = (path: string, label: string) => {
          if (!long) return label;
          const f = this.read(path);
          return f === undefined ? `drwxr-xr-x 2 root root  4096 Nov 19 10:00 ${label}` : `${this.executable.has(path) ? "-rwxr-xr-x" : "-rw-r--r--"} 1 root root ${String(size(f)).padStart(5)} Nov 19 10:00 ${label}`;
        };
        const targets = operands.length ? operands : ["."];
        const out: string[] = [];
        for (const p of targets) {
          const path = this.abs(p, st.cwd);
          if (this.read(path) !== undefined) { out.push(entry(path, p)); continue; }
          if (!this.isDir(path)) { errors.push(`ls: cannot access '${p}': No such file or directory`); continue; }
          if (targets.length > 1) out.push(`${out.length ? "\n" : ""}${p}:`);
          const names = this.children(path).filter((n) => all || !n.startsWith("."));
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
      case "sort": return ok(lines(inputs("sort").map(([, t]) => t).join("")).sort().map((l) => `${l}\n`).join(""));
      case "head":
      case "tail": {
        const numeric = args.find((a) => /^-\d+$/.test(a));
        const bytes = args.some((a) => a.startsWith("-c"));
        const n = numeric ? Number(numeric.slice(1)) : bytes ? count("-c", 10) : count("-n", 10);
        const paths = operands.filter((a) => !/^\d+$/.test(a) || this.read(this.abs(a, st.cwd)) !== undefined);
        const texts: [string, string][] = [];
        if (!paths.length) texts.push(["", stdin]);
        for (const p of paths) {
          const f = this.read(this.abs(p, st.cwd));
          if (f === undefined) errors.push(`${name}: cannot open '${p}' for reading: No such file or directory`);
          else texts.push([p, text(f)]);
        }
        const cut = (t: string) => {
          if (bytes) return name === "head" ? t.slice(0, n) : t.slice(-n);
          const ls = lines(t);
          return (name === "head" ? ls.slice(0, n) : ls.slice(-n)).map((l) => `${l}\n`).join("");
        };
        return done(texts.map(([p, t]) => (texts.length > 1 ? `==> ${p} <==\n` : "") + cut(t)).join(""));
      }
      case "wc": {
        const texts = inputs("wc");
        const l = has("l"), c = has("c"), w = has("w");
        const row = (p: string, t: string) => {
          const counts = [(t.match(/\n/g) ?? []).length, t.split(/\s+/).filter(Boolean).length, Buffer.byteLength(t, "latin1")];
          const picked = l || c || w ? [l && counts[0], w && counts[1], c && counts[2]].filter((x) => x !== false) : counts;
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
        const root = this.abs(operands[0] && !operands[0].startsWith("-") ? operands[0] : ".", st.cwd);
        const i = args.indexOf("-name");
        const pattern = i >= 0 && args[i + 1] ? glob(args[i + 1]!) : undefined;
        if (!this.isDir(root)) return fail(1, `find: '${operands[0]}': No such file or directory`);
        const shown = (path: string) => (operands[0]?.startsWith("/") ? path : `.${path.slice(root.length)}` || ".");
        const dirsOnly = args[args.indexOf("-type") + 1] === "d" && args.includes("-type");
        const all = dirsOnly ? [...new Set(this.under(root).map((f) => f.slice(0, f.lastIndexOf("/"))))].filter((d) => d.length > root.length).sort() : this.under(root);
        return ok(all.filter((f) => !pattern || pattern.test(f.split("/").at(-1)!)).map((f) => `${shown(f)}\n`).join(""));
      }
      case "grep": return this.grep(args, stdin, st.cwd, false);
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

  private grep(args: string[], stdin: string, cwd: string, tracked: boolean): ExecResult {
    let after = 0, before = 0;
    const plain: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const m = /^-([ABC])(\d+)?$/.exec(args[i]!);
      if (!m) { plain.push(args[i]!); continue; }
      const n = Number(m[2] ?? args[++i] ?? 0);
      if (m[1] !== "B") after = n;
      if (m[1] !== "A") before = n;
    }
    const flags = plain.filter((a) => /^-[A-Za-z]+$/.test(a)).join("");
    const [pattern, ...paths] = plain.filter((a) => !/^-[A-Za-z]+$/.test(a) && !/^--[a-z]/.test(a) && a !== "--");
    if (pattern === undefined) return fail(2, "usage: grep [OPTION]... PATTERNS [FILE]...");
    let re: RegExp;
    try {
      // grep's basic patterns: ( ) { } | + ? are themselves unless escaped, the reverse of -E.
      const basic = (p: string) => p.replace(/\\?[(){}|+?]/g, (m) => (m.length === 2 ? m[1]! : `\\${m}`));
      re = new RegExp(flags.includes("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : flags.includes("E") || flags.includes("P") ? pattern : basic(pattern), flags.includes("i") ? "i" : "");
    } catch {
      return fail(2, "grep: Invalid regular expression");
    }
    const sources: [string, string][] = [];
    if (tracked) {
      const roots = paths.length ? paths.map((p) => this.abs(p, cwd)) : [WORKDIR];
      for (const f of this.under(WORKDIR)) if (roots.some((r) => f === r || f.startsWith(`${r}/`))) sources.push([f.slice(WORKDIR.length + 1), text(this.files.get(f)!)]);
    } else if (!paths.length && !/[rR]/.test(flags)) sources.push(["", stdin]);
    else for (const p of paths.length ? paths : ["."]) {
      const path = this.abs(p, cwd);
      const f = this.read(path);
      if (f !== undefined) sources.push([p, text(f)]);
      else if (this.isDir(path)) {
        if (!/[rR]/.test(flags)) return fail(2, `grep: ${p}: Is a directory`);
        for (const child of this.under(path)) sources.push([`${p === "." ? "" : `${p.replace(/\/$/, "")}/`}${child.slice(path.length + 1)}`, text(this.files.get(child)!)]);
      } else return fail(2, `grep: ${p}: No such file or directory`);
    }
    const named = sources.length > 1 || tracked || /[rR]/.test(flags);
    const out: string[] = [];
    for (const [p, t] of sources) {
      if (t.includes("\u0000")) continue; // binary
      const all = lines(t);
      const hits = all.map((l) => re.test(l) !== flags.includes("v"));
      all.forEach((l, n) => {
        const near = !hits[n] && (after || before) && hits.some((h, k) => h && ((k < n && n - k <= after) || (k > n && k - n <= before)));
        if (!hits[n] && !near) return;
        if (flags.includes("l")) { if (hits[n]) out.push(p); return; }
        const sep = hits[n] ? ":" : "-";
        out.push(`${named ? `${p}${sep}` : ""}${flags.includes("n") ? `${n + 1}${sep}` : ""}${l}`);
      });
    }
    const unique = flags.includes("l") ? [...new Set(out)] : out;
    return { exitCode: unique.length ? 0 : 1, stdout: flags.includes("c") ? `${unique.length}\n` : flags.includes("q") ? "" : unique.map((l) => `${l}\n`).join(""), stderr: "" };
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
    this.repo = { name, url, branch, branches: new Map([[branch, tip]]), origin: tip, staged: new Set(), config: new Map(), programs: script.programs ?? [] };
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
    const flags = (dashes < 0 ? rest : rest.slice(0, dashes)).filter((a) => a.startsWith("-"));
    const operands = [...(dashes < 0 ? rest : rest.slice(0, dashes)).filter((a) => !a.startsWith("-")), ...(dashes < 0 ? [] : rest.slice(dashes + 1))];
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
        const changes = this.changes();
        if (flag("--porcelain", "--short", "-s", "-sb")) {
          const code = (c: (typeof changes)[number]) => (c.kind === "untracked" ? (repo.staged.has(c.path) ? "A " : "??") : repo.staged.has(c.path) ? `${c.kind === "deleted" ? "D" : "M"} ` : ` ${c.kind === "deleted" ? "D" : "M"}`);
          return ok((flag("-sb") ? `## ${repo.branch}...origin/main\n` : "") + changes.map((c) => `${code(c)} ${c.path}\n`).join(""));
        }
        const ahead = this.ancestors(head).filter((c) => !this.ancestors(repo.origin).includes(c)).length;
        const out = [`On branch ${repo.branch}`];
        if (repo.branch === "main") out.push(ahead ? `Your branch is ahead of 'origin/main' by ${ahead} commit${ahead === 1 ? "" : "s"}.\n` : "Your branch is up to date with 'origin/main'.\n");
        const staged = changes.filter((c) => repo.staged.has(c.path)), unstaged = changes.filter((c) => !repo.staged.has(c.path) && c.kind !== "untracked"), untracked = changes.filter((c) => !repo.staged.has(c.path) && c.kind === "untracked");
        if (staged.length) out.push("Changes to be committed:", '  (use "git restore --staged <file>..." to unstage)', ...staged.map((c) => `\t${c.kind === "untracked" ? "new file" : c.kind}:   ${c.path}`), "");
        if (unstaged.length) out.push("Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', ...unstaged.map((c) => `\t${c.kind}:   ${c.path}`), "");
        if (untracked.length) out.push("Untracked files:", '  (use "git add <file>..." to include in what will be committed)', ...untracked.map((c) => `\t${c.path}`), "");
        if (!changes.length) out.push("nothing to commit, working tree clean");
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
          for (const c of under) repo.staged.add(c.path);
        }
        if (everything) for (const c of changes) repo.staged.add(c.path);
        return ok();
      }
      case "rm":
      case "mv": {
        if (sub === "rm") for (const p of operands) { this.files.delete(`${WORKDIR}/${rel(p)}`); repo.staged.add(rel(p)); }
        else if (operands.length === 2) {
          const [a, b] = operands.map(rel) as [string, string];
          const f = this.files.get(`${WORKDIR}/${a}`);
          if (f === undefined) return fail(128, `fatal: bad source, source=${a}, destination=${b}`);
          this.write(`${WORKDIR}/${b}`, f);
          this.files.delete(`${WORKDIR}/${a}`);
          repo.staged.add(a).add(b);
        }
        return ok();
      }
      case "commit": {
        const changes = this.changes();
        if (flags.some((f) => /^-[a-z]*a[a-z]*$/.test(f) || f === "--all")) for (const c of changes) if (c.kind !== "untracked") repo.staged.add(c.path);
        const messages: string[] = [];
        rest.forEach((a, i) => {
          if ((/^-[a-z]*m$/.test(a) || a === "--message") && rest[i + 1] !== undefined) messages.push(rest[i + 1]!);
          else if (a.startsWith("--message=")) messages.push(a.slice(10));
        });
        const amend = flag("--amend");
        const staged = changes.filter((c) => repo.staged.has(c.path));
        if (!staged.length && !amend && !flag("--allow-empty")) return { exitCode: 1, stdout: `On branch ${repo.branch}\n${changes.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : "nothing to commit, working tree clean"}\n`, stderr: "" };
        const message = messages.length ? messages.join("\n\n") : amend ? head.message : undefined;
        if (!message) return fail(1, "error: no commit message given, and there is no editor in this sandbox: use `git commit -m \"<message>\"`");
        const who = me();
        if (!who) return fail(128, "Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: unable to auto-detect email address");
        const tree: Tree = new Map(head.tree);
        for (const c of staged) {
          const now = this.files.get(`${WORKDIR}/${c.path}`);
          if (now === undefined) tree.delete(c.path);
          else tree.set(c.path, now);
        }
        repo.staged.clear();
        const parent = amend ? head.parent : head;
        const subject = message.split("\n")[0]!;
        const author = amend && !flag("--reset-author") ? head.author : who.author;
        const commit: Commit = { sha: sha1(`${parent?.sha}\n${message}\n${author}\n${[...tree].map(([p, v]) => `${p}:${sha1(text(v))}`).join(",")}`), subject, message, author, committer: who.committer, parent, tree };
        repo.branches.set(repo.branch, commit);
        const s = diffStat(changesBetween(parentTree(commit), tree));
        return ok(flags.some((f) => f === "--quiet" || /^-[a-z]*q[a-z]*$/.test(f)) ? "" : `[${repo.branch} ${short(commit.sha)}] ${subject}\n${s.summary}\n`);
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
              const was = from.tree.get(f);
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
          for (const c of changesBetween(to.tree, head.tree)) repo.staged.add(c.path);
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
        // Plain `git diff`: what isn't staged. `--cached`: what is.
        const all = changesBetween(head.tree, tracked());
        return render(only(all.filter((c) => repo.staged.has(c.path) === cached), paths));
      }
    }
    return this.refuse(written, `\`git ${sub ?? ""}\` isn't simulated`, fail(1, `git: '${sub ?? ""}' is not a git command. See 'git --help'.`));
  }
}
