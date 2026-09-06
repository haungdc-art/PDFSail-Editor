/**
 * extractLayoutResult — 从布局后的 EditableDocument 提取 LayoutResult
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 4（Dual Run）
 *
 * 设计（低风险双写）：
 *   - 不重新计算 Layout，只从布局后的 EditableBlock 提取已算好的几何（bbox/lines/glyph bbox）。
 *   - 因此 LayoutResult 与旧 RenderCommand（读同一 block 几何）天然一致，Diff 必然 PASS。
 *   - 不引用 EditableBlock，只取 blockId/lineId 关联 + 几何。
 */

import type { EditableDocument } from "./types";
import type { LayoutResult, LayoutPageResult, LayoutBlockResult, LayoutLineResult, LayoutGlyphResult } from "./layout-result";

function toRect(bbox: { x: number; y: number; width: number; height: number }) {
  return {
    x: bbox.x,
    y: bbox.y,
    width: bbox.width,
    height: bbox.height,
  };
}

/**
 * 从布局后的 EditableDocument 提取 LayoutResult。
 */
export function extractLayoutResult(doc: EditableDocument): LayoutResult {
  const pages: LayoutPageResult[] = doc.pages.map((page) => {
    const blocks: LayoutBlockResult[] = page.blocks.map((block) => {
      const lines: LayoutLineResult[] = (block.lines ?? []).map((line) => {
        const glyphs: LayoutGlyphResult[] = (line.glyphs ?? []).map((g) => ({
          bbox: toRect(g.bbox),
          ...(g.transform ? { transform: g.transform } : {}),
        }));
        return {
          lineId: line.id,
          bbox: toRect(line.bbox),
          glyphs,
        };
      });
      return {
        blockId: block.id,
        paragraphBounds: toRect(block.bbox),
        lines,
      };
    });
    return {
      pageId: `p${page.index}`,
      blocks,
    };
  });
  return { pages };
}
