/**
 * reflowed-paragraph.ts — F3B-6.27 · P0-E2-A · Reflow / Rebind Contract（纯/半纯）
 *
 * 用户裁决：
 *   ① soft-wrap 不 split（1 paragraph → N visual lines，永不 split）
 *   ② 钉死 structural paragraph ≠ visual line（旧 EditingUnit.lines[] 混了三个概念）
 *   ③ visualLineCount 必须是 after 真实 layout 的输入事实，不得从旧 lines[] 推断
 *   ④ 保留 requested mutation 与 Core result 的差异（意图 ≠ Core truth）
 *   ⑤ 四态 ReflowStatus：exact / reflowed / core-divergence / unrebindable
 *
 * 与 P0-A EditingUnit 的关系：不是同一层。
 *   ReflowedEditingUnit = after-state 结构事实（paragraph 树 + visual lines）
 *   EditingUnit（P0-A）  = 用户编辑意图的坐标视图（P0-C surface 仍用它）
 *   通过 paragraphId 对齐；本模块不提供任何 mutation / plan API。
 *
 * 硬边界：0 生产接线 / 0 DOM / 0 Core Command / 0 History（只读）/ 0 merge-split
 */

import { getParagraphText } from "../core/document/query";
import { createFontMetricsProvider, layoutTextBox } from "../core/layout";
import type { FontMetricsProvider, Rect } from "../core/layout";
import type { EditorDocument, Paragraph, TextBoxObject } from "../core/document/types";
import type { EditingUnit } from "./editing-unit";

const SEPARATOR = "\n";

/** 一条 visual line（Core layout 的事实；不是 paragraph，也不是 legacy line） */
export interface ReflowedVisualLine {
  /** 本次 layout 内稳定索引键：`${paragraphId}#L${index}`（layout-derived，编辑后会变） */
  readonly visualLineKey: string;
  /** Core LineLayout.lineId（真实事实；与 visualLineKey 同构，非第二套 id） */
  readonly coreLineId: string;
  /** 在所属 paragraph 内的 UTF-16 区间 [startUtf16, endUtf16) */
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly box: Rect;
  readonly baseline: number;
  readonly contentWidth: number;
  readonly hardBreak: boolean;
  /** 相对 paragraph 左边界的缩进（悬挂缩进；首行为 0） */
  readonly textIndent: number;
}

/** 一个 structural paragraph 及其内部 visual lines（永不 split） */
export interface ReflowedParagraph {
  readonly paragraphId: string;
  readonly textBoxId: string;
  readonly text: string;
  readonly visualLines: readonly ReflowedVisualLine[];
  readonly lineId: string | null;
  readonly lineIdProvenance: "retained" | "absent";
  readonly metricsSource: "caller" | "core-fallback";
}

export type ReflowStatus = "exact" | "reflowed" | "core-divergence" | "unrebindable";

export interface ReflowedEditingUnit {
  readonly status: ReflowStatus;
  readonly reasons: readonly string[];
  readonly unitId: string;
  readonly blockId: string;
  readonly separator: string;
  readonly paragraphs: readonly ReflowedParagraph[];
  readonly text: string;
  readonly lengthUtf16: number;
  readonly paragraphCount: number;
  /** ★ 全部 visual lines 展平后的数量（与 paragraphCount 解耦） */
  readonly visualLineCount: number;
  readonly geometry: {
    readonly box: Rect;
    readonly visualLines: readonly ReflowedVisualLine[];
    readonly firstLineIndent: number;
    readonly requiredWidth: number;
  };
  /** ★ 编辑意图（不是 Core truth；由调用方从 plan 传入） */
  readonly requestedText: string | null;
  /** ★ Core 真实结果 */
  readonly coreText: string;
  readonly divergence: {
    readonly requestedText: string;
    readonly coreText: string;
    readonly identical: boolean;
  } | null;
  readonly metricsSource: "caller" | "core-fallback";
}

export type ReflowFailure =
  | "stale-generation"
  | "no-unit-before"
  | "empty-unit"
  | "paragraph-count-changed"
  | "missing-paragraph-after"
  | "textbox-changed-after"
  | "duplicate-paragraph-after"
  | "layout-unavailable"
  | "non-contiguous-visual-lines";

export type ReflowOutcome =
  | { readonly ok: true; readonly reflow: ReflowedEditingUnit }
  | { readonly ok: false; readonly reason: ReflowFailure; readonly status: "unrebindable" };

export interface ReflowInput {
  readonly documentBefore: EditorDocument;
  readonly documentAfter: EditorDocument;
  /** 只提供 paragraphId 列表 + before 对照；不用于推断新结构（裁决 ③） */
  readonly unitBefore: EditingUnit;
  /** ★ 编辑意图文本（来自 P0-D1 plan.afterText）。不是 Core truth（裁决 ④） */
  readonly requestedText?: string | null;
  readonly separator?: string;
  readonly metrics?: FontMetricsProvider;
  readonly generation?: number;
  readonly currentGeneration?: number;
}

function findParagraphAfter(
  document: EditorDocument,
  paragraphId: string
): { textBox: TextBoxObject; paragraph: Paragraph } | null {
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.type !== "text") continue;
      const textBox = object as TextBoxObject;
      const paragraph = textBox.paragraphs.find((p) => p.id === paragraphId);
      if (paragraph) return { textBox, paragraph };
    }
  }
  return null;
}

function countTextParagraphs(document: EditorDocument): number {
  let n = 0;
  for (const page of document.pages)
    for (const object of page.objects) {
      if (object.type !== "text") continue;
      n += (object as TextBoxObject).paragraphs.length;
    }
  return n;
}

function lineIdOfParagraph(paragraph: Paragraph): string | null {
  for (const run of paragraph.runs) {
    const lineId = run.source?.lineId;
    if (lineId) return lineId;
  }
  return null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function rectOf(r: Rect): Rect {
  return { x: round2(r.x), y: round2(r.y), width: round2(r.width), height: round2(r.height) };
}

function unionRect(boxes: readonly Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.width > x1) x1 = b.x + b.width;
    if (b.y + b.height > y1) y1 = b.y + b.height;
  }
  return rectOf({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
}

/** 给定 paragraph 在某 document 的真实 visual line 总数（before 对照用；-1 = 不可得） */
export function countVisualLinesOf(
  document: EditorDocument,
  paragraphIds: readonly string[],
  metrics: FontMetricsProvider
): number {
  let total = 0;
  for (const pid of paragraphIds) {
    const found = findParagraphAfter(document, pid);
    if (!found) return -1;
    try {
      const para = layoutTextBox(document, found.textBox.id, metrics).layout.paragraphs.find(
        (p) => p.paragraphId === pid
      );
      if (!para) return -1;
      total += para.lines.length;
    } catch {
      return -1;
    }
  }
  return total;
}

/**
 * P0-E2-A 主体：从 after-state 的真实 Core layout 重建结构事实。
 * ★ 只读 before/after document：不构造 Command、不触碰 History。
 */
export function reflowAfterMutation(input: ReflowInput): ReflowOutcome {
  if (
    input.generation !== undefined &&
    input.currentGeneration !== undefined &&
    input.generation !== input.currentGeneration
  ) {
    return { ok: false, reason: "stale-generation", status: "unrebindable" };
  }
  const before = input.unitBefore;
  if (!before) return { ok: false, reason: "no-unit-before", status: "unrebindable" };
  if (before.lines.length === 0) return { ok: false, reason: "empty-unit", status: "unrebindable" };

  const after = input.documentAfter;
  // ★ 不 merge/split：paragraph 数量变化即 unrebindable
  if (countTextParagraphs(after) !== countTextParagraphs(input.documentBefore)) {
    return { ok: false, reason: "paragraph-count-changed", status: "unrebindable" };
  }

  const metrics = input.metrics ?? createFontMetricsProvider({});
  const metricsSource: "caller" | "core-fallback" = input.metrics ? "caller" : "core-fallback";
  const separator = input.separator ?? SEPARATOR;

  const paragraphs: ReflowedParagraph[] = [];
  const allVisualLines: ReflowedVisualLine[] = [];
  const seen = new Set<string>();

  for (const beforeLine of before.lines) {
    if (seen.has(beforeLine.paragraphId)) {
      return { ok: false, reason: "duplicate-paragraph-after", status: "unrebindable" };
    }
    seen.add(beforeLine.paragraphId);
    const found = findParagraphAfter(after, beforeLine.paragraphId);
    if (!found) return { ok: false, reason: "missing-paragraph-after", status: "unrebindable" };
    if (found.textBox.id !== beforeLine.textBoxId) {
      return { ok: false, reason: "textbox-changed-after", status: "unrebindable" };
    }

    // ★ 结构事实完全来自 after 的真实 layout（不推断）
    let raw: Array<{
      lineId: string;
      box: Rect;
      baseline: number;
      textStart: number;
      textEnd: number;
      contentWidth: number;
      hardBreak: boolean;
    }>;
    const text = getParagraphText(found.paragraph);
    try {
      const para = layoutTextBox(after, found.textBox.id, metrics).layout.paragraphs.find(
        (p) => p.paragraphId === beforeLine.paragraphId
      );
      if (!para || para.lines.length === 0) {
        return { ok: false, reason: "layout-unavailable", status: "unrebindable" };
      }
      raw = para.lines.map((l) => ({
        lineId: l.lineId,
        box: l.box,
        baseline: l.baseline,
        textStart: l.textStart,
        textEnd: l.textEnd,
        contentWidth: l.contentWidth,
        hardBreak: l.hardBreak,
      }));
    } catch {
      return { ok: false, reason: "layout-unavailable", status: "unrebindable" };
    }

    // visual lines 必须无缝覆盖整段（否则映射非法）
    let cursor = 0;
    for (const l of raw) {
      if (l.textStart !== cursor || l.textEnd < l.textStart) {
        return { ok: false, reason: "non-contiguous-visual-lines", status: "unrebindable" };
      }
      cursor = l.textEnd;
    }
    if (cursor !== text.length) {
      return { ok: false, reason: "non-contiguous-visual-lines", status: "unrebindable" };
    }

    const paragraphLeft = Math.min(...raw.map((l) => l.box.x));
    const visualLines: ReflowedVisualLine[] = raw.map((l, index) => ({
      visualLineKey: beforeLine.paragraphId + "#L" + index,
      coreLineId: l.lineId,
      startUtf16: l.textStart,
      endUtf16: l.textEnd,
      box: rectOf(l.box),
      baseline: l.baseline,
      contentWidth: l.contentWidth,
      hardBreak: l.hardBreak,
      textIndent: round2(l.box.x - paragraphLeft),
    }));

    const retained = lineIdOfParagraph(found.paragraph);
    paragraphs.push({
      paragraphId: beforeLine.paragraphId,
      textBoxId: found.textBox.id,
      text,
      visualLines,
      lineId: retained,
      lineIdProvenance: retained ? "retained" : "absent",
      metricsSource,
    });
    for (const vl of visualLines) allVisualLines.push(vl);
  }

  const coreText = paragraphs.map((p) => p.text).join(separator);
  const visualLineCount = allVisualLines.length;
  const requestedText = input.requestedText ?? null;

  // ── 状态判定（严格按用户定义）──
  const reasons: string[] = [];
  let status: ReflowStatus;
  if (requestedText !== null && requestedText !== coreText) {
    status = "core-divergence";
    reasons.push("requested-text-differs-from-core-text");
  } else {
    const beforeVisual = countVisualLinesOf(
      input.documentBefore,
      before.lines.map((l) => l.paragraphId),
      metrics
    );
    if (beforeVisual >= 0 && beforeVisual !== visualLineCount) {
      status = "reflowed";
      reasons.push("visual-line-count-changed:" + beforeVisual + "->" + visualLineCount);
    } else {
      status = "exact";
    }
  }

  const box = unionRect(allVisualLines.map((l) => l.box));
  return {
    ok: true,
    reflow: {
      status,
      reasons,
      unitId: before.unitId,
      blockId: before.blockId,
      separator,
      paragraphs,
      text: coreText,
      lengthUtf16: coreText.length,
      paragraphCount: paragraphs.length,
      visualLineCount,
      geometry: {
        box,
        visualLines: allVisualLines,
        firstLineIndent: round2((allVisualLines[0]?.box.x ?? 0) - box.x),
        requiredWidth: round2(Math.max(box.width, ...allVisualLines.map((l) => l.box.width))),
      },
      requestedText,
      coreText,
      divergence:
        requestedText === null ? null : { requestedText, coreText, identical: requestedText === coreText },
      metricsSource,
    },
  };
}
