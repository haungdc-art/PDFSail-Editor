/**
 * editor/core/position/types.ts — EDITOR-CORE-002
 *
 * Editor Core 的统一文本位置 / 范围 / 插入点 / 选区模型（规范 §9–§16）。
 *
 * ── 严禁事项 ────────────────────────────────────────────────────────
 * §21 本模块**不得**出现 glyphIndex / startGlyphIndex / endGlyphIndex
 *     作为 TextPosition / TextRange / Caret / Selection 的字段。
 *     glyph 索引只存在于 PDF Binding 的 TextSourceBinding（provenance）。
 * §22 禁止依赖 react / DOM / window / document / Range / Selection / PDF.js。
 * §23 禁止依赖 docBlocks / Segment / EditSession / EditableTextNode。
 *
 * ── offset 语义（§2）───────────────────────────────────────────────
 * offset = 该 Run 内的 **UTF-16 code-unit** 偏移，不是 Unicode code point 索引。
 *   "A😀B" → A=1, 😀=2, B=1 → length 4
 *   offset 0 → A 前；1 → A 后；3 → 😀 后；4 → B 后
 */

/**
 * 文本位置。
 *
 * offset 是 run 内偏移，段落级 / 文档级偏移由 position.ts 的换算函数提供（§19），
 * 二者**不可混用**（§18：Run offsets ≠ Document global offset）。
 */
export interface TextPosition {
  textBoxId: string;
  paragraphId: string;
  runId: string;
  /** UTF-16 code-unit offset，取值 [0, run.text.length] */
  offset: number;
}

/**
 * 文本范围。
 *
 * §6：不假设 anchor 在前、focus 在后 —— anchor=100 / focus=20 的反向选择是合法的。
 * 需要有序结果时用 normalizeTextRange()（§9）。
 */
export interface TextRange {
  anchor: TextPosition;
  focus: TextPosition;
}

/** 范围方向。collapsed 是独立取值，不是 forward 的子集（§8） */
export type TextRangeDirection = "forward" | "backward" | "collapsed";

/**
 * 插入点亲和性。
 *
 * 用于处理行边界 / 折行 / 段落边界（§14）。
 * 本任务不实现复杂 bidi，默认 "forward"。
 */
export type CaretAffinity = "forward" | "backward";

export interface Caret {
  position: TextPosition;
  affinity: CaretAffinity;
}

/**
 * 选区。
 *
 * §16：第一版只有 range。direction / mode / source 等字段未来扩展，
 * 现在不提前增加（§7：不为目录结构造空抽象）。
 */
export interface EditorSelection {
  range: TextRange;
}
