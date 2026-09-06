/**
 * FactsSnapshot — Renderer 所需的 Content Snapshot（Facts）
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 3B
 *
 * 职责（ADR-003）：
 *   - 不是 EditableDocument（不是完整 Facts，只含 Renderer 需要的 Content）。
 *   - 不是 Layout（不含几何）。
 *   - 只是 Renderer 的 Content 快照：按 blockId / lineId / glyphIndex 关联 LayoutResult。
 *
 * 三层输入：
 *   FactsSnapshot（Content）+ LayoutResult（Geometry）→ LayoutResultAdapter → RenderCommand
 *
 * 与 EditableDocument 分离，避免 Adapter/Renderer 偷偷读 block.lines / bbox / regionType。
 */

/** 单个 glyph 的 Content（无几何） */
export interface FactGlyph {
  /** 关联 EditableBlock id */
  readonly blockId: string;
  /** 关联 EditableLine id */
  readonly lineId: string;
  /** 字符内容 */
  readonly char: string;
  /** 指向文档级 styles 数组的索引 */
  readonly styleRef: number;
  /** 是否被编辑过 */
  readonly modified: boolean;
}

/** 单行 Content */
export interface FactLine {
  /** 关联 EditableLine id */
  readonly lineId: string;
  /** 行内 glyph Content */
  readonly glyphs: ReadonlyArray<FactGlyph>;
}

/** 单个 block 的 Content */
export interface FactBlock {
  /** 关联 EditableBlock id */
  readonly blockId: string;
  /** 行 Content */
  readonly lines: ReadonlyArray<FactLine>;
}

/** 单页 Content */
export interface FactPage {
  /** 关联 EditablePage id */
  readonly pageId: string;
  /** block Content */
  readonly blocks: ReadonlyArray<FactBlock>;
}

/** 文档级 Content Snapshot（Facts，无几何） */
export interface FactsSnapshot {
  readonly pages: ReadonlyArray<FactPage>;
}
