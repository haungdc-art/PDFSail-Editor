/**
 * Line Split Operation — M5-IMPLEMENT-004D（ADR-051）
 *
 * Identity-preserving line split：
 *   把一行 glyph 在 splitIndex 处切成两段：
 *     - 前半段保持原 line 对象（原 id + 原 glyph 同对象引用，identity 保留）
 *     - 后半段移入新 line（新 id，glyph 同对象引用，仅 bbox.y 平移到新行基线）
 *   glyph 不重建（originalChar/originalBBox/styleRef/transform 全部保留）。
 *
 * 返回迁移映射（Document operation owns identity migration）：
 *   - glyphMigration:  每个 glyph 的新 lineId（供 selection/caret 重定位）
 *   - caretMapping:    原 caret（lineId, glyphIndex）迁移（前半保持原行，后半映射到新行）
 *   - selectionMapping: 原 range [start,end] 拆成跨行 ranges
 *
 * 不做（004D 边界）：自动 overflow trigger / font resize / tracking compression /
 * full reflow / page expansion。
 */
import type { EditableLine, EditableGlyph, BBox } from "./types";

export interface LineSplitOptions {
  /** 新行（后半段）的 blockId，用于生成新 line id */
  blockId: string;
  /** 新行的 y（后半段 bbox.y / baseline） */
  newLineY: number;
  /** 新行的 baseline（可选，用于更新后半段 baseline） */
  newBaseline?: number;
  /** 新行的 id（可选；默认 `${blockId}_L2`）。M5-004E reflow 多次 split 时需显式指定。 */
  newLineId?: string;
}

export interface GlyphMigrationEntry {
  glyphIndex: number;
  newLineId: string;
}

export interface CaretMapping {
  fromLineId: string;
  fromGlyphIndex: number;
  toLineId: string;
  toGlyphIndex: number;
}

export interface SelectionRangeMapping {
  fromLineId: string;
  fromStart: number;
  fromEnd: number;
  /** 拆分后：可能跨两行（最多两个 range） */
  to: Array<{ lineId: string; startGlyphIndex: number; endGlyphIndex: number }>;
}

export interface LineSplitResult {
  /** 拆分后的两行：lines[0] = 前半（原 id），lines[1] = 后半（新 id） */
  lines: [EditableLine, EditableLine];
  /** glyph 迁移：原行 index → 新 lineId */
  glyphMigration: GlyphMigrationEntry[];
  /** caret 迁移映射 */
  caretMapping: CaretMapping | null;
  /** selection range 迁移 */
  selectionMapping: SelectionRangeMapping | null;
}

/**
 * Identity-preserving split。
 * @param line     原行（将被拆成两半，返回新对象；原 line 不修改）
 * @param splitIndex 前半保留 [0, splitIndex-1]，后半 [splitIndex, ...]
 * @param options  新行 id/geometry
 * @param caret    当前 glyphCaret（可选，用于生成 caretMapping）
 * @param selection 当前 selection range（可选，用于生成 selectionMapping）
 */
export function splitLine(
  line: EditableLine,
  splitIndex: number,
  options: LineSplitOptions,
  caret?: { glyphIndex: number },
  selection?: { start: number; end: number }
): LineSplitResult {
  const glyphs = line.glyphs;
  const clamped = Math.max(0, Math.min(splitIndex, glyphs.length));
  const prefix = glyphs.slice(0, clamped);
  const suffix = glyphs.slice(clamped);

  // 新行 id：默认 ${blockId}_L2；M5-004E 多次 split 时由调用方经 options.newLineId 显式指定（保证唯一）。
  const newLineId = options.newLineId ?? `${options.blockId}_L2`;

  // 前半：保持原 id + 原 bbox，glyph 同对象
  const lineA: EditableLine = { ...line, glyphs: prefix };

  // 后半：新 id，glyph 同对象（仅 bbox.y 平移到新行基线）
  const dy = options.newLineY - line.bbox.y;
  const shiftedSuffix: EditableGlyph[] = suffix.map((g) => ({
    ...g,
    bbox: { ...g.bbox, y: g.bbox.y + dy },
  }));
  const lastA = prefix.length > 0 ? prefix[prefix.length - 1] : null;
  const lineB: EditableLine = {
    ...line,
    id: newLineId,
    bbox: {
      ...line.bbox,
      y: options.newLineY,
      height: line.bbox.height,
    } as BBox,
    baseline: options.newBaseline ?? options.newLineY,
    glyphs: shiftedSuffix,
  };
  void lastA; // 预留：后续可据此校正 lineA.width

  // glyphMigration
  const glyphMigration: GlyphMigrationEntry[] = [];
  for (let i = 0; i < glyphs.length; i++) {
    glyphMigration.push({ glyphIndex: i, newLineId: i < clamped ? line.id : newLineId });
  }

  // caretMapping：caret 在前半保持原行；后半映射到新行
  let caretMapping: CaretMapping | null = null;
  if (caret) {
    if (caret.glyphIndex < clamped) {
      caretMapping = {
        fromLineId: line.id,
        fromGlyphIndex: caret.glyphIndex,
        toLineId: line.id,
        toGlyphIndex: caret.glyphIndex,
      };
    } else {
      caretMapping = {
        fromLineId: line.id,
        fromGlyphIndex: caret.glyphIndex,
        toLineId: newLineId,
        toGlyphIndex: caret.glyphIndex - clamped,
      };
    }
  }

  // selectionMapping：[start,end] 拆成跨行 ranges
  let selectionMapping: SelectionRangeMapping | null = null;
  if (selection && selection.start <= selection.end) {
    const to: SelectionRangeMapping["to"] = [];
    if (selection.end < clamped) {
      to.push({ lineId: line.id, startGlyphIndex: selection.start, endGlyphIndex: selection.end });
    } else if (selection.start >= clamped) {
      to.push({ lineId: newLineId, startGlyphIndex: selection.start - clamped, endGlyphIndex: selection.end - clamped });
    } else {
      // 跨 split 点
      to.push({ lineId: line.id, startGlyphIndex: selection.start, endGlyphIndex: clamped - 1 });
      to.push({ lineId: newLineId, startGlyphIndex: 0, endGlyphIndex: selection.end - clamped });
    }
    selectionMapping = { fromLineId: line.id, fromStart: selection.start, fromEnd: selection.end, to };
  }

  return { lines: [lineA, lineB], glyphMigration, caretMapping, selectionMapping };
}
