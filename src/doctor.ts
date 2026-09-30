// doctor.ts — `lorehouse doctor`: checks a setup before (or while) it runs, and says
// what to fix. Every check is read-only; nothing is posted, indexed or pushed.
//
// Most setup mistakes fail silently at runtime: a bot not invited to a channel shows up
// only as a `not_in_channel` in GET /status, a missing scope as a mention that never gets
// an answer, a wrong signing secret as Slack's "Your URL didn't respond". So this asks
// each service directly, with the same environment the app would start with:
//
//   configuration  every setting loadConfig checks, all problems at once
//   slack          the bot token, its scopes (against slack/manifest.yaml), the agent's name
//   channels       each AGENT_CHANNELS id: public, and readable by the bot
//   anthropic      the API key, and that ANTHROPIC_MODEL exists
//   github         the App's key and permissions, or the token (code tools only)
//   sandbox        the direct sandbox host answers (code tools only)
//   storage        where the SQLite files go
//   deployment     with --url: /healthz, the signing secret, the admin API, and /status
//
// Exit code: 0 when nothing failed (warnings allowed), 1 when something did.

import { accessSync, constants, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHmac } from "node:crypto";
import manifest from "../slack/manifest.yaml";
import { ConfigError, loadConfig, type Config } from "./config";
import { appJwt } from "./github-auth";
import { agentIdentity, type AgentIdentity } from "./identity";
import { loadEnv, readSettings } from "./settings";
import { configToken, slackCall } from "./setup";

export type Level = "ok" | "warn" | "fail" | "info";
export type Check = { section: string; name: string; level: Level; detail: string };

export type DoctorOptions = {
  env?: Record<string, string | undefined>;
  url?: string; // the running deployment, e.g. https://lorehouse.example.com
  fetch?: typeof fetch;
  githubApiUrl?: string; // default https://api.github.com
  timeoutMs?: number; // per request, default 10 s
  settingsPath?: string; // settings.json: with a managed Slack app, Slack's side can be read too
};

const USAGE = `usage: lorehouse doctor [--url https://<your app>]

Checks the settings lorehouse would start with (the environment, /etc/lorehouse/lorehouse.env,
and what \`lorehouse setup\` stored): configuration, Slack, the model, GitHub and the sandbox.
It also checks the running deployment, at --url or wherever the app last said it was reachable.`;

// The bot scopes the app is installed with: slack/manifest.yaml is the one list.
export const MANIFEST_SCOPES: string[] = (manifest as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot;

export async function doctor(opts: DoctorOptions = {}): Promise<Check[]> {
  const env = opts.env ?? process.env;
  const checks: Check[] = [];
  const add = (section: string, name: string, level: Level, detail: string) => checks.push({ section, name, level, detail });
  const f = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // A request that never throws: a network failure comes back as `error`.
  const get = async (url: string, init: RequestInit = {}): Promise<{ res?: Response; error?: string }> => {
    try {
      return { res: await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }) };
    } catch (e) {
      return { error: e instanceof Error && e.name === "TimeoutError" ? `no answer in ${timeoutMs / 1000} s` : String(e instanceof Error ? e.message : e) };
    }
  };

  // A body that isn't JSON (a proxy's error page, some other server) reads as undefined.
  const json = async <T>(res: Response): Promise<T | undefined> => ((await res.json().catch(() => undefined)) ?? undefined) as T | undefined;

  // ── configuration ──
  let config: Config;
  let identity: AgentIdentity;
  try {
    config = loadConfig(env);
    identity = agentIdentity(config.agent.name, config.agent.coAuthor);
  } catch (e) {
    const problems = e instanceof ConfigError ? e.problems : [String(e instanceof Error ? e.message : e)];
    for (const p of problems) add("configuration", "environment", "fail", p);
    add("configuration", "environment", "info", "the other checks need a valid configuration: run `sudo lorehouse setup`, or set these in /etc/lorehouse/lorehouse.env");
    return checks;
  }
  add("configuration", "environment", "ok", `every required setting is present; agent @${identity.name}, code tools ${config.sandbox ? `on (${config.sandbox.mode})` : "off"}`);
  // Not a problem, but never a surprise: the agent tells each channel, and so does this.
  if (config.usage.recordPeople) add("configuration", "USAGE_RECORD_PEOPLE", "info", "on: usage records who asks the agent things, and each channel is told so");

  // ── slack ──
  const slackBase = (config.slack.apiUrl ?? "https://slack.com/api").replace(/\/$/, "");
  const slack = async (method: string, params: Record<string, string> = {}) => {
    const { res, error } = await get(`${slackBase}/${method}?${new URLSearchParams(params)}`, { headers: { authorization: `Bearer ${config.slack.botToken}` } });
    if (!res) return { error: error! };
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string } & Record<string, unknown>;
    return { res, body, error: body.ok ? undefined : (body.error ?? `http_${res.status}`) };
  };

  const auth = await slack("auth.test");
  if (auth.error || !auth.body) {
    add("slack", "bot token", "fail", `auth.test: ${auth.error} — is SLACK_BOT_TOKEN the app's Bot User OAuth Token (xoxb-…), for this workspace?`);
  } else {
    const botUserId = String(auth.body.user_id ?? "");
    add("slack", "bot token", "ok", `${auth.body.team ? `workspace ${auth.body.team}, ` : ""}bot user ${botUserId}`);
    if (config.slack.botUserId && config.slack.botUserId !== botUserId) {
      add("slack", "bot user id", "fail", `SLACK_BOT_USER_ID is ${config.slack.botUserId}, but the token belongs to ${botUserId}; unset it or fix it`);
    }

    // Slack reports what the token was granted on every response.
    const header = auth.res?.headers.get("x-oauth-scopes");
    if (header === null || header === undefined) {
      add("slack", "scopes", "warn", "Slack didn't report the token's scopes; compare them by hand with slack/manifest.yaml");
    } else {
      const granted = new Set(header.split(",").map((s) => s.trim()).filter(Boolean));
      // DMs arrive only with im:history, and only DM_MODE=ignore does without them.
      const needed = MANIFEST_SCOPES.filter((s) => !(s === "im:history" && config.agent.dm === "ignore"));
      const missing = needed.filter((s) => !granted.has(s));
      if (missing.length) add("slack", "scopes", "fail", `missing ${missing.join(", ")}: add under OAuth & Permissions (or re-create from slack/manifest.yaml), then reinstall the app`);
      else add("slack", "scopes", "ok", needed.join(", "));
    }

    // The name people @-mention must be the agent's own name, or the prompt and the
    // workspace disagree about who it is.
    const who = await slack("users.info", { user: botUserId });
    if (who.error || !who.body) {
      add("slack", "agent name", "warn", `not checked: users.info: ${who.error}${who.error === "missing_scope" ? " (the app needs users:read)" : ""}`);
    } else {
      const u = who.body.user as { name?: string; profile?: { display_name?: string; real_name?: string } } | undefined;
      const shown = (u?.profile?.display_name || u?.profile?.real_name || u?.name || "").trim();
      if (!shown) add("slack", "agent name", "warn", "not checked: Slack gave the bot no name");
      else if (shown.toLowerCase() !== identity.name) add("slack", "agent name", "warn", `the bot shows as "${shown}" in Slack but AGENT_NAME is "${identity.name}"; make them match`);
      else add("slack", "agent name", "ok", `@${identity.name}`);
    }
  }

  // ── channels ──
  if (!config.agent.channels.size) {
    add("channels", "AGENT_CHANNELS", "warn", "empty: the agent answers no mentions and learns nothing; set it to the public channel ids it may work in");
  } else {
    for (const channel of config.agent.channels) {
      // Public channel ids start with C; G is a private channel or group DM, D a DM.
      if (!/^C[A-Z0-9]+$/.test(channel)) {
        add("channels", channel, "fail", `not a public channel id (they start with C): the agent never works in private channels or DMs`);
        continue;
      }
      if (auth.error) {
        add("channels", channel, "info", "not checked: needs a working bot token");
        continue;
      }
      // The same read the backfill makes first.
      const h = await slack("conversations.history", { channel, limit: "1" });
      if (!h.error) add("channels", channel, "ok", "public, and the bot can read its history");
      else if (h.error === "not_in_channel") add("channels", channel, "fail", `the bot isn't a member: in that channel, /invite @${identity.name}`);
      else if (h.error === "channel_not_found") add("channels", channel, "fail", "no such public channel in this workspace (or it's private)");
      else add("channels", channel, "fail", `conversations.history: ${h.error}`);
    }
  }

  // ── anthropic ──
  {
    const base = (config.anthropic.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    const model = config.anthropic.model;
    const { res, error } = await get(`${base}/v1/models/${encodeURIComponent(model)}`, { headers: { "x-api-key": config.anthropic.apiKey, "anthropic-version": "2023-06-01" } });
    // A proxy or another server at ANTHROPIC_BASE_URL may not serve the models list.
    const other = config.anthropic.baseUrl ? "warn" : "fail";
    if (!res) add("anthropic", "API", "fail", `${base}: ${error}`);
    else if (res.ok) add("anthropic", "model", "ok", `${model}, and the key works`);
    else if (res.status === 401 || res.status === 403) add("anthropic", "API key", "fail", `refused (${res.status}): check ANTHROPIC_API_KEY`);
    else if (res.status === 404) add("anthropic", "model", other, `no model "${model}" at ${base}: check ANTHROPIC_MODEL`);
    else add("anthropic", "API", other, `${base}/v1/models answered ${res.status}`);
  }

  // ── github (code tools) ──
  const sandbox = config.sandbox;
  if (sandbox) {
    const api = (opts.githubApiUrl ?? "https://api.github.com").replace(/\/$/, "");
    const headers = { accept: "application/vnd.github+json", "user-agent": "lorehouse" };
    const gh = sandbox.github;
    // loadConfig checks only the PEM header; signing is what proves the key is one.
    let jwt: string | undefined;
    if (gh.kind === "app") {
      try {
        jwt = appJwt(gh.appId, gh.privateKey, Date.now());
      } catch (e) {
        add("github", "App", "fail", `GITHUB_APP_PRIVATE_KEY can't sign (${e instanceof Error ? e.message : e}): paste the App's whole .pem private key`);
      }
    }
    if (gh.kind === "app" && jwt) {
      const auth = { ...headers, authorization: `Bearer ${jwt}` };
      const { res, error } = await get(`${api}/app`, { headers: auth });
      const app = res?.ok ? await json<{ slug?: string; permissions?: Record<string, string> }>(res) : undefined;
      if (!res) add("github", "App", "fail", `${api}: ${error}`);
      else if (!res.ok) add("github", "App", "fail", `refused (${res.status}): GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must be the same App's, and this machine's clock right`);
      else if (!app?.slug) add("github", "App", "fail", `${api}/app answered ${res.status} without an App`);
      else {
        add("github", "App", "ok", `${app.slug}[bot]`);
        // Pushing a branch and opening a pull request (docs/github-app.md).
        const short = (["contents", "pull_requests"] as const).filter((p) => app.permissions?.[p] !== "write");
        if (short.length) add("github", "permissions", "fail", `the App needs read and write on ${short.join(" and ")}; change it under the App's Permissions, then accept the change on each installation`);
        else add("github", "permissions", "ok", "contents and pull requests: read and write");
        const inst = await get(`${api}/app/installations`, { headers: auth });
        const list = inst.res?.ok ? await json<unknown>(inst.res) : undefined;
        if (!inst.res) add("github", "installations", "fail", `${api}: ${inst.error}`);
        else if (!inst.res.ok) add("github", "installations", "fail", `${api}/app/installations answered ${inst.res.status}`);
        else if (!Array.isArray(list)) add("github", "installations", "fail", `${api}/app/installations didn't answer with a list`);
        else if (!list.length) add("github", "installations", "warn", "the App isn't installed anywhere yet: install it on the repos the agent may work on");
        else add("github", "installations", "ok", `${list.length} installation${list.length === 1 ? "" : "s"}`);
      }
    } else if (gh.kind === "token") {
      const { res, error } = await get(`${api}/user`, { headers: { ...headers, authorization: `Bearer ${gh.token}` } });
      if (!res) add("github", "token", "fail", `${api}: ${error}`);
      else if (!res.ok) add("github", "token", "fail", `refused (${res.status}): check GITHUB_TOKEN`);
      else add("github", "token", "warn", `works, as ${(await json<{ login?: string }>(res))?.login ?? "?"}; a long-lived token is for development: use a GitHub App (docs/github-app.md)`);
    }

    // ── sandbox ──
    // loadConfig checks only that SANDBOX_URL is set.
    if (sandbox.mode === "direct" && !URL.canParse(sandbox.url)) {
      add("sandbox", "host", "fail", `SANDBOX_URL "${sandbox.url}" isn't a URL`);
    } else if (sandbox.mode === "direct") {
      const url = sandbox.url.replace(/\/$/, "");
      const { res, error } = await get(`${url}/v1/sandboxes`, { headers: { authorization: `Bearer ${sandbox.token}` } });
      if (!res) add("sandbox", "host", "fail", `${url}: ${error}`);
      else if (res.status === 401) add("sandbox", "host", "fail", "refused: SANDBOX_TOKEN must be the host's SANDBOXD_TOKEN");
      else if (!res.ok) add("sandbox", "host", "fail", `${url}/v1/sandboxes answered ${res.status}`);
      else add("sandbox", "host", "ok", url);
      if (/^http:/.test(url) && !isLoopback(url)) add("sandbox", "host", "warn", "plain HTTP off this machine: the token and every command cross the network in the clear");
    } else {
      add("sandbox", "runners", "info", opts.url && config.statusToken ? "runners connect in: see deployment below" : "runners connect in, so they can only be seen on the running app: pass --url, with STATUS_TOKEN set");
    }
  }

  // ── storage ──
  for (const [key, path] of [["LOREHOUSE_DB", config.db.lorehouse], ["SESSIONS_DB", config.db.sessions]] as const) {
    if (path === ":memory:") {
      add("storage", key, "warn", key === "SESSIONS_DB" ? "in memory: conversation state is lost on every restart; set a file path" : "in memory: the index is rebuilt from Slack on every start; set a file path");
      continue;
    }
    // SQLite reads and writes the database, and in WAL mode (knowledge.ts) creates -wal
    // and -shm files beside it: the directory must be enterable and writable too.
    const full = resolve(path);
    const dir = dirname(full);
    const may = (p: string, mode: number) => { try { accessSync(p, mode); return true; } catch { return false; } };
    if (!existsSync(dir)) add("storage", key, "fail", `${dir} doesn't exist`);
    else if (!may(dir, constants.W_OK | constants.X_OK)) add("storage", key, "fail", `${dir} must be writable and enterable: SQLite keeps its -wal and -shm files there`);
    else if (existsSync(full) && !may(full, constants.R_OK | constants.W_OK)) add("storage", key, "fail", `${full} must be readable and writable`);
    else add("storage", key, "ok", existsSync(full) ? full : `${full} (created on first start)`);
  }

  // ── deployment ──
  if (!config.statusToken) add("deployment", "STATUS_TOKEN", "warn", "unset: GET /status is closed, so ingest errors show only in the logs");
  if (!opts.url) {
    add("deployment", "running app", "info", "pass --url https://<your app> to check the deployment Slack talks to");
    return checks;
  }
  // doctor() can be called without doctorMain's check.
  const url = opts.url.replace(/\/$/, "");
  if (!URL.canParse(url)) {
    add("deployment", "URL", "fail", `"${opts.url}" isn't a URL`);
    return checks;
  }
  if (!/^https:/.test(url) && !isLoopback(url)) add("deployment", "URL", "warn", "Slack delivers events only to HTTPS URLs");

  const health = await get(`${url}/healthz`);
  if (!health.res) {
    add("deployment", "/healthz", "fail", `${url}: ${health.error}`);
    return checks;
  }
  if (health.res.ok) add("deployment", "/healthz", "ok", url);
  else add("deployment", "/healthz", "fail", `answered ${health.res.status}: is this a lorehouse?`);

  // What Slack sends when a Request URL is saved, signed with our signing secret: the
  // running app answers it only if it holds the same one.
  const challenge = `doctor-${Date.now()}`;
  const body = JSON.stringify({ type: "url_verification", challenge });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = "v0=" + createHmac("sha256", config.slack.signingSecret).update(`v0:${ts}:${body}`).digest("hex");
  const verify = await get(`${url}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": ts, "x-slack-signature": signature }, body });
  const answered = verify.res?.ok ? ((await verify.res.json().catch(() => ({}))) as { challenge?: string }).challenge : undefined;
  if (answered === challenge) add("deployment", "/slack/events", "ok", "answers Slack's URL check with this SLACK_SIGNING_SECRET");
  else if (verify.res?.status === 401) add("deployment", "/slack/events", "fail", "the running app has a different SLACK_SIGNING_SECRET than this environment");
  else add("deployment", "/slack/events", "fail", verify.res ? `answered ${verify.res.status} to Slack's URL check` : String(verify.error));
  // Slack's side can't be read with a bot token. With the app's configuration token (a
  // managed app, from `lorehouse setup`), it can: compare where Slack sends events.
  const managed = opts.settingsPath ? readSettings(opts.settingsPath).slack : undefined;
  if (managed?.appId && managed.configRefreshToken) {
    try {
      const token = await configToken(opts.settingsPath!);
      const m = (await slackCall("apps.manifest.export", token, { app_id: managed.appId })).manifest as { settings?: { event_subscriptions?: { request_url?: string } } };
      const points = m.settings?.event_subscriptions?.request_url;
      if (points === `${url}/slack/events`) add("deployment", "Slack Request URL", "ok", `Slack sends events to ${points}`);
      else add("deployment", "Slack Request URL", "fail", `Slack sends events to ${points ?? "nowhere"}, not here: restart lorehouse to repoint it, or check LOREHOUSE_PUBLIC_URL`);
    } catch (e) {
      add("deployment", "Slack Request URL", "warn", `couldn't read the Slack app's settings: ${(e as Error).message}`);
    }
  } else add("deployment", "Slack app settings", "info", `Event Subscriptions${sandbox ? " and Interactivity" : ""} must point at ${url}/slack/events` + (sandbox ? " (without Interactivity, Approve and Deny do nothing)" : ""));

  // The admin API (docs/admin-api.md): its cheapest endpoint, only to see who it lets in.
  if (config.adminToken) {
    const a = await get(`${url}/api/v1/channels`, { headers: { authorization: `Bearer ${config.adminToken}` } });
    if (!a.res) add("deployment", "/api/v1", "fail", String(a.error));
    else if (a.res.ok) add("deployment", "/api/v1", "ok", "the admin API answers to this ADMIN_TOKEN");
    else if (a.res.status === 404) add("deployment", "/api/v1", "warn", "closed: the running app has no ADMIN_TOKEN");
    else if (a.res.status === 401) add("deployment", "/api/v1", "fail", "refused: the running app has a different ADMIN_TOKEN");
    else add("deployment", "/api/v1", "fail", `answered ${a.res.status}`);
  }

  if (!config.statusToken) return checks;
  const s = await get(`${url}/status`, { headers: { authorization: `Bearer ${config.statusToken}` } });
  const status = s.res?.ok ? await json<RunningStatus>(s.res) : undefined;
  // A proxy's page, or another server answering 200, is not a status to read from.
  const k = status && typeof status === "object" && status.knowledge && typeof status.knowledge === "object" ? status.knowledge : undefined;
  if (!s.res) add("deployment", "/status", "fail", String(s.error));
  else if (s.res.status === 404) add("deployment", "/status", "warn", "closed: the running app has no STATUS_TOKEN");
  else if (s.res.status === 401) add("deployment", "/status", "fail", "refused: the running app has a different STATUS_TOKEN");
  else if (!s.res.ok) add("deployment", "/status", "fail", `answered ${s.res.status}`);
  else if (!k) add("deployment", "/status", "fail", `answered ${s.res.status}, but not with a lorehouse status: is this the right URL?`);
  if (!status || !k) return checks;

  if (k.state === "error") add("deployment", "knowledge", "fail", `ingest failed: ${k.error}`);
  else if (k.state === "ready") add("deployment", "knowledge", "ok", `ready, ${k.documents} threads indexed`);
  else add("deployment", "knowledge", "info", `${k.state ?? "unknown"}, ${k.documents ?? 0} threads so far`);
  if (status.agent && status.agent !== identity.name) add("deployment", "agent", "warn", `the running app is @${status.agent}, this environment @${identity.name}: is this the same deployment?`);
  if (sandbox?.mode === "runners") {
    const online = (Array.isArray(status.runners) ? status.runners : []).filter((r) => r?.online);
    if (!online.length) add("deployment", "runners", "fail", "no sandbox runner is connected: code tools will fail (sandbox/host/README.md)");
    else add("deployment", "runners", "ok", online.map((r) => `${r.runner} (${r.transport}, ${r.running}/${r.capacity})`).join(", "));
  }
  return checks;
}

type RunningStatus = {
  agent?: string;
  knowledge?: { state?: string; documents?: number; error?: string };
  runners?: { runner: string; transport: string; online: boolean; capacity: number; running: number }[];
};

// Only a literal loopback address: a name like 127.0.0.1.example.com is not one, and
// neither is something that isn't a URL.
function isLoopback(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const host = new URL(url).hostname;
  return host === "localhost" || host === "[::1]" || /^127(\.\d{1,3}){3}$/.test(host);
}

const MARK: Record<Level, string> = { ok: "✓", warn: "!", fail: "✗", info: "·" };

export function report(checks: Check[]): string {
  const lines: string[] = [];
  const width = Math.max(...checks.map((c) => c.name.length));
  let section = "";
  for (const c of checks) {
    if (c.section !== section) lines.push(`${lines.length ? "\n" : ""}${(section = c.section)}`);
    lines.push(`  ${MARK[c.level]} ${c.name.padEnd(width)}  ${c.detail}`);
  }
  const count = (l: Level) => checks.filter((c) => c.level === l).length;
  const [fails, warns] = [count("fail"), count("warn")];
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  lines.push("", fails ? `${plural(fails, "problem")}, ${plural(warns, "warning")}.` : warns ? `No problems, ${plural(warns, "warning")}.` : "All good.");
  return lines.join("\n");
}

// `lorehouse doctor [--url …]`; returns the exit code.
export async function doctorMain(args: string[]): Promise<number> {
  let url: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") return console.log(USAGE), 0;
    if (a === "--url" || a.startsWith("--url=")) {
      url = a === "--url" ? args[++i] : a.slice("--url=".length);
      if (!url) return console.error(`lorehouse doctor: --url needs a URL\n\n${USAGE}`), 2;
    } else return console.error(`lorehouse doctor: unknown argument "${a}"\n\n${USAGE}`), 2;
  }
  if (url && !URL.canParse(url)) return console.error(`lorehouse doctor: "${url}" isn't a URL`), 2;
  const loaded = loadEnv();
  const checks = await doctor({ env: loaded.env, settingsPath: loaded.settingsPath, url: url ?? loaded.settings.runtime?.publicUrl });
  console.log(report(checks));
  return checks.some((c) => c.level === "fail") ? 1 : 0;
}
