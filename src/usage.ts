// usage.ts — how the agent is used, as GET /status reports it: how many people ask it
// things and where, and which questions knowledge had no answer for (what to write down
// next).
//
// Only public collaboration is counted: app.ts records nothing from a DM.

import type { Database } from "bun:sqlite";

// A message that started a turn. Slack redelivers an event it thinks went unanswered,
// and after a restart nothing remembers having seen it: the (channel, ts) key keeps
// that from counting twice.
export function recordAsk(db: Database, ask: { channel: string; ts: string; threadTs: string; user: string }, now = new Date()): void {
  db.query("INSERT OR IGNORE INTO agent_asks (channel, ts, thread_ts, user, at) VALUES (?, ?, ?, ?, ?)").run(ask.channel, ask.ts, ask.threadTs, ask.user, now.toISOString());
}

export function recordSearch(db: Database, search: { channel: string; threadTs: string; query: string; hits: number }, now = new Date()): void {
  db.query("INSERT INTO agent_searches (channel, thread_ts, query, hits, at) VALUES (?, ?, ?, ?, ?)").run(search.channel, search.threadTs, search.query, search.hits, now.toISOString());
}

export type UsageSummary = {
  since: string; // RFC 3339
  people: number; // distinct people who asked
  channels: number;
  threads: number;
  // Threads where the agent searched and every search came back empty, out of the threads
  // where it searched at all; and the latest distinct queries that found nothing.
  notFound: { threads: number; of: number; queries: string[] };
};

const LATEST = 10;

export function usageSummary(db: Database, { since }: { since: Date }): UsageSummary {
  const at = since.toISOString();
  const asks = db.query(
    `SELECT COUNT(DISTINCT user) AS people, COUNT(DISTINCT channel) AS channels,
       (SELECT COUNT(*) FROM (SELECT DISTINCT channel, thread_ts FROM agent_asks WHERE at >= ?1)) AS threads
     FROM agent_asks WHERE at >= ?1`,
  ).get(at) as { people: number; channels: number; threads: number };
  const searched = db.query(
    `SELECT COUNT(*) AS of, COALESCE(SUM(best = 0), 0) AS threads
     FROM (SELECT MAX(hits) AS best FROM agent_searches WHERE at >= ? GROUP BY channel, thread_ts)`,
  ).get(at) as { of: number; threads: number };
  const queries = db.query(
    "SELECT query FROM agent_searches WHERE at >= ? AND hits = 0 GROUP BY query ORDER BY MAX(id) DESC LIMIT ?",
  ).all(at, LATEST) as { query: string }[];
  return {
    since: at,
    ...asks,
    notFound: { threads: searched.threads, of: searched.of, queries: queries.map((q) => q.query) },
  };
}
