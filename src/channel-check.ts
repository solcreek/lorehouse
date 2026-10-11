// channel-check.ts — every channel in AGENT_CHANNELS must be a public channel, and Slack
// is asked, not the id's first letter (#86). A private channel's history would be indexed
// and quotable in public answers, and its mentions answered: app_mention and reaction
// payloads carry no channel type, and ingest reads every listed channel, so the list is
// all that vouches for them. Private channels made since 2021 have C… ids like public ones.
//
// conversations.info (channels:read) is asked once per listed channel, one at a time:
//   • on start, before the app opens its database or listens (assertPublicChannels): any
//     channel that isn't public refuses the start, named in the ConfigError
//   • by `lorehouse doctor`, per channel, read-only
//   • by ingest, before it first reads a channel and then hourly (ingest/slack.ts): a
//     channel that turned private or was archived while the app runs is closed then
// A lookup that fails (not found, a missing scope, no answer) fails closed: the channel
// counts as not public. A private channel is looked up with groups:read, which Lorehouse
// never asks for, so in a real workspace one likely answers missing_scope or
// channel_not_found rather than is_private (not yet seen against real Slack). Those are
// Slack's answer about the channel (isDefiniteFailure), not an outage, and a running
// app closes a channel on them as on is_private.

import { ConfigError } from "./config";
import type { SlackApi } from "./slack-api";

// What conversations.info says about a channel: the fields that decide.
export type ChannelInfo = {
  id?: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
};

export type ChannelVerdict =
  | { channel: string; name?: string; public: true }
  | { channel: string; name?: string; public: false; reason: "private" | "group_dm" | "dm" | "archived" }
  | { channel: string; name?: string; public: false; reason: "lookup_failed"; error: string };

// Public means Slack said so: not a DM, group DM or private channel, not archived, and
// is_private present and false. Anything Slack left unsaid fails closed.
export function classifyChannel(channel: string, info: ChannelInfo | undefined): ChannelVerdict {
  if (!info || typeof info !== "object") return { channel, public: false, reason: "lookup_failed", error: "Slack's answer had no channel" };
  const name = typeof info.name === "string" && info.name ? info.name : undefined;
  const base = name ? { channel, name } : { channel };
  if (info.is_im) return { ...base, public: false, reason: "dm" };
  if (info.is_mpim) return { ...base, public: false, reason: "group_dm" };
  if (info.is_private || info.is_group) return { ...base, public: false, reason: "private" };
  if (info.is_private !== false) return { ...base, public: false, reason: "lookup_failed", error: "Slack didn't say whether it is private" };
  if (info.is_archived) return { ...base, public: false, reason: "archived" };
  return { ...base, public: true };
}

// Errors that are Slack's answer about this channel, as opposed to an outage (http_5xx,
// ratelimited, fatal_error, no answer): the channel isn't one this token may see as public.
const DEFINITE = new Set(["channel_not_found", "missing_scope", "not_in_channel", "method_not_supported_for_channel_type"]);
export const isDefiniteFailure = (v: ChannelVerdict): boolean => !v.public && v.reason === "lookup_failed" && DEFINITE.has(v.error);

export const LOOKUP_TIMEOUT_MS = 10_000;

// Look one channel up. Never throws: a failure is a verdict (lookup_failed), and so is no
// answer within timeoutMs (a start must not hang on Slack before it listens).
export async function lookUpChannel(api: SlackApi, channel: string, timeoutMs = LOOKUP_TIMEOUT_MS): Promise<ChannelVerdict> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs); });
    const res = await Promise.race([api.call<{ channel?: ChannelInfo }>("conversations.info", { channel }), timeout]);
    return classifyChannel(channel, res.channel);
  } catch (err) {
    // SlackApiError's code (channel_not_found, missing_scope, http_500), or why fetch failed.
    const code = (err as { code?: unknown }).code;
    return { channel, public: false, reason: "lookup_failed", error: typeof code === "string" ? code : String(err instanceof Error ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

// Every channel, one request at a time (the list is short, and conversations.info is rate
// limited; slackApi waits out a 429).
export async function lookUpChannels(api: SlackApi, channels: Iterable<string>): Promise<ChannelVerdict[]> {
  const out: ChannelVerdict[] = [];
  for (const channel of channels) out.push(await lookUpChannel(api, channel));
  return out;
}

// What is wrong with a channel that isn't public, in a sentence; for a public one, that.
export function describeVerdict(v: ChannelVerdict): string {
  const who = v.name ? `${v.channel} (#${v.name})` : v.channel;
  if (v.public) return `${who} is a public channel`;
  switch (v.reason) {
    case "private": return `${who} is a private channel`;
    case "group_dm": return `${who} is a group DM`;
    case "dm": return `${who} is a DM`;
    case "archived": return `${who} is archived`;
    case "lookup_failed": return `${who} couldn't be looked up, so it counts as not public: conversations.info said ${v.error}${hint(v.error)}`;
  }
}

function hint(error: string): string {
  if (error === "channel_not_found") return " (no such channel, or a private one the bot can't see)";
  if (error === "missing_scope") return " (the app needs channels:read; or it's a private channel, which needs groups:read)";
  return "";
}

// Refuse the start when any listed channel isn't public, naming each one.
export async function assertPublicChannels(api: SlackApi, channels: Iterable<string>): Promise<void> {
  const refused = (await lookUpChannels(api, channels)).filter((v) => !v.public);
  if (refused.length) {
    throw new ConfigError(refused.map((v) => `AGENT_CHANNELS (${describeVerdict(v)}; list only public channels)`));
  }
}
