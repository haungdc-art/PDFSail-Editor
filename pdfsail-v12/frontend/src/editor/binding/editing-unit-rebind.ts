/**
 * editing-unit-rebind.ts — F3B-6.27 · P0-E1 · paragraphId-based rebind（纯/半纯）
 *
 * 用户裁决（硬约束）：
 *   ① paragraphId = structural identity（编辑后唯一稳定的 rebind 锚点）
 *   ② lineId = visual/provenance identity（可选，不可作生命周期主键）
 *      实测：整段删除后 run = {text:""} 且完全无 source ⇒ lineId 全丢；
 *            部分编辑时 lineId 部分保留（未触及 run 以原引用推入）。
 *   ③ 不 merge/split Core paragraph（paragraph 数量不变 ⇒ 结构变化即 fail-closed）
 *   ④ 不接 DOM / 不改 transaction contract（本模块是 UnitTransactionCommand 的消费者）
 *
 * 本模块不做的（留给 P0-E2）：reflow 闭环、决定 unit 最终几行、soft-wrap 处理
 *   （soft-wrap 只如实暴露 softWrappedParagraphs）、DOM/export。
 */

import { getParagraphText } from "../core/document/query";
import { createFontMetricsProvider, layoutTextBox } from "../core/layout";
import type { FontMetricsProvider } from "../core/layout";
import type { EditorDocument, Paragraph, TextBoxObject } from "../core/document/types";
import { buildEditingUnit, syntheticLineIdOf, type EditingUnit } from "./editing-unit";

export interface RebindRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RebindInput {
  readonly documentBefore: EditorDocument;
  readonly documentAfter: EditorDocument;
  readonly unitBefore: EditingUnit;
  /** 显式段间分隔（缺省 "\n"）。换行不是 Core text，只能显式声明。 */
  readonly separator?: string;
  /** Core layout 度量；缺省 = createFontMetricsProvider({})（与生产 Core 渲染同款兜底） */
  readonly metrics?: FontMetricsProvider;
  readonly intent?: { readonly separatorConsumed: boolean; readonly intendedText: string };
  readonly generation?: number;
  readonly currentGeneration?: number;
}

export type RebindLineIdProvenance = "retained" | "synthetic";

export interface RebindLineProvenance {
  readonly paragraphId: string;
  readonly textBoxId: string;
  readonly lineId: string;
  readonly lineIdProvenance: RebindLineIdProvenance;
  readonly textBefore: string;
  readonly textAfter: string;
  readonly changed: boolean;
  readonly visualLineCount: number;
}

export interface RebindGeometryLine {
  readonly paragraphId: string;
  readonly box: RebindRect;
  readonly baseline: number;
  readonly contentWidth: number;
  readonly visualLines: number;
}

export interface RebindResult {
  readonly unit: EditingUnit;
  readonly provenance: readonly RebindLineProvenance[];
  readonly geometry: {
    readonly box: RebindRect;
    readonly lines: readonly RebindGeometryLine[];
    readonly firstLineIndent: number;
    readonly requiredWidth: number;
  };
  readonly softWrappedParagraphs: readonly string[];
  readonly changed: boolean;
  readonly metricsSource: "caller" | "core-fallback";
  readonly intentSeparatorConsumed: boolean;
  /** 编辑意图 vs Core 实际文本（不修复，只转录差异） */
  readonly intentVsCore: {
    readonly intendedText: string;
    readonly coreUnitText: string;
    readonly identical: boolean;
  } | null;
}

export type RebindFailure =
  | "stale-generation"
  | "no-unit-before"
  | "empty-unit"
  | "missing-paragraph-after"
  | "textbox-changed-after"
  | "paragraph-count-changed"
  | "duplicate-paragraph-after"
  | "layout-unavailable";

export type RebindOutcome =
  | { readonly ok: true; readonly rebind: RebindResult }
  | { readonly ok: false; readonly reason: RebindFailure };

const SEPARATOR = "\n";

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

/** 该 paragraph 是否仍携带任一 lineId（部分编辑 ⇒ 保留；整段删除 ⇒ 丢失） */
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

function unionRect(boxes: readonly RebindRect[]): RebindRect {
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
  return { x: round2(x0), y: round2(y0), width: round2(x1 - x0), height: round2(y1 - y0) };
}

/**
 * P0-E1 主体：Core mutation 之后，按 paragraphId 重新绑定并重建 EditingUnit。
 * ★ 只读 documentAfter：不构造 Command、不触碰 History。
 */
export function rebindEditingUnit(input: RebindInput): RebindOutcome {
  if (
    input.generation !== undefined &&
    input.currentGeneration !== undefined &&
    input.generation !== input.currentGeneration
  ) {
    return { ok: false, reason: "stale-generation" };
  }
  const before = input.unitBefore;
  if (!before) return { ok: false, reason: "no-unit-before" };
  if (before.lines.length === 0) return { ok: false, reason: "empty-unit" };

  const after = input.documentAfter;

  // 守卫 1：paragraph 数量不得变化（不做 merge/split）
  if (countTextParagraphs(after) !== countTextParagraphs(input.documentBefore)) {
    return { ok: false, reason: "paragraph-count-changed" };
  }

  const metrics = input.metrics ?? createFontMetricsProvider({});
  const metricsSource: "caller" | "core-fallback" = input.metrics ? "caller" : "core-fallback";

  const provenance: RebindLineProvenance[] = [];
  const lineInputs: Array<{ lineId: string; textBoxId: string; paragraphId: string; text: string }> = [];
  const geomLines: RebindGeometryLine[] = [];
  const softWrapped: string[] = [];
  const seenParagraphs = new Set<string>();
  let changed = false;

  for (const beforeLine of before.lines) {
    if (seenParagraphs.has(beforeLine.paragraphId)) {
      return { ok: false, reason: "duplicate-paragraph-after" };
    }
    seenParagraphs.add(beforeLine.paragraphId);

    // ★ 唯一身份来源 = paragraphId（不看 lineId）
    const found = findParagraphAfter(after, beforeLine.paragraphId);
    if (!found) return { ok: false, reason: "missing-paragraph-after" };
    if (found.textBox.id !== beforeLine.textBoxId) {
      return { ok: false, reason: "textbox-changed-after" };
    }

    const textAfter = getParagraphText(found.paragraph);
    const retained = lineIdOfParagraph(found.paragraph);
    const lineId = retained ?? syntheticLineIdOf(beforeLine.paragraphId);

    let box: RebindRect;
    let baseline = 0;
    let contentWidth = 0;
    let visualLines = 1;
    try {
      const layout = layoutTextBox(after, found.textBox.id, metrics).layout;
      const para = layout.paragraphs.find((p) => p.paragraphId === beforeLine.paragraphId);
      if (!para || para.lines.length === 0) return { ok: false, reason: "layout-unavailable" };
      const l0 = para.lines[0]!;
      box = { x: l0.box.x, y: l0.box.y, width: l0.box.width, height: l0.box.height };
      baseline = l0.baseline;
      contentWidth = l0.contentWidth;
      visualLines = para.lines.length;
      if (visualLines > 1) softWrapped.push(beforeLine.paragraphId);
    } catch {
      return { ok: false, reason: "layout-unavailable" };
    }

    const lineChanged = textAfter !== beforeLine.text;
    if (lineChanged) changed = true;

    provenance.push({
      paragraphId: beforeLine.paragraphId,
      textBoxId: found.textBox.id,
      lineId,
      lineIdProvenance: retained ? "retained" : "synthetic",
      textBefore: beforeLine.text,
      textAfter,
      changed: lineChanged,
      visualLineCount: visualLines,
    });
    lineInputs.push({ lineId, textBoxId: found.textBox.id, paragraphId: beforeLine.paragraphId, text: textAfter });
    geomLines.push({ paragraphId: beforeLine.paragraphId, box, baseline, contentWidth, visualLines });
  }

  // 重建 EditingUnit（复用 P0-A 唯一构建器）
  const separator = input.separator ?? SEPARATOR;
  const built = buildEditingUnit({
    unitId: before.unitId,
    blockId: before.blockId,
    kind: before.kind,
    lines: lineInputs,
    // ★ separator 显式声明：换行不是 Core text，Core 里根本没有它
    separators: lineInputs.slice(0, -1).map((l) => ({ afterLineId: l.lineId, text: separator })),
  });
  if (!built.ok) return { ok: false, reason: "duplicate-paragraph-after" };
  const unit = (built as { ok: true; unit: EditingUnit }).unit;

  const box = unionRect(geomLines.map((l) => l.box));
  const coreUnitText = unit.text;
  const intendedText = input.intent?.intendedText ?? "";

  return {
    ok: true,
    rebind: {
      unit,
      provenance,
      geometry: {
        box,
        lines: geomLines,
        firstLineIndent: round2(geomLines[0]!.box.x - box.x),
        requiredWidth: round2(Math.max(box.width, ...geomLines.map((l) => l.box.width))),
      },
      softWrappedParagraphs: softWrapped,
      changed,
      metricsSource,
      intentSeparatorConsumed: input.intent?.separatorConsumed ?? false,
      intentVsCore: input.intent
        ? { intendedText, coreUnitText, identical: intendedText === coreUnitText }
        : null,
    },
  };
}
