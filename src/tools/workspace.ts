// sandbox.ts — the workspace seam: where the agent's code-touching work actually runs.
//
// A June agent lives in a Durable Object: no filesystem, no child processes. Everything
// code-touching (clone, edit, test, push) happens in a SANDBOX the agent drives through
// a few tools. The Sandbox interface is the only thing the tools know, so the backend is
// swappable — Cloudflare Sandbox (a container bound to the worker), a runner on a box we
// own, or an in-memory fake in tests.
//
// One sandbox per SESSION (one Slack thread): a follow-up message in the thread lands in
// the same checkout, so "now also fix the lint error" works without re-cloning.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { toolDescription } from "../prompts";
import type { GitIdentity, RepoRef } from "../github-auth";
import { MAX_ATTACH_BYTES, attachmentName, classify, formatSize } from "./file-types";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type ExecOptions = {
  cwd?: string;
  // Per-command env. Secrets go HERE, never into the sandbox's persistent env: a model-run
  // `env` or `cat ~/.config/...` in a later command must not be able to read them back.
  env?: Record<string, string>;
  // Default: EXEC_TIMEOUT_MS.
  timeoutMs?: number;
};

// A command's timeout when none is given. Sandbox implementations resolve it themselves and
// send it, so the guest's limit and the caller's deadline are the same number.
export const EXEC_TIMEOUT_MS = 10 * 60_000;

export interface Sandbox {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  // A text file, decoded as UTF-8 (workspace_read_file).
  readFile(path: string): Promise<string>;
  // A file's bytes as they are (workspace_attach_file). Throws "no such file: <path>" for a
  // missing one and FileTooLarge for one over guestd's read limit (16 MiB).
  readBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  // Publishing, done by the sandbox host so a write token never enters the sandbox
  // (sandbox/host/src/publish.rs). stage: verify the commits the checkout has that GitHub
  // doesn't, describe them against `base`, and record a stage for `branch`. push: push the
  // commit a stage recorded, to the branch it recorded; a stage authorizes one push
  // attempt, whatever its outcome, and the host refuses a push that doesn't restate it.
  // Both throw with the host's reason (no commits, the base isn't on GitHub, refused…).
  stage(o: { repo: RepoRef; base: string; branch: string; token?: string }): Promise<Staged>;
  push(o: { stage: string; repo: RepoRef; sha: string; branch: string; token: string }): Promise<{ sha: string; branch: string }>;
  // Background jobs (sandbox/guest/jobs.go), for a command longer than one tool call.
  // Absent on a backend that has none (test fakes).
  jobs?: SandboxJobs;
}

// A background job as guestd reports it. `exitCode` is set once it has ended (null while
// running, and for a lost one). `lost`: the VM stopped while it ran. `created`, on a
// start only: false when that id had already been started (the same job, not a copy).
export type JobState = "running" | "exited" | "cancelled" | "timed_out" | "lost";
export type SandboxJob = {
  id: string; command: string; cwd: string; state: JobState; exitCode: number | null;
  startedAt: string; endedAt: string | null; elapsedMs: number; timeoutMs: number;
  outputBytes: number; tail: string; tailTruncated: boolean; reason?: string; created?: boolean;
  // Set while guestd couldn't write the job's end to disk (it is kept in memory meanwhile).
  persistError?: string;
};
export type JobStart = { id: string; command: string; cwd: string; env?: Record<string, string>; timeoutMs?: number };

export interface SandboxJobs {
  // Starting an id that was started before returns that job (`created: false`).
  start(o: JobStart): Promise<SandboxJob>;
  // waitMs: return once the job ends, or after this long (≤ 5 min), whichever is first.
  status(id: string, o?: { waitMs?: number; tailBytes?: number }): Promise<SandboxJob>;
  cancel(id: string): Promise<SandboxJob>;
}

// A job call's deadline at the host: its own wait, plus room for a boot and the answer.
export const JOB_CALL_MS = 30_000;
// A cancel waits up to 12 s in the guest for the process group to go.
export const JOB_CANCEL_MS = 45_000;

// A job status's query: only what guestd takes (sandboxd refuses anything else).
export function jobQuery(o: { waitMs?: number; tailBytes?: number }): string {
  const q = new URLSearchParams();
  if (o.waitMs) q.set("waitMs", String(Math.max(0, Math.round(o.waitMs))));
  q.set("tailBytes", String(Math.max(0, Math.round(o.tailBytes ?? 8192))));
  return q.toString();
}

// A job call that got an answer other than the job: `status` is the host's or guestd's. A
// 4xx means the call was refused before anything ran; a start that throws anything else
// (a timeout, a 5xx, a dropped runner) may have started the job.
export class JobCallError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// A guestd job answer (both backends): the job, or a JobCallError with guestd's reason,
// which says what to do. A 404 that isn't guestd's JSON, or a runner refusing the path, is
// a host that predates jobs.
export function jobReply(op: string, status: number, body: string): SandboxJob {
  let parsed: { state?: unknown; error?: unknown } | undefined;
  try {
    parsed = JSON.parse(body);
  } catch {}
  if (status >= 200 && status < 300 && typeof parsed?.state === "string") return parsed as SandboxJob;
  if (typeof parsed?.error === "string") {
    if (parsed.error.startsWith("guest call not allowed")) throw new JobCallError(`job ${op}: this sandbox runner's sandboxd predates background jobs and refuses them; it needs updating (sandbox/host) before jobs can run there. Use workspace_exec for commands under 10 minutes meanwhile`, status);
    throw new JobCallError(`job ${op}: ${parsed.error}`, status);
  }
  if (status === 404) throw new JobCallError(`job ${op}: this sandbox's guest agent predates background jobs (no /jobs); its golden image needs rebuilding with the current guestd (sandbox/host/prepare-golden.sh). Use workspace_exec for commands under 10 minutes meanwhile`, status);
  throw new JobCallError(`job ${op}: ${status} ${body.slice(0, 300)}`, status);
}

// A file guestd won't read: over its limit (sandbox/guest/main.go, 16 MiB). `detail` is
// guestd's own sentence ("file is N bytes; the limit is M").
export class FileTooLarge extends Error {
  constructor(readonly path: string, readonly detail: string) {
    super(`too large to read: ${path}: ${detail}`);
  }
}

// What a stage found, all computed on the host from the verified commits. `stage`: the
// stage's id, what push takes. `authors`: "author <email>|committer <email>", one per commit.
// `patch` is an excerpt; `diffSha256` is the SHA-256 of the complete diff against the base.
export type Staged = { stage: string; sha: string; baseSha: string; commits: number; stat: string; authors: string[]; files: string[]; patch: string; patchTruncated: boolean; diffSha256: string };

// How long publishing may take: a first mirror of a big repo is a full clone.
export const STAGE_TIMEOUT_MS = 10 * 60_000;
export const PUSH_TIMEOUT_MS = 5 * 60_000;

// Resolves the sandbox for the turn's session. Keyed off ctx.sessionId, never off model
// input — the model cannot steer a tool into another thread's checkout.
export type SandboxFor = (ctx: ToolContext) => Sandbox;

// Where the repo is checked out inside every sandbox.
export const WORKDIR = "/workspace/repo";

// Tool results go into the transcript and every later model call: cap them. Keep the TAIL
// of long output — a failing test run's useful part (the failure summary) is at the end.
const MAX_OUTPUT = 12_000;
export function clip(s: string, max = MAX_OUTPUT): string {
  if (s.length <= max) return s;
  return `[… ${s.length - max} chars truncated …]\n${s.slice(-max)}`;
}

// NOTE on delivery semantics: these tools are ASYNC, which June runs at-least-once (a crash
// between the call and its checkpoint re-runs it on replay). Reads are naturally safe;
// `workspace_exec` is only as idempotent as the command the model chose. Acceptable for a
// throwaway checkout — the irreversible step (push + PR) lives in its own guarded tool.
//
// A failure (no sandbox host connected, the host offline or full, a timeout, a missing
// file) is returned as { error } for the model to relay or work around. Thrown, June would
// fail the whole turn and the thread would only see "the turn failed".
async function orError<T>(work: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await work();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// Who the agent's commits are by, as git's environment: it outranks every git config (the
// checkout's, the global one, one the model wrote), so every commit made through
// workspace_exec is by that account, in an old checkout too.
export function authorEnv(who: GitIdentity): Record<string, string> {
  return { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
}

// commitAs: the account commits are by (the GitHub App's bot). A failed lookup doesn't
// fail the command; it runs with git's own configuration.
export function workspaceTools(sandboxFor: SandboxFor, opts: { commitAs?: () => Promise<GitIdentity> } = {}): Tool[] {
  return [
    {
      spec: {
        name: "workspace_exec",
        description: toolDescription("workspace_exec", { workdir: WORKDIR }),
        input: {
          type: "object",
          properties: {
            command: { type: "string", description: "bash command line" },
            cwd: { type: "string", description: `working directory (default ${WORKDIR})` },
          },
          required: ["command"],
        },
      },
      run: async (input: { command: string; cwd?: string }, ctx: ToolContext) =>
        orError(async () => {
          const who = await opts.commitAs?.().catch(() => undefined);
          const env = who ? authorEnv(who) : undefined;
          const r = await sandboxFor(ctx).exec(input.command, { cwd: input.cwd ?? WORKDIR, env, timeoutMs: EXEC_TIMEOUT_MS });
          return { exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr, 4_000) };
        }),
    },
    {
      spec: {
        name: "workspace_read_file",
        description: toolDescription("workspace_read_file", { workdir: WORKDIR }),
        input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      run: async (input: { path: string }, ctx: ToolContext) =>
        orError(async () => ({ path: input.path, content: clip(await sandboxFor(ctx).readFile(resolve(input.path))) })),
    },
    {
      spec: {
        name: "workspace_write_file",
        description: toolDescription("workspace_write_file", { workdir: WORKDIR }),
        input: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
      run: async (input: { path: string; content: string }, ctx: ToolContext) =>
        orError(async () => {
          await sandboxFor(ctx).writeFile(resolve(input.path), input.content);
          return { path: input.path, bytes: input.content.length };
        }),
    },
    {
      spec: {
        name: "workspace_attach_file",
        description: toolDescription("workspace_attach_file", { workdir: WORKDIR, max: formatSize(MAX_ATTACH_BYTES) }),
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: `the file in the sandbox (relative paths resolve against ${WORKDIR})` },
            title: { type: "string", description: 'the name the thread shows, e.g. "Benchmark, main vs branch"; defaults to the file\'s own name' },
          },
          required: ["path"],
        },
      },
      run: async (input: { path?: unknown; title?: unknown }, ctx: ToolContext) => attach(sandboxFor, input, ctx),
    },
  ];
}

const SMALLER = "Make it smaller in the sandbox (a lower resolution, or JPEG, for an image; fewer rows for a CSV) and attach that";

// workspace_attach_file: the file's bytes from the thread's sandbox into June's file store;
// the Slack channel uploads it to the thread being answered after the reply, as it does
// render_pdf's PDF. It names no channel or thread, so it can attach nowhere else. What it
// attaches is decided by the bytes and the name (file-types.ts), never by the model.
async function attach(sandboxFor: SandboxFor, input: { path?: unknown; title?: unknown }, ctx: ToolContext): Promise<unknown> {
  if (typeof input?.path !== "string" || !input.path.trim()) return { error: 'workspace_attach_file needs `path`: the file in the sandbox to attach, e.g. "chart.png" or "/tmp/out/report.pdf"' };
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") return { error: "`title` must be a string (the name the thread shows), or left out" };
  const path = resolve(input.path.trim());
  let bytes: Uint8Array;
  try {
    bytes = await sandboxFor(ctx).readBytes(path);
  } catch (err) {
    if (err instanceof FileTooLarge) return { error: `${path} is too large to attach (${err.detail}); I attach files up to ${formatSize(MAX_ATTACH_BYTES)}. ${SMALLER}` };
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith("no such file")) return { error: `no such file in the sandbox: ${path}. Check the path (workspace_exec: ls -la ${path.slice(0, path.lastIndexOf("/") + 1)}); relative paths resolve against ${WORKDIR}` };
    return { error: `couldn't read ${path} from the sandbox: ${message}` };
  }
  if (bytes.byteLength > MAX_ATTACH_BYTES) return { error: `${path} is ${formatSize(bytes.byteLength)}; I attach files up to ${formatSize(MAX_ATTACH_BYTES)}. ${SMALLER}` };
  if (bytes.byteLength === 0) return { error: `${path} is empty: nothing to attach. Check that whatever writes it has finished (workspace_exec: ls -la ${path})` };
  const verdict = classify(path, bytes);
  if ("refusal" in verdict) return { error: verdict.refusal };
  const name = attachmentName(path, verdict.kind, typeof input.title === "string" ? input.title : undefined);
  const file = await ctx.files.put(bytes, { name, mediaType: verdict.kind.mediaType });
  return { file, note: `${name} (${verdict.kind.label}, ${formatSize(file.size)}) will be attached to this thread after your reply. Don't attach it again; say in a sentence what it shows.` };
}

export function resolve(path: string): string {
  return path.startsWith("/") ? path : `${WORKDIR}/${path.replace(/^\.\//, "")}`;
}
