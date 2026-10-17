import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { doctorMain } from "./doctor";
import { loadEnv } from "./settings";
import { logAsTenant, prepareTenant, resolveTenant } from "./tenant";
import { announceUrl, configToken, publicUrl, serveSetupMode, SETUP_PROVIDES, setupMain } from "./setup";

// `lorehouse` serves; `lorehouse setup` creates and installs the Slack app; `lorehouse
// doctor` checks the setup and exits.
const [command, ...args] = process.argv.slice(2);
if (command === "doctor") process.exit(await doctorMain(args));
if (command === "setup") process.exit(await setupMain(args));
if (command !== undefined) {
  console.error(`lorehouse: unknown command "${command}"

usage: lorehouse             serve (settings: the environment, /etc/lorehouse/lorehouse.env, and what setup stored)
       lorehouse setup       create and install the Slack app (--help for more)
       lorehouse doctor      check the setup (--help for more)`);
  process.exit(2);
}

const { env, settingsPath } = loadEnv();
// The tenant first (tenant.ts): every line logged from here on starts with its id, in setup
// mode too, and a new install's tenant directory is made now, so the id stays the same from
// this start on. An invalid TENANT_ID is left to loadConfig to report.
const tenant = resolveTenant(env);
if (!("problem" in tenant)) {
  logAsTenant(tenant.id);
  if (prepareTenant(tenant)) console.log(`lorehouse: tenant ${tenant.id} is new: its files go in ${tenant.dir}`);
}
let config;
try {
  config = loadConfig(env, "problem" in tenant ? undefined : tenant);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  // Missing settings that `lorehouse setup` provides are a state to finish, not a crash:
  // serve setup until they arrive. Anything else (an invalid value, conflicting credentials)
  // setup can't fix, so it still fails fast.
  if (!e.problems.every((p) => SETUP_PROVIDES.includes(p))) throw e;
  await serveSetupMode(Number(env.PORT ?? 3000), settingsPath, e.problems, env);
}

if (config) {
  // A stop (Fly sends its kill_signal, SIGINT unless fly.toml says otherwise, then SIGKILL
  // after its kill_timeout, 5 s by default; Ctrl-C is SIGINT too; most other supervisors
  // send SIGTERM) shuts down in order, well inside that: the server stops taking requests
  // (those in flight get STOP_REQUESTS_MS), app.close() gives running turns the rest and
  // checkpoints and closes the databases, and the process exits 0. Without this the
  // process died with the knowledge DB's WAL as it was, deleted text included (#89).
  // The handlers are on before the app starts: a stop during the start (which opens the
  // database and purges unlisted channels) waits for it, never serves, and closes the same
  // way; a start that hangs is cut off by the second signal, or by the kill_timeout.
  const STOP_REQUESTS_MS = 1000;
  const starting = createApp(config);
  let server: ReturnType<typeof Bun.serve> | undefined;
  let stopping = false;
  const shutdown = async (signal: string) => {
    // A second signal while shutting down means now: exit without waiting (the WAL keeps
    // what it holds until the next start checkpoints it).
    if (stopping) process.exit(1);
    stopping = true;
    console.log(`lorehouse: ${signal}: shutting down`);
    try {
      const app = await starting;
      if (server) {
        await Promise.race([server.stop(), Bun.sleep(STOP_REQUESTS_MS)]);
        void server.stop(true); // whatever is still open (a runner's socket) is cut
      }
      await app.close({ waitMs: 2500 });
    } catch (err) {
      console.error("lorehouse: shutting down:", err);
      process.exit(1);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  const app = await starting;
  // Stopped while starting: shutdown() (which awaits the same start, after this) closes it.
  if (!stopping) {
    const options = { port: config.port, idleTimeout: 60 };
    // Sandbox runners may connect over WebSocket (docs/sandbox-runners.md).
    const srv = app.websocket
      ? Bun.serve({ ...options, fetch: (req, srv) => app.fetch(req, srv), websocket: app.websocket })
      : Bun.serve({ ...options, fetch: (req) => app.fetch(req) });
    server = srv;
    const sandbox = config.sandbox ? `code tools on (${config.sandbox.mode === "runners" ? "runners connect in" : "direct sandbox host"})` : "code tools off";
    console.log(
      `lorehouse: @${app.identity.name} on :${srv.port}` + (app.seeded ? ` (seeded ${app.seeded} knowledge chunks)` : "") + ` — ${sandbox}`,
    );
    void app.startIngest();
    // Where Slack reaches us may have changed since the last start (a quick tunnel always has).
    void publicUrl(env, srv.port!).then(
      (url) => announceUrl(settingsPath, url),
      (e) => console.error(`lorehouse: ${(e as Error).message}`),
    );
    // Keep the configuration token alive: it lasts 12 hours, and a restart needs a live one.
    // configToken rotates inside 10 minutes of expiry, so check now and more often than that.
    const keepAlive = () => void configToken(settingsPath).catch(() => {});
    keepAlive();
    setInterval(keepAlive, 5 * 60_000).unref();
  }
}
