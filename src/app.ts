// app.ts — assemble the agent. Framework-specific wiring (June) stays in this file;
// the tools, policy, prompts and knowledge store around it don't depend on it.

import Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "@junejs/core/agent-models";
import { slackChannel, type SlackNormalizedEvent } from "@junejs/core/channels";
import { defineAgent, parseSkill, type Channel } from "@junejs/core/agent-config";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { memoryFileStore, type FileStore } from "@junejs/core/agent-files";
import { createNativeRuntime, mountAgent, toAgentDef } from "@junejs/server/agent-native";
import { assertDistinctDatabases, type Config } from "./config";
import { agentIdentity } from "./identity";
import { closeKnowledge, countDocuments, openKnowledge, recentDocuments, searcher, seedFromJsonl } from "./knowledge";
import { recentKnowledgeTool } from "./tools/recent-knowledge";
import { SlackIngester } from "./ingest/slack";
import { slackApi } from "./slack-api";
import { publicChannelsOnly } from "./policy";
import { assertPublicChannels, lookUpChannel } from "./channel-check";
import { describePurge, purgeUnlistedChannels } from "./purge";
import { PDF_SKILLS, SKILLS, systemPrompt } from "./prompts";
import { renderPdfTool, typstRenderer } from "./tools/render-pdf";
import { remoteSandbox } from "./sandbox-client";
import { RunnerHub } from "./runners/hub";
import { runnerRoutes } from "./runners/routes";
import type { Server } from "bun";
import type { RunnerSocketData } from "./runners/routes";
import { searchKnowledgeTool } from "./tools/search-knowledge";
import { withNamedPeople } from "./tools/slack-names";
import { withChannelGuard } from "./tools/slack-channels";
import { neutralizeMentions } from "./mentions";
import { withoutMentions } from "./slack-guard";
import { directMessage, redirectText } from "./dm";
import { statusRefusal } from "./status-auth";
import { adminRoutes } from "./admin";
import { inThread, isFollowUp, joinThread } from "./threads";
import { mayStartTurn, members, refusalText, type Membership } from "./members";
import { channelsToNotify, eraseAskers, feedbackOf, forgetAsk, markNotified, notifiedChannels, pruneUsage, raterKey, reconcileAsks, recordAsk, recordFeedback, recordSearch, usageSummary, USAGE_RETENTION_DAYS } from "./usage";
import { cachedNames } from "./ingest/slack-users";
import { pullRequestTool } from "./tools/pull-request";
import { approvalStore, approverGate } from "./approvals";
import { cloneTool } from "./tools/clone";
import { githubApp, staticToken } from "./github-auth";
import { workspaceTools } from "./tools/workspace";
import { jobStore, jobTools, slackJobAuthority } from "./tools/jobs";

// How each tool call shows up on the reply's task timeline in Slack.
const TASK_LABELS: Record<string, string> = {
  search_knowledge: "Searching what the company knows",
  recent_knowledge: "Looking at recent discussions",
  slack_read_thread: "Reading the thread",
  read_skill: "Reading a skill",
  workspace_clone: "Getting the repo",
  workspace_exec: "Running a command in the sandbox",
  workspace_read_file: "Reading a file",
  workspace_write_file: "Editing a file",
  workspace_job_start: "Starting a job in the sandbox",
  workspace_job_status: "Checking on the job",
  workspace_job_cancel: "Stopping the job",
  workspace_attach_file: "Attaching a file",
  open_pull_request: "Preparing a pull request",
  render_pdf: "Making the PDF",
};

// The durable agent id is fixed; the display name is config. Renaming the agent in a
// workspace must not orphan its threads' sessions.
const AGENT_ID = "lorehouse";

export async function createApp(config: Config) {
  const identity = agentIdentity(config.agent.name, config.agent.coAuthor);

  // Every listed channel must be public, as Slack says (channel-check.ts): before the
  // database is opened or purged, and before anything listens. A ConfigError names each.
  const slackReads = slackApi({ token: config.slack.botToken, apiUrl: config.slack.apiUrl });
  await assertPublicChannels(slackReads, config.agent.channels);

  const knowledge = openKnowledge(config.db.lorehouse);
  // Both files exist from here on, so this compares the files themselves, not their names.
  try {
    assertDistinctDatabases(config.db.lorehouse, config.db.sessions);
  } catch (err) {
    closeKnowledge(knowledge);
    throw err;
  }
  // A channel taken off AGENT_CHANNELS leaves the index, with its joined threads, before
  // anything is answered (purge.ts); an empty list leaves nothing from Slack.
  for (const p of purgeUnlistedChannels(knowledge, config.agent.channels)) console.log(describePurge(p));
  const seeded = config.db.knowledgeSeed ? seedFromJsonl(knowledge, config.db.knowledgeSeed) : 0;

  // Slack history becomes knowledge — only for channels the agent is allowed in.
  const ingester = config.agent.channels.size
    ? new SlackIngester(slackReads, knowledge, {
        channels: config.agent.channels,
        lookUp: (channel) => lookUpChannel(slackReads, channel),
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
  // Every timer the app arms, cleared on close.
  const timers: ReturnType<typeof setInterval>[] = [];
  timers.push(setInterval(() => tally(() => pruneUsage(knowledge)), 86_400_000).unref());

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
  // Who may click Approve on a pull request card is the install's rule (PR_APPROVER, ADR
  // 0002 §6). The card names APPROVER_POLICY, so June asks authorizeAnswer as each click
  // arrives; a refused click changes nothing, and the clicker alone is told so. Who June
  // says answered a click let through is recorded (src/approvals.ts) until the turn ends, so
  // the tool can check the rule against who answered when it pushes, and name them. What a
  // restart left behind is pruned on start, then daily.
  const approvals = approvalStore(knowledge);
  tally(() => approvals.prune());
  timers.push(setInterval(() => tally(() => approvals.prune()), 86_400_000).unref());
  let runtime: Awaited<ReturnType<typeof createNativeRuntime>> | undefined;
  // An approver must be a full member of the workspace, like an asker (#145). memberCheck
  // and the ingester are set up below; a click only comes later, once both exist.
  const authorizeAnswer = approverGate(config.prApprover, approvals, (session) => runtime?.session(AGENT_ID, session), async (user) =>
    (await memberCheck.check(user, ingester?.ownTeamId)).member,
  );
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
    // Who started each background job, for who may cancel it (tools/jobs.ts): pruned on
    // start, then daily.
    const jobs = jobStore(knowledge);
    tally(() => jobs.prune());
    timers.push(setInterval(() => tally(() => jobs.prune()), 86_400_000).unref());
    tools.push(
      ...workspaceTools(sandboxFor, { commitAs: github.identity }),
      ...jobTools(sandboxFor, { store: jobs, authority: slackJobAuthority(slackReads, approverName), commitAs: github.identity }),
      cloneTool(sandboxFor, github),
      pullRequestTool({ sandboxFor, github, identity, approverName, approver: config.prApprover, approvals, apiUrl }),
    );
  }

  // PDF replies: render_pdf puts the file in the store, and the Slack channel uploads it
  // to the thread after the reply.
  if (config.pdf) tools.push(renderPdfTool(typstRenderer(config.pdfFonts)));

  // Where the agent works: the listed channels, less any ingest found private, archived or
  // shared since the start (refused from then on; see ingest/slack.ts).
  const listed = { has: (channel: string) => config.agent.channels.has(channel) && !ingester?.isClosed(channel) };

  const dm = config.agent.dm;
  const shouldRespond = (e: SlackNormalizedEvent) =>
    e.kind === "app_mention" ||
    (dm === "answer" && e.channelType === "im") ||
    isFollowUp(e, (channel, thread) => inThread(knowledge, channel, thread));
  // Only full members of the workspace are answered (members.ts, #145): a guest, or someone
  // from another workspace, can't open every channel an answer may quote. The sender of an
  // event that may start a turn is looked up (users.info, cached) in resolveIdentity, which
  // June awaits before respondWhen; respondWhen then reads the verdict. Mentions, follow-ups
  // and DMs all pass through it; reactions never start a turn. No principal is pinned: the
  // hook is used only to look the sender up before the turn is decided.
  const memberCheck = members(slackReads);
  const refuse = (e: SlackNormalizedEvent, verdict: Membership | undefined) => {
    const v: Membership = verdict ?? { user: e.user?.id ?? "", member: false, reason: "lookup_failed", error: "not looked up" };
    if (v.member) return;
    console.log(`members: not answered: ${v.reason === "lookup_failed" ? `couldn't check the sender (${v.error})` : `the sender is ${v.reason === "guest" ? "a guest" : v.reason === "external" ? "from another workspace" : "deactivated"}`}`);
    const threadId = e.channelType === "im" ? e.threadId : (e.threadId ?? e.ts);
    void slack.post!({ channelId: e.channelId, threadId }, refusalText(v)).catch((err) => console.error("members: posting the refusal:", err));
  };
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
  // People's names, as knowledge names them (from its cache; none before ingest is up).
  const names = async (ids: string[]) => (await ingester?.names(ids)) ?? new Map();
  // Everything posted to Slack goes through withoutMentions: no reply, timeline note,
  // Approve card or notice can @-mention anyone, whatever the model writes (ADR 0002 §6).
  // The channel's own tools (read a thread, list or add reactions) reach only the channel
  // being answered in and those on AGENT_CHANNELS (slack-channels.ts).
  const slack: Channel = withoutMentions(withChannelGuard(withNamedPeople(slackChannel({
    signingSecret: config.slack.signingSecret,
    botToken: config.slack.botToken,
    apiUrl: config.slack.apiUrl,
    botUserId: config.slack.botUserId,
    path: "/slack/events",
    // Mentions start a turn, and so do follow-ups in a thread the agent was mentioned in
    // (see threads.ts); with DM_MODE=answer, DMs too. Those arrive as `message` events
    // like every channel message: respondWhen keeps the rest to knowledge.
    respondTo: ["app_mention", "message"],
    // Looks up who sent an event that may start a turn, before respondWhen (see members.ts).
    resolveIdentity: async (id) => {
      if (id.userId && mayStartTurn(id, dm === "answer")) await memberCheck.check(id.userId, id.teamId);
      return undefined;
    },
    respondWhen: (e) => {
      if (!shouldRespond(e)) return false;
      // Fails closed: a sender not looked up, or not a full member, gets one line instead.
      const verdict = e.user?.id ? memberCheck.peek(e.user.id) : undefined;
      if (!verdict?.member) {
        refuse(e, verdict);
        return false;
      }
      // An ask records where; who, only if the install opted in and the channel was told
      // (usage.ts). A recorded asker's name is cached now, so reading usage never asks Slack.
      const user = told.has(e.channelId) ? e.user?.id : undefined;
      if (e.channelType !== "im") tally(() => recordAsk(knowledge, { channel: e.channelId, ts: e.ts, threadTs: e.threadId ?? e.ts, user }));
      if (user) void ingester?.names([user]).catch(() => undefined);
      return true;
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
    accept: publicChannelsOnly(listed, { dms: dm !== "ignore" }),
    stream: true,
    // What the model says before a tool call ("Let me search…") goes to the task
    // timeline, not into the answer; only the final step's text is the reply.
    intermediateText: "status",
    // The name is the model's to choose: guarded like everything else it writes.
    tasks: (call) => neutralizeMentions(TASK_LABELS[call.name] ?? `Running ${call.name.replaceAll("_", " ")}`),
    onError: (err) => console.error("slack:", err),
  }), names), (c) => listed.has(c)), names);

  const agent = defineAgent({
    name: AGENT_ID,
    instructions: systemPrompt(identity),
    tools,
    skills: Object.entries({ ...SKILLS, ...(config.pdf ? PDF_SKILLS : {}) }).map(([name, text]) => parseSkill(name, text)),
    channels: [slack],
    authorizeAnswer,
  });

  const model = anthropic({
    model: config.anthropic.model,
    maxTokens: 4096,
    // Injected: bundlers can't see June's lazy SDK import, so a compiled binary needs it.
    // No cast: tsc checks the real SDK client against June's AnthropicClient here.
    client: new Anthropic({ apiKey: config.anthropic.apiKey, baseURL: config.anthropic.baseUrl }),
  });
  runtime = await createNativeRuntime({ [AGENT_ID]: toAgentDef(agent, model) }, config.db.sessions, { files: fileStore(config.files.store) });
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
      // A channel can turn private (or be archived) while the app runs: look again
      // (INGEST_CHANNEL_RECHECK_MS, hourly by default), armed before anything here can fail.
      if (ingester && config.ingest.recheckMs > 0) {
        timers.push(setInterval(() => void ingester.recheckChannels().catch((err) => console.error("ingest:", err)), config.ingest.recheckMs).unref());
      }
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
          // Who may approve opening a pull request (PR_APPROVER): a setting, like the above.
          pullRequestApprover: config.prApprover,
          ...(hub ? { runners: hub.status() } : {}),
        });
      }
      const adminReply = await admin(req);
      if (adminReply) return adminReply;
      const runnerReply = await runners?.handle(req, server);
      if (runnerReply) return runnerReply;
      return (await mounted.fetch(req)) ?? new Response("not found", { status: 404 });
    },
    // Shut down (server.ts, on SIGTERM/SIGINT, once the server takes no more requests): no
    // timer starts again, and ingest arms no new read but reads now the threads still
    // waiting out their debounce (an edit or deletion just before the stop isn't dropped);
    // those reads, and turns in flight, get up to `waitMs` to finish while June's runtime
    // closes (and with it SESSIONS_DB); then the knowledge store is checkpointed, its WAL
    // truncated (#89: a deleted message's frames leave lorehouse.db-wal), and closed. A turn
    // or read still running after `waitMs` is cut off: its later writes to the store fail,
    // and are logged.
    async close({ waitMs = 2500 }: { waitMs?: number } = {}) {
      for (const t of timers) clearInterval(t);
      const ingestStopped = ingester?.stop();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), waitMs); });
      try {
        const runtimeClosed = Promise.resolve().then(() => runtime!.close()).then(
          () => {},
          (err) => { console.error("lorehouse: closing the agent runtime:", err); },
        );
        const settled = Promise.all([runtimeClosed, ingestStopped]).then(() => "closed" as const);
        if ((await Promise.race([settled, timeout])) === "timeout") console.error(`lorehouse: turns or ingest reads still running after ${waitMs} ms; closing without them`);
      } finally {
        clearTimeout(timer);
        closeKnowledge(knowledge);
      }
    },
  };
}

// Where the agent's files (render_pdf's PDFs, workspace_attach_file's files from the sandbox)
// wait for the Slack channel to upload them (FILE_STORE). Only
// memory exists yet: never on disk, kept until 64 MiB of newer files push it out or the
// process restarts (no delete yet: junebuild/june#370). loadConfig refuses blob until it
// is built.
function fileStore(kind: Config["files"]["store"]): FileStore {
  if (kind === "memory") return memoryFileStore();
  throw new Error(`FILE_STORE=${kind} is not available yet`);
}
