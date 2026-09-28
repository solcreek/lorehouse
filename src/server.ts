import { createApp } from "./app";
import { loadConfig } from "./config";

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
