// Which repo a code request works in (#126): the channel's default, the one named, or a
// question back when there is neither.

import type { Case } from "../case";
import { called, neverSaid, ran, said } from "../checks";
import { widgets } from "./widgets";

const clone = (repo: string) => new RegExp(` clone (--branch \\S+ )?https://github\\.com/${repo}\\.git /workspace/repo$`);
const WHICH_REPO = /which\b[^.?!\n]{0,40}\brepo(sitory)?\b|what\b[^.?!\n]{0,20}\brepo(sitory)?\b|\brepo(sitory)?\b[^.?!\n]{0,60}\?/i;

export const cases: Case[] = [
  {
    id: "default-repo",
    suite: "code",
    why: "In a channel with a default repo, \"run the tests\" needs no repo name: Scout clones the default and gets on with it.",
    dry: "passes",
    setup: { defaultRepo: { repo: "acme/widgets", branch: "main" }, sandbox: widgets },
    conversation: [{ mention: "run the tests", dry: "[clone]" }],
    checks: [
      ran("the channel's default repo is cloned", { command: clone("acme/widgets") }),
      ran("no other repo is cloned", { command: / clone .*github\.com\/(?!acme\/widgets\.git)/ }, { max: 0 }),
      neverSaid("the reply doesn't ask which repo", WHICH_REPO),
      ran("a test command is run", { command: /\btest\b/ }, { required: false }),
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
      ran("acme/gadgets is cloned", { command: clone("acme/gadgets") }),
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
      said("the reply asks which repo", WHICH_REPO),
    ],
  },
];
