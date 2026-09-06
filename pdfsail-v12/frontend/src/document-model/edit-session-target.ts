/**
 * EditSession target resolver（M5-IMPLEMENT-002B）
 *
 * 从 EditableDocument 解析一个 block 的编辑 target（稳定 identity：blockId + lineId + glyph range）。
 * 供 B 路径（TextEditOverlay）进入编辑时创建 EditSession 使用。
 *
 * 纯函数，可独立测试；避免把逻辑内联进脆弱的 PDFEditor 组件。
 */
import type { EditableDocument } from "./types";
import type { EditSessionTarget } from "./edit-session";

export interface ResolvedEditTarget {
  /** 首行的稳定 target（single-line） */
  readonly target: EditSessionTarget;
  /** block 所有行的 ranges（单行 length===1；多行 length>1 用于 Multi-line SAFE REJECT） */
  readonly ranges: ReadonlyArray<EditSessionTarget>;
  /** 首行文本 */
  readonly firstLineText: string;
  /** block 行数 */
  readonly lineCount: number;
}

/**
 * 解析 block 的编辑 target。
 * - block 不存在 / 无行 → 返回 null。
 * - 单行 block：target = 该行整行 range（commit 走 M4 precise-range，几何保真）。
 * - 多行 block：ranges.length>1（Multi-line，EditSession 创建时 SAFE REJECT，由调用方回退）。
 */
export function resolveEditTarget(
  doc: EditableDocument | null | undefined,
  blockId: string
): ResolvedEditTarget | null {
  if (!doc) return null;
  const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!block || block.lines.length === 0) return null;

  const ranges = block.lines.map((l) => ({
    blockId,
    lineId: l.id,
    startGlyphIndex: 0,
    endGlyphIndex: Math.max(0, l.glyphs.length - 1),
  }));

  const firstLine = block.lines[0];
  const firstLineText = firstLine.glyphs.map((g) => g.char).join("");

  return {
    target: ranges[0],
    ranges,
    firstLineText,
    lineCount: block.lines.length,
  };
}
