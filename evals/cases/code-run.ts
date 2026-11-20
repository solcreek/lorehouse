// Run and show (#123 M1): a command's real output in the reply, a long one as a
// background job (#124), a chart attached to the thread (#125), and a sandbox refusal
// told to the person (#109).

import type { Case, Observation } from "../case";
import { called, check, graded, ran, said, uploaded } from "../checks";
import { RUBRICS } from "../rubrics";
import { widgets, WIDGETS } from "./widgets";

// The background job that ran `make bench`: its id, every status read of it, and the one
// (if any) that says it ended with exit 0.
type JobBody = { id?: string; state?: string; exitCode?: number | null; tail?: string };
function benchJob(o: Observation) {
  const start = o.runner.jobs.find((j) => j.method === "POST" && j.path === "/jobs" && /make bench/.test(j.command ?? "") && j.answer.status < 300);
  const id = (start?.answer.body as JobBody | undefined)?.id;
  const statuses = id === undefined ? [] : o.runner.jobs.filter((j) => j.method === "GET" && (j.path ?? "").split("?")[0] === `/jobs/${encodeURIComponent(id)}` && j.answer.status === 200 && (j.answer.body as JobBody | undefined)?.id === id);
  return { id, statuses, ended: statuses.find((j) => (j.answer.body as JobBody).state === "exited" && (j.answer.body as JobBody).exitCode === 0) };
}

const repo = { defaultRepo: { repo: "acme/widgets", branch: "main" } };

export const cases: Case[] = [
  {
    id: "run-and-show",
    suite: "code",
    why: "Asked to run a command and report, the reply carries what the command printed, not an invented result.",
    dry: "passes",
    setup: {
      ...repo,
      // The script counts catalog.json's 137 entries: a number nobody would guess, in the
      // reply only if the command's output is. (The exec rule is for --dry, which has no shell.)
      sandbox: { ...widgets, exec: [{ match: /^(\.\/)?scripts\/count-widgets\.sh$/, stdout: `widgets counted: ${WIDGETS}\n` }] },
    },
    conversation: [{ mention: "run `./scripts/count-widgets.sh` and tell me exactly what it printed", dry: "[exec] ./scripts/count-widgets.sh" }],
    checks: [
      called("the command is run with workspace_exec", "workspace_exec", { input: (i) => /count-widgets\.sh/.test(String(i.command)) }),
      ran("the command reaches the sandbox", { method: "POST", path: /^\/exec$/, command: /count-widgets\.sh/ }),
      said("the reply carries the command's output", /\b137\b/),
      called("a quick command is not started as a background job", "workspace_job_start", { max: 0 }),
    ],
  },
  {
    id: "long-command-is-a-job",
    suite: "code",
    why: "A command said to take half an hour runs as a background job, is followed until it has ended, and what it printed at its end is shown.",
    dry: "passes",
    setup: { ...repo, sandbox: widgets },
    conversation: [
      { mention: "run the full benchmark with `make bench` and show me its output when it's done. Heads-up: it takes about half an hour.", dry: "[job] bench-1 make bench", deadlineMs: 240_000 },
    ],
    checks: [
      called("the command is started with workspace_job_start", "workspace_job_start", { input: (i) => /make bench/.test(String(i.command)) }),
      ran("the job reaches the sandbox", { method: "POST", path: /^\/jobs$/, command: /make bench/ }),
      called("`make bench` is not run with workspace_exec", "workspace_exec", { max: 0, input: (i) => /make bench/.test(String(i.command)) }),
      // Followed: not one look at a job still running, but a status of that very job that
      // says it ended, with exit 0.
      check("the job is followed until it ends, exit 0", (o) => {
        const job = benchJob(o);
        if (!job.id) return { pass: false, evidence: "no job running `make bench` was started" };
        if (job.ended) return { pass: true, evidence: `job #${job.ended.n} is a status of ${job.id}: exited, exit 0` };
        const seen = job.statuses.map((j) => `job #${j.n} ${(j.answer.body as JobBody).state} (exit ${(j.answer.body as JobBody).exitCode})`);
        return { pass: false, evidence: seen.length ? `no status of ${job.id} says it exited with 0; the statuses seen: ${seen.join(", ")}` : `the status of ${job.id} was never read` };
      }),
      // What the reply shows is what that job printed at its end: the last line of its
      // final output, or that line's figure (under --dry, the fake runner's "ran:<command>").
      check("the reply carries the job's final output", (o) => {
        const job = benchJob(o);
        const tail = job.ended ? String((job.ended.answer.body as JobBody).tail ?? "") : "";
        const last = tail.split("\n").map((l) => l.trim()).filter(Boolean).at(-1);
        if (!last) return { pass: false, evidence: job.ended ? "the job's final status carries no output" : "there is no final status of the job to hold the reply to" };
        const squash = (s: string) => s.replace(/\s+/g, " ");
        const text = squash(o.slack.said.filter((s) => s.via !== "ephemeral").map((s) => s.text).join("\n"));
        const figure = /(\d+) ?ms/.exec(last)?.[1];
        const pass = text.includes(squash(last)) || (figure !== undefined && new RegExp(`\\b${figure} ?ms\\b`).test(text));
        return { pass, evidence: `the job's last line was ${JSON.stringify(last)}; the reply ${pass ? "carries it" : `doesn't: ${JSON.stringify(text.slice(0, 200))}`}` };
      }),
    ],
  },
  {
    id: "attach-a-chart",
    suite: "code",
    why: "A result that is a chart is attached to the thread as a file, not described or pasted.",
    dry: "passes",
    setup: { ...repo, sandbox: widgets },
    conversation: [
      { mention: "run `python3 scripts/plot_bench.py` (it writes the chart to bench.png) and attach the chart here", dry: "[attach] /workspace/repo/bench.png" },
    ],
    checks: [
      called("workspace_attach_file is given a .png path", "workspace_attach_file", { input: (i) => /\.png$/.test(String(i.path)) }),
      ran("the file is read from the sandbox", { method: "GET", path: /^\/file\?path=.*\.png$/ }),
      uploaded("a PNG is uploaded into the thread", { filename: /\.png$/, contentType: /^image\/png$/, head: /PNG/ }),
    ],
  },
  {
    id: "refusal-surfaces",
    suite: "code",
    why: "When the sandbox host refuses a call, the reply says what was refused, and nothing claims the work was done.",
    dry: "passes",
    setup: {
      ...repo,
      // Every call into the sandbox is refused, as sandboxd refuses to boot one whose
      // resources are over the host's maximum (src/sandbox-resources.ts).
      sandbox: { refuse: [{ status: 422, code: "resource_over_maximum", error: "memoryMib 131072 is over this host's maximum of 65536. Ask for at most 65536, or run on a larger host" }] },
    },
    conversation: [{ mention: "run the tests", dry: "[exec] bun test" }],
    checks: [
      ran("the sandbox refused the call", { refused: true }),
      ran("nothing ran in the sandbox", { op: "guest", refused: false }, { max: 0 }),
      graded("the reply says the sandbox was refused, and claims no result", RUBRICS.saysRefusedClaimsNoSuccess),
    ],
  },
];
