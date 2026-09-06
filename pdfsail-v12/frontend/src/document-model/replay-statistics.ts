/**
 * ReplayStatistics — Sprint38 · S38-4A（Model 已 Freeze，Builder 保持 Mutable）
 *
 * 一次 ReplaySession 的统计汇总。纯派生数据，不改 ReplaySession / ReplayResult。
 *
 *   ReplaySession
 *        ↓
 *   ReplayStatisticsBuilder
 *        ↓
 *   ReplayStatistics
 *        ↓
 *   Dashboard（Markdown / HTML / Console / React）——只消费，不计算
 *
 * 【CTO Review】
 *   - 数据结构（ReplayStatistics Interface）可以 Freeze。
 *   - 计算方式（Builder）保持可演化（未来可加 Stage Distribution 等）。
 *   - Coverage 是审计数据（来自 ReplaySession.evidenceCount），不是派生。
 *   - Rate 类指标全部 Derived：Regression Rate = Regression / Replay，
 *     Improvement Rate = Improved / Replay（由 isImproved 派生，ReplayResult 不存 improved）。
 *
 * 【Consumer Rule】只读 ReplaySession，绝不修改。
 */

import type { ReplaySession } from "./replay-engine";
import { isImproved } from "./replay-result";

/**
 * Replay Statistics — 一次 Replay 实验的统计汇总（Schema 已 Freeze）。
 *
 * 【CTO Review S38-4A】
 *   - 建议一：validReplayCount —— 真正参与 Delta 统计的数据量（有有效 afterDelta）。
 *   - 建议二：errorRate —— ERROR 单独统计（OOM/Timeout/OCR Crash 不算 FAIL）。
 *   - 建议三：unknownRate —— UNKNOWN 单独统计（Sample 损坏/没跑起来，与 ERROR 不同）。
 *   - generatedAt：Audit Metadata。⚠️ 由调用方（组装/展示层）打上时间戳，
 *     绝不由 Builder 生成 —— 因为 Builder 必须保持确定性（见下），
 *     若 Builder 生成时间戳，则相同输入会产生不同输出，破坏纯函数纪律。
 *   - 建议五（长期，当前保持扁平）：未来如需 p95ElapsedMs，再统一为
 *     percentiles: { delta: {...}, elapsedMs: {...} }。当前不阻断，不提前改。
 */
export interface ReplayStatistics {
  /** 实验覆盖的 Evidence 数（Audit Metadata，来自 session.evidenceCount） */
  coverage: number;
  /** 实际重放数（= session.results.length，统计指标，非 Visualization 推导） */
  replayCount: number;
  /** 真正参与 Delta 统计的数据量（有有效 afterDelta 的结果数） */
  validReplayCount: number;
  /** PASS 比例（PASS / total） */
  passRate: number;
  /** FAIL 比例（FAIL / total） */
  failRate: number;
  /** REGRESSION 比例（REGRESSION / total） */
  regressionRate: number;
  /** ERROR 比例（ERROR / total，OOM/Timeout/OCR Crash 等，不算 FAIL） */
  errorRate: number;
  /** UNKNOWN 比例（UNKNOWN / total，Sample 损坏/没跑起来，与 ERROR 不同） */
  unknownRate: number;
  /** Improvement 比例（Improved / total，Improved 由 afterDelta<beforeDelta 派生） */
  improvementRate: number;
  /** 平均 afterDelta（基于 validReplayCount） */
  averageDelta: number | null;
  /** 中位数 afterDelta（基于 validReplayCount） */
  medianDelta: number | null;
  /** P95 afterDelta（基于 validReplayCount） */
  p95Delta: number | null;
  /** P99 afterDelta（基于 validReplayCount） */
  p99Delta: number | null;
  /**
   * 统计生成时间（Audit Metadata）。
   *
   * ⚠️ 不由 Builder 生成（保持确定性），由调用方打上时间戳。
   * 链路审计：ReplaySession(09:00) → ReplayStatistics(09:00:03, 由调用方填) → Dashboard(09:00:05)。
   */
  generatedAt?: string;
}

/**
 * Replay Statistics Builder —— 唯一职责：计算（Mutable，可演化）。
 *
 * 【冻结纪律】ReplayStatisticsBuilder must be deterministic and side-effect free.
 *   - 同一个输入 → 永远得到同一个输出。
 *   - 不读数据库 / 不读配置 / 不读缓存 / 不写日志 / 不保存对象。
 *   - 不生成时间戳（generatedAt 由调用方打上，见 ReplayStatistics）。
 *   - 因此 ReplayStatistics 可以放心缓存。
 */
export interface ReplayStatisticsBuilder {
  build(session: ReplaySession): ReplayStatistics;
}

/**
 * 计算百分位数（线性插值法）。
 *
 * @param sortedDeltas 已升序排序的 delta 数组
 * @param p 百分位（0-100）
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
 * 默认 Replay Statistics Builder。
 */
export const DefaultReplayStatisticsBuilder: ReplayStatisticsBuilder = {
  build(session: ReplaySession): ReplayStatistics {
    const total = session.results.length;
    const count = (s: string) =>
      session.results.filter((r) => r.replayStatus === s).length;
    const pass = count("PASS");
    const fail = count("FAIL");
    const regression = count("REGRESSION");
    const error = count("ERROR");
    const unknown = count("UNKNOWN");
    const improved = session.results.filter(isImproved).length;

    // 真正参与 Delta 统计的数据量 = 有有效 afterDelta 的结果
    const deltas = session.results
      .map((r) => r.afterDelta)
      .filter((d): d is number => d !== null);
    const validReplayCount = deltas.length;
    const sorted = [...deltas].sort((a, b) => a - b);
    const avg =
      validReplayCount > 0
        ? deltas.reduce((a, b) => a + b, 0) / validReplayCount
        : null;

    const rate = (n: number) => (total > 0 ? n / total : 0);

    return {
      coverage: session.evidenceCount,
      replayCount: session.results.length,
      validReplayCount,
      passRate: rate(pass),
      failRate: rate(fail),
      regressionRate: rate(regression),
      errorRate: rate(error),
      unknownRate: rate(unknown),
      improvementRate: rate(improved),
      averageDelta: avg,
      medianDelta: percentile(sorted, 50),
      p95Delta: percentile(sorted, 95),
      p99Delta: percentile(sorted, 99),
    };
  },
};
