/**
 * Corpus Statistics — Sprint37 · S37-3
 *
 * 统计 Failure Corpus，发现失败模式（Evidence-driven）。
 *
 *   Failure Corpus → 统计 → 发现模式 → 改算法
 *
 * 【S37-3】Mutable 层，只消费 FailureRecord，不反向依赖 Runtime。
 */

import type { FailureRecord } from "./failure-corpus";

/**
 * Corpus 统计结果。
 */
export interface CorpusStatistics {
  /** 失败总数 */
  total: number;
  /** 平均误差（度） */
  averageDelta: number;
  /** 最大误差（度） */
  maxDelta: number;
  /** 误差分布（按 delta 区间计数） */
  deltaBuckets: Record<string, number>;
}

/** 计算统计（纯函数，Stateless） */
export function computeCorpusStatistics(records: readonly FailureRecord[]): CorpusStatistics {
  if (records.length === 0) {
    return { total: 0, averageDelta: 0, maxDelta: 0, deltaBuckets: {} };
  }

  const deltas = records.map((r) => r.delta);
  const totalDelta = deltas.reduce((a, b) => a + b, 0);
  const maxDelta = Math.max(...deltas);

  // 误差分布（bucket: 0-1, 1-5, 5-10, 10+）
  const deltaBuckets: Record<string, number> = { "<1°": 0, "1-5°": 0, "5-10°": 0, ">10°": 0 };
  for (const d of deltas) {
    if (d < 1) deltaBuckets["<1°"]++;
    else if (d < 5) deltaBuckets["1-5°"]++;
    else if (d < 10) deltaBuckets["5-10°"]++;
    else deltaBuckets[">10°"]++;
  }

  return {
    total: records.length,
    averageDelta: totalDelta / records.length,
    maxDelta,
    deltaBuckets,
  };
}

/**
 * 按 delta 降序排序（最大的错误最先），便于定位最严重失败。
 */
export function sortByDeltaDesc(records: readonly FailureRecord[]): FailureRecord[] {
  return [...records].sort((a, b) => b.delta - a.delta);
}
