import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const _log = console.log.bind(console);
const SUPPRESS = /.*/; // 本脚本自行控制输出
console.log = (...a: any[]) => { _log(...a); };

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

  // R1 子区间 79→78
  const seg: Segment = { ...cnpjSeg, id: "seg", text: "78", originalText: "79",
    source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s7, endGlyphIndex: s7 + 1 } } as any;
  const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;

  // 复刻 stripReplacedTextOperators 的收集+匹配（不依赖导出函数本身）
  const opIds = new Set<string>();
  for (const block of updated.pages[0].blocks) for (const line of block.lines) for (const g of line.glyphs) {
    const gg = g as any; if (gg.modified && gg.operatorId) opIds.add(gg.operatorId);
  }
  _log(`COLLECT modified&&operatorId 的 operatorId 集合 = ${[...opIds].join(",") || "(空)"}`);

  // 用「与 export 相同」的 pdf（PDFDocument.load(originalBytes)）做 resolver
  const pdf = await PDFDocument.load(bytes);
  const records = resolvePageShowTextWithXObjects(pdf, 0) as any[];
  const byId = new Map<string, any>();
  for (const r of records) byId.set(r.operatorId, r);
  _log(`RESOLVER page0 算子数=${records.length}，embedded#10 在 byId? ${byId.has("embedded#10")}`);
  const rec = byId.get("embedded#10");
  if (rec) _log(`RESOLVER embedded#10: charCodes=${rec.charCodes === null ? "NULL" : "len=" + rec.charCodes.length} unicodeText="${rec.unicodeText}"`);
  // 关键：strip 对每个 opId 做 byId.get → 是否存在 charCodes===null 跳过
  for (const opId of opIds) {
    const r = byId.get(opId);
    _log(`STRIPLOG opId=${opId} → byId命中? ${!!r}  charCodes===null? ${r ? (r.charCodes === null) : "N/A(命中失败)"}  → ${r && r.charCodes !== null ? "会剥离" : "SKIP(不剥)"}`);
  }
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
