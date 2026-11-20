// case.ts — what a case is, and what a trial of it observed.
//
// A case is data (evals/cases/): how the instance is set up, a conversation as a Slack
// teammate would have it, and named checks over the Observation the trial leaves. The
// runner (run.ts, trial.ts) knows nothing of any one case.

import type { Stats } from "../conformance/harness";
import type { ModelTurn } from "./proxy";
import type { SandboxScript } from "./sandbox";

export type Suite = "code" | "knowledge";

// What a step waits for before the next one (always followed by a wait for quiet):
//   reply      the agent's streamed reply in the thread has ended
//   card       an Approve/Deny card was posted in the thread
//   update     the card that was clicked was updated (a turn resumed and answered)
//   ephemeral  the clicker was answered alone, through their response_url
//   post       a message was posted to the step's channel
//   quiet      nothing in particular: only quiet
export type Until = "reply" | "card" | "update" | "ephemeral" | "post" | "quiet";

type StepCommon = {
  // A name checks can point at (`before`/`after`), instead of the step's position.
  as?: string;
  // What to wait for; each kind of step has a default.
  until?: Until;
  // How long the step may take before the trial fails, naming what it waited for.
  deadlineMs?: number;
};
type Says = {
  // Who writes it (default U1, a full member).
  user?: string;
  // What to send instead under --dry: the scripted model answers markers such as
  // "[clone]" or "[exec] <command>" (conformance/mock.ts), not prose.
  dry?: string;
};

export type Step =
  // A mention of the agent in the channel: the first starts the thread, later ones are in it.
  | (StepCommon & Says & { mention: string })
  // A reply in the thread without a mention (a follow-up).
  | (StepCommon & Says & { reply: string })
  // A direct message to the agent.
  | (StepCommon & Says & { dm: string })
  // A click on the newest card in the thread.
  | (StepCommon & { click: "Approve" | "Deny"; user: string })
  // Wait until nothing has happened for this long.
  | (StepCommon & { quiet: number });

export type Setup = {
  // Laid over the app's environment (e.g. PR_APPROVER, DM_MODE).
  env?: Record<string, string>;
  // The channel's default repo, set through the admin API as an admin would (the mock
  // GitHub knows acme/widgets and acme/gadgets).
  defaultRepo?: { repo: string; branch?: string };
  // Messages added to Slack's history before the app starts, beside the fixture file's.
  messages?: { channel: string; message: { ts: string; thread_ts?: string; user?: string; text: string } }[];
  // What the sandbox answers, beyond the fake runner's own answers (sandbox.ts).
  sandbox?: SandboxScript;
};

export type CheckResult = { pass: boolean; evidence: string };

export type Check = {
  name: string;
  // A code check that isn't required is reported and never fails a trial.
  required: boolean;
} & (
  | { graded: false; run: (o: Observation) => CheckResult }
  // Judged by a model, against `rubric`, on what `subject` picks out of the observation
  // (default: everything the agent said in the thread). Reported apart from code checks.
  | { graded: true; rubric: string; subject: (o: Observation) => string }
);

export type Case = {
  // Unique; names the evidence directory. Listed and matched as "<suite>/<id>".
  id: string;
  suite: Suite;
  // The user-visible promise this case holds, in one line.
  why: string;
  // What a --dry run is judged on: "passes" — the scripted model satisfies the checks
  // too, so they are judged; "runs" — only that the trial completed with an observation.
  dry: "passes" | "runs";
  setup?: Setup;
  conversation: Step[];
  checks: Check[];
};

// ── the observation ─────────────────────────────────────────────────────────

// One Slack call the app made, as the mock recorded it. `n` is its position among all of
// the trial's calls, from 0.
export type SlackCall = { n: number; method: string; body: Record<string, unknown> };

// Something the agent put in front of people.
export type Said = {
  via: "stream" | "post" | "update" | "ephemeral";
  channel?: string;
  // The thread it is in (a stream's or a post's thread_ts).
  thread?: string;
  // The message's own ts (a post's, or the one an update changed).
  ts?: string;
  text: string;
  // A post's blocks, when it has any (a card).
  blocks?: unknown[];
  // The call that completed it: checks order things by it.
  call: number;
  // A stream that never stopped.
  open?: boolean;
  // An ephemeral's response_url path ("/slack/response/<user>-<n>").
  path?: string;
};

// One job the sandbox runner was sent, decoded. Tokens in a body are replaced.
export type RunnerJob = {
  n: number;
  sandbox: string;
  op: string;
  method?: string;
  path?: string;
  timeoutMs?: number;
  // An exec's or a background job's command line and where it ran.
  command?: string;
  cwd?: string;
  body?: unknown;
  answer: { status: number; code?: string; error?: string; exitCode?: number; stdout?: string; stderr?: string; body?: unknown };
};

export type ToolCall = { turn: number; name: string; input: unknown };

// Where each kind of record stood when a step began: what came before the step is
// everything below these counts.
export type StepMark = {
  n: number;
  as?: string;
  step: string;
  slack: number;
  jobs: number;
  github: number;
  turns: number;
  // How it ended: done, or what it was still waiting for at its deadline; "skipped" after
  // an earlier step failed.
  outcome: "done" | "failed" | "skipped";
  detail?: string;
  ms?: number;
};

export type Observation = {
  channel: string;
  // The root ts of the thread the conversation is in (the first mention's).
  thread?: string;
  // What was sent, step by step.
  steps: StepMark[];
  slack: {
    calls: SlackCall[];
    said: Said[];
    uploads: Stats["uploads"];
    reactions: { name: string; channel?: string; ts?: string; call: number }[];
  };
  runner: { connected: boolean; jobs: RunnerJob[] };
  github: { calls: (Stats["github"][number] & { n: number })[] };
  model: { turns: ModelTurn[]; toolCalls: ToolCall[] };
  app: { exit: number | null; stderr: string; stdout: string };
};

// The step named `ref` (its `as`, or its position), or undefined.
export function stepMark(o: Observation, ref: string | number): StepMark | undefined {
  return typeof ref === "number" ? o.steps[ref] : o.steps.find((s) => s.as === ref);
}
