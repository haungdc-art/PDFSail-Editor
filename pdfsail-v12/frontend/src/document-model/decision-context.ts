/**
 * DecisionContext — Sprint35 · D3-1.5 (Definition)
 *
 * Processing Decision Resolver 的唯一输入（Domain Facts Bundle）。
 *
 * 为什么需要 Context：
 *   - Resolver 未来不只依赖 VisualSemantic + EngineCapability，
 *     还可能有 layoutFacts / documentFacts / language / pageIndex 等 Domain Facts。
 *   - 若 Resolver 签名直接逐个传参，会随 Facts 增长而不断变长：
 *       resolve(semantic, capability)
 *       resolve(semantic, capability, layout, page, language, ...)
 *   - 引入 DecisionContext 作为统一输入，Resolver Contract 永不因 Facts 增长而修改。
 *
 * 重要：DecisionContext 不是 Runtime。
 *   - 它是【Domain Facts Bundle】，仍属于 Definition 层（ADR-010）。
 *   - 不含 Runtime / Config / FeatureFlag / UserChoice。
 *
 * DecisionContext contains only immutable Domain Facts.
 * Runtime state must never be included.
 * （若加入 Config / FeatureFlag / UserChoice / ABTest / RuntimeState，
 *   DecisionContext 会退化为 ApplicationContext，Domain Layer 立即失效。）
 *
 * 遵循 ADR-011：Definition 无 Helper Function，本文件只有类型定义，零逻辑。
 */

import type { EngineCapability } from "./engine-capability";
import type { VisualSemantic } from "./visual-semantic";

/**
 * 决策上下文（DecisionContext） — Resolver 的唯一输入。
 *
 * 当前只聚合 Semantic + Capability。
 * 未来可扩展（作为 Domain Facts 加入，而非 Runtime）：
 *   layoutFacts / documentFacts / language / pageIndex / pageCount / ...
 */
export interface DecisionContext {
  /** 视觉语义（对象是什么 + 怎么呈现） */
  semantic: VisualSemantic;
  /** 引擎可用能力（Can） */
  capability: EngineCapability;
  // 未来在此追加 Domain Facts，无需修改 Resolver Contract：
  // layout?: LayoutFacts;
  // document?: DocumentFacts;
  // language?: string;
  // pageIndex?: number;
  // pageCount?: number;
}
