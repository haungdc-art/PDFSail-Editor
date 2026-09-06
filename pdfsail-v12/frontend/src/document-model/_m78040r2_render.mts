import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { renderDocumentToExportCommands, writeExportCommandsToPDF } from "./export-renderer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const _log = console.log.bind(console);
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!/\[009B|NATIVE|EXPORT_PATH|M7\.8/.test(s)) _log(...a); };

async function getTextContent(pageIndex1Based: number) {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdfjs = await getDocument({ data: new Uint8Array(fs.readFileSync(ORIG).buffer.slice(0)), isEvalSupported: false }).promise;
  const page = await pdfjs.getPage(pageIndex1Based);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1.5 });
  await pdfjs.destroy();
  return { tc, vp };
}
function collectOpIds(doc: EditableDocument) {
  const s = new Set<string>();
  for (const block of doc.pages[0].blocks) for (const line of block.lines) for (const g of line.glyphs) {
    const gg = g as any; if (gg.modified && gg.operatorId) s.add(gg.operatorId);
  }
  return s;
}

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;
  const { tc, vp } = await getTextContent(1);
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  const segs1 = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];
  const cnpjSeg = segs1.find((s) => s.text.includes("0001-79"))!;
  const cnpjLine = doc.pages[0].blocks[0].lines.find((l) => l.glyphs.map((g) => g.char).join("").includes("0001-79"))!;
  const lineText = cnpjLine.glyphs.map((g) => g.char).join("");
  const s7 = lineText.indexOf("0001-79") + "0001-".length;
  const src = (cnpjSeg as any).source;
  const seg: Segment = { ...cnpjSeg, id: "seg", text: "78", originalText: "79",
    source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s7, endGlyphIndex: s7 + 1 } } as any;
  const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;
  _log(`[A] mutation 后 opIds = ${[...collectOpIds(updated)].join(",") || "(空)"}`);

  const overlayDoc = updated;
  _log(`[B] 直接 opIds (同 updated) = ${[...collectOpIds(overlayDoc)].join(",") || "(空)"}`);

  const ctx: any = { renderScale: 1.5, cssScale: 1, pageHeightPt: doc.pages[0]?.height ?? 792 };
  const commands = renderDocumentToExportCommands(overlayDoc, ctx, undefined, undefined);
  _log(`[C] renderDocumentToExportCommands 后 opIds = ${[...collectOpIds(overlayDoc)].join(",") || "(空)"}  commands数=${commands.length}`);

  const pdf = await PDFDocument.load(bytes);
  // [E] 复刻 export 顺序：先 write overlay，再 resolvePageShowTextWithXObjects（strip 实际做的事）
  await writeExportCommandsToPDF(pdf, commands as any, { ctx } as any);
  const recsAfter = resolvePageShowTextWithXObjects(pdf, 0) as any[];
  const hasEmbedded10 = recsAfter.some((r) => r.operatorId === "embedded#10");
  _log(`[E] 写 overlay 后 resolvePageShowTextWithXObjects: embedded#10 仍在 byId? ${hasEmbedded10}  (算子数=${recsAfter.length})`);
  const byIdAfter = new Map(recsAfter.map((r) => [r.operatorId, r]));
  const opIds = collectOpIds(overlayDoc);
  let willStrip = 0;
  for (const opId of opIds) { const r = byIdAfter.get(opId); if (r && r.charCodes !== null) willStrip++; }
  _log(`[F] 复刻 export 真实顺序(先写后剥): opIds=${[...opIds].join(",") || "(空)"} willStrip=${willStrip}  → ${willStrip === 0 ? "0 剥离=重影根因确认!" : "会剥"}`);

  // [G] 对照：先 resolve(原pdf) 再写，则 byId 命中
  const pdf2 = await PDFDocument.load(bytes);
  const recsBefore = resolvePageShowTextWithXObjects(pdf2, 0) as any[];
  const byIdBefore = new Map(recsBefore.map((r) => [r.operatorId, r]));
  let willStripBefore = 0;
  for (const opId of opIds) { const r = byIdBefore.get(opId); if (r && r.charCodes !== null) willStripBefore++; }
  _log(`[G] 若 strip 在写 overlay 之前解析(对原pdf): willStrip=${willStripBefore}`);
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
