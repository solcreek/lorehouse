import { createApp } from "./app";
import { loadConfig } from "./config";
import { doctorMain } from "./doctor";

// `lorehouse` serves; `lorehouse doctor` checks the setup and exits.
const [command, ...args] = process.argv.slice(2);
if (command === "doctor") process.exit(await doctorMain(args));
if (command !== undefined) {
  console.error(`lorehouse: unknown command "${command}"

usage: lorehouse             serve (configured by environment variables; see the README)
       lorehouse doctor      check the setup (--help for more)`);
  process.exit(2);
}

const config = loadConfig();
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
