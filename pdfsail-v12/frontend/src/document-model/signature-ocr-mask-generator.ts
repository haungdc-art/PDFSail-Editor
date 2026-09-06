/**
 * Sprint 30: Signature OCR Mask Generator
 *
 * 为签名区域背景重建生成精确的 OCR 像素 mask。
 *
 * 规则：
 *   duplicateBlockIds 中的 block 的整个 bbox 区域 = 100% mask（需擦除）
 *
 * 与 thresholdDarkPixels() 的区别：
 *   - 旧方法：像素级灰度阈值 → run-length 分类 text/line → 可能误判
 *   - 新方法：OCR block 位置 → 精确知道哪些像素是重复文字
 *
 * 输入: SignatureCompositeRegion + EditableDocument
 * 输出: ImageData mask（Uint8Array[]，1 = 需擦除）
 */

import type { SignatureCompositeRegion } from "./signature-composite-region";
import type { EditableDocument } from "./types";

// ── Sprint30.1: 增强 mask 参数 ──

/** OCR bbox 扩展（canvas 像素） */
const EXPAND_PADDING_X = 8;
const EXPAND_PADDING_Y = 6;

/** Mask dilation 半径（canvas 像素） */
const DILATION_RADIUS = 2;

// ── 接口 ──

export interface OCRMaskBlockDebug {
  /** 首行文本（用于识别） */
  text: string;
  /** 原始 CSS bbox */
  originalBBox: { x: number; y: number; width: number; height: number };
  /** 扩展后的 CSS bbox */
  expandedBBox: { x: number; y: number; width: number; height: number };
  /** 扩展前的 zone 内像素数 */
  pixelsBefore: number;
  /** dilation 后的像素数 */
  pixelsAfterDilation: number;
}

export interface OCRMaskResult {
  /** 每个被 mask 的 block 的 ID */
  maskedBlockIds: string[];
  /** 总共被 mask 的像素数（dilation 前） */
  maskPixelCount: number;
  /** dilation 后的总像素数 */
  dilatedPixelCount: number;
  /** 按行排列的像素 mask（1 = 需擦除，0 = 保留） */
  mask: Uint8Array[];
  /** Sprint30.1: 每个 block 的 debug 详情 */
  blocks?: OCRMaskBlockDebug[];
}

// ── 公共配置接口 ──

export interface OCRMaskOptions {
  /** 是否 expand OCR bbox */
  expand: boolean;
  /** 是否 dilate mask */
  dilate: boolean;
}

/**
 * 原始 OCR mask 生成（Sprint30）。
 * 不做 expand / dilate，精确用 OCR bbox。
 */
export function generateOCRMask(
  imageData: ImageData,
  zoneCx: number,
  zoneCy: number,
  cssScale: number,
  composite: SignatureCompositeRegion,
  _editableDocument: EditableDocument,
): OCRMaskResult {
  return generateMaskCore(imageData, zoneCx, zoneCy, cssScale, composite, { expand: false, dilate: false });
}

/**
 * Sprint30.1: 增强 OCR mask 生成。
 * 1. expand OCR bbox（paddingX=8, paddingY=6 canvas px）
 * 2. dilate mask（2px radius）
 */
export function generateEnhancedOCRMask(
  imageData: ImageData,
  zoneCx: number,
  zoneCy: number,
  cssScale: number,
  composite: SignatureCompositeRegion,
  _editableDocument: EditableDocument,
): OCRMaskResult {
  return generateMaskCore(imageData, zoneCx, zoneCy, cssScale, composite, { expand: true, dilate: true });
}

/**
 * Sprint 31: 从显式 CSS bbox 列表生成 OCR mask。
 *
 * 与 generateOCRMask 的区别：
 *   - 不依赖 composite.duplicateBlockIds / sourceBlocks
 *   - 直接接收需 mask 的 CSS bbox 数组（来自 segmentSignatureRegion）
 *
 * @param cssBboxes - 需 mask 的 CSS bbox 列表（来自 duplicate-text sub-regions）
 */
export function generateMaskFromBboxes(
  imageData: ImageData,
  zoneCx: number,
  zoneCy: number,
  cssScale: number,
  cssBboxes: Array<{ x: number; y: number; width: number; height: number }>,
  opts: OCRMaskOptions = { expand: true, dilate: true },
): OCRMaskResult {
  return generateMaskCoreFromBboxes(imageData, zoneCx, zoneCy, cssScale, cssBboxes, opts);
}

// ────────────────────────────────────────────────────────────
// 核心实现
// ────────────────────────────────────────────────────────────

function generateMaskCore(
  imageData: ImageData,
  zoneCx: number,
  zoneCy: number,
  cssScale: number,
  composite: SignatureCompositeRegion,
  opts: OCRMaskOptions,
): OCRMaskResult {
  const { width, height } = imageData;

  // 初始化空 mask
  const mask: Uint8Array[] = [];
  for (let r = 0; r < height; r++) {
    mask.push(new Uint8Array(width));
  }

  const dupBlockIds = new Set(composite.duplicateBlockIds);
  const dupBlocks = composite.sourceBlocks.filter((b) => dupBlockIds.has(b.id));
  const maskedBlockIds: string[] = [];
  const blocks: OCRMaskBlockDebug[] = [];
  let maskPixelCount = 0;

  for (const block of dupBlocks) {
    const b = block.bbox;

    // 获取文本（用于 debug）
    const firstLine = block.lines?.[0];
    const firstGlyph = firstLine?.glyphs?.[0];
    const blockText = firstGlyph?.text ?? `block-${block.id.slice(0, 8)}`;

    // CSS 坐标 → canvas 像素坐标（应用 expand padding）
    let pixelPaddingX = 0;
    let pixelPaddingY = 0;
    if (opts.expand) {
      pixelPaddingX = Math.round(EXPAND_PADDING_X / cssScale);
      pixelPaddingY = Math.round(EXPAND_PADDING_Y / cssScale);
    }

    const blockCanvasX = Math.round(b.x / cssScale) - pixelPaddingX;
    const blockCanvasY = Math.round(b.y / cssScale) - pixelPaddingY;
    const blockCanvasW = Math.round(b.width / cssScale) + pixelPaddingX * 2;
    const blockCanvasH = Math.round(b.height / cssScale) + pixelPaddingY * 2;

    // Canvas 坐标 → zone 内局部坐标（相对 crop 左上角）
    let x1 = blockCanvasX - zoneCx;
    let y1 = blockCanvasY - zoneCy;
    let x2 = x1 + blockCanvasW;
    let y2 = y1 + blockCanvasH;

    // Clamp 到 imageData 边界内
    const origX1 = Math.max(0, Math.min(width, x1));
    const origY1 = Math.max(0, Math.min(height, y1));
    const origX2 = Math.max(0, Math.min(width, x2));
    const origY2 = Math.max(0, Math.min(height, y2));

    x1 = origX1; y1 = origY1; x2 = origX2; y2 = origY2;

    if (x1 >= x2 || y1 >= y2) continue; // block 完全在 zone 外

    // 填充 mask 矩形
    let pixelsFilled = 0;
    for (let r = y1; r < y2; r++) {
      for (let c = x1; c < x2; c++) {
        if (mask[r][c] === 0) {
          mask[r][c] = 1;
          maskPixelCount++;
          pixelsFilled++;
        }
      }
    }

    maskedBlockIds.push(block.id);

    // Sprint30.1: 每 block 的 debug 信息
    blocks.push({
      text: blockText,
      originalBBox: { x: b.x, y: b.y, width: b.width, height: b.height },
      expandedBBox: opts.expand
        ? {
            x: b.x - EXPAND_PADDING_X,
            y: b.y - EXPAND_PADDING_Y,
            width: b.width + EXPAND_PADDING_X * 2,
            height: b.height + EXPAND_PADDING_Y * 2,
          }
        : { x: b.x, y: b.y, width: b.width, height: b.height },
      pixelsBefore: pixelsFilled,
      pixelsAfterDilation: -1, // 稍后填写
    });
  }

  // Sprint30.1: dilation
  let dilatedPixelCount = maskPixelCount;
  if (opts.dilate && maskPixelCount > 0) {
    dilateMask(mask, width, height, DILATION_RADIUS);
    // 重新计数
    maskPixelCount = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (mask[r][c] === 1) maskPixelCount++;
      }
    }
    // 更新 blocks 中的 pixelsAfterDilation
    // 精确到每个 block 很困难（dilation 后区域重叠），这里给总变化量
    const delta = maskPixelCount - dilatedPixelCount;
    for (const bd of blocks) {
      bd.pixelsAfterDilation = bd.pixelsBefore + Math.round(delta / blocks.length);
    }
    dilatedPixelCount = maskPixelCount;
  } else {
    for (const bd of blocks) {
      bd.pixelsAfterDilation = bd.pixelsBefore;
    }
  }

  return {
    mask,
    maskedBlockIds,
    maskPixelCount: dilatedPixelCount > 0 ? dilatedPixelCount : maskPixelCount,
    dilatedPixelCount,
    blocks,
  };
}

// ────────────────────────────────────────────────────────────
// Sprint 31: 从显式 bbox 列表生成的 mask（不依赖 composite）
// ────────────────────────────────────────────────────────────

function generateMaskCoreFromBboxes(
  imageData: ImageData,
  zoneCx: number,
  zoneCy: number,
  cssScale: number,
  cssBboxes: Array<{ x: number; y: number; width: number; height: number }>,
  opts: OCRMaskOptions,
): OCRMaskResult {
  const { width, height } = imageData;

  const mask: Uint8Array[] = [];
  for (let r = 0; r < height; r++) {
    mask.push(new Uint8Array(width));
  }

  const maskedBlockIds: string[] = [];
  const blocks: OCRMaskBlockDebug[] = [];
  let maskPixelCount = 0;

  let padX = 0;
  let padY = 0;
  if (opts.expand) {
    padX = Math.round(EXPAND_PADDING_X / cssScale);
    padY = Math.round(EXPAND_PADDING_Y / cssScale);
  }

  for (let i = 0; i < cssBboxes.length; i++) {
    const b = cssBboxes[i];

    const blockCanvasX = Math.round(b.x / cssScale) - padX;
    const blockCanvasY = Math.round(b.y / cssScale) - padY;
    const blockCanvasW = Math.round(b.width / cssScale) + padX * 2;
    const blockCanvasH = Math.round(b.height / cssScale) + padY * 2;

    let x1 = blockCanvasX - zoneCx;
    let y1 = blockCanvasY - zoneCy;
    let x2 = x1 + blockCanvasW;
    let y2 = y1 + blockCanvasH;

    x1 = Math.max(0, Math.min(width, x1));
    y1 = Math.max(0, Math.min(height, y1));
    x2 = Math.max(0, Math.min(width, x2));
    y2 = Math.max(0, Math.min(height, y2));

    if (x1 >= x2 || y1 >= y2) continue;

    let pixelsFilled = 0;
    for (let r = y1; r < y2; r++) {
      for (let c = x1; c < x2; c++) {
        if (mask[r][c] === 0) {
          mask[r][c] = 1;
          maskPixelCount++;
          pixelsFilled++;
        }
      }
    }

    maskedBlockIds.push(`bbox_${i}`);

    blocks.push({
      text: `bbox_${i} (${Math.round(b.width)}x${Math.round(b.height)})`,
      originalBBox: { x: b.x, y: b.y, width: b.width, height: b.height },
      expandedBBox: opts.expand
        ? {
            x: b.x - EXPAND_PADDING_X,
            y: b.y - EXPAND_PADDING_Y,
            width: b.width + EXPAND_PADDING_X * 2,
            height: b.height + EXPAND_PADDING_Y * 2,
          }
        : { x: b.x, y: b.y, width: b.width, height: b.height },
      pixelsBefore: pixelsFilled,
      pixelsAfterDilation: -1,
    });
  }

  // dilation
  let dilatedPixelCount = maskPixelCount;
  if (opts.dilate && maskPixelCount > 0) {
    dilateMask(mask, width, height, DILATION_RADIUS);
    maskPixelCount = 0;
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (mask[r][c] === 1) maskPixelCount++;
      }
    }
    const delta = maskPixelCount - dilatedPixelCount;
    for (const bd of blocks) {
      bd.pixelsAfterDilation = bd.pixelsBefore + Math.round(delta / Math.max(1, blocks.length));
    }
    dilatedPixelCount = maskPixelCount;
  } else {
    for (const bd of blocks) {
      bd.pixelsAfterDilation = bd.pixelsBefore;
    }
  }

  return {
    mask,
    maskedBlockIds,
    maskPixelCount: dilatedPixelCount > 0 ? dilatedPixelCount : maskPixelCount,
    dilatedPixelCount,
    blocks,
  };
}

// ────────────────────────────────────────────────────────────
// Mask Dilation（形态学膨胀，2px radius）
// ────────────────────────────────────────────────────────────

/**
 * 对二值 mask 做半径 radius px 的形态学膨胀（8-邻域）。
 * 原地修改 mask。
 */
function dilateMask(
  mask: Uint8Array[],
  width: number,
  height: number,
  radius: number,
): void {
  if (radius <= 0) return;

  // 多轮 1px 膨胀（等效于 radius px）
  for (let pass = 0; pass < radius; pass++) {
    // 收集本轮需要设为 1 的像素（避免读-写冲突）
    const toSet: Array<[number, number]> = [];
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        if (mask[r][c] === 1) {
          // 8-邻域
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
              if (dr === 0 && dc === 0) continue;
              const nr = r + dr;
              const nc = c + dc;
              if (nr >= 0 && nr < height && nc >= 0 && nc < width && mask[nr][nc] === 0) {
                toSet.push([nr, nc]);
              }
            }
          }
        }
      }
    }
    for (const [r, c] of toSet) {
      mask[r][c] = 1;
    }
    if (toSet.length === 0) break; // 无变化，提前结束
  }
}
