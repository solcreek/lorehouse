// pull-request.ts — the ONE irreversible step, behind a human.
//
// Everything else the agent does happens in a throwaway sandbox. Pushing a branch and opening
// a PR is visible to the whole org, so this tool parks the turn on ctx.requestInput: the
// Slack channel posts Approve / Deny, the Durable Object can hibernate meanwhile, and the
// click resumes the turn with the clicker's verified id. Only then does anything leave
// the sandbox.
//
// Publishing goes through the sandbox host, not the sandbox (Sandbox.stage/push, see
// sandbox/host/src/publish.rs). Before approval, the host stages the commits: it verifies
// them into its own mirror and computes the diff, the patch and the authors the human
// sees. After approval, the host pushes exactly that commit. The write token for this one
// repo (a GitHub App installation token, see github-auth.ts) is asked for only then, and it
// goes to the host, never into the sandbox. The PR itself is opened from the worker side
// over the REST API.
//
// Replay: after resume the engine re-runs this tool from the top. The pre-approval part
// stages again (the same commits give the same sha and the same card), requestInput then
// returns the stored answer, and the post-approval part is idempotent: an already-open PR
// for the branch is returned instead of creating a second one.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import { WORKDIR, type SandboxFor, type Staged } from "./workspace";
import { agentIdentity, branchPrefix, displayName, type AgentIdentity } from "../identity";
import { toolDescription } from "../prompts";
import type { GitIdentity, GithubAccess, RepoRef } from "../github-auth";

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
      if (!input.branch.startsWith(BRANCH_PREFIX) || !isPlainRef(input.branch)) {
        return { error: `branch must start with "${BRANCH_PREFIX}" and be a plain branch name ([A-Za-z0-9_./-], no "..")` };
      }
      if (input.base !== undefined && !isPlainRef(input.base)) {
        return { error: `base must be a plain branch name ([A-Za-z0-9_./-], no "..")` };
      }
      const sb = opts.sandboxFor(ctx);
      const sh = async (command: string, env?: Record<string, string>) => {
        const r = await sb.exec(command, { cwd: WORKDIR, env, timeoutMs: 5 * 60_000 });
        if (r.exitCode !== 0) throw new Error(`\`${command.split("\n")[0]}\` failed (${r.exitCode}): ${r.stderr.slice(-500)}`);
        return r.stdout.trim();
      };

      // ── before approval: what would be published, staged by the sandbox host ───
      // The sandbox only says which repo and base. The commits are staged by the host
      // (Sandbox.stage), which verifies them and computes what the approval shows: nothing
      // shown or pushed comes from the sandbox's own git, which the model controls.
      let repo: RepoRef;
      let base: string;
      try {
        if (await sh("git status --porcelain")) return { error: "uncommitted changes — commit them first" };
        repo = parseGithubRemote(await sh("git remote get-url origin"));
        base = input.base ?? (await sh("git rev-parse --abbrev-ref origin/HEAD")).replace(/^origin\//, "");
      } catch (e) {
        return { error: (e as Error).message };
      }
      if (!isPlainRef(base)) return { error: "the repo's default branch isn't a plain branch name; give base explicitly" };
      // A read token to stage with (the host mirrors the repo); write access waits for approval.
      let readToken: string;
      try {
        readToken = await opts.github(repo, "read");
      } catch (e) {
        return { error: `no GitHub credential for ${repo.owner}/${repo.name}: ${(e as Error).message}` };
      }
      let staged: Staged;
      try {
        staged = await sb.stage({ repo, base, token: readToken });
      } catch (e) {
        return { error: `couldn't stage the commits: ${(e as Error).message}` };
      }
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(staged.sha)) return { error: "the staged commit id is malformed" };

      // Every commit must be by the account the PR comes from (the App's bot), before anyone
      // is asked to approve it: a commit made before that was enforced, or with an identity
      // the model set, would otherwise go out under a made-up name. The authors are the
      // host's reading of the staged commits. It fails closed: when the account can't be
      // looked up (GitHub unreachable), nobody is asked to approve commits that can't be
      // checked. Only a credential with no account to commit as skips the check.
      let who: GitIdentity | undefined;
      try {
        who = await opts.github.identity?.();
      } catch (e) {
        return { error: `can't check who the commits are by: looking up the GitHub account failed (${(e as Error).message}). Nothing was pushed; try again shortly.` };
      }
      if (who) {
        const want = `${who.name} <${who.email}>`;
        const off = staged.authors.filter((l) => l !== `${want}|${want}`).length;
        if (off) {
          return {
            error:
              `${off} of ${staged.authors.length} commit(s) on HEAD aren't by ${want}. Re-author them, then call open_pull_request again: ` +
              `workspace_exec \`git rebase --exec 'git commit --amend --no-edit --reset-author' origin/${base}\` (commands already run as ${who.name}).`,
          };
        }
      }

      const approved = await ctx.requestInput({
        id: `pr:${input.branch}:${staged.sha.slice(0, 12)}`,
        prompt: approvalCard({ repo, branch: input.branch, base, title: input.title, staged }),
      });
      if (approved !== true) return { status: "denied", note: "Nothing was pushed. Ask the requester what to change." };

      // ── after approval: the host pushes the staged commit, then open (or find) the PR ─
      let token: string;
      try {
        token = await opts.github(repo, "write");
      } catch (e) {
        return { error: `no GitHub credential for ${repo.owner}/${repo.name}: ${(e as Error).message}` };
      }
      try {
        await sb.push({ repo, sha: staged.sha, branch: input.branch, token });
      } catch (e) {
        return { error: `push failed: ${(e as Error).message}` };
      }
      // The checkout doesn't know about a push it didn't make: record it as origin/<branch>,
      // so a later PR can be based on this branch. Local only; a fetch brings it in anyway.
      await sb.exec(`git update-ref refs/remotes/origin/${input.branch} ${staged.sha}`, { cwd: WORKDIR, timeoutMs: 30_000 }).catch(() => undefined);

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

// A branch name safe to put in a shell command and a git refspec: letters, digits and
// _ . / - only (no shell metacharacters, no spaces), not starting with - or /, no "..",
// "//" or trailing "/" or ".lock" (which git refuses anyway).
export function isPlainRef(ref: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(ref) && !ref.includes("..") && !ref.includes("//") && !ref.endsWith("/") && !ref.endsWith(".lock");
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

// Paths a reviewer should look at twice: what runs in CI, and who owns what (GitHub reads
// CODEOWNERS from .github/, the root, or docs/).
const SENSITIVE = /^(\.github\/|(docs\/)?CODEOWNERS$)/;

// What the approver sees, all from the host's staging: the stat, any sensitive paths, and as
// much of the patch as fits. A Slack section caps at 3000 characters.
export function approvalCard(o: { repo: RepoRef; branch: string; base: string; title: string; staged: Staged }): string {
  const { staged } = o;
  const head =
    `*Open a pull request?*\n${o.repo.owner}/${o.repo.name}: \`${o.branch}\` → \`${o.base}\` (${staged.sha.slice(0, 8)}, ` +
    `${staged.commits} commit${staged.commits === 1 ? "" : "s"})\n*${o.title}*\n`;
  const statLines = staged.stat.trimEnd().split("\n");
  const stat = statLines.length <= 15 ? statLines.join("\n") : [...statLines.slice(0, 12), "…", statLines.at(-1)!].join("\n");
  const sensitive = staged.files.filter((f) => SENSITIVE.test(f));
  const warn = sensitive.length ? `:warning: Changes ${sensitive.slice(0, 5).map((f) => `\`${f}\``).join(", ")}${sensitive.length > 5 ? " …" : ""}: check these closely.\n` : "";
  const room = 2900 - head.length - stat.length - warn.length - 40;
  let patch = staged.patch.replaceAll("```", "``​`");
  const cut = patch.length > room || staged.patchTruncated;
  if (patch.length > room) patch = patch.slice(0, Math.max(0, room));
  const excerpt = room > 200 ? `\`\`\`${patch.trimEnd()}${cut ? "\n… (truncated)" : ""}\`\`\`` : "";
  return `${head}\`\`\`${stat}\`\`\`\n${warn}${excerpt}`;
}
