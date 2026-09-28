// A token-carrying git command, run with real git: nothing the checkout configures can
// capture the token (hooks, other credential helpers, a redirect to another host).

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitWithToken, tokenEnv } from "../src/tools/git-credential";
import { authorEnv } from "../src/tools/workspace";

const root = mkdtempSync(join(tmpdir(), "git-credential-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// A clean env: no user or system git config, so only what the test sets applies.
const baseEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function sh(command: string, o: { cwd?: string; env?: Record<string, string>; stdin?: string } = {}) {
  const r = Bun.spawnSync(["sh", "-c", command], { cwd: o.cwd ?? root, env: { ...baseEnv, ...o.env }, stdin: o.stdin === undefined ? "ignore" : new TextEncoder().encode(o.stdin) });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

// A checkout whose config an attacker controls, and a bare repo to push to.
function repo(name: string) {
  const dir = join(root, name);
  sh(`git init -q ${dir} && git -C ${dir} commit -q --allow-empty -m first && git init -q --bare ${dir}.git`);
  return dir;
}

describe("who commits", () => {
  test("the author environment outranks an identity the checkout's config was given", () => {
    const dir = repo("author");
    sh(`git config user.name Scout && git config user.email scout@made-up.example`, { cwd: dir });
    const bot = { name: "acme-agent[bot]", email: "900+acme-agent[bot]@users.noreply.github.com" };
    expect(sh(`git commit -q --allow-empty -m x`, { cwd: dir, env: authorEnv(bot) }).code).toBe(0);
    expect(sh(`git log -1 --format='%an <%ae>|%cn <%ce>'`, { cwd: dir }).out.trim()).toBe(`${bot.name} <${bot.email}>|${bot.name} <${bot.email}>`);
  });

  test("the re-author command open_pull_request suggests fixes every commit since the base", () => {
    const dir = repo("reauthor");
    sh(`git branch base && git config user.name Scout && git config user.email scout@made-up.example`, { cwd: dir });
    sh(`echo a > a && git add a && git commit -qm a && echo b > b && git add b && git commit -qm b`, { cwd: dir });
    const bot = { name: "acme-agent[bot]", email: "900+acme-agent[bot]@users.noreply.github.com" };
    const r = sh(`git rebase --exec 'git commit --amend --no-edit --reset-author' base`, { cwd: dir, env: authorEnv(bot) });
    expect(r.code).toBe(0);
    const want = `${bot.name} <${bot.email}>`;
    expect(sh(`git log --format='%an <%ae>|%cn <%ce>' base..HEAD`, { cwd: dir }).out.trim().split("\n")).toEqual([`${want}|${want}`, `${want}|${want}`]);
    expect(sh(`git log --format=%s base..HEAD`, { cwd: dir }).out.trim().split("\n")).toEqual(["b", "a"]); // same commits, re-authored
  });
});

describe("a pull request based on a branch the checkout pushed", () => {
  test("a push to the URL leaves origin/<branch> unknown; recording it makes the stacked diff work", () => {
    const dir = repo("stacked");
    sh(`git remote add origin ${dir}.git && git push -q origin HEAD:refs/heads/main && git fetch -q origin`, { cwd: dir });
    sh(`echo a > a && git add a && git commit -qm a`, { cwd: dir });
    const first = sh(`git rev-parse HEAD`, { cwd: dir }).out.trim();
    sh(`git push -q ${dir}.git ${first}:refs/heads/scout/one`, { cwd: dir }); // as open_pull_request pushes: to the URL
    expect(sh(`git rev-parse --verify --quiet origin/scout/one`, { cwd: dir }).code).not.toBe(0);
    sh(`git update-ref refs/remotes/origin/scout/one ${first}`, { cwd: dir }); // what it now records
    sh(`echo b > b && git add b && git commit -qm b`, { cwd: dir });
    expect(sh(`git diff --stat origin/scout/one...HEAD`, { cwd: dir }).out).toMatch(/^ b \| 1 \+\n 1 file changed/);
  });
});

describe("git with a token", () => {
  test("a hook planted in the checkout doesn't run, so it can't read the token", () => {
    const dir = repo("hooks");
    const leak = join(root, "hook-leak");
    writeFileSync(join(dir, ".git/hooks/pre-push"), `#!/bin/sh\necho "$LOREHOUSE_GH_TOKEN" > ${leak}\n`);
    chmodSync(join(dir, ".git/hooks/pre-push"), 0o755);
    const r = sh(gitWithToken(`push ${dir}.git HEAD:refs/heads/x`), { cwd: dir, env: tokenEnv("ghs_secret") });
    expect(r.code).toBe(0);
    expect(existsSync(leak)).toBe(false);
    // the control: the same push without the guard runs the hook
    sh(`git push -q ${dir}.git HEAD:refs/heads/y`, { cwd: dir, env: tokenEnv("ghs_secret") });
    expect(existsSync(leak)).toBe(true);
  });

  test("the token goes to github.com over https, and to no other credential helper", () => {
    const dir = repo("helpers");
    const leak = join(root, "helper-leak");
    // A helper in the checkout's config would be handed the credential to `store`.
    sh(`git config credential.helper '!f() { cat >> ${leak}; }; f'`, { cwd: dir });
    const fill = sh(`${gitWithToken("credential fill")}`, { cwd: dir, env: tokenEnv("ghs_secret"), stdin: "protocol=https\nhost=github.com\n\n" });
    expect(fill.code).toBe(0);
    expect(fill.out).toContain("username=x-access-token");
    expect(fill.out).toContain("password=ghs_secret");
    sh(`${gitWithToken("credential approve")}`, { cwd: dir, env: tokenEnv("ghs_secret"), stdin: fill.out + "\n" });
    expect(existsSync(leak)).toBe(false);
  });

  test("another host (a redirect by insteadOf, or plain http) gets nothing, and git doesn't prompt", () => {
    const dir = repo("hosts");
    for (const target of ["protocol=https\nhost=evil.example\n\n", "protocol=https\nhost=evil.github.com\n\n", "protocol=http\nhost=github.com\n\n"]) {
      const r = sh(`${gitWithToken("credential fill")}`, { cwd: dir, env: tokenEnv("ghs_secret"), stdin: target });
      expect(r.out).not.toContain("ghs_secret");
      expect(r.code).not.toBe(0); // no answer, no prompt: it fails
    }
  });
});
