/**
 * DefaultRuleRegistry — Sprint35 · D3-3A（第一份实现）
 *
 * RuleRegistry 的默认实现。
 *
 * 采用 Domain 层统一的 Functional Object 风格：
 *   - const 导出（非 class）
 *   - Stateless（无内部状态，getRules 直接返回）
 *
 * 当前返回空规则数组，让 Resolver 可以先跑通"无规则"场景。
 * 后续按 ADD 节奏逐步加入规则：
 *   D3-3B  加入第一条 Rule（IgnoreUnknownRule，冒烟测试）
 *   D3-3D  加入业务 Rule（SignatureRule / QRCodeRule ...）
 */

import type { RuleRegistry } from "./rule-registry";

/**
 * 默认规则注册表。
 *
 * 当前无规则；未来可替换为 Plugin / Medical / Invoice / Enterprise 等实现，
 * Resolver 无需知道规则来源（Dependency Inversion）。
 */
export const DefaultRuleRegistry: RuleRegistry = {
  getRules() {
    return [];
  },
};
