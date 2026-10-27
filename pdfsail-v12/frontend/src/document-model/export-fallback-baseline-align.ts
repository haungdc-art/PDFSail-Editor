/**
 * EXPORT-SPACE-02 · RAW-FALLBACK-01 · 修正 1：fallback 绘制 baseline 语义开关
 *
 * 背景：fallback 绘制（tryDrawNonWinAnsiAsCid → pdf-lib drawText）的 y 来自
 * L2485/L2525 的 `glyph.baseline ?? glyph.y`。native-replay 邻行命令（L1566 push）
 * 不携带 baseline 字段 ⇒ 恒走 `glyph.y`（bbox 底边语义）⇒ 与 raw 直发（pdfY 第一手
 * 基线）产生实测 4.47pt 差（a05 同逻辑基线样本，SPEC R5-B）。
 *
 * 本 flag 启用时：L1566 push 点为携带第一手 `metrics.pdfTransform[5]`（真实 PDF
 * 基线）的 glyph 补 `baseline` 字段 ⇒ L2485 的 baseline 分支生效 ⇒ fallback 绘制
 * 与 raw 直发共用同一基线定义。
 *
 * **默认关闭** = 现状逐位不变（回滚 = 移除注入）。
 * 无 provenance 的纯 fallback 字符（无 pdfTransform）不受影响（无字段可补）。
 */
export const FALLBACK_BASELINE_ALIGN_FLAG_KEY = "__FALLBACK_BASELINE_ALIGN_FLAG__";

let overrideForTest: boolean | null = null;

/** 仅测试使用：null = 恢复默认（读 globalThis 逃生口，缺省关闭）。 */
export function setFallbackBaselineAlignForTest(v: boolean | null): void {
  overrideForTest = v;
}

export function isFallbackBaselineAlignEnabled(): boolean {
  if (overrideForTest !== null) return overrideForTest;
  return (
    typeof globalThis !== "undefined" &&
    (globalThis as Record<string, unknown>)[FALLBACK_BASELINE_ALIGN_FLAG_KEY] === true
  );
}

/**
 * baseCssY 优先级（生产与专项测试共用）：
 *   1. glyph.baseline（CSS，有限值）——既有行为；
 *   2. rawFallbackDirectBaselineEnabled 且 directRawCssBaseline（有限值）——
 *      修正 2 方案 A-direct：同段落可信 raw pdfY 的 CSS 等效（独立 flag）；
 *   3. fallbackBaselineAlignEnabled 且 line.baseline（CSS，有限值）——
 *      修正 1 行级兜底；
 *   4. bbox 底部（bbox-top 语义，旧兜底）——flags 关闭时保持原行为逐位不变。
 */
export function resolveBaseCssY(args: {
  glyphBaseline: number | undefined | null;
  lineBaseline: number | undefined | null;
  fallbackBaselineAlignEnabled: boolean;
  bboxBottom: number;
  /** 修正 2 · A-direct：同段落可信 raw pdfY 的 CSS 等效（独立 flag 开启时传入） */
  directRawCssBaseline?: number | undefined | null;
  rawFallbackDirectBaselineEnabled?: boolean;
}): number {
  if (typeof args.glyphBaseline === "number" && Number.isFinite(args.glyphBaseline)) {
    return args.glyphBaseline;
  }
  if (
    args.rawFallbackDirectBaselineEnabled &&
    typeof args.directRawCssBaseline === "number" &&
    Number.isFinite(args.directRawCssBaseline)
  ) {
    return args.directRawCssBaseline;
  }
  if (
    args.fallbackBaselineAlignEnabled &&
    typeof args.lineBaseline === "number" &&
    Number.isFinite(args.lineBaseline)
  ) {
    return args.lineBaseline;
  }
  return args.bboxBottom;
}
