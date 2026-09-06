/**
 * Geometry Detector — Task 2 + Task 3
 *
 * 为 OCR preserve 区域（signature / stamp / handwriting）恢复几何变换。
 *
 * 输入：OCR block + 原始 image crop
 * 输出：geometry: { angle, transform }
 *
 * Task 2: Signature 区域进行 rotation 检测
 *   优先：OCR provider angle（GLM-OCR 返回的 angle 字段）
 *   否则：image analysis（从 image crop 检测文字倾斜角度）
 *
 * Task 3: 生成 PDF transform matrix
 *   angle θ → matrix [cosθ, sinθ, -sinθ, cosθ, 0, 0]
 *
 * 坐标系：
 *   - angle：度（顺时针为正），0 = 无旋转
 *   - transform：CSS 归一化形式（缩放归一化为 1，平移归零）
 *   - PDF Y-up 与 CSS Y-down 旋转方向一致，不取反 b/c
 */

import type { OcrBlockGeometry } from "../ocr/ocr-storage";
import type { LayoutRegionType, TransformMatrix } from "./types";

/**
 * 角度（度）→ CSS 归一化 transform matrix。
 *
 * angle θ → [cosθ, sinθ, -sinθ, cosθ, 0, 0]
 *
 * 与 CSS rotate(θdeg) = matrix(cosθ, sinθ, -sinθ, cosθ, 0, 0) 一致。
 * 缩放归一化为 1（fontSize 由 style 控制），平移归零（位置由 bbox 控制）。
 *
 * @param angle 角度（度，顺时针为正）
 * @returns CSS 归一化 transform matrix
 */
export function angleToTransformMatrix(angle: number): TransformMatrix {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cos, sin, -sin, cos, 0, 0];
}

/**
 * 从 transform matrix 提取旋转角度（度）。
 *
 * matrix [a, b, c, d, e, f] → angle = atan2(b, a) × 180 / π
 *
 * @param transform CSS 归一化 transform matrix
 * @returns 角度（度，顺时针为正）
 */
export function transformMatrixToAngle(transform: TransformMatrix): number {
  const [a, b] = transform;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

/**
 * resolveBlockRotation — Authoritative Rotation Resolution API。
 *
 * 返回一个 Block 当前应采用的**权威视觉旋转角度**（度，顺时针为正）。
 *
 * 这个 API 有意隐藏 rotation 的来源。
 * Callers（PDFEditor / Renderer / Export）**不得**直接检查 glyph.transform
 * 或自行 `transformMatrixToAngle(...)`——那会让 Geometry 逻辑泄漏到上层组件，
 * 并使 rotation 来源的演进（glyph.transform → glyph.rotation → geometry.rotation
 * → OCR.rotation）需要同时改动所有消费方。
 *
 * 解析优先级（结构化，随数据源演进）：
 *   Priority 1: block.rotation            （未来：Block 级权威 rotation）
 *   Priority 2: block.geometry?.rotation  （未来：Geometry 输出 rotation）
 *   Priority 3: glyph.transform           （当前 Provider：OCR/geometry 阶段按行算好的真实角度）
 *   fallback:   0                          （无任何旋转信息 → 水平）
 *
 * 注意：Priority 1 / 2 当前数据类型尚未提供，**保留为 TODO**，
 * 仅表达未来解析顺序，不因当前无数据而删除结构。
 *
 * @param block 文档 block（含可选的 block.rotation / geometry / glyph.transform）
 * @returns 旋转角度（度，顺时针为正），无旋转返回 0
 */
export function resolveBlockRotation(block: {
  /** 未来：Block 级权威 rotation（当前类型未提供，预留） */
  rotation?: number;
  /** 未来：Geometry 输出 rotation（当前类型未提供，预留） */
  geometry?: { rotation?: number };
  lines: Array<{ glyphs: Array<{ transform?: TransformMatrix }> }>;
}): number {
  // Priority 1: block.rotation（预留 TODO：当前 EditableBlock 无该字段）
  if (block.rotation != null && Number.isFinite(block.rotation)) {
    return block.rotation;
  }

  // Priority 2: geometry.rotation（预留 TODO：当前 EditableBlock 无 geometry）
  const geomRot = block.geometry?.rotation;
  if (geomRot != null && Number.isFinite(geomRot)) {
    return geomRot;
  }

  // Priority 3: glyph.transform（当前 Provider）
  // 取该 block 第一个非单位矩阵的 glyph.transform 角度；全部单位矩阵 → 继续 fallback。
  for (const line of block.lines) {
    for (const g of line.glyphs) {
      const t = g.transform;
      if (!t) continue;
      if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1) {
        return transformMatrixToAngle(t);
      }
    }
  }

  // fallback: 0
  return 0;
}

/**
 * 判断是否需要对区域进行几何变换检测。
 *
 * 仅 signature / stamp / handwriting 区域需要恢复旋转角度。
 * paragraph / table / footer 不需要（正常水平文字）。
 *
 * @param regionType 区域类型
 * @returns 是否需要 geometry 检测
 */
export function needsGeometryDetection(regionType: LayoutRegionType): boolean {
  return regionType === "signature" || regionType === "stamp";
  // handwriting 不在 LayoutRegionType 中，但 signature 已涵盖手写签名场景
}

/**
 * Task 2: 从 image crop 检测文字旋转角度。
 *
 * Image analysis 算法：基于投影剖面（projection profile）的倾斜检测。
 *   1. 将 image crop 转为灰度
 *   2. 二值化（Otsu 阈值或固定阈值）
 *   3. 在 -45° ~ +45° 范围内以 1° 步长旋转图像
 *   4. 对每个角度计算水平投影的方差（行像素和的方差）
 *   5. 方差最大的角度 = 文字的实际倾斜角度（取反即为校正角度）
 *
 * 简化实现：使用 canvas 像素分析，步长 2° 以平衡性能和精度。
 *
 * @param imageCrop Canvas 包含 OCR block 对应的图像区域
 * @returns 检测到的旋转角度（度，顺时针为正），0 = 无旋转
 */
export function detectRotationFromImage(imageCrop: HTMLCanvasElement): number {
  const ctx = imageCrop.getContext("2d");
  if (!ctx) return 0;

  const w = imageCrop.width;
  const h = imageCrop.height;
  if (w < 2 || h < 2) return 0;

  // 获取像素数据
  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch {
    // 跨域或空 canvas，无法分析
    return 0;
  }

  const data = imageData.data;
  const grayPixels = new Uint8Array(w * h);

  // 转灰度
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    grayPixels[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // 计算 Otsu 阈值（自动二值化）
  const threshold = otsuThreshold(grayPixels);

  // 二值化：深色（文字）= 1，浅色（背景）= 0
  const binary = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    binary[i] = grayPixels[i] < threshold ? 1 : 0;
  }

  // 在 -45° ~ +45° 范围内搜索最佳角度（步长 2°）
  let bestAngle = 0;
  let bestVariance = -1;

  for (let angle = -45; angle <= 45; angle += 2) {
    const variance = computeProjectionVariance(binary, w, h, angle);
    if (variance > bestVariance) {
      bestVariance = variance;
      bestAngle = angle;
    }
  }

  // 细搜：在最佳角度附近 ±2° 以 0.5° 步长搜索
  if (bestAngle !== 0 || bestVariance > 0) {
    for (let angle = bestAngle - 2; angle <= bestAngle + 2; angle += 0.5) {
      const variance = computeProjectionVariance(binary, w, h, angle);
      if (variance > bestVariance) {
        bestVariance = variance;
        bestAngle = angle;
      }
    }
  }

  // 只在角度足够大时才返回（小于 2° 视为无旋转，避免噪声）
  if (Math.abs(bestAngle) < 2) return 0;

  return Math.round(bestAngle * 10) / 10; // 保留 1 位小数
}

/**
 * 计算给定角度下水平投影剖面的方差。
 *
 * 原理：文字行在正确的角度下，水平投影（每行文字像素数）的方差最大
 * （行内文字像素密集，行间空白，方差大）。
 * 倾斜时投影分散，方差小。
 *
 * 简化算法：不实际旋转图像，而是用仿射变换映射计算每行的像素分布。
 *
 * @param binary 二值化像素（1=文字，0=背景），行优先
 * @param w 宽度
 * @param h 高度
 * @param angle 测试角度（度）
 * @returns 投影方差
 */
function computeProjectionVariance(
  binary: Uint8Array,
  w: number,
  h: number,
  angle: number
): number {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = w / 2;
  const cy = h / 2;

  // 旋转后的包围盒
  const newW = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const newH = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));

  // 投影数组（每行的文字像素数）
  const projection = new Float32Array(newH);

  // 遍历原始像素，映射到旋转后坐标
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (binary[y * w + x] === 0) continue; // 跳过背景

      // 旋转坐标变换（绕中心旋转）
      const dx = x - cx;
      const dy = y - cy;
      const newY = Math.round(sin * dx + cos * dy + cy + (newH - h) / 2);

      if (newY >= 0 && newY < newH) {
        projection[newY]++;
      }
    }
  }

  // 计算方差
  let sum = 0;
  let count = 0;
  for (let i = 0; i < newH; i++) {
    if (projection[i] > 0) {
      sum += projection[i];
      count++;
    }
  }
  if (count === 0) return 0;

  const mean = sum / count;
  let variance = 0;
  for (let i = 0; i < newH; i++) {
    if (projection[i] > 0) {
      const diff = projection[i] - mean;
      variance += diff * diff;
    }
  }
  return variance / count;
}

/**
 * Otsu 自适应阈值算法。
 *
 * 从灰度直方图计算最佳二值化阈值，
 * 使前景（文字）和背景的类间方差最大。
 */
function otsuThreshold(grayPixels: Uint8Array): number {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < grayPixels.length; i++) {
    histogram[grayPixels[i]]++;
  }

  const total = grayPixels.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += i * histogram[i];
  }

  let sumB = 0;
  let wB = 0;
  let maxVariance = 0;
  let threshold = 128;

  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;

    const wF = total - wB;
    if (wF === 0) break;

    sumB += t * histogram[t];

    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;

    const variance = wB * wF * (mB - mF) * (mB - mF);
    if (variance > maxVariance) {
      maxVariance = variance;
      threshold = t;
    }
  }

  return threshold;
}

/**
 * Task 2: 检测 OCR block 的旋转角度。
 *
 * 优先级：
 *   1. OCR provider angle（GLM-OCR 返回的 angle 字段）
 *   2. image analysis（从 image crop 检测）
 *   3. 0（无旋转）
 *
 * @param providerAngle OCR provider 返回的角度（可选）
 * @param imageCrop 原始 image crop（可选，用于 image analysis）
 * @returns 检测到的旋转角度（度，顺时针为正）
 */
export function detectRotation(
  providerAngle?: number,
  imageCrop?: HTMLCanvasElement
): number {
  // 1. 优先使用 OCR provider angle
  if (providerAngle !== undefined && !isNaN(providerAngle) && Math.abs(providerAngle) > 0.1) {
    return providerAngle;
  }

  // 2. image analysis
  if (imageCrop) {
    return detectRotationFromImage(imageCrop);
  }

  // 3. 无旋转
  return 0;
}

/**
 * Task 2 + Task 3: 检测旋转角度并生成 geometry。
 *
 * @param providerAngle OCR provider 返回的角度（可选）
 * @param imageCrop 原始 image crop（可选）
 * @returns OcrBlockGeometry（含 angle 和 transform），无旋转时 angle=0
 */
export function detectGeometry(
  providerAngle?: number,
  imageCrop?: HTMLCanvasElement
): OcrBlockGeometry {
  const angle = detectRotation(providerAngle, imageCrop);
  const transform = angleToTransformMatrix(angle);
  return { angle, transform };
}
