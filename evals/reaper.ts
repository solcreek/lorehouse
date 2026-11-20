// reaper.ts — what cleans up after a run that didn't get to: a small process the runner
// starts and tells, line by line on its stdin, which children it has started and which
// temp directories it has made. When that stdin closes (the runner exited, crashed, or was
// killed outright, SIGKILL included), whatever is still listed is killed and removed.
//
//   pid <n>     a child is running        done <n>    it was reaped
//   dir <path>  a temp directory exists   gone <path> it was removed
//
// It outlives the signals the runner dies of, and removes only directories that are this
// harness's own (lorehouse-eval-* under the system temp directory).

import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

const pids = new Set<number>();
const dirs = new Set<string>();
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});

// A directory this harness made: lorehouse-eval-* directly under the temp directory.
export function ownTempDir(path: string): boolean {
  try {
    return basename(path).startsWith("lorehouse-eval-") && realpathSync(dirname(path)) === realpathSync(tmpdir());
  } catch {
    return false;
  }
}

function line(text: string): void {
  const [verb, ...rest] = text.split(" ");
  const value = rest.join(" ");
  if (verb === "pid" && /^\d+$/.test(value)) pids.add(Number(value));
  else if (verb === "done") pids.delete(Number(value));
  else if (verb === "dir") dirs.add(value);
  else if (verb === "gone") dirs.delete(value);
}

if (import.meta.main) {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const l of lines) line(l);
  }
  // The runner is gone.
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  if (pids.size) await Bun.sleep(200); // let them go before their files do
  for (const dir of dirs) if (ownTempDir(dir)) rmSync(dir, { recursive: true, force: true });
}
