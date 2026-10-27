/**
 * editor/core/input/index.ts — EDITOR-CORE-008 统一出口
 *
 * 依赖边界（架构检查验证）：只允许
 *   `../document`、`../position`、`../commands`、`./*`
 * 禁止 `../layout`、`../history`、DOM、React、PDF、legacy。
 */

export {
  DEFAULT_INPUT_OPTIONS,
  caretOf,
  type InputAdapterOptions,
  type InputAdapterResult,
  type InputContext,
  type InputEvent,
} from "./types";

export type { ActionOutcome, DeleteUnit, KeyAction, KeyInput } from "./keyboard";
export {
  commandsForAction,
  insertOrReplace,
  nextPosition,
  previousPosition,
  resolveKeyAction,
  runRangesOfParagraph,
  // ★ F3B-6.21-F2（E-C5-2）：词级删除区间（TextRange）+ **唯一** code point 步进实现
  stepBack,
  stepForward,
  wordRangeInDocument,
  // 注意：不在此重导出 isCollapsedRange —— 它与 position/index 同名，
  // 会与 `export * from "./position/index"` 在 core/index 产生歧义。
  // 需要时从 position 模块取（语义完全相同）。
} from "./keyboard";

export {
  classifyWordChar,
  isJoinableConnector,
  wordRangeAt,
  type WordCharClass,
  type WordDirection,
  type WordRange,
} from "./word-boundary";

export type { CompositionEndResult, CompositionState } from "./composition";
export { CompositionTracker, commandsForComposition } from "./composition";

export type { PasteOutcome } from "./paste";
export { commandsForPaste, normalizePastedText } from "./paste";

export { InputAdapter, createInputAdapter, handleInputEvent } from "./input";

// ★ F3B-6.21-G3-C：Shift+Arrow selection mutation 的唯一新增逻辑原语（组合既有 Core 原语，非第二套 resolver）
export { extendSelectionByCodePoint, type SelectionStepDirection } from "./selection-navigation";
