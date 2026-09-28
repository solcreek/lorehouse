// fake-runner.ts — a sandbox runner for the conformance suite, over either transport.
//
// It speaks the runner protocol (docs/sandbox-runners.md) to the app under test exactly
// as sandboxd does, but "runs" a job by answering from memory: an exec returns
// "ran:<command>", so a scenario can tell the command went through the runner.

type Job = { id: string; sandbox: string; op: string; method?: string; path?: string; bodyBase64?: string };

export type FakeRunner = { jobs: Job[]; stop: () => Promise<void> };

const b64 = (s: string) => Buffer.from(s).toString("base64");

function answer(job: Job) {
  if (job.op === "guest" && job.method === "POST" && job.path === "/exec") {
    const { command } = JSON.parse(Buffer.from(job.bodyBase64 ?? "", "base64").toString());
    return { id: job.id, status: 200, contentType: "application/json", bodyBase64: b64(JSON.stringify({ exitCode: 0, stdout: `ran:${command}\n`, stderr: "" })) };
  }
  return { id: job.id, status: 404 };
}

const headers = (token: string, name: string) => ({ authorization: `Bearer ${token}`, "x-lorehouse-runner": name });
const status = { type: "status", capacity: 2, running: 0, version: "fake" };

export async function wsRunner(base: string, token: string, name: string): Promise<FakeRunner> {
  const jobs: Job[] = [];
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/runners/connect`, { headers: headers(token, name) } as unknown as string[]);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("runner websocket failed to open"));
  });
  ws.send(JSON.stringify(status));
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data)) as { type: string; job: Job };
    if (msg.type !== "job") return;
    jobs.push(msg.job);
    ws.send(JSON.stringify({ type: "result", result: answer(msg.job) }));
  };
  return {
    jobs,
    stop: async () => {
      ws.close();
      await Bun.sleep(100);
    },
  };
}

export function pollRunner(base: string, token: string, name: string): FakeRunner {
  const jobs: Job[] = [];
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      const r = await fetch(`${base}/runners/poll`, {
        method: "POST",
        headers: { ...headers(token, name), "content-type": "application/json" },
        body: JSON.stringify(status),
        signal: abort.signal,
      }).catch(() => undefined);
      if (!r?.ok) {
        await Bun.sleep(100);
        continue;
      }
      const { jobs: batch } = (await r.json()) as { jobs: Job[] };
      for (const job of batch) {
        jobs.push(job);
        await fetch(`${base}/runners/results`, {
          method: "POST",
          headers: { ...headers(token, name), "content-type": "application/json" },
          body: JSON.stringify({ results: [answer(job)] }),
        });
      }
    }
  })();
  return {
    jobs,
    stop: async () => {
      abort.abort();
      await loop.catch(() => {});
    },
  };
}
