/**
 * M7.8-040 回归测试（不修改 production code；仅复用真实 buildSegments + applySegmentEditsToDocument）。
 *
 * 覆盖：
 *  T0  Segment.source 在 buildSegments 创建时即由 glyph run 直接产生（startGlyphIndex 精确，不依赖 indexOf）
 *  T1  duplicate text：AAA 123 AAA 456 编辑【第二个】AAA → ZZZ 456（不改第一个 AAA）
 *  T2  同一行两个 Segment 同时修改，含变长/变短：123→"99"(短) + 第二个AAA→"ZZZZ"(长)
 *  T3  Undo → 再编辑：binding 基于源 glyph 区间，重编辑 doc0 仍精确（不依赖被改状态）
 */
import { buildSegments } from "./SegmentBuilder";
import { applySegmentEditsToDocument } from "../editor/features/segmentEditBinding";
import type { CoordinateMapper, FontAnalyzer, RawGlyph, LineGroup, Segment } from "./types";
import type { EditableDocument, EditableGlyph, EditableLine } from "../document-model/types";

// ── mocks（仅满足 buildSegments 的坐标/字体所需字段） ──
const mapper = {
  pdfToCss: (x: number, y: number, w: number, h: number) => ({ x, y, w, h }),
  pdfYToCssY: (y: number) => y,
  scaleFontSize: (pt: number) => pt,
  getPageWidthPt: () => 612,
} as unknown as CoordinateMapper;
const fontAnalyzer = {
  analyze: (fn: string, fs: number) =>
    ({ family: "Arial", rawFontName: fn, size: fs, weight: 400, style: "normal", color: "#000000", lineHeight: 1 } as any),
} as unknown as FontAnalyzer;

// ── 构造一行 LineGroup：AAA 123 AAA 456，列间隙拉大触发多列切分（每个非空白算子一个 Segment） ──
function rawGlyph(str: string, pdfX: number, width: number): RawGlyph {
  return { str, transform: [1, 0, 0, 1, pdfX, 700], fontName: "Arial", fontSize: 12, width, height: 12, pdfX, pdfY: 700 };
}
const lineGlyphs: RawGlyph[] = [
  rawGlyph("AAA", 24, 30),
  rawGlyph(" ", 54, 5),
  rawGlyph("123", 154, 20), // 与 AAA 间隙 100 > fontSize*1.5
  rawGlyph(" ", 174, 5),
  rawGlyph("AAA", 274, 30), // 间隙 100
  rawGlyph(" ", 304, 5),
  rawGlyph("456", 404, 30), // 间隙 100
];
const line: LineGroup = { text: "AAA 123 AAA 456", pdfX: 24, pdfY: 700, width: 410, height: 12, fontName: "Arial", fontSize: 12, glyphs: lineGlyphs };

const BLOCK = "pdf_p1_block0";
const LINE_ID = `pdf_${BLOCK}_l0`;

// ── 构造与 EditableLine.glyphs 等价的 per-char EditableDocument（与 pdf-native-adapter 的 Array.from(op.str) 对齐） ──
const OP_META: Array<[string, string]> = [
  ["AAA", "op0"], [" ", "op1"], ["123", "op2"], [" ", "op3"], ["AAA", "op4"], [" ", "op5"], ["456", "op6"],
];
function charWidth(ch: string, txt: string): number {
  if (ch === " ") return 5;
  if (txt === "123") return 20 / 3;
  if (txt === "456") return 30 / 3;
  return 10;
}
function buildDoc(): EditableDocument {
  let x = 24;
  const glyphs: EditableGlyph[] = [];
  for (const [txt, opId] of OP_META) {
    for (let i = 0; i < txt.length; i++) {
      const ch = txt[i];
      const w = charWidth(ch, txt);
      glyphs.push({
        char: ch, originalChar: ch,
        bbox: { x, y: 700, width: w, height: 12 },
        baseline: 700, styleRef: 0, modified: false,
        transform: [1, 0, 0, 1, x, 700],
        operatorId: opId, operatorCharIndex: i,
        metrics: { advanceWidth: w, pdfTransform: [1, 0, 0, 1, x, 700] } as any,
      } as any);
      x += w;
    }
  }
  const eLine: EditableLine = { id: LINE_ID, glyphs } as any;
  return { pages: [{ index: 1, width: 612, height: 792, blocks: [{ id: BLOCK, lines: [eLine] }] }], styles: [] } as any;
}
const charsOf = (doc: EditableDocument) => (doc.pages[0].blocks[0].lines[0] as EditableLine).glyphs.map((g) => (g as any).char);
const opIdsOf = (doc: EditableDocument) => (doc.pages[0].blocks[0].lines[0] as EditableLine).glyphs.map((g) => (g as any).operatorId);

// ── 用真实 buildSegments 产生 Segment（含 source） ──
const segs: Segment[] = buildSegments([line], mapper, fontAnalyzer, 1);
const segByText = (t: string) => segs.filter((s) => s.text === t);
const aaaSegs = segByText("AAA"); // 两个 AAA：索引 0（第一个）、索引 2（第二个）
const secondAAA = aaaSegs.find((s) => s.source!.startGlyphIndex === 8)!; // 第二个 AAA → [8,10]

const results: Array<{ name: string; ok: boolean; msg: string }> = [];
const check = (name: string, ok: boolean, msg: string) => {
  results.push({ name, ok, msg });
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}: ${msg}`);
};

// T0：source 在构建时由 glyph run 直接产生
{
  const allHaveSource = segs.every((s) => !!s.source);
  const aaaOk = secondAAA.source!.blockId === BLOCK && secondAAA.source!.lineId === LINE_ID &&
    secondAAA.source!.startGlyphIndex === 8 && secondAAA.source!.endGlyphIndex === 10;
  const range123 = segByText("123")[0].source!;
  const range456 = segByText("456")[0].source!;
  const rangesOk = range123.startGlyphIndex === 4 && range123.endGlyphIndex === 6 &&
    range456.startGlyphIndex === 12 && range456.endGlyphIndex === 14;
  check("T0 Segment.source 由 glyph run 直接产生且区间精确", allHaveSource && aaaOk && rangesOk,
    `segs=${segs.length} 第二个AAA source=${JSON.stringify(secondAAA.source)} 123=${JSON.stringify(range123)} 456=${JSON.stringify(range456)}`);
}

// T1：duplicate text 编辑第二个 AAA
{
  const doc = buildDoc();
  const edited = segs.map((s) => (s === secondAAA ? { ...s, text: "ZZZ" } : s));
  const out = applySegmentEditsToDocument(doc, edited);
  const chars = charsOf(out), opIds = opIdsOf(out);
  const ok = chars.join("") === "AAA 123 ZZZ 456" &&
    chars.slice(0, 3).join("") === "AAA" && opIds[0] === "op0" &&
    chars.slice(8, 11).join("") === "ZZZ" && opIds[8] === "op4" &&
    chars.slice(12, 15).join("") === "456" && opIds[12] === "op6";
  check("T1 duplicate: 编辑第二个AAA→ZZZ(不改第一个AAA/456)", ok, `joined="${chars.join("")}"`);
}

// T2：同一行两个 Segment 同时修改（变短 + 变长）
{
  const doc = buildDoc();
  const seg123 = segByText("123")[0];
  const edited = segs.map((s) =>
    s === seg123 ? { ...s, text: "99" } : s === secondAAA ? { ...s, text: "ZZZZ" } : s
  );
  const out = applySegmentEditsToDocument(doc, edited);
  const chars = charsOf(out);
  const ok = chars.join("") === "AAA 99 ZZZZ 456" &&
    chars.slice(0, 3).join("") === "AAA"; // 第一个 AAA 不变
  check("T2 同行长变短多段同时编辑", ok, `joined="${chars.join("")}"`);
}

// T3：Undo → 再编辑（binding 基于源区间，重编辑原 doc 仍精确）
{
  const doc = buildDoc();
  // 第一次编辑：第二个 AAA → ZZZ
  const edited1 = segs.map((s) => (s === secondAAA ? { ...s, text: "ZZZ" } : s));
  const doc1 = applySegmentEditsToDocument(doc, edited1);
  const after1 = charsOf(doc1).join("");
  // “Undo”：doc 是不可变更新，doc0 仍完好；重新用 doc0 再编辑第二个 AAA → QQQ
  const edited2 = segs.map((s) => (s === secondAAA ? { ...s, text: "QQQ" } : s));
  const doc2 = applySegmentEditsToDocument(doc, edited2); // 注意：基于原 doc（undo 后状态）
  const chars = charsOf(doc2), opIds = opIdsOf(doc2);
  const ok = after1 === "AAA 123 ZZZ 456" &&
    chars.join("") === "AAA 123 QQQ 456" &&
    chars.slice(0, 3).join("") === "AAA" && opIds[0] === "op0" &&
    chars.slice(12, 15).join("") === "456" && opIds[12] === "op6";
  check("T3 Undo→再编辑 binding 仍精确", ok, `after1="${after1}" afterReEdit="${chars.join("")}"`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n==== M7.8-040 汇总 ==== 总计 ${results.length}，通过 ${results.length - failed.length}，失败 ${failed.length}`);
process.exit(failed.length ? 1 : 0);
