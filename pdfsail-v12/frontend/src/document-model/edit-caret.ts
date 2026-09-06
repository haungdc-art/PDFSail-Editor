/**
 * EditCaret — Glyph Caret 几何解析（M5-IMPLEMENT-003B + M7.7-003）
 *
 * 把 GlyphCaret（glyph 级光标 Truth）解析为屏幕上竖线（caret）的 CSS 几何位置。
 *
 * 来源：glyph.bbox（Document Model 的 CSS 坐标），**不是** textarea.getBoundingClientRect()。
 * M7.7-003：旋转角度统一来自 edit-transform-geometry（single source，与 selection/input 同源），
 *   支持旋转/倾斜/缩放矩阵（atan2(b,a) 提取文本 x 轴方向角）。
 *
 * 职责：
 *   - glyphCaret → { x, y, height, lineId, rotation }（caret 竖线位置）
 *   - offset "before" → 锚点 = 字符左缘（局部 x=0）经 glyph.transform 映射的世界位置
 *   - offset "after"  → 锚点 = 字符右缘（局部 x=bbox.width）经 glyph.transform 映射的世界位置
 *
 * 纯函数，可独立测试；不依赖 DOM / textarea。
 */
import type { EditableDocument, EditableLine } from "./types";
import type { GlyphCaret } from "./edit-session";
import { rotationDegFromTransform, glyphLocalToWorld } from "./edit-transform-geometry";

export interface CaretPosition {
  readonly x: number;
  readonly y: number;
  readonly height: number;
  readonly lineId: string;
  /** M7.7-002/003: 旋转角度（deg，来自 glyph.transform 矩阵）。0 = 水平文本。 */
  readonly rotation: number;
}

/**
 * 估算 cap-height（大写字母高度）——caret 竖线的高度。
 * 优先使用真实 metric：
 *   - line.typography?.ascent（真实 ascent，CSS px）
 *   - glyph.metrics.ascent（PDF /FontDescriptor /Ascent，**1/1000 em**）
 *     → ÷1000 得 em 比例 → × fontSize（CSS px）→ cap-height
 *   - fallback：fontSize × 0.7（常规 cap-height / em 比例）
 */
function estimateCapHeight(
  line: EditableLine | undefined,
  glyphMetrics: { ascent?: number; fontSize?: number } | undefined,
  fontSize: number
): number {
  if (line?.typography?.ascent) return line.typography.ascent;
  // M7.7-VERIFY-007：metrics.ascent 单位是 1/1000 em（PDF /FontDescriptor /Ascent，如 Arial=905），
  //   非 CSS px。此前直接 ascent×0.9 → 把 905 当 905px → caret 814px 高、被推到页面外。
  if (glyphMetrics?.ascent) return (glyphMetrics.ascent / 1000) * fontSize;
  return fontSize * 0.7;
}

/**
 * 解析 glyph caret 的几何位置（M7.7-002: Adobe 级 caret 外观）。
 * 关键改进：caret 高度 = cap-height（而非整行 bbox.height），y 落 baseline。
 *
 * 坐标系：CSS 显示坐标（Y 向下）。
 *   - baseline 存在 → y = baseline - capHeight（竖线顶部），height = capHeight
 *   - baseline 缺失 → y = bbox.y + bbox.height - capHeight（从行底往上推）
 *   - offset "after" → x = bbox.x + bbox.width
 *
 * 找不到 line/glyph → 返回 null（无 caret 可显示）。
 */
export function resolveCaretPosition(
  doc: EditableDocument | null | undefined,
  caret: GlyphCaret | undefined
): CaretPosition | null {
  if (!doc || !caret) return null;

  const lines = doc.pages.flatMap((p) => p.blocks).flatMap((b) => b.lines);
  const line = lines.find((l) => l.id === caret.lineId);
  const glyph = line?.glyphs?.[caret.glyphIndex];
  if (!glyph || !line) return null;

  const bbox = glyph.bbox;
  const style = line.style;
  const fontSize = style?.fontSize ?? Math.max(bbox.height, 8);
  const capHeight = estimateCapHeight(line, glyph.metrics, fontSize);
  const glyphBaseline = glyph.baseline ?? line.baseline;

  // M7.7-003: caret 是文字局部坐标下的垂直段。
  //   局部 x：before=0（字符左侧）/ after=bbox.width（字符右侧）
  //   局部 y：pyTop=baseline-capHeight（竖线顶）.. pyBottom=baseline（竖线底），相对 bbox 左上
  const px = caret.offset === "after" ? bbox.width : 0;
  const pyTop =
    glyphBaseline !== undefined
      ? glyphBaseline - capHeight - bbox.y
      : bbox.height - capHeight;
  // 用 glyph.transform 把局部锚点映射到世界坐标 → 旋转/倾斜文本 caret 落在真实文字边缘
  // （旋转文本的 "after" 世界 x = bbox.x + a·width + c·pyTop，而非轴对齐 bbox.x + bbox.width）
  const top = glyphLocalToWorld(bbox, glyph.transform, px, pyTop);
  return {
    x: top.x,
    y: top.y,
    // 局部 cap-height 长度；CaretLayer 以 rotate(rotation) 绕锚点渲染 → 视觉上沿文字法线方向
    height: Math.max(capHeight, 2),
    lineId: caret.lineId,
    // M7.7-002: 旋转文本 → caret 随 glyph 旋转（垂直文本轴）
    rotation: rotationDegFromTransform(glyph.transform),
  };
}
