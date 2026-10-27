/**
 * editor/core/history/history.ts — EDITOR-CORE-004
 *
 * EditorHistory：Command + Selection + Caret 的统一事务栈。
 *
 * ── 与旧 core/engine.ts 的 CommandHistory 的关系（规范 §46 / §37）────
 * 旧实现（已于 F3B-6.23-C-Impl-3 删除）：
 *   new CommandHistory({ setDocBlocks })   ← 依赖 React state setter
 *   PatchBlocksCommand(prev, next)         ← 保存 docBlocks 快照
 *
 * 本实现：
 *   new EditorHistory({ document, selection, caret })   ← 纯数据输入
 *   commit(command, { selection, caret })               ← 纯数据输入
 *   history.state                                       ← 调用方读回后自行渲染
 *
 * F3B-6.23-C-Impl 起：CommandHistory 已退出，undo/redo 唯一入口 =
 * `requestUndo/requestRedo`（features/undo-redo-request.ts）→ PDFEditor 执行器
 * → decideUndoRedoRoute → **本模块（core）** 或 Legacy OperationHistory（rollback）。
 */

import { nextId } from "../document/factory";
import type { EditorCommand } from "../commands/types";
import type { Caret, EditorSelection } from "../position/types";
import { clampSnapshotToDocument } from "./clamp";
import type {
  CommitResult,
  EditorHistoryState,
  EditorTransaction,
  FinalizeResult,
  UndoRedoResult,
} from "./types";

export interface EditorHistoryOptions {
  /** 最多保留的事务数（超出后丢弃最旧的） */
  maxSize?: number;
}

/** commit 时可只给部分字段，缺省项由 clamp 收敛 */
export interface CommitSelectionInput {
  selection?: EditorSelection;
  caret?: Caret;
}

export class EditorHistory {
  private stack: EditorTransaction[] = [];
  /** 当前已应用的事务下标；-1 = 无 */
  private index = -1;
  private readonly maxSize: number;
  private current: EditorHistoryState;

  constructor(initial: EditorHistoryState, options: EditorHistoryOptions = {}) {
    // 原则 2：构造只接收纯数据，不接收任何 setter / 回调 / context
    this.current = initial;
    this.maxSize = options.maxSize ?? 100;
  }

  // ── 读取 ────────────────────────────────────────────────────────────

  /** 当前状态（浅拷贝：避免调用方误改内部引用；三级对象本身保持引用不变） */
  get state(): EditorHistoryState {
    return {
      document: this.current.document,
      selection: this.current.selection,
      caret: this.current.caret,
    };
  }

  get canUndo(): boolean {
    return this.index >= 0;
  }

  get canRedo(): boolean {
    return this.index < this.stack.length - 1;
  }

  /** 已提交事务数（含 redo 分支中尚未应用的） */
  get size(): number {
    return this.stack.length;
  }

  /** 已应用的事务数（= 可 undo 的步数） */
  get appliedCount(): number {
    return this.index + 1;
  }

  /** 只读事务视图，供调试面板使用（规范 §67） */
  entries(): readonly EditorTransaction[] {
    return this.stack;
  }

  // ── 写入 ────────────────────────────────────────────────────────────

  /**
   * 执行一个 Command 并提交事务。
   *
   * - no-op（command 返回同一 document）→ **不产生 history entry**，version 不变（规范 §5）
   * - 新 commit 会丢弃 redo 分支（标准栈语义）
   */
  commit(command: EditorCommand, next: CommitSelectionInput = {}): CommitResult {
    const before = this.current;
    const document = command.execute(before.document);

    if (document === before.document) {
      return { changed: false, state: this.state, transaction: null };
    }

    // 调用方未给出编辑后的 selection/caret → 从当前快照收敛到新 document
    const after: EditorHistoryState =
      next.selection !== undefined && next.caret !== undefined
        ? { document, selection: next.selection, caret: next.caret }
        : clampSnapshotToDocument(document, {
            document,
            selection: next.selection ?? before.selection,
            caret: next.caret ?? before.caret,
          });

    // 丢弃 redo 分支
    this.stack = this.stack.slice(0, this.index + 1);
    const transaction: EditorTransaction = {
      id: nextId("tx"),
      type: command.type,
      command,
      before,
      after,
    };
    this.stack.push(transaction);
    if (this.stack.length > this.maxSize) this.stack.shift();
    this.index = this.stack.length - 1;
    this.current = after;

    return { changed: true, state: this.state, transaction };
  }

  /**
   * 只更新 selection / caret，**不产生 history entry**。
   *
   * 移动光标、改变选区不是一次"用户编辑操作"，不应占用 undo 步（规范 §46）。
   */
  updateSelection(next: { selection?: EditorSelection; caret?: Caret }): EditorHistoryState {
    this.current = {
      document: this.current.document,
      selection: next.selection ?? this.current.selection,
      caret: next.caret ?? this.current.caret,
    };
    return this.state;
  }

  /** 直接重置状态（新文档加载）；清空历史 */
  reset(state: EditorHistoryState): EditorHistoryState {
    this.current = state;
    this.stack = [];
    this.index = -1;
    return this.state;
  }

  /**
   * **EDITOR-CORE-012-D**：用「命令执行**之后**才可能知道」的 selection / caret
   * 补全**栈顶事务的 `after`**。
   *
   * ── 为什么需要它 ─────────────────────────────────────────────────
   * 插入点无法从输入推导（provenance run 会新建 run；`"\n"` / SplitParagraph 会新建
   * Paragraph，段落 id 由命令内部生成），因此 CORE-009 的顺序只能是
   *
   *     commit(command)              ← 此刻 EditorHistory 固定 transaction.after
   *       ↓ resolveCaretTarget(afterDocument)
   *       ↓ updateSelection(...)     ← 只改 current，**不会回写** transaction.after
   *
   * 结果：`undo` 正确（`before` 每次 commit 都重新读取，是新鲜的），
   * 但 **`redo` 会恢复到 commit 时刻的 clamp 值**，而不是解析出的真实插入点 →
   * 违反 CORE-004「Undo/Redo 同时恢复 Document + Selection + Caret」的契约。
   *
   * ── 语义（严格）──────────────────────────────────────────────────
   *   · 只改栈顶事务的 `after.selection` / `after.caret`
   *   · **不**创建事务、**不**改 `size`、**不**改 `index`、**不**改 `before`、**不**改 `command`
   *   · **不**改 `after.document`（显式取 `latest.after.document`，与"不改变 document"一一对应）
   *   · **不**产生 history entry（与 `updateSelection` 的一致）
   *
   * ── 建立的不变量（012-D 起长期有效）──────────────────────────────
   *     latestTransaction.after.document  === state.document
   *     latestTransaction.after.selection === state.selection   （同一引用）
   *     latestTransaction.after.caret     === state.caret       （同一引用）
   * 即：**History 栈顶事务的 `after` 就是当前 state 的完整可恢复快照。**
   * 实现上令 `after` 与 `current` 指向**同一个对象**，因此该不变量由构造保证，而非约定。
   *
   * ⚠️ 由于事务对象被**替换**（不可变更新），此前从 `commit()` 拿到的 `transaction`
   * 引用已被取代（其 `after` 是旧的）。需要最新快照请读 `entries()` / 本函数返回值。
   */
  finalizeLatestTransaction(
    next: { selection?: EditorSelection; caret?: Caret } = {}
  ): FinalizeResult {
    if (this.index < 0 || this.index >= this.stack.length) {
      return { applied: false, state: this.state, transaction: null };
    }
    const latest = this.stack[this.index];
    const settled: EditorHistoryState = {
      // 显式取 `latest.after.document` —— 本函数"不改变 document"
      document: latest.after.document,
      selection: next.selection ?? this.current.selection,
      caret: next.caret ?? this.current.caret,
    };
    this.current = settled;
    const transaction: EditorTransaction = { ...latest, after: settled };
    this.stack[this.index] = transaction;
    return { applied: true, state: this.state, transaction };
  }

  /** 清空历史但保留当前状态 */
  clear(): void {
    this.stack = [];
    this.index = -1;
  }

  // ── Undo / Redo（原则 3）────────────────────────────────────────────

  /**
   * Undo：Document / Selection / Caret 全部回到 **before**。
   */
  undo(): UndoRedoResult {
    if (this.index < 0) {
      return { applied: false, state: this.state, transaction: null };
    }
    const transaction = this.stack[this.index];
    this.index -= 1;
    this.current = transaction.before;
    return { applied: true, state: this.state, transaction };
  }

  /**
   * Redo：Document / Selection / Caret 全部回到 **after**。
   */
  redo(): UndoRedoResult {
    if (this.index >= this.stack.length - 1) {
      return { applied: false, state: this.state, transaction: null };
    }
    this.index += 1;
    const transaction = this.stack[this.index];
    this.current = transaction.after;
    return { applied: true, state: this.state, transaction };
  }
}

export function createEditorHistory(
  initial: EditorHistoryState,
  options?: EditorHistoryOptions
): EditorHistory {
  return new EditorHistory(initial, options);
}
