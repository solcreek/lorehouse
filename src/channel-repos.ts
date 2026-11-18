// channel-repos.ts — a channel's default repo (#126): the GitHub repo a request in that
// channel means when it names none ("@scout run the benchmark"), and optionally the branch
// a fresh clone starts on.
//
// It is install data, in LOREHOUSE_DB (migrations/0013_channel_repos.sql): an admin sets
// and clears it through the admin API (src/admin.ts), which checks first that the GitHub
// credential can read the repo. The model never sets it and never names the channel:
// workspace_clone (src/tools/clone.ts) looks it up for the channel of the thread being
// answered. Only a channel on AGENT_CHANNELS can have one, a DM never, and the row goes
// with the rest of the channel's data when it leaves the list (src/purge.ts).

import type { Database } from "./sqlite";
import type { RepoRef } from "./github-auth";

// `repo` is "owner/name". `branch` null: the repo's own default branch.
export type ChannelRepo = { channel: string; repo: string; branch: string | null; setAt: string };

// A Slack channel id, as the admin API takes one.
export const CHANNEL_ID = /^[A-Z0-9]{1,32}$/;

// What a branch name may be (github-auth.ts): the rule for what is stored here.
export { validBranch } from "./github-auth";

const SELECT = "SELECT channel, owner || '/' || name AS repo, branch, set_at AS setAt FROM channel_repos";

// A database that predates the table (one `lorehouse doctor` reads before the next start
// has migrated it) has no defaults.
export function hasChannelRepos(db: Database): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'channel_repos'").get() !== null;
}

export function getChannelRepo(db: Database, channel: string): ChannelRepo | undefined {
  return (db.query(`${SELECT} WHERE channel = ?`).get(channel) as ChannelRepo | null) ?? undefined;
}

// The lookup workspace_clone is handed: a channel's default only while the agent works
// there (`working`: on AGENT_CHANNELS, and not closed since the start). A row alone is not
// enough: one can outlive its channel's standing until the next start purges it.
export function defaultRepoFor(db: Database, working: { has(channel: string): boolean }): (channel: string) => ChannelRepo | undefined {
  return (channel) => (working.has(channel) ? getChannelRepo(db, channel) : undefined);
}

// Every channel's default, by channel id.
export function listChannelRepos(db: Database): ChannelRepo[] {
  return db.query(`${SELECT} ORDER BY channel`).all() as ChannelRepo[];
}

// Set a channel's default. Setting what is already there changes nothing, `setAt` included,
// so repeating a set is safe.
export function setChannelRepo(db: Database, o: { channel: string; repo: RepoRef; branch?: string | null }, now = new Date()): ChannelRepo {
  const branch = o.branch ?? null;
  db.query(
    `INSERT INTO channel_repos (channel, owner, name, branch, set_at) VALUES (@channel, @owner, @name, @branch, @at)
     ON CONFLICT (channel) DO UPDATE SET owner = excluded.owner, name = excluded.name, branch = excluded.branch, set_at = excluded.set_at
     WHERE owner IS NOT excluded.owner OR name IS NOT excluded.name OR branch IS NOT excluded.branch`,
  ).run({ channel: o.channel, owner: o.repo.owner, name: o.repo.name, branch, at: now.toISOString() });
  return getChannelRepo(db, o.channel)!;
}

// Clear a channel's default; whether there was one.
export function clearChannelRepo(db: Database, channel: string): boolean {
  return db.query("DELETE FROM channel_repos WHERE channel = ?").run(channel).changes > 0;
}
