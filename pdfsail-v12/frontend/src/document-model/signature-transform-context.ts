/**
 * Sprint34.15: Signature Transform Context (Unification)
 *
 * 统一 Editor 与 Export 对签名文字旋转的处理。
 *
 * 背景：
 *   Editor 曾用 Signature Region Box Center 作为 rotation pivot，
 *   Export 用 Text Block BoundingBox Center 作为 pivot。
 *   同一个签名 block 在两个 transform space 产生不同旋转 → 长文本露边。
 *
 * 解决：
 *   统一 pivot = 每个 EditableBlock 自身 originalBounds 的 center。
 *   SignatureRegion 是组合区域（不是真实文字对象），不应作为 pivot 依据。
 *
 * SignatureTransformContext 同时被 Editor 与 Export 消费，
 * 是签名旋转的唯一依据。
 */

import type { BBox } from "./types";

/** 单个签名 block 的几何信息 */
export interface SignatureTransformBlock {
  id: string;
  text: string;
  originalBounds: BBox;
}

/**
 * Sprint34.19: Block 级文本几何。
 * rotation 从该 block 自身 glyph 计算（而非 region 级统一角度）。
 */
export interface SignatureTextGeometry {
  /** 该 block bbox 中心（CSS 文档坐标） */
  center: { x: number; y: number };
  /** 该 block 宽度（CSS） */
  width: number;
  /** 该 block 高度（CSS） */
  height: number;
  /** block 级旋转（CSS 度，顺时针为正），由 glyph 线性回归得到 */
  rotation: number;
}

/** 计算一个 block 的旋转（per-block 线性回归，方法同 detectRegionRotation，但不跨 block）。 */
export function calculateBlockRotationFromGlyphs(
  block: {
    lines: Array<{ glyphs: Array<{ bbox: BBox }> }>;
  },
): { rotation: number; confidence: number } {
  const points: Array<{ x: number; y: number }> = [];
  for (const line of block.lines) {
    for (const g of line.glyphs) {
      points.push({
        x: g.bbox.x + g.bbox.width / 2,
        y: g.bbox.y + g.bbox.height / 2,
      });
    }
  }
  if (points.length < 3) return { rotation: 0, confidence: 0 };

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = points.reduce((s, p) => s + p.x * p.x, 0);
  const denominator = n * sumX2 - sumX * sumX;
  if (Math.abs(denominator) < 1e-9) return { rotation: 0, confidence: 0 };

  const slope = (n * sumXY - sumX * sumY) / denominator;
  // 与 detectRegionRotation 一致：PDF→CSS 翻转后 slope 反转，angle 取负。
  const angleDeg = (-Math.atan(slope)) * (180 / Math.PI);

  const meanY = sumY / n;
  const ssRes = points.reduce((s, p) => {
    const yPred = slope * p.x + (meanY - slope * (sumX / n));
    return s + (p.y - yPred) ** 2;
  }, 0);
  const ssTot = points.reduce((s, p) => s + (p.y - meanY) ** 2, 0);
  const confidence = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { rotation: angleDeg, confidence };
}

/** 计算一个 block 的 SignatureTextGeometry（center / size / rotation）。 */
export function calculateSignatureTextGeometry(
  block: {
    bbox: BBox;
    lines: Array<{ glyphs: Array<{ bbox: BBox }> }>;
  },
): SignatureTextGeometry {
  const center = pivotOfBounds(block.bbox);
  const { rotation } = calculateBlockRotationFromGlyphs(block);
  return {
    center,
    width: block.bbox.width,
    height: block.bbox.height,
    rotation,
  };
}

/** 一个签名 block 的完整变换上下文（pivot = 该 block originalBounds center） */
export interface SignatureTransformContext {
  /** 所属签名区域 id（layout tree 的 signature 节点 id） */
  regionId: string;
  /** CSS 旋转角度（度，顺时针为正） */
  rotation: number;
  /** 旋转 pivot（页面 CSS 坐标）= originalBounds center */
  pivot: { x: number; y: number };
  /** 该 block 的几何信息 */
  blocks: SignatureTransformBlock[];
}

/**
 * 计算 bbox center（统一 pivot 规则）。
 *
 * 所有旋转（mask / Editor glyph / Export text）都以这里为 pivot，
 * 保证各层坐标空间一致。
 */
export function pivotOfBounds(bounds: BBox): { x: number; y: number } {
  return {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height / 2,
  };
}

/**
 * 构建单个 block 的 SignatureTransformContext。
 *
 * Sprint34.25（根本修复）：
 * rotation 统一来自 region 级检测（detectRegionRotation 对整个签名区域回归）。
 * OCR 单行 glyph 无法可靠测出真实倾斜（per-block 回归对水平行返回 0°），
 * 而签名区域是整体倾斜的，故用 region 级角度统一应用到该区域所有行。
 * 不再用 per-block glyph 回归覆盖（不可靠，会丢失真实倾斜）。
 *
 * @param blockId block id
 * @param regionId 签名区域 id
 * @param rotation region 级旋转（CSS 度，顺时针为正）
 * @param originalBounds block 原文区域（CSS）
 * @param text block 文本
 */
export function buildSignatureTransformContext(
  blockId: string,
  regionId: string,
  rotation: number,
  originalBounds: BBox,
  _block?: unknown,
  text = "",
): SignatureTransformContext {
  const pivot = pivotOfBounds(originalBounds);
  return {
    regionId,
    rotation,
    pivot,
    blocks: [{ id: blockId, text, originalBounds }],
  };
}
