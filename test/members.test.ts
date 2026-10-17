// Only full members of the workspace are answered (#145): guests and people from other
// workspaces can't open every channel an answer may quote.

import { describe, expect, test } from "bun:test";
import { classifyUser, mayStartTurn, members, refusalText, type UserInfo } from "../src/members";
import { SlackApiError, type SlackApi } from "../src/slack-api";

const MEMBER: UserInfo = { id: "U1", team_id: "T1", deleted: false, is_restricted: false, is_ultra_restricted: false };

describe("classifyUser", () => {
  test("a full member of the workspace the event came to", () => {
    expect(classifyUser("U1", MEMBER, "T1")).toEqual({ user: "U1", member: true });
  });

  test("a multi-channel guest (is_restricted) and a single-channel guest (is_ultra_restricted)", () => {
    expect(classifyUser("U1", { ...MEMBER, is_restricted: true }, "T1")).toEqual({ user: "U1", member: false, reason: "guest" });
    expect(classifyUser("U1", { ...MEMBER, is_restricted: true, is_ultra_restricted: true }, "T1")).toMatchObject({ member: false, reason: "guest" });
    expect(classifyUser("U1", { ...MEMBER, is_ultra_restricted: true }, "T1")).toMatchObject({ member: false, reason: "guest" });
  });

  test("someone from another workspace: another team_id, or a stranger", () => {
    expect(classifyUser("U1", { ...MEMBER, team_id: "T9" }, "T1")).toMatchObject({ member: false, reason: "external" });
    expect(classifyUser("U1", { ...MEMBER, is_stranger: true }, "T1")).toMatchObject({ member: false, reason: "external" });
  });

  test("an Enterprise Grid member whose home team differs, but who belongs to this workspace too", () => {
    expect(classifyUser("U1", { ...MEMBER, team_id: "T2", enterprise_user: { teams: ["T2", "T1"] } }, "T1")).toMatchObject({ member: true });
    expect(classifyUser("U1", { ...MEMBER, team_id: "T2", enterprise_user: { teams: ["T2"] } }, "T1")).toMatchObject({ member: false, reason: "external" });
  });

  test("a deactivated account", () => {
    expect(classifyUser("U1", { ...MEMBER, deleted: true }, "T1")).toMatchObject({ member: false, reason: "deactivated" });
  });

  test("what Slack left unsaid fails closed", () => {
    expect(classifyUser("U1", undefined, "T1")).toMatchObject({ member: false, reason: "lookup_failed" });
    const { is_restricted: _, ...noGuestFlag } = MEMBER;
    expect(classifyUser("U1", noGuestFlag, "T1")).toMatchObject({ member: false, reason: "lookup_failed", error: "Slack didn't say whether they are a guest" });
    const { team_id: _t, ...noTeam } = MEMBER;
    expect(classifyUser("U1", noTeam, "T1")).toMatchObject({ member: false, reason: "lookup_failed", error: "Slack didn't say which workspace they belong to" });
    expect(classifyUser("U1", MEMBER, undefined)).toMatchObject({ member: false, reason: "lookup_failed" });
  });
});

describe("refusalText", () => {
  test("one line, saying why, never naming anyone", () => {
    const guest = refusalText({ user: "U1", member: false, reason: "guest" });
    expect(guest).toBe("I only answer full members of this workspace: my answers draw on every channel I read, and not all of them are open to you as a guest.");
    expect(refusalText({ user: "U1", member: false, reason: "external" })).toStartWith("I only answer full members of this workspace");
    expect(refusalText({ user: "U1", member: false, reason: "lookup_failed", error: "ratelimited" })).toStartWith("I couldn't check that you're a full member");
    for (const t of [guest, refusalText({ user: "U1", member: false, reason: "lookup_failed", error: "x" })]) {
      expect(t).not.toContain("\n");
      expect(t).not.toContain("U1");
    }
  });
});

describe("mayStartTurn", () => {
  test("a mention, a thread reply, or a DM when DMs are answered; never a top-level message or a reaction", () => {
    expect(mayStartTurn({ kind: "app_mention", channelId: "C1", ts: "1" }, false)).toBe(true);
    expect(mayStartTurn({ kind: "message", channelId: "C1", ts: "2", threadId: "1" }, false)).toBe(true);
    expect(mayStartTurn({ kind: "message", channelId: "C1", ts: "1", threadId: "1" }, false)).toBe(false);
    expect(mayStartTurn({ kind: "message", channelId: "C1", ts: "1" }, true)).toBe(false);
    expect(mayStartTurn({ kind: "message", channelId: "D1", ts: "1" }, true)).toBe(true);
    expect(mayStartTurn({ kind: "message", channelId: "D1", ts: "1" }, false)).toBe(false);
    expect(mayStartTurn({ kind: "reaction_added", channelId: "C1", ts: "1" }, true)).toBe(false);
  });
});

// users.info answers per user: info, or a Slack error code.
function usersApi(answers: Record<string, UserInfo | string>) {
  const calls: string[] = [];
  const api: SlackApi = {
    async call<T>(method: string, params: Record<string, unknown> = {}) {
      if (method !== "users.info") throw new Error(`unexpected ${method}`);
      const user = String(params.user);
      calls.push(user);
      const a = answers[user] ?? "user_not_found";
      if (typeof a === "string") throw new SlackApiError("users.info", a);
      return { ok: true, user: { id: user, ...a } } as T;
    },
    async *paginate() {},
  };
  return { api, calls };
}

describe("members", () => {
  test("a lookup that fails is a refusal, never a throw: not found, a missing scope, no answer in time", async () => {
    const { api } = usersApi({ U2: "missing_scope" });
    const m = members(api);
    expect(await m.check("U1", "T1")).toEqual({ user: "U1", member: false, reason: "lookup_failed", error: "user_not_found" });
    expect(await m.check("U2", "T1")).toMatchObject({ member: false, reason: "lookup_failed", error: "missing_scope" });
    const slow: SlackApi = { call: () => new Promise(() => {}), async *paginate() {} };
    expect(await members(slow, { timeoutMs: 20 }).check("U1", "T1")).toMatchObject({ member: false, reason: "lookup_failed", error: "no answer in 0.02 s" });
  });

  test("a verdict is cached for its TTL, a failure for a shorter one; peek never asks Slack", async () => {
    let t = 0;
    const answers: Record<string, UserInfo | string> = { U1: MEMBER, U2: "ratelimited" };
    const { api, calls } = usersApi(answers);
    const m = members(api, { now: () => t, ttlMs: 1000, failureTtlMs: 100 });
    expect(m.peek("U1")).toBeUndefined();
    expect((await m.check("U1", "T1")).member).toBe(true);
    expect((await m.check("U2", "T1")).member).toBe(false);
    expect(calls).toEqual(["U1", "U2"]);
    t = 500;
    await m.check("U1", "T1");
    await m.check("U2", "T1"); // the failure expired: asked again
    expect(calls).toEqual(["U1", "U2", "U2"]);
    expect(m.peek("U1")).toMatchObject({ member: true });
    // promoted to guest (or the other way): seen once the TTL is up
    answers.U1 = { ...MEMBER, is_restricted: true };
    t = 1001;
    expect(m.peek("U1")).toBeUndefined();
    expect(await m.check("U1", "T1")).toMatchObject({ member: false, reason: "guest" });
    expect(m.peek("U1")).toMatchObject({ reason: "guest" });
  });

  test("the cache is bounded: the oldest entry goes first", async () => {
    const { api, calls } = usersApi({ U1: MEMBER, U2: MEMBER, U3: MEMBER });
    const m = members(api, { max: 2 });
    for (const u of ["U1", "U2", "U3"]) await m.check(u, "T1");
    expect(m.peek("U1")).toBeUndefined();
    expect(m.peek("U3")).toMatchObject({ member: true });
    await m.check("U1", "T1");
    expect(calls).toEqual(["U1", "U2", "U3", "U1"]);
  });
});
