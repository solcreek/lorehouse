// checkRepo (src/github-auth.ts): whether the credential can read a repo now, and whether
// a branch exists there. Asked before a channel's default repo is stored (#126).

import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { checkRepo, githubApp, staticToken } from "../src/github-auth";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

// How GitHub refuses: a status, or one of its two ways of saying "rate limited" on a 403
// (the primary limit's x-ratelimit-remaining: 0; a secondary limit's retry-after), or a 429.
type Refuse = number | "limit403" | "retry403" | "retry429";
type Api = { installed?: boolean; repo?: Refuse | "network" | object; branch?: Refuse | "network"; installation?: Refuse; token?: Refuse };

function refusal(r: Refuse): Response {
  if (r === "limit403") return new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });
  if (r === "retry403") return new Response("{}", { status: 403, headers: { "retry-after": "60" } });
  if (r === "retry429") return new Response("{}", { status: 429, headers: { "retry-after": "30" } });
  return new Response("{}", { status: r });
}
const refuses = (v: unknown): v is Refuse => typeof v === "number" || v === "limit403" || v === "retry403" || v === "retry429";

// A fake GitHub: the App's installation lookup and token exchange, a repo and its branches.
function fakeApi(o: Api = {}) {
  const reqs: { path: string; auth: string }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const path = new URL(url).pathname;
    reqs.push({ path, auth: new Headers(init.headers).get("authorization") ?? "" });
    if (path.endsWith("/installation")) return o.installation ? refusal(o.installation) : o.installed === false ? new Response("not found", { status: 404 }) : Response.json({ id: 42 });
    if (path === "/app/installations/42/access_tokens") return o.token ? refusal(o.token) : Response.json({ token: "ghs_read", expires_at: new Date(Date.now() + 3600_000).toISOString() }, { status: 201 });
    if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
      if (o.repo === "network") throw new Error("connection refused");
      if (refuses(o.repo)) return refusal(o.repo);
      return Response.json(o.repo ?? { full_name: path.slice("/repos/".length), default_branch: "main" });
    }
    if (path.includes("/branches/")) {
      if (o.branch === "network") throw new Error("connection reset");
      return o.branch ? refusal(o.branch) : Response.json({ name: path.split("/branches/")[1] });
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

  test("GitHub down for the App: unavailable, not a verdict on the repo", async () => {
    expect(await checkRepo(app(fakeApi({ installation: 503 })), widgets)).toMatchObject({ ok: false, reason: "unavailable" });
    expect(await checkRepo(app(fakeApi({ token: 500 })), widgets)).toMatchObject({ ok: false, reason: "unavailable" });
  });

  // An expired GITHUB_TOKEN, or an App id and key that don't match: the credential is what
  // needs fixing, not the repo's access.
  test("a 401 is the credential itself refused: credential_refused, never 'can't read the repo'", async () => {
    for (const api of [fakeApi({ repo: 401 }), fakeApi({ branch: 401 })]) {
      const r = await checkRepo(token(api), widgets, { fetch: api.f, branch: "main" });
      expect(r).toMatchObject({ ok: false, reason: "credential_refused" });
      expect((r as { detail: string }).detail).toContain("401");
    }
    for (const api of [fakeApi({ installation: 401 }), fakeApi({ token: 401 })]) {
      expect(await checkRepo(app(api), widgets, { fetch: api.f })).toMatchObject({ ok: false, reason: "credential_refused" });
    }
  });

  // GitHub's rate limits come as a 403 too; they say nothing about the repo.
  test("a rate limit (429, or a 403 with x-ratelimit-remaining: 0 or retry-after) is rate_limited, with how long to wait when GitHub says", async () => {
    for (const how of ["limit403", "retry403", "retry429"] as const) {
      const onRepo = fakeApi({ repo: how });
      expect([how, await checkRepo(token(onRepo), widgets, { fetch: onRepo.f })]).toEqual([how, { ok: false, reason: "rate_limited", detail: expect.stringContaining("rate limit"), ...(how === "limit403" ? {} : { retryAfterSecs: how === "retry403" ? 60 : 30 }) }]);
      const onBranch = fakeApi({ branch: how });
      expect(await checkRepo(token(onBranch), widgets, { fetch: onBranch.f, branch: "main" })).toMatchObject({ ok: false, reason: "rate_limited" });
      const onApp = fakeApi({ installation: how });
      expect(await checkRepo(app(onApp), widgets, { fetch: onApp.f })).toMatchObject({ ok: false, reason: "rate_limited" });
    }
  });

  test("with a plain token: readable when GitHub serves the repo to it", async () => {
    const api = fakeApi();
    expect(await checkRepo(token(api), widgets, { fetch: api.f })).toEqual({ ok: true, repo: widgets });
    expect(api.reqs).toEqual([{ path: "/repos/acme/widgets", auth: "Bearer ghp_dev" }]);
  });

  test("a repo the credential gets no read of (404, or a 403 that isn't a rate limit): not_readable", async () => {
    for (const status of [404, 403]) {
      const api = fakeApi({ repo: status });
      const r = await checkRepo(token(api), widgets, { fetch: api.f });
      expect(r).toMatchObject({ ok: false, reason: "not_readable" });
      expect((r as { detail: string }).detail).toContain(`acme/widgets (GitHub answered ${status})`);
    }
  });

  test("GitHub failing or unreachable: unavailable", async () => {
    for (const repo of [500, 502, "network"] as const) {
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
