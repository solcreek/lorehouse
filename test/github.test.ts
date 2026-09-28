// GitHub credentials (a GitHub App's short-lived tokens) and cloning with them.

import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { appJwt, githubApp, normalizePem, staticToken } from "../src/github-auth";
import { cloneTool, parseRepo } from "../src/tools/clone";
import type { ExecOptions, Sandbox } from "../src/tools/workspace";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const NOW = Date.parse("2026-09-28T00:00:00Z");

function decodePart(part: string) {
  return JSON.parse(Buffer.from(part, "base64url").toString());
}

// A plain token whose identity lookup never leaves the process (a clone asks for it).
const offline = (token: string) => staticToken(token, { fetch: (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch });

// A fake GitHub API: the installation lookup and the token exchange, the App and its bot
// user, with every request kept.
function fakeApi(o: { installed?: boolean; expiresIn?: number } = {}) {
  const reqs: { method: string; path: string; auth: string; body?: unknown }[] = [];
  let n = 0;
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    reqs.push({ method: init.method ?? "GET", path, auth: new Headers(init.headers).get("authorization") ?? "", body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/app") return Response.json({ slug: "acme-agent" });
    if (path === "/users/acme-agent%5Bbot%5D") return Response.json({ id: 900, login: "acme-agent[bot]" });
    if (path === "/user") return Response.json({ id: 7, login: "octo" });
    if (path.endsWith("/installation")) return o.installed === false ? new Response("not found", { status: 404 }) : Response.json({ id: 42 });
    if (path === "/app/installations/42/access_tokens") return Response.json({ token: `ghs_${++n}`, expires_at: new Date(NOW + (o.expiresIn ?? 3600_000)).toISOString() }, { status: 201 });
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return { f, reqs };
}

describe("the GitHub App's JWT", () => {
  test("is RS256, signed by the App's key, issued by the App, valid 9 minutes, backdated for skew", () => {
    const jwt = appJwt("123", privateKey, NOW);
    const [h, p, sig] = jwt.split(".");
    expect(decodePart(h!)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodePart(p!)).toEqual({ iss: "123", iat: NOW / 1000 - 60, exp: NOW / 1000 + 540 });
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });
});

describe("githubApp", () => {
  test("a write token: finds the installation, then asks for one repo with contents and pull requests write", async () => {
    const api = fakeApi();
    const access = githubApp({ appId: "123", privateKey, fetch: api.f, now: () => NOW });
    expect(await access({ owner: "acme", name: "widgets" }, "write")).toBe("ghs_1");
    expect(api.reqs.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /repos/acme/widgets/installation", "POST /app/installations/42/access_tokens"]);
    expect(api.reqs[1]!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "write", pull_requests: "write" } });
    for (const r of api.reqs) expect(r.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/); // the App's JWT, not a user token
  });

  test("a read token (to clone) asks for contents read only", async () => {
    const api = fakeApi();
    await githubApp({ appId: "123", privateKey, fetch: api.f, now: () => NOW })({ owner: "acme", name: "widgets" }, "read");
    expect(api.reqs[1]!.body).toEqual({ repositories: ["widgets"], permissions: { contents: "read" } });
  });

  test("tokens are reused until five minutes before they expire, per repo and access", async () => {
    let now = NOW;
    const api = fakeApi();
    const access = githubApp({ appId: "123", privateKey, fetch: api.f, now: () => now });
    const w = { owner: "acme", name: "widgets" };
    expect(await access(w, "write")).toBe("ghs_1");
    expect(await access(w, "write")).toBe("ghs_1"); // cached
    expect(await access(w, "read")).toBe("ghs_2"); // a different access is a different token
    now = NOW + 56 * 60_000; // 4 minutes before expiry
    expect(await access(w, "write")).toBe("ghs_3");
  });

  test("a repo the App isn't installed on says so", async () => {
    const access = githubApp({ appId: "123", privateKey, fetch: fakeApi({ installed: false }).f, now: () => NOW });
    await expect(access({ owner: "acme", name: "secret" }, "read")).rejects.toThrow("the GitHub App isn't installed on acme/secret");
  });

  test("commits are by the App's bot user, at its noreply address, so GitHub links them to it", async () => {
    const api = fakeApi();
    const access = githubApp({ appId: "123", privateKey, fetch: api.f, now: () => NOW });
    expect(await access.identity!()).toEqual({ name: "acme-agent[bot]", email: "900+acme-agent[bot]@users.noreply.github.com" });
    expect(api.reqs.map((r) => `${r.path} ${r.auth ? "jwt" : "anonymous"}`)).toEqual(["/app jwt", "/users/acme-agent%5Bbot%5D anonymous"]);
    await access.identity!();
    expect(api.reqs).toHaveLength(2); // looked up once
  });

  test("a failed identity lookup isn't remembered: the next one tries again", async () => {
    let down = true;
    const api = fakeApi();
    const f = (async (url: string, init?: RequestInit) => (down && new URL(url).pathname === "/app" ? new Response("down", { status: 502 }) : api.f(url, init))) as typeof fetch;
    const access = githubApp({ appId: "123", privateKey, fetch: f, now: () => NOW });
    await expect(access.identity!()).rejects.toThrow("502");
    down = false;
    expect((await access.identity!()).name).toBe("acme-agent[bot]");
  });

  test("with a plain token, commits are by the token's user", async () => {
    const api = fakeApi();
    expect(await staticToken("ghp_x", { fetch: api.f }).identity!()).toEqual({ name: "octo", email: "7+octo@users.noreply.github.com" });
    expect(api.reqs[0]!.auth).toBe("Bearer ghp_x");
  });

  test("a PEM stored with literal \\n escapes is restored", () => {
    expect(normalizePem("-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----")).toBe("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----");
    expect(normalizePem(privateKey)).toBe(privateKey);
  });
});

// A sandbox that records every exec; `origin` is the checkout's remote, if any.
function fakeSandbox(origin?: string) {
  const calls: { command: string; opts?: ExecOptions }[] = [];
  const sb: Sandbox = {
    async exec(command, opts) {
      calls.push({ command, opts });
      if (command.includes("remote get-url origin")) return origin ? { exitCode: 0, stdout: `${origin}\n`, stderr: "" } : { exitCode: 2, stdout: "", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async readFile() { return ""; },
    async writeFile() {},
  };
  return { sb, calls };
}

describe("workspace_clone", () => {
  const run = (tool: ReturnType<typeof cloneTool>, repo: string) => tool.run({ repo }, {} as never);

  test("a private repo clones with a read token that exists only in the clone command's env", async () => {
    const { sb, calls } = fakeSandbox();
    const asked: string[] = [];
    const tool = cloneTool(() => sb, async (r, a) => (asked.push(`${r.owner}/${r.name}:${a}`), "ghs_read"));
    expect(await run(tool, "acme/secret")).toEqual({ status: "cloned", repo: "acme/secret", path: "/workspace/repo" });
    expect(asked).toEqual(["acme/secret:read"]);
    const clone = calls.find((c) => c.command.includes(" clone "))!;
    expect(clone.command).toContain("clone https://github.com/acme/secret.git /workspace/repo");
    expect(clone.command).not.toContain("ghs_read"); // never in argv, so never in the remote URL
    expect(clone.opts?.env).toMatchObject({ LOREHOUSE_GH_TOKEN: "ghs_read" });
    expect(clone.command).toContain("-c core.hooksPath=/dev/null");
  });

  test("the checkout commits as the credential's account, so the model doesn't make one up", async () => {
    const { sb, calls } = fakeSandbox();
    const github = Object.assign(async () => "ghs_read", { identity: async () => ({ name: "acme-agent[bot]", email: "900+acme-agent[bot]@users.noreply.github.com" }) });
    expect(await run(cloneTool(() => sb, github), "acme/secret")).toMatchObject({ status: "cloned", commitsAs: "acme-agent[bot] <900+acme-agent[bot]@users.noreply.github.com>" });
    const config = calls.find((c) => c.command.includes("git config user.name"))!;
    expect(config.command).toBe("git config user.name 'acme-agent[bot]' && git config user.email '900+acme-agent[bot]@users.noreply.github.com'");
    expect(config.opts?.cwd).toBe("/workspace/repo");
  });

  test("no identity (lookup failed, or not plain enough for a shell command): the clone still stands, nothing is set", async () => {
    for (const identity of [async () => { throw new Error("502"); }, async () => ({ name: "x'; rm -rf / #", email: "a@b.c" })]) {
      const { sb, calls } = fakeSandbox();
      const r = await run(cloneTool(() => sb, Object.assign(async () => "t", { identity })), "acme/secret");
      expect(r).toMatchObject({ status: "cloned" });
      expect(r).not.toHaveProperty("commitsAs");
      expect(calls.some((c) => c.command.includes("git config"))).toBe(false);
    }
  });

  test("already cloned: it fetches the same repo, and refuses to clone a different one over it", async () => {
    const same = fakeSandbox("https://github.com/acme/secret.git");
    expect(await run(cloneTool(() => same.sb, offline("t")), "acme/secret")).toMatchObject({ status: "fetched" });
    expect(same.calls.some((c) => c.command.includes("fetch --prune origin"))).toBe(true);
    const other = fakeSandbox("https://github.com/acme/other.git");
    expect(await run(cloneTool(() => other.sb, offline("t")), "acme/secret")).toMatchObject({ error: expect.stringContaining("already holds acme/other") });
  });

  test("a different checkout is never described by its remote URL, which may hold a credential", async () => {
    const leaky = fakeSandbox("https://x-access-token:ghs_leak@example.com/acme/other.git");
    const r = (await run(cloneTool(() => leaky.sb, offline("t")), "acme/secret")) as { error: string };
    expect(r.error).toContain("already holds a different repository");
    expect(r.error).not.toContain("ghs_leak");
  });

  test("a repo the App isn't installed on clones anonymously (fine for a public one)", async () => {
    const { sb, calls } = fakeSandbox();
    const tool = cloneTool(() => sb, async () => { throw new Error("the GitHub App isn't installed on octo/public"); });
    expect(await run(tool, "https://github.com/octo/public")).toMatchObject({ status: "cloned" });
    const clone = calls.find((c) => c.command.includes(" clone "))!;
    expect(clone.command).not.toContain("credential.helper");
    expect(clone.opts?.env).toEqual({});
  });

  test("any other credential failure is reported, and nothing runs", async () => {
    const { sb, calls } = fakeSandbox();
    const tool = cloneTool(() => sb, async () => { throw new Error("GitHub App: 401 bad credentials"); });
    expect(await run(tool, "acme/secret")).toMatchObject({ error: expect.stringContaining("401 bad credentials") });
    expect(calls).toHaveLength(0);
  });

  test("repo references: owner/name and github.com URLs; nothing else", () => {
    expect(parseRepo("acme/widgets")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRepo("https://github.com/acme/widgets.git")).toEqual({ owner: "acme", name: "widgets" });
    expect(parseRepo("git@github.com:acme/widgets.git")).toEqual({ owner: "acme", name: "widgets" });
    for (const bad of ["acme", "acme/widgets; rm -rf /", "https://evil.example/acme/widgets", "../x/y", "acme/.git"]) expect(parseRepo(bad)).toBeUndefined();
  });
});
