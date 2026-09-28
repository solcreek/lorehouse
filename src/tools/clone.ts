// clone.ts — get a GitHub repo into the thread's sandbox, private ones included.
//
// A read-only token for the one repo (see github-auth.ts) enters the sandbox for the
// single git command only, run the same guarded way the push is (git-credential.ts): it is
// never written to .git/config and the remote stays a plain https URL. A repo the
// GitHub App isn't installed on is cloned anonymously, which works when it's public.
// Already cloned: the checkout is fetched instead, so the tool also refreshes it.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import type { GithubAccess, RepoRef } from "../github-auth";
import { toolDescription } from "../prompts";
import { parseGithubRemote } from "./pull-request";
import { gitWithToken, tokenEnv } from "./git-credential";
import { WORKDIR, type SandboxFor } from "./workspace";

// "owner/name", or a github.com URL (https or ssh), to a repo reference.
export function parseRepo(input: string): RepoRef | undefined {
  const m = input.trim().match(/^(?:(?:https:\/\/|git@)github\.com[/:])?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m && !m[1]!.startsWith(".") && !m[2]!.startsWith(".") ? { owner: m[1]!, name: m[2]! } : undefined;
}

export function cloneTool(sandboxFor: SandboxFor, github: GithubAccess): Tool {
  return {
    spec: {
      name: "workspace_clone",
      description: toolDescription("workspace_clone", { workdir: WORKDIR }),
      input: {
        type: "object",
        properties: { repo: { type: "string", description: "owner/name, or its github.com URL" } },
        required: ["repo"],
      },
    },
    run: async (input: { repo: string }, ctx: ToolContext) => {
      const repo = parseRepo(input.repo);
      if (!repo) return { error: `not a GitHub repo: ${input.repo} (use owner/name)` };
      const url = `https://github.com/${repo.owner}/${repo.name}.git`;
      let env: Record<string, string> = {};
      let git = (args: string) => `git ${args}`;
      try {
        env = tokenEnv(await github(repo, "read"));
        git = gitWithToken;
      } catch (e) {
        // Not installed there: fine for a public repo, which clones anonymously.
        if (!/isn't installed/.test((e as Error).message)) return { error: `no GitHub credential for ${repo.owner}/${repo.name}: ${(e as Error).message}` };
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
          if (!current || current.owner !== repo.owner || current.name !== repo.name) {
            // Named only as owner/name: the remote URL itself may carry a credential.
            const holds = current ? `${current.owner}/${current.name}` : "a different repository";
            return { error: `${WORKDIR} already holds ${holds}; this thread's sandbox has one checkout` };
          }
          const r = await sb.exec(git("fetch --prune origin"), { cwd: WORKDIR, env, timeoutMs: 5 * 60_000 });
          if (r.exitCode !== 0) return { error: `fetch failed: ${r.stderr.slice(-500)}` };
          return { status: "fetched", repo: `${repo.owner}/${repo.name}`, path: WORKDIR };
        }
        const r = await sb.exec(git(`clone ${url} ${WORKDIR}`), { cwd: "/", env, timeoutMs: 10 * 60_000 });
        if (r.exitCode !== 0) return { error: `clone failed: ${r.stderr.slice(-500)}` };
        return { status: "cloned", repo: `${repo.owner}/${repo.name}`, path: WORKDIR };
      } catch (e) {
        return { error: (e as Error).message };
      }
    },
  };
}
