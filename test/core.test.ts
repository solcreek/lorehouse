import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { matchExpression, openKnowledge, searcher, seedFromJsonl } from "../src/knowledge";
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
      const rows = b.query("SELECT version, name FROM lorehouse_migrations").all();
      expect(rows).toEqual([{ version: 1, name: "0001_knowledge.sql" }]);
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
    expect((db.query("SELECT count(*) AS n FROM knowledge_chunks").get() as { n: number }).n).toBe(first);
  });

  test("the match expression follows the documented contract", () => {
    expect(matchExpression("How does SOFT navigation work?")).toBe("how OR does OR soft OR navigation OR work");
    expect(matchExpression("a b c")).toBeNull(); // every token is shorter than 2 chars
    expect(matchExpression("")).toBeNull();
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
