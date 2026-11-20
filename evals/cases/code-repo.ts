// Which repo a code request works in (#126): the channel's default, the one named, or a
// question back when there is neither.

import type { Case } from "../case";
import { called, graded, ran } from "../checks";
import { RUBRICS } from "../rubrics";
import { widgets } from "./widgets";

const clone = (repo: string) => new RegExp(` clone (--branch \\S+ )?https://github\\.com/${repo}\\.git /workspace/repo$`);
// The repo's test runner being run, alone or in a chain: not `ls test/` or `cat test/x`.
const TEST_RUN = /(^|&&|\|\||;)\s*([A-Z_]+=\S+ )*(time )?(bun test|(bun|npm|yarn|pnpm) run test|npm test)\b/;

// The test runner's own summary of a run in which every test passed.
const PASSED = /^ *[1-9]\d* pass\n *0 fail\n/m;

export const cases: Case[] = [
  {
    id: "default-repo",
    suite: "code",
    why: "In a channel with a default repo, \"run the tests\" needs no repo name: Scout clones the default, runs the tests and says how they went.",
    dry: "passes",
    setup: { defaultRepo: { repo: "acme/widgets", branch: "main" }, sandbox: widgets },
    conversation: [{ mention: "run the tests", dry: "[clone]" }],
    checks: [
      ran("the channel's default repo is cloned", { command: clone("acme/widgets"), succeeded: true }),
      ran("no other repo is cloned", { command: / clone .*github\.com\/(?!acme\/widgets\.git)/ }, { max: 0 }),
      // Run, and seen to pass: the command exited 0 and printed the test runner's own
      // passing summary. A command that was refused, failed, or printed something else is
      // no evidence, whatever the reply then says. (Not under --dry: the scripted model
      // takes one step, the clone.)
      ran("the tests are run, and pass", { command: TEST_RUN, succeeded: true, output: PASSED }, { realOnly: true }),
      graded("the reply reports that the tests passed", RUBRICS.reportsTestsPassed),
    ],
  },
  {
    id: "named-repo-wins",
    suite: "code",
    why: "A request that names a repo works in that repo, not the channel's default.",
    dry: "passes",
    setup: { defaultRepo: { repo: "acme/widgets", branch: "main" }, sandbox: widgets },
    conversation: [{ mention: "run the tests in acme/gadgets", dry: "[clone] acme/gadgets" }],
    checks: [
      called("workspace_clone names acme/gadgets", "workspace_clone", { input: (i) => /acme\/gadgets/i.test(String(i.repo)) }),
      ran("acme/gadgets is cloned", { command: clone("acme/gadgets"), succeeded: true }),
      ran("the channel's default is not cloned", { command: clone("acme/widgets") }, { max: 0 }),
    ],
  },
  {
    id: "no-default-asks",
    suite: "code",
    why: "With no default repo and none named, Scout asks which repo instead of guessing one.",
    dry: "passes",
    setup: { sandbox: widgets },
    conversation: [{ mention: "run the tests", dry: "[clone]" }],
    checks: [
      ran("nothing is cloned", { command: / clone / }, { max: 0 }),
      called("no workspace_clone names a repo the request didn't", "workspace_clone", { max: 0, input: (i) => typeof i.repo === "string" && i.repo !== "" }),
      graded("the reply asks which repo", RUBRICS.asksWhichRepo),
    ],
  },
];
