// sandbox-resources.ts — what a profile may ask for its sandbox, and how a refusal reads.
//
// The sandbox host decides (ADR 0003): Lorehouse only asks. A request travels with the
// calls that create a sandbox, over both transports (a job's `resources` to a runner, the
// X-Lorehouse-Sandbox-Resources header to a host called directly), and sandboxd grants it
// within its own maxima or refuses it with a code; it never clamps
// (sandbox/host/src/resources.rs, docs/sandbox-runners.md). Plain data and no June: the
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
  // The longest one workspace_exec command may run. A background job has its own limits.
  readonly commandTimeoutSecs?: number;
};

// The least and the most any host may grant: sandboxd's own bounds. A host's maxima sit
// inside them, so a request outside them could never be granted anywhere.
export const RESOURCE_BOUNDS = {
  vcpus: [1, 32],
  memMib: [128, 262_144],
  diskGib: [1, 65_536],
  pids: [16, 4096],
  commandTimeoutSecs: [1, 6 * 3600],
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
    if (!(key in RESOURCE_BOUNDS)) {
      problems.push(`${at}.${key}: is not a sandbox resource (allowed: ${RESOURCE_FIELDS.join(", ")})`);
      continue;
    }
    const [min, max] = RESOURCE_BOUNDS[key as keyof SandboxResources];
    const n = o[key];
    if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) problems.push(`${at}.${key}: must be a whole number from ${min} to ${max}, got ${quote(n)}`);
  }
  if (!problems.length && Object.keys(o).length === 0) problems.push(`${at}: asks for nothing; leave it out to get the sandbox host's defaults`);
  const { vcpus, pids } = o as SandboxResources;
  if (!problems.length && pids !== undefined && vcpus !== undefined && pids < vcpus + PIDS_OVER_VCPUS) {
    problems.push(`${at}.pids: must be at least ${vcpus + PIDS_OVER_VCPUS} for ${vcpus} vCPUs (the VM's own threads count against it: one per vCPU and a few more), got ${pids}`);
  }
  return problems;
}

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

// How long one command may run when the caller names no timeout: what the profile asked
// for its sandbox, else `fallback` (the host's default, 10 minutes).
export function commandTimeoutMs(r: SandboxResources | undefined, fallback: number): number {
  return r?.commandTimeoutSecs !== undefined ? r.commandTimeoutSecs * 1000 : fallback;
}

// sandboxd refused the sandbox's resources. `code` is stable (invalid_resources,
// resource_over_maximum, disk_quota_unavailable, resources_mismatch); the message is
// sandboxd's own, whole: it names the field, what was asked, the limit and what to do.
// `status` is its HTTP-like status (400, 409, 422): nothing ran.
export class SandboxRefusal extends Error {
  constructor(readonly code: string, readonly status: number, readonly reason: string) {
    super(`the sandbox host refused this sandbox's resources (${code}): ${reason}`);
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
