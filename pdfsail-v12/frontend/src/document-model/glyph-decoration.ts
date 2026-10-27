/**
 * glyph-decoration.ts — F3B-6.21-H1-C2
 *
 * 从 `EditableStyle`（由 Core `TextStyle.underline` / `strike` 经 `toEditableStyle` 透传）
 * 派生字形装饰（下划线 / 删除线）的绘制描述。
 *
 * 几何契约（硬约束，来自 H1-C1 审计 + 用户裁决）：
 *  - 装饰定位**只**来自 `DrawGlyphCommand` 的真实 glyph box（x/y/width/height）；
 *    **绝不**引入 font metric / canvas 测量 / renderer-local magic offset。
 *  - 下划线 = box 底部；删除线 = box 中部。位置以 box 相对分数表达，与 box 像素尺寸解耦。
 *  - 线宽从 `fontSize` 确定性派生（`Math.max(1, Math.round(fontSize / 14))`），不依赖任何测量。
 *
 * 装饰来源**只**是 Core `TextStyle`（经 `toEditableStyle` 透传）；本模块不读取 DOM、
 * 不推断 `<u>` / `<s>`、不触碰 fontWeight / fontStyle / History / SetTextStyleCommand。
 *
 * 本模块是纯函数（零 React / 零 DOM 依赖），既供 `glyph-renderer.tsx` 渲染，
 * 也供 C2-A 单元测试断言几何派生。
 */

import type { EditableStyle } from "./types";

export type GlyphDecorationKind = "underline" | "strike";

export interface GlyphDecoration {
  kind: GlyphDecorationKind;
  /**
   * Box-relative placement（glyph box 的相对分数，font-metric-free → 无 magic offset）。
   * 下划线 → line 在 box 底部（topFrac = 1）；删除线 → line 在 box 中部（topFrac = 0.5）。
   * leftFrac/widthFrac 恒为 0/1（装饰横跨整个 glyph box 宽度）。
   */
  leftFrac: number;
  widthFrac: number;
  topFrac: number;
  /** 线宽：从 fontSize 确定性派生（不依赖测量）。 */
  thickness: number;
  /** 装饰颜色：沿用文本 color。 */
  color: string;
  /**
   * 绝对 box-relative 位置（仅当传入 `box` 时填充），用于几何派生测试断言。
   * left = box.x；top（underline）= box.y + box.height（box 底部）；
   * top（strike）= box.y + box.height * 0.5（box 中部）；width = box.width。
   */
  left?: number;
  top?: number;
  width?: number;
}

/**
 * 派生某个 glyph 的装饰绘制描述。
 *
 * @param style  该 glyph 的 `EditableStyle`（可能缺省 / undefined → 无装饰）
 * @param box    可选的真实 glyph box；传入时同时计算绝对位置供测试
 */
export function buildGlyphDecorations(
  style: EditableStyle | undefined | null,
  box?: { x: number; y: number; width: number; height: number }
): GlyphDecoration[] {
  if (!style) return [];
  const out: GlyphDecoration[] = [];
  const fontSize = typeof style.fontSize === "number" ? style.fontSize : 14;
  const thickness = Math.max(1, Math.round(fontSize / 14));
  const color = style.color || "#000000";

  if (style.underline) {
    out.push({
      kind: "underline",
      leftFrac: 0,
      widthFrac: 1,
      topFrac: 1,
      thickness,
      color,
      left: box ? box.x : undefined,
      top: box ? box.y + box.height : undefined,
      width: box ? box.width : undefined,
    });
  }
  if (style.strike) {
    out.push({
      kind: "strike",
      leftFrac: 0,
      widthFrac: 1,
      topFrac: 0.5,
      thickness,
      color,
      left: box ? box.x : undefined,
      top: box ? box.y + box.height * 0.5 : undefined,
      width: box ? box.width : undefined,
    });
  }
  return out;
}
