import { describe, expect, test } from "bun:test";
import { openKnowledge, recentDocuments, upsertDocument } from "../src/knowledge";
import { recentKnowledgeTool } from "../src/tools/recent-knowledge";

const NOW = 1790100000; // seconds

function withDocs() {
  const db = openKnowledge(":memory:");
  const add = (id: string, v?: string) => upsertDocument(db, { docId: id, kind: v ? "slack_thread" : "seed", source: `https://x/${id}`, title: id, text: `text of ${id}`, sourceVersion: v });
  add("seed-1"); // no source_version: never "recent"
  add("slack:C1:old", String(NOW - 40 * 86400));
  add("slack:C1:mid", String(NOW - 10 * 86400));
  add("slack:C1:new", String(NOW - 1 * 86400));
  return db;
}

describe("recent documents", () => {
  test("newest first, seeds never count, limit respected", () => {
    const r = recentDocuments(withDocs(), { limit: 2 });
    expect(r.map((d) => d.id)).toEqual(["slack:C1:new", "slack:C1:mid"]);
    expect(r[0]!.activeAt).toBe(new Date((NOW - 86400) * 1000).toISOString());
  });

  test("a since bound filters by the source's own activity time", () => {
    expect(recentDocuments(withDocs(), { limit: 10, sinceSec: NOW - 20 * 86400 }).map((d) => d.id)).toEqual(["slack:C1:new", "slack:C1:mid"]);
  });
});

describe("recent_knowledge tool", () => {
  const tool = (db = withDocs()) => recentKnowledgeTool((o) => recentDocuments(db, o), () => NOW * 1000);
  const result = (input: Record<string, unknown>) => JSON.parse(tool().run(input, {} as never) as string) as { now: string; threads: ({ id: string } & Record<string, unknown>)[] };
  const run = (input: Record<string, unknown>) => result(input).threads;

  test("with no window it returns the newest threads however old — a quiet channel still has an answer", () => {
    expect(run({}).map((d) => d.id)).toEqual(["slack:C1:new", "slack:C1:mid", "slack:C1:old"]);
  });

  test("days narrows to recent activity; limit is clamped to 1..30", () => {
    expect(run({ days: 5 }).map((d) => d.id)).toEqual(["slack:C1:new"]);
    expect(run({ limit: 0 })).toHaveLength(1);
    expect(run({ limit: 999 })).toHaveLength(3);
  });

  test("it tells the model what time it is, so a period like \"since August\" has a date to count from", () => {
    expect(result({}).now).toBe(new Date(NOW * 1000).toISOString());
  });

  test("each hit carries what an answer needs: id, title, source link, activity time, excerpt", () => {
    expect(run({ limit: 1 })[0]).toEqual({ id: "slack:C1:new", title: "slack:C1:new", source: "https://x/slack:C1:new", activeAt: expect.any(String), text: "text of slack:C1:new" });
  });
});
