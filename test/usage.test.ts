// Usage: who asks the agent things, and what its searches find.

import { describe, expect, test } from "bun:test";
import { openKnowledge } from "../src/knowledge";
import { recordAsk, recordSearch, usageSummary } from "../src/usage";

const since = new Date("2026-09-01T00:00:00Z");
const inWindow = new Date("2026-09-10T00:00:00Z");
const before = new Date("2026-08-20T00:00:00Z");

describe("usageSummary", () => {
  test("counts distinct people, threads and channels; a redelivered ask once", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1", user: "U1" }, inWindow);
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1", user: "U1" }, inWindow); // redelivered
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1", user: "U1" }, inWindow); // a follow-up
    recordAsk(db, { channel: "C1", ts: "2.1", threadTs: "2.1", user: "U2" }, inWindow);
    const s = usageSummary(db, { since });
    expect(s).toMatchObject({ since: "2026-09-01T00:00:00.000Z", people: 2, threads: 2, channels: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM agent_asks").get()).toEqual({ n: 3 });
  });

  test("a thread is not found when every search in it hit nothing; one hit is enough to be found", () => {
    const db = openKnowledge(":memory:");
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi budget", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "2.1", query: "wombat budget", hits: 0 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "2.1", query: "wombat", hits: 3 }, inWindow);
    recordSearch(db, { channel: "C1", threadTs: "3.1", query: "okapi", hits: 0 }, inWindow);
    expect(usageSummary(db, { since }).notFound).toEqual({ threads: 2, of: 3, queries: ["okapi", "wombat budget", "okapi budget"] });
  });

  test("rows from before `since` are left out", () => {
    const db = openKnowledge(":memory:");
    recordAsk(db, { channel: "C2", ts: "1.1", threadTs: "1.1", user: "U3" }, before);
    recordSearch(db, { channel: "C2", threadTs: "1.1", query: "okapi", hits: 0 }, before);
    recordAsk(db, { channel: "C1", ts: "2.1", threadTs: "2.1", user: "U1" }, inWindow);
    const s = usageSummary(db, { since });
    expect(s).toMatchObject({ people: 1, threads: 1, channels: 1, notFound: { threads: 0, of: 0, queries: [] } });
  });
});
