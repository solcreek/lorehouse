// clone.ts — get a GitHub repo into the thread's sandbox, private ones included.
//
// A read-only token for the one repo (see github-auth.ts) enters the sandbox for the
// single git command only, run the same guarded way the push is (git-credential.ts): it is
// never written to .git/config and the remote stays a plain https URL. A repo the
// GitHub App isn't installed on is cloned anonymously, which works when it's public.
// Already cloned: the checkout is fetched instead, so the tool also refreshes it.
//
// Which repo (#126): the one the model names, from the request; with none named, the
// default repo of the channel the thread is in (channel-repos.ts), which an admin set. The
// channel comes from the turn's Slack event, never from the model, and a DM has none. With
// neither, the model is told to ask, not handed a failed turn. The default's branch is
// what a fresh clone starts on, also when the model names that same repo itself.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { validBranch } from "../channel-repos";
import type { GithubAccess, RepoRef } from "../github-auth";
import { toolDescription } from "../prompts";
import { parseGithubRemote } from "./pull-request";
import { gitWithToken, tokenEnv } from "./git-credential";
import { answeredChannel } from "./slack-channels";
import { WORKDIR, type SandboxFor } from "./workspace";

// "owner/name", or a github.com URL (https or ssh), to a repo reference.
export function parseRepo(input: string): RepoRef | undefined {
  const m = input.trim().match(/^(?:(?:https:\/\/|git@)github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m && !m[1]!.startsWith(".") && !m[2]!.startsWith(".") ? { owner: m[1]!, name: m[2]! } : undefined;
}

// Only characters a GitHub login and a noreply address use: it goes into a shell command.
const PLAIN = /^[A-Za-z0-9._+@[\] -]{1,100}$/;

// A channel's default repo, as the tool needs it: "owner/name", and the branch a fresh
// clone starts on (null: the repo's own default branch).
export type DefaultRepo = { repo: string; branch: string | null };
export type CloneOptions = {
  // The default repo of a public channel the agent works in, if an admin set one.
  defaultRepo?: (channel: string) => DefaultRepo | undefined;
};

// GitHub's owner and repo names are case-insensitive: "Acme/Widgets" is acme/widgets. Every
// comparison of two repos here goes through this. Which spelling is cloned and reported:
// the channel default's (GitHub's own, as the admin API stored it) when the repo is the
// default, however the request spelt it; the checkout's when one is already there; else
// the request's.
export const sameRepo = (a: RepoRef, b: RepoRef) => a.owner.toLowerCase() === b.owner.toLowerCase() && a.name.toLowerCase() === b.name.toLowerCase();

type Chosen = { repo: RepoRef; branch?: string; source: "named" | "channel_default" };

// Which repo a call means: the one named, else the channel's default, else an error that
// says what to do.
function choose(input: { repo?: unknown } | undefined, ctx: ToolContext, opts: CloneOptions): Chosen | { error: string } {
  const channel = answeredChannel(ctx);
  const set = channel ? opts.defaultRepo?.(channel) : undefined;
  const fallback = set && parseRepo(set.repo);
  // The default's branch, for the default repo only. It goes into a shell command: one
  // that isn't a plain branch name (a row edited by hand; the admin API refuses it) is
  // never used.
  const withBranch = (chosen: Chosen): Chosen | { error: string } => {
    if (!fallback || !sameRepo(fallback, chosen.repo)) return chosen;
    // The default, however it was spelt: in the default's spelling.
    const c = { ...chosen, repo: fallback };
    if (!set?.branch) return c;
    if (!validBranch(set.branch)) return { error: "this channel's default branch isn't a usable branch name; an admin has to set the channel's default repo again (docs/admin-api.md)" };
    return { ...c, branch: set.branch };
  };
  const named = input?.repo;
  if (named !== undefined && named !== null && named !== "") {
    if (typeof named !== "string") return { error: "`repo` must be a string: owner/name, or its github.com URL" };
    const repo = parseRepo(named);
    if (!repo) return { error: `not a GitHub repo: ${named} (use owner/name)` };
    return withBranch({ repo, source: "named" });
  }
  if (fallback) return withBranch({ repo: fallback, source: "channel_default" });
  return { error: "no repo was named, and there is no default repo here. Ask which GitHub repo (owner/name) to work in, then call workspace_clone with it as `repo`; don't guess one" };
}

export function cloneTool(sandboxFor: SandboxFor, github: GithubAccess, opts: CloneOptions = {}): Tool {
  // Commits in the checkout are by the account the credential acts as (the App's bot), at
  // its noreply address, so GitHub links them to it. Left unset, the model would make one
  // up. Best effort: without it the clone still stands.
  async function commitAs(sb: ReturnType<SandboxFor>): Promise<{ commitsAs?: string }> {
    const who = await github.identity?.().catch(() => undefined);
    if (!who || !PLAIN.test(who.name) || !PLAIN.test(who.email)) return {};
    const r = await sb.exec(`git config user.name '${who.name}' && git config user.email '${who.email}'`, { cwd: WORKDIR, timeoutMs: 30_000 }).catch(() => undefined);
    return r?.exitCode === 0 ? { commitsAs: `${who.name} <${who.email}>` } : {};
  }

  return {
    spec: {
      name: "workspace_clone",
      description: toolDescription("workspace_clone", { workdir: WORKDIR }),
      input: {
        type: "object",
        properties: { repo: { type: "string", description: "owner/name, or its github.com URL; leave out when the request names no repo, to use this channel's default repo" } },
      },
    },
    run: async (input: { repo?: unknown } | undefined, ctx: ToolContext) => {
      const chosen = choose(input, ctx, opts);
      if ("error" in chosen) return chosen;
      const { repo, branch, source } = chosen;
      const url = `https://github.com/${repo.owner}/${repo.name}.git`;
      // Said with a failure of the default, so the thread learns whose setting it is.
      const hint = source === "channel_default" ? ` (${repo.owner}/${repo.name}${branch ? `, branch ${branch},` : ""} is this channel's default repo; an admin can change it)` : "";
      let env: Record<string, string> = {};
      let git = (args: string) => `git ${args}`;
      try {
        env = tokenEnv(await github(repo, "read"));
        git = gitWithToken;
      } catch (e) {
        // Not installed there: fine for a public repo, which clones anonymously.
        if (!/isn't installed/.test((e as Error).message)) return { error: `no GitHub credential for ${repo.owner}/${repo.name}: ${(e as Error).message}${hint}` };
      }
      try {
        const sb = sandboxFor(ctx);
        const origin = await sb.exec(`git -C ${WORKDIR} remote get-url origin 2>/dev/null`, { timeoutMs: 30_000 });
        if (origin.exitCode === 0) {
          const current = (() => {
            try {
              return parseGithubRemote(origin.stdout);
            } catch {
              return undefined;
            }
          })();
          if (!current || !sameRepo(current, repo)) {
            // Named only as owner/name: the remote URL itself may carry a credential.
            const holds = current ? `${current.owner}/${current.name}` : "a different repository";
            return { error: `${WORKDIR} already holds ${holds}; this thread's sandbox has one checkout` };
          }
          const r = await sb.exec(git("fetch --prune origin"), { cwd: WORKDIR, env, timeoutMs: 5 * 60_000 });
          if (r.exitCode !== 0) return { error: `fetch failed: ${r.stderr.slice(-500)}${hint}` };
          // The checkout stays on whatever branch the thread left it on, and is reported as
          // it was cloned.
          return { status: "fetched", repo: `${current.owner}/${current.name}`, path: WORKDIR, source, ...(await commitAs(sb)) };
        }
        const r = await sb.exec(git(`clone ${branch ? `--branch ${branch} ` : ""}${url} ${WORKDIR}`), { cwd: "/", env, timeoutMs: 10 * 60_000 });
        if (r.exitCode !== 0) return { error: `clone failed: ${r.stderr.slice(-500)}${hint}` };
        return { status: "cloned", repo: `${repo.owner}/${repo.name}`, path: WORKDIR, source, ...(branch ? { branch } : {}), ...(await commitAs(sb)) };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  };
}
