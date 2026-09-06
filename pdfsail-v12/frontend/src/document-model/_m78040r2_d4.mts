import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import type { EditableDocument, Segment } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const out: string[] = [];
const log = (...a: any[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
const SUPPRESS = /\[009B|NATIVE|EXPORT_PATH|M7\.8|\[MASK_DIAG|YDIAG|Sprint34|SignatureRotation|ExportLayout|GLYPH_GEOMETRY|M7\.7-010\]/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) console.error(...a); };

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

const decodeErrs: string[] = [];
function decodeStream(stream: any): string {
  try {
    if (!(stream instanceof PDFRawStream) && !(stream instanceof PDFStream)) return "";
    try {
      const b = decodePDFRawStream(stream as PDFRawStream).getBytes();
      if (b && b.length) return new TextDecoder().decode(b);
    } catch (e) { decodeErrs.push("getBytes():" + (e as Error).message); }
    try {
      const d = decodePDFRawStream(stream as PDFRawStream).decode();
      if (d && d.length) return new TextDecoder().decode(d);
    } catch (e) { decodeErrs.push("decode():" + (e as Error).message); }
    const c = (stream as any).contents;
    if (c) return new TextDecoder().decode(c);
  } catch (e) { decodeErrs.push("outer:" + (e as Error).message); }
  return "";
}
function collectAllStreams(pdf: PDFDocument, pageIdx: number): string[] {
  const page = pdf.getPages()[pageIdx];
  const ctx: any = (pdf as any).context;
  const texts: string[] = [];
  const visited = new Set<string>();
  const walk = (streamObj: any) => {
    let stream = streamObj;
    if (stream instanceof Object && "objectNumber" in stream) stream = ctx.lookup(stream);
    if (!stream) return;
    const key = (stream as any).objectNumber != null ? `${(stream as any).objectNumber} ${(stream as any).generationNumber}` : String(texts.length);
    if (visited.has(key)) return;
    visited.add(key);
    const txt = decodeStream(stream);
    if (txt) texts.push(txt);
    // 递归 Form XObject
    try {
      const dict = (stream as any).dict ?? stream;
      const res = dict?.get?.("Resources");
      const resDict = res instanceof Object && "objectNumber" in res ? ctx.lookup(res) : res;
      const xo = resDict?.get?.("XObject");
      const xod = xo instanceof Object && "objectNumber" in xo ? ctx.lookup(xo) : xo;
      if (xod instanceof Object) {
        xod.forEach?.((_v: any, k: any) => {
          const ref = xod.get(k);
          walk(ref);
        });
      }
    } catch { /* ignore */ }
  };
  const contents = (page as any).node.Contents();
  const arr = contents instanceof Array ? contents.asArray() : [contents];
  for (const c of arr) walk(c);
  return texts;
}
function getPageGraphics(pdf: PDFDocument, pageIdx: number) {
  const texts = collectAllStreams(pdf, pageIdx);
  const content = texts.join("\n");
  // 抽取 path/graphics 算子坐标
  const tokens = content.split(/(\s+)/).filter(t => t.trim().length > 0);
  const ops: { op: string; coords: number[] }[] = [];
  // 顺序扫描：维护数字栈
  const nums: number[] = [];
  for (const tk of tokens) {
    if (/^-?\d*\.?\d+$/.test(tk)) { nums.push(parseFloat(tk)); continue; }
    // 算子
    const need: Record<string, number> = { m: 2, l: 2, c: 6, v: 4, y: 4, re: 4, cm: 6, w: 1, h: 0, S: 0, s: 0, f: 0, F: 0, B: 0, b: 0, n: 0, q: 0, Q: 0 };
    if (tk in need) {
      const n = need[tk];
      const coords = n > 0 ? nums.slice(-n) : [];
      ops.push({ op: tk, coords });
      if (tk === "h" || tk === "S" || tk === "s" || tk === "f" || tk === "F" || tk === "B" || tk === "b" || tk === "n" || tk === "q" || tk === "Q") { /* 不消费数字栈，坐标独立 */ }
      else nums.length = 0;
    } else {
      // 非图形算子（Tj/TJ/Do 等）清空数字栈（其数字不是坐标）
      nums.length = 0;
    }
  }
  return ops;
}

function summarize(ops: { op: string; coords: number[] }[]) {
  const counts: Record<string, number> = {};
  for (const o of ops) counts[o.op] = (counts[o.op] ?? 0) + 1;
  // 关键：表格线用 m/l；白遮罩用 re/f
  const mlKeys = ops.filter(o => o.op === "m" || o.op === "l").map(o => `(${o.coords.map(c => c.toFixed(2)).join(",")})`);
  const reKeys = ops.filter(o => o.op === "re").map(o => `(${o.coords.map(c => c.toFixed(2)).join(",")})`);
  return { counts, mlSet: new Set(mlKeys), reSet: new Set(reKeys), mlKeys, reKeys };
}

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;

  // 编辑 79→78（触发 overlay + strip 路径）
  const { tc, vp } = await getTextContent(1);
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  const segs1 = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];
  const cnpjSeg = segs1.find((s) => s.text.includes("0001-79"))!;
  const cnpjLine = doc.pages[0].blocks[0].lines.find((l) => l.glyphs.map(g => g.char).join("").includes("0001-79"))!;
  const lineText = cnpjLine.glyphs.map(g => g.char).join("");
  const s7 = lineText.indexOf("0001-79") + "0001-".length;
  const src = (cnpjSeg as any).source;
  const seg: Segment = { ...cnpjSeg, id: "seg", text: "78", originalText: "79",
    source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s7, endGlyphIndex: s7 + 1 } } as any;
  const updated = applySegmentEditsToDocument(doc, [seg]) as EditableDocument;

  const exported = await exportEditableDocument(updated, bytes as unknown as ArrayBuffer);
  const expPdf = await PDFDocument.load(exported);
  log(`导出字节数=${exported.length} (原=${bytes.length})`);

  const npages = Math.min(pdf0.getPageCount(), expPdf.getPageCount());
  for (let i = 0; i < npages; i++) {
    const origOps = getPageGraphics(pdf0, i);
    const expOps = getPageGraphics(expPdf, i);
    if (i === 0) {
      const recs = resolvePageShowTextWithXObjects(expPdf, 0) as any[];
      log(`  [debug] resolver 对导出页1 抽得文本算子数=${recs.length} (若>0 证明导出流可解码→我的graphics解码器bug，非删除)`);
      log(`  [debug] 原第1页解码流数=${collectAllStreams(pdf0, 0).length} 导出=${collectAllStreams(expPdf, 0).length}`);
    }
    const o = summarize(origOps);
    const e = summarize(expOps);
    // 表格线(m/l) 原 ⊆ 导出 ?
    const missingML = [...o.mlSet].filter(k => !e.mlSet.has(k));
    const missingRE = [...o.reSet].filter(k => !e.reSet.has(k));
    log(`\n── 第${i + 1}页 ──`);
    log(`  图形算子计数 原=${JSON.stringify(o.counts)}`);
    log(`  图形算子计数 导=${JSON.stringify(e.counts)}`);
    log(`  表格线(m/l) 原=${o.mlSet.size} 导=${e.mlSet.size} 缺失=${missingML.length}`);
    log(`  矩形(re)   原=${o.reSet.size} 导=${e.reSet.size} 缺失=${missingRE.length}`);
    if (missingML.length) log(`  [!!] 原表格线坐标在导出中缺失(被删): ${missingML.slice(0, 8).join(" ")}`);
    if (missingRE.length) log(`  [!!] 原矩形在导出中缺失: ${missingRE.slice(0, 8).join(" ")}`);
    if (missingML.length === 0) log(`  [结论] 原表格线 100% 保留 → 未被 strip 删除`);
  }
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_d4.txt", out.join("\n"), "utf8");
  console.error("DONE -> _d4.txt");
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
