import type { Tool, ToolContext } from "@junejs/core/agent-runtime";
import type { Chunk } from "../knowledge";
import { toolDescription } from "../prompts";

// Returns the top hits as a JSON string: [{ id, title, source, text (first 500 chars) }].
// A string passes through the model adapter verbatim. `onSearch` hears every query and
// how many hits it got (usage: which searches came back empty).
export function searchKnowledgeTool(search: (q: string) => Chunk[], onSearch?: (query: string, hits: number, ctx: ToolContext) => void): Tool {
  return {
    spec: {
      name: "search_knowledge",
      description: toolDescription("search_knowledge"),
      input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    run: (input: { query?: string }, ctx: ToolContext) => {
      const query = String(input?.query ?? "");
      const hits = search(query);
      onSearch?.(query, hits.length, ctx);
      return JSON.stringify(hits.map((c) => ({ ...c, text: c.text.slice(0, 500) })));
    },
  };
}
