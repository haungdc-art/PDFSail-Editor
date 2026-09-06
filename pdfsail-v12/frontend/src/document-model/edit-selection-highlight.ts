/**
 * EditSelectionHighlight — 编辑态 selection 视觉高亮（M7.7-002 + M7.7-003）
 *
 * 把 EditSession.caret 的 selection range（session.text 字符偏移）映射为
 * 原 PDF 上 glyph 的**旋转四边形**（M7.7-003：selection 随文字方向，而非轴对齐矩形）。
 *
 * 设计原则：
 *   - 不拥有视觉 truth：只输出几何 quad 列表，由 SelectionHighlightLayer 渲染。
 *   - 不改 Canvas：Canvas 仍是唯一视觉源，高亮是叠加层（Adobe 风格蓝色选区）。
 *   - 字符偏移 → glyph index：按 glyph 累积字符数单调映射。
 *       文本未修改（session.text === 原文）时 → 1:1 精确对应；
 *       文本已编辑（长度变化）→ 单调降级映射（有界近似，selection 高亮场景可接受）。
 *   - collapsed caret（start === end）→ 无高亮（返回 []）。
 *   - 行内 glyph 共享 transform → 整段 selection 用首 glyph transform 构建平行四边形
 *     （横向文本退化为矩形，与 002 行为一致；旋转文本沿文字方向）。
 *
 * 纯函数，可独立测试；不依赖 DOM / textarea。
 */
import type { EditableDocument } from "./types";
import type { EditSession } from "./edit-session";
import { selectionQuad, type GlyphQuad } from "./edit-transform-geometry";

/**
 * 字符偏移 → glyph index（单调映射）。
 * offset 落在 glyph 累积字符区间 [acc, acc+n) → 返回该 glyph index。
 * offset 超出总字符数 → 返回 glyphs.length（行尾边界）。
 */
export function charOffsetToGlyphIndex(
  offset: number,
  glyphs: ReadonlyArray<{ char?: string }>
): number {
  let acc = 0;
  for (let i = 0; i < glyphs.length; i++) {
    const n = Array.from(glyphs[i].char ?? "").length;
    if (offset < acc + n) return i;
    acc += n;
  }
  return glyphs.length;
}

/**
 * 计算编辑态 selection 的高亮四边形列表（M7.7-003：旋转四边形）。
 *   - collapsed（start === end）→ []
 *   - selection 区间 [start, end) → 覆盖的旋转四边形（整段一个 quad，沿文字方向）
 *   - 找不到 line / 无 glyph → []
 */
export function selectionHighlightQuads(
  doc: EditableDocument | null | undefined,
  session: EditSession | null | undefined
): GlyphQuad[] {
  if (!doc || !session) return [];
  if (session.status !== "active") return [];
  const { start, end } = session.caret;
  if (start >= end) return [];

  const lines = doc.pages.flatMap((p) => p.blocks).flatMap((b) => b.lines);
  const line = lines.find((l) => l.id === session.target.lineId);
  const glyphs = line?.glyphs;
  if (!glyphs || glyphs.length === 0) return [];

  const startIdx = charOffsetToGlyphIndex(start, glyphs);
  const endIdx = charOffsetToGlyphIndex(end, glyphs);
  if (startIdx >= endIdx) return [];

  const quad = selectionQuad(glyphs, startIdx, endIdx);
  return quad ? [quad] : [];
}

/** 兼容别名：返回四边形列表（旧名 boxes，语义已升级为 quad）。 */
export function selectionHighlightBoxes(
  doc: EditableDocument | null | undefined,
  session: EditSession | null | undefined
): GlyphQuad[] {
  return selectionHighlightQuads(doc, session);
}
