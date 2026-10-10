// The conformance runner's command line and `--only`: what a pattern picks, what it pulls
// in because the picked scenarios need it, and that a pattern picking nothing is an error.

import { describe, expect, test } from "bun:test";
import { nameMatcher, parseArgs, selectScenarios, UsageError, type Selectable } from "../conformance/select";

const SCENARIOS: Selectable[] = [
  { name: "answers a mention" },
  { name: "GET /status needs the bearer token" },
  { name: "forgets a deleted message" },
  { name: "catches up after a restart" },
  { name: "the admin API forgets deleted messages too", needs: ["forgets a deleted message", "catches up after a restart"] },
  { name: "reports usage at GET /api/v1/usage" },
  { name: "a check on the admin API's leftovers", needs: ["the admin API forgets deleted messages too"] },
];
const names = (all: Selectable[], only?: string) => {
  const { run, prerequisites } = selectScenarios(all, only);
  return run.map((s) => (prerequisites.has(s) ? `+${s.name}` : s.name));
};

describe("parseArgs", () => {
  test("no arguments: the defaults", () => {
    expect(parseArgs([])).toEqual({});
  });

  test("--app and --only, in either order", () => {
    expect(parseArgs(["--app", "./dist/lorehouse", "--only", "usage"])).toEqual({ app: "./dist/lorehouse", only: "usage" });
    expect(parseArgs(["--only", "/^GET/", "--app", "x"])).toEqual({ app: "x", only: "/^GET/" });
  });

  test("a flag without its value, a repeated flag, or anything else is refused", () => {
    for (const argv of [["--only"], ["--only", ""], ["--only", "--app", "x"], ["--app"], ["--only", "a", "--only", "b"], ["--onyl", "a"], ["--only=a"], ["usage"]]) {
      expect(() => parseArgs(argv)).toThrow(UsageError);
    }
  });
});

describe("nameMatcher", () => {
  test("plain text matches a name containing it, ignoring case", () => {
    const m = nameMatcher("ADMIN api");
    expect(m("the admin API forgets deleted messages too")).toBe(true);
    expect(m("answers a mention")).toBe(false);
  });

  test("text with slashes inside is still text", () => {
    expect(nameMatcher("/status")("GET /status needs the bearer token")).toBe(true);
    expect(nameMatcher("/api/v1")("reports usage at GET /api/v1/usage")).toBe(true);
    expect(nameMatcher("/status")("status")).toBe(false);
  });

  test("/RE/ is a regular expression, ignoring case", () => {
    expect(nameMatcher("/^get /")("GET /status needs the bearer token")).toBe(true);
    expect(nameMatcher("/^get /")("reports usage at GET /api/v1/usage")).toBe(false);
    expect(nameMatcher("/deleted|restart/")("catches up after a restart")).toBe(true);
  });

  test("a regular expression that doesn't compile is a usage error", () => {
    expect(() => nameMatcher("/(/")).toThrow(UsageError);
  });
});

describe("selectScenarios", () => {
  test("without --only, everything, in order", () => {
    expect(names(SCENARIOS)).toEqual(SCENARIOS.map((s) => s.name));
  });

  test("one match runs alone", () => {
    expect(names(SCENARIOS, "answers a mention")).toEqual(["answers a mention"]);
  });

  test("a match that needs others pulls them in first, transitively, in the original order", () => {
    expect(names(SCENARIOS, "leftovers")).toEqual([
      "+forgets a deleted message",
      "+catches up after a restart",
      "+the admin API forgets deleted messages too",
      "a check on the admin API's leftovers",
    ]);
  });

  test("a needed scenario that also matches counts as matched, not as a prerequisite", () => {
    expect(names(SCENARIOS, "/forgets/")).toEqual(["forgets a deleted message", "+catches up after a restart", "the admin API forgets deleted messages too"]);
  });

  test("a pattern matching nothing is an error that says nothing ran", () => {
    expect(() => selectScenarios(SCENARIOS, "no such scenario")).toThrow(/matches none of the 7 scenarios; nothing ran/);
    expect(() => selectScenarios(SCENARIOS, "/^$/")).toThrow(UsageError);
  });

  test("a need naming no scenario, or a later one, is a mistake in the suite", () => {
    expect(() => selectScenarios([{ name: "a", needs: ["missing"] }])).toThrow(/no scenario/);
    expect(() => selectScenarios([{ name: "a", needs: ["b"] }, { name: "b" }])).toThrow(/runs after it/);
    expect(() => selectScenarios([{ name: "a" }, { name: "a" }])).toThrow(/share a name/);
  });
});
