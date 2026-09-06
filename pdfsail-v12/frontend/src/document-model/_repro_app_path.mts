/**
 * repro-app-path — 忠实模拟 PDFEditor.tsx 的内联构建流程：
 *   pdfjs getTextContent → groupIntoLines → pdfLinesToEditableBlock(pageMetrics + provenance)
 *   → applySegmentEditsToDocument → exportEditableDocument
 * 用于复现真实应用的导出（Helvetica overlay / 剥离失败），并验证修复。
 */
import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import { parsePdfFontMetrics } from "./pdf-font-metrics";
import { buildFontProvenanceMap } from "./pdf-font-provenance";
import { assignOperatorProvenanceForPage } from "./pdf-importer";
import { pdfLinesToEditableBlock } from "./pdf-native-adapter";
import { StyleResolver } from "./style-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

GlobalWorkerOptions.workerSrc = new URL(
  "../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  import.meta.url,
).href;

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
const OUT = process.argv[2] ?? "D:/TRAE/PDFSail-Editor/pdfsail-v12/scripts/_repro_app_out.pdf";
// argv[3] === "noprov" → 模拟旧 doc / HMR 残留（无 operator provenance，走文本兜底剥离）
const NOPROV = process.argv[3] === "noprov";

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const bufCopy = new Uint8Array(bytes); // 应用里 buf.slice(0)

  // 1) 应用：pdfLibDocRef = await PDFDocument.load(buf.slice(0))
  const pdfLibDoc = await PDFDocument.load(new Uint8Array(bufCopy), { ignoreEncryption: true });
  // 2) 应用：pageFontMetricsRef = parsePdfFontMetrics(pdfLibDocRef)
  const pageFontMetrics = parsePdfFontMetrics(pdfLibDoc);
  // 3) 应用：pdfjs getDocument(buf.slice(0))
  const pdfjsDoc = await getDocument({ data: new Uint8Array(bufCopy), isEvalSupported: false }).promise;

  const viewportScale = 1.5;
  const cssScale = 1;
  const pageIdx = 1;
  const page = await pdfjsDoc.getPage(pageIdx);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: viewportScale });

  // 4) 应用：provenance = await buildFontProvenanceMap(pdfLibDocRef.current, pdfDoc, page - 1)
  const provenance = await buildFontProvenanceMap(pdfLibDoc, pdfjsDoc, pageIdx - 1);
  console.log("[APP-REPRO] provenance entries:", [...provenance.keys()]);
  for (const [k, v] of provenance) {
    console.log(`[APP-REPRO] ${k}: fontRef=${v.fontIdentity.fontRef} subtype=${v.fontIdentity.subtype} embedded=${v.fontIdentity.embedded} u2c=${v.unicodeToCharCode.size}`);
  }

  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({
    viewportScale,
    viewportHeight: vp.height / viewportScale,
    viewportWidth: vp.width / viewportScale,
    cssScale,
    originXDevice: vp.transform[4],
    originYDevice: vp.transform[5],
  } as any);
  const fontAnalyzer = new FontAnalyzerImpl();
  const pageResolver = new StyleResolver();
  const block = pdfLinesToEditableBlock(
    lines, mapper, fontAnalyzer, `pdf_p${pageIdx}_block0`, pageResolver,
    pageFontMetrics?.[pageIdx - 1], provenance,
  );

  const doc: EditableDocument = {
    pages: [{
      index: pageIdx,
      width: vp.width * cssScale,
      height: vp.height * cssScale,
      blocks: [block],
      originYPt: (page.view as number[])?.[1] ?? 0,
    }],
    styles: pageResolver.toArray(),
    metadata: { fileName: "doc.pdf", pageCount: pdfjsDoc.numPages, createdAt: Date.now() },
    runtime: { renderScale: viewportScale, cssScale, pageMetrics: [{ width: vp.width / viewportScale, height: vp.height / viewportScale }] },
  } as any;

  // M7.8-042-FIX（与 PDFEditor.tsx 内联构建对齐）：为新构建页建立 operator provenance。
  // noprov 模式跳过 → 模拟旧 doc，验证文本兜底剥离 v2（y 带过滤）仍然兜得住。
  if (!NOPROV) {
    await assignOperatorProvenanceForPage(doc.pages[0], pdfLibDoc, pageIdx - 1);
    let withOp = 0;
    for (const l of block.lines) for (const g of l.glyphs) if ((g as any).operatorId) withOp++;
    console.log(`[APP-REPRO] provenance assigned: ${withOp} glyphs with operatorId`);
  } else {
    console.log("[APP-REPRO] NOPROV mode: skip operator provenance (fallback strip path)");
  }

  // 检查 doc 中 glyph 的 provenance
  let withFI = 0, withCode = 0, total = 0;
  for (const l of block.lines) for (const g of l.glyphs) {
    total++;
    if ((g as any).fontIdentity ?? (g as any).metrics?.fontIdentity) withFI++;
    if ((g as any).pdfCharCode ?? (g as any).metrics?.pdfCharCode) withCode++;
  }
  console.log(`[APP-REPRO] glyphs=${total} withFontIdentity=${withFI} withCharCode=${withCode}`);

  // 5) segments（与 PDFEditor 一致）
  const segs = buildSegments(lines, mapper, fontAnalyzer, pageIdx, undefined) as Segment[];
  const pick = (text: string, px: number, tol = 6) =>
    segs.find((s) => s.text === text && Math.abs(s.pdfX - px) < tol);
  const segS30 = pick("S30", 359.30);
  const seg100 = pick("100%", 395.90);
  if (!segS30 || !seg100) { console.log("[APP-REPRO] segments not found!", segs.filter(s => s.text.includes("S30") || s.text.includes("100%")).slice(0, 10)); return; }

  const updated = applySegmentEditsToDocument(doc, [
    { ...segS30, id: segS30.id + "_e", text: "S33", originalText: "S30" },
    { ...seg100, id: seg100.id + "_e", text: "99%", originalText: "100%" },
  ]) as EditableDocument;

  // 6) 导出
  const exported = await exportEditableDocument(updated, new Uint8Array(bytes).buffer as ArrayBuffer);
  fs.writeFileSync(OUT, Buffer.from(exported));
  console.log(`[APP-REPRO] exported -> ${OUT} (${exported.length} bytes)`);

  // 7) 验证
  const outDoc = await getDocument({ data: new Uint8Array(exported), isEvalSupported: false }).promise;
  const outPage = await outDoc.getPage(1);
  const otc = await outPage.getTextContent();
  const zone = otc.items
    .filter((it: any) => it.str && it.str.trim() && it.transform[5] >= 675 && it.transform[5] <= 775)
    .sort((a: any, b: any) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);
  console.log(`[APP-REPRO] items in y[675..775]: ${zone.length}`);
  for (const it of zone) {
    const [a, b, c, d, e, f] = it.transform;
    console.log(`x=${e.toFixed(2)} y=${f.toFixed(2)} w=${it.width.toFixed(2)} font=${it.fontName} ${JSON.stringify(it.str)}`);
  }
  await pdfjsDoc.destroy();
}

main().catch((e) => { console.error("ERR", e); process.exit(1); });
