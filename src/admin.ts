// admin.ts — the admin API: a read-only view of what Lorehouse knows and runs, for its
// operators and, later, the Lorehouse app.
//
//   GET /api/v1/documents?kind=&channel=&limit=&cursor=   the index, newest first, no text
//   GET /api/v1/documents/{id}                           one document, with its text
//   GET /api/v1/search?q=&limit=                         what search_knowledge finds, in its order
//   GET /api/v1/channels                                 each allowed channel's ingest
//   GET /api/v1/threads?limit=&cursor=                   the threads the agent was asked into
//   GET /api/v1/runners                                  connected sandbox runners
//   GET /api/v1/sandboxes?limit=&cursor=                 which runner each sandbox lives on
//
// It returns what people wrote, so it has its own token, ADMIN_TOKEN, apart from
// STATUS_TOKEN's counts: a monitor holding the status token can't read messages. Unset,
// all of /api/ is closed (404), as if it didn't exist. Nothing here writes.
// Contract: docs/admin-api.md.

import type { Database } from "bun:sqlite";
import type { IngestStatus } from "./ingest/slack";
import { getDocument, listDocuments, searcher } from "./knowledge";
import { listPlacements } from "./runners/hub";
import { bearerMatches } from "./status-auth";
import { listThreads } from "./threads";

type RunnerSummary = { runner: string; transport: string; online: boolean; capacity: number; running: number; version?: string; lastSeenSecs: number };

export type AdminOptions = {
  db: Database;
  token?: string;
  ingest: () => IngestStatus | undefined; // undefined: no channels, so no ingest
  sandbox: "off" | "direct" | "runners";
  runners?: () => RunnerSummary[];
};

const KINDS = new Set(["slack_thread", "seed"]);
const EXCERPT = 300;

class BadRequest extends Error {}

// Every answer, refusals included, is never kept by a shared cache: an answer holds
// message text, and a cached refusal would outlive the token it was about (a closed 404
// served on after ADMIN_TOKEN is set).
const NO_STORE = { "cache-control": "no-store" };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...NO_STORE, ...headers } });

function limitParam(url: URL, fallback: number, max: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= max)) throw new BadRequest(`limit: a whole number from 1 to ${max}`);
  return n;
}

// A page position: the last row's sort key and rowid, opaque to the client.
function cursorParam(url: URL): { key: string; rowid: number } | undefined {
  const raw = url.searchParams.get("cursor");
  if (raw === null) return undefined;
  try {
    const [key, rowid] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as [unknown, unknown];
    if (typeof key === "string" && Number.isSafeInteger(rowid)) return { key, rowid: rowid as number };
  } catch { /* fall through */ }
  throw new BadRequest("cursor: pass back the `next` of the previous page, as it was");
}

// One more row than asked for says whether there is a next page.
function page<T extends { rowid: number }>(rows: T[], limit: number, key: (row: T) => string) {
  const more = rows.length > limit;
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  const next = more && last ? Buffer.from(JSON.stringify([key(last), last.rowid])).toString("base64url") : null;
  return { items: shown.map(({ rowid: _, ...rest }) => rest), next };
}

export function adminRoutes(opts: AdminOptions) {
  const { db } = opts;

  function route(url: URL): Response {
    const path = url.pathname.replace(/\/$/, "");

    if (path === "/api/v1/documents") {
      const kind = url.searchParams.get("kind");
      if (kind !== null && !KINDS.has(kind)) throw new BadRequest(`kind: one of ${[...KINDS].join(", ")}`);
      const channel = url.searchParams.get("channel");
      if (channel !== null && !/^[A-Z0-9]{1,32}$/.test(channel)) throw new BadRequest("channel: a Slack channel id");
      const limit = limitParam(url, 50, 200);
      const after = cursorParam(url);
      const rows = listDocuments(db, { limit: limit + 1, kind: kind ?? undefined, prefix: channel ? `slack:${channel}:` : undefined, after: after && { updatedAt: after.key, rowid: after.rowid } });
      const { items, next } = page(rows, limit, (d) => d.updatedAt);
      return json({ documents: items, next });
    }

    if (path.startsWith("/api/v1/documents/")) {
      let id: string;
      try {
        id = decodeURIComponent(path.slice("/api/v1/documents/".length));
      } catch {
        throw new BadRequest("the document id isn't valid percent-encoding");
      }
      const doc = getDocument(db, id);
      return doc ? json(doc) : json({ error: `no document ${id}` }, 404);
    }

    if (path === "/api/v1/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q || q.length > 500) throw new BadRequest("q: what to search for, up to 500 characters");
      const results = searcher(db, limitParam(url, 10, 50))(q).map((c) => ({ id: c.id, source: c.source, title: c.title, excerpt: c.text.slice(0, EXCERPT) }));
      return json({ results });
    }

    if (path === "/api/v1/channels") {
      const s = opts.ingest();
      if (!s) return json({ state: "idle", channels: [] });
      const channels = Object.entries(s.channels).map(([id, c]) => ({
        id,
        threads: c.threads,
        // The cursor is the newest message ts seen.
        lastMessageAt: c.cursor && Number.isFinite(Number(c.cursor)) ? new Date(Number(c.cursor) * 1000).toISOString() : null,
      }));
      return json({ state: s.state, ...(s.error ? { error: s.error } : {}), channels });
    }

    if (path === "/api/v1/threads") {
      const limit = limitParam(url, 50, 200);
      const after = cursorParam(url);
      const rows = listThreads(db, { limit: limit + 1, after: after && { joinedAt: after.key, rowid: after.rowid } });
      const { items, next } = page(rows, limit, (t) => t.joinedAt);
      return json({ threads: items, next });
    }

    if (path === "/api/v1/runners") {
      return json({ mode: opts.sandbox, runners: opts.runners?.() ?? [] });
    }

    if (path === "/api/v1/sandboxes") {
      const limit = limitParam(url, 50, 200);
      const after = cursorParam(url);
      const rows = listPlacements(db, { limit: limit + 1, after: after && { placedAt: after.key, rowid: after.rowid } });
      const { items, next } = page(rows, limit, (p) => p.placedAt);
      return json({ sandboxes: items, next });
    }

    return json({ error: "no such endpoint (docs/admin-api.md)" }, 404);
  }

  // undefined: not an admin path; the caller goes on routing.
  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return undefined;
    // Closed: the same plain 404 as any path the app doesn't serve, so it doesn't say
    // there is an API here.
    if (!opts.token) return new Response("not found", { status: 404, headers: NO_STORE });
    if (!bearerMatches(req, opts.token)) return json({ error: "unauthorized: send Authorization: Bearer <ADMIN_TOKEN>" }, 401, { "www-authenticate": "Bearer" });
    if (req.method !== "GET") return json({ error: "method not allowed: the admin API only reads" }, 405, { allow: "GET" });
    try {
      return route(url);
    } catch (e) {
      if (e instanceof BadRequest) return json({ error: e.message }, 400);
      throw e;
    }
  };
}
