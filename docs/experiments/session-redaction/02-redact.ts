// Q2, option (a): redact by Slack thread, through a prototype June API, on the SESSIONS_DB
// that 01-where.ts built with the real app. Then restart the real app on the redacted file
// and ask a follow-up in the same thread: does the model input still carry the text, and
// does it still satisfy the Messages API's tool_use/tool_result pairing?
//
//   bun docs/experiments/session-redaction/01-where.ts        # first; keeps its directory
//   bun docs/experiments/session-redaction/02-redact.ts [--where <dir>] [--cleanup]
//
// June is patched in a scratch copy only (see june-redact.ts); Lorehouse's src/ and
// node_modules/ are untouched.

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, cleanup, duplicateToolUseIds, mention, modelRequests, pairingErrors, start } from "./harness.ts";
import { MARKER, markerHits, markerRows } from "./01-where.ts";

const ROOT = join(tmpdir(), "lorehouse-poc66");

// A scratch copy of @junejs (core, server, db) with june-redact.ts appended to the native
// store module. Returns the patched module.
export async function patchedJune(): Promise<{ createNativeRuntime: (agents: Record<string, unknown>, path: string) => Promise<any> }> {
  const work = join(ROOT, "june");
  rmSync(work, { recursive: true, force: true });
  cpSync(join(REPO, "node_modules/@junejs"), join(work, "node_modules/@junejs"), { recursive: true, dereference: true });
  const target = join(work, "node_modules/@junejs/server/src/agent-native.ts");
  writeFileSync(target, readFileSync(target, "utf8") + "\n" + readFileSync(join(import.meta.dir, "june-redact.ts"), "utf8"));
  return import(target);
}

// The model and tools are never called here (no turn runs through this runtime).
export const inertAgent = { lorehouse: { model: async function* () { throw new Error("no model in this script"); }, tools: [] } };

// What Lorehouse would pass as `rewrite` once June has the API: in a search_knowledge or
// recent_knowledge result, drop only the hit for the redacted thread and keep the others;
// any other string that names it (an answer citing it) becomes the placeholder.
export function lorehouseRewrite(docId: string, placeholder: string) {
  return (s: string): string => {
    try {
      const v = JSON.parse(s) as unknown;
      if (Array.isArray(v)) return JSON.stringify(v.filter((h) => (h as { id?: string })?.id !== docId));
      if (v && typeof v === "object" && Array.isArray((v as { threads?: unknown[] }).threads)) {
        return JSON.stringify({ ...v, threads: (v as { threads: { id?: string }[] }).threads.filter((h) => h.id !== docId) });
      }
    } catch { /* not JSON */ }
    return placeholder;
  };
}

if (import.meta.main) {
  const at = process.argv.indexOf("--where");
  const where = at > 0 ? process.argv[at + 1]! : join(ROOT, "where");
  if (!existsSync(join(where, "result.json"))) throw new Error(`run 01-where.ts first (no ${where}/result.json)`);
  const before = JSON.parse(readFileSync(join(where, "result.json"), "utf8")) as { source: { docId: string; ts: string }; ask: { thread: string } };
  const dir = join(ROOT, "redact");
  cleanup(dir);
  cpSync(where, dir, { recursive: true });
  rmSync(join(dir, "model-requests.jsonl"), { force: true });
  const sessionsDb = join(dir, "sessions.db");
  const out: Record<string, unknown> = { docId: before.source.docId, thread: before.ask.thread };

  const june = await patchedJune();
  const docId = before.source.docId;
  const permalink = `p${before.source.ts.replace(".", "")}`; // the thread's permalink path segment
  const placeholder = "[redacted: this content came from a message that no longer exists]";

  // Variant 1: secure_delete OFF, no VACUUM — what an UPDATE alone leaves in the file.
  const off = join(ROOT, "redact-off.db");
  cpSync(sessionsDb, off);
  {
    const rt = await june.createNativeRuntime(inertAgent, off);
    const report = rt.redact({ needles: [docId, permalink], rewrite: lorehouseRewrite(docId, placeholder), placeholder, secureDelete: false });
    await rt.close();
    out.secureDeleteOff = { report, markerBytes: markerHits(off), rowsStillHolding: markerRows(off).rows.length };
  }
  rmSync(off, { force: true });

  // Variant 2 (the proposal): secure_delete ON; then VACUUM, measured separately.
  out.before = { markerBytes: markerHits(sessionsDb), rows: markerRows(sessionsDb).rows.map((r) => `${r.table} ${r.key.split(" ")[0]} ${r.role ?? ""}`) };
  {
    const rt = await june.createNativeRuntime(inertAgent, sessionsDb);
    const report = rt.redact({ needles: [docId, permalink], rewrite: lorehouseRewrite(docId, placeholder), placeholder });
    await rt.close();
    out.secureDeleteOn = { report, markerBytes: markerHits(sessionsDb) };
  }
  // What the rewritten rows now hold.
  {
    const { Database } = await import("bun:sqlite");
    const db = new Database(sessionsDb, { readonly: true });
    out.afterRows = (db.query("SELECT seq, body FROM agent_messages ORDER BY seq").all() as { seq: number; body: string }[])
      .map((r) => `${r.seq} ${r.body.slice(0, 230)}`);
    db.close();
  }

  // The real app, restarted on the redacted file: a follow-up in the same thread.
  const fixture = JSON.parse(readFileSync(join(REPO, "conformance/fixtures/slack-history.json"), "utf8"));
  const run = await start(dir, fixture);
  try {
    await mention(run, "and what was the code word again?", before.ask.thread);
    const reqs = await modelRequests(run);
    out.followUp = reqs.map((r) => ({
      messages: r.body.messages.length,
      markerInRequest: JSON.stringify(r.body).split(MARKER).length - 1,
      docIdInRequest: JSON.stringify(r.body).split(docId).length - 1,
      pairingErrors: pairingErrors(r.body.messages),
      duplicateToolUseIds: duplicateToolUseIds(r.body.messages), // mock restarted: its counter reuses ids
      placeholderBlocks: r.body.messages.flatMap((m, i) => (typeof m.content === "string" ? [] : m.content.map((b, j) => (JSON.stringify(b).includes("[redacted:") ? `messages[${i}].content[${j}].${b.type}` : "")).filter(Boolean))),
    }));
  } finally {
    await run.stop();
  }
  out.afterFollowUp = { markerBytes: markerHits(sessionsDb) };
  console.log(JSON.stringify(out, null, 2));
  if (process.argv.includes("--cleanup")) { cleanup(dir); cleanup(join(ROOT, "june")); }
}
