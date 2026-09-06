/**
 * view-mode.ts — M7.6-IMPLEMENT-001 · Native Canvas Display feature flag
 *
 * 目标：把 GlyphRenderer 从「主显示层」降级为「编辑增强层」。
 *
 * render mode（二值）：
 *   - "native-canvas"  （默认）: pdf.js canvas 是唯一视觉源；隐藏 glyph white-mask 与重绘 span，
 *                              但保留 glyph hit-testing / selection geometry（几何层不可见但可交互）。
 *   - "legacy-glyph"：旧行为，glyph 层（mask + span）可见并作为主显示层。
 *
 * 读取优先级：
 *   1. window.__nativeCanvas = "native-canvas" | "legacy-glyph"（显式切换，便于回滚）
 *   2. 缺省 → "native-canvas"
 *
 * 边界：只控制显示层；不改 TextOperation / EditSession / Undo / Export / Font parser / Selection model。
 */

export type ViewRenderingMode = "native-canvas" | "legacy-glyph";

/** 当前渲染模式（feature flag，默认 native-canvas） */
export function getViewRenderingMode(): ViewRenderingMode {
  if (typeof window !== "undefined") {
    const m = (window as any).__nativeCanvas as string | undefined;
    if (m === "native-canvas" || m === "legacy-glyph") return m;
  }
  // 默认：canvas 为唯一视觉源
  return "native-canvas";
}