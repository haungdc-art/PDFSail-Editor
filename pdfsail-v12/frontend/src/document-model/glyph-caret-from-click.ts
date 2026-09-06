/**
 * glyph-caret-from-click.ts — M7.7-IMPLEMENT-001
 *
 * 把"点击位置"映射为 glyph 级光标（GlyphCaret）。纯函数、零副作用，可独立单测。
 *
 * 语义（与 GlyphCaret 一致）：
 *   - offset "before"：光标在 glyphIndex 字符左侧 → caret 字符偏移 = glyphIndex
 *   - offset "after" ：光标在 glyphIndex 字符右侧 → caret 字符偏移 = glyphIndex + 1
 *
 * 命中规则（点击 x ∈ [x, x+w] 区间）：
 *   - 落在字符左半 → { glyphIndex:i, offset:"before" }（如 HELLO|WORLD 在 W 左半）
 *   - 落在字符右半 → { glyphIndex:i, offset:"after"  }
 *   - 落在两字符间隙 → caret 属于左侧字符 → { glyphIndex:i, offset:"after" }
 *   - 行首左侧 / 行尾右侧 → 分别 before[0] / after[last]
 */
import type { GlyphCaret } from "./edit-session";
import type { DrawGlyphCommand } from "./render-command";

function widthOf(g: DrawGlyphCommand): number {
  return g.bbox?.width ?? g.width ?? 1;
}

/**
 * 由行的 glyph 命令与点击 x（Document Space，CSS 坐标）推导 GlyphCaret。
 * @param line 该行（blockId+lineId 已过滤）的 glyph 命令，顺序无关
 * @param screenX 点击横坐标（与 glyph.x 同一坐标空间）
 * @returns 永不返回 null；空行 → { glyphIndex:0, offset:"before" }（安全默认）
 */
export function glyphCaretFromClick(line: DrawGlyphCommand[], screenX: number): GlyphCaret {
  const lineId = line[0]?.lineId ?? "";
  const ordered = line.filter((g) => widthOf(g) > 0 || g.x !== undefined).slice().sort((a, b) => a.x - b.x);
  if (ordered.length === 0) {
    return { lineId, glyphIndex: 0, offset: "before", affinity: "forward" };
  }

  // 行首左侧
  if (screenX <= ordered[0].x) {
    return { lineId, glyphIndex: 0, offset: "before", affinity: "forward" };
  }
  // 行尾右侧
  const lastI = ordered.length - 1;
  if (screenX >= ordered[lastI].x + widthOf(ordered[lastI])) {
    return { lineId, glyphIndex: lastI, offset: "after", affinity: "forward" };
  }

  // 1) 直接命中某字符内部 → 按左/右半判定
  for (let i = 0; i < ordered.length; i++) {
    const g = ordered[i];
    const w = widthOf(g);
    if (screenX >= g.x && screenX < g.x + w) {
      return { lineId, glyphIndex: i, offset: screenX < g.x + w / 2 ? "before" : "after", affinity: "forward" };
    }
  }
  // 2) 落在两字符间隙 → caret 属于左侧字符（offset:"after"）
  for (let i = 0; i < ordered.length - 1; i++) {
    const g = ordered[i];
    const n = ordered[i + 1];
    const w = widthOf(g);
    if (screenX >= g.x + w && screenX < n.x) {
      return { lineId, glyphIndex: i, offset: "after", affinity: "forward" };
    }
  }
  // 安全兜底
  return { lineId, glyphIndex: 0, offset: "before", affinity: "forward" };
}

/** 由 GlyphCaret 推导 session.text 内 collapsed caret 的字符偏移（后插入点）。 */
export function caretCharOffsetOf(caret: GlyphCaret): number {
  return caret.offset === "after" ? caret.glyphIndex + 1 : caret.glyphIndex;
}