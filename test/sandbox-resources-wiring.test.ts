// The app's wiring of a profile's sandboxResources (#109, src/app.ts): the sandbox the
// tools get is built with the request of the profile Slack starts, over both transports.
// Driven through createApp with a profile that asks, so it fails if app.ts stops handing
// the request to either backend: a direct sandbox host must see the header on a tool's
// call, and a runner must see `resources` on the job.
//
// defineAgent is wrapped (and still runs) so the test gets the tools app.ts built.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as agentConfig from "@junejs/core/agent-config";
import type { AgentDefinition } from "@junejs/core/agent-config";
import { LOREHOUSE } from "../src/profiles";

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

const ASK = { vcpus: 4, memMib: 4096, commandTimeoutSecs: 1800 };
const ASKING = [{ ...LOREHOUSE, sandboxResources: ASK }];
const PUBLIC = { is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_shared: false, is_ext_shared: false, is_org_shared: false, is_pending_ext_shared: false };
// What reached the sandbox host called directly: "<METHOD> <path>" and the request header.
const direct: { call: string; asked: string | null }[] = [];

// One local server standing for Slack's Web API and a sandbox host that honors requests.
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
    direct.push({ call: `${req.method} ${url.pathname}`, asked: req.headers.get("x-lorehouse-sandbox-resources") });
    if (url.pathname === "/v1/capabilities") return Response.json({ version: "0.1.0", features: ["resources"] });
    if (url.pathname.endsWith("/file")) return new Response("content");
    return new Response("not found", { status: 404 });
  },
});
const HERE = `http://127.0.0.1:${server.port}`;
const dir = mkdtempSync(join(tmpdir(), "sandbox-resources-wiring-"));
const RUNNER_TOKEN = "r".repeat(32);
const STATUS = "s".repeat(32);
const apps: Awaited<ReturnType<typeof createApp>>[] = [];

// The app with `sandbox` as its sandbox settings, and its workspace_read_file tool.
async function start(name: string, sandbox: Record<string, string>, profiles?: unknown) {
  const before = defined.length;
  const app = await createApp(loadConfig({
    SLACK_SIGNING_SECRET: "s",
    SLACK_BOT_TOKEN: "xoxb-test",
    SLACK_API_URL: `${HERE}/slack`,
    ANTHROPIC_API_KEY: "k",
    AGENT_CHANNELS: "C1",
    LOREHOUSE_DB: join(dir, `${name}.db`),
    SESSIONS_DB: ":memory:",
    GITHUB_TOKEN: "g",
    STATUS_TOKEN: STATUS,
    INGEST_BACKFILL_DAYS: "0",
    ...sandbox,
  }), profiles);
  apps.push(app);
  const read = defined[before]!.tools.find((t) => t.spec.name === "workspace_read_file")!;
  const run = (session: string) => read.run({ path: "/w/a.txt" }, { sessionId: session } as never) as Promise<{ content?: string; error?: string }>;
  return { app, run };
}

afterAll(async () => {
  for (const app of apps) await app.close({ waitMs: 200 });
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
  mock.module("@junejs/core/agent-config", () => real);
});

describe("the sandbox the app builds for a profile that asks for resources", () => {
  test("called directly: the host is asked whether it honors requests, then the tool's call carries the profile's", async () => {
    const { run } = await start("direct", { SANDBOX_URL: HERE, SANDBOX_TOKEN: "t" }, ASKING);
    direct.length = 0;
    expect(await run("slack_C1_1.1")).toMatchObject({ content: "content" });
    expect(direct.map((d) => d.call)).toEqual(["GET /v1/capabilities", expect.stringMatching(/^GET \/v1\/sandboxes\/[^/]+\.slack_C1_1\.1\/file$/)]);
    expect(direct[1]!.asked).toBe('{"vcpus":4,"memMib":4096,"commandTimeoutSecs":1800}');
  });

  test("called directly, the shipped profile: no question, no header", async () => {
    const { run } = await start("direct-plain", { SANDBOX_URL: HERE, SANDBOX_TOKEN: "t" });
    direct.length = 0;
    expect(await run("slack_C1_2.2")).toMatchObject({ content: "content" });
    expect(direct).toEqual([{ call: expect.stringMatching(/\/file$/), asked: null }]);
  });

  // A runner over long poll, driven through the app's own routes: its poll is held until
  // the tool's job is waiting, and its result lets the tool answer.
  async function throughARunner(name: string, profiles: unknown, session: string) {
    const { app, run } = await start(name, { SANDBOX_RUNNER_TOKEN: RUNNER_TOKEN }, profiles);
    const post = (path: string, body: unknown) => app.fetch(new Request(`http://x${path}`, { method: "POST", headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "x-lorehouse-runner": "box-1", "content-type": "application/json" }, body: JSON.stringify(body) }));
    const polled = post("/runners/poll", { capacity: 2, running: 0, version: "0.1.0", features: ["resources"] });
    // The tool needs a runner to place its sandbox on: wait until the app itself lists
    // this one as connected (its poll has arrived and is held), not for a guessed delay.
    const listed = async () => {
      const status = (await (await app.fetch(new Request("http://x/status", { headers: { authorization: `Bearer ${STATUS}` } }))).json()) as { runners?: { runner: string; online: boolean }[] };
      return !!status.runners?.some((r) => r.runner === "box-1" && r.online);
    };
    const deadline = Date.now() + 5000;
    while (!(await listed())) {
      if (Date.now() > deadline) throw new Error("the runner's poll never registered: /status lists no box-1");
      await Bun.sleep(5);
    }
    const answer = run(session);
    const { jobs } = (await (await polled).json()) as { jobs: Record<string, unknown>[] };
    await post("/runners/results", { results: [{ id: jobs[0]!.id, status: 200, bodyBase64: Buffer.from("content").toString("base64") }] });
    expect(await answer).toMatchObject({ content: "content" });
    return jobs[0]!;
  }

  test("through a runner: the tool's job carries the profile's request", async () => {
    const job = await throughARunner("runner", ASKING, "slack_C1_3.3");
    expect(job).toMatchObject({ op: "guest", method: "GET", path: "/file?path=%2Fw%2Fa.txt", resources: ASK });
    expect(String(job.sandbox)).toEndWith(".slack_C1_3.3");
  });

  test("through a runner, the shipped profile: the job has no resources", async () => {
    const job = await throughARunner("runner-plain", undefined, "slack_C1_4.4");
    expect(job).toMatchObject({ op: "guest", method: "GET" });
    expect("resources" in job).toBe(false);
  });
});
