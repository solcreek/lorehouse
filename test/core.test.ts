import { describe, expect, test } from "bun:test";
// A second connection in this process goes through the app's driver: two SQLite libraries
// in one process don't see each other's locks on the same file.
import { Database } from "../src/sqlite";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDistinctDatabases, ConfigError, loadConfig } from "../src/config";
import { loadEnv } from "../src/settings";
import { checkpointRuns, closeKnowledge, countDocuments, deleteDocument, getCursor, getDocument, indexText, INDEX_VERSION, matchExpression, openKnowledge, searcher, SeedError, type SeedSync, setCursor, syncSeed, upsertDocument } from "../src/knowledge";
import { MIGRATIONS } from "../src/migrations";
import { render, systemPrompt, toolDescription } from "../src/prompts";
import { agentIdentity } from "../src/identity";

const CORPUS = join(import.meta.dir, "..", "conformance", "fixtures", "corpus.jsonl");

describe("knowledge store", () => {
  test("migrations apply once and are recorded; reopening is a no-op", () => {
    const path = join(import.meta.dir, `.tmp-${process.pid}.db`);
    try {
      const a = openKnowledge(path);
      a.close();
      const b = openKnowledge(path);
      const rows = b.query("SELECT version, name FROM lorehouse_migrations ORDER BY version").all();
      expect(rows).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
      expect(rows.length).toBeGreaterThanOrEqual(3);
      b.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  // KNOWLEDGE_SEED is read on every start and the index follows it (#166). Each test is a
  // series of starts against one database file: open, read the seed, close.
  describe("the seed file", () => {
    type Entry = { id: string; source: string; title: string; text: string };
    type Store = ReturnType<typeof openKnowledge>;
    const wombat: Entry = { id: "kb-1", source: "help/wombats.md", title: "Wombats", text: "the wombat review is quarterly" };
    const ibis: Entry = { id: "kb-2", source: "help/ibises.md", title: "Ibises", text: "the ibis census is in march" };
    const emu: Entry = { id: "kb-3", source: "help/emus.md", title: "Emus", text: "the emu fence is inspected weekly" };
    const thread = { docId: "slack:C1:1.1", kind: "slack_thread" as const, source: "https://x/p11", title: "t", text: "the quokka paddock moved north", sourceVersion: "1.1" };
    const OLD = "2020-01-01T00:00:00.000Z";

    type Install = {
      db: string;
      seed: string;
      write: (...lines: (Entry | string)[]) => void; // the seed file, one entry (or raw line) per line
      start: (...lines: (Entry | string)[]) => SeedSync; // one start: the file written if lines are given, then read
      inDb: <T>(fn: (db: Store) => T) => T; // the database opened, used and closed
    };
    const withInstall = (run: (i: Install) => void | Promise<void>) => async () => {
      const dir = mkdtempSync(join(tmpdir(), "lorehouse-seed-"));
      const db = join(dir, "lorehouse.db");
      const seed = join(dir, "seed.jsonl");
      const write = (...lines: (Entry | string)[]) => writeFileSync(seed, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
      const inDb = <T>(fn: (db: Store) => T): T => {
        const k = openKnowledge(db);
        try {
          return fn(k);
        } finally {
          closeKnowledge(k);
        }
      };
      const start = (...lines: (Entry | string)[]) => {
        if (lines.length) write(...lines);
        return inDb((k) => syncSeed(k, seed));
      };
      try {
        await run({ db, seed, write, start, inDb });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    // Every document as stored, in id order: what "the index is as it was" compares.
    const stored = (k: Store) => k.query("SELECT doc_id, kind, source, title, text, updated_at FROM knowledge_documents ORDER BY doc_id").all();
    // Backdate every document, so one written again shows.
    const backdate = (k: Store) => void k.query("UPDATE knowledge_documents SET updated_at = ?").run(OLD);
    const refused = (fn: () => unknown): string => {
      try {
        fn();
      } catch (err) {
        expect(err).toBeInstanceOf(SeedError);
        return (err as Error).message;
      }
      throw new Error("the seed was read; expected a SeedError");
    };

    test("the first start adds every entry; a start with the file unchanged touches nothing", withInstall(({ start, inDb }) => {
      expect(start(wombat, "", ibis, emu)).toEqual({ entries: 3, added: 3, updated: 0, removed: 0 }); // a blank line is skipped
      inDb(backdate);
      expect(start()).toEqual({ entries: 3, added: 0, updated: 0, removed: 0 });
      inDb((k) => {
        expect(countDocuments(k)).toBe(3);
        for (const e of [wombat, ibis, emu]) expect(getDocument(k, e.id)).toMatchObject({ kind: "seed", title: e.title, updatedAt: OLD });
      });
    }));

    test("the whole fixture corpus is read, and read again without a change", withInstall(({ inDb }) => {
      const first = inDb((k) => syncSeed(k, CORPUS));
      expect(first.added).toBeGreaterThan(200);
      expect(first).toEqual({ entries: first.added, added: first.added, updated: 0, removed: 0 });
      expect(inDb((k) => syncSeed(k, CORPUS))).toEqual({ ...first, added: 0 });
      expect(inDb((k) => countDocuments(k))).toBe(first.added);
    }));

    test("an entry whose title, source or text changed is re-indexed; the others keep their updatedAt", withInstall(({ start, inDb }) => {
      const dingo: Entry = { id: "kb-4", source: "help/dingoes.md", title: "Dingoes", text: "the dingo roster is monthly" };
      start(wombat, ibis, emu, dingo);
      inDb(backdate);
      const edited = [{ ...wombat, text: "the wombat review is yearly" }, { ...ibis, title: "Spoonbills" }, { ...emu, source: "help/birds/emus.md" }];
      expect(start(...edited, dingo)).toEqual({ entries: 4, added: 0, updated: 3, removed: 0 });
      inDb((k) => {
        const search = searcher(k);
        expect(search("yearly")[0]?.id).toBe("kb-1");
        expect(search("quarterly")).toEqual([]); // the old text left the index
        expect(search("spoonbills")[0]?.id).toBe("kb-2");
        expect(search("ibises")).toEqual([]);
        expect(getDocument(k, "kb-3")).toMatchObject({ source: "help/birds/emus.md", text: emu.text });
        for (const e of edited) expect(getDocument(k, e.id)!.updatedAt > OLD).toBe(true);
        expect(getDocument(k, "kb-4")!.updatedAt).toBe(OLD);
      });
    }));

    test("an entry gone from the file leaves the index and the database's files; added back, it is found again", withInstall(async ({ db, seed, write, start, inDb }) => {
      start(wombat, ibis, emu);
      expect(start(wombat, emu)).toEqual({ entries: 2, added: 0, updated: 0, removed: 1 });
      inDb((k) => {
        expect(getDocument(k, "kb-2")).toBeUndefined();
        expect(searcher(k)("census")).toEqual([]);
        expect(countDocuments(k)).toBe(2);
      });
      expect(start(wombat, ibis, emu)).toEqual({ entries: 3, added: 1, updated: 0, removed: 0 });
      inDb((k) => expect(searcher(k)("census")[0]?.id).toBe("kb-2"));

      // A removal asks for a checkpoint (checkpointSoon), so the text leaves the WAL while
      // the app runs, not only when it stops.
      const k = openKnowledge(db, MIGRATIONS, { delayMs: 20, retryMs: 20, log: () => {} });
      try {
        await Bun.sleep(60);
        const opened = checkpointRuns(k); // the one every open runs
        write(wombat, emu);
        expect(syncSeed(k, seed).removed).toBe(1);
        expect(readFileSync(`${db}-wal`).length).toBeGreaterThan(0); // the removal is in the WAL
        await Bun.sleep(150);
        expect(checkpointRuns(k)).toBe(opened + 1);
        expect(readFileSync(`${db}-wal`).length).toBe(0);
        expect(readFileSync(db).includes("census")).toBe(false);
      } finally {
        closeKnowledge(k);
      }
    }));

    test("an empty file removes every seed; Slack's documents are never touched", withInstall(({ start, inDb }) => {
      start(wombat, ibis);
      inDb((k) => {
        upsertDocument(k, thread);
        backdate(k);
      });
      expect(start("")).toEqual({ entries: 0, added: 0, updated: 0, removed: 2 });
      inDb((k) => {
        expect(k.query("SELECT doc_id, kind, updated_at FROM knowledge_documents").all()).toEqual([{ doc_id: thread.docId, kind: "slack_thread", updated_at: OLD }]);
        expect(searcher(k)("quokka")[0]?.id).toBe(thread.docId);
      });
    }));

    test("a seed set on an install that already has threads is read", withInstall(({ start, inDb }) => {
      inDb((k) => upsertDocument(k, thread));
      expect(start(wombat, ibis)).toEqual({ entries: 2, added: 2, updated: 0, removed: 0 });
      inDb((k) => {
        expect(searcher(k)("census")[0]?.id).toBe("kb-2");
        expect(getDocument(k, thread.docId)).toMatchObject({ kind: "slack_thread", text: thread.text });
      });
    }));

    test("an entry with the id of a Slack thread's document is refused, naming its line; the thread is left alone", withInstall(({ seed, write, start, inDb }) => {
      start(wombat);
      const before = inDb((k) => {
        upsertDocument(k, thread);
        return stored(k);
      });
      write(wombat, ibis, { ...emu, id: thread.docId });
      const message = inDb((k) => refused(() => syncSeed(k, seed)));
      expect(message).toContain(`line 3: id "${thread.docId}" is already the id of a slack_thread document`);
      expect(inDb(stored)).toEqual(before); // kb-2 wasn't added either
    }));

    test("a malformed line fails the read with its line number, and the index is as it was", withInstall(({ seed, write, start, inDb }) => {
      start(wombat, ibis);
      const before = inDb(stored);
      // Line 1 changes an entry, line 2 adds one, kb-2 is gone: none of it may happen.
      write({ ...wombat, text: "the wombat review is yearly" }, emu, "", '{"id":"kb-9","source":"s","title":"t","text":"cut off he');
      const message = inDb((k) => refused(() => syncSeed(k, seed)));
      expect(message).toContain(seed);
      expect(message).toContain("line 4: not JSON");
      expect(message).toContain("the index is as it was");
      expect(message).not.toContain("line 1:");
      expect(inDb(stored)).toEqual(before);
    }));

    test("every wrong line is named with what is wrong with it", withInstall(({ seed, write, inDb }) => {
      write(wombat, '["kb-5"]', '{"id":"kb-6","source":"s","title":"t"}', '{"id":7,"source":"s","title":"t","text":"x"}', '{"id":" ","source":"s","title":"t","text":"x"}', { ...ibis, id: "kb-1" });
      const message = inDb((k) => refused(() => syncSeed(k, seed)));
      expect(message).toContain("5 lines are wrong");
      expect(message).toContain("line 2: a JSON array, not an object");
      expect(message).toContain('line 3: "text" is missing');
      expect(message).toContain('line 4: "id" is a number, not a string');
      expect(message).toContain('line 5: "id" is empty');
      expect(message).toContain('line 6: id "kb-1" is already used on line 1');
      expect(message).toContain('{"id": "…", "source": "…", "title": "…", "text": "…"}'); // what a line should be
      expect(inDb((k) => countDocuments(k))).toBe(0);
    }));

    test("a file with many wrong lines names the first ten and counts the rest", withInstall(({ seed, write, inDb }) => {
      write(...Array.from({ length: 14 }, () => "nope"));
      const message = inDb((k) => refused(() => syncSeed(k, seed)));
      expect(message).toContain("14 lines are wrong");
      expect(message).toContain("line 10: not JSON");
      expect(message).not.toContain("line 11:");
      expect(message).toContain("and 4 more");
    }));

    test("a file that can't be read fails the read, naming the path; the seeds already indexed stay", withInstall(({ seed, start, inDb }) => {
      start(wombat, ibis);
      const before = inDb(stored);
      rmSync(seed);
      const message = inDb((k) => refused(() => syncSeed(k, seed)));
      expect(message).toContain(`KNOWLEDGE_SEED ${seed} can't be read`);
      expect(message).toContain("ENOENT");
      expect(inDb(stored)).toEqual(before);
    }));

    test("a file saved with a byte order mark or CRLF line ends reads the same", withInstall(({ seed, inDb }) => {
      writeFileSync(seed, String.fromCharCode(0xfeff) +[wombat, ibis].map((e) => JSON.stringify(e)).join("\r\n") + "\r\n");
      expect(inDb((k) => syncSeed(k, seed))).toEqual({ entries: 2, added: 2, updated: 0, removed: 0 });
    }));
  });

  test("upgrading a 0001 database carries its chunks over as seeds, ids intact, still searchable", () => {
    const path = join(import.meta.dir, `.tmp-upgrade-${process.pid}.db`);
    try {
      const old = openKnowledge(path, MIGRATIONS.filter((m) => m.version === 1));
      old.query("INSERT INTO knowledge_chunks (id, source, title, text) VALUES ('c7', 'docs/x.md', 'Wombats', 'wombats dig burrows')").run();
      old.close();
      const db = openKnowledge(path); // the real upgrade path: remaining migrations + index rebuild
      expect(db.query("SELECT doc_id, kind, source FROM knowledge_documents").all()).toEqual([{ doc_id: "c7", kind: "seed", source: "docs/x.md" }]);
      expect(searcher(db)("where do wombats dig")[0]?.id).toBe("c7");
      expect(db.query("SELECT name FROM sqlite_master WHERE name = 'knowledge_chunks'").get()).toBeNull();
      db.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("upsert replaces a document in place and the index follows", () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "https://x/p11", title: "t", text: "the wombat review is on monday" });
    upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "https://x/p11", title: "t", text: "the wombat review moved to thursday" });
    expect(countDocuments(db)).toBe(1);
    expect(searcher(db)("thursday")[0]?.id).toBe("slack:C1:1.1");
    expect(searcher(db)("monday")).toEqual([]); // the old text left the index
  });

  // A message deleted or edited in Slack (a pasted secret) must leave the database file too,
  // not only the search results: FTS5 otherwise keeps its words in the index's segments
  // until a merge, and SQLite keeps freed pages' bytes, on disk and in every backup.
  describe("removed text leaves the database file", () => {
    const filler = (db: ReturnType<typeof openKnowledge>) => {
      for (let i = 0; i < 50; i++) upsertDocument(db, { docId: `d${i}`, kind: "seed", source: "s", title: "t", text: `filler words here ${i} `.repeat(50) });
    };
    const secret = { docId: "slack:C1:9.9", kind: "slack_thread" as const, source: "https://x/p99", title: "t", text: "the launch password is zebrasecretword9 do not share" };
    // The file's bytes once everything is written back (WAL checkpointed into it).
    const fileHolds = (db: ReturnType<typeof openKnowledge>, path: string, word: string) => {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.close();
      return readFileSync(path).toString("latin1").includes(word);
    };
    const withFile = (name: string, body: (path: string) => void) => {
      const path = join(import.meta.dir, `.tmp-${name}-${process.pid}.db`);
      try {
        body(path);
      } finally {
        for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
      }
    };

    test("a deleted document", () => withFile("deleted", (path) => {
      const db = openKnowledge(path);
      filler(db);
      upsertDocument(db, secret);
      expect(deleteDocument(db, secret.docId)).toBe(true);
      expect(fileHolds(db, path, "zebrasecretword9")).toBe(false);
    }));

    test("an edit's old text", () => withFile("edited", (path) => {
      const db = openKnowledge(path);
      filler(db);
      upsertDocument(db, secret);
      upsertDocument(db, { ...secret, text: "the launch password is (removed)" });
      expect(searcher(db)("removed")[0]?.id).toBe(secret.docId);
      expect(fileHolds(db, path, "zebrasecretword9")).toBe(false);
    }));

    test("a document deleted before this was enforced, once the database is opened", () => withFile("upgraded", (path) => {
      const old = openKnowledge(path, MIGRATIONS.filter((m) => m.version <= 9));
      old.exec("PRAGMA secure_delete = OFF"); // as a build before this one deleted: freed bytes stay
      filler(old);
      upsertDocument(old, secret);
      deleteDocument(old, secret.docId);
      expect(fileHolds(old, path, "zebrasecretword9")).toBe(true); // the residue this cleans up
      const db = openKnowledge(path);
      // Already out of the file while the app holds it open, not only after a later checkpoint.
      expect(readFileSync(path).toString("latin1").includes("zebrasecretword9")).toBe(false);
      expect(searcher(db)("filler")).toHaveLength(5); // the index still works after the clean-up
      expect(fileHolds(db, path, "zebrasecretword9")).toBe(false);
    }));

    test("the one-time compaction never holds back the migrations, and is retried until it succeeds", () => withFile("busy", (path) => {
      const old = openKnowledge(path, MIGRATIONS.filter((m) => m.version <= 9));
      old.exec("PRAGMA secure_delete = OFF");
      filler(old);
      upsertDocument(old, secret);
      deleteDocument(old, secret.docId);
      old.close();
      // Another process holds a read while the app starts: the compaction can't complete.
      const reader = new Database(path);
      reader.exec("BEGIN");
      reader.query("SELECT count(*) FROM knowledge_documents").get();
      const first = openKnowledge(path);
      const versions = (first.query("SELECT version FROM lorehouse_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);
      expect(versions).toEqual(MIGRATIONS.map((m) => m.version)); // every migration recorded, in order
      expect(first.query("SELECT value FROM knowledge_index_meta WHERE key = 'compacted'").get()).toBeNull();
      first.close();
      reader.exec("COMMIT");
      reader.close();
      // The next start completes it, and the residue leaves the file.
      const db = openKnowledge(path);
      expect(db.query("SELECT value FROM knowledge_index_meta WHERE key = 'compacted'").get()).not.toBeNull();
      expect(fileHolds(db, path, "zebrasecretword9")).toBe(false);
    }));
  });

  test("ingest cursors round-trip per source", () => {
    const db = openKnowledge(":memory:");
    expect(getCursor(db, "slack:C1")).toBeUndefined();
    setCursor(db, "slack:C1", "1700000000.000100");
    setCursor(db, "slack:C1", "1700000009.000100");
    expect(getCursor(db, "slack:C1")).toBe("1700000009.000100");
  });

  test("the match expression follows the documented contract", () => {
    expect(matchExpression("How does SOFT navigation work?")).toBe('"how" OR "does" OR "soft" OR "navigation" OR "work"');
    expect(matchExpression("a b c")).toBeNull(); // every Latin token is shorter than 2 chars
    expect(matchExpression("")).toBeNull();
    expect(matchExpression("NOT this")).toBe('"not" OR "this"'); // quoted: never an operator
  });

  test("CJK runs become overlapping bigrams, in the index and in queries", () => {
    expect(indexText("看到廣告公司推")).toBe(" 看到 到廣 廣告 告公 公司 司推 ");
    expect(indexText("用 AI 做企劃")).toBe(" 用  AI  做企 企劃 "); // a one-char run stays single
    expect(indexText("plain english")).toBe("plain english"); // untouched
    expect(matchExpression("廣告 agent")).toBe('"agent" OR "廣告"');
    expect(matchExpression("最近的主題")).toBe('"最近" OR "近的" OR "的主" OR "主題"');
  });

  test("Chinese content is found by a Chinese question, and by a single word inside it", () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "x", title: "企劃 AI Agent", text: "分享之前看到廣告公司推企劃 AI Agent" });
    upsertDocument(db, { docId: "slack:C1:2.2", kind: "slack_thread", source: "y", title: "週會", text: "週會改到星期四下午" });
    expect(searcher(db)("廣告公司的 agent 是什麼")[0]?.id).toBe("slack:C1:1.1");
    expect(searcher(db)("廣告")[0]?.id).toBe("slack:C1:1.1");
    expect(searcher(db)("週會什麼時候")[0]?.id).toBe("slack:C1:2.2");
  });

  test("an index built by an older contract is rebuilt on open", () => {
    const path = join(import.meta.dir, `.tmp-reindex-${process.pid}.db`);
    try {
      const a = openKnowledge(path);
      upsertDocument(a, { docId: "d1", kind: "seed", source: "s", title: "t", text: "廣告公司" });
      a.exec("DELETE FROM knowledge_fts"); // simulate an index from an older contract…
      a.query("UPDATE knowledge_index_meta SET value = 'old' WHERE key = 'version'").run(); // …and its version
      a.close();
      const b = openKnowledge(path);
      expect(searcher(b)("廣告")[0]?.id).toBe("d1");
      expect(b.query("SELECT value FROM knowledge_index_meta WHERE key = 'version'").get()).toEqual({ value: INDEX_VERSION });
      b.close();
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
    }
  });

  test("search returns at most 5 ranked chunks", () => {
    const db = openKnowledge(":memory:");
    syncSeed(db, CORPUS);
    const hits = searcher(db)("how does soft navigation work");
    expect(hits.length).toBe(5);
    expect(hits[0]).toMatchObject({ id: expect.stringMatching(/^c\d+$/), title: expect.any(String) });
    expect(searcher(db)("")).toEqual([]);
  });
});

describe("prompts", () => {
  test("an unknown placeholder is an error, not a silent blank", () => {
    expect(render("hi {{name}}", { name: "x" })).toBe("hi x");
    expect(() => render("hi {{nope}}", {})).toThrow(/\{\{nope\}\} has no value/);
  });

  test("every tool description renders from its file", () => {
    expect(toolDescription("search_knowledge")).toContain("top 5 chunks");
    expect(toolDescription("workspace_exec", { workdir: "/w" })).toContain("cwd /w");
    expect(() => toolDescription("no_such_tool")).toThrow(/no prompt file/);
  });

  test("the system prompt uses the configured name", () => {
    expect(systemPrompt(agentIdentity("atlas"))).toStartWith("You are Atlas");
  });
});

describe("config", () => {
  const base = { SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "t", ANTHROPIC_API_KEY: "k" };

  test("reports every missing required setting at once", () => {
    expect(() => loadConfig({})).toThrow(/SLACK_SIGNING_SECRET, SLACK_BOT_TOKEN, ANTHROPIC_API_KEY/);
  });

  test("direct sandbox mode needs all three settings, or none", () => {
    expect(loadConfig(base).sandbox).toBeUndefined();
    expect(() => loadConfig({ ...base, SANDBOX_URL: "https://x" })).toThrow(/SANDBOX_TOKEN.*GITHUB_TOKEN/);
    expect(() => loadConfig({ ...base, GITHUB_TOKEN: "z" })).toThrow(/SANDBOX_URL/);
    expect(loadConfig({ ...base, SANDBOX_URL: "https://x", SANDBOX_TOKEN: "y", GITHUB_TOKEN: "z" }).sandbox).toEqual({ mode: "direct", url: "https://x", token: "y", github: { kind: "token", token: "z" } });
  });

  test("direct mode refuses a SANDBOX_URL that isn't https:// or plain http:// to this machine (it carries GitHub tokens)", () => {
    const direct = (url: string) => loadConfig({ ...base, SANDBOX_URL: url, SANDBOX_TOKEN: "y", GITHUB_TOKEN: "z" });
    for (const url of ["http://sandbox.internal:8080", "http://10.0.0.5", "http://127.0.0.1.example.test", "http://[::2]", "ftp://127.0.0.1", "not a url", "http://[bad"]) {
      expect(() => direct(url), url).toThrow(/SANDBOX_URL must be https:\/\//);
    }
    for (const url of ["https://sandbox.internal", "http://localhost:8080", "http://127.0.0.1:8080", "http://127.9.8.7", "http://[::1]:8080", "http://2130706433/"]) {
      expect(direct(url).sandbox, url).toMatchObject({ mode: "direct", url });
    }
  });

  test("the tenant's Strongroom: all three settings or none, an origin Strongroom's client accepts, a token and key reference of its shape", () => {
    const sr = { STRONGROOM_URL: "https://strongroom.example", STRONGROOM_TOKEN: "t".repeat(32), STRONGROOM_KEY: "tenant-acme" };
    expect(loadConfig(base).strongroom).toBeUndefined();
    expect(loadConfig({ ...base, ...sr }).strongroom).toEqual({ url: "https://strongroom.example", token: "t".repeat(32), key: "tenant-acme" });
    expect(() => loadConfig({ ...base, STRONGROOM_URL: sr.STRONGROOM_URL })).toThrow(/STRONGROOM_TOKEN .*STRONGROOM_KEY /);
    for (const url of ["http://strongroom.internal", "http://127.9.8.7", "https://strongroom.example/v1", "https://u:p@strongroom.example", "https://strongroom.example/?a=1", "not a url"]) {
      expect(() => loadConfig({ ...base, ...sr, STRONGROOM_URL: url }), url).toThrow(/STRONGROOM_URL must be an origin/);
    }
    for (const url of ["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787", "https://strongroom.example/"]) {
      expect(loadConfig({ ...base, ...sr, STRONGROOM_URL: url }).strongroom?.url, url).toBe(url);
    }
    expect(() => loadConfig({ ...base, ...sr, STRONGROOM_TOKEN: "short" })).toThrow(/STRONGROOM_TOKEN \(32 to 256/);
    expect(() => loadConfig({ ...base, ...sr, STRONGROOM_KEY: "a/b" })).toThrow(/STRONGROOM_KEY \(the key reference/);
    // A tenant in memory has no key: a session file beside it would be plaintext.
    expect(() => loadConfig({ ...base, ...sr, LOREHOUSE_DB: ":memory:", SESSIONS_DB: "/data/sessions.db" })).toThrow(/SESSIONS_DB \(with STRONGROOM_\* set and LOREHOUSE_DB in memory/);
    expect(loadConfig({ ...base, ...sr, LOREHOUSE_DB: ":memory:", SESSIONS_DB: ":memory:" }).strongroom).toBeDefined();
  });

  test("runner mode: a long SANDBOX_RUNNER_TOKEN plus GITHUB_TOKEN; never together with direct mode", () => {
    const runner = "r".repeat(32);
    expect(loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: runner, GITHUB_TOKEN: "z" }).sandbox).toEqual({ mode: "runners", runnerToken: runner, github: { kind: "token", token: "z" } });
    expect(() => loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: runner })).toThrow(/GITHUB_TOKEN/);
    expect(() => loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: "short", GITHUB_TOKEN: "z" })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: runner, SANDBOX_URL: "https://x", GITHUB_TOKEN: "z" })).toThrow(/one sandbox mode, not both/);
  });

  test("GitHub App credentials: a numeric id and a PEM key (escaped newlines restored); never with GITHUB_TOKEN; never without a sandbox", () => {
    const runner = { SANDBOX_RUNNER_TOKEN: "r".repeat(32) };
    const pem = "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----";
    expect(loadConfig({ ...base, ...runner, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem }).sandbox?.github).toEqual({ kind: "app", appId: "123", privateKey: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----" });
    expect(() => loadConfig({ ...base, ...runner, GITHUB_APP_ID: "my-app", GITHUB_APP_PRIVATE_KEY: pem })).toThrow(/GITHUB_APP_ID \(the App's numeric id\)/);
    expect(() => loadConfig({ ...base, ...runner, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "ssh-rsa AAAA" })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    expect(() => loadConfig({ ...base, ...runner, GITHUB_APP_ID: "123" })).toThrow(/GITHUB_APP_PRIVATE_KEY/);
    expect(() => loadConfig({ ...base, ...runner, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem, GITHUB_TOKEN: "z" })).toThrow(/one GitHub credential, not both/);
    expect(() => loadConfig({ ...base, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: pem })).toThrow(/GitHub credentials are set, but no sandbox/);
  });

  test("defaults: port 3000, claude-opus-5, both databases in the tenant's directory, empty channel allowlist", () => {
    // The data directory defaults to the working directory, which is the checkout here, and
    // a local `bun start` leaves a tenant's directory in it: read in an empty one instead.
    const here = process.cwd();
    const empty = mkdtempSync(join(tmpdir(), "lorehouse-defaults-"));
    let c;
    try {
      process.chdir(empty);
      c = loadConfig(base);
      // No tenant yet in the working directory: a new one, its directory under it.
      expect(c.tenant).toMatchObject({ source: "new", dataDir: process.cwd(), dir: join(process.cwd(), c.tenant.id) });
    } finally {
      process.chdir(here);
      rmSync(empty, { recursive: true, force: true });
    }
    expect(c.port).toBe(3000);
    expect(c.anthropic.model).toBe("claude-opus-5");
    expect(c.db).toMatchObject({ lorehouse: join(c.tenant.dir, "lorehouse.db"), sessions: join(c.tenant.dir, "sessions.db") });
    expect(c.agent.channels.size).toBe(0);
    expect(c.agent.dm).toBe("redirect");
  });

  // ADR 0002 §8: a turn parked on an Approve must survive a restart.
  test("SESSIONS_DB: unset, a file beside LOREHOUSE_DB; an explicit one kept; in memory only with LOREHOUSE_DB in memory", () => {
    const sessions = (env: Record<string, string>) => loadConfig({ ...base, ...env }).db.sessions;
    expect(sessions({ LOREHOUSE_DB: "/data/lorehouse.db" })).toBe("/data/sessions.db");
    expect(sessions({ LOREHOUSE_DB: "/data/lorehouse.db", SESSIONS_DB: "" })).toBe("/data/sessions.db");
    expect(sessions({ LOREHOUSE_DB: "var/knowledge.sqlite" })).toBe("var/sessions.db");
    expect(sessions({ LOREHOUSE_DB: "/data/lorehouse.db", SESSIONS_DB: ":memory:" })).toBe(":memory:");
    expect(sessions({ LOREHOUSE_DB: "/data/lorehouse.db", SESSIONS_DB: "/state/june.db" })).toBe("/state/june.db");
    expect(sessions({ LOREHOUSE_DB: ":memory:" })).toBe(":memory:");
    expect(sessions({ LOREHOUSE_DB: ":memory:", SESSIONS_DB: "/state/june.db" })).toBe("/state/june.db");
  });

  test("GITHUB_API_URL: unset, GitHub itself (the tools' default); set, kept", () => {
    expect(loadConfig(base).githubApiUrl).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_API_URL: "" }).githubApiUrl).toBeUndefined();
    expect(loadConfig({ ...base, GITHUB_API_URL: "http://localhost:9000/github" }).githubApiUrl).toBe("http://localhost:9000/github");
  });

  test("SESSIONS_DB never shares LOREHOUSE_DB's file, defaulted or explicit", () => {
    expect(() => loadConfig({ ...base, LOREHOUSE_DB: "/data/sessions.db" })).toThrow(/SESSIONS_DB \(must be a different file from LOREHOUSE_DB/);
    expect(() => loadConfig({ ...base, LOREHOUSE_DB: "/data/x.db", SESSIONS_DB: "/data/../data/x.db" })).toThrow(/SESSIONS_DB/);
  });

  test("SESSIONS_DB and LOREHOUSE_DB are compared as files once both exist, where paths can't tell", () => {
    const dir = mkdtempSync(join(tmpdir(), "lorehouse-identity-"));
    try {
      const db = join(dir, "lorehouse.db");
      // A link to a LOREHOUSE_DB not created yet: its path check can't see it…
      symlinkSync(db, join(dir, "dangling.db"));
      expect(loadConfig({ ...base, LOREHOUSE_DB: db, SESSIONS_DB: join(dir, "dangling.db") }).db.sessions).toBe(join(dir, "dangling.db"));
      // …once the knowledge store has created it, the identity check does.
      writeFileSync(db, "");
      expect(() => assertDistinctDatabases(db, join(dir, "dangling.db"))).toThrow(/SESSIONS_DB \(must be a different file from LOREHOUSE_DB; .* are one file\)/);
      // Two different files pass, and a SESSIONS_DB not created yet is created empty.
      expect(() => assertDistinctDatabases(db, join(dir, "sessions.db"))).not.toThrow();
      expect(existsSync(join(dir, "sessions.db"))).toBe(true);
      expect(() => assertDistinctDatabases(db, ":memory:")).not.toThrow();
      expect(() => assertDistinctDatabases(":memory:", join(dir, "other.db"))).not.toThrow();
      // On a case-insensitive filesystem (macOS by default) a differently cased name is the same file.
      if (existsSync(join(dir, "LOREHOUSE.DB"))) {
        expect(() => assertDistinctDatabases(db, join(dir, "LOREHOUSE.DB"))).toThrow(/are one file/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("SESSIONS_DB never reaches LOREHOUSE_DB's file by another name: a symlink, a hard link, a linked directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lorehouse-config-"));
    try {
      const db = join(dir, "lorehouse.db");
      writeFileSync(db, "");
      symlinkSync(db, join(dir, "symlink.db"));
      linkSync(db, join(dir, "hardlink.db"));
      mkdirSync(join(dir, "real"));
      symlinkSync(join(dir, "real"), join(dir, "linked"));
      expect(() => loadConfig({ ...base, LOREHOUSE_DB: db, SESSIONS_DB: join(dir, "symlink.db") })).toThrow(/SESSIONS_DB \(must be a different file/);
      expect(() => loadConfig({ ...base, LOREHOUSE_DB: db, SESSIONS_DB: join(dir, "hardlink.db") })).toThrow(/SESSIONS_DB \(must be a different file/);
      // Neither file exists yet: the directories they name are the same one.
      expect(() => loadConfig({ ...base, LOREHOUSE_DB: join(dir, "real", "x.db"), SESSIONS_DB: join(dir, "linked", "x.db") })).toThrow(/SESSIONS_DB \(must be a different file/);
      expect(loadConfig({ ...base, LOREHOUSE_DB: db, SESSIONS_DB: join(dir, "linked", "sessions.db") }).db.sessions).toBe(join(dir, "linked", "sessions.db"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DM_MODE is redirect, ignore or answer; anything else is reported", () => {
    for (const mode of ["redirect", "ignore", "answer"] as const) expect(loadConfig({ ...base, DM_MODE: mode }).agent.dm).toBe(mode);
    expect(() => loadConfig({ ...base, DM_MODE: "reply" })).toThrow(/DM_MODE \(one of redirect, ignore, answer, got "reply"\)/);
  });

  test("PR_APPROVER is requester by default, or anyone, or not-requester; anything else is reported", () => {
    expect(loadConfig(base).prApprover).toBe("requester");
    expect(loadConfig({ ...base, PR_APPROVER: "" }).prApprover).toBe("requester");
    for (const rule of ["requester", "anyone", "not-requester"] as const) expect(loadConfig({ ...base, PR_APPROVER: rule }).prApprover).toBe(rule);
    expect(() => loadConfig({ ...base, PR_APPROVER: "someone-else" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, PR_APPROVER: "Not-Requester" })).toThrow(/PR_APPROVER \(one of requester, anyone, not-requester, got "Not-Requester"\)/);
  });

  test("PDF_REPLIES is off unless 1; anything else is reported", () => {
    expect(loadConfig(base).pdf).toBe(false);
    expect(loadConfig({ ...base, PDF_REPLIES: "0" }).pdf).toBe(false);
    expect(loadConfig({ ...base, PDF_REPLIES: "1" }).pdf).toBe(true);
    expect(() => loadConfig({ ...base, PDF_REPLIES: "yes" })).toThrow(/PDF_REPLIES \(1 for PDF replies, or unset; got "yes"\)/);
  });

  test("PDF_FONTS is local by default, or google; anything else is reported", () => {
    expect(loadConfig(base).pdfFonts).toBe("local");
    expect(loadConfig({ ...base, PDF_FONTS: "google" }).pdfFonts).toBe("google");
    expect(() => loadConfig({ ...base, PDF_FONTS: "system" })).toThrow(/PDF_FONTS \(one of local, google, got "system"\)/);
  });

  test("FILE_STORE is memory by default; blob is planned and refused for now; anything else is reported", () => {
    expect(loadConfig(base).files.store).toBe("memory");
    expect(loadConfig({ ...base, FILE_STORE: "memory" }).files.store).toBe("memory");
    expect(() => loadConfig({ ...base, FILE_STORE: "blob" })).toThrow(/FILE_STORE=blob \(planned, not yet available/);
    expect(() => loadConfig({ ...base, FILE_STORE: "s3" })).toThrow(/FILE_STORE \(one of memory, blob, got "s3"\)/);
  });

  test("PR_APPROVER can come from settings.json, under the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "lorehouse-approver-"));
    try {
      const settings = join(dir, "settings.json");
      writeFileSync(settings, JSON.stringify({ env: { PR_APPROVER: "not-requester" } }));
      const proc = { ...base, LOREHOUSE_SETTINGS: settings, LOREHOUSE_ENV_FILE: join(dir, "missing.env") };
      expect(loadConfig(loadEnv(proc).env).prApprover).toBe("not-requester");
      expect(loadConfig(loadEnv({ ...proc, PR_APPROVER: "anyone" }).env).prApprover).toBe("anyone");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("DM_MODE=answer can't be combined with code tools: code work stays public", () => {
    const sandbox = { SANDBOX_URL: "https://x", SANDBOX_TOKEN: "y", GITHUB_TOKEN: "z" };
    expect(() => loadConfig({ ...base, ...sandbox, DM_MODE: "answer" })).toThrow(/DM_MODE=answer/);
    expect(loadConfig({ ...base, ...sandbox, DM_MODE: "redirect" }).sandbox).toBeDefined();
  });
});
