/**
 * editor/core/commands/split-paragraph.ts — EDITOR-CORE-003 · Command D
 *
 * 在 TextPosition 处把段落拆成两个（§17）。
 *
 * - start / middle / end 三种位置都正确（§17）
 * - 起始处拆分产生空段落，**不偷偷删除**（§18）
 * - 末尾处拆分产生空尾段落（§19）
 * - 两侧 run 的 style 原样保留（§20）
 */

import type { EditorDocument } from "../document/types";
import { positionToParagraphOffset, resolveTextPosition } from "../position/index";
import type { TextPosition } from "../position/types";
import { applyToTextBox, splitParagraphInTextBox } from "./helpers";
import type { EditorCommand } from "./types";

export class SplitParagraphCommand implements EditorCommand {
  readonly type = "split-paragraph" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly position: TextPosition;

  constructor(position: TextPosition) {
    this.position = position;
    this.affectedTextBoxes = [position.textBoxId];
    this.affectedParagraphs = [position.paragraphId];
  }

  execute(document: EditorDocument): EditorDocument {
    const resolved = resolveTextPosition(document, this.position);
    const offset = positionToParagraphOffset(document, this.position);
    return applyToTextBox(document, resolved.textBox.id, (tb) =>
      splitParagraphInTextBox(tb, resolved.paragraph.id, offset)
    );
  }
}
