// slack-guard.ts — every way text leaves for Slack goes through neutralizeMentions
// (mentions.ts), so the agent never @-mentions anyone, whatever the model writes.
//
// June's Slack channel renders a turn from the events it reads off the ChannelContext
// (runStream, resumeStream) or is handed (deliver, deliverResume), and posts through
// post(). It has no hook for the text it is about to send, so the guard sits on those
// public seams: the context the channel is given is wrapped, and so are its own methods.
// What reaches Slack from a turn:
//   message.delta     the streamed reply, and with intermediateText "status" the task
//                     timeline's notes: guarded as a stream (a mention may be split)
//   message.completed / turn.completed   the text posted when nothing was streamed
//   input.requested   the Approve/Deny card's prompt (a pull request's title)
// Task titles come from app.ts's `tasks`, which guards its own labels.

import type { Channel, ChannelContext, PostContent } from "@junejs/core/agent-config";
import type { TurnEvent } from "@junejs/core/agent-runtime";
import { mentionedUserIds, mentionStream, neutralizeMentions } from "./mentions";

type Names = (ids: string[]) => Promise<Map<string, { short: string }>>;

// Events between which a turn's text carries on (and may close a held `<`).
const CONTINUES = new Set<TurnEvent["type"]>(["turn.started", "action.requested", "action.completed", "reasoning.delta"]);

export function mentionGuard(names: Names = async () => new Map()) {
  const text = async (s: string): Promise<string> => {
    const ids = mentionedUserIds(s);
    const known = ids.length ? await names(ids).catch(() => new Map<string, { short: string }>()) : new Map<string, { short: string }>();
    return neutralizeMentions(s, (id) => known.get(id)?.short);
  };

  async function* events(source: AsyncIterable<TurnEvent>): AsyncIterable<TurnEvent> {
    const stream = mentionStream(text);
    let last: TurnEvent | undefined;
    for await (const e of source) {
      if (e.type === "message.delta") {
        last = e;
        const out = await stream.push(e.text);
        if (out) yield { ...e, text: out };
        continue;
      }
      // A held "<!chan" stays held across a tool call: the text after it may land in the
      // same Slack message and close it. Only an event that ends the text lets it go.
      if (CONTINUES.has(e.type)) {
        yield e.type === "reasoning.delta" ? { ...e, text: await text(e.text) } : e;
        continue;
      }
      const held = await stream.flush();
      if (held && last?.type === "message.delta") yield { ...last, text: held };
      if (e.type === "message.completed" || e.type === "turn.completed") yield { ...e, text: await text(e.text) };
      else if (e.type === "input.requested") yield { ...e, request: { ...e.request, prompt: await text(e.request.prompt) } };
      else yield e;
    }
    const held = await stream.flush();
    if (held && last?.type === "message.delta") yield { ...last, text: held };
  }

  async function post(content: PostContent): Promise<PostContent> {
    if (typeof content === "string") return text(content);
    return { ...content, ...(content.text !== undefined ? { text: await text(content.text) } : {}), ...(content.blocks ? { blocks: await deep(content.blocks) as unknown[] } : {}) };
  }

  // Every `text` string in a Block Kit structure, at any depth (a section's, a context
  // element's, a button label's). Ids, button values and URLs are left as they are.
  async function deep(v: unknown): Promise<unknown> {
    if (Array.isArray(v)) return Promise.all(v.map(deep));
    if (v && typeof v === "object") return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, k === "text" && typeof x === "string" ? await text(x) : await deep(x)])));
    return v;
  }

  function context(ctx: ChannelContext): ChannelContext {
    return {
      ...ctx,
      run: async (message, opts) => text(await ctx.run(message, opts)),
      ...(ctx.runStream ? { runStream: (message, opts) => events(ctx.runStream!(message, opts)) } : {}),
      ...(ctx.resumeStream ? { resumeStream: (opts) => events(ctx.resumeStream!(opts)) } : {}),
    };
  }

  return { text, events, post, context };
}

// The channel, with everything it sends to Slack guarded. Changes it in place (as
// withNamedPeople does), so a reference held to it posts guarded too.
export function withoutMentions<C extends Channel>(channel: C, names?: Names): C {
  const g = mentionGuard(names);
  // Bound: the originals still run as the channel's own methods.
  const deliver = channel.deliver?.bind(channel), deliverResume = channel.deliverResume?.bind(channel), post = channel.post?.bind(channel);
  const webhook = channel.webhook?.bind(channel), fetch = channel.fetch?.bind(channel);
  return Object.assign(channel, {
    ...(deliver ? { deliver: (target, evs, o) => deliver(target, g.events(evs), o) } satisfies Pick<Channel, "deliver"> : {}),
    ...(deliverResume ? { deliverResume: (target, evs, o) => deliverResume(target, g.events(evs), o) } satisfies Pick<Channel, "deliverResume"> : {}),
    ...(post ? { post: async (target, content) => post(target, await g.post(content)) } satisfies Pick<Channel, "post"> : {}),
    ...(webhook ? { webhook: (req, ctx) => webhook(req, g.context(ctx)) } satisfies Pick<Channel, "webhook"> : {}),
    ...(fetch ? { fetch: (ctx) => fetch(g.context(ctx)) } satisfies Pick<Channel, "fetch"> : {}),
  });
}
