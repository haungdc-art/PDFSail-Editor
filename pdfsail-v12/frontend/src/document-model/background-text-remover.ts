/**
 * Sprint 21: Background Text Remover
 *
 * 输入：原始 PDF canvas + 所有 OCR blocks
 * 输出：CleanBackgroundPatch[]（每个 block 的文本已擦除的背景 patch）
 *
 * 规则：block bbox + 3px padding → 擦除文本 → 输出清洁背景图像
 *
 * 用途：替代签名区域专用的背景重建，覆盖整个页面的所有 OCR block，
 *       实现 Adobe Acrobat 风格的「扫描 PDF → 可编辑 PDF」视觉重建。
 */

import type { EditableBlock, BBox } from "./types";
// Implementation-001 Phase-1 · Compliance-1: 引入 GlyphMask（GlyphDetector），分离"识别"与"重建"职责
import { detectGlyphMask, type GlyphMask } from "./glyph-mask";

// ─── 类型 ────────────────────────────────────────────────────

export interface CleanBackgroundPatch {
  blockId: string;
  /** base64 data URL */
  dataURL: string;
  /** CSS 坐标（与 canvas 显示坐标一致） */
  bbox: BBox;
  pageIndex: number;
}

export interface BackgroundRemovalDebug {
  page: number;
  totalBlocks: number;
  removedBlocks: Array<{
    text: string;
    bbox: { x: number; y: number; w: number; h: number };
  }>;
  patchCount: number;
  coverage: number; // 擦除面积 / 页面总面积 (%)
}

// ─── 常量 ────────────────────────────────────────────────────

/** block bbox 外扩 padding（CSS px） */
const PADDING = 3;

// ─── 主入口 ──────────────────────────────────────────────────

/**
 * 移除页面上所有 OCR block 的文字。
 *
 * @param canvas    - 已渲染的 PDF 页面 canvas
 * @param blocks    - 该页所有 EditableBlock
 * @param pageIndex - 页面索引
 * @param cssScale  - canvas.clientWidth / canvas.width（CSS 缩放比例）
 */
export function removeAllBlockText(
  canvas: HTMLCanvasElement,
  blocks: EditableBlock[],
  pageIndex: number,
  cssScale: number,
): { patches: CleanBackgroundPatch[]; debug: BackgroundRemovalDebug } {
  const patches: CleanBackgroundPatch[] = [];
  const debugRemovedBlocks: BackgroundRemovalDebug["removedBlocks"] = [];
  let totalErasedArea = 0;
  const pageArea = canvas.width * canvas.height / (cssScale * cssScale); // CSS px^2

  for (const block of blocks) {
    if (block.type !== "text") continue;

    // 提取 block 文本（用于 debug）
    const blockText = block.lines
      .map((l) => l.glyphs.map((g) => g.char).join(""))
      .join(" ")
      .substring(0, 80);

    // 计算 bbox（使用原始位置，加 padding）
    const bbox = expandBBox(block.bbox, PADDING);
    const cx = Math.floor(bbox.x / cssScale);
    const cy = Math.floor(bbox.y / cssScale);
    const cw = Math.ceil(bbox.width / cssScale);
    const ch = Math.ceil(bbox.height / cssScale);

    // 边界检查
    if (cx < 0 || cy < 0 || cx + cw > canvas.width || cy + ch > canvas.height) {
      continue;
    }
    if (cw <= 2 || ch <= 2) continue;

    // 从 canvas 裁剪像素数据
    let imageData: ImageData;
    try {
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) continue;
      imageData = ctx.getImageData(cx, cy, cw, ch);
    } catch {
      continue;
    }

    // 背景颜色估计（采样边缘）
    const bgColor = estimateBgColor(imageData, cw, ch);

    // Compliance-1: GlyphDetector（识别文字像素 → GlyphMask）
    const glyphMask = detectGlyphMask(imageData, cw, ch);

    // PixelReconstructor（只重建 glyph 像素 → 清洁 ImageData）
    const clean = reconstructPixels(imageData, cw, ch, bgColor, glyphMask);

    // 转为 dataURL
    const patchCanvas = document.createElement("canvas");
    patchCanvas.width = cw;
    patchCanvas.height = ch;
    const patchCtx = patchCanvas.getContext("2d")!;
    const cleanImgData = patchCtx.createImageData(cw, ch);
    cleanImgData.data.set(clean);
    patchCtx.putImageData(cleanImgData, 0, 0);

    patches.push({
      blockId: block.id,
      dataURL: patchCanvas.toDataURL("image/png"),
      bbox: {
        x: bbox.x,
        y: bbox.y,
        width: bbox.width,
        height: bbox.height,
      },
      pageIndex,
    });

    totalErasedArea += bbox.width * bbox.height;

    debugRemovedBlocks.push({
      text: blockText,
      bbox: {
        x: Math.round(bbox.x * 10) / 10,
        y: Math.round(bbox.y * 10) / 10,
        w: Math.round(bbox.width * 10) / 10,
        h: Math.round(bbox.height * 10) / 10,
      },
    });
  }

  const coverage = pageArea > 0 ? Math.min(100, Math.round((totalErasedArea / pageArea) * 1000) / 10) : 0;

  const debug: BackgroundRemovalDebug = {
    page: pageIndex,
    totalBlocks: blocks.filter((b) => b.type === "text").length,
    removedBlocks: debugRemovedBlocks,
    patchCount: patches.length,
    coverage,
  };

  return { patches, debug };
}

// ─── 辅助函数 ────────────────────────────────────────────────

/** 扩展 BBox（外扩 padding，不超出边界） */
function expandBBox(bbox: BBox, pad: number): BBox {
  return {
    x: Math.max(0, bbox.x - pad),
    y: Math.max(0, bbox.y - pad),
    width: bbox.width + pad * 2,
    height: bbox.height + pad * 2,
  };
}

/** 采样边缘像素估算背景色（中位数 RGB） */
function estimateBgColor(
  imageData: ImageData,
  w: number,
  h: number,
): [number, number, number] {
  const { data } = imageData;
  const samples: Array<[number, number, number]> = [];

  // 从顶部 3 行和底部 3 行边缘采样
  const edgeRows = Math.min(3, Math.floor(h / 2));
  for (let r = 0; r < edgeRows; r++) {
    for (let c = 0; c < w; c += 2) {
      // 每隔一列采样
      const i = (r * w + c) * 4;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray >= DARK_THRESHOLD) {
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
  for (let r = h - edgeRows; r < h; r++) {
    for (let c = 0; c < w; c += 2) {
      const i = (r * w + c) * 4;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray >= DARK_THRESHOLD) {
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }

  // 从左右 3 列边缘采样
  const edgeCols = Math.min(3, Math.floor(w / 2));
  for (let r = edgeRows; r < h - edgeRows; r += 4) {
    for (let c = 0; c < edgeCols; c++) {
      const i = (r * w + c) * 4;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray >= DARK_THRESHOLD) {
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    for (let c = w - edgeCols; c < w; c++) {
      const i = (r * w + c) * 4;
      const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
      if (gray >= DARK_THRESHOLD) {
        samples.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }

  // 回退：整个区域采样非暗像素
  if (samples.length < 5) {
    for (let r = 0; r < h; r += 3) {
      for (let c = 0; c < w; c += 3) {
        const i = (r * w + c) * 4;
        const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        if (gray >= DARK_THRESHOLD) {
          samples.push([data[i], data[i + 1], data[i + 2]]);
        }
      }
    }
  }

  if (samples.length === 0) return [255, 255, 255];

  // 中位数
  samples.sort((a, b) => a[0] + a[1] + a[2] - b[0] - b[1] - b[2]);
  const mid = Math.floor(samples.length / 2);
  return samples[mid];
}

/**
 * PixelReconstructor：只重建 GlyphMask 内的像素（文字），保留其余（背景/表格线）。
 *
 * Compliance-1：从 eraseTextPixels 重构，识别职责已分离到 GlyphDetector（glyph-mask.ts）。
 * 行为与旧 eraseTextPixels 完全一致（C1 Behavior preserved）：
 *   glyph mask=1 → 填 bgColor；mask=0 → 保留原样。
 *
 * Decision-001：只重建 mask 内像素，不覆盖非文字（mask=0 保留）→ 合规。
 */
function reconstructPixels(
  imageData: ImageData,
  w: number,
  h: number,
  bgColor: [number, number, number],
  glyphMask: GlyphMask,
): Uint8ClampedArray {
  const src = imageData.data;
  const dst = new Uint8ClampedArray(src.length);

  for (let i = 0; i < w * h; i++) {
    const px = i * 4;
    if (glyphMask[i] === 1) {
      // 文字像素 → 填充背景色
      dst[px] = bgColor[0];
      dst[px + 1] = bgColor[1];
      dst[px + 2] = bgColor[2];
      dst[px + 3] = 255;
    } else {
      // 非文字像素 → 保留原样（Decision-001: 不覆盖非文字）
      dst[px] = src[px];
      dst[px + 1] = src[px + 1];
      dst[px + 2] = src[px + 2];
      dst[px + 3] = src[px + 3];
    }
  }

  return dst;
}
