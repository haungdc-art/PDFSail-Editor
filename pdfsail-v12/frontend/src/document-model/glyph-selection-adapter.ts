/**
 * GlyphSelectionAdapter — GlyphSelection(CurrentSelection) → DocumentSelection（M4-IMPL-002A）
 *
 * Glyph Selection 天然携带 EditableDocument 的 blockId/lineId/glyphLocalIndex，
 * 因此到 DocumentSelection 的映射是直接、近乎 1:1 的（无需 page / 几何 / 文本重建）。
 *
 * 设计原则：
 *   - CurrentSelectionProvider 仍返回 CurrentSelection（不改成 Selection Manager，PM 裁决）。
 *   - 本 Adapter 在 EditTool 消费 provider 结果时做转换。
 *   - 不修改 CurrentSelection / Provider 本身。
 */
import type { CurrentSelection } from "./current-selection";
import type { DocumentSelection } from "./document-selection";

/**
 * 把 CurrentSelection（Glyph 通道）规范化为 DocumentSelection。
 * 定位字段直接透传；text 作为辅助信息透传；isEmpty 透传（供空选短路）。
 */
export function currentToDocument(selection: CurrentSelection): DocumentSelection {
  return {
    blockId: selection.blockId,
    lineId: selection.lineId,
    startGlyphIndex: selection.startGlyphIndex,
    endGlyphIndex: selection.endGlyphIndex,
    text: selection.text,
    isEmpty: selection.isEmpty,
    // M5-IMPLEMENT-001: 透传多行 ranges，不在此压缩回单行。
    ranges: selection.ranges,
  };
}
