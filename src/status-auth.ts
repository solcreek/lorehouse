// status-auth.ts — who may read GET /status.
//
// /status tells whoever asks which channels the agent reads, how much it knows, when it
// last saw a message and any ingest error, so it is closed unless STATUS_TOKEN is set,
// and then needs `Authorization: Bearer <token>`. /healthz stays open (it says only
// "ok", and a platform's health check needs it).

import { createHash, timingSafeEqual } from "node:crypto";

// A refusal to send instead of the status, or undefined when the request may see it.
export function statusRefusal(req: Request, token: string | undefined): Response | undefined {
  if (!token) return new Response("not found", { status: 404 }); // closed: as if it didn't exist
  // The scheme name is case-insensitive (RFC 9110 §11.1); the token itself is exact.
  const given = /^bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  // Compare digests, so the comparison takes the same time whatever the length or prefix.
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!timingSafeEqual(digest(given), digest(token))) {
    return new Response("unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
  }
  return undefined;
}
