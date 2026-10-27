/**
 * F3B-6.4B-P1-1 —— History mutation（undo/redo）后的 **render state 再派生**判据。
 *
 * ── 背景（F3B-6.4B-P1-A 审计结论）──
 *
 *   `editedLines` / `editedLineBoxes` 是 DOM mask（`[data-line-id][data-layer="mask"]`）的
 *   **authoritative state**（owner = `document-model/glyph-renderer.tsx`）。全仓只有两个写入点：
 *
 *     · `markLineEdited`（upsert，PDFEditor）
 *     · 换文档时整体清空
 *
 *   且**没有任何 per-line 删除**，故它们在单个文档生命周期内**单调只增**；
 *   而 `History.undo/redo` 只更新 EditableDocument，对它们**零读零写**
 *   ⇒ undo 后「按编辑后几何」算出的 mask 原样保留 ⇒ **Document 恢复、Render State 不恢复**。
 *
 * ── 修复思路（**再派生**，不是补丁）──
 *
 *   判据来源 = **History 中「仍被应用」的 entry**（`OperationHistory.appliedLineIds()`：
 *   undoStack 内 entry 涉及的 lineId）。undo 会把 entry 从 undoStack 移到 redoStack，
 *   因此该集合天然表达「当前文档状态下**仍然生效**的编辑」。
 *
 *   对**受影响行**重新派生：
 *
 *     · 仍有生效编辑 ⇒ `recompute`：用**当前 document** 重算 box（`markLineEdited` upsert）
 *     · 已无生效编辑 ⇒ `remove`  ：移除该行 render state
 *                                  （**派生结论**，不是「undo 就无条件 delete」；
 *                                    同一行的多次编辑由 `appliedLineIds` 正确区分）
 *
 *   ⚠️ 刻意**不做**的事（P1-1 红线）：
 *     · 不 `clear()` 全部 state（会把「局部失效」扩成「全局重算」）；
 *     · 不无条件 `delete(lineId)`（无法表达「同行多次编辑」）；
 *     · 不改 mask 几何算法（`markLineEdited` 原样复用）；
 *     · 不碰 P2（空行 `pageLineIds` gate）与 P3（`affectedGlyphs`）。
 *
 * ── 已知边界（文档化，本轮不解决）──
 *   · `maxSize`（默认 100）截断会丢弃最旧 entry ⇒ 某行若其编辑已被截断，
 *     `appliedLineIds()` 会**漏判**「仍在编辑」⇒ 该行 render state 会被移除（保守失败方向：
 *     mask 消失 = P2 型 ink leak，而非错误遮盖）；
 *   · 判据是「是否发生过仍生效的编辑 op」，**不是**「内容是否等于原文」
 *     （用户把文本改回原样仍算已编辑）；
 *   · 若某条「标记已编辑」的路径**不 push History**，对该行的 undo/redo 会误判为 remove。
 *
 * 本模块只承载**纯判据**（可单测）；副作用（`markLineEdited` / `setState`）留在 orchestration 层。
 */

/** 对某一受影响行应当执行的 render state 操作 */
export type RenderStateResyncAction =
  /** 该行仍有生效编辑 ⇒ 用当前 document 重新派生 box（markLineEdited upsert） */
  | "recompute"
  /** 该行已无生效编辑（或已不存在于文档）⇒ 移除该行 render state */
  | "remove";

export interface RenderStateResyncInput {
  /** 目标 lineId */
  lineId: string;
  /** 当前（undo/redo 之后）文档中是否仍存在该行 */
  lineExists: boolean;
  /** History 中**仍被应用**（undoStack）的 entry 所涉及的 lineId 集合 */
  appliedLineIds: ReadonlySet<string>;
}

/**
 * 纯判据：给定「是否仍有生效编辑」，决定该行的 render state 应当**重新派生**还是**移除**。
 *
 * 注意解除顺序：`lineExists === false` 优先 ⇒ 不会有孤儿 mask。
 */
export function decideRenderStateResync(input: RenderStateResyncInput): RenderStateResyncAction {
  const { lineId, lineExists, appliedLineIds } = input;
  if (!lineExists) return "remove";
  return appliedLineIds.has(lineId) ? "recompute" : "remove";
}
