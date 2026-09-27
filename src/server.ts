import { createApp } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();
const app = await createApp(config);
const server = Bun.serve({ port: config.port, idleTimeout: 60, fetch: app.fetch });
console.log(
  `lorehouse: @${app.identity.name} on :${server.port}` +
    (app.seeded ? ` (seeded ${app.seeded} knowledge chunks)` : "") +
    (config.sandbox ? " — code tools on" : " — code tools off"),
);
