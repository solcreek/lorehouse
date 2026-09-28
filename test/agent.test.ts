// The agent tools driven through the REAL June turn engine (AgentSession over an in-memory
// store) with a fake sandbox and a fake GitHub — the approval gate is exercised end to
// end: park → Approve/Deny → resume → push + PR (or nothing).

import { describe, expect, test } from "bun:test";
import { AgentSession, replyStream, type EventSink, type ModelReply, type Model, type Runtime, type Tool, type TurnEvent } from "@junejs/core/agent-runtime";
import { memorySessionStore } from "@junejs/core/test";
import { clip, workspaceTools, type ExecOptions, type Sandbox } from "../src/tools/workspace";
import { pullRequestTool, parseGithubRemote } from "../src/tools/pull-request";
import { parseAllowlist, publicChannelsOnly } from "../src/policy";
import { directMessage, redirectText } from "../src/dm";
import { remoteSandbox } from "../src/sandbox-client";
import { agentIdentity, DEFAULT_AGENT_NAME } from "../src/identity";
import { systemPrompt } from "../src/prompts";

class Sink implements EventSink {
  subs = new Set<(e: TurnEvent) => void>();
  emit(e: TurnEvent) { this.subs.forEach((cb) => cb(e)); }
  subscribe(cb: (e: TurnEvent) => void) { this.subs.add(cb); return () => this.subs.delete(cb); }
}
const noRuntime: Runtime = { session() { throw new Error("no subagents"); } };
const scripted = (script: ModelReply[]): Model => (msgs) =>
  replyStream(script[Math.min(msgs.filter((m) => m.role === "assistant").length, script.length - 1)]!);

// A sandbox that answers the git commands open_pull_request issues and records every exec.
function fakeRepo(o: { dirty?: boolean } = {}) {
  const calls: { command: string; opts?: ExecOptions }[] = [];
  const sb: Sandbox = {
    async exec(command, opts) {
      calls.push({ command, opts });
      const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });
      if (command === "git status --porcelain") return ok(o.dirty ? " M src/a.ts\n" : "");
      if (command === "git remote get-url origin") return ok("https://github.com/acme/widgets.git\n");
      if (command === "git rev-parse --abbrev-ref origin/HEAD") return ok("origin/main\n");
      if (command === "git rev-parse HEAD") return ok("0123456789abcdef0123456789abcdef01234567\n");
      if (command.startsWith("git diff --stat")) return ok(" src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n");
      if (command.includes(" push origin ")) return ok("");
      return { exitCode: 1, stdout: "", stderr: `unexpected: ${command}` };
    },
    async readFile() { return ""; },
    async writeFile() {},
  };
  return { sb, calls };
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
  test("parks before touching anything, then Approve pushes and opens a draft PR", async () => {
    const { sb, calls } = fakeRepo();
    const gh = fakeGithub();
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, githubToken: () => "ghs_secret", fetch: gh.f }));

    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    const parked = await s.result(t1);
    expect(parked).toMatchObject({ status: "suspended" });
    expect(JSON.stringify(parked)).toContain("src/a.ts | 2 +-"); // the human sees what would be pushed
    expect(calls.some((c) => c.command.includes("push"))).toBe(false); // nothing left the sandbox
    expect(gh.reqs).toHaveLength(0);

    const inputId = (parked as { request: { id: string } }).request.id;
    s.resume(t1, inputId, true);
    expect(await s.result(t1)).toMatchObject({ status: "completed", text: "done" });

    const push = calls.find((c) => c.command.includes(" push origin "))!;
    expect(push.command).toContain("0123456789abcdef0123456789abcdef01234567:refs/heads/scout/fix-a");
    expect(push.command).not.toContain("ghs_secret"); // token never in argv…
    expect(push.opts?.env).toEqual({ LOREHOUSE_GH_TOKEN: "ghs_secret" }); // …only in this command's env
    expect(calls.filter((c) => c.opts?.env).length).toBe(1); // and in no other command

    const post = gh.reqs.find((r) => r.method === "POST")!;
    expect(post.url).toBe("https://api.github.com/repos/acme/widgets/pulls");
    expect(post.body).toMatchObject({ head: "scout/fix-a", base: "main", title: "Fix a", draft: true });
    expect(toolResult()?.result).toMatchObject({ status: "opened", number: 7 });
  });

  test("Deny pushes nothing", async () => {
    const { sb, calls } = fakeRepo();
    const gh = fakeGithub();
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, githubToken: () => "t", fetch: gh.f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    const parked = (await s.result(t1)) as { request: { id: string } };
    s.resume(t1, parked.request.id, false);
    await s.result(t1);
    expect(calls.some((c) => c.command.includes("push"))).toBe(false);
    expect(gh.reqs).toHaveLength(0);
    expect(toolResult()?.result).toMatchObject({ status: "denied" });
  });

  test("an already-open PR for the branch is returned, not duplicated", async () => {
    const { sb } = fakeRepo();
    const gh = fakeGithub([{ html_url: "https://github.com/acme/widgets/pull/3", number: 3 }]);
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, githubToken: () => "t", fetch: gh.f }));
    const t1 = s.start({ turnId: "t1", userText: "open a PR" }).turnId;
    s.resume(t1, ((await s.result(t1)) as { request: { id: string } }).request.id, true);
    await s.result(t1);
    expect(gh.reqs.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(toolResult()?.result).toMatchObject({ status: "exists", number: 3 });
  });

  test("uncommitted changes fail fast — no approval is asked for", async () => {
    const { sb } = fakeRepo({ dirty: true });
    const { s, toolResult } = session(pullRequestTool({ sandboxFor: () => sb, githubToken: () => "t", fetch: fakeGithub().f }));
    expect(await s.result(s.start({ turnId: "t1", userText: "open a PR" }).turnId)).toMatchObject({ status: "completed" });
    expect(toolResult()?.result).toMatchObject({ error: expect.stringContaining("uncommitted") });
  });

  test("branches outside the agent prefix (scout/) are refused", async () => {
    const { sb, calls } = fakeRepo();
    const tool = pullRequestTool({ sandboxFor: () => sb, githubToken: () => "t", fetch: fakeGithub().f });
    const out = await tool.run({ branch: "main", title: "x" }, {} as never);
    expect(out).toMatchObject({ error: expect.stringContaining("scout/") });
    expect(calls).toHaveLength(0);
  });

  test("parseGithubRemote handles https and ssh forms", () => {
    expect(parseGithubRemote("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseGithubRemote("git@github.com:acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(() => parseGithubRemote("https://gitlab.com/a/b")).toThrow(/not a GitHub remote/);
  });
});

describe("workspace tools", () => {
  test("exec runs in the repo dir and keeps the TAIL of long output", async () => {
    const seen: { command: string; opts?: ExecOptions }[] = [];
    const sb: Sandbox = {
      async exec(command, opts) { seen.push({ command, opts }); return { exitCode: 1, stdout: "x".repeat(20_000) + "FAILED: 2 tests", stderr: "" }; },
      async readFile() { return ""; },
      async writeFile() {},
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
    const tools = workspaceTools((ctx) => { ids.push(ctx.sessionId); return { exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => "", writeFile: async () => {} }; });
    await tools[0]!.run({ command: "ls", sessionId: "slack:EVIL:1" }, { sessionId: "slack:C1:1.1" } as never);
    expect(ids).toEqual(["slack:C1:1.1"]);
  });

  test("clip is a no-op under the limit", () => {
    expect(clip("short")).toBe("short");
  });
});

describe("publicChannelsOnly", () => {
  const ev = (event: Record<string, unknown>) => ({ type: "event_callback", event });
  const open = publicChannelsOnly(new Set());
  const listed = publicChannelsOnly(parseAllowlist("C1, C2"));

  test("public-channel messages pass; DMs and private channels never do", () => {
    expect(open(ev({ type: "message", channel: "C9", channel_type: "channel" }))).toBe(true);
    expect(open(ev({ type: "message", channel: "D1", channel_type: "im" }))).toBe(false);
    expect(open(ev({ type: "message", channel: "G1", channel_type: "group" }))).toBe(false);
    expect(open(ev({ type: "message", channel: "G2", channel_type: "mpim" }))).toBe(false);
  });

  test("a mention carries no channel_type, so only an allowlisted channel admits it", () => {
    expect(open(ev({ type: "app_mention", channel: "C1" }))).toBe(false);
    expect(listed(ev({ type: "app_mention", channel: "C1" }))).toBe(true);
    expect(listed(ev({ type: "app_mention", channel: "C3" }))).toBe(false);
  });

  test("with an allowlist, a public channel outside it is refused too", () => {
    expect(listed(ev({ type: "message", channel: "C3", channel_type: "channel" }))).toBe(false);
  });

  test("with dms on, a DM passes, whatever the allowlist; private channels and group DMs still don't", () => {
    const withDms = publicChannelsOnly(parseAllowlist("C1"), { dms: true });
    expect(withDms(ev({ type: "message", channel: "D1", channel_type: "im" }))).toBe(true);
    expect(withDms(ev({ type: "message", channel: "G1", channel_type: "group" }))).toBe(false);
    expect(withDms(ev({ type: "message", channel: "G2", channel_type: "mpim" }))).toBe(false);
    expect(withDms(ev({ type: "message", channel: "C3", channel_type: "channel" }))).toBe(false);
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

  test("the reply links the allowlisted channels, or says any public channel", () => {
    expect(redirectText(parseAllowlist("C1"))).toContain("Ask me in <#C1>.");
    expect(redirectText(parseAllowlist("C1,C2"))).toContain("Ask me in <#C1> or <#C2>.");
    expect(redirectText(new Set())).toContain("Ask me in any public channel I'm in.");
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
    const tool = pullRequestTool({ sandboxFor: () => sb, githubToken: () => "t", fetch: gh.f, identity: agentIdentity("atlas") });
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
