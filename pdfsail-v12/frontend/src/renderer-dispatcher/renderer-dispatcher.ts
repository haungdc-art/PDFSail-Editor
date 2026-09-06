/**
 * renderer-dispatcher.ts — RendererDispatcher（Sprint-70 Task-001）
 *
 * 目的：把调度职责从 Renderer 抽离。
 *
 * PM Architecture Decision（Sprint-70）：
 *   真正调用 Painter 的不是 GlyphRenderer，而是 Dispatcher：
 *
 *     for (RenderObject)
 *        ↓
 *     Painter.paint(object)
 *        ↓
 *     DOM
 *
 * 职责拆分：
 *   - RenderObject   → 数据（绘制模型）
 *   - Painter        → 画（只消费，不分配）
 *   - Dispatcher     → 调度（只调度，不创建）
 *   - GlyphRenderer  → React（未来 Migration）
 *
 * PM Rule-016：Painter never allocates RenderObjects。
 * 本 Dispatcher **也绝不创建 RenderObject**——它只接收外部传入的 RenderObject[]，
 * 遍历调度到 Painter。所有 RenderObject 来自 RenderObject Builder（上游）。
 *
 * PM Rule-014：Migration builds compatibility, not replacement。
 *   本任务 **新增** Dispatcher（Prototype Only），**不删** 旧 Renderer。
 *
 * Pure Function（ADR-005）：输入 RenderObject[]，输出 PaintOutput[]。
 * 不依赖 DOM / Canvas / Renderer。
 */

import { paintObject } from "../render-painter/render-painter";
import type { PaintOutput } from "../render-painter/render-painter";
import type { RenderObject } from "../render-object/render-object";
import { createRendererStrategies } from "./renderer-strategy";
import type { RendererStrategy, RendererStrategyInput, RendererStrategyResult } from "./renderer-strategy";
import { createDefaultRegistry, renderWithRegistry } from "../renderer-registry/renderer-registry";
import type { RendererRegistry } from "../renderer-registry/renderer-registry";

/**
 * RendererDispatcher 接口。
 *
 * PM Rule-019：Dispatcher dispatches Renderers, not RenderObjects.
 * Dispatcher 调度 **Renderer**（Strategy），不是 RenderObject。
 *
 * 两种调度：
 *   - dispatch（Sprint-70 Prototype）：RenderObject[] → Painter → PaintOutput[]（未来 Painter 路径）
 *   - dispatchRenderer（Sprint-71）：按 Feature Flag 选择 RendererStrategy → 调度 Renderer
 */
export interface RendererDispatcher {
  /** 调度 RenderObject[] → Painter → PaintOutput[]（未来 Painter 路径，Prototype） */
  dispatch(objects: readonly RenderObject[]): PaintOutput[];
  /** 按 mode 选择 RendererStrategy，调度 Renderer（Sprint-71） */
  dispatchRenderer(
    mode: DispatchMode,
    input: RendererStrategyInput,
    strategies?: { legacy: RendererStrategy },
  ): RendererStrategyResult;
}

/**
 * 调度模式（Feature Flag）。
 *   - "legacy"：默认，走 LegacyRendererStrategy → GlyphRenderer（Pixel 完全一致）
 *   - "painter"：未来，走 PainterRendererStrategy（Sprint-72）
 */
export type DispatchMode = "legacy" | "painter";

/**
 * 默认 Dispatcher 实现（RenderObject → Painter）。
 * 遍历 RenderObject[]，对每个 object 调用 Painter.paint(object)。
 *
 * 注意：
 *   - 本函数**不创建**任何 RenderObject（PM Rule-016）。
 *   - 本函数**不计算**任何 Geometry / Layout（只消费 object 已有的数据）。
 *   - 返回的 PaintOutput[] 供 Renderer 消费。
 *
 * @param objects RenderObject[]（来自 RenderObject Builder / 上游转换）
 * @returns PaintOutput[]
 */
export function dispatchRenderObjects(objects: readonly RenderObject[]): PaintOutput[] {
  const outputs: PaintOutput[] = [];
  for (const object of objects) {
    outputs.push(paintObject(object));
  }
  return outputs;
}

/**
 * 通过 RendererRegistry 解析 Strategy 并调度（Sprint-72）。
 *
 * PM Rule-019：Dispatcher 调度 Renderer（Strategy），不解释 RenderObject。
 * PM Rule-020：Strategy 不知其他 Strategy（由 Dispatcher 经 Registry 选择）。
 * PM Rule-018：Mainline 迁移可回滚。
 *
 * Dispatcher 是"三行代码"：registry.resolve(name) → strategy.render(input)。
 * 不再 switch(mode)（Acceptance ②③）。
 *
 * @param registry 策略注册表（默认只含 legacy）
 * @param name 策略名（Feature Flag 决定）
 * @param input 渲染输入（RenderCommand[] 等）
 * @returns RendererStrategyResult（分派描述，由 React 消费方实例化）
 */
export function dispatchRenderer(
  mode: DispatchMode,
  input: RendererStrategyInput,
  registry?: RendererRegistry,
): RendererStrategyResult {
  // Feature Flag：mode → 实际注册的策略名。
  // painter 尚未注册（Sprint-73），fallback 到已注册的 legacy，保证可回滚（PM Rule-018）。
  const reg = registry ?? createDefaultRegistry(createRendererStrategies().legacy, "legacy");
  const resolvedName = reg.has(mode) ? mode : "legacy";
  return renderWithRegistry(reg, resolvedName, input);
}

/**
 * 显式用 Registry 解析策略并渲染。
 * 这是 Dispatcher 面向未来（Painter/SVG/WebGL）的扩展入口。
 */
export function dispatchWithRegistry(
  registry: RendererRegistry,
  name: string,
  input: RendererStrategyInput,
): RendererStrategyResult {
  return renderWithRegistry(registry, name, input);
}

