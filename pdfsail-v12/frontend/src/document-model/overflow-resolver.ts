/**
 * OverflowResolver — M5-IMPLEMENT-004E（ADR-050 / ADR-051）
 *
 * 第一版范围（PM 严格控制）：**overflow → line split**。
 *   输入超宽行 → breakTextIntoLinesByWords 计算断行点 → 逐段调用 splitLine（identity-preserving）。
 *   **不加 tracking / font scaling / page expansion / LayoutEngine reconstruct**。
 *
 * 链路：
 *   MutationResult.overflow=true
 *        ↓
 *   resolveOverflow(doc, blockId, lineId, maxWidth, caret?, selection?)
 *        ↓
 *   { document, reflowed, migration:{ glyphMigration, caretMapping, selectionMapping } }
 *
 * 原则：Document operation owns identity migration（ADR-051）。
 */
import type { EditableDocument, EditableLine } from "./types";
import { breakTextIntoLinesByWords } from "./text-measurement";
import { splitLine } from "./line-split";

export interface ReflowMigration {
  glyphMigration: Array<{ glyphIndex: number; newLineId: string }>;
  caretMapping: Array<{ fromLineId: string; fromGlyphIndex: number; toLineId: string; toGlyphIndex: number }>;
  selectionMapping: Array<{ fromLineId: string; fromStart: number; fromEnd: number; to: Array<{ lineId: string; startGlyphIndex: number; endGlyphIndex: number }> }>;
}

export interface OverflowResolveResult {
  document: EditableDocument;
  reflowed: boolean;
  migration: ReflowMigration;
}

/**
 * Overflow → line split（第一版，identity-preserving）。
 * 通过 breakTextIntoLinesByWords 找断行点，逐段 splitLine。
 * 仅当能拆出 >1 行时 reflow；否则返回 reflowed:false（保留 overflow，交策略决策）。
 */
export function resolveOverflow(
  doc: EditableDocument,
  blockId: string,
  lineId: string,
  maxWidth: number,
  caret?: { glyphIndex: number },
  selection?: { start: number; end: number }
): OverflowResolveResult {
  const emptyMigration: ReflowMigration = { glyphMigration: [], caretMapping: [], selectionMapping: [] };

  const pageIdx = doc.pages.findIndex((p) => p.blocks.some((b) => b.id === blockId));
  if (pageIdx < 0) return { document: doc, reflowed: false, migration: emptyMigration };
  const blockIdx = doc.pages[pageIdx].blocks.findIndex((b) => b.id === blockId);
  if (blockIdx < 0) return { document: doc, reflowed: false, migration: emptyMigration };
  const block = doc.pages[pageIdx].blocks[blockIdx];
  const lineIdx = block.lines.findIndex((l) => l.id === lineId);
  if (lineIdx < 0) return { document: doc, reflowed: false, migration: emptyMigration };
  const line = block.lines[lineIdx];
  const glyphs = line.glyphs;
  if (glyphs.length === 0) return { document: doc, reflowed: false, migration: emptyMigration };

  // 计算断行点（字符 index）
  const text = glyphs.map((g) => g.char).join("");
  const { lines: breakLines } = breakTextIntoLinesByWords(text, line.style, maxWidth);
  if (breakLines.length <= 1) {
    return { document: doc, reflowed: false, migration: emptyMigration };
  }

  // 断行点（新行起始，原始字符 index）
  const breaks = breakLines.slice(1).map((bl) => bl.start);
  const lineHeight = line.bbox.height || 12;

  // 逐段 splitLine（identity-preserving）
  const allLines: EditableLine[] = [];
  const migration: ReflowMigration = { glyphMigration: [], caretMapping: [], selectionMapping: [] };

  let current = line;
  let currentOffset = 0; // 当前行首相对原始 glyph 的偏移
  let currentY = line.bbox.y;
  let currentBaseline = line.baseline ?? line.bbox.y + line.bbox.height;

  for (let s = 0; s < breaks.length; s++) {
    const splitIndex = breaks[s] - currentOffset; // 相对当前行
    if (splitIndex <= 0 || splitIndex >= current.glyphs.length) break; // 防御

    // 每个新行分配唯一 id（b1_L2, b1_L3, ...）
    const newId = `${block.id}_L${lineIdx + 2 + s}`;
    const res = splitLine(
      current,
      splitIndex,
      { blockId, newLineY: currentY + lineHeight, newBaseline: currentBaseline + lineHeight, newLineId: newId },
      caret ? { glyphIndex: caret.glyphIndex - currentOffset } : undefined,
      selection ? { start: selection.start - currentOffset, end: selection.end - currentOffset } : undefined
    );

    // glyphMigration（相对原始 index）
    for (const g of res.glyphMigration) {
      migration.glyphMigration.push({ glyphIndex: g.glyphIndex + currentOffset, newLineId: g.newLineId });
    }

    allLines.push(res.lines[0]);
    current = res.lines[1];
    currentOffset = breaks[s];
    currentY += lineHeight;
    currentBaseline += lineHeight;
  }
  allLines.push(current); // 最后一段

  // caret / selection 迁移从 glyphMigration 权威推导（跨多 split 也正确）。
  // glyphMigration: 每个原始 index → newLineId。按原始 index 排序后，连续同 lineId 形成段。
  const byIndex = [...migration.glyphMigration].sort((a, b) => a.glyphIndex - b.glyphIndex);
  const lineOf = new Map<number, string>();
  for (const g of byIndex) lineOf.set(g.glyphIndex, g.newLineId);

  // caret：原始 index → 新 lineId + 新 index（相对新行）
  if (caret) {
    const cIdx = caret.glyphIndex;
    const newLine = lineOf.get(cIdx);
    if (newLine !== undefined) {
      // 新行内 index = 该行首个 glyph 的原始 index 之后的偏移
      const newStartRaw = byIndex.find((g) => g.newLineId === newLine)!.glyphIndex;
      migration.caretMapping.push({
        fromLineId: line.id,
        fromGlyphIndex: cIdx,
        toLineId: newLine,
        toGlyphIndex: cIdx - newStartRaw,
      });
    } else if (cIdx === glyphs.length) {
      // caret 在行尾：映射到最后一行末尾
      const lastLine = allLines[allLines.length - 1].id;
      migration.caretMapping.push({
        fromLineId: line.id,
        fromGlyphIndex: cIdx,
        toLineId: lastLine,
        toGlyphIndex: allLines[allLines.length - 1].glyphs.length,
      });
    }
  }

  // selection：[start,end] 按新 lineId 分段
  if (selection && selection.start <= selection.end) {
    const segs = new Map<string, { start: number; end: number }>();
    for (let i = selection.start; i <= selection.end; i++) {
      const nl = lineOf.get(i);
      if (nl === undefined) continue;
      const newStartRaw = byIndex.find((g) => g.newLineId === nl)!.glyphIndex;
      const rel = i - newStartRaw;
      const cur = segs.get(nl);
      if (cur) {
        if (rel < cur.start) cur.start = rel;
        if (rel > cur.end) cur.end = rel;
      } else {
        segs.set(nl, { start: rel, end: rel });
      }
    }
    migration.selectionMapping.push({
      fromLineId: line.id,
      fromStart: selection.start,
      fromEnd: selection.end,
      to: Array.from(segs.entries()).map(([lineId, r]) => ({
        lineId,
        startGlyphIndex: r.start,
        endGlyphIndex: r.end,
      })),
    });
  }

  // 把新 lines 写回 block（替换原单行）
  const newBlockLines = [...block.lines.slice(0, lineIdx), ...allLines, ...block.lines.slice(lineIdx + 1)];
  const newBlock = { ...block, lines: newBlockLines };
  const newPages = doc.pages.map((p, pi) =>
    pi === pageIdx
      ? { ...p, blocks: p.blocks.map((b, bi) => (bi === blockIdx ? newBlock : b)) }
      : p
  );

  return {
    document: { ...doc, pages: newPages },
    reflowed: true,
    migration,
  };
}
