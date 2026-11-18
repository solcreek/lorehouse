// The app's wiring of the GitHub App credential (src/app.ts): every request the credential
// makes for itself (the installation lookup, the token exchange) carries a deadline, as
// the repo check's own requests do. Without one, a GitHub that stalls leaves the request
// open behind a PUT that has already answered github_unavailable, and each retry leaves
// another. Driven through createApp and the admin API, with the process's fetch watched.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";

const PUBLIC = { is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };

// One local server standing for Slack's Web API and GitHub's REST API.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/slack/")) {
      const method = url.pathname.slice("/slack/".length);
      if (method === "auth.test") return Response.json({ ok: true, user_id: "UBOT", team_id: "T1" });
      if (method === "conversations.info") return Response.json({ ok: true, channel: { id: "C1", name: "general", ...PUBLIC } });
      if (method === "conversations.history") return Response.json({ ok: true, messages: [], has_more: false });
      return Response.json({ ok: true });
    }
    if (url.pathname === "/gh/repos/acme/widgets/installation") return Response.json({ id: 7 });
    if (url.pathname === "/gh/app/installations/7/access_tokens") return Response.json({ token: "ghs_read", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    if (url.pathname === "/gh/repos/acme/widgets") return Response.json({ full_name: "acme/widgets", default_branch: "main" });
    return new Response("not found", { status: 404 });
  },
});
const HERE = `http://127.0.0.1:${server.port}`;

// Every request the process made to the stand-in GitHub: its path, and whether it could
// be given up on (it carried an abort signal).
const github: { path: string; bounded: boolean }[] = [];
const realFetch = globalThis.fetch;
const watching = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === HERE && url.pathname.startsWith("/gh/")) github.push({ path: url.pathname.slice("/gh".length), bounded: init?.signal instanceof AbortSignal });
  return realFetch(input, init);
}) as typeof fetch;

const dir = mkdtempSync(join(tmpdir(), "app-credential-deadline-"));
const ADMIN = "a".repeat(32);
let app: Awaited<ReturnType<typeof createApp>>;

beforeAll(async () => {
  globalThis.fetch = watching;
  app = await createApp(loadConfig({
    SLACK_SIGNING_SECRET: "s",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_API_URL: `${HERE}/slack`,
    ANTHROPIC_API_KEY: "k",
    AGENT_CHANNELS: "C1",
    LOREHOUSE_DB: join(dir, "lorehouse.db"),
    SESSIONS_DB: ":memory:",
    ADMIN_TOKEN: ADMIN,
    SANDBOX_URL: HERE,
    SANDBOX_TOKEN: "t",
    GITHUB_APP_ID: "900",
    GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    GITHUB_API_URL: `${HERE}/gh`,
    INGEST_BACKFILL_DAYS: "0",
  }));
});

afterAll(async () => {
  await app?.close({ waitMs: 200 });
  globalThis.fetch = realFetch;
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("setting a default repo with a GitHub App", () => {
  test("every request to GitHub carries a deadline: the credential's own two, and the repo check's", async () => {
    const res = await app.fetch(new Request("http://x/api/v1/channels/C1/repo", { method: "PUT", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: JSON.stringify({ repo: "acme/widgets" }) }));
    expect(res.status).toBe(200);
    expect(github.map((r) => r.path)).toEqual(["/repos/acme/widgets/installation", "/app/installations/7/access_tokens", "/repos/acme/widgets"]);
    expect(github.filter((r) => !r.bounded)).toEqual([]);
  });
});
