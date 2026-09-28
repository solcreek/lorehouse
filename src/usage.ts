// usage.ts — how the agent is used, as GET /status reports it: how many people ask it
// things and where, which questions knowledge had no answer for (what to write down
// next), and the 👍/👎 people leave on its replies.
//
// Only public collaboration is counted: app.ts records nothing from a DM.

import type { Database } from "bun:sqlite";

// A message that started a turn. Slack redelivers an event it thinks went unanswered,
// and after a restart nothing remembers having seen it: the (channel, ts) key keeps
// that from counting twice.
export function recordAsk(db: Database, ask: { channel: string; ts: string; threadTs: string; user: string }, now = new Date()): void {
  db.query("INSERT OR IGNORE INTO agent_asks (channel, ts, thread_ts, user_id, asked_at) VALUES (?, ?, ?, ?, ?)").run(ask.channel, ask.ts, ask.threadTs, ask.user, now.toISOString());
}

export function recordSearch(db: Database, search: { channel: string; threadTs: string; query: string; hits: number }, now = new Date()): void {
  db.query("INSERT INTO agent_searches (channel, thread_ts, query, hits, searched_at) VALUES (?, ?, ?, ?, ?)").run(search.channel, search.threadTs, search.query, search.hits, now.toISOString());
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

export type Feedback = { channel: string; messageTs: string; user: string; rating: Rating };

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

// Added, or taken back (a removed reaction deletes it).
export function recordFeedback(db: Database, f: Feedback, added: boolean, now = new Date()): void {
  if (added) db.query("INSERT OR IGNORE INTO agent_feedback (channel, message_ts, user_id, rating, reacted_at) VALUES (?, ?, ?, ?, ?)").run(f.channel, f.messageTs, f.user, f.rating, now.toISOString());
  else db.query("DELETE FROM agent_feedback WHERE channel = ? AND message_ts = ? AND user_id = ? AND rating = ?").run(f.channel, f.messageTs, f.user, f.rating);
}

export type UsageSummary = {
  since: string; // RFC 3339
  people: number; // distinct people who asked
  channels: number;
  threads: number;
  // Threads where the agent searched and every search came back empty, out of the threads
  // where it searched at all; and the latest distinct queries that found nothing.
  notFound: { threads: number; of: number; queries: string[] };
  // 👍/👎 on the agent's replies, by how many people, and the latest replies given a 👎.
  feedback: { up: number; down: number; people: number; downMessages: { channel: string; ts: string }[] };
};

const LATEST = 10;

export function usageSummary(db: Database, { since }: { since: Date }): UsageSummary {
  const at = since.toISOString();
  const asks = db.query(
    `SELECT COUNT(DISTINCT user_id) AS people, COUNT(DISTINCT channel) AS channels,
       (SELECT COUNT(*) FROM (SELECT DISTINCT channel, thread_ts FROM agent_asks WHERE asked_at >= ?1)) AS threads
     FROM agent_asks WHERE asked_at >= ?1`,
  ).get(at) as { people: number; channels: number; threads: number };
  const searched = db.query(
    `SELECT COUNT(*) AS of, COALESCE(SUM(best = 0), 0) AS threads
     FROM (SELECT MAX(hits) AS best FROM agent_searches WHERE searched_at >= ? GROUP BY channel, thread_ts)`,
  ).get(at) as { of: number; threads: number };
  const queries = db.query(
    "SELECT query FROM agent_searches WHERE searched_at >= ? AND hits = 0 GROUP BY query ORDER BY MAX(id) DESC LIMIT ?",
  ).all(at, LATEST) as { query: string }[];
  const feedback = db.query(
    `SELECT COALESCE(SUM(rating = 'up'), 0) AS up, COALESCE(SUM(rating = 'down'), 0) AS down, COUNT(DISTINCT user_id) AS people
     FROM agent_feedback WHERE reacted_at >= ?`,
  ).get(at) as { up: number; down: number; people: number };
  const downMessages = db.query(
    `SELECT channel, message_ts AS ts FROM agent_feedback WHERE reacted_at >= ? AND rating = 'down'
     GROUP BY channel, message_ts ORDER BY MAX(reacted_at) DESC LIMIT ?`,
  ).all(at, LATEST) as { channel: string; ts: string }[];
  return {
    since: at,
    ...asks,
    notFound: { threads: searched.threads, of: searched.of, queries: queries.map((q) => q.query) },
    feedback: { ...feedback, downMessages },
  };
}
