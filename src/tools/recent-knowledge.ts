import type { Tool } from "@junejs/core/agent-runtime";
import type { Chunk } from "../knowledge";
import { toolDescription } from "../prompts";

type Recent = (opts: { limit: number; sinceSec?: number }) => (Chunk & { activeAt: string })[];

// The most recently active threads, newest first, whenever they were, as a JSON string:
// [{ id, title, source, activeAt, text (first 500 chars) }]. For overview questions
// ("what's been discussed lately?") that keyword search can't answer.
export function recentKnowledgeTool(recent: Recent, now: () => number = Date.now): Tool {
  return {
    spec: {
      name: "recent_knowledge",
      description: toolDescription("recent_knowledge"),
      input: {
        type: "object",
        properties: {
          days: { type: "number", description: "only threads active in the last N days; omit for the newest threads whenever they were (a quiet channel's latest may be weeks old)" },
          limit: { type: "number", description: "how many threads, newest first (default 15, max 30)" },
        },
      },
    },
    run: (input: { days?: number; limit?: number }) => {
      // No default window: "recent" is relative to the channel's own activity, and a fixed
      // window returns nothing for a channel that has been quiet for a few weeks.
      const limit = Math.min(Math.max(Math.floor(input?.limit ?? 15), 1), 30);
      const sinceSec = input?.days && input.days > 0 ? now() / 1000 - input.days * 86400 : undefined;
      const hits = recent({ limit, sinceSec });
      return JSON.stringify(hits.map((c) => ({ id: c.id, title: c.title, source: c.source, activeAt: c.activeAt, text: c.text.slice(0, 500) })));
    },
  };
}
