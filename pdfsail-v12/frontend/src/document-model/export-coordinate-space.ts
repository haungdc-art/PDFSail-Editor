/**
 * export-coordinate-space.ts — CSS 显示坐标 ⇄ PDF pt 坐标换算（**唯一实现模块**）。
 *
 * F3B-6.28 · D-3B-2：把 `cssToPdf` / `cssToPdfX` / `ExportContext` 从
 * `document-model/export-renderer.ts` 抽出成**中立纯模块**。
 *
 * 动机（架构边界，非行为变更）：`editor/binding/*` 受 012-B 边界守卫约束，
 * 禁止 import `export-renderer`；但 Binding 侧的重绘几何（D-3A/3B）必须使用
 * **同一套** CSS→PDF 坐标口径（绝不允许出现第二套换算）。把这几个纯函数
 * 放到中立模块，导出渲染器与 Binding 各自从这里 import —— 行为逐位不变。
 *
 * ── 两种显式命名契约（F3B-6.28 · D-3B-4 修复）────────────────────────────
 *   单一实现模块 ≠ 所有调用方共享同一种坐标语义。X 分量历史上存在两种契约，
 *   在此**显式命名**，禁止隐混：
 *
 *   ① `cssToPdfX`（**legacy-overlay 契约**）：`cssX / renderScale`。
 *      M7.8-048-FIX-EXPORT-X 锁定的历史行为；`EXPORT_SCALE_ALIGN_FLAG` 可将其
 *      切换为 ②（默认关闭 = 现状逐位不变，回滚安全）。消费方 = legacy overlay /
 *      mask / 旋转 / 签名等经 `cssToPdf` 的既有路径 —— **行为逐位不变**。
 *
 *   ② `cssToPdfXDocumentSpace`（**document-space 契约**）：`cssX / totalScale`。
 *      导入侧 `CoordinateMapper.pdfToCss` 的产物是 `×(viewportScale × cssScale)`
 *      （见 CoordinateMapper.ts L80），其精确逆为 `÷totalScale`，与 `cssToPdf` 的
 *      y/width/height **同口径**。消费方 = D-3B 重绘几何（其输入全部来自 legacy
 *      bbox / flow CSS 空间，与导入侧 CoordinateMapper 同构）。
 *
 *   ⚠️ 背景（P0 修复）：cssScale ≠ 1 时两契约相差恒定因子 cssScale（gd-swim 实测
 *      −10.31% ⇒ 被编辑 unit 整体左偏约 4.4mm）。修复前重绘几何误用 ①，而 y 用
 *      totalScale ⇒ X 与几何链分裂。修复 = 重绘几何显式改用 ②；① 逐位不变。
 *      二者在 cssScale === 1 时数值一致（既有单测不受影响）。
 *
 * 本模块必须保持零副作用（只读 `EXPORT_SCALE_ALIGN_FLAG`），不得引入
 * React / DOM / pdf-lib 依赖。
 */
import { isExportScaleAlignEnabled } from "./export-scale-align";

/** 导出上下文（坐标转换参数） */
export interface ExportContext {
  /** PDF 渲染 scale（通常 1.5） */
  renderScale: number;
  /** CSS 显示缩放（canvas.clientWidth / canvas.width） */
  cssScale: number;
  /** 页面高度（PDF pt，用于 Y 翻转） */
  pageHeightPt: number;
  /**
   * M7.8-035-FIX-4：页面**顶部**的 PDF 纵坐标（= MediaBox.y1），Y 翻转的真正基准。
   *
   * 导入侧 CoordinateMapper.pdfYToCssY 用的是 `originYDevice = vp.transform[5]`
   * = MediaBox.y1 × scale，即 CSS 原点在 **y1**（不是 y0）。
   * 而这里 pageHeightPt = page.height / scale = MediaBox.**height** = y1 − y0。
   * 当 MediaBox.y0 ≠ 0 时两者相差 y0，导出翻转会把内容整体下移 y0：
   *   - 文字走原生重放（直接用原始 pdfTransform）→ 位置仍正确；
   *   - mask 走 cssToPdf → 位置偏移 y0 → 擦到下一行 / 漏掉旧文字。
   * 缺省时回退 pageHeightPt，保证 y0 === 0 的 PDF 行为完全不变。
   */
  pageTopPt?: number;
}

/**
 * CSS 显示坐标 → PDF pt 坐标（Y 翻转）
 *
 * @param cssRect CSS 显示坐标 { x, y, width, height }
 * @param ctx 导出上下文
 * @returns PDF pt 坐标 { x, y, width, height }
 */
export function cssToPdf(
  cssRect: { x: number; y: number; width: number; height: number },
  ctx: ExportContext
): { x: number; y: number; width: number; height: number } {
  const totalScale = ctx.renderScale * ctx.cssScale;
  // M7.8-035-FIX-4：以页面顶部（MediaBox.y1）为翻转基准，与导入侧 pdfYToCssY 自洽。
  const flipBase = ctx.pageTopPt ?? ctx.pageHeightPt;
  // M7.8-048-FIX-EXPORT-X：glyph.bbox 是 renderScale 文档坐标系（CSS px @ scale=renderScale），
  // cssScale 仅是「显示缩放」（clientWidth/canvas.width），不参与文档坐标换算。
  // 此前 ptX 被多除了 cssScale → 编辑 overlay 文字相对原图右移 (约 cssScale 偏离量)。
  // Y 仍由 baseline 单独处理、width/height 仅用于 mask bbox，故仅修正 X 一个维度。
  // SCALE-MISMATCH-01（EXPORT-SPACE-02）：cssScale ≠ 1 时该特例使 X 与几何链产生
  // 恒定偏差 = cssScale（实测 −10.31%）。EXPORT_SCALE_ALIGN_FLAG 启用后 ptX 与
  // y/width/fontSize 同口径（÷ totalScale）；默认关闭 = M7.8-048 现状逐位不变。
  const ptX = cssToPdfX(cssRect.x, ctx);
  const ptY = flipBase - (cssRect.y / totalScale) - (cssRect.height / totalScale);
  const ptW = cssRect.width / totalScale;
  const ptH = cssRect.height / totalScale;
  return { x: ptX, y: ptY, width: ptW, height: ptH };
}

/**
 * CSS x → PDF x（**与 `cssToPdf` 同一实现的 X 分量**）。
 *
 * F3B-6.28 · D-3A：逐字符重绘几何需要「单个 x」的换算。为避免出现第二套坐标口径，
 * 这里抽出 `cssToPdf` 的 X 分量作为唯一实现，`cssToPdf` 自身也改调它
 * （同一 flag、同一除数，行为逐位不变）。
 */
export function cssToPdfX(cssX: number, ctx: ExportContext): number {
  const totalScale = ctx.renderScale * ctx.cssScale;
  return isExportScaleAlignEnabled() ? cssX / totalScale : cssX / ctx.renderScale;
}

/**
 * CSS x → PDF x（**document-space 契约**：÷ totalScale，与 y/width/height 同口径）。
 *
 * 语义与适用边界见文件头「两种显式命名契约」：
 *   · 输入空间 = 导入侧 CoordinateMapper 产物（`×(viewportScale × cssScale)`），
 *     其精确逆为 `÷(renderScale × cssScale)`；
 *   · 与 `cssToPdfX`（legacy-overlay 契约，÷ renderScale，M7.8-048 历史行为）
 *     是**两种显式命名契约**：cssScale ≠ 1 时相差恒定因子 cssScale；
 *   · **无 flag 分支**：本契约的正确性不依赖 legacy 迁移开关（flag 只治理 ①）。
 *
 * 消费方：F3B-6.28 · D-3B 重绘几何（flow 成员行/位移行的盒 x 与逐字符 targetXPt）。
 */
export function cssToPdfXDocumentSpace(cssX: number, ctx: ExportContext): number {
  const totalScale = ctx.renderScale * ctx.cssScale;
  return cssX / totalScale;
}
