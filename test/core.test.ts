import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { countDocuments, getCursor, indexText, INDEX_VERSION, matchExpression, openKnowledge, searcher, seedFromJsonl, setCursor, upsertDocument } from "../src/knowledge";
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

  test("seeding fills an empty index once, never duplicates", () => {
    const db = openKnowledge(":memory:");
    const first = seedFromJsonl(db, CORPUS);
    expect(first).toBeGreaterThan(200);
    expect(seedFromJsonl(db, CORPUS)).toBe(0);
    expect(countDocuments(db)).toBe(first);
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
    seedFromJsonl(db, CORPUS);
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

  test("code tools need all three sandbox settings, or none", () => {
    expect(loadConfig(base).sandbox).toBeUndefined();
    expect(() => loadConfig({ ...base, SANDBOX_URL: "http://x" })).toThrow(/SANDBOX_TOKEN.*GITHUB_TOKEN/);
    expect(loadConfig({ ...base, SANDBOX_URL: "http://x", SANDBOX_TOKEN: "y", GITHUB_TOKEN: "z" }).sandbox).toEqual({ url: "http://x", token: "y", githubToken: "z" });
  });

  test("defaults: port 3000, claude-opus-5, sessions in memory, empty channel allowlist", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.anthropic.model).toBe("claude-opus-5");
    expect(c.db.sessions).toBe(":memory:");
    expect(c.agent.channels.size).toBe(0);
  });
});
