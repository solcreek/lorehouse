// The Slack channel's thread tool, with people named.

import { describe, expect, test } from "bun:test";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import type { PersonName } from "../src/ingest/slack-users";
import { namedThreadTool, withNamedThreads } from "../src/tools/slack-names";

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

  test("keeps the tool's name and input; the description says replies are named", () => {
    const tool = namedThreadTool(rawThreadTool({ messages: [] }), names);
    expect(tool.spec.name).toBe("slack_read_thread");
    expect(tool.spec.input).toEqual({ type: "object", properties: {} });
    expect(tool.spec.description).toContain("author (the person who wrote it)");
  });
});

describe("withNamedThreads", () => {
  test("swaps only slack_read_thread; the channel's other tools are unchanged", async () => {
    const other: Tool = { spec: { name: "slack_resolve_user", description: "d", input: { type: "object", properties: {} } }, run: async () => "same" };
    const channel = withNamedThreads({ name: "slack", tools: () => [rawThreadTool({ messages: [{ user: "U5", text: "x", ts: "1" }] }), other] }, names);
    const [thread, resolve] = channel.tools!();
    expect(await thread!.run({}, ctx)).toEqual({ messages: [{ author: "hkato (Hana Kato)", user: "U5", text: "x", ts: "1" }] });
    expect(resolve).toBe(other);
  });

  test("a channel without tools is returned as is", () => {
    const channel: { name: string; tools?: () => Tool[] } = { name: "web" };
    expect(withNamedThreads(channel, names)).toBe(channel);
  });
});
