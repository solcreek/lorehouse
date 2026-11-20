// credential.ts — the one real model credential of a run, decided once before anything
// starts, and held by the recording proxy only (proxy.ts). In order:
//
//   1. ANTHROPIC_API_KEY     sent upstream as `x-api-key`                     (api_key)
//   2. ANTHROPIC_AUTH_TOKEN  sent as `Authorization: Bearer`                  (auth_token)
//   3. `ant` logged in       `ant auth print-credentials --access-token`,
//                            sent as `Authorization: Bearer`; asked again once
//                            when upstream answers 401 (it may have refreshed) (ant)
//
// Its value goes nowhere else: not into the app's environment, an argument, a log, a
// record or an evidence file. `secrets()` is for scrubbing output, in memory.

export type CredentialKind = "api_key" | "auth_token" | "ant";

export type Credential = {
  kind: CredentialKind;
  // The header that authenticates a request upstream.
  header(): [name: string, value: string];
  // After a 401: whether a different credential is now in hand (only `ant` can have one).
  refresh(): Promise<boolean>;
  // Every value this credential has had, for scrubbing output.
  secrets(): string[];
};

export const NO_CREDENTIAL =
  "no model credential. Provide one of: ANTHROPIC_API_KEY (an API key); ANTHROPIC_AUTH_TOKEN (a bearer token); or log in with the `ant` CLI (`ant auth login`), which this reads with `ant auth print-credentials --access-token`. Or pass --dry to run against the scripted model, which needs none";

// The access token `ant` holds, or undefined when ant isn't installed or isn't logged in.
// Spawned with no shell; the token is read from its stdout and never passed on anywhere.
export async function antToken(command = "ant"): Promise<string | undefined> {
  try {
    const proc = Bun.spawn([command, "auth", "print-credentials", "--access-token"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 20_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    const token = out.trim();
    // One bare token on one line; anything else (a prompt, an error, JSON) is not one.
    return code === 0 && /^\S{16,}$/.test(token) ? token : undefined;
  } catch {
    return undefined; // not on the PATH
  }
}

export async function resolveCredential(
  env: Record<string, string | undefined>,
  ant: () => Promise<string | undefined> = antToken,
): Promise<Credential | { problem: string }> {
  if (env.ANTHROPIC_API_KEY) {
    const key = env.ANTHROPIC_API_KEY;
    return { kind: "api_key", header: () => ["x-api-key", key], refresh: async () => false, secrets: () => [key] };
  }
  if (env.ANTHROPIC_AUTH_TOKEN) {
    const token = env.ANTHROPIC_AUTH_TOKEN;
    return { kind: "auth_token", header: () => ["authorization", `Bearer ${token}`], refresh: async () => false, secrets: () => [token] };
  }
  let token = await ant();
  if (!token) return { problem: NO_CREDENTIAL };
  const seen = [token];
  // Concurrent 401s share one refresh.
  let refreshing: Promise<boolean> | undefined;
  return {
    kind: "ant",
    header: () => ["authorization", `Bearer ${token}`],
    refresh: () =>
      (refreshing ??= (async () => {
        try {
          const next = await ant();
          if (!next || next === token) return false;
          token = next;
          seen.push(next);
          return true;
        } finally {
          refreshing = undefined;
        }
      })()),
    secrets: () => [...seen],
  };
}

// A placeholder for runs that reach no real model (--dry, tests).
export const noCredential: Credential = { kind: "api_key", header: () => ["x-api-key", "dry"], refresh: async () => false, secrets: () => [] };

// `text` with every secret replaced: the last line of defense before anything is written
// or printed. Nothing is meant to hold one (the proxy records no header), so a replacement
// here is a bug elsewhere, but not a leak.
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted credential]");
  return out;
}
