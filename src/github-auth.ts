// github-auth.ts — how Lorehouse gets a GitHub credential for one repo, for one purpose.
//
// The recommended way is a GitHub App: it is its own identity (PRs come from
// "<app>[bot]"), belongs to the org rather than a person, reaches only the repos it is
// installed on, and holds no long-lived token. Lorehouse signs a short JWT with the App's
// private key and exchanges it for an installation token that expires in an hour,
// narrowed to the one repo and the least permissions the task needs (read to clone;
// write to push and open a pull request). Tokens are cached until five minutes before
// they expire.
//
// A plain token (GITHUB_TOKEN) is also accepted, for development.

import { createSign } from "node:crypto";

export type RepoRef = { owner: string; name: string };
// Who the agent's commits are by: the GitHub account the credential acts as, with its
// noreply address, so GitHub links each commit to that account (the App's bot).
export type GitIdentity = { name: string; email: string };
export type GithubAccess = ((repo: RepoRef, access: "read" | "write") => Promise<string>) & { identity?: () => Promise<GitIdentity> };

const noreply = (id: number, login: string): GitIdentity => ({ name: login, email: `${id}+${login}@users.noreply.github.com` });
const HEADERS = { accept: "application/vnd.github+json", "user-agent": "lorehouse" };

// Look something up once; a failure isn't cached, so the next call tries again.
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | undefined;
  return () => (p ??= load().catch((e) => { p = undefined; throw e; }));
}

export function staticToken(token: string, opts: { fetch?: typeof fetch; apiUrl?: string } = {}): GithubAccess {
  const f = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const access: GithubAccess = async () => token;
  access.identity = once(async () => {
    const res = await f(`${api}/user`, { headers: { ...HEADERS, authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`GitHub: who is this token? ${res.status}`);
    const u = (await res.json()) as { id: number; login: string };
    return noreply(u.id, u.login);
  });
  return access;
}

type AppOptions = { appId: string; privateKey: string; fetch?: typeof fetch; now?: () => number; apiUrl?: string };

// A JWT for the App itself (RS256): valid 9 minutes, backdated 60 s for clock skew.
export function appJwt(appId: string, privateKey: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: appId })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

export function githubApp(opts: AppOptions): GithubAccess {
  const f = opts.fetch ?? fetch;
  const now = () => opts.now?.() ?? Date.now();
  const api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const cache = new Map<string, { token: string; expiresAt: number }>();

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return f(`${api}${path}`, {
      ...init,
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${appJwt(opts.appId, opts.privateKey, now())}`, "user-agent": "lorehouse", ...(init.body ? { "content-type": "application/json" } : {}) },
    });
  }

  const tokenFor: GithubAccess = async (repo, access) => {
    const key = `${repo.owner}/${repo.name}:${access}`;
    const hit = cache.get(key);
    if (hit && hit.expiresAt - 5 * 60_000 > now()) return hit.token;

    const install = await call(`/repos/${repo.owner}/${repo.name}/installation`);
    if (install.status === 404) throw new Error(`the GitHub App isn't installed on ${repo.owner}/${repo.name}; install it there (Only select repositories) and try again`);
    if (!install.ok) throw new Error(`GitHub App: looking up ${repo.owner}/${repo.name}: ${install.status} ${(await install.text()).slice(0, 200)}`);
    const { id } = (await install.json()) as { id: number };

    const permissions = access === "write" ? { contents: "write", pull_requests: "write" } : { contents: "read" };
    const res = await call(`/app/installations/${id}/access_tokens`, { method: "POST", body: JSON.stringify({ repositories: [repo.name], permissions }) });
    if (!res.ok) throw new Error(`GitHub App: a ${access} token for ${repo.owner}/${repo.name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { token, expires_at } = (await res.json()) as { token: string; expires_at: string };
    cache.set(key, { token, expiresAt: Date.parse(expires_at) });
    return token;
  };
  // The App's bot user, "<slug>[bot]": the App says its slug, the (public) user record its id.
  tokenFor.identity = once(async () => {
    const app = await call("/app");
    if (!app.ok) throw new Error(`GitHub App: looking up the App: ${app.status}`);
    const { slug } = (await app.json()) as { slug: string };
    const login = `${slug}[bot]`;
    const user = await f(`${api}/users/${encodeURIComponent(login)}`, { headers: HEADERS });
    if (!user.ok) throw new Error(`GitHub: looking up ${login}: ${user.status}`);
    return noreply(((await user.json()) as { id: number }).id, login);
  });
  return tokenFor;
}

// A PEM from the environment: platforms often store it with literal "\n" escapes.
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}
