import "./_env_doc.mts";
import * as fs from "node:fs";
import { PDFDocument, decodePDFRawStream, PDFRawStream, PDFStream, PDFRef, PDFArray } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument, renderDocumentToExportCommands, ensureIndirectPageContents, writeExportCommandsToPDF } from "./export-renderer";
import { stripNativeReadyState } from "./native-export-policy";
import { mutateLineText } from "./document-mutation";
import type { EditableDocument } from "../editor-engine/types";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";

process.env.MASK_DIAG = "1";
process.env.STRIP_DIAG = "1";

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668534110-k2v2grpo8.pdf";
const out: string[] = [];
const log = (...a: any[]) => { out.push(a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); console.log(...a); };
const S = /\[009B|NATIVE|EXPORT_PATH|M7\.8|M7\.7|Sprint34|\[MASK_DIAG|YDIAG|GLYPH_GEOMETRY|EditableDocument|drawTextGlyph|STRIP_DIAG|fully stripped|EDITED_LINE|INFO|WRITE_ENTRY|\[FIX-002|文本层清理/;
console.log = ((orig: any) => (...a: any[]) => {
  const s = typeof a[0] === "string" ? a[0] : "";
  if (S.test(s)) console.error(...a);
})(console.log);

async function getTextContentFromBytes(dataBytes: Uint8Array, pageIndex1Based: number) {
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
    const glyphs = (await import("../editor-engine/TextExtractor")).extractGlyphs(tc as any);
    const lines = (await import("../editor-engine/SegmentBuilder")).groupIntoLines(glyphs);
    return lines.map((l: any) => l.map((g: any) => g.str ?? g.char ?? "").join(""));
  } catch { return []; }
}
function decodePageContent(pdf: PDFDocument, pageIdx: number): string {
  try {
    const page = pdf.getPage(pageIdx) as any;
    const node = page.node.Contents?.();
    const streamBytes = (obj: any): Uint8Array | null => {
      if (obj instanceof PDFRawStream || obj instanceof PDFStream) {
        try { const b = decodePDFRawStream(obj).decode(); if (b && b.length) return b; } catch {}
        try { const b = decodePDFRawStream(obj).getBytes(); if (b && b.length) return b; } catch {}
        try { const b = obj.contents?.getBytes?.(); if (b && b.length) return b; } catch {}
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

async function main() {
  const bytes = fs.readFileSync(ORIG);
  const pdf0 = await PDFDocument.load(bytes);
  const doc = (await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, pdf0)) as EditableDocument;

  // 找到含 "Bidens" 且含 "69" 的行
  let blockId = "", lineId = "", lineText = "", start = -1;
  outer:
  for (const page of doc.pages) for (const block of page.blocks) for (const line of block.lines) {
    const t = line.glyphs.map(g => g.char).join("");
    if (t.includes("Bidens") && t.includes("69")) {
      blockId = block.id; lineId = line.id; lineText = t; start = t.indexOf("69");
      break outer;
    }
  }
  log(`\n=== 找到目标行: block=${blockId} line=${lineId}`);
  log(`    行文本 = "${lineText}"  ("69" 起始索引=${start})`);
  if (start < 0) { log("  !! 未找到 69，退出"); fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_69.txt", out.join("\n")); return; }

  // operatorId / modified 等溯源矩阵
  const line = doc.pages.flatMap(p => p.blocks).find(b => b.id === blockId)!.lines.find(l => l.id === lineId)!;
  log("    溯源矩阵:");
  line.glyphs.forEach((g: any, i: number) => {
    log(`      [${i}] char=${JSON.stringify(g.char)} orig=${JSON.stringify(g.originalChar)} mod=${g.modified} operatorId=${JSON.stringify(g.operatorId)} opCharIdx=${g.operatorCharIndex} pdfCharCode=${g.pdfCharCode ?? "undef"}`);
  });

  const newLineText = lineText.slice(0, start) + "619" + lineText.slice(start + 2);
  const res = mutateLineText(doc, blockId, lineId, newLineText, { start, end: start + 1 });
  log(`\n=== mutateLineText(69→619) mutated=${res.mutated}`);
  const editedLine = res.document.pages.flatMap(p => p.blocks).find(b => b.id === blockId)!.lines.find(l => l.id === lineId)!;
  log(`    编辑后行文本 = "${editedLine.glyphs.map(g => g.char).join("")}"`);
  editedLine.glyphs.forEach((g: any, i: number) => {
    log(`      [${i}] char=${JSON.stringify(g.char)} orig=${JSON.stringify(g.originalChar)} mod=${g.modified} operatorId=${JSON.stringify(g.operatorId)} pdfCharCode=${g.pdfCharCode ?? g.metrics?.pdfCharCode ?? "undef"}`);
  });

  // 导出命令阶段：mask / drawTextGlyph
  const ctx: any = { renderScale: (res.document as any).runtime?.renderScale ?? 1.5, cssScale: (res.document as any).runtime?.cssScale ?? 1, pageHeightPt: res.document.pages[0]?.height ?? 792 };
  const cmds: any[] = renderDocumentToExportCommands(res.document, ctx) as any[];
  const masks = cmds.filter(c => c.type === "drawLine" && c.purpose === "mask" && c.blockId === blockId);
  const glyphs = cmds.filter(c => c.type === "drawTextGlyph" && c.blockId === blockId);
  log(`\n    导出命令: mask 数=${masks.length} drawTextGlyph 数=${glyphs.length}`);
  glyphs.forEach((c: any) => log(`      drawTextGlyph char=${JSON.stringify(c.char)} x=${c.x?.toFixed?.(1)} y=${c.y?.toFixed?.(1)} pdfCharCode=${c.pdfCharCode ?? "undef"}`));

  // 实际导出 PDF
  const exported = await exportEditableDocument(res.document, bytes as unknown as ArrayBuffer);
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_partial_export.pdf", exported);
  const expPdf = await PDFDocument.load(exported);
  const expLines = (await extractLines(exported, 1)).join("\n");
  const origLines = (await extractLines(new Uint8Array(bytes.buffer.slice(0)), 1)).join("\n");
  const origRaw = decodePageContent(await PDFDocument.load(bytes), 0);
  const expRaw = decodePageContent(expPdf, 0);
  const origML = graphicsOps(origRaw);
  const expML = graphicsOps(expRaw);
  const missingML = [...origML].filter(k => !expML.has(k));

  const c2_619 = count(expLines, "619") >= 1;
  const c2_69ghost = expLines.split("\n").some(l => l.includes("69") && l.includes("Bidens"));
  const c4_strip = count(expRaw, "(69)") === 0; // 原 Tj 字面应被剥离
  const c6_graphics = missingML.length === 0;

  log(`\n=== 结果核对 ===`);
  log(`  [D2] 导出文本含 "619": ${c2_619}`);
  log(`  [D2] 导出文本 Bidens 行仍含 "69" (重影?): ${c2_69ghost}`);
  log(`  [D4] 流内 "(69)" 字面计数=${count(expRaw, "(69)")} → 应为 0: ${c4_strip}`);
  log(`  [D6] 表格线(图形 m/l 点)缺失数=${missingML.length}: ${c6_graphics}`);
  if (missingML.length) log(`       缺失样例: ${missingML.slice(0, 20).join("  ")}`);

  // ===== Scenario B: 强制走 mask 路径（不剥离原算子、fullyStripped 置空，模拟 provenance 缺失/剥离失败）=====
  log(`\n########## Scenario B: 强制 mask 路径（模拟 provenance 缺失/剥离失败时的真实 bug 路径）##########`);
  const pdfB = await PDFDocument.load(bytes);
  const overlayB = stripNativeReadyState(res.document);
  ensureIndirectPageContents(pdfB);
  const rs = (res.document as any).runtime?.renderScale ?? 1.5;
  const cs = (res.document as any).runtime?.cssScale ?? 1;
  const ctxB: any = ctx;
  const cmdsB: any[] = renderDocumentToExportCommands(overlayB, ctxB) as any[];
  const masksB = cmdsB.filter((c: any) => c.type === "drawLine" && c.purpose === "mask" && c.blockId === blockId);
  log(`    mask 命令数=${masksB.length}`);
  masksB.forEach((m: any) => log(`      mask rect x=${m.x?.toFixed?.(1)} y=${m.y?.toFixed?.(1)} w=${m.width?.toFixed?.(1)} h=${m.height?.toFixed?.(1)}`));
  await writeExportCommandsToPDF(
    pdfB, cmdsB,
    (idx: number) => { const p = res.document.pages[idx]; return p ? p.height / (rs * cs) : 842; },
    undefined, new Set() as any,
  );
  const outB = await pdfB.save();
  const expPdfB = await PDFDocument.load(outB);
  const expRawB = decodePageContent(expPdfB, 0);
  const expMLB = graphicsOps(expRawB);
  const missingMLB = [...origML].filter(k => !expMLB.has(k));
  const expLinesB = (await extractLines(outB, 1)).join("\n");
  const c6b_graphics = missingMLB.length === 0;
  const c2b_69ghost = expLinesB.split("\n").some(l => l.includes("69") && l.includes("Bidens"));
  log(`    [D6-B] 表格线(图形 m/l 点)缺失数=${missingMLB.length}: ${c6b_graphics ? "PASS(完整)" : "FAIL(被擦除!)"}`);
  if (missingMLB.length) log(`        缺失样例: ${missingMLB.slice(0, 20).join("  ")}`);
  log(`    [D2-B] 未剥离故 "69" 仍可文本层提取(预期内): ${c2b_69ghost}`);

  const pass = c2_619 && !c2_69ghost && c4_strip && c6_graphics;
  log(`\n>>> ScenarioA ${pass ? "PASS" : "FAIL"} | ScenarioB 表格线=${c6b_graphics ? "完整" : "被擦除!"} <<<`);
  fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_69.txt", out.join("\n"), "utf8");
  console.error("DONE -> _repro_69.txt");
}
main().catch(e => { console.error("ERR", e); fs.writeFileSync("D:/TRAE/pdfsail-v12/frontend/src/document-model/_repro_69.txt", out.join("\n")); process.exit(1); });
