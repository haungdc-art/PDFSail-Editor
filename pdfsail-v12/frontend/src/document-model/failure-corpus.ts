/**
 * Failure Corpus — Sprint37 · S37-3
 *
 * 目标：Build evidence before changing algorithms。
 *
 * 消费 Decision Trace，积累失败样本（Failure Record），建立证据闭环：
 *   PDF → Decision Trace → Failure Record → 统计 → 发现模式 → 改算法
 *
 * 【S37-3 关键设计】
 *   - FailureRecord 是数据模型（非文件夹）。
 *   - 保存完整 GeometryDecisionTrace 对象（非 Markdown/Timeline，Renderer 可随时重新生成）。
 *   - 直接保存 delta（expected-actual），后续排序快。
 *   - snapshot Optional（不同来源可能无截图）。
 *   - 【只依赖 GeometryDecisionTrace，绝不反向依赖 Runtime】。
 */

import type { GeometryDecisionTrace } from "./geometry-decision-trace";

/**
 * Failure Category — 失败模式分类（由 Corpus Analyzer 后处理标记，非 Runtime 计算）。
 */
export type FailureCategory =
  | "provider"
  | "baseline"
  | "pca"
  | "normalize"
  | "selection"
  | "unknown";

/**
 * Failure Record — 一条签名旋转失败样本。
 *
 * 注：S38-2 Freeze 后，重放状态统一由 replay-result.ts 的 ReplayStatus 承担
 * （PASS / FAIL / REGRESSION / ERROR / SKIPPED / UNKNOWN），
 * FailureRecord 不再持有 replayStatus（避免两套状态定义并存）。
 */
export interface FailureRecord {
  /** 唯一 id */
  id: string;
  /** 创建时间 */
  createdAt: string;
  /** 文档 id */
  documentId: string;
  /** 页码 */
  page: number;
  /** Trace version */
  traceVersion: number;
  /** 完整决策 Trace（Renderer 可重新生成） */
  decisionTrace: GeometryDecisionTrace;
  /** 期望角度（度） */
  expectedAngle: number;
  /** 实际角度（度） */
  actualAngle: number;
  /** 误差（度）——直接保存，排序快 */
  delta: number;
  /** 失败模式分类（Analyzer 后处理标记） */
  failureCategory?: FailureCategory;
  /** 是否已解决（Fail→Fix→Replay→Resolved，Corpus 不删除） */
  resolved?: boolean;
  /** 快照（可选，不同来源可能无截图） */
  snapshot?: string;
  /** 备注（可选） */
  notes?: string;
}

/**
 * Failure Corpus — 失败样本库。
 *
 * 只依赖 GeometryDecisionTrace，绝不反向依赖 Runtime。
 * Mutable（允许演进）。
 */
export interface FailureCorpus {
  /** 添加一条失败记录 */
  add(record: FailureRecord): void;
  /** 全部失败记录 */
  records(): readonly FailureRecord[];
  /** 记录数 */
  size(): number;
}

/**
 * 创建一条 FailureRecord（计算 delta）。
 *
 * @param trace          完整 Decision Trace
 * @param expectedAngle  期望角度
 * @param actualAngle    实际角度
 * @param extra          可选（documentId/page/snapshot/notes）
 */
export function createFailureRecord(
  trace: GeometryDecisionTrace,
  expectedAngle: number,
  actualAngle: number,
  extra: { documentId?: string; page?: number; snapshot?: string; notes?: string } = {},
): FailureRecord {
  return {
    id: `failure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    documentId: extra.documentId ?? trace.documentId,
    page: extra.page ?? trace.page,
    traceVersion: trace.version,
    decisionTrace: trace,
    expectedAngle,
    actualAngle,
    delta: Math.abs(expectedAngle - actualAngle),
    snapshot: extra.snapshot,
    notes: extra.notes,
  };
}

/**
 * 默认 Failure Corpus 实现（内存存储，Mutable）。
 */
export class DefaultFailureCorpus implements FailureCorpus {
  private readonly items: FailureRecord[] = [];

  add(record: FailureRecord): void {
    this.items.push(record);
  }

  records(): readonly FailureRecord[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }
}
