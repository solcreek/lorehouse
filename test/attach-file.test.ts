// workspace_attach_file: what may be attached (by bytes and name), the refusals the model
// reads, and reading bytes the same way over a runner and from a direct sandbox host.

import { describe, expect, test } from "bun:test";
import { memoryFileStore, type FileRef } from "@junejs/core/agent-files";
import { openKnowledge } from "../src/knowledge";
import { RunnerHub, type Job } from "../src/runners/hub";
import { remoteSandbox } from "../src/sandbox-client";
import { MAX_ATTACH_BYTES, attachmentName, classify } from "../src/tools/file-types";
import { takesChannel } from "../src/tools/slack-channels";
import { FileTooLarge, workspaceTools, type Sandbox } from "../src/tools/workspace";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%âã\n1 0 obj\n");
const text = (s: string) => new TextEncoder().encode(s);
const kindOf = (path: string, bytes: Uint8Array) => {
  const v = classify(path, bytes);
  return "kind" in v ? v.kind.mediaType : `refused: ${v.refusal}`;
};

describe("what is attached", () => {
  test("PNG, JPEG and PDF by their bytes, under a matching name", () => {
    expect(kindOf("/w/chart.png", PNG)).toBe("image/png");
    expect(kindOf("/w/shot.JPG", JPEG)).toBe("image/jpeg");
    expect(kindOf("/w/shot.jpeg", JPEG)).toBe("image/jpeg");
    expect(kindOf("/w/report.pdf", PDF)).toBe("application/pdf");
  });

  test("a name that disagrees with the bytes is refused, with the name to use", () => {
    expect(kindOf("/w/chart.png", JPEG)).toBe("refused: chart.png is a JPEG image by its contents, but its name says .png. Rename it to end in .jpg (workspace_exec: mv) and attach that");
    expect(kindOf("/w/chart", PNG)).toContain("its name says nothing (no extension)");
    // The model can't make text into a PNG by naming it one.
    expect(kindOf("/w/evil.png", text("<script>alert(1)</script>"))).toStartWith("refused: evil.png is text, but I attach text only as .csv, .txt, .log or .md, not .png");
  });

  test("CSV and plain text: clean UTF-8 under .csv, .txt, .log or .md", () => {
    expect(kindOf("/w/rows.csv", text("a,b\n1,2\n"))).toBe("text/csv");
    expect(kindOf("/w/out.txt", text("名稱\tok\r\n"))).toBe("text/plain");
    expect(kindOf("/w/run.log", text("ok"))).toBe("text/plain");
    expect(kindOf("/w/NOTES.md", text("# hi"))).toBe("text/plain");
    expect(kindOf("/w/page.html", text("<html></html>"))).toStartWith("refused: page.html is text, but I attach text only as .csv, .txt, .log or .md, not .html. Copy it to such a name (workspace_exec: cp page.html page.txt)");
    expect(kindOf("/w/Makefile", text("all:"))).toContain("and it has no extension");
  });

  test("bytes that are neither an allowed format nor text are refused, whatever the name", () => {
    expect(kindOf("/w/data.csv", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]))).toStartWith("refused: data.csv isn't a type I attach: its bytes aren't PNG, JPEG or PDF, nor UTF-8 text");
    expect(kindOf("/w/a.txt", text("ok\u0000ok"))).toStartWith("refused: a.txt isn't a type I attach");
    expect(kindOf("/w/a.gif", new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x80]))).toStartWith("refused: a.gif isn't a type I attach");
  });

  test("a file named .svg is refused with why and the PNG to make instead", () => {
    const svg = text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const path of ["/w/chart.svg", "/w/chart.SVGZ"]) {
      const v = kindOf(path, svg);
      expect(v).toStartWith("refused: SVG isn't attached: an SVG can carry scripts and links to external files");
      expect(v).toContain("attach the PNG");
    }
  });

  test("text that holds SVG markup is attached as the text its name says, never as an image", () => {
    const svg = text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(kindOf("/w/chart.txt", svg)).toBe("text/plain");
    expect(kindOf("/w/icons.md", text("Use it like this:\n<svg viewBox='0 0 1 1'></svg>"))).toBe("text/plain");
    expect(kindOf("/w/chart.csv", svg)).toBe("text/csv");
    // Named as an image, it must be one by its bytes.
    expect(kindOf("/w/chart.png", svg)).toStartWith("refused: chart.png is text, but I attach text only as");
  });
});

describe("the attachment's name", () => {
  const png = { label: "PNG image", mediaType: "image/png", ext: ".png" };
  test("the title when given, with the kind's extension; else the file's own name", () => {
    expect(attachmentName("/w/out/chart.png", png)).toBe("chart.png");
    expect(attachmentName("/w/out/chart.png", png, "Benchmark: main vs branch")).toBe("Benchmark- main vs branch.png");
    expect(attachmentName("/w/out/chart.png", png, "基準測試.png")).toBe("基準測試.png");
    expect(attachmentName("/w/a.jpeg", { label: "JPEG image", mediaType: "image/jpeg", ext: ".jpg" }, "shot")).toBe("shot.jpeg");
    expect(attachmentName("/w/a.png", png, "../../etc/passwd")).toBe("etc-passwd.png");
    expect(attachmentName("/w/a.png", png, "   ")).toBe("a.png");
    expect([...attachmentName("/w/a.png", png, "x".repeat(300))].length).toBe(104);
  });
});

// A sandbox that serves one file's bytes, or fails as told.
function sandboxWith(files: Record<string, Uint8Array | Error>): Sandbox {
  return {
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async readFile() { return ""; },
    async readBytes(path) {
      const f = files[path];
      if (f instanceof Error) throw f;
      if (!f) throw new Error(`no such file: ${path}`);
      return f;
    },
    async writeFile() {},
    async stage(): Promise<never> { throw new Error("no publishing here"); },
    async push(): Promise<never> { throw new Error("no publishing here"); },
  };
}

function attachTool(files: Record<string, Uint8Array | Error>) {
  const store = memoryFileStore();
  const tool = workspaceTools(() => sandboxWith(files)).find((t) => t.spec.name === "workspace_attach_file")!;
  const run = (input: unknown) => tool.run(input, { sessionId: "slack:C1:1.1", files: store } as never) as Promise<{ file?: FileRef; note?: string; error?: string }>;
  return { tool, store, run };
}

describe("workspace_attach_file", () => {
  test("puts the file's bytes in the file store and returns the ref the channel uploads", async () => {
    const { store, run } = attachTool({ "/workspace/repo/out/chart.png": PNG });
    const r = await run({ path: "out/chart.png", title: "Benchmark" });
    expect(r.file).toMatchObject({ $june: "file", name: "Benchmark.png", mediaType: "image/png", size: PNG.byteLength });
    expect(await store.get(r.file!.id)).toEqual(PNG);
    expect(r.note).toBe("Benchmark.png (PNG image, 16 B) will be attached to this thread after your reply. Don't attach it again; say in a sentence what it shows.");
  });

  test("names no channel or thread: it attaches to the thread being answered, never elsewhere", () => {
    const { tool } = attachTool({});
    expect(takesChannel(tool)).toBe(false);
    expect(Object.keys((tool.spec.input as { properties: object }).properties)).toEqual(["path", "title"]);
  });

  test("every refusal says what was wrong and what to do instead, and stores nothing", async () => {
    const big = new Uint8Array(MAX_ATTACH_BYTES + 1);
    big.set(PNG);
    const { run } = attachTool({
      "/workspace/repo/big.png": big,
      "/workspace/repo/huge.png": new FileTooLarge("/workspace/repo/huge.png", "file is 20000000 bytes; the limit is 16777216"),
      "/workspace/repo/empty.txt": new Uint8Array(),
      "/workspace/repo/dir": new Error("sandbox GET /file: 500 read /workspace/repo/dir: is a directory"),
      "/workspace/repo/chart.svg": text("<svg></svg>"),
    });
    expect((await run({ path: "big.png" })).error).toBe("/workspace/repo/big.png is 10.0 MB; I attach files up to 10.0 MB. Make it smaller in the sandbox (a lower resolution, or JPEG, for an image; fewer rows for a CSV) and attach that");
    expect((await run({ path: "huge.png" })).error).toStartWith("/workspace/repo/huge.png is too large to attach (file is 20000000 bytes; the limit is 16777216); I attach files up to 10.0 MB.");
    expect((await run({ path: "gone.png" })).error).toBe("no such file in the sandbox: /workspace/repo/gone.png. Check the path (workspace_exec: ls -la /workspace/repo/); relative paths resolve against /workspace/repo");
    expect((await run({ path: "empty.txt" })).error).toStartWith("/workspace/repo/empty.txt is empty: nothing to attach.");
    expect((await run({ path: "dir" })).error).toBe("couldn't read /workspace/repo/dir from the sandbox: sandbox GET /file: 500 read /workspace/repo/dir: is a directory");
    expect((await run({ path: "chart.svg" })).error).toStartWith("SVG isn't attached");
    expect((await run({})).error).toStartWith("workspace_attach_file needs `path`");
    expect((await run({ path: "chart.svg", title: 3 })).error).toBe("`title` must be a string (the name the thread shows), or left out");
  });

  test("a sandbox that is down comes back as { error }, not a failed turn", async () => {
    const { run } = attachTool({ "/workspace/repo/a.png": new Error("no sandbox runner is connected") });
    expect(await run({ path: "a.png" })).toEqual({ error: "couldn't read /workspace/repo/a.png from the sandbox: no sandbox runner is connected" });
  });
});

describe("reading bytes", () => {
  const binary = new Uint8Array([...PNG, 0x00, 0xff, 0x80, 0xc3]); // not valid UTF-8: must survive as is

  test("from a direct sandbox host: the body's bytes as they are; 404 and 413 named", async () => {
    const f = (async (url: string) => {
      if (url.includes("missing")) return new Response("not found", { status: 404 });
      if (url.includes("huge")) return new Response("file is 20000000 bytes; the limit is 16777216\n", { status: 413 });
      if (url.includes("dir")) return new Response("is a directory", { status: 500 });
      return new Response(binary);
    }) as typeof fetch;
    const sb = remoteSandbox("s1", { url: "https://fb.example", token: "tok", fetch: f });
    expect(await sb.readBytes("/w/a.png")).toEqual(binary);
    await expect(sb.readBytes("/w/missing")).rejects.toThrow("no such file: /w/missing");
    const huge = await sb.readBytes("/w/huge").catch((e) => e);
    expect(huge).toBeInstanceOf(FileTooLarge);
    expect(huge.detail).toBe("file is 20000000 bytes; the limit is 16777216");
    await expect(sb.readBytes("/w/dir")).rejects.toThrow("sandbox GET /file: 500 is a directory");
  });

  test("over a runner: the result's base64 decoded to the same bytes; 404 and 413 named", async () => {
    const hub = new RunnerHub(openKnowledge(":memory:"));
    const sent: Job[] = [];
    const link = hub.attachWs("r1", (j) => sent.push(j));
    link.status({ runner: "r1", capacity: 4, running: 0 });
    const sb = hub.sandbox("s1");
    const ok = sb.readBytes("/w/a.png");
    expect(sent[0]).toMatchObject({ op: "guest", method: "GET", path: "/file?path=%2Fw%2Fa.png" });
    link.result({ id: sent[0]!.id, status: 200, bodyBase64: Buffer.from(binary).toString("base64") });
    expect(await ok).toEqual(binary);
    const missing = sb.readBytes("/w/missing");
    link.result({ id: sent[1]!.id, status: 404 });
    await expect(missing).rejects.toThrow("no such file: /w/missing");
    const huge = sb.readBytes("/w/huge").catch((e) => e);
    link.result({ id: sent[2]!.id, status: 413, bodyBase64: Buffer.from("file is 20000000 bytes; the limit is 16777216\n").toString("base64") });
    expect(await huge).toBeInstanceOf(FileTooLarge);
    const busy = sb.readBytes("/w/a.png");
    link.result({ id: sent[3]!.id, status: 503, error: "all 4 sandboxes are busy; try again later" });
    await expect(busy).rejects.toThrow("sandbox GET /file: 503 all 4 sandboxes are busy");
  });
});
