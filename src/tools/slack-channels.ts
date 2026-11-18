// slack-channels.ts — the Slack channel's own tools reach only the channels the agent works in.
//
// June's Slack tools (slack_read_thread, slack_list_reactions, slack_add_reaction) take
// any channel id the model names, and the model gets ids from what it reads: a planted id
// could pull a DM's or a private channel's thread into a public reply, list who reacted
// how outside the allowlist, or put a reaction there. So a tool given a channel id is
// refused unless the channel is the one being answered in (a DM too, under
// DM_MODE=answer: the policy admitted it) or one the agent reads (AGENT_CHANNELS; an empty
// list reads nowhere, as in policy.ts). With no channel id, June's tools use the current
// channel, which is always allowed.
//
// The guard goes on every channel tool whose input has a channelId, not on a list of
// names, so a tool June adds later is guarded too.

import type { Tool, ToolContext } from "@junejs/core/agent-runtime";

export type Readable = (channelId: string) => boolean;

// The refusal for a channel the agent doesn't read, or undefined when the call may go on.
export function channelRefusal(input: unknown, ctx: ToolContext, readable: Readable): { error: string } | undefined {
  const channelId = (input as { channelId?: unknown } | undefined)?.channelId;
  if (channelId === undefined || channelId === null || channelId === "") return undefined; // June uses the current channel ("" finds no target)
  if (typeof channelId === "string" && (channelId === current(ctx) || readable(channelId))) return undefined;
  return { error: `not a channel I read: ${String(channelId)}` };
}

// The channel being answered in, as June's tools see it: only a Slack event has one.
function current(ctx: ToolContext): string | undefined {
  return ctx.event?.source === "slack" ? ctx.event.channelId : undefined;
}

// The channel a turn is answering in when it can be a public one: what a per-channel
// setting (a channel's default repo, tools/clone.ts) is looked up by. It comes from the
// event Slack signed, never from model input, so the model can't point a tool at another
// channel's setting. Never a DM, a group DM or a private channel: not by the event's type
// ("im", "mpim", "group"; a mention carries none, "unknown"), and not by its id (a public
// channel's starts with C; D is a DM, G a private channel or group DM). Nor a turn Slack
// didn't start. A C… id can still be a private channel's: whether the agent works there is
// the caller's to check against AGENT_CHANNELS (channel-repos.ts, defaultRepoFor).
export function answeredChannel(ctx: ToolContext): string | undefined {
  const e = ctx.event as { source?: string; channelId?: string; channelType?: string } | undefined;
  if (e?.source !== "slack" || !e.channelId || !/^C[A-Z0-9]+$/.test(e.channelId)) return undefined;
  return e.channelType === "im" || e.channelType === "mpim" || e.channelType === "group" ? undefined : e.channelId;
}

export function takesChannel(tool: Tool): boolean {
  const props = (tool.spec.input as { properties?: Record<string, unknown> } | undefined)?.properties;
  return !!props && "channelId" in props;
}

export function channelGuarded(tool: Tool, readable: Readable): Tool {
  return {
    ...tool,
    run: async (input, ctx) => channelRefusal(input, ctx, readable) ?? tool.run(input, ctx),
  };
}

// Guard every tool of the channel that takes a channel id; the others are unchanged.
export function withChannelGuard<C extends { tools?: () => Tool[] }>(channel: C, readable: Readable): C {
  const tools = channel.tools;
  if (!tools) return channel;
  return Object.assign(channel, {
    tools: () => tools().map((t) => (takesChannel(t) ? channelGuarded(t, readable) : t)),
  });
}
