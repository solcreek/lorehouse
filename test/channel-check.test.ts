// Every channel in AGENT_CHANNELS must be public, as conversations.info says (#86).

import { describe, expect, test } from "bun:test";
import { assertPublicChannels, classifyChannel, describeVerdict, isDefiniteFailure, lookUpChannel, lookUpChannels, type ChannelInfo } from "../src/channel-check";
import { ConfigError } from "../src/config";
import { docIdsWithPrefix, getCursor, openKnowledge } from "../src/knowledge";
import { SlackIngester } from "../src/ingest/slack";
import { SlackApiError, type SlackApi } from "../src/slack-api";

const PUBLIC: ChannelInfo = { name: "general", is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false };

describe("classifyChannel", () => {
  test("a public channel, as Slack describes one", () => {
    expect(classifyChannel("C1", PUBLIC)).toEqual({ channel: "C1", name: "general", public: true });
  });

  test("a private channel, whether it says is_private (newer, C… ids) or is_group (older, G… ids)", () => {
    expect(classifyChannel("C7", { ...PUBLIC, is_private: true })).toMatchObject({ public: false, reason: "private" });
    expect(classifyChannel("G1", { ...PUBLIC, is_channel: false, is_group: true, is_private: true })).toMatchObject({ public: false, reason: "private" });
    // is_group alone is enough, whatever is_private says
    expect(classifyChannel("G2", { ...PUBLIC, is_group: true })).toMatchObject({ public: false, reason: "private" });
  });

  test("a DM and a group DM", () => {
    expect(classifyChannel("D1", { is_im: true })).toMatchObject({ public: false, reason: "dm" });
    expect(classifyChannel("G3", { ...PUBLIC, is_mpim: true })).toMatchObject({ public: false, reason: "group_dm" });
  });

  test("an archived public channel, and a private one that is also archived reads as private", () => {
    expect(classifyChannel("C8", { ...PUBLIC, is_archived: true })).toMatchObject({ public: false, reason: "archived" });
    expect(classifyChannel("C9", { ...PUBLIC, is_private: true, is_archived: true })).toMatchObject({ public: false, reason: "private" });
  });

  test("what Slack left unsaid fails closed: no channel, or no is_private", () => {
    expect(classifyChannel("C1", undefined)).toMatchObject({ public: false, reason: "lookup_failed" });
    const { is_private: _, ...unsaid } = PUBLIC;
    expect(classifyChannel("C1", unsaid)).toMatchObject({ public: false, reason: "lookup_failed", error: "Slack didn't say whether it is private" });
  });

  test("a conversation not said to be a channel fails closed, even with is_private false", () => {
    expect(classifyChannel("C1", { is_private: false })).toMatchObject({ public: false, reason: "lookup_failed", error: "Slack didn't say it is a channel" });
    expect(classifyChannel("C1", { ...PUBLIC, is_channel: false })).toMatchObject({ public: false, reason: "lookup_failed", error: "Slack didn't say it is a channel" });
  });
});

describe("describeVerdict", () => {
  test("names the channel, with its name when Slack gave one, and why", () => {
    expect(describeVerdict(classifyChannel("C7", { ...PUBLIC, name: "board", is_private: true }))).toBe("C7 (#board) is a private channel");
    expect(describeVerdict(classifyChannel("C8", { ...PUBLIC, name: "", is_archived: true }))).toBe("C8 is archived");
    expect(describeVerdict({ channel: "C4", public: false, reason: "lookup_failed", error: "missing_scope" })).toContain("C4 couldn't be looked up, so it counts as not public: conversations.info said missing_scope (the app needs channels:read");
  });
});

// conversations.info answers per channel: info, or a Slack error code, or a thrown network error.
function infoApi(answers: Record<string, ChannelInfo | string | Error>) {
  const calls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const api: SlackApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      if (method === "auth.test") return { url: "https://acme.slack.com/" } as T;
      if (method !== "conversations.info") throw new Error(`unexpected ${method}`);
      const channel = String(params.channel);
      calls.push(channel);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Bun.sleep(1);
      inFlight--;
      const a = answers[channel] ?? "channel_not_found";
      if (a instanceof Error) throw a;
      if (typeof a === "string") throw new SlackApiError("conversations.info", a);
      return { ok: true, channel: { id: channel, ...a } } as T;
    },
    async *paginate() {},
  };
  return { api, calls, maxInFlight: () => maxInFlight };
}

describe("lookUpChannel", () => {
  test("a Slack error or a network failure is a failed lookup, never a throw", async () => {
    const { api } = infoApi({ C2: "missing_scope", C3: new TypeError("Unable to connect") });
    expect(await lookUpChannel(api, "C1")).toEqual({ channel: "C1", public: false, reason: "lookup_failed", error: "channel_not_found" });
    expect(await lookUpChannel(api, "C2")).toMatchObject({ public: false, reason: "lookup_failed", error: "missing_scope" });
    expect(await lookUpChannel(api, "C3")).toMatchObject({ public: false, reason: "lookup_failed", error: "Unable to connect" });
  });

  test("no answer in time is a failed lookup too, so a start never hangs on Slack", async () => {
    const api: SlackApi = { call: () => new Promise(() => {}), async *paginate() {} };
    expect(await lookUpChannel(api, "C1", 20)).toMatchObject({ public: false, reason: "lookup_failed", error: "no answer in 0.02 s" });
  });

  test("Slack's answer about a channel is definite; an outage isn't", () => {
    const failed = (error: string) => ({ channel: "C1", public: false as const, reason: "lookup_failed" as const, error });
    for (const e of ["channel_not_found", "missing_scope", "not_in_channel"]) expect(isDefiniteFailure(failed(e))).toBe(true);
    for (const e of ["http_503", "ratelimited", "fatal_error", "no answer in 10 s", "Unable to connect"]) expect(isDefiniteFailure(failed(e))).toBe(false);
    expect(isDefiniteFailure(classifyChannel("C1", PUBLIC))).toBe(false);
  });

  test("channels are looked up one at a time, in order", async () => {
    const { api, calls, maxInFlight } = infoApi({ C1: PUBLIC, C2: PUBLIC, C3: PUBLIC });
    expect((await lookUpChannels(api, ["C1", "C2", "C3"])).map((v) => v.public)).toEqual([true, true, true]);
    expect(calls).toEqual(["C1", "C2", "C3"]);
    expect(maxInFlight()).toBe(1);
  });
});

describe("assertPublicChannels", () => {
  test("all public: no error", async () => {
    await assertPublicChannels(infoApi({ C1: PUBLIC, C2: { ...PUBLIC, name: "random" } }).api, ["C1", "C2"]);
  });

  test("names every channel that isn't public, in one ConfigError, and not the public ones", async () => {
    const { api } = infoApi({ C1: PUBLIC, C7: { ...PUBLIC, name: "board", is_private: true }, C8: { ...PUBLIC, name: "old", is_archived: true } });
    const err = await assertPublicChannels(api, ["C1", "C7", "C8", "C404"]).then(() => undefined, (e) => e);
    expect(err).toBeInstanceOf(ConfigError);
    const problems = (err as ConfigError).problems;
    expect(problems).toHaveLength(3);
    expect(problems[0]).toStartWith("AGENT_CHANNELS (C7 (#board) is a private channel");
    expect(problems[1]).toStartWith("AGENT_CHANNELS (C8 (#old) is archived");
    expect(problems[2]).toStartWith("AGENT_CHANNELS (C404 couldn't be looked up");
    expect(problems.join(" ")).not.toContain("C1 ");
  });

  test("no channels: nothing to ask", async () => {
    const { api, calls } = infoApi({});
    await assertPublicChannels(api, []);
    expect(calls).toEqual([]);
  });
});

describe("ingest looks channels up", () => {
  const ingester = (api: SlackApi, channels: string[], logs: string[] = [], debounceMs = 0) =>
    new SlackIngester(api, openKnowledge(":memory:"), {
      channels: new Set(channels),
      backfillDays: 30,
      refreshDays: 0,
      debounceMs,
      now: () => 1790100000 * 1000,
      log: (m) => logs.push(m),
      lookUp: (c) => lookUpChannel(api, c),
    });

  // A Web API that answers conversations.info from `info` and records what it read.
  function readingApi(info: Record<string, ChannelInfo | string>) {
    const base = infoApi(info);
    const read: string[] = [];
    const api: SlackApi = {
      call: base.api.call,
      async *paginate<T>(method: string, params: Record<string, unknown>) {
        read.push(`${method} ${params.channel}`);
        yield* [] as T[];
      },
    };
    return { api, read, info };
  }

  test("before its first read: a channel found private is not read, is closed, and says so; a public one is read", async () => {
    const logs: string[] = [];
    const { api, read } = readingApi({ C1: PUBLIC, C7: { ...PUBLIC, name: "board", is_private: true } });
    const ing = ingester(api, ["C1", "C7"], logs);
    await ing.start();
    expect(read).toEqual(["conversations.history C1"]);
    expect(ing.isClosed("C7")).toBe(true);
    expect(ing.isClosed("C1")).toBe(false);
    expect(ing.status()).toMatchObject({ state: "ready", channels: { C7: { closed: "private" }, C1: {} } });
    expect(ing.status().channels.C1).not.toHaveProperty("closed");
    expect(logs.some((l) => l.includes("C7 (#board) is a private channel: no longer read"))).toBe(true);
  });

  test("an outage at the start skips reading that channel's history, but doesn't close it", async () => {
    const { api, read } = readingApi({ C1: PUBLIC, C2: "ratelimited" });
    const ing = ingester(api, ["C1", "C2"]);
    await ing.start();
    expect(read).toEqual(["conversations.history C1"]);
    expect(ing.isClosed("C2")).toBe(false);
  });

  test("a channel turned private while running: the recheck closes it, its live events are dropped, and the app doesn't crash", async () => {
    const { api, read, info } = readingApi({ C1: PUBLIC });
    const ing = ingester(api, ["C1"]);
    await ing.start();
    // While public, a live event re-reads its thread.
    read.length = 0;
    ing.onRawEvent({ type: "message", channel: "C1", ts: "1790000049.000100", text: "x" });
    await Bun.sleep(20);
    expect(read).toEqual(["conversations.replies C1"]);
    info.C1 = { ...PUBLIC, is_private: true };
    expect(await ing.recheckChannels()).toEqual([]);
    expect(ing.isClosed("C1")).toBe(true);
    read.length = 0;
    ing.onRawEvent({ type: "message", channel: "C1", ts: "1790000050.000100", text: "x" });
    await Bun.sleep(20);
    expect(read).toEqual([]);
    // Closed stays closed: a later recheck doesn't ask again, and doesn't reopen it.
    info.C1 = PUBLIC;
    await ing.recheckChannels();
    expect(ing.isClosed("C1")).toBe(true);
  });

  // What Slack likely answers for a channel turned private, to a token without groups:read.
  test("missing_scope or channel_not_found while running closes the channel too", async () => {
    const { api, info } = readingApi({ C1: PUBLIC, C2: PUBLIC });
    const ing = ingester(api, ["C1", "C2"]);
    await ing.start();
    info.C1 = "missing_scope";
    info.C2 = "channel_not_found";
    expect(await ing.recheckChannels()).toEqual([]);
    expect(ing.status().channels).toMatchObject({ C1: { closed: "missing_scope" }, C2: { closed: "channel_not_found" } });
  });

  test("a live change waiting out its debounce when the channel closes is never read", async () => {
    const { api, read, info } = readingApi({ C1: PUBLIC });
    const ing = ingester(api, ["C1"], [], 30);
    await ing.start();
    read.length = 0;
    ing.onRawEvent({ type: "message", channel: "C1", ts: "1790000050.000100", text: "x" });
    info.C1 = { ...PUBLIC, is_archived: true };
    await ing.recheckChannels();
    await Bun.sleep(60);
    expect(read).toEqual([]);
  });

  // A Web API whose history and replies for C1 run a hook before answering, so a test can
  // close the channel while ingest is mid-read.
  function midReadApi(info: Record<string, ChannelInfo | string>, onRead: (method: string, n: number) => Promise<void>) {
    const base = infoApi(info);
    let n = 0;
    const msg = (ts: string) => ({ type: "message", user: "U1", text: `note ${ts}`, ts });
    const api: SlackApi = {
      call: <T>(method: string, params?: Record<string, string | number | undefined>) =>
        method === "users.info" ? Promise.resolve({ user: { id: "U1", name: "ana", profile: { display_name: "Ana" } } } as T) : base.api.call<T>(method, params),
      async *paginate<T>(method: string, params: Record<string, unknown>) {
        if (method === "conversations.history") {
          for (const ts of ["1790000001.000100", "1790000002.000100"]) {
            await onRead(method, n++);
            yield msg(ts) as T;
          }
        } else if (method === "conversations.replies") {
          await onRead(method, n++);
          yield msg(String(params.ts)) as T;
        }
      },
    };
    return { api, info };
  }

  test("a channel closed while its history is being read keeps nothing read after, and no cursor", async () => {
    const db = openKnowledge(":memory:");
    let ing!: SlackIngester;
    const { api, info } = midReadApi({ C1: PUBLIC }, async (_method, n) => {
      if (n !== 1) return;
      info.C1 = { ...PUBLIC, is_private: true };
      await ing.recheckChannels();
    });
    ing = new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 30, refreshDays: 0, debounceMs: 0, now: () => 1790100000 * 1000, lookUp: (c) => lookUpChannel(api, c) });
    await ing.start();
    expect(ing.status().state).toBe("ready");
    expect(ing.isClosed("C1")).toBe(true);
    expect(docIdsWithPrefix(db, "slack:C1:")).toEqual(["slack:C1:1790000001.000100"]);
    expect(getCursor(db, "slack:C1")).toBeUndefined();
  });

  test("a live thread read in flight when the channel closes is not kept", async () => {
    const db = openKnowledge(":memory:");
    let ing!: SlackIngester;
    const { api, info } = midReadApi({ C1: PUBLIC }, async (method) => {
      if (method !== "conversations.replies") return;
      info.C1 = { ...PUBLIC, is_archived: true };
      await ing.recheckChannels();
    });
    ing = new SlackIngester(api, db, { channels: new Set(["C1"]), backfillDays: 0, refreshDays: 0, debounceMs: 0, now: () => 1790100000 * 1000, lookUp: (c) => lookUpChannel(api, c) });
    await ing.start();
    expect(await ing.refreshThread("C1", "1790000003.000100")).toBe("absent");
    expect(ing.isClosed("C1")).toBe(true);
    expect(docIdsWithPrefix(db, "slack:C1:")).toEqual([]);
  });

  test("a recheck called while one is still waiting on Slack shares it: one lookup per channel in flight", async () => {
    const asked: string[] = [];
    let answer!: () => void;
    const gate = new Promise<void>((r) => { answer = r; });
    const ing = new SlackIngester(infoApi({}).api, openKnowledge(":memory:"), {
      channels: new Set(["C1", "C2"]),
      backfillDays: 0,
      refreshDays: 0,
      debounceMs: 0,
      lookUp: async (c) => { asked.push(c); await gate; return { channel: c, public: true }; },
    });
    const first = ing.recheckChannels();
    const second = ing.recheckChannels();
    await Bun.sleep(10);
    expect(asked).toEqual(["C1"]);
    answer();
    expect(await Promise.all([first, second])).toEqual([[], []]);
    expect(asked).toEqual(["C1", "C2"]);
    // Once it settles, the next call asks again.
    await ing.recheckChannels();
    expect(asked).toEqual(["C1", "C2", "C1", "C2"]);
  });

  test("an outage while running changes nothing (it was public when last asked)", async () => {
    const { api, info } = readingApi({ C1: PUBLIC });
    const ing = ingester(api, ["C1"]);
    await ing.start();
    info.C1 = "fatal_error";
    expect(await ing.recheckChannels()).toEqual(["C1"]);
    expect(ing.isClosed("C1")).toBe(false);
  });
});
