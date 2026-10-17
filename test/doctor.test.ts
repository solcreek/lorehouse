// `lorehouse doctor`: each service asked directly, and a fix named for each problem.

import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { doctor, doctorMain, MANIFEST_SCOPES, report, type Check } from "../src/doctor";
import { countDocuments, openKnowledge, upsertDocument } from "../src/knowledge";
import { inThread, joinThread } from "../src/threads";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const DB = `${tmpdir()}/doctor-test-lorehouse.db`;
const ADMIN = "a".repeat(32);

const ENV = {
  SLACK_SIGNING_SECRET: "sign",
  SLACK_BOT_TOKEN: "xoxb-1",
  SLACK_API_URL: "http://slack.test/api",
  ANTHROPIC_API_KEY: "sk-1",
  AGENT_CHANNELS: "C1",
  LOREHOUSE_DB: DB,
  SESSIONS_DB: `${tmpdir()}/doctor-test-sessions.db`,
  STATUS_TOKEN: "st",
};

type World = {
  scopes?: string | null; // x-oauth-scopes; null: not sent
  authError?: string;
  displayName?: string;
  usersInfoError?: string;
  history?: Record<string, string>; // channel → Slack error
  info?: Record<string, Record<string, unknown> | string>; // conversations.info: channel → its fields, or a Slack error (default: public)
  anthropic?: number; // status of GET /v1/models/…
  appPermissions?: Record<string, string>;
  installations?: number | "http_500" | "not_a_list";
  app?: { secret?: string; status?: object | number | string; adminToken?: string | null }; // status as a string: a non-JSON body, 200; adminToken null: /api closed
};

// One fake internet: Slack, Anthropic, GitHub and the running app, by host.
function world(w: World = {}) {
  const seen: string[] = [];
  const f = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    seen.push(`${init.method ?? "GET"} ${url.host}${url.pathname}`);
    if (url.host === "slack.test") {
      const method = url.pathname.replace("/api/", "");
      const headers: Record<string, string> = w.scopes === null ? {} : { "x-oauth-scopes": w.scopes ?? MANIFEST_SCOPES.join(",") };
      if (method === "auth.test") return Response.json(w.authError ? { ok: false, error: w.authError } : { ok: true, team: "Acme", user_id: "UBOT" }, { headers });
      if (method === "users.info" && w.usersInfoError) return Response.json({ ok: false, error: w.usersInfoError });
      if (method === "users.info") return Response.json({ ok: true, user: { name: "scout", profile: { display_name: w.displayName ?? "scout" } } });
      if (method === "conversations.info") {
        const channel = url.searchParams.get("channel")!;
        const info = w.info?.[channel] ?? { name: "general", is_channel: true, is_private: false, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };
        return Response.json(typeof info === "string" ? { ok: false, error: info } : { ok: true, channel: { id: channel, ...info } });
      }
      if (method === "conversations.history") {
        const err = w.history?.[url.searchParams.get("channel")!];
        return Response.json(err ? { ok: false, error: err } : { ok: true, messages: [] });
      }
    }
    if (url.host === "api.anthropic.com" || url.host === "proxy.test") {
      const status = w.anthropic ?? 200;
      return status === 200 ? Response.json({ id: "claude-opus-5", display_name: "Claude Opus 5" }) : new Response("{}", { status });
    }
    if (url.host === "api.github.com") {
      if (url.pathname === "/app") return Response.json({ slug: "acme-agent", permissions: w.appPermissions ?? { contents: "write", pull_requests: "write", metadata: "read" } });
      if (url.pathname === "/app/installations") {
        if (w.installations === "http_500") return new Response("oops", { status: 500 });
        if (w.installations === "not_a_list") return Response.json({ message: "hm" });
        return Response.json(Array.from({ length: w.installations ?? 1 }, (_, id) => ({ id })));
      }
      if (url.pathname === "/user") return Response.json({ login: "octo" });
    }
    if (url.host === "app.test") {
      if (url.pathname === "/healthz") return new Response("ok");
      if (url.pathname === "/slack/events") {
        // Checks the signature the way the app does, with the running app's secret.
        const h = new Headers(init.headers);
        const body = String(init.body);
        const want = "v0=" + createHmac("sha256", w.app?.secret ?? "sign").update(`v0:${h.get("x-slack-request-timestamp")}:${body}`).digest("hex");
        if (h.get("x-slack-signature") !== want) return new Response("bad signature", { status: 401 });
        return Response.json({ challenge: JSON.parse(body).challenge });
      }
      if (url.pathname === "/api/v1/channels") {
        const token = w.app?.adminToken === undefined ? ADMIN : w.app.adminToken;
        if (token === null) return new Response("not found", { status: 404 });
        return new Headers(init.headers).get("authorization") === `Bearer ${token}` ? Response.json({ state: "ready", channels: [] }) : new Response("unauthorized", { status: 401 });
      }
      if (url.pathname === "/status") {
        const s = w.app?.status ?? { agent: "scout", knowledge: { state: "ready", documents: 12 } };
        if (typeof s === "string") return new Response(s, { status: 200 });
        return typeof s === "number" ? new Response("", { status: s }) : Response.json(s);
      }
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, seen };
}

const run = (env: Record<string, string | undefined>, w: World = {}, url?: string) => doctor({ env: { ...ENV, ...env }, fetch: world(w).f, url });
const find = (checks: Check[], name: string) => checks.filter((c) => c.name === name);
const levels = (checks: Check[]) => new Set(checks.map((c) => c.level));

describe("configuration", () => {
  test("every problem is listed, and nothing else is asked until they're fixed", async () => {
    const { f, seen } = world();
    const checks = await doctor({ env: { DM_MODE: "sometimes" }, fetch: f });
    const fails = checks.filter((c) => c.level === "fail").map((c) => c.detail);
    expect(fails.some((d) => d.startsWith("SLACK_SIGNING_SECRET"))).toBe(true);
    expect(fails.some((d) => d.startsWith("ANTHROPIC_API_KEY"))).toBe(true);
    expect(fails.some((d) => d.startsWith("DM_MODE"))).toBe(true);
    expect(seen).toEqual([]);
  });

  test("recording who asks is said out loud when on, and an unknown value is a problem", async () => {
    expect(find(await run({ USAGE_RECORD_PEOPLE: "1" }), "USAGE_RECORD_PEOPLE")).toMatchObject([{ level: "info" }]);
    expect(find(await run({}), "USAGE_RECORD_PEOPLE")).toEqual([]);
    const bad = await run({ USAGE_RECORD_PEOPLE: "yes" });
    expect(bad[0]).toMatchObject({ section: "configuration", level: "fail" });
    expect(bad[0]!.detail).toStartWith("USAGE_RECORD_PEOPLE");
  });

  test("who may approve a pull request is said with code tools on, and an unknown value is a problem", async () => {
    const sandbox = { SANDBOX_URL: "http://127.0.0.1:9", SANDBOX_TOKEN: "x", GITHUB_TOKEN: "ghp_1" };
    expect(find(await run(sandbox), "PR_APPROVER")).toMatchObject([{ section: "configuration", level: "info", detail: expect.stringMatching(/^requester: only the person who asked/) }]);
    expect(find(await run({ ...sandbox, PR_APPROVER: "anyone" }), "PR_APPROVER")).toMatchObject([{ level: "info", detail: expect.stringMatching(/^anyone:/) }]);
    expect(find(await run({ ...sandbox, PR_APPROVER: "not-requester" }), "PR_APPROVER")).toMatchObject([{ level: "info", detail: expect.stringMatching(/^not-requester:/) }]);
    // Without code tools it only matters once set.
    expect(find(await run({}), "PR_APPROVER")).toEqual([]);
    expect(find(await run({ PR_APPROVER: "not-requester" }), "PR_APPROVER")).toMatchObject([{ level: "info", detail: expect.stringContaining("no effect while code tools are off") }]);
    const bad = await run({ PR_APPROVER: "nobody" });
    expect(bad[0]).toMatchObject({ section: "configuration", level: "fail" });
    expect(bad[0]!.detail).toStartWith("PR_APPROVER");
  });

  test("a bad agent name is a configuration problem", async () => {
    const checks = await run({ AGENT_NAME: "Not A Handle!" });
    expect(checks[0]).toMatchObject({ section: "configuration", level: "fail" });
  });
});

describe("a working setup", () => {
  test("passes, with only the pointer to --url left", async () => {
    const checks = await run({});
    expect(checks.filter((c) => c.level === "fail" || c.level === "warn")).toEqual([]);
    expect(find(checks, "C1")[0]?.level).toBe("ok");
    expect(report(checks)).toEndWith("All good.");
  });
});

describe("slack", () => {
  test("a rejected token fails, and the channels aren't asked about", async () => {
    const { f, seen } = world({ authError: "invalid_auth" });
    const checks = await doctor({ env: ENV, fetch: f });
    expect(find(checks, "bot token")[0]).toMatchObject({ level: "fail" });
    expect(find(checks, "bot token")[0]!.detail).toContain("invalid_auth");
    expect(seen.some((s) => s.includes("conversations.history"))).toBe(false);
  });

  test("a scope missing from the manifest's list fails and names it", async () => {
    const checks = await run({}, { scopes: MANIFEST_SCOPES.filter((s) => s !== "users:read").join(",") });
    expect(find(checks, "scopes")[0]).toMatchObject({ level: "fail" });
    expect(find(checks, "scopes")[0]!.detail).toStartWith("missing users:read");
  });

  test("im:history is needed only while DMs are let in", async () => {
    const scopes = MANIFEST_SCOPES.filter((s) => s !== "im:history").join(",");
    expect(find(await run({}, { scopes }), "scopes")[0]?.level).toBe("fail");
    expect(find(await run({ DM_MODE: "ignore" }, { scopes }), "scopes")[0]?.level).toBe("ok");
  });

  test("with PDF replies on, it says where PDF fonts come from and what that sends", async () => {
    expect(find(await run({}), "PDF_FONTS")).toEqual([]);
    expect(find(await run({ PDF_REPLIES: "1" }, { scopes: MANIFEST_SCOPES.join(",") }), "PDF_FONTS")).toMatchObject([{ level: "info", detail: "local: offline: rendering contacts no one" }]);
    const google = find(await run({ PDF_REPLIES: "1", PDF_FONTS: "google" }), "PDF_FONTS")[0];
    // Both hosts: the subset file's own URL on fonts.gstatic.com carries the characters too.
    expect(google?.detail).toBe("google: sends each document's characters to fonts.googleapis.com, fonts.gstatic.com");
  });

  test("files:write is needed only with PDF replies or code tools on, and the failure says which", async () => {
    const scopes = MANIFEST_SCOPES.filter((s) => s !== "files:write").join(",");
    expect(find(await run({}, { scopes }), "scopes")[0]?.level).toBe("ok");
    const withPdf = find(await run({ PDF_REPLIES: "1" }, { scopes }), "scopes")[0];
    expect(withPdf).toMatchObject({ level: "fail" });
    expect(withPdf!.detail).toStartWith("missing files:write (to attach files, for PDF_REPLIES=1 (render_pdf)):");
    const sandbox = { SANDBOX_RUNNER_TOKEN: "r".repeat(32), GITHUB_TOKEN: "ghp_1" };
    const withCode = find(await run(sandbox, { scopes }), "scopes")[0];
    expect(withCode).toMatchObject({ level: "fail" });
    expect(withCode!.detail).toStartWith("missing files:write (to attach files, for code tools (workspace_attach_file)):");
    const both = find(await run({ ...sandbox, PDF_REPLIES: "1" }, { scopes }), "scopes")[0];
    expect(both!.detail).toContain("for PDF_REPLIES=1 (render_pdf) and code tools (workspace_attach_file)");
  });

  test("scopes Slack didn't report are a warning, not a pass", async () => {
    expect(find(await run({}, { scopes: null }), "scopes")[0]?.level).toBe("warn");
  });

  test("a bot shown under another name than AGENT_NAME is a warning", async () => {
    const checks = await run({}, { displayName: "atlas" });
    expect(find(checks, "agent name")[0]).toMatchObject({ level: "warn" });
  });

  test("a users.info failure is reported, not skipped", async () => {
    const checks = await run({}, { usersInfoError: "missing_scope" });
    expect(find(checks, "agent name")[0]).toMatchObject({ level: "warn", detail: "not checked: users.info: missing_scope (the app needs users:read)" });
  });

  test("a SLACK_BOT_USER_ID that isn't the token's bot fails", async () => {
    expect(find(await run({ SLACK_BOT_USER_ID: "UOTHER" }), "bot user id")[0]?.level).toBe("fail");
  });
});

describe("channels", () => {
  test("a channel the bot isn't in says how to invite it", async () => {
    const checks = await run({ AGENT_CHANNELS: "C1,C2" }, { history: { C2: "not_in_channel" } });
    expect(find(checks, "C1")[0]?.level).toBe("ok");
    expect(find(checks, "C2")[0]).toMatchObject({ level: "fail", detail: "the bot isn't a member: in that channel, /invite @scout" });
  });

  test("a private channel or DM id fails without asking Slack", async () => {
    const { f, seen } = world();
    const checks = await doctor({ env: { ...ENV, AGENT_CHANNELS: "G123,D9" }, fetch: f });
    expect(find(checks, "G123")[0]?.level).toBe("fail");
    expect(find(checks, "D9")[0]?.level).toBe("fail");
    expect(seen.some((s) => s.includes("conversations.history"))).toBe(false);
  });

  test("an unknown channel fails", async () => {
    expect(find(await run({}, { history: { C1: "channel_not_found" } }), "C1")[0]?.level).toBe("fail");
  });

  // What a start refuses on (#86), per channel, read-only; its history isn't read then.
  test("a private or archived channel with a C… id fails, named, as conversations.info says; the public one passes", async () => {
    const { f, seen } = world({ info: { C7: { name: "board", is_channel: true, is_private: true }, C8: { name: "old", is_channel: true, is_private: false, is_archived: true } } });
    const checks = await doctor({ env: { ...ENV, AGENT_CHANNELS: "C1,C7,C8" }, fetch: f });
    expect(find(checks, "C1")[0]).toMatchObject({ level: "ok", detail: "public (#general), and the bot can read its history" });
    expect(find(checks, "C7")[0]?.level).toBe("fail");
    expect(find(checks, "C7")[0]?.detail).toStartWith("C7 (#board) is a private channel: lorehouse refuses to start");
    expect(find(checks, "C8")[0]?.level).toBe("fail");
    expect(find(checks, "C8")[0]?.detail).toStartWith("C8 (#old) is archived");
    expect(seen.filter((s) => s.includes("conversations.history"))).toEqual(["GET slack.test/api/conversations.history"]);
  });

  test("a channel shared with another organization or workspace fails, named, saying why; its history isn't read", async () => {
    const shared = { name: "partners", is_channel: true, is_private: false, is_archived: false, is_shared: true };
    const { f, seen } = world({ info: { C3: { ...shared, is_ext_shared: true }, C4: { ...shared, name: "grid", is_org_shared: true } } });
    const checks = await doctor({ env: { ...ENV, AGENT_CHANNELS: "C3,C4" }, fetch: f });
    const [c3, c4] = [find(checks, "C3")[0]!, find(checks, "C4")[0]!];
    expect(c3.level).toBe("fail");
    expect(c3.detail).toStartWith("C3 (#partners) is shared with another organization (Slack Connect)");
    expect(c3.detail).toEndWith("lorehouse refuses to start until it is no longer shared or off AGENT_CHANNELS");
    expect(c4.level).toBe("fail");
    expect(c4.detail).toStartWith("C4 (#grid) is shared with other workspaces of this Enterprise Grid organization");
    expect(seen.some((s) => s.includes("conversations.history"))).toBe(false);
  });

  test("says who is answered: full members only, and a missing users:read means nobody", async () => {
    const policy = find(await run({ DM_MODE: "answer" }), "who is answered")[0];
    expect(policy?.level).toBe("info");
    expect(policy?.detail).toStartWith("full members of this workspace only: a guest");
    expect(policy?.detail).toContain("a follow-up or a DM");
    const scopes = find(await run({}, { scopes: MANIFEST_SCOPES.filter((s) => s !== "users:read").join(",") }), "scopes")[0];
    expect(scopes?.level).toBe("fail");
    expect(scopes?.detail).toContain("users:read (without it nobody can be checked as a full member, so nobody is answered)");
  });

  test("a channel that can't be looked up fails closed: not found, a missing scope", async () => {
    const checks = await run({ AGENT_CHANNELS: "C1,C2" }, { info: { C1: "channel_not_found", C2: "missing_scope" } });
    expect(find(checks, "C1")[0]).toMatchObject({ level: "fail", detail: expect.stringContaining("conversations.info said channel_not_found") });
    expect(find(checks, "C2")[0]).toMatchObject({ level: "fail", detail: expect.stringContaining("conversations.info said missing_scope (the app needs channels:read") });
  });

  test("no channels at all is a warning that says the agent works nowhere, and what a start purges", async () => {
    const check = find(await run({ AGENT_CHANNELS: "" }), "AGENT_CHANNELS")[0];
    expect(check?.level).toBe("warn");
    expect(check?.detail).toContain("nowhere");
    expect(check?.detail).toContain("purges everything it learned from Slack");
  });

  // Read-only: doctor counts what the next start would purge, and purges nothing (#82).
  test("channels no longer listed: what the next start would purge, per channel, without touching the database", async () => {
    const dir = mkdtempSync(`${tmpdir()}/doctor-purge-`);
    const path = `${dir}/lorehouse.db`;
    try {
      const db = openKnowledge(path);
      for (const [channel, n] of [["C1", 1], ["C2", 3], ["C3", 1]] as const) {
        for (let i = 0; i < n; i++) upsertDocument(db, { docId: `slack:${channel}:${i}.1`, kind: "slack_thread", source: "s", title: "t", text: "words" });
      }
      upsertDocument(db, { docId: "seed1", kind: "seed", source: "s", title: "t", text: "words" });
      joinThread(db, "C2", "0.1");
      db.close();
      const checks = await run({ AGENT_CHANNELS: "C1", LOREHOUSE_DB: path, SESSIONS_DB: `${dir}/sessions.db` });
      const purge = find(checks, "purge on start");
      expect(purge).toHaveLength(1);
      expect(purge[0]).toMatchObject({ section: "channels", level: "warn" });
      expect(purge[0]!.detail).toContain("4 documents");
      expect(purge[0]!.detail).toContain("C2 (3 documents)");
      expect(purge[0]!.detail).toContain("C3 (1 document)");
      const after = openKnowledge(path);
      expect(countDocuments(after)).toBe(6);
      expect(inThread(after, "C2", "0.1")).toBe(true);
      after.close();
      // Nothing to purge: no line at all.
      expect(find(await run({ AGENT_CHANNELS: "C1,C2,C3", LOREHOUSE_DB: path, SESSIONS_DB: `${dir}/sessions.db` }), "purge on start")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("anthropic", () => {
  test("a refused key fails", async () => {
    expect(find(await run({}, { anthropic: 401 }), "API key")[0]?.level).toBe("fail");
  });

  test("an unknown model fails at Anthropic, but only warns behind another ANTHROPIC_BASE_URL", async () => {
    expect(find(await run({}, { anthropic: 404 }), "model")[0]?.level).toBe("fail");
    expect(find(await run({ ANTHROPIC_BASE_URL: "http://proxy.test" }, { anthropic: 404 }), "model")[0]?.level).toBe("warn");
  });
});

describe("code tools", () => {
  const app = { SANDBOX_RUNNER_TOKEN: "r".repeat(32), GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: privateKey };

  test("a GitHub App that can't write pull requests fails and names the permission", async () => {
    const checks = await run(app, { appPermissions: { contents: "write", metadata: "read" } });
    expect(find(checks, "App")[0]).toMatchObject({ level: "ok", detail: "acme-agent[bot]" });
    expect(find(checks, "permissions")[0]).toMatchObject({ level: "fail" });
    expect(find(checks, "permissions")[0]!.detail).toContain("pull_requests");
  });

  test("an App installed nowhere is a warning", async () => {
    expect(find(await run(app, { installations: 0 }), "installations")[0]?.level).toBe("warn");
  });

  test("a failed or odd installations answer fails instead of passing silently", async () => {
    expect(find(await run(app, { installations: "http_500" }), "installations")[0]).toMatchObject({ level: "fail" });
    expect(find(await run(app, { installations: "not_a_list" }), "installations")[0]).toMatchObject({ level: "fail" });
  });

  test("a private key with a PEM header that can't sign fails, and GitHub isn't asked", async () => {
    const { f, seen } = world();
    const bad = "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----";
    const checks = await doctor({ env: { ...ENV, ...app, GITHUB_APP_PRIVATE_KEY: bad }, fetch: f });
    expect(find(checks, "App")[0]?.level).toBe("fail");
    expect(find(checks, "App")[0]!.detail).toStartWith("GITHUB_APP_PRIVATE_KEY can't sign");
    expect(seen.some((s) => s.includes("api.github.com"))).toBe(false);
  });

  test("a SANDBOX_URL that isn't a URL, or is plain HTTP off this machine, fails the configuration instead of crashing", async () => {
    for (const url of ["http://[bad", "http://sandbox.internal:8080"]) {
      const checks = await run({ SANDBOX_URL: url, SANDBOX_TOKEN: "t".repeat(32), GITHUB_TOKEN: "ghp_1" });
      expect(find(checks, "environment").find((c) => c.level === "fail")?.detail).toContain("SANDBOX_URL must be https://");
      expect(find(checks, "host")).toEqual([]);
    }
  });

  test("a plain GitHub token works, with a warning that it's for development", async () => {
    const checks = await run({ SANDBOX_RUNNER_TOKEN: "r".repeat(32), GITHUB_TOKEN: "ghp_1" });
    expect(find(checks, "token")[0]).toMatchObject({ level: "warn" });
  });

  test("code tools with GITHUB_TOKEN warn that the token reaches the sandbox; with an App they don't", async () => {
    const checks = await run({ SANDBOX_RUNNER_TOKEN: "r".repeat(32), GITHUB_TOKEN: "ghp_1" });
    expect(find(checks, "in the sandbox")[0]).toMatchObject({ level: "warn" });
    expect(find(checks, "in the sandbox")[0]!.detail).toContain("workspace_clone puts it in the sandbox");
    expect(find(await run(app), "in the sandbox")).toEqual([]);
  });

  test("asks GitHub where the app would (GITHUB_API_URL)", async () => {
    const { f, seen } = world();
    await doctor({ env: { ...ENV, SANDBOX_RUNNER_TOKEN: "r".repeat(32), GITHUB_TOKEN: "ghp_1", GITHUB_API_URL: "http://github.test/api/" }, fetch: f });
    expect(seen).toContain("GET github.test/api/user");
    expect(seen.some((s) => s.includes("api.github.com"))).toBe(false);
  });

  test("with runners, a running app with none connected fails", async () => {
    const checks = await run(app, { app: { status: { agent: "scout", knowledge: { state: "ready", documents: 1 }, runners: [] } } }, "https://app.test");
    expect(find(checks.filter((c) => c.section === "deployment"), "runners")[0]?.level).toBe("fail");
    const up = await run(app, { app: { status: { agent: "scout", knowledge: { state: "ready", documents: 1 }, runners: [{ runner: "starship", transport: "ws", online: true, capacity: 4, running: 1 }] } } }, "https://app.test");
    expect(find(up.filter((c) => c.section === "deployment"), "runners")[0]).toMatchObject({ level: "ok", detail: "starship (ws, 1/4)" });
  });
});

describe("storage", () => {
  test("a writable database in a read-only directory fails: SQLite's WAL files go beside it", async () => {
    const dir = mkdtempSync(`${tmpdir()}/doctor-ro-`);
    writeFileSync(`${dir}/lorehouse.db`, "");
    chmodSync(dir, 0o555);
    try {
      const checks = await run({ LOREHOUSE_DB: `${dir}/lorehouse.db` });
      expect(find(checks, "LOREHOUSE_DB")[0]).toMatchObject({ level: "fail" });
      expect(find(checks, "LOREHOUSE_DB")[0]!.detail).toContain("-wal");
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true });
    }
  });

  // A directory with one mode, holding a database file with another.
  async function storageWith(dirMode: number, fileMode: number) {
    const dir = mkdtempSync(`${tmpdir()}/doctor-mode-`);
    writeFileSync(`${dir}/lorehouse.db`, "");
    chmodSync(`${dir}/lorehouse.db`, fileMode);
    chmodSync(dir, dirMode);
    try {
      return find(await run({ LOREHOUSE_DB: `${dir}/lorehouse.db` }), "LOREHOUSE_DB")[0];
    } finally {
      chmodSync(dir, 0o755);
      rmSync(dir, { recursive: true });
    }
  }

  test("a directory that can be written but not entered fails", async () => {
    expect(await storageWith(0o300, 0o600)).toMatchObject({ level: "ok" });
    expect((await storageWith(0o600, 0o600))?.level).toBe("fail");
  });

  test("a database that can be written but not read fails", async () => {
    expect(await storageWith(0o755, 0o200)).toMatchObject({ level: "fail", detail: expect.stringContaining("readable and writable") });
  });

  test("a directory that doesn't exist fails; sessions in memory warn", async () => {
    const checks = await run({ LOREHOUSE_DB: "/no/such/dir/lorehouse.db", SESSIONS_DB: ":memory:" });
    expect(find(checks, "LOREHOUSE_DB")[0]?.level).toBe("fail");
    expect(find(checks, "SESSIONS_DB")[0]?.level).toBe("warn");
  });

  // Sessions are a file beside LOREHOUSE_DB unless asked otherwise (ADR 0002 §8): the
  // warning is about an explicit :memory:, and says how to get the default back.
  test("SESSIONS_DB unset is a file beside LOREHOUSE_DB; an explicit :memory: warns, naming the fix", async () => {
    const dir = mkdtempSync(`${tmpdir()}/doctor-sessions-`);
    try {
      const unset = find(await run({ LOREHOUSE_DB: `${dir}/lorehouse.db`, SESSIONS_DB: undefined }), "SESSIONS_DB")[0];
      expect(unset).toMatchObject({ level: "ok", detail: `${dir}/sessions.db (created on first start)` });
      const explicit = find(await run({ LOREHOUSE_DB: `${dir}/lorehouse.db`, SESSIONS_DB: ":memory:" }), "SESSIONS_DB")[0];
      expect(explicit?.level).toBe("warn");
      expect(explicit?.detail).toBe("in memory: a turn waiting on an Approve, and every conversation, is lost on every restart; unset SESSIONS_DB to keep sessions beside LOREHOUSE_DB");
      const follows = find(await run({ LOREHOUSE_DB: ":memory:", SESSIONS_DB: undefined }), "SESSIONS_DB")[0];
      expect(follows?.level).toBe("warn");
      expect(follows?.detail).toContain("as LOREHOUSE_DB is; set LOREHOUSE_DB to a file path, and sessions go beside it");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

// The tenant and the data directory (tenant.ts), and what the next start moves: reported,
// never done (the doctor only reads).
describe("the tenant", () => {
  const unset = { LOREHOUSE_DB: undefined, SESSIONS_DB: undefined };
  test("none yet: the first start makes one; the databases are checked in the data directory", async () => {
    const dir = mkdtempSync(`${tmpdir()}/doctor-tenant-`);
    try {
      const checks = await run({ ...unset, LOREHOUSE_DATA_DIR: dir });
      expect(find(checks, "tenant")[0]).toMatchObject({ level: "info", detail: `none yet: the first start makes one and keeps it in ${dir}/<id>/tenant.json` });
      expect(find(checks, "data directory")[0]?.detail).toBe(`${dir}: settings.json, and the tenant's files in <id>/`);
      expect(find(checks, "LOREHOUSE_DB")[0]?.level).toBe("ok");
      expect(readdirSync(dir)).toEqual([]); // nothing made
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  test("an install laid out before tenants: the next start's move is named, and nothing moves", async () => {
    const dir = mkdtempSync(`${tmpdir()}/doctor-tenant-`);
    try {
      const db = openKnowledge(`${dir}/lorehouse.db`);
      upsertDocument(db, { docId: "slack:C9:1.1", kind: "slack_thread", source: "https://x/p1", title: "#c9", text: "gone soon" });
      db.close();
      writeFileSync(`${dir}/sessions.db`, "");
      const checks = await run({ ...unset, LOREHOUSE_DATA_DIR: dir, TENANT_ID: "acme" });
      expect(find(checks, "tenant")[0]?.detail).toBe("acme (TENANT_ID)");
      expect(find(checks, "upgrade")[0]).toMatchObject({ level: "info", detail: `the next start moves lorehouse.db and sessions.db (with their -wal and -shm) from ${dir} into ${dir}/acme, leaving a symlink at each old path` });
      expect(find(checks, "LOREHOUSE_DB")[0]?.detail).toBe(`${dir}/lorehouse.db (moves to ${dir}/acme/lorehouse.db on the next start)`);
      // What a start would purge is read from where the database is now.
      expect(find(checks, "purge on start")[0]?.detail).toContain("C9 (1 document)");
      expect(readdirSync(dir).filter((f) => !/-(wal|shm)$/.test(f)).sort()).toEqual(["lorehouse.db", "sessions.db"]);
      // Both places holding one: the start would refuse, and so does the doctor.
      mkdirSync(`${dir}/acme`);
      writeFileSync(`${dir}/acme/lorehouse.db`, "");
      expect(find(await run({ ...unset, LOREHOUSE_DATA_DIR: dir, TENANT_ID: "acme" }), "upgrade")[0]).toMatchObject({ level: "fail", detail: expect.stringContaining(`both ${dir}/lorehouse.db and ${dir}/acme/lorehouse.db exist`) });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // A TENANT_ID with no directory yet, beside another tenant's, is a start on empty data:
  // refused, as the start refuses it, unless TENANT_NEW=1 asks for exactly that.
  test("another tenant's directory beside this one's fails; TENANT_NEW=1 makes it a warning", async () => {
    const dir = mkdtempSync(`${tmpdir()}/doctor-tenant-`);
    try {
      mkdirSync(`${dir}/globex`);
      writeFileSync(`${dir}/globex/tenant.json`, JSON.stringify({ id: "globex" }));
      const refused = await run({ ...unset, LOREHOUSE_DATA_DIR: dir, TENANT_ID: "acme" });
      expect(refused.filter((c) => c.level === "fail").map((c) => c.detail)).toEqual([expect.stringContaining("TENANT_ID (acme has no directory in")]);
      const allowed = await run({ ...unset, LOREHOUSE_DATA_DIR: dir, TENANT_ID: "acme", TENANT_NEW: "1" });
      expect(find(allowed, "other tenants")[0]).toMatchObject({ level: "warn", detail: expect.stringContaining(`${dir} also holds globex`) });
      expect(find(await run({ ...unset, LOREHOUSE_DATA_DIR: dir }), "tenant")[0]?.detail).toBe(`globex (named by ${dir}/globex/tenant.json)`);
      // Once acme has its directory, the other one is still a problem to look at.
      mkdirSync(`${dir}/acme`);
      writeFileSync(`${dir}/acme/tenant.json`, JSON.stringify({ id: "acme" }));
      expect(find(await run({ ...unset, LOREHOUSE_DATA_DIR: dir, TENANT_ID: "acme" }), "other tenants")[0]).toMatchObject({ level: "fail", detail: expect.stringContaining(`${dir} also holds globex`) });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("the running deployment (--url)", () => {
  test("a running app with the same secrets passes, and reports what it knows", async () => {
    const checks = await run({}, {}, "https://app.test");
    expect(levels(checks.filter((c) => c.section === "deployment"))).toEqual(new Set(["ok", "info"]));
    expect(find(checks, "knowledge")[0]?.detail).toBe("ready, 12 threads indexed");
  });

  test("the running app's tenant is named, and one that isn't this environment's warns", async () => {
    const status = (tenant: string) => ({ app: { status: { agent: "scout", tenant, knowledge: { state: "ready", documents: 1 } } } });
    expect(find(await run({ TENANT_ID: "acme" }, status("acme"), "https://app.test"), "tenant").at(-1)).toMatchObject({ section: "deployment", level: "ok", detail: "acme" });
    expect(find(await run({ TENANT_ID: "acme" }, status("globex"), "https://app.test"), "tenant").at(-1)).toMatchObject({ section: "deployment", level: "warn", detail: expect.stringContaining("serves tenant globex, this environment acme") });
  });

  test("a different signing secret on the running app fails", async () => {
    const checks = await run({}, { app: { secret: "other" } }, "https://app.test");
    expect(find(checks, "/slack/events")[0]).toMatchObject({ level: "fail", detail: "the running app has a different SLACK_SIGNING_SECRET than this environment" });
  });

  test("an ingest error on the running app fails and quotes it", async () => {
    const checks = await run({}, { app: { status: { agent: "scout", knowledge: { state: "error", documents: 0, error: "SlackApiError: slack conversations.history: not_in_channel" } } } }, "https://app.test");
    expect(find(checks, "knowledge")[0]).toMatchObject({ level: "fail" });
    expect(find(checks, "knowledge")[0]!.detail).toContain("not_in_channel");
  });

  test("a different STATUS_TOKEN fails; none on the running app warns", async () => {
    expect(find(await run({}, { app: { status: 401 } }, "https://app.test"), "/status")[0]?.level).toBe("fail");
    expect(find(await run({}, { app: { status: 404 } }, "https://app.test"), "/status")[0]?.level).toBe("warn");
  });

  test("a 200 /status that isn't a lorehouse status fails instead of crashing", async () => {
    for (const status of ["<html>proxy</html>", "null", { hello: "world" }]) {
      const checks = await run({}, { app: { status } }, "https://app.test");
      expect(find(checks, "/status")[0]).toMatchObject({ level: "fail" });
      expect(find(checks, "knowledge")).toEqual([]);
    }
  });

  test("plain HTTP warns unless the host is literally loopback", async () => {
    const warned = async (url: string) => find(await run({}, {}, url), "URL").length > 0;
    expect(await warned("http://127.0.0.1.example.test")).toBe(true);
    expect(await warned("http://app.test")).toBe(true);
    expect(await warned("http://127.0.0.1:3000")).toBe(false);
    expect(await warned("http://localhost:3000")).toBe(false);
  });

  test("a --url that isn't a URL fails, even called without the command line's check", async () => {
    const checks = await run({}, {}, "http://[bad");
    expect(find(checks, "URL")).toMatchObject([{ level: "fail" }]);
    expect(find(checks, "/healthz")).toEqual([]);
  });

  test("with ADMIN_TOKEN, the running app's admin API is checked: same token, another, or closed", async () => {
    const withAdmin = { ADMIN_TOKEN: ADMIN };
    expect(find(await run(withAdmin, {}, "https://app.test"), "/api/v1")[0]?.level).toBe("ok");
    expect(find(await run(withAdmin, { app: { adminToken: "b".repeat(32) } }, "https://app.test"), "/api/v1")[0]).toMatchObject({ level: "fail", detail: "refused: the running app has a different ADMIN_TOKEN" });
    expect(find(await run(withAdmin, { app: { adminToken: null } }, "https://app.test"), "/api/v1")[0]?.level).toBe("warn");
    expect(find(await run({}, {}, "https://app.test"), "/api/v1")).toEqual([]); // not set here: not asked
  });

  test("a URL nothing answers at fails without asking further", async () => {
    const checks = await doctor({ env: ENV, fetch: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch, url: "https://down.test" });
    expect(find(checks, "/healthz")[0]).toMatchObject({ level: "fail" });
    expect(find(checks, "/slack/events")).toEqual([]);
  });
});

describe("the command line", () => {
  test("--url without a value is refused, in either spelling", async () => {
    const err = console.error;
    console.error = () => {};
    try {
      expect(await doctorMain(["--url="])).toBe(2);
      expect(await doctorMain(["--url"])).toBe(2);
      expect(await doctorMain(["--nope"])).toBe(2);
    } finally {
      console.error = err;
    }
  });
});

describe("the report", () => {
  test("groups by section and counts problems and warnings", () => {
    const text = report([
      { section: "slack", name: "bot token", level: "ok", detail: "workspace Acme" },
      { section: "channels", name: "C2", level: "fail", detail: "invite it" },
      { section: "storage", name: "SESSIONS_DB", level: "warn", detail: "in memory" },
    ]);
    expect(text).toBe(["slack", "  ✓ bot token    workspace Acme", "", "channels", "  ✗ C2           invite it", "", "storage", "  ! SESSIONS_DB  in memory", "", "1 problem, 1 warning."].join("\n"));
  });
});
