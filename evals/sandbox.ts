// sandbox.ts — what a case's sandbox answers, laid over the conformance fake runner
// (conformance/fake-runner.ts), which stays the default for everything not scripted here:
// stage and push answer as sandboxd; with no shell, an exec and a background job print
// "ran:<command>".
//
// A real model reads what a command printed and checks its tools before trusting them, so
// a code case gives its sandbox a `shell` (shell.ts): a simulated checkout whose commands
// answer as bash and git would. Without one, an exec answers the fake runner's
// "ran:<command>", which is enough for the scripted model (--dry) and for a case where
// nothing runs (a refusal). Under --dry the shell is never used.
//
// Tried in order, for each job: a refusal; an `exec` rule on the whole command line; the
// shell; then the fake runner.

import type { Job, JobAnswer } from "../conformance/fake-runner";
import { Shell, type ExecResult, type ShellScript } from "./shell";

export type ExecRule = {
  // Tested against the whole command line.
  match: RegExp;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
};

// sandboxd refusing a call before anything ran (src/sandbox-resources.ts, SandboxRefusal):
// a status, a stable code, and its reason.
export type Refusal = {
  // Which jobs: an exec or background job whose command matches, or any guest call whose
  // path matches. With neither, every guest call.
  command?: RegExp;
  path?: RegExp;
  status: number;
  code: string;
  error: string;
};

export type SandboxScript = {
  shell?: ShellScript;
  exec?: ExecRule[];
  refuse?: Refusal[];
};

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const body = (job: Job): Record<string, unknown> => {
  try {
    return JSON.parse(Buffer.from(job.bodyBase64 ?? "", "base64").toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
};

// The command line a job carries, if it is an exec or a background job's start.
export function commandOf(job: Job): string | undefined {
  if (job.op !== "guest" || job.method !== "POST" || (job.path !== "/exec" && job.path !== "/jobs")) return undefined;
  const command = body(job).command;
  return typeof command === "string" ? command : undefined;
}

type BackgroundJob = { id: string; command: string; cwd: string; timeoutMs: number; polls: number; state: "running" | "exited" | "cancelled"; exitCode: number | null; startedAt: string; result: ExecResult };

// One sandbox's answers for one trial.
export function scriptedSandbox(script: SandboxScript = {}, opts: { dry?: boolean } = {}): (job: Job) => JobAnswer | undefined {
  // Not under --dry: the scripted model takes one scripted step and never looks around,
  // so its sandbox is the fake runner's, as in conformance.
  const shell = script.shell && !opts.dry ? new Shell(script.shell) : undefined;
  const background = new Map<string, BackgroundJob>();
  const json = (job: Job, value: unknown): JobAnswer => ({ id: job.id, status: 200, contentType: "application/json", bodyBase64: b64(JSON.stringify(value)) });
  return (job) => {
    if (job.op !== "guest") return undefined; // stage and push are the fake runner's
    const command = commandOf(job);
    const refusal = (script.refuse ?? []).find((r) =>
      r.command ? command !== undefined && r.command.test(command) : r.path ? r.path.test(job.path ?? "") : true,
    );
    if (refusal) return { id: job.id, status: refusal.status, code: refusal.code, error: refusal.error };

    if (job.method === "POST" && job.path === "/exec" && command !== undefined) {
      const rule = (script.exec ?? []).find((r) => r.match.test(command));
      if (rule) return json(job, { exitCode: rule.exitCode ?? 0, stdout: rule.stdout ?? "", stderr: rule.stderr ?? "" });
      if (!shell) return undefined;
      const cwd = body(job).cwd;
      return json(job, shell.exec(command, typeof cwd === "string" ? cwd : undefined));
    }
    // Background jobs, with a shell: as guestd answers them (sandbox/guest/jobs.go, and
    // the fake runner's shape), but the job's output is what its command prints, arriving
    // as it "runs": nothing yet at the start, half by the first status, all of it and the
    // exit code by the second. The elapsed time is the half hour a long command takes; the
    // model has no clock to hold it against.
    if (shell && (job.path === "/jobs" || job.path?.startsWith("/jobs/"))) {
      const route = job.path.split("?")[0]!;
      const view = (j: BackgroundJob, created?: boolean) => {
        const running = j.state === "running";
        const out = j.result.stdout + j.result.stderr;
        const tail = j.state === "cancelled" ? "" : !running ? out : j.polls === 0 ? "" : out.slice(0, out.indexOf("\n", Math.floor(out.length / 2)) + 1);
        const elapsedMs = running ? 1000 + j.polls * 720_000 : j.state === "cancelled" ? 1000 + j.polls * 720_000 : 1_741_000;
        return { id: j.id, command: j.command, cwd: j.cwd, state: j.state, exitCode: j.exitCode, startedAt: j.startedAt, endedAt: running ? null : new Date(Date.parse(j.startedAt) + elapsedMs).toISOString(), elapsedMs, timeoutMs: j.timeoutMs, outputBytes: tail.length, tail, tailTruncated: false, ...(created === undefined ? {} : { created }) };
      };
      if (job.method === "POST" && route === "/jobs") {
        const req = body(job) as { id?: string; command?: string; cwd?: string; timeoutMs?: number };
        const existing = background.get(String(req.id));
        if (existing) return json(job, view(existing, false));
        const cwd = typeof req.cwd === "string" ? req.cwd : undefined;
        const j: BackgroundJob = { id: String(req.id), command: String(req.command), cwd: cwd ?? "", timeoutMs: req.timeoutMs ?? 3_600_000, polls: 0, state: "running", exitCode: null, startedAt: new Date().toISOString(), result: shell.exec(String(req.command), cwd) };
        background.set(j.id, j);
        return { ...json(job, view(j, true)), status: 201 };
      }
      const m = /^\/jobs\/([^/]+)(\/cancel)?$/.exec(route);
      const j = m ? background.get(decodeURIComponent(m[1]!)) : undefined;
      if (!j) return { ...json(job, { error: `no job ${JSON.stringify(m?.[1])} in this sandbox (jobs here: ${[...background.keys()].join(", ") || "none"})` }), status: 404 };
      if (m![2]) {
        if (j.state === "running") Object.assign(j, { state: "cancelled", exitCode: 143 });
      } else if (j.state === "running" && ++j.polls >= 2) {
        Object.assign(j, { state: "exited", exitCode: j.result.exitCode });
      }
      return json(job, view(j));
    }
    if (shell && job.path?.startsWith("/file?")) {
      const path = new URL(`http://x${job.path}`).searchParams.get("path") ?? "";
      if (job.method === "PUT") {
        shell.write(path, Buffer.from(job.bodyBase64 ?? "", "base64").toString());
        return json(job, {});
      }
      const content = shell.read(path);
      // With a shell, a file is there or it isn't: no path reads as the fake runner's PNG.
      return content === undefined ? { id: job.id, status: 404 } : { id: job.id, status: 200, contentType: "application/octet-stream", bodyBase64: b64(content) };
    }
    return undefined;
  };
}
