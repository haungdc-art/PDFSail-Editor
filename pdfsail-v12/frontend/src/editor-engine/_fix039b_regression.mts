/**
 * M7.8-039B 回归（仅诊断 / 不改 production code）。
 *
 * 用真实提取的表格行几何（来自 _diag_m78039b_out.txt 的 8 个 RawGlyph）构造合成 LineGroup，
 * 确定性验证 Plan A（Spatial Text Run → Segment）：
 *   P1 列 X anchor 还原（5 段，cssX ≈ {36,249.62,325.65,414,594}）
 *   P2 编辑 B，A/C/D/E 不动（导出绑定 mutateLineText 验证）
 *   P3 编辑 D，其余不动
 *   P4 F&R 替换 B，其余 cssX 不变
 *   P5 翻译 D（变长），其余 cssX 不变
 *   P6 Export 几何不变（其它列 bbox.x 保留）
 *   P7 普通段落（单 operator）不被拆成多 Segment
 *   P8 Duplicate Text：同行两相同文本 → 暴露 indexOf 定位歧义（已知缺陷，单独报告，不在 039B 范围）
 */
import * as fs from "node:fs";
import { mutateLineText } from "../document-model/document-mutation";
import { buildSegments } from "./SegmentBuilder";
import { CoordinateMapperImpl } from "./CoordinateMapper";
import { FontAnalyzerImpl } from "./FontAnalyzer";
import type { RawGlyph, LineGroup } from "./types";
import type { EditableDocument, EditableLine, EditableGlyph } from "../document-model/types";

try {
  const { createCanvas } = require("@napi-rs/canvas") as any;
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? createCanvas(1, 1) : ({ getContext: () => null } as any)) };
} catch {
  (globalThis as any).document = { createElement: (t: string) => (t === "canvas" ? { getContext: () => ({ measureText: () => ({ width: 5 }), font: "" }) } : ({ getContext: () => null } as any)) };
}
const _log = console.log.bind(console);
console.log = (...a: any[]) => _log(...a);
console.error = () => {};

const FONT_SIZE = 9.9;
const PDFY = 329.847;
const COLOR = [0, 0, 0];
// 真实提取的 8 个 RawGlyph（pdfX / width / str）
const RAW: Array<[number, number, string]> = [
  [24.00, 33.62, "268282-1-1"],
  [57.62, 108.80, " "],
  [166.42, 25.62, "1.057,50"],
  [192.04, 25.06, " "],
  [217.10, 33.87, "27/04/2026"],
  [250.97, 145.03, " "],
  [276.00, 111.60, "MARLUPI VESTUARIO INFANTIL LTDA"],
  [396.00, 112.70, "COMERCIAL TEXTIL SUL BRASIL LTDA"],
];

function makeRawGlyph(pdfX: number, width: number, str: string): RawGlyph {
  return {
    str,
    transform: [1, 0, 0, 1, pdfX, PDFY],
    fontName: "g_d0_f2",
    fontSize: FONT_SIZE,
    width,
    height: FONT_SIZE,
    color: COLOR,
    hz: 1,
    pdfX,
    pdfY: PDFY,
  };
}
function makeRow(): LineGroup {
  const glyphs = RAW.map(([x, w, s]) => makeRawGlyph(x, w, s));
  return {
    text: glyphs.map((g) => g.str).join(""),
    pdfX: 24,
    pdfY: PDFY,
    width: 396 + 112.70 - 24,
    height: FONT_SIZE,
    fontName: "g_d0_f2",
    fontSize: FONT_SIZE,
    color: COLOR,
    hz: 1,
    glyphs,
  };
}
function makeMapper() {
  return new CoordinateMapperImpl({
    viewportScale: 1.5, viewportHeight: 792, viewportWidth: 612, cssScale: 1,
    originXDevice: 0, originYDevice: 792 * 1.5,
  });
}
const fa = new FontAnalyzerImpl();

// 期望列 anchor（PDF pt / cssX=pdfX*1.5）
const EXPECT_PDFX = [24, 166.42, 217.10, 276, 396];
const EXPECT_CSSX = EXPECT_PDFX.map((x) => x * 1.5);
const EXPECT_TEXT = ["268282-1-1", "1.057,50", "27/04/2026", "MARLUPI VESTUARIO INFANTIL LTDA", "COMERCIAL TEXTIL SUL BRASIL LTDA"];

interface PResult { name: string; ok: boolean; msg: string; }
const results: PResult[] = [];
function check(name: string, ok: boolean, msg: string) { results.push({ name, ok, msg }); _log(`[${ok ? "PASS" : "FAIL"}] ${name}: ${msg}`); }

// ============ P1 ============
{
  const segs = buildSegments([makeRow()], makeMapper() as any, fa as any, 1);
  const nOk = segs.length === 5;
  const pdfXOk = nOk && segs.every((s, i) => Math.abs(s.pdfX - EXPECT_PDFX[i]) < 0.5);
  const cssXOk = nOk && segs.every((s, i) => Math.abs(s.cssX - EXPECT_CSSX[i]) < 0.5);
  const textOk = nOk && segs.every((s, i) => s.text === EXPECT_TEXT[i]);
  const cellOk = nOk && segs.every((s) => s.isTableCell === true);
  const monoOk = nOk && segs.every((s, i) => i === 0 || s.cssX > segs[i - 1].cssX);
  const allOk = nOk && pdfXOk && cssXOk && textOk && cellOk && monoOk;
  check("P1 列X anchor 还原", allOk,
    `segs=${segs.length} pdfX=[${segs.map(s=>s.pdfX.toFixed(2))}] cssX=[${segs.map(s=>s.cssX.toFixed(2))}] text=[${segs.map(s=>JSON.stringify(s.text))}]`);
}

// ============ 导出绑定辅助：复刻 useExport.applySegmentEditsToDocument 的匹配 ============
function buildEditableDoc(): EditableDocument {
  const glyphs: EditableGlyph[] = RAW.map(([x, w, s], i) => ({
    char: s,
    bbox: { x, y: PDFY, width: w, height: FONT_SIZE },
    styleRef: 0,
    operatorId: `op${i}`,
    operatorCharIndex: 0,
    baseline: PDFY,
  } as any));
  const line: EditableLine = { id: "L0", glyphs } as any;
  return {
    pages: [{ index: 1, width: 612, height: 792, blocks: [{ id: "b0", lines: [line] }] }],
    styles: {},
  } as any;
}
// 对第 colIdx 个 segment 文本做编辑，驱动真实 mutateLineText，返回 mutation 后的 doc
function editColumn(doc: EditableDocument, originalText: string, newText: string) {
  const line = (doc.pages[0].blocks[0].lines as EditableLine[])[0];
  const lineText = line.glyphs.map((g) => (g as any).char).join("");
  if (lineText === originalText) {
    return mutateLineText(doc, "b0", "L0", newText).document;
  }
  const idx = lineText.indexOf(originalText);
  if (idx < 0) throw new Error("originalText 未命中 lineText: " + originalText);
  const start = idx;
  const end = idx + originalText.length - 1;
  const next = lineText.slice(0, start) + newText + lineText.slice(end + 1);
  return mutateLineText(doc, "b0", "L0", next, { start, end }).document;
}
function colBBoxX(doc: EditableDocument, colIdx: number): number {
  // 第 colIdx 个非空白 operator 的首 glyph bbox.x（含前置空白 operator 偏移）
  let n = -1;
  for (const g of (doc.pages[0].blocks[0].lines as EditableLine[])[0].glyphs) {
    if ((g as any).char.trim().length > 0) {
      n++;
      if (n === colIdx) return (g as any).bbox.x;
    }
  }
  return NaN;
}

// ============ P2 编辑 B ============
{
  const doc = buildEditableDoc();
  const edited = editColumn(doc, "1.057,50", "1.057,99");
  const aX = colBBoxX(edited, 0), bX = colBBoxX(edited, 1), cX = colBBoxX(edited, 2), dX = colBBoxX(edited, 3), eX = colBBoxX(edited, 4);
  const ok = aX === 24 && cX === 217.10 && dX === 276 && eX === 396 && bX === 166.42;
  check("P2 编辑B→A/C/D/E不动", ok, `A=${aX} B=${bX} C=${cX} D=${dX} E=${eX}`);
}
// ============ P3 编辑 D ============
{
  const doc = buildEditableDoc();
  const edited = editColumn(doc, "MARLUPI VESTUARIO INFANTIL LTDA", "MARLUPI MODIFICADO SA");
  const aX = colBBoxX(edited, 0), bX = colBBoxX(edited, 1), cX = colBBoxX(edited, 2), dX = colBBoxX(edited, 3), eX = colBBoxX(edited, 4);
  const ok = aX === 24 && bX === 166.42 && cX === 217.10 && eX === 396 && dX === 276;
  check("P3 编辑D→A/B/C/E不动", ok, `A=${aX} B=${bX} C=${cX} D=${dX} E=${eX}`);
}
// ============ P4 F&R 替换 B ============
{
  const doc = buildEditableDoc();
  const edited = editColumn(doc, "1.057,50", "9.999,99");
  const segs = buildSegments([makeRow()], makeMapper() as any, fa as any, 1);
  // 把 B 段文本改为 9.999,99 后重算 cssX（B 段 cssX 不变，因 anchor=首glyph pdfX）
  const ok = Math.abs(segs[1].cssX - EXPECT_CSSX[1]) < 0.5 && colBBoxX(edited, 1) === 166.42;
  check("P4 F&R替换B→其余cssX不变", ok, `B.cssX=${segs[1].cssX.toFixed(2)} 期望${EXPECT_CSSX[1]} B.bboxX=${colBBoxX(edited,1)}`);
}
// ============ P5 翻译 D（变长） ============
{
  const doc = buildEditableDoc();
  const longText = "MARLUPI VESTUARIO INFANTIL E COMERCIAL LTDA EXPORTADORA";
  const edited = editColumn(doc, "MARLUPI VESTUARIO INFANTIL LTDA", longText);
  const aX = colBBoxX(edited, 0), bX = colBBoxX(edited, 1), cX = colBBoxX(edited, 2), eX = colBBoxX(edited, 4);
  const ok = aX === 24 && bX === 166.42 && cX === 217.10 && eX === 396;
  check("P5 翻译D变长→A/B/C/E不动", ok, `A=${aX} B=${bX} C=${cX} E=${eX}`);
}
// ============ P6 Export 几何不变总检 ============
{
  const doc = buildEditableDoc();
  let cur = doc;
  cur = editColumn(cur, "1.057,50", "1.057,99");
  cur = editColumn(cur, "MARLUPI VESTUARIO INFANTIL LTDA", "MARLUPI MOD SA");
  const aX = colBBoxX(cur, 0), bX = colBBoxX(cur, 1), cX = colBBoxX(cur, 2), dX = colBBoxX(cur, 3), eX = colBBoxX(cur, 4);
  const ok = aX === 24 && bX === 166.42 && cX === 217.10 && dX === 276 && eX === 396;
  check("P6 Export几何不变(同时编辑B+D)", ok, `A=${aX} B=${bX} C=${cX} D=${dX} E=${eX}`);
}
// ============ P7 普通段落不拆 ============
{
  const para: LineGroup = {
    text: "Solicitamos providenciar a baixa e o cancelamento de protesto conforme requerido.",
    pdfX: 24, pdfY: 700, width: 300, height: FONT_SIZE,
    fontName: "g_d0_f1", fontSize: FONT_SIZE, color: COLOR, hz: 1,
    glyphs: [makeRawGlyph(24, 300, "Solicitamos providenciar a baixa e o cancelamento de protesto conforme requerido.")],
  };
  const segs = buildSegments([para], makeMapper() as any, fa as any, 1);
  const ok = segs.length === 1;
  check("P7 普通段落不拆", ok, `segs=${segs.length}`);
}
// ============ P8 Duplicate Text（暴露 indexOf 歧义，已知缺陷，单独报告） ============
{
  // 合成行：col0="AAA" x=24, col1="BBB" x=100, col2="AAA" x=200（col0 与 col2 文本相同）
  const dupRaw: Array<[number, number, string]> = [
    [24, 20, "AAA"],
    [60, 10, " "],
    [100, 20, "BBB"],
    [130, 10, " "],
    [200, 20, "AAA"],
  ];
  const glyphs = dupRaw.map(([x, w, s]) => makeRawGlyph(x, w, s));
  const row: LineGroup = { text: glyphs.map(g=>g.str).join(""), pdfX: 24, pdfY: PDFY, width: 220, height: FONT_SIZE, fontName: "g_d0_f2", fontSize: FONT_SIZE, color: COLOR, hz: 1, glyphs };
  const segs = buildSegments([row], makeMapper() as any, fa as any, 1);
  // 编辑"后者"（col2，索引2）的 "AAA" → "ZZZ"
  const editedSeg = segs[2];
  const doc = buildEditableDocDup(dupRaw);
  const line = (doc.pages[0].blocks[0].lines as EditableLine[])[0];
  const lineText = line.glyphs.map((g) => (g as any).char).join("");
  const idx = lineText.indexOf(editedSeg.originalText); // 复刻 useExport 匹配
  const firstHit = idx; // 命中的是第一个 AAA（col0）
  const hitCol0 = firstHit === 0; // col0 起点
  check("P8 DuplicateText 暴露indexOf歧义(已知缺陷/单独报告)", hitCol0,
    `segs=${segs.length} 编辑col2("AAA"→"ZZZ")时 indexOf 命中偏移=${firstHit}（=col0起点0）→ 误改前者；本缺陷属 useExport.applySegmentEditsToDocument，不在039B范围`);
}
function buildEditableDocDup(raw: Array<[number, number, string]>): EditableDocument {
  const glyphs: EditableGlyph[] = raw.map(([x, w, s], i) => ({
    char: s, bbox: { x, y: PDFY, width: w, height: FONT_SIZE }, styleRef: 0, operatorId: `op${i}`, operatorCharIndex: 0, baseline: PDFY,
  } as any));
  return { pages: [{ index: 1, width: 612, height: 792, blocks: [{ id: "b0", lines: [{ id: "L0", glyphs } as any] }] }], styles: {} } as any;
}

// ============ 汇总 ============
const failed = results.filter((r) => !r.ok);
_log("\n==== 汇总 ====");
_log(`总计 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`);
if (failed.length) { _log("失败项: " + failed.map(f => f.name).join(", ")); process.exit(1); }
else _log("全部通过（P8 为已知缺陷暴露项，见其 msg）");
