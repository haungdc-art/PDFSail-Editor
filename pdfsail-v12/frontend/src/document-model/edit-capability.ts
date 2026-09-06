/**
 * EditCapability — 编辑能力 Command（Task-011A.7 收紧）
 *
 * Registry 返回 Command（而非带 kind 的 Capability）。
 * Command 不知道自己是 Replace/Delete/Rewrite，只知道 execute(selection, payload)。
 * Registry 是纯 IOC：Name → Command 映射，不知道具体命令。
 */
import type { DocumentSelection } from "./document-selection";

/** 能力名称（Intent 层使用；Registry 把 name → Command） */
export type CapabilityName = "replace" | "delete" | "rewrite" | "fixOcr";

/** 能力 Command（自包含执行器，不感知自身能力名） */
export interface CapabilityCommand {
  /**
   * M4-IMPL-002A：契约统一为 DocumentSelection（EditableDocument 的定位契约）。
   * Segment / Glyph 各经 Adapter 规范化成 DocumentSelection 后进入。
   * 不感知用户通过 segment 还是 glyph 选中。
   */
  execute(selection: DocumentSelection, payload?: Record<string, unknown>): Promise<void>;
}
