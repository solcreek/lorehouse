// slack-names.ts — the Slack channel's own people tools, naming people the one way
// knowledge does ("hkato (Hana Kato)").
//
// June's slack_read_thread returns each reply's author as a bare user id. Holding an id
// it can't name while the search results beside it name people, a model guesses, and
// guessed wrong: it credited hkato's message to "Marco (hkato)". So the reply now
// carries `author`, and mentions in the text read as @names, not <@U…>.
//
// slack_resolve_user stays: the question itself arrives as Slack's raw text, so a person
// it mentions is a <@U…> the model has to look up. June returns three names for one
// person (handle, display name, real name); it now returns the one name used elsewhere.

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

export function namedUserTool(tool: Tool, names: Names): Tool {
  return {
    ...tool,
    spec: {
      ...tool.spec,
      description:
        "Look up who a Slack user id is (e.g. a <@U…> mention in the question); defaults to the person who asked. Returns their name, written the way knowledge writes it.",
    },
    run: async (input, ctx) => {
      const r = (await tool.run(input, ctx)) as { id?: string; error?: unknown } | undefined;
      if (!r?.id || r.error) return r; // an error or no target: pass it through
      const known = (await names([r.id])).get(r.id);
      return known ? { id: r.id, name: known.full } : r; // unnamed here (no users:read): June's answer as is
    },
  };
}

// Swap the channel's people tools for the named ones; its other tools are unchanged.
export function withNamedPeople<C extends { tools?: () => Tool[] }>(channel: C, names: Names): C {
  const tools = channel.tools;
  if (!tools) return channel;
  const named: Record<string, (t: Tool, n: Names) => Tool> = { slack_read_thread: namedThreadTool, slack_resolve_user: namedUserTool };
  return Object.assign(channel, {
    tools: () => tools().map((t) => named[t.spec.name]?.(t, names) ?? t),
  });
}
