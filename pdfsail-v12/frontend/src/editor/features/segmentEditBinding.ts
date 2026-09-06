/**
 * segmentEditBinding — M7.8-040 Segment → EditableDocument 精确回写 binding 层。
 *
 * 纯 additive：只消费 mutation 能力（mutateLineText），不改动 mutation core /
 * provenance / export renderer。
 *
 * applySegmentEditsToDocument 用 Segment.source（glyph 区间，由 buildSegmentFromGlyphs
 * 在创建 Segment 时直接由 glyph run 算出）精确定位并 range-mutation，
 * 完全不依赖 indexOf(originalText)。
 */
import type { EditableDocument, EditableLine } from "../../document-model";
import { mutateLineText } from "../../document-model";
import type { Segment } from "../../editor-engine/types";

/**
 * 按 blockId + lineId 精确定位 EditableLine。
 *
 * Native 文档的 lineId 形如 `pdf_${blockId}_l${lineIdx}`；OCR/扫描注入文档的 lineId 是 UUID 形式
 * （如 `uuid_L0`），与 Segment.source.lineId 的约定不同。因此当精确 id 匹配失败时，回退到
 * 「同一 block 内按 lineIdx 定位」——这是跨 Producer 的语义对齐层（Source Mapping），而不是假设
 * 所有 Producer 共用同一套 id convention。见 M7.8-048。
 */
function findLineBySource(
  doc: EditableDocument,
  blockId: string,
  lineId: string,
  lineIdx?: number
): EditableLine | undefined {
  for (const page of doc.pages) {
    const block = page.blocks.find((b) => b.id === blockId);
    if (!block) continue;
    const exact = block.lines.find((l) => l.id === lineId);
    if (exact) return exact;
    // 回退：精确 id 不匹配（OCR 注入文档）时，按 block 内行序号定位。
    if (typeof lineIdx === "number" && lineIdx >= 0 && lineIdx < block.lines.length) {
      return block.lines[lineIdx];
    }
  }
  return undefined;
}

/**
 * 把 segment 层的文本编辑同步进 EditableDocument。
 *
 * M7.8-040：按 source 精确 range mutation。
 *   - 按 (blockId, lineId) 分组；组内按 startGlyphIndex 升序；
 *   - 逐段 mutateLineText(next, { start, end })，用 shift 校正前序编辑的长度偏移
 *     → 同一行多段同时编辑（含变长/变短）精确，互不串位。
 * 仅当 Segment 无 source（旧状态，生产路径均已带 source）才走下方 legacy indexOf 兜底。
 */
export function applySegmentEditsToDocument(
  doc: EditableDocument,
  segments: Segment[]
): EditableDocument {
  const edited = segments.filter((s) => s.text !== s.originalText);
  if (!edited.length) return doc;

  // 主路径：按 source 精确 range mutation（不依赖 indexOf）。
  const groups = new Map<string, Segment[]>();
  for (const seg of edited) {
    if (!seg.source) continue; // 无 source → 下方 legacy 兜底
    const key = `${seg.source.blockId}::${seg.source.lineId}`;
    const arr = groups.get(key);
    if (arr) arr.push(seg);
    else groups.set(key, [seg]);
  }

  let updated = doc;
  for (const [, segs] of groups) {
    segs.sort((a, b) => a.source!.startGlyphIndex - b.source!.startGlyphIndex);
    const { blockId, lineId, lineIdx } = segs[0].source!;
    let shift = 0; // 前序编辑导致当前行 glyph 数量的累计偏移
    for (const seg of segs) {
      const line = findLineBySource(updated, blockId, lineId, lineIdx);
      if (!line) break;
      const start = seg.source!.startGlyphIndex + shift;
      const end = seg.source!.endGlyphIndex + shift;
      const lineText = line.glyphs.map((g) => g.char).join("");
      const next = lineText.slice(0, start) + seg.text + lineText.slice(end + 1);
      // 用解析到的真实 editable line.id（而非 source.lineId）调用 mutateLineText，
      // 否则 OCR 注入文档的 UUID 形式 lineId 无法命中（M7.8-048）。
      updated = mutateLineText(updated, blockId, line.id, next, { start, end }).document;
      // M7.8-040R-3 Bug B：本行已被成功 mutation → 标记整行需 export（覆盖「删除/无变化」编辑
      // 因 glyph.modified 全 false 而丢失 export 触发的情况）。
      const editedLine = findLineBySource(updated, blockId, lineId, lineIdx);
      if (editedLine) editedLine.edited = true;
      shift += seg.text.length - (seg.source!.endGlyphIndex - seg.source!.startGlyphIndex + 1);
    }
  }

  // Legacy 兜底（仅旧 segment 无 source 时）：按原文本 indexOf 定位。生产路径已均带 source。
  const legacy = edited.filter((s) => !s.source);
  if (legacy.length) {
    for (const seg of legacy) {
      if (!seg.originalText) continue;
      const pageIdx = seg.lineId ? Number(String(seg.lineId).split("_")[1]) : NaN;
      const page = Number.isFinite(pageIdx)
        ? updated.pages.find((p) => p.index === pageIdx)
        : undefined;
      if (!page) continue;
      let applied = false;
      for (const block of page.blocks) {
        if (applied) break;
        for (const line of block.lines) {
          if (!line.glyphs?.length) continue;
          const lineText = line.glyphs.map((g) => g.char).join("");
          if (lineText === seg.originalText) {
            updated = mutateLineText(updated, block.id, line.id, seg.text).document;
            const l = findLineBySource(updated, block.id, line.id);
            if (l) l.edited = true;
            applied = true;
            break;
          }
          const idx = lineText.indexOf(seg.originalText);
          if (idx >= 0) {
            const start = idx;
            const end = idx + seg.originalText.length - 1;
            const next =
              lineText.slice(0, start) + seg.text + lineText.slice(end + 1);
            updated = mutateLineText(updated, block.id, line.id, next, { start, end })
              .document;
            const l = findLineBySource(updated, block.id, line.id);
            if (l) l.edited = true;
            applied = true;
            break;
          }
        }
      }
    }
  }

  return updated;
}
