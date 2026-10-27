/**
 * core-editing-geometry.ts — EDITOR-CORE-012-E2（方案 B）
 *
 * **纯函数**：把 CORE-006-B 的 caret / selection 几何映射到既有 UI 层能消费的形状。
 *
 *     CaretGeometry      → CaretLayerPosition   （CaretLayer）
 *     SelectionGeometry  → GlyphQuad[]          （SelectionHighlightLayer）
 *
 * ── 为什么不需要坐标系变换 ─────────────────────────────────────────
 *   · `CaretGeometry` 的注释明确写着 **"插入点在 Page Canvas Space 中的位置"**
 *   · `SelectionGeometry.quads` 与 `GlyphLayout.box` 同空间（`Rect`）
 *   · `render-command-bridge.ts:199-202` 直接把 `glyph.box.x/y` 当 `RenderCommand.bounds`
 *     使用，且 012-A 已用真实 `GlyphRenderer` 验证过落点正确
 *     （导入时 TextBox 原点取自 legacy line 的 bbox，因此 **layout 空间 ≡ 页面 CSS 空间**）
 * → 两处映射都是**字段级直通**，没有缩放 / 偏移 / 旋转。
 *
 * ⚠️ 唯一已知损失：Core layout **没有旋转概念**，而 legacy 的 `resolveCaretPosition` 会
 * 用 `glyph.transform` 处理旋转/倾斜文本。因此 **Core 模式下旋转文本的 caret/selection
 * 退化为轴对齐**（本模块不猜旋转）。这是 012-E2 的已知限制，已记录。
 *
 * ── 依赖 ───────────────────────────────────────────────────────────
 * 只 import **类型**（Core 几何 + UI/旧 DTO 形状）。零运行时依赖、不 import React。
 */

import type { CaretGeometry, SelectionGeometry } from "../core/layout";
import type { CaretLayerPosition } from "./CaretLayer";
import type { GlyphQuad } from "../../document-model/edit-transform-geometry";

/** `CaretGeometry` → `CaretLayerPosition`（字段直通；无几何则返回 null，不伪造） */
export function coreCaretLayerPosition(
  geometry: CaretGeometry | null | undefined
): CaretLayerPosition | null {
  if (!geometry) return null;
  if (!Number.isFinite(geometry.x) || !Number.isFinite(geometry.y)) return null;
  if (!Number.isFinite(geometry.height) || geometry.height <= 0) return null;
  return { x: geometry.x, y: geometry.y, height: geometry.height };
}

/**
 * `SelectionGeometry.quads` → `GlyphQuad[]`。
 *
 * 轴对齐矩形 → 四角（**顺时针**：左上 → 右上 → 右下 → 左下）。
 * `SelectionHighlightLayer` 用 `clip-path: polygon(...)` 消费，环形顺序即可。
 * 退化矩形（宽或高 ≤ 0）被丢弃，不产出零面积 polygon。
 */
export function coreSelectionQuads(
  geometry: SelectionGeometry | null | undefined
): GlyphQuad[] {
  if (!geometry || geometry.quads.length === 0) return [];
  const out: GlyphQuad[] = [];
  for (const rect of geometry.quads) {
    if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue;
    if (!(rect.width > 0) || !(rect.height > 0)) continue;
    const { x, y, width, height } = rect;
    out.push({
      p1: { x, y },
      p2: { x: x + width, y },
      p3: { x: x + width, y: y + height },
      p4: { x, y: y + height },
    });
  }
  return out;
}
