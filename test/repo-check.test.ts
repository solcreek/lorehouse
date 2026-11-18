// checkRepo (src/github-auth.ts): whether the credential can read a repo now, and whether
// a branch exists there. Asked before a channel's default repo is stored (#126).

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { checkRepo, githubApp, staticToken } from "../src/github-auth";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

type Api = { installed?: boolean; repo?: number | "network" | object; branch?: number | "network"; installation?: number };

// A fake GitHub: the App's installation lookup and token exchange, a repo and its branches.
function fakeApi(o: Api = {}) {
  const reqs: { path: string; auth: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    reqs.push({ path, auth: new Headers(init.headers).get("authorization") ?? "" });
    if (path.endsWith("/installation")) return o.installation ? new Response("no", { status: o.installation }) : o.installed === false ? new Response("not found", { status: 404 }) : Response.json({ id: 42 });
    if (path === "/app/installations/42/access_tokens") return Response.json({ token: "ghs_read", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      if (o.repo === "network") throw new Error("connection refused");
      if (typeof o.repo === "number") return new Response("{}", { status: o.repo });
      return Response.json(o.repo ?? { full_name: path.slice("/repos/".length), default_branch: "main" });
    }
    if (path.includes("/branches/")) {
      if (o.branch === "network") throw new Error("connection reset");
      return o.branch ? new Response("{}", { status: o.branch }) : Response.json({ name: path.split("/branches/")[1] });
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { f, reqs };
}

const widgets = { owner: "acme", name: "widgets" };
const app = (api: ReturnType<typeof fakeApi>) => githubApp({ appId: "123", privateKey, fetch: api.f });
const token = (api: ReturnType<typeof fakeApi>) => staticToken("ghp_dev", { fetch: api.f });

describe("checkRepo", () => {
  test("with the App installed: readable, asked with a read token for that repo, never the App's JWT", async () => {
    const api = fakeApi();
    expect(await checkRepo(app(api), widgets, { fetch: api.f })).toEqual({ ok: true, repo: widgets });
    expect(api.reqs.map((r) => r.path)).toEqual(["/repos/acme/widgets/installation", "/app/installations/42/access_tokens", "/repos/acme/widgets"]);
    expect(api.reqs[2]!.auth).toBe("Bearer ghs_read");
  });

  test("the App not installed there: not_installed, saying to install it, and the repo isn't asked for", async () => {
    const api = fakeApi({ installed: false });
    const r = await checkRepo(app(api), widgets, { fetch: api.f });
    expect(r).toMatchObject({ ok: false, reason: "not_installed" });
    expect((r as { detail: string }).detail).toContain("install it there");
    expect(api.reqs.map((r) => r.path)).toEqual(["/repos/acme/widgets/installation"]);
  });

  test("the App's own credential refused, or GitHub down: unavailable, not a verdict on the repo", async () => {
    expect(await checkRepo(app(fakeApi({ installation: 401 })), widgets)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await checkRepo(app(fakeApi({ installation: 503 })), widgets)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  test("with a plain token: readable when GitHub serves the repo to it", async () => {
    const api = fakeApi();
    expect(await checkRepo(token(api), widgets, { fetch: api.f })).toEqual({ ok: true, repo: widgets });
    expect(api.reqs).toEqual([{ path: "/repos/acme/widgets", auth: "Bearer ghp_dev" }]);
  });

  test("a repo the credential gets no read of (404, 403, 401): not_readable", async () => {
    for (const status of [404, 403, 401]) {
      const api = fakeApi({ repo: status });
      const r = await checkRepo(token(api), widgets, { fetch: api.f });
      expect(r).toMatchObject({ ok: false, reason: "not_readable" });
      expect((r as { detail: string }).detail).toContain(`acme/widgets (GitHub answered ${status})`);
    }
  });

  test("GitHub failing or unreachable: unavailable", async () => {
    for (const repo of [500, 429, "network"] as const) {
      const api = fakeApi({ repo });
      expect(await checkRepo(token(api), widgets, { fetch: api.f })).toMatchObject({ ok: false, reason: "unavailable" });
    }
    const api = fakeApi({ branch: "network" });
    expect(await checkRepo(token(api), widgets, { fetch: api.f, branch: "main" })).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await checkRepo(token(fakeApi({ branch: 500 })), widgets, { fetch: fakeApi({ branch: 500 }).f, branch: "main" })).toMatchObject({ ok: false, reason: "unavailable" });
  });

  test("the name comes back as GitHub spells it: its case, or the new name after a rename", async () => {
    const api = fakeApi({ repo: { full_name: "Acme/Widgets" } });
    expect(await checkRepo(token(api), { owner: "acme", name: "widgets" }, { fetch: api.f })).toEqual({ ok: true, repo: { owner: "Acme", name: "Widgets" } });
    // An answer without a usable name keeps what was asked for.
    for (const repo of [{}, { full_name: 7 }, { full_name: "a/b/c" }, { full_name: "a b/c" }]) {
      const odd = fakeApi({ repo });
      expect(await checkRepo(token(odd), widgets, { fetch: odd.f })).toEqual({ ok: true, repo: widgets });
    }
  });

  test("a branch is looked up only when given: there, or branch_not_found; a slash in its name stays a slash", async () => {
    const api = fakeApi();
    expect(await checkRepo(token(api), widgets, { fetch: api.f, branch: "release/2026.11" })).toEqual({ ok: true, repo: widgets });
    expect(api.reqs.at(-1)!.path).toBe("/repos/acme/widgets/branches/release/2026.11");
    const none = fakeApi({ branch: 404 });
    const r = await checkRepo(token(none), widgets, { fetch: none.f, branch: "nope" });
    expect(r).toEqual({ ok: false, reason: "branch_not_found", detail: "acme/widgets has no branch nope" });
  });

  test("asks GitHub where it is told to (GITHUB_API_URL)", async () => {
    const seen: string[] = [];
    const f = (async (url: string) => (seen.push(url), Response.json({ full_name: "acme/widgets" }))) as unknown as typeof fetch;
    await checkRepo(staticToken("t", { fetch: f }), widgets, { fetch: f, apiUrl: "http://github.test/api/" });
    expect(seen).toEqual(["http://github.test/api/repos/acme/widgets"]);
  });
});
