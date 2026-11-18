// turns.ts — which Slack events start a turn, and for whom.
//
// The channel asks in two steps, in this order for every event (app.ts wires them to
// June's resolveIdentity and respondWhen; June awaits the first before it calls the second):
//   1. before(): look the sender up, if the event may start a turn (members.ts). Async.
//   2. decide(): answer, refuse with one line, or nothing. Synchronous: it reads the verdict
//      the lookup cached, and whether the thread is one the agent was asked into.
// Events are independent: another event's decide() can run while this one's before() is
// still waiting on Slack.

import { decideTurn, mayStartTurn, type Members, type Membership } from "./members";
import { isFollowUp } from "./threads";

// The sender facts an event carries, before it is decided (June's SlackIdentity).
export type TurnSender = { userId?: string; teamId?: string; channelId: string; threadId?: string; kind: string; ts: string };
// The event being decided (June's SlackNormalizedEvent, as much as is read here).
export type TurnEvent = { kind: string; channelId: string; channelType: string; threadId?: string; ts: string; text?: string; user?: { id: string } };
// "refuse" carries the verdict that refused (none: the sender was never looked up).
export type TurnDecision = { turn: "answer" } | { turn: "refuse"; verdict: Membership | undefined } | { turn: "none" };

export type TurnGate = {
  before(sender: TurnSender): Promise<void>;
  decide(event: TurnEvent): TurnDecision;
};

export function turnGate(o: {
  members: Members;
  // The channels the agent works in now (a channel closed since the start is not).
  listed: { has(channel: string): boolean };
  // Whether DMs are answered (DM_MODE=answer).
  dms: boolean;
  // Whether the agent was asked into this thread.
  joined: (channel: string, threadTs: string) => boolean;
}): TurnGate {
  // Mentions start a turn, and so do follow-ups in a thread the agent was mentioned in
  // (threads.ts); with DMs answered, DMs too.
  const mayRespond = (e: TurnEvent) => e.kind === "app_mention" || (o.dms && e.channelType === "im") || isFollowUp(e, o.joined);
  return {
    async before(sender) {
      if (sender.userId && mayStartTurn(sender, o.dms)) await o.members.check(sender.userId, sender.teamId);
    },
    decide(e) {
      if (!mayRespond(e)) return { turn: "none" };
      // Fails closed: a sender not looked up, or not a full member, is refused. The channel
      // is checked again first: the lookup awaited Slack, and an hourly recheck may have
      // closed the channel meanwhile (decideTurn).
      const verdict = e.user?.id ? o.members.peek(e.user.id) : undefined;
      const decision = decideTurn(e, o.listed, verdict);
      if (decision === "skip") return { turn: "none" };
      if (decision === "refuse") return { turn: "refuse", verdict };
      return { turn: "answer" };
    },
  };
}
