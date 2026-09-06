/**
 * Evidence Policy — Sprint38 · S38-3
 *
 * 【Must Fix 4】Failure Threshold 属于 Evidence Policy，不属于 Runtime。
 * 【CR-2】delta 由 Policy 计算（Builder 不计算）。
 * 【CR-3】Policy 返回 Decision 对象（save + reason），非 bool。
 *
 *   Geometry → GeometryCompleted → Evidence Policy → EvidenceDecision → Failure
 *
 * Threshold 是 Mutable，Evidence Package 是 Frozen。
 */

/**
 * Evidence Decision Reason — 为何决定保存/不保存。
 */
export type EvidenceDecisionReason =
  | "ThresholdExceeded"
  | "WithinThreshold"
  | "NoExpected"
  | "NoAngle"
  | "Duplicate"
  | "AlreadyResolved"
  | "Ignored";

/**
 * Evidence Decision — Policy 的判定结果（非 bool）。
 */
export interface EvidenceDecision {
  /** 是否保存 */
  save: boolean;
  /** 原因（Replay 可解释为何不保存） */
  reason: EvidenceDecisionReason;
  /** 计算出的 delta（Policy 计算，Builder 不计算） */
  delta: number;
}

/**
 * Evidence Policy — 决定是否将一次 Geometry 结果判定为失败。
 */
export interface EvidencePolicy {
  /** 计算 delta 并判定（返回 Decision，非 bool） */
  evaluate(expected: number, actual: number): EvidenceDecision;
  /** 阈值 */
  threshold: number;
}

/**
 * 默认 Evidence Policy（阈值可配置，Mutable）。
 */
export class DefaultEvidencePolicy implements EvidencePolicy {
  readonly threshold: number;

  constructor(threshold = 1.0) {
    this.threshold = threshold;
  }

  evaluate(expected: number, actual: number): EvidenceDecision {
    const delta = Math.abs(expected - actual);
    return {
      save: delta > this.threshold,
      reason: delta > this.threshold ? "ThresholdExceeded" : "WithinThreshold",
      delta,
    };
  }
}
