/**
 * extractFactsSnapshot — 从 EditableDocument 提取 FactsSnapshot（Content）
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 4（Dual Run）
 *
 * 职责：
 *   - 提取 Renderer 所需的 Content（char/styleRef/modified），不含几何。
 *   - 供 LayoutResultAdapter 与 LayoutResult（Geometry）合并生成 RenderCommand。
 *   - 不传整个 EditableDocument 给 Adapter/Renderer。
 */

import type { EditableDocument } from "./types";
import type { FactsSnapshot, FactPage, FactBlock, FactLine, FactGlyph } from "./facts-snapshot";

/**
 * 从布局后的 EditableDocument 提取 FactsSnapshot（Content）。
 */
export function extractFactsSnapshot(doc: EditableDocument): FactsSnapshot {
  const pages: FactPage[] = doc.pages.map((page) => {
    const blocks: FactBlock[] = page.blocks.map((block) => {
      const lines: FactLine[] = (block.lines ?? []).map((line) => {
        const glyphs: FactGlyph[] = (line.glyphs ?? []).map((g) => ({
          blockId: block.id,
          lineId: line.id,
          char: g.char,
          styleRef: g.styleRef ?? 0,
          modified: g.modified ?? false,
        }));
        return { lineId: line.id, glyphs };
      });
      return { blockId: block.id, lines };
    });
    return { pageId: `p${page.index}`, blocks };
  });
  return { pages };
}
