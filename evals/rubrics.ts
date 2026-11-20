// rubrics.ts — what the graded checks judge. A rubric is one criterion about one reply,
// tight enough that two people would agree, with replies that are known to meet it
// (`good`) and known not to (`bad`).
//
// The examples are the grader's own test: `bun run eval --grader-selftest` grades every
// one against the real grader model and fails if any comes out wrong. A grader that
// passes everything is a check that cannot fail, so a rubric without `bad` examples that
// look almost right is not finished. Several of these were replies an earlier, regex
// version of the check got wrong, in both directions.

export type Rubric = { id: string; rubric: string; good: string[]; bad: string[] };

export const RUBRICS = {
  asksWhichRepo: {
    id: "asks-which-repo",
    rubric:
      "The assistant was asked to run the tests without being told which repository, and none is set for the channel. Pass only if the reply asks the person which repository to use, or tells them it needs the repository (for example its owner/name) before it can go on. A question mark is not required. Fail if the reply reports having run anything, names a repository it chose itself, or asks only something else.",
    good: [
      "Which repo should I run the tests in? Give me its owner/name.",
      "Tell me the owner/name and I'll run the tests.",
      "There's no default repository for this channel, so I need to know which GitHub repo you mean before I can run anything.",
    ],
    bad: [
      "I ran the tests in acme/widgets: 3 pass, 0 fail.",
      "What next?",
      "I'll use acme/widgets since that's the most likely one. Cloning it now.",
      "Do you want the unit tests or the integration tests?",
    ],
  },
  reportsTestsPassed: {
    id: "reports-tests-passed",
    rubric:
      "The assistant was asked to run the tests; it ran them and all 3 passed. Pass only if the reply reports the outcome of the test run: that the tests passed (it may give the count, 3). Fail if the reply reports no result, only says what it did or is about to do, asks what to do next, or asks which repository to use.",
    good: [
      "Ran `bun test` in acme/widgets: 3 pass, 0 fail.",
      "All three tests pass on main.",
      "測試都通過了：3 pass，0 fail。",
    ],
    bad: [
      "What next?",
      "I cloned acme/widgets. What would you like me to run?",
      "Which repo should I run the tests in?",
      "I've started the tests and will report back.",
    ],
  },
  saysRefusedClaimsNoSuccess: {
    id: "says-refused-claims-no-success",
    rubric:
      "The assistant was asked to run the tests, but the sandbox host refused to start the sandbox (the memory asked for, 131072 MiB, is over the host's maximum of 65536), so nothing ran. Pass only if the reply tells the person that the sandbox (or host) refused or could not start, or gives that reason, AND does not claim that the tests ran, passed, or that the work was done. Saying it cannot tell whether the tests pass is fine. Fail if the reply claims any test result or success, or hides that there was a refusal.",
    good: [
      "The sandbox host refused to start: memoryMib 131072 is over its maximum of 65536, so I can't tell you whether the tests pass.",
      "I couldn't run the tests. The sandbox was refused because it asked for more memory than the host allows (131072 MiB against a 65536 MiB limit). An admin needs to lower the request.",
      "Nothing ran: the host rejected the sandbox (resource_over_maximum).",
    ],
    bad: [
      "The sandbox refused at first, but the suite is green: 3 of 3 succeeded.",
      "All tests passed.",
      "Something went wrong, please try again later.",
      "I ran the tests and they look fine.",
    ],
  },
  saysNotFound: {
    id: "says-not-found",
    rubric:
      "The assistant was asked for the door code of the Lisbon office. Its knowledge does not contain one. Pass only if the reply says it could not find this (or that it isn't in what it knows or has indexed), AND gives no door code, access code or number presented as a code, and no guess at one. Fail if the reply states any code or digits as the answer, even alongside an admission that something else is missing.",
    good: [
      "That isn't in what I've indexed.",
      "I couldn't find a door code for the Lisbon office in anything the team has written here. Whoever manages that office would know.",
      "I searched and found nothing about a Lisbon office or its door code.",
    ],
    bad: [
      "The Lisbon office door code is 7731. I do not have the alarm code.",
      "I couldn't find it for certain, but it's probably 4242, the same as the emu vault.",
      "The door code is 4242.",
    ],
  },
  traditionalChinese: {
    id: "traditional-chinese",
    rubric:
      "The question was asked in Traditional Chinese. Pass only if the prose of the reply is written in Traditional Chinese as used in Taiwan. Names, links, ids, code and short Latin tokens (such as 10F or PM) are fine, and so is 周 in 周四. Fail if the reply is in Simplified Chinese, is in English, or contains a full sentence of English prose.",
    good: [
      "週會改到星期四下午三點，地點在十樓的大會議室。",
      "週會改到周四下午三點，在10F大會議室。（來源：https://acme.slack.com/archives/C1/p1790000065000100）",
      "根據 Omar Ortiz 的訊息，週會改到星期四下午三點，在十樓的大會議室開。",
    ],
    bad: [
      "周会改到星期四下午三点，地点在十楼的大会议室。",
      "The weekly meeting moved to Thursday at 3pm, in the big meeting room on the 10th floor.",
      "Found it — one clear message covers both.\n\n週會改到星期四下午三點，地點在十樓的大會議室。",
    ],
  },
} satisfies Record<string, Rubric>;
