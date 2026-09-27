// ingest/slack.ts — public Slack channels as knowledge. One document per thread (the
// root message and its replies); a message nobody replied to is a thread of one.
//
// Only channels on the agent's allowlist are read, and the channel policy has already
// dropped DMs and private channels before a live event gets here. Bot and system
// messages (joins, topic changes, deletion tombstones) are left out: the agent's own
// answers must not become its sources. So are messages that mention the agent: they
// are questions put to it, not knowledge.
//
// Every change funnels into one operation, refreshThread: re-read the thread, then
// upsert it — or DELETE it when Slack no longer has it or nothing human is left. What
// triggers a refresh:
//   • a new message                       (live, debounced per thread)
//   • an edit or a deletion               (live: message_changed / message_deleted)
//   • start-up reconcile, for changes made while the app was down: every thread whose
//     root is within INGEST_REFRESH_DAYS and that gained a reply, had its root edited,
//     became a tombstone, or vanished from history.
// Deletions matter most: a message someone removed (a pasted secret, a mistake) must
// stop being quotable.
//
// Known gap: an edit to a REPLY made while the app was down is not seen by the
// reconcile (Slack's history exposes a thread's latest reply, not its latest edit);
// it is picked up the next time that thread changes.

import type { Database } from "bun:sqlite";
import { countDocuments, deleteDocument, docIdsWithPrefix, documentVersion, getCursor, setCursor, upsertDocument, type Document } from "../knowledge";
import { SlackApiError, type SlackApi } from "../slack-api";
import { SlackUsers } from "./slack-users";

export type SlackMessage = {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  edited?: { ts: string };
};

// A message that is knowledge: written by a person, not a system notice, and not a
// question put to the agent (a message mentioning the bot is asking, not telling —
// indexing it would let the agent cite the question back as an answer).
export function isHumanMessage(m: SlackMessage, botUserId?: string): boolean {
  if (m.bot_id || m.subtype || !m.text?.trim()) return false;
  return !(botUserId && m.text.includes(`<@${botUserId}>`));
}

// Slack's markup → readable text: <@U1> → @Wendy (or @U1 when the name is unknown),
// <#C1|ops> → #ops, <url|label> → label (url).
export function cleanSlackText(text: string, names: Map<string, string> = new Map()): string {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label?: string) => `@${names.get(id) ?? label ?? id}`)
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

const maxTs = (a: string, b: string) => (Number(b) > Number(a) ? b : a);

// The newest message-or-edit timestamp in a thread: its freshness.
export function threadVersion(messages: SlackMessage[]): string {
  return messages.reduce((v, m) => maxTs(maxTs(v, m.ts), m.edited?.ts ?? "0"), "0");
}

// What a history listing says about a root's freshness, without reading the thread.
function rootVersion(root: SlackMessage): string {
  return maxTs(root.latest_reply ?? root.ts, root.edited?.ts ?? "0");
}

// A thread (root first) → a document, or null when nothing in it is human-written.
// Every user id a thread refers to — its authors and the people mentioned in it.
export function userIdsIn(messages: SlackMessage[]): string[] {
  const ids = new Set<string>();
  for (const m of messages) {
    if (m.user) ids.add(m.user);
    for (const [, id] of m.text?.matchAll(/<@([A-Z0-9]+)/g) ?? []) ids.add(id!);
  }
  return [...ids];
}

export function threadDocument(channel: string, messages: SlackMessage[], workspaceUrl: string, botUserId?: string, names: Map<string, string> = new Map()): Document | null {
  const human = messages.filter((m) => isHumanMessage(m, botUserId));
  const root = messages[0];
  if (!root || human.length === 0) return null;
  const lines = human.map((m) => {
    const day = new Date(Number(m.ts) * 1000).toISOString().slice(0, 10);
    const who = m.user ? (names.get(m.user) ?? m.user) : "unknown";
    return `[${day}] ${who}: ${cleanSlackText(m.text!, names)}`;
  });
  const firstLine = cleanSlackText(human[0]!.text!, names).split("\n")[0]!.trim();
  return {
    docId: threadDocId(channel, root.ts),
    kind: "slack_thread",
    source: permalink(workspaceUrl, channel, root.ts),
    title: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
    text: lines.join("\n"),
    sourceVersion: threadVersion(messages),
  };
}

export const threadDocId = (channel: string, rootTs: string) => `slack:${channel}:${rootTs}`;

// Which thread a raw Events API message event touches, for new messages, edits and
// deletions alike. Undefined for anything else.
export function threadOfEvent(ev: Record<string, unknown> | undefined): { channel: string; threadTs: string } | undefined {
  if (!ev || ev.type !== "message" || typeof ev.channel !== "string") return undefined;
  const msg = (ev.message ?? {}) as SlackMessage;
  const prev = (ev.previous_message ?? {}) as SlackMessage;
  // A bot's own posts and edits never change knowledge (bots are left out), and the
  // agent's streamed replies arrive as a burst of edits: skip them without a re-read.
  if (ev.bot_id || (ev.subtype === "message_changed" && msg.bot_id)) return undefined;
  let threadTs: string | undefined;
  if (ev.subtype === "message_changed") threadTs = msg.thread_ts ?? msg.ts;
  else if (ev.subtype === "message_deleted") threadTs = prev.thread_ts ?? (ev.deleted_ts as string | undefined);
  else if (!ev.subtype) threadTs = (ev.thread_ts as string | undefined) ?? (ev.ts as string | undefined);
  return threadTs ? { channel: ev.channel, threadTs } : undefined;
}

export type IngestStatus = {
  state: "idle" | "backfilling" | "ready" | "error";
  documents: number;
  channels: Record<string, { cursor?: string; threads: number }>;
  reconciled: { refreshed: number; removed: number };
  error?: string;
};

export type IngestOptions = {
  channels: Set<string>;
  backfillDays: number; // how far back the FIRST start reads (0 = live only)
  refreshDays: number; // how far back a start-up reconcile looks for changes (0 = off)
  debounceMs: number;
  now?: () => number;
  log?: (msg: string) => void;
};

// Bump whenever threadDocument renders differently (what it leaves out, how it names
// people, …). On the next start every stored thread is re-read and re-rendered in
// place, so old documents never keep an outdated shape.
export const SLACK_DOC_VERSION = "names-1";

export class SlackIngester {
  private workspaceUrl = "";
  private botUserId?: string;
  private readonly users: SlackUsers;
  private state: IngestStatus["state"] = "idle";
  private error?: string;
  private threadsByChannel = new Map<string, number>();
  private reconciled = { refreshed: 0, removed: 0 };
  private pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly api: SlackApi,
    private readonly db: Database,
    private readonly opts: IngestOptions,
  ) {
    this.users = new SlackUsers(api, db, { log: opts.log, now: opts.now });
  }

  // Resolve the workspace URL (for permalinks) and the bot's own user id, re-render
  // stored threads if the document shape changed, then for each allowed channel: read
  // new history since the cursor, and reconcile what changed while the app was down.
  async start(): Promise<void> {
    this.state = "backfilling";
    try {
      const auth = await this.api.call<{ url: string; user_id?: string }>("auth.test");
      this.workspaceUrl = auth.url;
      this.botUserId = auth.user_id;
      await this.rerenderIfStale();
      for (const channel of this.opts.channels) {
        if (this.opts.backfillDays > 0 || getCursor(this.db, `slack:${channel}`)) await this.backfill(channel);
        if (this.opts.refreshDays > 0) await this.reconcile(channel);
      }
      this.state = "ready";
    } catch (err) {
      this.state = "error";
      this.error = String(err);
      this.opts.log?.(`ingest: ${this.error}`);
    }
  }

  private nowSec(): number {
    return (this.opts.now?.() ?? Date.now()) / 1000;
  }

  private async rerenderIfStale(): Promise<void> {
    const row = this.db.query("SELECT value FROM knowledge_index_meta WHERE key = 'slack_doc_version'").get() as { value: string } | null;
    if (row?.value === SLACK_DOC_VERSION) return;
    let n = 0;
    for (const channel of this.opts.channels) {
      for (const docId of docIdsWithPrefix(this.db, `slack:${channel}:`)) {
        await this.refreshThread(channel, docId.slice(`slack:${channel}:`.length));
        n++;
      }
    }
    // Without users:read the re-render fell back to ids: leave the version unset so the
    // next start (after the scope is added and the app reinstalled) tries again.
    if (!this.users.available) {
      this.opts.log?.(`ingest: re-rendered ${n} threads without names; will retry once users:read is granted`);
      return;
    }
    this.db.query("INSERT INTO knowledge_index_meta (key, value) VALUES ('slack_doc_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(SLACK_DOC_VERSION);
    if (n) this.opts.log?.(`ingest: re-rendered ${n} threads for document version ${SLACK_DOC_VERSION}`);
  }

  private async backfill(channel: string): Promise<void> {
    const source = `slack:${channel}`;
    const oldest = getCursor(this.db, source) ?? String(Math.floor(this.nowSec() - this.opts.backfillDays * 86400));
    let newest = oldest;
    for await (const m of this.api.paginate<SlackMessage>("conversations.history", { channel, oldest, limit: 200 }, "messages")) {
      if (Number(m.ts) > Number(newest)) newest = m.ts;
      if (m.thread_ts && m.thread_ts !== m.ts) continue; // a broadcast reply; its thread is indexed from the root
      const thread = m.reply_count ? await this.readThread(channel, m.ts) : [m];
      if (await this.store(channel, thread)) this.threadsByChannel.set(channel, (this.threadsByChannel.get(channel) ?? 0) + 1);
    }
    setCursor(this.db, source, newest);
    this.opts.log?.(`ingest: ${channel} backfilled up to ${newest}`);
  }

  // Changes made while we were down, for threads whose root is inside the refresh window.
  private async reconcile(channel: string): Promise<void> {
    const oldest = Math.floor(this.nowSec() - this.opts.refreshDays * 86400);
    const seen = new Set<string>();
    for await (const root of this.api.paginate<SlackMessage>("conversations.history", { channel, oldest: String(oldest), limit: 200 }, "messages")) {
      if (root.thread_ts && root.thread_ts !== root.ts) continue;
      const docId = threadDocId(channel, root.ts);
      seen.add(docId);
      const stored = documentVersion(this.db, docId);
      const stale =
        root.subtype === "tombstone" // the root was deleted; its replies live on
          ? stored !== undefined
          : stored === undefined
            ? isHumanMessage(root, this.botUserId) || !!root.reply_count // new to us (the cursor can lag an edit's window)
            : stored === null || Number(rootVersion(root)) > Number(stored);
      if (stale) await this.refreshThread(channel, root.ts, "reconcile");
    }
    // Stored threads in the window that history no longer lists were deleted outright.
    for (const docId of docIdsWithPrefix(this.db, `slack:${channel}:`)) {
      const rootTs = docId.slice(`slack:${channel}:`.length);
      if (Number(rootTs) >= oldest && !seen.has(docId)) await this.refreshThread(channel, rootTs, "reconcile");
    }
  }

  private async readThread(channel: string, ts: string): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    for await (const m of this.api.paginate<SlackMessage>("conversations.replies", { channel, ts, limit: 200 }, "messages")) out.push(m);
    return out;
  }

  private async store(channel: string, thread: SlackMessage[]): Promise<boolean> {
    const names = await this.users.names(userIdsIn(thread));
    const doc = threadDocument(channel, thread, this.workspaceUrl, this.botUserId, names);
    if (!doc) return false;
    upsertDocument(this.db, doc);
    return true;
  }

  // Re-read a thread and make the index match it: upsert, or delete when Slack no
  // longer has it or nothing human is left in it.
  async refreshThread(channel: string, threadTs: string, why: "live" | "reconcile" = "live"): Promise<"updated" | "removed" | "absent"> {
    let thread: SlackMessage[];
    try {
      thread = await this.readThread(channel, threadTs);
    } catch (err) {
      if (!(err instanceof SlackApiError && (err.code === "thread_not_found" || err.code === "message_not_found"))) throw err;
      thread = [];
    }
    const docId = threadDocId(channel, threadTs);
    if (await this.store(channel, thread)) {
      if (why === "reconcile") this.reconciled.refreshed++;
      return "updated";
    }
    const removed = deleteDocument(this.db, docId);
    if (removed && why === "reconcile") this.reconciled.removed++;
    return removed ? "removed" : "absent";
  }

  // A live Events API message event (new, edited or deleted), as Slack delivered it.
  // Re-reads the thread once things settle.
  onRawEvent(ev: Record<string, unknown> | undefined): void {
    const t = threadOfEvent(ev);
    if (!t || !this.opts.channels.has(t.channel)) return;
    const key = `${t.channel}:${t.threadTs}`;
    clearTimeout(this.pending.get(key));
    this.pending.set(key, setTimeout(() => {
      this.pending.delete(key);
      this.refreshThread(t.channel, t.threadTs).catch((err) => this.opts.log?.(`ingest: thread ${key}: ${err}`));
    }, this.opts.debounceMs));
  }

  status(): IngestStatus {
    const channels: IngestStatus["channels"] = {};
    for (const c of this.opts.channels) channels[c] = { cursor: getCursor(this.db, `slack:${c}`), threads: this.threadsByChannel.get(c) ?? 0 };
    return { state: this.state, documents: countDocuments(this.db), channels, reconciled: { ...this.reconciled }, ...(this.error ? { error: this.error } : {}) };
  }
}
