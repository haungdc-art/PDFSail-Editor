/**
 * Render Source Detector — M7.7-009A-1 · Line/Glyph-level Source Detection
 *
 * 目标：在 EditableDocument 构建阶段，对每行文本判定其「渲染源类型」：
 *
 *   - "vector"     → PDF 原生矢量文字（有 text operator，无图片覆盖）
 *   - "image"      → 图片区域内文本，无对应文本算子（纯扫描图，无 OCR 层）
 *   - "image-ocr"  → 图片区域内文本，有对应文本算子（扫描图 + OCR 层）
 *
 * ---
 *
 * 检测模型（三路分类）：
 *
 *   Signal A（Image Region Overlap）：
 *     从 page.getOperatorList() 中追踪 CTM，提取图片绘制区域。
 *
 *   Signal B（Text Operator Coverage）：
 *     从 page.getTextContent().items 提取文本项 bbox。
 *
 *   三路判定（MVP）：
 *     !A                    → "vector"
 *     A && !B               → "image"
 *     A &&  B               → "image-ocr"
 *
 *   额外输出（Audit 模式）：
 *     - imageCoverage:       行 bbox 被图片区域覆盖的比例（0-1）
 *     - textOperatorCoverage:行 bbox 被文本算子覆盖的比例（0-1）
 *     - hasOCRLayer:         行所在区域是否有文本算子（布尔）
 *
 * ---
 *
 * 坐标系约定：
 *   所有 bbox 使用 CSS 显示坐标（与 EditableLine.bbox 一致）。
 *   PDF pt 坐标通过 CoordinateMapper 转换为 CSS px。
 */

import type { BBox } from "./types";
import type { CoordinateMapper } from "../editor-engine/CoordinateMapper";
import type { OperatorListLike } from "./pdf-operator-binding";

// ────────────────────────────────────────────────────────────────
// RenderSource（与 types.ts 同步，避免循环依赖）
// ────────────────────────────────────────────────────────────────

export type RenderSource = "vector" | "image" | "image-ocr";

// ────────────────────────────────────────────────────────────────
// Image Region（PDF 图片绘制区域，CSS 坐标）
// ────────────────────────────────────────────────────────────────

export interface ImageRegion {
  /** 图片绘制区域 bbox（CSS 显示坐标，与 EditableLine.bbox 一致） */
  bbox: BBox;
}

// ────────────────────────────────────────────────────────────────
// Audit 输出（每行详细指标）
// ────────────────────────────────────────────────────────────────

export interface LineSourceAudit {
  /** 行文字预览（前 60 字符） */
  textPreview: string;
  /** 行 bbox（CSS 坐标） */
  bbox: BBox;
  /** Signal A: 行 bbox 被图片覆盖的面积比例（0-1） */
  imageCoverage: number;
  /** Signal B: 行 bbox 被文本算子覆盖的面积比例（0-1） */
  textOperatorCoverage: number;
  /** 是否有文本算子覆盖该行（textOperatorCoverage >= 0.3） */
  hasOCRLayer: boolean;
  /** 最终分类 */
  source: RenderSource;
}

// ────────────────────────────────────────────────────────────────
// CTM 追踪（PDF 坐标空间，bottom-left origin）
// ────────────────────────────────────────────────────────────────

/**
 * 3×3 仿射变换矩阵 [a, b, c, d, e, f]。
 * 对应 PDF 的 CTM（Current Transformation Matrix）。
 */
interface Ctm {
  a: number; b: number;
  c: number; d: number;
  e: number; f: number;
}

const IDENTITY_CTM: Ctm = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * 矩阵乘法：CTM × M
 * PDF 中 cm 算子右乘当前 CTM。
 */
function ctmMultiply(ctm: Ctm, m: Ctm): Ctm {
  return {
    a: ctm.a * m.a + ctm.b * m.c,
    b: ctm.a * m.b + ctm.b * m.d,
    c: ctm.c * m.a + ctm.d * m.c,
    d: ctm.c * m.b + ctm.d * m.d,
    e: ctm.e * m.a + ctm.f * m.c + m.e,
    f: ctm.e * m.b + ctm.f * m.d + m.f,
  };
}

// ────────────────────────────────────────────────────────────────
// Image Region Extraction
// ────────────────────────────────────────────────────────────────

/**
 * PDF.js OPS 枚举中与图片相关的算子 id。
 * 由调用方从 pdf.js 的 OPS 对象传入（如 (pdfjsLib as any).OPS）。
 */
export interface ImageOpCodes {
  q: number;
  Q: number;
  cm: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
}

/**
 * 从 operator list 中提取图片绘制区域（CSS 坐标）。
 *
 * 通过追踪 CTM，在 paintImageXObject / paintInlineImageXObject / paintImageMaskXObject
 * 算子处记录当前 CTM 变换后的图片区域。
 */
export function extractImageRegions(
  operatorList: OperatorListLike,
  ops: ImageOpCodes,
  mapper: CoordinateMapper,
): ImageRegion[] {
  const { fnArray, argsArray } = operatorList;
  const regions: ImageRegion[] = [];

  let ctm: Ctm = { ...IDENTITY_CTM };
  const ctmStack: Ctm[] = [];

  for (let i = 0; i < fnArray.length; i++) {
    const id = fnArray[i];
    const args = (argsArray[i] ?? []) as unknown[];

    if (isSaveState(id, ops)) {
      ctmStack.push({ ...ctm });
      continue;
    }

    if (isRestoreState(id, ops)) {
      if (ctmStack.length > 0) {
        ctm = ctmStack.pop()!;
      }
      continue;
    }

    if (isConcatMatrix(id, ops)) {
      const [a, b, c, d, e, f] = args as number[];
      if (args.length >= 6 && isFiniteNums(a, b, c, d, e, f)) {
        ctm = ctmMultiply(ctm, { a, b, c, d, e, f });
      }
      continue;
    }

    if (isPaintImage(id, ops)) {
      const region = extractImageBbox(ctm, args, mapper);
      if (region) {
        regions.push(region);
      }
      continue;
    }
  }

  return regions;
}

// ────────────────────────────────────────────────────────────────
// Operator ID 判定
// ────────────────────────────────────────────────────────────────

function isSaveState(id: number, ops: ImageOpCodes): boolean { return id === ops.q; }
function isRestoreState(id: number, ops: ImageOpCodes): boolean { return id === ops.Q; }
function isConcatMatrix(id: number, ops: ImageOpCodes): boolean { return id === ops.cm; }
function isPaintImage(id: number, ops: ImageOpCodes): boolean {
  return [ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject].includes(id);
}

// ────────────────────────────────────────────────────────────────
// 图片 bbox 提取（从 CTM + args）
// ────────────────────────────────────────────────────────────────

function extractImageBbox(ctm: Ctm, args: unknown[], mapper: CoordinateMapper): ImageRegion | null {
  const imgW = typeof args[1] === "number" ? args[1] : undefined;
  const imgH = typeof args[2] === "number" ? args[2] : undefined;

  const bottomLeftX = ctm.e;
  const bottomLeftY = ctm.f;

  let pdfW: number;
  let pdfH: number;

  if (imgW !== undefined && imgH !== undefined) {
    if (ctm.b === 0 && ctm.c === 0) {
      pdfW = Math.abs(ctm.a) * imgW;
      pdfH = Math.abs(ctm.d) * imgH;
    } else {
      const scaleX = Math.sqrt(ctm.a * ctm.a + ctm.b * ctm.b);
      const scaleY = Math.sqrt(ctm.c * ctm.c + ctm.d * ctm.d);
      pdfW = scaleX * imgW;
      pdfH = scaleY * imgH;
    }
  } else {
    pdfW = Math.abs(ctm.a);
    pdfH = Math.abs(ctm.d);
  }

  if (pdfW <= 0 || pdfH <= 0) return null;

  const css = mapper.pdfToCss(bottomLeftX, bottomLeftY, pdfW, pdfH);
  return { bbox: { x: css.x, y: css.y, width: css.w, height: css.h } };
}

// ────────────────────────────────────────────────────────────────
// Text Operator Rect 提取
// ────────────────────────────────────────────────────────────────

/**
 * 从 textContent items 提取文本项 bbox（CSS 坐标）。
 *
 * 用于判定「该行是否被文本算子覆盖」。
 */
export function extractTextItemRects(
  textItems: Array<{ transform: number[]; width: number; height: number; str: string }>,
  mapper: CoordinateMapper,
): BBox[] {
  return textItems.map((item) => {
    const tm = item.transform;
    const pdfX = tm[4] ?? 0;
    const pdfY = tm[5] ?? 0;
    const pdfW = item.width ?? item.str.length * 10;
    const pdfH = item.height ?? 12;
    const css = mapper.pdfToCss(pdfX, pdfY, pdfW, pdfH);
    return { x: css.x, y: css.y, width: css.w, height: css.h };
  });
}

// ────────────────────────────────────────────────────────────────
// BBox 覆盖比例计算
// ────────────────────────────────────────────────────────────────

/**
 * 计算 `inner` 被 `outer` 覆盖的面积比例。
 * 返回 0-1 的值，1 = inner 完全在 outer 内。
 */
function calcOverlapRatio(inner: BBox, outer: BBox): number {
  const ix = Math.min(inner.x + inner.width, outer.x + outer.width) - Math.max(inner.x, outer.x);
  const iy = Math.min(inner.y + inner.height, outer.y + outer.height) - Math.max(inner.y, outer.y);
  if (ix <= 0 || iy <= 0) return 0;
  const interArea = ix * iy;
  const innerArea = inner.width * inner.height;
  if (innerArea <= 0) return 0;
  return interArea / innerArea;
}

/**
 * 计算 lineBBox 被任意 imageRegion 覆盖的最大比例。
 */
export function calcMaxImageCoverage(lineBBox: BBox, imageRegions: ImageRegion[]): number {
  if (imageRegions.length === 0) return 0;
  let maxRatio = 0;
  for (const r of imageRegions) {
    const ratio = calcOverlapRatio(lineBBox, r.bbox);
    if (ratio > maxRatio) maxRatio = ratio;
  }
  return maxRatio;
}

/**
 * 计算 lineBBox 被任意 textItemRect 覆盖的最大比例。
 */
export function calcMaxTextOperatorCoverage(lineBBox: BBox, textItemRects: BBox[]): number {
  if (textItemRects.length === 0) return 0;
  let maxRatio = 0;
  for (const r of textItemRects) {
    const ratio = calcOverlapRatio(lineBBox, r);
    if (ratio > maxRatio) maxRatio = ratio;
  }
  return maxRatio;
}

// ────────────────────────────────────────────────────────────────
// 阈值常量
// ────────────────────────────────────────────────────────────────

/** 行 bbox 被图片覆盖的面积比例阈值（≥ 此值 → Signal A=true） */
const IMAGE_COVERAGE_THRESHOLD = 0.7;

/** 行 bbox 被文本算子覆盖的面积比例阈值（≥ 此值 → Signal B=true） */
const TEXT_OP_COVERAGE_THRESHOLD = 0.3;

// ────────────────────────────────────────────────────────────────
// 数值辅助
// ────────────────────────────────────────────────────────────────

function isFiniteNums(...args: number[]): boolean {
  return args.every((n) => Number.isFinite(n));
}

// ────────────────────────────────────────────────────────────────
// 主入口：行级 Render Source 分类 & Audit
// ────────────────────────────────────────────────────────────────

/**
 * 对页面内的所有行进行 Render Source 三路分类。
 *
 * 直接修改 line.source 字段。
 */
export function classifyLineRenderSources(
  lines: Array<{ bbox: BBox; source: string }>,
  imageRegions: ImageRegion[],
  textItemRects: BBox[],
): void {
  for (const line of lines) {
    const imageCoverage = calcMaxImageCoverage(line.bbox, imageRegions);
    const textOpCoverage = calcMaxTextOperatorCoverage(line.bbox, textItemRects);

    const signalA = imageCoverage >= IMAGE_COVERAGE_THRESHOLD;
    const signalB = textOpCoverage >= TEXT_OP_COVERAGE_THRESHOLD;

    if (!signalA) {
      (line as any).source = "vector";
    } else if (!signalB) {
      (line as any).source = "image";
    } else {
      (line as any).source = "image-ocr";
    }
  }
}

/**
 * 单行检测（便捷函数，返回三路分类字符串）。
 */
export function detectLineRenderSource(
  lineBBox: BBox,
  imageRegions: ImageRegion[],
  textItemRects: BBox[],
): RenderSource {
  const imageCoverage = calcMaxImageCoverage(lineBBox, imageRegions);
  const textOpCoverage = calcMaxTextOperatorCoverage(lineBBox, textItemRects);

  const signalA = imageCoverage >= IMAGE_COVERAGE_THRESHOLD;
  const signalB = textOpCoverage >= TEXT_OP_COVERAGE_THRESHOLD;

  if (!signalA) return "vector";
  if (!signalB) return "image";
  return "image-ocr";
}

/**
 * 单行 Audit（详细指标输出）。
 *
 * 返回 LineSourceAudit，包含 imageCoverage、textOperatorCoverage、
 * hasOCRLayer、source 等字段，用于真实 PDF 样本验证。
 */
export function auditLineRenderSource(
  lineBBox: BBox,
  textPreview: string,
  imageRegions: ImageRegion[],
  textItemRects: BBox[],
): LineSourceAudit {
  const imageCoverage = calcMaxImageCoverage(lineBBox, imageRegions);
  const textOpCoverage = calcMaxTextOperatorCoverage(lineBBox, textItemRects);

  const signalA = imageCoverage >= IMAGE_COVERAGE_THRESHOLD;
  const signalB = textOpCoverage >= TEXT_OP_COVERAGE_THRESHOLD;

  let source: RenderSource;
  if (!signalA) source = "vector";
  else if (!signalB) source = "image";
  else source = "image-ocr";

  return {
    textPreview: textPreview.length > 60 ? textPreview.slice(0, 57) + "..." : textPreview,
    bbox: { ...lineBBox },
    imageCoverage: Math.round(imageCoverage * 100) / 100,
    textOperatorCoverage: Math.round(textOpCoverage * 100) / 100,
    hasOCRLayer: signalB,
    source,
  };
}

/**
 * 全页 Audit：对页面内所有行执行 audit，返回审计报告数组。
 */
export function auditPageRenderSources(
  lines: Array<{ bbox: BBox; glyphs: Array<{ char: string }> }>,
  imageRegions: ImageRegion[],
  textItemRects: BBox[],
): LineSourceAudit[] {
  return lines.map((line) => {
    const textPreview = line.glyphs.map((g) => g.char).join("");
    return auditLineRenderSource(line.bbox, textPreview, imageRegions, textItemRects);
  });
}