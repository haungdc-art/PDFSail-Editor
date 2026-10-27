/**
 * editor/core/commands/set-text-style.ts — EDITOR-CORE-003 · §38
 *
 * 给选区文本套用 Partial<TextStyle>。
 *
 * 最小语义（§38）：
 *   选区 → 必要时在边界拆分 run → 只更新完全落在选区内的 run 的 style
 *
 * 明确**不**实现：字体替换 / PDF 字体嵌入 / font resolver / PDF 导出。
 * 实现隔离在自己的文件与 setStyleInTextBox，不污染文本结构 Command（§38）。
 *
 * 文本不变，因此未被拆分的 run 保留完整 source binding；
 * 被边界拆分出来的 run 清除 glyph 索引（一个原 run 拆成两个后，
 * 两个 run 共享同一 glyph 区间会导致导出重复替换）。
 */

import type { EditorDocument, TextStyle } from "../document/types";
import { resolveTextPosition } from "../position/index";
import type { TextRange } from "../position/types";
import { applyToTextBox, setStyleInTextBox } from "./helpers";
import { CommandError, type EditorCommand } from "./types";

export class SetTextStyleCommand implements EditorCommand {
  readonly type = "set-text-style" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly range: TextRange;
  readonly style: Partial<TextStyle>;

  constructor(range: TextRange, style: Partial<TextStyle>) {
    this.range = range;
    this.style = style;
    this.affectedTextBoxes = [range.anchor.textBoxId];
    this.affectedParagraphs = [range.anchor.paragraphId, range.focus.paragraphId];
  }

  execute(document: EditorDocument): EditorDocument {
    const a = resolveTextPosition(document, this.range.anchor);
    const b = resolveTextPosition(document, this.range.focus);
    if (a.textBox.id !== b.textBox.id) {
      throw new CommandError(
        "cross-text-box",
        `SetTextStyle 不支持跨 TextBox："${a.textBox.id}" ↔ "${b.textBox.id}"`
      );
    }
    return applyToTextBox(document, a.textBox.id, (tb) =>
      setStyleInTextBox(tb, this.range, this.style)
    );
  }
}
