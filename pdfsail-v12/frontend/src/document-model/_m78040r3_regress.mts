import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream, PDFRef, PDFArray } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const out: string[] = [];
const log = (...a: any[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
const SUPPRESS = /\[009B|NATIVE|EXPORT_PATH|M7\.8|\[MASK_DIAG|YDIAG|Sprint34|SignatureRotation|ExportLayout|GLYPH_GEOMETRY|M7\.7-010|M7\.8-036-FIX-002|line:|lines=|line\d|glyphs=/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) console.error(...a); };

async function getTextContentFromBytes(dataBytes: Uint8Array, pageIndex1Based: number) {
  const { getDocument, GlobalWorkerOptions } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdfjs = await getDocument({ data: new Uint8Array(dataBytes), isEvalSupported: false }).promise;
  const page = await pdfjs.getPage(pageIndex1Based);
  const tc = await page.getTextContent();
  const vp = page.getViewport({ scale: 1.5 });
  await pdfjs.destroy();
  return { tc, vp };
}

async function extractLines(dataBytes: Uint8Array, pageIdx: number): Promise<string[]> {
  try {
    const { tc, vp } = await getTextContentFromBytes(dataBytes, pageIdx);
    const glyphs = extractGlyphs(tc as any);
    const lines = groupIntoLines(glyphs);
    const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
    const segs = buildSegments(lines, mapper, new FontAnalyzerImpl(), pageIdx, undefined) as Segment[];
    return segs.map((s) => s.text);
  } catch (e) {
    console.error(`[DBG] extractLines page ${pageIdx} 失败:`, (e as Error).message);
    return [];
  }
}

function decodePageContent(pdf: PDFDocument, pageIdx: number): string {
  try {
    const page = pdf.getPage(pageIdx) as any;
    const node = page.node.Contents?.();
    const streamBytes = (obj: any): Uint8Array | null => {
      if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
        try { const b = decodePDFRawStream(obj).decode(); if (b && b.length) return b; } catch { /* */ }
        try { const b = decodePDFRawStream(obj).getBytes(); if (b && b.length) return b; } catch { /* */ }
        try { const b = obj.contents?.getBytes?.(); if (b && b.length) return b; } catch { /* */ }
      }
      return null;
    };
    if (!node) return "";
    if (node instanceof PDFArray) {
      let s = "";
      for (const item of node.asArray()) {
        const obj = item instanceof PDFRef ? pdf.context.lookup(item) : item;
        const b = streamBytes(obj); if (b) s += new TextDecoder("latin1").decode(b) + "\n";
      }
      return s;
    }
    const obj = node instanceof PDFRef ? pdf.context.lookup(node) : node;
    const b = streamBytes(obj);
    return b ? new TextDecoder("latin1").decode(b) : "";
  } catch {
    return "";
  }
}

function graphicsOps(content: string) {
  const tokens = content.split(/(\s+)/).filter(t => t.trim().length > 0);
  const ml: string[] = [];
  const nums: number[] = [];
  for (const tk of tokens) {
    if (/^-?\d*\.?\d+$/.test(tk)) { nums.push(parseFloat(tk)); continue; }
    if (tk === "m" || tk === "l") { const n = nums.slice(-2); ml.push(`(${n.map(c=>c.toFixed(2)).join(",")})`); nums.length = 0; }
    else if (tk === "re") { nums.length = 0; }
    else if (["h","S","s","f","F","B","b","n","q","Q"].includes(tk)) { nums.length = 0; }
    else if (!["cm","w"].includes(tk)) { nums.length = 0; }
  }
  return new Set(ml);
}

function count(hay: string, needle: string): number {
  if (!needle) return 0;
  let c = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length; }
  return c;
}

async function buildEditDoc(replacement: string) {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;
  const { tc, vp } = await getTextContentFromBytes(new Uint8Array(bytes.buffer.slice(0)), 1);
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  const segs1 = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];
  // 所有含 "0001-79" 的 segment（正文行 + 页脚行）都编辑
  const cnpjSegs = segs1.filter((s) => s.text.includes("0001-79"));
  const editSegs: Segment[] = cnpjSegs.map((seg) => {
    const t = seg.text;
    const idx = t.indexOf("0001-79");
    const s7 = idx + "0001-".length;
    const src = (seg as any).source;
    return { ...seg, id: seg.id + "_e", text: replacement, originalText: "79",
      source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s7, endGlyphIndex: s7 + 1 } } as any;
  });
  const updated = applySegmentEditsToDocument(doc, editSegs) as EditableDocument;
  const editedLines = updated.pages[0].blocks.flatMap(b => b.lines).filter(l => (l as any).edited);
  return { bytes, updated, nEdited: editedLines.length };
}

async function runCase(label: string, replacement: string, newToken: string) {
  const { bytes, updated, nEdited } = await buildEditDoc(replacement);
  const exported = await exportEditableDocument(updated, bytes as unknown as ArrayBuffer);
  const expPdf = await PDFDocument.load(exported);

  const origLines0 = await extractLines(new Uint8Array(bytes.buffer.slice(0)), 1);
  const expLines0 = await extractLines(exported, 1);
  const expLines2 = await extractLines(exported, 2);
  const origText0 = origLines0.join("\n");
  const expText0 = expLines0.join("\n");
  const expText2 = expLines2.join("\n");

  const origRaw0 = decodePageContent(expPdf, 0); // 用导出流做 graphics（原始流 graphics 已在 D4 验证）
  const origRaw0b = decodePageContent(await PDFDocument.load(bytes), 0);
  const origML = graphicsOps(origRaw0b);
  const expML = graphicsOps(origRaw0);
  const missingML = [...origML].filter(k => !expML.has(k));

  const sz0 = (await PDFDocument.load(bytes)).getPage(0).getSize();
  const szE = expPdf.getPage(0).getSize();

  const c1_stripOrig = count(expText0, "0001-79") === 0;
  const c2_newAppears = count(expText0, newToken) === nEdited;
  const c3_once = count(expText0, newToken) === nEdited;
  const c4_preserve = count(expText0, "YULM") === count(origText0, "YULM") && count(expText2, "CLÁUSULA") >= 1 && count(expText2, "OBRIGAÇÕES") >= 1;
  const c5_graphics = missingML.length === 0;
  const c6_size = Math.abs(sz0.width - szE.width) < 0.01 && Math.abs(sz0.height - szE.height) < 0.01;

  const pass = c1_stripOrig && c2_newAppears && c3_once && c4_preserve && c5_graphics && c6_size;
  log(`\n=== ${label}  (79→${JSON.stringify(replacement)})  被编辑行数=${nEdited} ===`);
  log(`  [1] 原operator被strip (0001-79 导出页1出现次数=${count(expText0,"0001-79")} → 应0): ${c1_stripOrig}`);
  log(`  [2] 新文本出现(${newToken} 导出页1次数=${count(expText0,newToken)} 应=${nEdited}): ${c2_newAppears}`);
  log(`  [3] 新文本每编辑行只一次: ${c3_once}`);
  log(`  [4] 非目标operator保留(YULM 原=${count(origText0,"YULM")} 导=${count(expText0,"YULM")}; CLÁUSULA导=${count(expText2,"CLÁUSULA")}; OBRIGAÇÕES导=${count(expText2,"OBRIGAÇÕES")}): ${c4_preserve}`);
  log(`  [5] 表格graphics保留(原m/l ${origML.size} 导=${expML.size} 缺失=${missingML.length}): ${c5_graphics}`);
  log(`  [6] 页面尺寸不变(原=${sz0.width.toFixed(1)}x${sz0.height.toFixed(1)} 导=${szE.width.toFixed(1)}x${szE.height.toFixed(1)}): ${c6_size}`);
  log(`  >>> ${pass ? "PASS" : "FAIL"} <<<`);
  return pass;
}

async function main() {
  const r: boolean[] = [];
  r.push(await runCase("R1", "78", "0001-78"));
  r.push(await runCase("R2", "7", "0001-7,"));
  r.push(await runCase("R3", "79123", "0001-79123,"));
  r.push(await runCase("R4", "", "0001-,"));
  log(`\n##### 总结果: ${r.filter(Boolean).length}/4 PASS #####`);
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_regress.txt", out.join("\n"), "utf8");
  console.error("DONE -> _regress.txt");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
