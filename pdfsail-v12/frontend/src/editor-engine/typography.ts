/**
 * Typography 能力（Story-5 Ownership Freeze / Story-6 Capability 消费 Metrics）。
 *
 * 本模块是 Typography 能力的独立载体，不属于 CoordinateMapper。
 * 职责语义是「Baseline → Top」（文本定位），不是「height → offset」。
 * CoordinateMapper 只调用 baselineToTop() / topToBaseline()，
 * 不知道内部是 0.72 / Font Metrics / capHeight，不拥有 Typography 的数据模型。
 *
 * Story-6（Step 6.2A）：Capability 从消费 fontSize 改为消费 TypographyMetrics（Domain Fact）。
 * 纪律：Producer 可以适配旧事实（fontSize），但 Capability 只消费 Domain Fact（TypographyMetrics）。
 *
 * 坐标空间：PDF（bottom-left origin，y 向上增大）。
 *   - top = baseline + ascent（baseline 上方是上升部，到文本顶部）
 *   - baseline = top - ascent
 */

import type { TypographyMetrics } from "../document-model/typography";

/**
 * Baseline → Top（PDF 空间）。
 *
 * 输入：baseline 的 PDF y + TypographyMetrics（Domain Fact）；返回文本顶部的 PDF y。
 * CoordinateMapper 只调用它，不解释 ascent 如何计算。
 */
export function baselineToTop(baselinePdfY: number, metrics: TypographyMetrics): number {
  return baselinePdfY + metrics.ascent;
}

/**
 * Top → Baseline（PDF 空间，反向）。
 *
 * 输入：文本顶部的 PDF y + TypographyMetrics（Domain Fact）；返回 baseline 的 PDF y。
 */
export function topToBaseline(topPdfY: number, metrics: TypographyMetrics): number {
  return topPdfY - metrics.ascent;
}
