// PROTOTYPE of the June API this POC asks for (#66). Not Lorehouse code: 02-redact.ts appends
// this file to a SCRATCH COPY of @junejs/server/src/agent-native.ts (the file Bun runs; the
// package's "bun" export condition points at src/), so it runs inside June's module with
// June's own SyncSqlite handle and NativeRuntime. Lorehouse's node_modules is never edited.
//
// Two operations over the native store's tables (agent_messages, agent_steps, and the
// *_archive tables a session reset leaves):
//   redact  — rewrite every stored string that contains one of `needles`, keeping each
//             message's shape (role, ids, tool_use/tool_result pairing), optionally the whole
//             turn's assistant text too; rows of every session, or only a key prefix.
//   purge   — delete every row of the sessions under a key prefix (a channel taken off).
// Both run with PRAGMA secure_delete = ON in one transaction, then optionally VACUUM.

/* eslint-disable */
export type RedactContext = { table: string; sessionId: string; role?: string; tool?: string; path: string };
export type RedactOptions = {
  // Store keys are `${agent}:${session}`, e.g. "lorehouse:slack:C1:1790000001.000100".
  sessionPrefix?: string;
  // A stored string containing any of these is passed to `rewrite`.
  needles: string[];
  // What the string becomes. Default: the placeholder. The app can be finer, e.g. drop one
  // hit from a JSON list of search results and keep the others.
  rewrite?: (s: string, ctx: RedactContext) => string;
  placeholder?: string;
  // Also replace the text of every assistant message in a turn where a tool result was
  // rewritten (the answer may paraphrase without naming the source). Default true.
  turnScope?: boolean;
  // PRAGMA secure_delete for the rewrite (default ON); off only to show what it does.
  secureDelete?: boolean;
  vacuum?: boolean;
};
export type RedactReport = {
  sessions: number;
  rows: { messages: number; steps: number; archived: number; turnScoped: number };
  scanMs: number;
  writeMs: number;
  vacuumMs?: number;
};

type Db = { exec(sql: string): void; query(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown; run(...a: unknown[]): unknown } };

const PLACEHOLDER = "[redacted: this content came from a message that no longer exists]";

function hasTable(db: Db, name: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null;
}

// The forms a needle takes inside a stored JSON body: raw, JSON-escaped once (a string
// field), and twice (a tool result that is itself a JSON string).
function forms(needle: string): string[] {
  const once = JSON.stringify(needle).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [...new Set([needle, once, twice])];
}

function prefixWhere(prefix: string | undefined): { sql: string; args: string[] } {
  return prefix ? { sql: "session_id >= ? AND session_id < ?", args: [prefix, prefix + "￿"] } : { sql: "1", args: [] };
}

export function redactStore(db: Db, opts: RedactOptions): RedactReport {
  const placeholder = opts.placeholder ?? PLACEHOLDER;
  const rewrite = opts.rewrite ?? (() => placeholder);
  const turnScope = opts.turnScope ?? true;
  const all = opts.needles.flatMap(forms);
  const match = (s: string) => opts.needles.some((n) => s.includes(n));
  const where = prefixWhere(opts.sessionPrefix);
  const anyNeedle = all.map(() => "instr(%COL%, ?) > 0").join(" OR ");

  // Rewrite every string in a JSON value that contains a needle; count what changed.
  const deep = (v: unknown, ctx: RedactContext): [unknown, boolean] => {
    if (typeof v === "string") {
      if (!match(v)) return [v, false];
      const out = rewrite(v, ctx);
      return [out, out !== v];
    }
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x, i) => { const [y, c] = deep(x, { ...ctx, path: `${ctx.path}[${i}]` }); changed ||= c; return y; });
      return [out, changed];
    }
    if (v && typeof v === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        // never rewrite identity: ids, roles, names, turn ids (the pairing lives there)
        if (k === "id" || k === "toolCallId" || k === "role" || k === "turnId" || k === "name" || k === "type") { out[k] = x; continue; }
        const [y, c] = deep(x, { ...ctx, path: `${ctx.path}.${k}` });
        changed ||= c;
        out[k] = y;
      }
      return [out, changed];
    }
    return [v, false];
  };

  const t0 = performance.now();
  const msgRows = db.query(`SELECT seq, session_id, body FROM agent_messages WHERE ${where.sql} AND (${anyNeedle.replaceAll("%COL%", "body")})`)
    .all(...where.args, ...all) as { seq: number; session_id: string; body: string }[];
  const stepRows = db.query(`SELECT session_id, id, output FROM agent_steps WHERE ${where.sql} AND (${anyNeedle.replaceAll("%COL%", "output")})`)
    .all(...where.args, ...all) as { session_id: string; id: string; output: string }[];
  const t1 = performance.now();

  const report: RedactReport = { sessions: 0, rows: { messages: 0, steps: 0, archived: 0, turnScoped: 0 }, scanMs: t1 - t0, writeMs: 0 };
  const sessions = new Set<string>();
  db.exec(`PRAGMA secure_delete = ${opts.secureDelete === false ? "OFF" : "ON"}`);
  db.exec("BEGIN");
  try {
    const updMsg = db.query("UPDATE agent_messages SET body = ? WHERE seq = ?");
    const updStep = db.query("UPDATE agent_steps SET output = ? WHERE session_id = ? AND id = ?");
    const scopedTurns = new Set<string>(); // `${session}\u0000${turnId}` with a rewritten tool result
    for (const r of msgRows) {
      const m = JSON.parse(r.body) as Record<string, unknown>;
      const [out, changed] = deep(m, { table: "agent_messages", sessionId: r.session_id, role: m.role as string, tool: m.name as string | undefined, path: "$" });
      if (!changed) continue;
      updMsg.run(JSON.stringify(out), r.seq);
      report.rows.messages++;
      sessions.add(r.session_id);
      if (m.role === "tool") scopedTurns.add(`${r.session_id}\u0000${m.turnId}`);
    }
    for (const r of stepRows) {
      const [out, changed] = deep(JSON.parse(r.output), { table: "agent_steps", sessionId: r.session_id, path: "$" });
      if (!changed) continue;
      updStep.run(JSON.stringify(out), r.session_id, r.id);
      report.rows.steps++;
      sessions.add(r.session_id);
    }
    // Turn scope: the assistant messages of an affected turn that come after the rewritten
    // result, and their model step (`model:<index of the message in the session>`).
    if (turnScope && scopedTurns.size) {
      const bySession = new Map<string, Set<string>>();
      for (const k of scopedTurns) { const [s, t] = k.split("\u0000") as [string, string]; (bySession.get(s) ?? bySession.set(s, new Set()).get(s)!).add(t); }
      for (const [sid, turns] of bySession) {
        const rows = db.query("SELECT seq, body FROM agent_messages WHERE session_id = ? ORDER BY seq").all(sid) as { seq: number; body: string }[];
        // Conservative: every assistant text after the turn's first tool result (the result
        // that matched may be any of them; the answer comes after them all).
        const afterResult = new Set<string>();
        rows.forEach((row, index) => {
          const m = JSON.parse(row.body) as { role: string; turnId: string; text?: string };
          if (!turns.has(m.turnId)) return;
          if (m.role === "tool") afterResult.add(m.turnId);
          if (m.role !== "assistant" || !afterResult.has(m.turnId) || !m.text || m.text === placeholder) return;
          updMsg.run(JSON.stringify({ ...m, text: placeholder }), row.seq);
          const step = db.query("SELECT output FROM agent_steps WHERE session_id = ? AND id = ?").get(sid, `model:${index}`) as { output: string } | undefined;
          if (step) updStep.run(JSON.stringify({ ...JSON.parse(step.output), text: placeholder }), sid, `model:${index}`);
          report.rows.turnScoped++;
        });
      }
    }
    for (const t of ["agent_messages_archive", "agent_steps_archive"]) {
      if (!hasTable(db, t)) continue;
      const col = t === "agent_messages_archive" ? "body" : "output";
      const rows = db.query(`SELECT rowid AS rid, session_id, ${col} AS v FROM ${t} WHERE ${where.sql} AND (${anyNeedle.replaceAll("%COL%", col)})`).all(...where.args, ...all) as { rid: number; session_id: string; v: string }[];
      for (const r of rows) {
        const [out, changed] = deep(JSON.parse(r.v), { table: t, sessionId: r.session_id, path: "$" });
        if (!changed) continue;
        db.query(`UPDATE ${t} SET ${col} = ? WHERE rowid = ?`).run(JSON.stringify(out), r.rid);
        report.rows.archived++;
        sessions.add(r.session_id);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  report.sessions = sessions.size;
  report.writeMs = performance.now() - t1;
  if (opts.vacuum) {
    const t2 = performance.now();
    db.exec("VACUUM");
    report.vacuumMs = performance.now() - t2;
  }
  return report;
}

export type PurgeReport = { sessions: number; rows: { messages: number; steps: number; sessions: number; archived: number }; ms: number; vacuumMs?: number };

export function purgeStore(db: Db, opts: { sessionPrefix: string; vacuum?: boolean }): PurgeReport {
  const where = prefixWhere(opts.sessionPrefix);
  const t0 = performance.now();
  const n = (sql: string) => (db.query(sql).get(...where.args) as { n: number }).n;
  const report: PurgeReport = {
    sessions: n(`SELECT count(DISTINCT session_id) AS n FROM agent_messages WHERE ${where.sql}`),
    rows: { messages: 0, steps: 0, sessions: 0, archived: 0 },
    ms: 0,
  };
  db.exec("PRAGMA secure_delete = ON");
  db.exec("BEGIN");
  try {
    report.rows.messages = n(`SELECT count(*) AS n FROM agent_messages WHERE ${where.sql}`);
    report.rows.steps = n(`SELECT count(*) AS n FROM agent_steps WHERE ${where.sql}`);
    report.rows.sessions = n(`SELECT count(*) AS n FROM agent_sessions WHERE ${where.sql}`);
    for (const t of ["agent_messages", "agent_steps", "agent_sessions"]) db.query(`DELETE FROM ${t} WHERE ${where.sql}`).run(...where.args);
    for (const t of ["agent_messages_archive", "agent_steps_archive", "agent_session_generations"]) {
      if (!hasTable(db, t)) continue;
      report.rows.archived += n(`SELECT count(*) AS n FROM ${t} WHERE ${where.sql}`);
      db.query(`DELETE FROM ${t} WHERE ${where.sql}`).run(...where.args);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  report.ms = performance.now() - t0;
  if (opts.vacuum) {
    const t1 = performance.now();
    db.exec("VACUUM");
    report.vacuumMs = performance.now() - t1;
  }
  return report;
}

// The runtime surface June would expose. Must run between turns: a turn in flight holds its
// transcript in memory and would write after the rewrite. (A real implementation would
// serialize through each affected session's actor, and evict purged actors.)
(NativeRuntime.prototype as any).redact = function (opts: RedactOptions): RedactReport { return redactStore(this.db, opts); };
(NativeRuntime.prototype as any).purgeSessions = function (opts: { sessionPrefix: string; vacuum?: boolean }): PurgeReport { return purgeStore(this.db, opts); };
