// file-types.ts — what workspace_attach_file may attach, decided by the file's bytes and
// its name together, never by what the model says the file is.
//
//   PNG, JPEG, PDF   by their magic bytes, under a name with the matching extension
//   CSV, plain text  valid UTF-8 with no NUL or other control bytes, named .csv (CSV) or
//                    .txt / .log / .md (plain text)
//
// Anything else is refused with what to do instead. SVG is refused for now, even though a
// chart is often one: an SVG is an XML document that can carry scripts, event handlers and
// references to external URLs (images, fonts, stylesheets), and whatever opens the file
// from Slack would run or fetch them. Rasterise it to PNG in the sandbox first.

export const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

export type Kind = { label: string; mediaType: string; ext: string };

const PNG: Kind = { label: "PNG image", mediaType: "image/png", ext: ".png" };
const JPEG: Kind = { label: "JPEG image", mediaType: "image/jpeg", ext: ".jpg" };
const PDF: Kind = { label: "PDF", mediaType: "application/pdf", ext: ".pdf" };
const CSV: Kind = { label: "CSV", mediaType: "text/csv", ext: ".csv" };
const TEXT: Kind = { label: "plain text", mediaType: "text/plain", ext: ".txt" };

// The extensions each kind may be named with; the first is the one to rename to.
const NAMES: [Kind, string[]][] = [
  [PNG, [".png"]],
  [JPEG, [".jpg", ".jpeg"]],
  [PDF, [".pdf"]],
  [CSV, [".csv"]],
  [TEXT, [".txt", ".log", ".md"]],
];

const ALLOWED = "PNG, JPEG, PDF, CSV (.csv) or plain text (.txt, .log, .md)";

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

const starts = (b: Uint8Array, magic: number[]) => magic.every((m, i) => b[i] === m);

// What the bytes are, from their first bytes; text only if all of it is clean UTF-8.
function sniff(bytes: Uint8Array): "png" | "jpeg" | "pdf" | "svg" | "text" | "binary" {
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (starts(bytes, [0xff, 0xd8, 0xff])) return "jpeg";
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf"; // %PDF-
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "binary";
  }
  // Control bytes other than tab, newline, form feed and carriage return: not text.
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return "binary";
  if (containsSvg(text)) return "svg";
  return "text";
}

// Whether the text holds an SVG anywhere: an element named svg, with or without a namespace
// prefix (<svg, <s:svg), or an xmlns attribute declaring the SVG namespace. Deliberately
// broader than "the root element is <svg>": an XML prolog has more legal forms (processing instructions, comments,
// a doctype, prefixed roots) than a sniffer should chase, and text that merely quotes an
// SVG is refused too, with a way out (quote it in the reply, or attach a PNG). One linear
// scan, no regex: a backtracking pattern here was a ReDoS (CodeQL).
function containsSvg(text: string): boolean {
  if (declaresSvgNamespace(text)) return true;
  const nameChar = (c: number) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x2e || c === 0x5f || c === 0x3a;
  for (let i = text.indexOf("<"); i >= 0; i = text.indexOf("<", i + 1)) {
    let j = i + 1;
    while (j < text.length && nameChar(text.charCodeAt(j))) j++;
    const name = text.slice(i + 1, j).toLowerCase();
    const local = name.slice(name.lastIndexOf(":") + 1);
    const next = text[j];
    if (local === "svg" && (next === undefined || next === ">" || next === "/" || /\s/.test(next))) return true;
  }
  return false;
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Whether an xmlns or xmlns:prefix attribute's value is exactly the SVG namespace: the
// attribute is parsed and its value compared whole, so mentioning the URL in prose doesn't
// count. One pass over the "xmlns" occurrences.
function declaresSvgNamespace(text: string): boolean {
  for (let i = text.indexOf("xmlns"); i >= 0; i = text.indexOf("xmlns", i + 5)) {
    let j = i + 5;
    if (text[j] === ":") {
      j++;
      while (j < text.length && /[\w.-]/.test(text[j]!)) j++;
    }
    while (j < text.length && /\s/.test(text[j]!)) j++;
    if (text[j] !== "=") continue;
    j++;
    while (j < text.length && /\s/.test(text[j]!)) j++;
    const quote = text[j];
    if (quote !== '"' && quote !== "'") continue;
    const end = text.indexOf(quote, j + 1);
    if (end >= 0 && text.slice(j + 1, end).trim() === SVG_NS) return true;
  }
  return false;
}

const SVG_REFUSAL = "SVG isn't attached: an SVG can carry scripts and links to external files that would run or load wherever it's opened. Rasterise it to PNG in the sandbox (for example `rsvg-convert -o chart.png chart.svg`, or save the chart as PNG in the first place: matplotlib `savefig(\"chart.png\")`) and attach the PNG. If the file is text that only quotes some SVG, quote what matters in your reply instead";

// The kind to attach the file as, or why not, as a sentence the model can act on.
export function classify(path: string, bytes: Uint8Array): { kind: Kind } | { refusal: string } {
  const ext = extensionOf(path);
  const base = path.slice(path.lastIndexOf("/") + 1);
  if (ext === ".svg" || ext === ".svgz") return { refusal: SVG_REFUSAL };
  const found = sniff(bytes);
  if (found === "svg") return { refusal: SVG_REFUSAL };
  const byBytes = { png: PNG, jpeg: JPEG, pdf: PDF }[found as "png" | "jpeg" | "pdf"] as Kind | undefined;
  if (byBytes) {
    if (names(byBytes).includes(ext)) return { kind: byBytes };
    return { refusal: `${base} is a ${byBytes.label} by its contents, but its name says ${ext || "nothing (no extension)"}. Rename it to end in ${byBytes.ext} (workspace_exec: mv) and attach that` };
  }
  if (found === "binary") {
    return { refusal: `${base} isn't a type I attach: its bytes aren't PNG, JPEG or PDF, nor UTF-8 text. I attach ${ALLOWED}. Convert it to one of those in the sandbox first (a chart as PNG, a table as CSV)` };
  }
  // Text: the name decides CSV or plain text; any other extension is refused, so a .html or
  // .js never goes up as a file Slack offers to open.
  if (names(CSV).includes(ext)) return { kind: CSV };
  if (names(TEXT).includes(ext)) return { kind: TEXT };
  return { refusal: `${base} is text, but I attach text only as .csv, .txt, .log or .md${ext ? `, not ${ext}` : " and it has no extension"}. Copy it to such a name (workspace_exec: cp ${base} ${base.replace(/\.[^.]*$/, "")}.txt) and attach the copy, or quote the part that matters in your reply` };
}

// The names a kind may have, looked up by media type (a Kind is plain data).
function names(kind: Kind): string[] {
  return NAMES.find(([k]) => k.mediaType === kind.mediaType)?.[1] ?? [kind.ext];
}

// The attachment's filename: the title when given (letters of any script kept, no path
// separators or control characters, at most 100 characters), else the file's own name;
// always ending in an extension of its kind.
export function attachmentName(path: string, kind: Kind, title?: string): string {
  const own = path.slice(path.lastIndexOf("/") + 1);
  let base = (title?.trim() ? title : own)
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  // The extension: the title's own if it is one of the kind's, else the file's, else the
  // kind's usual one.
  const given = extensionOf(base);
  const ext = [given, extensionOf(own)].find((e) => names(kind).includes(e)) ?? kind.ext;
  if (given === ext) base = base.slice(0, -ext.length);
  base = base.replace(/^[.\-\s]+|[.\-\s]+$/g, "");
  if ([...base].length > 100) base = [...base].slice(0, 100).join("").trim();
  return `${base || "file"}${ext}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
