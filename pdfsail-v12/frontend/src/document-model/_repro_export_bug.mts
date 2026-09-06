/**
 * repro-export-bug — Node 复现：S30→S33（row1 col5）+ power 100%→power 99%（row2 col5）
 * 导出后用 pdfjs 对比文本项几何，验证压缩/重影，并捕获 NATIVE_REPLAY 决策日志。
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
import { exportEditableDocument } from "./export-renderer";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const OUT = "D:/TRAE/pdfsail-v12/scripts/_repro_export_out.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const bytesCopy = new Uint8Array(bytes); // 独立副本（parse 会 transfer 底层 buffer）
  const pdf0 = await PDFDocument.load(bytesCopy);
  const doc = (await parsePdfToEditableDocument(new Uint8Array(bytes).buffer as ArrayBuffer, pdf0)) as EditableDocument;

  const { getDocument } = pdfjs;
  const pdfjsDoc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  const page = await pdfjsDoc.getPage(1);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1.5 });
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({
    viewportScale: 1.5,
    viewportHeight: vp.height / 1.5,
    viewportWidth: vp.width / 1.5,
    cssScale: 1,
    originXDevice: vp.transform[4],
    originYDevice: vp.transform[5],
  } as any);
  const segs = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];
  console.log(`segments: ${segs.length}`);

  const pick = (text: string, px: number, py: number, tol = 6) =>
    segs.find((s) => s.text === text && Math.abs(s.pdfX - px) < tol && Math.abs(s.pdfY - py) < tol);

  const segS30 = pick("S30", 359.30, 760.10);
  const seg100 = pick("100%", 395.90, 698.05);
  console.log("segS30:", segS30 ? JSON.stringify({ id: segS30.id, text: segS30.text, pdfX: segS30.pdfX, pdfY: segS30.pdfY, source: segS30.source }) : "NOT FOUND");
  console.log("seg100:", seg100 ? JSON.stringify({ id: seg100.id, text: seg100.text, pdfX: seg100.pdfX, pdfY: seg100.pdfY, source: seg100.source }) : "NOT FOUND");
  for (const s of segs) {
    if (s.pdfY >= 688 && s.pdfY <= 712) {
      console.log("segY698:", JSON.stringify({ text: s.text, pdfX: +s.pdfX.toFixed(2), pdfY: +s.pdfY.toFixed(2), pdfW: +s.pdfW.toFixed(2), id: s.id }));
    }
  }
  if (!segS30 || !seg100) {
    // dump candidates to locate correct coordinates
    for (const s of segs) {
      if (s.text === "S30" || s.text === "power 100%")
        console.log("cand:", JSON.stringify({ text: s.text, pdfX: +s.pdfX.toFixed(2), pdfY: +s.pdfY.toFixed(2), id: s.id }));
    }
    return;
  }

  const edits: Segment[] = [
    { ...segS30, id: segS30.id + "_e", text: "S33", originalText: "S30" },
    { ...seg100, id: seg100.id + "_e", text: "99%", originalText: "100%" },
  ];
  const updated = applySegmentEditsToDocument(doc, edits) as EditableDocument;
  console.log("applied edits");

  const exported = await exportEditableDocument(updated, bytes.buffer as ArrayBuffer);
  fs.writeFileSync(OUT, Buffer.from(exported));
  console.log(`exported -> ${OUT} (${exported.length} bytes)`);

  // ── verify with pdfjs: dump zone items ──
  const outDoc = await getDocument({ data: new Uint8Array(exported), isEvalSupported: false }).promise;
  const outPage = await outDoc.getPage(1);
  const otc = await (outPage.getTextContent() as any);
  const zone = otc.items
    .filter((it: any) => it.str && it.str.trim() && it.transform[5] >= 675 && it.transform[5] <= 775)
    .sort((a: any, b: any) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  console.log(`\n=== EXPORTED (repro) items in y[675..775]: ${zone.length} ===`);
  for (const it of zone) {
    const [a, b, c, d, e, f] = it.transform;
    console.log(`x=${e.toFixed(2)} y=${f.toFixed(2)} w=${it.width.toFixed(2)} font=${it.fontName} ${JSON.stringify(it.str)}`);
  }
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
