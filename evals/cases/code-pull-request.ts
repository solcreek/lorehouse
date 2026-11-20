// A change becomes a pull request only after a full member approves it in the thread
// (ADR 0002 §6, #145).

import type { Case } from "../case";
import { called, card, github, ran, said, toldAlone } from "../checks";
import { widgets } from "./widgets";

const OPENED = { method: "POST", path: /^\/repos\/acme\/widgets\/pulls$/ };

export const cases: Case[] = [
  {
    id: "pull-request-needs-approval",
    suite: "code",
    why: "Nothing is pushed and no pull request exists until a full member clicks Approve; a guest's click is refused; the pull request opens as a draft.",
    dry: "passes",
    setup: { defaultRepo: { repo: "acme/widgets", branch: "main" }, sandbox: widgets, env: { PR_APPROVER: "anyone" } },
    conversation: [
      {
        mention: "add the line `Questions? Ask in #widgets.` to the end of README.md, commit it, and open a pull request",
        dry: "[pr] scout/eval-readme",
        until: "card",
        deadlineMs: 300_000,
      },
      { as: "guest", click: "Approve", user: "UG1", until: "ephemeral" },
      { as: "member", click: "Approve", user: "U2", until: "update", deadlineMs: 180_000 },
    ],
    checks: [
      called("the model asks to open a pull request", "open_pull_request"),
      card("an Approve card is posted in the thread", "Approve", { before: "guest" }),
      ran("nothing is pushed before anyone clicks", { op: "push" }, { max: 0, before: "guest" }),
      github("no pull request exists before anyone clicks", OPENED, { max: 0, before: "guest" }),
      toldAlone("the guest's click is answered to them alone", "UG1"),
      ran("the guest's click pushes nothing", { op: "push" }, { max: 0, before: "member" }),
      github("the guest's click opens no pull request", OPENED, { max: 0, before: "member" }),
      ran("the member's Approve pushes once", { op: "push" }, { min: 1, max: 1, after: "member" }),
      github("one draft pull request is opened", { ...OPENED, body: (b) => b.draft === true }, { min: 1, max: 1, after: "member" }),
      said("the reply links the pull request", /github\.com\/acme\/widgets\/pull\/7/, { after: "member" }),
    ],
  },
];
