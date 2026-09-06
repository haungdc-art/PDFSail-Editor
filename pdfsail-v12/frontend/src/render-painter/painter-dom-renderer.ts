/**
 * painter-dom-renderer.ts — PainterDOMRenderer（Sprint-74 Task-001）
 *
 * 目的：把 PaintOutput 渲染为 React DOM，真正替换 GlyphRenderer。
 *
 * PM Architecture Decision（Sprint-74）：
 *   PainterRendererStrategy → PaintOutput → PainterDOMRenderer → React
 *
 *   这是第一次真正让 Painter "画东西"（DOM），而非仅输出 PaintOutput。
 *   GlyphRenderer 未来可退休。
 *
 * PM Rule-023：PaintOutput Never Goes Back.
 *   本组件只消费 PaintOutput，绝不回流为 RenderObject / RenderCommand。
 *
 * PM Rule-022：RenderObject Never Created Twice.
 *   本组件不创建 RenderObject。
 *
 * 职责：
 *   - paintOutputToReactElement(output)：PaintOutput → React 元素（纯函数）
 *   - renderPaintOutputsToMarkup(outputs)：SSR 输出 HTML（测试用，验证 DOM 结构）
 *   - PainterDOMLayer：React 组件（未来挂到 PDFCanvas）
 *
 * Pixel 一致性：glyph span 的位置/尺寸/char 完全来自 output.bounds（= RenderCommand 几何），
 * 与 GlyphRenderer 对齐。
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PaintOutput, GlyphPaintOutput } from "./render-painter";

/** 把 PaintOutput 渲染为 React 元素（纯函数，不创建 RenderObject，不回流 PaintOutput） */
export function paintOutputToReactElement(
  output: PaintOutput,
  index: number,
): React.ReactNode {
  const base: React.CSSProperties = {
    position: "absolute",
    left: output.bounds.x,
    top: output.bounds.y,
    width: output.bounds.width,
    height: output.bounds.height,
    zIndex: output.zIndex,
    pointerEvents: "none",
  };

  switch (output.kind) {
    case "glyph": {
      const glyph = output as GlyphPaintOutput;
      return React.createElement(
        "span",
        {
          key: `g_${index}`,
          "data-layer": "glyph",
          style: {
            ...base,
            fontFamily: glyph.fontFamily,
            fontSize: glyph.fontSize,
            color: glyph.color,
            lineHeight: 1,
            // Sprint-76：支持 rotation（paint 语义，来自 PaintOutput，非 Renderer 计算）
            ...(glyph.rotation !== undefined
              ? { transform: `rotate(${glyph.rotation}deg)`, transformOrigin: "0 0" }
              : {}),
          },
        },
        glyph.char,
      );
    }
    case "mask":
      return React.createElement("div", {
        key: `m_${index}`,
        "data-layer": "mask",
        style: { ...base, background: "#ffffff" },
      });
    case "patch":
      return React.createElement("div", {
        key: `p_${index}`,
        "data-layer": "patch",
        style: { ...base, background: "#ffffff" },
      });
  }
}

/** 把 PaintOutput[] 渲染为 React Fragment */
export function PaintOutputsLayer({ outputs }: { outputs: readonly PaintOutput[] }): React.ReactElement {
  return React.createElement(
    "div",
    { "data-layer": "painter" },
    outputs.map((o, i) => paintOutputToReactElement(o, i)),
  );
}

/** SSR：渲染为 HTML 字符串（测试用，验证 DOM 结构与输入几何一致） */
export function renderPaintOutputsToMarkup(outputs: readonly PaintOutput[]): string {
  const node = React.createElement(
    "div",
    { "data-layer": "painter" },
    outputs.map((o, i) => paintOutputToReactElement(o, i)),
  );
  return renderToStaticMarkup(node);
}
