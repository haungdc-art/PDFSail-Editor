/**
 * export-impact-analysis.ts — M7.8-024 · MASK_IMPACT_REDRAW (design + read-only trace)
 *
 * 纯函数层：给定「被编辑行的完整原始墨迹遮罩」与「所有原始行的墨迹带」，
 * 计算哪些原始行被遮罩命中（= 需要被重绘恢复的受影响邻行）。
 *
 * 设计约束（用户冻结）：
 *   - 遮罩 = 被编辑行的「完整原始墨迹」，不允许为规避重叠而收缩 top/bottom / 加 Y offset。
 *   - 受影响判定必须基于「遮罩矩形 × 原始 glyph/line 墨迹矩形」的真实几何相交，
 *     不允许写死 N+1。
 *   - 本文件只做「分析」，不修改任何生产渲染/编辑逻辑，不触碰 CoordinateMapper /
 *     cssToPdf / baseline / font-size / lineHeight / EditableTextNode。
 *
 * 坐标系：所有 InkRect 均为 PDF pt（bottom-left origin, Y-up）。y0 < y1。
 */

/** PDF pt 矩形（Y-up, y0<y1） */
export interface InkRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 一行在 PDF pt 下的完整原始墨迹带 */
export interface LineInkBand {
  index: number;
  ink: InkRect;
}

export interface MaskImpactOptions {
  /**
   * 遮罩相对被编辑行墨迹的额外 x 边距（PDF pt）。默认 0。
   * 仅用于抗锯齿安全，不得用于规避垂直重叠。
   */
  xPad?: number;
  /**
   * 遮罩相对被编辑行墨迹的额外 y 边距（PDF pt）。默认 0。
   * 关键：遮罩必须覆盖被编辑行的完整原始墨迹（含 descender），
   * 因此这里禁止为负，也禁止用来收缩以规避与邻行的重叠。
   */
  yPad?: number;
}

export interface MaskImpactResult {
  editedLineIndex: number;
  /** 被编辑行的完整原始墨迹遮罩（PDF pt） */
  maskRect: InkRect;
  /** 除被编辑行外，原始墨迹与 maskRect 相交的行 index 列表（受影响邻行） */
  affectedLineIndices: number[];
}

/** 矩形相交（开区间，边接触不算相交） */
export function rectsIntersect(a: InkRect, b: InkRect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/**
 * Mask Impact Analysis（纯函数）。
 *
 * 1) 由被编辑行的完整原始墨迹构造 full original ink mask；
 * 2) 对每一行（≠ edited）测试其原始墨迹带是否与遮罩相交；
 * 3) 相交者即为「受影响行」——遮罩擦除了它们的一部分原始墨迹，
 *    导出时必须在遮罩之上用原 PDF glyph/style/font/baseline 重绘这些行。
 */
export function analyzeMaskImpact(
  lines: LineInkBand[],
  editedLineIndex: number,
  opts: MaskImpactOptions = {},
): MaskImpactResult {
  const edited = lines.find((l) => l.index === editedLineIndex);
  if (!edited) {
    throw new Error(
      `[M7.8-024] editedLineIndex ${editedLineIndex} not found in block (${lines.length} lines)`,
    );
  }
  const xpad = Math.max(0, opts.xPad ?? 0);
  const ypad = Math.max(0, opts.yPad ?? 0);
  const maskRect: InkRect = {
    x0: edited.ink.x0 - xpad,
    y0: edited.ink.y0 - ypad,
    x1: edited.ink.x1 + xpad,
    y1: edited.ink.y1 + ypad,
  };
  const affectedLineIndices = lines
    .filter((l) => l.index !== editedLineIndex)
    .filter((l) => rectsIntersect(maskRect, l.ink))
    .map((l) => l.index);
  return { editedLineIndex, maskRect, affectedLineIndices };
}

/**
 * 由 EditableBlock 构造每行的完整原始墨迹带（PDF pt）。
 * 墨迹 = 该行所有 glyph 的 originalBBox 并集（经注入的 cssToPdf 转换）。
 * 注意：originalBBox 已含 ascender/descender，因此并集即为「完整原始墨迹」，
 * 这正是 full original ink mask 的来源。
 *
 * @param toPdfInk 注入的坐标转换器（调用方传入真实 cssToPdf，本模块不直接依赖 CoordinateMapper）
 */
export function blockLineInkBands(
  block: {
    lines: Array<{
      id: string;
      glyphs: Array<{
        bbox: { x: number; y: number; width: number; height: number };
        originalBBox?: { x: number; y: number; width: number; height: number };
      }>;
    }>;
  },
  toPdfInk: (cssBox: { x: number; y: number; width: number; height: number }) => InkRect,
): LineInkBand[] {
  return block.lines.map((line, index) => {
    let ink: InkRect | null = null;
    for (const g of line.glyphs) {
      // Native PDF（preserve 模式）不填 originalBBox；此时 bbox 即原始位置，直接复用。
      const b = g.originalBBox ?? g.bbox;
      if (
        !b ||
        !Number.isFinite(b.x) ||
        !Number.isFinite(b.y) ||
        !Number.isFinite(b.width) ||
        !Number.isFinite(b.height)
      ) {
        continue;
      }
      const r = toPdfInk(b);
      if (!ink) {
        ink = { ...r };
      } else {
        ink = {
          x0: Math.min(ink.x0, r.x0),
          y0: Math.min(ink.y0, r.y0),
          x1: Math.max(ink.x1, r.x1),
          y1: Math.max(ink.y1, r.y1),
        };
      }
    }
    if (!ink) {
      // 无 glyph / 无 originalBBox：退化为零面积带（不参与相交）
      ink = { x0: 0, y0: 0, x1: 0, y1: 0 };
    }
    return { index, ink };
  });
}
