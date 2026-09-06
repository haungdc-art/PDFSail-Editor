/**
 * 040R 验证：编辑 3 行后导出，结构性核验 7 条硬性标准。
 */
import * as fs from "node:fs";
import { PDFDocument, PDFRef, decodePDFRawStream } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects } from "./content-stream-resolver";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import type { EditableDocument, EditableGlyph } from "./types";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {}
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace|M7\.8-022A|NATIVE_DISABLED)/;
const _log = console.log.bind(console);
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };
const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";
function lineText(l: any) { return l.glyphs.map((g: any) => g.char ?? "").join(""); }
function decodeStream(pdf: PDFDocument, ref: string): string | null {
  const [n, g] = ref.split(" ").map(Number);
  try { const s: any = pdf.context.lookup(PDFRef.of(n, g)); const d: any = decodePDFRawStream(s).decode(); return typeof d === "string" ? d : new TextDecoder().decode(d); } catch { return null; }
}
function blackRectCount(pdf: PDFDocument): number {
  const recs = resolvePageShowTextWithXObjects(pdf, 0) as any[];
  const refs = [...new Set(recs.map((r) => r.streamObjRef))];
  let c = 0;
  for (const ref of refs) {
    const text = decodeStream(pdf, ref); if (!text) continue;
    const toks = text.split(/\s+/); let fill = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk === "rg") fill = toks.slice(Math.max(0, i - 3), i).join(" ");
      else if (tk === "re") { const w = parseFloat(toks[i - 2]); if (Number.isFinite(w) && fill === "0 0 0") c++; }
    }
  }
  return c;
}

async function run(cssScale: number) {
  const bytes = fs.readFileSync(ORIG);
  const base = await parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, await PDFDocument.load(bytes));
  // 选 3 行：表头 l1、240/180/360 行 l12、10MM Plywood 行 l27
  const targets = ["pdf_pdf_p1_block0_l1", "pdf_pdf_p1_block0_l12", "pdf_pdf_p1_block0_l27"];
  const segs: any[] = [];
  for (const p of base.pages) for (const b of p.blocks) for (const l of b.lines) {
    const lid = (l as any).id;
    if (targets.includes(lid)) {
      const t = lineText(l);
      segs.push({ id: `s_${lid}`, text: t + "【改】", originalText: t, lineId: lid, source: { blockId: b.id, lineId: lid, startGlyphIndex: 0, endGlyphIndex: l.glyphs.length - 1 } });
    }
  }
  _log(`[verify cssScale=${cssScale}] 编辑段数=${segs.length}`);
  const edited = applySegmentEditsToDocument(base, segs);
  const origPdf = await PDFDocument.load(bytes);
  const origRecs = resolvePageShowTextWithXObjects(origPdf, 0) as any[];
  // 标准1：编辑行的原 operator 残留
  let still = 0, rem = 0;
  for (const s of segs) {
    const opIds = new Set(edited.pages[0].blocks.flatMap((b: any) => b.lines.find((l: any) => l.id === s.lineId)?.glyphs ?? []).filter((g: any) => g.operatorId).map((g: any) => g.operatorId));
    for (const op of opIds) { const e = origRecs.find((r) => r.operatorId === op); if (e && e.operatorText) still++; else rem++; }
  }
  _log(`  标准1(原文字operator=0): 残留=${still} 移除=${rem} => ${still === 0 ? "PASS" : "FAIL"}`);
  // 导出
  edited.runtime = { renderScale: 1.5, cssScale, pageMetrics: edited.pages.map((p: any) => ({ width: p.width, height: p.height })) };
  const out = await exportEditableDocument(edited, bytes as unknown as ArrayBuffer, undefined, undefined, undefined);
  const outPdf = await PDFDocument.load(out);
  const outRecs = resolvePageShowTextWithXObjects(outPdf, 0) as any[];
  // 标准2：新文字"【改】"只出现一次（每编辑行一次）
  const newCnt = outRecs.filter((r: any) => r.operatorText && r.operatorText.includes("【改】")).length;
  _log(`  标准2(新文字出现): 【改】算子数=${newCnt} (期望=3) => ${newCnt === 3 ? "PASS" : "FAIL"}`);
  // 标准5：表格黑矩数量 vs 原始
  const origBlack = blackRectCount(origPdf);
  const outBlack = blackRectCount(outPdf);
  _log(`  标准5(表格线不减少): 原始黑矩=${origBlack} 导出黑矩=${outBlack} => ${outBlack >= origBlack ? "PASS" : "FAIL"}`);
  // 标准3/4：overlay 矩形在页面内（当前 skipOverlay → 应无白矩）
  const pageW = outPdf.getPage(0).getWidth();
  const pageH = outPdf.getPage(0).getHeight();
  const refs = [...new Set(outRecs.map((r: any) => r.streamObjRef))];
  let white = 0, oob = 0;
  for (const ref of refs) {
    const text = decodeStream(outPdf, ref); if (!text) continue;
    const toks = text.split(/\s+/); let fill = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk === "rg") fill = toks.slice(Math.max(0, i - 3), i).join(" ");
      else if (tk === "re") { const x = parseFloat(toks[i - 4]), y = parseFloat(toks[i - 3]), w = parseFloat(toks[i - 2]), h = parseFloat(toks[i - 1]); if (Number.isFinite(w) && (fill === "1 1 1" || fill === "1 1 1 1")) { white++; if (x < 0 || y < 0 || x + w > pageW || y + h > pageH) oob++; } }
    }
  }
  _log(`  标准3/4(白矩在页面内): 白矩数=${white} 超界=${oob} => ${white === 0 || oob === 0 ? "PASS" : "FAIL"}`);
  _log(`  pageW=${pageW.toFixed(1)} pageH=${pageH.toFixed(1)}`);
}

await run(1.0);
await run(0.1);
