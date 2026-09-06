/**
 * Sprint 29 / 31.2: Background Patch Layer
 *
 * 职责：只渲染 DrawImageCommand[] → <img>，不混入 GlyphRenderer。
 * z-index: 10（在 canvas 0 之上、glyph 30 之下）
 */

import React, { useEffect, useRef } from "react";
import type { DrawImageCommand } from "./render-command";
import { RenderLayer } from "./render-layer";

export interface BackgroundPatchLayerProps {
  images: DrawImageCommand[];
  /** 选中的 glyph ID 集合（控制 opacity，继承自 GlyphRenderer 的 interactive 逻辑） */
  children?: React.ReactNode;
}

export const BackgroundPatchLayer: React.FC<BackgroundPatchLayerProps> = ({
  images,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  // Debug: 暴露 window.__sprint29_layerTree()
  useEffect(() => {
    if (typeof window === "undefined") return;

    (window as any).__sprint29_layerTree = () => {
      const patchEl = containerRef.current;
      const patchComputed = patchEl ? getComputedStyle(patchEl) : null;

      const canvasEl = document.querySelector('[data-layer="pdf-canvas"]');
      const canvasComputed = canvasEl ? getComputedStyle(canvasEl) : null;

      const glyphEl = document.querySelector(".pdf-glyph-layer");
      const glyphComputed = glyphEl ? getComputedStyle(glyphEl) : null;

      const result = {
        canvas: {
          zIndex: canvasComputed ? parseInt(canvasComputed.zIndex, 10) || "auto" : null,
        },
        patchLayer: {
          zIndex: patchComputed ? parseInt(patchComputed.zIndex, 10) || "auto" : null,
          imgCount: patchEl ? patchEl.querySelectorAll("img").length : 0,
        },
        glyphLayer: {
          zIndex: glyphComputed ? parseInt(glyphComputed.zIndex, 10) || "auto" : null,
        },
      };

      console.log("[Sprint 29] layerTree:", result);
      return result;
    };

    return () => {
      delete (window as any).__sprint29_layerTree;
    };
  }, [images.length]);

  if (!images || images.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="pdf-background-patch-layer"
      data-layer="backgroundPatch"
      style={{
        position: "absolute",
        inset: 0,
        zIndex: RenderLayer.PATCH,
        pointerEvents: "none",
      }}
    >
      {images.map((cmd, i) => {
        const key = cmd.patchId ?? `bg-patch-${i}`;

        // Sprint34.11: 图片旋转支持。
        // 旋转原点与 glyph 签名区一致（transform-origin: left top，即 bbox 左上角），
        // 不引入新的 transform 系统，仅当 rotation 存在时叠加 rotate()。
        const rot = cmd.rotation ?? 0;
        const hasRot = Math.abs(rot) > 0.01;

        // Sprint34.11 Debug: 输出图片 rotation（确认 background patch 是否继承签名旋转）
        if (typeof console !== "undefined" && (cmd as any).patchId?.toString().startsWith("sig-patch")) {
          console.log(
            `%c[Sprint34.11][BgImage] patchId=${cmd.patchId} rotation=${rot} hasRot=${hasRot} bbox=(x=${Math.round(cmd.x)},y=${Math.round(cmd.y)},w=${Math.round(cmd.width)},h=${Math.round(cmd.height)})`,
            "color:#0ea5e9;",
          );
        }

        return (
          <img
            key={key}
            src={cmd.src}
            alt="background-patch"
            data-layer="backgroundPatch"
            data-sprint29-patch="true"
            data-patch-id={typeof key === "string" ? key : String(key)}
            style={{
              position: "absolute",
              left: cmd.x,
              top: cmd.y,
              width: cmd.width,
              height: cmd.height,
              pointerEvents: "none",
              imageRendering: "auto",
              // Sprint34.11: 与 glyph 使用同一 rotation，绕 bbox 左上角旋转
              transform: hasRot ? `rotate(${rot}deg)` : undefined,
              transformOrigin: "left top",
            }}
          />
        );
      })}
    </div>
  );
};
