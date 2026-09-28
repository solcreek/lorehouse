// status-auth.ts — bearer tokens: who may read GET /status, and the check itself.
//
// /status tells whoever asks which channels the agent reads, how much it knows, when it
// last saw a message and any ingest error, so it is closed unless STATUS_TOKEN is set,
// and then needs `Authorization: Bearer <token>`. /healthz stays open (it says only
// "ok", and a platform's health check needs it).

import { createHash, timingSafeEqual } from "node:crypto";

// Whether the request carries `Authorization: Bearer <token>`. The scheme name is
// case-insensitive (RFC 9110 §11.1); the token itself is exact. Digests are compared, so
// the time taken says nothing about the token's length or prefix.
export function bearerMatches(req: Request, token: string): boolean {
  const given = /^bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

export const unauthorized = () => new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });

// A refusal to send instead of the status, or undefined when the request may see it.
export function statusRefusal(req: Request, token: string | undefined): Response | undefined {
  if (!token) return new Response("not found", { status: 404 }); // closed: as if it didn't exist
  return bearerMatches(req, token) ? undefined : unauthorized();
}
