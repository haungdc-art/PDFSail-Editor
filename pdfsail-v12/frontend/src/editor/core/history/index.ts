/**
 * editor/core/history/index.ts — EDITOR-CORE-004 统一出口
 *
 * 规范 §27 / §58：调用方从这里取 History API。
 */

export type {
  CommitResult,
  EditorHistoryState,
  EditorTransaction,
  FinalizeResult,
  UndoRedoResult,
} from "./types";

export { clampSnapshotToDocument, safeClampPosition } from "./clamp";

export {
  EditorHistory,
  createEditorHistory,
  type CommitSelectionInput,
  type EditorHistoryOptions,
} from "./history";
