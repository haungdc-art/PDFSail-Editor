/**
 * LayoutResultAdapter — 纯映射（Pure Mapper）
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 3B
 *
 * 职责：Merge
 *   FactsSnapshot（Content） + LayoutResult（Geometry） → RenderCommand[]
 *
 * ADR-003 约束（冻结）：
 *   - 只允许按 blockId + lineId + glyphIndex 关联。
 *   - 禁止任何 Layout 计算逻辑：measureText / wrap / layout / overflow /
 *     region 判断 / layoutMode 判断 / OCR 判断。
 *   - 不依赖 EditableDocument 的 Layout 字段。
 *   - 若出现 if(layoutMode)/if(regionType) → 说明 Layout Engine 职责泄漏。
 *
 * 三层输入（避免 renderAssets 变成 God Object）：
 *   EditableDocument → Facts（Content）
 *   Layout Engine → LayoutResult（Geometry）
 *   Adapter → RenderCommand（Renderer 唯一输入）
 */

import type { FactsSnapshot, FactGlyph } from "./facts-snapshot";
import type { LayoutResult } from "./layout-result";
import type { RenderCommand } from "./render-command";
import { isDrawGlyph } from "./render-command";
import type { TransformMatrix } from "./types";

/** 由 blockId + lineId + glyphIndex 定位 Content glyph 的索引 */
interface ContentIndex {
  /** blockId → lineId → FactGlyph[]（按 glyphIndex 对齐 LayoutResult） */
  get: (blockId: string, lineId: string, glyphIndex: number) => FactGlyph | undefined;
}

function buildContentIndex(facts: FactsSnapshot): ContentIndex {
  const blockMap = new Map<string, Map<string, FactGlyph[]>>();
  for (const page of facts.pages) {
    for (const block of page.blocks) {
      const lineMap = new Map<string, FactGlyph[]>();
      for (const line of block.lines) {
        lineMap.set(line.lineId, [...line.glyphs]);
      }
      blockMap.set(block.blockId, lineMap);
    }
  }
  return {
    get(blockId, lineId, glyphIndex) {
      const lines = blockMap.get(blockId);
      if (!lines) return undefined;
      const glyphs = lines.get(lineId);
      if (!glyphs) return undefined;
      return glyphs[glyphIndex];
    },
  };
}

/**
 * 纯映射：把 FactsSnapshot + LayoutResult 合并为 RenderCommand[]。
 * 无任何 Layout 计算，只做几何 + Content 的关联拼接。
 */
export function buildRenderCommands(
  facts: FactsSnapshot,
  layout: LayoutResult
): RenderCommand[] {
  const content = buildContentIndex(facts);
  const commands: RenderCommand[] = [];

  for (const page of layout.pages) {
    for (const block of page.blocks) {
      for (const line of block.lines) {
        line.glyphs.forEach((glyph, glyphIndex) => {
          const fact = content.get(block.blockId, line.lineId, glyphIndex);
          if (!fact) return; // Content 缺失（不应发生）；跳过，避免错误命令

          commands.push({
            type: "drawGlyph",
            char: fact.char,
            x: glyph.bbox.x,
            y: glyph.bbox.y,
            width: glyph.bbox.width,
            height: glyph.bbox.height,
            styleRef: fact.styleRef,
            blockId: fact.blockId,
            lineId: fact.lineId,
            modified: fact.modified,
            transform: glyph.transform as TransformMatrix | undefined,
          });
        });
      }
    }
  }

  return commands;
}

/** 纯映射的 glyph 列表（供 Diff 验证比较几何与数量） */
export function toGlyphCommands(
  facts: FactsSnapshot,
  layout: LayoutResult
): Extract<RenderCommand, { type: "drawGlyph" }>[] {
  return buildRenderCommands(facts, layout).filter(isDrawGlyph);
}
