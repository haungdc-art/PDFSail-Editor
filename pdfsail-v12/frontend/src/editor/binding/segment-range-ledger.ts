/**
 * editor/binding/segment-range-ledger.ts — F3B-6.27 · Q2（transaction snapshot）
 *
 * 契约文档：cases/F3B-6.27-SegmentRangeOwnership-Contract.md §8
 * 裁决：Q2 = A（range 随 transaction 快照；**range 是状态，不是推导结果**）
 *
 * ── 必须证明的性质（用户明确要求）─────────────────────────────────────
 *   apply(T, R0) = R1
 *   undo(T, R1)  = R0
 *   redo(T, R0)  = R1
 *
 *   而不是只测试「保存了一个 before」。
 *
 * ── 与「重放（replay）」方案的区别 ────────────────────────────────────
 *   重放方案在 undo 时需要「当前 Core → 重新推导 R_prev」，会把
 *   indexOf / glyphBase / text accumulation 重新带回系统（正是要消灭的东西）。
 *   本 ledger 的 undo 是**对象引用级恢复**：current === tx.before（引用相等），
 *   结构性杜绝任何重新推导 —— 该性质由单测用引用相等断言锁定。
 *
 * ── 定位 ────────────────────────────────────────────────────────────────
 *   · 纯函数、无 DOM、无坐标、无文本、无 Core / legacy import（与 ownership 模块同纪律）
 *   · 只做「状态栈 + 快照恢复」，不做任何 ownership 判定（判定在 ownership 模块）
 *   · 当前无任何 production 消费方（接线冻结）
 */

import {
  applySingleSegmentLocalMutation,
  type SegmentRangeOwnership,
  type SingleSegmentLocalMutation,
} from "./segment-range-ownership";

export interface SegmentRangeTransaction {
  readonly id: string;
  /** 该事务**应用后**的 generation（undo 时回落到 before 的 generation） */
  readonly generation: number;
  readonly mutation: SingleSegmentLocalMutation;
  /** 快照：undo 时**原样恢复**（引用相等） */
  readonly before: SegmentRangeOwnership;
  readonly after: SegmentRangeOwnership;
}

export interface SegmentRangeLedger {
  readonly current: SegmentRangeOwnership;
  /** 已应用、可撤销 */
  readonly applied: readonly SegmentRangeTransaction[];
  /** 已撤销、可重做 */
  readonly undone: readonly SegmentRangeTransaction[];
  readonly generation: number;
}

export type LedgerFailure =
  | "mutation-rejected"
  | "no-transaction-to-undo"
  | "no-transaction-to-redo";

export type LedgerOutcome<T> = { readonly ok: true; readonly ledger: T; readonly restored?: SegmentRangeOwnership };

export function createLedger(initial: SegmentRangeOwnership, generation = 0): SegmentRangeLedger {
  return { current: initial, applied: [], undone: [], generation };
}

export function canUndo(ledger: SegmentRangeLedger): boolean {
  return ledger.applied.length > 0;
}

export function canRedo(ledger: SegmentRangeLedger): boolean {
  return ledger.undone.length > 0;
}

/**
 * 应用事务。mutation 被 ownership 层拒绝时 ⇒ **不产生事务、不改 current、不动 generation**
 * （fail-closed：被拒绝的 mutation 不能进入 ledger，否则 undo 会退回到错误状态）。
 */
export function commitTransaction(
  ledger: SegmentRangeLedger,
  mutation: SingleSegmentLocalMutation,
  id = `tx_${ledger.applied.length + ledger.undone.length + 1}`
):
  | { readonly ok: true; readonly ledger: SegmentRangeLedger; readonly transaction: SegmentRangeTransaction }
  | { readonly ok: false; readonly reason: LedgerFailure } {
  const applied = applySingleSegmentLocalMutation(ledger.current, mutation);
  if (!applied.ok) return { ok: false, reason: "mutation-rejected" };
  const transaction: SegmentRangeTransaction = {
    id,
    generation: ledger.generation + 1,
    mutation,
    before: ledger.current,
    after: applied.ownership,
  };
  return {
    ok: true,
    transaction,
    ledger: {
      current: applied.ownership,
      applied: [...ledger.applied, transaction],
      // 新分支：撤销栈作废（与常规 undo/redo 语义一致）
      undone: [],
      generation: ledger.generation + 1,
    },
  };
}

/** undo：**引用级恢复** `tx.before`（不是重新推导） */
export function undoTransaction(ledger: SegmentRangeLedger):
  | { readonly ok: true; readonly ledger: SegmentRangeLedger; readonly restored: SegmentRangeOwnership }
  | { readonly ok: false; readonly reason: LedgerFailure } {
  const last = ledger.applied[ledger.applied.length - 1];
  if (!last) return { ok: false, reason: "no-transaction-to-undo" };
  return {
    ok: true,
    restored: last.before,
    ledger: {
      current: last.before,
      applied: ledger.applied.slice(0, -1),
      undone: [...ledger.undone, last],
      generation: ledger.generation - 1,
    },
  };
}

/** redo：**引用级恢复** `tx.after` */
export function redoTransaction(ledger: SegmentRangeLedger):
  | { readonly ok: true; readonly ledger: SegmentRangeLedger; readonly restored: SegmentRangeOwnership }
  | { readonly ok: false; readonly reason: LedgerFailure } {
  const next = ledger.undone[ledger.undone.length - 1];
  if (!next) return { ok: false, reason: "no-transaction-to-redo" };
  return {
    ok: true,
    restored: next.after,
    ledger: {
      current: next.after,
      applied: [...ledger.applied, next],
      undone: ledger.undone.slice(0, -1),
      generation: ledger.generation + 1,
    },
  };
}
