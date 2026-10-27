// Q3, option (b): how big is the model input per turn as a thread grows, and what would a
// cap of N turns or M tokens leave? Drives the real app (src/server.ts) against the
// conformance mock with a synthetic channel (60 threads of 5 messages), and runs threads of
// 5, 20 and 50 mentions; the proxy logs every model request June sends.
// Sizes are characters of the request's JSON; tokens are ESTIMATED as chars / 4 (no API key
// here, so no count_tokens call). Caps are applied offline to the logged requests, dropping
// the oldest whole turns, and the capped transcript is re-checked for tool pairing.
//
//   bun docs/experiments/session-redaction/04-cap.ts [--cleanup]

import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnthropicMsg, type Fixture, cleanup, mention, modelRequests, pairingErrors, start } from "./harness.ts";

const dir = join(tmpdir(), "lorehouse-poc66", "cap");
cleanup(dir);

let seed = 85;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const WORDS = "deploy rollback staging review budget migration incident runbook owner metrics latency onboarding retro roadmap vendor contract invoice backup restore alert pager release freeze hotfix schema index cache quota region failover audit".split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");

// 60 synthetic threads, root + 4 replies, ~25 words each (a thread doc is ~900 chars, so
// search_knowledge's 500-char clip applies).
const fixture: Fixture = {
  _users: { U2: { name: "ana", profile: { real_name: "Ana A" } }, U3: { name: "ben", profile: { real_name: "Ben B" } }, U4: { name: "cy", profile: { real_name: "Cy C" } } } as unknown as unknown[],
  C1: Array.from({ length: 60 }, (_, i) => {
    const root = `${1790000000 + i * 100}.000100`;
    return [
      { ts: root, user: "U2", text: `deploy ${sentence(24)}` },
      ...Array.from({ length: 4 }, (_, j) => ({ ts: `${1790000000 + i * 100 + j + 1}.000100`, thread_ts: root, user: ["U2", "U3", "U4"][j % 3], text: sentence(25) })),
    ];
  }).flat(),
};

const est = (chars: number) => Math.round(chars / 4);
// Turn boundaries in an Anthropic request: a user message carrying text, not tool results.
const turnStarts = (ms: AnthropicMsg[]) => ms.map((m, i) => (m.role === "user" && (typeof m.content === "string" || m.content.some((b) => b.type === "text")) ? i : -1)).filter((i) => i >= 0);
const capTurns = (ms: AnthropicMsg[], n: number) => { const s = turnStarts(ms); return s.length <= n ? ms : ms.slice(s[s.length - n]); };
const capTokens = (ms: AnthropicMsg[], budget: number, fixed: number) => {
  const s = turnStarts(ms);
  for (const at of s) { const rest = ms.slice(at); if (est(fixed + JSON.stringify(rest).length) <= budget) return rest; }
  return ms.slice(s[s.length - 1]); // the current turn alone, even over budget
};

const run = await start(dir, fixture);
const out: Record<string, unknown> = { note: "chars = JSON length; tokens ≈ chars/4 (estimate)" };
try {
  for (const turns of [5, 20, 50]) {
    const before = (await modelRequests(run)).length;
    const first = await mention(run, `[q${turns}] deploy rollback runbook owner?`);
    for (let t = 1; t < turns; t++) await mention(run, `follow-up ${t}: ${sentence(6)}?`, first.ts);
    const reqs = (await modelRequests(run)).slice(before);
    const fixed = JSON.stringify({ system: reqs[0]!.body.system, tools: reqs[0]!.body.tools }).length;
    // per turn: the larger of its two calls (the second also carries the new tool result)
    const perTurn: { turn: number; messages: number; chars: number }[] = [];
    for (let i = 0; i < reqs.length; i += 2) {
      const r = reqs[i + 1] ?? reqs[i]!;
      perTurn.push({ turn: i / 2 + 1, messages: r.body.messages.length, chars: JSON.stringify(r.body.messages).length });
    }
    const last = reqs[reqs.length - 1]!.body.messages;
    const caps: Record<string, unknown> = {};
    for (const n of [3, 5, 10]) { const c = capTurns(last, n); caps[`last ${n} turns`] = { chars: JSON.stringify(c).length, estTokens: est(fixed + JSON.stringify(c).length), pairingErrors: pairingErrors(c).length }; }
    for (const m of [8000, 20000]) { const c = capTokens(last, m, fixed); caps[`${m} est. tokens`] = { turnsKept: turnStarts(c).length, chars: JSON.stringify(c).length, estTokens: est(fixed + JSON.stringify(c).length), pairingErrors: pairingErrors(c).length }; }
    out[`thread of ${turns}`] = {
      modelRequests: reqs.length,
      systemAndToolsChars: fixed,
      firstTurn: perTurn[0],
      lastTurn: { ...perTurn[perTurn.length - 1], estTokensWithSystem: est(fixed + perTurn[perTurn.length - 1]!.chars) },
      growthPerTurnChars: perTurn.length > 1 ? Math.round((perTurn[perTurn.length - 1]!.chars - perTurn[0]!.chars) / (perTurn.length - 1)) : 0,
      uncappedEstTokensSumOverTurns: perTurn.reduce((a, p) => a + est(fixed + p.chars), 0),
      perTurnChars: perTurn.map((p) => p.chars),
      capsOnLastTurn: caps,
    };
  }
} finally {
  await run.stop();
}
console.log(JSON.stringify(out, null, 2));
if (process.argv.includes("--cleanup")) cleanup(dir);
