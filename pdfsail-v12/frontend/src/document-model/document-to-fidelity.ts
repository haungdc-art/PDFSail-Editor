/**
 * DocumentToFidelity — Sprint40-Order-004（EditableDocument → Comparator 快照）
 *
 * 把 EditableDocument 转成 FidelityComparator 的输入快照（FidelityTextItem[]）。
 *
 * 用于 Replace Word Fidelity：Comparator 比较
 *   Expected EditableDocument（替换后） vs Export Parsed EditableDocument
 * 两者都转成 FidelityTextItem 快照，保证可比。
 *
 * 这是 Feature 层工具（Edit Text 验收），不碰冻结的 Comparator。
 */

import type { EditableDocument } from "./types";
import type { FidelityTextItem } from "./fidelity-comparator";

/**
 * 把 EditableDocument 转成 FidelityTextItem 快照（按页分组）。
 *
 * 坐标：glyph.bbox 是 CSS 显示坐标，此处转 PDF pt（除以 renderScale*cssScale）。
 * 实际与导出侧都走同一路径，坐标语义一致即可保证可比。
 *
 * @param doc EditableDocument
 * @returns 按页分组的 FidelityTextItem[]
 */
export function documentToFidelityText(
  doc: EditableDocument,
): FidelityTextItem[][] {
  const totalScale = (doc.runtime?.renderScale ?? 1.5) * (doc.runtime?.cssScale ?? 1);
  const pages: FidelityTextItem[][] = [];

  for (const page of doc.pages) {
    const pageItems: FidelityTextItem[] = [];
    for (const block of page.blocks) {
      for (const line of block.lines) {
        for (const glyph of line.glyphs) {
          if (!glyph.char || glyph.char.trim() === "") continue;
          const style = doc.styles[glyph.styleRef];
          pageItems.push({
            text: glyph.char,
            // CSS → PDF pt（Y 翻转：CSS top-down → PDF bottom-up）
            x: round(glyph.bbox.x / totalScale),
            y: round((page.height - glyph.bbox.y - glyph.bbox.height) / totalScale),
            fontSize: style?.fontSize ? style.fontSize / totalScale : 12,
            fontFamily: style?.fontFamily,
          });
        }
      }
    }
    pages.push(pageItems);
  }

  return pages;
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}
