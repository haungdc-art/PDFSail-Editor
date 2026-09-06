/**
 * glyph-mask.ts — GlyphDetector + GlyphMask（Implementation-001 Phase-1 · Compliance-1）
 *
 * ## Compliance-1（Introduce GlyphMask abstraction · No behavior change）
 *
 * 背景：Sprint21 `eraseTextPixels` 同时负责"识别暗像素"和"用背景色替换"两个职责。
 * 这导致后续 Region-aware / Structure-aware 升级时，都要改同一个函数。
 *
 * 本模块把"识别 Glyph"从"像素重建"中分离：
 *   GlyphDetector  → 输入 ImageData，输出 GlyphMask（1=文字/0=背景）
 *   GlyphMask      → 文字像素掩码（Uint8Array, w×h）
 *   PixelReconstructor →（在 background-text-remover 中）输入 ImageData + GlyphMask + bgColor，
 *                        只重建 glyph 像素
 *
 * 三者现在都可以还是旧算法（DARK_THRESHOLD 判定），**不改行为**（C1 Behavior preserved）。
 * 后续 Region-aware / Structure-aware 只替换 detectGlyphMask 的算法，PixelReconstructor 不动。
 *
 * ## Decision-001
 * Background reconstruction must never overwrite non-text pixels.
 * GlyphMask 精确标记文字区域，PixelReconstructor 只重建 mask 内的像素 → 不覆盖非文字。
 */

/** 暗像素阈值（灰度 < DARK_THRESHOLD 视为文字/线条） */
export const DARK_THRESHOLD = 128;

/** Glyph 掩码：Uint8Array，w×h，1=文字像素，0=背景像素 */
export type GlyphMask = Uint8Array;

/** detectGlyphMask 选项 */
export interface GlyphDetectOptions {
  /**
   * 排除表格线/边框（长直线）——Decision-001 合规（保留非文字结构）。
   * 默认 true。
   */
  excludeLines?: boolean;
  /** 水平线判定阈值（run 长度 / 宽度 比例，默认 0.5） */
  hLineRatio?: number;
  /** 垂直线判定阈值（run 长度 / 高度 比例，默认 0.5） */
  vLineRatio?: number;
}

/**
 * 从 ImageData 检测文字像素，生成 GlyphMask。
 *
 * Compliance-2（Glyph-aware detection, Decision-001 compliant）：
 *   - 初步 mask：灰度 < DARK_THRESHOLD(128) → 1（暗像素：文字 + 表格线）
 *   - 排除长直线（表格线/边框）：水平/垂直 run 长度超过页面尺寸比例 → 视为非文字结构（P3 保留），置 0
 *   - 这样 PixelReconstructor 只重建文字字形，表格线保留（Decision-001 不覆盖非文字）
 *
 * 后续 Phase-3（Structure-aware）可替换此函数，PixelReconstructor 无需改动。
 *
 * @param imageData 裁剪的 block 区域像素
 * @param w 宽度
 * @param h 高度
 * @param options 检测选项
 * @returns GlyphMask（w×h，1=文字，0=背景）
 */
export function detectGlyphMask(
  imageData: ImageData,
  w: number,
  h: number,
  options: GlyphDetectOptions = {},
): GlyphMask {
  const src = imageData.data;
  let mask = new Uint8Array(w * h);

  // 1) 初步：暗像素 → 文字/线条
  for (let i = 0; i < w * h; i++) {
    const px = i * 4;
    const gray = src[px] * 0.299 + src[px + 1] * 0.587 + src[px + 2] * 0.114;
    mask[i] = gray < DARK_THRESHOLD ? 1 : 0;
  }

  // Compliance-2: 排除表格线/边框（长直线）
  if (options.excludeLines !== false) {
    const hRatio = options.hLineRatio ?? 0.5;
    const vRatio = options.vLineRatio ?? 0.5;
    mask = excludeLongLines(mask, w, h, hRatio, vRatio);
  }

  return mask;
}

/**
 * 排除长直线（表格线/边框）：
 *   - 水平 run 长度 >= hRatio * w → 表格横线（置 0）
 *   - 垂直 run 长度 >= vRatio * h → 表格竖线/边框（置 0）
 * 文字字形通常不形成贯穿半页的直线，因此不会误伤。
 */
function excludeLongLines(
  mask: GlyphMask,
  w: number,
  h: number,
  hRatio: number,
  vRatio: number,
): GlyphMask {
  const result = mask.slice();
  const hMin = Math.max(2, Math.floor(w * hRatio));
  const vMin = Math.max(2, Math.floor(h * vRatio));

  // 水平 run 检测（逐行）
  for (let y = 0; y < h; y++) {
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const isDark = x < w && mask[y * w + x] === 1;
      if (isDark && runStart === -1) {
        runStart = x;
      } else if (!isDark && runStart !== -1) {
        const runLen = x - runStart;
        if (runLen >= hMin) {
          // 长水平 run → 表格横线 → 排除
          for (let k = runStart; k < x; k++) result[y * w + k] = 0;
        }
        runStart = -1;
      }
    }
  }

  // 垂直 run 检测（逐列）
  for (let x = 0; x < w; x++) {
    let runStart = -1;
    for (let y = 0; y <= h; y++) {
      const isDark = y < h && mask[y * w + x] === 1;
      if (isDark && runStart === -1) {
        runStart = y;
      } else if (!isDark && runStart !== -1) {
        const runLen = y - runStart;
        if (runLen >= vMin) {
          // 长垂直 run → 表格竖线/边框 → 排除
          for (let k = runStart; k < y; k++) result[k * w + x] = 0;
        }
        runStart = -1;
      }
    }
  }

  return result;
}

/** 创建全 0 掩码（无文字） */
export function emptyGlyphMask(w: number, h: number): GlyphMask {
  return new Uint8Array(w * h);
}

/** 统计 Glyph 像素数（用于 debug/coverage） */
export function countGlyphPixels(mask: GlyphMask): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) n++;
  return n;
}
