/**
 * Capability Resolver Engine — Sprint35 · D1
 *
 * 建立 Domain Layer 到 Engine Layer 的第一座桥梁：
 *
 *   VisualSemantic
 *        │
 *        ▼
 *   CapabilityResolver
 *        │
 *        ▼
 *   CapabilityProvider   ← Dependency Inversion
 *        │
 *        ▼
 *   EngineCapability
 *
 * Resolver【只依赖 CapabilityProvider】，不直接依赖具体能力数据源
 * （Matrix / JSON / YAML / Database / Remote Config / Plugin）。
 *
 * 本层【只做 Resolve（查表）】，不包含：
 *   - Runtime / Config / FeatureFlag
 *   - Pipeline / Geometry / OCR / Renderer / Export / React
 *   - 任何业务决策（Need）
 *
 * 只回答：Engine supports...（Can），绝不回答：Need...（Story-2E / D2）。
 */

import type { EngineCapability } from "../engine-capability";
import { DefaultCapabilityProvider, type CapabilityProvider } from "../engine-capability";
import type { VisualSemantic } from "../visual-semantic";

/**
 * Capability Resolver 契约。
 *
 * 任何"Semantic → Capability"的解析器都应实现此接口，
 * 未来可扩展多个 Resolver（Visual / Layout / Semantic / OCR），
 * 名字统一带 Resolver 后缀。
 */
export interface CapabilityResolver {
  /** 根据视觉语义，解析出引擎能力 */
  resolve(semantic: VisualSemantic): EngineCapability;
}

/**
 * 默认 Capability Resolver 实现。
 *
 * 通过注入的 CapabilityProvider 查表，Resolver 自身不含任何能力数据，
 * 也不做任何运行时判断。以 objectType 为 key 查表
 * （CTO 红线：禁止 if(signature) 式复合判断）。
 */
export const DefaultCapabilityResolver: CapabilityResolver = {
  resolve(semantic: VisualSemantic): EngineCapability {
    return capabilityProvider.getCapability(semantic.objectType);
  },
};

/** Resolver 依赖的能力提供者（默认为 DefaultCapabilityProvider，可替换） */
const capabilityProvider: CapabilityProvider = new DefaultCapabilityProvider();

/**
 * 便捷函数：VisualSemantic → EngineCapability。
 *
 * 默认使用 DefaultCapabilityResolver 纯查表实现。
 */
export function resolveCapability(semantic: VisualSemantic): EngineCapability {
  return DefaultCapabilityResolver.resolve(semantic);
}
