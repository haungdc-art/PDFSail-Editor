import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream, PDFRef, PDFArray } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument, renderDocumentToExportCommands } from "./export-renderer";
import { collectFontResources, findFontForChar } from "./pdf-font-provenance";
import type { EditableDocument, Segment, EditableGlyph } from "../editor-engine/types";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784672098938-k1smuql7x.pdf";
const out: string[] = [];
const log = (...a: any[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
const S = /\[009B|NATIVE|EXPORT_PATH|M7\.8|Sprint34|\[MASK_DIAG|YDIAG|GLYPH_GEOMETRY|M7\.7-010|line:|lines=|line\d|glyphs=|EditableDocument|drawTextGlyph|\[Sprint/;
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!S.test(s)) console.error(...a); };

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
  } catch { return []; }
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
    const collect = (n: any): string => {
      if (n instanceof PDFArray) { let s = ""; for (const item of n.asArray()) { const o = item instanceof PDFRef ? pdf.context.lookup(item) : item; const b = streamBytes(o); if (b) s += new TextDecoder("latin1").decode(b) + "\n"; } return s; }
      const o = n instanceof PDFRef ? pdf.context.lookup(n) : n;
      const b = streamBytes(o); return b ? new TextDecoder("latin1").decode(b) : "";
    };
    return collect(node);
  } catch { return ""; }
}
function graphicsOps(content: string): Set<string> {
  const tokens = content.split(/(\s+)/).filter(t => t.trim().length > 0);
  const ml: string[] = []; const nums: number[] = [];
  for (const tk of tokens) {
    if (/^-?\d*\.?\d+$/.test(tk)) { nums.push(parseFloat(tk)); continue; }
    if (tk === "m" || tk === "l") { const n = nums.slice(-2); ml.push(`(${n.map(c => c.toFixed(2)).join(",")})`); nums.length = 0; }
    else if (!["re", "h", "S", "s", "f", "F", "B", "b", "n", "q", "Q", "cm", "w"].includes(tk)) { nums.length = 0; }
  }
  return new Set(ml);
}
function count(hay: string, needle: string): number { if (!needle) return 0; let c = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { c++; i += needle.length; } return c; }

async function buildEdited(replacement: string): Promise<{ bytes: Buffer; pdf0: PDFDocument; updated: EditableDocument; footerLine: any; nEdited: number }> {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;
  const { tc, vp } = await getTextContentFromBytes(new Uint8Array(bytes.buffer.slice(0)), 1);
  const glyphs = extractGlyphs(tc as any);
  const lines = groupIntoLines(glyphs);
  const mapper = new CoordinateMapperImpl({ viewportScale: 1.5, viewportHeight: vp.height / 1.5, viewportWidth: vp.width / 1.5, cssScale: 1, originXDevice: vp.transform[4], originYDevice: vp.transform[5] } as any);
  const segs1 = buildSegments(lines, mapper, new FontAnalyzerImpl(), 1, undefined) as Segment[];
  const cnpjSegs = segs1.filter((s) => s.text.includes("0001-79"));
  const editSegs: any[] = cnpjSegs.map((seg) => {
    const src = (seg as any).source;
    // "79" 在 segment 文本内的偏移 + segment 绝对起始 = 整行绝对 glyph 索引
    const inSeg = seg.text.indexOf("0001-79") + "0001-".length;
    const s0 = (src?.startGlyphIndex ?? 0) + inSeg;
    const s1 = s0 + 1; // "79" 两 glyph
    return { ...seg, id: seg.id + "_e", text: replacement, originalText: "79", source: { blockId: src.blockId, lineId: src.lineId, startGlyphIndex: s0, endGlyphIndex: s1 } };
  });
  const updated = applySegmentEditsToDocument(doc, editSegs) as EditableDocument;
  const footerLine = updated.pages[0].blocks.flatMap(b => b.lines).find(l => (l as any).edited);
  const nEdited = updated.pages[0].blocks.flatMap(b => b.lines).filter(l => (l as any).edited).length;
  return { bytes, pdf0, updated, footerLine, nEdited };
}

function dumpGlyphMatrix(label: string, footerLine: any, updated: EditableDocument, highlightIdx: number[]) {
  log(`\n--- ${label} 字体溯源矩阵 (EditableGlyph) ---`);
  if (!footerLine) { log("  (无 edited footer line)"); return; }
  const styles: any[] = (updated as any).styles || [];
  const glyphs: EditableGlyph[] = footerLine.glyphs;
  const txt = glyphs.map(g => g.char).join("");
  log(`  footer text = "${txt}"  (nGlyphs=${glyphs.length})`);
  const hi = new Set(highlightIdx.length ? highlightIdx : glyphs.map((g, i) => g.modified ? i : -1).filter(i => i >= 0));
  glyphs.forEach((g, i) => {
    const m = g.metrics as any;
    const fiTop = g.fontIdentity as any;
    const fiMet = m?.fontIdentity as any;
    const fi = fiTop ?? fiMet;
    const tag = hi.has(i) ? "  <<< 目标(mod)" : "";
    log(`  [${i}] char=${JSON.stringify(g.char)} orig=${JSON.stringify(g.originalChar)} mod=${g.modified}${tag}`);
    log(`      operatorId=${JSON.stringify(g.operatorId)} opCharIdx=${g.operatorCharIndex}`);
    log(`      pdfCharCode(top)=${g.pdfCharCode ?? "undefined"}  pdfCharCode(metrics)=${m?.pdfCharCode ?? "undefined"}`);
    log(`      fontIdentity.top=${fiTop ? `${fiTop.fontRef}/${fiTop.fontName}(emb=${fiTop.embedded},sub=${fiTop.subtype})` : "undefined"}`);
    log(`      fontIdentity.metrics=${fiMet ? `${fiMet.fontRef}/${fiMet.fontName}` : "undefined"}  -> effective=${fi ? `${fi.fontRef}/${fi.fontName}` : "NONE"}`);
    log(`      pdfTransform=${JSON.stringify(g.pdfTransform ?? m?.pdfTransform)}`);
    log(`      bbox.x=${g.bbox.x?.toFixed(1)} bbox.y=${g.bbox.y?.toFixed(1)} h=${g.bbox.height?.toFixed(1)} fontSize=${styles[g.styleRef]?.fontSize}`);
  });
}

function dumpDrawCommands(label: string, updated: EditableDocument): number {
  log(`\n--- ${label} DrawTextGlyphCommand (export command 阶段) ---`);
  const renderScale = (updated as any).runtime?.renderScale ?? 1.5;
  const cssScale = (updated as any).runtime?.cssScale ?? 1;
  const ctx: any = { renderScale, cssScale, pageHeightPt: updated.pages[0]?.height ?? 792 };
  const cmds: any[] = renderDocumentToExportCommands(updated, ctx) as any[];
  const glyphCmds = cmds.filter(c => c.type === "drawTextGlyph" && c.pageIndex === 0 && c.y >= 585 && c.y <= 610);
  log(`  footer-band drawTextGlyph commands = ${glyphCmds.length}`);
  glyphCmds.forEach(c => {
    const fi = c.fontIdentity as any;
    log(`  char=${JSON.stringify(c.char)} x=${c.x?.toFixed(1)} y=${c.y?.toFixed(1)} size=${c.fontSize?.toFixed(1)} fam=${JSON.stringify(c.fontFamily)} pdfCharCode=${c.pdfCharCode ?? "undef"} fontRef=${fi?.fontRef ?? "undef"}`);
  });
  return glyphCmds.length;
}

async function runCase(label: string, replacement: string, newToken: string, highlightIdx: number[]) {
  const { bytes, pdf0, updated, footerLine, nEdited } = await buildEdited(replacement);
  dumpGlyphMatrix(label, footerLine, updated, highlightIdx);
  const footerCmds = dumpDrawCommands(label, updated);
  const exported = await exportEditableDocument(updated, bytes as unknown as ArrayBuffer);
  const expPdf = await PDFDocument.load(exported);
  const expLines0 = await extractLines(exported, 1);
  const expText0 = expLines0.join("\n");
  const origLines0 = await extractLines(new Uint8Array(bytes.buffer.slice(0)), 1);
  const origText0 = origLines0.join("\n");
  const origRaw0b = decodePageContent(await PDFDocument.load(bytes), 0);
  const expRaw0 = decodePageContent(expPdf, 0);
  const origML = graphicsOps(origRaw0b);
  const expML = graphicsOps(expRaw0);
  const missingML = [...origML].filter(k => !expML.has(k));
  const sz0 = (await PDFDocument.load(bytes)).getPage(0).getSize();
  const szE = expPdf.getPage(0).getSize();
  // D1 视觉渲染：footer band 有 draw command（坐标正确 y≈594.8）
  const c1_visual = footerCmds > 0;
  // D2 文本 extraction：新 token 在 pdfjs 文本层出现
  const c2_extract = count(expText0, newToken) >= 1;
  // D3 复制/搜索：同 D2（可复制=文本层可见）
  const c3_copy = c2_extract;
  // D4 原 operator strip（content stream）：流内无原 "0001-79" 字面
  const c4_stripStream = count(expRaw0, "0001-79") === 0;
  // D5 字体映射：每个 modified glyph 要么自身有 pdfCharCode，要么所在字体能编码该 char
  const c5_fontmap = !footerLine?.glyphs?.some((g: any) => {
    if (!g.modified) return false;
    if (typeof (g.pdfCharCode ?? g.metrics?.pdfCharCode) === "number") return false;
    const fi = g.fontIdentity ?? g.metrics?.fontIdentity;
    if (fi?.unicodeToCharCode?.get(g.char) !== undefined) return false;
    return true; // 既无 CID 也无字体映射 → 字体映射缺口
  });
  // D6 表格线完整
  const c6_graphics = missingML.length === 0;
  // D7 页面尺寸不变
  const c7_size = Math.abs(sz0.width - szE.width) < 0.01 && Math.abs(sz0.height - szE.height) < 0.01;
  log(`\n=== ${label} (79→${JSON.stringify(replacement)}) nEdited=${nEdited} ===`);
  log(`  [D1 视觉渲染] footer draw命令数=${footerCmds}: ${c1_visual}`);
  log(`  [D2 文本extraction] "${newToken}" 在pdfjs出现${count(expText0, newToken)}次: ${c2_extract}`);
  log(`  [D3 复制/搜索] 可复制文本命中: ${c3_copy}`);
  log(`  [D4 content stream strip] 流内0001-79计数=${count(expRaw0, "0001-79")}→0: ${c4_stripStream}`);
  log(`  [D5 字体映射] 每个modified glyph均可编码(有CID或字体支持): ${c5_fontmap}`);
  log(`  [D6 表格线完整] 缺失=${missingML.length}: ${c6_graphics}`);
  log(`  [D7 页面尺寸] 原=${sz0.width.toFixed(1)}x${sz0.height.toFixed(1)} 导=${szE.width.toFixed(1)}x${szE.height.toFixed(1)}: ${c7_size}`);
  const pass = c1_visual && c2_extract && c3_copy && c4_stripStream && c5_fontmap && c6_graphics && c7_size;
  log(`  >>> ${pass ? "PASS" : "FAIL"} <<<`);
  return pass;
}

async function fontMappingCheck(pdf0: PDFDocument) {
  log(`\n========== 字体溯源 (collectFontResources / findFontForChar) ==========`);
  const res = collectFontResources(pdf0, 0);
  log(`  页面0 字体资源数=${res.size}`);
  const targets = ["7", "9", "8", "1", "2", "3", "á", "ç", "A", "ß", "€", "中", "ã", "õ"];
  for (const [name, r] of res) {
    const u2c = (r as any).unicodeToCharCode as Map<string, number> | undefined;
    const row = targets.map(ch => `${JSON.stringify(ch)}=${u2c?.get(ch) ?? "-"}`).join(" ");
    log(`  ${name} name=${r.fontName} sub=${r.subtype} emb=${r.embedded} toUni=${r.hasToUnicode}  ${row}`);
  }
  log(`\n  findFontForChar(页面0):`);
  for (const ch of targets) {
    const f = findFontForChar(pdf0, 0, ch);
    log(`    ${JSON.stringify(ch)} -> ${f ? `${f.resourceName} code=${f.charCode}` : "UNDEFINED(字体不支持)"}`);
  }
  // 原 PDF 全文是否包含这些字符（判断 subset 是否可能含）
  let full = "";
  const n = pdf0.getPageCount();
  for (let p = 1; p <= n; p++) {
    const { tc } = await getTextContentFromBytes(new Uint8Array(fs.readFileSync(ORIG)), p);
    for (const it of (tc as any).items) if (typeof it.str === "string") full += it.str;
  }
  log(`\n  原 PDF 全文长度=${full.length}; 各字符出现: ` + targets.map(ch => `${JSON.stringify(ch)}=${count(full, ch)}`).join(" "));
}

(async () => {
  const pdf0 = await PDFDocument.load(fs.readFileSync(ORIG));
  await fontMappingCheck(pdf0);
  const results: boolean[] = [];
  results.push(await runCase("R1", "78", "0001-78", [5, 6]));        // 原7(idx5) / repl8(idx6)
  results.push(await runCase("R2", "7", "0001-7", [5]));            // 原7(idx5)
  results.push(await runCase("R3", "79123", "0001-79123", [5, 6, 7, 8, 9])); // 原7/9 + ins1/2/3
  results.push(await runCase("R4", "", "0001-", [5, 6]));
  results.push(await runCase("R5", "79á", "0001-79á", [5, 6, 7]));  // ins á
  results.push(await runCase("R6", "79ç", "0001-79ç", [5, 6, 7]));  // ins ç
  results.push(await runCase("R7", "79A", "0001-79A", [5, 6, 7]));  // ins A(原文已含)
  results.push(await runCase("R8", "79ß", "0001-79ß", [5, 6, 7]));  // ins ß(字体支持但原文未含?)
  results.push(await runCase("R9", "79中", "0001-79中", [5, 6, 7])); // ins 中(字体不支持)
  log(`\n##### 总结果: ${results.filter(Boolean).length}/9 PASS #####`);
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_m78041_diag.txt", out.join("\n"), "utf8");
  console.error("DONE -> _m78041_diag.txt");
})().catch(e => { console.error("ERR", e); process.exit(1); });
