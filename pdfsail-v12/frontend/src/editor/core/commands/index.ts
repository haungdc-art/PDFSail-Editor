/**
 * editor/core/commands/index.ts — EDITOR-CORE-003 统一出口
 *
 * 规范 §27 / §58：调用方从这里取 Command API，不直接 import commands/*.ts 内部文件。
 */

export type { CommandErrorCode, CommandResult, CommandType, EditorCommand } from "./types";
export { CommandError } from "./types";

export {
  GENERATED_SOURCE,
  applyToTextBox,
  compareInTextBox,
  deriveRun,
  ensureNonEmptyRuns,
  findParagraphIndex,
  findTextBoxIdByParagraph,
  insertIntoTextBox,
  makeRun,
  mergeParagraphsInTextBox,
  paragraphOffsetOf,
  removeRangeFromTextBox,
  setStyleInTextBox,
  splitParagraphInTextBox,
  stripGlyphRange,
  styleEquals,
} from "./helpers";

export { InsertTextCommand } from "./insert-text";
export { DeleteTextCommand } from "./delete-text";
export { ReplaceTextCommand } from "./replace-text";
export { SplitParagraphCommand } from "./split-paragraph";
export { MergeParagraphCommand } from "./merge-paragraph";
export { SetTextStyleCommand } from "./set-text-style";
export {
  AddBlockCommand,
  type AddBlockInput,
  type AddImageObjectInput,
  type AddObjectGeometry,
  type AddTextObjectInput,
  type AffineTransform4,
} from "./add-block";
export {
  DeleteObjectCommand,
  type DeleteObjectInput,
} from "./delete-object";
export {
  MoveObjectCommand,
  type MoveObjectInput,
} from "./move-object";
export {
  ResizeObjectCommand,
  type ResizeObjectInput,
} from "./resize-object";
export {
  AddOcrTextBlocksCommand,
  type AddOcrTextBlocksInput,
  type AddOcrTextBlockEntry,
} from "./add-ocr-blocks";
// F3B-6.27 P0-D2：一次 EditingUnit mutation 的包装器 Command。
// ⚠️ 本阶段**无生产 caller**（仅测试）；接线属 P0-E。
export {
  UnitTransactionCommand,
  type UnitTransactionOperation,
} from "./unit-transaction";

import type { EditorDocument } from "../document/types";
import type { CommandResult, EditorCommand } from "./types";

/**
 * 执行 Command 并产出结果元数据（§29）。
 *
 * changed = false 表示 no-op：不产生 history entry，version 不变（§5）。
 * Command 不修改 selection / caret（§28）—— 那是 EDITOR-CORE-004 的事务职责。
 */
export function applyCommand(
  document: EditorDocument,
  command: EditorCommand
): CommandResult {
  const next = command.execute(document);
  return {
    document: next,
    changed: next !== document,
    affectedTextBoxes: command.affectedTextBoxes ? [...command.affectedTextBoxes] : [],
    affectedParagraphs: command.affectedParagraphs ? [...command.affectedParagraphs] : [],
  };
}
