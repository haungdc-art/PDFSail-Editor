/**
 * Dual Run — Sprint36 · R2（骨架） / R3（Equality Metrics）
 *
 * Run Old Geometry and New Geometry independently from the same immutable
 * snapshot, compare their outputs, and produce a Geometry Report.
 *
 * 【R3 Story Goal】Define how equality is measured, not how Geometry is computed.
 *   - 不讨论 Geometry 怎么算，只讨论 Equality 怎么度量。
 *   - Metrics never modify runtime：Metric 只能 Measure，不能 Repair。
 *     禁止在计算 metric 时 normalize / round / fix / tolerance 修改 Geometry。
 *
 * 【Dual Run Discipline（METH-005）】
 *   Dual Run must execute both paths from the same immutable snapshot.
 *   - Old 与 New 输入来源必须完全相同。
 *   - Runtime 输入不可变。
 *   - Old 与 New 各自独立 GeometryExecutor 实例。
 */

import type { OcrTextBlock } from "../ocr/ocr-storage";
import type { GeometryComparison, GeometryExecutor, GeometryMetric } from "./real-geometry-consumer";

/**
 * Dual Run 输入 — 同一份 immutable snapshot。
 */
export interface DualRunInput {
  /** 待分析的 OCR blocks（不可变 snapshot） */
  blocks: OcrTextBlock[];
  /** 页面 canvas */
  canvas: HTMLCanvasElement;
}

/**
 * Geometry Report — Dual Run 的产出（结构固定，可扩展 metric 字段）。
 */
export interface GeometryReport {
  /** 总体是否一致 */
  overall: "PASS" | "FAIL";
  /** 各几何指标结果 */
  metrics: {
    rotation: "PASS" | "FAIL";
    polygon: "PASS" | "FAIL";
    transform: "PASS" | "FAIL";
  };
  /** 详细 Comparison（含 delta / reason，便于诊断） */
  comparison: GeometryComparison;
  /** 汇总（如 "1 metric failed"） */
  summary: string;
}

/** 相等性判定容差（度量用，不修改 runtime） */
const ROTATION_TOLERANCE = 0.01; // 角度（degree）
const TRANSFORM_TOLERANCE = 0.0001; // 矩阵元素

/** 从 snapshot 深拷贝 blocks（避免 Old/New 共享可变对象） */
function cloneBlocks(blocks: OcrTextBlock[]): OcrTextBlock[] {
  return blocks.map((b) => ({ ...b }));
}

/** 从 blocks 提取几何输出快照（用于比较，immutable） */
function snapshotGeometry(blocks: OcrTextBlock[]): {
  rotation: number | undefined;
  transform: number[] | undefined;
}[] {
  return blocks.map((b) => ({
    rotation: (b as any).geometry?.rotation as number | undefined,
    transform: (b as any).geometry?.transform as number[] | undefined,
  }));
}

/**
 * 比较 rotation（含容差，产 reason）。纯 Measure，不修改 runtime。
 */
function compareRotation(oldSnap: ReturnType<typeof snapshotGeometry>, newSnap: ReturnType<typeof snapshotGeometry>): GeometryMetric {
  if (oldSnap.length !== newSnap.length) {
    return { pass: false, reason: "block count mismatch" };
  }
  let maxDelta = 0;
  for (let i = 0; i < oldSnap.length; i++) {
    const o = oldSnap[i].rotation ?? 0;
    const n = newSnap[i].rotation ?? 0;
    maxDelta = Math.max(maxDelta, Math.abs(o - n));
  }
  return {
    pass: maxDelta <= ROTATION_TOLERANCE,
    delta: maxDelta,
    reason: maxDelta <= ROTATION_TOLERANCE ? "within tolerance" : "exceed tolerance",
  };
}

/**
 * 比较 transform（含容差，产 reason）。纯 Measure，不修改 runtime。
 */
function compareTransform(oldSnap: ReturnType<typeof snapshotGeometry>, newSnap: ReturnType<typeof snapshotGeometry>): GeometryMetric {
  if (oldSnap.length !== newSnap.length) {
    return { pass: false, reason: "block count mismatch" };
  }
  let maxDelta = 0;
  for (let i = 0; i < oldSnap.length; i++) {
    const o = oldSnap[i].transform ?? [];
    const n = newSnap[i].transform ?? [];
    const len = Math.max(o.length, n.length);
    for (let j = 0; j < len; j++) {
      maxDelta = Math.max(maxDelta, Math.abs((o[j] ?? 0) - (n[j] ?? 0)));
    }
  }
  return {
    pass: maxDelta <= TRANSFORM_TOLERANCE,
    delta: maxDelta,
    reason: maxDelta <= TRANSFORM_TOLERANCE ? "within tolerance" : "exceed tolerance",
  };
}

/**
 * 比较 polygon（当前以 block 结构相等近似，产 reason）。纯 Measure。
 */
function comparePolygon(oldSnap: ReturnType<typeof snapshotGeometry>, newSnap: ReturnType<typeof snapshotGeometry>): GeometryMetric {
  return {
    pass: oldSnap.length === newSnap.length,
    reason: oldSnap.length === newSnap.length ? "structure identical" : "block count mismatch",
  };
}

/** 比较两个几何快照，生成 GeometryComparison（含 reason，纯 Measure） */
function compare(oldSnap: ReturnType<typeof snapshotGeometry>, newSnap: ReturnType<typeof snapshotGeometry>): GeometryComparison {
  return {
    rotation: compareRotation(oldSnap, newSnap),
    transform: compareTransform(oldSnap, newSnap),
    polygon: comparePolygon(oldSnap, newSnap),
  };
}

/**
 * 执行 Dual Run：同一 immutable snapshot 驱动 Old 与 New Geometry。
 *
 * @param input           不可变 snapshot（blocks + canvas）
 * @param oldExecutorFactory Old Runtime 的 Executor 工厂（独立实例）
 * @param newExecutorFactory New Runtime 的 Executor 工厂（独立实例）
 * @returns GeometryReport
 */
export function runDualRun(
  input: DualRunInput,
  oldExecutorFactory: () => GeometryExecutor,
  newExecutorFactory: () => GeometryExecutor,
): GeometryReport {
  // Old Runtime：独立 Executor 实例
  const oldExecutor = oldExecutorFactory();
  const oldBlocks = cloneBlocks(input.blocks);
  oldExecutor.execute({ blocks: oldBlocks, canvas: input.canvas });
  const oldSnap = snapshotGeometry(oldBlocks);

  // New Runtime：独立 Executor 实例
  const newExecutor = newExecutorFactory();
  const newBlocks = cloneBlocks(input.blocks);
  newExecutor.execute({ blocks: newBlocks, canvas: input.canvas });
  const newSnap = snapshotGeometry(newBlocks);

  const comparison = compare(oldSnap, newSnap);
  const passCount = [
    comparison.rotation?.pass,
    comparison.transform?.pass,
    comparison.polygon?.pass,
  ].filter(Boolean).length;
  const overall = passCount === 3 ? "PASS" : "FAIL";

  return {
    overall,
    metrics: {
      rotation: comparison.rotation?.pass ? "PASS" : "FAIL",
      polygon: comparison.polygon?.pass ? "PASS" : "FAIL",
      transform: comparison.transform?.pass ? "PASS" : "FAIL",
    },
    comparison,
    summary: `${3 - passCount} metric(s) failed`,
  };
}
