/**
 * coordinate-transform.ts — M7.7-IMPLEMENT-004: Screen → Document 坐标归一化
 *
 * 背景（M7.7-DEBUG-001 根因）：
 *   flow glyph bbox / RenderCommand / glyph span 的坐标是 **Document Space**
 *   （CSS 布局像素，glyph 容器内坐标系，未缩放）。
 *   鼠标事件 clientX/clientY 与 getBoundingClientRect() 是 **Screen Space**
 *   （视觉像素，browser zoom / DPR / CSS transform 会放大）。
 *   在 zoom≠100% 时两者相差一个「容器视觉缩放 scale」；若不归一化，
 *   boundaryFromPoint 命中测试会偏移 scale 倍 → 编辑框开错行/无法打开、
 *   glyphCaretFromClick 光标落到错误字符（输入插中间）。—— 用户看到的
 *   「编辑框没贴原文 + 编辑后不能保存」的根因。
 *
 * 坐标系约定：
 *   - Document Space：CSS 布局坐标（未缩放）。glyph span / flow bbox /
 *     RenderCommand / TextEditOverlay.bbox 所在空间。
 *   - Screen Space：getBoundingClientRect() / clientX/clientY 所在空间（已缩放）。
 *   - scale（容器视觉缩放）= Screen px / Document px；zoom=100% 时为 1。
 *
 * 设计决策：
 *   - 所有「事件坐标 → Document 坐标」的转换统一收敛到本模块，不散落硬编码 x/zoom。
 *   - scale 作为参数注入，由调用方经 resolveContainerScale 从容器几何推导。
 *     该比值是 Document→Screen 的真实缩放，天然涵盖 browser zoom / DPR /
 *     CSS transform / fit-width 等一切视觉缩放；未来引入 documentScale 状态时，
 *     只需替换 resolveContainerScale 的实现，调用方与转换函数不变。
 */

/** 与 DOMRect 子集兼容的容器几何（Screen Space，来自 getBoundingClientRect） */
export interface ContainerRectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * 解析容器 Document→Screen 缩放系数。
 * clientWidth = 布局 CSS px（未缩放）；rect.width = 视觉 px（已缩放）。
 * 比值即 screen px / document px；zoom=100%（无视觉缩放）时为 1。
 * 兜底：clientWidth 非法 / 比值过小 → 1（无缩放，行为同旧实现）。
 */
export function resolveContainerScale(rect: ContainerRectLike, clientWidth: number): number {
  const s = clientWidth > 0 ? rect.width / clientWidth : 1;
  return s > 0.01 ? s : 1;
}

/**
 * Screen 本地点（相对容器视觉左上角）→ Document 点（glyph 容器坐标系）。
 * @param cssLocalPoint 相对容器视觉左上角的偏移：{ x: e.clientX - rect.left, y: e.clientY - rect.top }
 * @param scale Document→Screen 缩放系数（resolveContainerScale 产出）
 */
export function screenPointToDocumentPoint(
  cssLocalPoint: { x: number; y: number },
  rect: ContainerRectLike,
  scale: number,
): { x: number; y: number } {
  // rect 仅作契约占位（后续 fit-width/rotation 可能基于它做更复杂变换）。
  void rect;
  return {
    x: cssLocalPoint.x / scale,
    y: cssLocalPoint.y / scale,
  };
}

/**
 * 一站式便捷函数：事件坐标 + 容器几何 → Document 点。
 * 供 GlyphRenderer.pointFromEvent 使用（click / drag / dblclick 命中测试统一入口）。
 */
export function eventPointToDocumentPoint(
  clientX: number,
  clientY: number,
  rect: ContainerRectLike,
  clientWidth: number,
): { x: number; y: number } {
  const scale = resolveContainerScale(rect, clientWidth);
  return screenPointToDocumentPoint(
    { x: clientX - rect.left, y: clientY - rect.top },
    rect,
    scale,
  );
}
