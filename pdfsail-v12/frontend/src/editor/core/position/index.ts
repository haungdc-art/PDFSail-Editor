/**
 * editor/core/position/index.ts — EDITOR-CORE-002 统一出口
 *
 * 规范 §27：调用方通过稳定入口访问 TextPosition / TextRange / Caret / EditorSelection，
 * 不要直接 import position/*.ts 内部文件。
 */

export type {
  Caret,
  CaretAffinity,
  EditorSelection,
  TextPosition,
  TextRange,
  TextRangeDirection,
} from "./types";

export {
  getParagraphTextLength,
  getRunStartOffsetInParagraph,
  getRunTextLength,
  resolveParagraphOffset,
} from "./offset";

export {
  TextPositionError,
  clampTextPosition,
  compareTextPosition,
  createTextPosition,
  isValidTextPosition,
  paragraphOffsetToPosition,
  positionToParagraphOffset,
  resolveTextPosition,
  textPositionEquals,
  type ResolvedTextPosition,
  type TextPositionErrorCode,
} from "./position";

export {
  createTextRange,
  getRangeDirection,
  getTextRangeText,
  isCollapsedRange,
  isCrossTextBoxRange,
  normalizeTextRange,
} from "./range";

export {
  DEFAULT_CARET_AFFINITY,
  caretEquals,
  collapseSelectionToEnd,
  collapseSelectionToStart,
  createCaret,
  createCollapsedSelection,
  createSelection,
  getSelectionDirection,
  getSelectionText,
  isCollapsedSelection,
  selectionFromRange,
} from "./selection";
