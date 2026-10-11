// The Slack channel's thread tool, with people named.

import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import type { PersonName } from "../src/ingest/slack-users";
import { namedThreadTool, namedUserTool, withNamedPeople } from "../src/tools/slack-names";

const NAMES = new Map<string, PersonName>([
  ["U5", { short: "hkato", full: "hkato (Hana Kato)" }],
  ["U7", { short: "Priya Nair", full: "Priya Nair" }],
]);
const names = async (ids: string[]) => new Map([...NAMES].filter(([id]) => ids.includes(id)));
const ctx = {} as ToolContext;

// Stands in for June's slack_read_thread: raw replies, authors as ids.
function rawThreadTool(result: unknown): Tool {
  return {
    spec: { name: "slack_read_thread", description: "raw", input: { type: "object", properties: {} } },
    run: async () => result,
  };
}

describe("namedThreadTool", () => {
  test("each reply carries its author by name, and mentions read as names", async () => {
    const tool = namedThreadTool(rawThreadTool({ messages: [
      { user: "U5", text: "<@U7> 補充一下下一季的方向：先做排程", ts: "1.1" },
      { user: "U7", text: "收到～ 文件也需要再補", ts: "1.2" },
    ] }), names);
    expect(await tool.run({}, ctx)).toEqual({ messages: [
      { author: "hkato (Hana Kato)", user: "U5", text: "@Priya Nair 補充一下下一季的方向：先做排程", ts: "1.1" },
      { author: "Priya Nair", user: "U7", text: "收到～ 文件也需要再補", ts: "1.2" },
    ] });
  });

  test("a person it can't name keeps their id; a reply without a user is 'unknown'", async () => {
    const tool = namedThreadTool(rawThreadTool({ messages: [{ user: "U404", text: "hi <@U404>", ts: "1.1" }, { text: "system", ts: "1.2" }] }), names);
    expect(await tool.run({}, ctx)).toEqual({ messages: [
      { author: "U404", user: "U404", text: "hi @U404", ts: "1.1" },
      { author: "unknown", user: undefined, text: "system", ts: "1.2" },
    ] });
  });

  test("errors pass through untouched", async () => {
    let asked = false;
    const tool = namedThreadTool(rawThreadTool({ error: "thread_not_found" }), async () => ((asked = true), new Map()));
    expect(await tool.run({}, ctx)).toEqual({ error: "thread_not_found" });
    expect(asked).toBe(false);
  });

  test("reads a thread only in the channel it is answering in or in one it reads", async () => {
    const tool = namedThreadTool(rawThreadTool({ messages: [{ user: "U5", text: "x", ts: "1.1" }] }), names, (c) => c === "C1");
    const inC9 = { event: { channelId: "C9" } } as ToolContext;
    expect(await tool.run({ channelId: "D1", threadId: "1.1" }, inC9)).toEqual({ error: "not a channel I read: D1" });
    expect(await tool.run({ channelId: "C2", threadId: "1.1" }, inC9)).toEqual({ error: "not a channel I read: C2" });
    expect(await tool.run({ channelId: "C1", threadId: "1.1" }, inC9)).toEqual({ messages: [{ author: "hkato (Hana Kato)", user: "U5", text: "x", ts: "1.1" }] });
    expect(await tool.run({ channelId: "C9", threadId: "1.1" }, inC9)).toEqual({ messages: [{ author: "hkato (Hana Kato)", user: "U5", text: "x", ts: "1.1" }] });
    expect(await tool.run({ channelId: "C9", threadId: "1.1" }, ctx)).toEqual({ error: "not a channel I read: C9" });
  });

  test("keeps the tool's name and input; the description says replies are named", () => {
    const tool = namedThreadTool(rawThreadTool({ messages: [] }), names);
    expect(tool.spec.name).toBe("slack_read_thread");
    expect(tool.spec.input).toEqual({ type: "object", properties: {} });
    expect(tool.spec.description).toContain("author (the person who wrote it)");
  });
});

// Stands in for June's slack_resolve_user: three names for one person.
function rawUserTool(result: unknown): Tool {
  return {
    spec: { name: "slack_resolve_user", description: "raw", input: { type: "object", properties: { userId: { type: "string" } } } },
    run: async () => result,
  };
}

describe("namedUserTool", () => {
  test("returns the person under the one name knowledge uses, not a handle, display and real name", async () => {
    const tool = namedUserTool(rawUserTool({ id: "U5", name: "hana", realName: "Hana Kato", displayName: "hkato" }), names);
    expect(await tool.run({ userId: "U5" }, ctx)).toEqual({ id: "U5", name: "hkato (Hana Kato)" });
  });

  test("someone it can't name here, and errors, pass through as June returned them", async () => {
    const raw = { id: "U404", name: "ghost", realName: "G", displayName: "g" };
    expect(await namedUserTool(rawUserTool(raw), names).run({ userId: "U404" }, ctx)).toEqual(raw);
    expect(await namedUserTool(rawUserTool({ error: "user_not_found" }), names).run({ userId: "U9" }, ctx)).toEqual({ error: "user_not_found" });
  });

  test("keeps the tool's name and input; the description says to use it for mentions in the question", () => {
    const tool = namedUserTool(rawUserTool({}), names);
    expect(tool.spec.name).toBe("slack_resolve_user");
    expect(tool.spec.input).toEqual({ type: "object", properties: { userId: { type: "string" } } });
    expect(tool.spec.description).toContain("<@U…> mention in the question");
  });
});

describe("withNamedPeople", () => {
  test("swaps the thread and user tools for the named ones; the channel's other tools are unchanged", async () => {
    const other: Tool = { spec: { name: "slack_list_reactions", description: "d", input: { type: "object", properties: {} } }, run: async () => "same" };
    const channel = withNamedPeople({ name: "slack", tools: () => [rawThreadTool({ messages: [{ user: "U5", text: "x", ts: "1" }] }), rawUserTool({ id: "U5", name: "hana" }), other] }, names);
    const [thread, user, reactions] = channel.tools!();
    expect(await thread!.run({}, ctx)).toEqual({ messages: [{ author: "hkato (Hana Kato)", user: "U5", text: "x", ts: "1" }] });
    expect(await user!.run({ userId: "U5" }, ctx)).toEqual({ id: "U5", name: "hkato (Hana Kato)" });
    expect(reactions).toBe(other);
  });

  test("a channel without tools is returned as is", () => {
    const channel: { name: string; tools?: () => Tool[] } = { name: "web" };
    expect(withNamedPeople(channel, names)).toBe(channel);
  });
});
