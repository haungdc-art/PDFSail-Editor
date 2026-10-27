/**
 * editor/binding/canonical-selection-sink.ts — F3B-6.17-3C-10S.3B-1
 *
 * **Canonical Selection Sink / Provider**（纯模块，零 React / 零 DOM / 零副作用）。
 *
 * ── 解决的架构问题 ───────────────────────────────────────────────────
 * 3C-10S.3A 已证明：现有生产 sink `currentDerivedSelectionRef` 的类型是
 * `DerivedSelection`（TextFlow 派生的 **view-model**：`glyphLocalIndex` / `boxes` /
 * `startPoint/endPoint`），**不是语义选区**。把 `CanonicalSelection`（UTF-16）塞进它
 * 必须伪造 glyph index 与几何 —— 而 `UTF-16 → glyph` 逆映射在 emoji / ligature 下
 * 不安全（3C-9B / 3C-10S.1 定案禁止）。
 *
 * ⇒ 建立**并列的第二条 sink**（双轨 Selection Architecture）：
 *
 *     Glyph Selection ─▶ DerivedSelection ─▶ currentDerivedSelectionRef
 *                                            ─▶ MapCurrentSelectionProvider ─▶ Legacy Capability
 *
 *     DOM Selection   ─▶ CanonicalSelection ─▶ **本模块 sink**
 *                                            ─▶ CanonicalSelectionProvider ─▶ Core Capability
 *
 * 两条链**不中途互相转换**（无 glyph ↔ UTF-16 互转）。
 *
 * ── 为什么需要 Provider 抽象（而不是直接暴露 ref）────────────────────
 * 消费方（Core Capability，B-2）只应依赖 `CanonicalSelectionProvider.current()`，
 * 而**不得**直接触碰 `canonicalSelectionRef.current` —— 否则以后 Core 会反向依赖
 * React 组件的 ref 布局细节（UI → Core 反向依赖）。
 *
 * ── 禁止事项（守卫锁定）──────────────────────────────────────────────
 *   · 绝不做 `UTF-16 → glyph` 逆映射
 *   · 绝不伪造 / 修改 `DerivedSelection` / `DocumentSelection`
 *   · 不 import React、不触碰 DOM、不做任何 mutation / 导出
 */

import type { CanonicalSelection } from "./canonical-selection";
import type { CanonicalSelectionSink } from "./production-selection-adapter";

/**
 * 消费侧唯一的 canonical 读入口。
 *
 * ⚠️ Core Capability **只能**通过它读选区；不得引用任何 React ref。
 */
export interface CanonicalSelectionProvider {
  /** 当前 canonical 语义选区；无选区 / 不可解析 ⇒ `null`（已 fail-closed） */
  current(): CanonicalSelection | null;
}

/** sink（写侧）+ provider（读侧）配对；由生产在 PDFEditor 持有一次 */
export interface CanonicalSelectionStore {
  readonly sink: CanonicalSelectionSink;
  readonly provider: CanonicalSelectionProvider;
}

/**
 * 创建一个 canonical selection store。
 *
 * 语义与 `CanonicalSelectionSink` 契约严格一致：
 *   · `publish(selection)` ⇒ `provider.current()` 返回该选区
 *   · `clear()`            ⇒ `provider.current()` 返回 `null`
 *
 * 唯一状态是**一个闭包中的选区变量**：不新增文档状态、不进 History、
 * 不参与 Undo/Redo（选区是 transient 交互状态，不是文档真相）。
 */
export function createCanonicalSelectionStore(): CanonicalSelectionStore {
  let value: CanonicalSelection | null = null;

  const sink: CanonicalSelectionSink = {
    publish(selection: CanonicalSelection): void {
      value = selection;
    },
    clear(): void {
      value = null;
    },
  };

  const provider: CanonicalSelectionProvider = {
    current: () => value,
  };

  return { sink, provider };
}
