/**
 * renderer-registry.ts — RendererRegistry（Sprint-72 Task-001）
 *
 * 目的：把 Dispatcher 从 switch(mode) 改为 Registry 解析，实现 Open/Closed。
 *
 * PM Architecture Decision（Sprint-72）：
 *   以前：Dispatcher switch(mode){ case legacy: ... }
 *   以后：
 *     RendererRegistry.register(name, strategy)
 *     RendererRegistry.resolve(name)
 *     Dispatcher.dispatch()
 *
 *   Dispatcher 只有三行代码，真正的 Open/Closed。
 *   以后增加 Painter / SVG / Canvas / WebGL Strategy，只需 register，不改 Dispatcher。
 *
 * PM Rule-020：Strategy never knows other strategies.
 *   本 Registry 只负责注册与解析，Strategy 之间互不知晓。
 *
 * PM Rule-014：Migration builds compatibility, not replacement.
 *   本任务 **新增** Registry（New Path），Dispatcher 改为走 Registry（可回滚）。
 *
 * 纯数据 + 纯函数（ADR-005）。不依赖 DOM / Canvas / Renderer。
 */

import type { RendererStrategy, RendererStrategyInput, RendererStrategyResult } from "../renderer-dispatcher/renderer-strategy";

/**
 * RendererRegistry — 策略注册表。
 * 提供 register / resolve / has / list。
 */
export interface RendererRegistry {
  /** 注册策略 */
  register(name: string, strategy: RendererStrategy): void;
  /** 按名称解析策略；不存在抛错 */
  resolve(name: string): RendererStrategy;
  /** 是否已注册 */
  has(name: string): boolean;
  /** 已注册的策略名列表 */
  list(): string[];
}

/** 默认 Registry 实现（线程安全，不依赖外部状态） */
export class DefaultRendererRegistry implements RendererRegistry {
  private readonly strategies = new Map<string, RendererStrategy>();

  register(name: string, strategy: RendererStrategy): void {
    this.strategies.set(name, strategy);
  }

  resolve(name: string): RendererStrategy {
    const s = this.strategies.get(name);
    if (!s) {
      throw new Error(`[RendererRegistry] No strategy registered for "${name}"`);
    }
    return s;
  }

  has(name: string): boolean {
    return this.strategies.has(name);
  }

  list(): string[] {
    return [...this.strategies.keys()];
  }
}

/** 便捷：创建并预注册 LegacyRendererStrategy */
export function createDefaultRegistry(
  legacy: RendererStrategy,
  legacyName = "legacy",
): RendererRegistry {
  const registry = new DefaultRendererRegistry();
  registry.register(legacyName, legacy);
  return registry;
}

/**
 * 通过 Registry 解析 Strategy 并渲染。
 * 这是 Dispatcher 的"三行代码"：resolve → render。
 *
 * @param registry 策略注册表
 * @param name 策略名（Feature Flag 决定的）
 * @param input 渲染输入（RenderCommand[] 等）
 * @returns RendererStrategyResult
 */
export function renderWithRegistry(
  registry: RendererRegistry,
  name: string,
  input: RendererStrategyInput,
): RendererStrategyResult {
  const strategy = registry.resolve(name);
  return strategy.render(input);
}
