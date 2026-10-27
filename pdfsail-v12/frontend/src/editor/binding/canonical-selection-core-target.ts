/**
 * editor/binding/canonical-selection-core-target.ts — F3B-6.17-3C-10S.3B-2（B-2.1）
 *
 * **Core Entry Contract**（窄契约，纯函数）—— canonical 坐标链的唯一 Core 入口。
 *
 *     CanonicalSelection（blockId + lineId + UTF-16 [start,end)）
 *                ↓           本模块
 *     CoreSelectionTarget（textBoxId + paragraphId + runId + run 内 UTF-16 [start,end)）
 *
 * ── 职责边界（B-2.3 裁决）─────────────────────────────────────────────
 * `Page → Object → TextBox → Paragraph → TextRun` 的 **Core hierarchy 知识全部收敛在本模块**
 * （复用 3C-10S.1 `canonicalToCoreTarget` 的既有规则）。
 * Capability 侧只接收 `CoreSelectionTarget + replacementText`，**不得**自行解析 hierarchy。
 *
 * ── 明确不做什么 ─────────────────────────────────────────────────────
 *   · **不产生任何 Command**（构造命令属 capability Core commit 层，B-2.2）
 *   · **不做** `UTF-16 → glyph` 逆映射（3C-9B / 3C-10S.1 定案禁止）
 *   · **不读** `DocumentSelection` / `DerivedSelection` / `EditTool` / `EditableDocument`
 *   · **不回退** Legacy —— 失败一律 fail-closed（返回 reason，由调用方决定什么都不做）
 *
 * ── 接受范围（与 3C-10S.1 一致，第一阶段）────────────────────────────
 *   接受：同段落、**单一 run**、非空、正序、界内
 *   拒绝：`empty-selection` / `reversed-selection` / `multi-run`（split 后多 run）/
 *         `out-of-bounds` / `core-target-unresolved`
 */

import type { EditorDocument } from "../core/document/types";
import { canonicalToCoreTarget, type CanonicalSelection } from "./canonical-selection";

// ─────────────────────────────────────────────────────────────────────
//  CoreSelectionTarget
// ─────────────────────────────────────────────────────────────────────

/**
 * Core 命令目标：`TextBox → Paragraph → TextRun` + **run 内** UTF-16 半开区间。
 *
 * Capability 只消费本结构 —— 它不需要、也不应知道 `EditorDocument` 的形状。
 */
export interface CoreSelectionTarget {
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly runId: string;
  /** run 内 UTF-16 offset，半开区间 `[start, end)`（与 Core `TextPosition.offset` 同口径） */
  readonly startOffsetUtf16: number;
  readonly endOffsetUtf16: number;
}

/** 拒绝原因（全部 fail-closed；**不**含任何 Legacy fallback 语义） */
export type CanonicalCoreTargetRejection =
  | "empty-selection"
  | "reversed-selection"
  | "multi-run"
  | "out-of-bounds"
  | "core-target-unresolved";

export type CanonicalCoreTargetResult =
  | { readonly ok: true; readonly target: CoreSelectionTarget }
  | { readonly ok: false; readonly reason: CanonicalCoreTargetRejection };

// ─────────────────────────────────────────────────────────────────────
//  CanonicalSelection → CoreSelectionTarget
// ─────────────────────────────────────────────────────────────────────

/**
 * 解析选项。
 *
 * `allowCollapsedInsertion`（3C-10C.3A）：允许**折叠**（`start === end`）区间解析为
 * **零宽 target** —— Core 侧由 `createSegmentCoreCommand` 映射为 `insert-text`（**不是**
 * 空替换）。缺省 `false`：折叠区间保持 fail-closed（3C-10S.3B-2 B-2.1 的锁定语义）。
 *
 * ⚠️ 这是**同一个**解析实现上的开关，**不是**第二套 resolution：
 *    hierarchy 定位（`canonicalToCoreTarget`）/ 越界 / multi-run 判据完全共用。
 */
export interface CanonicalCoreTargetOptions {
  readonly allowCollapsedInsertion?: boolean;
}

/**
 * 把 canonical 语义选区解析为 Core 命令目标。
 *
 * @param selection `CanonicalSelection`（UTF-16，来自 DOM 路径）
 * @param document  当前 Core `EditorDocument`
 * @param options   见 `CanonicalCoreTargetOptions`
 */
export function canonicalSelectionToCoreTarget(
  selection: CanonicalSelection,
  document: EditorDocument,
  options: CanonicalCoreTargetOptions = {}
): CanonicalCoreTargetResult {
  const collapsed = selection.startOffsetUtf16 === selection.endOffsetUtf16;
  // ① 选区自身合法性（顺序先于 hierarchy 解析，避免把非法选区解释成 Core 结构问题）
  if (collapsed && options.allowCollapsedInsertion !== true) {
    return { ok: false, reason: "empty-selection" };
  }
  if (selection.startOffsetUtf16 > selection.endOffsetUtf16) {
    return { ok: false, reason: "reversed-selection" };
  }

  // ② Core hierarchy 解析（规则单一事实来源 = 3C-10S.1 canonicalToCoreTarget）
  const resolved = canonicalToCoreTarget(selection, document);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };

  const t = resolved.target;
  return {
    ok: true,
    target: {
      textBoxId: t.textBoxId,
      paragraphId: t.paragraphId,
      runId: t.runId,
      startOffsetUtf16: t.startOffsetUtf16,
      endOffsetUtf16: t.endOffsetUtf16,
    },
  };
}

/**
 * `CoreSelectionTarget` 是否可安全用于命令构造（防御性判据，供 capability 层守卫）。
 *
 * ⚠️ 它**不**重新解析文档 —— 只做结构自洽检查（正序、非空、非负）。
 */
export function isValidCoreSelectionTarget(target: CoreSelectionTarget): boolean {
  return (
    !!target.textBoxId &&
    !!target.paragraphId &&
    !!target.runId &&
    Number.isInteger(target.startOffsetUtf16) &&
    Number.isInteger(target.endOffsetUtf16) &&
    target.startOffsetUtf16 >= 0 &&
    target.startOffsetUtf16 < target.endOffsetUtf16
  );
}
