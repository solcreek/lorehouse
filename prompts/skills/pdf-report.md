---
name: pdf-report
description: Write a document from what the company knows and attach it to the thread as a PDF with render_pdf.
when-to-use: someone asks for a PDF, or for a report, summary or document to download, print or forward.
---
# A PDF report

1. Gather everything first, with `search_knowledge` and `recent_knowledge`. Don't render
   a draft and then render again: each `render_pdf` call attaches another file.
2. Write the whole document as Markdown, in the language the request was asked in:
   - A `#` title, then one paragraph with the key result.
   - `##` sections, short paragraphs, bullet lists for findings.
   - Figures in tables (`| a | b |` with a `|---|---|` row; `|--:|` right-aligns numbers).
   - Emphasize with **bold**, never *italics*: the document's Chinese font has no italic,
     so italic text set in it comes out upright and the emphasis is lost.
   - Cite each source as a link to its Slack thread, as you would in a reply.
   - Name people as plain text. Never put secrets, tokens or passwords in the document,
     even if a message quoted one: the file stays in the thread.
   - No images: say what a chart would show in words or a table.
3. Call `render_pdf` with `markdown`, a descriptive `filename` (e.g. `billing-decisions-2026-q3.pdf`)
   and `lang` (e.g. `zh-TW`, `en`, `ja`).
4. Reply in one or two sentences: what the PDF covers and its headline finding. Don't
   paste the document into the thread.
5. If `render_pdf` returns an error, read it, fix the Markdown and try once more. If it
   fails again, give the content as a normal reply and say the PDF couldn't be made.
