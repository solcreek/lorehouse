// turns.ts — which Slack events start a turn, and for whom.
//
// The channel asks in two steps, in this order for every event (app.ts wires them to
// June's resolveIdentity and respondWhen; June awaits the first before it calls the second):
//   1. before(): look the sender up, if the event may start a turn (members.ts). Async.
//   2. decide(): answer, refuse with one line, or nothing. Synchronous: it reads the verdict
//      the lookup cached, and whether the thread is one the agent was asked into.
// Events are independent: another event's decide() can run while this one's before() is
// still waiting on Slack. One case must not: a plain reply in a thread whose opening
// mention is still being looked up would be decided before the thread is joined, and
// dropped (#163). before() holds such a reply until the mention is decided (threads.ts,
// mentionHolds); the thread is joined only if the mention is accepted, in decide(), so a
// reply held for a refused asker's mention finds no joined thread and gets nothing.
//
// What the hold costs, and what it doesn't cover:
//   • Ingest of a held reply waits too, up to MENTION_HOLD_MS (12 s): June's onEvent, which
//     feeds the knowledge index, awaits the same promise as the decision. The message is
//     indexed late, not lost (and the start-up refresh would catch it after a restart).
//   • A reply Slack delivers BEFORE its thread's app_mention is still dropped: the hold
//     opens only when the mention arrives, so the reply finds neither a hold nor a joined
//     thread. Slack doesn't promise the order of two events; this one is rare (the reply
//     must be typed after the mention) and costs an answer, never exposes anything.
//   • A hold lives in memory: a reply held when the process stops is lost, as any event
//     in flight is.
//
// Which kinds of message start a turn at all is the profile's to say (profiles.ts): the
// events of the Slack trigger of the profile Slack starts, given here as `startsOn`.
//   • A mention that is not a trigger starts nothing, and so is never accepted: its thread
//     is not joined, its sender is not looked up, and it holds no reply.
//   • A follow-up is a reply in a thread a mention opened, so `follow_up` means something
//     only with `mention` (loadProfiles refuses it alone). Not a trigger: a reply in a
//     joined thread starts nothing, is not looked up and is never held.
//   • A DM starts a turn only when it is a trigger AND the install answers DMs (`dms`,
//     DM_MODE=answer): a profile can ask for DMs, it can't turn them on.

import { decideTurn, mayStartTurn, type Members, type Membership } from "./members";
import type { SlackTriggerEvent } from "./profiles";
import { isFollowUp, mentionHolds } from "./threads";

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
  // The kinds of message that start a turn: the Slack trigger events of the profile Slack
  // starts (profiles.ts). Left out: all three, as the lorehouse profile lists them.
  startsOn?: readonly SlackTriggerEvent[];
  // Whether the agent was asked into this thread.
  joined: (channel: string, threadTs: string) => boolean;
  // Record that it was: called for a mention that is answered, and for no other.
  join: (channel: string, threadTs: string) => void;
  // How long an undecided mention holds the replies in its thread (threads.ts).
  holdMs?: number;
  // Told when `joined` or `join` throws (the database): neither failure costs a lookup or
  // an accepted mention its answer.
  onError?: (what: string, err: unknown) => void;
}): TurnGate {
  // Whether the thread is joined, and "no" when that can't be read: a mention then opens a
  // hold it may not have needed, a reply waits for the mentions pending in its thread, and
  // a reply is not a follow-up (nothing is answered in a thread not known to be joined).
  // The sender's lookup never depends on it.
  const joined = (channel: string, threadTs: string): boolean => {
    try {
      return o.joined(channel, threadTs);
    } catch (err) {
      o.onError?.("reading whether the thread is joined", err);
      return false;
    }
  };
  // Mentions start a turn, and so do follow-ups in a thread the agent was mentioned in
  // (threads.ts); with DMs answered, DMs too. Each only where it is one of the profile's
  // trigger events.
  const on = new Set<SlackTriggerEvent>(o.startsOn ?? ["mention", "follow_up", "direct_message"]);
  const mentions = on.has("mention");
  const followUps = on.has("follow_up");
  const dms = o.dms && on.has("direct_message");
  const mayRespond = (e: TurnEvent) => (mentions && e.kind === "app_mention") || (dms && e.channelType === "im") || (followUps && isFollowUp(e, joined));
  // Whether the sender must be looked up: the event may start a turn (members.ts), and its
  // kind is a trigger. A DM is told by its channel id (D…), as mayStartTurn tells it.
  const mayStart = (s: TurnSender) => mayStartTurn(s, dms) && (s.kind === "app_mention" ? mentions : s.channelId.startsWith("D") || followUps);
  // A reply in a thread whose opening mention is not decided yet waits for it (#163).
  const holds = mentionHolds(o.holdMs);
  const decide = (e: TurnEvent): TurnDecision => {
    if (!mayRespond(e)) return { turn: "none" };
    // Fails closed: a sender not looked up, or not a full member, is refused. The channel
    // is checked again first: the lookup awaited Slack, and an hourly recheck may have
    // closed the channel meanwhile (decideTurn).
    const verdict = e.user?.id ? o.members.peek(e.user.id) : undefined;
    const decision = decideTurn(e, o.listed, verdict);
    if (decision === "skip") return { turn: "none" };
    if (decision === "refuse") return { turn: "refuse", verdict };
    // A mention asks the agent into its thread, once it is accepted: a thread a guest
    // opened, or one in a channel closed meanwhile, is never one the agent joined, so a
    // member's reply there is not a follow-up. The join is bookkeeping for later replies:
    // if recording it fails, the mention is still answered (as when the join was an
    // observer beside the turn), and replies there go unanswered until a new mention.
    if (e.kind === "app_mention") {
      try {
        o.join(e.channelId, e.threadId ?? e.ts);
      } catch (err) {
        o.onError?.("joining the thread", err);
      }
    }
    return { turn: "answer" };
  };
  return {
    async before(sender) {
      const waits: Promise<unknown>[] = [];
      // The hold opens before anything is awaited, so a reply that arrives next finds it. A
      // thread already joined needs none: replies there are follow-ups whatever this
      // mention comes to.
      const thread = sender.threadId ?? sender.ts;
      // A hold is for follow-ups to a mention that may be accepted: where either is not a
      // trigger, there is nothing to hold a reply for.
      if (mentions && followUps && sender.kind === "app_mention" && !joined(sender.channelId, thread)) holds.open(sender.channelId, thread, sender.ts);
      const lookUp = sender.userId && mayStart(sender) ? () => o.members.check(sender.userId!, sender.teamId) : undefined;
      if (lookUp) waits.push(lookUp());
      // A reply waits for the mentions pending in its thread, while its own sender is looked
      // up (so a sender not cached costs no extra wait).
      const held = followUps && sender.kind === "message" && thread !== sender.ts && !joined(sender.channelId, thread);
      if (held) waits.push(holds.settled(sender.channelId, thread));
      await Promise.all(waits);
      // The wait can outlast the sender's verdict: a cache hit made 5 s before it ran out
      // is gone after an 8 s hold, and decide() would refuse a member as "not looked up".
      // So the sender is checked again once the reply is let go: the cached verdict if it
      // is still within its own lifetime (no call), else a new lookup, whose answer is the
      // one that counts (a member turned guest meanwhile is refused). Never a verdict older
      // than the cache allows.
      if (held && lookUp) await lookUp();
    },
    // A mention's hold ends as it is decided, after the thread is joined (or not), and
    // whatever deciding it throws: the replies it held are decided next, each as any reply is.
    decide(e) {
      try {
        return decide(e);
      } finally {
        if (e.kind === "app_mention") holds.close(e.channelId, e.threadId ?? e.ts, e.ts);
      }
    },
  };
}
