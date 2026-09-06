/**
 * Semantic Mutation API — Sprint 8 Task 4
 *
 * AI Agent 通过语义层操作文档。
 *
 * 核心 API：
 *   replaceSemanticValue(semanticDoc, objectId, newValue)
 *     → 自动更新 Glyph（通过 sourceGlyphs）
 *     → 自动重新 Render（返回新的 EditableDocument）
 *     → 自动重新 Export（调用方负责导出新文档）
 *
 * 流程：
 *   AI: "把日期改成 2027"
 *     → Semantic Analyzer 找到 DateField（value="03/04/2026"）
 *     → replaceSemanticValue(semDoc, dateFieldId, "03/04/2027")
 *     → 内部调用 mutateLineText 更新对应 glyph
 *     → 返回新的 EditableDocument + 新的 SemanticDocument
 *     → 调用方 setEditableDocument + 重新渲染 + 重新导出
 *
 * 禁止直接修改 DOM。
 */

import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
  EditableGlyph,
} from "./types";
import type {
  SemanticDocument,
  AnySemanticObject,
  DateFieldObject,
  GlyphRef,
} from "./semantic-types";
import { mutateLineText, type MutationResult } from "./document-mutation";
import { analyzeDocument } from "./semantic-analyzer";

/** Semantic Mutation 结果 */
export interface SemanticMutationResult {
  /** 更新后的 EditableDocument */
  document: EditableDocument;
  /** 更新后的 SemanticDocument（重新分析） */
  semanticDocument: SemanticDocument;
  /** 是否实际发生了修改 */
  mutated: boolean;
  /** 被修改的 SemanticObject ID */
  modifiedObjectId: string;
  /** Document Mutation 结果（底层 glyph 变更） */
  glyphMutation: MutationResult;
}

/**
 * 替换 SemanticObject 的值
 *
 * 场景：AI Agent 修改日期（如 "03/04/2026" → "03/04/2027"）
 *
 * 流程：
 *   1. 找到 SemanticObject 的 sourceGlyphs
 *   2. 按 blockId + lineId 分组
 *   3. 对每行调用 mutateLineText，替换对应文本片段
 *   4. 返回新的 EditableDocument
 *   5. 重新分析生成新的 SemanticDocument
 *
 * @param semanticDoc 当前 SemanticDocument
 * @param objectId 目标 SemanticObject ID
 * @param newValue 新值
 * @returns SemanticMutationResult
 */
export function replaceSemanticValue(
  semanticDoc: SemanticDocument,
  objectId: string,
  newValue: string
): SemanticMutationResult {
  const obj = semanticDoc.objects.find((o) => o.id === objectId);

  if (!obj) {
    return {
      document: semanticDoc.document,
      semanticDocument: semanticDoc,
      mutated: false,
      modifiedObjectId: objectId,
      glyphMutation: {
        document: semanticDoc.document,
        mutated: false,
        modifiedGlyphIds: [],
      },
    };
  }

  // 按 (blockId, lineId) 分组 sourceGlyphs
  const grouped = groupGlyphsByLine(obj.sourceGlyphs);

  let currentDoc = semanticDoc.document;
  let totalMutated = false;
  const allModifiedGlyphIds: string[] = [];

  for (const [blockId, lineGroups] of grouped) {
    for (const [lineId, glyphRefs] of lineGroups) {
      // 找到对应的 block 和 line
      const { block, line } = findBlockAndLine(currentDoc, blockId, lineId);
      if (!block || !line) continue;

      // 构建旧行文本
      const oldLineText = line.glyphs.map((g) => g.char).join("");

      // 找到旧值在行中的位置
      const oldValue = extractValueFromGlyphs(line, glyphRefs);
      if (!oldValue) continue;

      const valueStart = oldLineText.indexOf(oldValue);
      if (valueStart === -1) continue;

      // 构建新行文本：替换旧值为新值
      const newLineText =
        oldLineText.substring(0, valueStart) +
        newValue +
        oldLineText.substring(valueStart + oldValue.length);

      // 调用 mutateLineText
      const result = mutateLineText(currentDoc, blockId, lineId, newLineText);
      if (result.mutated) {
        currentDoc = result.document;
        totalMutated = true;
        allModifiedGlyphIds.push(...result.modifiedGlyphIds);
      }
    }
  }

  // 更新 SemanticObject 的 value
  const updatedDoc = updateSemanticObjectValue(currentDoc, obj, newValue);

  // 重新分析生成新的 SemanticDocument
  const newSemanticDoc = analyzeDocument(updatedDoc);

  return {
    document: updatedDoc,
    semanticDocument: newSemanticDoc,
    mutated: totalMutated,
    modifiedObjectId: objectId,
    glyphMutation: {
      document: updatedDoc,
      mutated: totalMutated,
      modifiedGlyphIds: allModifiedGlyphIds,
    },
  };
}

/**
 * 批量替换多个 SemanticObject
 *
 * 场景：AI Agent 一次性修改多个字段
 *
 * @param semanticDoc 当前 SemanticDocument
 * @param replacements [{ objectId, newValue }]
 * @returns SemanticMutationResult（最后一次替换的结果）
 */
export function replaceSemanticValues(
  semanticDoc: SemanticDocument,
  replacements: Array<{ objectId: string; newValue: string }>
): SemanticMutationResult {
  let currentSemDoc = semanticDoc;
  let lastResult: SemanticMutationResult = {
    document: semanticDoc.document,
    semanticDocument: semanticDoc,
    mutated: false,
    modifiedObjectId: "",
    glyphMutation: {
      document: semanticDoc.document,
      mutated: false,
      modifiedGlyphIds: [],
    },
  };

  for (const { objectId, newValue } of replacements) {
    const result = replaceSemanticValue(currentSemDoc, objectId, newValue);
    if (result.mutated) {
      currentSemDoc = result.semanticDocument;
      lastResult = result;
    }
  }

  return lastResult;
}

/**
 * 按标签查找并替换
 *
 * 便捷方法：AI Agent 输入 "date" → "03/04/2027"
 *
 * @param semanticDoc 当前 SemanticDocument
 * @param label 要查找的标签（如 "date"、"name"）
 * @param newValue 新值
 * @returns SemanticMutationResult
 */
export function replaceByLabel(
  semanticDoc: SemanticDocument,
  label: string,
  newValue: string
): SemanticMutationResult {
  const lowerLabel = label.toLowerCase();
  const obj = semanticDoc.objects.find(
    (o) => o.label?.toLowerCase().includes(lowerLabel)
  );

  if (!obj) {
    return {
      document: semanticDoc.document,
      semanticDocument: semanticDoc,
      mutated: false,
      modifiedObjectId: "",
      glyphMutation: {
        document: semanticDoc.document,
        mutated: false,
        modifiedGlyphIds: [],
      },
    };
  }

  return replaceSemanticValue(semanticDoc, obj.id, newValue);
}

/**
 * 按类型查找并替换第一个匹配
 *
 * 便捷方法：replaceByType(semDoc, "dateField", "03/04/2027")
 */
export function replaceByType(
  semanticDoc: SemanticDocument,
  type: AnySemanticObject["type"],
  newValue: string
): SemanticMutationResult {
  const obj = semanticDoc.objects.find((o) => o.type === type);
  if (!obj) {
    return {
      document: semanticDoc.document,
      semanticDocument: semanticDoc,
      mutated: false,
      modifiedObjectId: "",
      glyphMutation: {
        document: semanticDoc.document,
        mutated: false,
        modifiedGlyphIds: [],
      },
    };
  }
  return replaceSemanticValue(semanticDoc, obj.id, newValue);
}

// ── 辅助函数 ──

/**
 * 按 (blockId, lineId) 分组 sourceGlyphs
 */
function groupGlyphsByLine(
  glyphs: GlyphRef[]
): Map<string, Map<string, GlyphRef[]>> {
  const grouped = new Map<string, Map<string, GlyphRef[]>>();

  for (const g of glyphs) {
    if (!grouped.has(g.blockId)) {
      grouped.set(g.blockId, new Map());
    }
    const lineMap = grouped.get(g.blockId)!;
    if (!lineMap.has(g.lineId)) {
      lineMap.set(g.lineId, []);
    }
    lineMap.get(g.lineId)!.push(g);
  }

  return grouped;
}

/**
 * 在 EditableDocument 中查找 block 和 line
 */
function findBlockAndLine(
  doc: EditableDocument,
  blockId: string,
  lineId: string
): { block: EditableBlock | null; line: EditableLine | null } {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.id !== blockId) continue;
      for (const line of block.lines) {
        if (line.id === lineId) {
          return { block, line };
        }
      }
      return { block, line: null };
    }
  }
  return { block: null, line: null };
}

/**
 * 从 glyph refs 提取值（按 glyphIndex 排序后拼接）
 */
function extractValueFromGlyphs(
  line: EditableLine,
  refs: GlyphRef[]
): string {
  const sorted = [...refs].sort((a, b) => a.glyphIndex - b.glyphIndex);
  return sorted.map((r) => line.glyphs[r.glyphIndex]?.char || "").join("");
}

/**
 * 更新 SemanticObject 的 value（在 EditableDocument 层面标记 modified）
 *
 * 注意：EditableDocument 本身不存 SemanticObject，
 * 这里只是确保 glyph.modified 标记正确（mutateLineText 已处理）。
 * SemanticObject 的 value 更新由重新 analyzeDocument 反映。
 */
function updateSemanticObjectValue(
  doc: EditableDocument,
  obj: AnySemanticObject,
  newValue: string
): EditableDocument {
  // DateField 特殊处理：更新 parsedDate
  if (obj.type === "dateField") {
    const dateObj = obj as DateFieldObject;
    const newParsedDate = parseDateSafe(newValue, dateObj.format);
    // parsedDate 会在重新 analyzeDocument 时更新
    // 这里不需要额外操作，因为 analyzeDocument 会重新检测
  }

  // 文档本身已被 mutateLineText 更新，直接返回
  return doc;
}

/**
 * 安全解析日期
 */
function parseDateSafe(dateStr: string, format?: string): string | undefined {
  if (!format) return undefined;
  try {
    const parts = dateStr.split(/[\/\-.]/);
    if (parts.length !== 3) return undefined;

    let day: number, month: number, year: number;

    if (format === "DD/MM/YYYY" || format === "DD-MM-YYYY" || format === "DD.MM.YYYY") {
      day = parseInt(parts[0]);
      month = parseInt(parts[1]);
      year = parseInt(parts[2]);
    } else if (format === "YYYY-MM-DD") {
      year = parseInt(parts[0]);
      month = parseInt(parts[1]);
      day = parseInt(parts[2]);
    } else {
      return undefined;
    }

    if (isNaN(day) || isNaN(month) || isNaN(year)) return undefined;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  } catch {
    return undefined;
  }
}
