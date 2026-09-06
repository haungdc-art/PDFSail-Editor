/**
 * geometry-validator.ts — Geometry Failure Validator（Sprint-84B Task-001）
 *
 * 验证几何类 Failure（rotation/bbox/coverage/baseline）是否真实。
 * 依赖：adobe 与 painter 两侧都有可比 glyph 几何（数据齐备）才可能 real。
 */

import { validateFailure, ValidationResult } from "./validator";

export interface GeometryFailureInput {
  readonly metric: "rotation" | "bbox" | "coverage" | "baseline";
  readonly failureReason: string | null;
  readonly diff: number | null;
  /** 几何 diff 是否可计算（两侧都有 glyph 几何） */
  readonly hasData: boolean;
  /** 提取方法是否匹配（canvas/document 提取 = true） */
  readonly extractionMethodMatches: boolean;
  readonly adobeGlyphCount: number;
  readonly painterGlyphCount: number;
}

/** 验证几何类 Failure 是否真实 */
export function validateGeometryFailure(input: GeometryFailureInput): ValidationResult {
  return validateFailure({
    metric: input.metric,
    failureReason: input.failureReason,
    hasData: input.hasData && input.diff !== null,
    extractionMethodMatches: input.extractionMethodMatches,
    adobeGlyphCount: input.adobeGlyphCount,
    painterGlyphCount: input.painterGlyphCount,
  });
}
