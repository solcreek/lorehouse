// One definition, two callers: the early-access form posts it through /mcp, and an
// agent can call the same tool there. Both are unauthenticated, so every call is
// counted against the caller's hourly limit and a site-wide one before anything is
// written. Edge rate limiting belongs in front of this once the site is deployed.
import { defineAction } from "@junejs/core/agent";
import { db } from "@junejs/db";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PER_CLIENT_PER_HOUR = 5;
const SITE_WIDE_PER_HOUR = 300;

async function clientKey(request: Request | undefined): Promise<string> {
  const ip =
    request?.headers.get("cf-connecting-ip") ??
    request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Counts one attempt for `client` in this hour and returns the new total.
async function countAttempt(client: string, hour: string): Promise<number> {
  const row = await db.get<{ count: number }>(
    `INSERT INTO early_access_attempts (client, hour, count) VALUES (?, ?, 1)
     ON CONFLICT (client, hour) DO UPDATE SET count = count + 1
     RETURNING count`,
    [client, hour],
  );
  return row?.count ?? 1;
}

export const joinEarlyAccess = defineAction({
  id: "join_early_access",
  description:
    "Add a work email to the list of people told when hosted Lorehouse opens. Adding the same email twice is harmless. Limited to a few calls per hour per caller.",
  input: {
    type: "object",
    properties: { email: { type: "string", description: "A work email address" } },
    required: ["email"],
  },
  async run({ email }, ctx) {
    const now = new Date();
    const hour = now.toISOString().slice(0, 13);

    const siteWide = await countAttempt("*", hour);
    if (siteWide === 1) {
      // First attempt of a new hour: drop counters older than a day.
      const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000).toISOString().slice(0, 13);
      await db.run("DELETE FROM early_access_attempts WHERE hour < ?", [dayAgo]);
    }
    const mine = await countAttempt(await clientKey(ctx.request), hour);
    if (mine > PER_CLIENT_PER_HOUR || siteWide > SITE_WIDE_PER_HOUR) {
      throw new Error("Too many sign-ups from here in the last hour. Try again later.");
    }

    const address = email.trim().toLowerCase();
    if (address.length > 254 || !EMAIL.test(address)) {
      throw new Error("That doesn't look like an email address. Check it and try again.");
    }
    await db.run("INSERT INTO early_access (email) VALUES (?) ON CONFLICT (email) DO NOTHING", [address]);
    return { ok: true };
  },
});
