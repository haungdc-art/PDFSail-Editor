/** diag-row7 — 检查 doc 第7行 glyph 的 provenance 认领 + 该行 band 的原算子列表 */
import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { parsePdfFontMetrics } from "./pdf-font-metrics";
import { buildFontProvenanceMap } from "./pdf-font-provenance";
import { assignOperatorProvenanceForPage } from "./pdf-importer";
import { pdfLinesToEditableBlock } from "./pdf-native-adapter";
import { StyleResolver } from "./style-resolver";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdfLibDoc = await PDFDocument.load(new Uint8Array(bytes), { ignoreEncryption: true });
  const pageFontMetrics = parsePdfFontMetrics(pdfLibDoc);
  const pdfjsDoc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;

  const viewportScale = 1.5;
  const pageIdx = 1;
  const page = await pdfjsDoc.getPage(pageIdx);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: viewportScale });
  const provenance = await buildFontProvenanceMap(pdfLibDoc, pdfjsDoc, pageIdx - 1);

  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({
    viewportScale, viewportHeight: vp.height / viewportScale, viewportWidth: vp.width / viewportScale,
    cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5],
  } as any);
  const block = pdfLinesToEditableBlock(
    lines, mapper, new FontAnalyzerImpl(), `pdf_p${pageIdx}_block0`, new StyleResolver(),
    pageFontMetrics?.[pageIdx - 1], provenance,
  );

  const doc: EditableDocument = {
    pages: [{ index: pageIdx, width: vp.width, height: vp.height, blocks: [block], originYPt: (page.view as number[])?.[1] ?? 0 }],
    styles: [], metadata: { fileName: "d", pageCount: 2, createdAt: Date.now() },
    runtime: { renderScale: viewportScale, cssScale: 1, pageMetrics: [] },
  } as any;
  await assignOperatorProvenanceForPage(doc.pages[0], pdfLibDoc, pageIdx - 1);

  // 找到含 "100%" 的行（第三处）
  let row7: any = null;
  for (const l of block.lines) {
    const t = l.glyphs.map((g: any) => g.char).join("");
    if (t.includes("power") && t.includes("100")) { console.log(`line candidate: ${JSON.stringify(t)} y=${l.glyphs[0]?.metrics?.pdfTransform?.[5]}`); }
  }
  // 选 y≈698 的行
  for (const l of block.lines) {
    const y = (l.glyphs[0] as any)?.metrics?.pdfTransform?.[5];
    if (typeof y === "number" && Math.abs(y - 698.05) < 3 && l.glyphs.some((g: any) => g.char === "p")) { row7 = l; break; }
  }
  if (!row7) { console.log("row7 not found"); return; }

  console.log(`\n=== row7 glyphs (${row7.glyphs.length}) ===`);
  for (const g of row7.glyphs) {
    console.log(`char=${JSON.stringify(g.char)} modified=${g.modified} originalChar=${JSON.stringify(g.originalChar ?? null)} opId=${JSON.stringify(g.operatorId ?? null)} opIdx=${String(g.operatorCharIndex)}`);
  }

  // band 内原算子
  const records = resolvePageShowTextWithXObjects(pdfLibDoc, pageIdx - 1);
  const pg = pdfLibDoc.getPage(pageIdx - 1);
  const cb = (pg as any).getCropBox ? (pg as any).getCropBox() : undefined;
  const cropTopY = cb && cb.height > 0 ? cb.y + cb.height : pg.getHeight();
  const bandOps = records
    .filter((r) => typeof (r as any).textY === "number")
    .filter((r) => Math.abs((cropTopY - (r as any).textY) - 698.05) <= 2.5);
  console.log(`\n=== band ops (pdfjsY≈698.05, ${bandOps.length}) ===`);
  for (const r of bandOps) {
    console.log(`id=${r.operatorId} text=${JSON.stringify(r.unicodeText ?? r.operatorText)} charCodes=${r.charCodes === null ? "null" : r.charCodes.length} textY=${((r as any).textY).toFixed(2)}`);
  }

  // 应用编辑
  const segs = (await import("../editor-engine/SegmentBuilder")).buildSegments(lines, mapper, new FontAnalyzerImpl(), pageIdx, undefined) as Segment[];
  const pick = (text: string, px: number, tol = 6) => segs.find((s) => s.text === text && Math.abs(s.pdfX - px) < tol);
  const seg100 = pick("100%", 395.90);
  if (!seg100) { console.log("seg 100% not found"); return; }
  const updated = applySegmentEditsToDocument(doc, [{ ...seg100, id: seg100.id + "_e", text: "99%", originalText: "100%" }]) as EditableDocument;
  const l2 = (updated.pages[0] as any).blocks[0].lines.find((l: any) => {
    const y = l.glyphs[0]?.metrics?.pdfTransform?.[5];
    return typeof y === "number" && Math.abs(y - 698.05) < 3;
  });
  console.log(`\n=== row7 AFTER edit (${l2.glyphs.length} glyphs) ===`);
  for (const g of l2.glyphs) {
    console.log(`char=${JSON.stringify(g.char)} modified=${g.modified} originalChar=${JSON.stringify(g.originalChar ?? null)} opId=${JSON.stringify(g.operatorId ?? null)}`);
  }
  await pdfjsDoc.destroy();
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
