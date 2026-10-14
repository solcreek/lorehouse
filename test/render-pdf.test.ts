import { describe, expect, test } from "bun:test";
import { typstRenderer } from "../src/tools/render-pdf";

// Embedded font names are readable in the PDF's bytes (each subset as XXXXXX+Name).
const fontsIn = (pdf: Uint8Array) => new TextDecoder("latin1").decode(pdf);

describe("render_pdf's renderer", () => {
  test("with PDF_FONTS=local, Chinese and Latin are set in Noto Sans TC alone, not Libertinus Serif", async () => {
    const pdf = await typstRenderer("local").render({ markdown: "# 報告 Report\n\nLorehouse 在 2026 年 10 月上線。**粗體 Bold**", lang: "zh-TW" });
    const text = fontsIn(pdf);
    expect(text).toContain("NotoSansTC-Regular");
    expect(text).toContain("NotoSansTC-Bold");
    expect(text).not.toContain("LibertinusSerif");
  });
});
