/**
 * ReplayResult — Sprint38 · S38-2（数据模型，已 Freeze）
 *
 * Replay 产生的新数据，代表"第二次实验"，不改 Evidence（第一次实验）。
 *
 * 【Consumer Rule】Evidence is immutable.
 *   Replay produces new evidence (ReplayResult), never mutates existing evidence.
 *   - Replay 不修改 FailureRecord.delta。
 *   - ReplayResult 单独保存。
 *
 * 【Freeze（CTO Review）】
 *   - Must Fix 1：不保存 derived `improved`（= afterDelta < beforeDelta），由 Statistics/UI 计算。
 *   - Must Fix 2：ReplayStatus 扩展为 PASS / FAIL / REGRESSION / ERROR / SKIPPED / UNKNOWN。
 *   - Must Fix 3：必须记录 algorithmVersion（如 "rotation-v1.2.3"），供 v1→v2→v3 对比。
 *   - Should 2：ReplayResult 只引用 evidenceId（Evidence 已聚合 Failure/Sample/Trace），
 *              Replay 不重新知道 Failure 内部结构。
 *   - 建议③：增加 elapsedMs，Dashboard 直接做 Accuracy vs Speed。
 *
 * 【Freeze 边界】
 *   - ReplayResult Schema 已 Freeze。
 *   - 判定逻辑（PASS/FAIL/REGRESSION/UNKNOWN）由 ReplayPolicy 承担，不在此处。
 */

import type { EvidencePackage } from "./evidence-package";
import type { ReplayStatus } from "./replay-status";

/**
 * Replay Status — 一次重放的判定。
 *
 * 说明：
 *   - PASS      ：重放成功，判定在容差内。
 *   - FAIL      ：重放成功，判定超过容差（且未回归）。
 *   - REGRESSION：重放成功，但比第一次实验更差（如 afterDelta > beforeDelta）。
 *   - ERROR     ：重放执行时抛错（Runtime Crash）。
 *   - SKIPPED   ：无法重放（如无 Sample）。
 *   - UNKNOWN   ：状态未知。
 *
 * （统一类型定义于 replay-status.ts，供 ReplayResult / ReplayPolicy 共享，避免循环依赖。）
 */
export type { ReplayStatus } from "./replay-status";

/**
 * Replay Result — 一次重放的独立结果（派生数据，不改 Evidence）。
 */
export interface ReplayResult {
  /** 关联的 Evidence id（Evidence 已聚合 Failure/Sample/Trace，Replay 不依赖其内部结构） */
  evidenceId: string;
  /** 重放所针对的算法版本（如 "rotation-v1.2.3"） */
  algorithmVersion: string;
  /** 重放前 delta（来自第一次实验） */
  beforeDelta: number;
  /** 重放后 delta（null = 无法得到有效 afterDelta，如 ERROR/SKIPPED/UNKNOWN） */
  afterDelta: number | null;
  /** 重放状态（由 ReplayPolicy 判定） */
  replayStatus: ReplayStatus;
  /** 单次重放耗时（毫秒，用于 Accuracy vs Speed） */
  elapsedMs: number;
  /** 重放时间 */
  replayedAt: string;
}

/**
 * 派生字段——是否改善。
 *
 * 不保存 derived 字段（Must Fix 1）。需要时由 Statistics/UI 计算。
 */
export function isImproved(result: ReplayResult): boolean {
  return result.afterDelta !== null && result.afterDelta < result.beforeDelta;
}

/**
 * 组装 ReplayResult 所需的已判定数据。
 *
 * 判定逻辑（status）由 ReplayPolicy 完成，Engine 只负责把判定的结果组装进来，
 * 绝不在此处重新解释 Replay。
 */
export interface ReplayResultInput {
  /** 重放后的角度（null = 无法得到） */
  replayedAngle: number | null;
  /** 重放后 delta（已由调用方计算；null = 无法得到有效 delta） */
  afterDelta: number | null;
  /** 重放状态（由 ReplayPolicy 判定） */
  replayStatus: ReplayStatus;
  /** 单次重放耗时（毫秒） */
  elapsedMs: number;
}

/**
 * 从 EvidencePackage + 已判定数据组装 ReplayResult（纯组装，不解释）。
 *
 * @param pkg             第一次实验的 EvidencePackage（不可变，不修改）
 * @param algorithmVersion 重放所针对的算法版本
 * @param input           已判定的重放数据（replayedAngle/afterDelta/replayStatus/elapsedMs）
 */
export function createReplayResult(
  pkg: EvidencePackage,
  algorithmVersion: string,
  input: ReplayResultInput,
): ReplayResult {
  return {
    evidenceId: pkg.id,
    algorithmVersion,
    beforeDelta: pkg.failure.delta,
    afterDelta: input.afterDelta,
    replayStatus: input.replayStatus,
    elapsedMs: input.elapsedMs,
    replayedAt: new Date().toISOString(),
  };
}
