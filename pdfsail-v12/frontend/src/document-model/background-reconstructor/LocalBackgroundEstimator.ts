/**
 * Sprint 31.1: Local Background Estimator
 *
 * 为每个 duplicate-text mask bbox 独立估算局部背景色。
 *
 * 算法：
 *   - 不像 estimateBackgroundColor() 那样读整个页面或顶部/底部边缘
 *   - 仅在 mask bbox 的 TOP / LEFT / RIGHT / BOTTOM 四周采样
 *   - padding = 10~20 px（canvas 像素）
 *   - 过滤暗像素（灰度 < DARK_THRESHOLD），因为黑色文字不能参与背景计算
 *   - 取采样中位数 RGB
 *
 * 输入: imageData（zone-cropped）、maskBBox（zone-local canvas 坐标）
 * 输出: { background: { r, g, b }, confidence: number }
 */

/** 灰度阈值：低于此值视为暗像素（文字），不参与背景计算 */
const DARK_THRESHOLD = 140;

/** 采样 padding（canvas 像素） */
const SAMPLE_PADDING_MIN = 10;
const SAMPLE_PADDING_MAX = 20;

/** 最小有效采样数，低于此值 confidence 降为 0 */
const MIN_SAMPLES = 5;

export interface LocalBackground {
  r: number;
  g: number;
  b: number;
}

export interface BackgroundEstimate {
  background: LocalBackground;
  /** 0-1，采样数量越多越接近 1 */
  confidence: number;
}

/**
 * 估算单个 mask bbox 周围的局部背景色。
 *
 * @param imageData  - 完整 zone 的 ImageData（zone.cw × zone.ch）
 * @param maskBBox   - mask bbox 在 zone-local canvas 像素坐标中的位置
 * @returns 估算的背景色和置信度
 */
export function estimateBackground(
  imageData: ImageData,
  maskBBox: { x: number; y: number; width: number; height: number },
): BackgroundEstimate {
  const { data, width, height } = imageData;

  // 确定采样区域（mask 四周各取 10-20px padding，不超过 imageData 边界）
  const padTop = Math.min(SAMPLE_PADDING_MAX, maskBBox.y);
  const padLeft = Math.min(SAMPLE_PADDING_MAX, maskBBox.x);
  const padRight = Math.min(SAMPLE_PADDING_MAX, width - (maskBBox.x + maskBBox.width));
  const padBottom = Math.min(SAMPLE_PADDING_MAX, height - (maskBBox.y + maskBBox.height));

  // 确保 padding 至少为 SAMPLE_PADDING_MIN（如果空间允许）
  const actualPadTop = padTop >= SAMPLE_PADDING_MIN ? padTop : 0;
  const actualPadLeft = padLeft >= SAMPLE_PADDING_MIN ? padLeft : 0;
  const actualPadRight = padRight >= SAMPLE_PADDING_MIN ? padRight : 0;
  const actualPadBottom = padBottom >= SAMPLE_PADDING_MIN ? padBottom : 0;

  const samples: Array<[number, number, number]> = [];

  // ── TOP 条带 ──
  if (actualPadTop > 0) {
    const yStart = maskBBox.y - actualPadTop;
    const yEnd = maskBBox.y;
    const xStart = Math.max(0, maskBBox.x);
    const xEnd = Math.min(width, maskBBox.x + maskBBox.width);
    sampleRect(data, width, xStart, yStart, xEnd, yEnd, samples);
  }

  // ── BOTTOM 条带 ──
  if (actualPadBottom > 0) {
    const yStart = maskBBox.y + maskBBox.height;
    const yEnd = maskBBox.y + maskBBox.height + actualPadBottom;
    const xStart = Math.max(0, maskBBox.x);
    const xEnd = Math.min(width, maskBBox.x + maskBBox.width);
    sampleRect(data, width, xStart, yStart, xEnd, yEnd, samples);
  }

  // ── LEFT 条带 ──
  if (actualPadLeft > 0) {
    const xStart = maskBBox.x - actualPadLeft;
    const xEnd = maskBBox.x;
    const yStart = Math.max(0, maskBBox.y);
    const yEnd = Math.min(height, maskBBox.y + maskBBox.height);
    sampleRect(data, width, xStart, yStart, xEnd, yEnd, samples);
  }

  // ── RIGHT 条带 ──
  if (actualPadRight > 0) {
    const xStart = maskBBox.x + maskBBox.width;
    const xEnd = maskBBox.x + maskBBox.width + actualPadRight;
    const yStart = Math.max(0, maskBBox.y);
    const yEnd = Math.min(height, maskBBox.y + maskBBox.height);
    sampleRect(data, width, xStart, yStart, xEnd, yEnd, samples);
  }

  // 如果四周采样都不够，降级为全 zone 采样（去暗像素）
  if (samples.length < MIN_SAMPLES) {
    for (let r = 0; r < height; r++) {
      for (let c = 0; c < width; c++) {
        const i = (r * width + c) * 4;
        const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (gray >= DARK_THRESHOLD) {
          samples.push([data[i], data[i + 1], data[i + 2]]);
        }
      }
    }
  }

  // 无有效采样 → 纯白
  if (samples.length === 0) {
    return { background: { r: 255, g: 255, b: 255 }, confidence: 0 };
  }

  // 按亮度排序取中位数
  samples.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const mid = Math.floor(samples.length / 2);
  const [r, g, b] = samples[mid];

  // 置信度：采样数 / 最大可能采样数（取四周各 20px 的像素数作为上限）
  const maxPossibleSamples =
    (maskBBox.width * SAMPLE_PADDING_MAX) * 2 +  // top + bottom
    (maskBBox.height * SAMPLE_PADDING_MAX) * 2;   // left + right
  const confidence = Math.min(1, samples.length / Math.max(MIN_SAMPLES, maxPossibleSamples * 0.3));

  return { background: { r, g, b }, confidence };
}

/**
 * 在矩形区域内采样非暗像素。
 */
function sampleRect(
  data: Uint8ClampedArray,
  width: number,
  xStart: number,
  yStart: number,
  xEnd: number,
  yEnd: number,
  out: Array<[number, number, number]>,
): void {
  for (let r = yStart; r < yEnd; r++) {
    for (let c = xStart; c < xEnd; c++) {
      const i = (r * width + c) * 4;
      const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      if (gray >= DARK_THRESHOLD) {
        out.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
  }
}

/**
 * 为多个 mask bbox 分别估算背景色，取加权平均。
 * 用于将 per-bbox 估算合并为单一背景色（供 createFeatherMask + localInpaint 使用）。
 */
export function estimateBackgroundsForBboxes(
  imageData: ImageData,
  maskBBoxes: Array<{ x: number; y: number; width: number; height: number }>,
): { background: LocalBackground; confidence: number } {
  if (maskBBoxes.length === 0) {
    return { background: { r: 255, g: 255, b: 255 }, confidence: 0 };
  }

  if (maskBBoxes.length === 1) {
    return estimateBackground(imageData, maskBBoxes[0]);
  }

  // 多个 bbox：取各 bbox 背景色的加权平均（按 confidence 加权）
  let totalWeight = 0;
  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;

  for (const bbox of maskBBoxes) {
    const est = estimateBackground(imageData, bbox);
    const w = est.confidence;
    weightedR += est.background.r * w;
    weightedG += est.background.g * w;
    weightedB += est.background.b * w;
    totalWeight += w;
  }

  if (totalWeight === 0) {
    return { background: { r: 255, g: 255, b: 255 }, confidence: 0 };
  }

  return {
    background: {
      r: Math.round(weightedR / totalWeight),
      g: Math.round(weightedG / totalWeight),
      b: Math.round(weightedB / totalWeight),
    },
    confidence: totalWeight / maskBBoxes.length,
  };
}
