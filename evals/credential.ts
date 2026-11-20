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

export const DEFAULT_UPSTREAM = "https://api.anthropic.com";

// Where the credential is sent. It goes to this host with every model call, so the host is
// the person's choice, made where they can see it:
//   - api.anthropic.com unless `--upstream <url>` is on the command line. An upstream set
//     only in the environment (EVAL_ANTHROPIC_UPSTREAM, which Bun would also read from a
//     checkout's .env) is refused: an environment variable is not a decision;
//   - https, or plain http only to this machine (localhost, 127.0.0.0/8, [::1]);
//   - a URL with no credentials, query or fragment of its own.
export function resolveUpstream(flag: string | undefined, env: Record<string, string | undefined>): { url: string } | { problem: string } {
  const fromEnv = env.EVAL_ANTHROPIC_UPSTREAM || undefined;
  const raw = flag ?? fromEnv ?? DEFAULT_UPSTREAM;
  const named = flag !== undefined ? `--upstream ${raw}` : `EVAL_ANTHROPIC_UPSTREAM=${raw}`;
  if (!URL.canParse(raw)) return { problem: `${named} isn't a URL (want e.g. ${DEFAULT_UPSTREAM})` };
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash) return { problem: `${named}: an upstream is an origin and an optional path, with no credentials, query or fragment` };
  const loopback = u.hostname === "localhost" || u.hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return { problem: `${named}: the model credential is only sent over https (or plain http to this machine: localhost, 127.0.0.1, [::1])` };
  const url = `${u.origin}${u.pathname}`.replace(/\/+$/, "");
  if (flag === undefined && u.origin !== new URL(DEFAULT_UPSTREAM).origin) {
    return { problem: `EVAL_ANTHROPIC_UPSTREAM names ${u.origin}, and the model credential would be sent there. The environment alone doesn't decide that: pass --upstream ${url} on the command line if that is where it should go, or unset EVAL_ANTHROPIC_UPSTREAM` };
  }
  return { url };
}

// `text` with every secret replaced: the last line of defense before anything is written
// or printed. Nothing is meant to hold one (the proxy records no header), so a replacement
// here is a bug elsewhere, but not a leak.
export function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join("[redacted credential]");
  return out;
}
