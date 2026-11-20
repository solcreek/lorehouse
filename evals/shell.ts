// shell.ts — a small simulated shell over a virtual checkout, for the sandbox of a code
// case (sandbox.ts).
//
// A real model checks its tools: it runs `echo hello`, lists the directory, reads the file
// it is about to change, and looks at `git status` after a commit. A sandbox that answers
// "ran:<command>" to all of that is, rightly, not believed, and the model stops and says
// so (measured 2026-11-19: 6 of 6 trials). So this runs the commands a model usually
// runs, against files in memory, and answers as bash and git would: output, exit codes,
// "command not found". Nothing is executed on this machine.
//
// It is not bash. It knows `&&`, `||`, `;`, pipes, `>`/`>>`/`<`, `2>/dev/null`, `2>&1`,
// quotes, `$?` and here-documents; a handful of commands (below); and the git commands
// of a small change (status, add, commit, branch, log, diff). Loops, substitutions and
// anything else answer as a command that isn't installed, which is at least honest.

import { deflateSync } from "node:zlib";

export type Program = {
  // Tested against one simple command, as written (e.g. "python3 scripts/plot.py").
  match: RegExp;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  // Files the command leaves behind, relative to the checkout.
  writes?: Record<string, string | Uint8Array>;
};

export type ShellScript = {
  // The checkout's files as cloned, relative to its root.
  files: Record<string, string>;
  // Commands that aren't the shell's own: a test runner, a script. The first match answers.
  programs?: Program[];
  // Programs installed beside the shell's own commands and git, each with what its
  // `--version` prints. One runs only as a `programs` rule says: any other invocation is
  // refused out loud, never answered with a silent success.
  installed?: Record<string, string>;
};

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export const WORKDIR = "/workspace/repo";
const BUILTIN = ["echo", "printf", "pwd", "cd", "test", "[", "true", "false", "command", "export", "type"];
const OWN = ["type", "echo", "printf", "pwd", "cd", "ls", "cat", "head", "tail", "wc", "sed", "grep", "find", "file", "test", "[", "true", "false", "mkdir", "touch", "rm", "which", "command", "git", "sort", "uname", "whoami", "date", "export"];

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

type Token = { op: string } | { word: string };
const OPS = ["2>/dev/null", "2>&1", "&>/dev/null", ">/dev/null", "&&", "||", ">>", ";", "|", ">", "<"];

function tokenize(line: string, status: number, cwd: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let word: string | undefined;
  const push = () => {
    if (word !== undefined) tokens.push({ word });
    word = undefined;
  };
  // `$?` is filled in when its command runs (the status so far), not here.
  void status;
  const expand = (s: string) => s.replace(/\$\?/g, "\u0001?").replace(/\$\{?PWD\}?/g, cwd).replace(/\$\{?HOME\}?/g, "/root");
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    if (c === " " || c === "\t") { push(); i++; continue; }
    if (c === "\n") { push(); tokens.push({ op: ";" }); i++; continue; }
    if (c === "#" && word === undefined) { while (i < line.length && line[i] !== "\n") i++; continue; }
    const op = word === undefined || !/\d$/.test(word) ? OPS.find((o) => line.startsWith(o, i)) : OPS.find((o) => line.startsWith(o, i) && !o.startsWith("2"));
    if (op) { push(); tokens.push({ op }); i += op.length; continue; }
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) return { error: "unexpected EOF while looking for matching `''" };
      word = (word ?? "") + line.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1, text = "";
      while (j < line.length && line[j] !== '"') {
        if (line[j] === "\\" && j + 1 < line.length && '"\\$`'.includes(line[j + 1]!)) { text += line[j + 1]; j += 2; } else text += line[j++];
      }
      if (j >= line.length) return { error: 'unexpected EOF while looking for matching `"\'' };
      if (/\$\(|`/.test(text)) return { error: "substitution" };
      word = (word ?? "") + expand(text);
      i = j + 1;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) { word = (word ?? "") + line[i + 1]; i += 2; continue; }
    if (c === "`" || line.startsWith("$(", i)) return { error: "substitution" };
    if (c === "$") {
      const m = /^\$(\?|\{?PWD\}?|\{?HOME\}?)/.exec(line.slice(i));
      if (m) { word = (word ?? "") + expand(m[0]); i += m[0].length; continue; }
    }
    word = (word ?? "") + c;
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

// ── the shell ───────────────────────────────────────────────────────────────

const text = (v: string | Uint8Array) => (typeof v === "string" ? v : Buffer.from(v).toString("latin1"));
const size = (v: string | Uint8Array) => (typeof v === "string" ? Buffer.byteLength(v) : v.byteLength);
const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });
const fail = (exitCode: number, stderr: string, stdout = ""): ExecResult => ({ exitCode, stdout, stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n` });
const lines = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
const sha = (s: string) => new Bun.CryptoHasher("sha1").update(s).digest("hex");

// What changed between two versions of a file, as one run: the lines both start with, the
// lines both end with, and what is between them on each side.
function diffLines(before: string[], after: string[]): { prefix: number; suffix: number; removed: string[]; added: string[] } {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  return { prefix, suffix, removed: before.slice(prefix, before.length - suffix), added: after.slice(prefix, after.length - suffix) };
}

export class Shell {
  readonly files = new Map<string, string | Uint8Array>();
  private dirs = new Set<string>(["/", "/workspace", "/tmp", "/root"]);
  // The checkout, once cloned: where it came from and its commits.
  private repo?: { url: string; branch: string; branches: Set<string>; head: Map<string, string | Uint8Array>; staged: Set<string>; commits: { sha: string; subject: string }[] };

  constructor(private script: ShellScript) {
    // What `which` names is there: an executable, by its first bytes.
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0x3e, 0, 1, 0, 0, 0]);
    for (const name of [...OWN.filter((n) => !BUILTIN.includes(n)), ...Object.keys(script.installed ?? {})]) this.files.set(`/usr/bin/${name}`, elf);
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
  write(path: string, content: string | Uint8Array): void {
    this.files.set(path, content);
  }
  // A file as the sandbox's file API reads it; `.git/HEAD` is there once cloned.
  read(path: string): string | Uint8Array | undefined {
    if (this.repo && path === `${WORKDIR}/.git/HEAD`) return `ref: refs/heads/${this.repo.branch}\n`;
    return this.files.get(path);
  }

  // ── running ──
  exec(command: string, cwd = WORKDIR): ExecResult {
    const { line, docs } = heredocs(command);
    let status = 0, stdout = "", stderr = "";
    // A working directory that isn't there (the checkout, before a clone).
    if (!this.isDir(cwd)) return fail(1, `bash: cd: ${cwd}: No such file or directory`);
    const state = { cwd };
    // One list at a time (split on newlines outside quotes is the tokenizer's job; `$?`
    // is the status as the list began).
    const tokens = tokenize(line, status, state.cwd);
    if ("error" in tokens) {
      return tokens.error === "substitution"
        ? fail(2, "bash: command substitution isn't available in this sandbox's shell; run the commands one at a time")
        : fail(2, `bash: -c: line 1: ${tokens.error}`);
    }
    // Split into pipelines joined by && || ;
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
      const skip = (join === "&&" && status !== 0) || (join === "||" && status === 0);
      if (!skip && pipeline.some((p) => p.length)) {
        let input = "";
        let last: ExecResult = ok();
        for (const part of pipeline) {
          // `$?` in this command is the status so far.
          last = this.simple(part.map((t) => ("word" in t ? { word: t.word.replace(/\u0001\?/g, String(status)) } : t)), input, state, docs, status);
          input = last.stdout;
          stderr += last.stderr;
        }
        stdout += last.stdout;
        status = last.exitCode;
      }
      join = next;
    }
    return { exitCode: status, stdout, stderr };
  }

  private simple(tokens: Token[], stdin: string, state: { cwd: string }, docs: string[], status: number): ExecResult {
    const words: string[] = [];
    let out: { path: string; append: boolean } | undefined;
    let quiet = false, merge = false, drop = false;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!;
      if ("word" in t) { words.push(t.word); continue; }
      const target = tokens[i + 1] && "word" in tokens[i + 1]! ? (tokens[i + 1] as { word: string }).word : undefined;
      if (t.op === "2>/dev/null") quiet = true;
      else if (t.op === "2>&1") merge = true;
      else if (t.op === "&>/dev/null") { quiet = true; drop = true; }
      else if (t.op === ">/dev/null") drop = true;
      else if (t.op === ">" || t.op === ">>") {
        if (target === undefined) return fail(2, "bash: syntax error near unexpected token `newline'");
        if (target === "/dev/null") drop = true;
        else out = { path: this.abs(target, state.cwd), append: t.op === ">>" };
        i++;
      } else if (t.op === "<") {
        if (target === undefined) return fail(2, "bash: syntax error near unexpected token `newline'");
        if (target.startsWith("\u0000")) stdin = docs[Number(target.slice(1))] ?? "";
        else {
          const f = this.read(this.abs(target, state.cwd));
          if (f === undefined) return fail(1, `bash: ${target}: No such file or directory`);
          stdin = text(f);
        }
        i++;
      }
    }
    if (!words.length) return ok();
    let r = this.run(words, stdin, state, status);
    if (out) {
      const before = out.append ? text(this.files.get(out.path) ?? "") : "";
      this.write(out.path, before + r.stdout);
      r = { ...r, stdout: "" };
    }
    if (drop) r = { ...r, stdout: "" };
    if (merge) r = { ...r, stdout: r.stdout + r.stderr, stderr: "" };
    if (quiet) r = { ...r, stderr: "" };
    return r;
  }

  private run(words: string[], stdin: string, state: { cwd: string }, status: number): ExecResult {
    const [name, ...args] = words as [string, ...string[]];
    const written = words.join(" ");
    const program = (this.script.programs ?? []).find((p) => p.match.test(written));
    if (program) {
      for (const [path, content] of Object.entries(program.writes ?? {})) this.write(this.abs(path, WORKDIR), content);
      return { exitCode: program.exitCode ?? 0, stdout: program.stdout ?? "", stderr: program.stderr ?? "" };
    }
    const flags = args.filter((a) => /^-[A-Za-z0-9]+$/.test(a));
    const operands = args.filter((a) => !/^-[A-Za-z0-9]+$/.test(a) && !/^--[a-z]/.test(a));
    const missing = (cmd: string, path: string) => `${cmd}: ${path}: No such file or directory`;
    // The content of each operand (or stdin when there is none), for the reading commands.
    const inputs = (cmd: string): { texts: [string, string][]; errors: string[] } => {
      if (!operands.length) return { texts: [["", stdin]], errors: [] };
      const texts: [string, string][] = [], errors: string[] = [];
      for (const p of operands) {
        const path = this.abs(p, state.cwd);
        const f = this.read(path);
        if (f !== undefined) texts.push([p, text(f)]);
        else errors.push(this.isDir(path) ? `${cmd}: ${p}: Is a directory` : missing(cmd, p));
      }
      return { texts, errors };
    };
    const count = (flag: string, fallback: number): number => {
      const i = args.indexOf(flag);
      if (i >= 0 && args[i + 1] !== undefined) return Number(args[i + 1]);
      const joined = args.find((a) => a.startsWith(flag) && a.length > flag.length);
      return joined ? Number(joined.slice(flag.length)) : fallback;
    };

    switch (name) {
      case "true": return ok();
      case "false": return { exitCode: 1, stdout: "", stderr: "" };
      case "export": return ok();
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
      case "pwd": return ok(`${state.cwd}\n`);
      case "whoami": return ok("root\n");
      case "uname": return ok(args.includes("-a") ? "Linux sandbox 6.8.0 #1 SMP x86_64 GNU/Linux\n" : "Linux\n");
      case "date": return ok("Thu Nov 19 10:00:00 UTC 2026\n");
      case "cd": {
        const to = this.abs(operands[0] ?? "/root", state.cwd);
        if (!this.isDir(to)) return fail(1, `bash: cd: ${operands[0]}: No such file or directory`);
        state.cwd = to;
        return ok();
      }
      case "mkdir": {
        for (const p of operands) this.dirs.add(this.abs(p, state.cwd));
        return ok();
      }
      case "touch": {
        for (const p of operands) if (!this.files.has(this.abs(p, state.cwd))) this.write(this.abs(p, state.cwd), "");
        return ok();
      }
      case "rm": {
        const errors: string[] = [];
        for (const p of operands) {
          const path = this.abs(p, state.cwd);
          if (this.files.delete(path)) continue;
          if (this.isDir(path) && flags.some((f) => f.includes("r"))) {
            for (const f of [...this.files.keys()]) if (f.startsWith(`${path}/`)) this.files.delete(f);
            this.dirs.delete(path);
          } else if (!flags.some((f) => f.includes("f"))) errors.push(`rm: cannot remove '${p}': No such file or directory`);
        }
        return errors.length ? fail(1, errors.join("\n")) : ok();
      }
      case "type": {
        const known = [...OWN, ...Object.keys(this.script.installed ?? {})];
        const out: string[] = [], errors: string[] = [];
        for (const p of operands) {
          if (BUILTIN.includes(p)) out.push(`${p} is a shell builtin`);
          else if (known.includes(p)) out.push(`${p} is /usr/bin/${p}`);
          else errors.push(`bash: type: ${p}: not found`);
        }
        return { exitCode: errors.length ? 1 : 0, stdout: out.length ? `${out.join("\n")}\n` : "", stderr: errors.length ? `${errors.join("\n")}\n` : "" };
      }
      case "which":
      case "command": {
        const found: string[] = [], known = [...OWN, ...Object.keys(this.script.installed ?? {})];
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
        const path = a[1] === undefined ? "" : this.abs(a[1], state.cwd);
        const yes = a[0] === "-f" ? this.read(path) !== undefined : a[0] === "-d" ? this.isDir(path) : a[0] === "-e" ? this.read(path) !== undefined || this.isDir(path) : a[0] === "-s" ? size(this.read(path) ?? "") > 0 : a[0] === "-n" ? !!a[1] : a[0] === "-z" ? !a[1] : a[1] === "=" || a[1] === "==" ? a[0] === a[2] : a[1] === "!=" ? a[0] !== a[2] : !!a[0];
        return { exitCode: yes ? 0 : 1, stdout: "", stderr: "" };
      }
      case "ls": {
        const all = flags.some((f) => /[aA]/.test(f)), long = flags.some((f) => f.includes("l"));
        const entry = (path: string, label: string) => {
          if (!long) return label;
          const f = this.read(path);
          return f === undefined ? `drwxr-xr-x 2 root root  4096 Nov 19 10:00 ${label}` : `-rw-r--r-- 1 root root ${String(size(f)).padStart(5)} Nov 19 10:00 ${label}`;
        };
        const targets = operands.length ? operands : ["."];
        const out: string[] = [], errors: string[] = [];
        for (const p of targets) {
          const path = this.abs(p, state.cwd);
          if (this.read(path) !== undefined) { out.push(entry(path, p)); continue; }
          if (!this.isDir(path)) { errors.push(`ls: cannot access '${p}': No such file or directory`); continue; }
          if (targets.length > 1) out.push(`${out.length ? "\n" : ""}${p}:`);
          const names = this.children(path).filter((n) => all || !n.startsWith("."));
          if (long) out.push(`total ${names.length * 4}`);
          if (all) out.push(entry(path, "."), entry(path, ".."));
          for (const n of names) out.push(entry(`${path === "/" ? "" : path}/${n}`, n));
        }
        return { exitCode: errors.length ? 2 : 0, stdout: out.length ? `${out.join("\n")}\n` : "", stderr: errors.length ? `${errors.join("\n")}\n` : "" };
      }
      case "cat": {
        const { texts, errors } = inputs("cat");
        let out = texts.map(([, t]) => t).join("");
        if (flags.some((f) => /[AE]/.test(f))) out = out.replace(/\t/g, "^I").replace(/\n/g, "$\n");
        if (flags.some((f) => f.includes("n"))) out = lines(out).map((l, i) => `${String(i + 1).padStart(6)}\t${l}\n`).join("");
        return { exitCode: errors.length ? 1 : 0, stdout: out, stderr: errors.length ? `${errors.join("\n")}\n` : "" };
      }
      case "sort": return ok(lines(inputs("sort").texts.map(([, t]) => t).join("")).sort().map((l) => `${l}\n`).join(""));
      case "head":
      case "tail": {
        const numeric = args.find((a) => /^-\d+$/.test(a));
        const bytes = args.some((a) => a.startsWith("-c"));
        const n = numeric ? Number(numeric.slice(1)) : bytes ? count("-c", 10) : count("-n", 10);
        const files = operands.filter((a) => !/^\d+$/.test(a) || this.read(this.abs(a, state.cwd)) !== undefined);
        const texts: [string, string][] = [], errors: string[] = [];
        if (!files.length) texts.push(["", stdin]);
        for (const p of files) {
          const f = this.read(this.abs(p, state.cwd));
          if (f === undefined) errors.push(`${name}: cannot open '${p}' for reading: No such file or directory`);
          else texts.push([p, text(f)]);
        }
        const cut = (t: string) => {
          if (bytes) return name === "head" ? t.slice(0, n) : t.slice(-n);
          const ls = lines(t);
          return (name === "head" ? ls.slice(0, n) : ls.slice(-n)).map((l) => `${l}\n`).join("");
        };
        return { exitCode: errors.length ? 1 : 0, stdout: texts.map(([p, t]) => (texts.length > 1 ? `==> ${p} <==\n` : "") + cut(t)).join(""), stderr: errors.length ? `${errors.join("\n")}\n` : "" };
      }
      case "wc": {
        const { texts, errors } = inputs("wc");
        const l = flags.some((f) => f.includes("l")), c = flags.some((f) => f.includes("c")), w = flags.some((f) => f.includes("w"));
        const row = (p: string, t: string) => {
          const counts = [(t.match(/\n/g) ?? []).length, t.split(/\s+/).filter(Boolean).length, Buffer.byteLength(t, "latin1")];
          const picked = l || c || w ? [l && counts[0], w && counts[1], c && counts[2]].filter((x) => x !== false) : counts;
          return `${picked.join(" ")}${p ? ` ${p}` : ""}\n`;
        };
        return { exitCode: errors.length ? 1 : 0, stdout: texts.map(([p, t]) => row(p, t)).join(""), stderr: errors.length ? `${errors.join("\n")}\n` : "" };
      }
      case "sed": {
        const expr = operands[0] ?? "";
        const m = /^(\d+)(?:,(\d+|\$))?p$/.exec(expr);
        if (!flags.includes("-n") || !m) return fail(1, "sed: only `sed -n 'N,Mp' <file>` is available in this sandbox; use workspace_read_file to read and workspace_write_file to edit");
        const f = operands[1] === undefined ? stdin : this.read(this.abs(operands[1], state.cwd));
        if (f === undefined) return fail(2, `sed: can't read ${operands[1]}: No such file or directory`);
        const ls = lines(text(f));
        const to = m[2] === undefined ? Number(m[1]) : m[2] === "$" ? ls.length : Number(m[2]);
        return ok(ls.slice(Number(m[1]) - 1, to).map((x) => `${x}\n`).join(""));
      }
      case "file": {
        const out = operands.map((p) => {
          const f = this.read(this.abs(p, state.cwd));
          if (f === undefined) return `${p}: cannot open \`${p}' (No such file or directory)`;
          const b = typeof f === "string" ? Buffer.from(f) : Buffer.from(f);
          if (b.length >= 4 && b.subarray(0, 4).toString("latin1") === "\u007fELF") return `${p}: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, stripped`;
          if (b.length > 24 && b.subarray(1, 4).toString("latin1") === "PNG") return `${p}: PNG image data, ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}, 8-bit/color RGB, non-interlaced`;
          return `${p}: ${b.length ? "ASCII text" : "empty"}`;
        });
        return ok(`${out.join("\n")}\n`);
      }
      case "find": {
        const root = this.abs(operands[0] && !operands[0].startsWith("-") ? operands[0] : ".", state.cwd);
        const i = args.indexOf("-name");
        const glob = i >= 0 && args[i + 1] ? new RegExp(`^${args[i + 1]!.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`) : undefined;
        if (!this.isDir(root)) return fail(1, `find: '${operands[0]}': No such file or directory`);
        const shown = (path: string) => (operands[0]?.startsWith("/") ? path : `.${path.slice(root.length)}` || ".");
        const found = [...this.files.keys()].filter((f) => f.startsWith(`${root === "/" ? "" : root}/`) && (!glob || glob.test(f.split("/").at(-1)!))).sort().map(shown);
        return ok(found.map((f) => `${f}\n`).join(""));
      }
      case "grep": return this.grep(args, stdin, state.cwd, false);
      case "git": return this.git(args, stdin, state);
    }
    void status;
    const versions = this.script.installed ?? {};
    if (name in versions) {
      if (args.length === 1 && ["--version", "-V", "-v", "version"].includes(args[0]!)) return ok(`${versions[name]}\n`);
      // Nothing here can run arbitrary code, and pretending it ran would be worse.
      return fail(126, `${name}: restricted in this sandbox: it runs the repository's own scripts and targets only (inline code, other files and other options are not allowed)`);
    }
    return fail(127, `bash: line 1: ${name}: command not found`);
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
      re = new RegExp(flags.includes("F") ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, flags.includes("i") ? "i" : "");
    } catch {
      return fail(2, `grep: Invalid regular expression`);
    }
    const sources: [string, string][] = [];
    const under = (dir: string) => [...this.files.keys()].filter((f) => f.startsWith(`${dir}/`)).sort();
    if (tracked) for (const f of under(WORKDIR)) sources.push([f.slice(WORKDIR.length + 1), text(this.files.get(f)!)]);
    else if (!paths.length && !flags.includes("r")) sources.push(["", stdin]);
    else for (const p of paths.length ? paths : ["."]) {
      const path = this.abs(p, cwd);
      const f = this.read(path);
      if (f !== undefined) sources.push([p, text(f)]);
      else if (this.isDir(path)) for (const child of under(path)) sources.push([`${p === "." ? "" : `${p.replace(/\/$/, "")}/`}${child.slice(path.length + 1)}`, text(this.files.get(child)!)]);
      else return fail(2, `grep: ${p}: No such file or directory`);
    }
    const named = sources.length > 1 || tracked || flags.includes("r");
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
    return { exitCode: unique.length ? 0 : 1, stdout: flags.includes("c") ? `${unique.length}\n` : unique.map((l) => `${l}\n`).join(""), stderr: "" };
  }

  // ── git ──
  // The checkout as a clone of `url` leaves it: the script's files, on `branch`.
  checkout(url: string, branch = "main"): void {
    const head = new Map<string, string | Uint8Array>(Object.entries(this.script.files));
    for (const [rel, content] of head) this.write(`${WORKDIR}/${rel}`, content);
    this.repo = { url, branch, branches: new Set([branch]), head, staged: new Set(), commits: [{ sha: sha("9c1d2e3"), subject: "Price widgets by size" }, { sha: sha("7a6b5c4"), subject: "Initial commit" }] };
  }

  private changes(): { path: string; kind: "modified" | "untracked" | "deleted" }[] {
    const repo = this.repo!;
    const out: { path: string; kind: "modified" | "untracked" | "deleted" }[] = [];
    const same = (a: string | Uint8Array, b: string | Uint8Array) => text(a) === text(b);
    for (const [f, content] of this.files) {
      if (!f.startsWith(`${WORKDIR}/`)) continue;
      const rel = f.slice(WORKDIR.length + 1);
      const was = repo.head.get(rel);
      if (was === undefined) out.push({ path: rel, kind: "untracked" });
      else if (!same(was, content)) out.push({ path: rel, kind: "modified" });
    }
    for (const rel of repo.head.keys()) if (!this.files.has(`${WORKDIR}/${rel}`)) out.push({ path: rel, kind: "deleted" });
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  private git(all: string[], stdin: string, state: { cwd: string }): ExecResult {
    // Global options: -c key=value (any number), -C <dir>.
    const args = [...all];
    let cwd = state.cwd;
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
      const operands = rest.filter((a, i) => !a.startsWith("-") && rest[i - 1] !== "--branch" && rest[i - 1] !== "-b" && rest[i - 1] !== "--depth");
      const [url, dest] = operands;
      const b = rest.indexOf("--branch") >= 0 ? rest[rest.indexOf("--branch") + 1] : rest.indexOf("-b") >= 0 ? rest[rest.indexOf("-b") + 1] : undefined;
      if (!url) return fail(129, "usage: git clone [<options>] [--] <repo> [<dir>]");
      const to = this.abs(dest ?? url.split("/").at(-1)!.replace(/\.git$/, ""), cwd);
      if (to !== WORKDIR) return fail(128, `fatal: could not create work tree dir '${dest}': Permission denied`);
      if (this.repo) return fail(128, `fatal: destination path '${dest}' already exists and is not an empty directory.`);
      if (!authed) return fail(128, `Cloning into '${to}'...\n${NO_ACCESS}`);
      this.checkout(url, b);
      return { exitCode: 0, stdout: "", stderr: `Cloning into '${to}'...\n` };
    }
    const repo = this.repo;
    if (!repo || !(cwd === WORKDIR || cwd.startsWith(`${WORKDIR}/`))) return fail(128, "fatal: not a git repository (or any of the parent directories): .git");
    const flags = rest.filter((a) => a.startsWith("-"));
    const operands = rest.filter((a) => !a.startsWith("-"));
    const rel = (p: string) => this.abs(p, cwd).slice(WORKDIR.length + 1);
    const short = (s: string) => s.slice(0, 7);
    const stat = (paths: string[]) => {
      let plus = 0, minus = 0;
      const rows = paths.map((p) => {
        const before = lines(text(repo.head.get(p) ?? "")), after = lines(text(this.files.get(`${WORKDIR}/${p}`) ?? ""));
        const d = diffLines(before, after);
        const added = d.added.length, removed = d.removed.length;
        plus += added;
        minus += removed;
        return ` ${p} | ${added + removed} ${"+".repeat(added)}${"-".repeat(removed)}`;
      });
      const summary = ` ${paths.length} file${paths.length === 1 ? "" : "s"} changed${plus ? `, ${plus} insertion${plus === 1 ? "" : "s"}(+)` : ""}${minus ? `, ${minus} deletion${minus === 1 ? "" : "s"}(-)` : ""}`;
      return { rows, summary };
    };

    switch (sub) {
      case "config": {
        if (operands.length === 1 && !flags.includes("--unset")) return operands[0] === "user.name" ? ok("octo\n") : operands[0] === "user.email" ? ok("1+octo@users.noreply.github.com\n") : { exitCode: 1, stdout: "", stderr: "" };
        return ok();
      }
      case "remote":
        if (operands[0] === "get-url") return ok(`${repo.url}\n`);
        return ok(flags.includes("-v") ? `origin\t${repo.url} (fetch)\norigin\t${repo.url} (push)\n` : "origin\n");
      case "fetch":
        return authed ? ok() : fail(128, NO_ACCESS);
      case "pull":
      case "push":
        return fail(128, NO_ACCESS);
      case "status": {
        const changes = this.changes();
        if (flags.some((f) => f === "--porcelain" || f === "--short" || f === "-s" || f === "-sb")) {
          const head = flags.includes("-sb") ? `## ${repo.branch}\n` : "";
          return ok(head + changes.map((c) => `${c.kind === "untracked" ? (repo.staged.has(c.path) ? "A " : "??") : repo.staged.has(c.path) ? `${c.kind === "deleted" ? "D" : "M"} ` : ` ${c.kind === "deleted" ? "D" : "M"}`} ${c.path}\n`).join(""));
        }
        const out = [`On branch ${repo.branch}`];
        const staged = changes.filter((c) => repo.staged.has(c.path)), unstaged = changes.filter((c) => !repo.staged.has(c.path) && c.kind !== "untracked"), untracked = changes.filter((c) => !repo.staged.has(c.path) && c.kind === "untracked");
        if (staged.length) out.push("Changes to be committed:", '  (use "git restore --staged <file>..." to unstage)', ...staged.map((c) => `\t${c.kind === "untracked" ? "new file" : c.kind}:   ${c.path}`), "");
        if (unstaged.length) out.push("Changes not staged for commit:", '  (use "git add <file>..." to update what will be committed)', ...unstaged.map((c) => `\t${c.kind}:   ${c.path}`), "");
        if (untracked.length) out.push("Untracked files:", '  (use "git add <file>..." to include in what will be committed)', ...untracked.map((c) => `\t${c.path}`), "");
        if (!changes.length) out.push("nothing to commit, working tree clean");
        else if (!staged.length) out.push(unstaged.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : 'nothing added to commit but untracked files present (use "git add" to track)');
        return ok(`${out.join("\n")}\n`);
      }
      case "add": {
        const changes = this.changes();
        const everything = flags.some((f) => f === "-A" || f === "--all" || f === "-u") || operands.includes(".");
        for (const p of operands.filter((o) => o !== ".")) {
          const path = rel(p);
          const under = changes.filter((c) => c.path === path || c.path.startsWith(`${path}/`));
          if (!under.length && !repo.head.has(path) && this.read(`${WORKDIR}/${path}`) === undefined && !this.isDir(`${WORKDIR}/${path}`)) return fail(128, `fatal: pathspec '${p}' did not match any files`);
          for (const c of under) repo.staged.add(c.path);
        }
        if (everything) for (const c of changes) repo.staged.add(c.path);
        return ok();
      }
      case "commit": {
        const changes = this.changes();
        if (flags.some((f) => /^-[a-z]*a[a-z]*$/.test(f) || f === "--all")) for (const c of changes) if (c.kind !== "untracked") repo.staged.add(c.path);
        const m = rest.findIndex((a) => /^-[a-z]*m$/.test(a) || a === "--message");
        const message = m >= 0 ? rest[m + 1] : rest.find((a) => a.startsWith("--message="))?.slice(10);
        const staged = changes.filter((c) => repo.staged.has(c.path));
        if (!staged.length) return { exitCode: 1, stdout: `On branch ${repo.branch}\n${changes.length ? 'no changes added to commit (use "git add" and/or "git commit -a")' : "nothing to commit, working tree clean"}\n`, stderr: "" };
        if (!message) return fail(1, "error: no commit message given; use `git commit -m \"<message>\"` (no editor in this sandbox)");
        const { summary } = stat(staged.map((c) => c.path));
        for (const c of staged) {
          const now = this.files.get(`${WORKDIR}/${c.path}`);
          if (now === undefined) repo.head.delete(c.path);
          else repo.head.set(c.path, now);
        }
        repo.staged.clear();
        const subject = message.split("\n")[0]!;
        const id = sha(`${repo.commits[0]!.sha}\n${message}\n${staged.map((c) => c.path).join(",")}`);
        repo.commits.unshift({ sha: id, subject });
        return ok(`[${repo.branch} ${short(id)}] ${subject}\n${summary}\n`);
      }
      case "checkout":
      case "switch": {
        const create = flags.some((f) => f === "-b" || f === "-c" || f === "-B" || f === "-C");
        const to = operands[0];
        if (!to) return fail(128, "fatal: missing branch or commit argument");
        if (create) {
          if (repo.branches.has(to) && !flags.some((f) => f === "-B" || f === "-C")) return fail(128, `fatal: a branch named '${to}' already exists`);
          repo.branches.add(to);
          repo.branch = to;
          return { exitCode: 0, stdout: "", stderr: `Switched to a new branch '${to}'\n` };
        }
        if (!repo.branches.has(to)) return fail(1, `error: pathspec '${to}' did not match any file(s) known to git`);
        repo.branch = to;
        return { exitCode: 0, stdout: "", stderr: `Switched to branch '${to}'\n` };
      }
      case "branch": {
        if (flags.includes("--show-current")) return ok(`${repo.branch}\n`);
        if (operands[0] && !flags.length) { repo.branches.add(operands[0]); return ok(); }
        return ok([...repo.branches].sort().map((b) => `${b === repo.branch ? "*" : " "} ${b}\n`).join("") + (flags.some((f) => f === "-a" || f === "-r") ? "  remotes/origin/HEAD -> origin/main\n  remotes/origin/main\n" : ""));
      }
      case "log": {
        if (flags.some((f) => f.startsWith("--format=") || f.startsWith("--pretty=format"))) return ok("");
        const n = flags.find((f) => /^-\d+$/.test(f)) ?? (flags.includes("-n") ? `-${operands[0]}` : undefined);
        const commits = repo.commits.slice(0, n ? Number(n.slice(1)) : undefined);
        if (flags.some((f) => f === "--oneline" || f.startsWith("--pretty=oneline"))) return ok(commits.map((c) => `${short(c.sha)} ${c.subject}\n`).join(""));
        return ok(commits.map((c) => `commit ${c.sha}\nAuthor: octo <1+octo@users.noreply.github.com>\nDate:   Thu Nov 19 10:00:00 2026 +0000\n\n    ${c.subject}\n`).join("\n"));
      }
      case "rev-parse": {
        if (flags.includes("--show-toplevel")) return ok(`${WORKDIR}\n`);
        if (flags.includes("--abbrev-ref")) return ok(`${operands[0] === "origin/HEAD" ? "origin/main" : repo.branch}\n`);
        if (flags.includes("--is-inside-work-tree")) return ok("true\n");
        return ok(`${flags.includes("--short") ? short(repo.commits[0]!.sha) : repo.commits[0]!.sha}\n`);
      }
      case "diff":
      case "show": {
        const cached = flags.some((f) => f === "--cached" || f === "--staged");
        if (sub === "show" && flags.includes("--stat")) return ok(`commit ${repo.commits[0]!.sha}\n\n    ${repo.commits[0]!.subject}\n`);
        // `git show HEAD:<path>`: the file as committed.
        const at = sub === "show" ? /^(?:HEAD|[0-9a-f]{7,40}):(.+)$/.exec(operands[0] ?? "") : null;
        if (at) {
          const f = repo.head.get(at[1]!.replace(/^\.\//, ""));
          return f === undefined ? fail(128, `fatal: path '${at[1]}' does not exist in 'HEAD'`) : ok(text(f));
        }
        if (sub === "show") return ok(`commit ${repo.commits[0]!.sha}\nAuthor: octo <1+octo@users.noreply.github.com>\nDate:   Thu Nov 19 10:00:00 2026 +0000\n\n    ${repo.commits[0]!.subject}\n`);
        if (operands.some((o) => o.includes("origin/") || o.includes("HEAD~") || o.includes(".."))) return ok("");
        const paths = this.changes().filter((c) => c.kind !== "untracked" && repo.staged.has(c.path) === cached && (!operands.length || operands.map(rel).includes(c.path))).map((c) => c.path);
        if (!paths.length) return ok("");
        if (flags.includes("--name-only")) return ok(paths.map((p) => `${p}\n`).join(""));
        if (flags.includes("--stat")) { const s = stat(paths); return ok(`${s.rows.join("\n")}\n${s.summary}\n`); }
        return ok(paths.map((p) => {
          const before = lines(text(repo.head.get(p) ?? "")), after = lines(text(this.files.get(`${WORKDIR}/${p}`) ?? ""));
          // One hunk, as git prints it: up to three lines of context either side.
          const d = diffLines(before, after);
          const lead = before.slice(Math.max(0, d.prefix - 3), d.prefix), trail = before.slice(before.length - d.suffix, before.length - d.suffix + 3);
          const from = d.prefix - lead.length + 1;
          const oldCount = lead.length + d.removed.length + trail.length, newCount = lead.length + d.added.length + trail.length;
          const index = `index ${sha(text(repo.head.get(p) ?? "")).slice(0, 7)}..${sha(text(this.files.get(`${WORKDIR}/${p}`) ?? "")).slice(0, 7)} 100644`;
          const body = [...lead.map((l) => ` ${l}`), ...d.removed.map((l) => `-${l}`), ...d.added.map((l) => `+${l}`), ...trail.map((l) => ` ${l}`)];
          return `diff --git a/${p} b/${p}\n${index}\n--- a/${p}\n+++ b/${p}\n@@ -${oldCount ? from : 0},${oldCount} +${newCount ? from : 0},${newCount} @@\n${body.join("\n")}\n`;
        }).join(""));
      }
      case "grep": return this.grep(rest, stdin, cwd, true);
      case "ls-files": return ok([...repo.head.keys()].sort().map((f) => `${f}\n`).join(""));
      case "stash":
      case "restore":
      case "reset":
        return ok();
    }
    return fail(1, `git: '${sub}' is not a git command. See 'git --help'.`);
  }
}
