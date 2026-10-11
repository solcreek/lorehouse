import { describe, expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDistinctDatabases, loadConfig } from "../src/config";
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

  test("direct sandbox mode needs all three settings, or none", () => {
    expect(loadConfig(base).sandbox).toBeUndefined();
    expect(() => loadConfig({ ...base, SANDBOX_URL: "http://x" })).toThrow(/SANDBOX_TOKEN.*GITHUB_TOKEN/);
    expect(() => loadConfig({ ...base, GITHUB_TOKEN: "z" })).toThrow(/SANDBOX_URL/);
    expect(loadConfig({ ...base, SANDBOX_URL: "http://x", SANDBOX_TOKEN: "y", GITHUB_TOKEN: "z" }).sandbox).toEqual({ mode: "direct", url: "http://x", token: "y", github: { kind: "token", token: "z" } });
  });

  test("runner mode: a long SANDBOX_RUNNER_TOKEN plus GITHUB_TOKEN; never together with direct mode", () => {
    const runner = "r".repeat(32);
    expect(loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: runner, GITHUB_TOKEN: "z" }).sandbox).toEqual({ mode: "runners", runnerToken: runner, github: { kind: "token", token: "z" } });
    expect(() => loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: runner })).toThrow(/GITHUB_TOKEN/);
    expect(() => loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: "short", GITHUB_TOKEN: "z" })).toThrow(/at least 32 characters/);
    expect(() => loadConfig({ ...base, SANDBOX_RUNNER_TOKEN: runner, SANDBOX_URL: "http://x", GITHUB_TOKEN: "z" })).toThrow(/one sandbox mode, not both/);
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

  test("defaults: port 3000, claude-opus-5, sessions beside the database, empty channel allowlist", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(3000);
    expect(c.anthropic.model).toBe("claude-opus-5");
    expect(c.db).toMatchObject({ lorehouse: "lorehouse.db", sessions: "sessions.db" });
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

  test("DM_MODE=answer can't be combined with code tools: code work stays public", () => {
    const sandbox = { SANDBOX_URL: "http://x", SANDBOX_TOKEN: "y", GITHUB_TOKEN: "z" };
    expect(() => loadConfig({ ...base, ...sandbox, DM_MODE: "answer" })).toThrow(/DM_MODE=answer/);
    expect(loadConfig({ ...base, ...sandbox, DM_MODE: "redirect" }).sandbox).toBeDefined();
  });
});
