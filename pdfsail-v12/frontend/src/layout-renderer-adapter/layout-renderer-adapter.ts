/**
 * layout-renderer-adapter.ts — LayoutRendererAdapter（Sprint-64）
 *
 * 目的：把 Layout（Layer 3）转换为旧 Renderer 认识的 Render Command（DrawGlyphCommand）。
 * 旧 Renderer 完全不动；本 Adapter 是 Renderer 前的数据适配层。
 *
 * 数据流：
 *   Semantic (Run) + Layout (LayoutRun)
 *        ↓
 *   LayoutRendererAdapter
 *        ↓
 *   DrawGlyphCommand[]
 *        ↓
 *   Renderer（旧，零修改）
 *
 * 职责：
 *   - LayoutGlyph（Position） + Semantic glyph（char/style/bbox）→ DrawGlyphCommand
 *   - 通过 runId / glyphId 引用 Semantic，不复制业务数据
 *
 * Pure Function（ADR-005）：输入 Layout + Semantic，输出 DrawGlyphCommand[]。
 * 不依赖 DOM / Canvas / Renderer。
 *
 * 第一版（Happy Path）：只处理 drawGlyph。
 */

import type { LayoutDocument, LayoutGlyph } from "../layout-model-v2/layout-model";
import type { SemanticDocumentV2 } from "../document-model-v2/semantic-run";
import type { RenderContext, RenderCoverage } from "../render-context/render-context";

/** Adapter 输入：Layout + Semantic（Adapter 通过引用取 Semantic 数据） */
export interface LayoutRenderAdapterInput {
  layout: LayoutDocument;
  semantic: SemanticDocumentV2;
}

/** Adapter 输出：兼容旧 Renderer 的 DrawGlyphCommand */
export interface AdaptedGlyphCommand {
  type: "drawGlyph";
  char: string;
  x: number;
  y: number;
  width: number;
  height: number;
  styleRef: number;
  blockId: string;
  lineId: string;
  modified: boolean;
  baseline?: number;
}

/** 构建索引：semanticId → SemanticRun（用于 runId 反查） */
function buildRunIndex(semantic: SemanticDocumentV2): Map<string, { run: any; lineId: string }> {
  const index = new Map<string, { run: any; lineId: string }>();
  for (const page of semantic.pages) {
    for (const para of page.paragraphs) {
      for (const line of para.lines) {
        for (const run of line.runs) {
          index.set(run.id, { run, lineId: line.id });
        }
      }
    }
  }
  return index;
}

/**
 * LayoutGlyph + Semantic Run → DrawGlyphCommand。
 * 通过 glyphId 从 Semantic Run 的 glyphs 取 char / bbox。
 */
function adaptGlyph(
  lg: LayoutGlyph,
  runIndexEntry: { run: any; lineId: string },
): AdaptedGlyphCommand | null {
  const run = runIndexEntry.run;
  // 通过 glyphId 定位语义 glyph（glyphId 格式：`<runId>-glyph-<i>`）
  const glyph = run.glyphs.find((g: any, gi: number) => `${run.id}-glyph-${gi}` === lg.glyphId);
  if (!glyph) return null;
  return {
    type: "drawGlyph",
    char: glyph.char,
    x: lg.x,
    y: lg.y,
    width: glyph.bbox.width,
    height: glyph.bbox.height,
    styleRef: 0,
    blockId: run.sourceId ?? run.id,
    lineId: runIndexEntry.lineId,
    modified: false,
    baseline: lg.baseline,
  };
}

/**
 * 把 LayoutDocument + SemanticDocumentV2 适配为 DrawGlyphCommand[]。
 *
 * @param input Layout + Semantic
 * @returns 兼容旧 Renderer 的 DrawGlyphCommand[]（仅 drawGlyph）
 */
export function adaptLayoutToRenderCommands(input: LayoutRenderAdapterInput): AdaptedGlyphCommand[] {
  const { layout, semantic } = input;
  const runIndex = buildRunIndex(semantic);
  const commands: AdaptedGlyphCommand[] = [];

  for (const page of layout.pages) {
    for (const para of page.paragraphs) {
      for (const line of para.lines) {
        for (const run of line.runs) {
          const sem = runIndex.get(run.runId);
          if (!sem) continue;
          for (const lg of run.glyphs) {
            const cmd = adaptGlyph(lg, sem);
            if (cmd) commands.push(cmd);
          }
        }
      }
    }
  }

  return commands;
}

/**
 * 把 run 的 visualCoverage 解析为 RenderCoverage。
 *
 * visualCoverageId：Adapter 合成（`<runId>-coverage`）。
 * 注：当前 LayoutRun 无 visualCoverageId 字段（LayoutEstimator 不输出 Coverage，见 ADR-006）。
 * Adapter 通过 runId 反查 Semantic run.visualCoverage，组装成 RenderContext 的 coverage。
 * Renderer 拿到的已是解析结果，不再反查 Semantic。
 */
function resolveRenderCoverage(run: any): RenderCoverage | null {
  const vc = run?.visualCoverage;
  if (!vc || !vc.maskBounds || !vc.patchBounds || !vc.coverageBounds) return null;
  return {
    visualCoverageId: `${run.id}-coverage`,
    maskBounds: vc.maskBounds,
    patchBounds: vc.patchBounds,
    coverageBounds: vc.coverageBounds,
    confidence: vc.confidence ?? 0,
  };
}

/**
 * 把 LayoutDocument + SemanticDocumentV2 适配为 RenderContext[]。
 *
 * 这是 Sprint-67 Task-001 的主输出：Renderer 未来唯一消费的输入。
 * 本函数是**新增**路径，保留旧 `adaptLayoutToRenderCommands`（PM Rule-010：
 * 不在同一任务改 Renderer / 删 Legacy；Task-002 才切换 Renderer 消费方）。
 *
 * @param input Layout + Semantic
 * @returns RenderContext[]（Renderer 零修改，Task-001 只建立层）
 */
export function adaptLayoutToRenderContext(input: LayoutRenderAdapterInput): RenderContext[] {
  const { layout, semantic } = input;
  const runIndex = buildRunIndex(semantic);
  const contexts: RenderContext[] = [];

  for (const page of layout.pages) {
    for (const para of page.paragraphs) {
      for (const line of para.lines) {
        for (const run of line.runs) {
          const sem = runIndex.get(run.runId);
          if (!sem) continue;
          // RenderContext 是 coverage 驱动的新路径：无 coverage 的 run 不进入
          // （Builder 保证每个 run 有 visualCoverage；此处为防御性 failsafe）
          const coverage = resolveRenderCoverage(sem.run);
          if (!coverage) continue;
          for (const lg of run.glyphs) {
            const glyph = sem.run.glyphs.find(
              (g: any, gi: number) => `${sem.run.id}-glyph-${gi}` === lg.glyphId,
            );
            if (!glyph) continue;
            const m = sem.run.metrics;
            contexts.push({
              type: "drawGlyph",
              char: glyph.char,
              x: lg.x,
              y: lg.y,
              width: glyph.bbox.width,
              height: glyph.bbox.height,
              baseline: lg.baseline,
              styleRef: 0,
              blockId: sem.run.sourceId ?? sem.run.id,
              lineId: sem.lineId,
              modified: false,
              metrics: {
                fontSize: m.fontSize,
                lineHeight: m.lineHeight,
                baseline: m.baseline,
                ascent: m.ascent,
                descent: m.descent,
                advanceWidth: m.advanceWidth,
                letterSpacing: m.letterSpacing,
              },
              style: sem.run.style ?? {},
              coverage,
            });
          }
        }
      }
    }
  }

  return contexts;
}
