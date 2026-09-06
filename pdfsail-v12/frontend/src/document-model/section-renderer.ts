/**
 * SectionRenderer — Sprint38 · S38-4C-3（Interface 已 Freeze，实现 Mutable）
 *
 * 把 Renderer 的 `switch(section.type)` 提升为插件机制。
 *
 *   RenderDocument
 *        ↓
 *   RendererRegistry（只遍历 sections[]）
 *        ↓
 *   SectionRenderer（真正渲染单个 section）
 *
 * 【CTO Review】Must Fix
 *   - Renderer 不再 switch(section.type)，只负责遍历，经 Registry 分发给 SectionRenderer。
 *   - 未来新增 HeatmapSection，只需新增 HeatmapSectionRenderer，Framework 不动。
 *   - Renderer 负责遍历；SectionRenderer 负责真正渲染。
 *
 * 【Presentation Composition Rule】
 *   SectionRenderer 必须 Pure + Deterministic + Idempotent + Side-effect free。
 */

import type {
  RenderSection,
  RenderSectionType,
  SummarySectionData,
  QualitySectionData,
  CoverageSectionData,
  RuntimeSectionData,
  RegressionSectionData,
  HistogramSectionData,
} from "./render-document";

/**
 * Section Renderer —— 渲染一个特定类型的 Section（Interface 已 Freeze）。
 */
export interface SectionRenderer<T = unknown> {
  /** 支持的 Section 类型 */
  readonly kind: RenderSectionType;
  /** Renderer 版本（Should 2：日志/Debug 可直接输出，如 "SummaryRenderer v2"） */
  readonly version: string;
  /** 渲染单个 Section，返回该格式下的片段（不包含标题外层结构，由调用方处理） */
  render(section: RenderSection<T>): string;
}

/**
 * Section Renderer Registry —— 按 kind 解析/注册 SectionRenderer（Interface 已 Freeze）。
 *
 * 返回 undefined = 该 kind 无 renderer（调用方可跳过或标注）。
 */
export interface SectionRendererRegistry {
  /** 解析某 kind 的 renderer（undefined = 未注册） */
  resolve(kind: RenderSectionType): SectionRenderer | undefined;
  /** 列出所有已注册 renderer（Should 1：Diagnostic / Capability / Debug UI） */
  list(): readonly SectionRenderer[];
  /** 注册一个 renderer（覆盖同 kind） */
  register(renderer: SectionRenderer): void;
  /** 替换某 kind 的 renderer（热插拔；未注册则新增） */
  replace(kind: RenderSectionType, renderer: SectionRenderer): void;
  /** 注销某 kind 的 renderer */
  unregister(kind: RenderSectionType): void;
}

/**
 * 创建 Section Renderer Registry（Mutable，支持热插拔）。
 *
 * @param renderers 初始注册的 SectionRenderer 列表
 */
export function createSectionRendererRegistry(
  renderers: SectionRenderer[] = [],
): SectionRendererRegistry {
  const byKind = new Map<RenderSectionType, SectionRenderer>();
  for (const r of renderers) {
    byKind.set(r.kind, r);
  }
  return {
    resolve(kind: RenderSectionType): SectionRenderer | undefined {
      return byKind.get(kind);
    },
    list(): readonly SectionRenderer[] {
      return [...byKind.values()];
    },
    register(renderer: SectionRenderer): void {
      byKind.set(renderer.kind, renderer);
    },
    replace(kind: RenderSectionType, renderer: SectionRenderer): void {
      byKind.set(kind, renderer);
    },
    unregister(kind: RenderSectionType): void {
      byKind.delete(kind);
    },
  };
}

function fmt(n: number | null): string {
  if (n === null) return "-";
  return n.toFixed(2);
}

/** Markdown Summary SectionRenderer */
export const MarkdownSummarySectionRenderer: SectionRenderer<SummarySectionData> = {
  kind: "summary",
  version: "1.0",
  render(section) {
    const d = section.data;
    return [
      `- Evidence: ${d.evidenceCount}`,
      `- Replay: ${d.replayCount}`,
      `- Pass Rate: ${fmt(d.passRate)}`,
    ].join("\n");
  },
};

/** Markdown Quality SectionRenderer */
export const MarkdownQualitySectionRenderer: SectionRenderer<QualitySectionData> = {
  kind: "quality",
  version: "1.0",
  render(section) {
    const d = section.data;
    return [
      `- Avg Delta: ${fmt(d.avgDelta)}`,
      `- Median Delta: ${fmt(d.medianDelta)}`,
      `- P95 Delta: ${fmt(d.p95Delta)}`,
    ].join("\n");
  },
};

/** Markdown Coverage SectionRenderer */
export const MarkdownCoverageSectionRenderer: SectionRenderer<CoverageSectionData> = {
  kind: "coverage",
  version: "1.0",
  render(section) {
    const d = section.data;
    return [
      `- Valid Replay: ${d.validReplayCount} / ${d.evidenceCount}`,
      `- Regression Rate: ${fmt(d.regressionRate)}`,
      `- Error Rate: ${fmt(d.errorRate)}`,
      `- Unknown Rate: ${fmt(d.unknownRate)}`,
      `- Improvement Rate: ${fmt(d.improvementRate)}`,
    ].join("\n");
  },
};

/** Markdown Runtime SectionRenderer */
export const MarkdownRuntimeSectionRenderer: SectionRenderer<RuntimeSectionData> = {
  kind: "runtime",
  version: "1.0",
  render(section) {
    const d = section.data;
    return [
      `- Samples: ${d.count}`,
      `- Avg Elapsed: ${fmt(d.avgElapsedMs)}ms`,
      `- Median Elapsed: ${fmt(d.medianElapsedMs)}ms`,
      `- P95 Elapsed: ${fmt(d.p95ElapsedMs)}ms`,
    ].join("\n");
  },
};

/** Markdown Regression SectionRenderer */
export const MarkdownRegressionSectionRenderer: SectionRenderer<RegressionSectionData> = {
  kind: "regression",
  version: "1.0",
  render(section) {
    const d = section.data;
    if (d.items.length === 0) return "- none";
    return d.items
      .map(
        (reg) =>
          `- ${reg.evidenceId}: ${reg.beforeDelta}° → ${reg.afterDelta}° (Δ${reg.regressionDelta}°)`,
      )
      .join("\n");
  },
};

/** Markdown Histogram SectionRenderer */
export const MarkdownHistogramSectionRenderer: SectionRenderer<HistogramSectionData> = {
  kind: "histogram",
  version: "1.0",
  render(section) {
    const d = section.data;
    const lines = d.buckets.map((b) => {
      const label = b.upper === null ? `>=${b.lower}°` : `${b.lower}~${b.upper}°`;
      return `- ${label}: ${b.count}`;
    });
    lines.push(`- (bucket=${d.bucketStrategyId})`);
    return lines.join("\n");
  },
};

/**
 * 默认 Markdown Section Renderer Registry。
 */
export const DefaultMarkdownSectionRendererRegistry: SectionRendererRegistry =
  createSectionRendererRegistry([
    MarkdownSummarySectionRenderer,
    MarkdownQualitySectionRenderer,
    MarkdownCoverageSectionRenderer,
    MarkdownRuntimeSectionRenderer,
    MarkdownRegressionSectionRenderer,
    MarkdownHistogramSectionRenderer,
  ]);
