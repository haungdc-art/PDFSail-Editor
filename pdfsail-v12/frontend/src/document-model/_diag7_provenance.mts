/**
 * diag7 — dump glyph provenance of edited lines (fontIdentity / metrics / operatorId)
 * to find why native replay pre-scan is skipped and why strip fails on line 7.
 */
import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { renderDocumentToExportCommands } from "./export-renderer";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(new Uint8Array(bytes));
  const doc = (await parsePdfToEditableDocument(new Uint8Array(bytes).buffer as ArrayBuffer, pdf0)) as EditableDocument;

  const pdfjsDoc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const page = await pdfjsDoc.getPage(1);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1.5 });
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({
    viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5,
    cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5],
  } as any);
  const segs = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];

  const segS30 = segs.find((s) => s.text === "S30" && Math.abs(s.pdfX - 359.3) < 6)!;
  const seg100 = segs.find((s) => s.text === "100%" && Math.abs(s.pdfX - 395.9) < 6)!;
  const updated = applySegmentEditsToDocument(doc, [
    { ...segS30, id: "e1", text: "S33", originalText: "S30" },
    { ...seg100, id: "e2", text: "99%", originalText: "100%" },
  ]) as EditableDocument;

  const block = updated.pages[0].blocks.find((b) => b.id === "pdf_p1_block0")!;
  for (const li of [0, 7]) {
    const line = block.lines[li];
    console.log(`\n===== LINE ${li} id=${line.id} edited=${(line as any).edited} nGlyphs=${line.glyphs.length}`);
    console.log("text:", JSON.stringify(line.glyphs.map((g) => g.char).join("")));
    line.glyphs.forEach((g, i) => {
      const m: any = g.metrics;
      const fi: any = g.fontIdentity ?? m?.fontIdentity;
      if (i < 40 || g.modified) {
        console.log(
          `[${i}] ${JSON.stringify(g.char)} mod=${g.modified} opId=${g.operatorId ?? "-"} opIdx=${g.operatorCharIndex ?? "-"} ` +
          `code=${g.pdfCharCode ?? m?.pdfCharCode ?? "-"} fontRef=${fi?.fontRef ?? "-"} emb=${fi?.embedded ?? "-"} sub=${fi?.subtype ?? "-"} ` +
          `pdfTm=${m?.pdfTransform ? "yes" : "no"} bbox.x=${g.bbox?.x?.toFixed(2)} w=${g.bbox?.width?.toFixed(2)}`
        );
      }
    });
  }

  // export commands for these lines
  const ctx: any = { renderScale: 1.5, cssScale: 1, pageHeightPt: updated.pages[0]?.height ?? 792 };
  const cmds: any[] = renderDocumentToExportCommands(updated, ctx) as any[];
  const glyphCmds = cmds.filter((c) => c.type === "drawTextGlyph" && c.pageIndex === 0);
  console.log(`\n===== drawTextGlyph commands: ${glyphCmds.length}`);
  for (const key of ["pdf_p1_block0:0", "pdf_p1_block0:7"]) {
    const rows = glyphCmds.filter((c) => `${c.blockId}:${c.lineIndex}` === key);
    console.log(`\n--- ${key}: ${rows.length} cmds`);
    for (const c of rows.slice(0, 35)) {
      const fi: any = c.fontIdentity;
      console.log(
        `${JSON.stringify(c.char)} mod=${c.modified} x=${c.x?.toFixed(2)} y=${c.y?.toFixed(2)} size=${c.fontSize?.toFixed(2)} ` +
        `code=${c.pdfCharCode ?? "-"} fontRef=${fi?.fontRef ?? "-"} emb=${fi?.embedded ?? "-"} pdfTm=${c.glyphMetrics?.pdfTransform ? "yes" : "no"}`
      );
    }
  }
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
