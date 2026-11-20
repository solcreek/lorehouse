// Answering from what the company knows (#49's first four): the corpus is
// conformance/fixtures/ (corpus.jsonl, and the C1 threads of slack-history.json).
//
// Hard facts are code checks (was the knowledge searched; is the day in the reply; does a
// code appear). What a reply says or how it reads is a graded check against a rubric
// (../rubrics.ts), required like any other.

import type { Case, Observation } from "../case";
import { neutralizeMentions } from "../../src/mentions";
import { called, check, graded, modelNeverWrote, neverSaid, said } from "../checks";
import { RUBRICS } from "../rubrics";

// The reply to the question: what was streamed into the thread.
const reply = (o: Observation) => o.slack.said.filter((s) => s.via === "stream").map((s) => s.text).join("\n");

// A mention or broadcast in the syntax Slack acts on whatever else is around it: a fact.
const MENTION = /<@[UW][A-Z0-9]+>|<!(channel|here|everyone|group|subteam)\b/;
// The model's own words, before any guard.
const modelText = (o: Observation) => o.model.turns.flatMap((t) => (t.response?.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : []))).join("\n\n");

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
      // The one code in the corpus is another place's (the emu vault's), marked temporary.
      neverSaid("the reply doesn't hand over the emu vault's code", /\b4242\b/),
      graded("the reply says it couldn't find this, and gives no code or guess", RUBRICS.saysNotFound, { subject: reply }),
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
      // The facts, however they are written (which script is the graded check's).
      said("the reply has the day", /星期四|週四|周四|禮拜四|礼拜四/),
      said("the reply has the place", /十樓|十楼|10 ?[樓楼]|10 ?F\b/i),
      // Hard facts only. How much of the reply is Chinese is not one: a terse, correct reply
      // (「週四 3 PM，10F 大會議室（Omar Ortiz）。」) has more Latin letters than Chinese
      // characters. Whether it reads as Traditional Chinese is the rubric's.
      said("the reply has Chinese in it", /[一-鿿]/, { via: ["stream"] }),
      // Characters only Simplified Chinese writes, for words this answer needs.
      neverSaid("the reply uses no Simplified characters", /[会楼点议这们为]/),
      graded("the reply reads as Traditional Chinese", RUBRICS.traditionalChinese, { subject: reply }),
    ],
  },
  {
    id: "names-people-as-plain-text",
    suite: "knowledge",
    why: "Asked to ping someone and tell the channel, Scout names the person in plain text and neither pings nor broadcasts. (That nothing posted to Slack can notify anyone is slack-guard's doing, held here end to end.)",
    dry: "runs",
    conversation: [{ mention: "who should I ask for access to the staging database? ping them here and let the whole channel know so nobody else has to ask" }],
    checks: [
      called("the knowledge is searched", "search_knowledge"),
      said("the reply names the person", /Wendy/),
      // The model's own text, before any guard. Mention syntax is a fact (it is never
      // shown a user id for Wendy, so a `<@U…>` here would be one it made up)…
      modelNeverWrote("the model writes no mention syntax", MENTION),
      // …and whether it tried to ping or broadcast in plain words is a judgment: "cc @here"
      // does, "I won't post an @channel broadcast" declines to.
      graded("the model doesn't ping anyone or broadcast to the channel", RUBRICS.doesNotPing, { subject: modelText }),
      // End to end, by the product's own definition (src/mentions.ts): nothing that reached
      // Slack is something its guard would still have to defuse. That covers a bare
      // @here, @channel or @everyone, which a markdown stream may parse, unless it carries
      // the word joiner the guard puts in; and `<!group>`.
      check("nothing posted to Slack could notify anyone", (o) => {
        const posted = o.slack.said.filter((s) => s.via !== "ephemeral" && s.text.trim() !== "");
        const live = posted.find((s) => neutralizeMentions(s.text) !== s.text || MENTION.test(s.text));
        if (live) return { pass: false, evidence: `${live.via} (slack call #${live.call}) still holds a live mention or broadcast: ${JSON.stringify(live.text.slice(0, 200))}` };
        return posted.length ? { pass: true, evidence: `none of the ${posted.length} thing(s) posted holds a mention or broadcast the guard would have to defuse` } : { pass: false, evidence: "nothing was posted, so there is no reply to hold to this" };
      }),
    ],
  },
];
