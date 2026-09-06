/**
 * render-object.ts — RenderObject（Sprint-68 Task-001）
 *
 * 目的：把 Renderer 的消费模型从"glyph 级 RenderContext"收敛为"统一的 RenderObject"。
 *
 * PM Architecture Decision（Sprint-68）：
 *   目前 RenderContext 是 **Glyph 级别**，而 Patch / Mask / Highlight / Selection 是 **Region 级别**。
 *   未来 Renderer 真正消费的应是 **RenderObject**（统一模型）：
 *
 *     GlyphObject / PatchObject / MaskObject / SelectionObject / HighlightObject
 *        ↓
 *     Renderer.paint(RenderObject)
 *
 *   RenderContext（glyph 级，Sprint-67）保留，本任务建立新模型并从 RenderContext 转换。
 *
 * PM Rule-014：Migration builds compatibility, not replacement。
 *   - 本任务 **新增** RenderObject，**不删** RenderContext。
 *   - RenderContext → RenderObject 的转换函数是 New Path。
 *   - Old Path（Renderer 直接消费 RenderContext）保留，直到 Consumer 100% 切换。
 *
 * 数据流（目标）：
 *   RenderContext[]（glyph 级）
 *        ↓
 *   renderContextToRenderObjects()   ← 本文件
 *        ↓
 *   RenderObject[]（GlyphObject / PatchObject / MaskObject）
 *        ↓
 *   Renderer.paint(RenderObject)（零修改，Task-003 后切换）
 *
 * 设计：
 *   同一 run 的多个 glyph 共享同一 visualCoverage。
 *   因此转换时按 runId 分组：
 *     - 每个 run → 1 个 MaskObject（coverage.maskBounds）
 *     - 每个 run → 1 个 PatchObject（coverage.patchBounds）
 *     - 每个 glyph → 1 个 GlyphObject
 *
 * Pure Function（ADR-005）：输入 RenderContext[]，输出 RenderObject[]。
 * Immutable（Readonly）。
 */

import type { RenderContext, RenderCoverage } from "../render-context/render-context";
import type { BBox } from "../document-model/types";

/** RenderObject 判别类型 */
export type RenderObjectType = "glyph" | "patch" | "mask";

/**
 * RenderObject — Renderer 唯一消费的统一模型（联合）。
 * Renderer 只 paint(RenderObject)，不再区分 glyph/patch/mask 的数据来源。
 */
export type RenderObject = GlyphObject | PatchObject | MaskObject;

/**
 * RenderBounds — 统一边界（PM 建议：所有 RenderObject 拥有 bounds）。
 * Renderer 永远只看 object.bounds，不做 if Patch/Mask/Glyph。
 */
export interface RenderBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Glyph 渲染对象（glyph 级） */
export interface GlyphObject {
  readonly kind: "glyph";
  readonly id: string;
  readonly char: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 统一边界（Renderer 只看它） */
  readonly bounds: RenderBounds;
  readonly baseline?: number;
  readonly blockId: string;
  readonly lineId: string;
  readonly metrics: Readonly<{
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly baseline: number;
    readonly ascent: number;
    readonly descent: number;
    readonly advanceWidth: number;
    readonly letterSpacing: number;
  }>;
  readonly style: Readonly<Record<string, unknown>>;
  readonly coverage: RenderCoverage;
  /** CSS 旋转角度（度，顺时针为正，Sprint-76 支持 rotation；paint 语义） */
  readonly rotation?: number;
}

/** Patch 渲染对象（region 级：签名背景恢复） */
export interface PatchObject {
  readonly kind: "patch";
  readonly id: string;
  /** patch 范围（coverage.patchBounds） */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 统一边界（Renderer 只看它） */
  readonly bounds: RenderBounds;
  readonly blockId: string;
  readonly coverage: RenderCoverage;
  /** 未来承载 patch 图像引用（Sprint-70 Patch Migration） */
  readonly patchRef?: string;
}

/** Mask 渲染对象（region 级：白色遮盖原文） */
export interface MaskObject {
  readonly kind: "mask";
  readonly id: string;
  /** mask 范围（coverage.maskBounds） */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 统一边界（Renderer 只看它） */
  readonly bounds: RenderBounds;
  readonly blockId: string;
  readonly coverage: RenderCoverage;
}

/**
 * 把单个 RenderContext（glyph 级）转换为 GlyphObject。
 */
function toGlyphObject(ctx: RenderContext): GlyphObject {
  return {
    kind: "glyph",
    id: `${ctx.blockId}-${ctx.x}-${ctx.y}-${ctx.char}`,
    char: ctx.char,
    x: ctx.x,
    y: ctx.y,
    width: ctx.width,
    height: ctx.height,
    bounds: { x: ctx.x, y: ctx.y, width: ctx.width, height: ctx.height },
    baseline: ctx.baseline,
    blockId: ctx.blockId,
    lineId: ctx.lineId,
    metrics: ctx.metrics,
    style: ctx.style,
    coverage: ctx.coverage,
  };
}

/**
 * 把 RenderContext[] 转换为 RenderObject[]。
 *
 * 按 runId 分组（同一 run 的 glyph 共享同一 coverage）：
 *   - 每个 run → 1 个 MaskObject（coverage.maskBounds）
 *   - 每个 run → 1 个 PatchObject（coverage.patchBounds）
 *   - 每个 glyph → 1 个 GlyphObject
 *
 * @param contexts RenderContext[]（glyph 级，来自 LayoutRendererAdapter）
 * @returns RenderObject[]
 */
export function renderContextToRenderObjects(contexts: readonly RenderContext[]): RenderObject[] {
  // 按 blockId（run）分组
  const groups = new Map<string, RenderContext[]>();
  for (const ctx of contexts) {
    const key = ctx.coverage.visualCoverageId;
    const list = groups.get(key) ?? [];
    list.push(ctx);
    groups.set(key, list);
  }

  const objects: RenderObject[] = [];
  for (const [coverageId, ctxs] of groups) {
    if (ctxs.length === 0) continue;
    const first = ctxs[0];
    const coverage = first.coverage;

    // region 级对象（每 run 一个）：Mask + Patch
    if (coverage.maskBounds) {
      objects.push({
        kind: "mask",
        id: `${coverageId}-mask`,
        x: coverage.maskBounds.x,
        y: coverage.maskBounds.y,
        width: coverage.maskBounds.width,
        height: coverage.maskBounds.height,
        bounds: {
          x: coverage.maskBounds.x,
          y: coverage.maskBounds.y,
          width: coverage.maskBounds.width,
          height: coverage.maskBounds.height,
        },
        blockId: first.blockId,
        coverage,
      });
    }
    if (coverage.patchBounds) {
      objects.push({
        kind: "patch",
        id: `${coverageId}-patch`,
        x: coverage.patchBounds.x,
        y: coverage.patchBounds.y,
        width: coverage.patchBounds.width,
        height: coverage.patchBounds.height,
        bounds: {
          x: coverage.patchBounds.x,
          y: coverage.patchBounds.y,
          width: coverage.patchBounds.width,
          height: coverage.patchBounds.height,
        },
        blockId: first.blockId,
        coverage,
      });
    }

    // glyph 级对象（每 glyph 一个）
    for (const ctx of ctxs) {
      objects.push(toGlyphObject(ctx));
    }
  }

  return objects;
}
