// The worker Creek runs: June's built worker, handed Creek's D1 binding under the
// name June reads. Creek binds the database as DATABASE (plus a DB alias in
// production only, removed at Creek v1.0); June reads env.DB. See creek.toml.
import june from "./dist/worker.js";

export default {
  fetch(request, env, ctx) {
    return june.fetch(request, env.DB ? env : { ...env, DB: env.DATABASE }, ctx);
  },
};
