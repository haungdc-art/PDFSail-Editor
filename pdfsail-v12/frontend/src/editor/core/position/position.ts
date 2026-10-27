/**
 * editor/core/position/position.ts — EDITOR-CORE-002
 *
 * TextPosition 的校验、钳制、比较，以及 Position ↔ 段落内偏移 的换算（§19）。
 *
 * 全部纯函数，仅依赖 Editor Core 的 document 模块；
 * 无 React / DOM / PDF / legacy 依赖（§22 / §23）。
 */

import { findTextBox, isTextBox } from "../document/query";
import type { EditorDocument, Paragraph, TextBoxObject, TextRun } from "../document/types";
import { getRunStartOffsetInParagraph, resolveParagraphOffset } from "./offset";
import type { TextPosition } from "./types";

// ─────────────────────────────────────────────────────────────────────
//  错误类型
// ─────────────────────────────────────────────────────────────────────

export type TextPositionErrorCode =
  | "missing-text-box"
  | "missing-paragraph"
  | "missing-run"
  | "cross-text-box";

/**
 * 位置解析失败。
 *
 * §4 明确：TextBox / Paragraph / Run 不存在时**不允许静默选择另一个对象**，
 * 因此这里一律抛错（带 code 便于调用方分类处理），不做兜底替换。
 */
export class TextPositionError extends Error {
  readonly code: TextPositionErrorCode;

  constructor(code: TextPositionErrorCode, message: string) {
    super(`[TextPosition] ${message}`);
    this.name = "TextPositionError";
    this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  解析
// ─────────────────────────────────────────────────────────────────────

export interface ResolvedTextPosition {
  textBox: TextBoxObject;
  paragraph: Paragraph;
  run: TextRun;
  /** paragraph 在 textBox.paragraphs 中的实际下标（文档顺序，非 id 排序） */
  paragraphIndex: number;
  /** run 在 paragraph.runs 中的实际下标 */
  runIndex: number;
}

/**
 * 解析位置到具体对象 + 顺序下标。
 *
 * 校验（§3.1–§3.5）：TextBox 存在 / Paragraph 存在 / Run 存在 /
 * Run 属于该 Paragraph / Paragraph 属于该 TextBox。
 */
export function resolveTextPosition(
  document: EditorDocument,
  position: TextPosition
): ResolvedTextPosition {
  const textBox = findTextBox(document, position.textBoxId);
  if (!textBox) {
    throw new TextPositionError("missing-text-box", `TextBox "${position.textBoxId}" 不存在`);
  }
  const paragraphIndex = textBox.paragraphs.findIndex((p) => p.id === position.paragraphId);
  if (paragraphIndex < 0) {
    throw new TextPositionError(
      "missing-paragraph",
      `Paragraph "${position.paragraphId}" 不属于 TextBox "${position.textBoxId}"`
    );
  }
  const paragraph = textBox.paragraphs[paragraphIndex];
  const runIndex = paragraph.runs.findIndex((r) => r.id === position.runId);
  if (runIndex < 0) {
    throw new TextPositionError(
      "missing-run",
      `Run "${position.runId}" 不属于 Paragraph "${position.paragraphId}"`
    );
  }
  return { textBox, paragraph, run: paragraph.runs[runIndex], paragraphIndex, runIndex };
}

// ─────────────────────────────────────────────────────────────────────
//  校验 / 钳制 / 比较
// ─────────────────────────────────────────────────────────────────────

/**
 * §3：完整校验。非法一律返回 false，**不静默修正**。
 *
 * 校验项：TextBox 存在 / Paragraph 存在 / Run 存在 / Run 属于 Paragraph /
 *         Paragraph 属于 TextBox / offset >= 0 / offset <= UTF-16 length
 *
 * 注：§3 未要求拒绝"代理对中间"的 offset（如 "A😀B" 的 offset 2）。
 *     本函数严格按 1–7 实现，代理对规范化留给 caret affinity / hit-testing
 *     后续阶段，不在本任务引入第 8 条规则。
 */
export function isValidTextPosition(
  document: EditorDocument,
  position: TextPosition
): boolean {
  if (!position) return false;
  if (!Number.isFinite(position.offset)) return false;
  if (position.offset < 0) return false;
  let resolved: ResolvedTextPosition;
  try {
    resolved = resolveTextPosition(document, position);
  } catch {
    return false;
  }
  return position.offset <= resolved.run.text.length;
}

/**
 * §4：钳制来自 browser selection / IME / legacy adapter / import / OCR 的边界位置。
 *
 *   offset < 0            → 0
 *   offset > text.length  → text.length
 *
 * TextBox / Paragraph / Run 不存在或父子关系错误 → 抛 TextPositionError（不换对象）。
 * 返回新对象，不修改入参。
 */
export function clampTextPosition(
  document: EditorDocument,
  position: TextPosition
): TextPosition {
  const { run } = resolveTextPosition(document, position);
  const len = run.text.length;
  const raw = Number.isFinite(position.offset) ? position.offset : 0;
  const offset = Math.min(len, Math.max(0, Math.trunc(raw)));
  return {
    textBoxId: position.textBoxId,
    paragraphId: position.paragraphId,
    runId: position.runId,
    offset,
  };
}

/**
 * §5：位置相等。必须比较全部四个字段。
 */
export function textPositionEquals(a: TextPosition, b: TextPosition): boolean {
  return (
    a.textBoxId === b.textBoxId &&
    a.paragraphId === b.paragraphId &&
    a.runId === b.runId &&
    a.offset === b.offset
  );
}

/**
 * §8：文档顺序比较。返回 -1（a 在前）/ 0 / 1（b 在前）。
 *
 * 排序规则（不许用 id 字符串排序）：
 *     Paragraph 实际顺序 → Run 实际顺序 → UTF-16 offset
 *
 * 跨 TextBox → 抛 TextPositionError("cross-text-box")（§13：第一版禁止跨 TextBox）。
 *
 * §20：Run A offset 5 与 Run B offset 0 是**两个不同的** TextPosition
 *      （视觉上同一边界），本函数不做 canonicalize，返回 -1（A 在前）。
 */
export function compareTextPosition(
  document: EditorDocument,
  a: TextPosition,
  b: TextPosition
): number {
  const ra = resolveTextPosition(document, a);
  const rb = resolveTextPosition(document, b);
  if (ra.textBox.id !== rb.textBox.id) {
    throw new TextPositionError(
      "cross-text-box",
      `不支持跨 TextBox 比较："${ra.textBox.id}" ↔ "${rb.textBox.id}"（EDITOR-CORE-002 第一版限制）`
    );
  }
  if (ra.paragraphIndex !== rb.paragraphIndex) {
    return ra.paragraphIndex < rb.paragraphIndex ? -1 : 1;
  }
  if (ra.runIndex !== rb.runIndex) {
    return ra.runIndex < rb.runIndex ? -1 : 1;
  }
  if (a.offset === b.offset) return 0;
  return a.offset < b.offset ? -1 : 1;
}

// ─────────────────────────────────────────────────────────────────────
//  Position ↔ Paragraph offset（§19）
// ─────────────────────────────────────────────────────────────────────

/**
 * §19：TextPosition → 段落内偏移（UTF-16）。
 *
 * 例：Run A="Hello "、Run B="world"，位置 = Run B offset 2 → 6 + 2 = 8。
 *
 * offset 超界时钳制到 [0, run.length]，保证与 paragraphOffsetToPosition 的
 * round-trip 稳定；结构性问题（对象不存在）仍抛错。
 */
export function positionToParagraphOffset(
  document: EditorDocument,
  position: TextPosition
): number {
  const { paragraph, run, runIndex } = resolveTextPosition(document, position);
  const offset = Math.min(run.text.length, Math.max(0, Math.trunc(position.offset)));
  return getRunStartOffsetInParagraph(paragraph, runIndex) + offset;
}

/**
 * §19：段落内偏移 → TextPosition（反向）。
 *
 * 需要 textBoxId，因此要在全文档中定位该段落所属 TextBox。
 * 段落无 run 时抛错（无法构造合法 TextPosition）。
 * 偏移超出段落长度 → 末尾 run 的末尾。
 */
export function paragraphOffsetToPosition(
  document: EditorDocument,
  paragraphId: string,
  offset: number
): TextPosition {
  for (const page of document.pages) {
    for (const textBox of page.objects) {
      if (!isTextBox(textBox)) continue; // F3B-6.24-B3：图片对象无段落
      const paragraph = textBox.paragraphs.find((p) => p.id === paragraphId);
      if (!paragraph) continue;
      if (paragraph.runs.length === 0) {
        throw new TextPositionError(
          "missing-run",
          `Paragraph "${paragraphId}" 没有 run，无法构造 TextPosition`
        );
      }
      const { runIndex, runOffset } = resolveParagraphOffset(paragraph, offset);
      return {
        textBoxId: textBox.id,
        paragraphId,
        runId: paragraph.runs[runIndex].id,
        offset: runOffset,
      };
    }
  }
  throw new TextPositionError("missing-paragraph", `Paragraph "${paragraphId}" 不存在`);
}

// ─────────────────────────────────────────────────────────────────────
//  构造
// ─────────────────────────────────────────────────────────────────────

export function createTextPosition(
  textBoxId: string,
  paragraphId: string,
  runId: string,
  offset = 0
): TextPosition {
  return { textBoxId, paragraphId, runId, offset };
}
