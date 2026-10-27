// members.ts — who may be answered: full members of this workspace, as Slack says (#145).
//
// An answer may quote any listed channel, so whoever reads it should be able to open every
// one of them (ADR 0005 §6: what reaches the model is what everyone who will read the
// answer may see). This gate checks the *asker* only. A full member of the workspace can
// open every public channel. Others can't, and are refused before any search or model call,
// with one line saying why. Not covered: guests who are members of a listed channel can
// read a full member's answer there. Filtering by the reply's whole audience is #155.
// Askers refused here:
//   • a guest (users.info is_restricted: a multi-channel guest; is_ultra_restricted: a
//     single-channel guest), who can open only the channels they were invited to
//   • someone from another workspace (Slack Connect, or another workspace of the same
//     Enterprise Grid org): users.info's team_id isn't this workspace, nor is it among
//     enterprise_user.teams; or Slack calls them is_stranger
//   • a deactivated account
// Answering a guest from only the channels they belong to would also be safe, but needs
// every search filtered by membership; refusing is the simplest correct rule for now.
//
// What Slack leaves unsaid fails closed, as in channel-check.ts: no is_restricted or
// is_ultra_restricted, no team_id, or a lookup that fails (missing users:read, user_not_found,
// an outage, no answer in time) counts as not a member, and the asker is told the check
// couldn't be made. A verdict is cached per user, a member's or guest's for TTL_MS (a
// guest promoted to member is answered within that), a failure for FAILURE_TTL_MS, so
// one outage doesn't refuse for long. The cache is bounded (MAX_ENTRIES, oldest first out).

import type { SlackApi } from "./slack-api";

export type UserInfo = {
  id?: string;
  team_id?: string;
  deleted?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  is_stranger?: boolean;
  enterprise_user?: { teams?: string[] };
};

export type Membership =
  | { user: string; member: true }
  | { user: string; member: false; reason: "guest" | "external" | "deactivated" }
  | { user: string; member: false; reason: "lookup_failed"; error: string };

// A full member of `team` (the workspace the event came to), as users.info describes them.
export function classifyUser(user: string, info: UserInfo | undefined, team: string | undefined): Membership {
  if (!info || typeof info !== "object") return { user, member: false, reason: "lookup_failed", error: "Slack's answer had no user" };
  if (info.deleted) return { user, member: false, reason: "deactivated" };
  if (info.is_restricted || info.is_ultra_restricted) return { user, member: false, reason: "guest" };
  if (info.is_stranger) return { user, member: false, reason: "external" };
  if (info.is_restricted !== false || info.is_ultra_restricted !== false) return { user, member: false, reason: "lookup_failed", error: "Slack didn't say whether they are a guest" };
  if (typeof info.team_id !== "string" || !info.team_id) return { user, member: false, reason: "lookup_failed", error: "Slack didn't say which workspace they belong to" };
  if (!team) return { user, member: false, reason: "lookup_failed", error: "the event didn't say which workspace it came to" };
  if (info.team_id !== team && !(info.enterprise_user?.teams ?? []).includes(team)) return { user, member: false, reason: "external" };
  return { user, member: true };
}

// The one line a refused asker gets, in place of an answer.
export function refusalText(m: Membership): string {
  if (m.member) return "";
  const why = "my answers draw on every channel I read, and not all of them are open to you";
  switch (m.reason) {
    case "guest": return `I only answer full members of this workspace: ${why} as a guest.`;
    case "external":
    case "deactivated": return `I only answer full members of this workspace: ${why}.`;
    case "lookup_failed": return "I couldn't check that you're a full member of this workspace, so I can't answer right now; try again in a minute.";
  }
}

// Whether an event could start a turn, so its sender must be looked up first: a mention,
// a reply in a thread (a follow-up, if the agent was asked into it), or with DMs answered,
// a DM (D… ids). Top-level channel messages and reactions never start one, and aren't
// looked up: ingest waits on the lookup, and those are most of the traffic.
export function mayStartTurn(e: { kind: string; channelId: string; threadId?: string; ts: string }, dms: boolean): boolean {
  if (e.kind === "app_mention") return true;
  if (e.kind !== "message") return false;
  if (e.channelId.startsWith("D")) return dms;
  return !!e.threadId && e.threadId !== e.ts;
}

export const TTL_MS = 10 * 60_000;
export const FAILURE_TTL_MS = 30_000;
export const MAX_ENTRIES = 5000;
export const LOOKUP_TIMEOUT_MS = 10_000;

export type Members = {
  // Look the user up (or take the cached verdict). Never throws.
  check(user: string, team: string | undefined): Promise<Membership>;
  // The cached verdict for this user, without asking Slack: undefined if none, or expired.
  peek(user: string): Membership | undefined;
};

export function members(api: SlackApi, opts: { now?: () => number; ttlMs?: number; failureTtlMs?: number; max?: number; timeoutMs?: number } = {}): Members {
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? TTL_MS;
  const failureTtl = opts.failureTtlMs ?? FAILURE_TTL_MS;
  const max = opts.max ?? MAX_ENTRIES;
  const timeoutMs = opts.timeoutMs ?? LOOKUP_TIMEOUT_MS;
  // Insertion order is age: a refreshed entry is deleted and set again, so it moves last.
  const cache = new Map<string, { verdict: Membership; team: string | undefined; until: number }>();

  async function lookUp(user: string, team: string | undefined): Promise<Membership> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`no answer in ${timeoutMs / 1000} s`));
          abort.abort();
        }, timeoutMs);
      });
      const res = await Promise.race([api.call<{ user?: UserInfo }>("users.info", { user }, { signal: abort.signal }), timeout]);
      return classifyUser(user, res.user, team);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      return { user, member: false, reason: "lookup_failed", error: typeof code === "string" ? code : String(err instanceof Error ? err.message : err) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async check(user, team) {
      const hit = cache.get(user);
      if (hit && hit.team === team && hit.until > now()) return hit.verdict;
      const verdict = await lookUp(user, team);
      cache.delete(user);
      cache.set(user, { verdict, team, until: now() + (verdict.member || verdict.reason !== "lookup_failed" ? ttl : failureTtl) });
      while (cache.size > max) cache.delete(cache.keys().next().value!);
      return verdict;
    },
    peek(user) {
      const hit = cache.get(user);
      return hit && hit.until > now() ? hit.verdict : undefined;
    },
  };
}

// What respondWhen does with an event that may start a turn, decided after the asker's
// lookup has finished (which awaits Slack): skip it when its channel was closed meanwhile
// (an hourly recheck found it private or shared, so nothing more is said there), refuse
// an asker who isn't a full member, else answer. DMs aren't listed channels.
export function decideTurn(e: { channelId: string; channelType?: string }, listed: { has(channel: string): boolean }, verdict: Membership | undefined): "answer" | "refuse" | "skip" {
  if (e.channelType !== "im" && !listed.has(e.channelId)) return "skip";
  return verdict?.member ? "answer" : "refuse";
}
