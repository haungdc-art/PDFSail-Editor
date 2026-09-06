/**
 * M7.8-040R 复现：强制 overlay 路径，实测 P1-P4。
 */
import * as fs from "node:fs";
import { PDFDocument, PDFRef, decodePDFRawStream } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { resolvePageShowTextWithXObjects, type TextShowRecord } from "./content-stream-resolver";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import { exportEditableDocument } from "./export-renderer";
import type { EditableDocument, EditableGlyph } from "./types";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 5 }), font: "" }) } : ({ getContext: () => null } as any)) };
}
const SUPPRESS = /\[?(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|SignatureRotationTrace)/;
const _log = console.log.bind(console);
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _log(...a); };

const ORIG = "D:/TRAE/pdfsail-v12/testcases/ocr/edit-pdf_uploads_1784668359598-iqd3ab8gq.pdf";

function glyphsOf(doc: EditableDocument): EditableGlyph[] {
  const out: EditableGlyph[] = [];
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines) for (const g of l.glyphs) out.push(g);
  return out;
}
function lineText(l: { glyphs: EditableGlyph[] }): string { return l.glyphs.map((g) => g.char ?? "").join(""); }
function decodeStream(pdf: PDFDocument, ref: string): string | null {
  const [n, g] = ref.split(" ").map(Number);
  try { const s: any = pdf.context.lookup(PDFRef.of(n, g)); const d: any = decodePDFRawStream(s).decode(); return typeof d === "string" ? d : new TextDecoder().decode(d); } catch { return null; }
}
function whiteRects(pdf: PDFDocument): { x: number; y: number; w: number; h: number }[] {
  const recs = resolvePageShowTextWithXObjects(pdf, 0) as any[];
  const refs = [...new Set(recs.map((r) => r.streamObjRef))];
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const ref of refs) {
    const text = decodeStream(pdf, ref);
    if (!text) continue;
    const toks = text.split(/\s+/);
    let fill = "";
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i];
      if (tk === "rg") fill = toks.slice(Math.max(0, i - 3), i).join(" ");
      else if (tk === "re") {
        const x = parseFloat(toks[i - 4]), y = parseFloat(toks[i - 3]), w = parseFloat(toks[i - 2]), h = parseFloat(toks[i - 1]);
        if (Number.isFinite(x) && Number.isFinite(w) && (fill === "1 1 1" || fill === "1 1 1 1")) out.push({ x, y, w, h });
      }
    }
  }
  return out;
}

function findTargets(doc: EditableDocument) {
  const needles = ["header", "240", "180", "390", "plywood", "10mm"];
  const out: any[] = [];
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines) {
    const t = lineText(l); const low = t.toLowerCase();
    if (needles.some((n) => low.includes(n))) out.push({ blockId: b.id, lineId: (l as any).id ?? "", text: t, glyphs: l.glyphs });
  }
  return out;
}

async function main() {
  const base = await parsePdfToEditableDocument(fs.readFileSync(ORIG) as unknown as ArrayBuffer, await PDFDocument.load(fs.readFileSync(ORIG)));
  _log(`[runtime] renderScale=${base.runtime?.renderScale} cssScale=${base.runtime?.cssScale} pageH=${base.pages[0]?.height}`);
  const targets = findTargets(base);
  _log(`[P1] 目标行数=${targets.length}`);
  for (const t of targets) {
    const opIds = new Set(t.glyphs.filter((g: any) => g.operatorId).map((g: any) => g.operatorId));
    const noOp = t.glyphs.filter((g: any) => !g.operatorId).length;
    _log(`  text="${t.text}" blockId=${t.blockId} lineId=${t.lineId} glyphs=${t.glyphs.length} operatorId数=${opIds.size} 无operatorId=${noOp}`);
    _log(`     operatorId集合=${[...opIds].slice(0, 6).join(", ")}`);
    const sample = t.glyphs.filter((g: any) => g.operatorId).slice(0, 3).map((g: any) => `${g.char}@${g.operatorId}#${g.operatorCharIndex}`);
    _log(`     glyph样本=${JSON.stringify(sample)}`);
  }

  for (const cssScale of [1.0, 0.1]) {
    _log(`\n=== 复现 export cssScale=${cssScale}（编辑追加'中'强制overlay）===`);
    const d = await parsePdfToEditableDocument(fs.readFileSync(ORIG) as unknown as ArrayBuffer, await PDFDocument.load(fs.readFileSync(ORIG)));
    const tg = findTargets(d);
    const segs: any[] = tg.map((t) => ({
      id: `seg_${t.blockId}_${t.lineId}`, text: t.text + "中", originalText: t.text, lineId: t.lineId,
      source: { blockId: t.blockId, lineId: t.lineId, startGlyphIndex: 0, endGlyphIndex: t.glyphs.length - 1 },
    }));
    const edited = applySegmentEditsToDocument(d, segs);
    if (cssScale === 1.0) {
      const eg = glyphsOf(edited).filter((g) => g.modified);
      _log(`  [P2] 编辑glyph=${eg.length} 有operatorId=${eg.filter((g) => g.operatorId).length}`);
      _log(`     P2样本=${JSON.stringify(eg.slice(0, 4).map((g) => ({ char: g.char, op: g.operatorId, oci: g.operatorCharIndex })))}`);
    }
    edited.runtime = { renderScale: 1.5, cssScale, pageMetrics: edited.pages.map((p) => ({ width: p.width, height: p.height })) };
    const out = await exportEditableDocument(edited, fs.readFileSync(ORIG) as unknown as ArrayBuffer, undefined, undefined, undefined);
    const outPdf = await PDFDocument.load(out);
    const outRecs = resolvePageShowTextWithXObjects(outPdf, 0) as TextShowRecord[];
    const tgOrig = findTargets(await parsePdfToEditableDocument(fs.readFileSync(ORIG) as unknown as ArrayBuffer, await PDFDocument.load(fs.readFileSync(ORIG))));
    let still = 0, rem = 0;
    for (const t of tgOrig) {
      const ops = new Set(t.glyphs.filter((g: any) => g.operatorId).map((g: any) => g.operatorId));
      for (const op of ops) { const e = outRecs.find((r) => r.operatorId === op); if (e && e.operatorText && e.operatorText.length > 0) still++; else rem++; }
    }
    _log(`  [P3] 原operator残留=${still} 已移除=${rem}`);
    const wr = whiteRects(outPdf);
    const pageW = outPdf.getPage(0).getWidth();
    _log(`  [P4] 白色矩形数=${wr.length} pageW=${pageW.toFixed(1)}`);
    wr.slice(0, 6).forEach((r, i) => _log(`     #${i + 1} x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} w=${r.w.toFixed(1)} h=${r.h.toFixed(1)}${r.w > pageW || r.h > pageW ? " <<超界" : ""}`));
  }
}
main().catch((e) => { _log("ERR", e); process.exit(1); });
