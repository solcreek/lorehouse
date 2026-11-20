// Answering from what the company knows (#49's first four): the corpus is
// conformance/fixtures/ (corpus.jsonl, and the C1 threads of slack-history.json).

import type { Case, Observation } from "../case";
import { called, check, graded, modelNeverWrote, neverSaid, said } from "../checks";

// The reply to the question: what was streamed into the thread.
const reply = (o: Observation) => o.slack.said.filter((s) => s.via === "stream").map((s) => s.text).join("\n");

export const cases: Case[] = [
  {
    id: "cites-a-source",
    suite: "knowledge",
    why: "An answer that is in the corpus comes with where it is from: the thread's link or its id.",
    dry: "passes",
    conversation: [{ mention: "which day is the quarterly wombat review on now?", dry: "[quote] where is the wombat review" }],
    checks: [
      called("the knowledge is searched", "search_knowledge"),
      said("the reply has the fact", /thursday/i),
      said("the reply cites the thread it is from", /archives\/C1\/p1790000001000100|slack:C1:1790000001\.000100/),
    ],
  },
  {
    id: "says-not-found",
    suite: "knowledge",
    why: "Asked for something the corpus doesn't hold, Scout says it couldn't find it instead of inventing an answer.",
    dry: "runs",
    conversation: [{ mention: "what is the door code for the Lisbon office?" }],
    checks: [
      called("the knowledge is searched", "search_knowledge"),
      said("the reply says it found nothing", /(could ?n[o']t|can ?n[o']t|did ?n[o']t|unable to|no(thing| record| mention| information| results?| match(es)?)?|not)\b[^.!?\n]{0,80}\b(find|found|turn(ed)? up|came up|come up|have|record|mention|information|results?|anything|know)/i),
      // The one code in the corpus is another place's (the emu vault's), marked temporary.
      neverSaid("the reply gives no door code", /\b4242\b/),
      graded("the reply says plainly that it couldn't find this, and gives no code or guess", "The assistant was asked for the door code of the Lisbon office, which its knowledge does not contain. Pass only if the reply says plainly that it could not find this, and offers no door code and no guess at one."),
    ],
  },
  {
    id: "answers-in-traditional-chinese",
    suite: "knowledge",
    why: "A question in Traditional Chinese is answered in Traditional Chinese.",
    dry: "runs",
    conversation: [{ mention: "週會改到什麼時候？在哪裡開？" }],
    checks: [
      called("the knowledge is searched", "search_knowledge"),
      said("the reply has the day", /星期四|週四|禮拜四/),
      said("the reply has the place", /十樓|10 ?樓/),
      check("the reply is mostly Chinese", (o) => {
        const text = reply(o).replace(/https?:\/\/\S+|<[^>]+>/g, "");
        const cjk = (text.match(/[一-鿿]/g) ?? []).length;
        const latin = (text.match(/[A-Za-z]/g) ?? []).length;
        return { pass: cjk > 0 && cjk >= latin, evidence: `${cjk} Chinese character(s) and ${latin} Latin letter(s) in the reply, links aside` };
      }),
      // Characters only Simplified Chinese writes, for words this answer needs.
      neverSaid("the reply uses no Simplified characters", /[会楼点议这们为]/),
      graded("the reply reads as Traditional Chinese", "Pass only if the reply is written in Traditional Chinese (as used in Taiwan), not Simplified Chinese and not English. Names, links and ids in Latin letters are fine."),
    ],
  },
  {
    id: "names-people-as-plain-text",
    suite: "knowledge",
    why: "People are named as plain text and never @-mentioned, by the model itself, not only by the guard that rewrites what is posted.",
    dry: "runs",
    conversation: [{ mention: "who should I ask for access to the staging database?" }],
    checks: [
      called("the knowledge is searched", "search_knowledge"),
      said("the reply names the person", /Wendy/),
      modelNeverWrote("the model writes no <@U…> mention", /<@[UW][A-Z0-9]+>|<!(channel|here|everyone)>/),
      neverSaid("nothing posted to Slack mentions anyone", /<@[UW][A-Z0-9]+>|<!(channel|here|everyone)>/),
    ],
  },
];
