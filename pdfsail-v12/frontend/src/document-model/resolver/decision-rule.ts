/**
 * DecisionRule — Sprint35 · D3-2.5 (Contract Only) + D3-3C.5 修订
 *
 * Rule Engine 的扩展点。冻结 DecisionRule Contract，避免
 * ProcessingDecisionResolver 长成 500 行 switch / if 链。
 *
 * 未来各类规则（SignatureRule / StampRule / QRCodeRule / LogoRule ...）
 * 全部实现本 Contract，而不是写 if(signature) / if(stamp)。
 *
 * 【D3-3C.5 修订】
 *   - Rule 产出独立的 DecisionProposal（type + priority + reasonCode），
 *     不通过 Omit<ProcessingDecision, "id"> 建立类型耦合。
 *   - Decision id 由 Resolver 通过注入的 DecisionIdProvider 生成，
 *     Rule 完全不负责 identity。
 *   - reason 正式命名为 reasonCode（Code，非 Sentence）。
 *
 * 遵循 ADR-010 依赖方向纪律：Definition → Resolver → ...
 * 遵循 ADR-011：Definition 无 Helper Function，Rule 必须 Stateless。
 */

import type { DecisionContext } from "../decision-context";
import type { DecisionPriority, DecisionType } from "../processing-decision";

/**
 * 决策提案（DecisionProposal） — Rule 产出的载荷，不含 identity。
 *
 * 与 ProcessingDecision 是两个职责不同的对象：
 *   - DecisionProposal：Rule 认为"应该做什么"（type + priority + reasonCode）
 *   - ProcessingDecision：Resolver 组装后的最终决策（含 id）
 *
 * 不通过 Omit<> 建立二者关系，避免未来 ProcessingDecision 增加字段时
 * （createdAt / traceId / sourceRule / diagnostics ...）Omit 越来越奇怪。
 */
export interface DecisionProposal {
  /** 决策意图（引擎无关） */
  type: DecisionType;
  /** 语义优先级 */
  priority: DecisionPriority;
  /** 稳定的原因代码（Code，非 Sentence；可用于 i18n / Telemetry） */
  reasonCode: string;
}

/**
 * 决策规则（DecisionRule） — 单一规则的评估契约。
 *
 * 输入：DecisionContext（Domain Facts Bundle）
 * 输出：一条 DecisionProposal（type + priority + reasonCode）；
 *       若该规则不适用，返回 null。
 *
 * Resolver 负责遍历规则、生成 id、组装 ProcessingDecision。
 */
export interface DecisionRule {
  /**
   * 评估当前规则。
   *
   * @param context 决策上下文（Domain Facts Bundle，非 Runtime）
   * @returns 匹配的决策提案；不适用则返回 null
   */
  evaluate(context: DecisionContext): DecisionProposal | null;
}
