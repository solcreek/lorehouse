// identity.ts — who the agent is in THIS install.
//
// The product name and the agent's name are separate: every workspace that installs it
// names its own agent (one team might call theirs "atlas"). The name is config, used for the
// agent's self-reference, its branch prefix, and PR attribution — and must match the
// Slack app's display name, which is set in the app manifest at install time.

export const DEFAULT_AGENT_NAME = "scout";

export type AgentIdentity = {
  name: string; // lowercase handle, e.g. "scout" → @scout, branches scout/<slug>
  coAuthor?: string; // git trailer identity, e.g. "Scout <scout@your-domain>"; omitted → no trailer
};

export function agentIdentity(name?: string, coAuthor?: string): AgentIdentity {
  const handle = (name ?? "").trim().toLowerCase() || DEFAULT_AGENT_NAME;
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(handle)) {
    throw new Error(`agent name "${name}" must be a lowercase handle: [a-z][a-z0-9-]{0,31}`);
  }
  return { name: handle, coAuthor: coAuthor?.trim() || undefined };
}

export const branchPrefix = (id: AgentIdentity) => `${id.name}/`;

// "scout" → "Scout", for prose.
export const displayName = (id: AgentIdentity) => id.name[0]!.toUpperCase() + id.name.slice(1);
