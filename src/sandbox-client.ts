// sandbox-client.ts — the Sandbox backend that talks to a remote sandbox daemon (Firecracker microVMs).
//
// The host daemon owns one microVM per sandbox id: it reflinks a golden rootfs on first
// use (~40 ms for 14 GB on btrfs), boots it (~0.6–0.9 s to guest agent healthy), and
// stops it gracefully when idle — the disk is a plain file, so a thread parked for hours
// on an approval comes back to the same checkout. The daemon proxies the guest agent's
// API (guestd, over vsock) under /v1/sandboxes/{id}/…:
//
//   POST /v1/sandboxes/{id}/exec   {command, cwd, env, timeoutMs} → {exitCode, stdout, stderr}
//   GET  /v1/sandboxes/{id}/file?path=…                            → bytes (404 if absent,
//                                                                     413 over 16 MiB)
//   PUT  /v1/sandboxes/{id}/file?path=…                            → 204
//   POST /v1/sandboxes/{id}/jobs, GET …/jobs/{job}, POST …/jobs/{job}/cancel → a background job
//
// With `resources` (what the profile asks for its sandbox, src/sandbox-resources.ts), every
// exec, file and jobs call carries them in X-Lorehouse-Sandbox-Resources: the daemon
// boots the sandbox with them, or refuses the call with a code and its reason
// (400, 409, 422 `{ error, code }`), which is thrown whole as a SandboxRefusal. A daemon
// that predates the header would ignore it, so it is asked first, once:
//
//   GET  /v1/capabilities          → { version, features: ["resources"], resources: {defaults, maxima} }
//
// Feasibility numbers (boot, exec, persistence): sandbox/spike/.

import { RESOURCES_FEATURE, RESOURCES_HEADER, ResourcesUnsupported, execTimeoutMs, explainTimeout, refusalFrom, wireResources, type SandboxResources } from "./sandbox-resources";
import { EXEC_TIMEOUT_MS, FileTooLarge, JOB_CALL_MS, JOB_CANCEL_MS, JobCallError, PUSH_TIMEOUT_MS, STAGE_TIMEOUT_MS, jobQuery, jobReply, type ExecOptions, type ExecResult, type Sandbox, type SandboxJob, type Staged } from "./tools/workspace";

export type RemoteSandboxOptions = {
  url: string; // daemon base URL, e.g. https://sandbox.example.com
  token: string; // bearer credential the daemon checks
  fetch?: typeof fetch; // injectable for tests
  // What to ask for the sandbox; left out, it gets the daemon's defaults.
  resources?: SandboxResources;
};

// Daemons known to understand a request for resources, per fetch and URL: asked once a
// process, and again after an answer that wasn't a yes (it may have been updated since).
const understands = new WeakMap<typeof fetch, Map<string, Promise<void>>>();

async function askCapabilities(f: typeof fetch, url: string, auth: Record<string, string>): Promise<void> {
  const host = `the sandbox host at ${url}`;
  let res: Response;
  try {
    res = await f(`${url}/v1/capabilities`, { method: "GET", headers: auth, signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new Error(`${host} didn't say whether it honors sandbox resources (GET /v1/capabilities: ${err instanceof Error ? err.message : String(err)}), so nothing was run there; try again`);
  }
  if (res.status === 404) throw new ResourcesUnsupported(host, "its sandboxd predates resource requests (no GET /v1/capabilities) and would run the sandbox with its defaults");
  const text = await res.text();
  if (!res.ok) throw new Error(`${host} didn't say whether it honors sandbox resources (GET /v1/capabilities: ${res.status} ${text.slice(0, 200)}), so nothing was run there`);
  let features: unknown;
  try {
    features = (JSON.parse(text) as { features?: unknown }).features;
  } catch {}
  if (!Array.isArray(features) || !features.includes(RESOURCES_FEATURE)) throw new ResourcesUnsupported(host, `its sandboxd doesn't list "${RESOURCES_FEATURE}" among its features and would run the sandbox with its defaults`);
}

export function remoteSandbox(id: string, opts: RemoteSandboxOptions): Sandbox {
  const f = opts.fetch ?? fetch;
  const url = opts.url.replace(/\/$/, "");
  const base = `${url}/v1/sandboxes/${encodeURIComponent(id)}`;
  const auth = { authorization: `Bearer ${opts.token}` };
  const asked = opts.resources ? { [RESOURCES_HEADER]: JSON.stringify(wireResources(opts.resources)) } : undefined;

  // The headers of a call that may create the sandbox: the token, and what is asked for
  // it, once the daemon is known to honor that.
  async function creating(): Promise<Record<string, string>> {
    if (!asked) return auth;
    let known = understands.get(f);
    if (!known) understands.set(f, (known = new Map()));
    let answer = known.get(url);
    if (!answer) {
      answer = askCapabilities(f, url, auth);
      known.set(url, answer);
      answer.catch(() => known.delete(url));
    }
    await answer;
    return { ...auth, ...asked };
  }

  async function call(path: string, init: RequestInit): Promise<Response> {
    const res = await f(`${base}${path}`, { ...init, headers: { ...(await creating()), ...(init.headers as Record<string, string>) } });
    if (!res.ok && res.status !== 404) {
      const text = await res.text();
      throw refusalFrom(res.status, text) ?? new Error(`sandbox ${init.method ?? "GET"} ${path}: ${res.status} ${text.slice(0, 200)}`);
    }
    return res;
  }

  // A background job call; every status is guestd's (or the daemon's) to explain (jobReply).
  async function job(op: string, method: "POST" | "GET", path: string, body: object | undefined, timeoutMs: number): Promise<SandboxJob> {
    const res = await f(`${base}${path}`, {
      method,
      headers: { ...(await creating()), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    // Refused before anything ran (a 4xx), in the daemon's own words.
    const refusal = refusalFrom(res.status, text);
    if (refusal) throw new JobCallError(`job ${op}: ${refusal.message}`, res.status);
    return jobReply(op, res.status, text);
  }

  return {
    jobs: {
      start: (o) => job("start", "POST", "/jobs", o, JOB_CALL_MS),
      status: (j, o = {}) => job("status", "GET", `/jobs/${encodeURIComponent(j)}?${jobQuery(o)}`, undefined, (o.waitMs ?? 0) + JOB_CALL_MS),
      cancel: (j) => job("cancel", "POST", `/jobs/${encodeURIComponent(j)}/cancel`, undefined, JOB_CANCEL_MS),
    },
    async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
      // Never more than the sandbox's command timeout: the daemon stops it there anyway.
      const timeoutMs = execTimeoutMs(opts.resources, o.timeoutMs, EXEC_TIMEOUT_MS);
      const res = await call("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, cwd: o.cwd, env: o.env, timeoutMs }),
      });
      return explainTimeout((await res.json()) as ExecResult, timeoutMs, opts.resources);
    },
    async readFile(path: string): Promise<string> {
      const res = await call(`/file?path=${encodeURIComponent(path)}`, { method: "GET" });
      if (res.status === 404) throw new Error(`no such file: ${path}`);
      return res.text();
    },
    async readBytes(path: string): Promise<Uint8Array> {
      const res = await f(`${base}/file?path=${encodeURIComponent(path)}`, { method: "GET", headers: await creating() });
      if (res.status === 404) throw new Error(`no such file: ${path}`);
      if (res.status === 413) throw new FileTooLarge(path, (await res.text()).trim().slice(0, 200));
      if (!res.ok) {
        const text = await res.text();
        throw refusalFrom(res.status, text) ?? new Error(`sandbox GET /file: ${res.status} ${text.slice(0, 200)}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
    async writeFile(path: string, content: string): Promise<void> {
      await call(`/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: content });
    },
    async stage(o): Promise<Staged> {
      return publish("stage", { owner: o.repo.owner, name: o.repo.name, base: o.base, branch: o.branch, token: o.token }, STAGE_TIMEOUT_MS) as Promise<Staged>;
    },
    async push(o) {
      return publish("push", { stage: o.stage, owner: o.repo.owner, name: o.repo.name, sha: o.sha, branch: o.branch, token: o.token }, PUSH_TIMEOUT_MS) as Promise<{ sha: string; branch: string }>;
    },
  };

  // A publish call: every non-2xx (404 included: the base isn't on GitHub, nothing staged)
  // is an error with the daemon's reason.
  async function publish(op: "stage" | "push", request: object, timeoutMs: number): Promise<unknown> {
    const res = await f(`${base}/${op}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // The daemon's own errors are JSON; its 401, a rejected body, or a proxy's page aren't.
      let reason = text;
      try {
        reason = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new Error(`${op}: ${res.status} ${reason.slice(0, 500)}`);
    }
    return JSON.parse(text);
  }
}
