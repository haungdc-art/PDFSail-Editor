/**
 * editor/binding/segment-range-session.ts — F3B-6.27 · 编辑期 SegmentRange 会话层
 *
 * 契约文档：cases/F3B-6.27-SegmentRangeOwnership-Contract.md
 *
 * ── 定位 ────────────────────────────────────────────────────────────────
 * 把 §10 冻结的契约层（ownership + ledger）接到**生产编辑面**的那一层：
 * 负责「段落级 offset ⇄ segment-local DOM offset」的**唯一换算口径**。
 *
 * ── 为什么必须收敛到这里 ────────────────────────────────────────────────
 * A′ 一旦把段的 DOM 文本替换成「Core 段落的切片」，该 DOM 的 offset **已经是段落相对**；
 * 若换算层仍执行 `base + domOffset`，就会形成
 *   paragraphOffset = segmentBase + (segmentBase + localOffset)   ← double-base
 * 因此本模块把 base 的来源统一为「ownership 的 range.startUtf16」，
 * 并在无 ownership 时才回退到既有 base（保持既有行为逐字节不变）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────────
 *   · 纯函数，无 DOM、无坐标、无 indexOf、无 segment.text 依赖
 *   · 不做 ownership 判定（判定在 segment-range-ownership）
 *   · 不做事务栈语义（栈在 segment-range-ledger）
 */

import {
  buildSegmentRangeOwnership,
  segmentRangeOf,
  type SegmentRangeOwnership,
} from "./segment-range-ownership";

/** 一个 segment 在 Core paragraph 中的段落级区间种子（来自 resolveSegmentParagraphRange） */
export interface SegmentRangeSeed {
  readonly segmentId: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface BuildLineOwnershipInput {
  readonly blockId: string;
  readonly lineId: string;
  readonly paragraphId: string;
  readonly paragraphLength: number;
  readonly seeds: readonly SegmentRangeSeed[];
}

/**
 * 由段落级区间种子建立 ownership；任一不变量不成立 ⇒ `null`（fail-closed）。
 *
 * 种子来源必须是**已验证的 Binding 解析原语**
 * （`resolveSegmentParagraphRange`，经 glyph 序列换算），不得由文本搜索得到。
 */
export function buildLineOwnership(input: BuildLineOwnershipInput): SegmentRangeOwnership | null {
  if (input.seeds.length === 0) return null;
  const built = buildSegmentRangeOwnership({
    blockId: input.blockId,
    lineId: input.lineId,
    paragraphId: input.paragraphId,
    paragraphLength: input.paragraphLength,
    segments: input.seeds.map((s) => ({
      segmentId: s.segmentId,
      startUtf16: s.startUtf16,
      endUtf16: s.endUtf16,
    })),
  });
  return built.ok ? built.ownership : null;
}

/**
 * 段落级 base：**唯一来源** = ownership 的 range.startUtf16；
 * 无 ownership ⇒ 回退调用方既有 base（行为不变）。
 */
export function segmentBaseOf(
  ownership: SegmentRangeOwnership | null,
  segmentId: string,
  fallbackBase: number
): number {
  const r = ownership ? segmentRangeOf(ownership, segmentId) : null;
  return r ? r.startUtf16 : fallbackBase;
}

/** segment-local DOM offset → 段落级 offset */
export function domOffsetToParagraphOffset(
  ownership: SegmentRangeOwnership | null,
  segmentId: string,
  domOffset: number,
  fallbackBase: number
): number {
  return segmentBaseOf(ownership, segmentId, fallbackBase) + domOffset;
}

/** 段落级 offset → segment-local DOM offset（钳到该段范围内） */
export function paragraphOffsetToDomOffset(
  ownership: SegmentRangeOwnership | null,
  segmentId: string,
  paragraphOffset: number,
  fallbackBase: number
): number {
  const base = segmentBaseOf(ownership, segmentId, fallbackBase);
  const raw = paragraphOffset - base;
  const r = ownership ? segmentRangeOf(ownership, segmentId) : null;
  if (!r) return raw;
  const lo = 0;
  const hi = r.endUtf16 - r.startUtf16;
  if (raw < lo) return lo;
  return raw > hi ? hi : raw;
}

/** 该 segment 对应的 Core 段落文本切片（A′ 写 DOM 文本的唯一来源） */
export function sliceTextFor(
  ownership: SegmentRangeOwnership | null,
  paragraphText: string,
  segmentId: string
): string | null {
  if (!ownership) return null;
  const r = segmentRangeOf(ownership, segmentId);
  if (!r) return null;
  if (r.startUtf16 > paragraphText.length) return null;
  return paragraphText.slice(r.startUtf16, Math.min(r.endUtf16, paragraphText.length));
}

/**
 * REENTER-SPLIT-01 / P9.2 — segment Core 写回前的 range-切片一致性校验（纯函数）
 *
 * 缺陷：Enter 拆段后，旧 segment 的注册区间（如旧行「日期：」的 [0,3)）被
 * `resolveSegmentToCoreRange` 作用于**新段落**；`ReplaceText([0,3), 43字)` 把段落
 * 前缀替换+拼接 ⇒ 72/40 → 112/80（重复绘制）。
 *
 * 校验语义：**目标段落在该 range 处的实际文本，必须等于该 segment 的注册切片文本**
 * ——两者同轴时 range 才有确定语义。切片为 null（无 ownership/区间越界）⇒ 无法证明
 * 一致性 ⇒ 调用方 fail-closed（不得猜测）。正常编辑（合法变化）⇒ 切片随段落文本
 * 演进，range 处文本仍等于切片 ⇒ 校验通过，不受哈希变化影响。
 */
export function segmentRangeMatchesParagraph(input: {
  paragraphText: string;
  /** 解析出的 Core 写回区间（段落 UTF-16 轴） */
  start: number;
  end: number;
  /** 该 segment 的注册切片文本（sliceTextFor 产出；null = 无法证明一致性） */
  expectedSliceText: string | null;
}): { ok: true } | { ok: false; reason: "range-out-of-bounds" | "slice-unprovable" | "slice-mismatch"; detail: string } {
  const { paragraphText, start, end, expectedSliceText } = input;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > paragraphText.length
  ) {
    return {
      ok: false,
      reason: "range-out-of-bounds",
      detail: `range [${start},${end}) 超出段落文本（len=${paragraphText.length}）`,
    };
  }
  if (expectedSliceText == null) {
    return {
      ok: false,
      reason: "slice-unprovable",
      detail: "该 segment 无注册切片（ownership/range 缺失）⇒ 无法证明 range 语义",
    };
  }
  const rangeText = paragraphText.slice(start, end);
  if (rangeText !== expectedSliceText) {
    return {
      ok: false,
      reason: "slice-mismatch",
      detail: `range 处文本 [${rangeText}] ≠ 注册切片 [${expectedSliceText}]（轴错位）`,
    };
  }
  return { ok: true };
}
