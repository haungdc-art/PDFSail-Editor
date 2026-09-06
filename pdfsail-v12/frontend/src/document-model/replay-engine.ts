/**
 * Replay Engine — Sprint38 · S38-3（接口已 Freeze）
 *
 * 重放 EvidencePackage，产生 ReplayResult（不改 Evidence）。
 *
 *   EvidencePackage → Run Runtime → ReplayPolicy → ReplayResult
 *
 * 【Consumer Rule】Evidence is immutable.
 *   Replay produces new evidence (ReplayResult), never mutates existing evidence.
 *   - 不修改 FailureRecord.delta。
 *   - ReplayResult 单独保存。
 *
 * 【CTO Review】
 *   - Must Fix 3：记录 algorithmVersion（注入，Engine 不猜版本）。
 *   - Should 1：ReplayEngine 输出 ReplaySession（一次 Replay = 一批结果）。
 *   - ② ReplayEngine 依赖 ReplayPolicy，而非裸 threshold；Engine 永远不解释 Replay。
 *   - ③ ReplayResult 增加 elapsedMs（Accuracy vs Speed）。
 *   - ④ Summary 不属于 Engine，移入 Statistics（未来 S38-4A）。
 *   - ① ReplaySession 记录"跑了什么实验"（algorithmVersion + replayPolicyVersion + corpusVersion），
 *        而非只记录"跑了什么算法"。
 *
 * 【Freeze】
 *   - ReplayEngine Interface：replay / replayAll。
 *   - ReplaySession Schema。
 *   - 实现可优化，接口尽量不再变。
 */

import type { EvidencePackage } from "./evidence-package";
import type { ReplayResult } from "./replay-result";
import { createReplayResult } from "./replay-result";
import type { ReplayPolicy } from "./replay-policy";
import { createDeltaThresholdPolicy } from "./replay-policy";

/**
 * Replay Executor — 由调用方注入，重放 Geometry 检测。
 *
 * 返回重放后的实际角度；null = 无法重放（SKIPPED/UNKNOWN）。
 * 抛错 = Runtime Crash（ERROR）。
 */
export interface ReplayExecutor {
  /** 重放一个 EvidencePackage，返回新的实际角度 */
  execute(pkg: EvidencePackage): number | null;
}

/**
 * Replay Session — 一次完整的 Replay 实验。
 *
 * 记录"跑了什么实验"（算法 + 判定策略 + 语料版本），而非只记录算法。
 * 因为：同一算法 + 不同 Policy / Corpus，结果会不同。
 *
 * Statistics / Dashboard 消费 ReplaySession（而非一个个 ReplayResult）。
 */
export interface ReplaySession {
  /** 会话 id */
  id: string;
  /** 重放所针对的算法版本（如 "rotation-v1.2.3"） */
  algorithmVersion: string;
  /** 重放判定策略版本（如 "delta-threshold-v1"） */
  replayPolicyVersion: string;
  /** 重放语料版本（如 "2026-09"，标识这批 Evidence 的来源） */
  corpusVersion: string;
  /**
   * 覆盖的 Evidence 数量 —— 审计元数据（Audit Metadata），非统计。
   *
   * Dashboard 直接显示"这次实验覆盖多少 Evidence"，无需从 results.length 推断。
   */
  evidenceCount: number;
  /** 开始时间 */
  startedAt: string;
  /** 结束时间 */
  finishedAt: string;
  /** 结果列表（一个 EvidencePackage 一条） */
  results: ReplayResult[];
}

/**
 * Replay Engine 契约。
 */
export interface ReplayEngine {
  /** 重放一个 EvidencePackage，返回 ReplayResult */
  replay(pkg: EvidencePackage): ReplayResult;
  /** 重放一批 EvidencePackage，返回 ReplaySession */
  replayAll(pkgs: readonly EvidencePackage[]): ReplaySession;
}

/**
 * 创建 Replay Engine。
 *
 * @param executor          重放执行器（注入）
 * @param algorithmVersion  重放所针对的算法版本（如 "rotation-v1.2.3"）
 * @param options           可选配置
 *   - policy        重放判定策略（默认 delta-threshold-v1，threshold=1°）
 *   - corpusVersion 重放语料版本（如 "2026-09"）
 */
export function createReplayEngine(
  executor: ReplayExecutor,
  algorithmVersion: string,
  options: {
    policy?: ReplayPolicy;
    corpusVersion?: string;
  } = {},
): ReplayEngine {
  const policy = options.policy ?? createDeltaThresholdPolicy(1.0);
  const corpusVersion = options.corpusVersion ?? "unknown";

  const replayOne = (pkg: EvidencePackage): ReplayResult => {
    const startedAt = performance.now();
    let replayedAngle: number | null = null;
    let runtimeError = false;
    try {
      replayedAngle = executor.execute(pkg);
    } catch {
      runtimeError = true;
    }
    const elapsedMs = performance.now() - startedAt;

    if (runtimeError) {
      // Runtime Crash → ERROR（即使有 beforeDelta，也不归类为 FAIL/REGRESSION）
      return createReplayResult(pkg, algorithmVersion, {
        replayedAngle: null,
        afterDelta: null,
        replayStatus: "ERROR",
        elapsedMs,
      });
    }

    const afterDelta =
      replayedAngle === null
        ? null
        : Math.abs(replayedAngle - pkg.failure.expectedAngle);

    const replayStatus = policy.judge({
      beforeDelta: pkg.failure.delta,
      afterDelta,
      replayedAngle,
      expectedAngle: pkg.failure.expectedAngle,
    });

    return createReplayResult(pkg, algorithmVersion, {
      replayedAngle,
      afterDelta,
      replayStatus,
      elapsedMs,
    });
  };

  return {
    replay(pkg: EvidencePackage): ReplayResult {
      return replayOne(pkg);
    },
    replayAll(pkgs: readonly EvidencePackage[]): ReplaySession {
      const startedAt = new Date().toISOString();
      const results = pkgs.map(replayOne);
      return {
        id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        algorithmVersion,
        replayPolicyVersion: policy.version,
        corpusVersion,
        evidenceCount: results.length,
        startedAt,
        finishedAt: new Date().toISOString(),
        results,
      };
    },
  };
}
