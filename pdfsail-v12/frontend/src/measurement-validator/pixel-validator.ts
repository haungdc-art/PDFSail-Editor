/**
 * pixel-validator.ts — Pixel Failure Validator（Sprint-84B Task-001）
 *
 * 验证像素类 Failure（pixel diff）是否真实。
 * 关键：pixel diff 依赖对齐（页面空间一致，PM Rule-056）。
 * 若两图未对齐（尺寸/背景/尺度不同）→ diff 无意义（Artifact）。
 */

import { validateFailure, ValidationResult } from "./validator";

export interface PixelFailureInput {
  readonly failureReason: string | null;
  readonly diffPercent: number | null;
  /** 像素 diff 是否已对齐（Measurement Equivalence） */
  readonly aligned: boolean;
  /** 对齐后计算出的真实 diff */
  readonly alignedDiffPercent: number | null;
  readonly extractionMethodMatches: boolean;
}

/** 验证像素类 Failure 是否真实 */
export function validatePixelFailure(input: PixelFailureInput): ValidationResult {
  return validateFailure({
    metric: "pixel",
    failureReason: input.failureReason,
    // 只有"对齐后"的 diff 才算有效数据
    hasData: input.aligned && input.alignedDiffPercent !== null,
    extractionMethodMatches: input.aligned, // 对齐成功视为"方法匹配"
    adobeGlyphCount: 0,
    painterGlyphCount: 0,
  });
}
