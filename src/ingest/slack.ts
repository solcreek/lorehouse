// ingest/slack.ts — public Slack channels as knowledge. One document per thread (the
// root message and its replies); a message nobody replied to is a thread of one.
//
// Only channels on the agent's allowlist are read, and the channel policy has already
// dropped DMs and private channels before a live event gets here. Bot messages and
// system messages (joins, topic changes) are left out: the agent's own answers must not
// become its sources.
//
// Backfill reads history once per channel and remembers the newest message it saw, so
// a restart picks up from there. Live messages re-read their whole thread (debounced),
// which also catches replies to old threads while the app is running. Known gap: a
// reply to an old thread that arrives while the app is DOWN is not picked up until
// that thread gets another message. Edits and deletions are not synced yet.

import type { Database } from "bun:sqlite";
import { countDocuments, getCursor, setCursor, upsertDocument, type Document } from "../knowledge";
import type { SlackApi } from "../slack-api";

export type SlackMessage = {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
};

export function isHumanMessage(m: SlackMessage): boolean {
  return !m.bot_id && !m.subtype && !!m.text?.trim();
}

// Slack's markup → readable text: <@U1> → @U1, <#C1|ops> → #ops, <url|label> → label (url).
export function cleanSlackText(text: string): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<#([A-Z0-9]+)>/g, "#$1")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

export function permalink(workspaceUrl: string, channel: string, ts: string): string {
  return `${workspaceUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
}

// A thread (root first) → a document, or null when nothing in it is human-written.
export function threadDocument(channel: string, messages: SlackMessage[], workspaceUrl: string): Document | null {
  const human = messages.filter(isHumanMessage);
  const root = messages[0];
  if (!root || human.length === 0) return null;
  const lines = human.map((m) => {
    const day = new Date(Number(m.ts) * 1000).toISOString().slice(0, 10);
    return `[${day}] @${m.user ?? "unknown"}: ${cleanSlackText(m.text!)}`;
  });
  const firstLine = cleanSlackText(human[0]!.text!).split("\n")[0]!.trim();
  return {
    docId: `slack:${channel}:${root.ts}`,
    kind: "slack_thread",
    source: permalink(workspaceUrl, channel, root.ts),
    title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
    text: lines.join("\n"),
  };
}

export type IngestStatus = {
  state: "idle" | "backfilling" | "ready" | "error";
  documents: number;
  channels: Record<string, { cursor?: string; threads: number }>;
  error?: string;
};

export class SlackIngester {
  private workspaceUrl = "";
  private state: IngestStatus["state"] = "idle";
  private error?: string;
  private threadsByChannel = new Map<string, number>();
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly api: SlackApi,
    private readonly db: Database,
    private readonly opts: { channels: Set<string>; backfillDays: number; debounceMs: number; now?: () => number; log?: (msg: string) => void },
  ) {}

  // Resolve the workspace URL (for permalinks), then backfill every allowed channel.
  async start(): Promise<void> {
    this.state = "backfilling";
    try {
      const auth = await this.api.call<{ url: string }>("auth.test");
      this.workspaceUrl = auth.url;
      if (this.opts.backfillDays > 0) for (const channel of this.opts.channels) await this.backfill(channel);
      this.state = "ready";
    } catch (err) {
      this.state = "error";
      this.error = String(err);
      this.opts.log?.(`ingest: ${this.error}`);
    }
  }

  private async backfill(channel: string): Promise<void> {
    const source = `slack:${channel}`;
    const now = this.opts.now?.() ?? Date.now();
    const oldest = getCursor(this.db, source) ?? String(Math.floor(now / 1000 - this.opts.backfillDays * 86400));
    let newest = oldest;
    for await (const m of this.api.paginate<SlackMessage>("conversations.history", { channel, oldest, limit: 200 }, "messages")) {
      if (Number(m.ts) > Number(newest)) newest = m.ts;
      if (m.thread_ts && m.thread_ts !== m.ts) continue; // a broadcast reply; its thread is indexed from the root
      const thread = m.reply_count ? await this.readThread(channel, m.ts) : [m];
      this.store(channel, thread);
    }
    setCursor(this.db, source, newest);
    this.opts.log?.(`ingest: ${channel} backfilled up to ${newest}`);
  }

  private async readThread(channel: string, ts: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for await (const m of this.api.paginate<SlackMessage>("conversations.replies", { channel, ts, limit: 200 }, "messages")) out.push(m);
    return out;
  }

  private store(channel: string, thread: SlackMessage[]): void {
    const doc = threadDocument(channel, thread, this.workspaceUrl);
    if (!doc) return;
    upsertDocument(this.db, doc);
    this.threadsByChannel.set(channel, (this.threadsByChannel.get(channel) ?? 0) + 1);
  }

  // A live message: re-read its thread once things settle, then upsert it.
  onMessage(e: { channelId: string; threadId?: string; ts?: string }): void {
    if (!this.opts.channels.has(e.channelId)) return;
    const threadTs = e.threadId ?? e.ts;
    if (!threadTs) return;
    const key = `${e.channelId}:${threadTs}`;
    clearTimeout(this.pending.get(key));
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      this.readThread(e.channelId, threadTs)
        .then((thread) => this.store(e.channelId, thread))
        .catch((err) => this.opts.log?.(`ingest: thread ${key}: ${err}`));
    }, this.opts.debounceMs));
  }

  status(): IngestStatus {
    const channels: IngestStatus["channels"] = {};
    for (const c of this.opts.channels) channels[c] = { cursor: getCursor(this.db, `slack:${c}`), threads: this.threadsByChannel.get(c) ?? 0 };
    return { state: this.state, documents: countDocuments(this.db), channels, ...(this.error ? { error: this.error } : {}) };
  }
}
