// app.ts — assemble the agent. Framework-specific wiring (June) stays in this file;
// the tools, policy, prompts and knowledge store around it don't depend on it.

import Anthropic from "@anthropic-ai/sdk";
import { anthropic, type AnthropicClient } from "@junejs/core/agent-models";
import { slackChannel } from "@junejs/core/channels";
import { defineAgent } from "@junejs/core/agent-config";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { createNativeRuntime, mountAgent, toAgentDef } from "@junejs/server/agent-native";
import type { Config } from "./config";
import { agentIdentity } from "./identity";
import { countDocuments, openKnowledge, searcher, seedFromJsonl } from "./knowledge";
import { SlackIngester } from "./ingest/slack";
import { slackApi } from "./slack-api";
import { publicChannelsOnly } from "./policy";
import { systemPrompt } from "./prompts";
import { remoteSandbox } from "./sandbox-client";
import { searchKnowledgeTool } from "./tools/search-knowledge";
import { pullRequestTool } from "./tools/pull-request";
import { workspaceTools } from "./tools/workspace";

// The durable agent id is fixed; the display name is config. Renaming the agent in a
// workspace must not orphan its threads' sessions.
const AGENT_ID = "lorehouse";

export async function createApp(config: Config) {
  const identity = agentIdentity(config.agent.name, config.agent.coAuthor);

  const knowledge = openKnowledge(config.db.lorehouse);
  const seeded = config.db.knowledgeSeed ? seedFromJsonl(knowledge, config.db.knowledgeSeed) : 0;

  // Slack history becomes knowledge — only for channels the agent is allowed in.
  const ingester = config.agent.channels.size
    ? new SlackIngester(slackApi({ token: config.slack.botToken, apiUrl: config.slack.apiUrl }), knowledge, {
        channels: config.agent.channels,
        backfillDays: config.ingest.backfillDays,
        refreshDays: config.ingest.refreshDays,
        debounceMs: config.ingest.debounceMs,
        log: (m) => console.log(m),
      })
    : undefined;

  const tools: Tool[] = [searchKnowledgeTool(searcher(knowledge))];
  if (config.sandbox) {
    const { url, token, githubToken } = config.sandbox;
    // One sandbox per thread, keyed off the session (never model input).
    const sandboxFor = (ctx: ToolContext) => remoteSandbox(ctx.sessionId.replace(/[^\w.-]/g, "_"), { url, token });
    tools.push(...workspaceTools(sandboxFor), pullRequestTool({ sandboxFor, githubToken: () => githubToken, identity }));
  }

  const agent = defineAgent({
    name: AGENT_ID,
    instructions: systemPrompt(identity),
    tools,
    channels: [
      slackChannel({
        signingSecret: config.slack.signingSecret,
        botToken: config.slack.botToken,
        apiUrl: config.slack.apiUrl,
        botUserId: config.slack.botUserId,
        path: "/slack/events",
        respondTo: ["app_mention"],
        // Every public message event the policy lets through (new, edited, deleted) keeps
        // the knowledge index in step; only mentions start a turn. onEvent, not
        // on.message: the framework normalizes away edits and deletions.
        onEvent: ingester || config.logSlackEvents
          ? ({ raw }) => {
              const event = (raw as { event?: Record<string, unknown> }).event;
              if (config.logSlackEvents) console.log(`slack event: ${JSON.stringify(event)}`);
              ingester?.onRawEvent(event);
            }
          : undefined,
        accept: publicChannelsOnly(config.agent.channels),
        stream: true,
        onError: (err) => console.error("slack:", err),
      }),
    ],
  });

  const model = anthropic({
    model: config.anthropic.model,
    maxTokens: 4096,
    // Injected: bundlers can't see June's lazy SDK import, so a compiled binary needs it.
    // The cast works around a June typing gap: its AnthropicStreamEvent.delta is an
    // all-optional ("weak") type, and @anthropic-ai/sdk 0.128's message_delta shares none
    // of its keys, so tsc rejects the real SDK. Runtime behavior is fine. Drop the cast
    // when junebuild/june#195 ships.
    client: new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl }) as unknown as AnthropicClient,
  });
  const runtime = await createNativeRuntime({ [AGENT_ID]: toAgentDef(agent, model) }, config.db.sessions);
  const mounted = mountAgent(agent, runtime);

  return {
    identity,
    seeded,
    // Kick off the Slack backfill; call after the server is listening (it runs in the
    // background and never blocks /healthz).
    startIngest: () => ingester?.start(),
    async fetch(req: Request): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return new Response("ok");
      if (path === "/status" && req.method === "GET") {
        return Response.json({
          agent: identity.name,
          knowledge: ingester?.status() ?? { state: "idle", documents: countDocuments(knowledge), channels: {} },
        });
      }
      return (await mounted.fetch(req)) ?? new Response("not found", { status: 404 });
    },
    close() {
      knowledge.close();
    },
  };
}
