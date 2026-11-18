// Carrying on a conversation in a thread without a new mention.

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { inThread, isFollowUp, joinThread, mentionHolds } from "../src/threads";

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

describe("mentionHolds", () => {
  // Whether a promise has resolved by now (after the microtasks already queued).
  const done = async (p: Promise<void>) => Promise.race([p.then(() => true), Bun.sleep(1).then(() => false)]);

  test("a thread with no hold is settled at once; one with a hold, when its mention is decided", async () => {
    const holds = mentionHolds();
    expect(await done(holds.settled("C1", "1.1"))).toBe(true);
    holds.open("C1", "1.1", "1.1");
    const waiting = holds.settled("C1", "1.1");
    expect(await done(waiting)).toBe(false);
    expect(await done(holds.settled("C1", "2.2"))).toBe(true); // another thread
    expect(await done(holds.settled("C2", "1.1"))).toBe(true); // another channel
    holds.close("C1", "1.1", "1.1");
    expect(await done(waiting)).toBe(true);
    expect(holds.size).toBe(0);
  });

  test("two mentions pending in a thread: settled when both are decided; one that arrives later isn't waited for", async () => {
    const holds = mentionHolds();
    holds.open("C1", "1.1", "1.1");
    holds.open("C1", "1.1", "1.2");
    const waiting = holds.settled("C1", "1.1");
    holds.close("C1", "1.1", "1.1");
    expect(await done(waiting)).toBe(false);
    holds.open("C1", "1.1", "1.3"); // after the wait began
    holds.close("C1", "1.1", "1.2");
    expect(await done(waiting)).toBe(true);
    expect(holds.size).toBe(1);
    holds.close("C1", "1.1", "1.3");
  });

  test("a hold never closed ends by itself, and leaves nothing behind", async () => {
    const holds = mentionHolds(10);
    for (let i = 0; i < 100; i++) holds.open("C1", `${i}.1`, `${i}.1`);
    expect(holds.size).toBe(100);
    await holds.settled("C1", "7.1");
    await Bun.sleep(5);
    expect(holds.size).toBe(0);
  });

  test("opening a mention's hold twice, or closing one that isn't open, is harmless", async () => {
    const holds = mentionHolds();
    holds.open("C1", "1.1", "1.1");
    holds.open("C1", "1.1", "1.1");
    expect(holds.size).toBe(1);
    holds.close("C1", "1.1", "1.1");
    holds.close("C1", "1.1", "1.1");
    holds.close("C9", "9.9", "9.9");
    expect(holds.size).toBe(0);
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
