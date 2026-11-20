# Evals

`bun run eval` drives Lorehouse the way a Slack teammate would, end to end, against a
**real model**, and says whether each promise the cases hold was kept. Conformance
(`bun run conformance`) proves the app's behavior with a scripted model; it cannot tell
whether a prompt, a tool description or a profile makes a real model do the right thing.
This can.

Every trial is its own instance: a fresh app subprocess with its own temp directory,
databases and ports; the conformance mock (`conformance/mock.ts`) for Slack and GitHub;
the fake runner (`conformance/fake-runner.ts`) for the sandbox; and the model behind a
recording proxy (`proxy.ts`). Nothing real is touched but the model: no Slack workspace,
no GitHub, no KVM.

## Run it

```bash
bun run eval                       # every case × 3 trials, against the real model
bun run eval --only code/          # one suite; or a case: --only default-repo; or /regex/
bun run eval --trials 1 --max-tokens 300000 --only cites-a-source   # one cheap trial
bun run eval --model claude-sonnet-5-5   # the app's ANTHROPIC_MODEL for this run
bun run eval --dry                 # the scripted model: no credential, no network (CI runs this)
bun run eval --list                # the cases, what each holds, and its checks
```

| flag | default | |
|---|---|---|
| `--dry` | off | Use the mock's scripted model. Proves the harness's plumbing, not the model (below). |
| `--only <pattern>` | all | Cases whose `<suite>/<id>` contains the text, or that `/regex/` matches. Any case. |
| `--trials <n>` | 3 (1 with `--dry`) | Trials per case. A real model is not deterministic: one trial is an anecdote. |
| `--model <id>` | the app's default | Sets the app's `ANTHROPIC_MODEL`. |
| `--concurrency <n>` | 2 | Trials at once. Each is its own processes and ports. |
| `--max-tokens <n>` | 5,000,000 | The run's total token budget (below). |
| `--threshold <x>` | 1 | A case is ok when passing trials / trials ≥ x. Code checks only. |
| `--grader-model <id>` | `claude-haiku-5-5` | The model for graded checks (also `EVAL_GRADER_MODEL`). |
| `--out <dir>` | `evals/out` | Where evidence goes (gitignored). |

**Exit code**: 0 when every case is at or above the threshold; 1 when one isn't, or the
budget stopped the run; 2 for a usage or setup error (a bad argument, an `--only` that
matches nothing, no credential without `--dry`), decided before anything starts.

### The model credential

Decided once, before anything starts, in this order:

1. `ANTHROPIC_API_KEY` — sent upstream as `x-api-key` (`api_key`).
2. `ANTHROPIC_AUTH_TOKEN` — sent as `Authorization: Bearer` (`auth_token`).
3. The `ant` CLI, logged in (`ant auth login`) — the harness runs
   `ant auth print-credentials --access-token` and sends the token as a bearer; when the
   API answers 401 it asks `ant` once more (the token may have been refreshed) and
   retries that request once (`ant`).

None of them: exit 2, naming these three. The final JSON line says which kind was used
(`credential`), never its value. The credential is held by the proxy only: the app under
test is given a placeholder key, the proxy drops whatever auth the app sent and sets the
real one, no header is recorded, and everything written or printed is scrubbed of it as
a last line of defense (`test/evals-proxy.test.ts` holds all of this, for each kind).

`EVAL_ANTHROPIC_UPSTREAM` points the proxy at another Anthropic-compatible endpoint
(default `https://api.anthropic.com`).

### Tokens

A run reports tokens, not dollars: prices change. Measured on 2026-11-19 with
`claude-opus-5`: a knowledge trial is 7,000 to 15,000 tokens (two or three model turns);
a code trial is one model turn per tool call, each resending the conversation, so 17,000
to 80,000, and one that goes exploring reached 160,000. The whole suite at 3 trials (36
trials) was about 1.3 million tokens, nearly all of it input, in under ten minutes at
`--concurrency 3`. Nothing is cached: June sends no cache breakpoints.

`--max-tokens` is the run's budget, input + output + cache read + cache write, the
grader's included. Once it is reached the proxy refuses every further model call, no new
trial starts, the run exits 1, and the JSON line says so (`tokens.exceeded`, `stopped`).
Set `EVAL_USD_PER_MTOK_IN` and `EVAL_USD_PER_MTOK_OUT` (dollars per million tokens) to
have an estimate printed beside the tokens.

## Read the output

Progress goes to stderr, one line per trial. Stdout is a table, then each case's checks
with their pass counts and, for a check that failed, the first failing trial's evidence
and its file. The **last stdout line is one JSON object**:

```json
{ "ok": false, "model": "claude-opus-5", "dry": false, "credential": "ant",
  "cases": 12, "passed": 11, "failed": 1, "trials": 36, "planned": 36, "threshold": 1,
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0,
              "max": 5000000, "exceeded": false,
              "grader": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 },
              "perCase": { "code/default-repo": 0 } },
  "graded": { "model": "claude-haiku-5-5", "passed": 5, "of": 6 },
  "failures": [ { "case": "code/no-default-asks", "check": "the reply asks which repo",
                  "trial": 2, "evidence": "…", "file": "evals/out/<run>/no-default-asks/2.json" } ],
  "ms": 0, "out": "evals/out/<run>" }
```

`failures` lists every required code check that failed, per trial. For an agent: read
that line, open one `file`, and the check's `evidence` names the record that decided it
(`job #3`, `turn 2`, `slack call #41`).

**Code checks and graded checks never share a number.** A trial passes when its
conversation ran to its end and every required code check passed. A case's rate is its
passing trials over its trials. Graded checks (prose a model judges) have their own
column and their own count in `graded`, and never decide a verdict or the exit code.

### An evidence file

`evals/out/<run id>/<case id>/<trial>.json`, written for every trial, pass or fail:

| key | holds |
|---|---|
| `case`, `why`, `trial`, `passed`, `model`, `ms`, `tokens` | the verdict and what it cost |
| `checks` | each check: `name`, `required`, `graded`, `judged`, `pass`, `evidence` |
| `conversation` | each step as sent, with how it ended (`outcome`, `detail`: what it was still waiting for) and where every record stood when it began |
| `transcript` | every model turn, in order: the request (`model`, `tools` offered, the newest `input`: the question or the tool results; the `system` prompt on turn 1) and the response (`content`: text blocks and `tool_use` with parsed `input`; `stopReason`; `tokens`), or its `error` |
| `observation.slack` | `calls` (every Slack call, raw), `said` (what people saw: streams, posts, card updates, ephemerals), `uploads`, `reactions` |
| `observation.runner.jobs` | every job the sandbox was sent, decoded: `command`, `cwd`, `timeoutMs`, and what it was answered (`exitCode`, `stdout`, or a refusal's `code`) |
| `observation.github.calls` | every request the mock GitHub received |
| `observation.model.toolCalls` | every tool call: `turn`, `name`, `input` |
| `observation.app` | the app's exit code, stderr and stdout |

To find what went wrong: `checks` → the failing one's `evidence` → that turn in
`transcript` (what the model was handed, what it called) or that job or Slack call.

## What `--dry` proves, and what it doesn't

`--dry` swaps the model for the conformance mock's scripted one (through the same proxy,
so the recording path runs too). It needs no credential and takes a few seconds; CI runs
it. It proves the harness: the app starts, events are delivered, clicks land, everything
is observed, checks evaluate, the report and evidence are written.

It proves nothing about a prompt. The scripted model answers markers (`[clone]`,
`[exec] <command>`), not prose, so a step can carry a `dry:` text for it. Each case says
what a dry run is judged on: `dry: "passes"` — the scripted model satisfies the checks
too, which shows the checks can pass; `dry: "runs"` — only that the trial completed
(checks are evaluated and recorded as "not judged"). Graded checks are never run dry.

## Add a case

Cases are data in `evals/cases/`, one file per small group, listed in
`cases/index.ts`. A case (`case.ts`):

```ts
{
  id: "default-repo",
  suite: "code",                       // "code": code tools on, a fake runner; "knowledge": off
  why: "In a channel with a default repo, \"run the tests\" needs no repo name: …",
  dry: "passes",
  setup: {
    defaultRepo: { repo: "acme/widgets", branch: "main" },   // through the real admin API
    sandbox: widgets,                  // what the sandbox answers (sandbox.ts)
    env: { PR_APPROVER: "anyone" },    // over the app's environment
  },
  conversation: [
    { mention: "run the tests", dry: "[clone]" },
    { as: "guest", click: "Approve", user: "UG1", until: "ephemeral" },
  ],
  checks: [
    ran("the channel's default repo is cloned", { command: / clone .*acme\/widgets\.git/ }),
    neverSaid("the reply doesn't ask which repo", /which\b.*\brepo/i),
  ],
}
```

- **`why`** is the user-visible promise, one line. If you can't write it, it isn't a case.
- **Steps**: `mention`, `reply` (a follow-up in the thread), `dm`, `click` (Approve or
  Deny on the newest card, by a named user), `quiet`. Each waits for something observable
  (`until`: `reply`, `card`, `update`, `ephemeral`, `post`) and then for quiet, under a
  deadline; a step that isn't answered fails the trial saying what it waited for. Users
  and channels are the fixtures' (`conformance/fixtures/slack-history.json`): `U1`–`U7`
  are full members, `UG1` a guest, `C1` the listed channel.
- **Checks** are code first (`checks.ts`): `ran` (runner jobs), `called` (the model's tool
  calls and their input), `said` / `neverSaid` (what people saw), `modelNeverWrote` (the
  model's own text, before Lorehouse's guards), `github`, `uploaded`, `card`,
  `toldAlone`, and `check` for anything else. `before` / `after` a step (by its `as`)
  restricts a check in time: "nothing is pushed before the click". Give a check
  `required: false` to report it without failing trials.
- **`graded(name, rubric)`** only where code can't decide (is this Traditional Chinese?
  does it say so plainly?). It is never required.
- **The sandbox** (`sandbox.ts`) is the fake runner unless the case scripts it. A code
  case gives it a `shell` (`shell.ts`): a simulated checkout whose files, `git` and common
  commands answer as bash and git would, plus the `programs` its request runs (a test
  runner, a script) and what each prints or writes. This matters: a real model checks its
  tools (`echo hello`, `ls`, `git status` after a commit, `python3 -V`), and when the
  sandbox answered `ran:<command>` it concluded, rightly, that nothing was executing and
  refused to go on (6 of 6 trials, 2026-11-19). Nothing is executed on your machine. The
  shell is not bash: no loops or `$(…)`, and a program invoked in a way no rule covers is
  refused out loud (exit 126), never answered with a silent success. Prefer an output
  nobody could guess (a number) over one a model might invent. `refuse` makes the host
  refuse calls, as sandboxd does. Under `--dry` there is no shell.
- Run it: `bun run eval --dry --only <id>`, then for real with `--trials 1`, and read the
  evidence file even when it passes: a check that passes for the wrong reason is worse
  than none.

Write checks for the promise, not the path: a model may run `ls` first, or word a reply
its own way. A check that fails on a reasonable variation measures the harness.

## Not here yet

- Comparing two git refs (#49): run the same cases in two worktrees and diff the two
  `summary.json` files by case and check. The pieces are here (`--out`, a stable summary
  shape); the command that makes the worktrees and prints the diff is not.
- The rest of #49's 15–30 knowledge cases (crediting the right author, digest shape).
- A GitHub App in the mock: the code suite uses the development `GITHUB_TOKEN` path, as
  conformance does, because the mock GitHub has no installation endpoints.
- A sandbox that runs code. The shell simulates; a model that pushes past what it
  simulates (inline Python, a build) is told the sandbox is restricted. A case that needs
  real execution needs a real sandbox, which is KVM's job (`sandbox/lab`).
- Real Slack, real GitHub, real KVM: by design.
