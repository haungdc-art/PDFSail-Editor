/**
 * TelemetrySummary — Sprint36 · Task RG-2
 *
 * 从 Raw Events 生成 Daily Summary。
 *
 *   RuntimeTelemetry (Raw Events)
 *            ↓
 *   TelemetrySummary
 *            ↓
 *   Daily Summary
 *
 * 【Ownership（CTO RG-1 收口）】
 *   - RuntimeTelemetry：唯一职责 append/record（Raw Events）。
 *   - TelemetrySummary：唯一职责 summarize（events → Daily Summary）。
 *   - Dashboard：唯一职责 render（summary → UI，后续）。
 *
 *   不要让 Telemetry 长成 Mega Service（record/summary/dashboard/statistics/trend）。
 *
 * 【RG-2 Done Definition】
 *   Raw Events → Daily Summary
 *   输出：documents / pass / fail / reasons
 *   不做：Dashboard / 趋势 / 图表 / UI / Export（全部放后面）。
 */

import type { RuntimeTelemetryEntry } from "./runtime-telemetry";

/** 每日统计汇总 */
export interface DailySummary {
  /** 日期（YYYY-MM-DD） */
  date: string;
  /** 文档总数 */
  documents: number;
  /** PASS 数 */
  pass: number;
  /** FAIL 数 */
  fail: number;
  /** FAIL 原因分布 */
  reasons: Record<string, number>;
}

/**
 * Telemetry Summary 契约。
 */
export interface TelemetrySummary {
  /** 从 Raw Events 生成每日汇总 */
  summarize(events: readonly RuntimeTelemetryEntry[], date: string): DailySummary;
}

/**
 * 默认 TelemetrySummary 实现（纯函数，无状态）。
 */
export const DefaultTelemetrySummary: TelemetrySummary = {
  summarize(events: readonly RuntimeTelemetryEntry[], date: string): DailySummary {
    const dayEntries = events.filter((e) => e.timestamp.slice(0, 10) === date);
    const pass = dayEntries.filter((e) => e.overall === "PASS").length;
    const fail = dayEntries.filter((e) => e.overall === "FAIL").length;

    const reasons: Record<string, number> = {};
    for (const e of dayEntries) {
      for (const r of e.failReasons) {
        reasons[r] = (reasons[r] ?? 0) + 1;
      }
    }

    return { date, documents: dayEntries.length, pass, fail, reasons };
  },
};
