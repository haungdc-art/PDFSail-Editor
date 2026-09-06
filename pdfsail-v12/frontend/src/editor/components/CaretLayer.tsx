/**
 * CaretLayer — Visual Caret（M5-IMPLEMENT-003B-UI）
 *
 * 在 PDFCanvas 的 wrapper（position: relative）内渲染编辑光标（竖线）。
 * 位置来自 resolveCaretPosition（glyph bbox 的 CSS 坐标），**非** textarea DOM position。
 *
 * 职责：纯视觉呈现。不接收 keyboard / selection / mutation。
 * caretPosition 由父组件（PDFEditor）用 resolveCaretPosition(doc, glyphCaret) 计算。
 */
import React from "react";

export interface CaretLayerPosition {
  x: number;
  y: number;
  height: number;
  /** M7.7-002: 旋转角度（deg，0 = 水平文本） */
  rotation?: number;
}

export function CaretLayer({ position }: { position: CaretLayerPosition | null }) {
  if (!position) return null;
  const rotation = position.rotation ?? 0;
  return (
    <div
      data-caret="caret"
      style={{
        position: "absolute",
        left: position.x,
        top: position.y,
        width: 2,
        height: position.height,
        background: "#2563eb",
        pointerEvents: "none",
        zIndex: 40,
        // M7.7-002: 旋转文本 → caret 随 glyph 旋转（transform-origin 顶部，保持文本轴垂直）
        transform: rotation !== 0 ? `rotate(${rotation}deg)` : undefined,
        transformOrigin: "0 0",
      }}
    />
  );
}
