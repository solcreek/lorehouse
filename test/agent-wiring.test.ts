// What createApp hands June, pinned: each agent's id, the whole system prompt (the
// instructions and the skill index), the tools in the order the model sees them, with their
// descriptions and schemas, and the channels, for each way an install turns tools on.
// Captured from the code before the agent became the `lorehouse` profile (#39; the tree of
// 6973193) and unchanged by it: a change here is a change in what the model is told or may
// call, to be made on purpose, with these pins updated in the same commit.
//
// defineAgent is wrapped (and still runs) so the test sees what src/app.ts passes it.

import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import * as agentConfig from "@junejs/core/agent-config";
import type { AgentDefinition } from "@junejs/core/agent-config";

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
afterAll(() => {
  mock.module("@junejs/core/agent-config", () => real);
});

const { createApp } = await import("../src/app");
const { loadConfig } = await import("../src/config");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// The pins. The Slack channel's own tools and read_skill are June's, added after Lorehouse's.
const JUNE_TOOLS = ["slack_read_thread", "slack_list_reactions", "slack_resolve_user", "slack_add_reaction", "read_skill"];
const CODE_TOOLS = [
  "workspace_exec",
  "workspace_read_file",
  "workspace_write_file",
  "workspace_attach_file",
  "workspace_job_start",
  "workspace_job_status",
  "workspace_job_cancel",
  "workspace_clone",
  "open_pull_request",
];
// The system prompt differs only by the skill index: with pdf-report in it, or not.
const PROMPT = "d8b4634745f453f35a00a60c32a44dc88924c4824f0e3b8586f6c525fcc10aeb";
const PROMPT_WITH_PDF = "fea6843f40af46bc68df71c5452999a51fdaf9b0e8de39ee94ff0108e09da3d1";

type Given = { id: string; prompt: string; tools: string[]; specs: string; skills: string[]; channels: string[] };
const PINNED: Record<"base" | "everything" | "sandbox" | "pdf", Given> = {
  base: {
    id: "lorehouse",
    prompt: PROMPT,
    tools: ["search_knowledge", "recent_knowledge", ...JUNE_TOOLS],
    specs: "1a494bd53ab90ab60646140ffbc480b37d3a7aec05e1cd65b37d7446667afec9",
    skills: ["channel-digest", "write-a-skill"],
    channels: ["slack"],
  },
  everything: {
    id: "lorehouse",
    prompt: PROMPT_WITH_PDF,
    tools: ["search_knowledge", "recent_knowledge", ...CODE_TOOLS, "render_pdf", ...JUNE_TOOLS],
    specs: "591eb3ebb067a1fff47940199e8fd17cf581b206e61dc9147703a48fff5d2364",
    skills: ["channel-digest", "write-a-skill", "pdf-report"],
    channels: ["slack"],
  },
  sandbox: {
    id: "lorehouse",
    prompt: PROMPT,
    tools: ["search_knowledge", "recent_knowledge", ...CODE_TOOLS, ...JUNE_TOOLS],
    specs: "3f06e48a1df7ac42a7280b14d750007faf3c7a2121e41b3400465cdcbb36dbbf",
    skills: ["channel-digest", "write-a-skill"],
    channels: ["slack"],
  },
  pdf: {
    id: "lorehouse",
    prompt: PROMPT_WITH_PDF,
    tools: ["search_knowledge", "recent_knowledge", "render_pdf", ...JUNE_TOOLS],
    specs: "c4bceb262d0213a259308e8e8070656b33cd8bf806f131f8741175e923003c0f",
    skills: ["channel-digest", "write-a-skill", "pdf-report"],
    channels: ["slack"],
  },
};

const BASE = {
  SLACK_SIGNING_SECRET: "s",
  SLACK_BOT_TOKEN: "xoxb-test",
  ANTHROPIC_API_KEY: "k",
  LOREHOUSE_DB: ":memory:",
  SESSIONS_DB: ":memory:",
};
// The code tools, by a sandbox host Lorehouse calls, or by hosts that connect in.
const DIRECT = { SANDBOX_URL: "http://127.0.0.1:9", SANDBOX_TOKEN: "t", GITHUB_TOKEN: "g" };
const RUNNERS = { SANDBOX_RUNNER_TOKEN: "r".repeat(32) };
const PEM = "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----";
// Every optional tool on: the code tools and PDF replies.
const EVERYTHING = { ...BASE, ...DIRECT, PDF_REPLIES: "1" };

// What June was given by one start with `env`.
async function agentsOf(env: Record<string, string>, profiles?: unknown[]) {
  defined.length = 0;
  const app = await createApp(loadConfig(env), profiles);
  await app.close({ waitMs: 100 });
  return defined.map((a) => ({
    id: a.name,
    prompt: sha256(real.buildSystemPrompt(a)),
    tools: a.tools.map((t) => t.spec.name),
    specs: sha256(JSON.stringify(a.tools.map((t) => t.spec))),
    skills: (a.skills ?? []).map((s) => s.name),
    channels: (a.channels ?? []).map((c) => c.name),
  }));
}

describe("what the app hands June", () => {
  const starts: [string, Record<string, string>, Given][] = [
    ["by default: one agent, `lorehouse`, with the knowledge tools, the built-in skills and the Slack channel", BASE, PINNED.base],
    ["with a sandbox and PDF replies on: the code tools, render_pdf and pdf-report join, in this order", EVERYTHING, PINNED.everything],
    ["with a sandbox only: the code tools, and no render_pdf or pdf-report", { ...BASE, ...DIRECT }, PINNED.sandbox],
    ["with PDF replies only: render_pdf and pdf-report, and no code tools", { ...BASE, PDF_REPLIES: "1" }, PINNED.pdf],
    ["with sandbox hosts that connect in (SANDBOX_RUNNER_TOKEN): the same as a sandbox it calls", { ...BASE, ...RUNNERS, GITHUB_TOKEN: "g" }, PINNED.sandbox],
    ["with a GitHub App for credentials: the same tools as with a token", { ...BASE, ...RUNNERS, GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: PEM }, PINNED.sandbox],
    ["with DM_MODE=answer: the same as by default", { ...BASE, DM_MODE: "answer" }, PINNED.base],
    ["with PR_APPROVER=anyone: the same as any sandbox", { ...BASE, ...DIRECT, PR_APPROVER: "anyone" }, PINNED.sandbox],
  ];
  for (const [name, env, pinned] of starts) {
    test(name, async () => {
      expect(await agentsOf(env)).toEqual([pinned]);
    });
  }
});

describe("a profile becomes an agent (src/profiles.ts, ADR 0002)", () => {
  // A second profile: an automation nothing in Slack starts. It has no Slack channel, so no
  // Approve click can reach it, and it may not open a pull request (the last test here).
  const second = { id: "second", mode: "automation", prompt: "lorehouse", tools: ["recent_knowledge", "search_knowledge", "render_pdf"], skills: ["write-a-skill"], triggers: [], sandbox: "none" };

  test("a second profile is a second agent under its own id, beside an unchanged first", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    const agents = await agentsOf(BASE, [LOREHOUSE, second]);
    expect(agents.map((a) => a.id)).toEqual(["lorehouse", "second"]);
    expect(agents[0]).toEqual(PINNED.base);
  });

  test("it gets the tools and skills it names, in its order, less those the install has off, and no Slack channel", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    const [, off] = await agentsOf(BASE, [LOREHOUSE, second]);
    // PDF replies off: no render_pdf. With no channel, none of the channel's tools.
    expect(off).toMatchObject({ tools: ["recent_knowledge", "search_knowledge", "read_skill"], skills: ["write-a-skill"], channels: [] });
    // A sandbox and PDF replies on: render_pdf joins; the code tools it doesn't list do not.
    const [, on] = await agentsOf(EVERYTHING, [LOREHOUSE, second]);
    expect(on).toMatchObject({ tools: ["recent_knowledge", "search_knowledge", "render_pdf", "read_skill"], skills: ["write-a-skill"], channels: [] });
  });

  test("a wrong profile stops the start before anything is defined, naming the field", async () => {
    defined.length = 0;
    await expect(createApp(loadConfig(BASE), [{ ...second, id: "lorehouse", mode: "interactive" }])).rejects.toThrow(/profile "lorehouse": triggers: an interactive profile needs a trigger of kind "slack"/);
    expect(defined).toEqual([]);
  });

  test("DM_MODE=answer with a profile that doesn't list direct_message is said once on start, and not otherwise", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    const noDms = { ...LOREHOUSE, triggers: [{ kind: "slack", events: ["mention", "follow_up"] }] };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const said = () => warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("direct_message"));
      await agentsOf({ ...BASE, DM_MODE: "answer" }, [noDms]);
      expect(said()).toEqual([expect.stringMatching(/^lorehouse: DM_MODE=answer, but profile "lorehouse" does not list direct_message in its Slack trigger: DMs are accepted by the install and start no turn/)]);
      warn.mockClear();
      await agentsOf(BASE, [noDms]);
      await agentsOf({ ...BASE, DM_MODE: "answer" });
      expect(said()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("a trigger without mention stops the start", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    await expect(createApp(loadConfig(BASE), [{ ...LOREHOUSE, triggers: [{ kind: "slack", events: ["direct_message"] }] }])).rejects.toThrow(/triggers\[0\]\.events: must list "mention"/);
  });

  test("a profile with no Slack channel that lists open_pull_request stops the start: its Approve could never be answered", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    defined.length = 0;
    const opensPrs = { ...second, tools: ["search_knowledge", "open_pull_request"], sandbox: "write" };
    await expect(createApp(loadConfig(EVERYTHING), [LOREHOUSE, opensPrs])).rejects.toThrow(/profile "second": tools: "open_pull_request" needs a trigger of kind "slack"/);
    expect(defined).toEqual([]);
  });
});

