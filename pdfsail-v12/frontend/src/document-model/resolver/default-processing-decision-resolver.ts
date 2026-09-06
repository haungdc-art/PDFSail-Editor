/**
 * DefaultProcessingDecisionResolver — Sprint35 · D3-3C（最小闭环）+ D3-3C.5 修订
 *
 * Rule Engine 首次真正跑通：
 *
 *   DecisionContext
 *        ↓
 *   registry.getRules()
 *        ↓
 *   for (rule) evaluate(context) → DecisionProposal
 *        ↓
 *   idProvider.next() → 组装 ProcessingDecision
 *        ↓
 *   ProcessingDecisionList
 *
 * 严格边界（CTO 指示）：只做 rules → evaluate → push。
 * 明确禁止：排序 / Merge / Priority Resolve / 去重 / Conflict Resolve /
 * Execution / Runtime / Pipeline / Geometry / Signature 特判。
 *
 * D3-3C.5 修订：
 *   - Rule 产出 DecisionProposal，Resolver 负责组装 id。
 *   - id 通过注入的 DecisionIdProvider 生成（Dependency Inversion）。
 */

import type { DecisionContext } from "../decision-context";
import type { ProcessingDecisionList } from "../processing-decision";
import type { RuleRegistry } from "./rule-registry";
import { DefaultRuleRegistry } from "./default-rule-registry";
import type { ProcessingDecisionResolver } from "./processing-decision-resolver";
import type { DecisionIdProvider } from "./decision-id-provider";
import { SimpleIncrementDecisionIdProvider } from "./simple-increment-decision-id-provider";

/**
 * 创建默认 Processing Decision Resolver。
 *
 * @param registry    RuleRegistry（默认 DefaultRuleRegistry）
 * @param idProvider  DecisionIdProvider（默认 SimpleIncrement）
 */
export const DefaultProcessingDecisionResolver = (
  registry: RuleRegistry = DefaultRuleRegistry,
  idProvider: DecisionIdProvider = SimpleIncrementDecisionIdProvider,
): ProcessingDecisionResolver => {
  return {
    resolve(context: DecisionContext): ProcessingDecisionList {
      const decisions = [];
      for (const rule of registry.getRules()) {
        const proposal = rule.evaluate(context);
        if (proposal) {
          decisions.push({ ...proposal, id: idProvider.next() });
        }
      }
      return { decisions };
    },
  };
};
