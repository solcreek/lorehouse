import { describe, expect, test } from "bun:test";
import { cleanSlackText, permalink, SlackIngester, threadDocument, type SlackMessage } from "../src/ingest/slack";
import { countDocuments, getCursor, openKnowledge, searcher } from "../src/knowledge";
import { slackApi, SlackApiError, type SlackApi } from "../src/slack-api";

const WS = "https://acme.slack.com/";

describe("Slack text → document", () => {
  test("markup becomes readable text", () => {
    expect(cleanSlackText("ping <@U123> in <#C9|ops> re <https://x.dev/a|the doc> &amp; <https://y.dev> <!here>"))
      .toBe("ping @U123 in #ops re the doc (https://x.dev/a) & https://y.dev @here");
  });

  test("permalinks follow Slack's archive URL shape", () => {
    expect(permalink(WS, "C1", "1790000001.000100")).toBe("https://acme.slack.com/archives/C1/p1790000001000100");
  });

  test("a thread keeps human messages only, titled by its first line", () => {
    const doc = threadDocument("C1", [
      { ts: "1790000001.000100", user: "U2", text: "Wombat review moves to Thursdays\nmore detail" },
      { ts: "1790000002.000100", thread_ts: "1790000001.000100", bot_id: "B1", text: "bot noise" },
      { ts: "1790000003.000100", thread_ts: "1790000001.000100", subtype: "channel_join", user: "U9", text: "joined" },
      { ts: "1790000004.000100", thread_ts: "1790000001.000100", user: "U3", text: "same room as <#C7|ops>?" },
    ], WS)!;
    expect(doc.docId).toBe("slack:C1:1790000001.000100");
    expect(doc.title).toBe("Wombat review moves to Thursdays");
    expect(doc.source).toBe("https://acme.slack.com/archives/C1/p1790000001000100");
    expect(doc.text).toContain("] U2: Wombat review");
    expect(doc.text).toContain("] U3: same room as #ops?");
    expect(doc.text).not.toContain("bot noise");
    expect(doc.text).not.toContain("joined");
  });

  test("a question put to the agent is not knowledge; the rest of its thread is", () => {
    const doc = threadDocument("C1", [
      { ts: "1.1", user: "U2", text: "<@UBOT> what's the pelican budget?" },
      { ts: "1.2", thread_ts: "1.1", user: "U3", text: "it's 40k, per the finance sync" },
    ], WS, "UBOT")!;
    expect(doc.text).not.toContain("pelican budget?");
    expect(doc.text).toContain("40k");
    expect(threadDocument("C1", [{ ts: "2.1", user: "U2", text: "<@UBOT> hello" }], WS, "UBOT")).toBeNull();
    // without a known bot id nothing is dropped (e.g. before auth.test answered)
    expect(threadDocument("C1", [{ ts: "2.1", user: "U2", text: "<@UBOT> hello" }], WS)).not.toBeNull();
  });

  test("a thread with nothing human-written is not a document", () => {
    expect(threadDocument("C1", [{ ts: "1.1", bot_id: "B1", text: "deploy ok" }], WS)).toBeNull();
    expect(threadDocument("C1", [], WS)).toBeNull();
  });
});

// A fake Web API: history per channel (optionally split into pages) and threads by root ts.
function fakeApi(history: Record<string, SlackMessage[][]>, threads: Record<string, SlackMessage[]> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const api: SlackApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params });
      if (method === "auth.test") return { url: WS } as T;
      if (method === "users.info") throw new SlackApiError("users.info", "missing_scope"); // names fall back to ids
      throw new Error(`unexpected ${method}`);
    },
    async *paginate<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "conversations.history") {
        for (const page of history[params.channel as string] ?? []) for (const m of page) if (Number(m.ts) > Number(params.oldest)) yield m as T;
      } else if (method === "conversations.replies") {
        for (const m of threads[`${params.channel}:${params.ts}`] ?? []) yield m as T;
      }
    },
  };
  return { api, calls };
}

describe("SlackIngester", () => {
  const now = () => 1790100000 * 1000;

  test("backfill indexes threads and single messages, skips bots, and saves a cursor", async () => {
    const db = openKnowledge(":memory:");
    const { api } = fakeApi(
      {
        C1: [
          [{ ts: "1790000001.000100", user: "U2", text: "wombat review moves to thursdays", reply_count: 1 }],
          [
            { ts: "1790000010.000100", user: "U4", text: "staging password rotates monthly" },
            { ts: "1790000020.000100", bot_id: "B1", text: "platypus build ok" },
          ],
        ],
      },
      { "C1:1790000001.000100": [{ ts: "1790000001.000100", user: "U2", text: "wombat review moves to thursdays" }, { ts: "1790000002.000100", thread_ts: "1790000001.000100", user: "U3", text: "which room?" }] },
    );
    const ing = new SlackIngester(api, db, { channels: new Set(["C1"]), refreshDays: 0, backfillDays: 30, debounceMs: 0, now });
    await ing.start();
    expect(ing.status()).toMatchObject({ state: "ready", documents: 2, channels: { C1: { cursor: "1790000020.000100", threads: 2 } } });
    expect(searcher(db)("which room for the wombat review")[0]?.id).toBe("slack:C1:1790000001.000100");
    expect(searcher(db)("platypus")).toEqual([]); // bot message not indexed
  });

  test("a restart resumes from the cursor instead of re-reading history", async () => {
    const db = openKnowledge(":memory:");
    const history = { C1: [[{ ts: "1790000001.000100", user: "U2", text: "first" }]] };
    await new SlackIngester(fakeApi(history).api, db, { channels: new Set(["C1"]), refreshDays: 0, backfillDays: 30, debounceMs: 0, now }).start();
    const second = fakeApi(history);
    await new SlackIngester(second.api, db, { channels: new Set(["C1"]), refreshDays: 0, backfillDays: 30, debounceMs: 0, now }).start();
    const historyCall = second.calls.find((c) => c.method === "conversations.history")!;
    expect(historyCall.params.oldest).toBe("1790000001.000100");
    expect(getCursor(db, "slack:C1")).toBe("1790000001.000100");
  });

  test("backfill starts backfillDays ago on first run", async () => {
    const { api, calls } = fakeApi({ C1: [[]] });
    await new SlackIngester(api, openKnowledge(":memory:"), { channels: new Set(["C1"]), refreshDays: 0, backfillDays: 10, debounceMs: 0, now }).start();
    expect(calls.find((c) => c.method === "conversations.history")!.params.oldest).toBe(String(1790100000 - 10 * 86400));
  });

  test("live messages re-read their thread once per burst, and only for allowed channels", async () => {
    const db = openKnowledge(":memory:");
    const { api, calls } = fakeApi({}, { "C1:1790000050.000100": [{ ts: "1790000050.000100", user: "U6", text: "kangaroo deploy freeze starts friday" }] });
    const ing = new SlackIngester(api, db, { channels: new Set(["C1"]), refreshDays: 0, backfillDays: 0, debounceMs: 20, now });
    await ing.start();
    ing.onRawEvent({ type: "message", channel: "C1", ts: "1790000050.000100", text: "x" });
    ing.onRawEvent({ type: "message", channel: "C1", ts: "1790000050.000100", text: "x" });
    ing.onRawEvent({ type: "message", channel: "C9", ts: "1790000099.000100", text: "x" }); // not allowed
    await Bun.sleep(60);
    expect(calls.filter((c) => c.method === "conversations.replies").map((c) => c.params.channel)).toEqual(["C1"]);
    expect(searcher(db)("kangaroo freeze")[0]?.id).toBe("slack:C1:1790000050.000100");
  });

  test("a failed backfill reports error in status, without throwing", async () => {
    const api: SlackApi = { call: async () => { throw new SlackApiError("auth.test", "invalid_auth"); }, paginate: async function* () {} };
    const ing = new SlackIngester(api, openKnowledge(":memory:"), { channels: new Set(["C1"]), refreshDays: 0, backfillDays: 1, debounceMs: 0 });
    await ing.start();
    expect(ing.status()).toMatchObject({ state: "error", error: expect.stringContaining("invalid_auth") });
  });
});

describe("slackApi", () => {
  test("honors Retry-After on 429, then succeeds", async () => {
    const slept: number[] = [];
    let n = 0;
    const f = (async () => (++n === 1 ? new Response("", { status: 429, headers: { "retry-after": "2" } }) : Response.json({ ok: true, url: WS }))) as unknown as typeof fetch;
    const api = slackApi({ token: "t", apiUrl: "http://mock/api", fetch: f, sleep: async (ms) => { slept.push(ms); } });
    expect(await api.call<{ url: string }>("auth.test")).toMatchObject({ url: WS });
    expect(slept).toEqual([2100]);
  });

  test("ok:false becomes a SlackApiError naming the method", async () => {
    const f = (async () => Response.json({ ok: false, error: "not_in_channel" })) as unknown as typeof fetch;
    await expect(slackApi({ token: "t", fetch: f }).call("conversations.history")).rejects.toThrow("slack conversations.history: not_in_channel");
  });

  test("paginate follows next_cursor and sends the token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: new Headers(init.headers).get("authorization") });
      const cursor = new URL(url).searchParams.get("cursor");
      return Response.json(cursor ? { ok: true, messages: [{ ts: "2" }] } : { ok: true, messages: [{ ts: "1" }], response_metadata: { next_cursor: "abc" } });
    }) as unknown as typeof fetch;
    const out: string[] = [];
    for await (const m of slackApi({ token: "xoxb-1", apiUrl: "http://mock/api/", fetch: f }).paginate<{ ts: string }>("conversations.history", { channel: "C1" }, "messages")) out.push(m.ts);
    expect(out).toEqual(["1", "2"]);
    expect(seen[1]!.url).toBe("http://mock/api/conversations.history?channel=C1&cursor=abc");
    expect(seen[0]!.auth).toBe("Bearer xoxb-1");
  });
});
