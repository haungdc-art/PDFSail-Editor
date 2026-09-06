/**
 * renderer-health.ts — Renderer Health（Sprint-78 Task-004）
 *
 * 目的：汇总 Shadow Metrics 为 Renderer Health 报告，供 Dashboard 展示。
 *
 * PM Architecture Decision（Sprint-78 Task-004）：
 *   建立 Renderer Health Dashboard，实时显示 Legacy/Painter/Diff/Performance/Memory/Errors。
 *   以后所有版本都看这里。
 *
 * 纯函数：输入 ShadowMetrics[]（多页），输出健康报告。
 * 不依赖 DOM / Browser（Node 可测）。
 */

import type { ShadowMetrics } from "../renderer-dispatcher/shadow-metrics";

/** 单页健康状态 */
export interface RendererHealthRow {
  readonly page: number;
  readonly legacyCount: number;
  readonly painterCount: number;
  readonly bboxDiff: number;
  readonly rotationDiff: number;
  readonly maskDiff: number;
  readonly patchDiff: number;
  readonly paintTime: number;
  readonly renderTime: number;
  readonly pass: boolean;
}

/** Renderer Health 汇总报告 */
export interface RendererHealthReport {
  readonly totalPages: number;
  readonly passPages: number;
  readonly failPages: number;
  readonly health: "healthy" | "degraded" | "unhealthy";
  readonly maxBBoxDiff: number;
  readonly avgPaintTime: number;
  readonly rows: RendererHealthRow[];
  readonly errors: string[];
}

/** 把单页 ShadowMetrics 转为 Health Row */
export function toHealthRow(metrics: ShadowMetrics, page: number): RendererHealthRow {
  return {
    page,
    legacyCount: metrics.count.legacy,
    painterCount: metrics.count.painter,
    bboxDiff: metrics.bboxDiff,
    rotationDiff: metrics.rotationDiff,
    maskDiff: metrics.maskDiff,
    patchDiff: metrics.patchDiff,
    paintTime: metrics.paintTime,
    renderTime: metrics.renderTime,
    pass: metrics.pass,
  };
}

/** 汇总多页 ShadowMetrics 为健康报告 */
export function computeRendererHealth(
  metrics: readonly ShadowMetrics[],
  errors: readonly string[] = [],
): RendererHealthReport {
  const rows = metrics.map((m, i) => toHealthRow(m, i + 1));
  const passPages = rows.filter((r) => r.pass).length;
  const failPages = rows.length - passPages;
  const maxBBoxDiff = rows.length > 0 ? Math.max(...rows.map((r) => r.bboxDiff)) : 0;
  const avgPaintTime =
    rows.length > 0 ? rows.reduce((s, r) => s + r.paintTime, 0) / rows.length : 0;

  // health 判定（区分结构性 fail 与轻微偏差）
  // - 结构性 fail：count/mask/patch 不匹配 → unhealthy
  // - 轻微偏差：bboxDiff > 0.01 但结构匹配 → degraded
  // - 严重错误：errors → unhealthy
  const hasStructuralFail = rows.some(
    (r) => !r.pass && (r.legacyCount !== r.painterCount || r.maskDiff > 0 || r.patchDiff > 0),
  );
  const hasBBoxFail = rows.some(
    (r) => !r.pass && r.legacyCount === r.painterCount && r.maskDiff === 0 && r.patchDiff === 0 && r.bboxDiff > 0.01,
  );

  let health: RendererHealthReport["health"] = "healthy";
  if (errors.length > 0 || hasStructuralFail) health = "unhealthy";
  else if (hasBBoxFail) health = "degraded";

  return {
    totalPages: rows.length,
    passPages,
    failPages,
    health,
    maxBBoxDiff,
    avgPaintTime,
    rows,
    errors: [...errors],
  };
}
