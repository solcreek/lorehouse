// slack-names.ts — the Slack channel's own thread tool, with people named.
//
// June's slack_read_thread returns each reply's author as a bare user id. Holding an id
// it can't name while the search results beside it name people, a model guesses, and
// guessed wrong: it credited hkato's message to "Marco (hkato)". So the reply now
// carries `author`, named the way knowledge names speakers ("hkato (Hana Kato)"),
// and mentions in the text read as @names, not <@U…>.

import type { Tool } from "@junejs/core/agent-runtime";
import { cleanSlackText, userIdsIn } from "../ingest/slack";
import type { PersonName } from "../ingest/slack-users";

type Names = (ids: string[]) => Promise<Map<string, PersonName>>;
type Reply = { user?: string; text?: string; ts: string };

export function namedThreadTool(tool: Tool, names: Names): Tool {
  return {
    ...tool,
    spec: {
      ...tool.spec,
      description:
        "Read the replies in a Slack thread (defaults to the current thread). Returns each reply's author (the person who wrote it), their user id, the text (mentions shown as @name), and ts.",
    },
    run: async (input, ctx) => {
      const r = (await tool.run(input, ctx)) as { messages?: Reply[] } | undefined;
      if (!r?.messages) return r; // an error or no target: pass it through
      const known = await names(userIdsIn(r.messages));
      return {
        messages: r.messages.map((m) => ({
          author: m.user ? (known.get(m.user)?.full ?? m.user) : "unknown",
          user: m.user,
          text: m.text === undefined ? undefined : cleanSlackText(m.text, known),
          ts: m.ts,
        })),
      };
    },
  };
}

// Swap the channel's slack_read_thread for the named one; its other tools are unchanged.
export function withNamedThreads<C extends { tools?: () => Tool[] }>(channel: C, names: Names): C {
  const tools = channel.tools;
  if (!tools) return channel;
  return Object.assign(channel, {
    tools: () => tools().map((t) => (t.spec.name === "slack_read_thread" ? namedThreadTool(t, names) : t)),
  });
}
