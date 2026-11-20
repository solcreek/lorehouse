// widgets.ts — the sandbox the code cases share: the two repos the mock GitHub knows,
// acme/widgets and acme/gadgets, as a simulated shell clones them (../shell.ts), with the
// programs their scripts run. The fixtures agree with themselves: what a script prints is
// what its source, read by a model first, says it will print.

import type { SandboxScript } from "../sandbox";
import { chartPng } from "../shell";

// The catalog scripts/count.ts counts: 137 entries, a number nobody would guess.
export const WIDGETS = 137;
const CATALOG = `${JSON.stringify(Array.from({ length: WIDGETS }, (_, i) => `w${String(i + 1).padStart(3, "0")}`))}\n`;
const RESULTS = [["build", 35], ["price", 60], ["ship", 45], ["pack", 80], ["load", 70]] as const;
// What `make bench` prints: bench/results.json, line by line, and their sum.
export const BENCH = `${RESULTS.map(([name, ms]) => `bench ${name} ${ms} ms\n`).join("")}bench total 290 ms (5 benchmarks)\n`;
const INSTALL = "bun install v1.4.3 (c6da4a4d)\n\nChecked 2 installs across 3 packages (no changes) [12.00ms]\n";
const tests = (file: string, names: string[]) =>
  `bun test v1.4.3 (c6da4a4d)\n\n${file}:\n${names.map((n) => `(pass) ${n} [0.12ms]\n`).join("")}\n ${names.length} pass\n 0 fail\nRan ${names.length} tests across 1 file. [21.00ms]\n`;

export const widgets: SandboxScript = {
  shell: {
    installed: { bun: "1.4.3", python3: "Python 3.12.3", make: "GNU Make 4.3\nBuilt for x86_64-pc-linux-gnu" },
    repos: {
      "acme/widgets": {
        files: {
          "README.md": "# widgets\n\nWidgets for Acme.\n\n## Develop\n\n    bun install\n    bun test\n",
          "package.json": `${JSON.stringify({ name: "widgets", version: "1.4.0", scripts: { test: "bun test", bench: "make bench", count: "bun scripts/count.ts" } }, null, 2)}\n`,
          "Makefile": "bench:\n\tbun scripts/bench.ts\n",
          "catalog.json": CATALOG,
          "src/widgets.ts": "export const build = (name: string) => ({ name });\nexport const price = (size: number) => size * 3;\nexport const ship = (name: string) => `shipped ${name}`;\n",
          "test/widgets.test.ts": 'import { expect, test } from "bun:test";\nimport { build, price, ship } from "../src/widgets";\n\ntest("widgets > builds", () => expect(build("a")).toEqual({ name: "a" }));\ntest("widgets > prices by size", () => expect(price(2)).toBe(6));\ntest("widgets > ships", () => expect(ship("a")).toBe("shipped a"));\n',
          "scripts/count-widgets.sh": "#!/bin/sh\n# Counts the widgets in the catalog.\nexec bun scripts/count.ts\n",
          "scripts/count.ts": 'import { readFileSync } from "node:fs";\nconsole.log(`widgets counted: ${JSON.parse(readFileSync("catalog.json", "utf8")).length}`);\n',
          "scripts/bench.ts": 'import { readFileSync } from "node:fs";\nconst results = JSON.parse(readFileSync("bench/results.json", "utf8"));\nfor (const r of results) console.log(`bench ${r.name} ${r.ms} ms`);\nconsole.log(`bench total ${results.reduce((n, r) => n + r.ms, 0)} ms (${results.length} benchmarks)`);\n',
          "scripts/plot_bench.py": 'import json\nimport matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\n\nruns = json.load(open("bench/results.json"))\nplt.bar([r["name"] for r in runs], [r["ms"] for r in runs])\nplt.ylabel("ms")\nplt.savefig("bench.png", dpi=100)\nprint("wrote bench.png")\n',
          "bench/results.json": `${JSON.stringify(RESULTS.map(([name, ms]) => ({ name, ms })))}\n`,
        },
        programs: [
          { match: /^((sh|bash) |\.\/)?scripts\/count-widgets\.sh$/, stdout: `widgets counted: ${WIDGETS}\n` },
          { match: /^bun (run )?(count|(\.\/)?scripts\/count\.ts)$/, stdout: `widgets counted: ${WIDGETS}\n` },
          { match: /^python3? (\.\/)?scripts\/plot_bench\.py$/, stdout: "wrote bench.png\n", writes: { "bench.png": chartPng() } },
          { match: /^(bun test|(bun|npm|yarn|pnpm) run test|npm test)( test\/?| test\/widgets\.test\.ts)?$/, stdout: tests("test/widgets.test.ts", ["widgets > builds", "widgets > prices by size", "widgets > ships"]) },
          { match: /^(bun|npm) install$/, stdout: INSTALL },
          { match: /^(make bench|(bun|npm) run bench|bun (run )?(\.\/)?scripts\/bench\.ts)$/, stdout: BENCH },
          { match: /^make (-n|--dry-run|--just-print) bench$/, stdout: "bun scripts/bench.ts\n" },
        ],
      },
      "acme/gadgets": {
        files: {
          "README.md": "# gadgets\n\nGadgets for Acme.\n\n## Develop\n\n    bun install\n    bun test\n",
          "package.json": `${JSON.stringify({ name: "gadgets", version: "0.3.0", scripts: { test: "bun test" } }, null, 2)}\n`,
          "src/gadgets.ts": "export const spin = (rpm: number) => rpm * 2;\nexport const stop = () => 0;\n",
          "test/gadgets.test.ts": 'import { expect, test } from "bun:test";\nimport { spin, stop } from "../src/gadgets";\n\ntest("gadgets > spins", () => expect(spin(2)).toBe(4));\ntest("gadgets > stops", () => expect(stop()).toBe(0));\n',
        },
        programs: [
          { match: /^(bun test|(bun|npm|yarn|pnpm) run test|npm test)( test\/?| test\/gadgets\.test\.ts)?$/, stdout: tests("test/gadgets.test.ts", ["gadgets > spins", "gadgets > stops"]) },
          { match: /^(bun|npm) install$/, stdout: INSTALL },
        ],
      },
    },
  },
};
