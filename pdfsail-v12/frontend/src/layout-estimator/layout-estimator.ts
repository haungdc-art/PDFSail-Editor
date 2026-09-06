/**
 * layout-estimator.ts — LayoutEstimator（Layer 3，Rendering Preparation）
 *
 * Sprint-63 Task-001：Semantic Layout Engine
 *
 * 职责：把 SemanticDocumentV2（Run）转换为 LayoutDocument（LayoutRun）。
 * Renderer 只能消费 LayoutRun，不能自己 measure/layout/baseline/letter-spacing。
 *
 * Pure Function（ADR-005）：输入 SemanticDocumentV2，输出 LayoutDocument。
 * 不依赖 DOM / Canvas / Window / Editor。
 *
 * 第一版（Happy Path）：
 *   - 用 Run.metrics（advanceWidth / lineHeight / baseline / fontSize）计算 glyph 位置
 *   - 用 Run.visualBounds 作为 origin / bounds
 *   - 用 runId / glyphId 引用 Semantic，不复制业务数据
 */

import type { SemanticDocumentV2 } from "../document-model-v2/semantic-run";
import {
  LAYOUT_SCHEMA_VERSION,
} from "../layout-model-v2/layout-model";
import type {
  LayoutDocument,
  LayoutGlyph,
  LayoutRun,
} from "../layout-model-v2/layout-model";

/** 构建选项 */
export interface LayoutEstimateOptions {
  /** 布局文档 id（默认 "layout-<timestamp>"） */
  layoutId?: string;
}

/**
 * 由单个 Semantic Run 估算 LayoutRun。
 *
 * Glyph 位置规则（第一版）：
 *   - glyph.x = origin.x + 累计 advance（advance = metrics.advanceWidth）
 *   - glyph.y = origin.y
 *   - glyph.baseline = origin.y + metrics.baseline
 *   - glyph.advance = metrics.advanceWidth
 */
function estimateLayoutRun(
  run: Readonly<{
    id: string;
    text: string;
    glyphs: ReadonlyArray<{ char: string; bbox: { x: number; y: number; width: number; height: number } }>;
    visualBounds: { x: number; y: number; width: number; height: number };
    metrics: { advanceWidth: number; baseline: number; lineHeight: number };
  }>,
  runIndex: number,
  lineX: number,
  lineY: number,
): LayoutRun {
  const metrics = run.metrics;
  const advance = metrics.advanceWidth > 0 ? metrics.advanceWidth : 0;
  let cursorX = lineX;

  const glyphs: LayoutGlyph[] = run.glyphs.map((g, gi) => {
    const glyph: LayoutGlyph = {
      id: `${run.id}-glyph-${gi}`,
      glyphId: `${run.id}-glyph-${gi}`,
      x: cursorX,
      y: lineY,
      advance,
      baseline: lineY + metrics.baseline,
    };
    cursorX += advance;
    return glyph;
  });

  const origin = { x: run.visualBounds.x, y: run.visualBounds.y };
  const baseline = metrics.baseline;

  return {
    id: `${run.id}-layout`,
    runId: run.id,
    glyphs,
    baseline,
    origin,
    bounds: { ...run.visualBounds },
  };
}

/**
 * 由 SemanticDocumentV2 估算 LayoutDocument。
 *
 * @param semantic 语义文档（Layer 2）
 * @param options 选项
 * @returns LayoutDocument（Layer 3，Immutable）
 */
export function buildLayoutDocument(
  semantic: SemanticDocumentV2,
  options: LayoutEstimateOptions = {},
): LayoutDocument {
  const layoutId = options.layoutId ?? `layout-${Date.now()}`;

  const pages = semantic.pages.map((page) => {
    const paragraphs = page.paragraphs.map((para) => {
      const lines = para.lines.map((line) => {
        // 行原点 = 第一个 run 的 visualBounds 左上角（第一版）
        const firstRun = line.runs[0];
        const lineX = firstRun ? firstRun.visualBounds.x : 0;
        const lineY = firstRun ? firstRun.visualBounds.y : 0;

        const runs = line.runs.map((run, ri) =>
          estimateLayoutRun(run as any, ri, lineX, lineY),
        );

        return { id: line.id, runs };
      });
      return { id: para.id, lines };
    });
    return { index: page.index, paragraphs };
  });

  return {
    schemaVersion: LAYOUT_SCHEMA_VERSION,
    id: layoutId,
    semanticDocumentId: semantic.id,
    pages,
  };
}

/** 供测试/调试用：单 Run 估算 */
export function estimateLayoutRunFromSemantic(
  run: Readonly<{
    id: string;
    text: string;
    glyphs: ReadonlyArray<{ char: string; bbox: { x: number; y: number; width: number; height: number } }>;
    visualBounds: { x: number; y: number; width: number; height: number };
    metrics: { advanceWidth: number; baseline: number; lineHeight: number };
  }>,
): LayoutRun {
  return estimateLayoutRun(run, 0, run.visualBounds.x, run.visualBounds.y);
}
