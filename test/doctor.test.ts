// `lorehouse doctor`: each service asked directly, and a fix named for each problem.

import { describe, expect, test } from "bun:test";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { doctor, doctorMain, MANIFEST_SCOPES, report, type Check } from "../src/doctor";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const DB = `${tmpdir()}/doctor-test-lorehouse.db`;

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
  anthropic?: number; // status of GET /v1/models/…
  appPermissions?: Record<string, string>;
  installations?: number | "http_500" | "not_a_list";
  app?: { secret?: string; status?: object | number | string }; // a string: a non-JSON body, 200
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
    const checks = await run({}, { scopes: "app_mentions:read,channels:history,chat:write,im:history" });
    expect(find(checks, "scopes")[0]).toMatchObject({ level: "fail" });
    expect(find(checks, "scopes")[0]!.detail).toStartWith("missing users:read");
  });

  test("im:history is needed only while DMs are let in", async () => {
    const scopes = MANIFEST_SCOPES.filter((s) => s !== "im:history").join(",");
    expect(find(await run({}, { scopes }), "scopes")[0]?.level).toBe("fail");
    expect(find(await run({ DM_MODE: "ignore" }, { scopes }), "scopes")[0]?.level).toBe("ok");
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

  test("no channels at all is a warning", async () => {
    expect(find(await run({ AGENT_CHANNELS: "" }), "AGENT_CHANNELS")[0]?.level).toBe("warn");
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

  test("a SANDBOX_URL that isn't a URL fails the sandbox check instead of crashing", async () => {
    const checks = await run({ SANDBOX_URL: "http://[bad", SANDBOX_TOKEN: "t".repeat(32), GITHUB_TOKEN: "ghp_1" });
    expect(find(checks, "host").map((c) => c.level)).toEqual(["fail"]);
  });

  test("a plain GitHub token works, with a warning that it's for development", async () => {
    const checks = await run({ SANDBOX_RUNNER_TOKEN: "r".repeat(32), GITHUB_TOKEN: "ghp_1" });
    expect(find(checks, "token")[0]).toMatchObject({ level: "warn" });
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
});

describe("the running deployment (--url)", () => {
  test("a running app with the same secrets passes, and reports what it knows", async () => {
    const checks = await run({}, {}, "https://app.test");
    expect(levels(checks.filter((c) => c.section === "deployment"))).toEqual(new Set(["ok", "info"]));
    expect(find(checks, "knowledge")[0]?.detail).toBe("ready, 12 threads indexed");
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
