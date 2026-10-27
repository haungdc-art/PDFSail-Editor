/**
 * editor/core/position/range.ts — EDITOR-CORE-002
 *
 * TextRange 的方向 / 归一化 / 文本抽取（§6–§13）。
 *
 * 边界（§13，第一版）：
 *   允许：同一 TextBox 内跨 Run、跨 Paragraph
 *   禁止：跨 TextBox（anchor 与 focus 落在不同 TextBox → 抛 TextPositionError）
 */

import { getParagraphText } from "../document/query";
import type { EditorDocument } from "../document/types";
import {
  compareTextPosition,
  positionToParagraphOffset,
  resolveTextPosition,
  textPositionEquals,
  TextPositionError,
} from "./position";
import type { TextRange, TextPosition, TextRangeDirection } from "./types";

export function createTextRange(anchor: TextPosition, focus: TextPosition): TextRange {
  return { anchor, focus };
}

/**
 * §7：折叠判定 —— anchor 与 focus 四字段完全相同才折叠。
 *
 * §20：Run A offset 5 与 Run B offset 0 是**不同**的 TextPosition，
 *      因此不构成折叠（第一版不做 canonicalize）。
 */
export function isCollapsedRange(range: TextRange): boolean {
  return textPositionEquals(range.anchor, range.focus);
}

/**
 * §8：方向判定。
 *
 * 不能只比 offset —— Range 可以跨 Run / Paragraph。
 * 顺序由文档实际结构（Paragraph → Run → offset）决定。
 */
export function getRangeDirection(
  document: EditorDocument,
  range: TextRange
): TextRangeDirection {
  if (isCollapsedRange(range)) return "collapsed";
  return compareTextPosition(document, range.anchor, range.focus) <= 0 ? "forward" : "backward";
}

/**
 * §9：归一化，保证 anchor <= focus。**不修改**入参，返回新对象。
 *
 * 跨 TextBox 时抛错（由 compareTextPosition 触发）。
 */
export function normalizeTextRange(document: EditorDocument, range: TextRange): TextRange {
  if (compareTextPosition(document, range.anchor, range.focus) <= 0) {
    return { anchor: range.anchor, focus: range.focus };
  }
  return { anchor: range.focus, focus: range.anchor };
}

/**
 * §10–§12：抽取 Range 覆盖的文本。
 *
 * 支持：
 *   同 Run            "Hello world" 的部分
 *   跨 Run            Run A → Run B → Run C（"lo beautiful wo"）
 *   跨 Paragraph      Paragraph 1 → Paragraph 3，段落边界为 "\n"
 *
 * 跨 TextBox → 抛 TextPositionError("cross-text-box")（§13）。
 */
export function getTextRangeText(document: EditorDocument, range: TextRange): string {
  const normalized = normalizeTextRange(document, range);
  const start = resolveTextPosition(document, normalized.anchor);
  const end = resolveTextPosition(document, normalized.focus);

  const startOffset = positionToParagraphOffset(document, normalized.anchor);
  const endOffset = positionToParagraphOffset(document, normalized.focus);

  // 同一段落：直接切片
  if (start.paragraphIndex === end.paragraphIndex) {
    return getParagraphText(start.paragraph).slice(startOffset, endOffset);
  }

  // 跨段落：段落之间显式插入 "\n"（§10：paragraph boundary = "\n"）
  const parts: string[] = [];
  parts.push(getParagraphText(start.paragraph).slice(startOffset));
  for (let i = start.paragraphIndex + 1; i < end.paragraphIndex; i++) {
    parts.push(getParagraphText(start.textBox.paragraphs[i]));
  }
  parts.push(getParagraphText(end.paragraph).slice(0, endOffset));
  return parts.join("\n");
}

/** 显式暴露跨 TextBox 检测，供调用方/测试直接判定 */
export function isCrossTextBoxRange(document: EditorDocument, range: TextRange): boolean {
  try {
    compareTextPosition(document, range.anchor, range.focus);
    return false;
  } catch (e) {
    return e instanceof TextPositionError && e.code === "cross-text-box";
  }
}
