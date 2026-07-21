/**
 * CoordinateMapper — Commit 5
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
 * Y 轴翻转：
 *   cssY = (viewport.height - pdfY - textHeight) × scale × cssScale
 */

/** PDF pt → CSS px 的转换上下文 */
export interface MapperContext {
  /** PDF.js viewport scale（通常 1.5） */
  viewportScale: number;
  /** PDF.js viewport height（pt，未应用 scale） */
  viewportHeight: number;
  /** CSS 显示缩放（canvas.clientWidth / canvas.width） */
  cssScale: number;
}

export class CoordinateMapperImpl implements CoordinateMapper {
  private ctx: MapperContext;

  constructor(ctx: MapperContext) {
    this.ctx = ctx;
  }

  /**
   * PDF pt bbox → CSS px bbox
   *
   * @param pdfX PDF x（pt，left）
   * @param pdfY PDF y（pt，bottom-left origin）
   * @param pdfW 宽（pt）
   * @param pdfH 高（pt）
   */
  pdfToCss(pdfX: number, pdfY: number, pdfW: number, pdfH: number): { x: number; y: number; w: number; h: number } {
    const { viewportScale, viewportHeight, cssScale } = this.ctx;
    // PDF pt × viewport scale = canvas px
    // canvas px × cssScale = CSS display px
    const totalScale = viewportScale * cssScale;
    return {
      x: pdfX * totalScale,
      // Y 翻转：PDF bottom-left → CSS top-left
      // pdfY 是 baseline，textHeight 是字体高度，需要减去 ascender（约 0.8 × height）
      y: (viewportHeight - pdfY - pdfH * 0.8) * totalScale,
      w: pdfW * totalScale,
      h: pdfH * totalScale,
    };
  }

  /** CSS px → PDF pt（反向转换，编辑后写回 PDF 时用） */
  cssToPdf(cssX: number, cssY: number, cssW: number, cssH: number): { x: number; y: number; w: number; h: number } {
    const { viewportScale, viewportHeight, cssScale } = this.ctx;
    const totalScale = viewportScale * cssScale;
    return {
      x: cssX / totalScale,
      y: viewportHeight - (cssY / totalScale) - (cssH / totalScale) * 0.8,
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
}

/** CoordinateMapper 接口（供 SegmentBuilder 依赖注入） */
export interface CoordinateMapper {
  pdfToCss(pdfX: number, pdfY: number, pdfW: number, pdfH: number): { x: number; y: number; w: number; h: number };
  cssToPdf(cssX: number, cssY: number, cssW: number, cssH: number): { x: number; y: number; w: number; h: number };
  updateCssScale(cssScale: number): void;
  scaleFontSize(pt: number): number;
}
