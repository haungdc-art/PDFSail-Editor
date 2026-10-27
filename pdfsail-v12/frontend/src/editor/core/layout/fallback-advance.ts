/**
 * editor/core/layout/fallback-advance.ts — 4B-4G · **Character-aware fallback metrics contract**
 *
 * ══ 它解决什么（4B-4F 的实测结论）══════════════════════════════════════
 *   Core 的断行在「新增字符」上系统性低估：
 *     新增「长」 → 无 PDF glyph provenance → `createDiffedLineMetrics` 返回 undefined
 *              → `metrics.ts` 兜底 `fontSize * 0.5` = 10.73px
 *              → Core 认为一行可放 48 个「长」（48 × 10.73 ≈ 515 ≤ 517.61）
 *     而 DOM 真实 fallback = 21.45px ⇒ 48 字 = 1029.6px ⇒ 折 2 行
 *     ⇒ Core 5 行 vs DOM 7 行，残差 ≈ 43px（**ratio 恰好 2.00**）
 *
 * ══ 本模块的定位（用户裁决）════════════════════════════════════════════
 *   这是 **Core fallback metrics policy**，**不是**新的 Font Metrics Bridge。
 *
 *     PDF glyph provenance   →  `pdfsail-glyph`（真实 PDF advance）**完全不动**
 *     无 provenance          →  character-aware fallback（本模块）
 *
 *   且 fallback **不是** `ADVANCE_SOURCE_ORDER` 里的新一级 —— 它是
 *   「四级全部未命中之后」的兜底策略，属于 **advance calculation strategy**，
 *   不是新的 provenance source：
 *
 *     advanceSource ── pdfsail-glyph
 *                  └── fallback ┬─ east-asian-wide → 1.0em
 *                               └─ generic         → 0.5em
 *
 * ══ 三条硬纪律 ════════════════════════════════════════════════════════
 *   1. **真实 glyph metrics > character-aware fallback > generic fallback**
 *      本模块**只在没有真实 metrics 时**被调用，绝不覆盖 `pdfsail-glyph`。
 *   2. `1.0em` 是 **fallback approximation**，不是"CJK 字符 = 1em"的断言。
 *      有真实 metrics 时本模块不参与。
 *   3. **unknown 不激进扩大**：emoji / 无法判定的字符一律 `unknown`
 *      ⇒ 保持 `0.5em`（当前行为），**仅**在 observability 上区分，
 *      绝不因为"看起来宽"就归到 wide。
 *
 * ★ 4B-4G 阶段：**纯契约，未接线**。生产接入属 4B-4H，届时不动 `ADVANCE_SOURCE_ORDER`。
 *
 * 硬边界：0 DOM / 0 React / 0 Core import（除 types）/ 0 Command / 0 History。
 */

import type { FallbackKind } from "./types";

/** fallback 宽度分类。 */
export type FallbackWidthClass = "narrow" | "wide" | "unknown";

export type { FallbackKind };

/**
 * East Asian **Wide / Fullwidth** 码点区间（UAX #11 的 W 与 F 的常用子集）。
 *
 * ⚠️ 刻意**不含** Halfwidth（U+FF61–U+FFDC）与 Ambiguous（A）——
 *    后者在不同字体下可宽可窄，归 `narrow` 即保持当前行为（纪律 3）。
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3], // CJK Radicals Supplement
  [0x2f00, 0x2fd5], // Kangxi Radicals
  [0x3000, 0x303e], // CJK Symbols and Punctuation（含 U+3000 全角空格）
  [0x3041, 0x3096], // Hiragana
  [0x3099, 0x30ff], // Katakana
  [0x3105, 0x312f],
  [0x3131, 0x318e], // Hangul Compatibility / Extended-A Jamo
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x4dbf], // 至 CJK Ext A
  [0x4e00, 0xa48c], // CJK Unified Ideographs（★ 中/文/长/日）+ Yi
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe10, 0xfe19], // Vertical forms
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60], // ★ Fullwidth forms：Ａ(FF21) ＠(FF20) ，(FF0C) ：(FF1A)
  [0xffe0, 0xffe6],
  [0x1b000, 0x1b001],
  [0x1f200, 0x1f2ff], // Enclosed Ideographic Supplement（Wide，非 emoji）
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/**
 * Emoji / 符号区 —— **一律 `unknown`，不猜宽度**（用户裁决）。
 *
 * ⚠️ 与 `WIDE_RANGES` **必须互斥**：emoji 从 0x1F300 起，而 Wide 只到 0x1F2FF。
 * ⚠️ 判定顺序：**先 emoji，后 wide** —— emoji 区里的字符即使 EAW 标 W 也不当 CJK。
 */
const EMOJI_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1f300, 0x1f5ff], // Misc Symbols and Pictographs
  [0x1f600, 0x1f64f], // Emoticons（★ 🙂 U+1F642）
  [0x1f650, 0x1f67f],
  [0x1f680, 0x1f6ff],
  [0x1f700, 0x1f77f],
  [0x1f780, 0x1f7ff],
  [0x1f800, 0x1f8ff],
  [0x1f900, 0x1f9ff],
  [0x1fa00, 0x1faff],
  [0x2600, 0x27bf], // Misc Symbols + Dingbats（❤ U+2764 等）
  [0x2b00, 0x2bff], // Misc Symbols and Arrows（⭐ U+2B50 等）
  [0x1f1e6, 0x1f1ff], // Regional indicators
  [0xfe0f, 0xfe0f], // VS16
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of ranges) if (cp >= lo && cp <= hi) return true;
  return false;
}

/**
 * 分类单个字符的 fallback 宽度。
 *
 * @param char **单个 code point**（代理对为 2 个 UTF-16 单元，与 `GlyphMetricsQuery.char` 同口径）
 * @returns `"wide"` / `"narrow"` / `"unknown"`
 */
export function classifyFallbackWidth(char: string): FallbackWidthClass {
  if (typeof char !== "string" || char.length === 0) return "unknown";
  const cp = char.codePointAt(0);
  if (cp === undefined) return "unknown";
  // ★ 必须是**恰好一个** code point：多字符 / 孤立代理项一律 unknown（不猜）
  const cpLen = cp > 0xffff ? 2 : 1;
  if (char.length !== cpLen) return "unknown";
  if (cp >= 0xd800 && cp <= 0xdfff) return "unknown";

  // ① emoji 优先：**不猜宽度**
  if (inRanges(cp, EMOJI_RANGES)) return "unknown";
  // ② East Asian Wide / Fullwidth
  if (inRanges(cp, WIDE_RANGES)) return "wide";
  // ③ 其余（Latin / 数字 / 半角标点 / Ambiguous / Neutral）保持既有行为
  return "narrow";
}

/** 分类 → observability 用的 kind 标签。 */
export function fallbackKindOf(char: string): FallbackKind {
  switch (classifyFallbackWidth(char)) {
    case "wide":
      return "east-asian-wide";
    case "narrow":
      return "generic";
    default:
      return "unknown";
  }
}

/**
 * 分类 → em 系数。
 *
 *   wide    → 1.0（全角近似）
 *   narrow  → 0.5（**与当前 `fontSize * 0.5` 逐位一致** ⇒ 对 Latin 零行为变化）
 *   unknown → 0.5（纪律 3：**保持当前行为**，只在 observability 上区分）
 */
export function fallbackEmOf(cls: FallbackWidthClass): number {
  return cls === "wide" ? 1.0 : 0.5;
}

export interface FallbackAdvanceQuery {
  readonly char: string;
  readonly fontSize: number;
}

/**
 * ★ Character-aware fallback advance（4B-4H 将注入 `FontMetricsProviderOptions.fallbackAdvance`）。
 *
 *   ⚠️ 签名接受 `{char, fontSize}` 而非整个 `GlyphMetricsQuery` —— 便于单测，
 *      且与 `metrics.ts` 的 `fallbackAdvance(query)` 形状兼容（后者**已有** `query.char`）。
 */
export function characterAwareFallbackAdvance(query: FallbackAdvanceQuery): number {
  const size = Number.isFinite(query.fontSize) ? Math.max(0, query.fontSize) : 0;
  return size * fallbackEmOf(classifyFallbackWidth(query.char));
}

/**
 * 逐字符分类整段文本（mixed text 回归矩阵用）。
 * ★ 按 **code point** 切分（不是 UTF-16 单元），emoji 不会被拆成两半。
 */
export function classifyFallbackText(text: string): Array<{ char: string; cls: FallbackWidthClass }> {
  return Array.from(text).map((char) => ({ char, cls: classifyFallbackWidth(char) }));
}
