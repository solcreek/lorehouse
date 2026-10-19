// Removed text leaves lorehouse.db-wal, not only the database file (#89). secure_delete
// (#65) zeroes what a delete frees in the page it rewrites, but in WAL mode the frames
// written before the delete still hold the old page until the WAL is checkpointed and
// truncated: whatever removes text asks for that, and closing the store does it too.

import { describe, expect, test } from "bun:test";
// A second connection in this process goes through the app's driver: two SQLite libraries
// in one process don't see each other's locks on the same file.
import { Database } from "../src/sqlite";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkpointRuns, checkpointSoon, closeKnowledge, deleteDocument, openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { MIGRATIONS } from "../src/migrations";
import { purgeUnlistedChannels } from "../src/purge";
import { eraseAskers, forgetAsk, pruneUsage, recordAsk, recordSearch } from "../src/usage";

const WORD = "zebrawalword9";
const secret = { docId: "slack:C2:9.9", kind: "slack_thread" as const, source: "https://x/p99", title: "t", text: `the launch password is ${WORD} do not share` };

// How many times `word` is in the file's bytes; a missing file holds none.
const copies = (file: string, word: string) => (existsSync(file) ? readFileSync(file).toString("latin1").split(word).length - 1 : 0);

function withDb(name: string, body: (path: string) => Promise<void> | void) {
  return async () => {
    const path = join(import.meta.dir, `.tmp-wal-${name}-${process.pid}.db`);
    try {
      await body(path);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  };
}

const fast = { delayMs: 20, retryMs: 50, log: () => {} };

describe("removed text leaves the WAL", () => {
  test("a deleted document: 0 copies in -wal (and the file) once the checkpoint ran", withDb("deleted", async (path) => {
    const db = openKnowledge(path, MIGRATIONS, fast);
    upsertDocument(db, secret);
    expect(copies(`${path}-wal`, WORD)).toBeGreaterThan(0); // what this removes
    expect(deleteDocument(db, secret.docId)).toBe(true);
    await Bun.sleep(150);
    expect(copies(`${path}-wal`, WORD)).toBe(0);
    expect(copies(path, WORD)).toBe(0);
    closeKnowledge(db);
  }));

  test("an edit's old text (a deleted reply re-renders its thread the same way)", withDb("edited", async (path) => {
    const db = openKnowledge(path, MIGRATIONS, fast);
    upsertDocument(db, secret);
    upsertDocument(db, { ...secret, text: "the launch password is (removed)" });
    await Bun.sleep(150);
    expect(searcher(db)("removed")[0]?.id).toBe(secret.docId);
    expect(copies(`${path}-wal`, WORD)).toBe(0);
    expect(copies(path, WORD)).toBe(0);
    closeKnowledge(db);
  }));

  test("a new document, or a refresh that changed nothing, asks for no checkpoint", withDb("insert", async (path) => {
    const db = openKnowledge(path, MIGRATIONS, fast);
    await Bun.sleep(50);
    const opened = checkpointRuns(db); // the one every open runs
    upsertDocument(db, secret);
    upsertDocument(db, secret);
    await Bun.sleep(100);
    expect(checkpointRuns(db)).toBe(opened);
    closeKnowledge(db);
  }));

  test("an open empties a WAL an earlier process left behind (a stop that couldn't checkpoint)", withDb("left", async (path) => {
    const first = openKnowledge(path, MIGRATIONS, { ...fast, delayMs: 60_000 });
    upsertDocument(first, secret);
    deleteDocument(first, secret.docId);
    // A second connection keeps SQLite from removing the WAL when the first one closes.
    const other = new Database(path);
    other.query("SELECT count(*) FROM knowledge_documents").get();
    first.close(); // no checkpoint: as if killed
    expect(copies(`${path}-wal`, WORD)).toBeGreaterThan(0);
    const db = openKnowledge(path, MIGRATIONS, fast);
    await Bun.sleep(100);
    expect(copies(`${path}-wal`, WORD)).toBe(0);
    expect(copies(path, WORD)).toBe(0);
    other.close();
    closeKnowledge(db);
  }));

  test("a store closed with a plain close() stops its pending checkpoint quietly", withDb("plain", async (path) => {
    const logs: string[] = [];
    const db = openKnowledge(path, MIGRATIONS, { ...fast, log: (m) => logs.push(m) });
    upsertDocument(db, secret);
    checkpointSoon(db);
    db.close();
    await Bun.sleep(150);
    const runs = checkpointRuns(db);
    await Bun.sleep(150);
    expect(checkpointRuns(db)).toBe(runs); // not retried forever
    expect(logs).toEqual([]);
  }));

  test("a purged channel's documents and searches (#85)", withDb("purge", async (path) => {
    const db = openKnowledge(path, MIGRATIONS, fast);
    upsertDocument(db, secret);
    recordSearch(db, { channel: "C2", threadTs: "9.9", query: "where is quokkawalword7", hits: 0 });
    purgeUnlistedChannels(db, new Set(["C1"]));
    await Bun.sleep(150);
    for (const word of [WORD, "quokkawalword7"]) {
      expect(copies(`${path}-wal`, word)).toBe(0);
      expect(copies(path, word)).toBe(0);
    }
    closeKnowledge(db);
  }));

  test("usage forgotten or erased: a deleted question's search, an asker, rows past retention", withDb("usage", async (path) => {
    const db = openKnowledge(path, MIGRATIONS, fast);
    recordAsk(db, { channel: "C1", ts: "5.5", threadTs: "5.5", user: "UWALPERSON1" });
    recordSearch(db, { channel: "C1", threadTs: "5.5", query: "where is quokkawalword8", hits: 0 });
    recordSearch(db, { channel: "C1", threadTs: "6.6", query: "old wombatwalword6", hits: 0 }, new Date(Date.now() - 200 * 86_400_000));
    forgetAsk(db, "C1", "5.5");
    await Bun.sleep(150);
    expect(copies(`${path}-wal`, "quokkawalword8")).toBe(0);
    recordAsk(db, { channel: "C1", ts: "7.7", threadTs: "7.7", user: "UWALPERSON2" });
    expect(eraseAskers(db)).toBe(1);
    expect(pruneUsage(db)).toBe(1);
    await Bun.sleep(150);
    for (const word of ["quokkawalword8", "UWALPERSON1", "UWALPERSON2", "wombatwalword6"]) {
      expect(copies(`${path}-wal`, word)).toBe(0);
      expect(copies(path, word)).toBe(0);
    }
    closeKnowledge(db);
  }));

  test("a burst of deletes shares one checkpoint", withDb("burst", async (path) => {
    const db = openKnowledge(path, MIGRATIONS, { ...fast, delayMs: 100 });
    await Bun.sleep(50);
    const opened = checkpointRuns(db);
    for (let i = 0; i < 20; i++) upsertDocument(db, { ...secret, docId: `slack:C2:${i}.1` });
    for (let i = 0; i < 20; i++) deleteDocument(db, `slack:C2:${i}.1`);
    await Bun.sleep(300);
    expect(checkpointRuns(db)).toBe(opened + 1);
    expect(copies(`${path}-wal`, WORD)).toBe(0);
    closeKnowledge(db);
  }));

  test("a busy checkpoint is logged, never thrown, and tried again until it completes", withDb("busy", async (path) => {
    const logs: string[] = [];
    const db = openKnowledge(path, MIGRATIONS, { ...fast, log: (m) => logs.push(m) });
    upsertDocument(db, secret);
    await Bun.sleep(50);
    const opened = checkpointRuns(db);
    // Another connection holds a read: the checkpoint can't reset the WAL under it.
    const reader = new Database(path);
    reader.exec("BEGIN");
    reader.query("SELECT count(*) FROM knowledge_documents").get();
    expect(deleteDocument(db, secret.docId)).toBe(true);
    await Bun.sleep(200);
    expect(logs.some((m) => m.includes("in use"))).toBe(true);
    expect(checkpointRuns(db)).toBeGreaterThan(opened + 1); // retried
    reader.exec("COMMIT");
    reader.close();
    await Bun.sleep(200);
    expect(copies(`${path}-wal`, WORD)).toBe(0);
    closeKnowledge(db);
  }));

  test("closing the store checkpoints first: a delete just before leaves 0 copies, with nothing pending", withDb("close", (path) => {
    const db = openKnowledge(path, MIGRATIONS, { ...fast, delayMs: 60_000 });
    upsertDocument(db, secret);
    deleteDocument(db, secret.docId);
    expect(copies(`${path}-wal`, WORD)).toBeGreaterThan(0); // the checkpoint it asked for hasn't run
    expect(closeKnowledge(db)).toBe(true);
    expect(copies(`${path}-wal`, WORD)).toBe(0);
    expect(copies(path, WORD)).toBe(0);
  }));
});
