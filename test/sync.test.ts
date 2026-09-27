// Keeping the index truthful: live edits and deletions, and the start-up reconcile for
// changes made while the app was down. A fake Slack whose history can change mid-test.

import { describe, expect, test } from "bun:test";
import { SlackIngester, threadOfEvent, threadVersion, type SlackMessage } from "../src/ingest/slack";
import { countDocuments, documentVersion, openKnowledge, searcher } from "../src/knowledge";
import { SlackApiError, type SlackApi } from "../src/slack-api";

const WS = "https://acme.slack.com/";
const NOW = () => 1790100000 * 1000;

// Slack, as a mutable list of messages per channel (roots and replies together).
function fakeSlack(initial: Record<string, SlackMessage[]>) {
  const channels = new Map(Object.entries(initial).map(([c, ms]) => [c, [...ms]]));
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const all = (c: string) => channels.get(c) ?? [];
  const api: SlackApi = {
    async call<T>(method: string) {
      calls.push({ method, params: {} });
      if (method === "auth.test") return { url: WS } as T;
      throw new Error(`unexpected ${method}`);
    },
    async *paginate<T>(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      const c = String(params.channel);
      if (method === "conversations.history") {
        const roots = all(c).filter((m) => (!m.thread_ts || m.thread_ts === m.ts) && Number(m.ts) > Number(params.oldest ?? 0));
        for (const r of roots) {
          const replies = all(c).filter((m) => m.thread_ts === r.ts && m.ts !== r.ts);
          yield { ...r, reply_count: replies.length || undefined, latest_reply: replies.at(-1)?.ts } as T;
        }
      } else {
        const thread = all(c).filter((m) => m.ts === params.ts || m.thread_ts === params.ts);
        if (!thread.length) throw new SlackApiError("conversations.replies", "thread_not_found");
        for (const m of thread) yield m as T;
      }
    },
  };
  return {
    api,
    calls,
    add: (c: string, m: SlackMessage) => channels.get(c)!.push(m),
    edit: (c: string, ts: string, text: string, at: string) => { const m = all(c).find((x) => x.ts === ts)!; m.text = text; m.edited = { ts: at }; },
    remove: (c: string, ts: string) => channels.set(c, all(c).filter((m) => m.ts !== ts)),
    tombstone: (c: string, ts: string) => { const m = all(c).find((x) => x.ts === ts)!; m.subtype = "tombstone"; m.text = "This message was deleted."; delete m.user; },
  };
}

const ingester = (api: SlackApi, db = openKnowledge(":memory:"), refreshDays = 14) =>
  ({ db, ing: new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 30, refreshDays, debounceMs: 10, now: NOW }) });

const THREAD = "1790000001.000100";
const baseHistory = () => ({
  C1: [
    { ts: THREAD, user: "U2", text: "the wombat review is on thursdays" },
    { ts: "1790000002.000100", thread_ts: THREAD, user: "U3", text: "which room?" },
    { ts: "1790000010.000100", user: "U4", text: "the staging password is hunter2" },
  ] as SlackMessage[],
});

describe("which thread an event touches", () => {
  test("new messages, replies, edits and deletions all resolve to their thread", () => {
    expect(threadOfEvent({ type: "message", channel: "C1", ts: "5.1" })).toEqual({ channel: "C1", threadTs: "5.1" });
    expect(threadOfEvent({ type: "message", channel: "C1", ts: "5.2", thread_ts: "5.1" })).toEqual({ channel: "C1", threadTs: "5.1" });
    expect(threadOfEvent({ type: "message", subtype: "message_changed", channel: "C1", message: { ts: "5.2", thread_ts: "5.1" } })).toEqual({ channel: "C1", threadTs: "5.1" });
    expect(threadOfEvent({ type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "5.1", previous_message: { ts: "5.1" } })).toEqual({ channel: "C1", threadTs: "5.1" });
    expect(threadOfEvent({ type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "5.2", previous_message: { ts: "5.2", thread_ts: "5.1" } })).toEqual({ channel: "C1", threadTs: "5.1" });
  });

  test("a bot's own posts and edits are skipped — the agent's streamed reply is a burst of edits", () => {
    expect(threadOfEvent({ type: "message", channel: "C1", ts: "5.3", thread_ts: "5.1", bot_id: "B1" })).toBeUndefined();
    expect(threadOfEvent({ type: "message", subtype: "message_changed", channel: "C1", message: { ts: "5.3", thread_ts: "5.1", bot_id: "B1" } })).toBeUndefined();
  });

  test("everything else is ignored", () => {
    expect(threadOfEvent({ type: "message", subtype: "channel_join", channel: "C1", ts: "5.1" })).toBeUndefined();
    expect(threadOfEvent({ type: "reaction_added", channel: "C1" })).toBeUndefined();
    expect(threadOfEvent(undefined)).toBeUndefined();
  });

  test("a thread's version is its newest message or edit", () => {
    expect(threadVersion([{ ts: "1.5" }, { ts: "3.0", edited: { ts: "9.0" } }, { ts: "4.0" }])).toBe("9.0");
    expect(threadVersion([{ ts: "1.5" }, { ts: "4.0" }])).toBe("4.0");
  });
});

describe("live edits and deletions", () => {
  test("an edit re-indexes the thread: the new text is found, the old text is gone", async () => {
    const slack = fakeSlack(baseHistory());
    const { db, ing } = ingester(slack.api);
    await ing.start();
    slack.edit("C1", THREAD, "the wombat review moved to fridays", "1790000050.000100");
    ing.onRawEvent({ type: "message", subtype: "message_changed", channel: "C1", message: { ts: THREAD } });
    await Bun.sleep(40);
    expect(searcher(db)("fridays")[0]?.id).toBe(`slack:C1:${THREAD}`);
    expect(searcher(db)("thursdays")).toEqual([]);
    expect(documentVersion(db, `slack:C1:${THREAD}`)).toBe("1790000050.000100");
  });

  test("deleting a lone message removes its document — a pasted secret stops being quotable", async () => {
    const slack = fakeSlack(baseHistory());
    const { db, ing } = ingester(slack.api);
    await ing.start();
    expect(searcher(db)("hunter2")).toHaveLength(1);
    slack.remove("C1", "1790000010.000100");
    ing.onRawEvent({ type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "1790000010.000100", previous_message: { ts: "1790000010.000100" } });
    await Bun.sleep(40);
    expect(searcher(db)("hunter2")).toEqual([]);
    expect(countDocuments(db)).toBe(1);
  });

  test("deleting a reply rewrites the thread without it", async () => {
    const slack = fakeSlack(baseHistory());
    const { db, ing } = ingester(slack.api);
    await ing.start();
    slack.remove("C1", "1790000002.000100");
    ing.onRawEvent({ type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: "1790000002.000100", previous_message: { ts: "1790000002.000100", thread_ts: THREAD } });
    await Bun.sleep(40);
    expect(searcher(db)("which room")).toEqual([]);
    expect(searcher(db)("wombat")[0]?.id).toBe(`slack:C1:${THREAD}`);
  });

  test("a deleted root with replies keeps the thread, minus the root", async () => {
    const slack = fakeSlack(baseHistory());
    const { db, ing } = ingester(slack.api);
    await ing.start();
    slack.tombstone("C1", THREAD);
    ing.onRawEvent({ type: "message", subtype: "message_deleted", channel: "C1", deleted_ts: THREAD, previous_message: { ts: THREAD } });
    await Bun.sleep(40);
    expect(searcher(db)("wombat")).toEqual([]);
    expect(searcher(db)("which room")[0]?.id).toBe(`slack:C1:${THREAD}`);
  });
});

describe("start-up reconcile: changes made while the app was down", () => {
  async function restartAfter(change: (slack: ReturnType<typeof fakeSlack>) => void, refreshDays = 14) {
    const slack = fakeSlack(baseHistory());
    const db = openKnowledge(":memory:");
    await ingester(slack.api, db, refreshDays).ing.start(); // first life
    change(slack); // while down
    const second = ingester(slack.api, db, refreshDays);
    const before = slack.calls.length;
    await second.ing.start(); // restart
    return { db, status: second.ing.status(), calls: slack.calls.slice(before) };
  }

  test("a new reply to an old thread is picked up", async () => {
    const { db, status } = await restartAfter((s) => s.add("C1", { ts: "1790000060.000100", thread_ts: THREAD, user: "U5", text: "and the koala budget too" }));
    expect(searcher(db)("koala budget")[0]?.id).toBe(`slack:C1:${THREAD}`);
    expect(status.reconciled).toEqual({ refreshed: 1, removed: 0 });
  });

  test("an edited root is picked up", async () => {
    const { db } = await restartAfter((s) => s.edit("C1", THREAD, "the wombat review moved to fridays", "1790000070.000100"));
    expect(searcher(db)("fridays")[0]?.id).toBe(`slack:C1:${THREAD}`);
  });

  test("a message deleted outright is removed", async () => {
    const { db, status } = await restartAfter((s) => s.remove("C1", "1790000010.000100"));
    expect(searcher(db)("hunter2")).toEqual([]);
    expect(status.reconciled).toEqual({ refreshed: 0, removed: 1 });
  });

  test("a root turned tombstone keeps its replies and loses its own text", async () => {
    const { db } = await restartAfter((s) => s.tombstone("C1", THREAD));
    expect(searcher(db)("wombat")).toEqual([]);
    expect(searcher(db)("which room")[0]?.id).toBe(`slack:C1:${THREAD}`);
  });

  test("nothing changed → no thread is re-read", async () => {
    const { status, calls } = await restartAfter(() => {});
    expect(status.reconciled).toEqual({ refreshed: 0, removed: 0 });
    expect(calls.filter((c) => c.method === "conversations.replies")).toEqual([]);
  });

  test("changes older than the refresh window are left alone", async () => {
    // window of 1 day before NOW excludes the fixtures (~1.2 days old)
    const { db, status } = await restartAfter((s) => s.remove("C1", "1790000010.000100"), 1);
    expect(searcher(db)("hunter2")).toHaveLength(1);
    expect(status.reconciled).toEqual({ refreshed: 0, removed: 0 });
  });
});
