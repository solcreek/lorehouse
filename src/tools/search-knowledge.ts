import type { Tool } from "@junejs/core/agent-runtime";
import type { Chunk } from "../knowledge";
import { toolDescription } from "../prompts";

// Returns the top hits as a JSON string: [{ id, title, source, text (first 500 chars) }].
// A string passes through the model adapter verbatim.
export function searchKnowledgeTool(search: (q: string) => Chunk[]): Tool {
  return {
    spec: {
      name: "search_knowledge",
      description: toolDescription("search_knowledge"),
      input: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
    run: (input: { query?: string }) =>
      JSON.stringify(search(String(input?.query ?? "")).map((c) => ({ ...c, text: c.text.slice(0, 500) }))),
  };
}
