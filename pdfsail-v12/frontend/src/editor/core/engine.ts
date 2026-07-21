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
//  CommandHistory
// ─────────────────────────────────────────────────────────────────────

export class CommandHistory {
  private stack: Command[] = [];
  private index = -1;
  private maxSize: number;
  private ctx: CommandContext;

  constructor(ctx: CommandContext, maxSize = 50) {
    this.ctx = ctx;
    this.maxSize = maxSize;
  }

  /** Push 一个已执行的 Command（不再调用 execute） */
  push(cmd: Command) {
    // 丢弃 redo 分支
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(cmd);
    if (this.stack.length > this.maxSize) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  undo(): boolean {
    if (this.index < 0) return false;
    this.stack[this.index].undo(this.ctx);
    this.index--;
    return true;
  }

  redo(): boolean {
    if (this.index >= this.stack.length - 1) return false;
    this.index++;
    this.stack[this.index].execute(this.ctx);
    return true;
  }

  /** 清空 history（用于新文档加载 / handleUpload） */
  clear() {
    this.stack = [];
    this.index = -1;
  }

  get canUndo() {
    return this.index >= 0;
  }

  get canRedo() {
    return this.index < this.stack.length - 1;
  }

  /** 兼容旧 API：当前栈长度（仅调试用） */
  get size() {
    return this.stack.length;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  内置 Command 实现
// ─────────────────────────────────────────────────────────────────────

/**
 * 通用 blocks patch：保存前/后完整 snapshot。
 * 适用于 add / remove / update / OCR 等所有 setBlocks 调用点。
 *
 * 深拷贝 prev/next，避免外部突变污染 history。
 */
export class PatchBlocksCommand implements Command {
  readonly type = "patch-blocks";
  private prev: Block[];
  private next: Block[];

  constructor(prev: Block[], next: Block[]) {
    // 深拷贝（与原 UndoRedo 行为一致）
    this.prev = JSON.parse(JSON.stringify(prev));
    this.next = JSON.parse(JSON.stringify(next));
  }

  execute(ctx: CommandContext) {
    ctx.setDocBlocks(JSON.parse(JSON.stringify(this.next)));
  }

  undo(ctx: CommandContext) {
    ctx.setDocBlocks(JSON.parse(JSON.stringify(this.prev)));
  }
}

/**
 * 批量替换 blocks（用于 OCR / PageOps 等大量替换场景）。
 * 与 PatchBlocksCommand 等价，仅 type 字段不同便于调试。
 */
export class ReplaceBlocksCommand implements Command {
  readonly type = "replace-blocks";
  private prev: Block[];
  private next: Block[];

  constructor(prev: Block[], next: Block[]) {
    this.prev = JSON.parse(JSON.stringify(prev));
    this.next = JSON.parse(JSON.stringify(next));
  }

  execute(ctx: CommandContext) {
    ctx.setDocBlocks(JSON.parse(JSON.stringify(this.next)));
  }

  undo(ctx: CommandContext) {
    ctx.setDocBlocks(JSON.parse(JSON.stringify(this.prev)));
  }
}
