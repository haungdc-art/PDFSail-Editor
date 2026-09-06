/**
 * SelectionHighlightLayer — 编辑态 selection 高亮（M7.7-002 + M7.7-003）
 *
 * 在 PDFCanvas 的 wrapper（position: relative）内渲染编辑 selection 的高亮。
 * 位置来自 selectionHighlightQuads（旋转四边形，世界 CSS 坐标）。
 *
 * M7.7-003 升级：不再渲染轴对齐矩形，而是用 `clip-path: polygon(...)` 渲染
 * **沿文字方向的旋转四边形** —— 旋转/倾斜文本的 selection 高亮与文字对齐
 * （Adobe 行为），横向文本退化为普通矩形。
 *
 * 职责：纯视觉呈现。不接收 keyboard / mutation。
 *
 * 约束（Native Canvas Invariant）：Canvas 仍是唯一视觉源 —— 高亮是叠加层，
 * 不重建文本，不改 Canvas 像素。
 */
import React from "react";
import { quadBounds, quadClipPath, type GlyphQuad } from "../../document-model/edit-transform-geometry";

export function SelectionHighlightLayer({ quads }: { quads?: ReadonlyArray<GlyphQuad> }) {
  if (!quads || quads.length === 0) return null;
  return (
    <>
      {quads.map((q, i) => {
        const b = quadBounds(q);
        return (
          <div
            key={i}
            data-selection-highlight="1"
            style={{
              position: "absolute",
              left: b.x,
              top: b.y,
              width: b.width,
              height: b.height,
              clipPath: quadClipPath(q),
              background: "rgba(59,130,246,0.35)",
              pointerEvents: "none",
              zIndex: 40,
            }}
          />
        );
      })}
    </>
  );
}
