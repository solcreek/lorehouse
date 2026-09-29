// policy.ts — the defining constraint: the agent only works in PUBLIC channels.
//
// Everything it does is visible, so everyone learns from everyone's prompts and nobody
// runs a code-writing agent in a DM. Enforced at the channel's `accept` gate, which sees
// the signature-verified raw payload before any turn or model call.
//
// The one exception is a direct message, admitted only when `dms` is on (DM_MODE is not
// "ignore") so it can be pointed to a public channel or answered from public knowledge.
// A DM is never knowledge: ingest only reads the allowlisted channels. Private channels
// and group DMs stay shut.
//
// `accept` is synchronous, so it can't ask Slack (conversations.info) whether a channel
// is private. What the payload itself says:
//   • message events carry channel_type: "channel" (public) | "group" | "im" | "mpim"
//   • app_mention events carry NO channel_type — so a mention is admitted only in a
//     channel on the explicit allowlist.
//   • reaction events carry neither channel_type nor `channel`: the reacted-to message's
//     channel is `item.channel`, and like a mention it must be on the allowlist.
// An async accept (or a cached conversations.info lookup) in @junejs/core would let this
// drop the allowlist for mentions. June has neither yet.

type SlackEnvelope = {
  type?: string;
  event?: { type?: string; channel?: string; channel_type?: string; item?: { channel?: string } };
};

export function publicChannelsOnly(allowlist: ReadonlySet<string>, opts: { dms?: boolean } = {}) {
  return (raw: unknown): boolean => {
    const env = raw as SlackEnvelope | undefined;
    // slackChannel only consults accept for event_callback deliveries (Approve/Deny clicks
    // never reach it); anything else passing through here is not ours to gate.
    if (env?.type !== "event_callback" || !env.event) return true;
    const { type, channel, channel_type, item } = env.event;
    if (type === "reaction_added" || type === "reaction_removed") return !!item?.channel && allowlist.has(item.channel);
    if (!channel) return false;
    if (channel_type === "im") return opts.dms === true;
    if (channel_type) return channel_type === "channel" && (allowlist.size === 0 || allowlist.has(channel));
    return allowlist.has(channel);
  };
}

export function parseAllowlist(csv: string | undefined): Set<string> {
  return new Set((csv ?? "").split(",").map((s) => s.trim()).filter(Boolean));
}
