/**
 * failure-prioritizer.ts — Failure Prioritizer（Sprint-81 Task-001）
 *
 * 从 FailureReport 聚合出 Top Root Cause，供 Sprint 决定"下一个修哪个"。
 * 配合 PM Rule-049（One Sprint, One Root Cause）：一次只修 Top1。
 *
 * 输入：AggregatedFailureReport（或原始 FailureReport[]）
 * 输出：PrioritizedFailure（按 impact 排序，含明确 Top1 建议）
 *
 * 优先级 = 出现率 × 严重度权重（rotation/coverage/glyph 为 P0 权重更高）。
 * 纯逻辑（ADR-005），不依赖 Renderer。
 */

import type { FailureReport, RootCause } from "./failure-analyzer";
import type { AggregatedFailureReport } from "./failure-report";
import { aggregateFailureReports } from "./failure-report";

/** 根因严重度权重（用于 impact 排序） */
export const ROOT_CAUSE_SEVERITY: Readonly<Record<RootCause, number>> = {
  none: 0,
  "rotation-estimator": 1.0,
  "typography-estimator": 0.9,
  "coverage-estimator": 0.9,
  "baseline-estimator": 0.8,
  "glyph-lost": 1.0,
  "glyph-extra": 0.7,
  "pixel-noise": 0.6,
  "ocr-noise": 0.4,
  "data-missing": 0.1,
};

/** 一条被优先化的根因 */
export interface PrioritizedRootCause {
  readonly rootCause: RootCause;
  /** 出现次数 */
  readonly count: number;
  /** 出现率（0-100） */
  readonly rate: number;
  /** 严重度权重 */
  readonly severity: number;
  /** 综合 impact（0-100）= rate × severity，越大越该先修 */
  readonly impact: number;
  /** 修复目标 */
  readonly target: string;
  readonly action: string;
}

/** 优先化结果 */
export interface PrioritizedFailure {
  /** 全部根因按 impact 降序 */
  readonly prioritized: readonly PrioritizedRootCause[];
  /** Top1 建议（下一个 Sprint 只修这个，PM Rule-049） */
  readonly top1: PrioritizedRootCause | null;
  /** 是否所有失败均不可修复（纯数据缺失） */
  readonly onlyDataMissing: boolean;
}

/** 从 AggregatedFailureReport 优先化 */
export function prioritizeFromAggregate(
  agg: AggregatedFailureReport,
): PrioritizedFailure {
  const prioritized: PrioritizedRootCause[] = agg.topRootCauses
    .map((s) => ({
      rootCause: s.rootCause,
      count: s.count,
      rate: s.percent,
      severity: ROOT_CAUSE_SEVERITY[s.rootCause] ?? 0,
      impact: round2(s.percent * (ROOT_CAUSE_SEVERITY[s.rootCause] ?? 0)),
      target: s.fixSuggestion.split("（")[0] ?? s.fixSuggestion,
      action: s.fixSuggestion,
    }))
    .sort((a, b) => b.impact - a.impact);

  const actionable = prioritized.filter((p) => p.rootCause !== "data-missing" && p.severity >= 0.5);
  const top1 = actionable[0] ?? null;

  return {
    prioritized,
    top1,
    onlyDataMissing: actionable.length === 0 && prioritized.length > 0,
  };
}

/** 便捷：直接从 FailureReport[] 优先化 */
export function prioritizeFailures(
  reports: readonly FailureReport[],
): PrioritizedFailure {
  return prioritizeFromAggregate(aggregateFailureReports(reports));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
