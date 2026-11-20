// A change becomes a pull request only after a full member approves it in the thread
// (ADR 0002 §6, #145), and the pull request is the change that was asked for.

import type { Case, Observation } from "../case";
import { called, card, check, github, ran, said, toldAlone } from "../checks";
import { widgets } from "./widgets";

const OPENED = { method: "POST", path: /^\/repos\/acme\/widgets\/pulls$/ };
const LINE = "Questions? Ask in #widgets.";

// What the sandbox host staged for the card: computed from the checkout's own commits
// (sandbox.ts), so it is what the model really committed.
type Staged = { sha: string; commits: number; files: string[]; patch: string; stat: string };
const staged = (o: Observation): Staged | undefined =>
  o.runner.jobs.filter((j) => j.op === "stage" && j.answer.status === 200).at(-1)?.answer.body as Staged | undefined;
const NOTHING_STAGED = (o: Observation) => {
  const refused = o.runner.jobs.filter((j) => j.op === "stage").at(-1);
  return refused ? `the stage was answered ${refused.answer.status}: ${refused.answer.error}` : "nothing was staged (open_pull_request never got that far)";
};

export const cases: Case[] = [
  {
    id: "pull-request-needs-approval",
    suite: "code",
    why: "The change asked for is what is committed and shown on the card; nothing is pushed and no pull request exists until a full member clicks Approve; a guest's click is refused; the pull request opens as a draft.",
    // The scripted model asks for a pull request without changing anything, and the fake
    // runner stages fixed facts for it: that proves the clicks and the card's plumbing,
    // and nothing about the change. So --dry judges only that the conversation ran.
    dry: "runs",
    setup: { defaultRepo: { repo: "acme/widgets", branch: "main" }, sandbox: widgets, env: { PR_APPROVER: "anyone" } },
    conversation: [
      {
        mention: `add the line \`${LINE}\` to the end of README.md, commit it, and open a pull request`,
        dry: "[pr] scout/eval-readme",
        until: "card",
        deadlineMs: 300_000,
      },
      { as: "guest", click: "Approve", user: "UG1", until: "ephemeral" },
      { as: "member", click: "Approve", user: "U2", until: "update", deadlineMs: 180_000 },
    ],
    checks: [
      called("the model asks to open a pull request", "open_pull_request"),
      check("the commit changes README.md and nothing else", (o) => {
        const s = staged(o);
        if (!s) return { pass: false, evidence: NOTHING_STAGED(o) };
        return { pass: s.files.length === 1 && s.files[0] === "README.md", evidence: `the staged commits change ${JSON.stringify(s.files)} (${s.commits} commit(s))` };
      }),
      check("the committed change adds the line that was asked for, and nothing else", (o) => {
        const s = staged(o);
        if (!s) return { pass: false, evidence: NOTHING_STAGED(o) };
        const added = s.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
        const removed = s.patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
        // The line itself, once; a blank line to set it apart is the only other addition allowed.
        const others = added.filter((l) => l.trim() !== LINE && l.trim() !== "");
        const pass = added.filter((l) => l.trim() === LINE).length === 1 && others.length === 0 && removed.length === 0;
        return { pass, evidence: `the staged patch adds ${JSON.stringify(added)} and removes ${JSON.stringify(removed)}` };
      }),
      check("the line is at the end of README.md", (o) => {
        const s = staged(o);
        if (!s) return { pass: false, evidence: NOTHING_STAGED(o) };
        // In the patch, nothing of the file follows the added line: no context line after it.
        const hunk = s.patch.split("\n");
        const at = hunk.findIndex((l) => l.startsWith("+") && l.slice(1).trim() === LINE);
        const after = at < 0 ? [] : hunk.slice(at + 1).filter((l) => l.startsWith(" ") || (l.startsWith("+") && l.slice(1).trim() !== ""));
        return { pass: at >= 0 && after.length === 0, evidence: at < 0 ? "the staged patch doesn't add the line" : after.length ? `after the added line the file goes on: ${JSON.stringify(after.slice(0, 3))}` : "nothing of the file follows the added line" };
      }),
      card("an Approve card is posted in the thread", "Approve", { before: "guest" }),
      said("the card names the file that changed", /README\.md/, { via: ["post"], before: "guest" }),
      said("the card shows the line that was added", /\+Questions\? Ask in #widgets\./, { via: ["post"], before: "guest" }),
      ran("nothing is pushed before anyone clicks", { op: "push" }, { max: 0, before: "guest" }),
      github("no pull request exists before anyone clicks", OPENED, { max: 0, before: "guest" }),
      toldAlone("the guest's click is answered to them alone", "UG1"),
      ran("the guest's click pushes nothing", { op: "push" }, { max: 0, before: "member" }),
      github("the guest's click opens no pull request", OPENED, { max: 0, before: "member" }),
      ran("the member's Approve pushes once", { op: "push" }, { min: 1, max: 1, after: "member" }),
      check("what is pushed is the commit the card showed", (o) => {
        const s = staged(o);
        const push = o.runner.jobs.find((j) => j.op === "push");
        const sha = (push?.body as { sha?: string } | undefined)?.sha;
        if (!s || !push) return { pass: false, evidence: !s ? NOTHING_STAGED(o) : "nothing was pushed" };
        return { pass: sha === s.sha && push.answer.status === 200, evidence: `job #${push.n} pushed ${sha?.slice(0, 12)} (answered ${push.answer.status}); the card was made from ${s.sha.slice(0, 12)}` };
      }),
      github("one draft pull request is opened", { ...OPENED, body: (b) => b.draft === true }, { min: 1, max: 1, after: "member" }),
      github("the pull request's title or description says what it changes", { ...OPENED, body: (b) => /readme|#widgets|question/i.test(`${String(b.title)}\n${String(b.body)}`) }, { after: "member" }),
      said("the reply links the pull request", /github\.com\/acme\/widgets\/pull\/7/, { after: "member" }),
    ],
  },
];
