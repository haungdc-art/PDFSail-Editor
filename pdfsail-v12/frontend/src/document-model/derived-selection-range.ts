/**
 * M7-004A: DerivedSelection → SelectionRange 转换。
 *
 * 利用 Boundary.glyphLocalIndex（runtime object identity），不做文本回查。
 * 与现有 SelectionRange = {blockId, lineId, startGlyphIndex, endGlyphIndex} 对齐（无第三套表达）。
 */
import type { SelectionRange } from "./current-selection";
import type { DerivedSelection } from "./selection-engine";

/**
 * 把拖选产生的 DerivedSelection 转为 SelectionRange。
 * - lineId = startBoundary.lineId（单行模型）。
 * - startGlyphIndex = min(anchor.glyphLocalIndex, focus.glyphLocalIndex)。
 * - endGlyphIndex 依 focus edge：半开区间 [start, focus) → edge "before" 时 = focus-1，"after" 时 = focus。
 * - 跨行（start/end lineId 不同）→ null（M7 单行模型）。
 */
export function derivedToSelectionRange(derived: DerivedSelection): SelectionRange | null {
  const a = derived.startBoundary;
  const b = derived.endBoundary;
  if (a.lineId !== b.lineId) return null; // 跨行 → 单行模型不支持
  const startIdx = Math.min(a.glyphLocalIndex, b.glyphLocalIndex);
  const endLocal = Math.max(a.glyphLocalIndex, b.glyphLocalIndex);
  // 取 focus（较大索引）的 edge 决定 end 是否含
  const focusEdge = b.glyphLocalIndex >= a.glyphLocalIndex ? b.edge : a.edge;
  const endGlyphIndex = focusEdge === "before" ? Math.max(startIdx, endLocal - 1) : endLocal;
  return {
    blockId: a.blockId,
    lineId: a.lineId,
    startGlyphIndex: startIdx,
    endGlyphIndex,
  };
}
