// jobs.ts — background jobs in the thread's sandbox: a command longer than one tool call
// (a benchmark, a test suite, a build) runs on in the sandbox while the agent checks on it.
//
//   workspace_job_start   {id, command, cwd?, timeoutMinutes?} → the job
//   workspace_job_status  {id, waitSeconds?}                    → the job, once it ends or the wait passes
//   workspace_job_cancel  {id, requestTs?}                      → the job, stopped
//
// The id is the model's, so a start is idempotent: June re-runs a tool call that was in
// flight when Lorehouse stopped, and guestd answers a second start of an id with the job it
// already started (sandbox/guest/jobs.go), never a second copy. The agent reports progress
// between status calls (prompts/tools/workspace_job_status.md); each call waits for the
// job up to a minute or more, so the thread hears at most about once a minute.
//
// Who may cancel: the person who started the job (the speaker of the turn that started
// it, when Slack vouched for them), or a workspace admin or owner. A turn runs until its
// job is done, so a "stop it" posted meanwhile reaches the agent only when it reads the
// thread: it passes that message's ts, and the author is looked up in Slack, not taken from
// the model. A job whose starter isn't known (no signed event) may be cancelled by anyone
// in the thread. Who started a job is written before the start is sent, since guestd may
// start it and the answer still be lost; a job with no such record in this thread (its
// row pruned, or never written) may be cancelled only by an admin: the safe side, since
// whether its starter was known can't be told then. An id guestd has no job for gets
// guestd's not-found instead, so a mistyped id isn't refused as if it existed.

import type { Database } from "bun:sqlite";
import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { toolDescription } from "../prompts";
import type { GitIdentity } from "../github-auth";
import type { SlackApi } from "../slack-api";
import { JobCallError, WORKDIR, authorEnv, clip, type SandboxFor, type SandboxJob, type SandboxJobs } from "./workspace";

export const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const DEFAULT_TIMEOUT_MIN = 60;
const MAX_TIMEOUT_MIN = 360;
const DEFAULT_WAIT_S = 60;
const MAX_WAIT_S = 300;
// What of the output tail goes into the transcript.
const TAIL_CHARS = 6_000;
const STORE_TTL_MS = 2 * 86_400_000;

// Who started which job (migrations/0012_sandbox_jobs.sql).
export function jobStore(db: Database) {
  return {
    // The first start of an id in a session writes the row; a replay leaves it. True when
    // this call wrote it.
    record(session: string, job: string, startedBy: string | null, now = new Date()): boolean {
      return db.query("INSERT OR IGNORE INTO sandbox_jobs (session, job, started_by, started_at) VALUES (?, ?, ?, ?)").run(session, job, startedBy, now.toISOString()).changes > 0;
    },
    forget(session: string, job: string): void {
      db.query("DELETE FROM sandbox_jobs WHERE session = ? AND job = ?").run(session, job);
    },
    get(session: string, job: string): { startedBy: string | null; startedAt: string } | undefined {
      return (db.query("SELECT started_by AS startedBy, started_at AS startedAt FROM sandbox_jobs WHERE session = ? AND job = ?").get(session, job) as { startedBy: string | null; startedAt: string } | null) ?? undefined;
    },
    prune(now = new Date()): number {
      return db.query("DELETE FROM sandbox_jobs WHERE started_at < ?").run(new Date(now.getTime() - STORE_TTL_MS).toISOString()).changes;
    },
  };
}
export type JobStore = ReturnType<typeof jobStore>;

// What cancel asks Slack: who wrote a message in the thread, whether someone is an admin,
// and a person's name (plain text, never a mention) for what the model is told.
export type JobAuthority = {
  authorOf(channel: string, thread: string, ts: string): Promise<string | undefined>;
  isAdmin(user: string): Promise<boolean>;
  nameOf?(user: string): Promise<string | undefined>;
};

export function slackJobAuthority(api: SlackApi, nameOf?: (user: string) => Promise<string | undefined>): JobAuthority {
  return {
    async authorOf(channel, thread, ts) {
      const r = await api.call<{ messages?: { ts?: string; user?: string }[] }>("conversations.replies", { channel, ts: thread, oldest: ts, latest: ts, inclusive: 1, limit: 10 });
      return r.messages?.find((m) => m.ts === ts)?.user;
    },
    async isAdmin(user) {
      const r = await api.call<{ user?: { is_admin?: boolean; is_owner?: boolean; is_primary_owner?: boolean } }>("users.info", { user });
      return !!(r.user?.is_admin || r.user?.is_owner || r.user?.is_primary_owner);
    },
    nameOf,
  };
}

// The turn's speaker, when its channel attests them (a signed Slack event).
function speakerOf(ctx: ToolContext): string | null {
  const user = ctx.event?.user;
  return user?.attested ? user.id : null;
}

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

// A job as the model sees it.
function view(j: SandboxJob): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: j.id,
    state: j.state,
    exitCode: j.exitCode,
    elapsed: formatElapsed(j.elapsedMs),
    outputBytes: j.outputBytes,
    tail: clip(j.tail, TAIL_CHARS),
  };
  if (j.tailTruncated && j.tail.length <= TAIL_CHARS) out.tail = `[… earlier output not shown …]\n${j.tail}`;
  if (j.reason) out.reason = j.reason;
  if (j.persistError) out.persistError = j.persistError;
  if (j.state === "running") out.next = "still running: post a short progress note if the last one was over a minute ago, then call workspace_job_status again";
  if (j.state === "lost") out.next = "the job did not finish; say so with the output above, and start it again under a new id only if the asker wants it";
  return out;
}

const fail = (error: string) => ({ error });

function jobsOf(sandboxFor: SandboxFor, ctx: ToolContext): SandboxJobs {
  const jobs = sandboxFor(ctx).jobs;
  if (!jobs) throw new Error("this sandbox backend has no background jobs; use workspace_exec (up to 10 minutes) instead");
  return jobs;
}

async function orError(work: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return await work();
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

const badId = (id: unknown) => `job id ${JSON.stringify(id)}: 1–64 of letters, digits, _ . -, starting with a letter or digit (e.g. "bench-1")`;

export function jobTools(sandboxFor: SandboxFor, opts: { store: JobStore; authority?: JobAuthority; commitAs?: () => Promise<GitIdentity> }): Tool[] {
  const { store, authority } = opts;
  const name = async (user: string) => (await authority?.nameOf?.(user).catch(() => undefined)) ?? user;
  return [
    {
      spec: {
        name: "workspace_job_start",
        description: toolDescription("workspace_job_start", { workdir: WORKDIR, default_timeout: String(DEFAULT_TIMEOUT_MIN), max_timeout: String(MAX_TIMEOUT_MIN) }),
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "a new id for this run, e.g. bench-1; starting the same id again returns that job" },
            command: { type: "string", description: "bash command line" },
            cwd: { type: "string", description: `working directory (default ${WORKDIR})` },
            timeoutMinutes: { type: "number", description: `stop it after this long (default ${DEFAULT_TIMEOUT_MIN}, at most ${MAX_TIMEOUT_MIN})` },
          },
          required: ["id", "command"],
        },
      },
      run: async (input: { id: string; command: string; cwd?: string; timeoutMinutes?: number }, ctx: ToolContext) =>
        orError(async () => {
          if (typeof input.id !== "string" || !JOB_ID.test(input.id)) return fail(badId(input.id));
          const minutes = input.timeoutMinutes ?? DEFAULT_TIMEOUT_MIN;
          if (!(minutes > 0 && minutes <= MAX_TIMEOUT_MIN)) return fail(`timeoutMinutes ${input.timeoutMinutes}: more than 0, at most ${MAX_TIMEOUT_MIN}`);
          const jobs = jobsOf(sandboxFor, ctx);
          const who = await opts.commitAs?.().catch(() => undefined);
          // Before the start: guestd may start the job and its answer be lost (a timeout, a
          // dropped runner), and the job must still be its starter's. Only a refusal (a 4xx:
          // nothing ran) takes back a row this call wrote; a replay writes nothing new.
          const wrote = store.record(ctx.sessionId, input.id, speakerOf(ctx));
          let j: SandboxJob;
          try {
            j = await jobs.start({ id: input.id, command: input.command, cwd: input.cwd ?? WORKDIR, env: who ? authorEnv(who) : undefined, timeoutMs: Math.round(minutes * 60_000) });
          } catch (err) {
            if (wrote && err instanceof JobCallError && err.status >= 400 && err.status < 500) store.forget(ctx.sessionId, input.id);
            throw err;
          }
          return { ...view(j), started: j.created === false ? "this id was already started: this is that job, not a second copy" : "started" };
        }),
    },
    {
      spec: {
        name: "workspace_job_status",
        description: toolDescription("workspace_job_status", { default_wait: String(DEFAULT_WAIT_S), max_wait: String(MAX_WAIT_S) }),
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            waitSeconds: { type: "number", description: `wait up to this long for the job to end before answering (default ${DEFAULT_WAIT_S}, at most ${MAX_WAIT_S}; 0 answers at once)` },
          },
          required: ["id"],
        },
      },
      run: async (input: { id: string; waitSeconds?: number }, ctx: ToolContext) =>
        orError(async () => {
          if (typeof input.id !== "string" || !JOB_ID.test(input.id)) return fail(badId(input.id));
          const wait = input.waitSeconds ?? DEFAULT_WAIT_S;
          if (!(wait >= 0 && wait <= MAX_WAIT_S)) return fail(`waitSeconds ${input.waitSeconds}: 0 to ${MAX_WAIT_S}`);
          return view(await jobsOf(sandboxFor, ctx).status(input.id, { waitMs: Math.round(wait * 1000), tailBytes: 8192 }));
        }),
    },
    {
      spec: {
        name: "workspace_job_cancel",
        description: toolDescription("workspace_job_cancel"),
        input: {
          type: "object",
          properties: {
            id: { type: "string" },
            requestTs: { type: "string", description: "the ts of the thread message that asked to cancel, when it isn't the message this turn answers" },
          },
          required: ["id"],
        },
      },
      run: async (input: { id: string; requestTs?: string }, ctx: ToolContext) =>
        orError(async () => {
          if (typeof input.id !== "string" || !JOB_ID.test(input.id)) return fail(badId(input.id));
          const started = store.get(ctx.sessionId, input.id);
          // Who asked: the author of the message named, as Slack says, or the turn's speaker.
          let asker = speakerOf(ctx);
          if (input.requestTs) {
            const channel = ctx.event?.channelId;
            const thread = ctx.event?.threadId ?? ctx.event?.ts;
            if (!channel || !thread || !authority) return fail("requestTs works only in a Slack thread; leave it out to cancel as this turn's speaker");
            if (!/^\d+\.\d+$/.test(input.requestTs)) return fail(`requestTs ${JSON.stringify(input.requestTs)}: a Slack message ts like 1790000000.000100 (slack_read_thread lists each message's ts)`);
            const author = await authority.authorOf(channel, thread, input.requestTs);
            if (!author) return fail(`no message with ts ${input.requestTs} in this thread; give the ts of the message that asked to cancel (slack_read_thread lists them)`);
            if (started && Number(input.requestTs) * 1000 < Date.parse(started.startedAt) - 60_000) return fail(`the message ${input.requestTs} is from before job ${input.id} started; give the ts of the message that asked to cancel it`);
            asker = author;
          }
          if (!started) {
            // No record of its start in this thread: whether its starter was known can't be
            // told, so only an admin may cancel it. But first ask guestd whether the job
            // exists at all: for an id that never ran, its not-found (which lists the real
            // ids) is the answer, not a refusal that implies there is such a job.
            try {
              await jobsOf(sandboxFor, ctx).status(input.id, { waitMs: 0, tailBytes: 0 });
            } catch (err) {
              if (err instanceof JobCallError && err.status === 404) return fail(err.message);
            }
            const why = `there's no record of who started job ${input.id} in this thread (it was started over two days ago, or not from here), so only a workspace admin may cancel it`;
            if (!asker) return fail(`${why}, and who asked isn't known. Pass requestTs, the ts of the message that asked`);
            if (!(await authority?.isAdmin(asker).catch(() => false))) return fail(`${why}; ${await name(asker)} asked. Say so in the thread; workspace_job_status still shows how it is doing`);
          } else if (started.startedBy && asker !== started.startedBy) {
            const starter = await name(started.startedBy);
            if (!asker) return fail(`job ${input.id} was started by ${starter}; only they or a workspace admin may cancel it, and who asked isn't known. Pass requestTs, the ts of the message that asked`);
            const admin = await authority?.isAdmin(asker).catch(() => false);
            if (!admin) return fail(`only ${starter}, who started job ${input.id}, or a workspace admin may cancel it; ${await name(asker)} asked. Say so in the thread; the job keeps running`);
          }
          return { ...view(await jobsOf(sandboxFor, ctx).cancel(input.id)), ...(asker ? { cancelledFor: await name(asker) } : {}) };
        }),
    },
  ];
}
