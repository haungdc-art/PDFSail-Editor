/**
 * undo-redo-request.ts — F3B-6.23-C-Impl-1
 *
 * **Canonical Undo/Redo 请求总线**（唯一入口）。
 *
 * ── C0 的结构性裁决 ─────────────────────────────────────────────────
 * 旧架构有两套互不知情的 Undo/Redo：
 *
 *     Toolbar  Undo/Redo ──→ useSelection.CommandHistory（只回退 docBlocks）
 *     Ctrl+Z / Ctrl+Y    ──→ PDFEditor M6-001C（ownership 路由：Core / Legacy）
 *
 * ⇒ 同一次 Ctrl+Z 触发两套 history（6.22-E R2），Toolbar Undo 撤 docBlocks
 *   但 EditableDocument 不回退（撕裂）。
 *
 * C-Impl 后：
 *
 *     Keyboard Ctrl+Z/Y  ─┐
 *                         ├─→ requestUndo / requestRedo（本模块）
 *     Toolbar Undo/Redo ──┘        │
 *                                   ▼
 *                        PDFEditor 的唯一执行器
 *                        decideUndoRedoRoute()
 *                          ┌────┴────┐
 *                        core       legacy
 *                    EditorHistory  OperationHistory
 *
 * ── 职责边界 ────────────────────────────────────────────────────────
 *   · 本模块只做「转发请求 + 广播可用性快照」，**不做任何路由判定**
 *     （路由 = decideUndoRedoRoute，属执行器所在层，因为只有它持有
 *      coreInputSessionRef / OperationHistory / ownership 记账）。
 *   · 零 React / 零 DOM / 零文档访问 —— useSelection（provider 层）与
 *     PDFEditor（editor 层）都只 import 本模块的纯函数。
 *   · 未注册执行器时请求为 no-op（SSR / 编辑器未挂载安全）。
 *
 * ── 可用性快照（Toolbar 的 canUndo/canRedo）─────────────────────────
 * 执行器在两侧栈变化时调用 `notifyUndoRedoAvailability` 广播 `{canUndo,
 * canRedo, owner}`；useSelection 订阅后暴露为 `undoRef`（与旧 CommandHistory
 * 实例同形的只读快照，MainToolbar 的 `undoRef.canUndo` 读取面不变）。
 * 快照语义与 decideUndoRedoRoute 一致：owner = core 时只看 Core 栈
 * （含 no-core-session ⇒ false），绝不显示 Legacy 栈的可用性。
 */

import type { UndoRedoOwner } from "../binding/core-input-history";

/** Toolbar 可读的可用性快照（owner 仅作诊断/测试观测，不参与门控） */
export interface UndoRedoAvailability {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly owner: UndoRedoOwner | null;
}

/** 唯一 Undo/Redo 执行器（由 PDFEditor 注册；doRedo=false ⇒ undo） */
export type UndoRedoExecutor = (doRedo: boolean) => void;

type AvailabilityListener = (availability: UndoRedoAvailability) => void;

// ── 模块级单例（编辑器单实例；重复注册 = 后者覆盖前者）──
let executor: UndoRedoExecutor | null = null;
const availabilityListeners = new Set<AvailabilityListener>();

/** 注册唯一执行器（C-Impl-1：PDFEditor 在挂载后调用） */
export function registerUndoRedoExecutor(next: UndoRedoExecutor): void {
  executor = next;
}

/** 注销执行器（卸载 / 重新注册前；未注册时请求 no-op） */
export function clearUndoRedoExecutor(): void {
  executor = null;
}

/** Canonical undo 请求（Toolbar / 键盘共用；未注册执行器 ⇒ no-op） */
export function requestUndo(): void {
  executor?.(false);
}

/** Canonical redo 请求（Toolbar / 键盘共用） */
export function requestRedo(): void {
  executor?.(true);
}

/** 执行器广播可用性快照（两侧栈 / ownership 变化的唯一出口） */
export function notifyUndoRedoAvailability(availability: UndoRedoAvailability): void {
  for (const listener of availabilityListeners) listener(availability);
}

/** 订阅可用性快照；返回退订函数（useSelection 的 useEffect 用） */
export function subscribeUndoRedoAvailability(listener: AvailabilityListener): () => void {
  availabilityListeners.add(listener);
  return () => {
    availabilityListeners.delete(listener);
  };
}
