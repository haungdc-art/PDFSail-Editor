/**
 * MapCurrentSelectionProvider — 真实 CurrentSelectionProvider 实现（Task-013B）
 *
 * 从 GlyphRenderer 上报的 DerivedSelection 构建 CurrentSelection。
 * 含 Consistency Guard（Task-013A.3）：校验 selection.blockId/lineId 仍属于当前 document。
 *
 * 依赖注入（Composition Root 提供闭包）：
 *   - getDerivedSelection: () => DerivedSelection | null   （读 onSelectionChanged 更新的 ref）
 *   - getDocument: () => EditableDocument | null           （读当前 document，用于 Guard）
 *
 * Contract 不变：current(): CurrentSelection | null。
 * Provider 只负责「取 + 转 + Guard」，不做计算/推导/Geometry。
 */
import type { CurrentSelectionProvider } from "./current-selection-provider";
import type { CurrentSelection } from "./current-selection";
import type { EditableDocument } from "./types";
import type { DerivedSelection } from "./selection-engine";

export interface MapCurrentSelectionProviderDeps {
  /** 读当前 DerivedSelection（由 onSelectionChanged 更新） */
  getDerivedSelection: () => DerivedSelection | null;
  /** 读当前 EditableDocument（Consistency Guard 用） */
  getDocument: () => EditableDocument | null;
}

export class MapCurrentSelectionProvider implements CurrentSelectionProvider {
  constructor(private readonly deps: MapCurrentSelectionProviderDeps) {}

  current(): CurrentSelection | null {
    const derived = this.deps.getDerivedSelection();
    if (!derived) return null;

    const glyphs = derived.glyphs;
    if (glyphs.length === 0) return null;

    // 取选区首字符所在行
    const first = glyphs[0];
    const last = glyphs[glyphs.length - 1];

    // ── Consistency Guard ──
    // 校验 selection 的 blockId+lineId 仍属于当前 document。
    // 若 document 已变化（翻页/OCR/undo/reload），blockId/lineId 找不到 → 返回 null。
    const doc = this.deps.getDocument();
    if (doc) {
      const lineExists = doc.pages
        .flatMap((p) => p.blocks)
        .some((b) => b.id === first.blockId && b.lines.some((l) => l.id === first.lineId));
      if (!lineExists) return null;
    }

    // ── M5-IMPLEMENT-001: 按行分组生成 ordered ranges（多行表达能力）──
    // DerivedSelection.glyphs[] 是全局有序的（可能跨行/跨 block）。
    // 按 (blockId, lineId) 连续分组，生成有序 SelectionRange[]：
    //   - 单行选区：ranges.length === 1，ranges[0] 与旧字段完全一致。
    //   - 跨行选区：ranges.length >= 2，每项是一个具体 line 的精确 glyph 区间。
    // 不做 text-search / 坐标重推断；只按已有 glyph identity 分组。
    // 注意：不在此拒绝跨行（保留信息到 CurrentSelection.ranges）；跨行 mutation
    //       由 EditTool 层多行 guard 安全拒绝（见 edit-tool.ts）。
    const ranges: { blockId: string; lineId: string; startGlyphIndex: number; endGlyphIndex: number }[] = [];
    let current: { blockId: string; lineId: string } | null = null;
    for (const g of glyphs) {
      if (!current || current.blockId !== g.blockId || current.lineId !== g.lineId) {
        current = { blockId: g.blockId, lineId: g.lineId };
        ranges.push({ blockId: g.blockId, lineId: g.lineId, startGlyphIndex: g.glyphLocalIndex, endGlyphIndex: g.glyphLocalIndex });
      } else {
        const lastRange = ranges[ranges.length - 1];
        lastRange.endGlyphIndex = g.glyphLocalIndex;
      }
    }

    // 单行时旧字段与 ranges[0] 一致；跨行时旧字段取 first（兼容）。
    return {
      text: glyphs.map((g) => g.char).join(""),
      blockId: first.blockId,
      lineId: first.lineId,
      startGlyphIndex: first.glyphLocalIndex,
      endGlyphIndex: last.glyphLocalIndex,
      isEmpty: false,
      ranges,
    };
  }
}
