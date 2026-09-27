// People by name, not by user id: in knowledge, in search, and after an upgrade.

import { describe, expect, test } from "bun:test";
import { SLACK_DOC_VERSION, SlackIngester, threadDocument, userIdsIn, type SlackMessage } from "../src/ingest/slack";
import { SlackUsers } from "../src/ingest/slack-users";
import { openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { SlackApiError, type SlackApi } from "../src/slack-api";

const WS = "https://acme.slack.com/";
const PEOPLE: Record<string, { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string }> = {
  U2: { profile: { display_name: "Wendy", real_name: "Wendy Wu" } },
  U3: { profile: { display_name: "", real_name: "Omar Ortiz" } }, // no display name → real name
  U4: { name: "kai" }, // only a handle
};

function fakeApi(opts: { scope?: boolean; threads?: Record<string, SlackMessage[]> } = {}) {
  const calls: string[] = [];
  const api: SlackApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      calls.push(`${method}:${params.user ?? ""}`);
      if (method === "auth.test") return { url: WS, user_id: "UBOT" } as T;
      if (method === "users.info") {
        if (opts.scope === false) throw new SlackApiError("users.info", "missing_scope");
        const user = PEOPLE[String(params.user)];
        if (!user) throw new SlackApiError("users.info", "user_not_found");
        return { user } as T;
      }
      throw new Error(`unexpected ${method}`);
    },
    async *paginate<T>(method: string, params: Record<string, unknown>) {
      calls.push(method);
      if (method === "conversations.replies") {
        const t = opts.threads?.[String(params.ts)];
        if (!t) throw new SlackApiError(method, "thread_not_found");
        for (const m of t) yield m as T;
      }
    },
  };
  return { api, calls };
}

describe("SlackUsers", () => {
  test("display name, else real name, else handle; unknown users stay unresolved", async () => {
    const names = await new SlackUsers(fakeApi().api, openKnowledge(":memory:")).names(["U2", "U3", "U4", "U404"]);
    expect(Object.fromEntries(names)).toEqual({ U2: "Wendy", U3: "Omar Ortiz", U4: "kai" });
  });

  test("names are cached: a second resolver on the same database doesn't call Slack", async () => {
    const db = openKnowledge(":memory:");
    await new SlackUsers(fakeApi().api, db).names(["U2"]);
    const second = fakeApi();
    expect(Object.fromEntries(await new SlackUsers(second.api, db).names(["U2"]))).toEqual({ U2: "Wendy" });
    expect(second.calls).toEqual([]);
  });

  test("without users:read it asks once, then falls back to ids quietly", async () => {
    const { api, calls } = fakeApi({ scope: false });
    const logs: string[] = [];
    const users = new SlackUsers(api, openKnowledge(":memory:"), { log: (m) => logs.push(m) });
    expect((await users.names(["U2", "U3"])).size).toBe(0);
    expect(calls.filter((c) => c.startsWith("users.info"))).toHaveLength(1);
    expect(logs).toEqual(["ingest: users:read scope missing — people appear as user ids"]);
  });
});

describe("documents name people", () => {
  const thread: SlackMessage[] = [
    { ts: "1.1", user: "U2", text: "pelican budget is 40k, cc <@U3>" },
    { ts: "1.2", thread_ts: "1.1", user: "U3", text: "thanks <@U2|wendy.w>" },
  ];

  test("authors and mentions read as names", () => {
    expect(userIdsIn(thread).sort()).toEqual(["U2", "U3"]);
    const doc = threadDocument("C1", thread, WS, "UBOT", new Map([["U2", "Wendy"], ["U3", "Omar"]]))!;
    expect(doc.text).toContain("] Wendy: pelican budget is 40k, cc @Omar");
    expect(doc.text).toContain("] Omar: thanks @Wendy");
  });

  test("an unknown name falls back to Slack's own label, then the id", () => {
    const doc = threadDocument("C1", thread, WS, "UBOT")!;
    expect(doc.text).toContain("] U2: pelican budget is 40k, cc @U3");
    expect(doc.text).toContain("] U3: thanks @wendy.w");
  });

  test("a person's name finds the threads they wrote", async () => {
    const { api } = fakeApi({ threads: { "1.1": thread } });
    const db = openKnowledge(":memory:");
    const ing = new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 });
    await ing.start();
    await ing.refreshThread("C1", "1.1");
    expect(searcher(db)("what did Wendy say")[0]?.id).toBe("slack:C1:1.1");
  });
});

describe("document version upgrade", () => {
  test("threads stored in an older shape are re-rendered in place on start", async () => {
    const db = openKnowledge(":memory:");
    // a thread as an older version stored it: ids, not names
    upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "x", title: "t", text: "[1970-01-01] U2: pelican budget", sourceVersion: "1.1" });
    db.query("INSERT INTO knowledge_index_meta (key, value) VALUES ('slack_doc_version', 'old') ON CONFLICT(key) DO UPDATE SET value = 'old'").run();
    const { api } = fakeApi({ threads: { "1.1": [{ ts: "1.1", user: "U2", text: "pelican budget" }] } });
    await new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 }).start();
    expect(searcher(db)("Wendy pelican")[0]?.id).toBe("slack:C1:1.1");
    expect(db.query("SELECT value FROM knowledge_index_meta WHERE key = 'slack_doc_version'").get()).toEqual({ value: SLACK_DOC_VERSION });
  });

  test("an upgrade without users:read is not marked done, so it retries after the scope is granted", async () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "x", title: "t", text: "[1970-01-01] U2: pelican budget", sourceVersion: "1.1" });
    const threads = { "1.1": [{ ts: "1.1", user: "U2", text: "pelican budget" }] };
    await new SlackIngester(fakeApi({ scope: false, threads }).api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 }).start();
    expect(db.query("SELECT value FROM knowledge_index_meta WHERE key = 'slack_doc_version'").get()).toBeNull();
    expect(searcher(db)("Wendy")).toEqual([]);
    // the app is reinstalled with users:read, then restarted
    await new SlackIngester(fakeApi({ threads }).api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 }).start();
    expect(searcher(db)("Wendy")[0]?.id).toBe("slack:C1:1.1");
  });

  test("a thread that is gone by the time of the upgrade is removed", async () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "slack:C1:9.9", kind: "slack_thread", source: "x", title: "t", text: "old", sourceVersion: "9.9" });
    await new SlackIngester(fakeApi().api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 }).start();
    expect(searcher(db)("old")).toEqual([]);
  });
});
