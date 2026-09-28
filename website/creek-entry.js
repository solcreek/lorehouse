// The worker Creek runs: June's built worker, handed Creek's D1 binding under the
// name June reads. Creek binds the database as DATABASE (plus a DB alias in
// production only, removed at Creek v1.0); June reads env.DB. See creek.toml.
import june from "./dist/worker.js";

// Sign-up attempt counters (hashed IPs and the site-wide total) are kept for a
// day; /privacy says so. join_early_access also prunes them when a new hour's
// first sign-up arrives, but with no sign-ups that never runs, so the hourly
// cron in creek.toml is what keeps the promise.
const COUNTER_RETENTION_MS = 24 * 3600 * 1000;

export default {
  fetch(request, env, ctx) {
    return june.fetch(request, env.DB ? env : { ...env, DB: env.DATABASE }, ctx);
  },

  async scheduled(_event, env) {
    const db = env.DB ?? env.DATABASE;
    const cutoff = new Date(Date.now() - COUNTER_RETENTION_MS).toISOString().slice(0, 13);
    const { meta } = await db
      .prepare("DELETE FROM early_access_attempts WHERE hour < ?")
      .bind(cutoff)
      .run();
    console.log(`[retention] deleted ${meta.changes} counter rows older than ${cutoff}`);
  },
};
