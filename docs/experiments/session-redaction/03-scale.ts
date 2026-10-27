// Q2/Q4 at scale: how long does redaction (option a) and a per-channel purge (#85) take on
// a SESSIONS_DB with many threads? The DB is written by June's own NativeRuntime (the
// scratch copy from 02-redact.ts, same store code as production) running real turns with
// a scripted model and a synthetic search tool shaped like search_knowledge's result (5 hits,
// text clipped at 500 chars). No app, no Slack: this measures the store, not the agent.
//
//   bun docs/experiments/session-redaction/03-scale.ts [--sessions 1000] [--turns 20] [--cleanup]

import { Database } from "bun:sqlite";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lorehouseRewrite, patchedJune } from "./02-redact.ts";
import { markerHits } from "./01-where.ts";

const arg = (name: string, d: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SESSIONS = arg("sessions", 1000);
const TURNS = arg("turns", 20);
const CHANNELS = ["C1", "C2", "C3", "C4"];
const DOCS = 300;
const MARKER = "OKAPIMARKER";
const dir = join(tmpdir(), "lorehouse-poc66", "scale");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const built = join(dir, "built.db");

// Deterministic pseudo-random (mulberry32), so a rerun builds the same DB.
let seed = 66;
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const WORDS = "deploy rollback staging review budget migration incident runbook owner metrics latency onboarding retro roadmap vendor contract invoice backup restore alert pager release freeze hotfix schema index cache quota region failover audit".split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(" ");
const corpus = Array.from({ length: DOCS }, (_, i) => {
  const ts = `${1790000000 + i * 100}.000100`;
  const text = (i === 0 ? `the vault phrase is ${MARKER}. ` : "") + Array.from({ length: 5 }, () => `— Person ${Math.floor(rnd() * 40)}, 2026-09-${10 + (i % 18)}\n${sentence(18)}`).join("\n\n");
  return { id: `slack:C1:${ts}`, title: sentence(8).slice(0, 80), source: `https://acme.slack.com/archives/C1/p${ts.replace(".", "")}`, text: text.slice(0, 500) };
});
const target = corpus[0]!;

// The scripted model: a user message → one search_knowledge call; a tool result → an answer
// of ~700 chars that cites the first hit's permalink half the time and paraphrases otherwise.
let callN = 0;
const model = (msgs: { role: string; result?: unknown }[]) => (async function* () {
  const last = msgs[msgs.length - 1]!;
  if (last.role === "user") {
    yield { type: "done" as const, reply: { text: "", toolCalls: [{ id: `toolu_${++callN}`, name: "search_knowledge", input: { query: sentence(5) } }] } };
    return;
  }
  const hits = JSON.parse(String(last.result)) as { source: string; text: string }[];
  const cite = rnd() < 0.5 ? ` Source: ${hits[0]!.source}` : "";
  yield { type: "done" as const, reply: { text: `From what I found: ${hits[0]!.text.slice(0, 300)} … ${sentence(40)}.${cite}`, toolCalls: [] } };
})();
const search = {
  spec: { name: "search_knowledge", description: "search", input: { type: "object" } },
  run: () => JSON.stringify(Array.from({ length: 5 }, () => corpus[Math.floor(rnd() * DOCS)])),
};

const june = await patchedJune();
const size = (p: string) => Math.round(statSync(p).size / 1e5) / 10; // MB, 1 decimal
const out: Record<string, unknown> = { sessions: SESSIONS, turns: TURNS, channels: CHANNELS.length, corpusDocs: DOCS };

// Build.
{
  const t0 = performance.now();
  const rt = await june.createNativeRuntime({ lorehouse: { model, tools: [search] } }, built);
  const keys = Array.from({ length: SESSIONS }, (_, i) => `slack:${CHANNELS[i % CHANNELS.length]}:${2000000000 + i}.000100`);
  for (let i = 0; i < keys.length; i += 50) {
    // 50 threads at a time, each thread's turns in order (one actor serializes them anyway)
    await Promise.all(keys.slice(i, i + 50).map(async (k) => { for (let t = 0; t < TURNS; t++) await rt.session("lorehouse", k).turn({ userText: `<@UBOT> ${sentence(10)}?` }); }));
  }
  await rt.close();
  const db = new Database(built, { readonly: true });
  const n = (sql: string) => (db.query(sql).get() as { n: number }).n;
  out.build = {
    seconds: Math.round((performance.now() - t0) / 100) / 10,
    fileMB: size(built),
    messages: n("SELECT count(*) AS n FROM agent_messages"),
    steps: n("SELECT count(*) AS n FROM agent_steps"),
    toolRowsNamingTarget: n(`SELECT count(*) AS n FROM agent_messages WHERE json_extract(body,'$.role') = 'tool' AND instr(body, '${target.id}') > 0`),
    sessionsNamingTarget: n(`SELECT count(DISTINCT session_id) AS n FROM agent_messages WHERE instr(body, '${target.id}') > 0`),
    markerBytes: markerHits(built, MARKER),
  };
  db.close();
}

const placeholder = "[redacted: this content came from a message that no longer exists]";
const needles = [target.id, target.source.split("/").pop()!];

// (a) redact the target thread everywhere (the deleted message's thread was quoted in many
// other threads' sessions), then VACUUM.
{
  const p = join(dir, "redact.db");
  cpSync(built, p);
  const rt = await june.createNativeRuntime({ lorehouse: { model, tools: [] } }, p);
  const report = rt.redact({ needles, rewrite: lorehouseRewrite(target.id, placeholder), placeholder, vacuum: true });
  await rt.close();
  out.redactAll = { report, markerBytesAfter: markerHits(p, MARKER), fileMB: size(p) };
  rmSync(p, { force: true });
}
// (a) the same, limited to one session's key (the cost when June knows where to look).
{
  const p = join(dir, "redact-one.db");
  cpSync(built, p);
  const db = new Database(p, { readonly: true });
  const one = (db.query(`SELECT session_id AS s FROM agent_messages WHERE instr(body, '${target.id}') > 0 LIMIT 1`).get() as { s: string }).s;
  db.close();
  const rt = await june.createNativeRuntime({ lorehouse: { model, tools: [] } }, p);
  const report = rt.redact({ sessionPrefix: one, needles, rewrite: lorehouseRewrite(target.id, placeholder), placeholder });
  await rt.close();
  out.redactOneSession = { session: one, report };
  rmSync(p, { force: true });
}
// #85: purge one channel's sessions (a quarter of them), then VACUUM.
{
  const p = join(dir, "purge.db");
  cpSync(built, p);
  const rt = await june.createNativeRuntime({ lorehouse: { model, tools: [] } }, p);
  const report = rt.purgeSessions({ sessionPrefix: "lorehouse:slack:C2:", vacuum: true });
  await rt.close();
  const db = new Database(p, { readonly: true });
  const left = (db.query("SELECT count(*) AS n FROM agent_messages WHERE session_id LIKE 'lorehouse:slack:C2:%'").get() as { n: number }).n;
  db.close();
  out.purgeChannel = { report, rowsLeftForC2: left, fileMB: size(p) };
  rmSync(p, { force: true });
}
console.log(JSON.stringify(out, null, 2));
if (process.argv.includes("--cleanup")) { rmSync(dir, { recursive: true, force: true }); rmSync(join(tmpdir(), "lorehouse-poc66", "june"), { recursive: true, force: true }); }
