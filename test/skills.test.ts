import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineAgent, buildSystemPrompt, parseSkill } from "@junejs/core/agent-config";
import type { Tool } from "@junejs/core/agent-runtime";
import { SKILLS } from "../src/prompts";

const SKILLS_DIR = join(import.meta.dir, "..", "prompts", "skills");
const skills = () => Object.entries(SKILLS).map(([name, text]) => parseSkill(name, text));

describe("skills", () => {
  test("SKILLS covers exactly the files in prompts/skills/, by basename", () => {
    const onDisk = readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
    expect(skills().map((s) => s.name).sort()).toEqual(onDisk);
  });

  test("every skill has a description and a when-to-use, so its frontmatter was read", () => {
    for (const s of skills()) {
      expect(s.description.length > 0 && !s.description.startsWith("---")).toBe(true);
      expect(s.whenToUse?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("read_skill returns channel-digest's body, and it's indexed in the system prompt", async () => {
    const agent = defineAgent({ name: "t", instructions: "x", skills: skills() });
    const readSkill = agent.tools.find((t) => t.spec.name === "read_skill") as Tool;
    expect(readSkill).toBeDefined();

    const body = readFileSync(join(SKILLS_DIR, "channel-digest.md"), "utf8").split("---\n").slice(2).join("---\n").trimStart();
    expect(body.startsWith("Report what the company")).toBe(true);

    expect(await readSkill.run({ name: "channel-digest" }, {} as never)).toEqual({ name: "channel-digest", body });
    expect(buildSystemPrompt(agent)).toContain("channel-digest: Summarize what has been discussed lately across the channels you read");
  });

  test("channel-digest sets no minimum number of topics, and says when there are few", () => {
    // One or two matching threads can't honestly make three topics; a minimum forces the
    // model to invent or split one. Whitespace is collapsed so a wrapped line can't hide it.
    const text = SKILLS["channel-digest"]!.replace(/\s+/g, " ");
    const atLeast2 = String.raw`(?:[2-9]|\d{2,}|two|three|four|five|six)`;
    const n = String.raw`(?:\d+|one|two|three|four|five|six)`;
    expect(text).not.toMatch(new RegExp(String.raw`\b(?:at least|a minimum of|no fewer than|minimum) ${atLeast2} topics?\b`, "i"));
    expect(text).not.toMatch(new RegExp(String.raw`\b${atLeast2} ?(?:to|-|–) ?${n} topics?\b`, "i"));
    expect(text).not.toMatch(new RegExp(String.raw`\b${atLeast2}\+? or more topics?\b`, "i"));
    expect(text).toContain("say plainly that the period held few topics");
  });

  test("channel-digest reads \"this week\" as a calendar week, not a `days` window", () => {
    // "this week" asked on a Monday is one day old; `days: 7` would reach into last week.
    const text = SKILLS["channel-digest"]!.replace(/\s+/g, " ");
    const rolling = /counted back from today \(([^)]*)\)/.exec(text)?.[1];
    const calendar = /For a calendar period \(([^)]*)\)/.exec(text)?.[1];
    expect(rolling).toBeDefined();
    expect(rolling).not.toMatch(/this week/i);
    expect(calendar).toMatch(/this week/i);
  });
});
