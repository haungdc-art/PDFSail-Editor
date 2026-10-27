/**
 * editor/core/input/selection-navigation.ts — F3B-6.21-G3-C
 *
 * ★ 这是 G3-C 的唯一新增逻辑原语：**把 Shift+Arrow 的 selection mutation 收敛成「既有 Core 原语的组合」**。
 *   **不是**新的 navigation resolver / navigator / adapter（G2 契约明确禁止为导航创造第二套 resolver）。
 *   仅组合：previousPosition / nextPosition（code-point 步进，跨 run/段落，surrogate 安全）
 *           + createSelection + createCaret。
 *
 * 依赖边界（与 core/input barrel 一致）：只允许 ../position、./keyboard；无 DOM / React / layout / history。
 *
 * 状态转换（G2/G3-C 契约，硬性）：
 *   - anchor **永远不**因移动方向重新归一化（反向 selection 在连续 Shift 中保持 anchor 不动）。
 *   - collapsed     → anchor = 当前 caret(==focus)，focus = 移动后的 focus。
 *   - non-collapsed → anchor = 原 anchor，focus = 移动后的 focus（focus 恒为「移动端」）。
 *   - 边界（focus 已到段落首尾 ⇒ previousPosition/nextPosition 返回 null）⇒ 返回 null
 *     （调用方 fail-closed：保留原 selection，不 preventDefault、不构造伪 selection、不回退浏览器原生扩展）。
 *
 * 反向 selection（anchor > focus）保持 anchor 不动、只动 focus —— 数据模型本身允许 anchor/focus 任意顺序
 * （G2-③ 已证明），本原语只是**读取 focus 作为移动端**而非 normalize。
 */

import type { EditorDocument } from "../document/types";
import type { Caret, EditorSelection } from "../position/types";
import { createCaret, createSelection } from "../position/selection";
import { nextPosition, previousPosition } from "./keyboard";

export type SelectionStepDirection = "left" | "right";

/**
 * 计算 Shift+Arrow 后的 Core selection（**不产生** history entry；
 * 调用方负责写 session.history.updateSelection + reconcileDomCaretFromCore）。
 * 返回 null ⇒ 边界 fail-closed（调用方据此保留原 selection）。
 */
export function extendSelectionByCodePoint(
  document: EditorDocument,
  selection: EditorSelection,
  direction: SelectionStepDirection
): { selection: EditorSelection; caret: Caret } | null {
  const anchorPos = selection.range.anchor;
  const focusPos = selection.range.focus;
  const moved =
    direction === "left"
      ? previousPosition(document, focusPos)
      : nextPosition(document, focusPos);
  if (!moved) return null; // ★ 边界 fail-closed：保留原 selection（anchor 不动、focus 不动）
  // ★ 不 normalize：anchor 保持原值，只移动 focus（移动端）
  return {
    selection: createSelection(anchorPos, moved),
    caret: createCaret(moved, "forward"),
  };
}
