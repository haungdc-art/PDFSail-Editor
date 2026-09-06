/**
 * DocumentSelection — 统一的文档选区契约（M4-DESIGN-001 · M4-IMPL-002A）
 *
 * 从 EditableDocument 的真实定位能力倒推：
 *   EditableDocument.pages[].blocks[].lines[].glyphs[]
 *   定位 = blockId + lineId + [startGlyphIndex, endGlyphIndex]
 *
 * 设计原则（PM 裁决）：
 *   - 不把 page 作为核心字段（page 可由 blockId 所属 page 反查，不为避免 flatMap 而冗余身份）。
 *   - 不把 text 作为核心定位字段（仅 UI 回显 / validation / stale 检测 / debugging）。
 *   - SegmentSelection 与 GlyphSelection 都是 Adapter，统一规范化成 DocumentSelection；
 *     ReplaceCommand 只依赖 DocumentSelection，不感知用户通过 segment 还是 glyph 选中。
 *
 * 与 CurrentSelection 的关系：
 *   - CurrentSelection 暂不废弃（M4-DESIGN-001 PM 裁决）。
 *   - CurrentSelection ≈ EditableDocument selection（定位字段一致），
 *     DocumentSelection 是其独立定位契约；GlyphSelectionAdapter 负责转换。
 */
export interface DocumentSelection {
  /** 选中的 block（paragraph） */
  readonly blockId: string;
  /** 选中的行 */
  readonly lineId: string;
  /** 选中范围内第一个 glyph 的行内索引 */
  readonly startGlyphIndex: number;
  /** 选中范围内最后一个 glyph 的行内索引（含） */
  readonly endGlyphIndex: number;
  /**
   * 辅助信息（非定位字段）：UI 回显 / selection validation / stale 检测 / debugging。
   * 不用于定位。
   */
  readonly text?: string;
  /** 是否为空选择（caret，无选中字符） */
  readonly isEmpty: boolean;
  /**
   * M5-IMPLEMENT-001：有序的多行 glyph 区间（与 CurrentSelection.ranges 一一对应）。
   * 单行 length===1；跨行 length>=2。跨行信息在此不压缩回"first line + last glyph"。
   */
  readonly ranges?: ReadonlyArray<{ blockId: string; lineId: string; startGlyphIndex: number; endGlyphIndex: number }>;
}
