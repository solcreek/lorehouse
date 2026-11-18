// sandbox-resources.ts — what a profile may ask for its sandbox, and how a refusal reads.
//
// The sandbox host decides (ADR 0003): Lorehouse only asks. A request travels with every
// call that can start a sandbox's VM, over both transports (a job's `resources` to a
// runner, the X-Lorehouse-Sandbox-Resources header to a host called directly), and
// sandboxd grants it within its own maxima or refuses it with a code; it never clamps
// (sandbox/host/src/resources.rs, docs/sandbox-runners.md). The request says what the
// whole sandbox is: what it names, and the host's defaults for the rest. It takes effect
// when the sandbox's VM next boots, so a profile whose request is added or changed
// reaches its existing threads once their VM has had its idle stop; while that VM still
// runs with other resources the call is refused (resources_mismatch), saying when to
// try again. Plain data and no June: the
// profile type, the two sandbox backends and their tests all read this file.

// Every field is optional: one left out gets the host's default (2 vCPUs, 2048 MiB,
// 8 GiB of disk, 64 pids and 10 minutes a command, unless the host's operator set others).
export type SandboxResources = {
  readonly vcpus?: number;
  readonly memMib?: number;
  // Granted only by a host whose disk quota is on; refused elsewhere, never unenforced.
  readonly diskGib?: number;
  // The VM's own threads on the host (one per vCPU and a few), not the guest's processes.
  readonly pids?: number;
  // The longest ANY one command may run in the sandbox: a workspace_exec command, and
  // every command the other tools run there, workspace_clone's clone and fetch and
  // open_pull_request's git commands included. The host stops a command at it whatever
  // Lorehouse sends, so the tools never wait longer than it (execTimeoutMs). It only
  // shortens: a tool's own shorter limit stays (a clone's 10 minutes, a fetch's 5).
  // Background jobs (workspace_job_start) are not commands in this sense and keep their
  // own limits (1 h by default, 6 h at most).
  readonly commandTimeoutSecs?: number;
};

// The least and the most a profile may ask: sandboxd's own bounds, a host's maxima sitting
// inside them, so a request outside them could never be granted anywhere. One is tighter
// here than sandboxd's: a command timeout under a minute (sandboxd takes 1 s) would stop
// every clone and fetch too (a small repository's clone took 8 s and a 129 MB one 34 s on
// the first sandbox host, sandbox/host/README.md), leaving a sandbox that can't get its
// checkout. A minute is the least that leaves the code tools usable.
export const RESOURCE_BOUNDS = {
  vcpus: [1, 32],
  memMib: [128, 262_144],
  diskGib: [1, 65_536],
  pids: [16, 4096],
  commandTimeoutSecs: [60, 6 * 3600],
} as const satisfies Record<keyof SandboxResources, readonly [number, number]>;

export const RESOURCE_FIELDS = Object.keys(RESOURCE_BOUNDS) as (keyof SandboxResources)[];
// The VM's threads count against its pids: sandboxd refuses fewer than this over its vCPUs.
const PIDS_OVER_VCPUS = 8;

// What a runner's status and a host's GET /v1/capabilities list when sandboxd understands
// requests. One that doesn't would ignore a request, so none is sent to it.
export const RESOURCES_FEATURE = "resources";
export const RESOURCES_HEADER = "x-lorehouse-sandbox-resources";

// What is wrong with a request, one entry per problem, each starting with the field's
// path under `at` (e.g. "sandboxResources.memMib: …"). Empty: it can be sent.
export function resourceProblems(v: unknown, at: string): string[] {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return [`${at}: must be an object with any of ${RESOURCE_FIELDS.join(", ")}, got ${quote(v)}`];
  const o = v as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(o)) {
    // Its own keys only: `in` would find toString, constructor and __proto__ on the object.
    if (!Object.hasOwn(RESOURCE_BOUNDS, key)) {
      problems.push(`${at}.${key}: is not a sandbox resource (allowed: ${RESOURCE_FIELDS.join(", ")})`);
      continue;
    }
    const [min, max] = RESOURCE_BOUNDS[key as keyof SandboxResources];
    const n = o[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) problems.push(`${at}.${key}: must be a whole number from ${min} to ${max}${key === "commandTimeoutSecs" ? COMMAND_TIMEOUT_MEANS : ""}, got ${quote(n)}`);
  }
  if (!problems.length && Object.keys(o).length === 0) problems.push(`${at}: asks for nothing; leave it out to get the sandbox host's defaults`);
  const { vcpus, pids } = o as SandboxResources;
  if (!problems.length && pids !== undefined && vcpus !== undefined && pids < vcpus + PIDS_OVER_VCPUS) {
    problems.push(`${at}.pids: must be at least ${vcpus + PIDS_OVER_VCPUS} for ${vcpus} vCPUs (the VM's own threads count against it: one per vCPU and a few more), got ${pids}`);
  }
  return problems;
}

// What the field bounds, said where a wrong value is refused: it is wider than its name.
const COMMAND_TIMEOUT_MEANS = " (seconds; it bounds every command run in the sandbox, a clone and a fetch included, so under a minute the code tools could not work; background jobs keep their own limits)";

function quote(v: unknown): string {
  if (v === undefined) return "nothing";
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return typeof v;
  }
}

// A request as it goes out: only the fields asked for, in a fixed order.
export function wireResources(r: SandboxResources): SandboxResources {
  return Object.fromEntries(RESOURCE_FIELDS.filter((f) => r[f] !== undefined).map((f) => [f, r[f]]));
}

// The timeout one command is sent with, and how long its caller waits: what the tool
// asked (`asked`), or with none the sandbox's own; and never more than the command
// timeout the profile asked for its sandbox, since the host stops every command there
// whatever is sent. With no such request: `asked`, else `fallback` (the host's default,
// 10 minutes), as it always was.
export function execTimeoutMs(r: SandboxResources | undefined, asked: number | undefined, fallback: number): number {
  if (r?.commandTimeoutSecs === undefined) return asked ?? fallback;
  const limit = r.commandTimeoutSecs * 1000;
  return Math.min(asked ?? limit, limit);
}

// A command's result, saying which limit stopped it when that was the sandbox's command
// timeout: otherwise a clone cut short by a profile's 120 s reads like a clone that hung.
// Three things together say it was: the command was sent exactly that timeout, it ended
// with guestd's exit code 124 and marker, and the call took about that long
// (`elapsedMs`, measured by the caller around the call). The last matters because the
// first two are the command's to fake: `timeout 1 x`, or a script that prints the marker
// and exits 124, ends in a second and was not stopped by anything of the sandbox's. Any
// other result is returned as it is.
export function explainTimeout<T extends { exitCode: number; stderr: string }>(result: T, timeoutMs: number, elapsedMs: number, r: SandboxResources | undefined): T {
  if (r?.commandTimeoutSecs === undefined || timeoutMs !== r.commandTimeoutSecs * 1000) return result;
  if (result.exitCode !== 124 || !result.stderr.includes("[guestd] command timed out")) return result;
  // A boot can only add to the call's time, and clocks differ a little: nine tenths.
  if (elapsedMs < timeoutMs * 0.9) return result;
  return { ...result, stderr: `${result.stderr}\n[lorehouse] stopped at this sandbox's command timeout, ${r.commandTimeoutSecs} s (the profile's sandboxResources.commandTimeoutSecs): it bounds every command run in the sandbox, a clone or a fetch included. A command that needs longer can run as a background job (workspace_job_start)` };
}

// sandboxd refused the call before anything ran. `code` is stable: for the sandbox's
// resources invalid_resources, resource_over_maximum, disk_quota_unavailable,
// resources_mismatch (its VM is running with other resources; they change after its idle
// stop), disk_in_use and invalid_stored_resources; for a command's body
// invalid_exec_body. The message is sandboxd's own, whole: it names the field, what was
// asked, the limit and what to do. `status` is its HTTP-like status (400, 409, 422, 500).
export class SandboxRefusal extends Error {
  constructor(readonly code: string, readonly status: number, readonly reason: string) {
    super(`the sandbox host refused this call (${code}): ${reason}`);
  }
}

// A sandboxd error body (`{ error, code }`) as a refusal, if it is one.
export function refusalFrom(status: number, body: string): SandboxRefusal | undefined {
  try {
    const o = JSON.parse(body) as { error?: unknown; code?: unknown };
    if (typeof o?.code === "string" && typeof o.error === "string") return new SandboxRefusal(o.code, status, o.error);
  } catch {}
  return undefined;
}

// The sandbox host is too old to honor a request: it would run the sandbox with its
// defaults and say nothing. Nothing was sent.
export class ResourcesUnsupported extends Error {
  constructor(host: string, detail: string) {
    super(`${host} can't honor this profile's sandbox resources: ${detail}. Nothing was run there. Update sandboxd on that host (sandbox/host), or remove sandboxResources from the profile to run with the host's defaults`);
  }
}
