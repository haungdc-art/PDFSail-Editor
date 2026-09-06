/**
 * ObservationWindow — Sprint36 · Task RG-4
 *
 * Observation Window records evidence, never decides release.
 *
 *   TelemetrySummary (Daily Summary)
 *            ↓
 *   ObservationWindow
 *            ↓
 *   ObservationEvidence
 *
 * 【唯一职责】collect evidence（证据），不 judge / 不 decide / 不 release。
 *   - 收集 Observation Evidence。
 *   - 累积文档数与连续天数。
 *   - 保存 Daily Reports 历史。
 *   - 【不】输出 Ready / Not Ready。
 *   - 【不】决定是否删除 Old Path。
 *
 * 【Ownership】Release Gate 是唯一的发布决策者：
 *   ObservationEvidence → ReleaseGate → PASS/FAIL → Delete Old Path
 */

import type { DailySummary } from "./telemetry-summary";

/** 每日观测记录 */
export interface DailyObservation {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 当日文档数 */
  documents: number;
  /** 当日 PASS 数 */
  pass: number;
  /** 当日 FAIL 数 */
  fail: number;
  /** 当日 FAIL 原因 */
  reasons: Record<string, number>;
}

/**
 * Observation Evidence — 观测窗口累积的证据。
 *
 * 只含证据，不含决策（无 Ready / Not Ready / Release）。
 */
export interface ObservationEvidence {
  /** 累计文档数 */
  documents: number;
  /** 累计连续天数 */
  days: number;
  /** 每日报告历史 */
  reports: DailyObservation[];
  /** 最近一天的日期 */
  lastDate: string;
}

/**
 * Observation Window 契约。
 */
export interface ObservationWindow {
  /** 累积一份 Daily Summary，更新证据 */
  accumulate(summary: DailySummary): ObservationEvidence;
  /** 当前证据（只读） */
  evidence(): ObservationEvidence;
}

/**
 * 默认 ObservationWindow 实现。
 *
 * 只收集证据，不 judge / decide / release。
 */
export class DefaultObservationWindow implements ObservationWindow {
  private readonly reports: DailyObservation[] = [];

  accumulate(summary: DailySummary): ObservationEvidence {
    // 追加当日报告（只收集，不判断）
    this.reports.push({
      date: summary.date,
      documents: summary.documents,
      pass: summary.pass,
      fail: summary.fail,
      reasons: summary.reasons,
    });
    return this.evidence();
  }

  evidence(): ObservationEvidence {
    const documents = this.reports.reduce((sum, r) => sum + r.documents, 0);
    return {
      documents,
      days: this.reports.length,
      reports: [...this.reports],
      lastDate: this.reports.length > 0 ? this.reports[this.reports.length - 1].date : "",
    };
  }
}
