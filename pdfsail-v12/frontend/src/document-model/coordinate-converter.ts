/**
 * CoordinateConverter — Document Coordinate Space（Task 1）
 *
 * 统一坐标系统，禁止 PDF px / Canvas px / CSS px 混用。
 *
 * 三个坐标空间：
 *   1. PDF Space     — PDF 原生坐标，单位 pt，原点 bottom-left，Y 向上
 *   2. Document Space — 文档内部坐标，单位 px，原点 top-left，Y 向下（与 CSS 一致）
 *   3. Screen Space  — 屏幕显示坐标，单位 px，受 zoom 影响
 *
 * 转换链：
 *   PDF pt ↔ Document px ↔ Screen px
 *
 * 关系：
 *   Document px = PDF pt × renderScale × cssScale
 *   Screen px = Document px × zoom
 *
 * renderScale：pdf.js viewport scale（通常 1.5）
 * cssScale：canvas.clientWidth / canvas.width（canvas px → CSS px）
 * zoom：用户缩放（编辑器画布缩放，默认 1）
 */

/** Document Coordinate Space 的配置上下文 */
export interface CoordContext {
  /** PDF 渲染 scale（pdf.js viewport scale，通常 1.5） */
  renderScale: number;
  /** canvas.clientWidth / canvas.width（canvas px → CSS px） */
  cssScale: number;
  /** 页面高度（PDF pt，用于 Y 轴翻转） */
  pageHeightPt: number;
  /** 用户缩放倍数（默认 1） */
  zoom?: number;
}

/** 坐标点 */
export interface Point {
  x: number;
  y: number;
}

/** 尺寸 */
export interface Size {
  width: number;
  height: number;
}

/** 矩形（Document Space） */
export interface DocRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class CoordinateConverter {
  private ctx: CoordContext;

  constructor(ctx: CoordContext) {
    this.ctx = ctx;
  }

  /** 更新 cssScale（canvas resize 后调用） */
  updateCssScale(cssScale: number): void {
    this.ctx.cssScale = cssScale;
  }

  /** 更新 zoom（用户缩放时调用） */
  updateZoom(zoom: number): void {
    this.ctx.zoom = zoom;
  }

  // ── PDF pt ↔ Document px ──

  /**
   * PDF pt → Document px（Y 轴翻转：bottom-left → top-left）
   *
   * @param pdfX PDF X（pt）
   * @param pdfY PDF Y（pt，baseline，bottom-left origin）
   * @param pdfW 宽（pt）
   * @param pdfH 高（pt）
   * @returns DocRect（Document px）
   */
  pdfToDocument(
    pdfX: number,
    pdfY: number,
    pdfW: number,
    pdfH: number
  ): DocRect {
    const { renderScale, cssScale, pageHeightPt } = this.ctx;
    const totalScale = renderScale * cssScale;
    return {
      x: pdfX * totalScale,
      // Y 翻转：PDF bottom-left baseline → Document top-left
      // pdfY 是基线，文本框顶部 = pageHeight - pdfY - pdfH
      y: (pageHeightPt - pdfY - pdfH) * totalScale,
      width: pdfW * totalScale,
      height: pdfH * totalScale,
    };
  }

  /**
   * Document px → PDF pt（Y 轴翻转：top-left → bottom-left）
   *
   * 用于导出时把编辑后的 Document 坐标转回 PDF 坐标。
   */
  documentToPdf(rect: DocRect): {
    x: number;
    y: number;
    width: number;
    height: number;
  } {
    const { renderScale, cssScale, pageHeightPt } = this.ctx;
    const totalScale = renderScale * cssScale;
    return {
      x: rect.x / totalScale,
      y: pageHeightPt - (rect.y / totalScale) - (rect.height / totalScale),
      width: rect.width / totalScale,
      height: rect.height / totalScale,
    };
  }

  // ── Document px ↔ Screen px ──

  /**
   * Document px → Screen px（应用 zoom）
   */
  documentToScreen(rect: DocRect): DocRect {
    const zoom = this.ctx.zoom || 1;
    return {
      x: rect.x * zoom,
      y: rect.y * zoom,
      width: rect.width * zoom,
      height: rect.height * zoom,
    };
  }

  /**
   * Screen px → Document px（反向 zoom）
   */
  screenToDocument(rect: DocRect): DocRect {
    const zoom = this.ctx.zoom || 1;
    return {
      x: rect.x / zoom,
      y: rect.y / zoom,
      width: rect.width / zoom,
      height: rect.height / zoom,
    };
  }

  // ── Canvas px ↔ Document px ──
  // OCR 返回的坐标是 canvas px（scale=1.5），需转为 Document px

  /**
   * Canvas px (scale=1.5) → Document px（× cssScale）
   *
   * OCR OcrTextBlock 的坐标是 canvas px at scale=1.5，
   * 转换到 Document px 需乘 cssScale。
   */
  canvasToDocument(canvasRect: DocRect): DocRect {
    return {
      x: canvasRect.x * this.ctx.cssScale,
      y: canvasRect.y * this.ctx.cssScale,
      width: canvasRect.width * this.ctx.cssScale,
      height: canvasRect.height * this.ctx.cssScale,
    };
  }

  /**
   * Document px → Canvas px（÷ cssScale）
   */
  documentToCanvas(rect: DocRect): DocRect {
    return {
      x: rect.x / this.ctx.cssScale,
      y: rect.y / this.ctx.cssScale,
      width: rect.width / this.ctx.cssScale,
      height: rect.height / this.ctx.cssScale,
    };
  }

  // ── 字号转换 ──

  /**
   * PDF fontSize pt → Document fontSize px
   *
   * Document px = pt × renderScale × cssScale
   * （与 CoordinateMapper.scaleFontSize 一致）
   */
  fontSizePtToDocument(pt: number): number {
    return pt * this.ctx.renderScale * this.ctx.cssScale;
  }

  /**
   * Document fontSize px → PDF fontSize pt（导出用）
   */
  fontSizeDocumentToPt(px: number): number {
    return px / (this.ctx.renderScale * this.ctx.cssScale);
  }

  /** 获取当前上下文（只读） */
  getContext(): Readonly<CoordContext> {
    return { ...this.ctx };
  }
}
