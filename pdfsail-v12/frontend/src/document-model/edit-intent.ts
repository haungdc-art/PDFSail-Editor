/**
 * EditIntent — 编辑意图（Task-011A）
 *
 * 采用 { capability, payload } 结构，避免未来 kind 爆炸。
 * Tool 表达"调用哪个能力 + 什么参数"，不表达"怎么做"（Mutation）。
 */
import type { CapabilityName } from "./edit-capability";

export interface EditIntent {
  capability: CapabilityName;
  payload?: Record<string, unknown>;
}
