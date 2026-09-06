/**
 * SignatureTextMaskGenerator — Sprint 17
 *
 * 为签名区域生成 image-replacement 背景恢复 mask。
 *
 * 目标：
 *   - 不单独 mask 每个 handwritten block，而是生成一个 signature replacement zone。
 *   - 用白色填充矩形覆盖整个手写签名区域，实现 Adobe 级 OCR replacement。
 *   - printed block 的 OCR glyph 会渲染在 mask 之上，保持可见/可编辑。
 *
 * 输入：SignatureRegion
 * 输出：DrawRectCommand[]（type = "rect", fill = "#ffffff", opacity = 1）
 */

import type { BBox } from "./types";
import type { DrawRectCommand } from "./render-command";
import type { SignatureRegion } from "./signature-region-merger";

export interface SignatureMaskDebugInfo {
  /** 签名替换区域（被抑制 handwritten block 的并集 bbox），格式 x/y/w/h */
  region: { x: number; y: number; w: number; h: number };
  /** 生成的 mask 矩形列表，格式 x/y/w/h */
  masks: { x: number; y: number; w: number; h: number }[];
  /** 被擦除 handwritten block 文本 */
  erasedBlocks: string[];
  /** 保持可见的 printed block 文本 */
  visibleBlocks: string[];
}

function toDebugRect(bbox: BBox): { x: number; y: number; w: number; h: number } {
  return {
    x: bbox.x,
    y: bbox.y,
    w: bbox.width,
    h: bbox.height,
  };
}

interface Padding {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * 扩展 bbox。
 */
function expandBBox(bbox: BBox, padding: Padding): BBox {
  return {
    x: Math.round((bbox.x - padding.left) * 10) / 10,
    y: Math.round((bbox.y - padding.top) * 10) / 10,
    width: Math.round((bbox.width + padding.left + padding.right) * 10) / 10,
    height: Math.round((bbox.height + padding.top + padding.bottom) * 10) / 10,
  };
}

/**
 * 计算多个 bbox 的并集。
 */
function unionBBox(bboxes: BBox[]): BBox {
  if (bboxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

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

function blockText(block: SignatureRegion["blocks"][number]): string {
  return block.lines
    .map(line => line.glyphs.map(glyph => glyph.char).join(""))
    .join(" ")
    .trim();
}

/**
 * 估算 block 的字体大小（px）。
 * 优先从 glyph bbox 高度取最大，fallback 到 block bbox 高度。
 */
function estimateBlockFontSize(block: SignatureRegion["blocks"][number]): number {
  if (block.type !== "text") return 12;

  let maxHeight = 0;
  for (const line of block.lines) {
    for (const glyph of line.glyphs) {
      maxHeight = Math.max(maxHeight, glyph.bbox.height);
    }
  }

  if (maxHeight > 0) return maxHeight;
  return block.bbox.height > 0 ? block.bbox.height : 12;
}

/**
 * 为单个签名区域生成 image-replacement 背景恢复 mask。
 *
 * 策略：
 *   1. 取所有 suppressed handwritten block 的 bbox 并集。
 *   2. 根据字体大小动态扩展 padding：max(fontSize * 0.4, 5)。
 *   3. 生成一个白色填充矩形覆盖整个签名替换区域。
 */
export function generateSignatureTextMasks(
  region: SignatureRegion,
): DrawRectCommand[] {
  if (!region.maskRequired || region.replacementMode !== "text-replacement") {
    return [];
  }

  const suppressedBlocks = region.blocks.filter(b =>
    region.suppressedGlyphBlockIds.includes(b.id),
  );

  if (suppressedBlocks.length === 0) return [];

  // 1. 计算 suppressed block bbox 的并集（signature replacement zone）
  const union = unionBBox(suppressedBlocks.map(b => b.bbox));

  // 2. 根据最大字体大小动态扩展 padding
  const maxFontSize = Math.max(
    ...suppressedBlocks.map(estimateBlockFontSize),
  );
  const padding = Math.max(maxFontSize * 0.4, 5);

  const expanded = expandBBox(union, {
    left: padding,
    right: padding,
    top: padding,
    bottom: padding,
  });

  return [
    {
      type: "drawRect",
      x: expanded.x,
      y: expanded.y,
      width: expanded.width,
      height: expanded.height,
      fill: "#ffffff",
      opacity: 1,
      blockId: region.id,
      purpose: "mask",
    },
  ];
}

/**
 * 批量为多个签名区域生成 image-replacement 背景恢复 mask。
 */
export function generateSignatureTextMasksForRegions(
  regions: SignatureRegion[],
): DrawRectCommand[] {
  return regions.flatMap(r => generateSignatureTextMasks(r));
}

/**
 * 构建单个签名区域的 mask debug 信息。
 */
export function buildSignatureMaskDebug(
  region: SignatureRegion,
): SignatureMaskDebugInfo {
  const erasedBlocks = region.suppressedGlyphBlockIds
    .map(id => region.blocks.find(b => b.id === id))
    .filter((b): b is NonNullable<typeof b> => b !== undefined)
    .map(blockText);

  const visibleBlocks = region.visibleBlockIds
    .map(id => region.blocks.find(b => b.id === id))
    .filter((b): b is NonNullable<typeof b> => b !== undefined)
    .map(blockText);

  const suppressedBlocks = region.blocks.filter(b =>
    region.suppressedGlyphBlockIds.includes(b.id),
  );

  const masks = generateSignatureTextMasks(region).map(cmd =>
    toDebugRect({ x: cmd.x, y: cmd.y, width: cmd.width, height: cmd.height }),
  );

  // region 使用实际生成的 mask 矩形（已扩展 padding）
  const regionBBox =
    masks.length > 0
      ? { x: masks[0].x, y: masks[0].y, width: masks[0].w, height: masks[0].h }
      : suppressedBlocks.length > 0
      ? unionBBox(suppressedBlocks.map(b => b.bbox))
      : region.bbox;

  return {
    region: toDebugRect(regionBBox),
    masks,
    erasedBlocks,
    visibleBlocks,
  };
}

/**
 * 批量构建多个签名区域的 mask debug 信息。
 */
export function buildSignatureMaskDebugForRegions(
  regions: SignatureRegion[],
): SignatureMaskDebugInfo[] {
  return regions.map(r => buildSignatureMaskDebug(r));
}
