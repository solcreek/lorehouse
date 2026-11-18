// Which Slack events start a turn, and for whom (src/turns.ts).

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { members, type UserInfo } from "../src/members";
import { SlackApiError, type SlackApi } from "../src/slack-api";
import { inThread, joinThread } from "../src/threads";
import { turnGate, type TurnDecision, type TurnEvent } from "../src/turns";

const MEMBER: UserInfo = { team_id: "T1", deleted: false, is_restricted: false, is_ultra_restricted: false };
const USERS: Record<string, UserInfo> = { U1: MEMBER, U2: MEMBER, UG1: { ...MEMBER, is_restricted: true } };

// A gate over a database of its own and a Slack whose users.info can be held per user, as
// a slow lookup is. deliver() takes an event through the gate the way June does: before()
// awaited, then decide().
function setup(opts: { dms?: boolean; listed?: string[]; holdMs?: number } = {}) {
  const db = openKnowledge(":memory:");
  const asked: string[] = [];
  const held = new Map<string, { arrived: () => void; release: Promise<void> }>();
  const api = {
    call: async (_method: string, params: { user: string }) => {
      asked.push(params.user);
      const hold = held.get(params.user);
      if (hold) {
        hold.arrived();
        await hold.release;
      }
      const user = USERS[params.user];
      if (!user) throw new SlackApiError("users.info", "user_not_found");
      return { user: { id: params.user, ...user } };
    },
  } as unknown as SlackApi;
  const listed = new Set(opts.listed ?? ["C1"]);
  const gate = turnGate({
    members: members(api),
    listed,
    dms: opts.dms ?? false,
    joined: (channel, thread) => inThread(db, channel, thread),
  });
  const deliver = async (e: TurnEvent): Promise<TurnDecision> => {
    await gate.before({ userId: e.user?.id, teamId: "T1", channelId: e.channelId, threadId: e.threadId, kind: e.kind, ts: e.ts });
    return gate.decide(e);
  };
  // Hold `user`'s lookup: `pending` resolves once Slack has been asked, `release` answers.
  const hold = (user: string) => {
    let arrived = () => {};
    let release = () => {};
    const pending = new Promise<void>((r) => { arrived = r; });
    held.set(user, { arrived, release: new Promise<void>((r) => { release = r; }) });
    return { pending, release: () => { held.delete(user); release(); } };
  };
  return { db, gate, deliver, hold, asked, listed, joined: (thread: string) => inThread(db, "C1", thread) };
}

let n = 0;
const nextTs = () => `1800000000.${String(++n).padStart(6, "0")}`;
// As June normalizes them: a mention carries no channel type, and a top-level message's
// thread is itself.
const mention = (user: string, thread?: string): TurnEvent => {
  const ts = nextTs();
  return { kind: "app_mention", channelId: "C1", channelType: "unknown", threadId: thread ?? ts, ts, text: "<@UBOT> where is the wombat review", user: { id: user } };
};
const reply = (user: string, thread: string, text = "and which floor is that on?"): TurnEvent =>
  ({ kind: "message", channelId: "C1", channelType: "channel", threadId: thread, ts: nextTs(), text, user: { id: user } });

const ANSWER: TurnDecision = { turn: "answer" };
const NONE: TurnDecision = { turn: "none" };

describe("turnGate", () => {
  test("a member's mention is answered; a guest's is refused, with the verdict that refused", async () => {
    const t = setup();
    expect(await t.deliver(mention("U1"))).toEqual(ANSWER);
    expect(await t.deliver(mention("UG1"))).toEqual({ turn: "refuse", verdict: { user: "UG1", member: false, reason: "guest" } });
    expect(await t.deliver(mention("U404"))).toMatchObject({ turn: "refuse", verdict: { reason: "lookup_failed", error: "user_not_found" } });
  });

  test("a sender who was never looked up is refused, with no verdict", async () => {
    const t = setup();
    expect(t.gate.decide(mention("U1"))).toEqual({ turn: "refuse", verdict: undefined });
    expect(await t.deliver({ ...mention("U1"), user: undefined })).toEqual({ turn: "refuse", verdict: undefined });
  });

  test("a follow-up in a joined thread is answered for a member and refused for a guest; elsewhere it is nothing", async () => {
    const t = setup();
    joinThread(t.db, "C1", "1.1");
    expect(await t.deliver(reply("U2", "1.1"))).toEqual(ANSWER);
    expect(await t.deliver(reply("UG1", "1.1"))).toMatchObject({ turn: "refuse", verdict: { reason: "guest" } });
    expect(await t.deliver(reply("U2", "9.9"))).toEqual(NONE);
    expect(await t.deliver(reply("U2", "1.1", "<@U1> what do you think?"))).toEqual(NONE);
  });

  test("top-level channel messages are nothing, and their senders aren't looked up", async () => {
    const t = setup();
    const ts = nextTs();
    expect(await t.deliver({ kind: "message", channelId: "C1", channelType: "channel", threadId: ts, ts, text: "lunch?", user: { id: "U2" } })).toEqual(NONE);
    expect(t.asked).toEqual([]);
  });

  test("a DM is answered only with DMs on, and only for a member", async () => {
    const dm = (user: string): TurnEvent => { const ts = nextTs(); return { kind: "message", channelId: "D1", channelType: "im", threadId: ts, ts, text: "hello", user: { id: user } }; };
    const off = setup();
    expect(await off.deliver(dm("U1"))).toEqual(NONE);
    expect(off.asked).toEqual([]);
    const on = setup({ dms: true });
    expect(await on.deliver(dm("U1"))).toEqual(ANSWER);
    expect(await on.deliver(dm("UG1"))).toMatchObject({ turn: "refuse" });
  });

  test("a channel closed while the sender was looked up gets nothing, not even a refusal", async () => {
    const t = setup();
    const lookup = t.hold("U1");
    const decided = t.deliver(mention("U1"));
    await lookup.pending;
    t.listed.delete("C1");
    lookup.release();
    expect(await decided).toEqual(NONE);
  });
});
