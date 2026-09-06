/**
 * ReplayPolicy — Sprint38 · S38-3（Mutable）
 *
 * Replay 如何判定 PASS/FAIL/REGRESSION/UNKNOWN，由 Policy 决定。
 *
 * 【CTO Review ②】ReplayEngine 依赖 ReplayPolicy，而非裸 threshold。
 *   - ReplayEngine 永远不解释 Replay 结果。
 *   - ReplayPolicy 负责判定（PASS / FAIL / REGRESSION / UNKNOWN）。
 *   - 以后判定标准可以演化（如 PASS = delta<2° AND confidence>0.8），
 *     Engine 完全不用改，只换 Policy。
 *
 * 【Freeze】
 *   - ReplayPolicy 保持 Mutable（判定标准未来一定会变）。
 */

import type { ReplayStatus } from "./replay-result";

/**
 * Replay 判定输入 —— Replay 一次实验的已知量。
 *
 * 只含"一次重放"的原始数据，不含 Evidence 内部结构。
 */
export interface ReplayJudgeInput {
  /** 重放前 delta（来自第一次实验） */
  beforeDelta: number;
  /** 重放后 delta（null = 无法得到有效 afterDelta） */
  afterDelta: number | null;
  /** 重放后的角度（可选，Policy 可能想基于角度而非仅 delta 判定） */
  replayedAngle?: number | null;
  /** 期望角度（可选） */
  expectedAngle?: number;
  /** 重放后的置信度（可选，未来判定可能引入 confidence） */
  replayedConfidence?: number | null;
}

/**
 * Replay Policy —— 判定一次重放的状态。
 */
export interface ReplayPolicy {
  /** Policy 版本（记录在 ReplaySession，区分不同判定规则） */
  version: string;
  /**
   * 判定一次重放的状态。
   *
   * 只判定、不修改任何数据。
   */
  judge(input: ReplayJudgeInput): ReplayStatus;
}

/**
 * 默认 Replay Policy —— 基于 delta 容差。
 *
 * 判定规则：
 *   - afterDelta === null      → UNKNOWN
 *   - afterDelta > beforeDelta → REGRESSION
 *   - afterDelta <= threshold  → PASS
 *   - 否则                     → FAIL
 *
 * @param threshold PASS 容差（度）
 */
export function createDeltaThresholdPolicy(threshold = 1.0): ReplayPolicy {
  return {
    version: `delta-threshold-v1`,
    judge(input: ReplayJudgeInput): ReplayStatus {
      if (input.afterDelta === null) {
        return "UNKNOWN";
      }
      if (input.afterDelta > input.beforeDelta) {
        return "REGRESSION";
      }
      return input.afterDelta <= threshold ? "PASS" : "FAIL";
    },
  };
}
