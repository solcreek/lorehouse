// sandbox.ts — the workspace seam: where the agent's code-touching work actually runs.
//
// A June agent lives in a Durable Object: no filesystem, no child processes. Everything
// code-touching (clone, edit, test, push) happens in a SANDBOX the agent drives through
// three tools. The Sandbox interface is the only thing the tools know, so the backend is
// swappable — Cloudflare Sandbox (a container bound to the worker), a runner on a box we
// own, or an in-memory fake in tests.
//
// One sandbox per SESSION (one Slack thread): a follow-up message in the thread lands in
// the same checkout, so "now also fix the lint error" works without re-cloning.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { toolDescription } from "../prompts";

export type ExecResult = { exitCode: number; stdout: string; stderr: string };

export type ExecOptions = {
  cwd?: string;
  // Per-command env. Secrets go HERE, never into the sandbox's persistent env: a model-run
  // `env` or `cat ~/.config/...` in a later command must not be able to read them back.
  env?: Record<string, string>;
  timeoutMs?: number;
};

export interface Sandbox {
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

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
export function workspaceTools(sandboxFor: SandboxFor): Tool[] {
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
      run: async (input: { command: string; cwd?: string }, ctx: ToolContext) => {
        const r = await sandboxFor(ctx).exec(input.command, { cwd: input.cwd ?? WORKDIR, timeoutMs: 10 * 60_000 });
        return { exitCode: r.exitCode, stdout: clip(r.stdout), stderr: clip(r.stderr, 4_000) };
      },
    },
    {
      spec: {
        name: "workspace_read_file",
        description: toolDescription("workspace_read_file", { workdir: WORKDIR }),
        input: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
      run: async (input: { path: string }, ctx: ToolContext) => {
        return { path: input.path, content: clip(await sandboxFor(ctx).readFile(resolve(input.path))) };
      },
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
      run: async (input: { path: string; content: string }, ctx: ToolContext) => {
        await sandboxFor(ctx).writeFile(resolve(input.path), input.content);
        return { path: input.path, bytes: input.content.length };
      },
    },
  ];
}

export function resolve(path: string): string {
  return path.startsWith("/") ? path : `${WORKDIR}/${path.replace(/^\.\//, "")}`;
}
