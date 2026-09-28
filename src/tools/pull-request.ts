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
// sandbox for the single `git push` command only (per-command env, read by an inline
// credential helper — never written to .git/config, never in argv), and the PR itself is
// opened from the worker side over the REST API.
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

export type PullRequestOptions = {
  sandboxFor: SandboxFor;
  // A write credential for the repo, asked for only after a human approved.
  github: GithubAccess;
  identity?: AgentIdentity; // default: scout
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
        await sh(
          // The helper reads the token from THIS command's env — nothing persists in the repo.
          `git -c credential.helper='!f() { echo username=x-access-token; echo "password=$LOREHOUSE_GH_TOKEN"; }; f' ` +
            `push origin ${head}:refs/heads/${input.branch}`,
          { LOREHOUSE_GH_TOKEN: token },
        );
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
      const approver = ctx.event?.user?.id;
      const body =
        `${input.body ?? ""}\n\n---\nOpened by ${displayName(id)} from Slack` +
        (approver ? `, approved by Slack user ${approver}` : "") + ".";
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

export function parseGithubRemote(url: string): { owner: string; name: string } {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`origin is not a GitHub remote: ${url}`);
  return { owner: m[1]!, name: m[2]! };
}

// Slack section text caps at 3000 chars; the stat's summary line is the last one.
function clipStat(stat: string): string {
  const lines = stat.split("\n");
  return lines.length <= 25 ? stat : [...lines.slice(0, 20), "…", lines.at(-1)!].join("\n");
}
