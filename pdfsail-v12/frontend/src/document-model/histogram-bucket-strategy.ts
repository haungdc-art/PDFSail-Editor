/**
 * HistogramBucketStrategy — Sprint38 · S38-4B（Mutable）
 *
 * 直方图桶划分策略。ReplayVisualizationComposer 只负责调用 Strategy，
 * 不负责桶怎么切。
 *
 *   session
 *     ↓
 *   bucketStrategy
 *     ↓
 *   histogram
 *
 * 【CTO Review】Must Fix 1：
 *   - 桶策略以后会变化（0~1/1~2/2~5/5~10 → 0~0.5/0.5~1/1~3/3~5，
 *     → Log Bucket / Adaptive Bucket / Auto Bucket）。
 *   - Composer 不知道桶怎么切，只负责用 Strategy 计算直方图。
 *
 * 【Presentation Composition Rule】
 *   Pure + Deterministic + Idempotent + Side-effect free。
 */

/**
 * 单个 Delta 桶。
 *
 * label 由 Renderer 决定（如 "0-1°" / "0°~1°" / "<1°"），Strategy 不冻结展示语言。
 */
export interface HistogramBucket {
  /** 下界（含） */
  lower: number;
  /** 上界（不含；null = +∞，最后一桶） */
  upper: number | null;
  /** 落入该桶的数据数 */
  count: number;
  /** 展示标签（可选） */
  label?: string;
}

/** Delta 直方图 */
export interface Histogram {
  /** 桶列表（按 lower 升序） */
  buckets: HistogramBucket[];
}

/**
 * Histogram Bucket Strategy —— 定义桶的切法 + 数据分类。
 */
export interface HistogramBucketStrategy {
  /** 策略标识（如 "delta-fixed-v1"），可记录审计 */
  id: string;
  /** 将数据落入桶，返回直方图（只读输入，不修改） */
  build(values: readonly number[]): Histogram;
}

/**
 * 默认 Delta 桶策略 —— 固定桶切法。
 *
 * 桶：0~1° / 1~2° / 2~5° / 5~10° / 10°+（upper=null 表示开放上界）
 */
export function createFixedDeltaBucketStrategy(): HistogramBucketStrategy {
  return {
    id: "delta-fixed-v1",
    build(values: readonly number[]): Histogram {
      const buckets: { lower: number; upper: number | null; count: number }[] = [
        { lower: 0, upper: 1, count: 0 },
        { lower: 1, upper: 2, count: 0 },
        { lower: 2, upper: 5, count: 0 },
        { lower: 5, upper: 10, count: 0 },
        { lower: 10, upper: null, count: 0 },
      ];
      for (const d of values) {
        const bucket = buckets.find(
          (b) => d >= b.lower && (b.upper === null || d < b.upper),
        );
        if (bucket) bucket.count += 1;
      }
      return { buckets };
    },
  };
}
