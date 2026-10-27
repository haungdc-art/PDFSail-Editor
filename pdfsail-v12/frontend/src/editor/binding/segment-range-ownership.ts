/**
 * editor/binding/segment-range-ownership.ts — F3B-6.27 · SegmentRangeOwnership
 *
 * 契约文档：cases/F3B-6.27-SegmentRangeOwnership-Contract.md
 *
 * ── 定位 ────────────────────────────────────────────────────────────────
 * Core paragraph（Core 持有文本）→ transparent DOM（selection/caret 载体）
 * 之间**缺失的一层**：per-segment UTF-16 range 的权威 ownership。
 *
 * ⚠️ 本模块是**纯函数契约层**，**当前无任何 production 消费方**（接线冻结）。
 *   它的存在只为了让契约可被单测钉死；A′ multi-segment 接线、
 *   G9 base 换算重写、DOM 几何全部**冻结**。
 *
 * ── 已裁决的语义（用户裁决，见契约 §8）───────────────────────────────
 *   Q1 = B  cross-segment mutation  → noSync（不猜 ownership）
 *   Q2 = A  range 随 transaction 快照（快照由上层 ledger 负责，本模块纯函数）
 *   Q3 = A  允许空 range（start == end）
 *   Q4 = A  separator 显式建模（参与 ownership 判定）
 *   Q5 = B  独立 Binding ledger（不塞 BindingSidecar）
 *
 * ── 刻意不做的事（结构保证，非纪律保证）───────────────────────────────
 *   · 无坐标：不 import / 不读取 glyph bbox、x、y        ⇒ I8
 *   · 无文本搜索：模块内不做 indexOf / lastIndexOf 定位  ⇒ I7
 *   · 无 DOM：document / window / selection 一律不碰      ⇒ I9
 *   · 不依赖 segment.text 当前值                          ⇒ I10
 *
 * ── 命名纪律（用户明确要求）────────────────────────────────────────────
 *   唯一被证明可维护的 mutation 是 **single-segment local mutation**
 *   （区间完全落在同一个 segment 内）。跨 segment 一律 noSync。
 *   函数名刻意带 SingleSegmentLocal，避免产生
 *   「ledger 可以维护任意 Core transaction」的危险误解。
 */

/** provenance：imported = 源自 PDF 原文；generated = 编辑产物 */
export type SegmentRangeKind = "imported" | "generated";

/** 段落内 UTF-16 半开区间 [startUtf16, endUtf16) */
export interface SegmentRange {
  readonly segmentId: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly kind: SegmentRangeKind;
}

/** 不属于任何 segment 的间隙（段间分隔空格、尾部余量） */
export interface SeparatorRange {
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface SegmentRangeOwnership {
  readonly blockId: string;
  readonly lineId: string;
  /** Core identity：由 Binding 用已验证解析器解析；Core 不知道 segmentId（I6） */
  readonly paragraphId: string;
  readonly paragraphLength: number;
  /** 按 document order 单调、互不重叠（I2 / I3） */
  readonly segments: readonly SegmentRange[];
  /** 显式间隙（Q4 = A）；参与 ownership 判定，不只是计算副产物 */
  readonly separators: readonly SeparatorRange[];
}

export type BuildFailure =
  | "empty-segments"
  | "duplicate-segment-id"
  | "negative-offset"
  | "not-monotonic"
  | "overlap"
  | "out-of-paragraph"
  | "invalid-paragraph-length";

export type BuildOutcome =
  | { readonly ok: true; readonly ownership: SegmentRangeOwnership }
  | { readonly ok: false; readonly reason: BuildFailure };

export type MutationFailure =
  | "empty-ownership"
  | "invalid-ownership"
  | "paragraph-mismatch"
  | "non-text-command"
  | "cross-run-range"
  | "stale-generation"
  | "range-out-of-paragraph"
  | "unresolved-segment"
  | "owner-conflict"
  | "start-in-separator"
  | "end-in-separator"
  | "ambiguous-boundary-start"
  | "cross-segment-range"
  | "invariant-violated";

export type MutationOutcome =
  | {
      readonly ok: true;
      readonly ownership: SegmentRangeOwnership;
      readonly touchedSegmentId: string;
      readonly deltaUtf16: number;
    }
  | { readonly ok: false; readonly reason: MutationFailure };

/** 段落相对的单段 mutation 描述（Core transaction 的形状） */
export interface SingleSegmentLocalMutation {
  readonly paragraphId: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly newTextLength: number;
  readonly commandKind: "insert" | "delete" | "replace" | "other" | "split-paragraph";
  /**
   * 调用方声称的 owner segment（真实来源 = 当前编辑会话的 segmentId）。
   *
   * ★ Q6 精化：段边界上的零宽插入（「归 A 尾」还是「归 B 头」）在**几何上**不可判定，
   *   但调用方**知道** caret 属于哪个 segment ⇒ 传入本字段即可消歧。
   *   省略 ⇒ 纯几何判定，边界落点 fail-closed（ambiguous-boundary-start）。
   *   传入但与几何冲突 ⇒ owner-conflict（fail-closed）。
   */
  readonly ownerSegmentId?: string;
  /** 已知跨 run（实测跨 run 时 range 计算会错 ⇒ 必须 noSync） */
  readonly crossRun?: boolean;
  /** 事务代令牌；< currentGeneration 即陈旧 */
  readonly generation?: number;
  readonly currentGeneration?: number;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

export type InvariantViolation =
  | "empty-segments"
  | "duplicate-segment-id"
  | "start-gt-end"
  | "negative-offset"
  | "not-monotonic"
  | "overlap"
  | "out-of-paragraph"
  | "separator-overlap"
  | "paragraph-length-mismatch";

/**
 * I1 start <= end（Q3 = A：允许空段）
 * I2 segments 互不重叠
 * I3 按 document order 单调
 * I4 separators 合法且与 segments 不交叠
 */
export function validateSegmentRangeOwnership(
  ownership: SegmentRangeOwnership
): { readonly ok: true } | { readonly ok: false; readonly reason: InvariantViolation } {
  const { segments, separators, paragraphLength } = ownership;
  if (!isInt(paragraphLength) || paragraphLength < 0) {
    return { ok: false, reason: "paragraph-length-mismatch" };
  }
  if (segments.length === 0) return { ok: false, reason: "empty-segments" };

  const seen = new Set<string>();
  let prevEnd = -1;
  for (const s of segments) {
    if (seen.has(s.segmentId)) return { ok: false, reason: "duplicate-segment-id" };
    seen.add(s.segmentId);
    if (!isInt(s.startUtf16) || !isInt(s.endUtf16)) return { ok: false, reason: "negative-offset" };
    if (s.startUtf16 < 0 || s.endUtf16 < 0) return { ok: false, reason: "negative-offset" };
    if (s.startUtf16 > s.endUtf16) return { ok: false, reason: "start-gt-end" };
    if (s.endUtf16 > paragraphLength) return { ok: false, reason: "out-of-paragraph" };
    if (s.startUtf16 < prevEnd) return { ok: false, reason: "overlap" };
    prevEnd = s.endUtf16;
  }
  for (const sep of separators) {
    if (!isInt(sep.startUtf16) || !isInt(sep.endUtf16)) {
      return { ok: false, reason: "negative-offset" };
    }
    if (sep.startUtf16 < 0 || sep.endUtf16 < sep.startUtf16) {
      return { ok: false, reason: "separator-overlap" };
    }
    if (sep.endUtf16 > paragraphLength) return { ok: false, reason: "out-of-paragraph" };
    for (const s of segments) {
      if (sep.startUtf16 < s.endUtf16 && s.startUtf16 < sep.endUtf16) {
        return { ok: false, reason: "separator-overlap" };
      }
    }
  }
  return { ok: true };
}

export interface BuildInput {
  readonly blockId: string;
  readonly lineId: string;
  readonly paragraphId: string;
  readonly paragraphLength: number;
  /** 已由外部（唯一原语 glyphRangeToUtf16Range）换算好的段落内区间 */
  readonly segments: readonly {
    readonly segmentId: string;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly kind?: SegmentRangeKind;
  }[];
}

/** 由区间描述构建 ownership，并**显式**列出间隙（Q4 = A） */
export function buildSegmentRangeOwnership(input: BuildInput): BuildOutcome {
  if (!isInt(input.paragraphLength) || input.paragraphLength < 0) {
    return { ok: false, reason: "invalid-paragraph-length" };
  }
  if (input.segments.length === 0) return { ok: false, reason: "empty-segments" };

  const ordered = [...input.segments].sort((a, b) => a.startUtf16 - b.startUtf16);
  const segments: SegmentRange[] = [];
  const separators: SeparatorRange[] = [];
  let cursor = 0;
  for (const s of ordered) {
    if (s.startUtf16 < 0 || s.endUtf16 < s.startUtf16) {
      return { ok: false, reason: "negative-offset" };
    }
    if (s.endUtf16 > input.paragraphLength) {
      return { ok: false, reason: "out-of-paragraph" };
    }
    if (s.startUtf16 > cursor) {
      separators.push({ startUtf16: cursor, endUtf16: s.startUtf16 });
    }
    segments.push({
      segmentId: s.segmentId,
      startUtf16: s.startUtf16,
      endUtf16: s.endUtf16,
      kind: s.kind ?? "imported",
    });
    cursor = Math.max(cursor, s.endUtf16);
  }
  if (cursor < input.paragraphLength) {
    separators.push({ startUtf16: cursor, endUtf16: input.paragraphLength });
  }

  const ownership: SegmentRangeOwnership = {
    blockId: input.blockId,
    lineId: input.lineId,
    paragraphId: input.paragraphId,
    paragraphLength: input.paragraphLength,
    segments,
    separators,
  };
  const v = validateSegmentRangeOwnership(ownership);
  if (!v.ok) return { ok: false, reason: v.reason as BuildFailure };
  return { ok: true, ownership };
}

export function segmentRangeOf(
  ownership: SegmentRangeOwnership,
  segmentId: string
): SegmentRange | null {
  return ownership.segments.find((s) => s.segmentId === segmentId) ?? null;
}

/** 段落在 Core 段落文本中的切片 —— A′ 写 DOM 文本时需要的**唯一**来源（I7/I8） */
export function sliceTextOfSegment(
  ownership: SegmentRangeOwnership,
  paragraphText: string,
  segmentId: string
): string | null {
  const r = segmentRangeOf(ownership, segmentId);
  if (!r) return null;
  if (r.startUtf16 > paragraphText.length) return null;
  return paragraphText.slice(r.startUtf16, Math.min(r.endUtf16, paragraphText.length));
}

export function separatorAt(
  ownership: SegmentRangeOwnership,
  offsetUtf16: number
): SeparatorRange | null {
  return (
    ownership.separators.find((s) => s.startUtf16 <= offsetUtf16 && offsetUtf16 < s.endUtf16) ??
    null
  );
}

/** offset 落在哪个 segment 内（含两端端点） */
function ownerSegmentAt(
  ownership: SegmentRangeOwnership,
  offsetUtf16: number
): { readonly range: SegmentRange; readonly index: number } | null {
  for (let i = 0; i < ownership.segments.length; i++) {
    const r = ownership.segments[i];
    if (offsetUtf16 >= r.startUtf16 && offsetUtf16 <= r.endUtf16) {
      return { range: r, index: i };
    }
  }
  return null;
}

/**
 * 施加**单段局部** mutation。
 *
 * 语义（严格）：区间 [startUtf16, endUtf16) 必须**完全落在同一个 segment 内**。
 * 任何跨越 segment / 落在 separator / 落在段边界 / 跨 run / 非文本命令 / 陈旧事务
 * ⇒ **一律 noSync**（fail-closed，不猜 ownership）。
 *
 * ⚠️ **不要**把它读成「能维护任意 Core transaction」——
 *   跨 segment 场景按 Q1 = B 明确不支持。
 */
export function applySingleSegmentLocalMutation(
  ownership: SegmentRangeOwnership,
  mutation: SingleSegmentLocalMutation
): MutationOutcome {
  if (ownership.segments.length === 0) return { ok: false, reason: "empty-ownership" };
  const v = validateSegmentRangeOwnership(ownership);
  if (!v.ok) return { ok: false, reason: "invalid-ownership" };

  if (mutation.paragraphId !== ownership.paragraphId) {
    return { ok: false, reason: "paragraph-mismatch" };
  }
  if (
    mutation.commandKind !== "insert" &&
    mutation.commandKind !== "delete" &&
    mutation.commandKind !== "replace"
  ) {
    return { ok: false, reason: "non-text-command" };
  }
  if (mutation.crossRun === true) return { ok: false, reason: "cross-run-range" };
  if (
    typeof mutation.generation === "number" &&
    typeof mutation.currentGeneration === "number" &&
    mutation.generation < mutation.currentGeneration
  ) {
    return { ok: false, reason: "stale-generation" };
  }
  const { startUtf16, endUtf16, newTextLength } = mutation;
  if (
    !isInt(startUtf16) ||
    !isInt(endUtf16) ||
    !isInt(newTextLength) ||
    newTextLength < 0 ||
    startUtf16 < 0 ||
    endUtf16 < startUtf16 ||
    endUtf16 > ownership.paragraphLength
  ) {
    return { ok: false, reason: "range-out-of-paragraph" };
  }

  // separator 内落点 ⇒ 无 owner（Q4 = A：separator 参与判定）
  if (separatorAt(ownership, startUtf16)) return { ok: false, reason: "start-in-separator" };
  if (separatorAt(ownership, endUtf16)) return { ok: false, reason: "end-in-separator" };

  const geometry = ownerSegmentAt(ownership, startUtf16);
  if (!geometry) return { ok: false, reason: "unresolved-segment" };

  // 段边界上的零宽插入在**几何上**歧义（「归 A 尾」还是「归 B 头」）。
  //   · 给出 ownerSegmentId ⇒ 以调用方为准（它知道 caret 归属），但必须与几何一致。
  //   · 未给出 ⇒ fail-closed（Q1：不猜 ownership）。
  let owner = geometry.range;
  let ownerIndex = geometry.index;
  if (typeof mutation.ownerSegmentId === "string") {
    const claimed = segmentRangeOf(ownership, mutation.ownerSegmentId);
    if (!claimed) return { ok: false, reason: "owner-conflict" };
    let claimedIndex = -1;
    for (let i = 0; i < ownership.segments.length; i++) {
      if (ownership.segments[i].segmentId === claimed.segmentId) { claimedIndex = i; break; }
    }
    if (startUtf16 < claimed.startUtf16 || startUtf16 > claimed.endUtf16) {
      return { ok: false, reason: "owner-conflict" };
    }
    owner = claimed;
    ownerIndex = claimedIndex;
  } else {
    // 内部边界 = start 恰好等于某个**非首段**的 start
    // （几何上无法区分「上一段尾」与「本段头」⇒ 不猜 ownership，Q1）
    let onInternalBoundary = false;
    for (let i = 1; i < ownership.segments.length; i++) {
      if (ownership.segments[i].startUtf16 === startUtf16) { onInternalBoundary = true; break; }
    }
    if (onInternalBoundary) return { ok: false, reason: "ambiguous-boundary-start" };
  }

  // end 必须落在同一段内 ⇒ 否则跨 segment（Q1 = B）
  if (endUtf16 > owner.endUtf16) return { ok: false, reason: "cross-segment-range" };

  const delta = newTextLength - (endUtf16 - startUtf16);

  const segments: SegmentRange[] = ownership.segments.map((s, i) => {
    if (i === ownerIndex) {
      // ★ 保留 mutation 之后**未被编辑的段内后缀**：
      //   newEnd = mutation.start + newTextLength + (owner.end - mutation.end)
      //   （漏掉后缀会把整段截断 —— 契约测试 C5/C6 曾实测抓到该缺陷）
      return {
        segmentId: s.segmentId,
        startUtf16: s.startUtf16,
        endUtf16: startUtf16 + newTextLength + (s.endUtf16 - endUtf16),
        kind: "generated" as const,
      };
    }
    if (i < ownerIndex) return s;
    return {
      segmentId: s.segmentId,
      startUtf16: s.startUtf16 + delta,
      endUtf16: s.endUtf16 + delta,
      kind: s.kind,
    };
  });

  const separators: SeparatorRange[] = ownership.separators.map((s) => {
    const shift = (from: number) =>
      from > owner.startUtf16 ? from + delta : from;
    return { startUtf16: shift(s.startUtf16), endUtf16: shift(s.endUtf16) };
  });

  const next: SegmentRangeOwnership = {
    blockId: ownership.blockId,
    lineId: ownership.lineId,
    paragraphId: ownership.paragraphId,
    paragraphLength: ownership.paragraphLength + delta,
    segments,
    separators,
  };
  const nv = validateSegmentRangeOwnership(next);
  if (!nv.ok) return { ok: false, reason: "invariant-violated" };
  return { ok: true, ownership: next, touchedSegmentId: owner.segmentId, deltaUtf16: delta };
}
