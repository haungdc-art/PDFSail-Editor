/**
 * editing-unit-transaction.ts — F3B-6.27 · **P0-D2 · plan → Core transaction 适配（Binding 侧）**
 *
 * ── 职责边界 ────────────────────────────────────────────────────────
 *   Core 的 `UnitTransactionCommand` **不认识** EditingUnit / separator / PDF；
 *   Binding 的 P0-D1 plan **不认识** Core Command。
 *   本模块是**唯一**的转换点（两侧解耦 ⇒ Core 不依赖 Binding）。
 *
 *   EditingUnitMutationPlan ──本模块──▶ UnitTransactionCommand ──▶ EditorHistory
 *          (Binding)                     (Core)                    (1 entry)
 *
 * ── 硬边界 ──────────────────────────────────────────────────────────
 *   · 本阶段**只做转换 + 契约转录**，不接任何生产调用方（P0-E 才接线）
 *   · 转换是**纯映射**（逐 op 结构对位），不做任何 offset 换算/猜测
 *   · `separatorConsumed` 的视觉限制在此**只做转录**，不修复（P0-E 的 reflow 议题）
 */

import {
  UnitTransactionCommand,
  type UnitTransactionOperation,
} from "../core/commands/unit-transaction";
import type { EditingUnitMutationPlan } from "./editing-unit-mutation-plan";

/** P0-D1 的 op → Core 的 operation（结构对位，无换算） */
export function toUnitTransactionOperations(
  plan: EditingUnitMutationPlan
): UnitTransactionOperation[] {
  return plan.operations.map((o) => ({
    textBoxId: o.textBoxId,
    paragraphId: o.paragraphId,
    startUtf16: o.coreStartUtf16,
    endUtf16: o.coreEndUtf16,
    replacement: o.replacement,
  }));
}

/** 转换的**已知限制**（调用方必须能读到，不允许静默） */
export interface UnitTransactionExpectation {
  readonly unitId: string;
  /** Core command 条数（>1 表示一次编辑跨多段） */
  readonly commandCount: number;
  /** 历史边界数（恒为 1 —— 这是 (a) 方案的全部价值） */
  readonly historyBoundaryCount: 1;
  /**
   * true = 本次 transaction **不会**改变 Core 的 visual line 数量
   * （删除换行在 visual-line 粒度下不可表达，见 P0-D1 S3）。
   * 调用方（P0-E）必须据此决定是否需要额外 reflow / 提示。
   */
  readonly visualLineCountPreserved: boolean;
  /** 编辑意图文本（P0-D1 的 afterText） */
  readonly intendedText: string;
  /** Core 侧真实会得到的文本（与 intendedText 可能差 separator） */
  readonly coreProjectionText: string;
}

export interface CreateUnitTransactionOutcome {
  readonly command: UnitTransactionCommand;
  readonly expectation: UnitTransactionExpectation;
}

/**
 * 把 P0-D1 计划包装成一个 Core transaction Command。
 * **不做任何 fail-closed 判断** —— 合法性由 Core 的 preflight 负责并抛错，
 * 这里只做纯转换（保持"唯一真值"：身份与区间在 P0-D1 已定案）。
 */
export function createUnitTransactionCommand(plan: EditingUnitMutationPlan): CreateUnitTransactionOutcome {
  const operations = toUnitTransactionOperations(plan);
  return {
    command: new UnitTransactionCommand(plan.unitId, operations),
    expectation: {
      unitId: plan.unitId,
      commandCount: operations.length,
      historyBoundaryCount: 1,
      // 未 consume separator 时 Core 文本 === 编辑意图；consume 时 Core 仍保留换行
      visualLineCountPreserved: plan.separatorConsumed || !plan.afterText.includes("\n"),
      intendedText: plan.afterText,
      coreProjectionText: plan.coreProjectionMismatch
        ? plan.coreProjectionMismatch.coreProjectionText
        : plan.afterText,
    },
  };
}
