/**
 * EXPORT-SPACE-02 · SCALE-MISMATCH-01 · S1：导出 X 换算同口径开关
 *
 * 背景：`cssToPdf`（export-renderer.ts）的 ptX 自 M7.8-048-FIX-EXPORT-X 起只除
 * renderScale，而 y/width/fontSize 除 (renderScale × cssScale)。cssScale ≠ 1 时
 * X 与几何链（import scale）产生恒定偏差 = cssScale（实测 −10.31%）。
 *
 * 本 flag 启用后 ptX 与其它维度同口径（÷ totalScale）。
 * **默认关闭** = M7.8-048 现状逐位不变（回滚安全）。
 *
 * 注入方式：
 *   - 单测：setExportScaleAlignForTest(true / false / null)
 *   - 浏览器 e2e：window.__EXPORT_SCALE_ALIGN_FLAG__ = true（导出前设置）
 *
 * ⚠️ 上线默认值仍为关闭；联合验收通过前不得改为 true。
 */
export const EXPORT_SCALE_ALIGN_FLAG_KEY = "__EXPORT_SCALE_ALIGN_FLAG__";

let overrideForTest: boolean | null = null;

/** 仅测试使用：null = 恢复默认（读 globalThis 逃生口，缺省关闭）。 */
export function setExportScaleAlignForTest(v: boolean | null): void {
  overrideForTest = v;
}

export function isExportScaleAlignEnabled(): boolean {
  if (overrideForTest !== null) return overrideForTest;
  return (
    typeof globalThis !== "undefined" &&
    (globalThis as Record<string, unknown>)[EXPORT_SCALE_ALIGN_FLAG_KEY] === true
  );
}
