// slack-users.ts — Slack user ids → the names people see, cached in slack_users.
//
// Needs the users:read scope. Without it (an app installed before the scope was added),
// lookups fail once with missing_scope and everything falls back to ids: knowledge
// still works, it just reads "U02ABC" where a name would be.

import type { Database } from "bun:sqlite";
import { SlackApiError, type SlackApi } from "../slack-api";

const REFRESH_MS = 24 * 3600 * 1000;

type UserInfo = { user?: { name?: string; real_name?: string; deleted?: boolean; profile?: { display_name?: string; real_name?: string } } };

export class SlackUsers {
  private memo = new Map<string, string>();
  private disabled = false;

  // False once Slack said the app lacks users:read: names can't be resolved this run.
  get available(): boolean {
    return !this.disabled;
  }

  constructor(
    private readonly api: SlackApi,
    private readonly db: Database,
    private readonly opts: { log?: (m: string) => void; now?: () => number } = {},
  ) {}

  // Resolve every id to a name (or leave it out of the map when it can't be resolved).
  async names(ids: Iterable<string>): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const id of new Set(ids)) {
      const n = await this.name(id);
      if (n) out.set(id, n);
    }
    return out;
  }

  private async name(id: string): Promise<string | undefined> {
    const hit = this.memo.get(id);
    if (hit) return hit;
    const now = this.opts.now?.() ?? Date.now();
    const row = this.db.query("SELECT name, updated_at FROM slack_users WHERE user_id = ?").get(id) as { name: string; updated_at: string } | null;
    if (row && now - Date.parse(row.updated_at) < REFRESH_MS) return this.remember(id, row.name);
    if (this.disabled) return row?.name;
    try {
      const info = await this.api.call<UserInfo>("users.info", { user: id });
      const u = info.user;
      const name = u?.profile?.display_name?.trim() || u?.profile?.real_name?.trim() || u?.real_name?.trim() || u?.name?.trim();
      if (!name) return row?.name;
      this.db.query("INSERT INTO slack_users (user_id, name, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at")
        .run(id, name, new Date(now).toISOString());
      return this.remember(id, name);
    } catch (err) {
      if (err instanceof SlackApiError && err.code === "missing_scope") {
        this.disabled = true; // stop asking; add users:read and reinstall the app
        this.opts.log?.("ingest: users:read scope missing — people appear as user ids");
      } else if (!(err instanceof SlackApiError && err.code === "user_not_found")) {
        throw err;
      }
      return row?.name;
    }
  }

  private remember(id: string, name: string): string {
    this.memo.set(id, name);
    return name;
  }
}
