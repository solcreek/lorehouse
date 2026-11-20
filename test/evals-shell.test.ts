// The simulated shell a code case's sandbox runs (evals/shell.ts): it has to answer the
// commands a model checks its tools with as bash and git would, or the model, rightly,
// stops trusting the sandbox (which is what a real run against "ran:<command>" showed);
// and what it can't run it must refuse out loud, and count.

import { expect, test } from "bun:test";
import { BENCH, widgets, WIDGETS } from "../evals/cases/widgets";
import { CASES } from "../evals/cases";
import { scriptedSandbox } from "../evals/sandbox";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chartPng, Shell, WORKDIR } from "../evals/shell";
import { gitWithToken } from "../src/tools/git-credential";

const URL_ = "https://github.com/acme/widgets.git";
const ME = { GIT_AUTHOR_NAME: "octo", GIT_AUTHOR_EMAIL: "1+octo@users.noreply.github.com", GIT_COMMITTER_NAME: "octo", GIT_COMMITTER_EMAIL: "1+octo@users.noreply.github.com" };
const fresh = () => new Shell(widgets.shell!);
function cloned(repo = URL_): Shell {
  const sh = fresh();
  expect(sh.exec(gitWithToken(`clone --branch main ${repo} ${WORKDIR}`), "/").exitCode).toBe(0);
  return sh;
}
const README = "# widgets\n\nWidgets for Acme.\n\n## Develop\n\n    bun install\n    bun test\n";
const TESTS_END = " 3 pass\n 0 fail\nRan 3 tests across 1 file. [21.00ms]\n";

// One row: commands run in order in one checkout (as the model would, each its own exec),
// and what the last one answers. A string is its exact stdout with exit 0; a RegExp is
// tested against stdout; an object names what to hold (stdout, stderr or code).
type Want = string | RegExp | { stdout?: string | RegExp; stderr?: string | RegExp; code?: number };
const TABLE: [name: string, commands: string[], want: Want][] = [
  // ── the shell ──
  ["echo", ["echo hello"], "hello\n"],
  ["a ; b and $?", ['false; echo "exit=$?"'], "exit=1\n"],
  ["a && b runs b after success", ["true && echo yes"], "yes\n"],
  ["a && b skips b after failure", ["false && echo yes"], { stdout: "", code: 1 }],
  ["a || b runs b after failure", ["ls nope 2>/dev/null || echo missing"], "missing\n"],
  ["the README's own line", ["bun install && bun test"], new RegExp(`^bun install v1\\.4\\.3[\\s\\S]*${TESTS_END.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`)],
  ["VAR=x cmd is that command's only", ["GREETING=hi env | grep GREETING; echo \"[$GREETING]\""], "GREETING=hi\n[]\n"],
  ["VAR=x alone, then $VAR and ${VAR}", ['NAME=widgets; echo "$NAME ${NAME}" $NAME'], "widgets widgets widgets\n"],
  ["export, then $VAR in a later command of the line", ["export CI=1 && echo ci=$CI"], "ci=1\n"],
  ["an unset variable is nothing; single quotes keep the $", ["echo a${NOPE}b $NOPE 'c $NOPE'"], "ab c $NOPE\n"],
  ["env prefix before a program", ["CI=1 NODE_ENV=test bun test | tail -3"], TESTS_END],
  ["env VAR=x cmd", ["env FOO=bar echo ok"], "ok\n"],
  ["2> sends stderr to a file", ["cat nope.txt 2> err.log; cat err.log"], "cat: nope.txt: No such file or directory\n"],
  [">&2 sends stdout to stderr, and makes no file", ["echo oops >&2; ls"], { stdout: /^Makefile\nREADME\.md\nbench\ncatalog\.json\npackage\.json\nscripts\nsrc\ntest\n$/ }],
  [">&2 is on stderr", ["echo oops >&2"], { stdout: "", stderr: "oops\n", code: 0 }],
  ["2>&1 joins stderr to the pipe", ["cat nope.txt 2>&1 | wc -l"], "1\n"],
  ["&> sends both to a file", ["cat README.md nope.txt &> all.log; wc -l all.log"], "9 all.log\n"],
  ["> /dev/null", ["echo gone > /dev/null; ls /dev 2>/dev/null; echo done"], "done\n"],
  ["a glob expands to the files it matches", ["ls scripts/*.ts"], "scripts/bench.ts\nscripts/count.ts\n"],
  ["a glob that matches nothing stays as written", ["echo *.nope"], "*.nope\n"],
  ["a quoted glob is not expanded", ["echo '*.md' \"*.md\" *.md"], "*.md *.md README.md\n"],
  ["? in a glob", ["ls src/widget?.ts"], "src/widgets.ts\n"],
  ["cp", ["cp README.md COPY.md && cat COPY.md"], README],
  ["cp -r", ["cp -r scripts tools && ls tools"], "bench.ts\ncount-widgets.sh\ncount.ts\nplot_bench.py\n"],
  ["mv", ["mv README.md docs.md && ls *.md"], "docs.md\n"],
  ["mv into a directory", ["mv README.md src/ && ls src"], "README.md\nwidgets.ts\n"],
  ["ls -l shows the exec bit a clone gives a script", ["ls -l scripts/count-widgets.sh"], /^-rwxr-xr-x 1 root root +\d+ Nov 19 10:00 scripts\/count-widgets\.sh\n$/],
  ["chmod +x", ["chmod +x scripts/count.ts && ls -l scripts/count.ts"], /^-rwxr-xr-x /],
  ["chmod 644 takes it away", ["chmod 644 scripts/count-widgets.sh && ls -l scripts/count-widgets.sh && test -x scripts/count-widgets.sh || echo no"], /^-rw-r--r-- .*\nno\n$/],
  ["tee", ["echo line | tee out.txt && cat out.txt"], "line\nline\n"],
  ["tee -a", ["echo one > log; echo two | tee -a log > /dev/null; cat log"], "one\ntwo\n"],
  ["env", ["env | grep -c ="], /^\d+\n$/],
  ["sleep", ["sleep 2 && echo awake"], "awake\n"],
  ["time", ["time bun test | tail -1"], { stdout: "Ran 3 tests across 1 file. [21.00ms]\n", stderr: /real\t0m/ }],
  ["set -e stops at the first failure", ["set -e\ncat nope.txt\necho after"], { stdout: "", code: 1 }],
  ["a here-document", ["cat > notes.md <<'EOF'\n# Notes\nline two\nEOF\ncat notes.md"], "# Notes\nline two\n"],
  ["cd, pwd, ls", ["cd scripts && pwd && ls"], "/workspace/repo/scripts\nbench.ts\ncount-widgets.sh\ncount.ts\nplot_bench.py\n"],
  ["tail, wc", ['tail -2 README.md; echo "---"; wc -l README.md'], "    bun install\n    bun test\n---\n8 README.md\n"],
  ["sed -n", ["sed -n '1,3p' README.md"], "# widgets\n\nWidgets for Acme.\n"],
  ["cat -n | tail", ["cat -n README.md | tail -1"], "     8\t    bun test\n"],
  ["grep -n with context", ["grep -n -A1 '^bench:' Makefile"], "1:bench:\n2-\tbun scripts/bench.ts\n"],
  ["find -name", ["find . -name '*.ts'"], "./scripts/bench.ts\n./scripts/count.ts\n./src/widgets.ts\n./test/widgets.test.ts\n"],
  ["a failure's exit code and stderr", ["head -1 README.md && cat nope.txt"], { stdout: "# widgets\n", stderr: "cat: nope.txt: No such file or directory\n", code: 1 }],
  ["which, type, command -v", ["which make; type make echo; command -v python3"], "/usr/bin/make\nmake is /usr/bin/make\necho is a shell builtin\n/usr/bin/python3\n"],
  ["what which names is a binary", ["file /usr/bin/make"], /^\/usr\/bin\/make: ELF 64-bit LSB pie executable/],
  ["versions are each program's own", ["python3 -V; make --version | head -1; bun --version"], "Python 3.12.3\nGNU Make 4.3\n1.4.3\n"],
  // ── the fixtures agree with themselves ──
  ["the catalog holds what the script counts", ["cat catalog.json | grep -o w | wc -l; ./scripts/count-widgets.sh"], { stdout: new RegExp(`widgets counted: ${WIDGETS}\n$`) }],
  ["the count, by any of its names", ["bun scripts/count.ts && bun run count && sh scripts/count-widgets.sh"], `widgets counted: ${WIDGETS}\n`.repeat(3)],
  ["make bench prints the results file's numbers", ["make bench"], BENCH],
  ["make -n says what it would run, and that runs", ["make -n bench && bun scripts/bench.ts | tail -1"], "bun scripts/bench.ts\nbench total 290 ms (5 benchmarks)\n"],
  ["the plot script writes a real PNG", ['python3 scripts/plot_bench.py; echo "exit=$?"; file bench.png'], "wrote bench.png\nexit=0\nbench.png: PNG image data, 640 x 400, 8-bit/color RGB, non-interlaced\n"],
  ["the tests name the test file's three tests", ["grep -c '^test(' test/widgets.test.ts; bun test | grep -c '(pass)'"], "3\n3\n"],
  // ── git ──
  ["status, clean", ["git status"], "On branch main\nYour branch is up to date with 'origin/main'.\n\nnothing to commit, working tree clean\n"],
  ["status --short after an edit and a new file", ["echo x >> README.md; touch new.txt; git status --short"], " M README.md\n?? new.txt\n"],
  ["diff --stat", ["echo 'Questions? Ask in #widgets.' >> README.md; git diff --stat"], " README.md | 1 +\n 1 file changed, 1 insertion(+)\n"],
  ["diff, as a patch with context", ["echo 'Questions? Ask in #widgets.' >> README.md; git --no-pager diff"], /^diff --git a\/README\.md b\/README\.md\nindex [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/README\.md\n\+\+\+ b\/README\.md\n@@ -6,3 \+6,4 @@\n \n     bun install\n     bun test\n\+Questions\? Ask in #widgets\.\n$/],
  ["diff HEAD sees staged and unstaged", ["echo a >> README.md; git add README.md; echo b >> Makefile; git diff HEAD --name-only"], "Makefile\nREADME.md\n"],
  ["diff is only what isn't staged; --cached what is", ["echo a >> README.md; git add README.md; echo b >> Makefile; git diff --name-only; echo --; git diff --cached --name-only"], "Makefile\n--\nREADME.md\n"],
  ["diff main, from a branch with a commit", ["git checkout -b scout/x", "echo a >> README.md && git commit -qam 'docs: a'", "git diff main --stat"], " README.md | 1 +\n 1 file changed, 1 insertion(+)\n"],
  ["diff HEAD~1", ["echo a >> README.md && git commit -qam 'docs: a'", "git diff HEAD~1 --name-only"], "README.md\n"],
  ["diff origin/main...HEAD", ["echo a >> README.md && git commit -qam 'docs: a'", "echo b >> Makefile", "git diff origin/main...HEAD --name-only"], "README.md\n"],
  ["diff of nothing", ["git diff HEAD"], ""],
  ["nothing staged: commit says so and fails", ["echo a >> README.md; git commit -m 'docs: a'"], { code: 1, stdout: /no changes added to commit/ }],
  ["checkout -b, add, commit, log --oneline -1", ["echo 'Questions? Ask in #widgets.' >> README.md", 'git checkout -b scout/readme && git add README.md && git commit -m "docs: say where to ask" && git log --oneline -1'], { stdout: /^\[scout\/readme ([0-9a-f]{7})\] docs: say where to ask\n 1 file changed, 1 insertion\(\+\)\n\1 docs: say where to ask\n$/, stderr: "Switched to a new branch 'scout/readme'\n" }],
  ["after a commit the tree is clean and HEAD names the branch", ["git checkout -qb scout/x 2>/dev/null; echo a >> README.md; git commit -qam m", "git status --porcelain; git branch --show-current"], "scout/x\n"],
  ["log origin/main..HEAD is only the commits ahead", ["echo a >> README.md && git commit -qam 'docs: a'", "echo b >> README.md && git commit -qam 'docs: b'", "git log origin/main..HEAD --format=%s"], "docs: b\ndocs: a\n"],
  ["log origin/main..HEAD with nothing ahead", ["git log origin/main..HEAD --oneline"], ""],
  ["log -1 --format=%H is a full id", ["git log -1 --format=%H"], /^[0-9a-f]{40}\n$/],
  ["log --format with several fields", ["echo a >> README.md && git commit -qam 'docs: a'", "git log -1 --format='%h %an <%ae> %s'"], /^[0-9a-f]{7} octo <1\+octo@users\.noreply\.github\.com> docs: a\n$/],
  ["log -1 --stat", ["echo a >> README.md && git commit -qam 'docs: a'", "git log -1 --stat"], /^commit [0-9a-f]{40}\nAuthor: octo <1\+octo@users\.noreply\.github\.com>\nDate: .*\n\n    docs: a\n\n README\.md \| 1 \+\n 1 file changed, 1 insertion\(\+\)\n$/],
  ["show", ["echo a >> README.md && git commit -qam 'docs: a'", "git show"], /^commit [0-9a-f]{40}\nAuthor: octo .*\n[\s\S]*    docs: a\n\ndiff --git a\/README\.md b\/README\.md\n[\s\S]*\n\+a\n$/],
  ["show --stat", ["echo a >> README.md && git commit -qam 'docs: a'", "git show --stat HEAD"], /    docs: a\n\n README\.md \| 1 \+\n 1 file changed, 1 insertion\(\+\)\n$/],
  ["show HEAD:path is the file as committed", ["echo a >> README.md", "git show HEAD:README.md"], README],
  ["checkout -- <file> puts it back", ["echo a >> README.md", "git checkout -- README.md && git status --porcelain && cat README.md"], README],
  ["restore <file>", ["echo a >> README.md", "git restore README.md && git status --porcelain && tail -1 README.md"], "    bun test\n"],
  ["restore --staged unstages", ["echo a >> README.md; git add .; git restore --staged README.md; git status --short"], " M README.md\n"],
  ["reset --hard drops the edits", ["echo a >> README.md; git add README.md", "git reset --hard && git status --porcelain && tail -1 README.md"], /^HEAD is now at [0-9a-f]{7} Add sources, tests and scripts\n    bun test\n$/],
  ["reset --hard HEAD~1 drops the commit", ["echo a >> README.md && git commit -qam 'docs: a'", "git reset --hard HEAD~1 > /dev/null && git log origin/main..HEAD --oneline && tail -1 README.md"], "    bun test\n"],
  ["reset --soft HEAD~1 keeps the change staged", ["echo a >> README.md && git commit -qam 'docs: a'", "git reset --soft HEAD~1 && git status --short"], "M  README.md\n"],
  ["commit --amend -m replaces the last commit", ["echo a >> README.md && git commit -qam 'wip'", "git commit --amend -qm 'docs: a' && git log origin/main..HEAD --format=%s"], "docs: a\n"],
  ["commit --amend --no-edit takes in what is staged", ["echo a >> README.md && git commit -qam 'docs: a'", "echo b >> Makefile && git add Makefile && git commit --amend --no-edit -q && git show --stat --oneline HEAD | tail -1"], " 2 files changed, 2 insertions(+)\n"],
  ["git grep", ["git grep -n price -- src"], "src/widgets.ts:2:export const price = (size: number) => size * 3;\n"],
  ["the pull request tool's questions", ["git status --porcelain; git remote get-url origin; git rev-parse --abbrev-ref origin/HEAD"], `${URL_}\norigin/main\n`],
  ["a plain clone, fetch or push has no access to GitHub", ["git fetch origin"], { code: 128, stderr: /could not read Username/ }],
];

for (const [name, commands, want] of TABLE) {
  test(`shell: ${name}`, () => {
    const sh = cloned();
    let r = { exitCode: 0, stdout: "", stderr: "" };
    for (const command of commands) r = sh.exec(command, WORKDIR, ME);
    const w = typeof want === "string" || want instanceof RegExp ? { stdout: want, code: 0 } : want;
    if (typeof w.stdout === "string") expect(r.stdout).toBe(w.stdout);
    else if (w.stdout) expect(r.stdout).toMatch(w.stdout);
    if (typeof w.stderr === "string") expect(r.stderr).toBe(w.stderr);
    else if (w.stderr) expect(r.stderr).toMatch(w.stderr);
    if (w.code !== undefined) expect({ code: r.exitCode, stderr: r.stderr }).toMatchObject({ code: w.code });
    // Nothing in the table is something the shell refuses.
    expect(sh.refused).toEqual([]);
  });
}

// What it can't run: refused in the words a real, small sandbox would use for that
// situation (a missing program, a tool's own usage error, a syntax error), and kept on
// the record with the real reason. [command, the part refused, exit code, what the model sees]
const REFUSED: [command: string, part: string, code: number, said: string | RegExp][] = [
  ["xxd -l 16 bench.png", "xxd -l 16 bench.png", 127, "sh: 1: xxd: not found\n"],
  ["cargo test", "cargo test", 127, "sh: 1: cargo: not found\n"],
  ["od -c README.md", "od -c README.md", 127, "sh: 1: od: not found\n"],
  ["python3 -c \"print('alive')\"", "python3 -c print('alive')", 2, "Unknown option: -c\nusage: python3 [option] ... [-c cmd | -m mod | file | -] [arg] ...\nTry `python -h' for more information.\n"],
  ["echo 'print(1)' > /tmp/t.py; python3 /tmp/t.py", "python3 /tmp/t.py", 2, "python3: can't open file '/tmp/t.py': [Errno 13] Permission denied\n"],
  ["python3 nope.py", "python3 nope.py", 2, "python3: can't open file '/workspace/repo/nope.py': [Errno 2] No such file or directory\n"],
  ["touch /tmp/t.ts; bun /tmp/t.ts", "bun /tmp/t.ts", 1, 'error: EACCES reading "/tmp/t.ts"\n'],
  ["bun run lint", "bun run lint", 1, 'error: Script not found "lint"\n'],
  ["make all", "make all", 2, "make: *** No rule to make target 'all'.  Stop.\n"],
  ["make -d bench", "make -d bench", 2, /^make: invalid option -- 'd'\nUsage: make/],
  ["git stash", "git stash", 1, "git: 'stash' is not a git command. See 'git --help'.\n"],
  ["git cherry-pick HEAD", "git cherry-pick HEAD", 1, "git: 'cherry-pick' is not a git command. See 'git --help'.\n"],
  ["git add -p", "git add -p", 129, /^error: unknown option `p'\nusage: git add/],
  ["sed -i 's/a/b/' README.md", "sed -i s/a/b/ README.md", 1, /^sed: invalid option -- 'i'\nUsage: sed/],
  ["sed 's/a/b/' README.md", "sed s/a/b/ README.md", 1, "sed: -e expression #1, char 1: unknown command: `s'\n"],
  ["echo $(date)", "echo $(date)", 2, 'sh: 1: Syntax error: "(" unexpected\n'],
  ["echo `date`", "echo `date`", 2, "sh: 1: Syntax error: EOF in backquote substitution\n"],
  ["for f in *.md; do echo $f; done", "for f in *.md; do echo $f; done", 2, 'sh: 1: Syntax error: "for" unexpected\n'],
  ["if [ -f README.md ]; then echo yes; fi", "if [ -f README.md ]; then echo yes; fi", 2, 'sh: 1: Syntax error: "if" unexpected\n'],
  ["(cd src && ls)", "(cd src && ls)", 2, 'sh: 1: Syntax error: "(" unexpected\n'],
  ["bun test &", "bun test &", 2, 'sh: 1: Syntax error: "&" unexpected\n'],
  ["chmod 644 scripts/count.ts; ./scripts/count.ts", "./scripts/count.ts", 126, "sh: 1: ./scripts/count.ts: Permission denied\n"],
];
// What would tell a model it is being evaluated. None of it may reach the model.
const GIVEAWAY = /\b(evals?|evaluat\w*|simulat\w*|mock\w*|fake\w*|conformance|harness|fixtures?)\b/i;

for (const [command, part, code, said] of REFUSED) {
  test(`shell refuses as a real sandbox would, and keeps the reason: ${command}`, () => {
    const sh = cloned();
    const r = sh.exec(command, WORKDIR, ME);
    expect({ code: r.exitCode, stderr: r.stderr }).toMatchObject({ code });
    if (typeof said === "string") expect(r.stderr).toBe(said);
    else expect(r.stderr).toMatch(said);
    // The model is never told what this is; the record is.
    expect(r.stdout + r.stderr).not.toMatch(GIVEAWAY);
    const kept = sh.refused.find((x) => x.part === part);
    expect(kept).toBeDefined();
    expect(kept!.said).toBe(r.stderr.trim());
    expect(kept!.why).toMatch(/simulated|programs/);
    // Never a silent success.
    expect(r.stdout).not.toContain("alive");
  });
}

test("a path that isn't there is not found, as a shell says, and that is no gap", () => {
  const sh = cloned();
  expect(sh.exec("./scripts/nope.sh", WORKDIR, ME)).toEqual({ exitCode: 127, stdout: "", stderr: "sh: 1: ./scripts/nope.sh: not found\n" });
  expect(sh.exec("cd nowhere", WORKDIR, ME)).toEqual({ exitCode: 2, stdout: "", stderr: "sh: 1: cd: can't cd to nowhere\n" });
  expect(sh.exec("echo 'unterminated", WORKDIR, ME)).toEqual({ exitCode: 2, stdout: "", stderr: "sh: 1: Syntax error: Unterminated quoted string\n" });
  expect(sh.exec("cat < nope.txt", WORKDIR, ME)).toEqual({ exitCode: 2, stdout: "", stderr: "sh: 1: cannot open nope.txt: No such file\n" });
  expect(sh.refused).toEqual([]);
});

test("a refusal inside a pipeline is still said and counted, though the pipeline's exit is its last command's", () => {
  const sh = cloned();
  const r = sh.exec("od -c README.md | tail -2", WORKDIR, ME);
  expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "sh: 1: od: not found\n" });
  expect(sh.refused).toEqual([{ part: "od -c README.md", why: "`od` isn't simulated", said: "sh: 1: od: not found" }]);
});

// Everything a trial can put in front of the model, searched for what would give the
// evaluation away: what the shell prints for the commands a model looks around with, every
// file of the repos it can clone, their history, and the Slack workspace's fixtures. (The
// knowledge corpus, conformance/fixtures/corpus.jsonl, is left out: it is documentation
// whose own subject uses "eval" as a word.)
test("nothing the model can see says it is being evaluated", () => {
  const seen: [string, string][] = [];
  for (const repo of Object.keys(widgets.shell!.repos)) {
    const sh = cloned(`https://github.com/${repo}.git`);
    const look = ["env", "hostname", "uname -a", "whoami", "pwd", "ls -la", "ls -la /", "ls -la /usr/bin", "git log", "git log --stat", "git remote -v", "git status", "git branch -a", "git config --list", "cat .git/HEAD",
      "which git bun python3 make", "bun --version; python3 -V; make --version", "bun test", "bun install", "make bench", "find . -name '*'", ...REFUSED.map(([c]) => c)];
    for (const command of look) {
      const r = sh.exec(command, WORKDIR, ME);
      seen.push([`${repo}: ${command}`, r.stdout + r.stderr]);
    }
    for (const [path, content] of Object.entries(widgets.shell!.repos[repo]!.files)) seen.push([`${repo}: ${path}`, `${path}\n${content}`]);
    for (const p of widgets.shell!.repos[repo]!.programs ?? []) seen.push([`${repo}: program ${p.match}`, `${p.stdout ?? ""}${p.stderr ?? ""}${Object.keys(p.writes ?? {}).join(" ")}`]);
    seen.push([`${repo}: its name`, repo]);
  }
  seen.push(["installed", JSON.stringify(widgets.shell!.installed)]);
  // The Slack workspace: channel names, people, messages.
  seen.push(["slack fixtures", readFileSync(join(import.meta.dir, "../conformance/fixtures/slack-history.json"), "utf8")]);
  // What a background job and a stage answer with (sandbox.ts).
  const sb = scriptedSandbox(widgets);
  sb(exec(gitWithToken(`clone ${URL_} ${WORKDIR}`), "/"));
  sb(exec("echo x >> README.md && git commit -qam 'docs: x'"));
  for (const job of [
    { id: "j", sandbox: "s", op: "guest", method: "POST", path: "/jobs", bodyBase64: b64({ id: "bench-1", command: "make bench", cwd: WORKDIR }) },
    { id: "j", sandbox: "s", op: "guest", method: "GET", path: "/jobs/bench-1?tailBytes=8192" },
    { id: "j", sandbox: "s", op: "guest", method: "GET", path: "/jobs/nope?tailBytes=0" },
    { id: "j", sandbox: "s", op: "stage", bodyBase64: b64({ owner: "acme", name: "widgets", base: "main", branch: "scout/x", token: "t" }) },
  ]) {
    const a = sb(job)!;
    seen.push([`sandbox ${job.op} ${job.path ?? ""}`, `${a.error ?? ""}${a.bodyBase64 ? Buffer.from(a.bodyBase64, "base64").toString() : ""}`]);
  }
  expect(seen.length).toBeGreaterThan(80);
  for (const [where, text] of seen) expect([where, GIVEAWAY.exec(text)?.[0] ?? null]).toEqual([where, null]);
});

// ── the second review's rows: each was answered wrong in silence ─────────────
const ROWS2: [name: string, commands: string[], want: Want][] = [
  ["printf reuses its format for each argument", ["printf '%s\\n' one two three"], "one\ntwo\nthree\n"],
  ["printf with two directives cycles in pairs", ["printf '%s=%d\\n' a 1 b 2"], "a=1\nb=2\n"],
  ["printf with no arguments prints the format once", ["printf 'done\\n'"], "done\n"],
  ["printf %%", ["printf '100%%\\n'"], "100%\n"],
  ["[ 1 -eq 2 ] is false", ["[ 1 -eq 2 ] && echo yes || echo no"], "no\n"],
  ["test 3 -gt 5 is false", ["test 3 -gt 5; echo $?"], "1\n"],
  ["test's numeric operators", ["test 3 -lt 5 && test 5 -ge 5 && test 2 -ne 3 && [ 4 -le 4 ] && echo ok"], "ok\n"],
  ["test's string operators and !", ["[ abc = abc ] && [ abc != abd ] && [ ! -f nope ] && [ -n x ] && [ -z '' ] && echo ok"], "ok\n"],
  ["test of a non-number is an error, not true", ["[ abc -eq 1 ]"], { code: 2, stderr: "sh: 1: [: Illegal number: abc\n" }],
  ["find prints paths under the start point as given", ["find src -name '*.ts'"], "src/widgets.ts\n"],
  ["find . keeps the ./", ["find . -name 'widgets*'"], "./src/widgets.ts\n./test/widgets.test.ts\n"],
  ["find -type d", ["find . -maxdepth 1 -type d"], ".\n./bench\n./scripts\n./src\n./test\n"],
  ["find -type f -maxdepth 1", ["find . -maxdepth 1 -type f"], "./Makefile\n./README.md\n./catalog.json\n./package.json\n"],
  ["tail -n +3 is from the third line on", ["tail -n +7 README.md"], "    bun install\n    bun test\n"],
  ["head -n -N is all but the last N", ["head -n -6 README.md"], "# widgets\n\n"],
  ["tail -c", ["tail -c 5 README.md"], "test\n"],
  ["echo -ne", ["echo -ne 'a\\tb\\n'"], "a\tb\n"],
  ["echo -e, and -n", ["echo -e 'x\\ny'; echo -n z; echo"], "x\ny\nz\n"],
  ["echo of a word that only looks like a flag prints it", ["echo -Z hello"], "-Z hello\n"],
  ["grep -o prints each match on its own line", ["grep -o 'bun [a-z]*' README.md"], "bun install\nbun test\n"],
  ["grep -c of two files counts each", ["grep -c bun README.md Makefile"], "README.md:2\nMakefile:1\n"],
  ["grep -c of one file is a bare count", ["grep -c bun README.md"], "2\n"],
  ["grep -w", ["printf 'test\\ntesting\\n' | grep -w test"], "test\n"],
  ["grep -h drops the names, -H adds one", ["grep -h widgets README.md package.json | head -1; grep -H Acme README.md"], "# widgets\nREADME.md:Widgets for Acme.\n"],
  ["grep -e", ["grep -c -e install -e Acme README.md"], "2\n"],
  ["a backslash-newline continues the line", ["echo one \\\n  two && \\\n  echo three"], "one two\nthree\n"],
  ["an unquoted $VAR is split into words", ["FILES='README.md Makefile'; wc -l $FILES | head -2"], "8 README.md\n2 Makefile\n"],
  ["a quoted $VAR is one word", ["FILES='README.md Makefile'; wc -l \"$FILES\""], { code: 1, stderr: "wc: README.md Makefile: No such file or directory\n" }],
  ["an unquoted $VAR joins the text around it", ["D=scripts; ls $D/*.sh; EXT=ts; ls src/widgets.$EXT"], "scripts/count-widgets.sh\nsrc/widgets.ts\n"],
  ["$VAR in an unquoted here-document is expanded", ["NAME=widgets\ncat <<EOF\nrepo: $NAME (${NAME})\nEOF"], "repo: widgets (widgets)\n"],
  ["$VAR in a quoted here-document is not", ["NAME=widgets\ncat <<'EOF'\nrepo: $NAME\nEOF"], "repo: $NAME\n"],
  ["set -u stops at a variable that isn't set", ["set -u; echo \"$NOPE\"; echo after"], { stdout: "", code: 2, stderr: "sh: 1: NOPE: parameter not set\n" }],
  ["set -o pipefail makes a pipeline fail with its first failure", ["set -o pipefail; cat nope.txt 2>/dev/null | wc -l; echo \"exit=$?\""], "0\nexit=1\n"],
  ["set -euo pipefail, the usual first line", ["set -euo pipefail\necho ok"], "ok\n"],
  ["ls -lah", ["ls -lah catalog.json"], /^-rw-r--r-- 1 root root +961 Nov 19 10:00 catalog\.json\n$/],
  ["ls -lh of a directory is 4.0K", ["ls -lh | grep src"], /^drwxr-xr-x 2 root root  4\.0K Nov 19 10:00 src\n$/],
  ["ls -r", ["ls -r src test"], "src:\nwidgets.ts\n\ntest:\nwidgets.test.ts\n"],
  ["sort -r, -u, -n", ["printf '10\\n9\\n9\\n' | sort -n -u; printf 'a\\nb\\n' | sort -r"], "9\n10\nb\na\n"],
  ["mkdir without -p needs the parent", ["mkdir a/b"], { code: 1, stderr: "mkdir: cannot create directory 'a/b': No such file or directory\n" }],
  ["mkdir -p", ["mkdir -p a/b && test -d a/b && echo made"], "made\n"],
  ["chmod u+x and a-x", ["chmod u+x scripts/count.ts && test -x scripts/count.ts && chmod a-x scripts/count.ts && test -x scripts/count.ts || echo off"], "off\n"],
  ["uname -sr", ["uname -sr; uname -m"], "Linux 6.8.0\nx86_64\n"],
  // git: the index is what `add` saw.
  ["add, edit again, commit: the commit holds what was added", ["echo first >> README.md && git add README.md && echo second >> README.md && git commit -qm 'docs: first'", "git show HEAD:README.md | tail -1; git status --short; tail -1 README.md"], "first\n M README.md\nsecond\n"],
  ["status shows both columns for a file added and then edited", ["echo a >> README.md && git add README.md && echo b >> README.md && git status --short"], "MM README.md\n"],
  ["diff --cached is what was added; diff is what came after", ["echo a >> README.md && git add README.md && echo b >> README.md", "git diff --cached | tail -1; git diff | tail -1"], "+a\n+b\n"],
  ["a new file, added: A, then committed with the content it had", ["echo one > new.txt && git add new.txt && echo two >> new.txt && git status --short && git commit -qm new && git show HEAD:new.txt"], "AM new.txt\none\n"],
  ["checkout -- <file> goes back to what was added", ["echo a >> README.md && git add README.md && echo b >> README.md && git checkout -- README.md && tail -1 README.md"], "a\n"],
  ["commit -F - takes the message from stdin", ["echo a >> README.md && git add README.md && printf 'docs: from stdin\\n\\nbody line\\n' | git commit -q -F -", "git log -1 --format=%s; git log -1 --format=%B | tail -1"], "docs: from stdin\nbody line\n"],
  ["commit -F <file>", ["echo 'docs: from a file' > /tmp/msg && echo a >> README.md && git commit -qa -F /tmp/msg && git log -1 --format=%s"], "docs: from a file\n"],
  ["commit with no message says how to give one", ["echo a >> README.md && git commit -a"], { code: 1, stderr: /Please supply the message using either -m or -F option/ }],
  ["rebase onto what HEAD already has is up to date", ["git checkout -qb scout/x && echo a >> README.md && git commit -qam 'docs: a' && git rebase origin/main"], "Current branch scout/x is up to date.\n"],
];
for (const [name, commands, want] of ROWS2) {
  test(`shell: ${name}`, () => {
    const sh = cloned();
    let r = { exitCode: 0, stdout: "", stderr: "" };
    for (const command of commands) r = sh.exec(command, WORKDIR, ME);
    const w = typeof want === "string" || want instanceof RegExp ? { stdout: want, code: 0 } : want;
    if (typeof w.stdout === "string") expect(r.stdout).toBe(w.stdout);
    else if (w.stdout) expect(r.stdout).toMatch(w.stdout);
    if (typeof w.stderr === "string") expect(r.stderr).toBe(w.stderr);
    else if (w.stderr) expect(r.stderr).toMatch(w.stderr);
    if (w.code !== undefined) expect({ code: r.exitCode, stderr: r.stderr }).toMatchObject({ code: w.code });
    expect(sh.refused).toEqual([]);
  });
}

test("git rebase --exec re-authors the commits ahead, the one form the product tells the model to run", () => {
  const sh = cloned();
  const mallory = { ...ME, GIT_AUTHOR_NAME: "Mallory", GIT_AUTHOR_EMAIL: "m@example.com", GIT_COMMITTER_NAME: "Mallory", GIT_COMMITTER_EMAIL: "m@example.com" };
  sh.exec("git checkout -qb scout/x && echo a >> README.md && git commit -qam 'docs: a' && echo b >> Makefile && git commit -qam 'chore: b'", WORKDIR, mallory);
  expect(sh.publishable("main")).toMatchObject({ commits: 2, authors: ["Mallory <m@example.com>|Mallory <m@example.com>", "Mallory <m@example.com>|Mallory <m@example.com>"] });
  // What open_pull_request's error says to run (src/tools/pull-request.ts), as octo.
  const r = sh.exec("git rebase --exec 'git commit --amend --no-edit --reset-author' origin/main", WORKDIR, ME);
  expect(r).toEqual({ exitCode: 0, stdout: "Executing: git commit --amend --no-edit --reset-author\n".repeat(2), stderr: "Successfully rebased and updated refs/heads/scout/x.\n" });
  const me = "octo <1+octo@users.noreply.github.com>";
  expect(sh.publishable("main")).toMatchObject({ commits: 2, authors: [`${me}|${me}`, `${me}|${me}`], files: ["Makefile", "README.md"] });
  expect(sh.exec("git log origin/main..HEAD --format='%an %s'", WORKDIR, ME).stdout).toBe("octo chore: b\nocto docs: a\n");
  expect(sh.exec("git status --porcelain", WORKDIR, ME).stdout).toBe("");
  expect(sh.refused).toEqual([]);
  // Any other command to --exec isn't run, and says it failed.
  const other = sh.exec("git rebase --exec 'bun test' origin/main", WORKDIR, ME);
  expect(other.exitCode).toBe(1);
  expect(other.stderr).toContain("warning: execution failed: bun test");
  expect(sh.refused.map((x) => x.part)).toEqual(["git rebase --exec bun test origin/main"]);
});

// The rule, held for every command: an option or operator it doesn't implement is
// refused in the tool's own words and recorded. Never ignored, never approximated.
test("every command refuses an option it doesn't implement", () => {
  // [command, what the model sees (start), exit code]
  const walk: [string, string, number][] = [
    ["ls -Z", "ls: invalid option -- 'Z'\nTry 'ls --help' for more information.", 2],
    ["ls --zzz", "ls: unrecognized option '--zzz'", 2],
    ["ls -l --time-style=full-iso", "ls: unrecognized option '--time-style=full-iso'", 2],
    ["ls -R", "ls: invalid option -- 'R'", 2],
    ["cat -Z README.md", "cat: invalid option -- 'Z'", 1],
    ["head -Z README.md", "head: invalid option -- 'Z'", 1],
    ["tail -f README.md", "tail: invalid option -- 'f'", 1],
    ["wc -Z README.md", "wc: invalid option -- 'Z'", 1],
    ["sort -k2 README.md", "sort: invalid option -- 'k'", 2],
    ["mkdir -Z x", "mkdir: invalid option -- 'Z'", 1],
    ["touch -d yesterday x", "touch: invalid option -- 'd'", 1],
    ["rm -i README.md", "rm: invalid option -- 'i'", 1],
    ["cp -Z README.md x", "cp: invalid option -- 'Z'", 1],
    ["mv -n README.md x", "mv: invalid option -- 'n'", 1],
    ["tee -Z x", "tee: invalid option -- 'Z'", 1],
    ["sleep -Z 1", "sleep: invalid option -- 'Z'", 1],
    ["which -Z git", "which: invalid option -- 'Z'", 1],
    ["uname -Z", "uname: invalid option -- 'Z'", 1],
    ["whoami -Z", "whoami: invalid option -- 'Z'", 1],
    ["hostname -Z", "hostname: invalid option -- 'Z'", 1],
    ["date -Z", "date: invalid option -- 'Z'", 1],
    ["date +%s", "date: invalid date '+%s'", 1],
    ["basename -Z x", "basename: invalid option -- 'Z'", 1],
    ["dirname -Z x", "dirname: invalid option -- 'Z'", 1],
    ["file -Z README.md", "file: invalid option -- 'Z'", 1],
    ["pwd -Z", "sh: 1: pwd: Illegal option -Z", 2],
    ["cd -Z /tmp", "sh: 1: cd: Illegal option -Z", 2],
    ["unset -Z X", "sh: 1: unset: Illegal option -Z", 2],
    ["type -Z ls", "sh: 1: type: Illegal option -Z", 2],
    ["command -Z ls", "sh: 1: command: Illegal option -Z", 2],
    ["export -p", "sh: 1: export: Illegal option -p", 2],
    ["set -x", "sh: 1: set: Illegal option -x", 2],
    ["set -o errexit", "sh: 1: set: Illegal option -o errexit", 2],
    ["printf -Z x", "sh: 1: printf: Illegal option -Z", 2],
    ["printf '%5.2f\\n' 3", "sh: 1: printf: %5: invalid directive", 1],
    ["env -i ls", "env: invalid option -- 'i'", 125],
    ["time -p ls", "sh: 1: -p: not found", 127],
    ["test -Z x", "sh: 1: test: -Z: unexpected operator", 2],
    ["[ a -ef b ]", "sh: 1: [: -ef: unexpected operator", 2],
    ["[ -f README.md -a -f Makefile ]", "sh: 1: [: -a: unexpected operator", 2],
    ["test a = b -o c = c", "sh: 1: test: -o: unexpected operator", 2],
    ["find . -newer README.md", "find: unknown predicate `-newer'", 1],
    ["find . -name '*.ts' -exec cat {} +", "find: unknown predicate `-exec'", 1],
    ["find . -type l", "find: Unknown argument to -type: l", 1],
    ["grep -P 'a+' README.md", "grep: invalid option -- 'P'", 2],
    ["grep --include='*.ts' -r x .", "grep: unrecognized option '--include=*.ts'", 2],
    ["sed -Z README.md", "sed: invalid option -- 'Z'", 1],
    ["git status --ignored", "error: unknown option `ignored'\nusage: git status [<options>]", 129],
    ["git log --graph", "error: unknown option `graph'", 129],
    ["git diff -U10", "error: unknown switch `U'", 129],
    ["git commit --fixup HEAD", "error: unknown option `fixup'", 129],
    ["git branch -vv", "error: unknown switch `v'", 129],
    ["git checkout --orphan x", "error: unknown option `orphan'", 129],
    ["git reset --merge", "error: unknown option `merge'", 129],
    ["git rebase -i origin/main", "error: unknown switch `i'", 129],
    ["git rev-parse --symbolic-full-name HEAD", "error: unknown option `symbolic-full-name'", 129],
  ];
  for (const [command, said, code] of walk) {
    const sh = cloned();
    const r = sh.exec(command, WORKDIR, ME);
    expect([command, r.exitCode, r.stderr.slice(0, said.length), r.stdout]).toEqual([command, code, said, ""]);
    expect([command, sh.refused.length]).toEqual([command, 1]);
    expect(sh.refused[0]!.said).toBe(r.stderr.trim());
    expect(r.stderr).not.toMatch(GIVEAWAY);
  }
});

test("a pattern that could stall the runner is not run: a repeated group inside a repeated group, or a very long one", () => {
  const sh = cloned();
  sh.exec(`printf '%s\\n' ${"a".repeat(40)}b > long.txt`, WORKDIR, ME);
  const t0 = performance.now();
  for (const command of ["grep -E '(a+)+$' long.txt", "grep -E '(a*)*b$' long.txt", "grep -E '^(a|aa)+$' long.txt | head -1; grep '\\(a\\+\\)\\+$' long.txt", `grep ${"a".repeat(300)} long.txt`, "git grep -E '(x+)+y'"]) {
    const r = sh.exec(command, WORKDIR, ME);
    if (command.startsWith("grep -E '^(a|aa)+$'")) { expect(r.stderr).toBe("grep: regular expression is too large\n".repeat(2)); continue; }
    expect([command, r.exitCode, r.stderr]).toEqual([command, 2, "grep: regular expression is too large\n"]);
  }
  expect(performance.now() - t0).toBeLessThan(500);
  expect(sh.refused.length).toBe(6);
  expect(sh.refused[0]).toMatchObject({ part: "grep -E (a+)+$ long.txt", said: "grep: regular expression is too large", why: expect.stringContaining("could stall the runner") });
  // Groups and repeats that aren't nested are fine.
  expect(sh.exec("grep -cE 'bun (install|test)' README.md; grep -c 'a\\+b' long.txt; grep -cE '^ +bun' README.md", WORKDIR, ME).stdout).toBe("2\n1\n2\n");
});

test("run-and-show's script prints its count only where it exists: in a cloned checkout, run from its root", () => {
  const sandbox = CASES.find((c) => c.id === "run-and-show")!.setup!.sandbox!;
  const SCRIPT = "./scripts/count-widgets.sh";
  // A real trial, before any clone: there is no checkout, so no script and no count.
  const real = scriptedSandbox(sandbox);
  const none = result(real(exec(SCRIPT)));
  expect(none).toEqual({ exitCode: 2, stdout: "", stderr: "sh: 1: cd: can't cd to /workspace/repo\n" });
  expect(result(real(exec(SCRIPT, "/tmp")))).toEqual({ exitCode: 127, stdout: "", stderr: "sh: 1: ./scripts/count-widgets.sh: not found\n" });
  // Cloned: run from the checkout's root it prints the catalog's count…
  expect(result(real(exec(gitWithToken(`clone ${URL_} ${WORKDIR}`), "/"))).exitCode).toBe(0);
  expect(result(real(exec(SCRIPT)))).toEqual({ exitCode: 0, stdout: `widgets counted: ${WIDGETS}\n`, stderr: "" });
  expect(result(real(exec(SCRIPT, `${WORKDIR}/`))).stdout).toBe(`widgets counted: ${WIDGETS}\n`);
  // …and from anywhere else there is no such path.
  expect(result(real(exec(SCRIPT, "/tmp")))).toMatchObject({ exitCode: 127, stdout: "" });
  expect(result(real(exec(`cd /tmp && ${SCRIPT}`)))).toMatchObject({ exitCode: 127, stdout: "" });
  expect(result(real(exec("cd src && bun test")))).toMatchObject({ stdout: "" });
  // Under --dry there is no shell and no clone step: the scripted model's one command is
  // answered by the case's dry-only rule.
  const dry = scriptedSandbox(sandbox, { dry: true });
  expect(result(dry(exec(SCRIPT)))).toEqual({ exitCode: 0, stdout: `widgets counted: ${WIDGETS}\n`, stderr: "" });
  // A rule under `exec` still answers in both (the refusal test above uses one).
  const both = scriptedSandbox({ ...widgets, exec: [{ match: /^make test$/, exitCode: 2, stderr: "boom" }] });
  expect(result(both(exec("make test", "/")))).toEqual({ exitCode: 2, stdout: "", stderr: "boom" });
});

test("a refused git command changes nothing: stash is refused, not pretended", () => {
  const sh = cloned();
  sh.exec("echo a >> README.md", WORKDIR, ME);
  expect(sh.exec("git stash", WORKDIR, ME).exitCode).toBe(1);
  expect(sh.exec("git status --short", WORKDIR, ME).stdout).toBe(" M README.md\n");
});

test("before a clone there is no checkout, and only Lorehouse's own clone reaches GitHub", () => {
  const sh = fresh();
  // workspace_clone's probe, then a model's own attempt, then the tool's.
  expect(sh.exec(`git -C ${WORKDIR} remote get-url origin 2>/dev/null`, "/")).toEqual({ exitCode: 128, stdout: "", stderr: "" });
  expect(sh.exec("ls", WORKDIR)).toEqual({ exitCode: 2, stdout: "", stderr: "sh: 1: cd: can't cd to /workspace/repo\n" });
  const own = sh.exec(`git clone ${URL_} ${WORKDIR}`, "/");
  expect(own.exitCode).toBe(128);
  expect(own.stderr).toContain("could not read Username");
  expect(sh.exec(gitWithToken(`clone https://github.com/acme/nope.git ${WORKDIR}`), "/")).toMatchObject({ exitCode: 128, stderr: expect.stringContaining("Repository not found") });
  expect(sh.exec(gitWithToken(`clone --branch main ${URL_} ${WORKDIR}`), "/")).toMatchObject({ exitCode: 0, stdout: "" });
  expect(sh.exec(`git -C ${WORKDIR} remote get-url origin 2>/dev/null`, "/")).toEqual({ exitCode: 0, stdout: `${URL_}\n`, stderr: "" });
  expect(sh.exec(gitWithToken("fetch --prune origin")).exitCode).toBe(0);
  expect(sh.exec("git config user.name 'octo' && git config user.email '1+octo@users.noreply.github.com' && git config user.name").stdout).toBe("octo\n");
  expect(sh.read(`${WORKDIR}/.git/HEAD`)).toBe("ref: refs/heads/main\n");
});

test("a clone of acme/gadgets is gadgets, with its own tests, not the widgets files", () => {
  const sh = cloned("https://github.com/acme/gadgets.git");
  expect(sh.exec("ls").stdout).toBe("README.md\npackage.json\nsrc\ntest\n");
  expect(sh.exec("head -1 README.md; bun test | grep -c '(pass)'").stdout).toBe("# gadgets\n2\n");
  expect(sh.exec("git remote get-url origin").stdout).toBe("https://github.com/acme/gadgets.git\n");
  // A widgets script isn't here, and isn't run.
  expect(sh.exec("make bench")).toEqual({ exitCode: 2, stdout: "", stderr: "make: *** No rule to make target 'bench'.  Stop.\n" });
});

test("a chart is a real PNG", () => {
  const png = chartPng();
  expect(Buffer.from(png.subarray(0, 8)).toString("latin1")).toBe("\u0089PNG\r\n\u001a\n");
  expect(Buffer.from(png).readUInt32BE(16)).toBe(640);
  expect(png.byteLength).toBeGreaterThan(500);
});

// ── what a pull request publishes is the checkout's own ─────────────────────

test("publishable: nothing committed is 'no commits to publish'; a commit is its files, diffstat, author and patch", () => {
  const none = fresh();
  expect(none.publishable("main")).toMatchObject({ status: 409, error: expect.stringContaining("isn't a git checkout") });
  const sh = cloned();
  expect(sh.publishable("main")).toEqual({ status: 409, error: "no commits to publish: HEAD has nothing that isn't on GitHub already (commit first?)" });
  // An edit that isn't committed is still nothing to publish.
  sh.exec("echo 'Questions? Ask in #widgets.' >> README.md", WORKDIR, ME);
  expect(sh.publishable("main")).toMatchObject({ status: 409 });
  sh.exec("git checkout -b scout/readme && git commit -am 'docs: say where to ask'", WORKDIR, ME);
  const staged = sh.publishable("main");
  if ("error" in staged) throw new Error(staged.error);
  expect(staged).toMatchObject({ commits: 1, files: ["README.md"], stat: " README.md | 1 +\n 1 file changed, 1 insertion(+)\n", authors: ["octo <1+octo@users.noreply.github.com>|octo <1+octo@users.noreply.github.com>"] });
  expect(staged.patch).toContain("+Questions? Ask in #widgets.\n");
  expect(staged.sha).toMatch(/^[0-9a-f]{40}$/);
  expect(staged.sha).toBe(sh.exec("git rev-parse HEAD").stdout.trim());
  expect(staged.baseSha).toBe(sh.exec("git rev-parse origin/main").stdout.trim());
  // A second commit by someone else is counted and named.
  sh.exec("echo more >> Makefile && git commit -qam 'chore: more'", WORKDIR, { ...ME, GIT_AUTHOR_NAME: "Mallory", GIT_AUTHOR_EMAIL: "m@example.com" });
  expect(sh.publishable("main")).toMatchObject({ commits: 2, files: ["Makefile", "README.md"], authors: [expect.stringContaining("octo <"), "Mallory <m@example.com>|octo <1+octo@users.noreply.github.com>"] });
  expect(sh.publishable("release/1.x")).toMatchObject({ status: 409 });
});

const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");
const exec = (command: string, cwd = WORKDIR) => ({ id: "j", sandbox: "s", op: "guest", method: "POST", path: "/exec", bodyBase64: b64({ command, cwd, env: ME }) });
const file = (method: string, path: string, body?: string) => ({ id: "j", sandbox: "s", op: "guest", method, path: `/file?path=${encodeURIComponent(path)}`, bodyBase64: body === undefined ? undefined : b64(body) });
const result = (a: { bodyBase64?: string } | undefined) => JSON.parse(Buffer.from(a!.bodyBase64!, "base64").toString());

test("the scripted sandbox: a stage is the checkout's commits, a push must restate it, and nothing committed is the host's refusal", () => {
  const sb = scriptedSandbox(widgets);
  const stage = (branch: string) => sb({ id: "j", sandbox: "s", op: "stage", bodyBase64: b64({ owner: "acme", name: "widgets", base: "main", branch, token: "t" }) })!;
  sb(exec(gitWithToken(`clone ${URL_} ${WORKDIR}`), "/"));
  // Nothing committed: what sandboxd says, which open_pull_request hands the model.
  expect(stage("scout/x")).toEqual({ id: "j", status: 409, error: "no commits to publish: HEAD has nothing that isn't on GitHub already (commit first?)" });
  sb(exec("echo 'Questions? Ask in #widgets.' >> README.md && git commit -qam 'docs: say where to ask'"));
  const staged = result(stage("scout/x"));
  expect(staged).toMatchObject({ commits: 1, files: ["README.md"], patchTruncated: false, authors: ["octo <1+octo@users.noreply.github.com>|octo <1+octo@users.noreply.github.com>"] });
  expect(staged.stat).toContain("README.md | 1 +");
  expect(staged.patch).toContain("+Questions? Ask in #widgets.");
  expect(staged.diffSha256).toMatch(/^[0-9a-f]{64}$/);
  const push = (o: object) => sb({ id: "j", sandbox: "s", op: "push", bodyBase64: b64({ owner: "acme", name: "widgets", token: "t", ...o }) })!;
  expect(push({ stage: staged.stage, sha: "0".repeat(40), branch: "scout/x" }).status).toBe(403);
  expect(push({ stage: staged.stage, sha: staged.sha, branch: "scout/x" }).status).toBe(404); // a stage is used once
  const again = result(stage("scout/x"));
  expect(result(push({ stage: again.stage, sha: again.sha, branch: "scout/x" }))).toEqual({ sha: staged.sha, branch: "scout/x" });
  // With no shell (under --dry), stage and push are the fake runner's.
  expect(scriptedSandbox(widgets, { dry: true })({ id: "j", sandbox: "s", op: "stage" })).toBeUndefined();
});

test("the scripted sandbox: a refusal, an exec rule, the shell, files, background jobs, and what the shell refused", () => {
  const sb = scriptedSandbox({ ...widgets, exec: [{ match: /^make test$/, exitCode: 2, stderr: "boom" }], refuse: [{ command: /bench/, status: 422, code: "resource_over_maximum", error: "too big" }] });
  expect(sb(exec("make bench"))).toEqual({ id: "j", status: 422, code: "resource_over_maximum", error: "too big" });
  expect(sb({ id: "j", sandbox: "s", op: "guest", method: "POST", path: "/jobs", bodyBase64: b64({ id: "b", command: "make bench" }) })?.code).toBe("resource_over_maximum");
  expect(result(sb(exec("make test")))).toEqual({ exitCode: 2, stdout: "", stderr: "boom" });
  expect(result(sb(exec("echo hi", "/")))).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
  expect(result(sb(exec(gitWithToken(`clone ${URL_} ${WORKDIR}`), "/"))).exitCode).toBe(0);
  expect(Buffer.from(sb(file("GET", `${WORKDIR}/README.md`))!.bodyBase64!, "base64").toString()).toBe(README);
  // With a shell, a file that isn't there isn't: no path reads as a placeholder PNG.
  expect(sb(file("GET", `${WORKDIR}/chart.png`))).toEqual({ id: "j", status: 404 });
  expect(sb(file("PUT", `${WORKDIR}/new.txt`, "made"))?.status).toBe(200);
  expect(result(sb(exec("cat new.txt && git status --short")))).toMatchObject({ stdout: "made?? new.txt\n" });
  // A background job prints what its command prints, as it runs: nothing at the start,
  // part by the first status, all of it and the exit code by the second.
  const jobs = (method: string, path: string, value?: unknown) => ({ id: "j", sandbox: "s", op: "guest", method, path, bodyBase64: value === undefined ? undefined : b64(value) });
  const started = sb(jobs("POST", "/jobs", { id: "tests-1", command: "bun test 2>&1", cwd: WORKDIR, timeoutMs: 3_600_000 }))!;
  expect(started.status).toBe(201);
  expect(result(started)).toMatchObject({ id: "tests-1", state: "running", exitCode: null, tail: "", created: true });
  expect(result(sb(jobs("POST", "/jobs", { id: "tests-1", command: "bun test 2>&1", cwd: WORKDIR })))).toMatchObject({ created: false });
  const first = result(sb(jobs("GET", "/jobs/tests-1?tailBytes=8192")));
  expect(first.state).toBe("running");
  expect(first.tail.length).toBeGreaterThan(0);
  expect(first.tail).not.toContain("0 fail");
  const done = result(sb(jobs("GET", "/jobs/tests-1?tailBytes=8192")));
  expect(done).toMatchObject({ state: "exited", exitCode: 0, elapsedMs: 1_741_000 });
  expect(done.tail).toContain(" 3 pass\n 0 fail\n");
  expect(sb(jobs("GET", "/jobs/nope?tailBytes=0"))?.status).toBe(404);
  sb(jobs("POST", "/jobs", { id: "long-1", command: "bun test", cwd: WORKDIR }));
  expect(result(sb(jobs("POST", "/jobs/long-1/cancel")))).toMatchObject({ state: "cancelled", exitCode: 143 });
  // What the shell refused is on the sandbox's record, with the whole command line.
  expect(sb.refused).toEqual([]);
  expect(result(sb(exec("ls && python3 -c 'print(1)'"))).exitCode).toBe(2);
  expect(sb.refused).toEqual([{ command: "ls && python3 -c 'print(1)'", part: "python3 -c print(1)", why: expect.stringContaining("`python3` is simulated only for the repository's own scripts"), said: expect.stringContaining("Unknown option: -c") }]);
  // With no rule naming what to refuse, every call into the sandbox is refused.
  expect(scriptedSandbox({ refuse: [{ status: 409, code: "resources_mismatch", error: "x" }] })(file("GET", "/a.png"))?.code).toBe("resources_mismatch");
  // Under --dry there is no shell: the scripted model's sandbox is the fake runner's.
  const dry = scriptedSandbox(widgets, { dry: true });
  expect(dry(exec("echo hi"))).toBeUndefined();
  expect(dry(file("GET", `${WORKDIR}/bench.png`))).toBeUndefined();
  expect(dry(jobs("POST", "/jobs", { id: "b", command: "make all" }))).toBeUndefined();
  expect(scriptedSandbox({})(exec("echo hi"))).toBeUndefined();
});
