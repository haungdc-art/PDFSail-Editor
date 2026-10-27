/**
 * editor/core/commands/merge-paragraph.ts — EDITOR-CORE-003 · Command E
 *
 * 将指定段落与其**前一个**段落合并（§21）。
 *
 * - 按 paragraphId 定位，调用方**不依赖数组 index**（§21）
 * - 段落边界本身不引入空格（§22）：
 *     "Hello" + "world"  → "Helloworld"
 *     "Hello " + "world" → "Hello world"
 * - 第一个段落无前驱 → no-op
 */

import type { EditorDocument } from "../document/types";
import { applyToTextBox, findTextBoxIdByParagraph, mergeParagraphsInTextBox } from "./helpers";
import { CommandError, type EditorCommand } from "./types";

export class MergeParagraphCommand implements EditorCommand {
  readonly type = "merge-paragraph" as const;
  readonly affectedTextBoxes: readonly string[];
  readonly affectedParagraphs: readonly string[];
  readonly paragraphId: string;

  constructor(paragraphId: string) {
    this.paragraphId = paragraphId;
    this.affectedTextBoxes = [];
    this.affectedParagraphs = [paragraphId];
  }

  execute(document: EditorDocument): EditorDocument {
    const textBoxId = findTextBoxIdByParagraph(document, this.paragraphId);
    if (!textBoxId) {
      throw new CommandError(
        "missing-paragraph",
        `Paragraph "${this.paragraphId}" 不存在于任何 TextBox`
      );
    }
    return applyToTextBox(document, textBoxId, (tb) =>
      mergeParagraphsInTextBox(tb, this.paragraphId)
    );
  }
}
