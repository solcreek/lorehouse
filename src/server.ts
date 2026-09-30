import { createApp } from "./app";
import { ConfigError, loadConfig } from "./config";
import { doctorMain } from "./doctor";
import { loadEnv } from "./settings";
import { announceUrl, configToken, publicUrl, serveSetupMode, setupMain } from "./setup";

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
let config;
try {
  config = loadConfig(env);
} catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  // Missing settings are a state to finish, not a crash: serve setup until they arrive.
  await serveSetupMode(Number(env.PORT ?? 3000), settingsPath, e.problems, env);
}

if (config) {
  const app = await createApp(config);
  const options = { port: config.port, idleTimeout: 60 };
  // Sandbox runners may connect over WebSocket (docs/sandbox-runners.md).
  const server = app.websocket
    ? Bun.serve({ ...options, fetch: (req, srv) => app.fetch(req, srv), websocket: app.websocket })
    : Bun.serve({ ...options, fetch: (req) => app.fetch(req) });
  const sandbox = config.sandbox ? `code tools on (${config.sandbox.mode === "runners" ? "runners connect in" : "direct sandbox host"})` : "code tools off";
  console.log(
    `lorehouse: @${app.identity.name} on :${server.port}` + (app.seeded ? ` (seeded ${app.seeded} knowledge chunks)` : "") + ` — ${sandbox}`,
  );
  void app.startIngest();
  // Where Slack reaches us may have changed since the last start (a quick tunnel always has).
  void publicUrl(env, server.port!).then(
    (url) => announceUrl(settingsPath, url),
    (e) => console.error(`lorehouse: ${(e as Error).message}`),
  );
  // Keep the configuration token alive: it lasts 12 hours, and a restart needs a live one.
  setInterval(() => void configToken(settingsPath).catch(() => {}), 60 * 60_000).unref();
}
