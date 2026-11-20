// widgets.ts — the sandbox the code cases share: a checkout of acme/widgets (one of the two
// repos the mock GitHub knows) in a simulated shell (../shell.ts), with the few programs
// the cases' requests run. Each program prints something nobody could guess, so a reply
// that carries it got it from the command.

import type { SandboxScript } from "../sandbox";
import { chartPng } from "../shell";

const TESTS = "bun test v1.4.3\n\ntest/widgets.test.ts:\n(pass) widgets > builds [0.42ms]\n(pass) widgets > prices by size [0.11ms]\n(pass) widgets > ships [0.09ms]\n\n 3 pass\n 0 fail\nRan 3 tests across 1 file. [21.00ms]\n";

// What `make bench` prints (bench/results.json, and their sum).
export const BENCH = "bench build 35 ms\nbench price 60 ms\nbench ship 45 ms\nbench pack 80 ms\nbench load 70 ms\nbench total 290 ms (5 benchmarks)\n";

export const widgets: SandboxScript = {
  shell: {
    files: {
      "README.md": "# widgets\n\nWidgets for Acme.\n\n## Develop\n\n    bun install\n    bun test\n",
      "package.json": JSON.stringify({ name: "widgets", version: "1.4.0", scripts: { test: "bun test", bench: "make bench" } }, null, 2) + "\n",
      "Makefile": "bench:\n\tbun run scripts/bench.ts\n",
      "src/widgets.ts": "export const price = (size: number) => size * 3;\n",
      "test/widgets.test.ts": 'import { expect, test } from "bun:test";\nimport { price } from "../src/widgets";\n\ntest("widgets > prices by size", () => expect(price(2)).toBe(6));\n',
      "scripts/bench.ts": 'import results from "../bench/results.json";\nfor (const r of results) console.log(`bench ${r.name} ${r.ms} ms`);\nconsole.log(`bench total ${results.reduce((n, r) => n + r.ms, 0)} ms (${results.length} benchmarks)`);\n',
      "scripts/count-widgets.sh": "#!/bin/sh\n# Counts the widgets in the catalog.\nexec bun run scripts/count.ts \"$@\"\n",
      "scripts/count.ts": 'import { readFileSync } from "node:fs";\nconsole.log(`widgets counted: ${JSON.parse(readFileSync("catalog.json", "utf8")).length}`);\n',
      "scripts/plot_bench.py": 'import json\nimport matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\n\nruns = json.load(open("bench/results.json"))\nplt.bar([r["name"] for r in runs], [r["ms"] for r in runs])\nplt.ylabel("ms")\nplt.savefig("bench.png", dpi=100)\nprint("wrote bench.png")\n',
      "bench/results.json": '[{"name":"build","ms":35},{"name":"price","ms":60},{"name":"ship","ms":45},{"name":"pack","ms":80},{"name":"load","ms":70}]\n',
    },
    installed: { bun: "1.4.3", python3: "Python 3.12.3", make: "GNU Make 4.3\nBuilt for x86_64-pc-linux-gnu", sh: "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)", bash: "GNU bash, version 5.2.21(1)-release (x86_64-pc-linux-gnu)" },
    programs: [
      { match: /^(sh |bash |\.\/)?(\.\/)?scripts\/count-widgets\.sh\b/, stdout: "widgets counted: 4173\n" },
      { match: /^python3? (\.\/)?scripts\/plot_bench\.py\b/, stdout: "wrote bench.png\n", writes: { "bench.png": chartPng() } },
      { match: /^(bun|npm|pnpm|yarn)( run)? test\b/, stdout: TESTS },
      { match: /^(make bench|bun( run)? (\.\/)?scripts\/bench\.ts)$/, stdout: BENCH },
      { match: /^make (-n|--dry-run|--just-print) bench$/, stdout: "bun run scripts/bench.ts\n" },
    ],
  },
};
