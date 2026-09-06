/**
 * SignatureGeometryAnalyzer — V2
 *
 * 检测签名区域的旋转角度。
 *
 * 优先级（从精确到粗略）：
 *   1. Baseline Detection：从图像 crop 提取文字组件质心 → 线性回归检测基线
 *      不受横线、CRM 印章、背景噪点干扰（通过组件尺寸/长宽比过滤）
 *   2. PCA（图像矩法）：fallback，当组件质心不足时使用
 *
 * 输入：page image crop（signature block 对应的图像区域）
 * 输出：{ angle, transform, method, confidence }
 *
 * Baseline Detection 原理：
 *   - 二值化 → 连通组件分析 → 过滤（剔除长横线/大面积印章/噪声）
 *   - 每个文本组件质心 (xi, yi) → 线性回归 y = kx + b
 *   - angle = atan(k)，R² 作为置信度
 *
 * PCA 原理（fallback）：
 *   - 图像矩公式：tan(2θ) = 2·μ_11 / (μ_20 − μ_02)
 *   - PCA 第一主成分方向 = 笔迹分布最大方向
 *
 * 支持：horizontal baseline + -45° ~ +45° 旋转
 */

import type { EditablePage, TransformMatrix } from "./types";
import { angleToTransformMatrix } from "./geometry-detector";
import {
  computeBaselineFromTransform,
  extractTransform,
  hasRotation,
  type PagedGeometryInfo,
  type TextGeometry,
} from "./text-geometry";

export interface SignatureGeometryResult {
  /** 旋转角度（度，顺时针为正，0 = 水平基线） */
  angle: number;
  /** CSS 归一化 transform matrix [cosθ, sinθ, -sinθ, cosθ, 0, 0] */
  transform: TransformMatrix;
  /** 使用的检测方法 */
  method: "baseline" | "pca";
  /** 置信度（0-1）：baseline 为 R²，PCA 为 0 */
  confidence: number;
  /** 提取到的文字组件质心数量 */
  componentCount: number;
}

/**
 * Geometry Candidate（P0-011 Commit 1）— 单个检测候选。
 *
 * Analyzer 只 Produce Candidate，不做最终选择。
 * 选择由 Geometry Pipeline 的 chooseBestCandidate() 负责。
 */
export interface GeometryCandidate {
  /** 使用的检测方法 */
  method: "baseline" | "pca";
  /** 旋转角度（度，顺时针为正） */
  angle: number;
  /** 置信度（0-1） */
  confidence: number;
  /** 附加元数据（如 componentCount、rawAngle、r2 等），供审计/调试 */
  metadata?: Record<string, unknown>;
}

/**
 * Geometry Analysis（P0-011 Commit 1）— Analyzer 的完整产出。
 *
 * candidates 可能为空（无候选）或含多个候选（baseline / pca / ...）。
 */
export interface GeometryAnalysis {
  candidates: GeometryCandidate[];
}

/**
 * Candidate Agreement（P0-012 Commit 1）— 多个候选是否相互支持。
 *
 * agreement：0-1，越高表示候选之间越一致。
 * deltaAngle：候选角度差（度），0 表示完全一致。
 */
export interface CandidateAgreement {
  agreement: number;
  deltaAngle: number;
}

/**
 * evaluateAgreement — 评估多个候选之间的相互支持程度（P0-012 Commit 1）。
 *
 * 仅打印日志，**不参与任何决策**（Commit 1 只引入概念，不改行为）。
 *
 * 规则：
 *   - 0 或 1 个候选：无法确认，agreement = 0，deltaAngle = Infinity。
 *   - ≥2 个候选：deltaAngle = maxAngle - minAngle，
 *     agreement = exp(-deltaAngle / 20)（角度差越大，一致性越低）。
 *     例：baseline=-7.5°, pca=-3.2° → delta=4.3° → agreement≈0.81。
 *
 * @param candidates Analyzer 产出的候选数组
 * @returns CandidateAgreement
 */
export function evaluateAgreement(
  candidates: GeometryCandidate[]
): CandidateAgreement {
  if (!candidates || candidates.length < 2) {
    const result: CandidateAgreement = { agreement: 0, deltaAngle: Infinity };
    console.log("[P0-012][evaluateAgreement]", {
      candidateCount: candidates?.length ?? 0,
      ...result,
    });
    return result;
  }

  const angles = candidates.map(c => c.angle);
  const minAngle = Math.min(...angles);
  const maxAngle = Math.max(...angles);
  const deltaAngle = Math.abs(maxAngle - minAngle);
  // sigma=20°：角度差 0 → agreement=1；角度差 20° → agreement≈0.37
  const agreement = Math.exp(-deltaAngle / 20);
  const result: CandidateAgreement = {
    agreement: Math.round(agreement * 100) / 100,
    deltaAngle: Math.round(deltaAngle * 10) / 10,
  };
  console.log("[P0-012][evaluateAgreement]", {
    candidateCount: candidates.length,
    angles,
    deltaAngle: result.deltaAngle,
    agreement: result.agreement,
  });
  return result;
}

// ────────────────────────────────────────────────────────────────
// 公共入口
// ────────────────────────────────────────────────────────────────

/**
 * 分析签名区域的几何变换，产出多个候选（P0-011 Commit 2）。
 *
 * Analyzer 只 Produce Candidates，不做最终选择。
 * 选择由 Geometry Pipeline 的 chooseBestCandidate() 负责。
 *
 * 流程：
 *   1. 二值化图像
 *   2. 提取文字组件质心 → Baseline Detection（线性回归）→ Baseline Candidate
 *   3. PCA（图像矩法）→ PCA Candidate
 *
 * @param imageCrop 签名区域对应的 page image crop（HTML Canvas）
 * @returns GeometryAnalysis（candidates 数组，可能为空）
 */
export function analyzeSignatureGeometryCandidates(
  imageCrop: HTMLCanvasElement
): GeometryAnalysis {
  // 1. 二值化（灰度 + Otsu 阈值）
  const bin = binarizeCrop(imageCrop);
  if (!bin) return { candidates: [] };

  const { gray, w, h, threshold } = bin;

  // 2. 连通组件分析 → 提取文字质心
  const centroids = extractTextComponentCentroids(gray, w, h, threshold);

  const candidates: GeometryCandidate[] = [];

  // 3. 质心足够 → 基线回归 → Baseline Candidate
  if (centroids.length >= 3) {
    const reg = linearRegressionAngle(centroids);
    if (reg && Math.abs(reg.angle) >= 0.5 && Math.abs(reg.angle) <= 45) {
      // Sprint-50 Task-005：方向可信度与线性拟合可信度解耦
      // 多行文本 R² 低但方向稳定 → 用 directionConfidence 作为候选置信度，而非 R²
      const directionConfidence = computeDirectionConfidence(centroids);
      candidates.push({
        method: "baseline",
        angle: clampAngle(reg.angle),
        confidence: directionConfidence,
        metadata: {
          componentCount: centroids.length,
          rawAngle: reg.angle,
          r2: Math.round(reg.r2 * 100) / 100,
          linearityConfidence: Math.round(reg.r2 * 100) / 100,
          directionConfidence,
          cropSize: { w, h },
        },
      });
      // Debug: baseline candidate
      console.log("[SignatureGeometryAnalyzer] baseline candidate:", {
        componentCount: centroids.length,
        regressionPoints: centroids.slice(0, 30).map(p => ({
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
        })),
        angle: clampAngle(reg.angle),
        confidence: directionConfidence,
        r2: Math.round(reg.r2 * 100) / 100,
        cropSize: { w, h },
      });
    }
    // Debug: baseline 条件不满足（R² 太低 或 angle 超出范围）
    if (reg) {
      console.log("[SignatureGeometryAnalyzer] baseline rejected:", {
        componentCount: centroids.length,
        regressionPoints: centroids.slice(0, 30).map(p => ({
          x: Math.round(p.x * 10) / 10,
          y: Math.round(p.y * 10) / 10,
        })),
        rawAngle: reg.angle,
        r2: Math.round(reg.r2 * 100) / 100,
        reason: reg.r2 < 0.3 ? "low R²" : "angle out of range",
        cropSize: { w, h },
      });
    }
  }

  // 4. PCA（图像矩法）→ PCA Candidate
  const pcaAngle = detectSignatureOrientationFromBinary(gray, w, h, threshold);
  if (pcaAngle !== 0) {
    candidates.push({
      method: "pca",
      angle: pcaAngle,
      confidence: 0,
      metadata: {
        componentCount: centroids.length,
        cropSize: { w, h },
      },
    });
  }
  console.log("[SignatureGeometryAnalyzer] pca candidate:", {
    method: "pca",
    componentCount: centroids.length,
    regressionPoints: centroids.slice(0, 30).map(p => ({
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
    })),
    angle: pcaAngle,
    confidence: 0,
    cropSize: { w, h },
  });

  return { candidates };
}

/**
 * 从 GeometryAnalysis 中选最优候选（P0-011 Commit 2）。
 *
 * 兼容函数：把 GeometryAnalysis 折叠为单个 SignatureGeometryResult。
 * 规则：按 confidence 最大排序，取第一个；无候选时返回 zeroResult("pca")。
 *
 * @param analysis Analyzer 的完整产出
 * @returns 单个最佳候选（折叠为 SignatureGeometryResult）
 */
export function analyzeSignatureGeometry(
  imageCrop: HTMLCanvasElement
): SignatureGeometryResult {
  const analysis = analyzeSignatureGeometryCandidates(imageCrop);
  if (analysis.candidates.length === 0) {
    return zeroResult("pca");
  }
  // 按 confidence 最大排序，取第一个
  const best = [...analysis.candidates].sort((a, b) => b.confidence - a.confidence)[0];
  const componentCount =
    typeof best.metadata?.componentCount === "number"
      ? best.metadata.componentCount
      : 0;
  return {
    angle: best.angle,
    transform: angleToTransformMatrix(best.angle),
    method: best.method,
    confidence: best.confidence,
    componentCount,
  };
}

// ────────────────────────────────────────────────────────────────
// 二值化
// ────────────────────────────────────────────────────────────────

interface BinarizedData {
  gray: Uint8Array;
  w: number;
  h: number;
  threshold: number;
}

/**
 * 从 Canvas 提取灰度图 + Otsu 阈值。
 */
function binarizeCrop(imageCrop: HTMLCanvasElement): BinarizedData | null {
  const w = imageCrop.width;
  const h = imageCrop.height;
  if (w < 4 || h < 4) return null;

  const ctx = imageCrop.getContext("2d");
  if (!ctx) return null;

  let imageData: ImageData;
  try {
    imageData = ctx.getImageData(0, 0, w, h);
  } catch {
    return null;
  }

  const numPixels = w * h;
  const gray = new Uint8Array(numPixels);
  const data = imageData.data;
  for (let i = 0; i < numPixels; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const threshold = otsuThreshold(gray);
  return { gray, w, h, threshold };
}

// ────────────────────────────────────────────────────────────────
// Baseline Detection：连通组件质心 + 线性回归
// ────────────────────────────────────────────────────────────────

interface Point {
  x: number;
  y: number;
}

interface RegressionResult {
  angle: number;  // 度
  r2: number;     // R² (0-1)
}

/**
 * 从二值图像中提取文字组件的质心。
 *
 * 使用 BFS 连通组件分析（8-邻域），按面积和长宽比过滤：
 *   - 面积 < 5px 或 > 30% 画布 → 过滤（噪声 / 大面积图案）
 *   - 长宽比 > 8 → 过滤（长横线 / CRM 线条）
 *
 * @returns 过滤后的组件质心列表
 */
function extractTextComponentCentroids(
  gray: Uint8Array,
  w: number,
  h: number,
  threshold: number
): Point[] {
  const visited = new Uint8Array(w * h);
  const centroids: Point[] = [];
  const maxArea = w * h * 0.3;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      const idx = rowOffset + x;
      // 背景像素 或 已访问 → 跳过
      if (gray[idx] >= threshold || visited[idx]) continue;

      // BFS 填充当前组件
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;

      const stack: number[] = [idx];
      visited[idx] = 1;

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cx = cur % w;
        const cy = Math.floor(cur / w);

        count++;
        sumX += cx;
        sumY += cy;
        if (cx < minX) minX = cx;
        if (cx > maxX) maxX = cx;
        if (cy < minY) minY = cy;
        if (cy > maxY) maxY = cy;

        // 8-邻域
        for (let dy = -1; dy <= 1; dy++) {
          const ny = cy + dy;
          if (ny < 0 || ny >= h) continue;
          const nRow = ny * w;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            if (nx < 0 || nx >= w) continue;
            const nIdx = nRow + nx;
            if (gray[nIdx] < threshold && !visited[nIdx]) {
              visited[nIdx] = 1;
              stack.push(nIdx);
            }
          }
        }
      }

      // 过滤规则
      if (count < 5) continue; // 噪声
      if (count > maxArea) continue; // 大面积（印章/背景块）

      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const aspectRatio = Math.max(bw, bh) / Math.max(Math.min(bw, bh), 1);
      if (aspectRatio > 8) continue; // 长横线

      centroids.push({ x: sumX / count, y: sumY / count });
    }
  }

  return centroids;
}

/**
 * 对点集做线性回归 y = kx + b，返回基线角度和 R² 置信度。
 *
 * k = Sxy / Sxx
 * angle = atan(k) * 180 / π
 * R² = Sxy² / (Sxx · Syy)
 *
 * @param points 质心点集
 * @returns { angle, r2 }，Sxx 过小时返回 null
 */
function linearRegressionAngle(points: Point[]): RegressionResult | null {
  const n = points.length;
  if (n < 2) return null;

  // 均值
  let meanX = 0;
  let meanY = 0;
  for (const p of points) {
    meanX += p.x;
    meanY += p.y;
  }
  meanX /= n;
  meanY /= n;

  // 离差平方和
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }

  // X 分布过窄 → 回归不可靠
  if (sxx < 1.0) return null;

  const k = sxy / sxx;

  // R² 置信度
  let r2 = 0;
  if (syy > 1e-10) {
    r2 = (sxy * sxy) / (sxx * syy);
    r2 = Math.max(0, Math.min(1, r2));
  }

  const angleRad = Math.atan(k);
  let angleDeg = (angleRad * 180) / Math.PI;

  // 规范化到 ±45°
  if (angleDeg > 45) angleDeg -= 90;
  if (angleDeg < -45) angleDeg += 90;

  return { angle: Math.round(angleDeg * 10) / 10, r2 };
}

// ────────────────────────────────────────────────────────────────
// PCA（图像矩法）— Fallback
// ────────────────────────────────────────────────────────────────

/**
 * 用图像矩法检测签名的基线方向（基于已二值化的数据）。
 *
 * 与 geometry-detector.ts 的 detectRotationFromImage() 的区别：
 *   - 图像矩直接计算 O(N)，投影剖面迭代搜索 O(N × numAngles)
 *   - 对稀疏签名笔迹更鲁棒
 *
 * @returns 旋转角度（度，顺时针为正），0 = 水平
 */
function detectSignatureOrientationFromBinary(
  gray: Uint8Array,
  w: number,
  h: number,
  threshold: number
): number {
  // 收集前景像素 + 计算质心
  let cx = 0;
  let cy = 0;
  let fgCount = 0;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[rowOffset + x] < threshold) {
        cx += x;
        cy += y;
        fgCount++;
      }
    }
  }

  if (fgCount < 20) return 0;

  cx /= fgCount;
  cy /= fgCount;

  // 中心矩
  let m11 = 0;
  let m20 = 0;
  let m02 = 0;

  for (let y = 0; y < h; y++) {
    const rowOffset = y * w;
    for (let x = 0; x < w; x++) {
      if (gray[rowOffset + x] < threshold) {
        const dx = x - cx;
        const dy = y - cy;
        m11 += dx * dy;
        m20 += dx * dx;
        m02 += dy * dy;
      }
    }
  }

  m11 /= fgCount;
  m20 /= fgCount;
  m02 /= fgCount;

  const numerator = 2 * m11;
  const denominator = m20 - m02;

  // 各向同性 → 无法确定方向
  if (Math.abs(numerator) < 1e-10 && Math.abs(denominator) < 1e-10) {
    return 0;
  }

  // denominator ≈ 0 → angle ≈ ±45°
  if (Math.abs(denominator) < 1e-10) {
    return numerator > 0 ? 45 : -45;
  }

  const angleRad = 0.5 * Math.atan2(numerator, denominator);
  let angleDeg = (angleRad * 180) / Math.PI;

  // 规范化
  if (angleDeg > 45) angleDeg -= 90;
  if (angleDeg < -45) angleDeg += 90;

  // 方差太小 → 方向不可靠
  const totalVariance = m20 + m02;
  if (totalVariance < 5.0) return 0;

  if (Math.abs(angleDeg) < 0.5) return 0;

  return clampAngle(angleDeg);
}

// ────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────

function clampAngle(angle: number): number {
  const clamped = Math.max(-45, Math.min(45, angle));
  return Math.round(clamped * 10) / 10;
}

/**
 * Direction Confidence（Sprint-50 Task-005）
 *
 * 把"方向可信度"与"线性拟合可信度（R²）"解耦。
 *
 * 问题：多行文本（如 Doctor Footer 的三条平行线）R² 天然低（质心不在一条直线），
 * 但方向（倾斜角）非常稳定。把 R² 当作方向可信度会误杀正确检测。
 *
 * 算法：
 *   1. 按 y 聚类质心成「行」（文本行）
 *   2. 每行取最左/最右质心，计算该行方向角
 *   3. 多行的方向角一致性 → directionConfidence（标准差小则高）
 *
 * 对平行多行文本：各行方向一致 → directionConfidence 高（尽管 R² 低）。
 * 对随机噪声：各行方向随机 → directionConfidence 低。
 */
function computeDirectionConfidence(centroids: Point[]): number {
  if (centroids.length < 3) return 0;

  // 1. 按 y 排序，按间隙聚类成行
  const sorted = [...centroids].sort((a, b) => a.y - b.y);
  // 间隙阈值：用质心 y 的典型间距（中位相邻差），放大若干倍作为"分行"判据
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].y - sorted[i - 1].y);
  gaps.sort((a, b) => a - b);
  const medianGap = gaps[Math.floor(gaps.length / 2)] ?? 0;
  const rowGap = Math.max(medianGap * 3, 3);

  const rows: Point[][] = [];
  let cur: Point[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].y - sorted[i - 1].y > rowGap) {
      rows.push(cur);
      cur = [];
    }
    cur.push(sorted[i]);
  }
  rows.push(cur);

  // 2. 每行方向角：最左 → 最右质心连线
  const rowAngles: number[] = [];
  for (const row of rows) {
    if (row.length < 2) continue;
    let minX = row[0], maxX = row[0];
    for (const p of row) {
      if (p.x < minX.x) minX = p;
      if (p.x > maxX.x) maxX = p;
    }
    if (maxX.x - minX.x < 2) continue; // 行内 x 范围过小，跳过
    rowAngles.push((Math.atan2(maxX.y - minX.y, maxX.x - minX.x) * 180) / Math.PI);
  }

  // 3. 方向一致性
  if (rowAngles.length < 2) {
    // 单行：方向可信度较低（无法交叉验证），回退到一个保守值
    return 0;
  }
  const meanAngle = rowAngles.reduce((s, a) => s + a, 0) / rowAngles.length;
  const variance = rowAngles.reduce((s, a) => s + (a - meanAngle) ** 2, 0) / rowAngles.length;
  const stdDev = Math.sqrt(variance);
  // 标准差 0° → 1.0；10° → 0；线性衰减
  const conf = 1 - stdDev / 10;
  return Math.max(0, Math.min(1, Math.round(conf * 100) / 100));
}

function zeroResult(method: "baseline" | "pca"): SignatureGeometryResult {
  return {
    angle: 0,
    transform: [1, 0, 0, 1, 0, 0] as TransformMatrix,
    method,
    confidence: 0,
    componentCount: 0,
  };
}

/**
 * Otsu 自适应阈值算法。
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

// ────────────────────────────────────────────────────────────────
// Sprint 15: 页面级几何分析（debug + 未来渲染优化）
// ────────────────────────────────────────────────────────────────

/**
 * 分析页面内所有 block 的几何变换信息。
 *
 * 遍历 EditablePage.blocks，对有旋转的 block 计算 baseline + transform，
 * 输出 PagedGeometryInfo 供 debug 使用。
 *
 * 不修改任何数据（纯读取），可直接调用。
 *
 * @param page 可编辑页面
 * @returns PagedGeometryInfo（含所有有旋转的 block 的 TextGeometry）
 */
export function analyzeSignatureGeometryForPage(
  page: EditablePage
): PagedGeometryInfo {
  const blocks: PagedGeometryInfo["blocks"] = [];

  for (const block of page.blocks) {
    if (block.type !== "text") continue;

    const transform = extractTransform(block);
    if (!hasRotation(transform)) continue;

    const baseline = computeBaselineFromTransform(block.bbox, transform);

    // 从 transform 提取 angle
    const angleRounded =
      Math.round(
        (Math.atan2(transform[1], transform[0]) * 180) / Math.PI * 10
      ) / 10;

    const geometry: TextGeometry = {
      baseline: {
        x1: baseline.x1,
        y1: baseline.y1,
        x2: baseline.x2,
        y2: baseline.y2,
      },
      transform,
      angle: angleRounded,
      // confidence: 当前从 glyph 反推（无原始 OCR confidence），
      // 实际情况中 confidence 已嵌入在 angle 的精度中。
      confidence: Math.abs(angleRounded) > 0.5 ? 0.7 : 0.5,
    };

    blocks.push({
      blockId: block.id,
      bbox: {
        x: block.bbox.x,
        y: block.bbox.y,
        width: block.bbox.width,
        height: block.bbox.height,
      },
      geometry,
    });
  }

  return {
    pageIndex: page.index,
    pageWidth: page.width,
    pageHeight: page.height,
    blocks,
  };
}
