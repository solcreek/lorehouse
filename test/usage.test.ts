// Usage: who asks the agent things, what its searches find, and the 👍/👎 on its replies.

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { channelsToNotify, eraseAskers, feedbackOf, forgetAsk, markNotified, pruneUsage, raterKey, rating, recordAsk, recordFeedback, recordSearch, USAGE_RETENTION_DAYS, usageSummary } from "../src/usage";

const since = new Date("2026-09-01T00:00:00Z");
const inWindow = new Date("2026-09-10T00:00:00Z");
const before = new Date("2026-08-20T00:00:00Z");

describe("rating", () => {
  test("👍 is up and 👎 is down, by either name and in any skin tone; other emoji are neither", () => {
    expect(["+1", "thumbsup", "+1::skin-tone-4"].map(rating)).toEqual(["up", "up", "up"]);
    expect(["-1", "thumbsdown", "thumbsdown::skin-tone-2"].map(rating)).toEqual(["down", "down", "down"]);
    expect(["tada", "eyes", "+1-plus", "skin-tone-2"].map(rating)).toEqual([undefined, undefined, undefined, undefined]);
  });
});

describe("feedbackOf", () => {
  const reaction = (name: string, o: { by?: string; itemUser?: string } = {}) =>
    ({ channelId: "C1", user: { id: o.by ?? "U2" }, reaction: { name, itemTs: "1.2" }, raw: { type: "reaction_added", item_user: o.itemUser ?? "UBOT" } });

  test("a person's 👍/👎 on the agent's reply is feedback on that reply", () => {
    expect(feedbackOf(reaction("-1"), "UBOT")).toEqual({ channel: "C1", messageTs: "1.2", user: "U2", rating: "down" });
  });

  test("not feedback: a person's message, the agent's own reaction, another emoji, or an unknown bot id", () => {
    expect(feedbackOf(reaction("-1", { itemUser: "U1" }), "UBOT")).toBeUndefined();
    expect(feedbackOf(reaction("+1", { by: "UBOT" }), "UBOT")).toBeUndefined();
    expect(feedbackOf(reaction("tada"), "UBOT")).toBeUndefined();
    expect(feedbackOf(reaction("+1"), undefined)).toBeUndefined();
  });
});

describe("usageSummary", () => {
  test("counts asks, threads and channels; a redelivered ask once", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, inWindow);
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, inWindow); // redelivered
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1" }, inWindow); // a follow-up
    recordAsk(db, { channel: "C1", ts: "2.1", threadTs: "2.1" }, inWindow);
    const s = usageSummary(db, { since });
    expect(s).toMatchObject({ since: "2026-09-01T00:00:00.000Z", asks: 3, threads: 2, channels: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM agent_asks").get()).toEqual({ n: 3 });
  });

  test("a thread's searches were all empty when every one hit nothing; one hit is enough", () => {
    const db = openKnowledge(":memory:");
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi budget", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "2.1", query: "wombat budget", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "2.1", query: "wombat", hits: 3 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "3.1", query: "okapi", hits: 0 }, inWindow);
    expect(usageSummary(db, { since }).emptySearches).toEqual({ threads: 2, of: 3, queries: ["okapi", "wombat budget", "okapi budget"] });
  });

  test("feedback counts ratings and distinct raters; a removed reaction takes its rating back", () => {
    const db = openKnowledge(":memory:");
    recordFeedback(db, { channel: "C1", messageTs: "1.2", rater: "U1", rating: "up" }, true, inWindow);
    recordFeedback(db, { channel: "C1", messageTs: "1.2", rater: "U2", rating: "up" }, true, inWindow);
    recordFeedback(db, { channel: "C1", messageTs: "2.2", rater: "U2", rating: "down" }, true, inWindow);
    expect(usageSummary(db, { since }).feedback).toEqual({ up: 2, down: 1, raters: 2, downMessages: [{ channel: "C1", ts: "2.2" }] });
    recordFeedback(db, { channel: "C1", messageTs: "2.2", rater: "U2", rating: "down" }, false);
    expect(usageSummary(db, { since }).feedback).toEqual({ up: 2, down: 0, raters: 2, downMessages: [] });
  });

  test("rows from before `since` are left out", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C2", ts: "1.1", threadTs: "1.1" }, before);
    recordSearch(db, { channel: "C2", threadTs: "1.1", query: "okapi", hits: 0 }, before);
    recordFeedback(db, { channel: "C2", messageTs: "1.2", rater: "U3", rating: "down" }, true, before);
    recordAsk(db, { channel: "C1", ts: "2.1", threadTs: "2.1" }, inWindow);
    const s = usageSummary(db, { since });
    expect(s).toMatchObject({ asks: 1, threads: 1, channels: 1, emptySearches: { threads: 0, of: 0, queries: [] }, feedback: { up: 0, down: 0, raters: 0, downMessages: [] } });
  });
});

describe("forgetting", () => {
  const count = (db: ReturnType<typeof openKnowledge>, table: string) => (db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

  test("a deleted follow-up takes only its ask; the thread's searches stay", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, inWindow);
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1" }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi", hits: 0 }, inWindow);
    forgetAsk(db, "C1", "1.2");
    expect(count(db, "agent_asks")).toBe(1);
    expect(count(db, "agent_searches")).toBe(1);
  });

  test("a deleted thread root takes its ask and the searches run for it", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi budget", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C2", threadTs: "1.1", query: "another channel", hits: 0 }, inWindow);
    forgetAsk(db, "C1", "1.1");
    expect(count(db, "agent_asks")).toBe(0);
    expect(db.query("SELECT channel, query FROM agent_searches").all()).toEqual([{ channel: "C2", query: "another channel" }]);
  });

  test(`rows older than ${USAGE_RETENTION_DAYS} days are pruned, in every table; newer ones stay`, () => {
    const db = openKnowledge(":memory:");
    const now = new Date("2026-12-01T00:00:00Z");
    const old = new Date(now.getTime() - (USAGE_RETENTION_DAYS + 1) * 86_400_000);
    const recent = new Date(now.getTime() - (USAGE_RETENTION_DAYS - 1) * 86_400_000);
    for (const [at, ts] of [[old, "1.1"], [recent, "2.1"]] as const) {
      recordAsk(db, { channel: "C1", ts, threadTs: ts }, at);
      recordSearch(db, { channel: "C1", threadTs: ts, query: "okapi", hits: 0 }, at);
      recordFeedback(db, { channel: "C1", messageTs: ts, rater: "U1", rating: "up" }, true, at);
    }
    expect(pruneUsage(db, now)).toBe(3);
    for (const t of ["agent_asks", "agent_searches", "agent_feedback"]) expect(count(db, t)).toBe(1);
    expect(pruneUsage(db, now)).toBe(0);
  });
});

describe("never who", () => {
  test("by default an ask keeps no asker, and searches and feedback have nowhere to keep one", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, inWindow);
    expect(db.query("SELECT user_id FROM agent_asks").all()).toEqual([{ user_id: null }]);
    for (const t of ["agent_searches", "agent_feedback"]) {
      const columns = (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
      expect(columns.filter((c) => /user/.test(c))).toEqual([]);
    }
    const s = usageSummary(db, { since });
    expect("people" in s || "askers" in s).toBe(false);
  });

  test("a rater is a keyed hash: the same person under one secret, unrelated under another, never the id", () => {
    const a = raterKey("secret-a");
    const b = raterKey("secret-b");
    expect(a("U123")).toBe(a("U123"));
    expect(a("U123")).not.toBe(a("U456"));
    expect(a("U123")).not.toBe(b("U123"));
    expect(a("U123")).toMatch(/^[0-9a-f]{32}$/);
    expect(a("U123")).not.toContain("U123");
  });

  test("one person's 👍 counts once however often it arrives, and taking it back finds it by the same hash", () => {
    const db = openKnowledge(":memory:");
    const rater = raterKey("s")("U2");
    recordFeedback(db, { channel: "C1", messageTs: "1.2", rater, rating: "up" }, true, inWindow);
    recordFeedback(db, { channel: "C1", messageTs: "1.2", rater, rating: "up" }, true, inWindow);
    expect(usageSummary(db, { since }).feedback).toMatchObject({ up: 1, raters: 1 });
    recordFeedback(db, { channel: "C1", messageTs: "1.2", rater: raterKey("s")("U2"), rating: "up" }, false);
    expect(usageSummary(db, { since }).feedback).toMatchObject({ up: 0, raters: 0 });
  });
});

describe("opted in to recording askers", () => {
  test("people and askers, most asks first; asks from before opting in have no asker and aren't among them", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.0", threadTs: "1.0" }, inWindow); // before opting in
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1", user: "U1" }, inWindow);
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1", user: "U2" }, inWindow);
    recordAsk(db, { channel: "C2", ts: "2.1", threadTs: "2.1", user: "U2" }, inWindow);
    recordAsk(db, { channel: "C2", ts: "0.1", threadTs: "0.1", user: "U3" }, before); // outside the window
    const s = usageSummary(db, { since, people: true });
    expect(s).toMatchObject({ asks: 4, people: 2, askers: [{ user: "U2", asks: 2 }, { user: "U1", asks: 1 }] });
  });

  test("opting out erases every asker kept, and leaves the asks", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1", user: "U1" }, inWindow);
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1", user: "U2" }, inWindow);
    expect(eraseAskers(db)).toBe(2);
    expect(db.query("SELECT user_id FROM agent_asks").all()).toEqual([{ user_id: null }, { user_id: null }]);
    expect(usageSummary(db, { since, people: true })).toMatchObject({ asks: 2, people: 0, askers: [] });
    expect(eraseAskers(db)).toBe(0);
  });

  test("each channel is told once that askers are recorded, and once when they no longer are", () => {
    const db = openKnowledge(":memory:");
    expect(channelsToNotify(db, ["C1", "C2"], false)).toEqual([]); // never on: nothing to take back
    expect(channelsToNotify(db, ["C1", "C2"], true)).toEqual(["C1", "C2"]);
    markNotified(db, "C1", true);
    expect(channelsToNotify(db, ["C1", "C2"], true)).toEqual(["C2"]);
    markNotified(db, "C2", true);
    expect(channelsToNotify(db, ["C1", "C2"], true)).toEqual([]);
    // turned off: the channels told before hear it stopped, even one no longer allowlisted
    expect(channelsToNotify(db, ["C1"], false).sort()).toEqual(["C1", "C2"]);
    markNotified(db, "C1", false);
    markNotified(db, "C2", false);
    expect(channelsToNotify(db, ["C1"], false)).toEqual([]);
  });
});
