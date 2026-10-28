/**
 * engine.ts — Commit 4
 *
 * Command Pattern + History 引擎，替代原 undo-redo.ts 的 snapshot 模式。
 *
 * 设计原则：
 *   - 每个操作封装为 Command（execute / undo），可分类、可合并、可扩展（序列化/协作）
 *   - CommandHistory 是栈式结构，push 时丢弃 redo 分支
 *   - ctx 注入 setDocBlocks，Command 通过 ctx 修改 state，不直接耦合 React
 *   - PatchBlocksCommand 是最通用的 Command（prev/next 都已知）；
 *     未来可派生 AddBlockCommand / RemoveBlockCommand 等细粒度 Command
 *
 * 替代关系：
 *   原 UndoRedo<T>        → CommandHistory
 *   原 push(state)        → push(cmd)（cmd 已 execute 过）
 *   原 undo() → state     → undo() 内部调用 cmd.undo(ctx)
 *   原 redo() → state     → redo() 内部调用 cmd.execute(ctx)
 *
 * Note: prev/next 仍做深拷贝（与原 UndoRedo 行为一致），避免外部突变污染 history。
 */

import type { Block } from "../types";

// ─────────────────────────────────────────────────────────────────────
//  Command 接口
// ─────────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** 应用 blocks 更新到 React state（Command 通过此函数改 state） */
  setDocBlocks: (updater: Block[] | ((prev: Block[]) => Block[])) => void;
}

export interface Command {
  /** 调试/日志用 */
  readonly type: string;
  /** Redo 时调用（首次 push 不调用，因为已 apply） */
  execute(ctx: CommandContext): void;
  /** Undo 时调用 */
  undo(ctx: CommandContext): void;
}

// ─────────────────────────────────────────────────────────────────────
//  Command 接口（保留；CommandHistory 及其内置实现已于 F3B-6.23-C 移除）
// ─────────────────────────────────────────────────────────────────────
