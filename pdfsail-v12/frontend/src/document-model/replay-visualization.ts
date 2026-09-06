/**
 * ReplayVisualization — Sprint38 · S38-4B（Model 已 Freeze，Composer 保持 Mutable）
 *
 * 可视化数据（Visualization Data）：Histogram / Regressions / Runtime。
 *
 * 这些属于"可视化"，不属于 Dashboard（Review UI、Scatter、Trend、Heatmap 都会复用）。
 *
 *   ReplaySession
 *        ↓
 *   ReplayVisualizationComposer
 *        ↓
 *   ReplayVisualization
 *
 * 【CTO Review】
 *   - Must Fix：runtime 下沉到 ReplayVisualization，DashboardModelBuilder 不再承担
 *     Presentation Mapping（不再 elapsedSummary → runtime rename）。
 *   - Should 1：记录 bucketStrategyId（如 "fixed-v1"），Dashboard 可标注 (bucket=fixed-v1)。
 *   - Should 2：metadata 承载 schemaVersion + bucketStrategy，Visualization 不会一直长字段。
 *
 * 【Presentation Composition Rule】
 *   所有 Builder / Composer 必须 Pure + Deterministic + Idempotent + Side-effect free。
 *   只读输入，纯计算，不修改输入，不保存、不缓存、不写日志。
 */

import type { ReplaySession } from "./replay-engine";
import type { ReplayResult } from "./replay-result";
import type { Histogram, HistogramBucketStrategy } from "./histogram-bucket-strategy";
import { createFixedDeltaBucketStrategy } from "./histogram-bucket-strategy";

/** 当前 Visualization Schema 版本（统一常量，未来集中到 Version Registry） */
export const CURRENT_SCHEMA = 1;

/**
 * Visualization 元数据（Should 2）。
 *
 * 承载 schemaVersion / bucketStrategy 等，未来新增信息放 metadata，不一直长字段。
 */
export interface ReplayVisualizationMetadata {
  /** Visualization Schema 版本（Renderer switch(schemaVersion) 用） */
  schemaVersion: number;
  /** 直方图桶策略 id（如 "fixed-v1" / "adaptive-v1" / "log-v1"），便于实验比较 */
  bucketStrategyId: string;
}

/**
 * Replay Visualization — 从 ReplaySession 导出的可视化数据（Model 已 Freeze）。
 *
 * 纯派生，不改 Session。Dashboard / Review UI / 未来 Scatter/Trend 复用。
 */
export interface ReplayVisualization {
  /** 元数据（schemaVersion / bucketStrategyId 等） */
  metadata: ReplayVisualizationMetadata;
  /** Delta 直方图 */
  histogram: Histogram;
  /** 回归列表（按恶化量降序） */
  regressions: ReplayRegression[];
  /** 运行时（avg/median/p95，已计算好，Dashboard 只 copy，零映射） */
  runtime: RuntimeSummary;
}

/** 一条回归明细（可视化用） */
export interface ReplayRegression {
  /** 关联的 Evidence id */
  evidenceId: string;
  /** 重放前 delta */
  beforeDelta: number;
  /** 重放后 delta */
  afterDelta: number;
  /** 恶化量（afterDelta - beforeDelta） */
  regressionDelta: number;
}

/**
 * 运行时汇总（Must Fix：从 DashboardModel 下沉到 Visualization）。
 *
 * 语义为 Runtime，未来 CPU / Memory / Replay Time / IO 属此。
 */
export interface RuntimeSummary {
  /** 样本数 */
  count: number;
  /** 平均耗时（毫秒） */
  avgElapsedMs: number | null;
  /** 中位耗时（毫秒） */
  medianElapsedMs: number | null;
  /** P95 耗时（毫秒） */
  p95ElapsedMs: number | null;
}

/**
 * Replay Visualization Composer —— 唯一职责：组织可视化数据（Mutable）。
 *
 * 命名语义：Composer → Organize Presentation Model。
 * 未来 TrendComposer / ScatterComposer / HeatmapComposer 统一沿用。
 */
export interface ReplayVisualizationComposer {
  compose(session: ReplaySession): ReplayVisualization;
}

/**
 * 计算百分位数（线性插值法）。
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const frac = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * frac;
}

/**
 * 默认 Replay Visualization Composer。
 *
 * @param bucketStrategy 直方图桶策略（默认 delta-fixed-v1）
 */
export function createReplayVisualizationComposer(
  bucketStrategy: HistogramBucketStrategy = createFixedDeltaBucketStrategy(),
): ReplayVisualizationComposer {
  return {
    compose(session: ReplaySession): ReplayVisualization {
      const results = session.results;

      // 回归：afterDelta > beforeDelta，按恶化量降序
      const regressions = results
        .filter(
          (r): r is ReplayResult & { afterDelta: number } =>
            r.afterDelta !== null && r.afterDelta > r.beforeDelta,
        )
        .map((r) => ({
          evidenceId: r.evidenceId,
          beforeDelta: r.beforeDelta,
          afterDelta: r.afterDelta,
          regressionDelta: r.afterDelta - r.beforeDelta,
        }))
        .sort((a, b) => b.regressionDelta - a.regressionDelta);

      // 运行时：所有有效耗时 + 汇总
      const elapsedMsValues = results
        .map((r) => r.elapsedMs)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      const sortedElapsed = [...elapsedMsValues].sort((a, b) => a - b);
      const avgElapsedMs =
        sortedElapsed.length > 0
          ? sortedElapsed.reduce((a, b) => a + b, 0) / sortedElapsed.length
          : null;

      // 直方图：委托 Bucket Strategy（Composer 不知道桶怎么切）
      const deltas = results
        .map((r) => r.afterDelta)
        .filter((d): d is number => d !== null);
      const histogram = bucketStrategy.build(deltas);

      return {
        metadata: {
          schemaVersion: CURRENT_SCHEMA,
          bucketStrategyId: bucketStrategy.id,
        },
        histogram,
        regressions,
        runtime: {
          count: sortedElapsed.length,
          avgElapsedMs,
          medianElapsedMs: percentile(sortedElapsed, 50),
          p95ElapsedMs: percentile(sortedElapsed, 95),
        },
      };
    },
  };
}

/** 默认 Composer 实例（使用默认桶策略） */
export const DefaultReplayVisualizationComposer: ReplayVisualizationComposer =
  createReplayVisualizationComposer();
