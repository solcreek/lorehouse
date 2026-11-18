// A channel's default repo (#126): one row per channel in LOREHOUSE_DB, set and cleared
// by an admin, read by workspace_clone.

import { describe, expect, test } from "bun:test";
import { clearChannelRepo, defaultRepoFor, getChannelRepo, hasChannelRepos, listChannelRepos, setChannelRepo, validBranch } from "../src/channel-repos";
import { openKnowledge } from "../src/knowledge";
import { MIGRATIONS } from "../src/migrations";

const widgets = { owner: "acme", name: "widgets" };
const T0 = new Date("2026-11-01T00:00:00Z");
const T1 = new Date("2026-11-02T00:00:00Z");

describe("a channel's default repo", () => {
  test("none until set; set, it is read back with its branch and when it was set", () => {
    const db = openKnowledge(":memory:");
    expect(getChannelRepo(db, "C1")).toBeUndefined();
    expect(listChannelRepos(db)).toEqual([]);
    expect(setChannelRepo(db, { channel: "C1", repo: widgets, branch: "main" }, T0)).toEqual({ channel: "C1", repo: "acme/widgets", branch: "main", setAt: T0.toISOString() });
    expect(getChannelRepo(db, "C1")).toEqual({ channel: "C1", repo: "acme/widgets", branch: "main", setAt: T0.toISOString() });
    expect(getChannelRepo(db, "C2")).toBeUndefined();
  });

  test("no branch is null: the repo's own default branch", () => {
    const db = openKnowledge(":memory:");
    expect(setChannelRepo(db, { channel: "C1", repo: widgets }, T0).branch).toBeNull();
    expect(setChannelRepo(db, { channel: "C2", repo: widgets, branch: null }, T0).branch).toBeNull();
  });

  test("setting it again replaces it: one default per channel", () => {
    const db = openKnowledge(":memory:");
    setChannelRepo(db, { channel: "C1", repo: widgets, branch: "main" }, T0);
    expect(setChannelRepo(db, { channel: "C1", repo: { owner: "acme", name: "gadgets" } }, T1)).toEqual({ channel: "C1", repo: "acme/gadgets", branch: null, setAt: T1.toISOString() });
    expect(listChannelRepos(db)).toHaveLength(1);
  });

  test("setting what is already there changes nothing, not even when it was set", () => {
    const db = openKnowledge(":memory:");
    setChannelRepo(db, { channel: "C1", repo: widgets, branch: "main" }, T0);
    expect(setChannelRepo(db, { channel: "C1", repo: widgets, branch: "main" }, T1).setAt).toBe(T0.toISOString());
    setChannelRepo(db, { channel: "C2", repo: widgets }, T0);
    expect(setChannelRepo(db, { channel: "C2", repo: widgets }, T1).setAt).toBe(T0.toISOString());
    // A branch added, or dropped, is a change.
    expect(setChannelRepo(db, { channel: "C2", repo: widgets, branch: "main" }, T1).setAt).toBe(T1.toISOString());
    expect(setChannelRepo(db, { channel: "C1", repo: widgets }, T1)).toMatchObject({ branch: null, setAt: T1.toISOString() });
  });

  test("clearing removes it and says whether there was one; clearing again is harmless", () => {
    const db = openKnowledge(":memory:");
    setChannelRepo(db, { channel: "C1", repo: widgets }, T0);
    expect(clearChannelRepo(db, "C1")).toBe(true);
    expect(getChannelRepo(db, "C1")).toBeUndefined();
    expect(clearChannelRepo(db, "C1")).toBe(false);
  });

  test("listed by channel id", () => {
    const db = openKnowledge(":memory:");
    setChannelRepo(db, { channel: "C9", repo: widgets }, T0);
    setChannelRepo(db, { channel: "C1", repo: { owner: "acme", name: "gadgets" }, branch: "dev" }, T0);
    expect(listChannelRepos(db).map((r) => `${r.channel} ${r.repo} ${r.branch}`)).toEqual(["C1 acme/gadgets dev", "C9 acme/widgets null"]);
  });

  // What workspace_clone is handed (src/app.ts): a stored row is not enough. Rows for a
  // private channel, a DM, a channel off the list or one closed since the start can exist
  // (set before it changed, or written by hand); none of them is a default.
  test("defaultRepoFor: only a channel the agent works in now gets its default", () => {
    const db = openKnowledge(":memory:");
    for (const channel of ["C1", "C2", "C9", "G1", "D1"]) setChannelRepo(db, { channel, repo: widgets }, T0);
    const closed = new Set(["C2"]);
    const listed = new Set(["C1", "C2"]);
    const lookup = defaultRepoFor(db, { has: (c) => listed.has(c) && !closed.has(c) });
    expect(lookup("C1")).toMatchObject({ channel: "C1", repo: "acme/widgets" });
    for (const channel of ["C2", "C9", "G1", "D1", "C404"]) expect([channel, lookup(channel)]).toEqual([channel, undefined]);
    // Reopened (a restart), it has its default again: the row was kept.
    closed.clear();
    expect(lookup("C2")).toMatchObject({ channel: "C2" });
  });

  test("a database from before the table has none, and says so without failing", () => {
    const old = openKnowledge(":memory:", MIGRATIONS.filter((m) => m.version < 13));
    expect(hasChannelRepos(old)).toBe(false);
    expect(hasChannelRepos(openKnowledge(":memory:"))).toBe(true);
  });

  test("a branch name is what git accepts and a shell command can carry unquoted", () => {
    for (const ok of ["main", "release/2026.11", "feat/channel-default-repo", "v1.2.3", "a_b", "a/b.c/d", "x".repeat(255)]) expect([ok, validBranch(ok)]).toEqual([ok, true]);
    for (const bad of ["", "-rf", "/main", "main/", "a..b", "a//b", "main.lock", "main.", ".hidden", "a b", "a;rm -rf /", "$(id)", "a'b", "a~1", "a^", "a:b", "x".repeat(256)]) expect([bad, validBranch(bad)]).toEqual([bad, false]);
  });

  // What `git check-ref-format --branch` refuses, and what a URL would normalize away: a
  // name is stored only if it is, part for part, what GitHub was asked about.
  test("a branch name has no '.' or '..' part, no empty part, no part that starts with '.' or ends in '.lock', and none of git's forbidden characters", () => {
    for (const bad of ["a/./b", "a/../b", "./a", "a/.", "a/..", "a/.b", "a/b.lock/c", "a.lock/b", "a/b/", "a/b.", "@", "a@{b", "a\\b", "a?b", "a*b", "a[b", "a\tb", "a\nb", "a\u007fb", "a\u0000b", "-a/b"]) expect([JSON.stringify(bad), validBranch(bad)]).toEqual([JSON.stringify(bad), false]);
  });
});
