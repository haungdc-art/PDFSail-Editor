/**
 * SignaturePixelMaskGenerator — Sprint 18 (DEPRECATED by Sprint 19)
 *
 * @deprecated 已被 signature-background-reconstructor.ts 替代。
 *   旧方案生成数千个 DrawRectCommand（3685+），导致性能问题和视觉伪影。
 *   新方案使用 inpainting 技术生成单张背景补丁图像（每区域 1 个 DrawImageCommand）。
 *
 * 像素级签名文字擦除。
 *
 * 目标：
 *   - 用灰度 + 阈值检测 suppressed handwritten block 区域内的文字像素。
 *   - 通过水平游程分析区分"文字"（短暗像素游程）和"签名横线"（长暗像素游程）。
 *   - 只为文字像素生成白色遮罩矩形，保留横线和文档图形。
 *   - 输出 DrawRectCommand[] 供 GlyphRenderer 渲染（zIndex=1, mask layer）。
 *
 * 输入：SignatureRegion[] + page canvas + cssScale
 * 输出：DrawRectCommand[] + SignaturePixelMaskDebugInfo
 */

import type { BBox } from "./types";
import type { DrawRectCommand } from "./render-command";
import type { SignatureRegion } from "./signature-region-merger";

// ── 可调参数 ──

/** 灰度阈值：像素亮度低于此值视为"暗像素" */
const GRAY_THRESHOLD = 128;

/** 暗像素水平游程的最小宽度（canvas px），超过此值视为"横线"并保护 */
const LINE_MIN_RUN_CANVAS = 50;

/** 区间合并允许的最大间距（行数），用于压缩 mask 矩形数量 */
const ROW_MERGE_GAP = 2;

/** 单行 mask 的最小 CSS 高度（避免 0px 高 div） */
const MIN_MASK_HEIGHT = 1;

// ── 类型 ──

export interface SignaturePixelMaskDebugInfo {
  /** 签名替换区域 CSS 坐标 */
  signatureZone: { x: number; y: number; w: number; h: number };
  /** 区域内总暗像素数 */
  totalDarkPixels: number;
  /** 分类为"文字"的像素数 */
  textPixels: number;
  /** 分类为"横线"的像素数（被保护） */
  linePixels: number;
  /** 被保护像素数（= linePixels + 亮像素） */
  protectedPixels: number;
  /** 生成的 mask 矩形列表 */
  maskRects: { x: number; y: number; w: number; h: number }[];
  /** 调试可视化图片（data URL） */
  debugImageDataURL?: string;
  /** 错误信息 */
  error?: string;
}

interface Padding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

// ── 工具函数 ──

function expandBBox(bbox: BBox, padding: Padding): BBox {
  return {
    x: Math.round((bbox.x - padding.left) * 10) / 10,
    y: Math.round((bbox.y - padding.top) * 10) / 10,
    width: Math.round((bbox.width + padding.left + padding.right) * 10) / 10,
    height: Math.round((bbox.height + padding.top + padding.bottom) * 10) / 10,
  };
}

function unionBBox(bboxes: BBox[]): BBox {
  if (bboxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bboxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return {
    x: Math.round(minX * 10) / 10,
    y: Math.round(minY * 10) / 10,
    width: Math.round((maxX - minX) * 10) / 10,
    height: Math.round((maxY - minY) * 10) / 10,
  };
}

function estimateBlockFontSize(block: SignatureRegion["blocks"][number]): number {
  if (block.type !== "text") return 12;
  let maxHeight = 0;
  for (const line of block.lines) {
    for (const glyph of line.glyphs) {
      maxHeight = Math.max(maxHeight, glyph.bbox.height);
    }
  }
  return maxHeight > 0 ? maxHeight : (block.bbox.height > 0 ? block.bbox.height : 12);
}

// ── 核心：像素检测 ──

interface RowClassResult {
  /** 哪些行包含文字像素 */
  textRows: Set<number>;
  /** 哪些行包含横线像素（被保护） */
  lineRows: Set<number>;
  /** 每行的文字列区间 [colStart, colEnd] */
  textColRuns: Map<number, Array<[number, number]>>;
  /** 统计 */
  totalDark: number;
  textPixelCount: number;
  linePixelCount: number;
}

/**
 * 对 canvas ImageData 做灰度阈值 + 水平游程长度分析，
 * 将暗像素分类为"文字"或"横线"。
 */
function classifyPixels(
  imageData: ImageData,
  zoneCanvasWidth: number,
  zoneCanvasHeight: number,
): RowClassResult {
  const { data, width } = imageData;
  const textRows = new Set<number>();
  const lineRows = new Set<number>();
  const textColRuns = new Map<number, Array<[number, number]>>();
  let totalDark = 0;
  let textPixelCount = 0;
  let linePixelCount = 0;

  // 按行扫描
  for (let row = 0; row < zoneCanvasHeight; row++) {
    const rowColRuns: Array<[number, number]> = [];
    let col = 0;

    while (col < zoneCanvasWidth) {
      // 跳过亮像素
      while (col < zoneCanvasWidth && !isDarkPixel(data, width, row, col)) {
        col++;
      }
      if (col >= zoneCanvasWidth) break;

      const runStart = col;
      // 扫描暗像素游程
      while (col < zoneCanvasWidth && isDarkPixel(data, width, row, col)) {
        col++;
      }
      const runEnd = col - 1;
      const runLength = runEnd - runStart + 1;

      totalDark += runLength;

      if (runLength >= LINE_MIN_RUN_CANVAS) {
        // 长游程 → 横线（保护）
        lineRows.add(row);
        linePixelCount += runLength;
      } else {
        // 短游程 → 文字（擦除）
        textRows.add(row);
        textPixelCount += runLength;
        rowColRuns.push([runStart, runEnd]);
      }
    }

    if (rowColRuns.length > 0) {
      textColRuns.set(row, rowColRuns);
    }
  }

  return { textRows, lineRows, textColRuns, totalDark, textPixelCount, linePixelCount };
}

/**
 * 判断 (row, col) 处像素是否暗（亮度 < GRAY_THRESHOLD）。
 */
function isDarkPixel(
  data: Uint8ClampedArray,
  width: number,
  row: number,
  col: number,
): boolean {
  const idx = (row * width + col) * 4;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  // 灰度公式（感知亮度，避免 α 为 0 的误报）
  const a = data[idx + 3];
  if (a === 0) return false;
  const gray = 0.299 * r + 0.587 * g + 0.114 * b;
  return gray < GRAY_THRESHOLD;
}

// ── mask 矩形生成 ──

interface RawMaskRect {
  colStart: number; // canvas col
  colEnd: number;   // canvas col
  rowStart: number; // canvas row
  rowEnd: number;   // canvas row
}

/**
 * 将行级文字列区间合并为连续矩形块。
 */
function mergeColRuns(rawRects: RawMaskRect[]): RawMaskRect[] {
  if (rawRects.length <= 1) return rawRects;

  // 按 (rowStart, colStart) 排序
  rawRects.sort((a, b) => a.rowStart - b.rowStart || a.colStart - b.colStart);

  const merged: RawMaskRect[] = [];
  let current: RawMaskRect | null = null;

  for (const rect of rawRects) {
    if (!current) {
      current = { ...rect };
      continue;
    }

    // 同一行或相邻行（gap ≤ ROW_MERGE_GAP），且列区间重叠或相邻
    const rowGap = rect.rowStart - current.rowEnd;
    const colOverlap =
      rect.colStart <= current.colEnd + 1 &&
      rect.colEnd >= current.colStart - 1;

    if (rowGap <= ROW_MERGE_GAP && colOverlap) {
      // 合并
      current.colStart = Math.min(current.colStart, rect.colStart);
      current.colEnd = Math.max(current.colEnd, rect.colEnd);
      current.rowEnd = Math.max(current.rowEnd, rect.rowEnd);
    } else {
      merged.push(current);
      current = { ...rect };
    }
  }

  if (current) merged.push(current);

  return merged;
}

// ── debug 可视化 ──

/**
 * 创建像素分类调试图片（data URL）。
 * 红色 = 文字像素（被擦除），绿色 = 横线像素（被保护），蓝色 = 背景。
 */
function createDebugImage(
  imageData: ImageData,
  result: RowClassResult,
  zoneCanvasWidth: number,
  zoneCanvasHeight: number,
): string {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = zoneCanvasWidth;
    canvas.height = zoneCanvasHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";

    // 绘制原始图（半透明基底）
    ctx.putImageData(imageData, 0, 0);

    // 半透明叠加分类颜色
    const overlayData = ctx.createImageData(zoneCanvasWidth, zoneCanvasHeight);
    const { data, width } = imageData;

    for (let row = 0; row < zoneCanvasHeight; row++) {
      for (let col = 0; col < zoneCanvasWidth; col++) {
        const idx = (row * width + col) * 4;
        const isDark = isDarkPixel(data, width, row, col);
        if (!isDark) {
          // 背景 → 半透明蓝
          overlayData.data[idx] = 100;     // R
          overlayData.data[idx + 1] = 149; // G
          overlayData.data[idx + 2] = 237; // B
          overlayData.data[idx + 3] = 80;  // A
        } else if (result.lineRows.has(row)) {
          // 横线 → 半透明绿
          overlayData.data[idx] = 34;      // R
          overlayData.data[idx + 1] = 197; // G
          overlayData.data[idx + 2] = 94;  // B
          overlayData.data[idx + 3] = 140; // A
        } else if (result.textRows.has(row)) {
          // 文字 → 半透明红
          overlayData.data[idx] = 239;     // R
          overlayData.data[idx + 1] = 68;  // G
          overlayData.data[idx + 2] = 68;  // B
          overlayData.data[idx + 3] = 160; // A
        }
      }
    }

    ctx.putImageData(overlayData, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return "";
  }
}

// ── 公共 API ──

/**
 * 为签名区域生成像素级文字擦除 mask。
 *
 * 流程：
 *   1. 取 suppressed handwritten block 的 bbox 并集 → signature replacement zone
 *   2. 动态扩展 padding
 *   3. 从 page canvas 裁剪该区域的像素数据
 *   4. 灰度阈值 + 游程分析，分类文字 / 横线
 *   5. 为文字像素生成 DrawRectCommand[]
 *   6. 构建调试信息
 */
export function generateSignaturePixelMasks(
  region: SignatureRegion,
  pageCanvas: HTMLCanvasElement,
  cssScale: number,
): { masks: DrawRectCommand[]; debug: SignaturePixelMaskDebugInfo } {
  const emptyDebug: SignaturePixelMaskDebugInfo = {
    signatureZone: { x: 0, y: 0, w: 0, h: 0 },
    totalDarkPixels: 0,
    textPixels: 0,
    linePixels: 0,
    protectedPixels: 0,
    maskRects: [],
    error: "",
  };

  if (!region.maskRequired || region.replacementMode !== "text-replacement") {
    return { masks: [], debug: { ...emptyDebug, error: "region not maskRequired" } };
  }

  const suppressedBlocks = region.blocks.filter(b =>
    region.suppressedGlyphBlockIds.includes(b.id),
  );
  if (suppressedBlocks.length === 0) {
    return { masks: [], debug: { ...emptyDebug, error: "no suppressed blocks" } };
  }

  // 1. 签名替换区域及其扩展
  const union = unionBBox(suppressedBlocks.map(b => b.bbox));
  const maxFontSize = Math.max(...suppressedBlocks.map(estimateBlockFontSize));
  const padding = Math.max(maxFontSize * 0.4, 5);
  const zone = expandBBox(union, {
    left: padding,
    right: padding,
    top: padding,
    bottom: padding,
  });

  // 2. 从 canvas 裁剪像素
  const canvasX = zone.x / cssScale;
  const canvasY = zone.y / cssScale;
  const canvasW = zone.width / cssScale;
  const canvasH = zone.height / cssScale;

  const ctx = pageCanvas.getContext("2d");
  if (!ctx) {
    return { masks: [], debug: { ...emptyDebug, signatureZone: toDebugRect(zone), error: "no 2d context" } };
  }

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(
      Math.max(0, Math.round(canvasX)),
      Math.max(0, Math.round(canvasY)),
      Math.min(pageCanvas.width - Math.round(canvasX), Math.round(canvasW)),
      Math.min(pageCanvas.height - Math.round(canvasY), Math.round(canvasH)),
    );
  } catch {
    return { masks: [], debug: { ...emptyDebug, signatureZone: toDebugRect(zone), error: "getImageData failed (tainted canvas?)" } };
  }

  const zoneCanvasWidth = imageData.width;
  const zoneCanvasHeight = imageData.height;

  // 3. 像素分类
  const result = classifyPixels(imageData, zoneCanvasWidth, zoneCanvasHeight);

  // 4. 生成行级 mask 矩形
  const rawRects: RawMaskRect[] = [];
  for (const [row, colRuns] of result.textColRuns) {
    for (const [colStart, colEnd] of colRuns) {
      rawRects.push({ colStart, colEnd, rowStart: row, rowEnd: row });
    }
  }

  // 5. 合并相邻区间
  const mergedRects = mergeColRuns(rawRects);

  // 6. 转换为 CSS 坐标的 DrawRectCommand
  const masks: DrawRectCommand[] = mergedRects.map(r => ({
    type: "drawRect",
    x: Math.round((zone.x + r.colStart * cssScale) * 10) / 10,
    y: Math.round((zone.y + r.rowStart * cssScale) * 10) / 10,
    width: Math.round(((r.colEnd - r.colStart + 1) * cssScale) * 10) / 10,
    height: Math.max(
      MIN_MASK_HEIGHT,
      Math.round(((r.rowEnd - r.rowStart + 1) * cssScale) * 10) / 10,
    ),
    fill: "#ffffff",
    opacity: 1,
    blockId: region.id,
    purpose: "mask",
  }));

  // 7. 构建调试信息
  const debugImageDataURL = createDebugImage(
    imageData, result, zoneCanvasWidth, zoneCanvasHeight,
  );

  const debug: SignaturePixelMaskDebugInfo = {
    signatureZone: toDebugRect(zone),
    totalDarkPixels: result.totalDark,
    textPixels: result.textPixelCount,
    linePixels: result.linePixelCount,
    protectedPixels: result.linePixelCount + (zoneCanvasWidth * zoneCanvasHeight - result.totalDark),
    maskRects: masks.map(toDebugRect),
    debugImageDataURL: debugImageDataURL || undefined,
  };

  return { masks, debug };
}

/**
 * 批量生成像素级签名文字擦除 mask。
 * 每个签名区域分别从 canvas 裁剪分析。
 */
export function generateSignaturePixelMasksForRegions(
  regions: SignatureRegion[],
  pageCanvas: HTMLCanvasElement,
  cssScale: number,
): { masks: DrawRectCommand[]; debug: SignaturePixelMaskDebugInfo[] } {
  const allMasks: DrawRectCommand[] = [];
  const allDebug: SignaturePixelMaskDebugInfo[] = [];

  for (const region of regions) {
    const { masks, debug } = generateSignaturePixelMasks(region, pageCanvas, cssScale);
    allMasks.push(...masks);
    allDebug.push(debug);
  }

  return { masks: allMasks, debug: allDebug };
}

function toDebugRect(
  bbox: { x: number; y: number; width?: number; w?: number; height?: number; h?: number },
): { x: number; y: number; w: number; h: number } {
  return {
    x: bbox.x,
    y: bbox.y,
    w: (bbox as any).w ?? (bbox as any).width ?? 0,
    h: (bbox as any).h ?? (bbox as any).height ?? 0,
  };
}
