/**
 * CoordinateMapper — Commit 5 + baseline alignment fix
 *
 * PDF pt → CSS px 坐标转换。
 *
 * 公式：
 *   CSS px = PDF pt × zoom × 96 / 72
 *
 * PDF 坐标系：bottom-left origin（y 从下往上）
 * CSS 坐标系：top-left origin（y 从上往下）
 *
 * 需要的输入：
 *   - viewport：PDF.js viewport（含 scale + width/height）
 *   - cssScale：canvas.clientWidth / canvas.width（CSS 显示缩放）
 *
 * Y 轴翻转 + baseline 修正：
 *   PDF.js transform[5] 是文字基线（baseline），不是文本框顶部。
 *   cssY = (viewportHeight - baselineY - ascent × fontSize) × totalScale
 *
 *   baseline → top 由外部 Typography 能力 baselineToTop() 提供，CoordinateMapper 不拥有其语义、
 *   不知道它如何实现（ascent / 0.72 / Font Metrics）。
 *   （Story-5 Ownership Freeze：CoordinateMapper 只调用 Typography 能力，不解释/不拥有它。）
 */

import { baselineToTop, topToBaseline } from "./typography";
import { produceTypographyMetrics } from "../document-model/typography-producer";

/** PDF pt → CSS px 的转换上下文 */
export interface MapperContext {
  /** PDF.js viewport scale（通常 1.5） */
  viewportScale: number;
  /** PDF.js viewport height（pt，未应用 scale） */
  viewportHeight: number;
  /** PDF.js viewport width（pt，未应用 scale） */
  viewportWidth: number;
  /** CSS 显示缩放（canvas.clientWidth / canvas.width） */
  cssScale: number;
  /**
   * PDF.js viewport.transform 的设备像素平移量（crop 偏移补偿）。
   *   pdf.js 真实映射：deviceX = viewportScale·x + originXDevice
   *                    deviceY = originYDevice − viewportScale·y
   * 不传则回退旧行为：originXDevice=0, originYDevice=viewportHeight·viewportScale
   * （仅当 cropbox 与 mediabox 完全重合时才等价于正确值）。
   */
  originXDevice?: number;
  originYDevice?: number;
}

export class CoordinateMapperImpl implements CoordinateMapper {
  private ctx: MapperContext;

  constructor(ctx: MapperContext) {
    this.ctx = ctx;
  }

  /** 页面宽度（PDF pt） */
  getPageWidthPt(): number {
    return this.ctx.viewportWidth;
  }

  /**
   * PDF pt bbox → CSS px bbox
   *
   * @param pdfX PDF x（pt，left）
   * @param pdfY PDF y（pt，baseline，bottom-left origin）
   * @param pdfW 宽（pt）
   * @param pdfH 高（pt，通常 = fontSize）
   */
  pdfToCss(pdfX: number, pdfY: number, pdfW: number, pdfH: number): { x: number; y: number; w: number; h: number } {
    const { viewportScale, viewportHeight, cssScale } = this.ctx;
    const ox = this.ctx.originXDevice ?? 0;
    const oy = this.ctx.originYDevice ?? viewportHeight * viewportScale;
    const totalScale = viewportScale * cssScale;
    // Call-site Adaptation：把 fontSize（旧事实）交给 Producer 生成 TypographyMetrics（Domain Fact）。
    // 纪律：Producer 可以适配旧事实，但 Capability（baselineToTop）只消费 Domain Fact（metrics）。
    const metrics = produceTypographyMetrics({ baseline: pdfY, fontSize: pdfH });
    // Typography 部分：baseline → top（PDF 空间），委托给外部 Typography 能力。
    const topPdf = baselineToTop(pdfY, metrics);
    return {
      x: (ox + pdfX * viewportScale) * cssScale,
      // 坐标部分：对 PDF top 做 Y 翻转 + 缩放 + crop 平移，得到 CSS 文本框顶部。
      y: (oy - topPdf * viewportScale) * cssScale,
      w: pdfW * totalScale,
      h: pdfH * totalScale,
    };
  }

  /** CSS px → PDF pt（反向转换，编辑后写回 PDF 时用） */
  cssToPdf(cssX: number, cssY: number, cssW: number, cssH: number): { x: number; y: number; w: number; h: number } {
    const { viewportScale, viewportHeight, cssScale } = this.ctx;
    const ox = this.ctx.originXDevice ?? 0;
    const totalScale = viewportScale * cssScale;
    // 坐标部分：CSS top → PDF top（Y 翻转 + 缩放逆）。
    const topPdf = this.cssYToPdfY(cssY);
    // Call-site Adaptation：把 fontSize（旧事实）交给 Producer 生成 TypographyMetrics（Domain Fact）。
    const metrics = produceTypographyMetrics({ baseline: topPdf, fontSize: cssH / totalScale });
    // Typography 部分：top → baseline（PDF 空间），委托给外部 Typography 能力。
    const baselinePdf = topToBaseline(topPdf, metrics);
    return {
      x: (cssX / cssScale - ox) / viewportScale,
      y: baselinePdf,
      w: cssW / totalScale,
      h: cssH / totalScale,
    };
  }

  /** 更新 CSS scale（canvas resize 后调用） */
  updateCssScale(cssScale: number) {
    this.ctx.cssScale = cssScale;
  }

  /**
   * 字体大小转换：PDF pt → CSS display px
   *
   * 与原 coord.ts LockCoordSystem.fromPDF 一致：
   *   CSS px = pt × viewportScale × cssScale
   *
   * 注意：不包含 96/72 转换（PDF.js viewport 已处理 pt → canvas px）
   */
  scaleFontSize(pt: number): number {
    const { viewportScale, cssScale } = this.ctx;
    return pt * viewportScale * cssScale;
  }

  /**
   * PDF Y → CSS Y（纯坐标转换，语义无关，ADR-008）。
   *
   * 只做 Y 翻转（PDF bottom-left → CSS top-left）+ 缩放。
   * 不知道传入的 Y 是 baseline / top / center——只是坐标。
   */
  pdfYToCssY(pdfY: number): number {
    const { viewportScale, viewportHeight, cssScale } = this.ctx;
    const oy = this.ctx.originYDevice ?? viewportHeight * viewportScale;
    const totalScale = viewportScale * cssScale;
    return (oy - pdfY * viewportScale) * cssScale;
  }

  /** CSS Y → PDF Y（纯坐标转换，语义无关，ADR-008） */
  cssYToPdfY(cssY: number): number {
    const { viewportScale, viewportHeight, cssScale } = this.ctx;
    const oy = this.ctx.originYDevice ?? viewportHeight * viewportScale;
    const totalScale = viewportScale * cssScale;
    return oy / viewportScale - cssY / totalScale;
  }
}

/** CoordinateMapper 接口（供 SegmentBuilder 依赖注入） */
export interface CoordinateMapper {
  pdfToCss(pdfX: number, pdfY: number, pdfW: number, pdfH: number): { x: number; y: number; w: number; h: number };
  cssToPdf(cssX: number, cssY: number, cssW: number, cssH: number): { x: number; y: number; w: number; h: number };
  /** PDF Y → CSS Y（纯坐标转换，语义无关，ADR-008） */
  pdfYToCssY(pdfY: number): number;
  /** CSS Y → PDF Y（纯坐标转换，语义无关，ADR-008） */
  cssYToPdfY(cssY: number): number;
  /** 页面宽度（PDF pt） */
  getPageWidthPt(): number;
  updateCssScale(cssScale: number): void;
  scaleFontSize(pt: number): number;
}
