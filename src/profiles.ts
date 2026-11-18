// profiles.ts — a profile is one agent on the platform (ADR 0002): a prompt, the tools and
// skills it gets, what starts its turns and what it may do in a sandbox. It is plain data:
// this file knows nothing of June, and src/app.ts alone turns each profile into an agent.
//
// Adding a profile: write prompts/profiles/<name>.md and register it in src/prompts.ts,
// add an object to PROFILES below, and give it its own conformance scenarios. Every
// profile is checked on start (loadProfiles): a wrong one stops the start, naming the
// field and what it allows. The rules no profile can change are ADR 0002 §6.

import type { DmMode } from "./config";
import { PROMPT_CATALOG } from "./prompts";
import { resourceProblems, type SandboxResources } from "./sandbox-resources";

// How a profile's turns start, and what its sessions are (ADR 0002 §3):
//   interactive  a person: a mention, then follow-ups in the thread; one session per thread
//   automation   an outside event (a webhook); one durable session per subject
//   job          a schedule or a command; short-lived, the result is posted
export const PROFILE_MODES = ["interactive", "automation", "job"] as const;
export type ProfileMode = (typeof PROFILE_MODES)[number];

// What a profile may do in a sandbox (ADR 0002 §1: `none`, `read` or `write`; only `write`
// may open a pull request):
//   none   no sandbox: it may list none of the code tools (workspace_*, open_pull_request)
//   write  today's sandbox: it may list them all
//   read   in the ADR and in this type, but refused by loadProfiles for now: nothing would
//          keep its sandbox read-only (the workspace tools write, and a clone takes
//          credentials). It is accepted once something enforces it.
export const PROFILE_SANDBOXES = ["none", "read", "write"] as const;
export type ProfileSandbox = (typeof PROFILE_SANDBOXES)[number];
const SUPPORTED_SANDBOXES = ["none", "write"];
// The tools that run in, or publish from, a sandbox.
const isCodeTool = (tool: string) => tool.startsWith("workspace_") || tool === "open_pull_request";

// The Slack messages that start a turn:
//   mention         an @-mention in a listed public channel; it also asks the agent into
//                   the thread. Every Slack trigger lists it (loadProfiles): the other two
//                   mean nothing without it
//   follow_up       a reply in a thread the agent was mentioned in (src/threads.ts)
// src/turns.ts decides each event by them (turnGate's `startsOn`).
//   direct_message  a DM, and only while the install answers them (DM_MODE=answer): a
//                   profile may ask for DMs, it can't turn them on (ADR 0002 §6)
export const SLACK_TRIGGER_EVENTS = ["mention", "follow_up", "direct_message"] as const;
export type SlackTriggerEvent = (typeof SLACK_TRIGGER_EVENTS)[number];

// What starts a turn, tagged by `kind`. Only Slack exists yet; a webhook and a schedule
// (ADR 0002 §1) are further members of this union, each with its own fields.
export type ProfileTrigger = { readonly kind: "slack"; readonly events: readonly SlackTriggerEvent[] };
export const TRIGGER_KINDS = ["slack"] as const;

// Read-only: a loaded profile is frozen (loadProfiles), so nothing changes one after the check.
export type Profile = {
  // The durable agent id: names its sessions and, later, its sandboxes. Never the display
  // name, and never changed once sessions exist under it.
  readonly id: string;
  readonly mode: ProfileMode;
  // Its system prompt: the name of a file in prompts/profiles/, as registered in src/prompts.ts.
  readonly prompt: string;
  // Lorehouse's tools it may call, by name, in the order the model sees them. One whose
  // feature the install has off (no sandbox, PDF_REPLIES unset) is left out, not an error.
  readonly tools: readonly string[];
  // The skills in its index, by name, in order; likewise left out while their feature is off.
  readonly skills: readonly string[];
  readonly triggers: readonly ProfileTrigger[];
  readonly sandbox: ProfileSandbox;
  // What it asks for its sandbox (#109): vCPUs, memory, disk, pids and how long any one
  // command may run there (commandTimeoutSecs: workspace_exec, and the clone, fetch and git
  // commands the other tools run; background jobs keep their own limits), each optional. A
  // request, not a setting: the sandbox host grants it within its own maxima or refuses
  // the call with a reason, and never clamps it (ADR 0003; src/sandbox-resources.ts). Left
  // out, the sandbox gets the host's defaults. Adding or changing it reaches a thread's
  // existing sandbox at its VM's next boot, after its idle stop; until then calls there
  // are refused, saying so. A field
  // beside `sandbox`, not inside it: `sandbox` stays the one word that says what the
  // profile may do there (ADR 0002 §1), and this says how big "there" is. Only for a
  // profile with a sandbox, and only the Slack-started one for now (loadProfiles).
  readonly sandboxResources?: SandboxResources;
  // ADR 0002 §1 also gives a profile `delivery`, `credentials`, `knowledge` and `model`.
  // Nothing reads them yet, so they are not fields yet (PENDING_FIELDS): a profile that
  // sets one is refused, not silently ignored. Each arrives with the code that honors it.
};

const FIELDS = ["id", "mode", "prompt", "tools", "skills", "triggers", "sandbox", "sandboxResources"] as const;
// What every profile must have; the rest of FIELDS may be left out.
const REQUIRED_FIELDS = FIELDS.filter((f) => f !== "sandboxResources");
const PENDING_FIELDS = ["delivery", "credentials", "knowledge", "model"];

// Like the agent name, so it is valid in a sandbox id as is (ADR 0002 §1).
export const PROFILE_ID = /^[a-z][a-z0-9-]{0,31}$/;

// Today's agent, as the first profile. Its id stays `lorehouse`, so no session kept under
// it is orphaned. The code tools and render_pdf are listed and are on only where the
// install has a sandbox or PDF replies; DMs start a turn only under DM_MODE=answer.
export const LOREHOUSE: Profile = {
  id: "lorehouse",
  mode: "interactive",
  prompt: "lorehouse",
  tools: [
    "search_knowledge",
    "recent_knowledge",
    "workspace_exec",
    "workspace_read_file",
    "workspace_write_file",
    "workspace_attach_file",
    "workspace_job_start",
    "workspace_job_status",
    "workspace_job_cancel",
    "workspace_clone",
    "open_pull_request",
    "render_pdf",
  ],
  skills: ["channel-digest", "write-a-skill", "pdf-report"],
  triggers: [{ kind: "slack", events: ["mention", "follow_up", "direct_message"] }],
  sandbox: "write",
};

// Every profile this build runs. The first profiles are code (ADR 0002, Deferred).
export const PROFILES: readonly Profile[] = [LOREHOUSE];

// What a profile's names are checked against: the prompts, tools and skills that exist.
export type ProfileCatalog = { prompts: readonly string[]; tools: readonly string[]; skills: readonly string[] };

// Every problem with the profiles, one per entry, each naming the profile and the field.
export class ProfileError extends Error {
  constructor(readonly problems: string[]) {
    super(`lorehouse: invalid profile${problems.length === 1 ? "" : "s"}: ${problems.join("; ")}`);
  }
}

// The profiles to run (this build's, unless given), checked. Each is copied first, as plain
// data (structuredClone: a getter is read once, and only an object's own fields come
// along), then the copy is checked, frozen and returned: what was checked is what runs,
// whatever the caller's object is or does after. Throws a ProfileError listing every problem.
export function loadProfiles(profiles: unknown = PROFILES, catalog: ProfileCatalog = PROMPT_CATALOG): readonly Profile[] {
  if (!Array.isArray(profiles)) throw new ProfileError([`profiles: must be a list of profiles, got ${show(profiles)}`]);
  const problems: string[] = [];
  const checked: (Profile | undefined)[] = [];
  for (let i = 0; i < profiles.length; i++) {
    // A hole is not a profile left out on purpose: say so, as for any other entry.
    if (!(i in profiles)) {
      problems.push(`profile #${i}: is missing: the list has a hole there`);
      checked.push(undefined);
      continue;
    }
    let copy: unknown;
    try {
      copy = structuredClone(profiles[i]);
    } catch (err) {
      problems.push(`${nameOf(profiles[i], i)}: must be plain data, and can't be copied: ${err instanceof Error ? err.message : String(err)}`);
      checked.push(undefined);
      continue;
    }
    checked.push(checkProfile(copy, i, catalog, problems));
  }
  const ok = checked.filter((p): p is Profile => p !== undefined);

  const seen = new Set<string>();
  for (const p of ok) {
    if (seen.has(p.id)) problems.push(`profile "${p.id}": id is used by more than one profile; each id names its own sessions`);
    seen.add(p.id);
  }
  // ADR 0002 §2: people see one agent in Slack, so at most one profile is started by Slack
  // messages. This build asks for more than the ADR does: there must be one, for now,
  // because the Slack channel that profile brings is also how Lorehouse receives the events
  // it indexes, and how anything is posted.
  const bySlack = ok.filter((p) => slackTrigger(p)).map((p) => `"${p.id}"`);
  if (ok.length === checked.length) {
    if (bySlack.length > 1) problems.push(`triggers: at most one profile may have a trigger of kind "slack" (ADR 0002 §2), found ${bySlack.join(", ")}`);
    if (bySlack.length === 0) problems.push('triggers: one profile must have a trigger of kind "slack", for now (this build\'s rule, not the ADR\'s): the Slack channel it brings also carries ingest and posting; found none');
  }
  if (problems.length) throw new ProfileError(problems);
  return Object.freeze(ok);
}

// How a problem names the profile it is about: by its id when it has a valid one (read
// defensively: reading it may throw), else by its place in the list.
function nameOf(profile: unknown, index: number): string {
  try {
    const id = isRecord(profile) ? profile.id : undefined;
    if (typeof id === "string" && PROFILE_ID.test(id)) return `profile "${id}"`;
  } catch {
    // by its place, then
  }
  return `profile #${index}`;
}

// Checks one profile, already copied, and freezes it. `input` is the copy that is returned.
function checkProfile(input: unknown, index: number, catalog: ProfileCatalog, problems: string[]): Profile | undefined {
  if (!isRecord(input)) {
    problems.push(`profile #${index}: must be an object with ${REQUIRED_FIELDS.join(", ")}`);
    return undefined;
  }
  const who = nameOf(input, index);
  const before = problems.length;
  const bad = (field: string, problem: string) => void problems.push(`${who}: ${field}: ${problem}`);
  const oneOf = (field: string, allowed: readonly string[]) => {
    const v = input[field];
    if (typeof v !== "string" || !allowed.includes(v)) bad(field, `must be one of ${allowed.join(", ")}, got ${show(v)}`);
  };
  // A list of names from `allowed`, each once.
  const names = (field: string, v: unknown, allowed: readonly string[], what: string) => {
    if (!Array.isArray(v)) return bad(field, `must be a list of ${what}, got ${show(v)}`);
    const seen = new Set<unknown>();
    for (const name of v) {
      if (typeof name !== "string" || !allowed.includes(name)) bad(field, `${show(name)} is not ${what} (allowed: ${allowed.join(", ")})`);
      else if (seen.has(name)) bad(field, `${show(name)} is listed twice`);
      seen.add(name);
    }
  };

  for (const key of Object.keys(input)) {
    if ((FIELDS as readonly string[]).includes(key)) continue;
    bad(key, PENDING_FIELDS.includes(key) ? "is in ADR 0002 §1 but not supported yet: nothing would honor it" : `is not a profile field (allowed: ${FIELDS.join(", ")})`);
  }
  if (typeof input.id !== "string" || !PROFILE_ID.test(input.id)) bad("id", `must match ${PROFILE_ID.source} (a lowercase handle, at most 32 characters), got ${show(input.id)}`);
  oneOf("mode", PROFILE_MODES);
  oneOf("prompt", catalog.prompts);
  names("tools", input.tools, catalog.tools, "a tool");
  names("skills", input.skills, catalog.skills, "a skill");
  if (input.sandbox === "read") bad("sandbox", `"read" is in ADR 0002 §1 but not supported yet: nothing would keep the sandbox read-only (allowed for now: ${SUPPORTED_SANDBOXES.join(", ")})`);
  else oneOf("sandbox", SUPPORTED_SANDBOXES);

  if (!Array.isArray(input.triggers)) bad("triggers", `must be a list of triggers, got ${show(input.triggers)}`);
  else {
    // By index, every one: forEach would skip a hole, which the copy keeps, and leave it
    // unchecked (Array.from fills holes with undefined, which is then refused as no trigger).
    Array.from(input.triggers as unknown[]).forEach((t: unknown, i: number) => {
      const field = `triggers[${i}]`;
      if (!isRecord(t) || t.kind !== "slack") return bad(`${field}.kind`, `must be one of ${TRIGGER_KINDS.join(", ")}, got ${show(isRecord(t) ? t.kind : t)}`);
      for (const key of Object.keys(t)) if (key !== "kind" && key !== "events") bad(`${field}.${key}`, "is not a field of a slack trigger (allowed: kind, events)");
      names(`${field}.events`, t.events, SLACK_TRIGGER_EVENTS, "a Slack trigger event");
      if (Array.isArray(t.events) && !t.events.length) bad(`${field}.events`, `must name at least one of ${SLACK_TRIGGER_EVENTS.join(", ")}`);
      // Without a mention nothing starts in a channel: a follow-up is a reply in a thread a
      // mention opened, and a DM that isn't answered is pointed to a channel (DM_MODE=redirect).
      if (Array.isArray(t.events) && t.events.length && !t.events.includes("mention")) bad(`${field}.events`, 'must list "mention": a follow-up is a reply in a thread a mention opened, and a DM is pointed to a channel, where only a mention starts a turn');
    });
    const slack = input.triggers.filter((t: unknown) => isRecord(t) && t.kind === "slack").length;
    if (slack > 1) bad("triggers", `at most one trigger of kind "slack", found ${slack}`);
    // ADR 0002 §2 and §3: Slack messages start the interactive profile, and only it.
    if (input.mode === "interactive" && slack === 0) bad("triggers", 'an interactive profile needs a trigger of kind "slack"');
    if ((input.mode === "automation" || input.mode === "job") && slack > 0) bad("triggers", `a trigger of kind "slack" is for mode interactive, not ${input.mode}`);
    // An Approve is a click in Slack, and it reaches only the agent that has the Slack
    // channel: June resumes that agent's session and asks that agent's gate (src/app.ts
    // mounts no other). A card posted by any other profile would park in its own session,
    // and the click would resume the wrong one. So only the profile Slack starts may open a
    // pull request, until an approval can find the profile that asked for it.
    if (slack === 0 && Array.isArray(input.tools) && input.tools.includes("open_pull_request")) {
      bad("tools", '"open_pull_request" needs a trigger of kind "slack": an Approve click can only reach the profile Slack starts, for now');
    }
  }

  // The code tools need a sandbox, and the one kind there is yet is `write` (ADR 0002 §1:
  // only `write` may open a pull request). This is what honors `none`: such a profile gets
  // no code tool, since it can't list one.
  if (input.sandbox === "none" && Array.isArray(input.tools)) {
    const code = input.tools.filter((t: unknown): t is string => typeof t === "string" && isCodeTool(t));
    if (code.length) bad("sandbox", `must be write for the tool${code.length === 1 ? "" : "s"} ${code.join(", ")}, got "none"`);
  }
  // A request for resources: whole numbers within what any host could grant, only fields a
  // host honors, and only where something sends it. `none` has no sandbox to size. The
  // sandbox is built for the profile Slack starts (src/app.ts), so another profile's
  // request would reach no host: refused until its sandbox is its own (ADR 0002 §7).
  if ("sandboxResources" in input) {
    const at = "sandboxResources";
    if (input.sandboxResources === undefined) bad(at, "is set to nothing; leave the field out to get the sandbox host's defaults");
    else {
      for (const problem of resourceProblems(input.sandboxResources, at)) problems.push(`${who}: ${problem}`);
      if (input.sandbox === "none") bad(at, 'needs a sandbox: this profile\'s sandbox is "none", so nothing would be booted with them');
      else if (Array.isArray(input.triggers) && !input.triggers.some((t: unknown) => isRecord(t) && t.kind === "slack")) {
        bad(at, 'needs a trigger of kind "slack", for now: only the sandbox of the profile Slack starts is asked for with a request, so nothing would honor this one');
      }
    }
  }
  return problems.length === before ? deepFreeze(input as Profile) : undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
// A value as a problem quotes it. Total: whatever it is given (a bigint, a circular object,
// a symbol, an object whose toJSON throws), it returns a string and never throws.
export function show(v: unknown): string {
  if (v === undefined) return "nothing";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "function") return "a function";
  try {
    const json = JSON.stringify(v);
    if (json !== undefined) return json.length > 200 ? `${json.slice(0, 200)}…` : json;
  } catch {
    // circular, a bigint inside, a toJSON that throws: described by its kind below
  }
  try {
    return typeof v === "object" && v !== null ? `${Array.isArray(v) ? "a list" : "an object"} that can't be written as JSON` : String(v);
  } catch {
    return `a ${typeof v}`;
  }
}

// The profile's Slack trigger, if Slack messages start it.
export function slackTrigger(profile: Profile): Extract<ProfileTrigger, { kind: "slack" }> | undefined {
  return profile.triggers.find((t) => t.kind === "slack");
}

// What the profile names, out of what the install has on, in the profile's order: its tools
// from the tools this start built, its skills from the skills it parsed. A name the install
// has off is skipped; one that doesn't exist at all never got past loadProfiles.
export function selectByName<T>(names: readonly string[], available: ReadonlyMap<string, T>): T[] {
  return names.flatMap((name) => (available.has(name) ? [available.get(name)!] : []));
}

// The install's settings that narrow what a profile asked for.
export type ProfileInstall = { dm: DmMode };

// The triggers in force on this install: a profile's own, less the Slack events the install
// has off (a DM starts a turn only under DM_MODE=answer).
export function activeTriggers(profile: Profile, install: ProfileInstall): ProfileTrigger[] {
  return profile.triggers.map((t) => ({ kind: t.kind, events: t.events.filter((e) => e !== "direct_message" || install.dm === "answer") }));
}

// The line to log on start when the install answers DMs (DM_MODE=answer) and the profile
// Slack starts doesn't list `direct_message`: the install lets DMs in, and none starts a
// turn. Nothing to say otherwise.
export function unansweredDmNotice(profile: Profile, install: ProfileInstall): string | undefined {
  const trigger = slackTrigger(profile);
  if (install.dm !== "answer" || !trigger || trigger.events.includes("direct_message")) return undefined;
  return `lorehouse: DM_MODE=answer, but profile "${profile.id}" does not list direct_message in its Slack trigger: DMs are accepted by the install and start no turn for this profile, so a DM gets no answer and no pointer to a channel`;
}

// A profile as GET /status lists it: ids are strings, and each trigger is tagged by `kind`.
export type ProfileStatus = { id: string; mode: ProfileMode; triggers: ProfileTrigger[] };

export function profileStatus(profile: Profile, install: ProfileInstall): ProfileStatus {
  return { id: profile.id, mode: profile.mode, triggers: activeTriggers(profile, install) };
}
