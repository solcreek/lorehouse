// checks.ts — the predicates a case's checks are made of. Each reads the trial's
// Observation and answers pass or fail with a short evidence string that points at the
// record that decided it (job #3, turn 2, slack call #41), so a failure can be found in
// the evidence file without reading all of it.
//
// A window (`before` / `after` a step, by its `as` name or position) restricts a check to
// what was observed before that step began, or from it on.

import { stepMark, type Check, type CheckResult, type Observation, type RunnerJob, type Said, type ToolCall } from "./case";

export type Window = { before?: string | number; after?: string | number };
export type Count = { min?: number; max?: number };
type Options = Window & Count & { required?: boolean };

const short = (s: string, n = 160) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n - 1)}…`;
};

// The [from, to) range of record positions a window leaves, for one kind of record.
function range(o: Observation, w: Window, kind: "slack" | "jobs" | "github" | "turns"): { from: number; to: number; problem?: string } {
  const at = (ref: string | number) => stepMark(o, ref);
  const before = w.before === undefined ? undefined : at(w.before);
  const after = w.after === undefined ? undefined : at(w.after);
  if (w.before !== undefined && !before) return { from: 0, to: 0, problem: `no step ${JSON.stringify(w.before)} in this conversation` };
  if (w.after !== undefined && !after) return { from: 0, to: 0, problem: `no step ${JSON.stringify(w.after)} in this conversation` };
  // A step that never began (an earlier one failed) has no mark of its own: nothing is
  // "after" it, and everything observed is "before" it.
  const reached = (m: NonNullable<typeof before>) => m.outcome !== "skipped";
  return {
    from: after ? (reached(after) ? after[kind] : Infinity) : 0,
    to: before && reached(before) ? before[kind] : Infinity,
  };
}
const within = (r: { from: number; to: number }, n: number) => n >= r.from && n < r.to;
const windowText = (w: Window) => `${w.before !== undefined ? ` before step ${JSON.stringify(w.before)}` : ""}${w.after !== undefined ? ` from step ${JSON.stringify(w.after)} on` : ""}`;

// `found` against the wanted count, with what was found (or what there was instead).
function counted<T>(found: T[], c: Count, what: string, show: (x: T) => string, others: () => string): CheckResult {
  const min = c.min ?? (c.max === undefined ? 1 : 0);
  const pass = found.length >= min && (c.max === undefined || found.length <= c.max);
  const want = c.max === undefined ? `at least ${min}` : c.max === min ? `exactly ${min}` : `${min} to ${c.max}`;
  if (pass) return { pass, evidence: found.length ? `${found.length} ${what}: ${short(found.slice(0, 3).map(show).join("; "), 300)}` : `no ${what}, as wanted` };
  return { pass, evidence: `${found.length} ${what}, want ${want}. ${found.length ? `Found: ${short(found.slice(0, 4).map(show).join("; "), 400)}` : others()}` };
}

const code = (name: string, o: Options | undefined, run: (obs: Observation) => CheckResult): Check => ({ name, required: o?.required ?? true, graded: false, run });

const showJob = (j: RunnerJob) => `job #${j.n} ${j.op}${j.method ? ` ${j.method} ${j.path?.split("?")[0]}` : ""}${j.command !== undefined ? ` ${JSON.stringify(short(j.command, 120))}` : ""}${j.answer.code ? ` → refused ${j.answer.code}` : ""}`;
const showCall = (c: ToolCall) => `turn ${c.turn} ${c.name} ${short(JSON.stringify(c.input), 140)}`;
const showSaid = (s: Said) => `${s.via} (slack call #${s.call}) ${JSON.stringify(short(s.text, 200))}`;

// Jobs the sandbox runner was sent. `command` matches an exec's or a background job's
// command line; `op` is "guest", "stage" or "push"; `path` matches a guest call's path.
export function ran(name: string, what: { command?: RegExp; op?: string; method?: string; path?: RegExp; refused?: boolean }, o?: Options): Check {
  return code(name, o, (obs) => {
    const r = range(obs, o ?? {}, "jobs");
    if (r.problem) return { pass: false, evidence: r.problem };
    const inWindow = obs.runner.jobs.filter((j) => within(r, j.n));
    const found = inWindow.filter(
      (j) =>
        (what.op === undefined || j.op === what.op) &&
        (what.method === undefined || j.method === what.method) &&
        (what.path === undefined || what.path.test(j.path ?? "")) &&
        (what.command === undefined || (j.command !== undefined && what.command.test(j.command))) &&
        (what.refused === undefined || !!j.answer.code === what.refused),
    );
    const described = [what.op, what.method, what.path && `path ${what.path}`, what.command && `command ${what.command}`, what.refused && "refused"].filter(Boolean).join(" ");
    return counted(found, o ?? {}, `runner job(s) matching ${described}${windowText(o ?? {})}`, showJob, () =>
      inWindow.length ? `The runner was sent: ${short(inWindow.slice(0, 8).map(showJob).join("; "), 600)}` : obs.runner.connected ? "The runner was sent nothing." : "No runner was connected.",
    );
  });
}

// Tool calls the model made. `input` decides on the call's parsed input.
export function called(name: string, tool: string | RegExp, o?: Options & { input?: (input: Record<string, unknown>) => boolean }): Check {
  return code(name, o, (obs) => {
    const r = range(obs, o ?? {}, "turns");
    if (r.problem) return { pass: false, evidence: r.problem };
    // A turn's position is its number less one.
    const inWindow = obs.model.toolCalls.filter((c) => within(r, c.turn - 1));
    const named = (c: ToolCall) => (typeof tool === "string" ? c.name === tool : tool.test(c.name));
    const found = inWindow.filter((c) => named(c) && (!o?.input || (c.input !== null && typeof c.input === "object" && o.input(c.input as Record<string, unknown>))));
    return counted(found, o ?? {}, `call(s) of ${tool}${o?.input ? " with the wanted input" : ""}${windowText(o ?? {})}`, showCall, () =>
      inWindow.length ? `The model called: ${short(inWindow.slice(0, 8).map(showCall).join("; "), 600)}` : `The model called no tool (${obs.model.turns.length} model turn(s)).`,
    );
  });
}

const saidIn = (obs: Observation, o: Window & { via?: Said["via"][] }) => {
  const r = range(obs, o, "slack");
  return { r, items: obs.slack.said.filter((s) => within(r, s.call) && (!o.via || o.via.includes(s.via))) };
};
// Everything the agent said to the thread (not ephemerals, which one person sees).
const PUBLIC: Said["via"][] = ["stream", "post", "update"];

// Something the agent said matches `re`. `via` narrows where (default: stream, post, update).
export function said(name: string, re: RegExp, o?: Window & { required?: boolean; via?: Said["via"][] }): Check {
  return code(name, o, (obs) => {
    const { r, items } = saidIn(obs, { ...o, via: o?.via ?? PUBLIC });
    if (r.problem) return { pass: false, evidence: r.problem };
    const hit = items.find((s) => re.test(s.text));
    if (hit) return { pass: true, evidence: `${re} matches ${showSaid(hit)}` };
    return { pass: false, evidence: items.length ? `${re} matches nothing the agent said${windowText(o ?? {})}: ${short(items.map(showSaid).join("; "), 700)}` : `the agent said nothing${windowText(o ?? {})}` };
  });
}

// Nothing the agent said matches `re`. An agent that said nothing at all fails: silence
// isn't the behavior any case wants.
export function neverSaid(name: string, re: RegExp, o?: Window & { required?: boolean; via?: Said["via"][] }): Check {
  return code(name, o, (obs) => {
    const { r, items } = saidIn(obs, { ...o, via: o?.via ?? PUBLIC });
    if (r.problem) return { pass: false, evidence: r.problem };
    const hit = items.find((s) => re.test(s.text));
    if (hit) return { pass: false, evidence: `${re} matches ${showSaid(hit)}` };
    return items.length ? { pass: true, evidence: `${re} matches none of the ${items.length} thing(s) the agent said` } : { pass: false, evidence: `the agent said nothing${windowText(o ?? {})}, so there is no reply to hold to this` };
  });
}

// Nothing the model itself wrote (its text blocks, before Lorehouse's guards rewrite
// anything on the way to Slack) matches `re`.
export function modelNeverWrote(name: string, re: RegExp, o?: { required?: boolean }): Check {
  return code(name, o, (obs) => {
    const texts = obs.model.turns.flatMap((t) => (t.response?.content ?? []).flatMap((b) => (b.type === "text" ? [{ turn: t.n, text: b.text }] : [])));
    const hit = texts.find((t) => re.test(t.text));
    if (hit) return { pass: false, evidence: `${re} matches the model's text in turn ${hit.turn}: ${JSON.stringify(short(hit.text, 200))}` };
    return texts.length ? { pass: true, evidence: `${re} matches none of the model's ${texts.length} text block(s)` } : { pass: false, evidence: "the model wrote no text at all" };
  });
}

// Requests GitHub's API received.
export function github(name: string, what: { method: string; path: RegExp; body?: (body: Record<string, unknown>) => boolean }, o?: Options): Check {
  return code(name, o, (obs) => {
    const r = range(obs, o ?? {}, "github");
    if (r.problem) return { pass: false, evidence: r.problem };
    const inWindow = obs.github.calls.filter((c) => within(r, c.n));
    const found = inWindow.filter((c) => c.method === what.method && what.path.test(c.path) && (!what.body || (c.body !== null && typeof c.body === "object" && what.body(c.body as Record<string, unknown>))));
    const show = (c: (typeof inWindow)[number]) => `github call #${c.n} ${c.method} ${c.path}${c.body ? ` ${short(JSON.stringify(c.body), 140)}` : ""}`;
    return counted(found, o ?? {}, `GitHub request(s) ${what.method} ${what.path}${what.body ? " with the wanted body" : ""}${windowText(o ?? {})}`, show, () =>
      inWindow.length ? `GitHub received: ${short(inWindow.slice(0, 8).map(show).join("; "), 600)}` : "GitHub received nothing.",
    );
  });
}

// A file uploaded and shared into the conversation's thread.
export function uploaded(name: string, what: { filename?: RegExp; contentType?: RegExp; head?: RegExp }, o?: Count & { required?: boolean }): Check {
  return code(name, o, (obs) => {
    const shared = obs.slack.uploads.filter((u) => u.channel !== undefined && u.bytes !== undefined);
    const found = shared.filter((u) => (!what.filename || what.filename.test(u.filename)) && (!what.contentType || what.contentType.test(u.contentType ?? "")) && (!what.head || what.head.test(u.head ?? "")) && (!obs.thread || u.thread_ts === obs.thread));
    const show = (u: (typeof shared)[number]) => `${JSON.stringify(u.filename)} (${u.contentType}, ${u.bytes} bytes) in thread ${u.thread_ts}`;
    return counted(found, o ?? {}, "upload(s) shared into the thread", show, () => (obs.slack.uploads.length ? `Uploads: ${short(JSON.stringify(obs.slack.uploads), 500)}` : "Nothing was uploaded."));
  });
}

// An Approve/Deny card (a message with a button labelled `label`) posted in the thread.
export function card(name: string, label: string, o?: Options): Check {
  return code(name, o, (obs) => {
    const r = range(obs, o ?? {}, "slack");
    if (r.problem) return { pass: false, evidence: r.problem };
    const found = obs.slack.said.filter((s) => s.via === "post" && within(r, s.call) && JSON.stringify(s.blocks ?? []).includes(`"text":${JSON.stringify(label)}`));
    return counted(found, o ?? {}, `card(s) with a ${label} button${windowText(o ?? {})}`, showSaid, () => `Posts: ${short(obs.slack.said.filter((s) => s.via === "post").map(showSaid).join("; "), 500) || "none"}`);
  });
}

// An ephemeral reply to `user` alone (through the response_url of their click).
export function toldAlone(name: string, user: string, o?: { required?: boolean; matching?: RegExp }): Check {
  return code(name, o, (obs) => {
    const all = obs.slack.said.filter((s) => s.via === "ephemeral");
    const found = all.filter((s) => (s.path ?? "").startsWith(`/slack/response/${user}-`) && (!o?.matching || o.matching.test(s.text)));
    return counted(found, {}, `ephemeral repl(ies) to ${user}${o?.matching ? ` matching ${o.matching}` : ""}`, showSaid, () => (all.length ? `Ephemerals: ${short(all.map((s) => `${s.path} ${JSON.stringify(short(s.text, 100))}`).join("; "), 400)}` : "Nobody was answered ephemerally."));
  });
}

// Anything else: a predicate of the case's own.
export function check(name: string, run: (obs: Observation) => CheckResult, o?: { required?: boolean }): Check {
  return code(name, o, run);
}

// Everything the agent said to the thread, in order: what a graded check judges by default.
export const everythingSaid = (obs: Observation) => obs.slack.said.filter((s) => PUBLIC.includes(s.via)).map((s) => s.text).join("\n\n");

// A check only a model can decide (prose). Never required: graded checks are reported
// apart from code checks and don't decide the exit code.
export function graded(name: string, rubric: string, subject: (obs: Observation) => string = everythingSaid): Check {
  return { name, required: false, graded: true, rubric, subject };
}
