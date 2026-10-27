/**
 * editor/core/position/selection.ts — EDITOR-CORE-002
 *
 * Caret 与 EditorSelection 的构造与辅助函数（§14–§17）。
 */

import type { EditorDocument } from "../document/types";
import { compareTextPosition } from "./position";
import { getRangeDirection, getTextRangeText, isCollapsedRange } from "./range";
import type {
  Caret,
  CaretAffinity,
  EditorSelection,
  TextPosition,
  TextRange,
} from "./types";

// ─────────────────────────────────────────────────────────────────────
//  Caret（§14 / §15）
// ─────────────────────────────────────────────────────────────────────

/** 默认亲和性：forward（§14） */
export const DEFAULT_CARET_AFFINITY: CaretAffinity = "forward";

export function createCaret(
  position: TextPosition,
  affinity: CaretAffinity = DEFAULT_CARET_AFFINITY
): Caret {
  return { position, affinity };
}

/** §15：比较 position + affinity */
export function caretEquals(a: Caret, b: Caret): boolean {
  return (
    a.affinity === b.affinity &&
    a.position.textBoxId === b.position.textBoxId &&
    a.position.paragraphId === b.position.paragraphId &&
    a.position.runId === b.position.runId &&
    a.position.offset === b.position.offset
  );
}

// ─────────────────────────────────────────────────────────────────────
//  Selection（§16 / §17）
// ─────────────────────────────────────────────────────────────────────

export function createSelection(anchor: TextPosition, focus: TextPosition): EditorSelection {
  return { range: { anchor, focus } };
}

/** §17：折叠选区（anchor = focus = position） */
export function createCollapsedSelection(position: TextPosition): EditorSelection {
  return { range: { anchor: position, focus: position } };
}

/**
 * §17：折叠到选区**起点**（文档顺序上靠前的一端），不修改入参。
 */
export function collapseSelectionToStart(
  document: EditorDocument,
  selection: EditorSelection
): EditorSelection {
  const start =
    compareTextPosition(document, selection.range.anchor, selection.range.focus) <= 0
      ? selection.range.anchor
      : selection.range.focus;
  return createCollapsedSelection(start);
}

/**
 * §17：折叠到选区**终点**（文档顺序上靠后的一端），不修改入参。
 */
export function collapseSelectionToEnd(
  document: EditorDocument,
  selection: EditorSelection
): EditorSelection {
  const end =
    compareTextPosition(document, selection.range.anchor, selection.range.focus) >= 0
      ? selection.range.anchor
      : selection.range.focus;
  return createCollapsedSelection(end);
}

export function isCollapsedSelection(selection: EditorSelection): boolean {
  return isCollapsedRange(selection.range);
}

export function getSelectionText(document: EditorDocument, selection: EditorSelection): string {
  return getTextRangeText(document, selection.range);
}

export function getSelectionDirection(
  document: EditorDocument,
  selection: EditorSelection
): ReturnType<typeof getRangeDirection> {
  return getRangeDirection(document, selection.range);
}

/** 从 Range 构造 Selection（复用同一 range 对象，不深拷贝） */
export function selectionFromRange(range: TextRange): EditorSelection {
  return { range };
}
