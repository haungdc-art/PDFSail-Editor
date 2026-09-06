/**
 * RuleRegistry — Sprint35 · D3-2.6 (Contract Only, 最后一个抽象层)
 *
 * Rule Engine 的规则容器（Dependency Inversion）。
 *
 * 与 CapabilityProvider 完全一致的依赖倒置：
 *   - Resolver 不知道规则来自哪里（Local / Plugin / Medical / Invoice / Enterprise）。
 *   - Resolver 只通过 RuleRegistry 获取规则。
 *
 * 【本阶段只冻结 Contract，不实现。】
 * 无 Default、无数组、无注册逻辑。
 */

import type { DecisionRule } from "./decision-rule";

/**
 * 规则注册表（RuleRegistry） — 提供 DecisionRule 列表的契约。
 *
 * 未来 Local / Plugin / Medical / Invoice / Enterprise 等均可实现本接口，
 * ProcessingDecisionResolver 无需知道规则的具体来源。
 */
export interface RuleRegistry {
  /** 获取规则列表（只读，调用方不得修改） */
  getRules(): readonly DecisionRule[];
}
