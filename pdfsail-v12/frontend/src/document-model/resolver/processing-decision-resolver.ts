/**
 * ProcessingDecisionResolver — Sprint35 · D3-2 (Contract Only)
 *
 * 【本阶段只冻结 Contract，不实现具体逻辑。】
 *
 * 职责：把 DecisionContext 解析为 ProcessingDecisionList。
 *
 *   DecisionContext
 *     （semantic + capability + 未来 Domain Facts）
 *        │
 *        ▼
 *   ProcessingDecisionList
 *
 * 遵循 ADR-010 依赖方向纪律：
 *   Definition → Resolver → ...
 *
 * 遵循 ADR-011：Definition 无 Helper Function。
 * 本文件是 Resolver Contract，不属于 Definition，不携带任何具体判断逻辑。
 *
 * 禁止在本 Contract 层写 if(signature) / if(stamp) 式业务判断。
 */

import type { DecisionContext } from "../decision-context";
import type { ProcessingDecisionList } from "../processing-decision";

/**
 * Processing Decision Resolver 契约。
 *
 * 输入：DecisionContext（Domain Facts Bundle，唯一输入）。
 * 输出：多值 ProcessingDecisionList（意图列表，引擎无关）。
 *
 * 未来 Facts 增长（layoutFacts / documentFacts / language / pageIndex 等）
 * 只需扩展 DecisionContext 字段，Resolver Contract 无需修改。
 *
 * 具体实现（如何把 Context 映射为 DecisionList）属于后续
 * Implementation 阶段，本 Contract 只定义签名。
 */
export interface ProcessingDecisionResolver {
  /**
   * 解析处理决策。
   *
   * @param context 决策上下文（Domain Facts Bundle，非 Runtime）
   * @returns 处理决策列表（Need，引擎无关意图）
   */
  resolve(context: DecisionContext): ProcessingDecisionList;
}
