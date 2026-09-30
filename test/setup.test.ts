import { describe, expect, test } from "bun:test";
import { appManifest, urlMismatch, type ManagedManifest } from "../src/setup";

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
