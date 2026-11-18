// The app's wiring of a channel's default repo (#126, src/app.ts): the workspace_clone
// the app hands June gets a default only for a listed, still-open public channel of the
// thread being answered. Driven through createApp, with a Slack and a sandbox host that
// answer on a local port, so it fails if app.ts stops passing that rule to the tool: a row
// alone (for a private channel, a DM, a channel off the list, one closed since the start)
// must never be a default.
//
// defineAgent is wrapped (and still runs) so the test gets the tool app.ts built.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentConfig from "@junejs/core/agent-config";
import type { AgentDefinition } from "@junejs/core/agent-config";
import { Database } from "../src/sqlite";

const real = { ...agentConfig };
const defined: AgentDefinition[] = [];
mock.module("@junejs/core/agent-config", () => ({
  ...real,
  defineAgent: (...args: Parameters<typeof real.defineAgent>) => {
    const agent = real.defineAgent(...args);
    defined.push(agent);
    return agent;
  },
}));

const { createApp } = await import("../src/app");
const { loadConfig } = await import("../src/config");

const PUBLIC = { is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };
// What Slack says of each channel now; C2 is turned private part-way through.
const channels: Record<string, Record<string, unknown>> = { C1: { name: "general", ...PUBLIC }, C2: { name: "random", ...PUBLIC } };
// Every clone that reached the sandbox host: "<sandbox id> <repo url>".
const clones: string[] = [];

// One local server standing for Slack's Web API and the sandbox host.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/slack/")) {
      const method = url.pathname.slice("/slack/".length);
      const params = { ...Object.fromEntries(url.searchParams), ...Object.fromEntries(new URLSearchParams(await req.text())) } as Record<string, string>;
      if (method === "auth.test") return Response.json({ ok: true, user_id: "UBOT", team_id: "T1" });
      if (method === "conversations.info") {
        const info = channels[params.channel ?? ""];
        return Response.json(info ? { ok: true, channel: { id: params.channel, ...info } } : { ok: false, error: "channel_not_found" });
      }
      if (method === "conversations.history") return Response.json({ ok: true, messages: [], has_more: false });
      return Response.json({ ok: true });
    }
    const exec = /^\/v1\/sandboxes\/([^/]+)\/exec$/.exec(url.pathname);
    if (exec && req.method === "POST") {
      const { command } = (await req.json()) as { command: string };
      const clone = / clone (?:--branch \S+ )?(\S+) \/workspace\/repo$/.exec(command);
      if (clone) clones.push(`${decodeURIComponent(exec[1]!)} ${clone[1]}`);
      // No checkout yet in any sandbox: the remote lookup fails, everything else succeeds.
      return Response.json(command.includes("remote get-url origin") ? { exitCode: 2, stdout: "", stderr: "" } : { exitCode: 0, stdout: "", stderr: "" });
    }
    return new Response("not found", { status: 404 });
  },
});
const HERE = `http://127.0.0.1:${server.port}`;

const dir = mkdtempSync(join(tmpdir(), "default-repo-wiring-"));
const DB = join(dir, "lorehouse.db");
let app: Awaited<ReturnType<typeof createApp>>;
let clone: AgentDefinition["tools"][number];

const STATUS = "s".repeat(32);
const closedChannels = async () => {
  const s = (await (await app.fetch(new Request("http://x/status", { headers: { authorization: `Bearer ${STATUS}` } }))).json()) as { knowledge: { state: string; channels: Record<string, { closed?: string }> } };
  return { state: s.knowledge.state, closed: Object.entries(s.knowledge.channels).filter(([, c]) => c.closed).map(([id]) => id) };
};
async function until(check: () => Promise<boolean>, ms = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await check()) return true;
    await Bun.sleep(20);
  }
  return false;
}

beforeAll(async () => {
  app = await createApp(loadConfig({
    SLACK_SIGNING_SECRET: "s",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_API_URL: `${HERE}/slack`,
    ANTHROPIC_API_KEY: "k",
    AGENT_CHANNELS: "C1,C2",
    LOREHOUSE_DB: DB,
    SESSIONS_DB: ":memory:",
    STATUS_TOKEN: STATUS,
    SANDBOX_URL: HERE,
    SANDBOX_TOKEN: "t",
    GITHUB_TOKEN: "g",
    INGEST_BACKFILL_DAYS: "0",
    INGEST_CHANNEL_RECHECK_MS: "50",
  }));
  clone = defined[0]!.tools.find((t) => t.spec.name === "workspace_clone")!;
  // Rows for every kind of channel, written after the start (its purge has run), through
  // the one driver LOREHOUSE_DB is opened with: what a row alone would hand out.
  const db = new Database(DB);
  for (const channel of ["C1", "C2", "C9", "G1", "D1"]) {
    db.query("INSERT INTO channel_repos (channel, owner, name, branch, set_at) VALUES (?, 'acme', ?, NULL, '2026-11-01T00:00:00.000Z')").run(channel, `repo-${channel.toLowerCase()}`);
  }
  db.close();
  await app.startIngest();
});

afterAll(async () => {
  await app?.close({ waitMs: 200 });
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  mock.module("@junejs/core/agent-config", () => real);
});

// A tool call in a turn answering a mention (or, with a type, a message) in `channel`.
const run = (channel: string, type = "unknown", input: unknown = {}) =>
  clone.run(input, { sessionId: `slack_${channel}_1.1`, event: { source: "slack", kind: "app_mention", channelId: channel, channelType: type, ts: "1.1" } } as never) as Promise<{ status?: string; repo?: string; source?: string; error?: string }>;

describe("the workspace_clone the app builds", () => {
  test("in a listed, open channel: the channel's default repo is cloned", async () => {
    expect(await run("C1")).toMatchObject({ status: "cloned", repo: "acme/repo-c1", source: "channel_default" });
    expect(clones.filter((c) => c.endsWith("https://github.com/acme/repo-c1.git"))).toHaveLength(1);
    expect(await run("C2")).toMatchObject({ status: "cloned", repo: "acme/repo-c2", source: "channel_default" });
  });

  test("a row alone is no default: not for a channel off AGENT_CHANNELS, a private channel, a group DM or a DM", async () => {
    const before = clones.length;
    for (const [channel, type] of [["C9", "unknown"], ["C9", "channel"], ["G1", "unknown"], ["G1", "group"], ["G1", "mpim"], ["D1", "im"], ["D1", "unknown"], ["C1", "group"]] as const) {
      const r = await run(channel, type);
      expect([channel, type, r.error?.slice(0, 18)]).toEqual([channel, type, "no repo was named,"]);
    }
    expect(clones.length).toBe(before);
    // Named, a repo still clones there: only the default is the channel's.
    expect(await run("C9", "unknown", { repo: "acme/named" })).toMatchObject({ status: "cloned", source: "named" });
  });

  test("a channel closed since the start (turned private) gets no default, though its row is still there; the open one keeps its own", async () => {
    channels.C2 = { ...channels.C2, is_private: true };
    expect(await until(async () => (await closedChannels()).closed.includes("C2"))).toBe(true);
    const before = clones.length;
    expect((await run("C2")).error).toStartWith("no repo was named,");
    expect(clones.length).toBe(before);
    expect(await run("C1")).toMatchObject({ repo: "acme/repo-c1", source: "channel_default" });
    const db = new Database(DB);
    expect(db.query("SELECT count(*) AS n FROM channel_repos WHERE channel = 'C2'").get()).toEqual({ n: 1 });
    db.close();
  });
});
