/**
 * validator.ts — Measurement Validator（Sprint-84B Task-001）
 *
 * 职责（PM 定义）：判断一个 Failure 是真实 Failure 还是 Measurement Artifact。
 * 它不是 Prioritizer。Prioritizer 回答"哪个最严重"，Validator 回答"这个是真的吗"。
 *
 * PM Rule-062：Every Failure Must First Pass Measurement Validation。
 * 流程：Failure → Measurement Validation → Real? → YES → Prioritizer → Root Cause → Fix
 *                                       → NO（Artifact）→ Stop
 *
 * 输出：Real / Artifact / Unknown（三个判定）
 *
 * 纯逻辑（ADR-005），不依赖 Renderer / DOM / Canvas。Node 可测。
 */

/** 判定结果 */
export type ValidationVerdict = "real" | "artifact" | "unknown";

/** 单项校验结论 */
export interface ValidationCheck {
  readonly check: string;
  readonly verdict: ValidationVerdict;
  readonly reason: string;
}

/** 整体校验结果 */
export interface ValidationResult {
  readonly verdict: ValidationVerdict;
  /** 各检查项 */
  readonly checks: readonly ValidationCheck[];
  /** 是否能进入 Prioritizer（real） */
  readonly actionable: boolean;
}

/** 输入：一次 Failure 及其测量上下文 */
export interface FailureInput {
  readonly metric: string;
  readonly failureReason: string | null;
  /** 该维度是否检测到数据（null = 无数据） */
  readonly hasData: boolean;
  /** 提取方法是否匹配渲染方式（如 DOM selector 对 canvas 渲染 = false） */
  readonly extractionMethodMatches: boolean;
  /** glyph 数量对比（glyph-lost 判定用） */
  readonly adobeGlyphCount: number;
  readonly painterGlyphCount: number;
}

/* 各专项校验器（glyph / geometry / pixel）通过组合通用检查实现 */

/** 通用校验：数据缺失 vs 提取伪影 */
export function validateFailure(input: FailureInput): ValidationResult {
  const checks: ValidationCheck[] = [];

  // 1. 无数据 → 不是真实 failure，是 data-missing（Artifact）
  checks.push({
    check: "has-data",
    verdict: input.hasData ? "real" : "artifact",
    reason: input.hasData ? "该维度有数据" : "无数据（data-missing），非真实 failure",
  });

  // 2. 提取方法不匹配渲染方式 → 高度可疑伪影
  if (!input.extractionMethodMatches) {
    checks.push({
      check: "extraction-matches-render",
      verdict: "artifact",
      reason: "提取方法不匹配渲染方式（如 DOM selector 对 canvas 渲染）→ 极可能 Artifact",
    });
  }

  // 3. glyph-lost 判定：adobe>0 且 painter=0
  if (input.metric === "glyph") {
    if (input.adobeGlyphCount > 0 && input.painterGlyphCount === 0) {
      // 关键：painter 侧 0 glyph 可能是提取失败（canvas）而非真丢失
      checks.push({
        check: "glyph-painter-zero",
        verdict: input.extractionMethodMatches ? "real" : "artifact",
        reason: input.extractionMethodMatches
          ? "painter 0 glyph 且提取方法匹配 → 真实 glyph 丢失"
          : "painter 0 glyph 但提取方法不匹配渲染方式 → 极可能提取伪影（False Positive）",
      });
    }
  }

  // 综合判定
  const verdict: ValidationVerdict = checks.some((c) => c.verdict === "artifact")
    ? "artifact"
    : checks.every((c) => c.verdict === "real")
      ? "real"
      : "unknown";

  return { verdict, checks, actionable: verdict === "real" };
}
