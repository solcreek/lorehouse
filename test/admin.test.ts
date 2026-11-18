// The admin API: the index, the agent's threads and the sandboxes, read behind its own
// token; and the one setting it writes, a channel's default repo.

import { describe, expect, test } from "bun:test";
import { adminRoutes, type AdminOptions } from "../src/admin";
import { getChannelRepo, listChannelRepos, setChannelRepo } from "../src/channel-repos";
import { ConfigError, loadConfig } from "../src/config";
import type { RepoCheck } from "../src/github-auth";
import type { IngestStatus } from "../src/ingest/slack";
import { openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { joinThread } from "../src/threads";
import { recordAsk, recordFeedback, recordSearch, usageSummary } from "../src/usage";

const TOKEN = "a".repeat(32);

function setup(o: Partial<AdminOptions> = {}) {
  const db = openKnowledge(":memory:");
  const handle = adminRoutes({ db, tenant: "t-test", token: TOKEN, ingest: () => undefined, sandbox: "off", ...o });
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

  // ADR 0005 §2: the tenant id is in every answer, errors included; a refusal of the token
  // says nothing about the install.
  test("every answer to the token names the tenant; a refusal doesn't", async () => {
    const { db, get } = setup();
    fill(db);
    for (const path of ["/api/v1/documents", "/api/v1/documents/seed-1", "/api/v1/search?q=wombat", "/api/v1/channels", "/api/v1/channels/C1/repo", "/api/v1/threads", "/api/v1/runners", "/api/v1/sandboxes", "/api/v1/usage", "/api/v1/documents?limit=0", "/api/v1/nope"]) {
      const r = await get(path);
      expect([path, ((await r.json()) as { tenant?: string }).tenant]).toEqual([path, "t-test"]);
    }
    expect(await (await get("/api/v1/documents", { token: "wrong" })).text()).not.toContain("t-test");
  });

  test("a read endpoint only reads: anything but GET is 405", async () => {
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
      await get("/api/v1/channels/C1/repo"), // 404, with a code
      await get("/api/v1/channels/C1/repo", { method: "DELETE" }), // 200
      await get("/api/v1/channels/C1/repo", { method: "PUT", body: "{" }), // 404, with a code
      await closed("/api/v1/documents"), // 404, closed
      await closed("/api/v1/channels/C1/repo", { method: "PUT", body: '{"repo":"acme/widgets"}' }), // 404, closed
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
    expect(await body("/api/v1/channels")).toEqual({ tenant: "t-test",
      state: "ready",
      channels: [
        { id: "C1", threads: 3, lastMessageAt: new Date(1790000005.0001 * 1000).toISOString(), defaultRepo: null },
        { id: "C2", threads: 0, lastMessageAt: null, defaultRepo: null },
      ],
    });
  });

  test("each channel is listed with its default repo, or null", async () => {
    const status: IngestStatus = { state: "ready", documents: 0, channels: { C1: { threads: 0 }, C2: { threads: 0 } }, reconciled: { refreshed: 0, removed: 0 } };
    const { db, body } = setup({ ingest: () => status });
    setChannelRepo(db, { channel: "C2", repo: { owner: "acme", name: "widgets" }, branch: "main" }, new Date("2026-11-01T00:00:00Z"));
    expect((await body("/api/v1/channels")).channels.map((c: { id: string; defaultRepo: unknown }) => [c.id, c.defaultRepo])).toEqual([
      ["C1", null],
      ["C2", { repo: "acme/widgets", branch: "main", setAt: "2026-11-01T00:00:00.000Z" }],
    ]);
  });

  test("an ingest error is passed on; no channels at all is idle", async () => {
    const failed: IngestStatus = { state: "error", documents: 0, channels: {}, reconciled: { refreshed: 0, removed: 0 }, error: "not_in_channel" };
    expect(await setup({ ingest: () => failed }).body("/api/v1/channels")).toEqual({ tenant: "t-test", state: "error", error: "not_in_channel", channels: [] });
    expect(await setup().body("/api/v1/channels")).toEqual({ tenant: "t-test", state: "idle", channels: [] });
  });

  test("threads the agent was asked into, newest first, linked to their document when indexed", async () => {
    const { db, body } = setup();
    fill(db);
    joinThread(db, "C1", "1790000001.000100", new Date("2026-09-01T00:00:00Z"));
    joinThread(db, "C1", "1795000000.000100", new Date("2026-09-02T00:00:00Z")); // only a question: not indexed
    const { threads, next } = await body("/api/v1/threads");
    expect(next).toBeNull();
    expect(threads).toEqual([
      { channel: "C1", threadTs: "1795000000.000100", joinedAt: "2026-09-02T00:00:00.000Z", document: null, source: null, asks: 0, searches: 0, emptySearches: 0 },
      { channel: "C1", threadTs: "1790000001.000100", joinedAt: "2026-09-01T00:00:00.000Z", document: "slack:C1:1790000001.000100", source: "https://acme.slack.com/archives/C1/p1790000001000100", asks: 0, searches: 0, emptySearches: 0 },
    ]);
    const paged = await body("/api/v1/threads?limit=1");
    expect(paged.threads.length).toBe(1);
    expect((await body(`/api/v1/threads?limit=1&cursor=${paged.next}`)).threads[0].threadTs).toBe("1790000001.000100");
  });

  test("runners in runner mode; none otherwise", async () => {
    const r = { runner: "starship", transport: "ws", online: true, capacity: 2, running: 1, lastSeenSecs: 3 };
    expect(await setup({ sandbox: "runners", runners: () => [r] }).body("/api/v1/runners")).toEqual({ tenant: "t-test", mode: "runners", runners: [r] });
    expect(await setup().body("/api/v1/runners")).toEqual({ tenant: "t-test", mode: "off", runners: [] });
  });

  test("which runner each sandbox lives on, newest first", async () => {
    const { db, body } = setup({ sandbox: "runners" });
    db.query("INSERT INTO sandbox_placements (sandbox, runner, placed_at) VALUES (?, ?, ?)").run("slack_C1_1", "starship", "2026-09-01T00:00:00.000Z");
    db.query("INSERT INTO sandbox_placements (sandbox, runner, placed_at) VALUES (?, ?, ?)").run("slack_C1_2", "falcon", "2026-09-02T00:00:00.000Z");
    expect(await body("/api/v1/sandboxes")).toEqual({ tenant: "t-test",
      sandboxes: [
        { sandbox: "slack_C1_2", runner: "falcon", placedAt: "2026-09-02T00:00:00.000Z" },
        { sandbox: "slack_C1_1", runner: "starship", placedAt: "2026-09-01T00:00:00.000Z" },
      ],
      next: null,
    });
  });
});

describe("usage", () => {
  // Wired as the app wires it: usage read from the same database.
  function setupUsage() {
    const db = openKnowledge(":memory:");
    const handle = adminRoutes({ db, tenant: "t-test", token: TOKEN, ingest: () => undefined, sandbox: "off", usage: (since) => usageSummary(db, { since }) });
    const get = async (path: string) => (await handle(new Request(`http://x${path}`, { headers: { authorization: `Bearer ${TOKEN}` } })))!;
    return { db, get, body: async (path: string) => (await (await get(path)).json()) as Record<string, any> };
  }

  test("who asks, which searches found nothing and the 👍/👎, over the last 7 days by default", async () => {
    const { db, body } = setupUsage();
    const now = new Date();
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, now);
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1" }, now);
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi budget", hits: 0 }, now);
    recordFeedback(db, { channel: "C1", messageTs: "1.3", rater: "U2", rating: "down" }, true, now);
    const u = await body("/api/v1/usage");
    expect(u).toMatchObject({
      days: 7, asks: 2, channels: 1, threads: 1,
      emptySearches: { threads: 1, of: 1, queries: ["okapi budget"] },
      feedback: { up: 0, down: 1, raters: 1, downMessages: [{ channel: "C1", ts: "1.3" }] },
    });
    expect(Date.now() - Date.parse(u.since)).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
  });

  test("the window is 1 to 90 whole days: anything else is a 400, never read as something else", async () => {
    const { get, body } = setupUsage();
    expect((await body("/api/v1/usage?days=1")).days).toBe(1);
    expect((await body("/api/v1/usage?days=90")).days).toBe(90);
    for (const days of ["0", "91", "-5", "7.9", "3days", "", "abc"]) {
      const r = await get(`/api/v1/usage?days=${days}`);
      expect(`${days} → ${r.status}`).toBe(`${days} → 400`);
    }
  });

  test("an older ask is outside a shorter window", async () => {
    const { db, body } = setupUsage();
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" }, new Date(Date.now() - 3 * 86_400_000));
    expect((await body("/api/v1/usage?days=2")).asks).toBe(0);
    expect((await body("/api/v1/usage?days=4")).asks).toBe(1);
  });

  test("not wired: a 404, not an empty summary", async () => {
    const { get } = setup();
    expect((await get("/api/v1/usage")).status).toBe(404);
  });

  test("each thread says how often it was asked, searched, and searched in vain", async () => {
    const { db, body } = setupUsage();
    joinThread(db, "C1", "1.1");
    recordAsk(db, { channel: "C1", ts: "1.1", threadTs: "1.1" });
    recordAsk(db, { channel: "C1", ts: "1.2", threadTs: "1.1" });
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "okapi", hits: 0 });
    recordSearch(db, { channel: "C1", threadTs: "1.1", query: "wombat", hits: 3 });
    recordSearch(db, { channel: "C2", threadTs: "1.1", query: "same ts, another channel", hits: 0 });
    expect((await body("/api/v1/threads")).threads[0]).toMatchObject({ channel: "C1", threadTs: "1.1", asks: 2, searches: 2, emptySearches: 1 });
  });
});

// #126: the one thing the admin API writes. Declarative: PUT the state wanted, DELETE for
// none, both safe to repeat; a refusal carries a stable code and stores nothing.
describe("a channel's default repo", () => {
  // A GitHub where every repo and branch is readable, unless `over` says otherwise.
  function github(over?: (repo: string, branch?: string) => RepoCheck | undefined) {
    const asked: string[] = [];
    const checkRepo: NonNullable<AdminOptions["checkRepo"]> = async (repo, branch) => {
      const full = `${repo.owner}/${repo.name}`;
      asked.push(branch === undefined ? full : `${full}@${branch}`);
      return over?.(full, branch) ?? { ok: true, repo, ...(branch === undefined ? {} : { branch }) };
    };
    return { checkRepo, asked };
  }
  function repoSetup(o: Partial<AdminOptions> = {}) {
    const gh = github();
    const log: string[] = [];
    const s = setup({ channels: new Set(["C1", "C2"]), checkRepo: gh.checkRepo, log: (l) => log.push(l), ...o });
    const call = async (method: string, channel: string, body?: unknown) => {
      const res = await s.get(`/api/v1/channels/${channel}/repo`, { method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
      return { status: res.status, allow: res.headers.get("allow"), body: (await res.json()) as Record<string, any> };
    };
    return { ...s, call, asked: gh.asked, log };
  }
  const put = (r: ReturnType<typeof repoSetup>, body: unknown, channel = "C1") => r.call("PUT", channel, body);

  test("none until set: GET says null", async () => {
    const r = repoSetup();
    expect(await r.call("GET", "C1")).toEqual({ status: 200, allow: null, body: { tenant: "t-test", channel: "C1", defaultRepo: null } });
  });

  test("PUT sets it, checked with GitHub first, and GET reads it back", async () => {
    const r = repoSetup();
    const set = await put(r, { repo: "acme/widgets", branch: "main" });
    expect(set).toEqual({ status: 200, allow: null, body: { tenant: "t-test", channel: "C1", defaultRepo: { repo: "acme/widgets", branch: "main", setAt: expect.any(String) } } });
    expect(r.asked).toEqual(["acme/widgets@main"]);
    expect((await r.call("GET", "C1")).body).toEqual(set.body);
    expect((await r.call("GET", "C2")).body.defaultRepo).toBeNull(); // per channel
    expect(r.log).toEqual(["admin: C1's default repo is now acme/widgets (branch main)"]);
  });

  test("the branch is optional: left out or null, it is the repo's default branch, and no branch is checked", async () => {
    const r = repoSetup();
    expect((await put(r, { repo: "acme/widgets" })).body.defaultRepo).toMatchObject({ repo: "acme/widgets", branch: null });
    expect((await put(r, { repo: "acme/widgets", branch: null }, "C2")).body.defaultRepo).toMatchObject({ branch: null });
    expect(r.asked).toEqual(["acme/widgets", "acme/widgets"]);
  });

  test("PUT again with the same state is the same answer, setAt included; with another, it replaces", async () => {
    const r = repoSetup();
    const first = await put(r, { repo: "acme/widgets", branch: "main" });
    await Bun.sleep(2);
    expect(await put(r, { repo: "acme/widgets", branch: "main" })).toEqual(first);
    expect(r.log).toHaveLength(1);
    const other = await put(r, { repo: "acme/gadgets" });
    expect(other.body.defaultRepo).toMatchObject({ repo: "acme/gadgets", branch: null });
    expect(listChannelRepos(r.db)).toHaveLength(1);
    expect(r.log.at(-1)).toBe("admin: C1's default repo is now acme/gadgets");
  });

  test("it is stored as GitHub spells the repo", async () => {
    const r = repoSetup({ checkRepo: github(() => ({ ok: true, repo: { owner: "Acme", name: "Widgets" } })).checkRepo });
    expect((await put(r, { repo: "acme/widgets" })).body.defaultRepo.repo).toBe("Acme/Widgets");
  });

  test("DELETE clears it, and again is the same answer", async () => {
    const r = repoSetup();
    await put(r, { repo: "acme/widgets" });
    const cleared = await r.call("DELETE", "C1");
    expect(cleared).toEqual({ status: 200, allow: null, body: { tenant: "t-test", channel: "C1", defaultRepo: null } });
    expect(getChannelRepo(r.db, "C1")).toBeUndefined();
    expect(await r.call("DELETE", "C1")).toEqual(cleared);
    expect(r.log.filter((l) => l.includes("cleared"))).toEqual(["admin: C1 has no default repo now (cleared)"]);
    // A channel off the list has none to clear: the same answer, not an error.
    expect((await r.call("DELETE", "C9")).status).toBe(200);
  });

  // Every refusal: its status, its code, and that nothing was stored or changed.
  const refused = async (r: ReturnType<typeof repoSetup>, body: unknown, status: number, code: string, channel = "C1") => {
    const before = listChannelRepos(r.db);
    const res = await put(r, body, channel);
    expect([res.status, res.body.code]).toEqual([status, code]);
    expect(res.body.error.length).toBeGreaterThan(20);
    expect(res.body.tenant).toBe("t-test");
    expect(listChannelRepos(r.db)).toEqual(before);
    return res.body.error as string;
  };

  test("invalid_channel (400): not a Slack channel id", async () => {
    const r = repoSetup();
    for (const channel of ["general", "c1", "C1%3Bdrop", "%E0%A4%A"]) {
      await refused(r, { repo: "acme/widgets" }, 400, "invalid_channel", channel);
      expect((await r.call("GET", channel)).body.code).toBe("invalid_channel");
      expect((await r.call("DELETE", channel)).body.code).toBe("invalid_channel");
    }
    expect(r.asked).toEqual([]);
  });

  test("channel_not_listed (404): only a channel on AGENT_CHANNELS can have one, so never a DM", async () => {
    const r = repoSetup();
    for (const channel of ["C9", "D1", "G1"]) {
      const error = await refused(r, { repo: "acme/widgets" }, 404, "channel_not_listed", channel);
      expect(error).toContain("AGENT_CHANNELS");
      expect((await r.call("GET", channel)).body.code).toBe("channel_not_listed");
    }
    // With no channels at all, none is listed.
    await refused(repoSetup({ channels: undefined }), { repo: "acme/widgets" }, 404, "channel_not_listed");
    expect(r.asked).toEqual([]);
  });

  test("invalid_body (400): not JSON, not an object, too long, or a field it doesn't know", async () => {
    const r = repoSetup();
    for (const body of ["", "{", "[]", '"acme/widgets"', "null", JSON.stringify({ repo: "acme/widgets", branch: "x".repeat(5000) })]) await refused(r, body, 400, "invalid_body");
    expect(await refused(r, { repo: "acme/widgets", default_branch: "main" }, 400, "invalid_body")).toContain('"default_branch"');
    expect(r.asked).toEqual([]);
  });

  test("invalid_repo (400): anything but owner/name", async () => {
    const r = repoSetup();
    for (const repo of [undefined, 7, "", "widgets", "acme/", "acme/widgets/x", "https://github.com/acme/widgets", "acme/widgets.git", "acme/widgets; rm -rf /", "../x", "acme/..", `${"o".repeat(40)}/widgets`, `acme/${"n".repeat(101)}`]) await refused(r, { repo }, 400, "invalid_repo");
    expect(r.asked).toEqual([]);
  });

  test("invalid_branch (400): not a branch name", async () => {
    const r = repoSetup();
    for (const branch of [7, "", "-rf", "a b", "a..b", "$(id)", ["main"], "a/./b", "a/../b", "a//b", "a/b.lock", "x".repeat(256)]) await refused(r, { repo: "acme/widgets", branch }, 400, "invalid_branch");
    expect(r.asked).toEqual([]);
  });

  test("the branch stored is the one GitHub confirmed: an ok that doesn't name the branch asked for stores nothing", async () => {
    for (const answered of [undefined, "trunk"]) {
      const r = repoSetup({ checkRepo: github((_, branch) => (branch ? { ok: true, repo: { owner: "acme", name: "widgets" }, ...(answered ? { branch: answered } : {}) } : undefined)).checkRepo });
      await refused(r, { repo: "acme/widgets", branch: "main" }, 502, "github_unavailable");
    }
  });

  test("code_tools_off (409): with no GitHub credential there is nothing to check with, and nothing to use it", async () => {
    const r = repoSetup({ checkRepo: undefined });
    expect(await refused(r, { repo: "acme/widgets" }, 409, "code_tools_off")).toContain("SANDBOX_RUNNER_TOKEN");
    // Reading and clearing still work.
    expect((await r.call("GET", "C1")).status).toBe(200);
    expect((await r.call("DELETE", "C1")).status).toBe(200);
  });

  test("app_not_installed (422): says to install the App on that repo", async () => {
    const r = repoSetup({ checkRepo: github(() => ({ ok: false, reason: "not_installed", detail: "the GitHub App isn't installed on acme/secret" })).checkRepo });
    const error = await refused(r, { repo: "acme/secret" }, 422, "app_not_installed");
    expect(error).toContain("isn't installed on acme/secret");
    expect(error).toContain("install it there");
  });

  test("repo_not_readable (422): the credential gets no read of it", async () => {
    const r = repoSetup({ checkRepo: github(() => ({ ok: false, reason: "not_readable", detail: "the GitHub credential can't read acme/secret (GitHub answered 404): no such repo, or no access to it" })).checkRepo });
    expect(await refused(r, { repo: "acme/secret" }, 422, "repo_not_readable")).toContain("can't read acme/secret");
  });

  test("branch_not_found (422): the repo is readable, the branch isn't there", async () => {
    const r = repoSetup({ checkRepo: github((_, branch) => (branch === "nope" ? { ok: false, reason: "branch_not_found", detail: "acme/widgets has no branch nope" } : undefined)).checkRepo });
    expect(await refused(r, { repo: "acme/widgets", branch: "nope" }, 422, "branch_not_found")).toContain("has no branch nope");
    expect((await put(r, { repo: "acme/widgets", branch: "main" })).status).toBe(200);
  });

  test("github_unavailable (502): GitHub couldn't be asked, so nothing changes", async () => {
    const r = repoSetup({ checkRepo: github(() => ({ ok: false, reason: "unavailable", detail: "GitHub answered 503 for acme/widgets" })).checkRepo });
    expect(await refused(r, { repo: "acme/widgets" }, 502, "github_unavailable")).toContain("try again");
  });

  test("credential_refused (502): GitHub refused the install's own credential, so the fix is the credential, not the repo's access", async () => {
    const r = repoSetup({ checkRepo: github(() => ({ ok: false, reason: "credential_refused", detail: "GitHub refused the credential itself (401) when asked for acme/widgets" })).checkRepo });
    const error = await refused(r, { repo: "acme/widgets" }, 502, "credential_refused");
    expect(error).toContain("GITHUB_TOKEN has expired or been revoked");
    expect(error).not.toContain("access to it");
  });

  test("github_rate_limited (503): GitHub is rate limiting; Retry-After is passed on when GitHub gave one", async () => {
    const r = repoSetup({ checkRepo: github(() => ({ ok: false, reason: "rate_limited", detail: "GitHub is applying a rate limit to the credential (it says to wait 60 s)", retryAfterSecs: 60 })).checkRepo });
    expect(await refused(r, { repo: "acme/widgets" }, 503, "github_rate_limited")).toContain("wait 60 s");
    expect((await r.get("/api/v1/channels/C1/repo", { method: "PUT", body: '{"repo":"acme/widgets"}' })).headers.get("retry-after")).toBe("60");
    const unsaid = repoSetup({ checkRepo: github(() => ({ ok: false, reason: "rate_limited", detail: "GitHub is applying a rate limit to the credential" })).checkRepo });
    await refused(unsaid, { repo: "acme/widgets" }, 503, "github_rate_limited");
    expect((await unsaid.get("/api/v1/channels/C1/repo", { method: "PUT", body: '{"repo":"acme/widgets"}' })).headers.get("retry-after")).toBeNull();
  });

  test("a refused set leaves the default that was there", async () => {
    let gone = false;
    const r = repoSetup({ checkRepo: github(() => (gone ? { ok: false, reason: "not_installed", detail: "x" } : undefined)).checkRepo });
    await put(r, { repo: "acme/widgets", branch: "main" });
    gone = true;
    await refused(r, { repo: "acme/gadgets" }, 422, "app_not_installed");
    await refused(r, { repo: "acme/widgets", branch: "main" }, 422, "app_not_installed"); // even the same state: it is checked every time
    expect(getChannelRepo(r.db, "C1")).toMatchObject({ repo: "acme/widgets", branch: "main" });
  });

  test("method_not_allowed (405): GET, PUT and DELETE only", async () => {
    const r = repoSetup();
    for (const method of ["POST", "PATCH"]) {
      const res = await r.call(method, "C1", { repo: "acme/widgets" });
      expect([res.status, res.body.code, res.allow]).toEqual([405, "method_not_allowed", "GET, PUT, DELETE"]);
    }
    expect(listChannelRepos(r.db)).toEqual([]);
  });

  test("it needs the admin token like everything else, and is closed without one", async () => {
    const r = repoSetup();
    const init = { method: "PUT", body: JSON.stringify({ repo: "acme/widgets" }) };
    expect((await r.get("/api/v1/channels/C1/repo", { ...init, token: "wrong" })).status).toBe(401);
    expect((await r.get("/api/v1/channels/C1/repo", { ...init, token: null })).status).toBe(401);
    const closed = repoSetup({ token: undefined });
    expect((await closed.get("/api/v1/channels/C1/repo", init)).status).toBe(404);
    expect(listChannelRepos(r.db)).toEqual([]);
    expect(listChannelRepos(closed.db)).toEqual([]);
    expect(r.asked).toEqual([]);
  });
});
