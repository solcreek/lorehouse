// render-pdf.ts — the render_pdf tool (PDF_REPLIES=1): June's @junejs/pdf, on the Typst
// engine compiled to WebAssembly. The tool puts the PDF in the run's file store, and the
// Slack channel uploads it to the thread after the reply. `bun build --compile` embeds the
// engine and the bundled font: the packages' Bun entries import them as files.
//
// Where the fonts come from decides where a document's text goes (PDF_FONTS):
//   local   Noto Sans TC, bundled (~11 MB): rendering never touches the network
//   google  Noto Sans TC subsets from Google Fonts, cut to each document's characters, so
//           fonts.googleapis.com and fonts.gstatic.com see every distinct non-ASCII
//           character of the document
// Either way, a character no loaded font covers fails the render with an error the model
// reads, instead of a PDF with that character missing.
//
// Noto Sans TC comes first for every character, Latin and digits included: otherwise Typst
// sets those in its default Libertinus Serif, a smaller serif face beside the sans Chinese.
// With google, the subsets cover only non-ASCII characters, so Latin still falls back.
// Noto Sans TC has no italic, and Typst doesn't slant one, so *emphasis* set in it prints
// upright: all of it with local; with google, only the Chinese (Latin slants in Libertinus).
// The pdf-report skill asks for bold instead (a slant for emph is junebuild/june#389).

import { googleFontSubsets, typstWasmRenderer, type FontEgress, type FontProvider, type TypstWasmRenderer } from "@junejs/pdf-typst-wasm";
import { notoSansTC } from "@junejs/pdf-font-noto-sans-tc";
import { pdfTools } from "@junejs/pdf";
import type { Tool } from "@junejs/core/agent-runtime";
import type { PdfFonts } from "../config";
import { toolDescription } from "../prompts";

export function fontProviders(fonts: PdfFonts): FontProvider[] {
  return fonts === "local" ? [notoSansTC()] : [googleFontSubsets({ families: [{ family: "Noto Sans TC", weights: [400, 700] }] })];
}

export function typstRenderer(fonts: PdfFonts): TypstWasmRenderer {
  return typstWasmRenderer({ fonts: fontProviders(fonts), fontFamilies: ["Noto Sans TC"] });
}

// What rendering sends where, in one line, for the doctor.
export function describeEgress(egress: readonly FontEgress[]): string {
  if (!egress.length) return "offline: rendering contacts no one";
  const carry = egress.filter((e) => e.sends === "document-characters").map((e) => e.host);
  const fixed = egress.filter((e) => e.sends === "nothing").map((e) => e.host);
  return [
    carry.length ? `sends each document's characters to ${carry.join(", ")}` : "",
    fixed.length ? `fetches fonts from ${fixed.join(", ")}` : "",
  ].filter(Boolean).join("; ");
}

export function renderPdfTool(renderer: TypstWasmRenderer): Tool {
  const [tool] = pdfTools({ renderer });
  // The description is Lorehouse's, from prompts/tools/render_pdf.md, like every tool's.
  return { ...tool!, spec: { ...tool!.spec, description: toolDescription("render_pdf") } };
}
