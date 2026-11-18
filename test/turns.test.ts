// Which Slack events start a turn, and for whom (src/turns.ts).

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { members, TTL_MS, type UserInfo } from "../src/members";
import { SlackApiError, type SlackApi } from "../src/slack-api";
import type { SlackTriggerEvent } from "../src/profiles";
import { inThread, joinThread } from "../src/threads";
import { turnGate, type TurnDecision, type TurnEvent } from "../src/turns";

const MEMBER: UserInfo = { team_id: "T1", deleted: false, is_restricted: false, is_ultra_restricted: false };
const USERS: Record<string, UserInfo> = { U1: MEMBER, U2: MEMBER, UG1: { ...MEMBER, is_restricted: true } };

// A gate over a database of its own and a Slack whose users.info can be held per user, as
// a slow lookup is. deliver() takes an event through the gate the way June does: before()
// awaited, then decide().
function setup(opts: { dms?: boolean; startsOn?: SlackTriggerEvent[]; listed?: string[]; holdMs?: number; join?: () => void; joined?: () => boolean } = {}) {
  const db = openKnowledge(":memory:");
  const asked: string[] = [];
  // What Slack says of each person now (a test may change it), and the members cache's clock.
  const users: Record<string, UserInfo> = { ...USERS };
  const clock = { now: 1_000_000 };
  const errors: string[] = [];
  const held = new Map<string, { arrived: () => void; release: Promise<void> }>();
  const api = {
    call: async (_method: string, params: { user: string }) => {
      asked.push(params.user);
      const hold = held.get(params.user);
      if (hold) {
        hold.arrived();
        await hold.release;
      }
      const user = users[params.user];
      if (!user) throw new SlackApiError("users.info", "user_not_found");
      return { user: { id: params.user, ...user } };
    },
  } as unknown as SlackApi;
  const listed = new Set(opts.listed ?? ["C1"]);
  const gate = turnGate({
    members: members(api, { now: () => clock.now }),
    listed,
    dms: opts.dms ?? false,
    startsOn: opts.startsOn,
    joined: opts.joined ?? ((channel, thread) => inThread(db, channel, thread)),
    join: opts.join ?? ((channel, thread) => joinThread(db, channel, thread)),
    holdMs: opts.holdMs,
    onError: (what, err) => errors.push(`${what}: ${err instanceof Error ? err.message : String(err)}`),
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
  return { db, gate, deliver, hold, asked, listed, users, clock, errors, joined: (thread: string) => inThread(db, "C1", thread) };
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

  test("a mention asks the agent into its thread only once it is accepted", async () => {
    const t = setup();
    const asked = mention("U1");
    expect(t.joined(asked.ts)).toBe(false);
    expect(await t.deliver(asked)).toEqual(ANSWER);
    expect(t.joined(asked.ts)).toBe(true);
    // In a thread someone else started: the thread's root is what is joined.
    expect(await t.deliver(mention("U2", "1.1"))).toEqual(ANSWER);
    expect(t.joined("1.1")).toBe(true);
  });

  test("a refused asker's mention joins nothing: a guest's, an unknown sender's, or one in a channel closed meanwhile", async () => {
    const t = setup();
    const guest = mention("UG1"), unknown = mention("U404"), closed = mention("U1");
    expect(await t.deliver(guest)).toMatchObject({ turn: "refuse" });
    expect(await t.deliver(unknown)).toMatchObject({ turn: "refuse" });
    t.listed.delete("C1");
    expect(await t.deliver(closed)).toEqual(NONE);
    for (const m of [guest, unknown, closed]) expect(t.joined(m.ts)).toBe(false);
    // So a member's reply there is not a follow-up.
    t.listed.add("C1");
    expect(await t.deliver(reply("U2", guest.ts))).toEqual(NONE);
  });

  // #163. U2's verdict is cached, so nothing but the hold keeps U2's reply from being
  // decided while U1's lookup is still out.
  test("a follow-up that arrives while the mention that opened its thread is still being looked up is answered once the mention is accepted", async () => {
    const t = setup();
    await t.deliver(mention("U2")); // U2 is cached
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const order: string[] = [];
    const first = t.deliver(asked).then((d) => { order.push("mention"); return d; });
    await lookup.pending;
    const second = t.deliver(reply("U2", asked.ts)).then((d) => { order.push("follow-up"); return d; });
    await Bun.sleep(5);
    expect(order).toEqual([]); // neither is decided while U1's lookup is out
    expect(t.joined(asked.ts)).toBe(false);
    lookup.release();
    expect(await second).toEqual(ANSWER);
    expect(await first).toEqual(ANSWER);
    expect(order).toEqual(["mention", "follow-up"]);
    expect(t.asked.filter((u) => u === "U2")).toHaveLength(1); // the follow-up cost no lookup
  });

  test("a follow-up held for a mention that is then refused is nothing, and the thread is never joined", async () => {
    for (const asker of ["UG1", "U404"]) { // a guest; a lookup that fails
      const t = setup();
      await t.deliver(mention("U2"));
      const lookup = t.hold(asker);
      const asked = mention(asker);
      const first = t.deliver(asked);
      await lookup.pending;
      const second = t.deliver(reply("U2", asked.ts));
      expect(t.joined(asked.ts)).toBe(false); // not while the lookup is out
      lookup.release();
      expect(await first).toMatchObject({ turn: "refuse" });
      expect(await second).toEqual(NONE);
      expect(t.joined(asked.ts)).toBe(false);
      expect(await t.deliver(reply("U2", asked.ts))).toEqual(NONE); // nor later
    }
  });

  test("a held follow-up still passes the members check and the channel check", async () => {
    const t = setup();
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const first = t.deliver(asked);
    await lookup.pending;
    const guest = t.deliver(reply("UG1", asked.ts));
    lookup.release();
    expect(await first).toEqual(ANSWER);
    expect(await guest).toMatchObject({ turn: "refuse", verdict: { reason: "guest" } });

    const closing = setup();
    await closing.deliver(mention("U2"));
    const slow = closing.hold("U1");
    const opened = mention("U1");
    const accepted = closing.deliver(opened);
    await slow.pending;
    const held = closing.deliver(reply("U2", opened.ts));
    slow.release();
    expect(await accepted).toEqual(ANSWER);
    closing.listed.delete("C1"); // closed after the mention was accepted, before the follow-up is decided
    expect(await held).toEqual(NONE);
  });

  // The sender's verdict was cached 9 min 55 s ago (TTL_MS is 10 min) and runs out while
  // the reply is held: it is judged on a verdict valid when it is let go, looked up anew.
  test("a held reply whose sender's cached verdict expires during the hold is looked up again: still a member, answered", async () => {
    const t = setup();
    await t.deliver(mention("U2"));
    t.clock.now += TTL_MS - 5000;
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const first = t.deliver(asked);
    await lookup.pending;
    const second = t.deliver(reply("U2", asked.ts)); // a cache hit, 5 s before it runs out
    await Bun.sleep(1);
    expect(t.asked.filter((u) => u === "U2")).toHaveLength(1);
    t.clock.now += 8000; // U1's lookup took 8 s
    lookup.release();
    expect(await first).toEqual(ANSWER);
    expect(await second).toEqual(ANSWER);
    expect(t.asked.filter((u) => u === "U2")).toHaveLength(2);
  });

  test("a held reply whose sender's verdict expired during the hold, and who is a guest now, is refused as one", async () => {
    const t = setup();
    await t.deliver(mention("U2"));
    t.clock.now += TTL_MS - 5000;
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const first = t.deliver(asked);
    await lookup.pending;
    const second = t.deliver(reply("U2", asked.ts));
    t.users.U2 = { ...MEMBER, is_restricted: true };
    t.clock.now += 8000;
    lookup.release();
    expect(await first).toEqual(ANSWER);
    expect(await second).toEqual({ turn: "refuse", verdict: { user: "U2", member: false, reason: "guest" } });
  });

  // Whichever arrives first and whichever is decided first, the reply waits for both and
  // finds the thread joined by the member's.
  for (const arrival of [["U1", "UG1"], ["UG1", "U1"]] as const) {
    for (const decided of [["U1", "UG1"], ["UG1", "U1"]] as const) {
      test(`two mentions pending in one thread (${arrival.join(" then ")}; decided ${decided.join(" then ")}): a held reply waits for both, and is answered because the member's was accepted`, async () => {
        const t = setup();
        await t.deliver(mention("U2"));
        const lookups = { U1: t.hold("U1"), UG1: t.hold("UG1") };
        const mentions = arrival.map((user) => ({ user, done: t.deliver(mention(user, "5.5")) }));
        await Promise.all([lookups.U1.pending, lookups.UG1.pending]);
        let replied = false;
        const held = t.deliver(reply("U2", "5.5")).then((d) => { replied = true; return d; });
        lookups[decided[0]].release();
        await mentions.find((m) => m.user === decided[0])!.done;
        await Bun.sleep(1);
        expect(replied).toBe(false); // the other mention is still out
        lookups[decided[1]].release();
        expect(await held).toEqual(ANSWER);
        expect(await mentions.find((m) => m.user === "U1")!.done).toEqual(ANSWER);
        expect(await mentions.find((m) => m.user === "UG1")!.done).toMatchObject({ turn: "refuse", verdict: { reason: "guest" } });
        expect(t.joined("5.5")).toBe(true);
      });
    }
  }

  test("an accepted mention is still answered when recording the join fails; the failure is reported and its hold ends", async () => {
    const t = setup({ join: () => { throw new Error("disk full"); } });
    const asked = mention("U1");
    expect(await t.deliver(asked)).toEqual(ANSWER);
    expect(t.errors).toEqual(["joining the thread: disk full"]);
    // The hold is closed: a reply there is decided at once (and, the join lost, is nothing).
    const t0 = Date.now();
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(NONE);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test("when whether a thread is joined can't be read, the sender is still looked up: a mention is answered, a reply is nothing", async () => {
    const t = setup({ joined: () => { throw new Error("database is locked"); } });
    expect(await t.deliver(mention("U1"))).toEqual(ANSWER);
    expect(await t.deliver(mention("UG1"))).toMatchObject({ turn: "refuse", verdict: { reason: "guest" } });
    expect(await t.deliver(reply("U2", "1.1"))).toEqual(NONE);
    expect(t.asked).toEqual(["U1", "UG1", "U2"]);
    expect(t.errors.length).toBeGreaterThan(0);
    expect(new Set(t.errors)).toEqual(new Set(["reading whether the thread is joined: database is locked"]));
  });

  test("a hold expires: a mention that is never decided lets the follow-up go, unanswered", async () => {
    const t = setup({ holdMs: 20 });
    await t.deliver(mention("U2"));
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const first = t.deliver(asked);
    await lookup.pending;
    const t0 = Date.now();
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(NONE);
    expect(Date.now() - t0).toBeLessThan(1000);
    lookup.release();
    expect(await first).toEqual(ANSWER); // the mention itself is still answered, and joins
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(ANSWER);
  });

  test("a follow-up in a thread already joined doesn't wait for a mention pending there, nor for one in another thread", async () => {
    const t = setup();
    await t.deliver(mention("U2"));
    joinThread(t.db, "C1", "1.1");
    const lookup = t.hold("UG1");
    const there = t.deliver(mention("UG1", "1.1"));
    const elsewhere = t.deliver(mention("UG1"));
    await lookup.pending;
    expect(await t.deliver(reply("U2", "1.1"))).toEqual(ANSWER);
    expect(await t.deliver(reply("U2", "9.9"))).toEqual(NONE);
    lookup.release();
    await Promise.all([there, elsewhere]);
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

// The profile Slack starts says which kinds of message start a turn (profiles.ts): its
// Slack trigger's events, given to the gate as `startsOn`. Every set loadProfiles accepts
// is here (follow_up without mention is refused there). Left out, as in every test above,
// it is all three: the lorehouse profile's.
describe("turnGate, by the profile's trigger events", () => {
  const dm = (user: string): TurnEvent => { const ts = nextTs(); return { kind: "message", channelId: "D1", channelType: "im", threadId: ts, ts, text: "hello", user: { id: user } }; };

  test("all three listed is the same gate as none given: a mention, its follow-up, and with DMs on a DM, are answered", async () => {
    for (const startsOn of [undefined, ["mention", "follow_up", "direct_message"] as SlackTriggerEvent[]]) {
      const t = setup({ startsOn, dms: true });
      const asked = mention("U1");
      expect(await t.deliver(asked)).toEqual(ANSWER);
      expect(t.joined(asked.ts)).toBe(true);
      expect(await t.deliver(reply("U2", asked.ts))).toEqual(ANSWER);
      expect(await t.deliver(dm("U1"))).toEqual(ANSWER);
      expect(await setup({ startsOn, dms: false }).deliver(dm("U1"))).toEqual(NONE);
    }
  });

  test("mention only: a mention is answered and joins its thread; a reply there starts nothing and isn't looked up; a DM starts nothing even with DMs on", async () => {
    const t = setup({ startsOn: ["mention"], dms: true });
    const asked = mention("U1");
    expect(await t.deliver(asked)).toEqual(ANSWER);
    expect(t.joined(asked.ts)).toBe(true);
    expect(await t.deliver(mention("UG1"))).toMatchObject({ turn: "refuse", verdict: { reason: "guest" } });
    t.asked.length = 0;
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(NONE);
    expect(await t.deliver(dm("U2"))).toEqual(NONE);
    expect(t.asked).toEqual([]);
  });

  test("mention only: a reply never waits for a mention being looked up, since no reply is a follow-up", async () => {
    const t = setup({ startsOn: ["mention"] });
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const first = t.deliver(asked);
    await lookup.pending;
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(NONE); // decided while the mention is still pending
    lookup.release();
    expect(await first).toEqual(ANSWER);
  });

  test("mention and follow_up: a reply is answered only in a thread a mention opened; a DM starts nothing even with DMs on", async () => {
    const t = setup({ startsOn: ["mention", "follow_up"], dms: true });
    const asked = mention("U1");
    expect(await t.deliver(asked)).toEqual(ANSWER);
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(ANSWER);
    expect(await t.deliver(reply("UG1", asked.ts))).toMatchObject({ turn: "refuse" });
    expect(await t.deliver(reply("U2", "9.9"))).toEqual(NONE);
    t.asked.length = 0;
    expect(await t.deliver(dm("U404"))).toEqual(NONE);
    expect(t.asked).toEqual([]); // not a trigger: its sender isn't looked up
  });

  test("mention and follow_up: a reply is still held while its thread's mention is looked up (#163)", async () => {
    const t = setup({ startsOn: ["mention", "follow_up"] });
    await t.deliver(mention("U2")); // U2's verdict is cached
    const lookup = t.hold("U1");
    const asked = mention("U1");
    const first = t.deliver(asked);
    await lookup.pending;
    const second = t.deliver(reply("U2", asked.ts));
    lookup.release();
    expect(await first).toEqual(ANSWER);
    expect(await second).toEqual(ANSWER);
  });

  test("mention and direct_message: a DM is answered only with DMs on; a reply in a mentioned thread starts nothing", async () => {
    const on = setup({ startsOn: ["mention", "direct_message"], dms: true });
    const asked = mention("U1");
    expect(await on.deliver(asked)).toEqual(ANSWER);
    expect(await on.deliver(dm("U1"))).toEqual(ANSWER);
    expect(await on.deliver(dm("UG1"))).toMatchObject({ turn: "refuse" });
    expect(await on.deliver(reply("U2", asked.ts))).toEqual(NONE);
    const off = setup({ startsOn: ["mention", "direct_message"], dms: false });
    expect(await off.deliver(dm("U1"))).toEqual(NONE);
    expect(off.asked).toEqual([]);
  });

  test("direct_message only: a mention starts nothing, joins no thread and is not looked up, so a reply there is nothing; a DM is answered with DMs on", async () => {
    const t = setup({ startsOn: ["direct_message"], dms: true });
    const asked = mention("U1");
    expect(await t.deliver(asked)).toEqual(NONE);
    expect(t.joined(asked.ts)).toBe(false);
    expect(await t.deliver(mention("UG1"))).toEqual(NONE); // not even a refusal
    expect(await t.deliver(reply("U2", asked.ts))).toEqual(NONE);
    expect(t.asked).toEqual([]);
    expect(await t.deliver(dm("U1"))).toEqual(ANSWER);
    expect(t.asked).toEqual(["U1"]);
  });

  test("direct_message only: a mention joins nothing even in a thread joined before, where a reply stays nothing", async () => {
    const t = setup({ startsOn: ["direct_message"], dms: true });
    joinThread(t.db, "C1", "1.1"); // as a profile that listed follow-ups once left it
    expect(await t.deliver(mention("U1", "1.1"))).toEqual(NONE);
    expect(await t.deliver(reply("U2", "1.1"))).toEqual(NONE);
    let joins = 0;
    const counted = setup({ startsOn: ["direct_message"], dms: true, join: () => { joins++; } });
    await counted.deliver(mention("U1"));
    expect(joins).toBe(0);
  });

  test("direct_message only, with DMs off: nothing starts a turn, and nobody is looked up", async () => {
    const t = setup({ startsOn: ["direct_message"], dms: false });
    expect(await t.deliver(mention("U1"))).toEqual(NONE);
    expect(await t.deliver(dm("U1"))).toEqual(NONE);
    expect(t.asked).toEqual([]);
  });

  test("direct_message not listed: a DM starts nothing under DM_MODE=answer, whatever else is listed", async () => {
    for (const startsOn of [["mention"], ["mention", "follow_up"]] as SlackTriggerEvent[][]) {
      const t = setup({ startsOn, dms: true });
      expect(await t.deliver(dm("U1")), startsOn.join("+")).toEqual(NONE);
      expect(t.asked).toEqual([]);
    }
  });
});
