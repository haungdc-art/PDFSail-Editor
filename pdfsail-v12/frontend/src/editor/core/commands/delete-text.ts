/**
 * editor/core/commands/delete-text.ts — EDITOR-CORE-003 · Command B
 *
 * 删除 TextRange 覆盖的文本（§10）。
 *
 * - 支持同 run / 跨 run / 跨 paragraph（§11–§13）
 * - 折叠 range → no-op（§11），但**不在构造阶段**修改 range
 * - 删除基于 UTF-16 字符边界，绝不使用 glyph index（§12）
 * - 被部分删除的 run 清除 glyph 索引，避免导出错误替换（§25）
 */

import type { EditorDocument } from "../document/types";
import { resolveTextPosition } from "../position/index";
import type { TextRange } from "../position/types";
import { applyToTextBox, removeRangeFromTextBox } from "./helpers";
import { CommandError, type EditorCommand } from "./types";

export class DeleteTextCommand implements EditorCommand {
  readonly type = "delete-text" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly range: TextRange;

  constructor(range: TextRange) {
    // §11：折叠 range 是合法入参，此处**不**修改 range；execute 时判定为 no-op
    this.range = range;
    this.affectedTextBoxes = [range.anchor.textBoxId];
    this.affectedParagraphs = [range.anchor.paragraphId, range.focus.paragraphId];
  }

  execute(document: EditorDocument): EditorDocument {
    const a = resolveTextPosition(document, this.range.anchor);
    const b = resolveTextPosition(document, this.range.focus);
    if (a.textBox.id !== b.textBox.id) {
      throw new CommandError(
        "cross-text-box",
        `DeleteText 不支持跨 TextBox："${a.textBox.id}" ↔ "${b.textBox.id}"`
      );
    }
    return applyToTextBox(document, a.textBox.id, (tb) => removeRangeFromTextBox(tb, this.range));
  }
}
