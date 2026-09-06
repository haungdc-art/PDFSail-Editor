/**
 * renderer-strategy.ts — RendererStrategy（Sprint-71 Task-001）
 *
 * 目的：把"调度 Renderer"抽象为 Strategy，让 Dispatcher 成为总入口。
 *
 * PM Architecture Decision（Sprint-71，PM Rule-019）：
 *   Dispatcher dispatches Renderers, not RenderObjects.
 *   Dispatcher 是 Strategy 总入口：
 *
 *     PDFCanvas → Dispatcher → if(legacy) LegacyRendererStrategy → GlyphRenderer(RenderCommand)
 *                                else        FutureRenderer
 *
 *   关键：
 *     - Dispatcher 调度 **Renderer**（Strategy），不是 RenderObject。
 *     - RenderObject 是 **Painter** 的数据，不进入 Dispatcher。
 *     - GlyphRenderer **零修改**，仍消费 RenderCommand[]。
 *     - LegacyRendererStrategy 内部调用现有 GlyphRenderer。
 *
 * 本文件：
 *   - 定义 RendererStrategy 接口（render 入口）
 *   - 实现 LegacyRendererStrategy（包装 GlyphRenderer）
 *   - render() 返回分派描述（renderer + props），由未来 React 消费方实例化
 *
 * Pure Function（ADR-005）：输入 RendererStrategyInput，输出 RendererStrategyResult。
 * 不依赖真实 DOM 实例化（Node 可测试）。
 */

import type { RenderCommand } from "../document-model/render-command";
import type { EditableStyle } from "../document-model/types";
import type { GlyphRendererProps } from "../document-model/glyph-renderer";

/** Strategy 输入：与 GlyphRenderer props 对齐（命令 + 样式 + 交互回调） */
export interface RendererStrategyInput {
  readonly commands: readonly RenderCommand[];
  readonly styles: readonly EditableStyle[];
  readonly interactive?: boolean;
  readonly selectedGlyphIds?: ReadonlySet<string>;
  readonly editingBlockId?: string | null;
  readonly blockRotations?: ReadonlyMap<string, number>;
  readonly signatureRegionMap?: ReadonlyMap<string, { regionId: string; rotation: number }>;
  readonly onGlyphClick?: GlyphRendererProps["onGlyphClick"];
  readonly onGlyphSelect?: GlyphRendererProps["onGlyphSelect"];
  readonly onGlyphEdit?: GlyphRendererProps["onGlyphEdit"];
}

/** Strategy 输出：分派描述（renderer 标识 + props），由 React 消费方实例化 */
export interface RendererStrategyResult {
  readonly strategy: string;
  /** 渲染器标识（"glyph-renderer" 等） */
  readonly renderer: string;
  /** 传给渲染器的 props（未来 React 层 <GlyphRenderer {...props} />） */
  readonly props: {
    readonly commands: RenderCommand[];
    readonly styles: EditableStyle[];
    readonly interactive?: boolean;
    readonly selectedGlyphIds?: Set<string>;
    readonly editingBlockId?: string | null;
    readonly blockRotations?: Map<string, number>;
    readonly signatureRegionMap?: Map<string, { regionId: string; rotation: number }>;
    readonly onGlyphClick?: GlyphRendererProps["onGlyphClick"];
    readonly onGlyphSelect?: GlyphRendererProps["onGlyphSelect"];
    readonly onGlyphEdit?: GlyphRendererProps["onGlyphEdit"];
  };
  /** Painter 路径输出（Sprint-73：PainterRendererStrategy 填充，Legacy 不填） */
  readonly paintOutputs?: import("../render-painter/render-painter").PaintOutput[];
  /** Painter 路径的中间 RenderObject（可选，供调试/验证） */
  readonly renderObjects?: readonly import("../render-object/render-object").RenderObject[];
}

/** RendererStrategy 接口（PM Acceptance ①） */
export interface RendererStrategy {
  readonly kind: string;
  render(input: RendererStrategyInput): RendererStrategyResult;
}

/**
 * LegacyRendererStrategy — 内部调用现有 GlyphRenderer（零修改）。
 *
 * render() 返回分派描述，标识 renderer = "glyph-renderer"，并把输入 props 透传给 GlyphRenderer。
 * GlyphRenderer 的渲染逻辑完全不变（PM Acceptance ④）。
 */
export class LegacyRendererStrategy implements RendererStrategy {
  readonly kind = "legacy";

  render(input: RendererStrategyInput): RendererStrategyResult {
    return {
      strategy: "legacy",
      renderer: "glyph-renderer",
      props: {
        commands: [...input.commands],
        styles: [...input.styles],
        interactive: input.interactive,
        selectedGlyphIds: input.selectedGlyphIds ? new Set(input.selectedGlyphIds) : undefined,
        editingBlockId: input.editingBlockId,
        blockRotations: input.blockRotations ? new Map(input.blockRotations) : undefined,
        signatureRegionMap: input.signatureRegionMap ? new Map(input.signatureRegionMap) : undefined,
        onGlyphClick: input.onGlyphClick,
        onGlyphSelect: input.onGlyphSelect,
        onGlyphEdit: input.onGlyphEdit,
      },
    };
  }
}

/** 内置策略注册表（当前只有 Legacy） */
export function createRendererStrategies(): {
  legacy: RendererStrategy;
} {
  return { legacy: new LegacyRendererStrategy() };
}
