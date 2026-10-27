/**
 * editor/binding/canonical-selection.ts — F3B-6.17-3C-10S.1
 *
 * **Canonical Selection Contract**（contract-only，纯函数，不接生产）。
 *
 * ── 解决什么 ─────────────────────────────────────────────────────────
 * 3C-10S 审计结论：系统有两条独立的 selection source，但只有一条汇入 canonical provider。
 *
 *      DOM / TextLayer  ──UTF-16──┐
 *                                 ├──▶ CanonicalSelection ──▶ currentDerivedSelectionRef
 *      GlyphRenderer    ──glyph───┘         （本模块）              ──▶ MapCurrentSelectionProvider
 *                                                                   ──▶ EditTool
 *
 * ── 关键裁决（不做什么）──────────────────────────────────────────────
 *   · **不修改** `DocumentSelection`（glyph-based 契约仍有大量生产/测试依赖）
 *   · **不发明** `UTF-16 → glyph` 逆映射（3C-9B 已证明 glyph→UTF-16 是**单向**边界；
 *     emoji / ligature 下逆映射本身不是一对一天然转换）
 *   · **不把** `FloatingToolbar.SelectionInfo`（UI state）直接当成 semantic selection；
 *     本模块只消费一个**普通输入结构**，由上游 Adapter 负责从 UI state 转换
 *   · 不接 `EditTool` / Capability / EditSession / 任何生产写入
 *
 * ── canonical text coordinate ────────────────────────────────────────
 * Core 的 `Position.offset` 是 **UTF-16**。`CanonicalSelection` 即以
 * `(blockId, lineId) + UTF-16 [start, end)` 表达语义选区 —— 与 Core 同构。
 *
 * ── 第一阶段支持范围（明确的 fallback 边界）───────────────────────────
 *   支持：same segment / same line / single contiguous range
 *   拒绝：multi-range（含 multi-segment / multi-line）、unresolved-segment、
 *         reversed-selection、out-of-bounds、empty-selection
 *   （与 3C-7 已确定的 EditSession「multi-line = SAFE REJECT」一致；
 *     不为了让 Toolbar 选区「全部可用」而偷偷扩展 Core）
 */

import type { EditorDocument } from "../core/document/types";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";

// ─────────────────────────────────────────────────────────────────────
//  S1 · CanonicalSelection
// ─────────────────────────────────────────────────────────────────────

/**
 * Selection Adapter 的 **canonical intermediate contract**。
 *
 * ⚠️ 它**不是** `DocumentSelection` 的替换，也不是新的 UI state；
 *    它是「DOM 路径」与「Glyph 路径」汇合后的**唯一语义表达**。
 */
export interface CanonicalSelection {
  readonly blockId: string;
  readonly lineId: string;
  /** UTF-16 code unit，**半开区间** `[start, end)`（与 Core `Position.offset` 同口径） */
  readonly startOffsetUtf16: number;
  readonly endOffsetUtf16: number;
}

/** 拒绝原因（明确的 fallback 边界，绝不猜） */
export type CanonicalSelectionRejection =
  | "empty-selection"
  | "multi-range"
  | "unresolved-segment"
  | "reversed-selection"
  | "out-of-bounds";

export type CanonicalSelectionResult =
  | { readonly ok: true; readonly selection: CanonicalSelection }
  | { readonly ok: false; readonly reason: CanonicalSelectionRejection };

// ─────────────────────────────────────────────────────────────────────
//  S2 · DOM → CanonicalSelection
// ─────────────────────────────────────────────────────────────────────

/** 单条 DOM 选区 range（来自 `FloatingToolbar.SelectionInfo` 的**普通投影**，非引用它） */
export interface DomSelectionRangeInput {
  readonly segmentId: string;
  /** UTF-16 offset（DOM TextNode walker 累加得到） */
  readonly startOffsetUtf16: number;
  readonly endOffsetUtf16: number;
}

export interface DomSelectionAdapterDeps {
  /** `segmentId` → `(blockId, lineId)`；未解析 ⇒ 拒绝 */
  readonly resolveSegmentIdentity: (segmentId: string) => { blockId: string; lineId: string } | null;
  /** 该 segment 的 UTF-16 文本长度（bounds 校验）；未知 ⇒ 拒绝 */
  readonly segmentTextLengthOf: (segmentId: string) => number | null;
  /**
   * ★ IB-2-B：segment 在 **paragraph 内**的 UTF-16 起点 base（多段行时 > 0）。
   * 缺省 / 返回 null ⇒ 0（单段行向后兼容）。
   *
   * 理由：DOM/TextLayer 的 offset 是 **segment-local**（段内子串）；
   * `CanonicalSelection` 语义是 **paragraph-relative**（整行级 UTF-16）。
   * 中间缺它 → Core 把段内偏移当成段首偏移 → 「编辑 A 段污染 B 段」（段落级错位）。
   * 调用方（生产 `segmentsRef` 累加同 lineId 段文本长度 / 测试直接给 base）负责提供，
   * 本函数只做「segment-local + base → paragraph-relative」的唯一加法。
   */
  readonly segmentStartOffsetUtf16Of?: (segmentId: string) => number | null;
}

/**
 * DOM/TextLayer selection → `CanonicalSelection`。
 *
 * @param ranges DOM 选区（`ranges.length !== 1` ⇒ 拒绝；第一阶段只支持单一连续区间）
 */
export function domSelectionToCanonical(
  ranges: ReadonlyArray<DomSelectionRangeInput>,
  deps: DomSelectionAdapterDeps
): CanonicalSelectionResult {
  if (ranges.length === 0) return { ok: false, reason: "empty-selection" };
  // multi-segment / multi-line 在第一阶段统一按 multi-range 拒绝（SAFE REJECT）
  if (ranges.length > 1) return { ok: false, reason: "multi-range" };

  const r = ranges[0];
  const identity = deps.resolveSegmentIdentity(r.segmentId);
  if (!identity) return { ok: false, reason: "unresolved-segment" };

  if (r.startOffsetUtf16 > r.endOffsetUtf16) return { ok: false, reason: "reversed-selection" };
  if (r.startOffsetUtf16 === r.endOffsetUtf16) return { ok: false, reason: "empty-selection" };

  const len = deps.segmentTextLengthOf(r.segmentId);
  if (len === null || r.startOffsetUtf16 < 0 || r.endOffsetUtf16 > len) {
    return { ok: false, reason: "out-of-bounds" };
  }

  // ★ IB-2-B：segment-local → paragraph-relative（唯一换算点：调用方提供 base）
  const base = deps.segmentStartOffsetUtf16Of?.(r.segmentId) ?? 0;

  return {
    ok: true,
    selection: {
      blockId: identity.blockId,
      lineId: identity.lineId,
      startOffsetUtf16: r.startOffsetUtf16 + base,
      endOffsetUtf16: r.endOffsetUtf16 + base,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  S3 · Glyph → CanonicalSelection
// ─────────────────────────────────────────────────────────────────────

export interface GlyphSelectionInput {
  readonly blockId: string;
  readonly lineId: string;
  /** inclusive glyph 下标 */
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
}

/**
 * Glyph selection → `CanonicalSelection`。
 *
 * 复用**唯一**换算点 `glyphRangeToUtf16Range`（F3B-6.5-C，累加 `char.length`）；
 * **禁止** `text.length === glyphCount` 假设，**禁止** glyph index 直接当 UTF-16 offset。
 */
export function glyphSelectionToCanonical(
  input: GlyphSelectionInput,
  glyphs: ReadonlyArray<{ char?: string; originalChar?: string }>
): CanonicalSelectionResult {
  if (glyphs.length === 0) return { ok: false, reason: "empty-selection" };

  const { start, end } = glyphRangeToUtf16Range(
    glyphs as unknown as Parameters<typeof glyphRangeToUtf16Range>[0],
    input.startGlyphIndex,
    input.endGlyphIndex
  );
  if (end <= start) return { ok: false, reason: "empty-selection" };

  return {
    ok: true,
    selection: {
      blockId: input.blockId,
      lineId: input.lineId,
      startOffsetUtf16: start,
      endOffsetUtf16: end,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  S4 · CanonicalSelection → Core command target
// ─────────────────────────────────────────────────────────────────────

/** Core 命令目标（`TextBox → Paragraph → TextRun` + **run 内** UTF-16 区间） */
export interface CoreTextTarget {
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly runId: string;
  /** run 内 UTF-16 offset */
  readonly startOffsetUtf16: number;
  readonly endOffsetUtf16: number;
}

/** S4 拒绝原因（与 S2 的边界区分：这里失败在 **Core hierarchy** 层） */
export type CoreTargetRejection = "core-target-unresolved" | "multi-run" | "out-of-bounds";

export type CoreTargetResult =
  | { readonly ok: true; readonly target: CoreTextTarget }
  | { readonly ok: false; readonly reason: CoreTargetRejection };

/**
 * `CanonicalSelection` → Core 命令目标。
 *
 * **核心侧对 Core hierarchy 的知识全部收敛在此**（`paragraphId` / run offsets），
 * Toolbar 不需要知道 `EditorDocument` 结构。
 *
 * 定位方式：找 `run.source.(blockId, lineId)` 与选择匹配的 run。
 * 第一阶段**只支持单一 run**（跨 run ⇒ `multi-run` 拒绝，绝不截断/合并）。
 * run 内 offset = 行内 offset − 该 run 之前同段落 run 的文本长度之和。
 */
export function canonicalToCoreTarget(
  selection: CanonicalSelection,
  document: EditorDocument
): CoreTargetResult {
  for (const page of document.pages ?? []) {
    for (const textBox of page.objects ?? []) {
      if (textBox.type !== "text") continue; // F3B-6.24-B3：图片对象无段落
      for (const paragraph of textBox.paragraphs ?? []) {
        const runs = paragraph.runs ?? [];
        // 该段落内匹配 (blockId, lineId) 的 run（保持文档顺序）
        const matched: Array<{ index: number; run: (typeof runs)[number] }> = [];
        for (let i = 0; i < runs.length; i++) {
          const src = runs[i].source;
          if (src?.blockId === selection.blockId && src?.lineId === selection.lineId) {
            matched.push({ index: i, run: runs[i] });
          }
        }
        if (matched.length === 0) continue;
        if (matched.length > 1) return { ok: false, reason: "multi-run" };

        const { index, run } = matched[0];
        if (!run.id) return { ok: false, reason: "core-target-unresolved" };

        // 行内 offset 的基准 = 该 run 之前同段落 run 的文本长度之和
        let base = 0;
        for (let i = 0; i < index; i++) base += (runs[i].text ?? "").length;

        const runLen = (run.text ?? "").length;
        const startLocal = selection.startOffsetUtf16 - base;
        const endLocal = selection.endOffsetUtf16 - base;
        if (startLocal < 0 || endLocal > runLen || startLocal > endLocal) {
          return { ok: false, reason: "out-of-bounds" };
        }

        return {
          ok: true,
          target: {
            textBoxId: textBox.id,
            paragraphId: paragraph.id,
            runId: run.id,
            startOffsetUtf16: startLocal,
            endOffsetUtf16: endLocal,
          },
        };
      }
    }
  }
  return { ok: false, reason: "core-target-unresolved" };
}

// ─────────────────────────────────────────────────────────────────────
//  便捷：两条路径的等价性证明辅助
// ─────────────────────────────────────────────────────────────────────

/** 两个 `CanonicalSelection` 是否语义相同（字段级相等） */
export function canonicalSelectionsEqual(a: CanonicalSelection, b: CanonicalSelection): boolean {
  return (
    a.blockId === b.blockId &&
    a.lineId === b.lineId &&
    a.startOffsetUtf16 === b.startOffsetUtf16 &&
    a.endOffsetUtf16 === b.endOffsetUtf16
  );
}
