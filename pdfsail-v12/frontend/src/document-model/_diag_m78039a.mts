/**
 * M7.8-039A Diagnostic — Editor Geometry Divergence (X-position)
 * 只诊断，不修改 production code。
 * 追踪目标行（268282-1-1 ...）在 P0→P1→P3→P4 的 X。
 * 运行：npx tsx _diag_m78039a.mts <pdfPath>
 */
import * as fs from "node:fs";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs";
import { PDFDocument } from "pdf-lib";
import { parsePdfToEditableDocument } from "./pdf-importer";
import { exportEditableDocument } from "./export-renderer";
import type { EditableDocument, EditableGlyph, EditableLine } from "./types";
import { renderPageToCommands } from "./document-renderer";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 5 }), font: "" }) } : ({ getContext: () => null } as any)) };
}

const SUPPRESS = /\[(Sprint40-fix|Sprint34|YDIAG|M7\.8|PDFdraw|ExportLayout|WRITE_ENTRY|COORD_DIAG|DrawGlyph|NATIVE_REPLAY|009B|FIX-002|EditableDocument|ExportRenderer|DBG|Sprint34\.13|EditorMaskGeometry)\]/;
const _raw = console.log.bind(console);
console.log = (...a: any[]) => { const s = typeof a[0] === "string" ? a[0] : ""; if (!SUPPRESS.test(s)) _raw(...a); };
console.error = () => {};

function freshDoc(bytes: Uint8Array): Promise<EditableDocument> {
  return parsePdfToEditableDocument(bytes as unknown as ArrayBuffer, "doc.pdf");
}
function findTableLine(doc: EditableDocument): { blockId: string; lineId: string; line: EditableLine } | null {
  for (const p of doc.pages) for (const b of p.blocks) for (const l of b.lines) {
    const txt = l.glyphs.map((g) => g.char).join("");
    if (txt.includes("268282-1-1")) return { blockId: b.id, lineId: l.id, line: l };
  }
  return null;
}

async function main() {
  const pdfPath = process.argv[2] as string;
  const bytes = fs.readFileSync(pdfPath);

  // ── P0: 原始 PDF operators（pdf.js 原始 TextContent item；每 item = 一个 text show operator）──
  GlobalWorkerOptions.workerSrc = new URL("../../../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).href;
  const pdfjs = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false }).promise;
  const tc = await pdfjs.getPage(1).then((pg: any) => pg.getTextContent());
  _raw("==== P0: RAW PDF OPERATORS (textContent items) on page 1 ====");
  const items: any[] = tc.items;
  // 找出表格行的 operators：y(transform[5]) 接近 567（_ydiag 已知该行列基线≈567.35）
  const rowItems = items.filter((it: any) => it.transform && Math.abs(it.transform[5] - 567.35) < 6 && it.str && it.str.trim().length > 0);
  _raw(`表格行 text items 数 = ${rowItems.length}`);
  rowItems.forEach((it: any, idx: number) => {
    const tm = it.transform;
    _raw(`  [P0 op#${idx}] x=${tm[4].toFixed(2)} y=${tm[5].toFixed(2)} w=${it.width?.toFixed(2)} str=${JSON.stringify(it.str)}`);
  });
  await pdfjs.destroy();

  // ── P1: Imported Document Model ──
  const doc1 = await freshDoc(bytes);
  const t1 = findTableLine(doc1);
  if (!t1) { _raw("!! 未找到表格行"); return; }
  _raw("\n==== P1: IMPORTED DOCUMENT MODEL (EditableGlyph) ====");
  _raw(`lineId=${t1.lineId} glyphCount=${t1.line.glyphs.length}`);
  const g1 = t1.line.glyphs;
  g1.forEach((g: EditableGlyph, i: number) => {
    _raw(`  [P1 g#${i}] char=${JSON.stringify(g.char)} x=${g.bbox.x.toFixed(2)} y=${g.bbox.y.toFixed(2)} w=${g.bbox.width.toFixed(2)} opId=${g.operatorId ?? "-"} opIdx=${g.operatorCharIndex ?? "-"} hasOriginalBBox=${!!g.originalBBox}`);
  });
  // P1 per-operator firstGlyphX/lastGlyphX
  const byOp = new Map<string, { first: number; last: number; n: number }>();
  g1.forEach((g: EditableGlyph) => {
    const k = g.operatorId ?? "(none)";
    const e = byOp.get(k) ?? { first: Infinity, last: -Infinity, n: 0 };
    e.first = Math.min(e.first, g.bbox.x);
    e.last = Math.max(e.last, g.bbox.x + g.bbox.width);
    e.n++;
    byOp.set(k, e);
  });
  _raw("\n---- P1 operator boundaries (from bbox.x) ----");
  for (const [op, v] of byOp) _raw(`  op=${op} firstX=${v.first.toFixed(2)} lastX=${v.last.toFixed(2)} glyphs=${v.n}`);

  // ── P3: Editor overlay renderer input (DrawGlyphCommand.x) ──
  const cmds = renderPageToCommands(doc1, 0);
  const lineCmds = cmds.filter((c: any) => c.type === "drawGlyph" && c.lineId === t1.lineId);
  _raw("\n==== P3: EDITOR OVERLAY RENDERER INPUT (DrawGlyphCommand.x) ====");
  _raw(`line glyph cmds = ${lineCmds.length}`);
  lineCmds.forEach((c: any, i: number) => {
    _raw(`  [P3 cmd#${i}] char=${JSON.stringify(c.char)} x=${c.x.toFixed(2)} y=${c.y.toFixed(2)} w=${c.width.toFixed(2)}`);
  });

  // ── P4: Export → re-import ──
  _raw("\n==== P4: EXPORT → RE-IMPORT ====");
  const exp = await exportEditableDocument(doc1, bytes as unknown as ArrayBuffer);
  const doc4 = await freshDoc(exp);
  const t4 = findTableLine(doc4);
  if (t4) {
    _raw(`lineId=${t4.lineId} glyphCount=${t4.line.glyphs.length}`);
    t4.line.glyphs.slice(0, 12).forEach((g: EditableGlyph, i: number) => {
      _raw(`  [P4 g#${i}] char=${JSON.stringify(g.char)} x=${g.bbox.x.toFixed(2)} opId=${g.operatorId ?? "-"}`);
    });
  } else _raw("!! 未找到表格行 (reimport)");

  _raw("\n==== SUMMARY ====");
  _raw(`P0 operators in row: ${rowItems.length}`);
  _raw(`P1 distinct operatorIds: ${byOp.size}`);
  _raw(`P1 first glyph x: ${g1[0]?.bbox.x.toFixed(2)}  last glyph x: ${g1[g1.length - 1]?.bbox.x.toFixed(2)}`);
}
main().catch((e) => { console.error("DIAG ERR", e); process.exit(1); });
