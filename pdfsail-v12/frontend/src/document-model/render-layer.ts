/**
 * RenderLayer — Sprint34.1: 统一渲染层级常量。
 *
 * 单一事实来源，替代散落的魔法 z-index（如 99999）。
 *
 * 层级约定（自底向上）：
 *   IMAGE     0    PDF 原始位图 canvas
 *   PATCH     10   背景恢复层（BackgroundPatchLayer <img>）
 *   GLYPH     30   Glyph 渲染层（逐字 span + mask）
 *   SELECTION 60   选区高亮层
 *   EDITOR    100  文本编辑层（textarea / contentEditable）
 *
 * 原则：
 *   - 编辑层必须高于 glyph 层，否则编辑框被原文覆盖。
 *   - 禁止再引入 > GLYPH 的魔法值（除非确实是编辑器之上的临时浮层）。
 */
export const RenderLayer = {
  IMAGE: 0,
  PATCH: 10,
  GLYPH: 30,
  SELECTION: 60,
  EDITOR: 100,
} as const;

export type RenderLayerKey = keyof typeof RenderLayer;
