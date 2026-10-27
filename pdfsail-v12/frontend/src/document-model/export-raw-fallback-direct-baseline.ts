/**
 * EXPORT-SPACE-02 · RAW-FALLBACK-01 · 修正 2 方案 A-direct：raw 直发基线参照开关
 *
 * 契约：同段落存在可信、可追溯、未重排的 raw `pdfY`（glyph.metrics.pdfTransform[5]）
 * 时，fallback 字符的绘制基线直接使用该第一手基线（经 `pdfYToCssY` 同构换算回 CSS，
 * 再走既有 baseline→PDF 转换），而非 layoutBaseline 的 0.80 推算。
 *
 * 优先级（resolveBaseCssY）：glyph.baseline → (本 flag) raw 参照 → (修正 1 flag)
 * line.baseline → bbox 底部。参考缺失/失效（无 raw glyph、重排行）时 fail-closed
 * 回退修正 1 已验收行为。
 *
 * **默认关闭**；与修正 1 的 flag 独立（两者验证不同策略，须独立开关与回滚）。
 */
export const RAW_FALLBACK_DIRECT_BASELINE_FLAG_KEY = "__RAW_FALLBACK_DIRECT_BASELINE_FLAG__";

let overrideForTest: boolean | null = null;

/** 仅测试使用：null = 恢复默认（读 globalThis 逃生口，缺省关闭）。 */
export function setRawFallbackDirectBaselineForTest(v: boolean | null): void {
  overrideForTest = v;
}

export function isRawFallbackDirectBaselineEnabled(): boolean {
  if (overrideForTest !== null) return overrideForTest;
  return (
    typeof globalThis !== "undefined" &&
    (globalThis as Record<string, unknown>)[RAW_FALLBACK_DIRECT_BASELINE_FLAG_KEY] === true
  );
}

/**
 * A-direct 参考解析（生产与专项测试共用）：
 * 从**同一逻辑行**的 glyph 命令中取首个可信 raw PDF 基线（pdfTransform[5]，第一手）。
 * - 仅接受有限数值（undefined/NaN/Infinity 一律排除，不得进入直通分支）；
 * - 行内作用域由调用方保证（只在同一 lineGlyphs 分组内调用 ⇒ 不跨行借用）；
 * - 无可信参考 ⇒ undefined ⇒ 调用方 fail-closed 回退修正 1 兜底。
 */
export function resolveDirectRawPdfY(
  glyphs: ReadonlyArray<{ pdfTransform?: readonly number[] | undefined } | undefined>,
): number | undefined {
  for (const g of glyphs) {
    const f = g?.pdfTransform?.[5];
    if (typeof f === "number" && Number.isFinite(f)) return f;
  }
  return undefined;
}

/**
 * RAW-CID-01 · pdfTransform 完整性校验（生产与测试同源）：
 * 存在、长度恰好 6、六个元素均为有限数字（拒绝 NaN/Infinity）。
 */
export function isValidPdfTransform(
  t: unknown,
): t is readonly [number, number, number, number, number, number] {
  if (!Array.isArray(t) || t.length !== 6) return false;
  return t.every((v) => typeof v === "number" && Number.isFinite(v));
}
