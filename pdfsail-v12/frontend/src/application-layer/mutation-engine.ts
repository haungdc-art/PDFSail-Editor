/**
 * MutationEngine — 唯一 Materializer
 *
 * Sprint36 · TD-002（Immutable Document Mutation）· PR-1 · Commit 2
 *
 * 职责：
 *   - 把 Application 产生的 Mutation[] 应用到 Raw Document，生成布局后的 EditableDocument。
 *   - 唯一 Materializer：Document 的 regionType / layoutMode 只由本 Engine 写入。
 *   - 不知道 OCR / AI / Layout 策略 / Renderer，只知道 Mutation。
 *   - 布局引擎（layoutBlock）在 Materialize 时由本 Engine 调用（不决定布局策略，只执行）。
 *
 * 设计说明：
 *   - 布局与 OCR 邻近匹配（resolvedList）在 OCR Pipeline 循环内实时耦合，
 *     因此 Engine 提供 materializeBlock（逐 block Materialize），供循环内调用。
 *   - apply() 为文档级入口，内部遍历 block 调用 materializeBlock。
 */

import type {
  EditableBlock,
  EditableDocument,
  EditableStyle,
} from "../document-model/types";
import { layoutBlock } from "../document-model/layout-engine";
import { extractLayoutResult } from "../document-model/extract-layout-result";
import type { LayoutResult } from "../document-model/layout-result";
import type { Mutation } from "./mutation";

/** Materialize 上下文（布局所需，由调用方提供） */
export interface MaterializeContext {
  /** 已注册样式（resolver.toArray()，须为实时快照） */
  styles: EditableStyle[];
  /** 页面宽度（CSS px） */
  pageWidth: number;
}

/**
 * 解析某个 block 的 regionType / layoutMode（来自 Mutation，Engine 不自行决策）。
 * Application 须保证每个 block 都有完整的 RegionMutation + LayoutMutation。
 */
function resolveBlockPolicies(
  raw: EditableBlock,
  mutations: Mutation[]
): { regionType?: EditableBlock["regionType"]; layoutMode?: EditableBlock["layoutMode"] } {
  const regionMutation = mutations.find(
    (m): m is Extract<Mutation, { kind: "RegionMutation" }> =>
      m.kind === "RegionMutation" && m.blockId === raw.id
  );
  const layoutMutation = mutations.find(
    (m): m is Extract<Mutation, { kind: "LayoutMutation" }> =>
      m.kind === "LayoutMutation" && m.blockId === raw.id
  );

  const regionType = regionMutation?.regionType;
  // layoutMode：优先 LayoutMutation；缺失时按 regionType 派生（与 LayoutPolicy 约定一致）
  const layoutMode =
    layoutMutation?.layoutMode ??
    (regionType === "paragraph" ? "reconstruct" : "preserve");

  return { regionType, layoutMode };
}

/** MutationEngine — 唯一 Materializer */
export class MutationEngine {
  /**
   * 逐 block Materialize：应用该 block 的 mutation（regionType/layoutMode）+ 布局。
   * 供 OCR Pipeline 循环内调用（保留 resolvedList 邻近匹配的实时性）。
   */
  materializeBlock(
    raw: EditableBlock,
    mutations: Mutation[],
    ctx: MaterializeContext
  ): EditableBlock {
    const { regionType, layoutMode } = resolveBlockPolicies(raw, mutations);
    if (!regionType || !layoutMode) {
      // 缺少 mutation（不应发生）；原样返回 raw，避免错误写入
      return raw;
    }
    // 不可变：raw 不变，生成带业务字段的新 block
    const blockWithMode: EditableBlock = { ...raw, regionType, layoutMode };
    // 布局引擎在 Materialize 时由本 Engine 调用
    return layoutBlock(blockWithMode, layoutMode, ctx.styles, ctx.pageWidth);
  }

  /**
   * 文档级 Materialize：遍历所有 block 应用 mutation + 布局。
   */
  apply(
    rawDoc: EditableDocument,
    mutations: Mutation[],
    ctx: MaterializeContext
  ): EditableDocument {
    const pages = rawDoc.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((raw) => this.materializeBlock(raw, mutations, ctx)),
    }));
    return { ...rawDoc, pages };
  }

  /**
   * 文档级双写 Materialize（Commit 4 · Dual Run）：
   *   - 布局后 EditableDocument（旧路径，Renderer 仍消费此 doc）。
   *   - 提取 LayoutResult（新，从已算好的几何提取，不重新计算）。
   * Renderer 默认仍走旧路径（doc）；LayoutResult 供 Diff 验证与后续切换。
   */
  applyWithLayoutResult(
    rawDoc: EditableDocument,
    mutations: Mutation[],
    ctx: MaterializeContext
  ): { doc: EditableDocument; layoutResult: LayoutResult } {
    const doc = this.apply(rawDoc, mutations, ctx);
    return { doc, layoutResult: extractLayoutResult(doc) };
  }
}

/** 便捷单例 */
export const mutationEngine = new MutationEngine();
