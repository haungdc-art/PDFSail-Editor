/**
 * Sprint34.13: Signature Replacement Mask Geometry Unification
 *
 * 统一 Signature Replacement Mask 的几何计算。
 *
 * 背景：
 *   Sprint34.12 确认 Editor 与 Export 使用同一个 originalBounds，
 *   但签名文字 rotation 后实际渲染区域超过水平 mask 覆盖区域，
 *   导致原 PDF 文字边缘露出。
 *
 * 解决：
 *   用真实旋转矩形的 bounding box 作为 mask，
 *   而不是简单增加 padding。
 *
 * 坐标约定：
 *   - rotation 为 CSS 旋转角度（顺时针为正），与 EditableTransform.rotation / glyph transform 一致。
 *   - 输入输出均为 CSS 显示坐标（与 EditableBlock.originalBounds 同一空间）。
 */

import type { BBox } from "./types";

/** calculateReplacementMaskBounds 输入 */
export interface ReplacementMaskInput {
  /** 原始（未旋转）文字区域 bbox */
  originalBounds: BBox;
  /** CSS 旋转角度（度，顺时针为正） */
  rotation: number;
}

/**
 * 旋转一个点（绕 center 顺时针旋转）。
 */
function rotatePoint(
  px: number,
  py: number,
  centerX: number,
  centerY: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - centerX;
  const dy = py - centerY;
  return {
    x: centerX + dx * cos - dy * sin,
    y: centerY + dx * sin + dy * cos,
  };
}

/**
 * resolveVisualCoverageBounds — Geometry Domain，**唯一负责 Coverage**。
 *
 * 输入：OCR Detection Bounds（block.originalBounds，紧贴文字主体的检测框）。
 * 输出：真正应该被白色遮罩覆盖的 Visual Coverage Bounds。
 *
 * 背景（FID-010 Ghost）：
 *   `originalBounds` 语义其实是 "OCR Detection Box"，而非 "Original Pixel Coverage"。
 *   OCR region.bbox_2d 紧贴文字主体，不含衬线（serif）/倾斜/笔画延伸。
 *   底层扫描原图的实际文字像素通常更宽 → 直接用作 mask 会盖不住 → 原图透出（重影）。
 *
 * 职责边界：
 *   - Coverage 策略（padding / 像素前景检测 / vision 外扩）全部只改这里。
 *   - `calculateReplacementMaskBounds` 只负责 rotation 几何，不再混入 coverage 启发式。
 *   - Editor 与 Export 共用同一 Coverage 来源。
 *
 * V1（当前）：按字符高度比例的 padding（实现细节，非 API 语义）。
 * 未来可演进为：per-side padding、pixel dilation、vision coverage，均只改此函数。
 */
export function resolveVisualCoverageBounds(
  originalBounds: BBox,
  options?: {
    /** 水平 padding（默认按字符高度比例） */
    paddingX?: number;
    /** 垂直 padding（默认按字符高度比例） */
    paddingY?: number;
  },
): BBox {
  const { x, y, width, height } = originalBounds;
  const padX = options?.paddingX ?? height * 0.15;
  const padY = options?.paddingY ?? height * 0.15;
  return {
    x: x - padX,
    y: y - padY,
    width: width + padX * 2,
    height: height + padY * 2,
  };
}

/**
 * 计算 Signature Replacement Mask 的包围盒。
 *
 * 规则：
 *   1. 取原始矩形的四个角；
 *   2. 绕矩形中心旋转 rotation（CSS 顺时针为正）；
 *   3. 取旋转后四角的 minX/minY/maxX/maxY 作为 bounding box。
 *
 * 返回的 bbox 保证覆盖 rotation 后的完整文字区域。
 * 当 rotation=0 时返回与原 bbox 完全一致（不改变普通文字）。
 *
 * 注意：本函数**只负责 rotation 几何**。输入应为已扩展的
 * Visual Coverage Bounds（由 resolveVisualCoverageBounds 生成），
 * 不再在此处理 coverage padding。
 */
export function calculateReplacementMaskBounds(
  input: ReplacementMaskInput,
): BBox {
  const { originalBounds, rotation } = input;
  const { x, y, width, height } = originalBounds;

  // rotation=0（或极小）时直接返回原 bbox，避免浮点误差改变普通文字。
  if (Math.abs(rotation) < 0.01) {
    return { x, y, width, height };
  }

  // 原始矩形四个角
  const corners = [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];

  // 旋转中心 = 矩形中心
  const centerX = x + width / 2;
  const centerY = y + height / 2;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const c of corners) {
    const r = rotatePoint(c.x, c.y, centerX, centerY, rotation);
    if (r.x < minX) minX = r.x;
    if (r.y < minY) minY = r.y;
    if (r.x > maxX) maxX = r.x;
    if (r.y > maxY) maxY = r.y;
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}
