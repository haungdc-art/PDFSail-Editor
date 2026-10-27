/**
 * editor/core/commands/replace-text.ts — EDITOR-CORE-003 · Command C
 *
 * 语义 = Delete(range) + Insert(text)，但作为**一个逻辑 Command**（§14）：
 * 用户按一次 Replace，只产生一条 history entry，只需 Undo 一次。
 *
 * - text === "" 等价于 DeleteTextCommand，但保持 ReplaceText 类型语义（§15）
 * - 支持 "\n"，正确创建段落边界（§16）
 * - 新文本标记 { kind: "generated" }，不伪造 PDF provenance（§24/§26）
 */

import { getTextBoxText } from "../document/query";
import type { EditorDocument } from "../document/types";
import {
  normalizeTextRange,
  positionToParagraphOffset,
  resolveTextPosition,
} from "../position/index";
import type { TextRange } from "../position/types";
import { applyToTextBox, insertIntoTextBox, removeRangeFromTextBox } from "./helpers";
import { CommandError, type EditorCommand } from "./types";

export class ReplaceTextCommand implements EditorCommand {
  readonly type = "replace-text" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly range: TextRange;
  readonly text: string;

  constructor(range: TextRange, text: string) {
    this.range = range;
    this.text = text;
    this.affectedTextBoxes = [range.anchor.textBoxId];
    this.affectedParagraphs = [range.anchor.paragraphId, range.focus.paragraphId];
  }

  execute(document: EditorDocument): EditorDocument {
    const a = resolveTextPosition(document, this.range.anchor);
    const b = resolveTextPosition(document, this.range.focus);
    if (a.textBox.id !== b.textBox.id) {
      throw new CommandError(
        "cross-text-box",
        `ReplaceText 不支持跨 TextBox："${a.textBox.id}" ↔ "${b.textBox.id}"`
      );
    }
    const normalized = normalizeTextRange(document, this.range);
    const startParagraphId = normalized.anchor.paragraphId;
    const startOffset = positionToParagraphOffset(document, normalized.anchor);
    const startStyle = resolveTextPosition(document, normalized.anchor).run.style;

    return applyToTextBox(document, a.textBox.id, (tb) => {
      // ① 删除（无变化则沿用原对象引用）
      const afterDelete = removeRangeFromTextBox(tb, this.range) ?? tb;
      // ② 在删除后的同一起点插入（删除保留前缀，起点偏移仍然有效）
      const inserted = insertIntoTextBox(
        afterDelete,
        startParagraphId,
        startOffset,
        this.text,
        startStyle
      );
      const next = inserted ?? afterDelete;
      if (next === tb) return null;
      // §5：替换后文本与原文完全一致 → 视为 no-op，不制造无意义 history entry
      if (getTextBoxText(next) === getTextBoxText(tb)) return null;
      return next;
    });
  }
}
