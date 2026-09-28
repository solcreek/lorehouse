// threads.ts — carrying on a conversation in a thread without being @-mentioned again.
//
// Once someone mentions the agent in a thread, it has been asked in. A later reply there
// is a follow-up for the agent, so it answers without a new mention, which is what makes a
// back-and-forth (a question, then "and the tests?", then "now open the PR") read
// naturally. It stays out of everything else:
//   • top-level channel messages: knowledge, never a turn
//   • threads it was never asked into
//   • a reply that @-mentions the agent: Slack also sends that as an app_mention, which is
//     already answered, so answering the message too would reply twice
//   • a reply that @-mentions someone else, a user group, or the whole channel
//     (@channel, @here, @everyone): people talking to each other
// Bots and edits never get here (June normalizes only people's new messages).

import type { Database } from "bun:sqlite";

export function joinThread(db: Database, channel: string, threadTs: string, now = new Date()): void {
  db.query("INSERT INTO agent_threads (channel, thread_ts, joined_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(channel, threadTs, now.toISOString());
}

export function inThread(db: Database, channel: string, threadTs: string): boolean {
  return db.query("SELECT 1 FROM agent_threads WHERE channel = ? AND thread_ts = ?").get(channel, threadTs) !== null;
}

type FollowUpEvent = { kind: string; channelId: string; channelType: string; threadId?: string; ts: string; text?: string };

// Whether a `message` event is a follow-up the agent should answer. Any mention rules it
// out, the agent's (answered as the app_mention) or anyone else's (a conversation between
// people), so the agent's own id isn't needed. Slack encodes a user as `<@U…>` and a
// broadcast or user group as `<!channel>`, `<!here>`, `<!everyone>`, `<!subteam^S…>`; other
// `<!…>` forms such as `<!date^…>` are formatting, not mentions.
const MENTION = /<@[A-Z0-9]+|<!(?:channel|here|everyone|subteam\^)/;

export function isFollowUp(e: FollowUpEvent, joined: (channel: string, threadTs: string) => boolean): boolean {
  if (e.kind !== "message" || e.channelType !== "channel") return false;
  if (!e.threadId || e.threadId === e.ts) return false; // a top-level message
  if (MENTION.test(e.text ?? "")) return false;
  return joined(e.channelId, e.threadId);
}

// The threads the agent was asked into, newest first, each with its document when the
// thread is indexed (a thread holding only a question to the agent isn't knowledge).
export type JoinedThread = { channel: string; threadTs: string; joinedAt: string; document: string | null; source: string | null; rowid: number };

export function listThreads(db: Database, opts: { limit: number; after?: { joinedAt: string; rowid: number } }): JoinedThread[] {
  return db.query(
    `SELECT t.rowid AS rowid, t.channel, t.thread_ts AS threadTs, t.joined_at AS joinedAt, d.doc_id AS document, d.source
     FROM agent_threads t LEFT JOIN knowledge_documents d ON d.doc_id = 'slack:' || t.channel || ':' || t.thread_ts
     WHERE (?1 IS NULL OR (t.joined_at, t.rowid) < (?1, ?2))
     ORDER BY t.joined_at DESC, t.rowid DESC LIMIT ?3`,
  ).all(opts.after?.joinedAt ?? null, opts.after?.rowid ?? null, opts.limit) as JoinedThread[];
}
