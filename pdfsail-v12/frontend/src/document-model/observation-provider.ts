/**
 * observation-provider.ts — Observation Provider Contract（Sprint45 · Order-045A）
 *
 * layer: Core（Sprint45 Architecture Freeze 冻结）
 *
 * 原则（ADR-008）：
 *   Observation SHALL be produced by Providers, not inferred by Validators.
 *
 * 职责分离：
 *   Provider      ：生产 Observation（Importer / pdf.js / OCR / Renderer）
 *   Validation    ：消费 Observation
 *   Semantic Layer：解释 Observation
 *   Alignment     ：关联 Observation
 *
 * 每个 Provider 必须声明"我是怎么看 Document 的"（representation + semanticBoundary）。
 * 以后 Validation 不用猜"为什么不同"，因为 Provider 已声明自己的语义单元。
 */
import type { Observation } from "./observation-model";
import { observeFromDocument, observeFromExtracted } from "./observation-model";
import type { EditableDocument } from "./types";

/** Provider 声明的 Representation */
export interface ProviderRepresentation {
  /** 工具名 */
  tool: string;
  /** Representation 类型（EditableBlock / TextItem / Word / ...） */
  representation: string;
  /** 语义边界（Paragraph / GlyphRun / Word / ...） */
  semanticBoundary: string;
  /** 该 Provider 的语义单元与 Document Semantic Object 的映射说明 */
  mappingNote?: string;
}

/** Observation Provider 接口 */
export interface ObservationProvider {
  readonly id: string;
  /** 声明自己如何观测 Document */
  readonly representation: ProviderRepresentation;
  /** 观测 Document，产生 Observation */
  observe(document: any, documentId: string): Promise<Observation> | Observation;
}

/**
 * Importer Provider：观测 EditableDocument（Representation = EditableBlock，语义边界 = Paragraph）。
 * 注：semanticBoundary 为声明（Hypothesis），实际语义边界由 Semantic Layer 判定（ADR-008）。
 */
export const importerProvider: ObservationProvider = {
  id: "importer",
  representation: {
    tool: "importer",
    representation: "EditableBlock",
    semanticBoundary: "Paragraph",
    mappingNote: "Importer 的 Block 作为 Paragraph 的 Representation（Hypothesis，待 Semantic Mapping 确认）",
  },
  observe(document: EditableDocument, documentId: string): Observation {
    return observeFromDocument(document, documentId);
  },
};

/** pdf.js Provider：观测 pdf.js TextItem（Representation = TextItem，语义边界 = GlyphRun） */
export const pdfjsProvider: ObservationProvider = {
  id: "pdfjs-extract",
  representation: {
    tool: "pdfjs-extract",
    representation: "TextItem",
    semanticBoundary: "GlyphRun",
    mappingNote: "pdf.js 的 TextItem 作为 GlyphRun 的 Representation（Hypothesis，待 Semantic Mapping 确认）",
  },
  observe(raw: { pages: Array<Array<{ text: string }>> }, documentId: string): Observation {
    return observeFromExtracted("pdfjs-extract", raw.pages, documentId);
  },
};

/**
 * OCR Provider：观测 OCR 结果（Representation = Word，语义边界 = Word）。
 * 注：OCR 未接入，仅声明 Provider 契约（observe 待实现）。
 */
export const ocrProvider: ObservationProvider = {
  id: "ocr",
  representation: {
    tool: "ocr",
    representation: "Word",
    semanticBoundary: "Word",
    mappingNote: "OCR 的 Word 作为 Word 的 Representation（OCR 未接入，待实现）",
  },
  observe(_document: any, _documentId: string): Observation {
    throw new Error("OCR Provider not yet implemented");
  },
};

/** 所有已声明的 Provider（供 Validation 消费） */
export const PROVIDERS: ObservationProvider[] = [importerProvider, pdfjsProvider, ocrProvider];

/** 按 id 查 Provider */
export function providerById(id: string): ObservationProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
