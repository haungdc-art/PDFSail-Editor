/**
 * dispatcher-glyph-layer.tsx — DispatcherGlyphLayer（Sprint-75 Task-001）
 *
 * 目的：PDFCanvas 通过本组件接入 Dispatcher，默认走 Legacy，可 Feature Flag 切 Painter。
 *
 * PM Architecture Decision（Sprint-75：Mainline Mount）：
 *   PDFCanvas → Dispatcher → Registry → Legacy Strategy（默认）→ GlyphRenderer
 *                                     → Painter Strategy（可选）→ PaintOutputsLayer
 *
 *   这是第一次真正替换生产入口（PDFCanvas 挂载点）。
 *   默认 Legacy：GlyphRenderer 零修改，Pixel 完全一致，可回滚（PM Rule-018）。
 *
 * PM Rule-024：Renderer Never Owns Style（本组件只消费 Style，不计算）。
 * PM Rule-025：DOM Is Only Projection（本组件不把 DOM 写回 Engine）。
 * PM Rule-022/023：不重复创建 RenderObject，PaintOutput 不回流。
 *
 * Feature Flag：window.__rendererMode = "legacy"（默认）| "painter"。
 */

import * as React from "react";
import { GlyphRenderer } from "../document-model/glyph-renderer";
import type { GlyphRendererProps } from "../document-model/glyph-renderer";
import { LegacyRendererStrategy } from "./renderer-strategy";
import type { RendererStrategy } from "./renderer-strategy";
import { PainterRendererStrategy } from "./painter-renderer-strategy";
import { dispatchRenderer } from "./renderer-dispatcher";
import { createDefaultRegistry } from "../renderer-registry/renderer-registry";
import { PaintOutputsLayer } from "../render-painter/painter-dom-renderer";
import { computeShadowMetrics, outputsToGeom, objectsToGeom } from "./shadow-metrics";

/**
/**
 * 读取 Feature Flag。
 * PM 裁决（Sprint-77 Hold）：Sprint-77B（Production Ready）未通过，
 * Default 必须保持 legacy（PM Rule-030：Default Never Ahead Of Validation）。
 * - window.__rendererMode = "painter" → 显式切 Painter（测试/验证用）
 * - 缺省 / "legacy" → Legacy（默认，生产）
 */
export function getRenderMode(): "legacy" | "painter" {
  if (typeof window !== "undefined") {
    const m = (window as any).__rendererMode;
    if (m === "painter") return "painter";
  }
  return "legacy";
}

/** 是否启用 Shadow Mode（painter 渲染时同时跑 legacy 收集 diff，Sprint-77 Acceptance ⑥） */
export function isShadowModeEnabled(): boolean {
  if (typeof window !== "undefined") {
    return (window as any).__rendererShadow === true;
  }
  return false;
}

/**
 * DispatcherGlyphLayer — PDFCanvas 的 Glyph 渲染总入口。
 *
 * 内部：
 *   1. 建立 Registry（预注册 legacy）
 *   2. 若 painter 模式，注册 PainterRendererStrategy
 *   3. 通过 Dispatcher.dispatchRenderer(mode, ...) 选 Strategy
 *   4. 根据 strategy 渲染：
 *      - legacy → <GlyphRenderer {...props} />（零修改，Pixel 一致）
 *      - painter → <PaintOutputsLayer outputs={paintOutputs} />（Prototype）
 */
export function DispatcherGlyphLayer(props: GlyphRendererProps) {
  const mode = getRenderMode();
  const shadowEnabled = isShadowModeEnabled();

  // 建立 Registry（Sprint-77：始终注册 legacy + painter，保证可切换）
  const registryRef = React.useRef<{ legacy: RendererStrategy; painter: RendererStrategy } | null>(null);
  if (!registryRef.current) {
    registryRef.current = {
      legacy: new LegacyRendererStrategy(),
      painter: new PainterRendererStrategy(),
    };
  }

  const result = React.useMemo(
    () =>
      dispatchRenderer(mode, {
        commands: props.commands,
        styles: props.styles,
      }, createDefaultRegistry(registryRef.current!.legacy, "legacy")),
    [mode, props.commands, props.styles],
  );

  // Shadow Mode（Sprint-78 Task-003：升级为渲染指标，PM Rule-031）
  // painter 渲染时同时采集 legacy 几何，计算 BBox/Rotation/Mask/Patch/Timing diff。
  if (shadowEnabled && mode === "painter") {
    try {
      const start = typeof performance !== "undefined" ? performance.now() : 0;
      // painter 几何：来自 result.renderObjects（RenderObject[]）
      const painterGeom = result.renderObjects ? objectsToGeom(result.renderObjects) : [];
      // legacy 几何：从 RenderCommand 提取（drawGlyph/drawLine mask）
      const legacyGeom: { x: number; y: number; width: number; height: number; kind: "glyph" | "mask" | "patch"; rotation?: number }[] = [];
      for (const cmd of props.commands) {
        if (cmd.type === "drawGlyph") {
          legacyGeom.push({ x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height, kind: "glyph" });
        } else if (cmd.type === "drawLine" && (cmd as any).purpose === "mask") {
          const c = cmd as any;
          legacyGeom.push({ x: c.x, y: c.y, width: c.width, height: c.height, kind: "mask" });
        }
      }
      const paintTime = typeof performance !== "undefined" ? performance.now() - start : 0;
      const metrics = computeShadowMetrics(legacyGeom, painterGeom, paintTime, 0);
      if (typeof window !== "undefined") {
        (window as any).__rendererShadowMetrics = metrics;
      }
    } catch {
      // Shadow 采集失败不影响主渲染
    }
  }

  if (result.strategy === "painter") {
    // Painter（Default）：PaintOutput → React DOM
    return <PaintOutputsLayer outputs={result.paintOutputs ?? []} />;
  }

  // Legacy（Feature Flag 显式切回）：GlyphRenderer 零修改，完整 props 透传（含交互）
  return <GlyphRenderer {...props} />;
}
