// The Slack channel's own tools reach only the channel being answered in and the listed ones.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { slackChannel } from "@junejs/core/channels";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { parseAllowlist } from "../src/policy";
import { channelGuarded, withChannelGuard } from "../src/tools/slack-channels";

// A Slack Web API that records what it is asked: which method, for which channel.
let asked: { method: string; channel?: string }[] = [];
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const method = url.pathname.split("/").pop()!;
    const body = req.method === "POST" ? ((await req.json()) as Record<string, string>) : Object.fromEntries(url.searchParams);
    asked.push({ method, channel: body.channel });
    if (method === "conversations.replies") return Response.json({ ok: true, messages: [{ user: "U5", text: "x", ts: "1.1" }] });
    if (method === "reactions.get") return Response.json({ ok: true, message: { reactions: [{ name: "tada", count: 1, users: ["U5"] }] } });
    if (method === "users.info") return Response.json({ ok: true, user: { id: body.user, name: "hana" } });
    return Response.json({ ok: true });
  },
});
afterAll(() => api.stop(true));
beforeEach(() => { asked = []; });

// June's real Slack tools, guarded as app.ts guards them, for an allowlist.
function juneTools(channels: string): Map<string, Tool> {
  const allow = parseAllowlist(channels);
  const channel = withChannelGuard(slackChannel({ signingSecret: "s", botToken: "xoxb-t", apiUrl: `http://localhost:${api.port}/api` }), (c) => allow.has(c));
  return new Map(channel.tools!().map((t) => [t.spec.name, t]));
}
const answeringIn = (channelId: string) => ({ event: { source: "slack", channelId, ts: "9.9", threadId: "9.9" } }) as unknown as ToolContext;
const inC9 = answeringIn("C9");

// Each June tool that takes a channel id, called for that channel, and the Slack method it reads or writes.
const GUARDED = [
  { tool: "slack_read_thread", input: (channelId: string) => ({ channelId, threadId: "1.1" }), method: "conversations.replies" },
  { tool: "slack_list_reactions", input: (channelId: string) => ({ channelId, ts: "1.1" }), method: "reactions.get" },
  { tool: "slack_add_reaction", input: (channelId: string) => ({ channelId, ts: "1.1", name: "eyes" }), method: "reactions.add" },
] as const;

describe("withChannelGuard on June's Slack tools", () => {
  test("June's Slack tools are the four expected; all but slack_resolve_user take a channel id", () => {
    const tools = juneTools("C1");
    expect([...tools.keys()].sort()).toEqual(["slack_add_reaction", "slack_list_reactions", "slack_read_thread", "slack_resolve_user"]);
    for (const [name, t] of tools) expect(name !== "slack_resolve_user").toBe("channelId" in ((t.spec.input as { properties: object }).properties));
  });

  for (const { tool, input, method } of GUARDED) {
    describe(tool, () => {
      test("allowed: the channel it is answering in, named or by default", async () => {
        const t = juneTools("C1").get(tool)!;
        expect(await t.run(input("C9"), inC9)).not.toHaveProperty("error");
        expect(await t.run({ ...input("C9"), channelId: undefined }, inC9)).not.toHaveProperty("error");
        expect(asked).toEqual([{ method, channel: "C9" }, { method, channel: "C9" }]);
      });

      test("allowed: a channel on AGENT_CHANNELS", async () => {
        expect(await juneTools("C1,C2").get(tool)!.run(input("C2"), inC9)).not.toHaveProperty("error");
        expect(asked).toEqual([{ method, channel: "C2" }]);
      });

      test("refused, and Slack never asked: a channel not on AGENT_CHANNELS", async () => {
        expect(await juneTools("C1").get(tool)!.run(input("C2"), inC9)).toEqual({ error: "not a channel I read: C2" });
        expect(asked).toEqual([]);
      });

      test("refused: any other channel when AGENT_CHANNELS is empty (nowhere)", async () => {
        expect(await juneTools("").get(tool)!.run(input("C1"), inC9)).toEqual({ error: "not a channel I read: C1" });
        expect(asked).toEqual([]);
      });

      test("refused: a DM or private channel other than the one it is answering in", async () => {
        const t = juneTools("C1").get(tool)!;
        expect(await t.run(input("D1"), inC9)).toEqual({ error: "not a channel I read: D1" });
        expect(await t.run(input("G1"), inC9)).toEqual({ error: "not a channel I read: G1" });
        expect(asked).toEqual([]);
      });

      test("allowed: the DM it is answering in (DM_MODE=answer), though no DM is ever listed", async () => {
        expect(await juneTools("C1").get(tool)!.run(input("D1"), answeringIn("D1"))).not.toHaveProperty("error");
        expect(asked).toEqual([{ method, channel: "D1" }]);
      });

      test("refused: a named channel when the turn has no Slack event to answer in", async () => {
        expect(await juneTools("").get(tool)!.run(input("C9"), {} as ToolContext)).toEqual({ error: "not a channel I read: C9" });
        expect(asked).toEqual([]);
      });
    });
  }

  test("slack_resolve_user is left as June made it", async () => {
    expect(await juneTools("").get("slack_resolve_user")!.run({ userId: "U5" }, inC9)).toMatchObject({ id: "U5", name: "hana" });
  });
});

describe("channelGuarded", () => {
  const raw: Tool = { spec: { name: "t", description: "d", input: { type: "object", properties: { channelId: { type: "string" } } } }, run: async () => "ran" };

  test("a channel id that isn't a string is refused, not passed on", async () => {
    expect(await channelGuarded(raw, () => true).run({ channelId: 42 }, inC9)).toEqual({ error: "not a channel I read: 42" });
  });

  test("only a Slack event's channel counts as the one being answered in", async () => {
    const fromWeb = { event: { source: "web", channelId: "C9" } } as unknown as ToolContext;
    expect(await channelGuarded(raw, () => false).run({ channelId: "C9" }, fromWeb)).toEqual({ error: "not a channel I read: C9" });
  });

  test("no channel id, null or empty: passed on for June to use the current channel or find no target", async () => {
    const guarded = channelGuarded(raw, () => false);
    for (const input of [{}, { channelId: null }, { channelId: "" }, undefined]) expect(await guarded.run(input, inC9)).toBe("ran");
  });

  test("keeps the tool's spec", () => {
    expect(channelGuarded(raw, () => true).spec).toBe(raw.spec);
  });

  test("a channel without tools is returned as is", () => {
    const channel: { name: string; tools?: () => Tool[] } = { name: "web" };
    expect(withChannelGuard(channel, () => true)).toBe(channel);
  });
});
