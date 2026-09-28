// pull-request.ts — the ONE irreversible step, behind a human.
//
// Everything else the agent does happens in a throwaway sandbox. Pushing a branch and opening
// a PR is visible to the whole org, so this tool parks the turn on ctx.requestInput: the
// Slack channel posts Approve / Deny, the Durable Object can hibernate meanwhile, and the
// click resumes the turn with the clicker's verified id. Only then does anything leave
// the sandbox.
//
// Credentials: a write token for this one repo is asked for only after the approval (from
// a GitHub App, a short-lived installation token; see github-auth.ts). It enters the
// sandbox for the single `git push` command only, run guarded (git-credential.ts: env
// only, hooks off, no other credential helpers, answered only for github.com), to the
// repo's github.com URL rather than `origin`, whose push URL the checkout could change.
// The PR itself is opened from the worker side over the REST API.
//
// Replay: after resume the engine re-runs this tool from the top. The pre-approval part
// is read-only (it recomputes the same summary), requestInput then returns the stored
// answer, and the post-approval part is idempotent — an already-open PR for the branch is
// returned instead of creating a second one.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { WORKDIR, type SandboxFor } from "./workspace";
import { agentIdentity, branchPrefix, displayName, type AgentIdentity } from "../identity";
import { toolDescription } from "../prompts";
import type { GithubAccess } from "../github-auth";
import { gitWithToken, tokenEnv } from "./git-credential";

export type PullRequestOptions = {
  sandboxFor: SandboxFor;
  // A write credential for the repo, asked for only after a human approved.
  github: GithubAccess;
  identity?: AgentIdentity; // default: scout
  // The approver's name for the PR body, from their Slack user id. The id itself never
  // goes into the PR: it identifies the workspace, and a PR can be public.
  approverName?: (slackUserId: string) => Promise<string | undefined>;
  fetch?: typeof fetch; // injectable for tests
};

type Input = { branch: string; title: string; body?: string; base?: string };

export function pullRequestTool(opts: PullRequestOptions): Tool {
  const f = opts.fetch ?? fetch;
  const id = opts.identity ?? agentIdentity();
  const BRANCH_PREFIX = branchPrefix(id);
  return {
    spec: {
      name: "open_pull_request",
      description: toolDescription("open_pull_request", { branch_prefix: BRANCH_PREFIX }),
      input: {
        type: "object",
        properties: {
          branch: { type: "string", description: `new branch name, e.g. ${BRANCH_PREFIX}fix-flaky-timer-test` },
          title: { type: "string" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "base branch (default: the repo's default branch)" },
        },
        required: ["branch", "title"],
      },
    },
    run: async (input: Input, ctx: ToolContext) => {
      if (!input.branch.startsWith(BRANCH_PREFIX) || !/^[\w./-]+$/.test(input.branch)) {
        return { error: `branch must start with "${BRANCH_PREFIX}" and contain only [A-Za-z0-9_./-]` };
      }
      const sb = opts.sandboxFor(ctx);
      const sh = async (command: string, env?: Record<string, string>) => {
        const r = await sb.exec(command, { cwd: WORKDIR, env, timeoutMs: 5 * 60_000 });
        if (r.exitCode !== 0) throw new Error(`\`${command.split("\n")[0]}\` failed (${r.exitCode}): ${r.stderr.slice(-500)}`);
        return r.stdout.trim();
      };

      // ── before approval: read-only facts about what would be pushed ──────────
      let repo: { owner: string; name: string };
      let base: string, head: string, stat: string;
      try {
        if (await sh("git status --porcelain")) return { error: "uncommitted changes — commit them first" };
        repo = parseGithubRemote(await sh("git remote get-url origin"));
        base = input.base ?? (await sh("git rev-parse --abbrev-ref origin/HEAD")).replace(/^origin\//, "");
        head = await sh("git rev-parse HEAD");
        stat = await sh(`git diff --stat origin/${base}...HEAD`);
      } catch (e) {
        return { error: (e as Error).message };
      }
      if (!stat) return { error: `HEAD has no changes against origin/${base}` };

      // Every commit must be by the account the PR comes from (the App's bot), before anyone
      // is asked to approve it: a commit made before that was enforced, or with an identity
      // the model set, would otherwise go out under a made-up name. Without an identity
      // (the lookup failed) there's nothing to check against.
      const who = await opts.github.identity?.().catch(() => undefined);
      if (who) {
        const want = `${who.name} <${who.email}>`;
        let lines: string[];
        try {
          lines = (await sh(`git log --format='%an <%ae>|%cn <%ce>' origin/${base}..HEAD`)).split("\n").filter(Boolean);
        } catch (e) {
          return { error: (e as Error).message };
        }
        const off = lines.filter((l) => l !== `${want}|${want}`).length;
        if (off) {
          return {
            error:
              `${off} of ${lines.length} commit(s) on HEAD aren't by ${want}. Re-author them, then call open_pull_request again: ` +
              `workspace_exec \`git rebase --exec 'git commit --amend --no-edit --reset-author' origin/${base}\` (commands already run as ${who.name}).`,
          };
        }
      }

      const approved = await ctx.requestInput({
        id: `pr:${input.branch}:${head.slice(0, 12)}`,
        prompt:
          `*Open a pull request?*\n${repo.owner}/${repo.name}: \`${input.branch}\` → \`${base}\` (${head.slice(0, 8)})\n` +
          `*${input.title}*\n\`\`\`${clipStat(stat)}\`\`\``,
      });
      if (approved !== true) return { status: "denied", note: "Nothing was pushed. Ask the requester what to change." };

      // ── after approval: push, then open (or find) the PR ────────────────────
      let token: string;
      try {
        token = await opts.github(repo, "write");
      } catch (e) {
        return { error: `no GitHub credential for ${repo.owner}/${repo.name}: ${(e as Error).message}` };
      }
      try {
        await sh(gitWithToken(`push https://github.com/${repo.owner}/${repo.name}.git ${head}:refs/heads/${input.branch}`), tokenEnv(token));
      } catch (e) {
        return { error: `push failed: ${(e as Error).message}` };
      }

      const gh = (path: string, init?: RequestInit) =>
        f(`https://api.github.com/repos/${repo.owner}/${repo.name}${path}`, {
          ...init,
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": `${id.name}-agent`,
            ...(init?.body ? { "content-type": "application/json" } : {}),
          },
        });

      const existing = await gh(`/pulls?state=open&head=${repo.owner}:${encodeURIComponent(input.branch)}`);
      if (existing.ok) {
        const [pr] = (await existing.json()) as { html_url: string; number: number }[];
        if (pr) return { status: "exists", url: pr.html_url, number: pr.number };
      }
      const approverId = ctx.event?.user?.id;
      const approver = approverId ? await opts.approverName?.(approverId).catch(() => undefined) : undefined;
      const body = `${input.body ?? ""}\n\n---\nOpened by ${displayName(id)} from Slack, approved there${approver ? ` by ${approver}` : ""}.`;
      const res = await gh("/pulls", {
        method: "POST",
        body: JSON.stringify({ title: input.title, head: input.branch, base, body, draft: true }),
      });
      if (!res.ok) return { error: `GitHub rejected the PR: ${res.status} ${(await res.text()).slice(0, 300)}` };
      const pr = (await res.json()) as { html_url: string; number: number };
      return { status: "opened", url: pr.html_url, number: pr.number };
    },
  };
}

// A remote on github.com itself: https://github.com/o/r, git@github.com:o/r or
// ssh://git@github.com/o/r (with or without .git). The whole URL must match: a token for o/r
// is asked for on the strength of it, so evil.github.com, github.com.evil.example or a
// URL with userinfo are refused. The URL isn't echoed back (it may hold a credential).
export function parseGithubRemote(url: string): { owner: string; name: string } {
  const m = url.trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  if (!m || m[1]!.startsWith(".") || m[2]!.startsWith(".")) throw new Error("origin is not a github.com remote");
  return { owner: m[1]!, name: m[2]! };
}

// Slack section text caps at 3000 chars; the stat's summary line is the last one.
function clipStat(stat: string): string {
  const lines = stat.split("\n");
  return lines.length <= 25 ? stat : [...lines.slice(0, 20), "…", lines.at(-1)!].join("\n");
}
