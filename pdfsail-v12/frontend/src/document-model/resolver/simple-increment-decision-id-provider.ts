/**
 * SimpleIncrementDecisionIdProvider — Sprint35 · D3-3C.5（默认实现）
 *
 * DecisionIdProvider 的简单自增实现（decision-0001, decision-0002 ...）。
 *
 * 仅用于验证骨架；未来可替换为 UUID / Snowflake / Database / Workflow 实现，
 * Resolver 无需改动（Dependency Inversion）。
 *
 * Infrastructure，非 Domain Definition。
 */

import type { DecisionIdProvider } from "./decision-id-provider";

/**
 * 自增 Decision id 提供者。
 *
 * Stateless 的替代实现；本实现带最小内部计数器。
 */
export const SimpleIncrementDecisionIdProvider: DecisionIdProvider = (() => {
  let counter = 0;
  return {
    next(): string {
      counter += 1;
      return `decision-${String(counter).padStart(4, "0")}`;
    },
  };
})();
