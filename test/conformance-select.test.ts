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

  test("^TEXT is a name that starts with it, TEXT$ one that ends with it, ^TEXT$ the whole name; all ignoring case", () => {
    expect(nameMatcher("^get ")("GET /status needs the bearer token")).toBe(true);
    expect(nameMatcher("^get ")("reports usage at GET /api/v1/usage")).toBe(false);
    expect(nameMatcher("TOKEN$")("GET /status needs the bearer token")).toBe(true);
    expect(nameMatcher("token$")("the token is rotated on start")).toBe(false);
    expect(nameMatcher("^Answers a Mention$")("answers a mention")).toBe(true);
    expect(nameMatcher("^answers a mention$")("answers a mention twice")).toBe(false);
    // Only at the ends: elsewhere they are the characters themselves.
    expect(nameMatcher("costs $5")("a reply that costs $5 is refused")).toBe(true);
    expect(nameMatcher("a^b")("a^b")).toBe(true);
  });

  test("A|B is a name either matches, each with its own anchors", () => {
    const m = nameMatcher("deleted|^catches up|restart$");
    expect(m("the admin API forgets deleted messages too")).toBe(true);
    expect(m("catches up after a restart")).toBe(true);
    expect(m("ingest survives a restart")).toBe(true);
    expect(m("answers a mention")).toBe(false);
  });

  // The pattern is never compiled: what a regular expression would give meaning to is
  // text here, so no pattern can be malformed, slow, or mean more than it says.
  test("the characters of a regular expression are only themselves", () => {
    expect(nameMatcher("(a+)+")("the (a+)+ case")).toBe(true);
    expect(nameMatcher("(a+)+")("aaaa")).toBe(false);
    expect(nameMatcher(".*")("anything at all")).toBe(false);
    expect(nameMatcher("[cite:")("echoes the top hit as [cite:…]")).toBe(true);
    expect(nameMatcher("/^get /")("GET /status needs the bearer token")).toBe(false); // the old /RE/ form is text too
  });

  test("an alternative with nothing in it is a usage error, naming the forms", () => {
    for (const pattern of ["a|", "|a", "a||b", "^", "$", "^$", "a|^$"]) {
      expect(() => nameMatcher(pattern)).toThrow(UsageError);
    }
    expect(() => nameMatcher("a|")).toThrow(/TEXT, \^TEXT, TEXT\$, \^TEXT\$/);
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
    expect(names(SCENARIOS, "forgets")).toEqual(["forgets a deleted message", "+catches up after a restart", "the admin API forgets deleted messages too"]);
  });

  test("a pattern matching nothing is an error that says nothing ran", () => {
    expect(() => selectScenarios(SCENARIOS, "no such scenario")).toThrow(/matches none of the 7 scenarios; nothing ran/);
    // A pattern written as the /RE/ this used to take says what to write instead.
    expect(() => selectScenarios(SCENARIOS, "/^GET /")).toThrow(/matches none of the 7 scenarios; nothing ran\. A \/regular expression\/ is not taken: write \^TEXT for a name that starts with it, TEXT\$ for one that ends with it, A\|B for either/);
    expect(() => selectScenarios(SCENARIOS, "no such scenario")).not.toThrow(/regular expression/);
    expect(() => selectScenarios(SCENARIOS, "/^$/")).toThrow(UsageError);
  });

  test("a need naming no scenario, or a later one, is a mistake in the suite", () => {
    expect(() => selectScenarios([{ name: "a", needs: ["missing"] }])).toThrow(/no scenario/);
    expect(() => selectScenarios([{ name: "a", needs: ["b"] }, { name: "b" }])).toThrow(/runs after it/);
    expect(() => selectScenarios([{ name: "a" }, { name: "a" }])).toThrow(/share a name/);
  });
});
