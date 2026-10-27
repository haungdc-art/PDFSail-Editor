/**
 * editor/binding/segment-paragraph-range.ts — IB-2-A
 *
 * **Segment → Paragraph Binding Range 原语**（纯函数，contract-only，不接生产）。
 *
 * ── 解决什么 ─────────────────────────────────────────────────────────
 * IB-1 已把 UI→Core 的坐标错误锁定为**明确的坐标域错误**：
 *
 *   `computeSegmentDomOffset/Range` 产出的是 **segment-local UTF-16**，
 *   而 `CanonicalSelection` / `canonicalToCoreTarget` 消费的是 **paragraph-relative UTF-16**。
 *   中间缺少 Segment → Paragraph 的转换 ⇒ Core 把段内偏移当成段首偏移，
 *   编辑 A 段时污染 B 段（段落级错位）。
 *
 * ── 本原语的职责 ─────────────────────────────────────────────────────
 * 给定 Segment 在**行 glyph 序列**中的 `[startGlyphIndex, endGlyphIndex]`（含端），
 * 证明并解析它在 **Core paragraph（段落级 UTF-16）** 中的 `[segmentStartUtf16, segmentEndUtf16)`。
 *
 *    Segment.source.startGlyphIndex
 *            ↓  glyphRangeToUtf16Range（唯一 glyph→UTF-16 换算点）
 *    Core paragraph UTF-16
 *
 * 输出 `SegmentBindingRange` 明确属于 Binding 层，**不进入 Core Document**。
 *
 * ── 为什么用 `glyphRangeToUtf16Range`（最小方案）而非运行态 run 前缀累加 ──
 * IB-2-A 的第一动作是**锁定 Mapping Invariant**：
 *   glyph UTF-16 offset === Core paragraph UTF-16 offset
 * 在 单 run / 多 run / 多视觉列 / emoji / CJK / whitespace / repeated text
 * 七类 fixture 上验证成立 ⇒ 采用 `segmentStartUtf16` 最小方案（复用既有的唯一
 * glyph→UTF-16 换算点 `glyphRangeToUtf16Range`，绝不制造第二套坐标 Truth）。
 *
 * 子串级（run 内）前缀累加只有在「1 glyph === 1 字符」时才成立；ligature
 * （1 glyph = 多字符，如 "ffi"）下会算错。因此段落级 UTF-16 **必须由行 glyph
 * 序列直接推导**（`glyphRangeToUtf16Range`），而 `paragraphId / runId` 的归属
 * 由 `TextSourceBinding` 的 glyph 区间**包含关系**解析（fail-closed）。
 *
 * ── fail-closed（绝不猜）─────────────────────────────────────────────
 * 身份缺失 / 无 lineGlyphs / glyph 越界 / 无 run 完整包含该 glyph 区间 ⇒ 返回 `null`。
 * 调用方在本函数返回 null 时**必须**保持其既有行为（不回退到错误的段内偏移）。
 */

import type { EditorDocument } from "../core/document/types";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";

// ─────────────────────────────────────────────────────────────────────
//  S1 · 输入 / 输出结构（结构性投影，不 import editor-engine 的 Segment 类型）
// ─────────────────────────────────────────────────────────────────────

/** Segment 的几何身份投影（与 `editor-engine/SegmentBuilder` 的 `SegmentSource` 同构） */
export interface SegmentRangeSource {
  readonly blockId?: string;
  readonly lineId?: string;
  readonly lineIdx?: number;
  /** 行 glyph 序列内的 inclusive glyph 下标（与 `computeSourceGlyphRange` 同口径） */
  readonly startGlyphIndex?: number;
  readonly endGlyphIndex?: number;
}

export interface SegmentParagraphRangeInput {
  readonly source?: SegmentRangeSource;
}

/** Segment 在 Core paragraph 中的段落级绑定区间（Binding 层，不进入 Core Document） */
export interface SegmentBindingRange {
  readonly blockId: string;
  readonly lineId: string;
  /** 段落级（paragraph-relative）UTF-16 code-unit，**半开区间** `[start, end)` */
  readonly segmentStartUtf16: number;
  readonly segmentEndUtf16: number;
  readonly paragraphId: string;
  readonly runId?: string;
}

// ─────────────────────────────────────────────────────────────────────
//  S2 · 解析原语
// ─────────────────────────────────────────────────────────────────────

/**
 * 解析 Segment 在 Core paragraph 中的 `[start, end)` 段落级 UTF-16 区间。
 *
 * @param document   Core `EditorDocument`（用于按 `TextSourceBinding` 解析 `paragraphId / runId`）
 * @param segment    Segment 的几何身份投影（`source.startGlyphIndex/endGlyphIndex`）
 * @param lineGlyphs 该 segment 所属行的**完整 glyph 序列**（按行内顺序；
 *                    每个 glyph 的 `char` 长度即其 UTF-16 单元数）。缺失 ⇒ fail-closed。
 * @returns 段落级绑定区间；任何不变量不成立 ⇒ `null`
 */
export function resolveSegmentParagraphRange(
  document: EditorDocument,
  segment: SegmentParagraphRangeInput,
  lineGlyphs: ReadonlyArray<{ char?: string; originalChar?: string }>
): SegmentBindingRange | null {
  const src = segment.source;
  if (!src || !src.blockId || !src.lineId) return null;

  const sgStart = src.startGlyphIndex;
  const sgEnd = src.endGlyphIndex;
  if (sgStart == null || sgEnd == null) return null;
  if (!Number.isInteger(sgStart) || !Number.isInteger(sgEnd)) return null;
  if (sgEnd < sgStart) return null;

  if (!lineGlyphs || lineGlyphs.length === 0) return null;
  if (sgStart > lineGlyphs.length - 1 || sgEnd > lineGlyphs.length - 1) return null;

  // ★ 段落级 UTF-16：复用唯一 glyph→UTF-16 换算点（最小方案，已锁定 invariant）
  const { start, end } = glyphRangeToUtf16Range(
    lineGlyphs as unknown as Parameters<typeof glyphRangeToUtf16Range>[0],
    sgStart,
    sgEnd
  );

  // 归属解析：找 run 其 source glyph 区间**完整包含** `[sgStart, sgEnd]`
  const hit = findRunContainingGlyphRange(document, src.blockId, src.lineId, sgStart, sgEnd);
  if (!hit) return null;

  return {
    blockId: src.blockId,
    lineId: src.lineId,
    segmentStartUtf16: start,
    segmentEndUtf16: end,
    paragraphId: hit.paragraphId,
    runId: hit.runId,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  S3 · 归属解析（TextSourceBinding 包含关系）
// ─────────────────────────────────────────────────────────────────────

/**
 * 在 Core document 中找 run：其 `source.(blockId, lineId)` 命中，且
 * `[sgStart, sgEnd]` 被其 `source.(startGlyphIndex, endGlyphIndex)` 完整包含。
 *
 * 多段落共享同一 lineId（Core split 形状）时，glyph 区间的包含关系能正确
 * 消歧（split 两侧 run 的 glyph 区间不同）；区间跨 run ⇒ 不认领任何一段
 * （fail-closed，绝不截断 / 绝不合并）。
 */
function findRunContainingGlyphRange(
  document: EditorDocument,
  blockId: string,
  lineId: string,
  sgStart: number,
  sgEnd: number
): { paragraphId: string; runId: string } | null {
  for (const page of document.pages ?? []) {
    for (const textBox of page.objects ?? []) {
      if (textBox.type !== "text") continue;
      for (const paragraph of textBox.paragraphs ?? []) {
        for (const run of paragraph.runs ?? []) {
          const rs = run.source;
          if (!rs) continue;
          if (rs.blockId !== blockId || rs.lineId !== lineId) continue;
          const rStart = rs.startGlyphIndex;
          const rEnd = rs.endGlyphIndex;
          if (rStart == null || rEnd == null) continue;
          if (sgStart >= rStart && sgEnd <= rEnd) {
            return { paragraphId: paragraph.id, runId: run.id };
          }
        }
      }
    }
  }
  return null;
}
