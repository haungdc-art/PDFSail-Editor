/**
 * editor/binding/table-cell-resolver.ts — F3B-6.28 · S1：segment → cell 唯一归属解析（**纯 contract**）
 *
 * ── 用户诉求（2026-10-20）──────────────────────────────────────────────
 *   > 「表格的识别不能按段落来，应该是按照表格格子来识别，一个格子相当于一个段落」
 *
 *   S0 只读调查（真实 fixture `cases/gd-swim-2026.pdf` 第 11 页，16 个表格行）已把问题从
 *   「索引体系冲突」重新定位为 **「segment 如何唯一归属 cell」**。本模块只回答后者，
 *   **不承担任何编辑行为**（不构造 Command、不写文档、不判提交资格）。
 *
 * ── S0 实测结论（本模块的设计依据，全部真跑取证）────────────────────────
 *   · `PDFEditor.tsx` 旧注释记载的「segment.source 是 cell 内索引」**被证伪**：
 *     `computeSourceGlyphRange` 遍历**整个 LineGroup** ⇒ source 区间本就是**行内** glyph
 *     区间；且 `groupIntoLines` 在本 fixture **没有**把表格行拆成多个 LineGroup
 *     （同 pdfY 多 LineGroup = 空；importer 文档与 SegmentBuilder lines 逐行一致 26=26）。
 *   · 全部 19 行（16 表格 + 3 正文）字符级校验 100% 通过：source 区间经
 *     `glyphRangeToUtf16Range` 切片 === segment.text。
 *   · **真实分歧不是索引口径，而是边界粒度**（D1）：segmenter 切分判据
 *     `gap > 0.4×fontSize`，cell 契约判据 `gap ≥ 中位列宽×0.5` ⇒ **segment 严格细于或
 *     等于 cell**（实证：表头行 7 segment ↔ 6 cell，cell0「称号的小项50米池」含 2 个
 *     segment；全部行 0 个跨 cell 边界 segment）。
 *     ⇒ cell 映射**必须按区间包含关系**，一个 cell 可含多个 segment；segment 跨多个
 *       cell 时**绝不**任意选一个。
 *
 * ── 输入契约（刻意不携带 cell 文本）────────────────────────────────────
 *   `cells` 只接受 **glyph 区间投影** `{index, startGlyphIndex, endGlyphIndex}`，
 *   **刻意不含 text** —— 从类型层结构性杜绝「按文本选 cell」。
 *   UTF-16 区间一律由本模块经唯一换算点 `glyphRangeToUtf16Range` 从 `rowGlyphs`
 *   现算（不信任调用方传入的第二套 UTF-16，避免双坐标真相）。
 *
 * ── D3：位置内容证明（为什么需要 originalText）────────────────────────
 *   `rowGlyphs` 来自**活** legacy 行（`lineGlyphsFor` 读 `editableDocumentRef`）：
 *     · Core ownership 下 legacy 不被 mutation ⇒ import 期映射持续有效；
 *     · Legacy fallback（`mutateLineText`）会重写行 glyph ⇒ `segment.source` 陈旧。
 *   仅靠区间上界/包含关系**无法**识别「同长不同内容」的漂移 ⇒ 用 import 期不可变锚
 *   `segment.originalText`（`projectCoreTextOntoSegments` 契约 S2：永不被投影改写；
 *   `applySegmentEditsToDocument` 只读它）做**位置内容证明**：
 *     `join(rowGlyphs[start..end].char) === originalText` 才承认该映射仍然有效。
 *   ⚠ 它**只**用于接受/拒绝整个映射，**绝不参与** cell 的选择（选择 100% 由区间包含决定）。
 *
 * ── fail-closed 全集（零匹配 / 多重 / 越界 / 陈旧 / 来源不一致）──────────
 *   任何不成立 ⇒ `{ok:false, reason}`；调用方须保持既有整行编辑行为，**严禁**默认首格。
 *
 * ── 硬边界 ─────────────────────────────────────────────────────────────
 *   纯函数：零 React / 零 DOM / 零 Core import / 零 Command / 零 indexOf / 零文本匹配。
 *   本模块**不接生产**（S1 仅契约 + 测试；接入属 S2，需独立授权）。
 */

import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";

// ─────────────────────────────────────────────────────────────────────
//  S1 · 输入 / 输出结构（结构性投影，不 import editor-engine 的 Segment 类型）
// ─────────────────────────────────────────────────────────────────────

/** Segment 的 source 投影（与 `editor-engine` 的 `SegmentSource` 同构） */
export interface CellResolverSegmentSource {
  readonly blockId?: string;
  readonly lineId?: string;
  readonly startGlyphIndex?: number;
  readonly endGlyphIndex?: number;
}

/**
 * Segment 身份投影。
 * `originalText` = **import 期原文**（不可变锚），仅用于位置内容证明（见头注 D3）。
 */
export interface CellResolverSegment {
  readonly id: string;
  readonly source?: CellResolverSegmentSource | null;
  readonly originalText?: string | null;
}

/** 行 glyph 投影（与 `EditableGlyph` 的 char 子集同构） */
export interface CellResolverGlyph {
  readonly char?: string;
}

/**
 * cell 区间的** glyph 投影**（与 `detectTableCells` 产出的 `TableCell` 同构，但**刻意去 text**）。
 * 去 text 是类型层约束：解析器不可能按文本选 cell（D5）。
 */
export interface CellResolverCellInterval {
  readonly index: number;
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
}

/** 唯一归属成功时的 cell 身份 + 双区间（glyph 闭区间 + UTF-16 半开区间，均为行内坐标） */
export interface ResolvedSegmentCell {
  readonly cellIndex: number;
  /** cell 的行内 glyph 闭区间 */
  readonly cellStartGlyphIndex: number;
  readonly cellEndGlyphIndex: number;
  /** cell 的行内 UTF-16 半开区间（由 rowGlyphs 经唯一换算点现算） */
  readonly cellStartUtf16: number;
  readonly cellEndUtf16: number;
  /** segment 的行内 UTF-16 半开区间（同坐标空间；供调用方做 unit/编辑面定位） */
  readonly segmentStartUtf16: number;
  readonly segmentEndUtf16: number;
}

export type SegmentCellRejectReason =
  /** 行不是表格行（cells 为空）⇒ 调用方保持整行编辑 */
  | "not-table-row"
  | "missing-segment"
  /** segment 不属于该行（rowSegments 中无此 id）⇒ 坐标空间不可信 */
  | "segment-not-in-row"
  /** segment.source.lineId 与该行其他 segment 不一致 ⇒ 来源不一致 */
  | "line-mismatch"
  | "missing-source"
  /** glyph 区间非整数 / 逆序 */
  | "invalid-glyph-range"
  | "range-out-of-bounds"
  /** 缺 import 期原文锚 ⇒ 无法证明映射仍然有效 */
  | "missing-original-anchor"
  /** 位置内容证明失败（行 glyph 已被重写 / 同长漂移）⇒ 映射陈旧 */
  | "stale-mapping"
  /** 不被任何 cell 包含，且最多邻接 1 个 cell（落在间隙/部分越出） */
  | "no-cell"
  /** 区间跨 ≥2 个 cell ⇒ 绝不任意选其中一个 */
  | "spans-multiple-cells"
  /** ≥2 个 cell 同时包含该 segment（数据不一致：cell 区间重叠）⇒ 不猜 */
  | "ambiguous";

export type SegmentCellResolution =
  | { readonly ok: true; readonly cell: ResolvedSegmentCell }
  | { readonly ok: false; readonly reason: SegmentCellRejectReason };

export interface ResolveSegmentCellInput {
  /** 被解析的 segment（通常 = 用户点击的那个） */
  readonly segment: CellResolverSegment | null | undefined;
  /** 该行**当前**的完整 glyph 序列（活文档；Core ownership 下 = import 期原序列） */
  readonly rowGlyphs: ReadonlyArray<CellResolverGlyph>;
  /** 该行全部 segment（用于身份成员校验；顺序不得影响结果） */
  readonly rowSegments: ReadonlyArray<CellResolverSegment>;
  /** `detectTableCells(rowGlyphs).cells` 的 glyph 区间投影；空 ⇒ 非表格行 */
  readonly cells: ReadonlyArray<CellResolverCellInterval>;
}

// ─────────────────────────────────────────────────────────────────────
//  S2 · 解析原语（纯函数；选择 100% 由区间包含决定）
// ─────────────────────────────────────────────────────────────────────

/** 闭区间包含：`[s,e] ⊆ [cs,ce]` */
const contains = (cs: number, ce: number, s: number, e: number): boolean => cs <= s && e <= ce;

/** 闭区间相交：`[s,e] ∩ [cs,ce] ≠ ∅` */
const overlaps = (cs: number, ce: number, s: number, e: number): boolean => s <= ce && cs <= e;

/**
 * **segment → cell 唯一归属解析**（S1 唯一入口）。
 *
 * 判定顺序（固定；fail-closed 优先于归属）：
 *   1. `cells` 空 ⇒ `not-table-row`
 *   2. segment 缺失 / 不在 rowSegments / lineId 不一致 ⇒ 来源不可信
 *   3. source 缺失 / glyph 区间非法 / 越界 ⇒ 坐标不可信
 *   4. **位置内容证明**（D3）：区间切片 ≠ import 期原文 ⇒ `stale-mapping`
 *   5. 区间包含归属（D1）：唯一包含 ⇒ 成功；跨多个 cell ⇒ `spans-multiple-cells`；
 *      零包含且最多邻接 1 个 ⇒ `no-cell`；多包含（数据不一致）⇒ `ambiguous`
 *
 * ★ 零匹配/多重/异常**一律失败**，绝不默认首格、绝不按 ordinal、绝不按文本。
 */
export function resolveSegmentCell(input: ResolveSegmentCellInput): SegmentCellResolution {
  const cells = input.cells;
  if (!cells || cells.length === 0) return { ok: false, reason: "not-table-row" };

  const segment = input.segment;
  if (!segment || !segment.id) return { ok: false, reason: "missing-segment" };

  // 身份成员校验：segment 必须属于该行（rowSegments 顺序不得影响结果）
  const rowSegments = input.rowSegments ?? [];
  const inRow = rowSegments.some((s) => s.id === segment.id);
  if (!inRow) return { ok: false, reason: "segment-not-in-row" };

  // 来源一致性：该行 segment 的 source.lineId 必须一致（取首个非空者为行基准）
  const rowLineId = rowSegments.find((s) => s.source?.lineId)?.source?.lineId ?? null;
  const src = segment.source ?? null;
  if (!src) return { ok: false, reason: "missing-source" };
  if (rowLineId !== null && src.lineId !== rowLineId) {
    return { ok: false, reason: "line-mismatch" };
  }

  const sgStart = src.startGlyphIndex;
  const sgEnd = src.endGlyphIndex;
  if (sgStart == null || sgEnd == null) return { ok: false, reason: "missing-source" };
  if (!Number.isInteger(sgStart) || !Number.isInteger(sgEnd) || sgEnd < sgStart) {
    return { ok: false, reason: "invalid-glyph-range" };
  }

  const rowGlyphs = input.rowGlyphs ?? [];
  if (rowGlyphs.length === 0) return { ok: false, reason: "range-out-of-bounds" };
  if (sgStart < 0 || sgEnd > rowGlyphs.length - 1) {
    return { ok: false, reason: "range-out-of-bounds" };
  }

  // ── D3：位置内容证明（只接受/拒绝整个映射，不参与 cell 选择）──
  const anchor = segment.originalText;
  if (anchor == null || anchor.length === 0) {
    return { ok: false, reason: "missing-original-anchor" };
  }
  let sliced = "";
  for (let i = sgStart; i <= sgEnd; i++) sliced += rowGlyphs[i]?.char ?? "";
  if (sliced !== anchor) return { ok: false, reason: "stale-mapping" };

  // ── D1：区间包含归属（唯一确定，无文本、无 ordinal）──
  const containing = cells.filter((c) => contains(c.startGlyphIndex, c.endGlyphIndex, sgStart, sgEnd));
  if (containing.length > 1) return { ok: false, reason: "ambiguous" };
  if (containing.length === 0) {
    const overlapping = cells.filter((c) => overlaps(c.startGlyphIndex, c.endGlyphIndex, sgStart, sgEnd));
    if (overlapping.length >= 2) return { ok: false, reason: "spans-multiple-cells" };
    return { ok: false, reason: "no-cell" };
  }

  const cell = containing[0]!;
  // UTF-16 一律由 rowGlyphs 经唯一换算点现算（不信任调用方的第二套 UTF-16）
  const segRange = glyphRangeToUtf16Range(
    rowGlyphs as unknown as Parameters<typeof glyphRangeToUtf16Range>[0],
    sgStart,
    sgEnd,
  );
  const cellRange = glyphRangeToUtf16Range(
    rowGlyphs as unknown as Parameters<typeof glyphRangeToUtf16Range>[0],
    cell.startGlyphIndex,
    cell.endGlyphIndex,
  );

  return {
    ok: true,
    cell: {
      cellIndex: cell.index,
      cellStartGlyphIndex: cell.startGlyphIndex,
      cellEndGlyphIndex: cell.endGlyphIndex,
      cellStartUtf16: cellRange.start,
      cellEndUtf16: cellRange.end,
      segmentStartUtf16: segRange.start,
      segmentEndUtf16: segRange.end,
    },
  };
}
