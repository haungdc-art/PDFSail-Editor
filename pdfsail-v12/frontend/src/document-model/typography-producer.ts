/**
 * Typography Producer（Story-6，Step 6.1）。
 *
 * 本模块建立 Typography 的**事实来源**（Producer），生产 TypographyMetrics。
 * 只回答「Who produces Typography?」；不涉及 DI / Composition / Consumer / 算法。
 *
 * 职责边界（METH-001 / Story-6 Out of Scope）：
 *   - 建立 Producer 事实来源 ✅
 *   - 稳定生成 TypographyMetrics ✅
 *   - 不接入 baselineToTop / topToBaseline（Step 6.1 无人消费）✅
 *   - 不引入真实 Font Metrics 算法（属 Font Metrics Story，Step 6.3）✅
 *
 * 本 Story 冻结的是 Producer 的**职责**（produce(...) → TypographyMetrics），
 * 而不是 Producer 的**输入**。输入属于实现细节，不属于架构契约。
 */

import type { TypographyMetrics } from "./typography";

/**
 * Producer 当前的最小输入（临时实现占位，**非冻结架构契约**）。
 *
 * baseline + fontSize 只是 CoordinateMapper 今天碰巧能提供的数据，
 * 不是 Typography Domain 自身的 Fact，因此**不作为 Producer 的长期接口**。
 * 未来输入应演进为 Glyph / TextRun / FontMetrics（Domain Fact），
 * 届时本输入类型会随实现演进，不构成外部依赖。
 */
export interface TypographyProducerInput {
  /** 真实基线（PDF y，当前实现占位） */
  baseline: number;
  /** 字号（PDF pt，当前实现占位） */
  fontSize: number;
  /**
   * 字体名（可选）。用于 font-aware ascent（Sprint-94 BBox Estimator 修复）。
   * 未提供时回退到通用 ASCENT_RATIO（0.72），保证向后兼容。
   */
  fontName?: string;
}

/**
 * Typography Producer —— 生产 TypographyMetrics 的事实来源。
 *
 * 职责：给定必要输入，产出 TypographyMetrics。
 * 不承诺输入的具体形态（当前为 TypographyProducerInput 占位，未来演进）。
 */
export interface TypographyProducer {
  produce(input: TypographyProducerInput): TypographyMetrics;
}

/**
 * baseline → 文本顶部（ascent）的比例（经验值，Story-4.1：Typography 经验估算，非真实 Font Metrics）。
 * Sprint-94（BBox Estimator 修复）：从固定 0.72 升级为 **font-aware ascent ratio**。
 * 不同字体的 ascent 差异显著（Helvetica≈0.8，Times≈0.9，CJK≈1.0），固定 0.72 导致 glyph bbox 偏高。
 */
const DEFAULT_ASCENT_RATIO = 0.72;

/** 已知字体家族的 ascent ratio（经验值，供 BBox 更贴近真实字体度量） */
const FONT_ASCENT_RATIOS: Record<string, number> = {
  // 西文
  "arial": 0.76,
  "helvetica": 0.76,
  "verdana": 0.79,
  "tahoma": 0.78,
  "times": 0.89,       // serif 高 ascent
  "timesnewroman": 0.89,
  "georgia": 0.88,
  "courier": 0.77,
  "calibri": 0.75,
  "trebuchetms": 0.81,
  // 中文（CJK 方块字 ascent 接近全高）
  "simsun": 0.86,
  "songti": 0.86,
  "stsong": 0.86,
  "simhei": 0.86,
  "heiti": 0.86,
  "microsoftyahei": 0.85,
  "msyh": 0.85,
};

/** 从字体名解析 ascent ratio（未知字体回退默认） */
export function ascentRatioForFont(fontName?: string): number {
  if (!fontName) return DEFAULT_ASCENT_RATIO;
  const clean = fontName
    .replace(/^[A-Z]{6}\+/, "")   // 去 subset 前缀
    .replace(/[-_]/g, "")
    .toLowerCase();
  // 精确匹配
  if (FONT_ASCENT_RATIOS[clean]) return FONT_ASCENT_RATIOS[clean];
  // 模糊匹配（clean 包含某个已知字体名）
  for (const [key, ratio] of Object.entries(FONT_ASCENT_RATIOS)) {
    if (clean.includes(key)) return ratio;
  }
  return DEFAULT_ASCENT_RATIO;
}

/** Producer 接口的默认实现：委托给模块级纯函数 produceTypographyMetrics。 */
export class AscentRatioTypographyProducer implements TypographyProducer {
  produce(input: TypographyProducerInput): TypographyMetrics {
    return produceTypographyMetrics(input);
  }
}

/**
 * 模块级 Producer 纯函数入口。
 *
 * 供调用方（CoordinateMapper 等）直接调用，**无 DI / 无 this.producer / 无 new**。
 * 适配层：输入 fontSize（旧事实），产出 TypographyMetrics（Domain Fact）。
 * 纪律：Producer 可以适配旧事实（fontSize），但 Capability 只消费 Domain Fact（TypographyMetrics）。
 */
export function produceTypographyMetrics(input: TypographyProducerInput): TypographyMetrics {
  // Sprint-94：font-aware ascent（BBox Estimator 修复）——按字体家族选择 ascent ratio，而非固定 0.72
  const ratio = ascentRatioForFont(input.fontName);
  const ascent = input.fontSize * ratio;
  return {
    baseline: input.baseline,
    ascent,
    descent: input.fontSize - ascent,
    lineHeight: input.fontSize,
  };
}
