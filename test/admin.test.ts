// The admin API: a read-only view of the index, the agent's threads and the sandboxes,
// behind its own token.

import { describe, expect, test } from "bun:test";
import { adminRoutes, type AdminOptions } from "../src/admin";
import { ConfigError, loadConfig } from "../src/config";
import type { IngestStatus } from "../src/ingest/slack";
import { openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { joinThread } from "../src/threads";

const TOKEN = "a".repeat(32);

function setup(o: Partial<AdminOptions> = {}) {
  const db = openKnowledge(":memory:");
  const handle = adminRoutes({ db, token: TOKEN, ingest: () => undefined, sandbox: "off", ...o });
  const get = async (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const { token = TOKEN, ...rest } = init;
    const res = await handle(new Request(`http://x${path}`, { ...rest, headers: token === null ? {} : { authorization: `Bearer ${token}` } }));
    return res!;
  };
  const body = async (path: string) => (await (await get(path)).json()) as Record<string, any>;
  return { db, handle, get, body };
}

// Five Slack threads in two channels and one seed, indexed in this order.
function fill(db: ReturnType<typeof openKnowledge>) {
  const thread = (channel: string, ts: string, text: string) =>
    upsertDocument(db, { docId: `slack:${channel}:${ts}`, kind: "slack_thread", source: `https://acme.slack.com/archives/${channel}/p${ts.replace(".", "")}`, title: `#${channel}`, text, sourceVersion: ts });
  upsertDocument(db, { docId: "seed-1", kind: "seed", source: "docs/wombat.md", title: "Wombats", text: "The wombat review is quarterly." });
  thread("C1", "1790000001.000100", "Wendy: the wombat review moved to Thursday");
  thread("C1", "1790000002.000100", "Omar: 週會改到星期四下午三點");
  thread("C2", "1790000003.000100", "Wendy: the kangaroo freeze starts Monday");
  thread("C2", "1790000004.000100", "Omar: " + "long ".repeat(200));
  thread("C1", "1790000005.000100", "Wendy: the ibex standup is in the falcon room");
}

describe("who may use it", () => {
  test("without ADMIN_TOKEN, all of /api/ is closed: 404, even with a bearer", async () => {
    const { get } = setup({ token: undefined });
    expect((await get("/api/v1/documents")).status).toBe(404);
    expect((await get("/api/v1/anything")).status).toBe(404);
  });

  test("only the exact bearer gets in", async () => {
    const { get } = setup();
    expect((await get("/api/v1/documents", { token: null })).status).toBe(401);
    expect((await get("/api/v1/documents", { token: "wrong" })).status).toBe(401);
    expect((await get("/api/v1/documents")).status).toBe(200);
  });

  test("it only reads: anything but GET is 405", async () => {
    const { get } = setup();
    const r = await get("/api/v1/documents", { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
  });

  test("other paths are not its business", async () => {
    const { handle } = setup();
    expect(await handle(new Request("http://x/apiary"))).toBeUndefined();
    expect(await handle(new Request("http://x/status"))).toBeUndefined();
  });

  test("nothing it answers is kept by a shared cache, refusals included", async () => {
    const { get } = setup();
    const closed = setup({ token: undefined }).get;
    for (const r of [
      await get("/api/v1/documents"), // 200
      await get("/api/v1/documents?limit=0"), // 400
      await get("/api/v1/nope"), // 404
      await get("/api/v1/documents", { token: "wrong" }), // 401
      await get("/api/v1/documents", { method: "POST" }), // 405
      await closed("/api/v1/documents"), // 404, closed
    ]) {
      expect(`${r.status} ${r.headers.get("cache-control")}`).toBe(`${r.status} no-store`);
    }
  });

  test("a refusal is a JSON error, and still says what it wants", async () => {
    const { get } = setup();
    const denied = await get("/api/v1/documents", { token: "wrong" });
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    expect(((await denied.json()) as { error: string }).error).toStartWith("unauthorized");
    const posted = await get("/api/v1/documents", { method: "POST" });
    expect(posted.headers.get("allow")).toBe("GET");
    expect(((await posted.json()) as { error: string }).error).toStartWith("method not allowed");
  });

  test("closed, it answers like any path the app doesn't serve: a plain 404", async () => {
    const r = await setup({ token: undefined }).get("/api/v1/documents");
    expect(await r.text()).toBe("not found");
  });

  test("an unknown endpoint is a 404 that says where the list is", async () => {
    const { get } = setup();
    const r = await get("/api/v1/nope");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toContain("docs/admin-api.md");
  });
});

describe("the ADMIN_TOKEN setting", () => {
  const env = { SLACK_SIGNING_SECRET: "s", SLACK_BOT_TOKEN: "xoxb", ANTHROPIC_API_KEY: "k" };
  const problems = (extra: Record<string, string>) => {
    try {
      loadConfig({ ...env, ...extra });
      return [];
    } catch (e) {
      return (e as ConfigError).problems;
    }
  };

  test("is at least 32 characters, and never the status token", () => {
    expect(problems({ ADMIN_TOKEN: "short" })).toEqual(["ADMIN_TOKEN (at least 32 characters)"]);
    expect(problems({ ADMIN_TOKEN: TOKEN, STATUS_TOKEN: TOKEN })[0]).toStartWith("ADMIN_TOKEN (must differ from STATUS_TOKEN");
    expect(problems({ ADMIN_TOKEN: TOKEN, STATUS_TOKEN: "other" })).toEqual([]);
    expect(loadConfig(env).adminToken).toBeUndefined();
  });
});

describe("documents", () => {
  test("newest indexed first, without their text", async () => {
    const { db, body } = setup();
    fill(db);
    const { documents, next } = await body("/api/v1/documents");
    expect(documents.map((d: { id: string }) => d.id)).toEqual([
      "slack:C1:1790000005.000100", "slack:C2:1790000004.000100", "slack:C2:1790000003.000100", "slack:C1:1790000002.000100", "slack:C1:1790000001.000100", "seed-1",
    ]);
    expect(next).toBeNull();
    expect(documents[0]).toEqual({
      id: "slack:C1:1790000005.000100", kind: "slack_thread", source: "https://acme.slack.com/archives/C1/p1790000005000100", title: "#C1",
      updatedAt: expect.any(String), activeAt: new Date(1790000005.0001 * 1000).toISOString(), chars: 45,
    });
    expect(documents.at(-1).activeAt).toBeNull(); // a seed has no clock
  });

  test("filtered by kind or by channel", async () => {
    const { db, body } = setup();
    fill(db);
    expect((await body("/api/v1/documents?kind=seed")).documents.map((d: { id: string }) => d.id)).toEqual(["seed-1"]);
    expect((await body("/api/v1/documents?channel=C2")).documents.map((d: { id: string }) => d.id)).toEqual(["slack:C2:1790000004.000100", "slack:C2:1790000003.000100"]);
  });

  test("paged: every document once, however the pages fall", async () => {
    const { db, body } = setup();
    fill(db);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r: Record<string, any> = await body(`/api/v1/documents?limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.documents.map((d: { id: string }) => d.id));
      cursor = r.next;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual((await body("/api/v1/documents")).documents.map((d: { id: string }) => d.id));
  });

  test("a page stays put while documents change: a changed one moves to the front, not onto the next page twice", async () => {
    const { db, body } = setup();
    fill(db);
    const first = await body("/api/v1/documents?limit=3");
    await Bun.sleep(2);
    upsertDocument(db, { docId: "slack:C1:1790000005.000100", kind: "slack_thread", source: "s", title: "#C1", text: "edited", sourceVersion: "1790000009.000100" });
    const second = await body(`/api/v1/documents?limit=3&cursor=${first.next}`);
    const ids = [...first.documents, ...second.documents].map((d: { id: string }) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("bad parameters are a 400 that says what's expected", async () => {
    const { get } = setup();
    for (const q of ["limit=0", "limit=201", "limit=ten", "cursor=garbage", "kind=email", "channel=c1;drop"]) {
      const r = await get(`/api/v1/documents?${q}`);
      expect(r.status).toBe(400);
      expect(((await r.json()) as { error: string }).error.length).toBeGreaterThan(5);
    }
  });

  test("one document, with its text, by its id as is or percent-encoded", async () => {
    const { db, body, get } = setup();
    fill(db);
    const doc = await body("/api/v1/documents/slack:C1:1790000001.000100");
    expect(doc).toMatchObject({ id: "slack:C1:1790000001.000100", kind: "slack_thread", text: "Wendy: the wombat review moved to Thursday" });
    expect((await body(`/api/v1/documents/${encodeURIComponent("slack:C1:1790000001.000100")}`)).id).toBe("slack:C1:1790000001.000100");
    expect((await get("/api/v1/documents/slack:C1:0.0")).status).toBe(404);
    expect((await get("/api/v1/documents/%E0%A4%A")).status).toBe(400);
  });
});

describe("search", () => {
  test("finds what the agent's search finds, in the same order, with an excerpt", async () => {
    const { db, body } = setup();
    fill(db);
    const { results } = await body("/api/v1/search?q=wombat%20review");
    expect(results.map((r: { id: string }) => r.id)).toEqual(searcher(db)("wombat review").map((c) => c.id));
    expect(results[0]).toEqual({ id: expect.any(String), source: expect.any(String), title: expect.any(String), excerpt: expect.any(String) });
  });

  test("in Chinese too", async () => {
    const { db, body } = setup();
    fill(db);
    expect((await body(`/api/v1/search?q=${encodeURIComponent("週會")}`)).results[0].id).toBe("slack:C1:1790000002.000100");
  });

  test("an excerpt is at most 300 characters", async () => {
    const { db, body } = setup();
    fill(db);
    const long = (await body("/api/v1/search?q=long")).results[0];
    expect(long.excerpt.length).toBe(300);
  });

  test("more than the agent's five, when asked", async () => {
    const { db, body } = setup();
    for (let i = 0; i < 8; i++) upsertDocument(db, { docId: `seed-${i}`, kind: "seed", source: "s", title: "t", text: `echidna fact ${i}` });
    expect((await body("/api/v1/search?q=echidna")).results.length).toBe(8);
    expect((await body("/api/v1/search?q=echidna&limit=3")).results.length).toBe(3);
  });

  test("needs a query", async () => {
    const { get } = setup();
    expect((await get("/api/v1/search")).status).toBe(400);
    expect((await get("/api/v1/search?q=%20%20")).status).toBe(400);
    expect((await get(`/api/v1/search?q=${"x".repeat(501)}`)).status).toBe(400);
  });
});

describe("channels, threads and sandboxes", () => {
  test("each allowed channel's ingest, with when it last saw a message", async () => {
    const status: IngestStatus = { state: "ready", documents: 3, channels: { C1: { cursor: "1790000005.000100", threads: 3 }, C2: { threads: 0 } }, reconciled: { refreshed: 0, removed: 0 } };
    const { body } = setup({ ingest: () => status });
    expect(await body("/api/v1/channels")).toEqual({
      state: "ready",
      channels: [
        { id: "C1", threads: 3, lastMessageAt: new Date(1790000005.0001 * 1000).toISOString() },
        { id: "C2", threads: 0, lastMessageAt: null },
      ],
    });
  });

  test("an ingest error is passed on; no channels at all is idle", async () => {
    const failed: IngestStatus = { state: "error", documents: 0, channels: {}, reconciled: { refreshed: 0, removed: 0 }, error: "not_in_channel" };
    expect(await setup({ ingest: () => failed }).body("/api/v1/channels")).toEqual({ state: "error", error: "not_in_channel", channels: [] });
    expect(await setup().body("/api/v1/channels")).toEqual({ state: "idle", channels: [] });
  });

  test("threads the agent was asked into, newest first, linked to their document when indexed", async () => {
    const { db, body } = setup();
    fill(db);
    joinThread(db, "C1", "1790000001.000100", new Date("2026-09-01T00:00:00Z"));
    joinThread(db, "C1", "1795000000.000100", new Date("2026-09-02T00:00:00Z")); // only a question: not indexed
    const { threads, next } = await body("/api/v1/threads");
    expect(next).toBeNull();
    expect(threads).toEqual([
      { channel: "C1", threadTs: "1795000000.000100", joinedAt: "2026-09-02T00:00:00.000Z", document: null, source: null },
      { channel: "C1", threadTs: "1790000001.000100", joinedAt: "2026-09-01T00:00:00.000Z", document: "slack:C1:1790000001.000100", source: "https://acme.slack.com/archives/C1/p1790000001000100" },
    ]);
    const paged = await body("/api/v1/threads?limit=1");
    expect(paged.threads.length).toBe(1);
    expect((await body(`/api/v1/threads?limit=1&cursor=${paged.next}`)).threads[0].threadTs).toBe("1790000001.000100");
  });

  test("runners in runner mode; none otherwise", async () => {
    const r = { runner: "starship", transport: "ws", online: true, capacity: 2, running: 1, lastSeenSecs: 3 };
    expect(await setup({ sandbox: "runners", runners: () => [r] }).body("/api/v1/runners")).toEqual({ mode: "runners", runners: [r] });
    expect(await setup().body("/api/v1/runners")).toEqual({ mode: "off", runners: [] });
  });

  test("which runner each sandbox lives on, newest first", async () => {
    const { db, body } = setup({ sandbox: "runners" });
    db.query("INSERT INTO sandbox_placements (sandbox, runner, placed_at) VALUES (?, ?, ?)").run("slack_C1_1", "starship", "2026-09-01T00:00:00.000Z");
    db.query("INSERT INTO sandbox_placements (sandbox, runner, placed_at) VALUES (?, ?, ?)").run("slack_C1_2", "falcon", "2026-09-02T00:00:00.000Z");
    expect(await body("/api/v1/sandboxes")).toEqual({
      sandboxes: [
        { sandbox: "slack_C1_2", runner: "falcon", placedAt: "2026-09-02T00:00:00.000Z" },
        { sandbox: "slack_C1_1", runner: "starship", placedAt: "2026-09-01T00:00:00.000Z" },
      ],
      next: null,
    });
  });
});
