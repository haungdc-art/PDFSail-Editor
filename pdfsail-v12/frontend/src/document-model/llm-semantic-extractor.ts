/**
 * LLM Semantic Extractor — Sprint 9 Task 2
 *
 * 调用后端 /api/llm/extract-semantic，从 EditableDocument 提取语义对象。
 *
 * 要求：
 *   - LLM 只能引用已有 glyph/block（禁止幻觉）
 *   - 后端验证 blockId 存在性，过滤幻觉
 *   - 前端二次验证：LLM 返回的 blockIds 必须在 EditableDocument 中存在
 *
 * 数据流：
 *   EditableDocument
 *     ↓ 提取 text + blocks
 *   POST /api/llm/extract-semantic
 *     ↓ LLM 分析
 *   { objects, documentType }
 *     ↓ 前端验证 + GlyphRef 构建
 *   SemanticObject[]（含 evidenceGlyphs + reason）
 *
 * Fallback：
 *   LLM 未配置或调用失败 → 使用规则 SemanticAnalyzer
 */

import type {
  EditableDocument,
  EditableBlock,
  EditableLine,
} from "./types";
import type {
  AnySemanticObject,
  SemanticDocument,
  GlyphRef,
  SemanticObjectType,
} from "./semantic-types";
import { analyzeDocument } from "./semantic-analyzer";

/** LLM 提取的原始对象（后端返回） */
interface LlmSemanticObject {
  type: SemanticObjectType;
  value: string;
  label?: string;
  blockIds: string[];
  confidence: number;
  reason?: string;
}

/** LLM 提取响应 */
interface LlmExtractResponse {
  success: boolean;
  data?: {
    objects: LlmSemanticObject[];
    documentType: string;
    source: "llm" | "fallback";
  };
  error?: string;
}

/**
 * 从 EditableDocument 提取文本和 block 信息（发送给 LLM）
 */
function extractDocInfo(doc: EditableDocument) {
  let fullText = "";
  const blocks: Array<{ id: string; text: string; page: number }> = [];

  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.type !== "text") continue;
      const blockText = block.lines
        .map((l) => l.glyphs.map((g) => g.char).join(""))
        .join("\n");
      fullText += blockText + "\n";
      blocks.push({ id: block.id, text: blockText, page: page.index });
    }
  }

  return { text: fullText, blocks };
}

/**
 * 把 LLM 返回的对象转换为 SemanticObject（含 GlyphRef）
 *
 * 关键：LLM 只返回 blockIds，前端需要从 block 中找到对应的 glyph 构建 GlyphRef。
 * 策略：在 block 文本中搜索 value，找到对应的 glyph 索引。
 */
function llmObjectToSemanticObject(
  llmObj: LlmSemanticObject,
  doc: EditableDocument,
  index: number
): AnySemanticObject | null {
  // 验证 blockId 存在
  const validBlockIds = llmObj.blockIds.filter((id) =>
    doc.pages.some((p) => p.blocks.some((b) => b.id === id))
  );

  if (validBlockIds.length === 0) return null;

  // 在 block 中搜索 value，构建 GlyphRef
  const sourceGlyphs: GlyphRef[] = [];
  const evidenceGlyphs: GlyphRef[] = [];
  let bbox = { x: 0, y: 0, width: 0, height: 0 };

  for (const blockId of validBlockIds) {
    const { block, page } = findBlock(doc, blockId);
    if (!block) continue;

    for (const line of block.lines) {
      const lineText = line.glyphs.map((g) => g.char).join("");
      const valueStart = lineText.indexOf(llmObj.value);
      if (valueStart === -1) continue;

      // 收集 value 对应的 glyph
      for (let i = valueStart; i < valueStart + llmObj.value.length && i < line.glyphs.length; i++) {
        const g = line.glyphs[i];
        sourceGlyphs.push({
          blockId,
          lineId: line.id,
          glyphIndex: i,
          char: g.char,
        });
        evidenceGlyphs.push({
          blockId,
          lineId: line.id,
          glyphIndex: i,
          char: g.char,
        });

        // 更新 bbox
        if (sourceGlyphs.length === 1) {
          bbox = { ...g.bbox };
        } else {
          bbox.x = Math.min(bbox.x, g.bbox.x);
          bbox.y = Math.min(bbox.y, g.bbox.y);
          bbox.width = Math.max(bbox.width, g.bbox.x + g.bbox.width - bbox.x);
          bbox.height = Math.max(bbox.height, g.bbox.y + g.bbox.height - bbox.y);
        }
      }
      break;
    }
  }

  if (sourceGlyphs.length === 0) return null;

  const baseObj = {
    id: `llm_sem_${index}_${Date.now().toString(36).slice(-4)}`,
    value: llmObj.value,
    originalValue: llmObj.value,
    label: llmObj.label,
    sourceBlocks: validBlockIds,
    sourceGlyphs,
    bbox,
    confidence: llmObj.confidence,
    detectedBy: "llm" as const,
    page: findBlock(doc, validBlockIds[0]).page?.index || 1,
    modified: false,
    evidenceGlyphs,
    reason: llmObj.reason,
  };

  // 根据类型构建具体对象
  switch (llmObj.type) {
    case "dateField":
      return { ...baseObj, type: "dateField" as const };
    case "nameField":
      return { ...baseObj, type: "nameField" as const, nameRole: "unknown" as const };
    case "addressField":
      return { ...baseObj, type: "addressField" as const };
    case "signatureField":
      return { ...baseObj, type: "signatureField" as const, isSigned: true };
    case "tableField":
      return { ...baseObj, type: "tableField" as const, rows: 0, cols: 0, cells: [] };
    case "textField":
    default:
      return { ...baseObj, type: "textField" as const, textRole: "value" as const };
  }
}

/** 在 EditableDocument 中查找 block */
function findBlock(
  doc: EditableDocument,
  blockId: string
): { block: EditableBlock | null; page: { index: number } | null } {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.id === blockId) return { block, page };
    }
  }
  return { block: null, page: null };
}

/**
 * 调用 LLM 提取语义对象
 *
 * @param doc EditableDocument
 * @returns SemanticDocument（LLM 提取，或 fallback 到规则分析）
 */
export async function extractSemanticWithLLM(
  doc: EditableDocument
): Promise<SemanticDocument> {
  try {
    const { text, blocks } = extractDocInfo(doc);

    const resp = await fetch("/api/llm/extract-semantic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, blocks }),
    });

    if (!resp.ok) {
      throw new Error(`LLM extract failed: ${resp.status}`);
    }

    const data: LlmExtractResponse = await resp.json();
    if (!data.success || !data.data) {
      throw new Error(data.error || "LLM extract returned no data");
    }

    // 如果是 fallback（LLM 未配置），使用规则分析
    if (data.data.source === "fallback") {
      console.log("[LLM Semantic] LLM not configured, using rule-based analyzer");
      return analyzeDocument(doc);
    }

    // 转换 LLM 对象为 SemanticObject
    const objects: AnySemanticObject[] = [];
    data.data.objects.forEach((llmObj, i) => {
      const obj = llmObjectToSemanticObject(llmObj, doc, i);
      if (obj) objects.push(obj);
    });

    // 合并：LLM 对象 + 规则分析对象（规则补充 LLM 可能遗漏的）
    const ruleSemDoc = analyzeDocument(doc);
    const ruleIds = new Set(objects.map((o) => o.value));
    for (const ruleObj of ruleSemDoc.objects) {
      if (!ruleIds.has(ruleObj.value)) {
        objects.push(ruleObj);
      }
    }

    // 统计
    const typeCounts: Record<SemanticObjectType, number> = {
      textField: 0,
      dateField: 0,
      nameField: 0,
      addressField: 0,
      signatureField: 0,
      tableField: 0,
    };
    for (const obj of objects) {
      typeCounts[obj.type]++;
    }

    return {
      document: doc,
      objects,
      metadata: {
        analyzedAt: Date.now(),
        objectCount: objects.length,
        typeCounts,
      },
    };
  } catch (e: any) {
    console.warn("[LLM Semantic] LLM extraction failed, falling back to rules:", e.message);
    return analyzeDocument(doc);
  }
}
