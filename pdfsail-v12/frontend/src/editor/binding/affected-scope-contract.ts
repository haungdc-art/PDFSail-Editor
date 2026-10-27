/**
 * affected-scope-contract.ts — F3B-6.28 · C1：完整受影响范围契约（纯函数，未接渲染）
 *
 * ── 定位（用户 C 阶段裁决 2026-10-12）────────────────────────────────
 *
 *   消费三方既有成果，**不重新实现段落识别**：
 *     · P0 confirmed 分组（哪些行是同一逻辑段落）
 *     · A 流布局结果（reflow 后的视觉行 + displaced 推进）
 *     · B EditingUnit 来源映射（成员行 ↔ 底层 textBox/paragraph）
 *   输出 = 需要清除（旧字残留区）与重绘（新布局位置）的**全部对象**，
 *   每项可追溯到来源（门槛 5：区分原始内容 / 编辑后内容 / 未受影响内容）。
 *
 * ── 失败纪律（门槛 7）────────────────────────────────────────────────
 *   来源映射缺失 / 几何不完整 ⇒ 该项显式标记 `incomplete`（调用方不得静默
 *   扩大 mask 或猜测清除区域）；任何 unknown 维度都保留在输出里可观测。
 *
 * ── 与渲染的关系 ─────────────────────────────────────────────────────
 *   本契约只回答「**哪些**对象受影响、各自**原位置**与**新位置**」；
 *   如何清除（mask / 白底）与如何重绘（DOM overlay / canvas）是 C2/C3 的
 *   渲染决策，不在本契约内。
 */

import type { EditingUnit } from "./editing-unit";
import type { FlowLayoutResult, FlowVisualLine } from "./logical-paragraph-flow-layout";

export interface ScopeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 受影响对象的角色 */
export type ScopeRole = "unit-member" | "displaced-successor";

/** 一个受影响对象（可追溯到来源） */
export interface AffectedScopeItem {
  readonly role: ScopeRole;
  /** 来源行（unit 成员行 lineId 或被推进的后续行 lineId） */
  readonly sourceLineId: string;
  readonly textBoxId: string | null;
  readonly paragraphId: string | null;
  /** 原始位置（clear 目标；来源 = legacy 行盒 / successor 输入盒） */
  readonly originalRect: ScopeRect | null;
  /** 新位置（redraw 目标；null = 该对象只清除不重绘，如被整体删除的行） */
  readonly targetRect: ScopeRect | null;
  /**
   * 几何不完整标记（门槛 7）：true ⇒ 调用方不得使用本项做清除/重绘决策，
   * 必须显式失败或降级（绝不猜测补位）。
   */
  readonly incomplete: boolean;
  readonly detail: string;
}

export interface AffectedScope {
  readonly ok: true;
  /** 全部受影响对象（unit 成员 + 被推进后续；未受影响内容**不在**其中） */
  readonly items: readonly AffectedScopeItem[];
  /** 便捷视图：全部可用的清除矩形（incomplete 项被排除） */
  readonly clearRects: readonly ScopeRect[];
  /** 便捷视图：全部可用的重绘目标（incomplete 项被排除） */
  readonly redrawItems: readonly AffectedScopeItem[];
  /** true = 无 reflow（delta=0）⇒ scope 退化为仅 unit 成员行 */
  readonly noReflow: boolean;
  readonly warnings: readonly string[];
}

export type AffectedScopeFailure =
  | { readonly ok: false; readonly reason: "flow-not-ok"; readonly detail: string }
  | { readonly ok: false; readonly reason: "empty-unit"; readonly detail: string };

/**
 * 来源 id → 原始行盒（调用方从 legacy bbox / successor 输入提供；缺 ⇒ 该项 incomplete）。
 * 键可以是 unit 成员 lineId，也可以是 displaced 的 textBoxId / paragraphId
 * （lookup 实现需兼容两类键——displaced 项依次按两者查询）。
 */
export type MemberRectLookup = (sourceId: string) => ScopeRect | null;

/**
 * 计算完整受影响范围。
 *
 * @param unit        B 的 EditingUnit（成员 = 底层来源映射）
 * @param flow        A 的流布局结果（必须 ok；非 ok ⇒ fail-closed）
 * @param memberRects 成员行原始行盒查询（legacy bbox——原始事实）
 */
export function computeAffectedScope(
  unit: EditingUnit,
  flow: FlowLayoutResult,
  memberRects: MemberRectLookup,
): AffectedScope | AffectedScopeFailure {
  if (!flow.ok) {
    return { ok: false, reason: "flow-not-ok", detail: `流布局未成功：${flow.reason}` };
  }
  if (unit.lines.length === 0) {
    return { ok: false, reason: "empty-unit", detail: "unit 无成员行" };
  }
  const warnings: string[] = [];
  const items: AffectedScopeItem[] = [];

  // ── ① unit 成员行：clear = 原始行盒；redraw = 该成员文本所在的 flow 视觉行 ──
  for (const member of unit.lines) {
    const orig = memberRects(member.lineId);
    // 该成员的文本区间（unit 坐标）→ 覆盖它的输出视觉行
    // member.startUtf16/endUtf16 是 unit 文本坐标（含 synthetic \n 的行区间）
    const covering = flow.ok
      ? flow.lines.filter((fl: FlowVisualLine) =>
          fl.sources.some(
            (s) => s.lineId === member.lineId && s.textEnd > s.textStart,
          ),
        )
      : [];
    // 成员文本在输出中的首/末行（redraw 目标 = 覆盖行盒的并集）
    let target: ScopeRect | null = null;
    if (covering.length > 0) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const fl of covering) {
        x0 = Math.min(x0, fl.box.x);
        y0 = Math.min(y0, fl.box.y);
        x1 = Math.max(x1, fl.box.x + fl.box.width);
        y1 = Math.max(y1, fl.box.y + fl.box.height);
      }
      target = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    }
    const incomplete = orig === null || target === null;
    if (orig === null) warnings.push(`成员行 ${member.lineId} 缺原始行盒 ⇒ 该项 incomplete（不猜测）`);
    if (target === null) warnings.push(`成员行 ${member.lineId} 无覆盖输出行 ⇒ 该项 incomplete`);
    items.push({
      role: "unit-member",
      sourceLineId: member.lineId,
      textBoxId: member.textBoxId,
      paragraphId: member.paragraphId,
      originalRect: orig,
      targetRect: target,
      incomplete,
      detail: `unit 成员；覆盖输出行 ${covering.map((c) => c.index).join(",") || "无"}`,
    });
  }

  // ── ② 被推进的后续内容：clear = 原始盒；redraw = 原盒平移 delta ──
  const noReflow = flow.metrics.delta === 0;
  if (!noReflow) {
    // successor 的原始盒从 displaced 记录取（A 已带 originalTop；x/width 在
    // FlowSuccessorInput 中但未透传到 displaced ⇒ 需要 memberRects 同源查询）
    for (const d of flow.displaced) {
      // displaced 的原始盒：用 lineId 查（调用方同源提供后续行盒）
      const orig = memberRects(d.textBoxId) ?? memberRects(d.paragraphId);
      const target: ScopeRect | null = orig
        ? { ...orig, y: orig.y + d.delta }
        : null;
      const incomplete = orig === null;
      if (incomplete) warnings.push(`被推进对象 ${d.textBoxId} 缺原始行盒 ⇒ 该项 incomplete（不猜测）`);
      items.push({
        role: "displaced-successor",
        sourceLineId: d.textBoxId,
        textBoxId: d.textBoxId,
        paragraphId: d.paragraphId,
        originalRect: orig,
        targetRect: target,
        incomplete,
        detail: `后续推进 delta=${d.delta.toFixed(2)}`,
      });
    }
  }

  const usable = items.filter((i) => !i.incomplete);
  return {
    ok: true,
    items,
    clearRects: usable.map((i) => i.originalRect!).filter(Boolean),
    redrawItems: usable.filter((i) => i.targetRect !== null),
    noReflow,
    warnings,
  };
}
