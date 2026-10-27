/**
 * editor/core/layout/reflow.ts — EDITOR-CORE-006-B
 *
 * 把 EditorDocument 排成唯一 TextLayout，并在**同一次调用**内给出 caret / selection 几何。
 *
 * ── 这就是 006-A 找到的缺失零件（Q5）─────────────────────────────
 * 现状的实时 reflow 零件散落两处：
 *   · `document-model/layout-engine.reconstructBlockLayout` → 能重排，但**不返回 caret 映射**
 *   · `document-model/overflow-resolver` + `line-split`     → **有** caret/selection 迁移，但**无生产调用者**
 * 本文件把两者合成一个同步纯函数：
 *
 *     EditorDocument（编辑后的）
 *           ↓
 *     layoutTextBox(document, textBoxId, metrics, { caret, selection })
 *           ↓
 *     { layout, caretGeometry, selectionGeometry }
 *
 * 规范 §48：typing 必须触发「Command → Document → Layout → Renderer」于同一交互周期，
 * 不得等 blur / Enter / export / commit。本函数是同步的，因此调用方
 * 「commit() 之后立刻 layoutTextBox()」即满足该要求。
 *
 * ── TextBox 是真实布局容器（§16）───────────────────────────────────
 * 折行一律以 `TextBox.width` 为约束；超出 `TextBox.height` 只置 `overflow = true`，
 * **不**撑大容器、不等到 blur 才提交。
 *
 * ── 依赖边界 ────────────────────────────────────────────────────────
 * 只依赖 `../document`、`../position`、`./metrics`、`./breaker`；无 legacy / DOM / PDF。
 */

import { findTextBox } from "../document/query";
import type { EditorDocument, Paragraph, TextStyle, TextBoxObject } from "../document/types";
import { positionToParagraphOffset } from "../position/index";
import type { Caret, EditorSelection, TextPosition, TextRange } from "../position/types";
import { LineBreaker, type BreakResult, type ParagraphStyleResolver } from "./breaker";
import { FontMetricsProvider } from "./metrics";
import {
  DEFAULT_LAYOUT_OPTIONS,
  type CaretGeometry,
  type GlyphLayout,
  type LayoutOptions,
  type LayoutResult,
  type LineLayout,
  type ParagraphLayout,
  type Rect,
  type RunLayout,
  type SelectionGeometry,
  type TextLayout,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  错误
// ─────────────────────────────────────────────────────────────────────

export type LayoutErrorCode = "missing-text-box" | "missing-paragraph" | "invalid-position";

export class LayoutError extends Error {
  readonly code: LayoutErrorCode;
  constructor(code: LayoutErrorCode, message: string) {
    super(`[Layout] ${message}`);
    this.name = "LayoutError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  请求
// ─────────────────────────────────────────────────────────────────────

export interface LayoutTextBoxRequest {
  /** 需要几何的插入点（可选） */
  caret?: Caret;
  /** 需要几何的选区（可选） */
  selection?: EditorSelection;
  options?: LayoutOptions;
}

// ─────────────────────────────────────────────────────────────────────
//  样式解析（段落内多 run 混排）
// ─────────────────────────────────────────────────────────────────────

interface RunSlice {
  runId: string;
  /** 段落文本 UTF-16 区间 */
  start: number;
  end: number;
  style: TextStyle;
}

function sliceParagraphRuns(paragraph: Paragraph): RunSlice[] {
  const out: RunSlice[] = [];
  let cursor = 0;
  for (const run of paragraph.runs) {
    const start = cursor;
    cursor += run.text.length;
    out.push({ runId: run.id, start, end: cursor, style: run.style });
  }
  return out;
}

function createStyleResolver(slices: RunSlice[]): ParagraphStyleResolver {
  let hint = 0;
  return (textIndex: number): TextStyle => {
    if (slices.length === 0) {
      throw new LayoutError("missing-paragraph", "段落没有 run，无法解析样式");
    }
    // 断行/度量调用是单调递增的，用 hint 做近似 O(1)
    if (hint < slices.length) {
      const s = slices[hint];
      if (textIndex >= s.start && textIndex < s.end) return s.style;
    }
    for (let i = 0; i < slices.length; i++) {
      const s = slices[i];
      if (textIndex >= s.start && textIndex < s.end) {
        hint = i;
        return s.style;
      }
    }
    hint = slices.length - 1;
    return slices[slices.length - 1].style;
  };
}

function paragraphTextLength(paragraph: Paragraph): number {
  let n = 0;
  for (const run of paragraph.runs) n += run.text.length;
  return n;
}

// ─────────────────────────────────────────────────────────────────────
//  对齐
// ─────────────────────────────────────────────────────────────────────

function alignedLineX(
  constraintX: number,
  constraintWidth: number,
  contentWidth: number,
  alignment: ParagraphLayout["alignment"]
): number {
  const slack = Math.max(0, constraintWidth - contentWidth);
  switch (alignment) {
    case "center":
      return constraintX + slack / 2;
    case "right":
      return constraintX + slack;
    default:
      // justify 暂按 left 处理（006-A：justify 需要重新分配空格推进量，未在本阶段建模）
      return constraintX;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  主入口
// ─────────────────────────────────────────────────────────────────────

/**
 * 把单个 TextBox 排成 TextLayout，并（可选）给出 caret / selection 几何。
 */
export function layoutTextBox(
  document: EditorDocument,
  textBoxId: string,
  metrics: FontMetricsProvider,
  request: LayoutTextBoxRequest = {}
): LayoutResult {
  const textBox = findTextBox(document, textBoxId);
  if (!textBox) {
    throw new LayoutError("missing-text-box", `TextBox "${textBoxId}" 不存在`);
  }

  const options: Required<LayoutOptions> = { ...DEFAULT_LAYOUT_OPTIONS, ...request.options };
  const breaker = new LineBreaker(metrics, {
    kinsoku: options.kinsoku,
    breakLongTokens: options.breakLongTokens,
    maxWarnings: options.maxWarnings,
  });

  const warnings: string[] = [];
  const paragraphs: ParagraphLayout[] = [];
  let cursorY = textBox.y;
  let lineCount = 0;

  for (const paragraph of textBox.paragraphs) {
    const slices = sliceParagraphRuns(paragraph);
    const styleAt = createStyleResolver(slices);
    const text = paragraph.runs.map((r) => r.text).join("");
    const textLength = text.length;

    const broken = breaker.break(text, styleAt, textBox.width);
    warnings.push(...broken.warnings);

    const { lines, paragraphHeight } = buildLines({
      paragraph,
      slices,
      broken,
      metrics,
      textBox,
      options,
      startY: cursorY,
      alignment: paragraph.alignment,
      styleAt,
    });
    lineCount += lines.length;

    paragraphs.push({
      paragraphId: paragraph.id,
      textBoxId: textBox.id,
      box: {
        x: textBox.x,
        y: cursorY,
        width: textBox.width,
        height: paragraphHeight,
      },
      alignment: paragraph.alignment,
      textLength,
      height: paragraphHeight,
      lines,
    });

    cursorY += paragraphHeight;
  }

  if (paragraphs.some((p) => p.alignment === "justify")) {
    warnings.push("justify 对齐暂按 left 处理（需按空格重新分配推进量，未在本阶段建模）");
  }

  const totalHeight = cursorY - textBox.y;
  const layout: TextLayout = {
    textBoxId: textBox.id,
    documentVersion: document.version,
    constraintBox: {
      x: textBox.x,
      y: textBox.y,
      width: textBox.width,
      height: textBox.height,
    },
    paragraphs,
    height: totalHeight,
    overflow: totalHeight > textBox.height,
    lineCount,
  };

  let caretGeometry: CaretGeometry | null = null;
  if (request.caret) {
    caretGeometry = caretGeometryAt(document, layout, request.caret);
    if (!caretGeometry) warnings.push("caret 无法在布局中定位（position 与布局不一致）");
  }
  let selectionGeometry: SelectionGeometry | null = null;
  if (request.selection) {
    selectionGeometry = selectionGeometryFor(document, layout, request.selection.range);
    if (!selectionGeometry) warnings.push("selection 无法在布局中定位（range 与布局不一致）");
  }

  return {
    layout,
    caretGeometry,
    selectionGeometry,
    warnings: dedupe(warnings).slice(0, options.maxWarnings),
  };
}

/** 对整个文档的所有 TextBox 布局（供 Renderer 全量渲染 / 诊断） */
export function layoutDocument(
  document: EditorDocument,
  metrics: FontMetricsProvider,
  options?: LayoutOptions
): TextLayout[] {
  const out: TextLayout[] = [];
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      out.push(layoutTextBox(document, textBox.id, metrics, { options }).layout);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
//  行构建
// ─────────────────────────────────────────────────────────────────────

interface BuildLinesInput {
  paragraph: Paragraph;
  slices: RunSlice[];
  broken: BreakResult;
  metrics: FontMetricsProvider;
  textBox: TextBoxObject;
  options: Required<LayoutOptions>;
  startY: number;
  alignment: ParagraphLayout["alignment"];
  styleAt: ParagraphStyleResolver;
}

function buildLines(input: BuildLinesInput): { lines: LineLayout[]; paragraphHeight: number } {
  const { paragraph, slices, broken, metrics, textBox, options, startY, alignment, styleAt } = input;
  const lines: LineLayout[] = [];
  let cursorY = startY;

  broken.lines.forEach((bl, lineIndex) => {
    // 该行涉及的 run
    const contributing = slices.filter((s) => s.start < bl.textEnd && s.end > bl.textStart);

    // 行高 / ascent 取该行所有 run 的最大值（混排不同字号时正确）
    let lineHeight = 0;
    let ascent = 0;
    for (const s of contributing) {
      const scale = metrics.resolveScale(s.style, options.fallbackLineHeightRatio);
      lineHeight = Math.max(lineHeight, scale.lineHeight);
      ascent = Math.max(ascent, metrics.ascent(scale.fontSize));
    }
    if (lineHeight <= 0) {
      // 空行：用前一行的度量，或段落首个 run 的样式兜底
      const fallback = contributing[0]?.style ?? slices[0]?.style;
      const scale = metrics.resolveScale(fallback, options.fallbackLineHeightRatio);
      lineHeight = scale.lineHeight;
      ascent = metrics.ascent(scale.fontSize);
    }

    const lineTop = cursorY;
    const baseline = lineTop + ascent;
    const lineX = alignedLineX(textBox.x, textBox.width, bl.width, alignment);

    // 构建 run / glyph
    const runs: RunLayout[] = [];
    let x = lineX;
    for (const slice of contributing) {
      const from = Math.max(bl.textStart, slice.start);
      const to = Math.min(bl.textEnd, slice.end);
      if (to <= from) continue;

      const runOriginX = x;
      const glyphs: GlyphLayout[] = [];
      const style = styleAt(from);
      const letterSpacing = style.letterSpacing ?? 0;

      // 逐 code point 推进（代理对整体推进，绝不切开）
      let charIndex = from;
      while (charIndex < to) {
        const code = paragraphCharAt(paragraph, charIndex);
        if (code === undefined) break;
        const m = metrics.measure({ char: code.char, textIndex: charIndex, style });
        const advance = m.advance + letterSpacing;
        glyphs.push({
          textIndex: charIndex,
          length: code.char.length,
          advance,
          box: { x, y: lineTop, width: advance, height: lineHeight },
          baseline,
          advanceSource: m.advanceSource,
        });
        x += advance;
        charIndex += code.char.length;
      }

      runs.push({
        runId: slice.runId,
        textStart: from,
        textEnd: to,
        origin: { x: runOriginX, y: lineTop },
        box: { x: runOriginX, y: lineTop, width: x - runOriginX, height: lineHeight },
        baseline,
        glyphs,
      });
    }

    lines.push({
      lineId: `${paragraph.id}#L${lineIndex}`,
      box: { x: lineX, y: lineTop, width: x - lineX, height: lineHeight },
      baseline,
      textStart: bl.textStart,
      textEnd: bl.textEnd,
      hardBreak: bl.hardBreak,
      runs,
      contentWidth: bl.width,
    });

    cursorY += lineHeight;
  });

  return { lines, paragraphHeight: cursorY - startY };
}

/** 按 UTF-16 索引取段落中的一个 code point（含其长度） */
function paragraphCharAt(
  paragraph: Paragraph,
  textIndex: number
): { char: string; runId: string } | undefined {
  let cursor = 0;
  for (const run of paragraph.runs) {
    const next = cursor + run.text.length;
    if (textIndex >= cursor && textIndex < next) {
      const local = textIndex - cursor;
      const char = run.text.slice(local, local + 1);
      // 若命中代理对的高位，向前补一位（保证整体推进）
      const code = run.text.codePointAt(local);
      if (code !== undefined && code > 0xffff) {
        return { char: run.text.slice(local, local + 2), runId: run.id };
      }
      return { char, runId: run.id };
    }
    cursor = next;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
//  Caret / Selection 几何
// ─────────────────────────────────────────────────────────────────────

function findParagraphLayout(
  layout: TextLayout,
  paragraphId: string
): ParagraphLayout | undefined {
  return layout.paragraphs.find((p) => p.paragraphId === paragraphId);
}

/** 某段落偏移处的插入线 x（不跨行处理，调用方需先定位行） */
function xInLine(line: LineLayout, offset: number): number {
  if (line.runs.length === 0) return line.box.x;
  for (const run of line.runs) {
    for (const g of run.glyphs) {
      if (g.textIndex === offset) return g.box.x;
    }
  }
  // 落在最后一个 glyph 之后（行尾）
  const lastRun = line.runs[line.runs.length - 1];
  const lastGlyph = lastRun.glyphs[lastRun.glyphs.length - 1];
  if (lastGlyph) return lastGlyph.box.x + lastGlyph.advance;
  return line.box.x;
}

/** 找到覆盖该偏移的行；返回 {line, index} */
function findLineAtOffset(
  paragraph: ParagraphLayout,
  offset: number
): { line: LineLayout; index: number } | undefined {
  for (let i = 0; i < paragraph.lines.length; i++) {
    const line = paragraph.lines[i];
    if (offset >= line.textStart && offset <= line.textEnd) {
      // 软换行边界：offset === textEnd 同时属于本行尾与下一行首
      // → affinity 由调用方处理；这里返回**第一个**命中的行
      return { line, index: i };
    }
  }
  const last = paragraph.lines[paragraph.lines.length - 1];
  return last ? { line: last, index: paragraph.lines.length - 1 } : undefined;
}

/**
 * TextPosition → caret 几何。
 *
 * Caret affinity（规范 §14）在这里真正起作用：
 * 在**软换行边界**（offset === line.textEnd 且 !hardBreak）上，
 *   affinity = "forward"  → 取下一行行首
 *   affinity = "backward" → 取本行行尾
 * 硬换行边界与段落边界只有一种几何。
 */
export function caretGeometryAt(
  document: EditorDocument,
  layout: TextLayout,
  caret: Caret
): CaretGeometry | null {
  const paragraph = findParagraphLayout(layout, caret.position.paragraphId);
  if (!paragraph) return null;

  let offset: number;
  try {
    offset = positionToParagraphOffset(document, caret.position);
  } catch {
    return null;
  }

  const found = findLineAtOffset(paragraph, offset);
  if (!found) return null;

  let { line, index } = found;
  const isSoftBoundary =
    offset === line.textEnd && !line.hardBreak && index < paragraph.lines.length - 1;
  if (isSoftBoundary && caret.affinity === "forward") {
    line = paragraph.lines[index + 1];
    index += 1;
  }

  return {
    position: caret.position,
    affinity: caret.affinity,
    x: xInLine(line, offset),
    y: line.box.y,
    height: line.box.height,
  };
}

/** 段落内 [s, e) 的选区矩形（每行一个） */
function quadsWithinParagraph(paragraph: ParagraphLayout, s: number, e: number): Rect[] {
  if (e <= s) return [];
  const quads: Rect[] = [];
  for (const line of paragraph.lines) {
    const ls = Math.max(line.textStart, s);
    const le = Math.min(line.textEnd, e);
    if (le <= ls) continue;
    const x1 = xInLine(line, ls);
    const x2 = xInLine(line, le);
    quads.push({
      x: Math.min(x1, x2),
      y: line.box.y,
      width: Math.abs(x2 - x1),
      height: line.box.height,
    });
  }
  return quads;
}

/**
 * TextRange → 选区几何（每视觉行一个 quad）。
 * 支持跨行 / 跨段落；段落之间不相连（段落边界是结构边界）。
 */
export function selectionGeometryFor(
  document: EditorDocument,
  layout: TextLayout,
  range: TextRange
): SelectionGeometry | null {
  const order =
    range.anchor.paragraphId === range.focus.paragraphId
      ? compareSameParagraph(document, range)
      : compareByLayoutOrder(layout, range);
  if (order === null) return null;

  const from = order <= 0 ? range.anchor : range.focus;
  const to = order <= 0 ? range.focus : range.anchor;

  let startOffset: number;
  let endOffset: number;
  try {
    startOffset = positionToParagraphOffset(document, from);
    endOffset = positionToParagraphOffset(document, to);
  } catch {
    return null;
  }

  const quads: Rect[] = [];
  if (from.paragraphId === to.paragraphId) {
    const p = findParagraphLayout(layout, from.paragraphId);
    if (!p) return null;
    quads.push(...quadsWithinParagraph(p, startOffset, endOffset));
  } else {
    const startPara = findParagraphLayout(layout, from.paragraphId);
    const endPara = findParagraphLayout(layout, to.paragraphId);
    if (!startPara || !endPara) return null;
    quads.push(...quadsWithinParagraph(startPara, startOffset, startPara.textLength));
    const startIdx = layout.paragraphs.indexOf(startPara);
    const endIdx = layout.paragraphs.indexOf(endPara);
    for (let i = startIdx + 1; i < endIdx; i++) {
      const p = layout.paragraphs[i];
      quads.push(...quadsWithinParagraph(p, 0, p.textLength));
    }
    quads.push(...quadsWithinParagraph(endPara, 0, endOffset));
  }

  return { range, quads };
}

function compareSameParagraph(document: EditorDocument, range: TextRange): number {
  const a = positionToParagraphOffset(document, range.anchor);
  const b = positionToParagraphOffset(document, range.focus);
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareByLayoutOrder(layout: TextLayout, range: TextRange): number | null {
  const ai = layout.paragraphs.findIndex((p) => p.paragraphId === range.anchor.paragraphId);
  const bi = layout.paragraphs.findIndex((p) => p.paragraphId === range.focus.paragraphId);
  if (ai < 0 || bi < 0) return null;
  if (ai === bi) return 0;
  return ai < bi ? -1 : 1;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
