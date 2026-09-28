// sandbox-client.ts — the Sandbox backend that talks to a remote sandbox daemon (Firecracker microVMs).
//
// The host daemon owns one microVM per sandbox id: it reflinks a golden rootfs on first
// use (~40 ms for 14 GB on btrfs), boots it (~0.6–0.9 s to guest agent healthy), and
// stops it gracefully when idle — the disk is a plain file, so a thread parked for hours
// on an approval comes back to the same checkout. The daemon proxies the guest agent's
// API (guestd, over vsock) under /v1/sandboxes/{id}/…:
//
//   POST /v1/sandboxes/{id}/exec   {command, cwd, env, timeoutMs} → {exitCode, stdout, stderr}
//   GET  /v1/sandboxes/{id}/file?path=…                            → bytes (404 if absent)
//   PUT  /v1/sandboxes/{id}/file?path=…                            → 204
//
// Feasibility numbers (boot, exec, persistence): sandbox/spike/.

import { EXEC_TIMEOUT_MS, type ExecOptions, type ExecResult, type Sandbox } from "./tools/workspace";

export type RemoteSandboxOptions = {
  url: string; // daemon base URL, e.g. https://sandbox.example.com
  token: string; // bearer credential the daemon checks
  fetch?: typeof fetch; // injectable for tests
};

export function remoteSandbox(id: string, opts: RemoteSandboxOptions): Sandbox {
  const f = opts.fetch ?? fetch;
  const base = `${opts.url.replace(/\/$/, "")}/v1/sandboxes/${encodeURIComponent(id)}`;
  const auth = { authorization: `Bearer ${opts.token}` };

  async function call(path: string, init: RequestInit): Promise<Response> {
    const res = await f(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string>) } });
    if (!res.ok && res.status !== 404) {
      throw new Error(`sandbox ${init.method ?? "GET"} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    return res;
  }

  return {
    async exec(command: string, o: ExecOptions = {}): Promise<ExecResult> {
      const res = await call("/exec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, cwd: o.cwd, env: o.env, timeoutMs: o.timeoutMs ?? EXEC_TIMEOUT_MS }),
      });
      return (await res.json()) as ExecResult;
    },
    async readFile(path: string): Promise<string> {
      const res = await call(`/file?path=${encodeURIComponent(path)}`, { method: "GET" });
      if (res.status === 404) throw new Error(`no such file: ${path}`);
      return res.text();
    },
    async writeFile(path: string, content: string): Promise<void> {
      await call(`/file?path=${encodeURIComponent(path)}`, { method: "PUT", body: content });
    },
  };
}
