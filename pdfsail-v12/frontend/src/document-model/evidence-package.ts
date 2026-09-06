/**
 * Evidence Package — Sprint38 · S38-0（Evidence Model）
 *
 * 把 Sample + Failure 绑定为一个完整实验对象。
 *
 * 【Must Fix 1】EvidencePackage 是聚合（Aggregate），不是复制（Copy）：
 *   - 不保存 decisionTrace 副本（FailureRecord 已有）。
 *   - Replay 通过 package.failure.decisionTrace 访问。
 *   - 避免同一 Trace 存两份（Trace Version / Replay / Migration 复杂化）。
 *
 * 【Must Fix 2】EvidenceStore 不拥有 create()，Builder 独立（Repository 与 Builder 分离）。
 *
 * 【Freeze 纪律】Evidence is immutable once recorded.
 *   Analysis may annotate it, but never rewrite history.
 */

import type { FailureRecord } from "./failure-corpus";
import type { Sample } from "./sample-store";

/**
 * Evidence Package — 一次完整实验的不可变聚合。
 *
 * decisionTrace 通过 failure.decisionTrace 访问（不复制）。
 */
export interface EvidencePackage {
  /** 唯一 id */
  id: string;
  /** Evidence Schema 版本（CR-5：不绑死 Trace version） */
  schemaVersion: 1;
  /** 原始样本 */
  sample: Sample;
  /** 失败记录（含完整 decisionTrace） */
  failure: FailureRecord;
  /** 创建时间 */
  createdAt: string;
}

/**
 * EvidenceBuilder — 组装 EvidencePackage（Repository 与 Builder 分离）。
 *
 * 职责：assemble()。
 * EvidenceStore 只负责 save/load/find/list。
 */
export interface EvidenceBuilder {
  /**
   * 组装 EvidencePackage。
   *
   * @param sample 原始样本
   * @param failure 失败记录（含 decisionTrace）
   */
  assemble(sample: Sample, failure: FailureRecord): EvidencePackage;
}

/**
 * 默认 EvidenceBuilder 实现。
 */
export const DefaultEvidenceBuilder: EvidenceBuilder = {
  assemble(sample: Sample, failure: FailureRecord): EvidencePackage {
    return {
      id: `evidence-${sample.id}-${failure.id}`,
      schemaVersion: 1,
      sample,
      failure,
      createdAt: new Date().toISOString(),
    };
  },
};

/**
 * EvidenceStore — 管理 EvidencePackage（Repository）。
 *
 * 职责只有：save / load / find / list。
 * 不拥有 create（那是 EvidenceBuilder）。
 */
export interface EvidenceStore {
  /** 保存一个 Evidence Package */
  save(pkg: EvidencePackage): void;
  /** 按 id 加载 */
  load(id: string): EvidencePackage | undefined;
  /** 列表 */
  list(): readonly EvidencePackage[];
  /** 数量 */
  size(): number;
}

/**
 * 默认 EvidenceStore 实现（内存存储）。
 */
export class DefaultEvidenceStore implements EvidenceStore {
  private readonly items = new Map<string, EvidencePackage>();

  save(pkg: EvidencePackage): void {
    this.items.set(pkg.id, pkg);
  }

  load(id: string): EvidencePackage | undefined {
    return this.items.get(id);
  }

  list(): readonly EvidencePackage[] {
    return [...this.items.values()];
  }

  size(): number {
    return this.items.size;
  }
}
