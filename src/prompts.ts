// prompts.ts — the agent's words live in /prompts as plain Markdown, shared by any
// implementation. Imported as text so `bun build --compile` embeds them in the binary.
//
// Templates use {{placeholder}}; an unknown placeholder is an error, not a silent blank.

import system from "../prompts/system.md" with { type: "text" };
import searchKnowledge from "../prompts/tools/search_knowledge.md" with { type: "text" };
import workspaceExec from "../prompts/tools/workspace_exec.md" with { type: "text" };
import workspaceReadFile from "../prompts/tools/workspace_read_file.md" with { type: "text" };
import workspaceWriteFile from "../prompts/tools/workspace_write_file.md" with { type: "text" };
import openPullRequest from "../prompts/tools/open_pull_request.md" with { type: "text" };
import { branchPrefix, displayName, type AgentIdentity } from "./identity";

const TOOLS: Record<string, string> = {
  search_knowledge: searchKnowledge,
  workspace_exec: workspaceExec,
  workspace_read_file: workspaceReadFile,
  workspace_write_file: workspaceWriteFile,
  open_pull_request: openPullRequest,
};

export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in vars)) throw new Error(`prompt placeholder {{${key}}} has no value`);
    return vars[key]!;
  }).trim();
}

export function systemPrompt(id: AgentIdentity): string {
  return render(system, {
    display_name: displayName(id),
    branch_prefix: branchPrefix(id),
    co_author_line: id.coAuthor ? ` End it with the trailer "Co-authored-by: ${id.coAuthor}".` : "",
  });
}

export function toolDescription(name: string, vars: Record<string, string> = {}): string {
  const template = TOOLS[name];
  if (!template) throw new Error(`no prompt file for tool "${name}"`);
  return render(template, vars);
}
