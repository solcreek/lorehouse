// People by name, not by user id: in knowledge, in search, and after an upgrade.

import { describe, expect, test } from "bun:test";
import { SLACK_DOC_VERSION, SlackIngester, threadDocument, userIdsIn, type SlackMessage } from "../src/ingest/slack";
import { personName, SlackUsers, type PersonName } from "../src/ingest/slack-users";
import { openKnowledge, searcher, upsertDocument } from "../src/knowledge";
import { SlackApiError, type SlackApi } from "../src/slack-api";

const WS = "https://acme.slack.com/";
const PEOPLE: Record<string, { profile?: { display_name?: string; real_name?: string }; real_name?: string; name?: string }> = {
  U2: { profile: { display_name: "Wendy", real_name: "Wendy Wu" } },
  U3: { profile: { display_name: "", real_name: "Omar Ortiz" } }, // no display name → real name
  U4: { name: "kai" }, // only a handle
  U5: { name: "hana", profile: { display_name: "hkato", real_name: "Hana Kato" } }, // a display name that reads like a handle
  U6: { name: "marco", profile: { display_name: "Marco", real_name: "marco" } }, // same name, different case
};

const full = (m: Map<string, PersonName>) => Object.fromEntries([...m].map(([id, n]) => [id, n.full]));
const short = (m: Map<string, PersonName>) => Object.fromEntries([...m].map(([id, n]) => [id, n.short]));

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

describe("personName", () => {
  test("display and real name both show when they differ", () => {
    expect(personName({ display: "hkato", real: "Hana Kato", handle: "hana" })).toEqual({ short: "hkato", full: "hkato (Hana Kato)" });
  });

  test("one name when they match, ignoring case and surrounding space", () => {
    expect(personName({ display: "Marco", real: " marco " })).toEqual({ short: "Marco", full: "Marco" });
  });

  test("falls back real name → handle → nothing; blanks count as missing", () => {
    expect(personName({ display: " ", real: "Omar Ortiz" })).toEqual({ short: "Omar Ortiz", full: "Omar Ortiz" });
    expect(personName({ display: "", real: "", handle: "kai" })).toEqual({ short: "kai", full: "kai" });
    expect(personName({ display: "Wendy" })).toEqual({ short: "Wendy", full: "Wendy" });
    expect(personName({})).toBeUndefined();
    expect(personName({ display: " ", real: "", handle: "" })).toBeUndefined();
  });
});

describe("SlackUsers", () => {
  test("display name, else real name, else handle; both names when they differ; unknown users stay unresolved", async () => {
    const names = await new SlackUsers(fakeApi().api, openKnowledge(":memory:")).names(["U2", "U3", "U4", "U5", "U6", "U404"]);
    expect(short(names)).toEqual({ U2: "Wendy", U3: "Omar Ortiz", U4: "kai", U5: "hkato", U6: "Marco" });
    expect(full(names)).toEqual({ U2: "Wendy (Wendy Wu)", U3: "Omar Ortiz", U4: "kai", U5: "hkato (Hana Kato)", U6: "Marco" });
  });

  test("names are cached: a second resolver on the same database doesn't call Slack", async () => {
    const db = openKnowledge(":memory:");
    await new SlackUsers(fakeApi().api, db).names(["U2"]);
    const second = fakeApi();
    expect(full(await new SlackUsers(second.api, db).names(["U2"]))).toEqual({ U2: "Wendy (Wendy Wu)" });
    expect(second.calls).toEqual([]);
  });

  test("a row cached before both names were kept is re-fetched, and updated in place", async () => {
    const db = openKnowledge(":memory:");
    db.query("INSERT INTO slack_users (user_id, name, updated_at) VALUES ('U5', 'hkato', ?)").run(new Date().toISOString());
    const { api, calls } = fakeApi();
    expect(full(await new SlackUsers(api, db).names(["U5"]))).toEqual({ U5: "hkato (Hana Kato)" });
    expect(calls).toEqual(["users.info:U5"]);
    expect(db.query("SELECT name, display_name, real_name FROM slack_users WHERE user_id = 'U5'").get())
      .toEqual({ name: "hana", display_name: "hkato", real_name: "Hana Kato" });
  });

  test("an old row still names the person when Slack can't be asked", async () => {
    const db = openKnowledge(":memory:");
    db.query("INSERT INTO slack_users (user_id, name, updated_at) VALUES ('U5', 'hkato', ?)").run(new Date().toISOString());
    expect(full(await new SlackUsers(fakeApi({ scope: false }).api, db).names(["U5"]))).toEqual({ U5: "hkato" });
  });

  test("names older than a day are refreshed", async () => {
    const db = openKnowledge(":memory:");
    const t0 = Date.parse("2026-09-01T00:00:00Z");
    await new SlackUsers(fakeApi().api, db, { now: () => t0 }).names(["U2"]);
    const soon = fakeApi();
    await new SlackUsers(soon.api, db, { now: () => t0 + 23 * 3600e3 }).names(["U2"]);
    expect(soon.calls).toEqual([]);
    const later = fakeApi();
    await new SlackUsers(later.api, db, { now: () => t0 + 25 * 3600e3 }).names(["U2"]);
    expect(later.calls).toEqual(["users.info:U2"]);
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

  const names = new Map<string, PersonName>([
    ["U2", { short: "Wendy", full: "Wendy (Wendy Wu)" }],
    ["U3", { short: "Omar Ortiz", full: "Omar Ortiz" }],
  ]);

  test("each message is a speaker line (full name, date), then its text; mentions use the short name", () => {
    expect(userIdsIn(thread).sort()).toEqual(["U2", "U3"]);
    const doc = threadDocument("C1", thread, WS, "UBOT", names)!;
    expect(doc.text).toBe(
      "— Wendy (Wendy Wu), 1970-01-01\npelican budget is 40k, cc @Omar Ortiz\n\n" +
      "— Omar Ortiz, 1970-01-01\nthanks @Wendy",
    );
    expect(doc.title).toBe("pelican budget is 40k, cc @Omar Ortiz");
  });

  test("a speaker never sits on the same line as a mention", () => {
    // the shape that was misread as one person: "hkato: @Marco …" → "Marco (hkato)"
    const doc = threadDocument("C1", [{ ts: "1.1", user: "U5", text: "<@U6> 這版可以再簡化" }], WS, "UBOT", new Map([
      ["U5", { short: "hkato", full: "hkato (Hana Kato)" }],
      ["U6", { short: "Marco", full: "Marco" }],
    ]))!;
    expect(doc.text).toBe("— hkato (Hana Kato), 1970-01-01\n@Marco 這版可以再簡化");
    for (const line of doc.text.split("\n")) expect(line.startsWith("— ") && line.includes("@")).toBe(false);
  });

  test("an unknown name falls back to Slack's own label, then the id", () => {
    const doc = threadDocument("C1", thread, WS, "UBOT")!;
    expect(doc.text).toBe("— U2, 1970-01-01\npelican budget is 40k, cc @U3\n\n— U3, 1970-01-01\nthanks @wendy.w");
  });

  test("a person's name finds the threads they wrote", async () => {
    const { api } = fakeApi({ threads: { "1.1": thread } });
    const db = openKnowledge(":memory:");
    const ing = new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 });
    await ing.start();
    await ing.refreshThread("C1", "1.1");
    expect(searcher(db)("what did Wendy say")[0]?.id).toBe("slack:C1:1.1");
    expect(searcher(db)("Wu")[0]?.id).toBe("slack:C1:1.1"); // the real name is searchable too
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

  test("threads rendered as names-1 (\"name: text\" lines) are re-rendered with speaker lines", async () => {
    const db = openKnowledge(":memory:");
    upsertDocument(db, { docId: "slack:C1:1.1", kind: "slack_thread", source: "x", title: "t", text: "[1970-01-01] Wendy: pelican budget", sourceVersion: "1.1" });
    db.query("INSERT INTO knowledge_index_meta (key, value) VALUES ('slack_doc_version', 'names-1') ON CONFLICT(key) DO UPDATE SET value = 'names-1'").run();
    const { api } = fakeApi({ threads: { "1.1": [{ ts: "1.1", user: "U2", text: "pelican budget" }] } });
    await new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0 }).start();
    expect(db.query("SELECT text FROM knowledge_documents WHERE doc_id = 'slack:C1:1.1'").get()).toEqual({ text: "— Wendy (Wendy Wu), 1970-01-01\npelican budget" });
    expect(searcher(db)("Wu")[0]?.id).toBe("slack:C1:1.1");
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
