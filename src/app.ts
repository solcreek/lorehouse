// app.ts — assemble the agent. Framework-specific wiring (June) stays in this file;
// the tools, policy, prompts and knowledge store around it don't depend on it.

import Anthropic from "@anthropic-ai/sdk";
import { anthropic, type AnthropicClient } from "@junejs/core/agent-models";
import { slackChannel } from "@junejs/core/channels";
import { defineAgent, type Channel } from "@junejs/core/agent-config";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { createNativeRuntime, mountAgent, toAgentDef } from "@junejs/server/agent-native";
import type { Config } from "./config";
import { agentIdentity } from "./identity";
import { countDocuments, openKnowledge, recentDocuments, searcher, seedFromJsonl } from "./knowledge";
import { recentKnowledgeTool } from "./tools/recent-knowledge";
import { SlackIngester } from "./ingest/slack";
import { slackApi } from "./slack-api";
import { publicChannelsOnly } from "./policy";
import { systemPrompt } from "./prompts";
import { remoteSandbox } from "./sandbox-client";
import { RunnerHub } from "./runners/hub";
import { runnerRoutes } from "./runners/routes";
import type { Server } from "bun";
import type { RunnerSocketData } from "./runners/routes";
import { searchKnowledgeTool } from "./tools/search-knowledge";
import { withNamedPeople } from "./tools/slack-names";
import { directMessage, redirectText } from "./dm";
import { statusRefusal } from "./status-auth";
import { inThread, isFollowUp, joinThread } from "./threads";
import { pullRequestTool } from "./tools/pull-request";
import { cloneTool } from "./tools/clone";
import { githubApp, staticToken } from "./github-auth";
import { workspaceTools } from "./tools/workspace";

// How each tool call shows up on the reply's task timeline in Slack.
const TASK_LABELS: Record<string, string> = {
  search_knowledge: "Searching what the company knows",
  recent_knowledge: "Looking at recent discussions",
  slack_read_thread: "Reading the thread",
  workspace_clone: "Getting the repo",
  workspace_exec: "Running a command in the sandbox",
  workspace_read_file: "Reading a file",
  workspace_write_file: "Editing a file",
  open_pull_request: "Preparing a pull request",
};

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

  const tools: Tool[] = [
    searchKnowledgeTool(searcher(knowledge)),
    recentKnowledgeTool((o) => recentDocuments(knowledge, o)),
  ];
  // Sandbox runners connect in (docs/sandbox-runners.md); or one host is called directly.
  const hub = config.sandbox?.mode === "runners" ? new RunnerHub(knowledge, { log: (m) => console.log(m) }) : undefined;
  const runners = hub && config.sandbox?.mode === "runners" ? runnerRoutes(hub, config.sandbox.runnerToken) : undefined;
  if (config.sandbox) {
    const sb = config.sandbox;
    // One sandbox per thread, keyed off the session (never model input).
    const sandboxId = (ctx: ToolContext) => ctx.sessionId.replace(/[^\w.-]/g, "_");
    const sandboxFor = sb.mode === "runners"
      ? (ctx: ToolContext) => hub!.sandbox(sandboxId(ctx))
      : (ctx: ToolContext) => remoteSandbox(sandboxId(ctx), { url: sb.url, token: sb.token });
    // Per-repo GitHub credentials: from the App (short-lived, least permission) or a token.
    const github = sb.github.kind === "app" ? githubApp({ appId: sb.github.appId, privateKey: sb.github.privateKey }) : staticToken(sb.github.token);
    const approverName = async (userId: string) => (await ingester?.names([userId]))?.get(userId)?.full;
    tools.push(...workspaceTools(sandboxFor, { commitAs: github.identity }), cloneTool(sandboxFor, github), pullRequestTool({ sandboxFor, github, identity, approverName }));
  }

  const dm = config.agent.dm;
  const slack: Channel = withNamedPeople(slackChannel({
    signingSecret: config.slack.signingSecret,
    botToken: config.slack.botToken,
    apiUrl: config.slack.apiUrl,
    botUserId: config.slack.botUserId,
    path: "/slack/events",
    // Mentions start a turn, and so do follow-ups in a thread the agent was mentioned in
    // (see threads.ts); with DM_MODE=answer, DMs too. Those arrive as `message` events
    // like every channel message: respondWhen keeps the rest to knowledge.
    respondTo: ["app_mention", "message"],
    respondWhen: (e) =>
      e.kind === "app_mention" ||
      (dm === "answer" && e.channelType === "im") ||
      isFollowUp(e, (channel, thread) => inThread(knowledge, channel, thread)),
    // A mention asks the agent into its thread.
    on: { app_mention: (e) => joinThread(knowledge, e.channelId, e.threadId ?? e.ts) },
    // Every public message event the policy lets through (new, edited, deleted) keeps
    // the knowledge index in step (DMs aren't on the allowlist, so never indexed). onEvent,
    // not on.message: the framework normalizes away edits and deletions.
    onEvent: ingester || config.logSlackEvents || dm === "redirect"
      ? ({ raw }) => {
          const event = (raw as { event?: Record<string, unknown> }).event;
          if (config.logSlackEvents) console.log(`slack event: ${JSON.stringify(event)}`);
          ingester?.onRawEvent(event);
          const direct = dm === "redirect" ? directMessage(raw) : undefined;
          if (direct) return slack.post!({ channelId: direct.channel }, redirectText(config.agent.channels)).then(() => undefined);
        }
      : undefined,
    accept: publicChannelsOnly(config.agent.channels, { dms: dm !== "ignore" }),
    stream: true,
    // What the model says before a tool call ("Let me search…") goes to the task
    // timeline, not into the answer; only the final step's text is the reply.
    intermediateText: "status",
    tasks: (call) => TASK_LABELS[call.name] ?? `Running ${call.name.replaceAll("_", " ")}`,
    onError: (err) => console.error("slack:", err),
  }), async (ids) => (await ingester?.names(ids)) ?? new Map());

  const agent = defineAgent({
    name: AGENT_ID,
    instructions: systemPrompt(identity),
    tools,
    channels: [slack],
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
    // Bun.serve's websocket handlers (sandbox runners), when runners are enabled.
    websocket: runners?.websocket,
    async fetch(req: Request, server?: Server<RunnerSocketData>): Promise<Response> {
      const path = new URL(req.url).pathname;
      if (path === "/healthz") return new Response("ok");
      if (path === "/status" && req.method === "GET") {
        const refusal = statusRefusal(req, config.statusToken);
        if (refusal) return refusal;
        return Response.json({
          agent: identity.name,
          knowledge: ingester?.status() ?? { state: "idle", documents: countDocuments(knowledge), channels: {} },
          ...(hub ? { runners: hub.status() } : {}),
        });
      }
      const runnerReply = await runners?.handle(req, server);
      if (runnerReply) return runnerReply;
      return (await mounted.fetch(req)) ?? new Response("not found", { status: 404 });
    },
    close() {
      knowledge.close();
    },
  };
}
