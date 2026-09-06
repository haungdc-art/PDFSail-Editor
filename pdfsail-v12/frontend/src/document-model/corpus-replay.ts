/**
 * Corpus Replay — Sprint37 · S37-3.5（Replay Harness）
 *
 * 目标：让任何一次 Rotation Algorithm 修改，都能自动重放同一批
 * FailureRecord，并生成 Before/After 对比。
 *
 *   Failure Record
 *        ↓
 *   Replay Runtime（重新生成 Trace）
 *        ↓
 *   重新生成 Report
 *        ↓
 *   比较 → PASS / FAIL
 *
 * 这是典型的 Regression Harness：
 *   - Algorithm 修改后，一键 Replay 全部 FailureRecord，马上知道修好几个。
 *   - 只依赖 FailureRecord，不反向依赖 Runtime（Observability Frozen 边界）。
 *
 * 【S37-3.5】Mutable 层。
 */

import type { FailureRecord } from "./failure-corpus";

/**
 * Replay Executor — 由调用方注入，重新运行 Geometry 检测。
 *
 * 返回重放后的实际角度；null 表示无法重放（UNKNOWN）。
 */
export interface ReplayExecutor {
  /** 重放一条 FailureRecord，返回新的实际角度 */
  execute(record: FailureRecord): number | null;
}

/** 单条重放结果 */
export interface ReplayResult {
  record: FailureRecord;
  /** 重放后的实际角度 */
  replayedAngle: number | null;
  /** 重放前 delta */
  beforeDelta: number;
  /** 重放后 delta（null 表示 UNKNOWN） */
  afterDelta: number | null;
  /** 重放状态 */
  status: "PASS" | "FAIL" | "UNKNOWN";
}

/** 重放汇总 */
export interface ReplaySummary {
  total: number;
  pass: number;
  fail: number;
  unknown: number;
  /** Before 平均 delta（原始失败） */
  avgBeforeDelta: number;
  /** After 平均 delta（重放后） */
  avgAfterDelta: number | null;
  results: ReplayResult[];
}

/**
 * 重放一批 FailureRecord。
 *
 * @param records  失败样本
 * @param executor 重放执行器（注入）
 */
export function replayCorpus(
  records: readonly FailureRecord[],
  executor: ReplayExecutor,
): ReplaySummary {
  const results: ReplayResult[] = records.map((record) => {
    let replayedAngle: number | null = null;
    try {
      replayedAngle = executor.execute(record);
    } catch {
      replayedAngle = null;
    }

    let status: ReplayResult["status"] = "UNKNOWN";
    let afterDelta: number | null = null;
    if (replayedAngle !== null) {
      afterDelta = Math.abs(replayedAngle - record.expectedAngle);
      // 用 Benchmark 容差（1°）判定 PASS/FAIL
      status = afterDelta <= 1 ? "PASS" : "FAIL";
    }

    return {
      record,
      replayedAngle,
      beforeDelta: record.delta,
      afterDelta,
      status,
    };
  });

  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const unknown = results.filter((r) => r.status === "UNKNOWN").length;

  const avgBeforeDelta =
    results.length > 0 ? results.reduce((a, r) => a + r.beforeDelta, 0) / results.length : 0;
  const afterDeltas = results
    .map((r) => r.afterDelta)
    .filter((d): d is number => d !== null);
  const avgAfterDelta =
    afterDeltas.length > 0 ? afterDeltas.reduce((a, b) => a + b, 0) / afterDeltas.length : null;

  return {
    total: results.length,
    pass,
    fail,
    unknown,
    avgBeforeDelta,
    avgAfterDelta,
    results,
  };
}
