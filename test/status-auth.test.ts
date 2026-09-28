// Who may read GET /status.

import { describe, expect, test } from "bun:test";
import { statusRefusal } from "../src/status-auth";

const req = (auth?: string) => new Request("http://x/status", { headers: auth ? { authorization: auth } : {} });

describe("statusRefusal", () => {
  test("with no STATUS_TOKEN, /status is closed to everyone: 404, even with a bearer", () => {
    expect(statusRefusal(req(), undefined)?.status).toBe(404);
    expect(statusRefusal(req("Bearer anything"), undefined)?.status).toBe(404);
    expect(statusRefusal(req("Bearer "), "")?.status).toBe(404);
  });

  test("with a token, only the exact bearer is let through", () => {
    expect(statusRefusal(req("Bearer s3cret"), "s3cret")).toBeUndefined();
    expect(statusRefusal(req(), "s3cret")?.status).toBe(401);
    expect(statusRefusal(req("Bearer wrong"), "s3cret")?.status).toBe(401);
    expect(statusRefusal(req("Bearer s3cret-and-more"), "s3cret")?.status).toBe(401);
    expect(statusRefusal(req("Bearer s3cre"), "s3cret")?.status).toBe(401); // a prefix isn't enough
    expect(statusRefusal(req("s3cret"), "s3cret")?.status).toBe(401); // the scheme is required
    expect(statusRefusal(req("Basic s3cret"), "s3cret")?.status).toBe(401);
  });

  test("the scheme name is case-insensitive; the token is not", () => {
    expect(statusRefusal(req("bearer s3cret"), "s3cret")).toBeUndefined();
    expect(statusRefusal(req("BEARER s3cret"), "s3cret")).toBeUndefined();
    expect(statusRefusal(req("Bearer S3CRET"), "s3cret")?.status).toBe(401);
  });

  test("a refusal says it wants a bearer token", () => {
    expect(statusRefusal(req(), "s3cret")?.headers.get("www-authenticate")).toBe("Bearer");
  });
});
