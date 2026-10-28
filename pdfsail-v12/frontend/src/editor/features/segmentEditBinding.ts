/**
 * segmentEditBinding — M7.8-040 Segment → EditableDocument 精确回写 binding 层。
 *
 * 纯 additive：只消费 mutation 能力（mutateLineText），不改动 mutation core /
 * provenance / export renderer。
 *
 * applySegmentEditsToDocument 用 Segment.source（glyph 区间，由 buildSegmentFromGlyphs
 * 在创建 Segment 时直接由 glyph run 算出）精确定位并 range-mutation，
 * 完全不依赖 indexOf(originalText)。
 *
 * ── F3B-6.17-3C-3B：架构身份 = **Legacy export materialization adapter** ────────
 *   · 本模块**不属于** Segment 的正常 semantic editing path（正常路径见 `segmentCommit.ts`
 *     头部注释：`Segment → Core Command → EditorDocument → Core Export`）。
 *   · 唯一 production caller = `useExport` 的 **Legacy 导出分支**（`if (!usedCore)`）：
 *     `legacyDocForExport = allEditSegs.length ? applySegmentEditsToDocument(doc, allEditSegs) : doc`。
 *   · Core success / `ownership === "core"` ⇒ 该分支不执行 ⇒ **本模块与其 3 处 `mutateLineText`
 *     调用均不可达**（由 `C6/C7/C8` guard 固定）。
 *   · ⚠️ 不要新增第二层 wrapper 来「包装」本函数：不消除任何依赖，只会增加层级。
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
export function findLineBySource(
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
 * 把 segment 层的文本编辑同步进 EditableDocument（legacy safety-net）。
 *
 * ── 坐标契约（F3B-6.4B-5 / 5.1，务必先读）────────────────────────────────
 * 本函数接收的 segment range **必须是当前文档坐标（current coordinates）**，
 * 而不是 Segment 的 source（PDF 原始）坐标。
 *
 * 三层坐标语义，不要混为一谈：
 *   · 原始 Segment truth（`Segment.source` / `ledger` 的基准）→ **source coordinates**
 *   · legacy safety-net orchestration input（本函数入参）      → **current coordinates**
 *   · 本函数内部的批次 `shift`                                → 仅处理「该 current 批次内部」
 *                                                              pending segment 之间的相对位移
 *
 * 为什么入参必须是 current：本函数的 `shift` 初值恒为 **0**，只累加**入参批次内部**的位移
 * （见下方循环）。因此若调用方把「已经 canonical commit 的 segment」从批次里剔除
 * （orchestration 的 canonicalized 过滤），批次就不再完整，后续 segment 会被系统性压回
 * source 位置 ⇒ 错位。故换算由 **orchestration 层**负责（`PDFEditor.getLegacyPendingSegments`
 * 用 `ledger.currentRange(sourceSegmentKey(source))` 换算并**复制**对象）。
 *
 * ⚠️ 本 binding **不认识 Ledger / canonical commit / undo-redo**，也不接收 `initialShift`：
 *    它只消费「一个 current 坐标批次」，并在批次内部自行处理相对位移。
 *
 * M7.8-040：按 (blockId, lineId) 分组；组内按 startGlyphIndex 升序；
 *   逐段 mutateLineText(next, { start, end })，用 shift 校正前序编辑的长度偏移
 *   → 同一行多段同时编辑（含变长/变短）精确，互不串位。
 * 仅当 Segment 无 source（旧状态，生产路径均已带 source）才走下方 legacy indexOf 兜底。
 *
 * ── F3B-6.17-3C-3B：**Legacy export materialization adapter** ──────────────────
 * 唯一 production 调用点在 `useExport` 的 `if (!usedCore)` Legacy 导出分支内；
 * Core 成功接管下载时（`usedCore === true`）**不经过本函数**。
 */
export function applySegmentEditsToDocument(
  doc: EditableDocument,
  segments: Segment[]
): EditableDocument {
  const edited = segments.filter((s) => s.text !== s.originalText);
  if (!edited.length) return doc;

  // 主路径：按**入参 range**（= current coordinates）精确 mutation（不依赖 indexOf）。
  // `shift` 初值 0 ⇒ 只校正本批次内部的相对位移（坐标换算由 orchestration 负责）。
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
