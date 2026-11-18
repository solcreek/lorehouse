// June is wired in src/app.ts and nowhere else (ADR 0001, ADR 0002 §1). This is a lint
// against wiring June somewhere else by accident, not a sandbox. The rule, exactly:
//
//   1. Outside src/app.ts, no file in src/ has a runtime import of the framework:
//      `@junejs/core`, `@junejs/server` or `@junejs/db`, by any spelling of the specifier
//      that names the package (a subpath, another case, `npm:@junejs/core`, a path through
//      `node_modules/@junejs/core`). A runtime import is one that survives type erasure:
//      `import`, `export … from`, `export * from`, `import("…")` and `require("…")`.
//      Type-only imports (`import type`, `import { type X }`, `export type … from`,
//      `import("…").X` in a type) are allowed: the tools and guards take June's Tool and
//      Channel types, and that is not wiring.
//   2. Any other `@junejs/*` package is a runtime import only where it is listed below:
//      `@junejs/pdf` and `@junejs/pdf-*`, the PDF renderer, in src/tools/render-pdf.ts.
//   3. src/profiles.ts does not contain the text `@junejs` at all: no import, no type, not
//      even a comment.
//   4. Nowhere in src/, app.ts included, is a module loaded by a path the lint can't read:
//      no `import()` whose first argument isn't a string literal, no reference to `require`
//      other than a call with one string literal (so no alias, `require.call`,
//      `import.meta.require`, `globalThis.require` or `module.require`), and no import of
//      `node:module` (createRequire).
//   5. Every file under src/ is read, and a file with an extension this lint has no loader
//      for fails it.
//
// How it reads a file: Bun's transpiler erases types and comments and reports the static
// and literal dynamic imports (`scan`). `require` is found by asking the transpiler to
// rename every free reference to it (`define`), so a property or a string named "require"
// is never taken for one. An `import()` of a non-literal is found by a small lexer over
// the erased JavaScript, which knows strings, templates, comments and regex literals; the
// literal `import()` calls it finds must be the ones `scan` reports, or the file is flagged
// to be read by hand.
//
// What it cannot catch, so nobody reads it as a guarantee:
//   • a file that imports a June value from ./app (app.ts re-exporting it), or from any
//     other module that imports June: only direct imports are read;
//   • code built at run time: `eval`, `new Function`, a `Bun.plugin` that resolves another
//     name to June, a loader hook;
//   • a `require` reached through a name this lint doesn't know (`process.mainModule`), or
//     a local variable named `require` that is in fact the real one, passed in;
//   • a regex literal the lexer takes for a division (after `)`, as in `if (x) /re/.test(y)`)
//     and that holds a quote: what follows may be misread. A literal import hidden that way
//     is caught by the cross-check with `scan`; a non-literal one is not.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

// The loader for each source extension. Anything else under src/ fails the lint.
const LOADERS: Record<string, "ts" | "tsx" | "js"> = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".js": "js", ".mjs": "js", ".cjs": "js" };
// Every free reference to `require`, however it is reached, is renamed to this.
const REQUIRE = "__JUNE_LINT_REQUIRE__";
const REQUIRE_NAMES = ["require", "import.meta.require", "globalThis.require", "module.require"];
const transpilers = new Map<string, InstanceType<typeof Bun.Transpiler>>();
const transpilerFor = (loader: "ts" | "tsx" | "js") => {
  if (!transpilers.has(loader)) transpilers.set(loader, new Bun.Transpiler({ loader, define: Object.fromEntries(REQUIRE_NAMES.map((n) => [n, REQUIRE])) }));
  return transpilers.get(loader)!;
};

// The framework: only src/app.ts may import these at runtime.
const FRAMEWORK = ["core", "server", "db"];
// Other June packages, and the one file each may be imported in at runtime.
const LIBRARIES: [(pkg: string) => boolean, string][] = [[(pkg) => pkg === "pdf" || pkg.startsWith("pdf-"), "tools/render-pdf.ts"]];

// The June package a specifier names, wherever `@junejs` appears in it and in any case:
// "core" for "@junejs/core/agent-config", "npm:@JuneJS/core" and
// "../node_modules/@junejs/core/dist/x.js"; "" for one that names June but no package;
// undefined for a specifier that has nothing to do with June.
function junePackage(specifier: string): string | undefined {
  const m = /@junejs(?:[\\/]+([a-z0-9._-]+))?/i.exec(specifier);
  return m ? (m[1] ?? "").toLowerCase() : undefined;
}

type Token = { t: "id" | "str" | "tpl" | "regex" | "num" | "p"; v: string };
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

// The tokens of erased JavaScript, as much as finding `import(` needs: strings, templates
// (the code inside `${…}` is lexed, the text is not), comments and regex literals are told
// apart, so a quote or an `import(` inside one of them is not code.
function lex(js: string): Token[] {
  const out: Token[] = [];
  const isIdent = (c: string) => /[\w$]/.test(c) || c.charCodeAt(0) > 127;
  // Lexes from `i` to the end, or inside a template's `${…}` to its closing brace.
  const run = (i: number, inTemplate: boolean): number => {
    let depth = 0;
    while (i < js.length) {
      const c = js[i]!;
      if (/\s/.test(c)) i++;
      else if (c === "/" && js[i + 1] === "/") while (i < js.length && js[i] !== "\n") i++;
      else if (c === "/" && js[i + 1] === "*") i = js.indexOf("*/", i + 2) < 0 ? js.length : js.indexOf("*/", i + 2) + 2;
      else if (c === '"' || c === "'") {
        const start = i++;
        while (i < js.length && js[i] !== c && js[i] !== "\n") i += js[i] === "\\" ? 2 : 1;
        out.push({ t: "str", v: js.slice(start, ++i) });
      } else if (c === "`") {
        out.push({ t: "tpl", v: "`" });
        i++;
        while (i < js.length && js[i] !== "`") {
          if (js[i] === "\\") i += 2;
          else if (js[i] === "$" && js[i + 1] === "{") i = run(i + 2, true);
          else i++;
        }
        i++;
      } else if (c === "/") {
        const prev = out[out.length - 1];
        const regex = !prev || (prev.t === "p" && prev.v !== ")" && prev.v !== "]") || (prev.t === "id" && REGEX_AFTER.has(prev.v));
        if (!regex) {
          out.push({ t: "p", v: c });
          i++;
          continue;
        }
        const start = i++;
        for (let inClass = false; i < js.length && js[i] !== "\n" && (inClass || js[i] !== "/"); i++) {
          if (js[i] === "\\") i++;
          else if (js[i] === "[") inClass = true;
          else if (js[i] === "]") inClass = false;
        }
        i++;
        while (i < js.length && /[a-z]/i.test(js[i]!)) i++;
        out.push({ t: "regex", v: js.slice(start, i) });
      } else if (/[0-9]/.test(c)) {
        const start = i;
        while (i < js.length && (isIdent(js[i]!) || js[i] === ".")) i++;
        out.push({ t: "num", v: js.slice(start, i) });
      } else if (isIdent(c)) {
        const start = i;
        while (i < js.length && isIdent(js[i]!)) i++;
        out.push({ t: "id", v: js.slice(start, i) });
      } else if (js.startsWith("...", i)) {
        out.push({ t: "p", v: "..." });
        i += 3;
      } else {
        if (inTemplate && c === "{") depth++;
        if (inTemplate && c === "}" && depth-- === 0) return i + 1;
        out.push({ t: "p", v: c });
        i++;
      }
    }
    return i;
  };
  run(0, false);
  return out;
}

// Every `import(` call in the tokens, and whether its first argument is one string literal
// (what may follow it, as in `import("./x.json", { with: … })`, doesn't matter). A property
// (`o.import(x)`) and a method definition (`{ import(n) { … } }`) are not calls of it.
function importCalls(tokens: Token[]): { literal: boolean }[] {
  const calls: { literal: boolean }[] = [];
  const is = (k: number, v: string) => tokens[k]?.t === "p" && tokens[k]!.v === v;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.t !== "id" || tokens[i]!.v !== "import" || !is(i + 1, "(") || is(i - 1, ".")) continue;
    let close = i + 1;
    for (let depth = 0; close < tokens.length; close++) {
      if (is(close, "(")) depth++;
      else if (is(close, ")") && --depth === 0) break;
    }
    if (is(close + 1, "{")) continue; // a method named import
    calls.push({ literal: tokens[i + 2]?.t === "str" && (is(i + 3, ")") || is(i + 3, ",")) });
  }
  return calls;
}

// What `source`, as src/<file>, does that the rule forbids; [] when it keeps to it.
function violations(file: string, source: string): string[] {
  const loader = LOADERS[extname(file)];
  if (!loader) return [`has an extension the lint has no loader for (${extname(file) || "none"})`];
  if (source.includes(REQUIRE)) return [`contains the lint's own marker ${REQUIRE}`];
  const out: string[] = [];
  const transpiler = transpilerFor(loader);
  const js = transpiler.transformSync(source);
  const scanned = transpiler.scan(source).imports;

  // Each module loaded by a literal path: static and dynamic imports, and require("…").
  const loaded: { how: string; path: string }[] = scanned.map((i) => ({ how: i.kind === "dynamic-import" ? "import()" : i.kind === "import-statement" ? "import" : i.kind, path: i.path }));
  for (const use of js.matchAll(new RegExp(`${REQUIRE}(\\(\\s*("(?:[^"\\\\\\n]|\\\\.)*")\\s*\\))?`, "g"))) {
    let path: unknown;
    try {
      path = use[2] === undefined ? undefined : JSON.parse(use[2]);
    } catch {
      path = undefined;
    }
    if (typeof path === "string") loaded.push({ how: "require()", path });
    else out.push('a reference to require that isn\'t require("a string literal")');
  }
  for (const { how, path } of loaded) {
    const pkg = junePackage(path);
    if (pkg === undefined) {
      if (/^(?:node:)?module$/.test(path)) out.push(`${how} "${path}": createRequire loads modules by a path the lint can't read`);
    } else if (file === "app.ts") continue;
    else if (FRAMEWORK.includes(pkg)) out.push(`${how} "${path}": the framework is wired only in app.ts`);
    else if (!LIBRARIES.some(([lib, where]) => lib(pkg) && where === file)) out.push(`${how} "${path}": not a June package this file may import`);
  }

  // import() of something that isn't a literal, by the lexer; its literal ones must be scan's.
  const calls = importCalls(lex(js));
  for (const call of calls) if (!call.literal) out.push("import() of something that isn't a string literal");
  const literal = calls.filter((c) => c.literal).length;
  const dynamic = scanned.filter((i) => i.kind === "dynamic-import").length;
  if (literal !== dynamic) out.push(`the lexer found ${literal} literal import() call(s) and the transpiler ${dynamic}: read this file by hand`);

  if (file === "profiles.ts" && /@junejs/i.test(source)) out.push("contains the text @junejs: profiles.ts takes nothing from June, types included");
  return out;
}

// Every file under src/, as a path from it with forward slashes.
function sourceFiles(): string[] {
  return (readdirSync(SRC, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).filter((f) => statSync(join(SRC, f)).isFile()).sort();
}

describe("June stays in src/app.ts", () => {
  test("every file under src/ is one the lint can read", () => {
    const files = sourceFiles();
    expect(files).toContain("app.ts");
    expect(files).toContain("tools/render-pdf.ts");
    expect(files.filter((f) => !LOADERS[extname(f)])).toEqual([]);
  });

  test("no file in src/ breaks the rule", () => {
    const broken = sourceFiles().flatMap((f) => violations(f, readFileSync(join(SRC, f), "utf8")).map((v) => `src/${f}: ${v}`));
    expect(broken).toEqual([]);
  });

  test("the lint sees what it is for: app.ts imports the framework at runtime, the tools only its types, sqlite.ts requires by literal", () => {
    const transpiler = transpilerFor("ts");
    const paths = (file: string) => transpiler.scan(readFileSync(join(SRC, file), "utf8")).imports.map((i) => i.path);
    expect(paths("app.ts")).toContain("@junejs/core/agent-config");
    expect(paths("app.ts")).toContain("@junejs/server/agent-native");
    expect(readFileSync(join(SRC, "tools/workspace.ts"), "utf8")).toContain('from "@junejs/core/agent-runtime"');
    expect(paths("tools/workspace.ts").filter((p) => junePackage(p) !== undefined)).toEqual([]);
    expect(paths("tools/render-pdf.ts")).toContain("@junejs/pdf");
    expect(transpiler.transformSync(readFileSync(join(SRC, "sqlite.ts"), "utf8"))).toContain(`${REQUIRE}("better-sqlite3-multiple-ciphers/linux-x64")`);
  });

  test("a specifier names a June package wherever @junejs appears in it, in any case", () => {
    expect(junePackage("@junejs/core")).toBe("core");
    expect(junePackage("@junejs/core/agent-config")).toBe("core");
    expect(junePackage("@JuneJS/Server")).toBe("server");
    expect(junePackage("npm:@junejs/db@0.2.2")).toBe("db");
    expect(junePackage("../node_modules/@junejs/core/dist/x.js")).toBe("core");
    expect(junePackage("..\\node_modules\\@junejs\\core\\dist\\x.js")).toBe("core");
    expect(junePackage("@junejs/pdf-typst-wasm")).toBe("pdf-typst-wasm");
    expect(junePackage("@junejs")).toBe("");
    expect(junePackage("june")).toBeUndefined();
    expect(junePackage("node:path")).toBeUndefined();
  });

  const FRAMEWORK_ONLY = /the framework is wired only in app\.ts/;
  const NOT_LITERAL = /^import\(\) of something that isn't a string literal$/;
  const NOT_A_CALL = /^a reference to require that isn't require\("a string literal"\)$/;
  // Each source as a file that is not app.ts, and what the rule must say about it.
  const flagged: [string, string, RegExp][] = [
    ["a named import", 'import { defineAgent } from "@junejs/core/agent-config";\ndefineAgent({ name: "x" });', /^import "@junejs\/core\/agent-config": the framework/],
    ["an import nothing uses", 'import { defineAgent } from "@junejs/core/agent-config";', /^import "@junejs\/core\/agent-config"/],
    ["a value beside an inline type", 'import { type Tool, defineAgent } from "@junejs/core/agent-config";\nexport const t = defineAgent({ name: "x" }) as unknown as Tool;', /^import "@junejs\/core\/agent-config"/],
    ["a namespace import", 'import * as june from "@junejs/server";\nexport const j = june;', /^import "@junejs\/server"/],
    ["a default import of the package root", 'import june from "@junejs/core";\nexport const j = june;', /^import "@junejs\/core"/],
    ["an import for its side effects", 'import "@junejs/core";', /^import "@junejs\/core"/],
    ["a re-export", 'export { defineAgent } from "@junejs/core/agent-config";', /^import "@junejs\/core\/agent-config"/],
    ["a re-export of everything", 'export * from "@junejs/server/agent-native";', /^import "@junejs\/server\/agent-native"/],
    ["a multi-line import", 'import {\n  createNativeRuntime,\n  mountAgent,\n} from "@junejs/server/agent-native";\nexport const r = [createNativeRuntime, mountAgent];', /^import "@junejs\/server\/agent-native"/],
    ["@junejs/db", 'import { fromPrepare } from "@junejs/db";\nexport const f = fromPrepare;', /^import "@junejs\/db"/],
    ["the package in another case", 'import { defineAgent } from "@JuneJS/Core/agent-config";\nexport const d = defineAgent;', FRAMEWORK_ONLY],
    ["a path through node_modules", 'import { defineAgent } from "../node_modules/@junejs/core/dist/agent-config.js";\nexport const d = defineAgent;', FRAMEWORK_ONLY],
    ["an npm: specifier", 'import { defineAgent } from "npm:@junejs/core";\nexport const d = defineAgent;', FRAMEWORK_ONLY],
    ["a dynamic import", 'export const m = await import("@junejs/db");', /^import\(\) "@junejs\/db": the framework/],
    ["a dynamic import between two regex literals that hold a quote", 'export const m = [/"/, await import("@junejs/core"), /"/];', /^import\(\) "@junejs\/core": the framework/],
    ["a dynamic import after a string that holds a quote and a template", "export const m = ['\"', `'${1}\"`, await import(\"@junejs/server\")];", /^import\(\) "@junejs\/server": the framework/],
    ["a dynamic import with options", 'export const m = await import("@junejs/core", { with: { type: "json" } });', /^import\(\) "@junejs\/core": the framework/],
    ["a dynamic import of two literals joined, which the transpiler folds into one", 'export const m = await import("@junejs/" + "core");', /^import\(\) "@junejs\/core": the framework/],
    ["a dynamic import of a template literal", 'const n = "core";\nexport const m = await import(`@junejs/${n}`);', NOT_LITERAL],
    ["a dynamic import of a variable", 'const n = "@junejs/core";\nexport const m = await import(n);', NOT_LITERAL],
    ["a dynamic import of a concatenation", 'const n = "core";\nexport const m = await import("@junejs/" + n);', NOT_LITERAL],
    ["a dynamic import of a variable inside a template's ${}", 'const n = "@junejs/core";\nexport const s = `${await import(n)}`;', NOT_LITERAL],
    ["a dynamic import of a variable after a regex that holds a quote", 'const n = "@junejs/core";\nexport const m = [/["\']/g, await import(n)];', NOT_LITERAL],
    ["a spread dynamic import of a variable", 'const n = "x";\nexport const m = [...(await import(n)).default, ...await import(n)];', NOT_LITERAL],
    ["a require", 'export const m = require("@junejs/core/agent-runtime");', /^require\(\) "@junejs\/core\/agent-runtime": the framework/],
    ["a require of a variable", 'const n = "@junejs/core";\nexport const m = require(n);', NOT_A_CALL],
    ["require under another name", 'const load = require;\nexport const m = load("@junejs/core");', NOT_A_CALL],
    ["require.call", 'export const m = require.call(null, "@junejs/core");', NOT_A_CALL],
    ["require.resolve", 'export const m = require.resolve("@junejs/core");', NOT_A_CALL],
    ["import.meta.require", 'export const m = import.meta.require("@junejs/core");', /^require\(\) "@junejs\/core": the framework/],
    ["import.meta.require of a variable", 'const n = "@junejs/core";\nexport const m = import.meta.require(n);', NOT_A_CALL],
    ["globalThis.require", 'export const m = (globalThis as any).require ?? globalThis.require;', NOT_A_CALL],
    ["a test for require", 'export const has = typeof require === "function";', NOT_A_CALL],
    ["createRequire", 'import { createRequire } from "node:module";\nexport const m = createRequire(import.meta.url)("@junejs/core");', /^import "node:module": createRequire/],
    ["the PDF renderer outside render-pdf.ts", 'import { pdfTools } from "@junejs/pdf";\nexport const p = pdfTools;', /^import "@junejs\/pdf": not a June package this file may import$/],
    ["a June package the rule doesn't list", 'import { x } from "@junejs/queue";\nexport const q = x;', /^import "@junejs\/queue": not a June package this file may import$/],
    ["the scope with no package", 'import * as j from "@junejs";\nexport const q = j;', /^import "@junejs": not a June package this file may import$/],
  ];
  for (const [what, source, problem] of flagged) {
    test(`flagged outside app.ts: ${what}`, () => {
      const found = violations("tools/example.ts", source);
      expect(found.length).toBeGreaterThan(0);
      for (const v of found) expect(v).toMatch(problem);
    });
  }

  const allowed: [string, string][] = [
    ["a type-only import", 'import type { Tool } from "@junejs/core/agent-runtime";\nexport const t: Tool | undefined = undefined;'],
    ["an inline type import", 'import { type Tool, type ToolContext } from "@junejs/core/agent-runtime";\nexport const f = (t: Tool, c: ToolContext) => [t, c];'],
    ["a type-only re-export", 'export type { Tool } from "@junejs/core/agent-runtime";'],
    ["a type written as import()", 'export const f = (t: import("@junejs/core/agent-runtime").Tool) => t;\nexport type J = typeof import("@junejs/server");'],
    ["an import in a comment", '// import { defineAgent } from "@junejs/core/agent-config";\n/* export * from "@junejs/server"; await import(name); require(name) */\nexport const x = 1;'],
    ["an import in a string", 'export const s = "import { defineAgent } from \'@junejs/core\'";\nexport const d = \'await import(name) and require(name) and "\';'],
    ["an import in a template's text", 'const n = 1;\nexport const s = `await import(name), require(name) and import("@junejs/core") ${n} import(more)`;'],
    ["an import in a regex", 'export const r = /import\\(name\\)|require\\(name\\)|["\'`]/g;'],
    ["another package, and a literal dynamic import of one", 'import { join } from "node:path";\nexport const m = await import("node:fs");\nexport const j = join;'],
    ["a literal dynamic import with options", 'export const j = await import("./x.json", { with: { type: "json" } });'],
    ["a literal dynamic import inside a template's ${}", 'export const s = `${(await import("node:os")).EOL}`;'],
    ["a require of a literal that isn't June", 'export const addon = require("better-sqlite3-multiple-ciphers/linux-x64");'],
    ["a method named import or require, defined and called", 'const o = { import(n: string) { return n; }, require(n: string) { return n; }, load: (n: string) => n };\nconst n = "x";\nexport const r = [o.import(n), o.require(n), o?.import(n), o.load(n)];'],
    ["a property and a key named require", 'export const schema = { required: ["a"], require: true };\nexport const k = schema.require;'],
    ["import.meta", 'export const here = import.meta.dir + import.meta.url;'],
    ["a division, and a regex after a keyword", 'const a = 6, b = 3;\nexport const q = a / b / 2;\nexport const f = (s: string) => { return /"/.test(s) ? a / b : b; };'],
  ];
  for (const [what, source] of allowed) {
    test(`not flagged: ${what}`, () => {
      expect(violations("tools/example.ts", source)).toEqual([]);
    });
  }

  test("src/app.ts may import the framework, but not by a path the lint can't read", () => {
    expect(violations("app.ts", 'import { defineAgent } from "@junejs/core/agent-config";\nexport const d = defineAgent;\nexport const m = await import("@junejs/db");')).toEqual([]);
    expect(violations("app.ts", 'const n = "@junejs/core";\nexport const m = await import(n);')).toEqual(["import() of something that isn't a string literal"]);
    expect(violations("app.ts", "const load = require;\nexport const m = load;")).toEqual(['a reference to require that isn\'t require("a string literal")']);
    expect(violations("app.ts", 'import { createRequire } from "node:module";\nexport const c = createRequire;')).toEqual([expect.stringMatching(/^import "node:module": createRequire/)]);
  });

  test("the PDF renderer is a runtime import in src/tools/render-pdf.ts only, and the framework isn't one even there", () => {
    const pdf = 'import { pdfTools } from "@junejs/pdf";\nimport { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";\nimport { typstWasmRenderer } from "@junejs/pdf-typst-wasm";\nexport const p = [pdfTools, notoSansTC, typstWasmRenderer];';
    expect(violations("tools/render-pdf.ts", pdf)).toEqual([]);
    expect(violations("tools/workspace.ts", pdf)).toHaveLength(3);
    expect(violations("tools/render-pdf.ts", 'import { defineAgent } from "@junejs/core/agent-config";\nexport const d = defineAgent;')).toHaveLength(1);
  });

  test("src/profiles.ts takes nothing from June: not a type, not even the name in a comment", () => {
    const refusal = ["contains the text @junejs: profiles.ts takes nothing from June, types included"];
    expect(violations("profiles.ts", 'import type { Tool } from "@junejs/core/agent-runtime";\nexport type P = { tools: Tool[] };')).toEqual(refusal);
    expect(violations("profiles.ts", 'export type P = { tools: import("@junejs/core/agent-runtime").Tool[] };')).toEqual(refusal);
    expect(violations("profiles.ts", "// as @JuneJS/core's defineAgent takes it\nexport type P = { tools: string[] };")).toEqual(refusal);
    expect(violations("profiles.ts", "// June's defineAgent takes this in src/app.ts.\nexport type P = { tools: string[] };")).toEqual([]);
    // The same type-only import is fine in a tool.
    expect(violations("tools/example.ts", 'import type { Tool } from "@junejs/core/agent-runtime";\nexport type P = { tools: Tool[] };')).toEqual([]);
  });

  test("every source extension is read, with its own loader; any other fails the lint", () => {
    const june = 'import { defineAgent } from "@junejs/core/agent-config";\nexport const d = defineAgent;';
    for (const ext of [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"]) expect(violations(`tools/example${ext}`, june), ext).toEqual([expect.stringMatching(FRAMEWORK_ONLY)]);
    expect(violations("tools/example.tsx", 'import { defineAgent } from "@junejs/core/agent-config";\nexport const d = <div>{defineAgent.name}</div>;')).toEqual([expect.stringMatching(FRAMEWORK_ONLY)]);
    expect(violations("tools/example.coffee", "x = 1")).toEqual(["has an extension the lint has no loader for (.coffee)"]);
    expect(violations("tools/Makefile", "all:")).toEqual(["has an extension the lint has no loader for (none)"]);
  });

  test("a file that holds the lint's own marker is flagged, since a string could then pass for require", () => {
    expect(violations("tools/example.ts", `export const s = "${REQUIRE}";`)).toEqual([`contains the lint's own marker ${REQUIRE}`]);
  });
});
