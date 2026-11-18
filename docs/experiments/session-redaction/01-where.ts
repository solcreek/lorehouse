// Q1: where does a quoted Slack message's text live in SESSIONS_DB, and does it survive the
// message's deletion? Drives the real app (src/server.ts) against the conformance mock:
//   1. a person posts a message carrying a marker word; ingest indexes it
//   2. @scout is asked in a new thread; the scripted model searches and quotes the hit
//   3. the message is deleted in Slack; Lorehouse's index forgets it (#65)
//   4. a follow-up in the same thread: the model request is logged by the proxy
// then the app stops and the DB files are inspected. Output: one JSON object on stdout.
// Keeps the run directory (02-redact.ts reads it) unless --cleanup.
//
//   bun docs/experiments/session-redaction/01-where.ts [--dir <dir>] [--cleanup]

import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO, admin, cleanup, del, mention, modelRequests, pairingErrors, post, start } from "./harness.ts";

export const MARKER = "ZEBRAQUARTZ";

// Bytes of the marker in each file of the database (main, WAL), like `strings | grep -c`.
export function markerHits(path: string, marker = MARKER): Record<string, number> {
  const out: Record<string, number> = {};
  for (const suffix of ["", "-wal"]) {
    const p = path + suffix;
    if (!existsSync(p)) continue;
    const bytes = readFileSync(p).toString("latin1");
    out[(p.split("/").pop())!] = bytes.split(marker).length - 1;
  }
  return out;
}

// Where the marker lives, row by row: table, key, the JSON path of the string holding it,
// and that string with the marker shown as «MARKER» (clipped).
export function markerRows(dbPath: string, marker = MARKER) {
  const db = new Database(dbPath, { readonly: true });
  const rows: { table: string; key: string; role?: string; paths: string[]; sample: string }[] = [];
  const paths = (v: unknown, at = "$"): string[] => {
    if (typeof v === "string") return v.includes(marker) ? [at] : [];
    if (Array.isArray(v)) return v.flatMap((x, i) => paths(x, `${at}[${i}]`));
    if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => paths(x, `${at}.${k}`));
    return [];
  };
  const show = (s: string) => {
    const i = s.indexOf(marker);
    return s.slice(Math.max(0, i - 60), i + marker.length + 40).replaceAll(marker, "«MARKER»");
  };
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
  for (const r of db.query("SELECT seq, session_id, body FROM agent_messages WHERE instr(body, ?) > 0").all(marker) as { seq: number; session_id: string; body: string }[]) {
    const v = JSON.parse(r.body);
    rows.push({ table: "agent_messages", key: `seq=${r.seq} session=${r.session_id}`, role: v.role, paths: paths(v), sample: show(r.body) });
  }
  for (const r of db.query("SELECT session_id, id, output FROM agent_steps WHERE instr(output, ?) > 0").all(marker) as { session_id: string; id: string; output: string }[]) {
    rows.push({ table: "agent_steps", key: `id=${r.id} session=${r.session_id}`, paths: paths(JSON.parse(r.output)), sample: show(r.output) });
  }
  const counts = Object.fromEntries(tables.map((t) => [t, (db.query(`SELECT count(*) AS n FROM "${t}"`).get() as { n: number }).n]));
  const schema = (db.query("SELECT sql FROM sqlite_master WHERE type IN ('table','index') AND sql IS NOT NULL").all() as { sql: string }[]).map((r) => r.sql);
  const pragmas = { secure_delete: (db.query("PRAGMA secure_delete").get() as Record<string, number>), journal_mode: db.query("PRAGMA journal_mode").get(), freelist_count: db.query("PRAGMA freelist_count").get() };
  db.close();
  return { tables, counts, schema, pragmas, rows };
}

if (import.meta.main) {
  const flagAt = process.argv.indexOf("--dir");
  const dir = flagAt > 0 ? process.argv[flagAt + 1]! : join(tmpdir(), "lorehouse-poc66", "where");
  cleanup(dir);
  const fixture = JSON.parse(readFileSync(join(REPO, "conformance/fixtures/slack-history.json"), "utf8"));
  const run = await start(dir, fixture);
  const out: Record<string, unknown> = { dir };
  try {
    // 1. the source message (synthetic)
    const sourceTs = await post(run, `Reminder for the offsite: the papaya launch code word is ${MARKER}, keep it in this channel`);
    await Bun.sleep(1200); // past INGEST_DEBOUNCE_MS (200)
    const docId = `slack:C1:${sourceTs}`;
    out.source = { ts: sourceTs, docId, indexed: (await admin(run, `/api/v1/documents/${docId}`)).status };

    // 2. ask in a new thread; the scripted model searches and, with [quote], quotes the hit
    const q1 = await mention(run, "[q1] [quote] what is the papaya launch code word?");
    out.ask = { thread: q1.ts, replyQuotesMarker: q1.reply.includes(MARKER), reply: q1.reply.replaceAll(MARKER, "«MARKER»").slice(0, 200) };
    out.afterAsk = { sessionsDb: markerHits(run.sessionsDb), lorehouseDb: markerHits(run.lorehouseDb) };

    // 3. delete it in Slack
    await del(run, sourceTs);
    await Bun.sleep(1200);
    const search = await admin(run, `/api/v1/search?q=papaya`);
    out.afterDelete = {
      documentStatus: (await admin(run, `/api/v1/documents/${docId}`)).status,
      searchHits: Array.isArray((search.body as { hits?: unknown[] }).hits) ? (search.body as { hits: unknown[] }).hits.length : search.body,
      sessionsDb: markerHits(run.sessionsDb),
      lorehouseDb: markerHits(run.lorehouseDb),
    };

    // 4. a follow-up in the same thread: what does June send the model now?
    const before = (await modelRequests(run)).length;
    const q2 = await mention(run, "anything else about the offsite?", q1.ts);
    const reqs = (await modelRequests(run)).slice(before);
    out.followUp = {
        modelRequests: reqs.map((r) => {
        const where: string[] = [];
        r.body.messages.forEach((m, i) => {
          const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
          blocks.forEach((b, j) => { if (JSON.stringify(b).includes(MARKER)) where.push(`messages[${i}](${m.role}).content[${j}].${b.type}`); });
        });
        return { messages: r.body.messages.length, chars: JSON.stringify(r.body).length, markerIn: where, pairingErrors: pairingErrors(r.body.messages) };
      }),
    };
  } finally {
    await run.stop();
  }
  // After a clean stop (June closes the handle; WAL checkpointed on close).
  out.afterStop = { sessionsDb: markerHits(run.sessionsDb), lorehouseDb: markerHits(run.lorehouseDb) };
  out.sessions = markerRows(run.sessionsDb);
  console.log(JSON.stringify(out, null, 2));
  writeFileSync(join(dir, "result.json"), JSON.stringify(out, null, 2));
  if (process.argv.includes("--cleanup")) cleanup(dir);
}
