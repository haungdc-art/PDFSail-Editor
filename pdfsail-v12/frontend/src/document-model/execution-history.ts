/**
 * Execution History — Sprint 11 Task 5
 *
 * 保存 Agent 执行历史，支持 Undo。
 *
 * 每条记录：
 *   - action：执行的操作描述
 *   - before：修改前的 EditableDocument 快照
 *   - after：修改后的 EditableDocument 快照
 *   - timestamp：执行时间
 *   - changes：修改详情
 *
 * 支持：
 *   - record(action, before, after, changes)
 *   - undo() → 回退到上一个状态
 *   - getHistory() → 获取历史记录
 *   - clear() → 清空历史
 */

import type { EditableDocument } from "./types";
import type { SemanticDocument } from "./semantic-types";
import type { PlanExecutionResult } from "./action-plan";

/** 历史记录条目 */
export interface HistoryEntry {
  /** 唯一 ID */
  id: string;
  /** 操作描述 */
  action: string;
  /** 修改前的 EditableDocument（深拷贝快照） */
  before: EditableDocument;
  /** 修改后的 EditableDocument（深拷贝快照） */
  after: EditableDocument;
  /** 修改前的 SemanticDocument（可选） */
  beforeSemantic?: SemanticDocument;
  /** 修改后的 SemanticDocument（可选） */
  afterSemantic?: SemanticDocument;
  /** 执行时间戳 */
  timestamp: number;
  /** 修改详情 */
  changes: PlanExecutionResult["changes"];
  /** 执行结果摘要 */
  summary: string;
}

/** Undo 结果 */
export interface UndoResult {
  /** 是否成功 */
  success: boolean;
  /** 回退到的文档 */
  document: EditableDocument | null;
  /** 回退到的 SemanticDocument（可选） */
  semanticDocument: SemanticDocument | null;
  /** 描述 */
  description: string;
}

/** 深拷贝（避免引用共享） */
function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj));
}

/** ExecutionHistory 类 */
export class ExecutionHistory {
  private history: HistoryEntry[] = [];
  private maxSize: number;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  /**
   * 记录一次执行
   *
   * @param action 操作描述
   * @param before 修改前文档
   * @param after 修改后文档
   * @param changes 修改详情
   * @param summary 摘要
   * @param beforeSem 修改前 SemanticDocument（可选）
   * @param afterSem 修改后 SemanticDocument（可选）
   */
  record(
    action: string,
    before: EditableDocument,
    after: EditableDocument,
    changes: PlanExecutionResult["changes"],
    summary: string,
    beforeSem?: SemanticDocument,
    afterSem?: SemanticDocument
  ): HistoryEntry {
    const entry: HistoryEntry = {
      id: `hist_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      action,
      before: deepClone(before),
      after: deepClone(after),
      beforeSemantic: beforeSem ? deepClone(beforeSem) : undefined,
      afterSemantic: afterSem ? deepClone(afterSem) : undefined,
      timestamp: Date.now(),
      changes,
      summary,
    };

    this.history.push(entry);

    // 超出上限时移除最旧的
    if (this.history.length > this.maxSize) {
      this.history.shift();
    }

    return entry;
  }

  /**
   * 撤销最后一次操作
   *
   * @returns UndoResult（包含回退到的文档）
   */
  undo(): UndoResult {
    if (this.history.length === 0) {
      return {
        success: false,
        document: null,
        semanticDocument: null,
        description: "没有可撤销的操作",
      };
    }

    const lastEntry = this.history.pop()!;
    const restoredDoc = deepClone(lastEntry.before);
    const restoredSem = lastEntry.beforeSemantic
      ? deepClone(lastEntry.beforeSemantic)
      : null;

    return {
      success: true,
      document: restoredDoc,
      semanticDocument: restoredSem,
      description: `已撤销：${lastEntry.action}（${lastEntry.summary}）`,
    };
  }

  /**
   * 获取历史记录
   */
  getHistory(): readonly HistoryEntry[] {
    return this.history;
  }

  /**
   * 获取最近 N 条记录
   */
  getRecent(count: number): HistoryEntry[] {
    return this.history.slice(-count);
  }

  /**
   * 获取最后一条记录
   */
  getLast(): HistoryEntry | null {
    return this.history.length > 0 ? this.history[this.history.length - 1] : null;
  }

  /**
   * 历史记录数量
   */
  get size(): number {
    return this.history.length;
  }

  /**
   * 是否可以撤销
   */
  get canUndo(): boolean {
    return this.history.length > 0;
  }

  /**
   * 清空历史
   */
  clear(): void {
    this.history = [];
  }

  /**
   * 生成历史摘要（人类可读）
   */
  summarize(): string {
    if (this.history.length === 0) return "无执行历史。";

    const lines = this.history.map((entry, i) => {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const changeCount = entry.changes.length;
      return `${i + 1}. [${time}] ${entry.action} (${changeCount} changes) — ${entry.summary}`;
    });

    return `执行历史（${this.history.length} 条）：\n${lines.join("\n")}`;
  }
}

/** 全局 ExecutionHistory 实例 */
let _globalHistory: ExecutionHistory | null = null;

/** 获取全局 ExecutionHistory */
export function getExecutionHistory(): ExecutionHistory {
  if (!_globalHistory) {
    _globalHistory = new ExecutionHistory();
  }
  return _globalHistory;
}
