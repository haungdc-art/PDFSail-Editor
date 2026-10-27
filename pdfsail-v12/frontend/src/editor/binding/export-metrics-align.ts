/**
 * EXPORT-SPACE-02 · SCALE-MISMATCH-01 · S2：导出 Core relayout metrics 对齐开关
 *
 * 背景：屏幕路径 relayout 注入 `buildMetricsByTextBoxFromLegacy`（PDFEditor.tsx
 * 可见层 + mask 两处），而导出路径 `buildCoreExportContext` 调
 * `buildCoreRenderSourceFromDocument(document)` **不传 metrics** ⇒ layoutTextBox
 * 走空 provider 兜底（advance = fontSize×0.5，`legacy-generic`）。
 * ⇒ 导出行分配与屏幕不一致（实测：去空格变体 21 长塞 L1，越界丢 2 字）。
 *
 * 本 flag 启用后，导出 relayout 注入与屏幕同款的 metrics builder
 * （`buildMetricsByTextBoxFromLegacy(legacy, document)`）。
 * **默认关闭** = 现状逐位不变（回滚安全）。
 *
 * 注入方式：
 *   - 单测：setExportMetricsAlignForTest(true / false / null)
 *   - 浏览器 e2e：window.__EXPORT_METRICS_ALIGN_FLAG__ = true（导出前设置）
 *
 * ⚠️ 上线默认值仍为关闭；联合验收通过前不得改为 true。
 * ⚠️ metrics 注入不保证编辑后新生成 glyph 有有效原始度量 —— 覆盖缺口
 *    （textBox 无 metrics entry ⇒ injected=false）会以 warning 明确记录，
 *    不静默声称已与屏幕对齐。
 */
export const EXPORT_METRICS_ALIGN_FLAG_KEY = "__EXPORT_METRICS_ALIGN_FLAG__";

let overrideForTest: boolean | null = null;

/** 仅测试使用：null = 恢复默认（读 globalThis 逃生口，缺省关闭）。 */
export function setExportMetricsAlignForTest(v: boolean | null): void {
  overrideForTest = v;
}

export function isExportMetricsAlignEnabled(): boolean {
  if (overrideForTest !== null) return overrideForTest;
  return (
    typeof globalThis !== "undefined" &&
    (globalThis as Record<string, unknown>)[EXPORT_METRICS_ALIGN_FLAG_KEY] === true
  );
}
