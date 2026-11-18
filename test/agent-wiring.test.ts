// What createApp hands June, pinned: each agent's id, the whole system prompt (the
// instructions and the skill index), the tools in the order the model sees them, with their
// descriptions and schemas, and the channels. Captured before the agent became the
// `lorehouse` profile (#39) and unchanged by it: a change here is a change in what the model
// is told or may call, to be made on purpose, with these pins updated in the same commit.
//
// defineAgent is wrapped (and still runs) so the test sees what src/app.ts passes it.

import { afterAll, describe, expect, mock, test } from "bun:test";
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

const BASE = {
  SLACK_SIGNING_SECRET: "s",
  SLACK_BOT_TOKEN: "xoxb-test",
  ANTHROPIC_API_KEY: "k",
  LOREHOUSE_DB: ":memory:",
  SESSIONS_DB: ":memory:",
};
// Every optional tool on: the code tools (a sandbox) and PDF replies.
const EVERYTHING = { ...BASE, SANDBOX_URL: "http://127.0.0.1:9", SANDBOX_TOKEN: "t", GITHUB_TOKEN: "g", PDF_REPLIES: "1" };

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
  test("by default: one agent, `lorehouse`, with the knowledge tools, the built-in skills and the Slack channel", async () => {
    expect(await agentsOf(BASE)).toEqual(PINNED.base);
  });

  test("with a sandbox and PDF replies on: the code tools, render_pdf and pdf-report join, in this order", async () => {
    expect(await agentsOf(EVERYTHING)).toEqual(PINNED.everything);
  });
});

describe("a profile becomes an agent (src/profiles.ts, ADR 0002)", () => {
  // A second profile, as #44 will add one: an automation nothing in Slack starts.
  const second = { id: "second", mode: "automation", prompt: "lorehouse", tools: ["recent_knowledge", "search_knowledge", "open_pull_request"], skills: ["write-a-skill"], triggers: [], sandbox: "write" };

  test("a second profile is a second agent under its own id, beside an unchanged first", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    const agents = await agentsOf(BASE, [LOREHOUSE, second]);
    expect(agents.map((a) => a.id)).toEqual(["lorehouse", "second"]);
    expect(agents[0]).toEqual(PINNED.base[0]!);
  });

  test("it gets the tools and skills it names, in its order, less those the install has off, and no Slack channel", async () => {
    const { LOREHOUSE } = await import("../src/profiles");
    const [, off] = await agentsOf(BASE, [LOREHOUSE, second]);
    // No sandbox: open_pull_request is off. With no channel, none of the channel's tools.
    expect(off).toMatchObject({ tools: ["recent_knowledge", "search_knowledge", "read_skill"], skills: ["write-a-skill"], channels: [] });
    const [, on] = await agentsOf(EVERYTHING, [LOREHOUSE, second]);
    expect(on).toMatchObject({ tools: ["recent_knowledge", "search_knowledge", "open_pull_request", "read_skill"], skills: ["write-a-skill"], channels: [] });
  });

  test("a wrong profile stops the start before anything is defined, naming the field", async () => {
    defined.length = 0;
    await expect(createApp(loadConfig(BASE), [{ ...second, id: "lorehouse", mode: "interactive" }])).rejects.toThrow(/profile "lorehouse": triggers: an interactive profile needs a trigger of kind "slack"/);
    expect(defined).toEqual([]);
  });
});

// The Slack channel's own tools and read_skill are June's, added after Lorehouse's.
const JUNE_TOOLS = ["slack_read_thread", "slack_list_reactions", "slack_resolve_user", "slack_add_reaction", "read_skill"];

type Given = { id: string; prompt: string; tools: string[]; specs: string; skills: string[]; channels: string[] };
const PINNED: Record<"base" | "everything", Given[]> = {
  base: [
    {
      id: "lorehouse",
      prompt: "d8b4634745f453f35a00a60c32a44dc88924c4824f0e3b8586f6c525fcc10aeb",
      tools: ["search_knowledge", "recent_knowledge", ...JUNE_TOOLS],
      specs: "1a494bd53ab90ab60646140ffbc480b37d3a7aec05e1cd65b37d7446667afec9",
      skills: ["channel-digest", "write-a-skill"],
      channels: ["slack"],
    },
  ],
  everything: [
    {
      id: "lorehouse",
      prompt: "fea6843f40af46bc68df71c5452999a51fdaf9b0e8de39ee94ff0108e09da3d1",
      tools: [
        "search_knowledge",
        "recent_knowledge",
        "workspace_exec",
        "workspace_read_file",
        "workspace_write_file",
        "workspace_attach_file",
        "workspace_job_start",
        "workspace_job_status",
        "workspace_job_cancel",
        "workspace_clone",
        "open_pull_request",
        "render_pdf",
        ...JUNE_TOOLS,
      ],
      specs: "591eb3ebb067a1fff47940199e8fd17cf581b206e61dc9147703a48fff5d2364",
      skills: ["channel-digest", "write-a-skill", "pdf-report"],
      channels: ["slack"],
    },
  ],
};
