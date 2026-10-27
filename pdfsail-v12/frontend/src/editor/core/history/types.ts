/**
 * editor/core/history/types.ts — EDITOR-CORE-004
 *
 * History / Transaction 模型。
 *
 * ── 三条硬原则 ──────────────────────────────────────────────────────
 * 1. History **不保存 docBlocks**
 *      History 只认识 EditorDocument（Editor Core 唯一真相，规范 §6）。
 *      docBlocks / Segment / EditSession / EditableTextNode 一律不进入本模块。
 * 2. History **不依赖 React setter**
 *      没有 CommandContext、没有 setDocBlocks、没有任何回调。
 *      History 是纯数据 + 纯函数，状态由调用方从 `state` 读回后自行渲染。
 * 3. Undo / Redo **同时恢复 Document + Selection + Caret**
 *      Undo  → { document: before.document, selection: before.selection, caret: before.caret }
 *      Redo  → { document: after.document,  selection: after.selection,  caret: after.caret  }
 *
 * ── 与 document 的关系 ──────────────────────────────────────────────
 * History 保存 before/after 两份快照，Command 不实现 undo（规范 §2）。
 * 因此 CORE-003 的 Command 无需改动即可接入。
 */

import type { EditorDocument } from "../document/types";
import type { EditorCommand, CommandType } from "../commands/types";
import type { Caret, EditorSelection } from "../position/types";

/** History 管理的完整可恢复状态（三者缺一不可） */
export interface EditorHistoryState {
  document: EditorDocument;
  selection: EditorSelection;
  caret: Caret;
}

/** 一个逻辑编辑事务 = 一次用户操作 = 一步 undo */
export interface EditorTransaction {
  id: string;
  /** 产生该事务的 Command 类型（调试/诊断用） */
  type: CommandType;
  readonly command: EditorCommand;
  readonly before: EditorHistoryState;
  readonly after: EditorHistoryState;
}

export interface CommitResult {
  /** false = no-op：未产生 history entry，version 不变（规范 §5） */
  changed: boolean;
  /** 提交后的状态；未变更时等于提交前状态 */
  state: EditorHistoryState;
  /** changed=true 时为新建的事务，否则 null */
  transaction: EditorTransaction | null;
}

export interface UndoRedoResult {
  /** false = 栈空，未发生状态变化 */
  applied: boolean;
  state: EditorHistoryState;
  /** applied=true 时为被回滚/重做的事务，否则 null */
  transaction: EditorTransaction | null;
}

/**
 * `EditorHistory.finalizeLatestTransaction()` 的结果（EDITOR-CORE-012-D）。
 *
 * 用途：把「**命令执行之后**才能知道」的 selection / caret 补进栈顶事务的 `after`，
 * 使 `transaction.after` 成为当前状态**完整可恢复的快照**（否则 `redo` 会恢复
 * commit 时刻的 clamp 值，而不是 009 解析出的真实插入点）。
 */
export interface FinalizeResult {
  /** false = 没有可补全的事务（栈空，或处于 redo 分支且当前无已应用事务） */
  applied: boolean;
  /** 补全后的状态（与 `state` 同口径） */
  state: EditorHistoryState;
  /** applied=true 时为**补全后**的事务，否则 null */
  transaction: EditorTransaction | null;
}
