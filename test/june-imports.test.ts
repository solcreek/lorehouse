// June is wired in src/app.ts and nowhere else (ADR 0001, ADR 0002 §1). The rule, exactly:
//
//   1. Outside src/app.ts, no file in src/ has a runtime import from `@junejs/core`,
//      `@junejs/server` or `@junejs/db`, or any path under them. A runtime import is one
//      that survives type erasure: `import`, `export … from`, `export * from`, `import()`
//      and `require()`. Type-only imports (`import type`, `import { type X }`, `export
//      type … from`, `import("…").X` in a type) are allowed: the tools and guards take
//      June's Tool and Channel types, and that is not wiring.
//   2. Any other `@junejs/*` package is a runtime import only where it is listed below:
//      `@junejs/pdf*`, the PDF renderer, in src/tools/render-pdf.ts.
//   3. src/profiles.ts names no `@junejs/*` module at all, types included.
//   4. Nowhere in src/, app.ts included, is there an `import()` or `require()` of anything
//      but a string literal: a computed path could name June and no scan would see it.
//
// The imports are read with Bun's transpiler, not a regex over the text: it erases types
// and comments first, so `import { type Tool }` is not an import and a comment is not code.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const transpiler = new Bun.Transpiler({ loader: "ts" });

// The framework: only src/app.ts may import these at runtime.
const FRAMEWORK = /^@junejs\/(?:core|server|db)(?:\/|$)/;
// Other June packages, and the one file each may be imported in at runtime.
const LIBRARIES: [RegExp, string][] = [[/^@junejs\/pdf(?:-[a-z0-9-]+)?(?:\/|$)/, "tools/render-pdf.ts"]];

type RuntimeImport = { how: "import" | "import()" | "require()"; path: string | null };

// Every import of `source` that survives type erasure. `path` is null for an import() or
// require() whose argument isn't exactly one string literal.
function runtimeImports(source: string): RuntimeImport[] {
  const found: RuntimeImport[] = transpiler.scan(source).imports.filter((i) => i.kind === "import-statement").map((i) => ({ how: "import", path: i.path }));
  // import() and require() are read from the erased JavaScript, with every string literal
  // set aside first, so text inside a string is never taken for a call.
  const strings: string[] = [];
  const code = transpiler.transformSync(source).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (literal) => `"${strings.push(literal.slice(1, -1)) - 1}"`);
  for (const call of code.matchAll(/(?<![.\w$])(import|require)\s*\(\s*(?:"(\d+)"\s*\))?/g)) {
    found.push({ how: call[1] === "import" ? "import()" : "require()", path: call[2] === undefined ? null : strings[Number(call[2])]! });
  }
  return found;
}

// What `source`, as src/<file>, does that the rule forbids; [] when it keeps to it.
function violations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const { how, path } of runtimeImports(source)) {
    if (path === null) out.push(`${how} of something that isn't a string literal`);
    else if (file === "app.ts" || !path.startsWith("@junejs/")) continue;
    else if (FRAMEWORK.test(path)) out.push(`${how} "${path}": the framework is wired only in app.ts`);
    else if (!LIBRARIES.some(([pkg, where]) => pkg.test(path) && where === file)) out.push(`${how} "${path}": not a June package this file may import`);
  }
  if (file === "profiles.ts" && /["'`]@junejs\//.test(source)) out.push("names a @junejs module: profiles.ts takes nothing from June, types included");
  return out;
}

describe("June stays in src/app.ts", () => {
  test("no file in src/ breaks the rule", () => {
    const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((f) => /\.ts$/.test(f) && !f.endsWith(".d.ts")).map((f) => f.replaceAll("\\", "/"));
    expect(files).toContain("app.ts");
    expect(files).toContain("tools/render-pdf.ts");
    const broken = files.flatMap((f) => violations(f, readFileSync(join(SRC, f), "utf8")).map((v) => `src/${f}: ${v}`));
    expect(broken).toEqual([]);
  });

  test("the scan sees what it is for: app.ts imports the framework at runtime, the tools only its types", () => {
    const paths = (file: string) => runtimeImports(readFileSync(join(SRC, file), "utf8")).map((i) => i.path);
    expect(paths("app.ts")).toContain("@junejs/core/agent-config");
    expect(paths("app.ts")).toContain("@junejs/server/agent-native");
    expect(readFileSync(join(SRC, "tools/workspace.ts"), "utf8")).toContain('from "@junejs/core/agent-runtime"');
    expect(paths("tools/workspace.ts").filter((p) => p?.startsWith("@junejs/"))).toEqual([]);
    expect(paths("tools/render-pdf.ts")).toContain("@junejs/pdf");
    expect(paths("sqlite.ts")).toContain("better-sqlite3-multiple-ciphers/linux-x64");
  });

  // Each source as a file that is not app.ts, and what the rule must say about it.
  const flagged: [string, string, RegExp][] = [
    ["a named import", 'import { defineAgent } from "@junejs/core/agent-config";\ndefineAgent({ name: "x" });', /import "@junejs\/core\/agent-config"/],
    ["an import nothing uses", 'import { defineAgent } from "@junejs/core/agent-config";', /import "@junejs\/core\/agent-config"/],
    ["a value beside an inline type", 'import { type Tool, defineAgent } from "@junejs/core/agent-config";\nexport const t = defineAgent({ name: "x" }) as unknown as Tool;', /import "@junejs\/core\/agent-config"/],
    ["a namespace import", 'import * as june from "@junejs/server";\nexport const j = june;', /import "@junejs\/server"/],
    ["a default import of the package root", 'import june from "@junejs/core";\nexport const j = june;', /import "@junejs\/core"/],
    ["an import for its side effects", 'import "@junejs/core";', /import "@junejs\/core"/],
    ["a re-export", 'export { defineAgent } from "@junejs/core/agent-config";', /import "@junejs\/core\/agent-config"/],
    ["a re-export of everything", 'export * from "@junejs/server/agent-native";', /import "@junejs\/server\/agent-native"/],
    ["a multi-line import", 'import {\n  createNativeRuntime,\n  mountAgent,\n} from "@junejs/server/agent-native";\nexport const r = [createNativeRuntime, mountAgent];', /import "@junejs\/server\/agent-native"/],
    ["@junejs/db", 'import { fromPrepare } from "@junejs/db";\nexport const f = fromPrepare;', /import "@junejs\/db"/],
    ["a dynamic import", 'export const m = await import("@junejs/db");', /import\(\) "@junejs\/db"/],
    ["a require", 'export const m = require("@junejs/core/agent-runtime");', /require\(\) "@junejs\/core\/agent-runtime"/],
    ["a dynamic import of a template literal", 'const n = "core";\nexport const m = await import(`@junejs/${n}`);', /import\(\) of something that isn't a string literal/],
    ["a dynamic import of a variable", 'const n = "@junejs/core";\nexport const m = await import(n);', /import\(\) of something that isn't a string literal/],
    ["a dynamic import of a concatenation", 'const n = "core";\nexport const m = await import("@junejs/" + n);', /import\(\) of something that isn't a string literal/],
    ["a dynamic import of two literals joined, which the transpiler folds into one", 'export const m = await import("@junejs/" + "core");', /import\(\) "@junejs\/core": the framework/],
    ["a require of a variable", 'const n = "@junejs/core";\nexport const m = require(n);', /require\(\) of something that isn't a string literal/],
    ["the PDF renderer outside render-pdf.ts", 'import { pdfTools } from "@junejs/pdf";\nexport const p = pdfTools;', /import "@junejs\/pdf": not a June package this file may import/],
    ["a June package the rule doesn't list", 'import { x } from "@junejs/queue";\nexport const q = x;', /import "@junejs\/queue": not a June package this file may import/],
  ];
  for (const [what, source, problem] of flagged) {
    test(`flagged outside app.ts: ${what}`, () => {
      expect(violations("tools/example.ts", source)).toEqual([expect.stringMatching(problem)]);
    });
  }

  const allowed: [string, string][] = [
    ["a type-only import", 'import type { Tool } from "@junejs/core/agent-runtime";\nexport const t: Tool | undefined = undefined;'],
    ["an inline type import", 'import { type Tool, type ToolContext } from "@junejs/core/agent-runtime";\nexport const f = (t: Tool, c: ToolContext) => [t, c];'],
    ["a type-only re-export", 'export type { Tool } from "@junejs/core/agent-runtime";'],
    ["a type written as import()", 'export const f = (t: import("@junejs/core/agent-runtime").Tool) => t;\nexport type J = typeof import("@junejs/server");'],
    ["an import in a comment", '// import { defineAgent } from "@junejs/core/agent-config";\n/* export * from "@junejs/server"; */\nexport const x = 1;'],
    ["an import in a string", 'export const s = "import { defineAgent } from \'@junejs/core\'";\nexport const d = \'await import("@junejs/db") and require(name)\';'],
    ["another package, and a literal dynamic import of one", 'import { join } from "node:path";\nexport const m = await import("node:fs");\nexport const j = join;'],
    ["a method named import or require", 'const o = { import: (n: string) => n, require: (n: string) => n };\nconst n = "x";\nexport const r = [o.import(n), o.require(n)];'],
  ];
  for (const [what, source] of allowed) {
    test(`not flagged: ${what}`, () => {
      expect(violations("tools/example.ts", source)).toEqual([]);
    });
  }

  test("src/app.ts may import the framework, but not by a computed path", () => {
    expect(violations("app.ts", 'import { defineAgent } from "@junejs/core/agent-config";\nexport const d = defineAgent;\nexport const m = await import("@junejs/db");')).toEqual([]);
    expect(violations("app.ts", 'const n = "@junejs/core";\nexport const m = await import(n);')).toEqual(["import() of something that isn't a string literal"]);
  });

  test("the PDF renderer is a runtime import in src/tools/render-pdf.ts only, and the framework isn't one even there", () => {
    const pdf = 'import { pdfTools } from "@junejs/pdf";\nimport { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";\nimport { typstWasmRenderer } from "@junejs/pdf-typst-wasm";\nexport const p = [pdfTools, notoSansTC, typstWasmRenderer];';
    expect(violations("tools/render-pdf.ts", pdf)).toEqual([]);
    expect(violations("tools/workspace.ts", pdf)).toHaveLength(3);
    expect(violations("tools/render-pdf.ts", 'import { defineAgent } from "@junejs/core/agent-config";\nexport const d = defineAgent;')).toHaveLength(1);
  });

  test("src/profiles.ts takes nothing from June, not even a type", () => {
    const refusal = ["names a @junejs module: profiles.ts takes nothing from June, types included"];
    expect(violations("profiles.ts", 'import type { Tool } from "@junejs/core/agent-runtime";\nexport type P = { tools: Tool[] };')).toEqual(refusal);
    expect(violations("profiles.ts", 'export type P = { tools: import("@junejs/core/agent-runtime").Tool[] };')).toEqual(refusal);
    expect(violations("profiles.ts", "// June's defineAgent takes this in src/app.ts.\nexport type P = { tools: string[] };")).toEqual([]);
    // The same type-only import is fine in a tool.
    expect(violations("tools/example.ts", 'import type { Tool } from "@junejs/core/agent-runtime";\nexport type P = { tools: Tool[] };')).toEqual([]);
  });
});
