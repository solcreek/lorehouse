import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettings } from "../src/settings";
import { announceUrl, appManifest, urlMismatch, type ManagedManifest } from "../src/setup";

const url = "https://a.trycloudflare.com";

describe("appManifest", () => {
  test("with events, interactivity points at the same URL", () => {
    const m = appManifest("scout", url, true) as ManagedManifest;
    expect(m.settings?.interactivity).toEqual({ is_enabled: true, request_url: `${url}/slack/events` });
    expect(urlMismatch(m, url)).toBe("");
  });

  test("before the signing secret, neither block is set", () => {
    const m = appManifest("scout", url, false) as ManagedManifest;
    expect(m.settings?.event_subscriptions).toBeUndefined();
    expect(m.settings?.interactivity).toBeUndefined();
  });
});

describe("urlMismatch", () => {
  test("a removed events block is a mismatch, not a match", () => {
    expect(urlMismatch({ settings: { interactivity: { is_enabled: true, request_url: `${url}/slack/events` } } }, url)).toBe("events go to nowhere");
  });

  test("interactivity switched off or pointing elsewhere is a mismatch", () => {
    const events = { request_url: `${url}/slack/events` };
    expect(urlMismatch({ settings: { event_subscriptions: events } }, url)).toBe("interactivity goes to nowhere (off)");
    expect(urlMismatch({ settings: { event_subscriptions: events, interactivity: { is_enabled: true, request_url: "https://old.example/slack/events" } } }, url)).toBe(
      "interactivity goes to https://old.example/slack/events",
    );
  });
});

describe("announceUrl", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => void (globalThis.fetch = realFetch));

  test("a failed Slack update is retried until it lands", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "lorehouse-announce-")), "settings.json");
    writeSettings(file, { env: { SLACK_BOT_TOKEN: "xoxb" }, slack: { appId: "A1", configToken: "xoxe", configRefreshToken: "r", configExpiresAt: Date.now() / 1000 + 3600 } });
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = String(input);
      if (u.endsWith("/healthz")) return new Response("ok");
      calls.push(u.split("/").pop()!);
      if (calls.length === 1) return Response.json({ ok: false, error: "ratelimited" });
      if (u.endsWith("apps.manifest.export")) return Response.json({ ok: true, manifest: appManifest("scout", url, false) });
      return Response.json({ ok: true });
    }) as typeof fetch;
    await announceUrl(file, url, 10);
    expect(calls).toEqual(["apps.manifest.export", "apps.manifest.export", "apps.manifest.update"]);
  });
});
