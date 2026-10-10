// app.ts — assemble the agent. Framework-specific wiring (June) stays in this file;
// the tools, policy, prompts and knowledge store around it don't depend on it.

import Anthropic from "@anthropic-ai/sdk";
import { anthropic, type AnthropicClient } from "@junejs/core/agent-models";
import { slackChannel, type SlackNormalizedEvent } from "@junejs/core/channels";
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
import { adminRoutes } from "./admin";
import { inThread, isFollowUp, joinThread } from "./threads";
import { channelsToNotify, eraseAskers, feedbackOf, forgetAsk, markNotified, notifiedChannels, pruneUsage, raterKey, reconcileAsks, recordAsk, recordFeedback, recordSearch, usageSummary, USAGE_RETENTION_DAYS } from "./usage";
import { cachedNames } from "./ingest/slack-users";
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
        // Questions deleted while the app was down are forgotten in usage too, as live.
        onReconciled: async (channel, oldestSec, roots) => {
          try {
            const n = await reconcileAsks(knowledge, channel, oldestSec, { roots, thread: (ts) => ingester!.threadMessageTs(channel, ts) });
            if (n) console.log(`usage: ${channel}: forgot ${n} question(s) deleted while down`);
          } catch (err) {
            console.error("usage:", err); // bookkeeping: never fails the ingest
          }
        },
      })
    : undefined;

  // Usage is bookkeeping: a failed write is logged, never allowed to cost an answer.
  const tally = (write: () => void) => {
    try {
      write();
    } catch (err) {
      console.error("usage:", err);
    }
  };

  // Usage is kept USAGE_RETENTION_DAYS: pruned on start, then daily.
  tally(() => pruneUsage(knowledge));
  // Not recording who asks (the default, or opted out again): forget any asker kept before.
  const recordPeople = config.usage.recordPeople;
  if (!recordPeople) tally(() => eraseAskers(knowledge));
  // Opted in, a channel's askers are recorded only once it has been told (the notices go
  // out after the server is up, so the first asks may come before them).
  const told = recordPeople ? notifiedChannels(knowledge) : new Set<string>();
  setInterval(() => tally(() => pruneUsage(knowledge)), 86_400_000).unref();

  const tools: Tool[] = [
    // A search is counted in the Slack thread it ran for (a top-level question is its own
    // thread's root, as for asks); DMs aren't counted.
    searchKnowledgeTool(searcher(knowledge), (query, hits, ctx) => {
      const e = ctx.event as SlackNormalizedEvent | undefined;
      if (e?.source !== "slack" || !e.channelId || e.channelType === "im") return;
      const threadTs = e.threadId ?? e.ts;
      if (threadTs) tally(() => recordSearch(knowledge, { channel: e.channelId, threadTs, query, hits }));
    }),
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
    const apiUrl = config.githubApiUrl;
    const github = sb.github.kind === "app" ? githubApp({ appId: sb.github.appId, privateKey: sb.github.privateKey, apiUrl }) : staticToken(sb.github.token, { apiUrl });
    const approverName = async (userId: string) => (await ingester?.names([userId]))?.get(userId)?.full;
    tools.push(...workspaceTools(sandboxFor, { commitAs: github.identity }), cloneTool(sandboxFor, github), pullRequestTool({ sandboxFor, github, identity, approverName, apiUrl }));
  }

  const dm = config.agent.dm;
  const shouldRespond = (e: SlackNormalizedEvent) =>
    e.kind === "app_mention" ||
    (dm === "answer" && e.channelType === "im") ||
    isFollowUp(e, (channel, thread) => inThread(knowledge, channel, thread));
  // A 👍/👎 on one of the agent's replies is feedback, recorded and never answered, and
  // kept under a keyed hash of the person, never their Slack id (usage.ts). Without the
  // agent's own id no reaction can count, and usage would read as if nobody reacted: say
  // so, once.
  const rater = raterKey(config.slack.signingSecret);
  let warnedNoBotId = false;
  const onReaction = (e: SlackNormalizedEvent) => {
    const botUserId = ingester?.ownUserId ?? config.slack.botUserId;
    if (!botUserId && !warnedNoBotId) {
      warnedNoBotId = true;
      console.error("usage: a reaction arrived before the agent's own user id is known (auth.test pending or failed, and no SLACK_BOT_USER_ID); it is not counted; reactions are counted again once the id is known");
    }
    const f = feedbackOf(e, botUserId);
    if (f) tally(() => recordFeedback(knowledge, { channel: f.channel, messageTs: f.messageTs, rater: rater(f.user), rating: f.rating }, e.kind === "reaction_added"));
  };
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
    respondWhen: (e) => {
      const respond = shouldRespond(e);
      // An ask records where; who, only if the install opted in and the channel was told
      // (usage.ts). A recorded asker's name is cached now, so reading usage never asks Slack.
      const user = told.has(e.channelId) ? e.user?.id : undefined;
      if (respond && e.channelType !== "im") tally(() => recordAsk(knowledge, { channel: e.channelId, ts: e.ts, threadTs: e.threadId ?? e.ts, user }));
      if (respond && user) void ingester?.names([user]).catch(() => undefined);
      return respond;
    },
    // A mention asks the agent into its thread. Reactions are observed only: they are not
    // in respondTo, so none starts a turn.
    on: {
      app_mention: (e) => joinThread(knowledge, e.channelId, e.threadId ?? e.ts),
      reaction_added: onReaction,
      reaction_removed: onReaction,
    },
    // Every public message event the policy lets through (new, edited, deleted) keeps
    // the knowledge index in step (DMs aren't on the allowlist, so never indexed). onEvent,
    // not on.message: the framework normalizes away edits and deletions.
    onEvent: ingester || config.logSlackEvents || dm === "redirect"
      ? ({ raw }) => {
          const event = (raw as { event?: Record<string, unknown> }).event;
          if (config.logSlackEvents) console.log(`slack event: ${JSON.stringify(event)}`);
          ingester?.onRawEvent(event);
          // A question deleted in Slack takes its ask (and, as a thread root, its searches) along.
          if (event?.subtype === "message_deleted" && event.channel_type !== "im" && typeof event.channel === "string" && typeof event.deleted_ts === "string") {
            const { channel, deleted_ts } = event;
            tally(() => forgetAsk(knowledge, channel, deleted_ts));
          }
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
  // Recording who asks is never silent: each channel is told when it starts, and again
  // when it stops (the record erased). Once per change, not on every start.
  const announceRecordPeople = async () => {
    const text = recordPeople
      ? `Heads-up: in this workspace I now record who asks me things here, for usage numbers the admins can see. The record is kept ${USAGE_RETENTION_DAYS} days.`
      : "I no longer record who asks me things here, and the record I kept is erased.";
    for (const channel of channelsToNotify(knowledge, config.agent.channels, recordPeople)) {
      try {
        await slack.post!({ channelId: channel }, text);
        markNotified(knowledge, channel, recordPeople);
        if (recordPeople) told.add(channel);
      } catch (err) {
        console.error(`usage: telling ${channel} whether askers are recorded:`, err); // tried again on the next start
      }
    }
  };

  // The read-only admin API (/api/v1), behind ADMIN_TOKEN.
  const admin = adminRoutes({
    db: knowledge,
    token: config.adminToken,
    ingest: () => ingester?.status(),
    sandbox: config.sandbox?.mode ?? "off",
    runners: hub ? () => hub.status() : undefined,
    // With askers recorded, each is named as knowledge names people, from the names already
    // cached: the admin API only reads (no Slack call, no write). Uncached: name null.
    usage: (since) => {
      const summary = usageSummary(knowledge, { since, people: recordPeople });
      if (!summary.askers?.length) return summary;
      const names = cachedNames(knowledge, summary.askers.map((a) => a.user));
      return { ...summary, askers: summary.askers.map((a) => ({ ...a, name: names.get(a.user)?.full ?? null })) };
    },
  });

  return {
    identity,
    seeded,
    // Kick off the Slack backfill; call after the server is listening (it runs in the
    // background and never blocks /healthz).
    startIngest: async () => {
      await announceRecordPeople();
      await ingester?.start();
    },
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
          // Whether usage records who asks: a setting, not anyone's data.
          recordsWhoAsks: recordPeople,
          ...(hub ? { runners: hub.status() } : {}),
        });
      }
      const adminReply = await admin(req);
      if (adminReply) return adminReply;
      const runnerReply = await runners?.handle(req, server);
      if (runnerReply) return runnerReply;
      return (await mounted.fetch(req)) ?? new Response("not found", { status: 404 });
    },
    close() {
      knowledge.close();
    },
  };
}
