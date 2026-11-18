// admin.ts — the admin API: what Lorehouse knows and runs, for its operators, their
// agents and, later, the Lorehouse app. It reads, with one setting it also writes: a
// channel's default repo.
//
//   GET /api/v1/documents?kind=&channel=&limit=&cursor=   the index, newest first, no text
//   GET /api/v1/documents/{id}                           one document, with its text
//   GET /api/v1/search?q=&limit=                         what search_knowledge finds, in its order
//   GET /api/v1/channels                                 each allowed channel's ingest and default repo
//   GET /api/v1/channels/{id}/repo                       one channel's default repo (#126)
//   PUT /api/v1/channels/{id}/repo                       set it: { repo: "owner/name", branch? }
//   DELETE /api/v1/channels/{id}/repo                    clear it
//   GET /api/v1/threads?limit=&cursor=                   the threads the agent was asked into
//   GET /api/v1/runners                                  connected sandbox runners
//   GET /api/v1/sandboxes?limit=&cursor=                 which runner each sandbox lives on
//   GET /api/v1/usage?days=                              who asks, empty searches, 👍/👎
//
// It returns what people wrote, so it has its own token, ADMIN_TOKEN, apart from
// STATUS_TOKEN's counts: a monitor holding the status token can't read messages. Unset,
// all of /api/ is closed (404), as if it didn't exist. The one thing written is a
// channel's default repo (channel-repos.ts): install data in LOREHOUSE_DB, never message
// text. Setting it is declarative (PUT the state wanted, DELETE for none, either safe to
// repeat), and a refusal carries a stable `code` beside its message.
// Contract: docs/admin-api.md.

import type { Database } from "./sqlite";
import type { IngestStatus } from "./ingest/slack";
import { CHANNEL_ID, clearChannelRepo, getChannelRepo, listChannelRepos, setChannelRepo, validBranch, type ChannelRepo } from "./channel-repos";
import { repoName, type RepoCheck, type RepoRef } from "./github-auth";
import { getDocument, listDocuments, searcher } from "./knowledge";
import { listPlacements } from "./runners/hub";
import { bearerMatches } from "./status-auth";
import { listThreads } from "./threads";
import type { UsageSummary } from "./usage";

type RunnerSummary = { runner: string; transport: string; online: boolean; capacity: number; running: number; version?: string; lastSeenSecs: number; mirrors?: Record<string, unknown> };

export type AdminOptions = {
  db: Database;
  // Whose data this is (tenant.ts): every answer names it.
  tenant: string;
  token?: string;
  ingest: () => IngestStatus | undefined; // undefined: no channels, so no ingest
  sandbox: "off" | "direct" | "runners";
  runners?: () => RunnerSummary[];
  usage?: (since: Date) => UsageSummary | Promise<UsageSummary>;
  // The channels on AGENT_CHANNELS: only they can have a default repo. Unset: none can.
  channels?: { has(channel: string): boolean };
  // Whether the GitHub credential can read a repo, and the branch exists (github-auth.ts,
  // checkRepo). Unset: code tools are off, so no default repo can be set.
  checkRepo?: (repo: RepoRef, branch?: string) => Promise<RepoCheck>;
  // One line per default repo set or cleared: counts and names, never a token.
  log?: (line: string) => void;
};

const KINDS = new Set(["slack_thread", "seed"]);
const EXCERPT = 300;

class BadRequest extends Error {}

// A refused write: an HTTP status, a stable machine-readable `code`, and a message that
// says what to do about it.
class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

// PUT's body is one small JSON object.
const MAX_BODY = 4096;
const REPO_METHODS = ["GET", "PUT", "DELETE"];

// A default repo as the API shows it; null when the channel has none.
const shown = (r: ChannelRepo | undefined) => (r ? { repo: r.repo, branch: r.branch, setAt: r.setAt } : null);

// Every answer, refusals included, is never kept by a shared cache: an answer holds
// message text, and a cached refusal would outlive the token it was about (a closed 404
// served on after ADMIN_TOKEN is set).
const NO_STORE = { "cache-control": "no-store" };


// A whole number from 1 to max, or the fallback when absent. Strict: "3days", "7.9" or
// "-5" are a 400, never read as something else.
function countParam(url: URL, name: string, fallback: number, max: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
  if (!(n >= 1 && n <= max)) throw new BadRequest(`${name}: a whole number from 1 to ${max}`);
  return n;
}
const limitParam = (url: URL, fallback: number, max: number) => countParam(url, "limit", fallback, max);

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
  // Every JSON answer to the token, errors included, starts with the tenant it is about.
  const json = (body: Record<string, unknown>, status = 200, headers: Record<string, string> = {}) =>
    Response.json({ tenant: opts.tenant, ...body }, { status, headers: { ...NO_STORE, ...headers } });
  const { db } = opts;

  async function route(url: URL): Promise<Response> {
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
      const repos = new Map(listChannelRepos(db).map((r) => [r.channel, r]));
      const channels = Object.entries(s.channels).map(([id, c]) => ({
        id,
        threads: c.threads,
        // The cursor is the newest message ts seen.
        lastMessageAt: c.cursor && Number.isFinite(Number(c.cursor)) ? new Date(Number(c.cursor) * 1000).toISOString() : null,
        defaultRepo: shown(repos.get(id)),
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

    if (path === "/api/v1/usage") {
      const days = countParam(url, "days", 7, 90);
      const summary = await opts.usage?.(new Date(Date.now() - days * 86_400_000));
      return summary ? json({ days, ...summary }) : json({ error: "usage isn't recorded here" }, 404);
    }

    return json({ error: "no such endpoint (docs/admin-api.md)" }, 404);
  }

  // What PUT asks for, from its body: { "repo": "owner/name", "branch": "main" } (branch
  // optional; null or left out: the repo's own default branch). Strict: a field it doesn't
  // know is refused, never ignored, so a misspelt "branch" can't silently set none.
  async function wanted(req: Request): Promise<{ repo: RepoRef; branch?: string }> {
    const example = 'send JSON like { "repo": "owner/name" } or { "repo": "owner/name", "branch": "main" }';
    const raw = await req.text();
    if (raw.length > MAX_BODY) throw new Refusal(400, "invalid_body", `the body is too long: ${example}`);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Refusal(400, "invalid_body", `the body isn't JSON: ${example}`);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refusal(400, "invalid_body", `the body isn't a JSON object: ${example}`);
    const unknown = Object.keys(body).filter((k) => k !== "repo" && k !== "branch");
    if (unknown.length) throw new Refusal(400, "invalid_body", `unknown field ${unknown.map((k) => JSON.stringify(k)).join(", ")}: the fields are "repo" and "branch"`);
    const { repo, branch } = body as { repo?: unknown; branch?: unknown };
    const named = typeof repo === "string" ? repoName(repo) : undefined;
    if (!named) throw new Refusal(400, "invalid_repo", '"repo" must be a GitHub repo as owner/name, e.g. "acme/widgets" (not a URL; an owner is up to 39 characters, a name up to 100)');
    if (branch !== undefined && branch !== null && !(typeof branch === "string" && validBranch(branch))) throw new Refusal(400, "invalid_branch", '"branch" must be a branch name, e.g. "main"; leave it out (or send null) for the repo\'s default branch');
    return { repo: named, branch: typeof branch === "string" ? branch : undefined };
  }

  // A channel's default repo: GET reads it, PUT sets it, DELETE clears it.
  async function channelRepo(req: Request, rawChannel: string): Promise<Response> {
    if (!REPO_METHODS.includes(req.method)) throw new Refusal(405, "method_not_allowed", "method not allowed: GET reads a channel's default repo, PUT sets it, DELETE clears it", { allow: REPO_METHODS.join(", ") });
    let channel = rawChannel;
    try {
      channel = decodeURIComponent(rawChannel);
    } catch { /* not a channel id either way */ }
    if (!CHANNEL_ID.test(channel)) throw new Refusal(400, "invalid_channel", "the channel must be a Slack channel id, e.g. C0123ABCD (not its name)");

    // Clearing is safe for any channel: one off AGENT_CHANNELS has none to clear.
    if (req.method === "DELETE") {
      if (clearChannelRepo(db, channel)) opts.log?.(`admin: ${channel} has no default repo now (cleared)`);
      return json({ channel, defaultRepo: null });
    }
    if (!opts.channels?.has(channel)) throw new Refusal(404, "channel_not_listed", `${channel} isn't on AGENT_CHANNELS: only a public channel the agent works in can have a default repo (a DM never does). Add it to AGENT_CHANNELS and restart, then set it`);
    if (req.method === "GET") return json({ channel, defaultRepo: shown(getChannelRepo(db, channel)) });

    const want = await wanted(req);
    const full = `${want.repo.owner}/${want.repo.name}`;
    if (!opts.checkRepo) throw new Refusal(409, "code_tools_off", "code tools are off on this install (no sandbox and no GitHub credential), so a default repo would never be used and can't be checked. Turn them on (SANDBOX_RUNNER_TOKEN or SANDBOX_URL, with a GitHub App: docs/github-app.md), restart, then set it");
    const check = await opts.checkRepo(want.repo, want.branch);
    if (!check.ok) {
      // Nothing is stored: a default the credential can't read would fail every request.
      if (check.reason === "not_installed") throw new Refusal(422, "app_not_installed", `the GitHub App isn't installed on ${full}: install it there (the App's settings, Install App, Only select repositories), then set it again`);
      if (check.reason === "not_readable") throw new Refusal(422, "repo_not_readable", `${check.detail}. Check the name, or give the credential access to it, then set it again`);
      if (check.reason === "branch_not_found") throw new Refusal(422, "branch_not_found", `${check.detail}: name a branch that exists, or leave "branch" out for the repo's default branch`);
      // Not verdicts on the repo: the install's own credential, or GitHub, is what to fix or wait for.
      if (check.reason === "credential_refused") throw new Refusal(502, "credential_refused", `GitHub refused this install's own credential (401), so ${full} couldn't be checked and nothing was changed: GITHUB_TOKEN has expired or been revoked, or GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY aren't the same App's. Fix the credential (\`lorehouse doctor\` checks it), restart, then set it again`);
      if (check.reason === "rate_limited") throw new Refusal(503, "github_rate_limited", `${check.detail}, so ${full} couldn't be checked and nothing was changed: wait${check.retryAfterSecs !== undefined ? ` ${check.retryAfterSecs} s (Retry-After)` : ""}, then set it again`, check.retryAfterSecs !== undefined ? { "retry-after": String(check.retryAfterSecs) } : {});
      throw new Refusal(502, "github_unavailable", `couldn't check ${full} with GitHub (${check.detail}); nothing was changed, try again`);
    }
    const before = getChannelRepo(db, channel);
    const now = setChannelRepo(db, { channel, repo: check.repo, branch: want.branch });
    if (before?.repo !== now.repo || before.branch !== now.branch) opts.log?.(`admin: ${channel}'s default repo is now ${now.repo}${now.branch ? ` (branch ${now.branch})` : ""}`);
    return json({ channel, defaultRepo: shown(now) });
  }

  const REPO_PATH = /^\/api\/v1\/channels\/([^/]+)\/repo$/;

  // undefined: not an admin path; the caller goes on routing.
  return async function handle(req: Request): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return undefined;
    // Closed: the same plain 404 as any path the app doesn't serve, so it doesn't say
    // there is an API here.
    if (!opts.token) return new Response("not found", { status: 404, headers: NO_STORE });
    // A refusal says nothing about the install, its tenant included.
    if (!bearerMatches(req, opts.token)) return Response.json({ error: "unauthorized: send Authorization: Bearer <ADMIN_TOKEN>" }, { status: 401, headers: { ...NO_STORE, "www-authenticate": "Bearer" } });
    try {
      // The one endpoint that also writes.
      const repo = REPO_PATH.exec(url.pathname.replace(/\/$/, ""));
      if (repo) return await channelRepo(req, repo[1]!);
      if (req.method !== "GET") return json({ error: "method not allowed: this endpoint only reads" }, 405, { allow: "GET" });
      return await route(url);
    } catch (e) {
      if (e instanceof BadRequest) return json({ error: e.message }, 400);
      if (e instanceof Refusal) return json({ error: e.message, code: e.code }, e.status, e.headers);
      throw e;
    }
  };
}
