/**
 * Sprint 31.1: Local Inpaint
 *
 * 用羽化 alpha mask 将背景色混入原图，替代旧的硬边填充。
 *
 * 旧方案（Sprint 30/31）:
 *   inpaintTextPixels() → 对每个 mask 像素硬替换为背景色（或水平插值）
 *   → 产生明显的白色矩形边界
 *
 * 新方案（Sprint 31.1）:
 *   localInpaint() → 对每个像素按 alpha 混合
 *   result = old * (1 - alpha) + bg * alpha
 *
 * 效果：
 *   - alpha = 1 的中心 → 完全背景色（文字被擦除）
 *   - alpha = 0.3~0.9 的边缘 → 保留纹理 + 部分背景色混合（羽化过渡）
 *   - alpha = 0 → 完全保留原像素
 */

import type { LocalBackground } from "./LocalBackgroundEstimator";

/**
 * 使用 alpha mask 将背景色混合到原图中。
 *
 * @param imageData   - 原始 zone 像素数据
 * @param alphaMask   - 羽化 alpha mask（Float32Array[]）
 * @param background  - 估算的背景色 { r, g, b }
 * @returns 混合后的像素数据（Uint8ClampedArray）
 */
export function localInpaint(
  imageData: ImageData,
  alphaMask: Float32Array[],
  background: LocalBackground,
): Uint8ClampedArray {
  const src = imageData.data;
  const { width, height } = imageData;
  const dst = new Uint8ClampedArray(src.length);

  let blendedPixelCount = 0;

  for (let r = 0; r < height; r++) {
    const alphaRow = alphaMask[r];
    for (let c = 0; c < width; c++) {
      const alpha = alphaRow[c];
      const i = (r * width + c) * 4;

      if (alpha <= 0) {
        // 非 mask 像素 → 原样保留
        dst[i] = src[i];
        dst[i + 1] = src[i + 1];
        dst[i + 2] = src[i + 2];
        dst[i + 3] = src[i + 3];
      } else {
        // mask 像素 → alpha blend
        // result = old * (1 - alpha) + bg * alpha
        dst[i] = Math.round(src[i] * (1 - alpha) + background.r * alpha);
        dst[i + 1] = Math.round(src[i + 1] * (1 - alpha) + background.g * alpha);
        dst[i + 2] = Math.round(src[i + 2] * (1 - alpha) + background.b * alpha);
        dst[i + 3] = 255; // 不透明
        blendedPixelCount++;
      }
    }
  }

  // Debug info stored for later use
  if (typeof window !== "undefined") {
    (window as any).__sprint31_1_lastBlendCount = blendedPixelCount;
  }

  return dst;
}
