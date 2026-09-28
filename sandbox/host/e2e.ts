// e2e.ts — Lorehouse (runner mode) with a real sandboxd connecting in, end to end.
//
// Starts the conformance mock (Slack + a scripted model) and Lorehouse, waits for a
// runner to connect, then asks in "Slack" for a command that only a real microVM can
// answer. Run sandboxd elsewhere, pointed at this machine:
//
//   bun sandbox/host/e2e.ts                       # prints the runner token and URL to use
//   # on the KVM host, over an encrypted private link (plain HTTP must be opted into):
//   SANDBOXD_APP_URL=http://<this host>:8850 SANDBOXD_ALLOW_INSECURE_HTTP=1 SANDBOXD_RUNNER_TOKEN=<token> sandboxd
//
// Env: E2E_TOKEN or E2E_TOKEN_FILE (default: random), E2E_TRANSPORT (expected transport,
// ws|poll; default ws), E2E_NO_WS_PROXY=1 (runner via :8851, upgrades stripped),
// E2E_DROP=1 (runner via :8852, every connection cut for 5 s mid-job).

import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const APP_PORT = 8850, MOCK_PORT = 8950, SECRET = "e2e-signing-secret";
const TOKEN = process.env.E2E_TOKEN_FILE ? readFileSync(process.env.E2E_TOKEN_FILE, "utf8").trim() : (process.env.E2E_TOKEN ?? randomBytes(24).toString("hex"));
const STATUS_TOKEN = "e2e-status";
const WANT = process.env.E2E_TRANSPORT ?? "ws";
const MOCK = `http://localhost:${MOCK_PORT}`, APP = `http://localhost:${APP_PORT}`;
const DB = join(tmpdir(), `lorehouse-e2e-${process.pid}.db`);

const mock = Bun.spawn(["bun", join(ROOT, "conformance/mock.ts")], {
  env: { ...process.env, PORT: String(MOCK_PORT), TTFT_MS: "20", TOKEN_DELAY_MS: "1", SLACK_FIXTURES: join(ROOT, "conformance/fixtures/slack-history.json") },
  stdout: "ignore",
  stderr: "inherit",
});
const app = Bun.spawn(["bun", join(ROOT, "src/server.ts")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    SLACK_SIGNING_SECRET: SECRET,
    SLACK_BOT_TOKEN: "xoxb-e2e",
    SLACK_API_URL: `${MOCK}/slack/api`,
    ANTHROPIC_API_KEY: "e2e",
    ANTHROPIC_BASE_URL: `${MOCK}/anthropic`,
    AGENT_CHANNELS: "C1",
    LOREHOUSE_DB: DB,
    INGEST_BACKFILL_DAYS: "0",
    STATUS_TOKEN,
    SANDBOX_RUNNER_TOKEN: TOKEN,
    GITHUB_TOKEN: "e2e-unused",
  },
  stdout: "inherit",
  stderr: "inherit",
});
// E2E_NO_WS_PROXY=1: runners reach Lorehouse through a proxy on :8851 that forwards
// plain HTTP only, like a corporate proxy or platform that strips WebSocket upgrades. A
// runner on `auto` should get a 426 and fall back to long poll.
const proxy = process.env.E2E_NO_WS_PROXY
  ? Bun.serve({
      port: APP_PORT + 1,
      idleTimeout: 60,
      fetch: (req) => {
        const url = new URL(req.url);
        const headers = new Headers(req.headers);
        for (const h of ["connection", "upgrade", "sec-websocket-key", "sec-websocket-version", "sec-websocket-extensions"]) headers.delete(h);
        return fetch(`${APP}${url.pathname}${url.search}`, { method: req.method, headers, body: req.body, signal: req.signal });
      },
    })
  : undefined;
// E2E_DROP=1: runners reach Lorehouse through a TCP relay on :8852 that the run cuts in
// the middle of a job (every connection closed, nothing listening for 5 s). The runner
// must reconnect and deliver the job's result, which it finished while cut off.
type Pipe = { a: import("bun").Socket<unknown>; b?: import("bun").Socket<unknown> };
const pipes = new Set<Pipe>();
function relayListen() {
  // Bytes a client sends before the upstream connection is up are held, then flushed.
  return Bun.listen<{ peer?: import("bun").Socket<unknown>; pipe?: Pipe; early: Uint8Array[] }>({
    hostname: "0.0.0.0",
    port: APP_PORT + 2,
    socket: {
      async open(client) {
        const pipe: Pipe = { a: client as never };
        pipes.add(pipe);
        client.data = { pipe, early: [] };
        pipe.b = await Bun.connect<unknown>({
          hostname: "127.0.0.1",
          port: APP_PORT,
          socket: {
            data: (_s, chunk) => void client.write(chunk),
            close: () => client.end(),
            error: () => client.end(),
          },
        });
        client.data.peer = pipe.b;
        for (const chunk of client.data.early.splice(0)) pipe.b.write(chunk);
      },
      data: (client, chunk) => {
        if (client.data.peer) client.data.peer.write(chunk);
        else client.data.early.push(new Uint8Array(chunk));
      },
      close: (client) => {
        client.data.peer?.end();
        if (client.data.pipe) pipes.delete(client.data.pipe);
      },
    },
  });
}
let relay = process.env.E2E_DROP ? relayListen() : undefined;
function cutRelay() {
  relay?.stop(true);
  relay = undefined;
  for (const p of pipes) {
    p.a.end();
    p.b?.end();
  }
  pipes.clear();
}

const cleanup = () => {
  cutRelay();
  proxy?.stop(true);
  app.kill();
  mock.kill();
  for (const s of ["", "-wal", "-shm"]) rmSync(DB + s, { force: true });
};
process.on("SIGINT", () => { cleanup(); process.exit(130); });

type Runner = { runner: string; transport: string; online: boolean; capacity: number; running: number };
const runners = async (): Promise<Runner[]> =>
  ((await (await fetch(`${APP}/status`, { headers: { authorization: `Bearer ${STATUS_TOKEN}` } })).json()) as { runners?: Runner[] }).runners ?? [];

async function ask(question: string, ts: string): Promise<string> {
  const body = JSON.stringify({ type: "event_callback", team_id: "T1", event_id: `EvE2E${ts}`, event: { type: "app_mention", user: "U1", team: "T1", text: `<@UBOT> [q1] ${question}`, ts, event_ts: ts, channel: "C1" } });
  const now = String(Math.floor(Date.now() / 1000));
  const sig = "v0=" + createHmac("sha256", SECRET).update(`v0:${now}:${body}`).digest("hex");
  await fetch(`${APP}/slack/events`, { method: "POST", headers: { "content-type": "application/json", "x-slack-request-timestamp": now, "x-slack-signature": sig }, body });
  const r = await fetch(`${MOCK}/wait?thread_ts=${ts}&timeout_ms=120000`);
  return ((await r.json()) as { text?: string }).text ?? "";
}

try {
  await Bun.sleep(1500);
  console.log(`\ne2e: Lorehouse on :${APP_PORT} in runner mode. Point a runner at it:`);
  console.log(`e2e:   SANDBOXD_APP_URL=http://<this host>:${APP_PORT} SANDBOXD_RUNNER_TOKEN=${TOKEN.slice(0, 4)}… (E2E_TOKEN)`);
  const t0 = Date.now();
  let connected: Runner | undefined;
  while (!connected && Date.now() - t0 < 180_000) {
    connected = (await runners().catch(() => [])).find((r) => r.online);
    if (!connected) await Bun.sleep(500);
  }
  if (!connected) throw new Error("no runner connected within 3 minutes");
  console.log(`e2e: runner ${connected.runner} connected over ${connected.transport} (capacity ${connected.capacity})`);
  if (connected.transport !== WANT) throw new Error(`transport ${connected.transport}, want ${WANT}`);

  if (process.env.E2E_DROP) {
    const t0 = Date.now();
    const pending = ask("[exec] sleep 12 && echo survived-the-drop", `${Math.floor(Date.now() / 1000)}.000100`);
    await Bun.sleep(4000);
    console.log("e2e: cutting every connection for 5 s, mid-job");
    cutRelay();
    await Bun.sleep(5000);
    relay = relayListen();
    const answer = await pending;
    const out = /\[exec:(\d+):([^\]]*)\]/.exec(answer);
    console.log(`e2e: answered in ${Date.now() - t0} ms: ${out ? `exit ${out[1]} — ${out[2]}` : answer.slice(0, 200)}`);
    if (!out || out[2] !== "survived-the-drop") throw new Error("the job's result was lost with the connection");
    const again = (await runners())[0];
    console.log(`e2e: runner ${again?.runner} back over ${again?.transport}`);
    console.log("e2e: PASS");
    cleanup();
    process.exit(0);
  }

  const command = "cat /proc/cpuinfo | grep -c ^processor && uname -r && git --version && curl -s -o /dev/null -w github:%{http_code} https://github.com";
  const t1 = Date.now();
  const answer = await ask(`[exec] ${command}`, `${Math.floor(Date.now() / 1000)}.000100`);
  const out = /\[exec:(\d+):([^\]]*)\]/.exec(answer);
  console.log(`e2e: answered in ${Date.now() - t1} ms: ${out ? `exit ${out[1]} — ${out[2]}` : answer.slice(0, 200)}`);
  if (!out || out[1] !== "0" || !out[2]!.includes("github:200")) throw new Error("the command didn't run in a sandbox with internet");
  console.log("e2e: PASS");
} catch (err) {
  console.error(`e2e: FAIL — ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
