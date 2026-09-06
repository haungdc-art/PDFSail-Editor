/**
 * OCR Style Resolver — Task 3
 *
 * 针对扫描 PDF，从 OCR bbox + page image 推断样式。
 *
 * 输入：
 *   - OCR bbox（block 的 x/y/w/h）
 *   - page image（可选，用于颜色采样）
 *   - 同页 PDF 原生样式（可选，混合 PDF 时）
 *   - 邻近 block 样式（可选）
 *   - 页面统计样式（可选）
 *
 * 输出：estimated EditableStyle
 *
 * 4 级 fallback 规则（优先级从高到低）：
 *   1. 同区域 PDF style：OCR block bbox 与 PDF 原生文本 bbox 重叠时，借用 PDF 样式
 *   2. 邻近文字 style：取空间上最近的 block 的样式
 *   3. 页面统计 style：整页 fontSize 中位数 + 默认字体
 *   4. fallback：硬编码默认值
 *
 * 字号推断：
 *   OCR block 的 bbox.height 可能是多行总高度。
 *   singleLineHeight = bbox.height / estimatedLineCount
 *   fontSize ≈ singleLineHeight × 0.85（与 ocr-utils.ts 一致）
 *
 * 颜色推断（可选，需 page image）：
 *   从 block bbox 中心区域采样像素，取主色。
 *   Sprint 2 简化：默认黑色，page image 采样留作 Sprint 3。
 */

import type { EditableStyle, BBox } from "./types";
import type { FontDetectionResult } from "./font-detector";
// M7.7-003B: 字体决策层（只做编辑态 CSS 字体选择；不改 font-detector 核心）
import { resolveEditFont } from "./font-style-confidence-resolver";

/**
 * Consumer Contract（Interface Segregation，Story-9）。
 *
 * ocr-style-resolver 只消费 OCR 文本块的这些字段（text/x/y/w/h/fontSize），
 * 因此定义自己的最小契约。Producer（OCR 文本块）结构兼容即可，
 * Consumer 不依赖具体 OCR 类型。
 */
export interface OCRStyleSource {
  /** M7.7-004U-EditStyle: block ID（用于命中 fontDetection 的 per-block 字体） */
  id?: string;
  /** 文本内容 */
  text: string;
  /** 块左 X（canvas px at scale=1.5） */
  x: number;
  /** 块顶部 Y（canvas px at scale=1.5） */
  y: number;
  /** 块宽度（canvas px at scale=1.5） */
  w: number;
  /** 块高度（canvas px at scale=1.5） */
  h: number;
  /** 估算字号（canvas px at scale=1.5） */
  fontSize: number;
}

/** OCR 样式解析的输入上下文 */
export interface OcrStyleContext {
  /** 同页 PDF 原生样式列表（含 bbox，用于空间匹配） */
  pdfNativeStyles?: Array<{
    bbox: BBox;
    style: EditableStyle;
  }>;
  /** 同页已解析的 OCR block 样式（用于邻近匹配，按解析顺序填充） */
  resolvedOcrBlocks?: Array<{
    bbox: BBox;
    style: EditableStyle;
  }>;
  /** 页面统计样式（fontSize 中位数等） */
  pageStats?: PageStyleStats;
  /** M7.7-004U-EditStyle: 页面字体检测结果（per-block + dominant）。
   *  扫描件（无文本层）的 OCR 样式来自硬编码 fallback，与原扫描字体（如 Arial Bold）不一致，
   *  编辑后文字样式与原文完全不同。检测命中时用它覆盖 fontFamily/fontWeight。 */
  fontDetection?: FontDetectionResult | null;
}

/** 页面级样式统计 */
export interface PageStyleStats {
  /** 所有 block 的单行高度中位数（CSS px） */
  medianLineHeight: number;
  /** 所有 block 的 fontSize 中位数（CSS px） */
  medianFontSize: number;
  /** 页面主字体（从 PDF 原生或默认） */
  dominantFontFamily: string;
}

/** 默认 fallback 样式 */
const FALLBACK_STYLE: EditableStyle = {
  // M7.7-004U-EditStyle: 扫描件 fallback 改为「拉丁优先」。
  // 此前是 CJK 优先（Noto Sans SC），拉丁扫描件（多数商务/法律文档）编辑后文字用 Noto Sans SC
  // 渲染，与原扫描字体（多为 Arial/Helvetica）差异巨大。拉丁族名在前，CJK 字符仍回退中文族。
  fontFamily: "'Arial', 'Helvetica', 'Noto Sans SC', 'Microsoft YaHei', 'PingFang SC', sans-serif",
  fontSize: 14,
  fontWeight: 400,
  fontStyle: "normal",
  color: "#000000",
  lineHeight: 14 * 1.3,
  letterSpacing: 0,
};

/**
 * M7.7-004U-EditStyle + M7.7-003B: 应用页面字体检测结果。
 *
 * 扫描件无文本层，OCR 样式（fallback）与原扫描字体不一致 → 编辑后文字样式与原文完全不同。
 * 检测命中的 block 用 per-block 字体，未命中的用 dominant 兜底。
 * M7.7-003B: 检测结果先经 resolveEditFont 决策层（置信度门 + 字重权重 + 字体语法）——低置信
 * 的 regular 衬线误判（Times/Georgia/Courier）回退到安全无衬线+中文栈，避免污染编辑框。
 * 只覆盖 fontFamily/fontWeight，保留 resolver 推断的 fontSize/lineHeight/color。
 */
function applyFontDetection(
  style: EditableStyle,
  ocrBlock: OCRStyleSource,
  fontDetection?: FontDetectionResult | null
): EditableStyle {
  if (!fontDetection) return style;
  const detected = (ocrBlock.id ? fontDetection.byBlock.get(ocrBlock.id) : undefined) ?? fontDetection.dominant;
  if (!detected) return style;
  // M7.7-003B: 决策层用安全基底栈（拉丁优先 + 中文回退），不沿用可能已被污染的 style.fontFamily。
  const resolved = resolveEditFont(detected);
  return { ...style, fontFamily: resolved.familyStack, fontWeight: resolved.weight };
}

/** 计算 bbox 的中心点 */
function bboxCenter(b: BBox): { x: number; y: number } {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** 计算两个 bbox 的重叠面积 */
function bboxOverlap(a: BBox, b: BBox): number {
  const xOverlap = Math.max(
    0,
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  );
  const yOverlap = Math.max(
    0,
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  );
  return xOverlap * yOverlap;
}

/** 计算两个 bbox 中心的距离 */
function bboxDistance(a: BBox, b: BBox): number {
  const ca = bboxCenter(a);
  const cb = bboxCenter(b);
  return Math.sqrt((ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2);
}

/**
 * 规则 1：同区域 PDF style 匹配。
 *
 * 在 pdfNativeStyles 中找与 ocrBBox 重叠面积最大的样式。
 * 重叠面积 > 0 即认为匹配。
 */
function matchPdfNativeStyle(
  ocrBBox: BBox,
  pdfNativeStyles?: OcrStyleContext["pdfNativeStyles"]
): EditableStyle | null {
  if (!pdfNativeStyles || pdfNativeStyles.length === 0) {
    // [TRACE-DECISION] Rule1 miss reason
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-DECISION]   Rule1(PDF) MISS reason=pdfNativeStyles ${pdfNativeStyles ? "empty(0)" : "undefined"}`);
    }
    return null;
  }

  let bestStyle: EditableStyle | null = null;
  let bestOverlap = 0;

  for (const { bbox, style } of pdfNativeStyles) {
    const overlap = bboxOverlap(ocrBBox, bbox);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestStyle = style;
    }
  }

  return bestOverlap > 0 ? bestStyle : null;
}

/**
 * 规则 2：邻近文字 style。
 *
 * 在 resolvedOcrBlocks 中找空间距离最近的 block，借用其样式。
 */
function matchNearestStyle(
  ocrBBox: BBox,
  resolvedOcrBlocks?: OcrStyleContext["resolvedOcrBlocks"]
): EditableStyle | null {
  if (!resolvedOcrBlocks || resolvedOcrBlocks.length === 0) {
    // [TRACE-DECISION] Rule2 miss reason
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-DECISION]   Rule2(Neighbor) MISS reason=resolvedOcrBlocks ${resolvedOcrBlocks ? "empty(0)" : "undefined"} (无已解析邻居)`);
    }
    return null;
  }

  if (typeof process !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(`[TRACE-DECISION]   Rule2(Neighbor) candidates=${resolvedOcrBlocks.length} 最近距离=${bboxDistance(ocrBBox, resolvedOcrBlocks[0].bbox).toFixed(1)}px`);
  }

  let bestStyle: EditableStyle | null = null;
  let bestDist = Infinity;

  for (const { bbox, style } of resolvedOcrBlocks) {
    const dist = bboxDistance(ocrBBox, bbox);
    if (dist < bestDist) {
      bestDist = dist;
      bestStyle = style;
    }
  }

  return bestStyle;
}

/**
 * 规则 3：页面统计 style。
 *
 * 用 pageStats 的中位数 fontSize + 主字体。
 */
function buildPageStatsStyle(
  ocrBBox: BBox,
  estimatedLineCount: number,
  pageStats?: PageStyleStats
): EditableStyle {
  if (!pageStats) return { ...FALLBACK_STYLE };

  // 用页面统计的 fontSize，但根据当前 block 的 bbox 高度调整
  // 如果 block 高度显著大于 medianLineHeight，说明是多行 block
  const blockHeight = ocrBBox.height;
  const isMultiLine = blockHeight > pageStats.medianLineHeight * 1.8;

    // fontSize 取页面中位数（避免单个 block 的高度噪声）
  const fontSize = pageStats.medianFontSize;
  const lineHeight = fontSize * 1.3;

  // [DEBUG-FONT] Task-1: 打印 Rule3 输出（fontSize 将驱动 Layout）
  if (typeof process !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(`[FONT-RULE3] bboxH=${blockHeight.toFixed(1)} medianFontSize=${pageStats.medianFontSize.toFixed(2)} -> fontSize=${fontSize.toFixed(2)} isMultiLine=${isMultiLine}`);
  }

  return {
    fontFamily: pageStats.dominantFontFamily,
    fontSize,
    fontWeight: 400,
    fontStyle: "normal",
    color: "#000000",
    lineHeight,
    letterSpacing: 0,
    // 多行标记（不直接用于样式，但保留信息供 Layout Engine）
    ...(isMultiLine ? {} : {}),
  };
}

/**
 * 估算 OCR block 的行数。
 *
 * 与 ocr-utils.ts 的逻辑一致：
 *   1. 按换行符分割
 *   2. 无换行符时用 bbox 高度 / 单行高度估算
 */
function estimateLineCount(ocrBlock: OCRStyleSource, medianLineHeight: number): number {
  const textLines = ocrBlock.text.split("\n").filter((l) => l.trim().length > 0);
  if (textLines.length > 1) return textLines.length;

  if (medianLineHeight > 0) {
    return Math.max(1, Math.round(ocrBlock.h / medianLineHeight));
  }
  return 1;
}

/**
 * 解析单个 OCR block 的样式。
 *
 * @param ocrBlock OCR 文本块
 * @param cssScale canvas px → CSS px
 * @param context OCR 样式上下文（PDF 原生样式、邻近 block、页面统计）
 * @returns EditableStyle + estimatedLineCount
 */
export function resolveOcrBlockStyle(
  ocrBlock: OCRStyleSource,
  cssScale: number,
  context: OcrStyleContext
): { style: EditableStyle; estimatedLineCount: number } {
  const ocrBBox: BBox = {
    x: ocrBlock.x * cssScale,
    y: ocrBlock.y * cssScale,
    width: ocrBlock.w * cssScale,
    height: ocrBlock.h * cssScale,
  };

  const medianLineHeight = context.pageStats?.medianLineHeight ?? ocrBlock.fontSize * cssScale * 1.3;
  const lineCount = estimateLineCount(ocrBlock, medianLineHeight);

  // [TRACE] Task-2: Block Trace — 打印每个 block 进入 StyleResolver 的输入与命中规则
  if (typeof process !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(`[TRACE-RESOLVE] text=${(ocrBlock.text || "").substring(0, 25).padEnd(25)} ocr.fontSize=${(ocrBlock.fontSize * cssScale).toFixed(2)} ocr.bboxH=${(ocrBlock.h * cssScale).toFixed(1)} lineCount=${lineCount}`);
  }

  // 规则 1：同区域 PDF style
  const pdfStyle = matchPdfNativeStyle(ocrBBox, context.pdfNativeStyles);
  if (pdfStyle) {
    // [TRACE] rule1 命中
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-RESOLVE]   -> rule1(PDF) fontSize=${(ocrBlock.fontSize * cssScale).toFixed(2)}`);
    }
    // PDF 样式优先，但用 OCR 的 fontSize 覆盖（OCR bbox 更准确）
    return {
      style: applyFontDetection({
        ...pdfStyle,
        fontSize: ocrBlock.fontSize * cssScale,
        lineHeight: ocrBlock.fontSize * cssScale * 1.3,
      }, ocrBlock, context.fontDetection),
      estimatedLineCount: lineCount,
    };
  }

  // 规则 2：邻近文字 style
  const nearestStyle = matchNearestStyle(ocrBBox, context.resolvedOcrBlocks);
  if (nearestStyle) {
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-RESOLVE]   -> rule2(Neighbor) fontSize=${(ocrBlock.fontSize * cssScale).toFixed(2)}`);
    }
    return {
      style: applyFontDetection({
        ...nearestStyle,
        fontSize: ocrBlock.fontSize * cssScale,
        lineHeight: ocrBlock.fontSize * cssScale * 1.3,
      }, ocrBlock, context.fontDetection),
      estimatedLineCount: lineCount,
    };
  }

  // 规则 3：页面统计 style
  if (context.pageStats) {
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(`[TRACE-RESOLVE]   -> rule3(Page) fontSize=${context.pageStats.medianFontSize.toFixed(2)} (median)`);
    }
    return {
      style: applyFontDetection(
        buildPageStatsStyle(ocrBBox, lineCount, context.pageStats),
        ocrBlock,
        context.fontDetection
      ),
      estimatedLineCount: lineCount,
    };
  }

  // 规则 4：fallback
  if (typeof process !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(`[TRACE-RESOLVE]   -> rule4(Fallback) fontSize=${(ocrBlock.fontSize * cssScale).toFixed(2)}`);
  }
  return {
    style: applyFontDetection({
      ...FALLBACK_STYLE,
      fontSize: ocrBlock.fontSize * cssScale,
      lineHeight: ocrBlock.fontSize * cssScale * 1.3,
    }, ocrBlock, context.fontDetection),
    estimatedLineCount: lineCount,
  };
}

/**
 * 计算页面级样式统计。
 *
 * 从所有 OCR blocks 的 fontSize 计算中位数。
 * 用于规则 3 的 fallback。
 */
export function computePageStyleStats(
  ocrBlocks: OCRStyleSource[],
  cssScale: number,
  pdfNativeStyles?: Array<{ bbox: BBox; style: EditableStyle }>
): PageStyleStats {
  if (ocrBlocks.length === 0) {
    return {
      medianLineHeight: FALLBACK_STYLE.lineHeight!,
      medianFontSize: FALLBACK_STYLE.fontSize!,
      dominantFontFamily: FALLBACK_STYLE.fontFamily!,
    };
  }

  // 收集所有 block 的单行高度
  const lineHeights: number[] = [];
  const fontSizes: number[] = [];

  for (const b of ocrBlocks) {
    const fontSizePx = b.fontSize * cssScale;
    fontSizes.push(fontSizePx);
    lineHeights.push(fontSizePx * 1.3);
    // [DEBUG-FONT] Task-1: 打印 fontSize 计算链（产品代码内日志）
    if (typeof process !== "undefined") {
      // eslint-disable-next-line no-console
      console.log(`[FONT-INPUT] text=${(b.text || "").substring(0, 30).padEnd(30)} ocr.fontSize=${(b.fontSize || 0).toFixed(2)} cssScale=${cssScale} fontSizePx=${fontSizePx.toFixed(2)}`);
    }
  }

  // 中位数
  const median = (arr: number[]): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted[mid] || arr[0];
  };

  const medianFontSize = median(fontSizes);
  const medianLineHeight = median(lineHeights);
  // [DEBUG-FONT] Task-1: 打印 median 结果
  if (typeof process !== "undefined") {
    // eslint-disable-next-line no-console
    console.log(`[FONT-MEDIAN] allFontSizes=[${fontSizes.map((n) => n.toFixed(1)).join(",")}] medianFontSize=${medianFontSize.toFixed(2)} medianLineHeight=${medianLineHeight.toFixed(2)}`);
  }

  // 主字体：优先从 PDF 原生样式取出现最多的 fontFamily
  let dominantFontFamily = FALLBACK_STYLE.fontFamily!;
  if (pdfNativeStyles && pdfNativeStyles.length > 0) {
    const familyCounts = new Map<string, number>();
    for (const { style } of pdfNativeStyles) {
      if (style.fontFamily) {
        familyCounts.set(
          style.fontFamily,
          (familyCounts.get(style.fontFamily) || 0) + 1
        );
      }
    }
    let maxCount = 0;
    for (const [family, count] of familyCounts) {
      if (count > maxCount) {
        maxCount = count;
        dominantFontFamily = family;
      }
    }
  }

  return { medianLineHeight, medianFontSize, dominantFontFamily };
}
