/**
 * observation-semantics.ts — Observation Semantics（Sprint45 · Validation Baseline）
 *
 * ⚠️ STATUS: PROTOTYPE（原型验证，非正式基线）
 *   ARB 决定（ADR-008）：真正稳定的是 Document Semantic Object，
 *   而非工具的 Semantic Unit。本文件定义的只是"工具 Representation 的单元"，
 *   需升级到 ADR-008 的 Document Semantic Layer。
 *
 * 目的：定义"每个工具 Representation 的语义单元"。
 * Identity 建立在 Document Semantic Object 层（ADR-008），而非工具单元层。
 */

/** 语义单元类型 */
export type SemanticUnit =
  | "paragraph"   // 段落（Importer：Paragraph）
  | "textblock"   // 文本块（Importer：TextBlock）
  | "line"        // 行（Importer：Line）
  | "span"        // 跨度（连续样式）
  | "glyphrun"    // 字形串（Glyph Run）
  | "textitem"    // 文本项（pdf.js：TextItem）
  | "word"        // 词（OCR：Word）
  | "chunk";      // 块（pdf.js：Chunk）

/** 某工具的语义单元声明 */
export interface ToolSemantics {
  tool: string;
  /** 该工具输出的最小语义单元 */
  unit: SemanticUnit;
  /** 语义说明 */
  note?: string;
}

/**
 * 各工具默认语义单元（需在 Ground Truth 前确认）。
 * 这是 Hypothesis，非事实——由工具文档/实现确认。
 */
export const DEFAULT_TOOL_SEMANTICS: Record<string, ToolSemantics> = {
  importer: { tool: "importer", unit: "textblock", note: "Importer 的 block，粒度可能跨行（Hypothesis，待确认）" },
  "pdfjs-extract": { tool: "pdfjs-extract", unit: "textitem", note: "pdf.js TextItem（Glyph Run 级，Hypothesis，待确认）" },
  ocr: { tool: "ocr", unit: "word", note: "OCR Word（Hypothesis，待确认）" },
  renderer: { tool: "renderer", unit: "line", note: "Renderer Line（Hypothesis，待确认）" },
  exporter: { tool: "exporter", unit: "textblock", note: "Exporter TextBlock（Hypothesis，待确认）" },
};

/** 语义单元是否可比（属于同一语义层级才可做 Identity 对齐） */
export function semanticallyComparable(a: SemanticUnit, b: SemanticUnit): boolean {
  // 文本类单元（含文本语义）彼此可比；glyph/position 类不参与文本 Identity
  const textLike: SemanticUnit[] = ["paragraph", "textblock", "line", "span", "glyphrun", "textitem", "word", "chunk"];
  return textLike.includes(a) && textLike.includes(b);
}

/**
 * 判断两个工具能否进行文本 Identity 对齐。
 * 若语义单元定义不一致（如 Importer=textblock vs pdfjs=textitem），
 * 需先归一化到同一语义层级（如都折叠到 word 序列），而非直接 Identity。
 */
export function canAlign(aTool: string, bTool: string): { ok: boolean; reason?: string } {
  const a = DEFAULT_TOOL_SEMANTICS[aTool];
  const b = DEFAULT_TOOL_SEMANTICS[bTool];
  if (!a || !b) return { ok: false, reason: `unknown tool semantics: ${aTool}/${bTool}` };
  if (a.unit === b.unit) return { ok: true };
  // 单元不同但仍可比（文本类）——需归一化到 word 序列层
  if (semanticallyComparable(a.unit, b.unit)) {
    return { ok: true, reason: `unit differs (${a.unit} vs ${b.unit}); align at word-sequence level` };
  }
  return { ok: false, reason: `units not comparable (${a.unit} vs ${b.unit})` };
}
