/**
 * glyph-validator.ts — Glyph Failure Validator（Sprint-84B Task-001）
 *
 * 验证 glyph 类 Failure（如 glyph-lost）是否真实。
 * 关键：painter 0 glyph 很可能是提取伪影（应用 canvas 渲染，DOM selector 失效），
 * 而非真实的 Painter 丢字形。PM Rule-062。
 */

import { validateFailure, ValidationResult } from "./validator";

export interface GlyphFailureInput {
  readonly failureReason: string | null;
  readonly adobeGlyphCount: number;
  readonly painterGlyphCount: number;
  /** 提取方法是否匹配渲染方式（canvas 渲染用 __editableDocument 提取 = true；DOM selector = false） */
  readonly extractionMethodMatches: boolean;
}

/** 验证 glyph 类 Failure 是否真实 */
export function validateGlyphFailure(input: GlyphFailureInput): ValidationResult {
  return validateFailure({
    metric: "glyph",
    failureReason: input.failureReason,
    hasData: input.adobeGlyphCount > 0,
    extractionMethodMatches: input.extractionMethodMatches,
    adobeGlyphCount: input.adobeGlyphCount,
    painterGlyphCount: input.painterGlyphCount,
  });
}
