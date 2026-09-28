// Carrying on a conversation in a thread without a new mention.

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { inThread, isFollowUp, joinThread } from "../src/threads";

const joined = (channel: string, thread: string) => channel === "C1" && thread === "1.1";
const reply = (e: Partial<Parameters<typeof isFollowUp>[0]> = {}) =>
  ({ kind: "message", channelId: "C1", channelType: "channel", threadId: "1.1", ts: "1.2", text: "and the tests?", ...e });

describe("isFollowUp", () => {
  test("a plain reply in a thread the agent was asked into is a follow-up", () => {
    expect(isFollowUp(reply(), joined)).toBe(true);
  });

  test("not a follow-up: a thread it was never asked into, or a top-level message", () => {
    expect(isFollowUp(reply({ threadId: "9.9" }), joined)).toBe(false);
    expect(isFollowUp(reply({ threadId: "1.1", ts: "1.1" }), joined)).toBe(false); // the root itself
    expect(isFollowUp(reply({ threadId: undefined }), joined)).toBe(false);
  });

  test("not a follow-up: a reply that mentions anyone (the agent: answered as the mention; someone else: people talking)", () => {
    expect(isFollowUp(reply({ text: "<@UBOT> and the tests?" }), joined)).toBe(false);
    expect(isFollowUp(reply({ text: "<@U2> what do you think?" }), joined)).toBe(false);
    expect(isFollowUp(reply({ text: "cc <@U2|wendy>" }), joined)).toBe(false);
  });

  test("not a follow-up: a reply that mentions a user group or the whole channel", () => {
    expect(isFollowUp(reply({ text: "<!channel> deploy is done" }), joined)).toBe(false);
    expect(isFollowUp(reply({ text: "<!here|here> anyone around?" }), joined)).toBe(false);
    expect(isFollowUp(reply({ text: "<!everyone> heads up" }), joined)).toBe(false);
    expect(isFollowUp(reply({ text: "<!subteam^S123|@oncall> can you look?" }), joined)).toBe(false);
  });

  test("a follow-up: Slack formatting that isn't a mention", () => {
    expect(isFollowUp(reply({ text: "and after <!date^1700000000^{date}|Nov 14>?" }), joined)).toBe(true);
  });

  test("not a follow-up: anything but a public-channel message (DMs, private channels, mentions, reactions)", () => {
    expect(isFollowUp(reply({ channelType: "im" }), joined)).toBe(false);
    expect(isFollowUp(reply({ channelType: "group" }), joined)).toBe(false);
    expect(isFollowUp(reply({ channelType: "unknown" }), joined)).toBe(false);
    expect(isFollowUp(reply({ kind: "app_mention" }), joined)).toBe(false);
    expect(isFollowUp(reply({ kind: "reaction_added" }), joined)).toBe(false);
  });
});

describe("agent threads", () => {
  test("a joined thread is remembered per channel; joining twice is harmless", () => {
    const db = openKnowledge(":memory:");
    expect(inThread(db, "C1", "1.1")).toBe(false);
    joinThread(db, "C1", "1.1");
    joinThread(db, "C1", "1.1");
    expect(inThread(db, "C1", "1.1")).toBe(true);
    expect(inThread(db, "C2", "1.1")).toBe(false);
    expect(inThread(db, "C1", "1.2")).toBe(false);
  });
});
