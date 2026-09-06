/**
 * fix-suggestion.ts — Fix Suggestion（Sprint-80 Task-001）
 *
 * 把 Failure Analyzer 的根因（RootCause）映射为可执行的修复提示（Fix Hint），
 * 使 AI / 开发者可以直接"Fix CoverageEstimator"，而非人工看图。
 *
 * 纯逻辑（ADR-005），不依赖 Renderer。
 */

import type { RootCause, FailureScope } from "./failure-analyzer";

/** 一条修复提示 */
export interface FixSuggestion {
  readonly rootCause: RootCause;
  /** 目标模块（可直接修复） */
  readonly target: string;
  /** 修复动作 */
  readonly action: string;
  /** 优先级（P0 最紧急） */
  readonly priority: "P0" | "P1" | "P2";
  /** 影响范围 */
  readonly scope: FailureScope;
}

/** 根因 → 修复目标映射表 */
export const FIX_TARGETS: Readonly<Record<RootCause, FixSuggestion>> = {
  none: { rootCause: "none", target: "", action: "无需修复", priority: "P2", scope: "none" },
  "rotation-estimator": {
    rootCause: "rotation-estimator",
    target: "RotationEstimator",
    action: "重新校准旋转估计（基线/方向置信度）",
    priority: "P0",
    scope: "paragraph",
  },
  "typography-estimator": {
    rootCause: "typography-estimator",
    target: "TypographyEstimator",
    action: "重新估计字体/字号/字形宽度（影响 bbox）",
    priority: "P0",
    scope: "paragraph",
  },
  "coverage-estimator": {
    rootCause: "coverage-estimator",
    target: "CoverageEstimator",
    action: "调整 mask/padding/coverage 边界",
    priority: "P0",
    scope: "single-glyph",
  },
  "baseline-estimator": {
    rootCause: "baseline-estimator",
    target: "BaselineEstimator",
    action: "重新估计文本基线（y 偏移）",
    priority: "P1",
    scope: "line",
  },
  "glyph-lost": {
    rootCause: "glyph-lost",
    target: "OCR/Layout",
    action: "修复 glyph 丢失（OCR 漏检 / 布局裁剪）",
    priority: "P0",
    scope: "whole-page",
  },
  "glyph-extra": {
    rootCause: "glyph-extra",
    target: "Layout",
    action: "清理多余 glyph（覆盖 / 重复）",
    priority: "P1",
    scope: "whole-page",
  },
  "pixel-noise": {
    rootCause: "pixel-noise",
    target: "PixelDiff/NoiseFilter",
    action: "检查噪点过滤 / mask / 字体加载导致的像素差异",
    priority: "P1",
    scope: "whole-page",
  },
  "ocr-noise": {
    rootCause: "ocr-noise",
    target: "OCR",
    action: "降低 OCR 噪点（扫描件预处理）",
    priority: "P2",
    scope: "single-glyph",
  },
  "data-missing": {
    rootCause: "data-missing",
    target: "Dataset",
    action: "采集真实数据后重新 Benchmark（当前数据缺失）",
    priority: "P2",
    scope: "no-data",
  },
};

/** 根据根因获取修复提示 */
export function getFixSuggestion(rootCause: RootCause): FixSuggestion {
  return FIX_TARGETS[rootCause];
}

/** 从分析结果提取可执行的修复提示列表（跳过无动作项） */
export function collectActionableFixes(
  rootCauses: ReadonlyArray<RootCause>,
): FixSuggestion[] {
  return rootCauses
    .map(getFixSuggestion)
    .filter((f) => f.rootCause !== "none" && f.rootCause !== "data-missing" && f.action !== "无需修复")
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
}

function priorityRank(p: FixSuggestion["priority"]): number {
  return p === "P0" ? 0 : p === "P1" ? 1 : 2;
}
