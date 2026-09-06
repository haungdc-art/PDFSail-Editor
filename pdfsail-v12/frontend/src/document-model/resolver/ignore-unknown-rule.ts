/**
 * IgnoreUnknownRule — Sprint35 · D3-3B（第一条 Rule，冒烟测试）
 *
 * Rule Engine 的第一条规则，作为整条链路的 Smoke Test：
 *
 *   Registry → Rule → Decision → Resolver
 *
 * 刻意选择【零业务 / 零 Geometry / 零 OCR / 零 Rotation】的规则：
 *   - 当对象是 Unknown 时，决策提案为 ignore。
 *
 * 用途：先验证 Rule Engine 骨架已跑通，再引入业务 Rule
 * （D3-3D：SignatureRule / QRCodeRule ...）。
 *
 * Rule 必须 Stateless（ADR-011）：本规则无任何内部状态，纯函数。
 *
 * 职责边界（D3-3C.5 修订）：
 *   - Rule 产出 DecisionProposal（type + priority + reasonCode），不含 id。
 *   - reasonCode 使用稳定 Code，便于 i18n / Telemetry。
 */

import type { DecisionContext } from "../decision-context";
import { VisualObjectType } from "../visual-semantic";
import type { DecisionProposal, DecisionRule } from "./decision-rule";

/**
 * IgnoreUnknownRule 实现。
 *
 * evaluate(context)：
 *   - objectType === Unknown  → 返回 ignore 提案
 *   - 否则                    → 返回 null（本规则不适用）
 */
export const IgnoreUnknownRule: DecisionRule = {
  evaluate(context: DecisionContext): DecisionProposal | null {
    if (context.semantic.objectType !== VisualObjectType.Unknown) {
      return null;
    }
    return {
      type: "ignore",
      priority: "none",
      reasonCode: "unknown-object",
    };
  },
};
