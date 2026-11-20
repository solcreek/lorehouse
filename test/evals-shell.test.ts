// The simulated shell a code case's sandbox runs (evals/shell.ts): it has to answer the
// commands a model checks its tools with as bash and git would, or the model, rightly,
// stops trusting the sandbox (which is what a real run against "ran:<command>" showed).

import { expect, test } from "bun:test";
import { widgets } from "../evals/cases/widgets";
import { scriptedSandbox } from "../evals/sandbox";
import { chartPng, Shell, WORKDIR } from "../evals/shell";
import { gitWithToken } from "../src/tools/git-credential";

const URL_ = "https://github.com/acme/widgets.git";
const fresh = () => new Shell(widgets.shell!);
function cloned(): Shell {
  const sh = fresh();
  expect(sh.exec(gitWithToken(`clone --branch main ${URL_} ${WORKDIR}`), "/").exitCode).toBe(0);
  return sh;
}

test("before a clone there is no checkout, and only Lorehouse's own clone reaches GitHub", () => {
  const sh = fresh();
  // workspace_clone's probe, then a model's own attempt, then the tool's.
  expect(sh.exec(`git -C ${WORKDIR} remote get-url origin 2>/dev/null`, "/")).toEqual({ exitCode: 128, stdout: "", stderr: "" });
  expect(sh.exec("ls", WORKDIR)).toEqual({ exitCode: 1, stdout: "", stderr: "bash: cd: /workspace/repo: No such file or directory\n" });
  const own = sh.exec(`git clone ${URL_} ${WORKDIR}`, "/");
  expect(own.exitCode).toBe(128);
  expect(own.stderr).toContain("could not read Username");
  const tool = sh.exec(gitWithToken(`clone --branch main ${URL_} ${WORKDIR}`), "/");
  expect(tool).toMatchObject({ exitCode: 0, stdout: "" });
  expect(sh.exec(`git -C ${WORKDIR} remote get-url origin 2>/dev/null`, "/")).toEqual({ exitCode: 0, stdout: `${URL_}\n`, stderr: "" });
  expect(sh.exec(gitWithToken("fetch --prune origin")).exitCode).toBe(0);
  expect(sh.exec("git fetch origin").exitCode).toBe(128);
  expect(sh.exec("git config user.name 'octo' && git config user.email '1+octo@users.noreply.github.com'").exitCode).toBe(0);
});

test("the commands a model checks a sandbox with answer as a shell does", () => {
  const sh = cloned();
  expect(sh.exec("echo hello")).toEqual({ exitCode: 0, stdout: "hello\n", stderr: "" });
  expect(sh.exec('pwd; echo "---"; ls').stdout).toBe("/workspace/repo\n---\nMakefile\nREADME.md\nbench\npackage.json\nscripts\nsrc\ntest\n");
  expect(sh.exec("pwd && ls -a").stdout).toContain(".git\n");
  const long = sh.exec("ls -la scripts/").stdout;
  expect(long).toContain("count-widgets.sh");
  expect(long).toMatch(/-rw-r--r-- 1 root root +\d+ Nov 19 10:00 plot_bench.py/);
  expect(sh.exec('tail -20 README.md; echo "---"; wc -l README.md').stdout).toBe("# widgets\n\nWidgets for Acme.\n\n## Develop\n\n    bun install\n    bun test\n---\n8 README.md\n");
  expect(sh.exec("sed -n '1,3p' README.md").stdout).toBe("# widgets\n\nWidgets for Acme.\n");
  expect(sh.exec("cat package.json | grep -n test").stdout).toBe('5:    "test": "bun test",\n');
  expect(sh.exec("head -1 README.md && cat nope.txt")).toEqual({ exitCode: 1, stdout: "# widgets\n", stderr: "cat: nope.txt: No such file or directory\n" });
  expect(sh.exec("ls nope 2>/dev/null || echo missing").stdout).toBe("missing\n");
  expect(sh.exec('false; echo "exit=$?"').stdout).toBe("exit=1\n");
  expect(sh.exec("cd scripts && pwd && ls").stdout).toBe("/workspace/repo/scripts\nbench.ts\ncount-widgets.sh\ncount.ts\nplot_bench.py\n");
  expect(sh.exec("find . -name '*.ts'").stdout).toBe("./scripts/bench.ts\n./scripts/count.ts\n./src/widgets.ts\n./test/widgets.test.ts\n");
  expect(sh.exec("git grep -n price -- src").exitCode).toBe(0);
  expect(sh.exec("which python3 git && which cargo").exitCode).toBe(1);
  // Not installed is said the way bash says it; nothing pretends to have run.
  expect(sh.exec("cargo test")).toEqual({ exitCode: 127, stdout: "", stderr: "bash: line 1: cargo: command not found\n" });
  expect(sh.exec("echo $(date)").exitCode).toBe(2);
  expect(sh.exec("ls && grep -n -A5 '^bench:' Makefile").stdout).toEndWith("test\n1:bench:\n2-\tbun run scripts/bench.ts\n");
  expect(sh.exec("ls -l --time-style=full-iso Makefile").exitCode).toBe(0);
});

test("what is installed is there, says its own version, and never pretends to have run something it can't", () => {
  const sh = cloned();
  expect(sh.exec("python3 -V; make --version | head -1; bun --version").stdout).toBe("Python 3.12.3\nGNU Make 4.3\n1.4.3\n");
  expect(sh.exec("which make; type make echo; command -v python3").stdout).toBe("/usr/bin/make\nmake is /usr/bin/make\necho is a shell builtin\n/usr/bin/python3\n");
  expect(sh.exec("ls -l /usr/bin/python3 && file /usr/bin/make").stdout).toMatch(/^-rw-r--r-- 1 root root +24 Nov 19 10:00 \/usr\/bin\/python3\n\/usr\/bin\/make: ELF 64-bit LSB pie executable/);
  // Code this shell can't run is refused out loud: exit 126, never a silent success.
  for (const command of ["python3 -c \"print('alive')\"", "bun /tmp/t.ts", "make -d bench", "make all"]) {
    const r = sh.exec(command);
    expect([command, r.exitCode, r.stdout]).toEqual([command, 126, ""]);
    expect(r.stderr).toContain("restricted in this sandbox");
  }
  expect(sh.exec("make bench").stdout).toEndWith("bench total 290 ms (5 benchmarks)\n");
  expect(sh.exec("make -n bench").stdout).toBe("bun run scripts/bench.ts\n");
  expect(sh.exec("cat scripts/bench.ts").exitCode).toBe(0);
});

test("a case's programs print their own output and leave their files; a chart is a real PNG", () => {
  const sh = cloned();
  expect(sh.exec("./scripts/count-widgets.sh").stdout).toBe("widgets counted: 4173\n");
  expect(sh.exec("bun test").stdout).toContain(" 3 pass\n 0 fail\n");
  expect(sh.exec("ls bench.png").exitCode).toBe(2);
  expect(sh.exec('python3 scripts/plot_bench.py; echo "exit=$?"; ls -la bench.png').stdout).toMatch(/^wrote bench\.png\nexit=0\n-rw-r--r-- 1 root root +\d+ Nov 19 10:00 bench\.png\n$/);
  expect(sh.exec("file bench.png").stdout).toBe("bench.png: PNG image data, 640 x 400, 8-bit/color RGB, non-interlaced\n");
  const png = chartPng();
  expect(Buffer.from(png.subarray(0, 8)).toString("latin1")).toBe("\u0089PNG\r\n\u001a\n");
  expect(png.byteLength).toBeGreaterThan(500);
  // Bun decodes it: the chunks and their checksums are right.
  expect(new Bun.CryptoHasher("sha1").update(png).digest("hex")).toHaveLength(40);
});

test("a small change: edit, status, branch, add, commit, log; the pull request tool's questions", () => {
  const sh = cloned();
  expect(sh.exec("git status --porcelain").stdout).toBe("");
  expect(sh.exec("git status").stdout).toBe("On branch main\nnothing to commit, working tree clean\n");
  expect(sh.exec("echo 'Questions? Ask in #widgets.' >> README.md").exitCode).toBe(0);
  expect(sh.exec("tail -1 README.md").stdout).toBe("Questions? Ask in #widgets.\n");
  expect(sh.exec("git status --short").stdout).toBe(" M README.md\n");
  expect(sh.exec("git diff --stat").stdout).toBe(" README.md | 1 +\n 1 file changed, 1 insertion(+)\n");
  expect(sh.exec("git --no-pager diff").stdout).toMatch(/^diff --git a\/README\.md b\/README\.md\nindex [0-9a-f]{7}\.\.[0-9a-f]{7} 100644\n--- a\/README\.md\n\+\+\+ b\/README\.md\n@@ -6,3 \+6,4 @@\n \n     bun install\n     bun test\n\+Questions\? Ask in #widgets\.\n$/);
  expect(sh.exec("git show HEAD:README.md").stdout).toBe("# widgets\n\nWidgets for Acme.\n\n## Develop\n\n    bun install\n    bun test\n");
  expect(sh.exec("cat -n README.md | tail -1").stdout).toBe("     9\tQuestions? Ask in #widgets.\n");
  // Nothing staged: git says so and fails, as it does.
  expect(sh.exec('git commit -m "docs: say where to ask"')).toMatchObject({ exitCode: 1 });
  const done = sh.exec('git checkout -b scout/readme-questions && git add README.md && git commit -m "docs: say where to ask" && git log --oneline -1');
  expect(done.exitCode).toBe(0);
  expect(done.stderr).toBe("Switched to a new branch 'scout/readme-questions'\n");
  expect(done.stdout).toMatch(/^\[scout\/readme-questions ([0-9a-f]{7})\] docs: say where to ask\n 1 file changed, 1 insertion\(\+\)\n\1 docs: say where to ask\n$/);
  expect(sh.exec("git status --porcelain").stdout).toBe("");
  expect(sh.exec("git branch --show-current").stdout).toBe("scout/readme-questions\n");
  expect(sh.exec("git log --oneline").stdout.split("\n").length).toBe(4);
  expect(sh.exec("git remote get-url origin").stdout).toBe(`${URL_}\n`);
  expect(sh.exec("git rev-parse --abbrev-ref origin/HEAD").stdout).toBe("origin/main\n");
  expect(sh.read(`${WORKDIR}/.git/HEAD`)).toBe("ref: refs/heads/scout/readme-questions\n");
  expect(sh.exec("git push origin HEAD").exitCode).toBe(128);
  // A new file, written by a here-document, is untracked until added.
  expect(sh.exec("cat > notes.md <<'EOF'\n# Notes\nline two\nEOF\ngit status --short").stdout).toBe("?? notes.md\n");
  expect(sh.exec("cat notes.md").stdout).toBe("# Notes\nline two\n");
  expect(sh.exec("git add -A && git commit -qm 'add notes' ; git status --porcelain").stdout).not.toContain("notes.md");
});

test("the scripted sandbox: a refusal, an exec rule, the shell, files written and read back; the rest is the fake runner's", () => {
  const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64");
  const exec = (command: string, cwd = WORKDIR) => ({ id: "j", sandbox: "s", op: "guest", method: "POST", path: "/exec", bodyBase64: b64({ command, cwd }) });
  const file = (method: string, path: string, body?: string) => ({ id: "j", sandbox: "s", op: "guest", method, path: `/file?path=${encodeURIComponent(path)}`, bodyBase64: body === undefined ? undefined : b64(body) });
  const result = (a: { bodyBase64?: string } | undefined) => JSON.parse(Buffer.from(a!.bodyBase64!, "base64").toString());
  const sb = scriptedSandbox({ ...widgets, exec: [{ match: /^make test$/, exitCode: 2, stderr: "boom" }], refuse: [{ command: /bench/, status: 422, code: "resource_over_maximum", error: "too big" }] });
  expect(sb(exec("make bench"))).toEqual({ id: "j", status: 422, code: "resource_over_maximum", error: "too big" });
  expect(sb({ id: "j", sandbox: "s", op: "guest", method: "POST", path: "/jobs", bodyBase64: b64({ id: "b", command: "make bench" }) })?.code).toBe("resource_over_maximum");
  expect(result(sb(exec("make test")))).toEqual({ exitCode: 2, stdout: "", stderr: "boom" });
  expect(result(sb(exec("echo hi", "/")))).toEqual({ exitCode: 0, stdout: "hi\n", stderr: "" });
  // Stage and push stay the fake runner's.
  expect(sb({ id: "j", sandbox: "s", op: "stage" })).toBeUndefined();
  expect(result(sb(exec(gitWithToken(`clone ${URL_} ${WORKDIR}`), "/"))).exitCode).toBe(0);
  expect(Buffer.from(sb(file("GET", `${WORKDIR}/README.md`))!.bodyBase64!, "base64").toString()).toStartWith("# widgets\n");
  // With a shell, a file that isn't there isn't: no path reads as a placeholder PNG.
  expect(sb(file("GET", `${WORKDIR}/bench.png`))).toEqual({ id: "j", status: 404 });
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
  // With no rule naming what to refuse, every call into the sandbox is refused.
  expect(scriptedSandbox({ refuse: [{ status: 409, code: "resources_mismatch", error: "x" }] })(file("GET", "/a.png"))?.code).toBe("resources_mismatch");
  // Under --dry there is no shell: the scripted model's sandbox is the fake runner's.
  const dry = scriptedSandbox(widgets, { dry: true });
  expect(dry(exec("echo hi"))).toBeUndefined();
  expect(dry(jobs("POST", "/jobs", { id: "b", command: "make all" }))).toBeUndefined();
  expect(dry(file("GET", `${WORKDIR}/bench.png`))).toBeUndefined();
  expect(scriptedSandbox({})(exec("echo hi"))).toBeUndefined();
});
