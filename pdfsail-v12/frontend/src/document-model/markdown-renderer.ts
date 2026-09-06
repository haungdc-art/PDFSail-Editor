/**
 * MarkdownRenderer — Sprint38 · S38-4C-3（Mutable，Renderer Plugin）
 *
 * 唯一职责：把 RenderDocument 输出为 Markdown RenderArtifact。零计算。
 *
 *   RenderDocument
 *        ↓
 *   MarkdownRenderer（遍历 sections[]，经 SectionRendererRegistry 分发）
 *        ↓
 *   RenderArtifact { type: "markdown", content: string }
 *
 * 【CTO Review】Must Fix
 *   - Renderer 不再 switch(section.type)，只负责遍历。
 *   - SectionRenderer 负责真正渲染。
 *   - 未来新增 HeatmapSection 只需新增 HeatmapSectionRenderer，Renderer 不动。
 */

import type { DashboardRenderer, RendererContext, RenderArtifact } from "./replay-dashboard-model";
import type { RenderDocument } from "./render-document";
import type { SectionRendererRegistry } from "./section-renderer";
import { DefaultMarkdownSectionRendererRegistry } from "./section-renderer";

/** 当前 Renderer 版本（用于 artifact.metadata.rendererVersion） */
export const MARKDOWN_RENDERER_VERSION = "markdown-v1";

/**
 * Markdown Renderer —— 遍历 RenderDocument.sections，经 Registry 分发渲染。
 */
export class MarkdownRenderer implements DashboardRenderer {
  constructor(private readonly registry: SectionRendererRegistry = DefaultMarkdownSectionRendererRegistry) {}

  render(doc: RenderDocument, _context?: RendererContext): RenderArtifact {
    const lines: string[] = [];
    lines.push(`# ${doc.title}`);
    lines.push("");

    for (const section of doc.sections) {
      lines.push(`## ${section.title}`);
      const sectionRenderer = this.registry.resolve(section.type);
      if (sectionRenderer) {
        lines.push(sectionRenderer.render(section));
      } else {
        lines.push(`- _unsupported section type: ${section.type}_`);
      }
      lines.push("");
    }

    return {
      artifactVersion: 1,
      type: "markdown",
      content: lines.join("\n"),
      metadata: {
        generatedAt: new Date().toISOString(),
        rendererVersion: MARKDOWN_RENDERER_VERSION,
        dashboardSchema: 1,
      },
    } as const;
  }
}
