// slack-users.ts — Slack user ids → how people are named in knowledge, cached in
// slack_users.
//
// Needs the users:read scope. Without it (an app installed before the scope was added),
// lookups fail once with missing_scope and everything falls back to ids: knowledge
// still works, it just reads "U02ABC" where a name would be.

import type { Database } from "bun:sqlite";
import { SlackApiError, type SlackApi } from "../slack-api";

const REFRESH_MS = 24 * 3600 * 1000;

// How a person is named. `full` labels who is speaking; `short` is for mentions inline.
export type PersonName = { short: string; full: string };

// The naming contract. A display name is often a handle ("hkato"): on its own a
// reader, or a model, can take it for someone else's handle ("Marco (hkato)").
// So when the display name and the real name differ, the speaker label carries both:
// "hkato (Hana Kato)". Compared case-insensitively, so "Marco"/"marco" is one
// name. Falls back real name → handle → nothing.
export function personName(p: { display?: string; real?: string; handle?: string }): PersonName | undefined {
  const display = p.display?.trim() || undefined;
  const real = p.real?.trim() || undefined;
  const handle = p.handle?.trim() || undefined;
  const short = display ?? real ?? handle;
  if (!short) return undefined;
  const full = display && real && display.toLowerCase() !== real.toLowerCase() ? `${display} (${real})` : short;
  return { short, full };
}

type UserInfo = { user?: { name?: string; real_name?: string; profile?: { display_name?: string; real_name?: string } } };
type Row = { name: string; display_name: string | null; real_name: string | null; updated_at: string };

// Names already cached, without asking Slack or writing anything: for readers that must
// stay read-only (the admin API). Ids not cached are left out.
export function cachedNames(db: Database, ids: Iterable<string>): Map<string, PersonName> {
  const out = new Map<string, PersonName>();
  const stmt = db.query("SELECT name, display_name, real_name FROM slack_users WHERE user_id = ?");
  for (const id of new Set(ids)) {
    const row = stmt.get(id) as Omit<Row, "updated_at"> | null;
    const n = row && personName({ display: row.display_name ?? undefined, real: row.real_name ?? undefined, handle: row.name });
    if (n) out.set(id, n);
  }
  return out;
}

export class SlackUsers {
  private memo = new Map<string, PersonName>();
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

  // Resolve every id to a name (ids that can't be resolved are left out of the map).
  async names(ids: Iterable<string>): Promise<Map<string, PersonName>> {
    const out = new Map<string, PersonName>();
    for (const id of new Set(ids)) {
      const n = await this.name(id);
      if (n) out.set(id, n);
    }
    return out;
  }

  private async name(id: string): Promise<PersonName | undefined> {
    const hit = this.memo.get(id);
    if (hit) return hit;
    const now = this.opts.now?.() ?? Date.now();
    const row = this.db.query("SELECT name, display_name, real_name, updated_at FROM slack_users WHERE user_id = ?").get(id) as Row | null;
    const cached = row ? personName({ display: row.display_name ?? undefined, real: row.real_name ?? undefined, handle: row.name }) : undefined;
    // rows from before 0006 have neither name column: re-fetch them
    const fresh = row && (row.display_name !== null || row.real_name !== null) && now - Date.parse(row.updated_at) < REFRESH_MS;
    if (fresh && cached) return this.remember(id, cached);
    if (this.disabled) return cached;
    try {
      const u = (await this.api.call<UserInfo>("users.info", { user: id })).user;
      const display = u?.profile?.display_name?.trim() ?? "";
      const real = (u?.profile?.real_name || u?.real_name || "").trim();
      const handle = u?.name?.trim() ?? "";
      const n = personName({ display, real, handle });
      if (!n) return cached;
      this.db.query(
        `INSERT INTO slack_users (user_id, name, display_name, real_name, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, display_name = excluded.display_name, real_name = excluded.real_name, updated_at = excluded.updated_at`,
      ).run(id, handle || n.short, display, real, new Date(now).toISOString());
      return this.remember(id, n);
    } catch (err) {
      if (err instanceof SlackApiError && err.code === "missing_scope") {
        this.disabled = true; // stop asking; add users:read and reinstall the app
        this.opts.log?.("ingest: users:read scope missing — people appear as user ids");
      } else if (!(err instanceof SlackApiError && err.code === "user_not_found")) {
        throw err;
      }
      return cached;
    }
  }

  private remember(id: string, n: PersonName): PersonName {
    this.memo.set(id, n);
    return n;
  }
}
