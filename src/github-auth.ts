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

// A repo named exactly as owner/name: the one form a channel's default repo is taken in
// (admin.ts), stored in, and accepted back from GitHub (checkRepo). The characters GitHub
// names are made of, within its lengths (owner 39, name 100); no leading "." (so never
// "." or ".."), and no ".git" suffix. Not a URL: workspace_clone's own input is looser
// (tools/clone.ts, parseRepo).
export function repoName(s: string): RepoRef | undefined {
  const m = /^([A-Za-z0-9_.-]{1,39})\/([A-Za-z0-9_.-]{1,100})$/.exec(s);
  if (!m || m[1]!.startsWith(".") || m[2]!.startsWith(".") || m[2]!.endsWith(".git")) return undefined;
  return { owner: m[1]!, name: m[2]! };
}

// A branch name a channel's default repo may carry: one `git check-ref-format --branch`
// accepts, that a shell command can carry unquoted (it goes into `git clone --branch`),
// and that a URL leaves as it is (it goes into /branches/<name>). So: only letters, digits
// and . _ / - (which rules out spaces, control characters, and git's \ ~ ^ : ? * [ and
// @{); up to 255 characters; not starting with "-"; no empty path part (no leading,
// trailing or doubled "/"); no part starting with "." (so no "." or ".." part, which a URL
// would resolve away); no ".."; no part ending in ".lock"; not ending in ".". Stricter
// than git: a branch with other characters can't be a default.
export function validBranch(branch: string): boolean {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,254}$/.test(branch) || branch.includes("..") || branch.endsWith(".")) return false;
  return branch.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

// GitHub's rate limits: a 429, or a 403 that says so (the primary limit's
// x-ratelimit-remaining: 0; a secondary limit's retry-after). `retryAfterSecs` when it says
// how long to wait.
function rateLimit(res: Response): { retryAfterSecs?: number } | undefined {
  const retry = res.headers.get("retry-after");
  if (res.status !== 429 && !(res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || retry !== null))) return undefined;
  return retry !== null && /^\d{1,6}$/.test(retry) ? { retryAfterSecs: Number(retry) } : {};
}

// An answer from GitHub that wasn't the one asked for: its status, and whether it was a
// rate limit, so a caller can tell a refused credential (401) from a busy GitHub.
export class GithubRefused extends Error {
  readonly status: number;
  readonly rateLimit?: { retryAfterSecs?: number };
  constructor(res: Response, message: string) {
    super(message);
    this.status = res.status;
    this.rateLimit = rateLimit(res);
  }
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
    if (!install.ok) throw new GithubRefused(install, `GitHub App: looking up ${repo.owner}/${repo.name}: ${install.status} ${(await install.text()).slice(0, 200)}`);
    const { id } = (await install.json()) as { id: number };

    const permissions = access === "write" ? { contents: "write", pull_requests: "write" } : { contents: "read" };
    const res = await call(`/app/installations/${id}/access_tokens`, { method: "POST", body: JSON.stringify({ repositories: [repo.name], permissions }) });
    if (!res.ok) throw new GithubRefused(res, `GitHub App: a ${access} token for ${repo.owner}/${repo.name}: ${res.status} ${(await res.text()).slice(0, 200)}`);
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

// Whether the credential can read a repo now, and whether a branch exists there: asked
// before a channel's default repo is stored (admin.ts) and again by `lorehouse doctor`,
// since it can go stale (the App uninstalled, the repo renamed or deleted). Each outcome
// has its own next step:
//   not_installed       the GitHub App isn't installed on the repo: install it there
//   not_readable        no read of it (404, or a 403 that isn't a rate limit): no such
//                       repo, or the credential has no access to it
//   branch_not_found    the repo is readable and has no such branch
//   credential_refused  GitHub refused the credential itself (401): an expired or revoked
//                       GITHUB_TOKEN, or an App id and key that don't match. Fix the credential
//   rate_limited        GitHub is rate limiting the credential: wait (retryAfterSecs when it says)
//   unavailable         GitHub didn't answer, or failed: try again. Not a verdict on the repo
// `repo` in an ok answer is the name as GitHub spells it (its case; the new name after a
// rename); `branch`, when one was asked about, is the name GitHub answered with, which is
// the name asked for.
export type RepoCheck =
  | { ok: true; repo: RepoRef; branch?: string }
  | { ok: false; reason: "not_installed" | "not_readable" | "branch_not_found" | "credential_refused" | "unavailable"; detail: string }
  | { ok: false; reason: "rate_limited"; detail: string; retryAfterSecs?: number };

type Failed = Extract<RepoCheck, { ok: false }>;
const REFUSED = "GitHub refused the credential itself (401)";
const limited = (l: { retryAfterSecs?: number }): Failed => ({ ok: false, reason: "rate_limited", detail: `GitHub is applying a rate limit to the credential${l.retryAfterSecs !== undefined ? ` (it says to wait ${l.retryAfterSecs} s)` : ""}`, ...l });

export async function checkRepo(github: GithubAccess, repo: RepoRef, opts: { branch?: string; fetch?: typeof fetch; apiUrl?: string } = {}): Promise<RepoCheck> {
  const f = opts.fetch ?? fetch;
  const api = (opts.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const full = `${repo.owner}/${repo.name}`;
  let token: string;
  try {
    token = await github(repo, "read");
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    if (/isn't installed/.test(detail)) return { ok: false, reason: "not_installed", detail };
    if (e instanceof GithubRefused && e.rateLimit) return limited(e.rateLimit);
    if (e instanceof GithubRefused && e.status === 401) return { ok: false, reason: "credential_refused", detail: `${REFUSED}: ${detail}` };
    return { ok: false, reason: "unavailable", detail };
  }
  const get = async (path: string, init: RequestInit = {}): Promise<Response | string> => {
    try {
      return await f(`${api}${path}`, { ...init, headers: { ...HEADERS, authorization: `Bearer ${token}` } });
    } catch (e) {
      return `GitHub didn't answer: ${e instanceof Error ? e.message : e}`;
    }
  };

  // What an answer that isn't the thing asked for means, apart from "not there", which
  // is the caller's to name: a rate limit, or the credential refused.
  const refused = (r: Response, what: string): Failed | undefined => {
    const l = rateLimit(r);
    if (l) return limited(l);
    if (r.status === 401) return { ok: false, reason: "credential_refused", detail: `${REFUSED} when asked for ${what}` };
    return undefined;
  };

  const res = await get(`/repos/${repo.owner}/${repo.name}`);
  if (typeof res === "string") return { ok: false, reason: "unavailable", detail: res };
  const no = refused(res, full);
  if (no) return no;
  if (res.status === 403 || res.status === 404) return { ok: false, reason: "not_readable", detail: `the GitHub credential can't read ${full} (GitHub answered ${res.status}): no such repo, or no access to it` };
  if (!res.ok) return { ok: false, reason: "unavailable", detail: `GitHub answered ${res.status} for ${full}` };
  // GitHub's spelling is what gets stored, so it is held to the same rule as an admin's
  // input: an answer that names no usable repo is not a yes.
  const named = ((await res.json().catch(() => undefined)) as { full_name?: unknown } | undefined)?.full_name;
  const canonical = typeof named === "string" ? repoName(named) : undefined;
  if (!canonical) return { ok: false, reason: "unavailable", detail: `GitHub's answer for ${full} didn't name the repo as owner/name` };

  if (opts.branch === undefined) return { ok: true, repo: canonical };

  // The branch that gets stored must be the branch that was asked about, so the answer has
  // to be about that very name:
  //   • a name a URL would rewrite ("a/./b" asks about "a/b") is never sent (validBranch);
  //   • each part is encoded, the slashes kept: a branch may be "release/2026.11";
  //   • a redirect isn't followed: GitHub redirects a renamed branch to its new name, and
  //     the old one is no longer there to clone;
  //   • the name in the answer must be the name asked for.
  const missing: Failed = { ok: false, reason: "branch_not_found", detail: `${canonical.owner}/${canonical.name} has no branch ${opts.branch}` };
  if (!validBranch(opts.branch)) return missing;
  const b = await get(`/repos/${canonical.owner}/${canonical.name}/branches/${opts.branch.split("/").map(encodeURIComponent).join("/")}`, { redirect: "manual" });
  if (typeof b === "string") return { ok: false, reason: "unavailable", detail: b };
  const noBranch = refused(b, `the branch ${opts.branch} of ${full}`);
  if (noBranch) return noBranch;
  if (b.status === 404) return missing;
  if (b.status >= 300 && b.status < 400) return { ...missing, detail: `${missing.detail} (GitHub redirects it: the branch was renamed)` };
  if (!b.ok) return { ok: false, reason: "unavailable", detail: `GitHub answered ${b.status} for the branch ${opts.branch} of ${full}` };
  const answered = ((await b.json().catch(() => undefined)) as { name?: unknown } | undefined)?.name;
  if (answered !== opts.branch) return missing;
  return { ok: true, repo: canonical, branch: answered };
}

// A PEM from the environment: platforms often store it with literal "\n" escapes.
export function normalizePem(pem: string): string {
  return pem.includes("\\n") ? pem.replace(/\\n/g, "\n") : pem;
}
