// setup.ts — getting from a fresh install to a working agent without copying a secret by
// hand, and staying reachable after that.
//
//   setup mode      With required settings missing, `lorehouse` doesn't exit (under systemd
//                   that was a crash loop). It serves /healthz (state "setup"), Slack's URL
//                   check, and the OAuth callback, and says in one line what to run.
//   lorehouse setup Takes an app configuration token (the one thing Slack makes a person
//                   generate) and the Anthropic key, on stdin or a hidden prompt, never as
//                   arguments. It creates the Slack app from slack/manifest.yaml, points its
//                   events at this server, and prints the install link. Clicking Allow is
//                   the only other human step: the callback stores the bot token, joins the
//                   channels, and the service restarts into normal mode.
//   URL sync        On every start, if the app holds a configuration token, it points
//                   Slack's Request URL and OAuth redirect at where it is reachable now. A
//                   quick tunnel's URL changes on every restart; this keeps Slack following it.
//   tunnel          LOREHOUSE_TUNNEL=quick runs cloudflared as a child, for a server with no
//                   domain. LOREHOUSE_PUBLIC_URL names a fixed URL instead.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import manifestTemplate from "../slack/manifest.yaml";
import { agentIdentity } from "./identity";
import { loadEnv, readSettings, updateSettings, type Env, type Settings } from "./settings";

// The required settings `lorehouse setup` and the install fill in. Setup mode waits for
// these, and only these, to be missing.
export const SETUP_PROVIDES = ["SLACK_SIGNING_SECRET", "SLACK_BOT_TOKEN", "ANTHROPIC_API_KEY"];

export const BOT_EVENTS =["app_mention", "message.channels", "message.im", "reaction_added", "reaction_removed"];
const SLACK_API = "https://slack.com/api";

type SlackBody = { ok: boolean; error?: string; errors?: unknown } & Record<string, unknown>;

export class SlackError extends Error {
  constructor(readonly method: string, readonly code: string, detail?: unknown) {
    super(`${method}: ${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
  }
}

// A Slack Web API call, form-encoded. Throws on ok: false.
export async function slackCall(method: string, token: string | undefined, params: Record<string, string>): Promise<SlackBody> {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as SlackBody;
  if (!body.ok) throw new SlackError(method, body.error ?? "unknown", body.errors);
  return body;
}

// A fresh configuration token, rotating when the stored one is within 10 minutes of expiry
// (or `force`). The new pair is stored before it is used: a refresh token works once.
export async function configToken(settingsFile: string, force = false): Promise<string> {
  const s = readSettings(settingsFile);
  const c = s.slack;
  if (!c?.configRefreshToken) throw new Error("no Slack configuration token: run `lorehouse setup`");
  if (!force && c.configToken && (c.configExpiresAt ?? 0) - Date.now() / 1000 > 600) return c.configToken;
  const r = await slackCall("tooling.tokens.rotate", undefined, { refresh_token: c.configRefreshToken });
  updateSettings(settingsFile, (s) => {
    s.slack = { ...s.slack, configToken: r.token as string, configRefreshToken: r.refresh_token as string, configExpiresAt: r.exp as number };
  });
  return r.token as string;
}

// slack/manifest.yaml, named for this agent, pointed at `url`. Events only once the app can
// answer Slack's URL check, that is, once it holds the signing secret. Interactivity (the
// pull request Approve/Deny clicks) goes to the same URL, so it moves with it.
export function appManifest(name: string, url: string, events: boolean): Record<string, unknown> {
  const m = structuredClone(manifestTemplate) as {
    display_information: { name: string };
    features: { bot_user: { display_name: string } };
    oauth_config: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  m.display_information.name = name;
  m.features.bot_user.display_name = name;
  m.oauth_config.redirect_urls = [`${url}/slack/oauth/callback`];
  if (events) {
    m.settings.event_subscriptions = { request_url: `${url}/slack/events`, bot_events: BOT_EVENTS };
    m.settings.interactivity = { is_enabled: true, request_url: `${url}/slack/events` };
  }
  return m;
}

// The parts of an exported manifest that follow the server's URL.
export type ManagedManifest = {
  settings?: {
    event_subscriptions?: { request_url?: string; bot_events?: string[] };
    interactivity?: { is_enabled?: boolean; request_url?: string };
  } & Record<string, unknown>;
  oauth_config?: { redirect_urls?: string[] } & Record<string, unknown>;
};

// What's wrong with where the app's events and interactivity point, compared with `url`:
// "" when both are right. For the log and the doctor.
export function urlMismatch(m: ManagedManifest, url: string): string {
  const want = `${url}/slack/events`;
  const ev = m.settings?.event_subscriptions?.request_url;
  const ia = m.settings?.interactivity;
  const wrong: string[] = [];
  if (ev !== want) wrong.push(`events go to ${ev ?? "nowhere"}`);
  if (!ia?.is_enabled || ia.request_url !== want) wrong.push(`interactivity goes to ${ia?.is_enabled ? (ia.request_url ?? "nowhere") : "nowhere (off)"}`);
  return wrong.join("; ");
}

// Point the app's Request URLs (events and interactivity) and OAuth redirect at `url`, if
// they aren't already, recreating a block that was removed in Slack. Returns what it did,
// for the log.
export async function syncSlackUrls(settingsFile: string, url: string): Promise<string> {
  const s = readSettings(settingsFile);
  const appId = s.slack?.appId;
  if (!appId || !s.slack?.configRefreshToken) return "no managed Slack app: Slack's Request URL is yours to keep current";
  const token = await configToken(settingsFile);
  const exported = await slackCall("apps.manifest.export", token, { app_id: appId });
  const m = exported.manifest as ManagedManifest;
  const events = `${url}/slack/events`;
  const redirect = `${url}/slack/oauth/callback`;
  const was = m.settings?.event_subscriptions?.request_url;
  const eventsOk = !urlMismatch(m, url);
  // The OAuth redirect matters only until the install finishes. Changing it afterwards made
  // Slack report permissions_updated (2026-09-30) though the bot's scopes stayed the same.
  const installing = !s.env.SLACK_BOT_TOKEN || !!s.slack.oauthState;
  const redirectOk = !installing || (m.oauth_config?.redirect_urls?.includes(redirect) ?? false);
  if (eventsOk && redirectOk) return `Slack already points at ${url}`;
  m.settings = {
    ...m.settings,
    event_subscriptions: { ...m.settings?.event_subscriptions, request_url: events, bot_events: m.settings?.event_subscriptions?.bot_events ?? BOT_EVENTS },
    interactivity: { ...m.settings?.interactivity, is_enabled: true, request_url: events },
  };
  if (installing) m.oauth_config = { ...m.oauth_config, redirect_urls: [redirect] };
  const r = await slackCall("apps.manifest.update", token, { app_id: appId, manifest: JSON.stringify(m) });
  return `Slack now points at ${url}` + (was && was !== events ? ` (was ${new URL(was).origin})` : "") + (r.permissions_updated ? "; Slack reports its permissions changed: run lorehouse doctor to check the scopes" : "");
}

// ── public URL ───────────────────────────────────────────────────────────────────────────

// cloudflared as a child process; resolves with its https://…trycloudflare.com URL. If
// the tunnel exits, so does lorehouse, and the service manager restarts both. That includes
// the 30 s deadline: a cloudflared that stays silent is killed, and the restart tries again.
export async function startQuickTunnel(port: number): Promise<string> {
  const child = Bun.spawn(["cloudflared", "tunnel", "--no-autoupdate", "--url", `http://localhost:${port}`], { stdout: "ignore", stderr: "pipe" });
  void child.exited.then((code) => {
    console.error(`lorehouse: the tunnel exited (${code}); exiting so the service restarts both`);
    process.exit(1);
  });
  const reader = child.stderr.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  let timer: Timer | undefined;
  const timeout = new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), 30_000)));
  for (;;) {
    const next = await Promise.race([reader.read(), timeout]);
    if (next === "timeout") {
      child.kill();
      break;
    }
    const { value, done } = next;
    if (done) break;
    seen += decoder.decode(value);
    const m = seen.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      clearTimeout(timer);
      void (async () => {
        for (;;) if ((await reader.read()).done) return; // keep draining so cloudflared never blocks
      })();
      return m[0];
    }
  }
  throw new Error("the quick tunnel gave no URL in 30 s");
}

// A new tunnel hostname takes a few seconds to resolve. Slack checks the URL the moment it is
// saved, so wait until it answers from outside first.
export async function waitReachable(url: string, ms = 90_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.ok, () => false);
    if (ok) return true;
    await Bun.sleep(2000);
  }
  return false;
}

// Where Slack can reach this server: a fixed LOREHOUSE_PUBLIC_URL, or a quick tunnel.
export async function publicUrl(env: Env, port: number): Promise<string | undefined> {
  if (env.LOREHOUSE_PUBLIC_URL) return env.LOREHOUSE_PUBLIC_URL.replace(/\/$/, "");
  if (env.LOREHOUSE_TUNNEL === "quick") return startQuickTunnel(port);
  return undefined;
}

// After the server is up: record the URL, and point Slack at it. Never throws: a failure is
// logged, and the app keeps serving at the old URL's mercy.
export async function announceUrl(settingsFile: string, url: string | undefined): Promise<void> {
  if (!url) return;
  updateSettings(settingsFile, (s) => void (s.runtime = { ...s.runtime, publicUrl: url }));
  console.log(`lorehouse: reachable at ${url}`);
  try {
    if (!readSettings(settingsFile).slack?.appId) return;
    if (!(await waitReachable(url))) return console.error(`lorehouse: ${url} isn't reachable yet; Slack not updated`);
    console.log(`lorehouse: ${await syncSlackUrls(settingsFile, url)}`);
  } catch (e) {
    console.error(`lorehouse: couldn't update Slack's URLs: ${(e as Error).message}`);
  }
}

// ── Slack requests in setup mode ─────────────────────────────────────────────────────────

function verifiedSlackBody(req: Request, raw: string, signingSecret: string): boolean {
  const ts = req.headers.get("x-slack-request-timestamp") ?? "";
  const sig = req.headers.get("x-slack-signature") ?? "";
  if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const want = "v0=" + createHmac("sha256", signingSecret).update(`v0:${ts}:${raw}`).digest("hex");
  return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// `html` is markup: anything in it from the request, from Slack or from an exception goes
// through esc().
const page = (title: string, html: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:36em;margin:4em auto"><h1>${title}</h1><p>${html}</p>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

// Slack sends the browser here after Allow: exchange the code for the bot token, join the
// channels asked for, store both, and restart into normal mode.
async function oauthCallback(req: Request, settingsFile: string, url: string | undefined, onInstalled: () => void): Promise<Response> {
  const q = new URL(req.url).searchParams;
  const s = readSettings(settingsFile);
  if (q.get("error")) return page("Not installed", `Slack says: ${esc(q.get("error")!)}. Run <code>lorehouse setup</code> again for a new link.`, 400);
  if (!s.slack?.oauthState || q.get("state") !== s.slack.oauthState) return page("Link expired", "This install link isn't the current one. Run <code>lorehouse setup</code> again.", 400);
  if (!s.slack.clientId || !s.slack.clientSecret || !url) return page("Not ready", "Run <code>lorehouse setup</code> first.", 409);
  try {
    const r = await slackCall("oauth.v2.access", undefined, {
      client_id: s.slack.clientId,
      client_secret: s.slack.clientSecret,
      code: q.get("code") ?? "",
      redirect_uri: `${url}/slack/oauth/callback`,
    });
    const bot = r.access_token as string;
    const joined: string[] = [];
    const wanted = new Set((s.slack.channels ?? []).map((c) => c.replace(/^#/, "")));
    if (wanted.size) {
      // Slack may return fewer than `limit` per page, with the rest behind next_cursor.
      let cursor = "";
      do {
        const list = await slackCall("conversations.list", bot, { types: "public_channel", exclude_archived: "true", limit: "1000", ...(cursor ? { cursor } : {}) });
        for (const c of list.channels as { id: string; name: string }[]) {
          if (!wanted.has(c.name) && !wanted.has(c.id)) continue;
          await slackCall("conversations.join", bot, { channel: c.id });
          joined.push(c.id);
        }
        cursor = (list.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ?? "";
      } while (cursor);
    }
    updateSettings(settingsFile, (s) => {
      s.env.SLACK_BOT_TOKEN = bot;
      s.env.SLACK_BOT_USER_ID = r.bot_user_id as string;
      if (joined.length) s.env.AGENT_CHANNELS = joined.join(",");
      s.slack = { ...s.slack, installedBy: (r.authed_user as { id?: string } | undefined)?.id };
      delete s.slack.oauthState;
    });
    console.log(`lorehouse: installed in ${(r.team as { name?: string })?.name ?? "the workspace"}; joined ${joined.length} channel(s)`);
    onInstalled();
    const missing = [...wanted].length - joined.length;
    return page("Installed", `Lorehouse is in ${esc((r.team as { name?: string })?.name ?? "your workspace")}` + (joined.length ? ` and joined ${joined.length} channel(s)` : "") + (missing > 0 ? `. ${missing} channel(s) weren't found` : "") + ". It starts answering in a few seconds. You can close this tab.");
  } catch (e) {
    return page("Not installed", `Slack refused the install: ${esc((e as Error).message)}`, 502);
  }
}

// ── setup mode ───────────────────────────────────────────────────────────────────────────

export async function serveSetupMode(port: number, settingsFile: string, problems: string[], env: Env): Promise<void> {
  let url: string | undefined;
  const server = Bun.serve({
    port,
    idleTimeout: 60,
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return Response.json({ state: "setup", missing: problems, url });
      if (path === "/slack/events" && req.method === "POST") {
        const raw = await req.text();
        const secret = readSettings(settingsFile).env.SLACK_SIGNING_SECRET;
        if (!secret || !verifiedSlackBody(req, raw, secret)) return new Response("unauthorized", { status: 401 });
        // Interactivity arrives form-encoded, not JSON: before the install, dropped like events.
        const body = (() => { try { return JSON.parse(raw) as { type?: string; challenge?: string }; } catch { return {}; } })();
        if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
        return new Response("ok"); // an event before the install finished: acknowledged, dropped
      }
      if (path === "/slack/oauth/callback") {
        return oauthCallback(req, settingsFile, url, () => setTimeout(() => {
          console.log("lorehouse: settings complete; restarting into normal mode");
          process.exit(0); // the unit's Restart=always brings it back configured
        }, 1000));
      }
      return Response.json({ state: "setup", missing: problems }, { status: 503 });
    },
  });
  console.log(`lorehouse: setup required (missing ${problems.join(", ")}). Serving setup on :${server.port}. Next: sudo lorehouse setup`);
  url = await publicUrl(env, server.port!).catch((e) => (console.error(`lorehouse: ${(e as Error).message}`), undefined));
  await announceUrl(settingsFile, url);
}

// ── lorehouse setup ──────────────────────────────────────────────────────────────────────

const SETUP_USAGE = `usage: lorehouse setup [--channels name,name] [--no-wait]

Creates and installs the Slack app, with no settings copied by hand. Reads, from stdin as
KEY=value lines (or a hidden prompt on a terminal):

  SLACK_CONFIG_TOKEN          api.slack.com/apps → Your App Configuration Tokens → Generate
  SLACK_CONFIG_REFRESH_TOKEN  the refresh token shown with it
  ANTHROPIC_API_KEY           unless the settings already have one

Then prints one link to open and click Allow on. It waits for that (unless --no-wait),
and ends with a line an agent can read: LOREHOUSE_SETUP status=…`;

function prompt(label: string): string {
  process.stderr.write(`${label}: `);
  const r = Bun.spawnSync(["sh", "-c", 'stty -echo; IFS= read -r v; stty echo; printf %s "$v"'], { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  process.stderr.write("\n");
  return r.stdout.toString().trim();
}

async function readInputs(needed: string[]): Promise<Record<string, string>> {
  if (!process.stdin.isTTY) {
    const text = await Bun.stdin.text();
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && m[2]) out[m[1]!] = m[2]!;
    }
    return out;
  }
  return Object.fromEntries(needed.map((k) => [k, prompt(k)]));
}

export async function setupMain(args: string[]): Promise<number> {
  let channels: string[] = [];
  let wait = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--help" || a === "-h") return console.log(SETUP_USAGE), 0;
    else if (a === "--channels") channels = (args[++i] ?? "").split(",").map((c) => c.trim().replace(/^#/, "")).filter(Boolean);
    else if (a === "--no-wait") wait = false;
    else return console.error(`lorehouse setup: unknown argument "${a}"\n\n${SETUP_USAGE}`), 2;
  }
  const step = (t: string) => console.log(`• ${t}`);
  const done = (status: string, extra = "") => (console.log(`LOREHOUSE_SETUP status=${status}${extra}`), status === "ready" || status === "needs-human" ? 0 : 1);

  const { env, settingsPath: file } = loadEnv();
  const port = Number(env.PORT ?? 3000);
  // The same check the server makes on start: a name Slack accepts but agentIdentity doesn't
  // would install fine, then crash-loop on the restart into normal mode.
  let name: string;
  try {
    name = agentIdentity(env.AGENT_NAME).name;
  } catch (e) {
    return console.error(`✗ AGENT_NAME: ${(e as Error).message}`), done("error", " reason=agent-name");
  }

  // The running server knows where Slack can reach it.
  const health = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text(), () => undefined);
  if (health === undefined) return console.error(`✗ nothing answers on :${port}: start the service first (sudo systemctl start lorehouse)`), done("error", " reason=not-running");
  if (health === "ok") return step("lorehouse is already set up and running"), done("ready");
  const url = (JSON.parse(health) as { url?: string }).url ?? readSettings(file).runtime?.publicUrl;
  if (!url) return console.error("✗ the server has no public URL: set LOREHOUSE_PUBLIC_URL, or LOREHOUSE_TUNNEL=quick"), done("error", " reason=no-url");

  if (!(await waitReachable(url))) return console.error(`✗ ${url} doesn't answer from outside yet; try again in a minute`), done("error", " reason=unreachable");

  const s0 = readSettings(file);
  const needed = [...(s0.slack?.configRefreshToken ? [] : ["SLACK_CONFIG_TOKEN", "SLACK_CONFIG_REFRESH_TOKEN"]), ...(env.ANTHROPIC_API_KEY ? [] : ["ANTHROPIC_API_KEY"])];
  const input = needed.length ? await readInputs(needed) : {};
  for (const k of needed) if (!input[k]) return console.error(`✗ ${k} is required\n\n${SETUP_USAGE}`), done("error", ` reason=missing-${k}`);

  try {
    if (input.ANTHROPIC_API_KEY) {
      const r = await fetch("https://api.anthropic.com/v1/models", { headers: { "x-api-key": input.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return console.error(`✗ Anthropic refused the key (${r.status})`), done("error", " reason=anthropic-key");
      step("Anthropic key works");
    }
    updateSettings(file, (s) => {
      if (input.ANTHROPIC_API_KEY) s.env.ANTHROPIC_API_KEY = input.ANTHROPIC_API_KEY;
      s.env.STATUS_TOKEN ||= randomBytes(32).toString("hex");
      if (input.SLACK_CONFIG_REFRESH_TOKEN) s.slack = { ...s.slack, configToken: input.SLACK_CONFIG_TOKEN, configRefreshToken: input.SLACK_CONFIG_REFRESH_TOKEN, configExpiresAt: 0 };
      if (channels.length) s.slack = { ...s.slack, channels };
    });
    const token = await configToken(file, true);
    step("Slack configuration token works (rotated and stored)");

    let s: Settings = readSettings(file);
    if (!s.slack?.appId) {
      const r = await slackCall("apps.manifest.create", token, { manifest: JSON.stringify(appManifest(name, url, false)) });
      const c = r.credentials as { client_id: string; client_secret: string; signing_secret: string };
      s = updateSettings(file, (s) => {
        s.env.SLACK_SIGNING_SECRET = c.signing_secret;
        s.slack = { ...s.slack, appId: r.app_id as string, clientId: c.client_id, clientSecret: c.client_secret };
      });
      step(`created the Slack app @${name} (${r.app_id})`);
    } else step(`the Slack app ${s.slack.appId} exists`);

    // The server now holds the signing secret, so Slack's URL check on this update passes.
    await slackCall("apps.manifest.update", token, { app_id: s.slack!.appId!, manifest: JSON.stringify(appManifest(name, url, true)) });
    step(`events point at ${url}/slack/events`);

    const state = randomBytes(16).toString("hex");
    updateSettings(file, (s) => void (s.slack = { ...s.slack, oauthState: state }));
    const scopes = (manifestTemplate as { oauth_config: { scopes: { bot: string[] } } }).oauth_config.scopes.bot.join(",");
    const link = `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: s.slack!.clientId!, scope: scopes, redirect_uri: `${url}/slack/oauth/callback`, state })}`;
    console.log(`\nOpen this link and click Allow (the one step Slack keeps for a person):\n\n  ${link}\n`);
    if (!wait) return done("needs-human", ` action=open-link url=${link}`);

    console.log("Waiting for the Allow click…");
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      await Bun.sleep(3000);
      const h = await fetch(`http://localhost:${port}/healthz`, { signal: AbortSignal.timeout(5000) }).then((r) => r.text(), () => undefined);
      if (h === "ok") {
        step("installed; lorehouse restarted and is answering");
        return done("ready", ` url=${url}`);
      }
    }
    return console.error("✗ no Allow within 15 minutes; run lorehouse setup again for a new link"), done("error", " reason=timeout");
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    return done("error", ` reason=${e instanceof SlackError ? `${e.method}:${e.code}` : "exception"}`);
  }
}
