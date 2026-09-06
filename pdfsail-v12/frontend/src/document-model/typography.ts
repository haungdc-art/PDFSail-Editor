/**
 * Typography Domain — 排版事实（Fact）定义。
 *
 * 只定义 Type / Interface / Fact，不含函数、逻辑、魔数、坐标转换。
 * 独立于 CoordinateMapper / Renderer，属于 Document Model 的领域模型。
 *
 * 三链分离（ADR-009）：
 *   - Geometry Fact：PDF → RawGlyph → CoordinateMapper → BBox
 *   - Typography Fact：baseline / ascent / descent / lineHeight（本 Domain）
 *   - Coordinate Fact：纯坐标转换（Flip / Scale / Translate），语义无关
 */

/**
 * TypographyMetrics — 单个文本实体的排版事实。
 *
 * 语义：描述一行 / 一个字符的垂直排版几何。
 *   - baseline 为真实基线（非 box-top）
 *   - ascent / descent / lineHeight 为该字体在该字号下的度量
 * 字段值均由 Producer 填充，Consumer 直接消费，不做经验重建。
 */
export interface TypographyMetrics {
  /** 真实基线（Original Fact），语义与 EditableLine.baseline 一致 */
  baseline: number;
  /** ascent：从 baseline 向上到上升部顶端的距离 */
  ascent: number;
  /** descent：从 baseline 向下到下降部底端的距离 */
  descent: number;
  /** lineHeight：行高（line box 高度） */
  lineHeight: number;
}
