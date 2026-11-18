// Profiles (src/profiles.ts, ADR 0002): the type, the `lorehouse` profile, what a wrong
// profile is told on start, and how a profile's names become an agent's tools and skills.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentIdentity } from "../src/identity";
import { activeTriggers, loadProfiles, LOREHOUSE, PROFILES, profileStatus, ProfileError, selectByName, slackTrigger, type Profile } from "../src/profiles";
import { profilePrompt, PROMPT_CATALOG } from "../src/prompts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const CATALOG = { prompts: ["lorehouse", "review"], tools: ["search_knowledge", "workspace_exec", "open_pull_request"], skills: ["channel-digest"] };
const valid: Profile = { id: "lorehouse", mode: "interactive", prompt: "lorehouse", tools: ["search_knowledge"], skills: [], triggers: [{ kind: "slack", events: ["mention"] }], sandbox: "none" };

// The problems loadProfiles reports for `profiles`, or [] when it accepts them.
function problems(...profiles: unknown[]): string[] {
  try {
    loadProfiles(profiles, CATALOG);
    return [];
  } catch (err) {
    if (!(err instanceof ProfileError)) throw err;
    return err.problems;
  }
}

describe("the lorehouse profile", () => {
  test("is the only profile, and passes the checks against the real catalog", () => {
    expect(loadProfiles()).toEqual([LOREHOUSE]);
    expect(PROFILES).toEqual([LOREHOUSE]);
  });

  test("keeps the id sessions are already stored under, and is started by Slack", () => {
    expect(LOREHOUSE.id).toBe("lorehouse");
    expect(LOREHOUSE.mode).toBe("interactive");
    expect(slackTrigger(LOREHOUSE)).toEqual({ kind: "slack", events: ["mention", "follow_up", "direct_message"] });
  });

  test("lists every tool and skill there is: it narrows nothing today's agent had", () => {
    expect([...LOREHOUSE.tools].sort()).toEqual([...PROMPT_CATALOG.tools].sort());
    expect([...LOREHOUSE.skills].sort()).toEqual([...PROMPT_CATALOG.skills].sort());
  });

  // The rendered prompt, pinned by the SHA-256 of each rendering: a change to what the
  // model is told is made on purpose, with these updated in the same commit. Until #126
  // they were, byte for byte, what prompts/system.md rendered to on main before it became
  // this profile's (#39). #126 changed one step, "Working in code" 1: with no repo named in
  // the request, workspace_clone is called without one, for the channel's default repo.
  test("its prompt renders to the pinned bytes", () => {
    const rendered = (name?: string, coAuthor?: string) => sha256(profilePrompt(LOREHOUSE.prompt, agentIdentity(name, coAuthor)));
    expect(rendered()).toBe("e525ca1ee8ab13ff26fbb1bec3cafe599801e3635d577d3d741c4b2daa7852e3");
    expect(rendered("scout", "Scout <scout@example.com>")).toBe("29bb23817a9533d22d111ab3a8b7009cc96c23051e5ca2efbef8ace6d97ad515");
    expect(rendered("atlas")).toBe("593323e04ce07ef0c7fd281e3bba96aba15663399c3df59ec4a0c686bdd04d65");
    expect(sha256(readFileSync(join(import.meta.dir, "..", "prompts", "profiles", "lorehouse.md"), "utf8"))).toBe("c87020353a7eacb01ffdf5a10ebbafb3883051c5191c181fb060fe07b037d9b0");
  });

  test("every file in prompts/profiles/ is registered, and every profile's prompt is a file there", () => {
    const onDisk = readdirSync(join(import.meta.dir, "..", "prompts", "profiles")).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")).sort();
    expect([...PROMPT_CATALOG.prompts].sort()).toEqual(onDisk);
    expect(() => profilePrompt("no-such-profile", agentIdentity())).toThrow(/no prompt file for profile "no-such-profile"/);
  });
});

describe("June stays in src/app.ts (ADR 0001, ADR 0002 §1)", () => {
  const SRC = join(import.meta.dir, "..", "src");
  const read = (file: string) => readFileSync(join(SRC, file), "utf8");

  test("src/profiles.ts imports nothing from June, not even a type", () => {
    expect(read("profiles.ts")).not.toMatch(/from\s*["']@junejs\//);
  });

  // The agent framework is @junejs/core and @junejs/server. The tools and guards take
  // June's types (Tool, Channel), which is not wiring; a value import (defineAgent, a
  // runtime, a channel) is. @junejs/pdf* is the PDF renderer, a library the render_pdf
  // tool calls, not the framework.
  test("only src/app.ts wires June: every other file in src/ imports types alone from @junejs/core and @junejs/server", () => {
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.ts$/.test(f) && f !== "app.ts");
    const wires = (text: string) =>
      /\bimport\s+(?!type\s)[^;"']*from\s*["']@junejs\/(?:core|server)\b/.test(text) || /\b(?:import|require)\(\s*["']@junejs\/(?:core|server)\b/.test(text);
    expect(files.filter((f) => wires(read(f)))).toEqual([]);
    // The check sees what it is for: app.ts is where the wiring is.
    expect(wires(read("app.ts"))).toBe(true);
    expect(wires('import {\n  defineAgent,\n} from "@junejs/core/agent-config";')).toBe(true);
    expect(wires('import type { Tool } from "@junejs/core/agent-runtime";\nimport { x } from "./y";')).toBe(false);
  });
});

describe("a profile is checked on start", () => {
  test("a valid one is returned as it is", () => {
    expect(loadProfiles([valid], CATALOG)).toEqual([valid]);
  });

  test("the id is a lowercase handle of at most 32 characters, and names one profile", () => {
    for (const id of ["Lorehouse", "1st", "has_underscore", "has.dot", "", "a".repeat(33), 7, undefined]) {
      expect(problems({ ...valid, id }), String(id)).toEqual([expect.stringMatching(/^profile #0: id: must match \^\[a-z\]\[a-z0-9-\]\{0,31\}\$ .*, got /)]);
    }
    expect(problems({ ...valid, id: "a".repeat(32) })).toEqual([]);
    expect(problems(valid, { ...valid, mode: "job", triggers: [] })).toEqual(['profile "lorehouse": id is used by more than one profile; each id names its own sessions']);
  });

  test("mode, prompt and sandbox each say what they allow", () => {
    expect(problems({ ...valid, mode: "batch" })).toContain('profile "lorehouse": mode: must be one of interactive, automation, job, got "batch"');
    expect(problems({ ...valid, prompt: "system" })).toEqual(['profile "lorehouse": prompt: must be one of lorehouse, review, got "system"']);
    expect(problems({ ...valid, sandbox: "rw" })).toEqual(['profile "lorehouse": sandbox: must be one of none, read, write, got "rw"']);
    const { sandbox: _, ...without } = valid;
    expect(problems(without)).toEqual(['profile "lorehouse": sandbox: must be one of none, read, write, got nothing']);
  });

  test("a tool or skill that doesn't exist, or is listed twice, is named with what does exist", () => {
    expect(problems({ ...valid, tools: ["search_knowledge", "delete_everything"] })).toEqual(['profile "lorehouse": tools: "delete_everything" is not a tool (allowed: search_knowledge, workspace_exec, open_pull_request)']);
    expect(problems({ ...valid, tools: ["search_knowledge", "search_knowledge"] })).toEqual(['profile "lorehouse": tools: "search_knowledge" is listed twice']);
    expect(problems({ ...valid, skills: ["pdf-report"] })).toEqual(['profile "lorehouse": skills: "pdf-report" is not a skill (allowed: channel-digest)']);
    expect(problems({ ...valid, tools: "search_knowledge" })).toEqual(['profile "lorehouse": tools: must be a list of a tool, got "search_knowledge"']);
  });

  test("a trigger is tagged by a kind that exists, and a Slack one names its events", () => {
    expect(problems({ ...valid, triggers: [{ kind: "webhook", provider: "github" }] })).toContain('profile "lorehouse": triggers[0].kind: must be one of slack, got "webhook"');
    expect(problems({ ...valid, triggers: [{ kind: "slack", events: ["reaction"] }] })).toEqual(['profile "lorehouse": triggers[0].events: "reaction" is not a Slack trigger event (allowed: mention, follow_up, direct_message)']);
    expect(problems({ ...valid, triggers: [{ kind: "slack", events: [] }] })).toEqual(['profile "lorehouse": triggers[0].events: must name at least one of mention, follow_up, direct_message']);
    expect(problems({ ...valid, triggers: [{ kind: "slack", events: ["mention"], channel: "C1" }] })).toEqual(['profile "lorehouse": triggers[0].channel: is not a field of a slack trigger (allowed: kind, events)']);
    expect(problems({ ...valid, triggers: "slack" })).toContain('profile "lorehouse": triggers: must be a list of triggers, got "slack"');
  });

  test("Slack starts the interactive profile and no other (ADR 0002 §2): exactly one profile has a slack trigger", () => {
    expect(problems({ ...valid, triggers: [] })).toContain('profile "lorehouse": triggers: an interactive profile needs a trigger of kind "slack"');
    expect(problems(valid, { ...valid, id: "review", mode: "automation" })).toContain('profile "review": triggers: a trigger of kind "slack" is for mode interactive, not automation');
    expect(problems(valid, { ...valid, id: "second" })).toEqual(['triggers: exactly one profile may have a trigger of kind "slack" (ADR 0002 §2), found "lorehouse", "second"']);
    expect(problems({ ...valid, id: "digest", mode: "job", triggers: [] })).toEqual(['triggers: exactly one profile may have a trigger of kind "slack" (ADR 0002 §2), found none']);
    // A second profile is one more object: an automation beside the interactive one.
    expect(problems(valid, { ...valid, id: "review", mode: "automation", prompt: "review", triggers: [] })).toEqual([]);
  });

  test("only a write sandbox may open a pull request, and the workspace tools need a sandbox (ADR 0002 §1)", () => {
    expect(problems({ ...valid, tools: ["open_pull_request"], sandbox: "read" })).toEqual(['profile "lorehouse": sandbox: must be write for the tool open_pull_request, got "read"']);
    expect(problems({ ...valid, tools: ["workspace_exec"], sandbox: "none" })).toEqual(['profile "lorehouse": sandbox: must be read or write for the tool workspace_exec, got "none"']);
    expect(problems({ ...valid, tools: ["workspace_exec"], sandbox: "read" })).toEqual([]);
    expect(problems({ ...valid, tools: ["workspace_exec", "open_pull_request"], sandbox: "write" })).toEqual([]);
  });

  test("a field nothing honors yet is refused, not ignored; so is one that isn't a profile's", () => {
    for (const field of ["delivery", "credentials", "knowledge", "model"]) {
      expect(problems({ ...valid, [field]: "x" }), field).toEqual([`profile "lorehouse": ${field}: is in ADR 0002 §1 but not supported yet: nothing would honor it`]);
    }
    expect(problems({ ...valid, instructions: "be brief" })).toEqual(['profile "lorehouse": instructions: is not a profile field (allowed: id, mode, prompt, tools, skills, triggers, sandbox)']);
    expect(problems("lorehouse")).toEqual(["profile #0: must be an object with id, mode, prompt, tools, skills, triggers, sandbox"]);
  });

  test("every problem is reported at once, in one error that names each profile and field", () => {
    const found = problems({ ...valid, mode: "batch", sandbox: "rw" }, { ...valid, id: "Review" });
    expect(found).toHaveLength(3);
    let message = "";
    try {
      loadProfiles([{ ...valid, mode: "batch" }], CATALOG);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toStartWith('lorehouse: invalid profile: profile "lorehouse": mode: must be one of');
  });
});

describe("a profile becomes an agent's tools and skills", () => {
  const tool = (name: string) => ({ spec: { name } });
  const built = (...names: string[]) => new Map(names.map((n) => [n, tool(n)]));

  test("its names pick from what the install has on, in the profile's order", () => {
    const on = built("recent_knowledge", "render_pdf", "search_knowledge");
    expect(selectByName(["search_knowledge", "recent_knowledge", "render_pdf"], on).map((t) => t.spec.name)).toEqual(["search_knowledge", "recent_knowledge", "render_pdf"]);
  });

  test("a tool whose feature is off is left out; one the profile doesn't list is never given", () => {
    const on = built("search_knowledge", "recent_knowledge");
    expect(selectByName(LOREHOUSE.tools, on).map((t) => t.spec.name)).toEqual(["search_knowledge", "recent_knowledge"]);
    expect(selectByName(["search_knowledge"], built("search_knowledge", "open_pull_request")).map((t) => t.spec.name)).toEqual(["search_knowledge"]);
    expect(selectByName([], on)).toEqual([]);
  });

  test("with everything on, the lorehouse profile's tools and skills come in the order the model had them", () => {
    expect(selectByName(LOREHOUSE.tools, built(...PROMPT_CATALOG.tools)).map((t) => t.spec.name)).toEqual([
      "search_knowledge", "recent_knowledge",
      "workspace_exec", "workspace_read_file", "workspace_write_file", "workspace_attach_file",
      "workspace_job_start", "workspace_job_status", "workspace_job_cancel",
      "workspace_clone", "open_pull_request", "render_pdf",
    ]);
    expect(selectByName(LOREHOUSE.skills, new Map(PROMPT_CATALOG.skills.map((s) => [s, s])))).toEqual(["channel-digest", "write-a-skill", "pdf-report"]);
  });
});

describe("a profile as /status lists it", () => {
  test("id, mode and the triggers in force: a DM starts a turn only under DM_MODE=answer", () => {
    expect(profileStatus(LOREHOUSE, { dm: "redirect" })).toEqual({ id: "lorehouse", mode: "interactive", triggers: [{ kind: "slack", events: ["mention", "follow_up"] }] });
    expect(activeTriggers(LOREHOUSE, { dm: "ignore" })).toEqual([{ kind: "slack", events: ["mention", "follow_up"] }]);
    expect(activeTriggers(LOREHOUSE, { dm: "answer" })).toEqual([{ kind: "slack", events: ["mention", "follow_up", "direct_message"] }]);
  });

  test("it carries nothing else of the profile: no prompt, tools or skills", () => {
    expect(Object.keys(profileStatus(LOREHOUSE, { dm: "answer" }))).toEqual(["id", "mode", "triggers"]);
    expect(LOREHOUSE.triggers[0]!.events).toHaveLength(3); // the profile itself is not narrowed
  });
});
