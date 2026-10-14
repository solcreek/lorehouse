// render-pdf.ts — the render_pdf tool (PDF_REPLIES=1): June's @junejs/pdf, on the Typst
// engine compiled to WebAssembly. The tool puts the PDF in the run's file store, and the
// Slack channel uploads it to the thread after the reply.
//
// The engine (~30 MB) is imported as a file, so `bun build --compile` embeds it: the
// package's own loader reads it from node_modules at runtime, which a compiled binary
// doesn't have (junebuild/june#367). It is compiled on the first render, not at start.
//
// Fonts: CJK text renders with Noto Sans TC, which the renderer fetches from Google
// Fonts per document. Without that fetch, CJK characters come out missing, with no error
// (junebuild/june#368).

import wasmPath from "@junejs/pdf-typst-wasm/typst.wasm" with { type: "file" };
import { typstWasmRenderer } from "@junejs/pdf-typst-wasm";
import { pdfTools, type PdfRenderer } from "@junejs/pdf";
import type { Tool } from "@junejs/core/agent-runtime";
import { toolDescription } from "../prompts";

export function typstRenderer(): PdfRenderer {
  return typstWasmRenderer({ wasm: async () => WebAssembly.compile(await Bun.file(wasmPath).arrayBuffer()) });
}

export function renderPdfTool(renderer: PdfRenderer = typstRenderer()): Tool {
  const [tool] = pdfTools({ renderer });
  // The description is Lorehouse's, from prompts/tools/render_pdf.md, like every tool's.
  return { ...tool!, spec: { ...tool!.spec, description: toolDescription("render_pdf") } };
}
