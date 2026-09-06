/**
 * TextGeometry Model — Sprint 15
 *
 * 为签名区域等 rotated text block 提供基线几何信息。
 * 渲染管线使用 baseline + transform 将可编辑文字精确覆盖在原图文字上方。
 *
 * 用途：
 *   - SignatureGeometryAnalyzer 输出 TextGeometry 供 debug + 未来渲染优化
 *   - window.__signatureGeometryDebug 暴露完整的页面级几何分析结果
 */

import type { BBox, EditableBlock, TransformMatrix } from "./types";
import { IDENTITY_TRANSFORM } from "./types";

/**
 * TextGeometry — 文字几何描述
 *
 * @property baseline - 基线起止点（CSS 显示坐标），用于精确定位文字行
 * @property transform - CSS 归一化旋转矩阵 [a,b,c,d,e,f]，缩放=1，平移归零
 * @property angle - 旋转角度（度，顺时针为正），从 transform 提取方便调试
 * @property confidence - 几何检测置信度（0-1），OCR provider angle > image analysis > 0
 */
export interface TextGeometry {
  /** 基线起止点（CSS 显示坐标） */
  baseline: SimpleBaseline;
  /** CSS 归一化 transform matrix [a,b,c,d,e,f] */
  transform: TransformMatrix;
  /** 旋转角度（度，顺时针为正） */
  angle: number;
  /** 检测置信度（0-1） */
  confidence: number;
}

/**
 * SimpleBaseline — 文字基线
 *
 * @property x1, y1 - 基线起点（左端，CSS 显示坐标）
 * @property x2, y2 - 基线终点（右端，CSS 显示坐标）
 *
 * 对于水平文字（angle=0）：(x1, y1) = bbox 左下，(x2, y2) = bbox 右下
 * 对于旋转文字：绕 bbox 中心旋转后的底线
 */
export interface SimpleBaseline {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

// ────────────────────────────────────────────────────────────────
// PagedGeometryInfo
// ────────────────────────────────────────────────────────────────

/**
 * BlockGeometryInfo — 单个 block 的几何信息
 */
export interface BlockGeometryInfo {
  /** block ID */
  blockId: string;
  /** block 包围盒（CSS 显示坐标） */
  bbox: BBox;
  /** 文字几何（含 baseline + transform） */
  geometry: TextGeometry;
}

/**
 * PagedGeometryInfo — 页面级几何分析结果
 *
 * window.__signatureGeometryDebug 的结构。
 */
export interface PagedGeometryInfo {
  /** 页码 */
  pageIndex: number;
  /** 页面尺寸（CSS px） */
  pageWidth: number;
  pageHeight: number;
  /** 所有需要旋转渲染的 block 的几何信息 */
  blocks: BlockGeometryInfo[];
}

// ────────────────────────────────────────────────────────────────
// 工厂函数
// ────────────────────────────────────────────────────────────────

/**
 * 从 EditableBlock 提取 transform matrix。
 *
 * 原则：所有 glyph 共享 block 的 transform（由 ocr.geometry 统一赋值）。
 * 取第一个 glyph 的 transform，无 glyph 或无 transform 则返回单位矩阵。
 */
export function extractTransform(block: EditableBlock): TransformMatrix {
  const glyph = block.lines[0]?.glyphs[0];
  return glyph?.transform ?? IDENTITY_TRANSFORM;
}

/**
 * 计算文字基线（CSS 显示坐标）。
 *
 * 基线 = bbox 底边绕 bbox 中心旋转 angle 度。
 * 对于 angle=0，基线 = (x, y+h) → (x+w, y+h)，即 bbox 底线。
 *
 * 使用 transform matrix [cos, sin, -sin, cos] 直接计算旋转后的端点，
 * 避免 trig 重复计算。
 *
 * @param bbox block 包围盒（CSS 显示坐标）
 * @param transform CSS 归一化 transform matrix（用于计算基线方向）
 * @returns 旋转后的基线起止点
 */
export function computeBaselineFromTransform(
  bbox: BBox,
  transform: TransformMatrix
): SimpleBaseline {
  const [cos, sin] = transform; // a=cos, b=sin
  const hw = bbox.width / 2;
  const hh = bbox.height / 2;
  const cx = bbox.x + hw;
  const cy = bbox.y + hh;

  // bbox 底边在局部坐标系（center-aligned）:
  //   left  point: (-hw, +hh)   [bottom-left]
  //   right point: (+hw, +hh)   [bottom-right]
  //
  // 旋转变换: newX = cos*x - sin*y, newY = sin*x + cos*y
  //
  // left:
  const lx = cos * (-hw) - sin * hh;
  const ly = sin * (-hw) + cos * hh;
  // right:
  const rx = cos * hw - sin * hh;
  const ry = sin * hw + cos * hh;

  return {
    x1: Math.round((cx + lx) * 10) / 10,
    y1: Math.round((cy + ly) * 10) / 10,
    x2: Math.round((cx + rx) * 10) / 10,
    y2: Math.round((cy + ry) * 10) / 10,
  };
}

/**
 * 快速判定 transform 是否非单位矩阵（即是否有旋转）。
 * 避免逐分量比较带来的精度问题。
 */
export function hasRotation(transform: TransformMatrix): boolean {
  const [a, b] = transform;
  // cos ≈ 0, sin ≈ 0 表示无旋转
  return Math.abs(b) > 0.001 || Math.abs(a - 1) > 0.001;
}
