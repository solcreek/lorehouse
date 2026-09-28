// dm.ts — what a direct message gets under DM_MODE=redirect: one short reply pointing
// to the public channel(s), without a model call. See DmMode in config.ts.

type RawEvent = { type?: string; subtype?: string; channel?: string; channel_type?: string; user?: string; bot_id?: string; text?: string };

// A person's new message in a DM with the agent: the only thing that gets a redirect.
// Not an edit, a deletion or any other subtype, and never a bot's message, including
// the agent's own redirect, which would otherwise answer itself.
export function directMessage(raw: unknown): { channel: string; user: string } | undefined {
  const ev = (raw as { type?: string; event?: RawEvent } | undefined)?.event;
  if (!ev || ev.type !== "message" || ev.channel_type !== "im") return undefined;
  if (ev.subtype || ev.bot_id || !ev.user || !ev.channel) return undefined;
  return { channel: ev.channel, user: ev.user };
}

// Slack renders <#C…> as a link to the channel. With no allowlist the agent works in
// any public channel it has been added to.
export function redirectText(channels: ReadonlySet<string>): string {
  const where = channels.size === 0
    ? "any public channel I'm in"
    : [...channels].map((c) => `<#${c}>`).join(" or ");
  return `I only answer in public, so everyone can learn from the question and the answer. Ask me in ${where}.`;
}
