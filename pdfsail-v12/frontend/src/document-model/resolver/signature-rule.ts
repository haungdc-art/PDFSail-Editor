/**
 * SignatureRule — Sprint35 · D3-3D（第一条业务 Rule）
 *
 * 验证业务 Rule 能接入 Rule Engine。
 *
 *   VisualObjectType.Signature
 *        ↓
 *   DecisionProposal
 *        ↓
 *   analyze_visual
 *
 * 【最小实现，禁止扩展】
 *   - 不做 Geometry / OCR / Rotation。
 *   - 不做 Runtime / Config / Merge / Pipeline。
 *   - 只证明：Signature 业务 Rule 可插入 Rule Engine 并产出决策。
 *
 * Rule 必须 Stateless（ADR-011）：纯函数，无内部状态。
 */

import type { DecisionContext } from "../decision-context";
import { VisualObjectType } from "../visual-semantic";
import type { DecisionProposal, DecisionRule } from "./decision-rule";

/**
 * SignatureRule 实现。
 *
 * evaluate(context)：
 *   - objectType === Signature → 返回 analyze_visual 提案（第一版仅此，验证接入）
 *   - 否则                       → 返回 null
 */
export const SignatureRule: DecisionRule = {
  evaluate(context: DecisionContext): DecisionProposal | null {
    if (context.semantic.objectType !== VisualObjectType.Signature) {
      return null;
    }
    return {
      type: "analyze_visual",
      priority: "high",
      reasonCode: "signature-requires-visual-analysis",
    };
  },
};
