/**
 * DecisionIdProvider — Sprint35 · D3-3C.5（Infrastructure Contract）
 *
 * Decision id 的生成契约（Resolver Infrastructure，非 Domain Definition）。
 *
 * 遵循 Dependency Inversion：Resolver 不自己拼字符串 id，
 * 而是注入 DecisionIdProvider 生成 id。
 *
 * 未来可替换实现：
 *   - SimpleIncrementDecisionIdProvider（默认）
 *   - UUIDDecisionIdProvider
 *   - SnowflakeDecisionIdProvider
 *   - Database / Workflow 生成
 *
 * Resolver 无需改动。
 *
 * 【注意】本 Contract 属于 Resolver Infrastructure，
 * 不是 Business Definition，不违反 Domain Layer 封板原则。
 */

export interface DecisionIdProvider {
  /** 生成下一个 Decision id */
  next(): string;
}
