/**
 * Runtime Telemetry — Sprint36 · Task RG-1（只记录，不影响业务）
 *
 * 为每个文档生成 GeometryReport 的运行时日志，支撑 Release Gate 的 Observation Window。
 *
 *   Old Runtime → GeometryReport → runtime log(JSON)
 *
 * 【明确约束（CTO）】
 *   - 只记录，不上传、不数据库、不分析。
 *   - 不影响业务：不改 Geometry / Dual Run / Pipeline。
 *   - 纯 Telemetry，Observability 层。
 *
 * 【交付标准】
 *   - 为每个文档生成一份 GeometryReport（JSON）。
 *   - 每天自动汇总 PASS / FAIL / Reason。
 *   - 能支撑 Release Gate 的 Observation Window。
 */

import type { GeometryReport } from "./dual-run";

/**
 * 单文档的运行时记录（Telemetry 条目）。
 */
export interface RuntimeTelemetryEntry {
  /** 文档 id */
  docId: string;
  /** 页码 */
  page: number;
  /** rotation 结果 */
  rotation: "PASS" | "FAIL";
  /** polygon 结果 */
  polygon: "PASS" | "FAIL";
  /** transform 结果 */
  transform: "PASS" | "FAIL";
  /** overall 结果 */
  overall: "PASS" | "FAIL";
  /** 汇总（如 "0 metric failed"） */
  summary: string;
  /** FAIL 的原因列表（从 GeometryReport.comparison 提取） */
  failReasons: string[];
  /** 记录时间戳 */
  timestamp: string;
}

/** 每日统计汇总 */
export interface DailyRuntimeSummary {
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
 * Runtime Telemetry — 只记录，不影响业务。
 */
export class RuntimeTelemetry {
  private readonly entries: RuntimeTelemetryEntry[] = [];

  /**
   * 记录一份文档的 GeometryReport。
   *
   * @param docId 文档 id
   * @param page  页码
   * @param report GeometryReport
   */
  record(docId: string, page: number, report: GeometryReport): RuntimeTelemetryEntry {
    // 提取 FAIL 原因（纯记录，不修改 runtime）
    const failReasons: string[] = [];
    if (report.comparison.rotation && !report.comparison.rotation.pass) {
      failReasons.push(`rotation:${report.comparison.rotation.reason ?? "unknown"}`);
    }
    if (report.comparison.transform && !report.comparison.transform.pass) {
      failReasons.push(`transform:${report.comparison.transform.reason ?? "unknown"}`);
    }
    if (report.comparison.polygon && !report.comparison.polygon.pass) {
      failReasons.push(`polygon:${report.comparison.polygon.reason ?? "unknown"}`);
    }

    const entry: RuntimeTelemetryEntry = {
      docId,
      page,
      rotation: report.metrics.rotation,
      polygon: report.metrics.polygon,
      transform: report.metrics.transform,
      overall: report.overall,
      summary: report.summary,
      failReasons,
      timestamp: new Date().toISOString(),
    };
    this.entries.push(entry);

    // 只记录（runtime log），不分析、不上传、不数据库
    console.log("[RuntimeTelemetry]", JSON.stringify(entry));

    return entry;
  }

  /**
   * 生成每日统计汇总（支撑 Observation Window）。
   *
   * @param date 日期（YYYY-MM-DD），默认今天
   */
  dailySummary(date: string = new Date().toISOString().slice(0, 10)): DailyRuntimeSummary {
    const dayEntries = this.entries.filter((e) => e.timestamp.slice(0, 10) === date);
    const pass = dayEntries.filter((e) => e.overall === "PASS").length;
    const fail = dayEntries.filter((e) => e.overall === "FAIL").length;

    const reasons: Record<string, number> = {};
    for (const e of dayEntries) {
      for (const r of e.failReasons) {
        reasons[r] = (reasons[r] ?? 0) + 1;
      }
    }

    return { date, documents: dayEntries.length, pass, fail, reasons };
  }

  /** 全部记录（只读，供观测） */
  getEntries(): readonly RuntimeTelemetryEntry[] {
    return this.entries;
  }
}

/**
 * 全局 Telemetry 实例（Observability 层，单例）。
 */
export const runtimeTelemetry = new RuntimeTelemetry();
