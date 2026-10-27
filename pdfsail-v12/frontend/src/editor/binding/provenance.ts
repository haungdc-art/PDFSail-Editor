/**
 * editor/binding/provenance.ts — EDITOR-CORE-011-B
 *
 * PDF provenance 的**唯一解析入口**。
 *
 * ── 铁律（011-A 已坐实）────────────────────────────────────────────
 * PDF provenance 只能这样取：
 *
 *     runId
 *       ↓
 *     EditorDocument.TextRun.source        ← 唯一允许出现 glyph 索引的地方（§10）
 *       ↓
 *     blockId / lineId / lineIdx / glyph 索引
 *
 * **绝对禁止**：
 *
 *     EditorGlyphBox.blockId  →  PDF provenance     ❌
 *
 * 理由：011-B 把两套语义彻底拆开了 ——
 *   · `EditorGlyphBox` 里的 blockId/lineId 是 **renderer 分组键**（渲染身份）
 *   · `TextRun.source` 里的 blockId/lineId 是 **PDF 写回身份**（provenance）
 * 二者可能**不同值**（例如 generated run 有渲染 id 但没有任何 PDF id）。
 * 沿渲染身份去反推 PDF 身份，会在导出时错误替换原文。
 *
 * ── 依赖边界 ───────────────────────────────────────────────────────
 * 只 import Editor Core（`../core/*`）。不 import React / DOM / PDF / 旧 renderer 实现。
 */

import { allTextBoxes, findTextBox } from "../core/document";
import type {
  EditorDocument,
  Paragraph,
  TextBoxObject,
  TextRun,
  TextSourceBinding,
  TextSourceKind,
} from "../core/document";

/** PDF provenance 的解析结果（**只读快照**，不复制成第二份真相） */
export interface PdfProvenance {
  /** 来源种类：pdf-native / ocr / user / generated */
  kind: TextSourceKind;
  /** document-model `EditableBlock.id`（PDF 侧 block 身份）；无则 null */
  blockId: string | null;
  /** document-model `EditableLine.id`（PDF 侧行身份）；无则 null */
  lineId: string | null;
  /** 行在 block 内的序号（`lineId` 精确匹配失败时的回退定位） */
  lineIdx: number | null;
  /** glyph 索引区间（含）。provenance only，禁止用于 Editor 选区 */
  startGlyphIndex: number | null;
  endGlyphIndex: number | null;
  /** 是否携带完整 glyph 区间 */
  hasGlyphRange: boolean;
  /**
   * 是否为「未被动过的 PDF 原文」= `kind === "pdf-native"` 且带 glyph 区间。
   *
   * 这正是 CORE-003 §25 的修改标记：文本被改动后保留 blockId/lineId
   * 但**清除 glyph 索引**。因此「有 glyph 区间」⇔「原文未被改过」。
   */
  isPristineNative: boolean;
}

/** run 在文档中的位置（用于 need-to-know 的上下文查询） */
export interface RunContext {
  textBox: TextBoxObject;
  paragraph: Paragraph;
  run: TextRun;
}

// ─────────────────────────────────────────────────────────────────────
//  查询
// ─────────────────────────────────────────────────────────────────────

/**
 * 按 runId 解析 PDF provenance。
 *
 * 返回 `null` 表示该 run **没有任何** PDF 来源（例如用户新建内容）——
 * 调用方必须显式处理 null，**不得**用 id 猜一个。
 */
export function resolvePdfProvenance(
  document: EditorDocument,
  runId: string
): PdfProvenance | null {
  const context = findRunContext(document, runId);
  if (!context) return null;
  return provenanceOfBinding(context.run.source);
}

/** 把 `TextSourceBinding` 规范化成解析结果（缺省字段统一为 null） */
export function provenanceOfBinding(
  binding: TextSourceBinding | undefined
): PdfProvenance | null {
  if (!binding || typeof binding.kind !== "string") return null;
  const start = typeof binding.startGlyphIndex === "number" ? binding.startGlyphIndex : null;
  const end = typeof binding.endGlyphIndex === "number" ? binding.endGlyphIndex : null;
  return {
    kind: binding.kind,
    blockId: binding.blockId ?? null,
    lineId: binding.lineId ?? null,
    lineIdx: typeof binding.lineIdx === "number" ? binding.lineIdx : null,
    startGlyphIndex: start,
    endGlyphIndex: end,
    hasGlyphRange: start !== null && end !== null,
    isPristineNative: binding.kind === "pdf-native" && start !== null && end !== null,
  };
}

/** 跨页/跨 TextBox 按 runId 查找 (textBox, paragraph, run) */
export function findRunContext(document: EditorDocument, runId: string): RunContext | null {
  for (const textBox of allTextBoxes(document)) {
    for (const paragraph of textBox.paragraphs) {
      for (const run of paragraph.runs) {
        if (run.id === runId) return { textBox, paragraph, run };
      }
    }
  }
  return null;
}

/**
 * 该 run 是否应被视为「已修改」（供 legacy `EditableGlyph.modified` 等消费方使用）。
 *
 * 规则（由 CORE-003 §25 的标记推导，不是猜测）：
 *   · 无 source                → 已修改（用户/命令新增）
 *   · kind !== "pdf-native"    → 已修改（OCR / user / generated）
 *   · 有 source 但无 glyph 区间 → 已修改（原文被动过，索引已失效被清除）
 *   · 其余                      → 未修改（原文原样保留）
 */
export function isModifiedRun(provenance: PdfProvenance | null): boolean {
  if (!provenance) return true;
  return !provenance.isPristineNative;
}

/** 文档内全部 runId → provenance（调试 / 批量映射用；只读） */
export function collectProvenance(
  document: EditorDocument
): Map<string, PdfProvenance | null> {
  const out = new Map<string, PdfProvenance | null>();
  for (const textBox of allTextBoxes(document)) {
    for (const paragraph of textBox.paragraphs) {
      for (const run of paragraph.runs) {
        out.set(run.id, provenanceOfBinding(run.source));
      }
    }
  }
  return out;
}

/** TextBox 级的 provenance（对象级，粒度低于 run 级） */
export function textBoxProvenance(textBox: TextBoxObject): PdfProvenance | null {
  return provenanceOfBinding(textBox.source);
}

/** 便捷：按 blockId 找 TextBox（供 Binding 反向定位） */
export function findTextBoxByBlockId(
  document: EditorDocument,
  blockId: string
): TextBoxObject | null {
  for (const textBox of allTextBoxes(document)) {
    if (textBox.source?.blockId === blockId) return textBox;
  }
  return null;
}

/** 便捷：按 textBoxId 找 TextBox（转发 Core 查询，保持 binding 侧单一入口） */
export function findTextBoxById(
  document: EditorDocument,
  textBoxId: string
): TextBoxObject | null {
  return findTextBox(document, textBoxId);
}
