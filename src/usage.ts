// usage.ts — how the agent is used, to improve it: where it is asked things, which
// searches came back empty (what the lore is missing), and the 👍/👎 on its replies (what
// it gets wrong). Read through the admin API (GET /api/v1/usage), never GET /status: it
// holds what was searched for, and the status token is the one handed to monitors.
//
// By default nothing here says who asked. Usage is for finding gaps and bad answers, not
// for seeing who uses the agent and who doesn't: a record of who asks in public would make
// people think twice before asking there, and public questions are the point. An install
// may opt in to recording askers (USAGE_RECORD_PEOPLE=1, app.ts): then it is announced in
// each channel, and turning it off erases them (eraseAskers). A reaction never keeps the
// person, opted in or not, only a keyed hash (raterKey) to count each once and take back
// the right one: a named 👎 is one people hold back.
//
// Only public collaboration is counted: app.ts records nothing from a DM. Rows are kept
// USAGE_RETENTION_DAYS, the longest window the API reports, and a deleted question takes
// its ask with it (forgetAsk), as a deleted message leaves the knowledge index.

import type { Database } from "bun:sqlite";
import { createHmac } from "node:crypto";

// A message that started a turn. Slack redelivers an event it thinks went unanswered,
// and after a restart nothing remembers having seen it: the (channel, ts) key keeps
// that from counting twice.
// `user` only when the install opted in to recording askers.
export function recordAsk(db: Database, ask: { channel: string; ts: string; threadTs: string; user?: string }, now = new Date()): void {
  db.query("INSERT OR IGNORE INTO agent_asks (channel, ts, thread_ts, user_id, asked_at) VALUES (?, ?, ?, ?, ?)").run(ask.channel, ask.ts, ask.threadTs, ask.user ?? null, now.toISOString());
}

// Opted out (again): forget every asker kept while it was on. Returns how many asks lost one.
export function eraseAskers(db: Database): number {
  return db.query("UPDATE agent_asks SET user_id = NULL WHERE user_id IS NOT NULL").run().changes;
}

// Which channels still need telling that askers are recorded (on), or that they no longer
// are (off: the ones told before). A channel is marked once its notice is posted.
export function channelsToNotify(db: Database, channels: Iterable<string>, recording: boolean): string[] {
  const told = new Set((db.query("SELECT channel FROM usage_people_notices").all() as { channel: string }[]).map((r) => r.channel));
  return recording ? [...channels].filter((c) => !told.has(c)) : [...told];
}

// The channels told that askers are recorded. Until a channel has been told, its askers
// aren't recorded, even opted in: the notice comes first.
export function notifiedChannels(db: Database): Set<string> {
  return new Set((db.query("SELECT channel FROM usage_people_notices").all() as { channel: string }[]).map((r) => r.channel));
}

// Asks deleted while the app was down, found on start from what Slack still has: the
// top-level messages since `oldestSec` (a deleted root with replies reads as a tombstone,
// so it isn't among them), and each thread's messages, read only for threads with a reply
// that asked. Each ask gone from Slack is forgotten as if deleted live. Returns how many.
export async function reconcileAsks(
  db: Database,
  channel: string,
  oldestSec: number,
  present: { roots: ReadonlySet<string>; thread: (threadTs: string) => Promise<ReadonlySet<string>> },
): Promise<number> {
  const asks = db.query("SELECT ts, thread_ts AS threadTs FROM agent_asks WHERE channel = ? AND CAST(ts AS REAL) >= ?").all(channel, oldestSec) as { ts: string; threadTs: string }[];
  const gone: string[] = asks.filter((a) => a.ts === a.threadTs && !present.roots.has(a.ts)).map((a) => a.ts);
  const replies = new Map<string, string[]>();
  for (const a of asks) if (a.ts !== a.threadTs) replies.set(a.threadTs, [...(replies.get(a.threadTs) ?? []), a.ts]);
  for (const [threadTs, tss] of replies) {
    const inThread = await present.thread(threadTs);
    gone.push(...tss.filter((ts) => !inThread.has(ts)));
  }
  for (const ts of gone) forgetAsk(db, channel, ts);
  return gone.length;
}

export function markNotified(db: Database, channel: string, recording: boolean, now = new Date()): void {
  if (recording) db.query("INSERT OR IGNORE INTO usage_people_notices (channel, notified_at) VALUES (?, ?)").run(channel, now.toISOString());
  else db.query("DELETE FROM usage_people_notices WHERE channel = ?").run(channel);
}

export function recordSearch(db: Database, search: { channel: string; threadTs: string; query: string; hits: number }, now = new Date()): void {
  db.query("INSERT INTO agent_searches (channel, thread_ts, query, hits, searched_at) VALUES (?, ?, ?, ?, ?)").run(search.channel, search.threadTs, search.query, search.hits, now.toISOString());
}

// A question deleted in Slack is forgotten here too. When it was a thread's root, the
// thread's searches go with it: they were run for it and hold its words.
export function forgetAsk(db: Database, channel: string, ts: string): void {
  db.transaction(() => {
    db.query("DELETE FROM agent_asks WHERE channel = ? AND ts = ?").run(channel, ts);
    db.query("DELETE FROM agent_searches WHERE channel = ? AND thread_ts = ?").run(channel, ts);
  })();
}

export const USAGE_RETENTION_DAYS = 90;

// Drop every usage row older than the retention window. Returns how many went.
export function pruneUsage(db: Database, now = new Date()): number {
  const before = new Date(now.getTime() - USAGE_RETENTION_DAYS * 86_400_000).toISOString();
  return db.transaction(() =>
    db.query("DELETE FROM agent_asks WHERE asked_at < ?").run(before).changes +
    db.query("DELETE FROM agent_searches WHERE searched_at < ?").run(before).changes +
    db.query("DELETE FROM agent_feedback WHERE reacted_at < ?").run(before).changes,
  )();
}

// Tells one person's reactions from another's without saying who: an HMAC of their Slack
// id under a secret kept outside the database (the app passes its signing secret), so the
// rows alone can't be matched back to the workspace's members. Rotating the secret only
// means a reaction taken back after the rotation no longer finds its row.
export function raterKey(secret: string): (slackUserId: string) => string {
  return (id) => createHmac("sha256", secret).update(`lorehouse-usage-rater:${id}`).digest("hex").slice(0, 32);
}

export type Rating = "up" | "down";

// Slack names 👍 "+1" (alias "thumbsup") and 👎 "-1" ("thumbsdown"); a skin tone arrives
// as a suffix: "+1::skin-tone-3".
export function rating(reactionName: string): Rating | undefined {
  const name = reactionName.replace(/::skin-tone-\d+$/, "");
  if (name === "+1" || name === "thumbsup") return "up";
  if (name === "-1" || name === "thumbsdown") return "down";
  return undefined;
}

// A reaction as it arrives (with the person's Slack id, in memory only), and as it is kept.
export type Feedback = { channel: string; messageTs: string; user: string; rating: Rating };
export type StoredFeedback = { channel: string; messageTs: string; rater: string; rating: Rating };

type ReactionEvent = { channelId: string; user?: { id: string }; reaction?: { name: string; itemTs: string }; raw?: unknown };

// A person's 👍/👎 on a message the agent wrote, or undefined for any other reaction. The
// raw event's item_user is the reacted-to message's author. Without the agent's own id
// there is no telling its replies apart, so nothing counts.
export function feedbackOf(e: ReactionEvent, botUserId: string | undefined): Feedback | undefined {
  const user = e.user?.id;
  const r = e.reaction && rating(e.reaction.name);
  if (!botUserId || !user || user === botUserId || !r) return undefined;
  if ((e.raw as { item_user?: string } | undefined)?.item_user !== botUserId) return undefined;
  return { channel: e.channelId, messageTs: e.reaction!.itemTs, user, rating: r };
}

export function recordFeedback(db: Database, f: StoredFeedback, added: boolean, now = new Date()): void {
  if (added) db.query("INSERT OR IGNORE INTO agent_feedback (channel, message_ts, rater, rating, reacted_at) VALUES (?, ?, ?, ?, ?)").run(f.channel, f.messageTs, f.rater, f.rating, now.toISOString());
  else db.query("DELETE FROM agent_feedback WHERE channel = ? AND message_ts = ? AND rater = ? AND rating = ?").run(f.channel, f.messageTs, f.rater, f.rating);
}

export type UsageSummary = {
  since: string; // RFC 3339
  // How much and how widely the agent is asked things: messages it answered, and in how
  // many channels and threads. Never by whom.
  asks: number;
  channels: number;
  threads: number;
  // Threads where the agent searched and every search came back empty, out of the threads
  // where it searched at all; and the latest distinct queries that found nothing. A floor
  // for "couldn't answer", not a count of it: search ORs its words, so a question with no
  // real answer usually still gets hits.
  emptySearches: { threads: number; of: number; queries: string[] };
  // 👍/👎 on the agent's replies, from how many distinct raters (one grumpy person or many),
  // and the latest replies given a 👎.
  feedback: { up: number; down: number; raters: number; downMessages: { channel: string; ts: string }[] };
  // Only when the install opted in to recording askers: how many people asked, and each
  // with their asks, most first. Asks from before opting in have no asker and aren't here.
  people?: number;
  askers?: { user: string; asks: number }[];
};

const LATEST = 10;

export function usageSummary(db: Database, { since, people = false }: { since: Date; people?: boolean }): UsageSummary {
  const at = since.toISOString();
  const asks = db.query(
    `SELECT COUNT(*) AS asks, COUNT(DISTINCT channel) AS channels, COUNT(DISTINCT channel || ' ' || thread_ts) AS threads
     FROM agent_asks WHERE asked_at >= ?`,
  ).get(at) as { asks: number; channels: number; threads: number };
  const searched = db.query(
    `SELECT COUNT(*) AS of, COALESCE(SUM(best = 0), 0) AS threads
     FROM (SELECT MAX(hits) AS best FROM agent_searches WHERE searched_at >= ? GROUP BY channel, thread_ts)`,
  ).get(at) as { of: number; threads: number };
  const queries = db.query(
    "SELECT query FROM agent_searches WHERE searched_at >= ? AND hits = 0 GROUP BY query ORDER BY MAX(id) DESC LIMIT ?",
  ).all(at, LATEST) as { query: string }[];
  const feedback = db.query(
    `SELECT COALESCE(SUM(rating = 'up'), 0) AS up, COALESCE(SUM(rating = 'down'), 0) AS down, COUNT(DISTINCT rater) AS raters
     FROM agent_feedback WHERE reacted_at >= ?`,
  ).get(at) as { up: number; down: number; raters: number };
  const downMessages = db.query(
    `SELECT channel, message_ts AS ts FROM agent_feedback WHERE reacted_at >= ? AND rating = 'down'
     GROUP BY channel, message_ts ORDER BY MAX(reacted_at) DESC LIMIT ?`,
  ).all(at, LATEST) as { channel: string; ts: string }[];
  const summary: UsageSummary = {
    since: at,
    ...asks,
    emptySearches: { threads: searched.threads, of: searched.of, queries: queries.map((q) => q.query) },
    feedback: { ...feedback, downMessages },
  };
  if (!people) return summary;
  const askers = db.query(
    `SELECT user_id AS user, COUNT(*) AS asks FROM agent_asks WHERE asked_at >= ? AND user_id IS NOT NULL
     GROUP BY user_id ORDER BY asks DESC, user_id`,
  ).all(at) as { user: string; asks: number }[];
  return { ...summary, people: askers.length, askers };
}
