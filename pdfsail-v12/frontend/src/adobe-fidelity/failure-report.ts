/**
 * failure-report.ts — Failure Report（Sprint-80 Task-001）
 *
 * 把多个 FailureAnalyzer 的 FailureReport 聚合为整批（Corpus / BenchmarkReport）的
 * 失败汇总，支持 Dashboard "Top Failure" 统计（如 Rotation 37% / Coverage 11%）。
 *
 * 纯逻辑（ADR-005），不依赖 Renderer。
 */

import type { FailureReport, DimensionAnalysis, RootCause } from "./failure-analyzer";
import { collectActionableFixes } from "./fix-suggestion";

/** 某根因在整批中出现的次数与占比 */
export interface RootCauseStat {
  readonly rootCause: RootCause;
  readonly count: number;
  readonly percent: number; // 0-100
  readonly fixSuggestion: string;
}

/** 聚合失败报告 */
export interface AggregatedFailureReport {
  readonly documentCount: number;
  readonly failedCount: number;
  /** Top Failure 根因排序（按出现次数降序） */
  readonly topRootCauses: RootCauseStat[];
  /** 各维度失败文档数 */
  readonly failedByMetric: Readonly<Record<string, number>>;
  /** 全部可执行的修复动作 */
  readonly actionableFixes: ReadonlyArray<{ target: string; action: string }>;
  /** 是否整体健康（无失败） */
  readonly healthy: boolean;
}

/** 聚合多个 FailureReport */
export function aggregateFailureReports(
  reports: ReadonlyArray<FailureReport>,
): AggregatedFailureReport {
  const failed = reports.filter((r) => !r.pass);
  const failedCount = failed.length;

  // 根因统计
  const rootCount = new Map<RootCause, number>();
  for (const r of failed) {
    const seen = new Set<RootCause>();
    for (const d of r.failures) {
      if (!seen.has(d.rootCause)) {
        seen.add(d.rootCause);
        rootCount.set(d.rootCause, (rootCount.get(d.rootCause) ?? 0) + 1);
      }
    }
  }
  const topRootCauses: RootCauseStat[] = [...rootCount.entries()]
    .map(([rootCause, count]) => ({
      rootCause,
      count,
      percent: reports.length > 0 ? (count / reports.length) * 100 : 0,
      fixSuggestion: collectActionableFixes([rootCause])[0]?.action ?? "",
    }))
    .sort((a, b) => b.count - a.count);

  // 维度统计
  const failedByMetric: Record<string, number> = {};
  for (const r of failed) {
    for (const d of r.failures) {
      failedByMetric[d.metric] = (failedByMetric[d.metric] ?? 0) + 1;
    }
  }

  // 可执行修复（去重）
  const fixMap = new Map<string, { target: string; action: string }>();
  for (const r of failed) {
    for (const d of r.failures) {
      const fix = collectActionableFixes([d.rootCause])[0];
      if (fix && fix.target) fixMap.set(fix.target, { target: fix.target, action: fix.action });
    }
  }

  return {
    documentCount: reports.length,
    failedCount,
    topRootCauses,
    failedByMetric,
    actionableFixes: [...fixMap.values()],
    healthy: failedCount === 0,
  };
}

/** 便捷：单个维度是否为失败 */
export function isDimensionFailure(d: DimensionAnalysis): boolean {
  return !d.pass;
}
