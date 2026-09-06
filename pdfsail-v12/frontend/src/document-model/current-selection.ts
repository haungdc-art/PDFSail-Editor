/**
 * CurrentSelection — 编辑消费的当前选中内容（Principle-8：Selection 产生 Context，Tool 消费 Context）
 *
 * 永远不可变（readonly，Principle：CurrentSelection 不可变）。
 * 纯 Glyph 上下文，完全不知道 Legacy 世界（无 segmentId / startOffset / fullText）。
 *
 * M5-IMPLEMENT-001：新增 multi-line representation（ranges）。
 *   - 单行选区：ranges.length === 1，ranges[0] 与旧字段完全一致（向后兼容）。
 *   - 跨行选区：ranges.length >= 2，每个 range 表示一个具体 line 上的精确 glyph interval（有序）。
 *   - 旧字段（blockId/lineId/start/end）在跨行时取 first，仅用于兼容；真实多行信息在 ranges。
 */

/** 单行精确 glyph 区间（M5-IMPLEMENT-001） */
export interface SelectionRange {
  readonly blockId: string;
  readonly lineId: string;
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
}

export interface CurrentSelection {
  /** 选中文本 */
  readonly text: string;
  /** 选中所在的 block（paragraph）—— 兼容字段：跨行时取 first */
  readonly blockId: string;
  /** 选中的行 —— 兼容字段：跨行时取 first */
  readonly lineId: string;
  /** 选中范围内第一个 glyph 的行内索引 —— 兼容字段 */
  readonly startGlyphIndex: number;
  /** 选中范围内最后一个 glyph 的行内索引（含）—— 兼容字段 */
  readonly endGlyphIndex: number;
  /** 是否为空选择（caret，无选中字符） */
  readonly isEmpty: boolean;
  /**
   * M5-IMPLEMENT-001：有序的多行 glyph 区间（Selection Truth 的 range 表达）。
   * 单行选区 length===1；跨行选区 length>=2。不丢失中间行 identity/ordering。
   */
  readonly ranges?: SelectionRange[];
}
