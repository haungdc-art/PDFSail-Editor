/**
 * editor/binding/production-selection-adapter.ts — F3B-6.17-3C-10S.3A
 *
 * **Production Selection Adapter**（窄契约：把 DOM 选区发布到 canonical sink）。
 *
 * ── 职责（只有一个）──────────────────────────────────────────────────
 *
 *      DOM selection ──▶ CanonicalSelection ──▶ **injected canonical sink**
 *
 * ── 明确不知道什么（3C-10S.3A 边界）──────────────────────────────────
 * 本模块**不**知道、**不**引用：
 *   · `EditTool` / Capability / `ReplaceTextCommand` / `mutateLineText`
 *   · `EditableDocument` / `DocumentSelection` / `DerivedSelection` / `CurrentSelection`
 *   · `currentDerivedSelectionRef` / `MapCurrentSelectionProvider`
 * 它只是**选择来源适配器**：DOM → canonical 语义 → sink。sink 由调用方注入。
 *
 * ── 为什么 sink 是注入的而不是现成的 ─────────────────────────────────
 * 3C-10S.3A 审计结论（见 `cases/F3B-6.17-3C-10S.3A-Production-Sink-Contract-Audit.md`）：
 * 现有生产 sink `currentDerivedSelectionRef` 的类型是 `DerivedSelection` ——
 * 一个**由 TextFlow 派生的 view-model**（`glyphs[].glyphLocalIndex/glyphId` +
 * `boxes` + `startPoint/endPoint`），**不是语义选区**。
 * 把 `CanonicalSelection`（UTF-16）塞进它必须**伪造 glyph index 与几何**
 * （而 UTF-16 → glyph 逆映射在 emoji/ligature 下不安全，3C-9B/10S.1 已定案禁止）。
 *
 * ⇒ canonical sink 需要一个**新的、与 view sink 并列的窄契约**（本模块的注入点）。
 *    该契约的**生产接线**属独立任务（3C-10S.3B），不在本阶段强行改造
 *    `DocumentSelection` / `DerivedSelection` / `EditTool`。
 *
 * ── 禁止事项（守卫锁定）──────────────────────────────────────────────
 *   · 绝不做 `UTF-16 → glyph` 逆映射
 *   · 绝不伪造 `DerivedSelection` / `DocumentSelection`
 *   · 绝不在本模块内调用 Core Command / Legacy mutation
 */

import type { CanonicalSelection } from "./canonical-selection";
import {
  domRangeToCanonicalShadow,
  domSelectionShadow,
  type DomRangeLike,
  type DomShadowDeps,
  type DomShadowResult,
} from "./dom-selection-shadow";

// ─────────────────────────────────────────────────────────────────────
//  Canonical sink 契约（窄；与 view sink `DerivedSelection` 并列，不替代）
// ─────────────────────────────────────────────────────────────────────

/**
 * canonical semantic selection sink。
 *
 * ⚠️ 这是**新契约**，**不**修改 `currentDerivedSelectionRef` 的类型，
 *    **不**替换 `MapCurrentSelectionProvider`。两者的合流属独立任务。
 */
export interface CanonicalSelectionSink {
  /** 发布一次 canonical 语义选区 */
  publish(selection: CanonicalSelection): void;
  /** 选区清空 / 不可解析时调用 */
  clear(): void;
}

export interface ProductionSelectionAdapterDeps extends DomShadowDeps {
  readonly sink: CanonicalSelectionSink;
}

/** 适配器结果：可解析 ⇒ `DomShadowResult`；无选区 ⇒ `no-selection` */
export type ProductionSelectionResult = DomShadowResult | { readonly ok: false; readonly reason: "no-selection" };

// ─────────────────────────────────────────────────────────────────────
//  入口 1：真实 DOM → CanonicalSelection → sink
// ─────────────────────────────────────────────────────────────────────

export interface PublishDomSelectionArgs {
  /** 真实 DOM `Range`；`null` = 选区已清空 */
  readonly range: DomRangeLike | null;
  /** 承载该选区的 segment 元素；`null` = 无法定位 */
  readonly segmentElement: Node | null;
  readonly segmentId: string | null;
}

/**
 * 生产接线动作：把一次 DOM 选区发布到 canonical sink。
 *
 * 语义：
 *   · range 缺失 / segment 缺失 ⇒ `sink.clear()`（选区清空）
 *   · 抽取或 canonical 化失败 ⇒ `sink.clear()`（明确拒绝，绝不 fallback、绝不伪造）
 *   · 成功 ⇒ `sink.publish(canonical)`
 */
export function publishDomSelection(
  args: PublishDomSelectionArgs,
  deps: ProductionSelectionAdapterDeps
): ProductionSelectionResult {
  if (!args.range || !args.segmentElement || !args.segmentId) {
    deps.sink.clear();
    return { ok: false, reason: "no-selection" };
  }

  const result = domRangeToCanonicalShadow({
    range: args.range,
    segmentElement: args.segmentElement,
    segmentId: args.segmentId,
    deps,
  });

  if (result.ok) deps.sink.publish(result.selection);
  else deps.sink.clear();
  return result;
}

// ─────────────────────────────────────────────────────────────────────
//  入口 2：中性输入 → CanonicalSelection → sink（供单元测试 / 无 DOM 环境）
// ─────────────────────────────────────────────────────────────────────

/**
 * 与 `publishDomSelection` 同语义，但直接消费**中性输入**（已抽取的 UTF-16 区间）。
 * 用于无 DOM 环境（单元测试）与已持有 offset 的调用方。
 */
export function publishCanonicalSelection(
  ranges: ReadonlyArray<{ segmentId: string; startOffsetUtf16: number; endOffsetUtf16: number }>,
  deps: ProductionSelectionAdapterDeps
): ProductionSelectionResult {
  if (ranges.length === 0) {
    deps.sink.clear();
    return { ok: false, reason: "no-selection" };
  }
  const result = domSelectionShadow(ranges, deps);
  if (result.ok) deps.sink.publish(result.selection);
  else deps.sink.clear();
  return result;
}
