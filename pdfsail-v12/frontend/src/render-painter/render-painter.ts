/**
 * render-painter.ts — RenderObjectPainter（Sprint-69 Task-001）
 *
 * 目的：把 RenderObject 的绘制语义集中到 Painter。
 *
 * PM Architecture Decision（Sprint-69）：
 *   Semantic → Layout → RenderContext（数据准备层）
 *                          ↓
 *                        RenderObject（绘制模型）
 *                          ↓
 *                        Painter（绘制）→ Renderer（调度）
 *
 * PM Rule-015：RenderObject owns paint semantics, never document semantics.
 *   - Painter 只消费 paint 数据（bounds / coverage / opacity / blendMode / zIndex / clip）
 *   - Painter 永远不接触 paragraph / sentence / language / OCR / Semantic / Document
 *
 * PM 建议（统一 bounds）：
 *   - 所有 RenderObject 拥有 `bounds`
 *   - Renderer / Painter 只看 `object.bounds`，不做 if Patch/Mask/Glyph
 *   - 对象内部自己决定 bounds 来自 maskBounds / coverageBounds / patchBounds
 *
 * PM Rule-014：Migration builds compatibility, not replacement.
 *   - 本任务 **新增** Painter，**不删** 旧 Renderer
 *   - Prototype Only：Painter 是独立新路径，未接入 Mainline
 *
 * Pure Function（ADR-005）：输入 RenderObject，输出 PaintOutput。
 * 不依赖 DOM / Canvas / Renderer。
 */

import type { RenderObject, GlyphObject, PatchObject, MaskObject, RenderBounds } from "../render-object/render-object";

/** Painter 输出的统一绘制描述 */
export interface PaintOutput {
  readonly kind: string;
  /** 统一边界（来自 object.bounds） */
  readonly bounds: RenderBounds;
  /** z-index（绘制顺序） */
  readonly zIndex: number;
  /** 渲染层级语义 */
  readonly layer: "glyph" | "mask" | "patch";
}

/** Glyph 绘制输出 */
export interface GlyphPaintOutput extends PaintOutput {
  readonly kind: "glyph";
  readonly char: string;
  readonly fontFamily?: string;
  readonly fontSize?: number;
  readonly color?: string;
  readonly baseline?: number;
  /** CSS 旋转角度（度，Sprint-76 支持 rotation；paint 语义） */
  readonly rotation?: number;
}

/** Mask 绘制输出（白色遮盖原文） */
export interface MaskPaintOutput extends PaintOutput {
  readonly kind: "mask";
  readonly fill: string;
  readonly opacity: number;
}

/** Patch 绘制输出（签名背景恢复图像） */
export interface PatchPaintOutput extends PaintOutput {
  readonly kind: "patch";
  /** patch 图像引用（Sprint-71 接入） */
  readonly patchRef?: string;
  readonly opacity: number;
}

/** RenderObjectPainter 接口（PM Acceptance ①） */
export interface RenderObjectPainter {
  /** 统一绘制入口：按 kind 分发到 paintGlyph / paintMask / paintPatch */
  paint(object: RenderObject): PaintOutput;
  paintGlyph(object: GlyphObject): GlyphPaintOutput;
  paintMask(object: MaskObject): MaskPaintOutput;
  paintPatch(object: PatchObject): PatchPaintOutput;
}

/** 把 RenderObject 转为 PaintOutput（统一入口，Prototype Only） */
export function paintObject(object: RenderObject): PaintOutput {
  switch (object.kind) {
    case "glyph":
      return paintGlyphObject(object);
    case "mask":
      return paintMaskObject(object);
    case "patch":
      return paintPatchObject(object);
  }
}

/** 绘制 GlyphObject（只看 object.bounds / char / style） */
export function paintGlyphObject(object: GlyphObject): GlyphPaintOutput {
  const style = object.style as { fontFamily?: string; fontSize?: number; color?: string };
  return {
    kind: "glyph",
    bounds: object.bounds,
    char: object.char,
    fontFamily: style?.fontFamily,
    fontSize: style?.fontSize ?? object.metrics.fontSize,
    color: style?.color,
    baseline: object.baseline,
    rotation: object.rotation,
    zIndex: 2,
    layer: "glyph",
  };
}

/** 绘制 MaskObject（白色遮盖原文） */
export function paintMaskObject(object: MaskObject): MaskPaintOutput {
  return {
    kind: "mask",
    bounds: object.bounds,
    fill: "#ffffff",
    opacity: 1,
    zIndex: 1,
    layer: "mask",
  };
}

/** 绘制 PatchObject（签名背景恢复图像） */
export function paintPatchObject(object: PatchObject): PatchPaintOutput {
  return {
    kind: "patch",
    bounds: object.bounds,
    patchRef: object.patchRef,
    opacity: 1,
    zIndex: 0,
    layer: "patch",
  };
}
