/**
 * editor/core/commands/insert-text.ts — EDITOR-CORE-003 · Command A
 *
 * 在 TextPosition **之前**插入文本（§6）。
 *
 * - 继承插入点所在 run 的 TextStyle（§9）
 * - 同 style 且无 provenance 冲突时合并回原 run，不产生 run 碎片（§8）
 * - "\n" 解释为段落拆分，而不是普通字符（§7）
 */

import type { EditorDocument } from "../document/types";
import { positionToParagraphOffset, resolveTextPosition } from "../position/index";
import type { TextPosition } from "../position/types";
import { applyToTextBox, insertIntoTextBox } from "./helpers";
import type { EditorCommand } from "./types";

export class InsertTextCommand implements EditorCommand {
  readonly type = "insert-text" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly position: TextPosition;
  readonly text: string;

  constructor(position: TextPosition, text: string) {
    this.position = position;
    this.text = text;
    this.affectedTextBoxes = [position.textBoxId];
    this.affectedParagraphs = [position.paragraphId];
  }

  execute(document: EditorDocument): EditorDocument {
    // resolveTextPosition 校验结构（缺对象 / 父子关系错 → 抛错，不静默换对象）
    const resolved = resolveTextPosition(document, this.position);
    const offset = positionToParagraphOffset(document, this.position);
    // §9：默认继承插入点所在 run 的 style
    const style = resolved.run.style;
    return applyToTextBox(document, resolved.textBox.id, (tb) =>
      insertIntoTextBox(tb, resolved.paragraph.id, offset, this.text, style)
    );
  }
}
