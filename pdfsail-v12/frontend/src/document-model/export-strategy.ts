/**
 * export-strategy.ts — Export Strategy（Sprint44-Order-020，ADR-007）
 *
 * 三层架构：
 *   Export Engine（exportEditableDocument）
 *     ↓
 *   Export Strategy（Overlay / Document Rewrite）
 *     ↓
 *   Renderer（writeExportCommandsToPDF，纯渲染，不感知策略）
 *
 * 架构原则：
 *   - Strategy Selection SHALL be based on export requirements, not feature names.
 *   - Strategy SHALL NOT change rendering semantics.（Strategy 只决定 PDF 来源，Renderer 决定绘制）
 *
 * 阶段：Phase B —— needRewrite && rewriteCapable → Document Rewrite，否则 Overlay。
 * 最小实现，不扩展 Export API。
 */
import { PDFDocument } from "pdf-lib";
import type { EditableDocument } from "./types";

/** Export Requirements（requirements 驱动，非 feature names） */
export interface ExportRequirements {
  /** 需要文本层一致（Document Rewrite）—— Replace / Remove / OCR Correction */
  needRewrite?: boolean;
  /** 仅视觉叠加（Overlay）—— Highlight / Signature / Annotation / Compress */
  visualOverlayOnly?: boolean;
}

/**
 * rewriteCapable：文档是否满足 Document Rewrite 前置条件（保守检查）。
 * 不满足 → 回退 Overlay（或由调用方决定）。
 */
export function rewriteCapable(doc: EditableDocument): boolean {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      // 仅支持 Renderer 已支持的对象类型
      if (block.type !== "text" && block.type !== "image") {
        return false;
      }
    }
  }
  return true;
}

/** ExportStrategy 接口：Strategy 唯一负责创建/加载 PDF */
export interface ExportStrategy {
  readonly name: string;
  /** 创建或加载目标 PDF（Strategy 决定 PDF 从哪来） */
  createPdf(originalBytes?: ArrayBuffer): Promise<PDFDocument>;
  /** 该策略是否匹配给定 requirements */
  matches(requirements: ExportRequirements): boolean;
}

/** OverlayExportStrategy：load(originalBytes)，叠加。 */
export class OverlayExportStrategy implements ExportStrategy {
  readonly name = "overlay";

  async createPdf(originalBytes?: ArrayBuffer): Promise<PDFDocument> {
    if (originalBytes) {
      return await PDFDocument.load(originalBytes);
    }
    return await PDFDocument.create();
  }

  matches(requirements: ExportRequirements): boolean {
    return !!requirements.visualOverlayOnly && !requirements.needRewrite;
  }
}

/** RewriteExportStrategy：create()，从 EditableDocument 重建。 */
export class RewriteExportStrategy implements ExportStrategy {
  readonly name = "document-rewrite";

  async createPdf(_originalBytes?: ArrayBuffer): Promise<PDFDocument> {
    const pdf = await PDFDocument.create();
    pdf.addPage([595, 842]);
    return pdf;
  }

  matches(requirements: ExportRequirements): boolean {
    return !!requirements.needRewrite;
  }
}

/**
 * ExportStrategySelector：基于 requirements + rewriteCapable 选择策略。
 * 最小实现，不返回状态对象。
 */
export class ExportStrategySelector {
  private readonly strategies: ExportStrategy[];

  constructor(strategies: ExportStrategy[]) {
    this.strategies = strategies;
  }

  select(requirements: ExportRequirements, doc?: EditableDocument): ExportStrategy {
    // needRewrite && rewriteCapable → Rewrite；否则 Overlay
    if (requirements.needRewrite) {
      const rewrite = this.strategies.find((s) => s.name === "document-rewrite");
      if (rewrite && (!doc || rewriteCapable(doc))) {
        return rewrite;
      }
    }
    const overlay = this.strategies.find((s) => s.name === "overlay") ?? this.strategies[0];
    return overlay;
  }
}

/** 默认 Selector（Overlay + Rewrite） */
export const defaultExportStrategySelector = new ExportStrategySelector([
  new OverlayExportStrategy(),
  new RewriteExportStrategy(),
]);
