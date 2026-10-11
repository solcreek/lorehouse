// A channel taken off AGENT_CHANNELS leaves the knowledge index on the next start (#82):
// its threads, the threads the agent joined there, its ingest cursor and the usage rows
// that would otherwise point at them. Seeds and listed channels are left alone.

import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { countDocuments, getCursor, openKnowledge, searcher, setCursor, upsertDocument } from "../src/knowledge";
import { pendingPurge, purgeUnlistedChannels } from "../src/purge";
import { inThread, joinThread } from "../src/threads";
import { recordAsk, recordFeedback, recordSearch } from "../src/usage";

type Db = ReturnType<typeof openKnowledge>;

// Two channels' worth of everything Lorehouse keeps per channel, plus seeds.
function fill(db: Db) {
  upsertDocument(db, { docId: "c1", kind: "seed", source: "docs/a.md", title: "seed", text: "a seeded page about wombats" });
  // A seed whose id happens to look like a Slack one is still a seed: only Slack threads go.
  upsertDocument(db, { docId: "slack:C2:legacy", kind: "seed", source: "docs/b.md", title: "seed", text: "a seeded page about ibises" });
  for (const [channel, word] of [["C1", "heron"], ["C2", "quokka"], ["C3", "pelican"]] as const) {
    for (const ts of ["1.1", "2.2"]) {
      upsertDocument(db, { docId: `slack:${channel}:${ts}`, kind: "slack_thread", source: `https://x/${channel}/${ts}`, title: word, text: `the ${word} budget ${ts}`, sourceVersion: ts });
    }
    setCursor(db, `slack:${channel}`, "2.2");
    joinThread(db, channel, "1.1");
    recordAsk(db, { channel, ts: "1.1", threadTs: "1.1" });
    recordAsk(db, { channel, ts: "1.5", threadTs: "1.1" });
    recordSearch(db, { channel, threadTs: "1.1", query: `${word} budget`, hits: 2 });
    recordFeedback(db, { channel, messageTs: "1.6", rater: "r1", rating: "down" }, true);
  }
}

const count = (db: Db, sql: string, ...args: string[]) => (db.query(sql).get(...args) as { n: number }).n;

describe("purging channels no longer listed", () => {
  test("only an unlisted channel's documents, joined threads, cursor, asks and searches go", () => {
    const db = openKnowledge(":memory:");
    fill(db);
    const purged = purgeUnlistedChannels(db, new Set(["C1"]));
    expect(purged).toEqual([
      { channel: "C2", documents: 2, threads: 1, cursors: 1, asks: 2, searches: 1 },
      { channel: "C3", documents: 2, threads: 1, cursors: 1, asks: 2, searches: 1 },
    ]);
    // C1, still listed, keeps everything.
    expect(countDocuments(db, "slack:C1:")).toBe(2);
    expect(inThread(db, "C1", "1.1")).toBe(true);
    expect(getCursor(db, "slack:C1")).toBe("2.2");
    expect(count(db, "SELECT count(*) AS n FROM agent_asks WHERE channel = 'C1'")).toBe(2);
    expect(count(db, "SELECT count(*) AS n FROM agent_searches WHERE channel = 'C1'")).toBe(1);
    // C2 and C3 keep nothing that points at their threads.
    for (const c of ["C2", "C3"]) {
      expect(countDocuments(db, `slack:${c}:`)).toBe(c === "C2" ? 1 : 0); // C2's one: the seed
      expect(inThread(db, c, "1.1")).toBe(false);
      expect(getCursor(db, `slack:${c}`)).toBeUndefined();
      expect(count(db, "SELECT count(*) AS n FROM agent_asks WHERE channel = ?", c)).toBe(0);
      expect(count(db, "SELECT count(*) AS n FROM agent_searches WHERE channel = ?", c)).toBe(0);
    }
    // Seeds stay; a reply's 👍/👎 holds no text and no thread, and stays until retention.
    expect(count(db, "SELECT count(*) AS n FROM knowledge_documents WHERE kind = 'seed'")).toBe(2);
    expect(count(db, "SELECT count(*) AS n FROM agent_feedback")).toBe(3);
    // And search follows: the purged channels' words find nothing, the listed one's still do.
    const search = searcher(db, 50);
    expect(search("quokka pelican")).toEqual([]);
    expect(search("heron").map((c) => c.id).sort()).toEqual(["slack:C1:1.1", "slack:C1:2.2"]);
    expect(search("ibises")[0]?.id).toBe("slack:C2:legacy");
    // A second start has nothing left to purge.
    expect(purgeUnlistedChannels(db, new Set(["C1"]))).toEqual([]);
  });

  test("an empty list purges everything learned from Slack, and only that", () => {
    const db = openKnowledge(":memory:");
    fill(db);
    const purged = purgeUnlistedChannels(db, new Set());
    expect(purged.map((p) => p.channel)).toEqual(["C1", "C2", "C3"]);
    expect(count(db, "SELECT count(*) AS n FROM knowledge_documents WHERE kind = 'slack_thread'")).toBe(0);
    expect(count(db, "SELECT count(*) AS n FROM knowledge_documents WHERE kind = 'seed'")).toBe(2);
    for (const table of ["agent_threads", "ingest_cursors", "agent_asks", "agent_searches"]) {
      expect(count(db, `SELECT count(*) AS n FROM ${table}`)).toBe(0);
    }
  });

  test("a malformed Slack id names no channel, and is left alone", () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "slack:noColon", kind: "slack_thread", source: "s", title: "t", text: "words" });
    expect(purgeUnlistedChannels(db, new Set(["C1"]))).toEqual([]);
  });

  test("a channel known only from its joined threads or usage rows is purged too", () => {
    const db = openKnowledge(":memory:");
    joinThread(db, "C5", "1.1"); // asked in, never indexed (a thread holding only the question)
    recordAsk(db, { channel: "C5", ts: "1.1", threadTs: "1.1" });
    expect(purgeUnlistedChannels(db, new Set(["C1"]))).toEqual([{ channel: "C5", documents: 0, threads: 1, cursors: 0, asks: 1, searches: 0 }]);
    expect(inThread(db, "C5", "1.1")).toBe(false);
  });

  test("the doctor's preview counts the same, and changes nothing", () => {
    const db = openKnowledge(":memory:");
    fill(db);
    const preview = pendingPurge(db, new Set(["C1"]));
    expect(countDocuments(db, "slack:C2:")).toBe(3);
    expect(inThread(db, "C2", "1.1")).toBe(true);
    expect(preview).toEqual(purgeUnlistedChannels(db, new Set(["C1"])));
  });

  // As for a deleted message (#65): the purged words leave the file, not only the results.
  test("the purged text leaves the database file", () => {
    const path = join(import.meta.dir, `.tmp-purge-${process.pid}.db`);
    try {
      const db = openKnowledge(path);
      for (let i = 0; i < 50; i++) upsertDocument(db, { docId: `d${i}`, kind: "seed", source: "s", title: "t", text: `filler words here ${i} `.repeat(50) });
      upsertDocument(db, { docId: "slack:C2:9.9", kind: "slack_thread", source: "https://x/p99", title: "t", text: "the launch password is zebrasecretword9 do not share" });
      recordSearch(db, { channel: "C2", threadTs: "9.9", query: "where is quokkasearchword7", hits: 0 });
      purgeUnlistedChannels(db, new Set(["C1"]));
      expect(searcher(db)("filler")).toHaveLength(5); // the index still works
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      const bytes = readFileSync(path).toString("latin1");
      expect(bytes.includes("zebrasecretword9")).toBe(false);
      expect(bytes.includes("quokkasearchword7")).toBe(false);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });
});
