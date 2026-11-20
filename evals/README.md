# Evals

`bun run eval` drives Lorehouse the way a Slack teammate would, end to end, against a
**real model**, and says whether each promise the cases hold was kept. Conformance
(`bun run conformance`) proves the app's behavior with a scripted model; it cannot tell
whether a prompt, a tool description or a profile makes a real model do the right thing.
This can.

Every trial is its own instance: a fresh app subprocess with its own temp directory,
databases and port; the conformance mock (`conformance/mock.ts`) for Slack and GitHub;
the fake runner (`conformance/fake-runner.ts`) for the sandbox, with a simulated shell
behind it for code cases (`shell.ts`); and the model behind a recording proxy
(`proxy.ts`). Nothing real is touched but the model: no Slack workspace, no GitHub, no
KVM, and no command a model chooses is ever executed on your machine.

## Run it

```bash
bun run eval                       # every case × 3 trials, against the real model
bun run eval --only code/          # one suite; or a case: --only default-repo; or /regex/
bun run eval --trials 1 --max-tokens 300000 --only cites-a-source   # one cheap trial
bun run eval --model claude-sonnet-5-5   # the app's ANTHROPIC_MODEL for this run
bun run eval --dry                 # the scripted model: no credential, no network (CI runs this)
bun run eval --grader-selftest     # is the grader itself right? (about 15,000 tokens)
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
| `--threshold <x>` | 1 | A case is ok when passing trials / trials ≥ x. |
| `--grader-model <id>` | `claude-haiku-5-5` | The model for graded checks (also `EVAL_GRADER_MODEL`). |
| `--no-grader` | off | Run without graded checks: they are "not judged" (below). |
| `--grader-selftest` | | Grade every rubric's known replies with the real grader; runs no case. |
| `--upstream <url>` | `https://api.anthropic.com` | Where model calls, and the credential, are sent (below). |
| `--out <dir>` | `evals/out` | Where evidence goes (gitignored). |

**Exit code**

- 0: every case is at or above the threshold, fully judged, within the budget.
- 1: a case is below it; or a case is not fully judged (`--no-grader`, or the grader gave
  no usable verdict for a required graded check); or the run's tokens went over
  `--max-tokens`, whether or not every trial ran. Also `--grader-selftest` with a wrong
  verdict, and a crash.
- 2: a usage or setup error (a bad argument, an `--only` that matches nothing, no
  credential without `--dry`, an upstream the command line didn't choose), decided before
  anything starts.
- 130: interrupted (SIGINT, SIGTERM, SIGHUP).

### The model credential

Decided once, before anything starts, in this order:

1. `ANTHROPIC_API_KEY` — sent upstream as `x-api-key` (`api_key`).
2. `ANTHROPIC_AUTH_TOKEN` — sent as `Authorization: Bearer` (`auth_token`).
3. The `ant` CLI, logged in (`ant auth login`) — the harness runs
   `ant auth print-credentials --access-token` and sends the token as a bearer; when the
   API answers 401 it asks `ant` once more (the token may have been refreshed) and
   retries that request once (`ant`).

None of them: exit 2, naming these three. The final JSON line says which kind was used
(`credential`), never its value.

**The credential is sent to the upstream host with every model call.** That host is
`https://api.anthropic.com` unless `--upstream <url>` is on the command line, and a line
on stderr says where it will go, and which kind it is, before anything is sent:

    eval: the model credential (ant) will be sent to https://api.anthropic.com, and nowhere else

An upstream must be https, or plain http to this machine only. `EVAL_ANTHROPIC_UPSTREAM`
on its own is refused (exit 2) when it names another host: an environment variable is not
a decision, and `bun run eval` does not load `.env` at all (`--no-env-file`), so neither
an upstream nor a key can come from a file in the checkout. A redirect from upstream is
never followed.

The credential is held by the proxy only:

- the app under test and the grader are given a key the proxy makes up for the run, which
  is worth nothing anywhere else;
- the proxy listens on loopback, requires that key on every request, forwards only
  `POST /v1/messages` of an open trial, drops whatever auth the request carried and sets
  the real one;
- no header is recorded, and what is recorded, handed back, written or printed is
  scrubbed of the credential, should an upstream ever echo it.

`test/evals-proxy.test.ts` and `test/evals-run.test.ts` hold all of this, for each kind,
including a run against an upstream that sends the credential back.

### Tokens

A run reports tokens, not dollars: prices change. Measured on the full suite
(12 cases × 3 trials, `claude-opus-5`, `--concurrency 2`, 2026-11-20): **894,193 tokens
in 4 min 36 s**, of them 871,134 input and 23,059 output, with 10,866 the grader's
(`claude-haiku-5-5`, 15 verdicts). A knowledge trial was 7,500 to 15,400 tokens; a code
trial 16,500 to 51,400, since each tool call is another model turn that resends the
conversation. Nothing is cached: June sends no cache breakpoints. `--grader-selftest`
was 15,092 tokens.

`--max-tokens` is the run's budget, input + output + cache read + cache write, the
grader's included. Once the total reaches it the proxy refuses every further model call
and no new trial starts; the JSON line says so (`tokens.exceeded`, `stopped`) and the run
exits 1, even if a last call took the total over the line after every trial had run. Set
`EVAL_USD_PER_MTOK_IN` and `EVAL_USD_PER_MTOK_OUT` (dollars per million tokens) to have
an estimate printed beside the tokens.

## Read the output

Progress goes to stderr, one line per trial. Stdout is a table, then each case's checks
with their pass counts and, for a check that failed, the first failing trial's evidence
and its file. The **last stdout line is one JSON object**:

```json
{ "ok": false, "model": "claude-opus-5", "dry": false, "credential": "ant",
  "cases": 12, "passed": 11, "failed": 1, "unjudged": 0,
  "trials": 36, "planned": 36, "threshold": 1,
  "checks": { "code": { "passed": 188, "of": 189 },
              "graded": { "passed": 15, "of": 15, "notJudged": 0 } },
  "grader": "claude-haiku-5-5",
  "tokens": { "input": 871134, "output": 23059, "cacheRead": 0, "cacheWrite": 0,
              "total": 894193, "max": 2000000, "exceeded": false,
              "grader": { "input": 8291, "output": 2575, "cacheRead": 0, "cacheWrite": 0, "total": 10866 },
              "perCase": { "code/default-repo": 93258 } },
  "failures": [ { "case": "knowledge/names-people-as-plain-text", "check": "…", "kind": "code",
                  "trial": 1, "evidence": "…", "file": "evals/out/<run>/names-people-as-plain-text/1.json" } ],
  "shellRefused": [ { "case": "code/attach-a-chart", "trial": 1,
                      "command": "ls -la bench.png && file bench.png && xxd -l 16 bench.png",
                      "part": "xxd -l 16 bench.png" } ],
  "ms": 275674, "out": "evals/out/<run>" }
```

`failures` lists every required check that failed, per trial, with its `kind`. For an
agent: read that line, open one `file`, and the check's `evidence` names the record that
decided it (`job #3`, `turn 2`, `slack call #41`), or for a graded check the grader's
reason and the words of the reply it quoted.

### Two kinds of check, never one number

- **Code checks** decide hard facts: which jobs ran, which repo was cloned, which digits
  appear in the reply, what was staged and pushed, that nothing was uploaded.
- **Graded checks** are a judgment about prose that code can't make: does the reply ask
  which repo; does it say it found nothing and give no code; does it say what was refused
  and claim no success; does it read as Traditional Chinese. A cheap model
  (`--grader-model`) judges the reply against one rubric (`rubrics.ts`) and answers
  strict JSON with the words of the reply that decided it.

Either kind may be required, and a trial fails when a required check of either kind
fails. They are counted apart everywhere: two columns in the table, `checks.code` and
`checks.graded` in the JSON line, `kind` on every failure.

A graded check has a verdict only when the grader's answer can be used. An answer that
isn't the JSON asked for, a quote that isn't in the reply, a pass that quotes nothing, or
a call that fails is **not judged, never a pass**. A trial with no failure but a required
graded check left unjudged is *not fully judged*; so is its case (`NOT JUDGED` in the
table, `unjudged` in the JSON line), and the run exits 1. `--no-grader` does this on
purpose: the code checks run, the graded ones are reported as not judged, and no case
that needs one is reported as passed.

**A grader that passes everything is a check that cannot fail.** So every rubric carries
replies known to meet it and known not to, and `bun run eval --grader-selftest` grades
them all with the real grader model: exit 0 only if every verdict is the one the example
deserves. Run it when a rubric or the grader's prompt changes, or the grader model does.
On 2026-11-20 it was 33 of 33 right with `claude-haiku-5-5`.

### The simulated shell's refusals

`shellRefused` (and a list under the table) is every command the simulated shell would
not run, by trial. A model that is refused something it reasonably tried may go on to
fail a check for that reason and not its own: when a case fails, look here first.

### An evidence file

`evals/out/<run id>/<case id>/<trial>.json`, written for every trial, pass or fail:

| key | holds |
|---|---|
| `case`, `why`, `trial`, `verdict`, `model`, `ms`, `tokens` | the verdict (`passed`, `failed`, `unjudged`) and what it cost |
| `checks` | each check: `name`, `required`, `graded`, `judged`, `pass`, `evidence` |
| `conversation` | each step as sent, with how it ended (`outcome`, `detail`: what it was still waiting for) and where every record stood when it began |
| `transcript` | every model turn, in order: the request (`model`, `tools` offered, the newest `input`: the question or the tool results; the `system` prompt on turn 1) and the response (`content`: text blocks and `tool_use` with parsed `input`; `stopReason`; `tokens`), or its `error` |
| `observation.slack` | `calls` (every Slack call, raw), `said` (what people saw: streams, posts, card updates, ephemerals), `uploads`, `reactions` |
| `observation.runner` | `jobs`: every job the sandbox was sent, decoded (`command`, `cwd`, `timeoutMs`) with what it was answered (`exitCode`, `stdout`, a stage's facts, or a refusal's `code`); `refused`: what the simulated shell wouldn't run |
| `observation.github.calls` | every request the mock GitHub received |
| `observation.model.toolCalls` | every tool call: `turn`, `name`, `input` |
| `observation.app` | the app's exit code, stderr and stdout |

To find what went wrong: `checks` → the failing one's `evidence` → that turn in
`transcript` (what the model was handed, what it called) or that job or Slack call.

## What `--dry` proves, and what it doesn't

`--dry` swaps the model for the conformance mock's scripted one (through the same proxy,
so the recording path runs too). It needs no credential and takes a few seconds (12
cases in 4.7 s on a Mac Studio); CI runs it. It proves the harness: the app starts,
events are delivered, clicks land, everything is observed, checks evaluate, the report
and evidence are written.

It proves nothing about a prompt. The scripted model answers markers (`[clone]`,
`[exec] <command>`), not prose, takes one step per thread and never looks around; so a
step can carry a `dry:` text for it, its sandbox is the fake runner's (no simulated
shell), and no graded check is judged. Each case says what a dry run is judged on:
`dry: "passes"` — the scripted model satisfies the case's code checks too, which shows
they can pass (a check marked `realOnly` is left out); `dry: "runs"` — only that the
trial completed, with the checks evaluated and recorded as "not judged". The pull request
case only "runs": the scripted model asks for a pull request without changing anything,
which is exactly what that case must fail.

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
    sandbox: widgets,                  // what the sandbox answers (sandbox.ts, shell.ts)
    env: { PR_APPROVER: "anyone" },    // over the app's environment
  },
  conversation: [
    { mention: "run the tests", dry: "[clone]" },
    { as: "guest", click: "Approve", user: "UG1", until: "ephemeral" },
  ],
  checks: [
    ran("the channel's default repo is cloned", { command: / clone .*acme\/widgets\.git/ }),
    ran("the tests are run", { command: TEST_RUN }, { realOnly: true }),
    graded("the reply reports that the tests passed", RUBRICS.reportsTestsPassed),
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
- **A fact is a code check** (`checks.ts`): `ran` (runner jobs), `called` (the model's
  tool calls and their input), `said` / `neverSaid` (a fact in what people saw: a digit, a
  link), `modelNeverWrote` (the model's own text, before Lorehouse's guards), `github`,
  `uploaded`, `card`, `toldAlone`, and `check` for anything else. `before` / `after` a
  step (by its `as`) restricts a check in time: "nothing is pushed before the click".
  `required: false` reports a check without failing trials.
- **A judgment about prose is a graded check**: `graded(name, RUBRICS.x)`. Do not write a
  regex for "asks which repo" or "says it couldn't find it": both directions go wrong
  (a reply with no question mark is failed; "the code is 7731, I don't have the alarm
  code" is passed). Add a rubric to `rubrics.ts` instead, written as "Pass only if …",
  with at least two replies known to pass and two known to fail, the near misses
  especially, and run `--grader-selftest`.
- **Ask whether the check can fail.** For each check, name a reply or a run that should
  fail it and make sure it does (`test/evals-run.test.ts` does this for the shipped
  ones). A check that only another part of the system can make fail (the guard that
  rewrites mentions, say) is fine as an end-to-end check, as long as its `why` says so.
- **The sandbox** (`sandbox.ts`) is the fake runner unless the case scripts it. A code
  case gives it a `shell`: the repos GitHub has, their files as cloned, and the
  `programs` their scripts run (a test runner, a script) with what each prints or
  writes. Keep fixtures consistent with themselves: a model reads a script before running
  it, and notices when the output isn't what the source says. Prefer an output nobody
  could guess (the catalog's 137 entries) over one a model might invent. `refuse` makes
  the host refuse calls, as sandboxd does.
- Run it: `bun run eval --dry --only <id>`, then for real with `--trials 1`, and read the
  evidence file even when it passes: a check that passes for the wrong reason is worse
  than none.

### What the simulated shell is, and is not

A real model checks its tools: it runs `echo hello`, lists the directory, reads the file
it is about to change, looks at `git status` and `git log` after a commit, inspects a
chart before attaching it. Against a sandbox that answered `ran:<command>` it concluded,
rightly, that nothing was executing, and stopped (6 of 6 trials, 2026-11-19). So
`shell.ts` answers those commands as bash and git would, against files in memory:

- `echo`, `printf`, `pwd`, `cd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `find`,
  `sort`, `file`, `cp`, `mv`, `rm`, `mkdir`, `touch`, `chmod`, `tee`, `env`, `test`,
  `which`, `type`, `sleep`, `time`, `sed -n 'N,Mp'`; `&&`, `||`, `;`, pipes, `>`, `>>`,
  `<`, `2>`, `>&2`, `2>&1`, `&>`, here-documents, globs, `VAR=x cmd`, `export`, `$VAR`,
  `$?`, `set -e`;
- git: `clone` (only Lorehouse's own, with its credential helper, reaches GitHub),
  `status`, `add`, `commit` (`-a`, `-m`, `--amend`), `diff` (against the index, `HEAD`,
  a branch, `HEAD~1`, `A..B`, `A...B`; `--stat`, `--name-only`), `show`, `log`
  (`--oneline`, `--stat`, `--format`, `A..B`), `branch`, `checkout`, `switch`, `restore`,
  `reset` (`--soft`, `--hard`), `rev-parse`, `remote`, `config`, `ls-files`, `grep`.
  History is commits with trees, so what a commit did is what `log`, `show` and `diff`
  then say;
- a pull request's stage and push: the commits `HEAD` has that GitHub doesn't, with
  their files, diffstat, authors and patch, and with nothing committed the host's own
  "no commits to publish".

**It is not bash, and it is not a sandbox.** It runs no inline code (`python3 -c`), no
script that isn't one of the repo's `programs`, no loops, `$(…)`, subshells or background
`&`, no `git stash`, `rebase` or `merge`, and no build. Each of those is refused with
exit 126 and a line that says it is the eval's simulated shell and what it supports
(never a silent success), and is counted in `shellRefused`. In the acceptance run a model
was refused three times (`xxd`, `python3 -c`) and carried on. A case whose promise
depends on code really running needs a real sandbox, which this is not: that is KVM's
job (`sandbox/lab`), and running the code suite against one is future work.

## Cleaning up

A trial stops its app and mock and removes its temp directory when it ends. A run that
is interrupted (SIGINT, SIGTERM, SIGHUP) does the same and exits 130. A run that is
killed outright or crashes is cleaned up after by a small reaper process (`reaper.ts`)
that the runner tells what it started and made. Evidence under `evals/out/` is yours to
remove.

## Not here yet

- Comparing two git refs (#49): run the same cases in two worktrees and diff the two
  `summary.json` files by case and check. The pieces are here (`--out`, a stable summary
  shape); the command that makes the worktrees and prints the diff is not.
- The rest of #49's 15–30 knowledge cases (crediting the right author, digest shape).
- The code suite against a real sandbox, where code runs (above).
- A GitHub App in the mock: the code suite uses the development `GITHUB_TOKEN` path, as
  conformance does, because the mock GitHub has no installation endpoints.
- Real Slack, real GitHub: by design.
