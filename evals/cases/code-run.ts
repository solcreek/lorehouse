// Run and show (#123 M1): a command's real output in the reply, a long one as a
// background job (#124), a chart attached to the thread (#125), and a sandbox refusal
// told to the person (#109).

import type { Case } from "../case";
import { called, neverSaid, ran, said, uploaded } from "../checks";
import { widgets, WIDGETS } from "./widgets";

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
    why: "A command said to take half an hour runs as a background job, is followed until it ends, and its output is shown.",
    dry: "passes",
    setup: { ...repo, sandbox: widgets },
    conversation: [
      { mention: "run the full benchmark with `make bench` and show me its output when it's done. Heads-up: it takes about half an hour.", dry: "[job] bench-1 make bench", deadlineMs: 240_000 },
    ],
    checks: [
      called("the command is started with workspace_job_start", "workspace_job_start", { input: (i) => /make bench/.test(String(i.command)) }),
      ran("the job reaches the sandbox", { method: "POST", path: /^\/jobs$/, command: /make bench/ }),
      called("the job is followed with workspace_job_status", "workspace_job_status"),
      called("`make bench` is not run with workspace_exec", "workspace_exec", { max: 0, input: (i) => /make bench/.test(String(i.command)) }),
      // What the benchmark prints at its end (under --dry, the fake runner's "ran:<command>").
      said("the reply carries the job's output", /290 ?ms|ran:[^\n]*make bench/),
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
      said("the reply says what was refused", /refus|65536|maximum|resource_over_maximum/i),
      neverSaid("nothing claims the tests ran or passed", /\b\d+ pass\b|tests? (all )?pass(ed|ing)?\b|all (the )?tests|passed successfully|✅/i),
    ],
  },
];
