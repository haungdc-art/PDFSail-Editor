/**
 * FidelityBenchmark — Sprint39（验收闭环 / DoD 追踪）
 *
 * 核心：把多份 PDF 的 DifferenceReport 聚合成**可量化指标 + Top Problems 排行榜**，
 * 让开发能回答 CTO 要求的三个问题：
 *   1. 本轮修复了哪个指标？
 *   2. 指标从多少提升到多少？
 *   3. 距离最终 DoD 还有多少差距？
 *
 *   DifferenceReport[100 份]
 *        ↓
 *   FidelityBenchmarkBuilder
 *        ↓
 *   FidelityBenchmarkResult
 *        ├─ DoD 指标（Text/Font/Coordinate/Missing）
 *        └─ Top Problems（排行榜 = Sprint Backlog）
 *
 * 【纪律】Pure + Deterministic。只读报告，不修改输入。
 */

import type { DifferenceReport } from "./fidelity-comparator";

/**
 * 对齐项目最终 Definition of Done 的指标。
 */
export const FIDELITY_DOD: FidelityDoD = {
  textAccuracy: 0.99,
  fontAccuracy: 0.99,
  coordinateAccuracy: 0.99,
  missingRate: 0.005, // ≤0.5%
};

/** Definition of Done 阈值 */
export interface FidelityDoD {
  /** Text Accuracy 达标值（≥） */
  textAccuracy: number;
  /** Font Accuracy 达标值（≥） */
  fontAccuracy: number;
  /** Coordinate Accuracy 达标值（≥） */
  coordinateAccuracy: number;
  /** Missing 率达标值（≤） */
  missingRate: number;
}

/** 一个 Top Problem（排行榜条目，即 Sprint Backlog 项） */
export interface TopProblem {
  /** 维度 */
  dimension: "font" | "coordinate" | "missing" | "text";
  /** 问题标识（如字体名 "Helvetica"、"missing"、"coordinate"） */
  label: string;
  /** 出现次数 */
  count: number;
}

/**
 * Fidelity Benchmark 结果（一次性聚合）。
 */
export interface FidelityBenchmarkResult {
  /** 参与比较的 PDF 数 */
  documentCount: number;
  /** DoD 指标 */
  metrics: {
    /** Text Accuracy 0-1 */
    textAccuracy: number;
    /** Font Accuracy 0-1 */
    fontAccuracy: number;
    /** Coordinate Accuracy 0-1 */
    coordinateAccuracy: number;
    /** Missing 率 0-1（缺失项 / 原总项） */
    missingRate: number;
  };
  /** 与 DoD 的差距（每项 = DoD - 当前，负数/0 = 达标） */
  gapToDoD: {
    textAccuracy: number;
    fontAccuracy: number;
    coordinateAccuracy: number;
    missingRate: number;
  };
  /** 是否全部达标（DoD 达成） */
  doDMet: boolean;
  /** Top Problems 排行榜（按次数降序） */
  topProblems: TopProblem[];
}

/**
 * Fidelity Benchmark Builder —— 唯一职责：聚合报告为指标 + 排行榜（Pure）。
 */
export interface FidelityBenchmarkBuilder {
  build(reports: readonly DifferenceReport[]): FidelityBenchmarkResult;
}

/** 无报告时的空结果 */
function emptyResult(): FidelityBenchmarkResult {
  return {
    documentCount: 0,
    metrics: { textAccuracy: 0, fontAccuracy: 0, coordinateAccuracy: 0, missingRate: 0 },
    gapToDoD: {
      textAccuracy: FIDELITY_DOD.textAccuracy,
      fontAccuracy: FIDELITY_DOD.fontAccuracy,
      coordinateAccuracy: FIDELITY_DOD.coordinateAccuracy,
      missingRate: FIDELITY_DOD.missingRate,
    },
    doDMet: false,
    topProblems: [],
  };
}

/**
 * 默认 Fidelity Benchmark Builder。
 */
export const DefaultFidelityBenchmarkBuilder: FidelityBenchmarkBuilder = {
  build(reports: readonly DifferenceReport[]): FidelityBenchmarkResult {
    if (reports.length === 0) return emptyResult();

    // 汇总各维度（以原始文本项数为加权分母）
    let originalTotal = 0;
    let textOk = 0;
    let fontOk = 0;
    let coordOk = 0;
    let missingTotal = 0;

    // Top Problems 聚合
    const problemCount = new Map<string, { dimension: string; label: string; count: number }>();

    for (const report of reports) {
      const weight = Math.max(report.originalItemCount, 1);

      // 报告级各维度准确率 = 页准确率均值（简单平均），再按该报告文本项数加权
      const pageAvg = (pick: (p: { textAccuracy: number }) => number) =>
        report.pages.length > 0
          ? report.pages.reduce((s, p) => s + pick(p), 0) / report.pages.length
          : 1;

      textOk += pageAvg((p) => p.textAccuracy) * weight;
      fontOk += pageAvg((p) => p.fontAccuracy) * weight;
      coordOk += pageAvg((p) => p.coordinateAccuracy) * weight;
      missingTotal += report.missingCount;
      originalTotal += weight;

      // Top Problems 聚合
      for (const m of report.mismatches) {
        const label =
          m.dimension === "font"
            ? (m.expectedFont || "unknown-font")
            : m.dimension === "missing"
              ? "missing-element"
              : m.dimension === "coordinate"
                ? "coordinate-offset"
                : "text-mismatch";
        const key = `${m.dimension}:${label}`;
        const cur = problemCount.get(key);
        if (cur) cur.count += 1;
        else problemCount.set(key, { dimension: m.dimension, label, count: 1 });
      }
    }

    const textAccuracy = originalTotal > 0 ? textOk / originalTotal : 0;
    const fontAccuracy = originalTotal > 0 ? fontOk / originalTotal : 0;
    const coordinateAccuracy = originalTotal > 0 ? coordOk / originalTotal : 0;
    const missingRate = originalTotal > 0 ? missingTotal / originalTotal : 0;

    const topProblems: TopProblem[] = [...problemCount.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)
      .map((p) => ({
        dimension: p.dimension as TopProblem["dimension"],
        label: p.label,
        count: p.count,
      }));

    const gapToDoD = {
      textAccuracy: FIDELITY_DOD.textAccuracy - textAccuracy,
      fontAccuracy: FIDELITY_DOD.fontAccuracy - fontAccuracy,
      coordinateAccuracy: FIDELITY_DOD.coordinateAccuracy - coordinateAccuracy,
      missingRate: FIDELITY_DOD.missingRate - missingRate,
    };
    const doDMet =
      textAccuracy >= FIDELITY_DOD.textAccuracy &&
      fontAccuracy >= FIDELITY_DOD.fontAccuracy &&
      coordinateAccuracy >= FIDELITY_DOD.coordinateAccuracy &&
      missingRate <= FIDELITY_DOD.missingRate;

    return {
      documentCount: reports.length,
      metrics: { textAccuracy, fontAccuracy, coordinateAccuracy, missingRate },
      gapToDoD,
      doDMet,
      topProblems,
    };
  },
};
