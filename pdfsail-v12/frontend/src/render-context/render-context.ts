/**
 * render-context.ts — RenderContext（Sprint-67 Task-001）
 *
 * 目的：建立 Renderer 唯一消费的输入类型。
 *
 * PM Architecture Decision（Sprint-67 修正）：
 *   Semantic Run owns VisualCoverage
 *          ▲
 *          │ ref（visualCoverageId）
 *   LayoutRun
 *          │
 *          ▼
 *   Adapter
 *          │
 *          ▼
 *   RenderContext   ← 本文件
 *          │
 *          ▼
 *   Renderer（只消费 RenderContext，永远不知道 Semantic）
 *
 * 数据流：
 *   Semantic (Run.visualCoverage) + Layout (LayoutRun)
 *        ↓
 *   LayoutRendererAdapter
 *        ↓
 *   RenderContext[]
 *        ↓
 *   Renderer（零修改，未来 Task-002 切换）
 *
 * 关键（PM Rule）：
 *   - Renderer 只消费 RenderContext，不直接依赖 Semantic
 *   - Renderer 禁止 `semantic.find(...)` / `run.visualCoverage` 跨层访问
 *   - RenderContext 持有 visualCoverageId 引用解析结果（Adapter 解析，Renderer 不再解析）
 *   - Ownership 永远属于 Semantic；Layout 只持有引用；RenderContext 是 Adapter 的组装产物
 *
 * PM Rule-010：本任务只建立 RenderContext，不改 Renderer。
 * 纯类型 + 纯构建函数（ADR-005 Pure Function），Immutable（Readonly）。
 */

import type { BBox } from "../document-model/types";

/**
 * Coverage 引用解析结果。
 * RenderContext 持有的是 **解析后** 的 coverage（由 Adapter 从 Semantic 解析），
 * 不是引用本身——Renderer 拿到即可用，不再反查 Semantic。
 *
 * 字段归属（PM 纪律）：
 *   visualCoverageId → Identity（引用，指向 Semantic coverage）
 *   maskBounds       → Geometry（取自 visualCoverage.maskBounds）
 *   patchBounds      → Geometry（取自 visualCoverage.patchBounds）
 *   coverageBounds   → Geometry（取自 visualCoverage.coverageBounds）
 *   confidence       → Semantic（取自 visualCoverage.confidence）
 */
export interface RenderCoverage {
  /** 引用 id（`<runId>-coverage`，指向 Semantic visualCoverage） */
  readonly visualCoverageId: string;
  /** mask 白色矩形（Geometry） */
  readonly maskBounds: BBox;
  /** 背景 patch 范围（Geometry） */
  readonly patchBounds: BBox;
  /** 最终覆盖范围（Geometry，含扩展） */
  readonly coverageBounds: BBox;
  /** 覆盖置信度（Semantic） */
  readonly confidence: number;
}

/**
 * RenderContext — 单个 glyph 的完整渲染上下文。
 * Renderer 从今天开始只消费它。
 *
 * 包含（PM：glyph / coverage / style / metrics / paintData）：
 *   glyph    → 位置 + 字符（来自 LayoutGlyph + Semantic glyph）
 *   coverage → 视觉覆盖解析结果（来自 Semantic visualCoverage，由 Adapter 解析）
 *   style    → 渲染样式（来自 Semantic run.style）
 *   metrics  → 排版度量（来自 Semantic run.metrics）
 *   paintData→ 供旧 Renderer 的兼容数据（char/x/y/width/height/baseline）
 *
 * Immutable：所有字段 Readonly。
 */
export interface RenderContext {
  readonly type: "drawGlyph";
  /** 字符（来自 Semantic glyph.char） */
  readonly char: string;
  /** 字符左上角 x（LayoutGlyph.x，页面 CSS 坐标） */
  readonly x: number;
  /** 字符左上角 y（LayoutGlyph.y，页面 CSS 坐标） */
  readonly y: number;
  /** 字符宽度（Semantic glyph.bbox.width） */
  readonly width: number;
  /** 字符高度（Semantic glyph.bbox.height） */
  readonly height: number;
  /** baseline（LayoutGlyph.baseline，绝对 Y） */
  readonly baseline?: number;
  /** 样式引用（旧 Renderer 兼容，当前为 0） */
  readonly styleRef: number;
  /** block id（run.sourceId ?? run.id） */
  readonly blockId: string;
  /** line id */
  readonly lineId: string;
  /** 是否已修改（旧 Renderer 兼容，当前为 false） */
  readonly modified: boolean;
  /** 排版度量（来自 Semantic run.metrics） */
  readonly metrics: Readonly<{
    readonly fontSize: number;
    readonly lineHeight: number;
    readonly baseline: number;
    readonly ascent: number;
    readonly descent: number;
    readonly advanceWidth: number;
    readonly letterSpacing: number;
  }>;
  /** 渲染样式（来自 Semantic run.style） */
  readonly style: Readonly<Record<string, unknown>>;
  /** 视觉覆盖解析结果（Adapter 解析，Renderer 不再解析） */
  readonly coverage: RenderCoverage;
}
