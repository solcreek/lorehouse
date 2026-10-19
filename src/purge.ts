// purge.ts — a channel taken off AGENT_CHANNELS leaves Lorehouse (#82). On start, before
// the app listens, everything kept for a Slack channel no longer listed goes:
//   • its threads in the knowledge index (`slack:<channel>:…`, kind slack_thread), through
//     deleteDocument, the path a deleted message takes, so the text leaves LOREHOUSE_DB's
//     files too, the -wal included (secure_delete, migrations/0010_fts_secure_delete.sql;
//     checkpointSoon); seeds are not Slack and stay
//   • the threads the agent was asked into there (agent_threads), so follow-ups stop
//   • its ingest cursor, so listing it again reads its history afresh
//   • usage's asks and searches there, as for a deleted question (usage.ts, forgetAsk):
//     they name its threads, and a search holds the words it was run for
// A 👍/👎 (agent_feedback) stays until retention: it holds no text and no thread. An empty
// list purges everything learned from Slack.
//
// Other copies of the channel's text can remain, among them:
//   • usage records this doesn't match by channel (a search can repeat its words), until
//     pruneUsage drops them past USAGE_RETENTION_DAYS (#98);
//   • June's saved conversations in SESSIONS_DB: every turn's full tool results (whole
//     search results, not only what was quoted) and answers. They are the framework's
//     tables, which Lorehouse code doesn't touch (AGENTS.md). The channel's own threads are
//     no longer answered once it is unlisted, but any conversation whose search returned
//     its text sends that text to the model again on every later turn (#66 POC: 3 copies in
//     each request of a follow-up in a listed channel's thread), until June supports
//     redaction (junebuild/june#360). Deleting SESSIONS_DB with the app stopped erases them.
//
// pendingPurge counts the same rows without changing anything, for `lorehouse doctor`.

import type { Database } from "./sqlite";
import { checkpointSoon, deleteDocument } from "./knowledge";

export type ChannelPurge = { channel: string; documents: number; threads: number; cursors: number; asks: number; searches: number };

const SLACK_DOCS = "kind = 'slack_thread' AND doc_id >= 'slack:' AND doc_id < 'slack;'";

// Every Slack channel Lorehouse keeps something for, sorted.
function knownChannels(db: Database): string[] {
  const rows = db.query(
    `SELECT substr(doc_id, 7, instr(substr(doc_id, 7), ':') - 1) AS channel FROM knowledge_documents WHERE ${SLACK_DOCS} AND instr(substr(doc_id, 7), ':') > 1
     UNION SELECT substr(source, 7) FROM ingest_cursors WHERE source >= 'slack:' AND source < 'slack;'
     UNION SELECT channel FROM agent_threads
     UNION SELECT channel FROM agent_asks
     UNION SELECT channel FROM agent_searches`,
  ).all() as { channel: string }[];
  return rows.map((r) => r.channel).filter(Boolean).sort();
}

const docIds = (db: Database, channel: string) =>
  (db.query(`SELECT doc_id FROM knowledge_documents WHERE ${SLACK_DOCS} AND doc_id >= ? AND doc_id < ?`).all(`slack:${channel}:`, `slack:${channel}:￿`) as { doc_id: string }[]).map((r) => r.doc_id);

const n = (db: Database, sql: string, ...args: string[]) => (db.query(sql).get(...args) as { n: number }).n;

function counts(db: Database, channel: string): ChannelPurge {
  return {
    channel,
    documents: docIds(db, channel).length,
    threads: n(db, "SELECT count(*) AS n FROM agent_threads WHERE channel = ?", channel),
    cursors: n(db, "SELECT count(*) AS n FROM ingest_cursors WHERE source = ?", `slack:${channel}`),
    asks: n(db, "SELECT count(*) AS n FROM agent_asks WHERE channel = ?", channel),
    searches: n(db, "SELECT count(*) AS n FROM agent_searches WHERE channel = ?", channel),
  };
}

// What a start would purge, per channel; read-only.
export function pendingPurge(db: Database, listed: ReadonlySet<string>): ChannelPurge[] {
  return knownChannels(db).filter((c) => !listed.has(c)).map((c) => counts(db, c));
}

// Purge every channel not in `listed`; returns what went, per channel. What went leaves
// the WAL too, soon after (checkpointSoon; deleteDocument asks for it as well).
export function purgeUnlistedChannels(db: Database, listed: ReadonlySet<string>): ChannelPurge[] {
  const purged = db.transaction(() =>
    knownChannels(db).filter((c) => !listed.has(c)).map((channel): ChannelPurge => {
      let documents = 0;
      for (const id of docIds(db, channel)) if (deleteDocument(db, id)) documents++;
      return {
        channel,
        documents,
        threads: db.query("DELETE FROM agent_threads WHERE channel = ?").run(channel).changes,
        cursors: db.query("DELETE FROM ingest_cursors WHERE source = ?").run(`slack:${channel}`).changes,
        asks: db.query("DELETE FROM agent_asks WHERE channel = ?").run(channel).changes,
        searches: db.query("DELETE FROM agent_searches WHERE channel = ?").run(channel).changes,
      };
    }),
  )();
  if (purged.length) checkpointSoon(db);
  return purged;
}

// One log line per purged channel: counts only, never what was in them.
export function describePurge(p: ChannelPurge): string {
  return `purge: ${p.channel} is no longer in AGENT_CHANNELS: removed ${p.documents} document(s), ${p.threads} joined thread(s), ${p.cursors} ingest cursor(s), ${p.asks} ask(s), ${p.searches} search(es)`;
}
