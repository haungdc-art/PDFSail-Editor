/**
 * EditTransformGeometry — 旋转/倾斜 glyph 的几何事实（M7.7-003）
 *
 * 统一 glyph 的「CSS 归一化 transform + bbox」→ 世界坐标（CSS px）的映射。
 *
 * 渲染约定（与 GlyphRenderer 一致）：
 *   每个 glyph：`left: bbox.x, top: bbox.y` + `transform: matrix(a,b,c,d,0,0)` + `transform-origin: 0 0`。
 *   因此 glyph 局部坐标 (px, py) → 世界坐标：
 *       worldX = bbox.x + a·px + c·py
 *       worldY = bbox.y + b·px + d·py
 *
 * 消费方（M7.7-003 四链路统一）：
 *   - CaretLayer        （caret 竖线位置/旋转）
 *   - SelectionLayer    （selection 四边形高亮，而非轴对齐矩形）
 *   - Input Surface     （textarea 跟随文字方向）
 *   - Commit placement  （编辑后 placement 保持原始 matrix —— 本层不参与，由 Native Export 保证）
 *
 * 纯函数，零副作用，可独立单测。不依赖 DOM / Canvas。
 */
import type { BBox, TransformMatrix, EditableGlyph } from "./types";

export interface Point {
  x: number;
  y: number;
}

/**
 * GlyphQuad — glyph 的旋转四边形（世界 CSS 坐标）。
 * p1=TL, p2=TR, p3=BR, p4=BL（按 glyph 局部坐标映射后的世界点）。
 */
export interface GlyphQuad {
  p1: Point;
  p2: Point;
  p3: Point;
  p4: Point;
}

/** 单位矩阵（无旋转） */
const IDENTITY: TransformMatrix = [1, 0, 0, 1, 0, 0];

/**
 * 把 glyph 局部坐标 (px, py)（相对 bbox 左上角）映射为世界 CSS 坐标。
 * transform 缺失/单位矩阵 → 返回 (bbox.x + px, bbox.y + py)。
 */
export function glyphLocalToWorld(
  bbox: BBox,
  transform: TransformMatrix | undefined,
  px: number,
  py: number
): Point {
  const [a, b, c, d] = transform ?? IDENTITY;
  return {
    x: bbox.x + a * px + c * py,
    y: bbox.y + b * px + d * py,
  };
}

/**
 * 单个 glyph 的四边形（4 角点，世界 CSS 坐标）。
 */
export function glyphQuad(glyph: Pick<EditableGlyph, "bbox" | "transform">): GlyphQuad {
  const b = glyph.bbox;
  return {
    p1: glyphLocalToWorld(b, glyph.transform, 0, 0), // TL
    p2: glyphLocalToWorld(b, glyph.transform, b.width, 0), // TR
    p3: glyphLocalToWorld(b, glyph.transform, b.width, b.height), // BR
    p4: glyphLocalToWorld(b, glyph.transform, 0, b.height), // BL
  };
}

/**
 * 四边形 → 轴对齐包围盒（世界 CSS 坐标）。用于 clip-path 渲染容器定位。
 */
export function quadBounds(q: GlyphQuad): BBox {
  const xs = [q.p1.x, q.p2.x, q.p3.x, q.p4.x];
  const ys = [q.p1.y, q.p2.y, q.p3.y, q.p4.y];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * selection 区间 [startIdx, endIdx) 的联合四边形（世界 CSS 坐标）。
 *
 * 语义：从首 glyph 左上 → 末 glyph 右下，沿该行 transform 方向的平行四边形。
 *   - 行内 glyph 共享同一 transform（pdf-native-adapter 按 text item 统一赋值）→ 用首 glyph transform。
 *   - 高度：取区间内 glyph 的垂直并集（top..bottom）。
 *   - 横向文本（单位矩阵）→ 退化为普通矩形（与 M7.7-002 行为一致）。
 *
 * 找不到有效区间 → 返回 null。
 */
export function selectionQuad(
  glyphs: ReadonlyArray<Pick<EditableGlyph, "bbox" | "transform">>,
  startIdx: number,
  endIdx: number
): GlyphQuad | null {
  if (!glyphs || glyphs.length === 0 || startIdx >= endIdx) return null;
  const lo = Math.max(0, startIdx);
  const hi = Math.min(endIdx, glyphs.length);
  if (lo >= hi) return null;

  const first = glyphs[lo];
  const last = glyphs[hi - 1];
  // 垂直并集（处理 glyph 高度差异）
  let top = Infinity;
  let bottom = -Infinity;
  for (let i = lo; i < hi; i++) {
    const g = glyphs[i];
    top = Math.min(top, g.bbox.y);
    bottom = Math.max(bottom, g.bbox.y + g.bbox.height);
  }
  // 沿 text 方向宽度 = 末 glyph 右缘 - 首 glyph 左缘（transform 方向已由矩阵承载）
  const widthLocal = last.bbox.x + last.bbox.width - first.bbox.x;
  const heightLocal = bottom - top;
  // 局部坐标系：以 first.bbox 左上为原点；垂直偏移 = top - first.bbox.y
  const yOff = top - first.bbox.y;
  const t = first.transform;
  return {
    p1: glyphLocalToWorld(first.bbox, t, 0, yOff),
    p2: glyphLocalToWorld(first.bbox, t, widthLocal, yOff),
    p3: glyphLocalToWorld(first.bbox, t, widthLocal, yOff + heightLocal),
    p4: glyphLocalToWorld(first.bbox, t, 0, yOff + heightLocal),
  };
}

/**
 * 从 CSS 归一化 transform 提取旋转角度（deg）。
 * 语义：文本 x 轴方向角（CSS 坐标，Y 向下 → 正角顺时针）。无旋转/单位矩阵 → 0。
 */
export function rotationDegFromTransform(t?: TransformMatrix): number {
  if (!t) return 0;
  const a = t[0] ?? 1;
  const b = t[1] ?? 0;
  if (Math.abs(a - 1) < 1e-6 && Math.abs(b) < 1e-6) return 0;
  return (Math.atan2(b, a) * 180) / Math.PI;
}

/**
 * CSS `clip-path: polygon(...)` 字符串（世界 CSS 坐标，px）。
 * 供 SelectionHighlightLayer 渲染旋转四边形高亮。
 */
export function quadClipPath(q: GlyphQuad): string {
  return `polygon(${q.p1.x}px ${q.p1.y}px, ${q.p2.x}px ${q.p2.y}px, ${q.p3.x}px ${q.p3.y}px, ${q.p4.x}px ${q.p4.y}px)`;
}
