/**
 * shadow-metrics.ts — Shadow Metrics（Sprint-78 Task-003）
 *
 * 目的：把 Shadow 从"count diff"升级为渲染指标（PM Rule-031：Shadow Must Measure Rendering）。
 *
 * PM Rule-031：Shadow 必须统计 DOM / BBox / Rotation / Patch / Mask / Render Time。
 * 不能只统计 count。
 *
 * 采集指标：
 *   - countDiff     ：对象数量差异
 *   - bboxDiff      ：Bounding Box 差异（像素级，归一化到页宽）
 *   - rotationDiff  ：旋转差异（度）
 *   - maskDiff      ：mask 对象数量/面积差异
 *   - patchDiff     ：patch 对象数量差异
 *   - paintTime     ：painter paint 耗时（ms）
 *   - renderTime    ：DOM 渲染耗时（ms）
 *
 * 纯函数（ADR-005）：输入 legacy/painter 的几何 + 耗时，输出 ShadowMetrics。
 * 不依赖 DOM / Canvas / Browser（Node 可测）。
 */

import type { RenderObject } from "../render-object/render-object";
import type { PaintOutput } from "../render-painter/render-painter";

/** 一条几何记录（用于 diff） */
export interface GeomRecord {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly kind: "glyph" | "mask" | "patch";
  readonly rotation?: number;
}

/** Shadow Metrics 输出 */
export interface ShadowMetrics {
  readonly count: { readonly legacy: number; readonly painter: number };
  readonly countDiff: number;
  readonly bboxDiff: number; // 归一化到 [0,1] 的 bbox 偏差（0 = 完全一致）
  readonly rotationDiff: number; // 平均旋转差（度）
  readonly maskDiff: number; // mask 对象数差
  readonly patchDiff: number; // patch 对象数差
  readonly paintTime: number; // ms
  readonly renderTime: number; // ms
  readonly pass: boolean; // bboxDiff < 0.01 且 countDiff === 0 视为通过
}

/** 从 RenderObject[] 提取几何记录 */
export function objectsToGeom(objects: readonly RenderObject[]): GeomRecord[] {
  return objects.map((o) => ({
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    kind: o.kind as GeomRecord["kind"],
    rotation: (o as any).rotation,
  }));
}

/** 从 PaintOutput[] 提取几何记录 */
export function outputsToGeom(outputs: readonly PaintOutput[]): GeomRecord[] {
  return outputs.map((o) => ({
    x: o.bounds.x,
    y: o.bounds.y,
    width: o.bounds.width,
    height: o.bounds.height,
    kind: o.kind as GeomRecord["kind"],
    rotation: (o as any).rotation,
  }));
}

/** 计算两套几何的 diff（假定顺序对应，按 index 比较） */
export function computeGeomDiff(
  legacy: readonly GeomRecord[],
  painter: readonly GeomRecord[],
): { countDiff: number; bboxDiff: number; rotationDiff: number; maskDiff: number; patchDiff: number } {
  const countDiff = Math.abs(legacy.length - painter.length);
  const maxLen = Math.max(legacy.length, painter.length);

  // BBox diff：归一化（用首条宽作为基准，避免页宽依赖）
  let bboxAcc = 0;
  let rotAcc = 0;
  let rotCount = 0;
  for (let i = 0; i < Math.min(legacy.length, painter.length); i++) {
    const a = legacy[i];
    const b = painter[i];
    const scale = Math.max(a.width, b.width, 1);
    const bboxErr =
      Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height);
    bboxAcc += bboxErr / scale;
    if (a.rotation !== undefined || b.rotation !== undefined) {
      rotAcc += Math.abs((a.rotation ?? 0) - (b.rotation ?? 0));
      rotCount++;
    }
  }
  const bboxDiff = maxLen > 0 ? bboxAcc / maxLen : 0;
  const rotationDiff = rotCount > 0 ? rotAcc / rotCount : 0;

  const maskDiff = Math.abs(
    legacy.filter((g) => g.kind === "mask").length - painter.filter((g) => g.kind === "mask").length,
  );
  const patchDiff = Math.abs(
    legacy.filter((g) => g.kind === "patch").length - painter.filter((g) => g.kind === "patch").length,
  );

  return { countDiff, bboxDiff, rotationDiff, maskDiff, patchDiff };
}

/**
 * 计算完整 Shadow Metrics。
 * @param legacy  legacy 几何（RenderObject 或 PaintOutput 均可，用 GeomRecord）
 * @param painter painter 几何
 * @param paintTime painter paint 耗时（ms）
 * @param renderTime DOM 渲染耗时（ms）
 */
export function computeShadowMetrics(
  legacy: readonly GeomRecord[],
  painter: readonly GeomRecord[],
  paintTime = 0,
  renderTime = 0,
): ShadowMetrics {
  const { countDiff, bboxDiff, rotationDiff, maskDiff, patchDiff } = computeGeomDiff(legacy, painter);
  const pass = countDiff === 0 && bboxDiff < 0.01;
  return {
    count: { legacy: legacy.length, painter: painter.length },
    countDiff,
    bboxDiff,
    rotationDiff,
    maskDiff,
    patchDiff,
    paintTime,
    renderTime,
    pass,
  };
}
