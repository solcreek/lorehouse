// fake-runner.ts — a sandbox runner for the conformance suite, over either transport.
//
// It speaks the runner protocol (docs/sandbox-runners.md) to the app under test exactly
// as sandboxd does, but "runs" a job by answering from memory: an exec returns
// "ran:<command>", so a scenario can tell the command went through the runner, except
// the git commands open_pull_request runs, answered as a checkout ready for a PR. The
// publish ops answer as sandboxd's would for that checkout: stage returns the facts and a
// new stage id, and push succeeds only for a stage it handed out, once, with the same
// commit and branch (sandbox/host/src/publish.rs).

type Job = { id: string; sandbox: string; op: string; method?: string; path?: string; bodyBase64?: string };

export type FakeRunner = { jobs: Job[]; stop: () => Promise<void> };

const b64 = (s: string) => Buffer.from(s).toString("base64");

// The git commands open_pull_request runs, answered as a clean checkout of
// github.com/acme/widgets with one commit on top of main would answer them.
function git(command: string): string | undefined {
  if (command === "git status --porcelain") return "";
  if (command === "git remote get-url origin") return "https://github.com/acme/widgets.git\n";
  if (command === "git rev-parse --abbrev-ref origin/HEAD") return "origin/main\n";
  if (command === "git rev-parse HEAD") return "0123456789abcdef0123456789abcdef01234567\n";
  if (command.startsWith("git rev-parse --verify --quiet origin/")) return "x\n";
  if (command.startsWith("git diff --stat")) return " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n";
  if (command.startsWith("git log --format=")) return ""; // no commit by anyone else
  if (command.includes(" push https://github.com/") || command.startsWith("git update-ref ")) return "";
  return undefined;
}

const SHA = "0123456789abcdef0123456789abcdef01234567";
const stages = new Map<string, { sandbox: string; branch: string }>();
let staged = 0;

function json(job: Job, status: number, body: unknown) {
  return { id: job.id, status, contentType: "application/json", bodyBase64: b64(JSON.stringify(body)) };
}

function publish(job: Job) {
  const req = JSON.parse(Buffer.from(job.bodyBase64 ?? "", "base64").toString()) as { stage?: string; branch?: string; sha?: string };
  if (job.op === "stage") {
    const stage = `${Math.floor(Date.now() / 1000)}-${String(++staged).padStart(32, "0")}`;
    stages.set(stage, { sandbox: job.sandbox, branch: req.branch ?? "" });
    return json(job, 200, {
      stage, sha: SHA, baseSha: "f".repeat(40), commits: 1,
      stat: " src/a.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n",
      authors: [], files: ["src/a.ts"], patch: "--- a/src/a.ts\n+++ b/src/a.ts\n-old\n+new\n", patchTruncated: false,
      diffSha256: "d".repeat(64),
    });
  }
  const record = req.stage ? stages.get(req.stage) : undefined;
  if (!record) return { id: job.id, status: 404, error: `stage ${req.stage} isn't here` };
  stages.delete(req.stage!);
  if (record.sandbox !== job.sandbox || record.branch !== req.branch || req.sha !== SHA) return { id: job.id, status: 403, error: "the push doesn't match its stage" };
  return json(job, 200, { sha: SHA, branch: req.branch });
}

function answer(job: Job) {
  if (job.op === "stage" || job.op === "push") return publish(job);
  if (job.op === "guest" && job.method === "POST" && job.path === "/exec") {
    const { command } = JSON.parse(Buffer.from(job.bodyBase64 ?? "", "base64").toString());
    const stdout = git(command) ?? `ran:${command}\n`;
    return { id: job.id, status: 200, contentType: "application/json", bodyBase64: b64(JSON.stringify({ exitCode: 0, stdout, stderr: "" })) };
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
