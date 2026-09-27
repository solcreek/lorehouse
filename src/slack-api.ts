// slack-api.ts — the few Slack Web API reads ingestion needs, with pagination and
// rate-limit backoff. (Replies to the thread go through the agent framework's channel;
// this is only for reading history.)

export class SlackApiError extends Error {
  constructor(readonly method: string, readonly code: string) {
    super(`slack ${method}: ${code}`);
  }
}

export type SlackApiOptions = {
  token: string;
  apiUrl?: string; // default https://slack.com/api
  fetch?: typeof fetch;
  maxRetries?: number; // on 429, default 5
  sleep?: (ms: number) => Promise<void>;
};

export type SlackApi = {
  call<T = Record<string, unknown>>(method: string, params?: Record<string, string | number | undefined>): Promise<T>;
  // Every page of a cursor-paginated method, yielding the array under `key`.
  paginate<T>(method: string, params: Record<string, string | number | undefined>, key: string): AsyncGenerator<T>;
};

export function slackApi(opts: SlackApiOptions): SlackApi {
  const base = (opts.apiUrl ?? "https://slack.com/api").replace(/\/$/, "");
  const f = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 5;

  async function call<T>(method: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const res = await f(`${base}/${method}?${qs}`, { headers: { authorization: `Bearer ${opts.token}` } });
      if (res.status === 429 && attempt < maxRetries) {
        // Slack says how long to wait; honor it (plus a little), fall back to 1 s.
        const retryAfter = Number(res.headers.get("retry-after") ?? 1);
        await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000 + 100);
        continue;
      }
      if (!res.ok) throw new SlackApiError(method, `http_${res.status}`);
      const body = (await res.json()) as { ok: boolean; error?: string } & T;
      if (!body.ok) throw new SlackApiError(method, body.error ?? "unknown_error");
      return body;
    }
  }

  async function* paginate<T>(method: string, params: Record<string, string | number | undefined>, key: string): AsyncGenerator<T> {
    let cursor: string | undefined;
    do {
      const page = await call<Record<string, unknown> & { response_metadata?: { next_cursor?: string } }>(method, { ...params, cursor });
      for (const item of (page[key] as T[] | undefined) ?? []) yield item;
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  return { call, paginate };
}
