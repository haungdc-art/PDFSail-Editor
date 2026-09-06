/**
 * replay-model.ts — Adobe Replay Model（Sprint-80 Task-004）
 *
 * 统一 Failure Replay 数据模型：把一次失败的完整上下文（Adobe / Painter / Diff /
 * Heatmap / Failure / Fix Suggestion）绑定到一个 Replay 对象，供 Replay 页面"一眼看到哪里不一样"。
 *
 * 纯类型 + 组装逻辑（ADR-005），不依赖 Renderer / DOM / Canvas。
 */

import type { FailureReport, DimensionAnalysis, RootCause, FailureScope, BenchmarkResultInput } from "./failure-analyzer";
import type { FixSuggestion } from "./fix-suggestion";

/** 一次可回放的失败 */
export interface ReplayModel {
  readonly document: string;
  readonly category: string;
  /** 各产物路径 */
  readonly assets: {
    readonly originalPdf: string;
    readonly adobePng: string;
    readonly painterPng: string;
    readonly diffPng?: string;
    readonly heatmapPng?: string;
    readonly heatmapJson?: string;
  };
  /** 原始 BenchmarkResult */
  readonly benchmark: BenchmarkResultInput;
  /** 失败分析 */
  readonly analysis: FailureReport;
  /** 按维度索引（便于页面定位） */
  readonly dimensions: Readonly<Record<string, DimensionAnalysis>>;
  /** 失败维度（按严重度） */
  readonly failures: readonly DimensionAnalysis[];
  /** 可执行的修复动作 */
  readonly fixes: readonly FixSuggestion[];
  /** 是否可回放（有真实 adobe/painter PNG） */
  readonly replayable: boolean;
}

/** 组装 ReplayModel */
export function buildReplayModel(
  benchmark: BenchmarkResultInput,
  analysis: FailureReport,
  assets: ReplayModel["assets"],
  fixes: readonly FixSuggestion[],
): ReplayModel {
  const byMetric: Record<string, DimensionAnalysis> = {};
  for (const d of analysis.dimensions) byMetric[d.metric] = d;

  return {
    document: benchmark.document,
    category: benchmark.category,
    assets,
    benchmark,
    analysis,
    dimensions: byMetric,
    failures: analysis.failures,
    fixes,
    // 可回放 = 有真实 PNG（非占位）
    replayable: assets.adobePng.length > 0 && assets.painterPng.length > 0,
  };
}

/** 提取一个 ReplayModel 的根因摘要 */
export function replaySummary(r: ReplayModel): string {
  const roots = r.failures.map((f) => f.rootCause);
  const unique = [...new Set(roots)];
  return `${r.document}: ${unique.join(", ") || "PASS"}`;
}

/** 判断两个 Replay 是否针对同一根因（用于去重/分组） */
export function sameRootCause(a: ReplayModel, b: ReplayModel): boolean {
  const rootsA = new Set(a.failures.map((f) => f.rootCause));
  const rootsB = new Set(b.failures.map((f) => f.rootCause));
  return [...rootsA].some((r) => rootsB.has(r));
}

export type { RootCause, FailureScope };
