/**
 * RuntimeDailyReport — Sprint36 · Task RG-3
 *
 * Daily Summary → 固定 Markdown Report。
 *
 *   RuntimeTelemetry (Raw Events)
 *            ↓
 *   TelemetrySummary (Daily Summary)
 *            ↓
 *   RuntimeDailyReport (Markdown)
 *
 * 【Story 纪律（CTO）】Dashboard renders summaries, never interprets runtime events.
 *   - 本 Report 只消费 DailySummary，不读取 Runtime Events。
 *   - 不做统计 / 排序 / 聚合 / 过滤 / 趋势（那是 Summary 或 Dashboard 的职责）。
 *
 * 【RG-3 Done】Daily Summary → Markdown Report，输出固定 Markdown。
 *   Release Gate 真正看的是这份日报格式，Dashboard 移后（RG-5）。
 */

import type { DailySummary } from "./telemetry-summary";

/**
 * Runtime Daily Report 契约。
 */
export interface RuntimeDailyReport {
  /** 从 Daily Summary 生成固定 Markdown 日报 */
  render(summary: DailySummary): string;
}

/**
 * 默认 RuntimeDailyReport 实现（纯函数，无状态）。
 *
 * 固定 Markdown 格式：
 *   Geometry Runtime Report
 *   2026-08-12
 *
 *   Documents / PASS / FAIL
 *   Reasons（FAIL reason 分布）
 */
export const DefaultRuntimeDailyReport: RuntimeDailyReport = {
  render(summary: DailySummary): string {
    const lines: string[] = [];
    lines.push("## Geometry Runtime Report");
    lines.push(`Date: ${summary.date}`);
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Documents | ${summary.documents} |`);
    lines.push(`| PASS | ${summary.pass} |`);
    lines.push(`| FAIL | ${summary.fail} |`);
    lines.push("");
    lines.push("### Reasons");
    const reasonKeys = Object.keys(summary.reasons);
    if (reasonKeys.length === 0) {
      lines.push("- (none)");
    } else {
      for (const r of reasonKeys) {
        lines.push(`- ${r} (${summary.reasons[r]})`);
      }
    }
    lines.push("");
    return lines.join("\n");
  },
};
