// The grader of the evals' graded checks (evals/grader.ts): its answer is used only when
// it is strict JSON that quotes the reply; anything else, and any failed call, is "not
// judged", never a pass. Whether the grader model itself judges well is not something a
// unit test can hold: that is `bun run eval --grader-selftest`, whose table is held here.

import { afterEach, expect, test } from "bun:test";
import { noCredential } from "../evals/credential";
import { grader, GRADER_SYSTEM, graderPrompt, parseVerdict, selftest, type Grader } from "../evals/grader";
import { startProxy } from "../evals/proxy";
import { RUBRICS, type Rubric } from "../evals/rubrics";

const REPLY = "I couldn't find a door code for the Lisbon office.";

test("parseVerdict: strict JSON with a quote from the reply is a verdict", () => {
  expect(parseVerdict(' {"pass": true, "quote": "couldn\'t find a door code", "reason": "says it found nothing"}\n', REPLY)).toEqual({ judged: true, pass: true, evidence: 'grader: says it found nothing — quoting "couldn\'t find a door code"' });
  expect(parseVerdict('{"pass": false, "quote": "", "reason": "gives no admission"}', REPLY)).toEqual({ judged: true, pass: false, evidence: "grader: gives no admission" });
  expect(parseVerdict('{"pass": false, "quote": "for the Lisbon office", "reason": "names a code"}', REPLY)).toMatchObject({ judged: true, pass: false });
  // Whitespace in the quote may differ from the reply's.
  expect(parseVerdict('{"pass": true, "quote": "find a\\n door   code", "reason": "ok"}', REPLY)).toMatchObject({ judged: true, pass: true });
});

test("parseVerdict: anything else is not judged, never a pass", () => {
  const unusable: [string, string][] = [
    ['```json\n{"pass": true, "quote": "couldn\'t", "reason": "x"}\n```', "isn't JSON"],
    ["PASS", "isn't JSON"],
    ["", "isn't JSON"],
    ['{"pass": true, "quote": "couldn\'t find"} and more', "isn't JSON"],
    ['{"pass": "yes", "quote": "couldn\'t", "reason": "x"}', 'isn\'t {"pass": boolean'],
    ['{"pass": true, "reason": "x"}', 'isn\'t {"pass": boolean'],
    ['{"pass": true, "quote": "couldn\'t find"}', 'isn\'t {"pass": boolean'],
    ['[{"pass": true, "quote": "couldn\'t", "reason": "x"}]', 'isn\'t {"pass": boolean'],
    ["null", 'isn\'t {"pass": boolean'],
    // A quote that isn't in the reply: the grader made its evidence up.
    ['{"pass": true, "quote": "The code is not known to me", "reason": "x"}', "quoted words that aren't in the reply"],
    ['{"pass": false, "quote": "The door code is 7731", "reason": "x"}', "quoted words that aren't in the reply"],
    // A pass with nothing quoted: nothing in the reply was shown to decide it.
    ['{"pass": true, "quote": "", "reason": "looks fine"}', "without quoting what in it decided that"],
    ['{"pass": true, "quote": "   ", "reason": "looks fine"}', "without quoting what in it decided that"],
  ];
  for (const [answer, why] of unusable) {
    const v = parseVerdict(answer, REPLY);
    expect([answer, v.judged]).toEqual([answer, false]);
    expect(v.evidence).toStartWith("not judged: ");
    expect(v.evidence).toContain(why);
    expect("pass" in v).toBe(false);
  }
});

const stops: (() => unknown)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});
function upstream(answer: (n: number) => Response): { url: string; bodies: string[] } {
  const bodies: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.text()); return answer(bodies.length); } });
  stops.push(() => server.stop(true));
  return { url: `http://localhost:${server.port}`, bodies };
}
const message = (text: string) => Response.json({ id: "msg_g", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 200, output_tokens: 20 } });

test("the grader asks through the proxy with the fixed prompt; its tokens are counted under its own name", async () => {
  const up = upstream((n) => (n === 1 ? message('{"pass": true, "quote": "couldn\'t find a door code", "reason": "it says so plainly"}') : message("I think it passes.")));
  const proxy = startProxy({ credential: noCredential, maxTokens: 1_000_000 });
  stops.push(() => proxy.stop());
  const grade = grader(proxy.open("grader", up.url), proxy.key, "claude-haiku-5-5");
  expect(await grade(RUBRICS.saysNotFound, REPLY)).toEqual({ judged: true, pass: true, evidence: 'grader: it says so plainly — quoting "couldn\'t find a door code"' });
  // An answer that isn't the JSON asked for: not judged.
  expect(await grade(RUBRICS.saysNotFound, REPLY)).toMatchObject({ judged: false });
  const sent = JSON.parse(up.bodies[0]!) as { model: string; system: string; messages: { content: string }[] };
  expect(sent.model).toBe("claude-haiku-5-5");
  expect(sent.system).toBe(GRADER_SYSTEM);
  expect(sent.system).toContain('"quote"');
  expect(sent.messages[0]!.content).toBe(graderPrompt(RUBRICS.saysNotFound, REPLY));
  expect(sent.messages[0]!.content).toContain(`Criterion:\n${RUBRICS.saysNotFound.rubric}`);
  expect(sent.messages[0]!.content).toContain(`<reply>\n${REPLY}\n</reply>`);
  expect(proxy.tokens("grader")).toEqual({ input: 400, output: 40, cacheRead: 0, cacheWrite: 0 });
});

test("a grader call that fails is not judged, never a pass: an API error, a refusal of the budget, no upstream", async () => {
  const up = upstream(() => Response.json({ type: "error", error: { type: "invalid_request_error", message: "model: claude-nope not found" } }, { status: 400 }));
  const proxy = startProxy({ credential: noCredential, maxTokens: 1_000_000 });
  stops.push(() => proxy.stop());
  const failed = await grader(proxy.open("grader", up.url), proxy.key, "claude-nope")(RUBRICS.saysNotFound, REPLY);
  expect(failed.judged).toBe(false);
  expect(failed.evidence).toContain("not judged: the grader call failed: 400");
  expect(failed.evidence).toContain("claude-nope not found");

  const broke = startProxy({ credential: noCredential, maxTokens: 0 });
  stops.push(() => broke.stop());
  const refused = await grader(broke.open("grader", up.url), broke.key, "claude-haiku-5-5")(RUBRICS.saysNotFound, REPLY);
  expect(refused).toMatchObject({ judged: false, evidence: expect.stringContaining("eval budget exceeded") });

  const nowhere = await grader(proxy.open("gone", "http://127.0.0.1:1"), proxy.key, "claude-haiku-5-5")(RUBRICS.saysNotFound, REPLY);
  expect(nowhere.judged).toBe(false);
}, 30_000);

test("the self-test grades every rubric's known replies and says which verdicts are wrong", async () => {
  const rubrics: Rubric[] = [{ id: "r1", rubric: "x", good: ["good one", "good two"], bad: ["bad one"] }, { id: "r2", rubric: "y", good: ["fine"], bad: ["bad two", "odd"] }];
  // A grader that judges by the word, and has no verdict for "odd".
  const byWord: Grader = async (_r, reply) => (reply === "odd" ? { judged: false, evidence: "not judged: the grader's answer isn't JSON" } : { judged: true, pass: !reply.startsWith("bad"), evidence: `grader: ${reply}` });
  const rows = await selftest(byWord, rubrics);
  expect(rows.map((r) => [r.rubric, r.expect, r.reply, r.got, r.right])).toEqual([
    ["r1", "pass", "good one", "pass", true], ["r1", "pass", "good two", "pass", true], ["r1", "fail", "bad one", "fail", true],
    ["r2", "pass", "fine", "pass", true], ["r2", "fail", "bad two", "fail", true],
    // No verdict is not the failure the example deserves: it is wrong.
    ["r2", "fail", "odd", "not judged", false],
  ]);
  // The bug this exists to catch: a grader that passes everything gets every bad example wrong.
  const yes: Grader = async () => ({ judged: true, pass: true, evidence: "grader: fine" });
  const lenient = await selftest(yes, rubrics);
  expect(lenient.filter((r) => !r.right).map((r) => r.reply)).toEqual(["bad one", "bad two", "odd"]);
  // And one that fails everything gets every good example wrong.
  const no: Grader = async () => ({ judged: true, pass: false, evidence: "grader: no" });
  expect((await selftest(no, rubrics)).filter((r) => !r.right).map((r) => r.reply)).toEqual(["good one", "good two", "fine"]);
});

test("every rubric has replies known to pass and known to fail, for the self-test to hold the grader to", () => {
  const ids = Object.values(RUBRICS).map((r) => r.id);
  expect(new Set(ids).size).toBe(ids.length);
  for (const r of Object.values(RUBRICS)) {
    expect(r.rubric).toContain("Pass only if");
    expect(r.good.length).toBeGreaterThanOrEqual(2);
    expect(r.bad.length).toBeGreaterThanOrEqual(2);
    expect(r.good.filter((x) => r.bad.includes(x))).toEqual([]);
  }
});
