/**
 * AI Action API — Sprint 9 Task 5
 *
 * 自然语言意图 → SemanticObject → Mutation → Render → Export
 *
 * 流程：
 *   用户："把所有日期改成 2027"
 *     ↓
 *   Intent Parsing（LLM 或本地规则）
 *     ↓ action: "replace_all", fieldType: "dateField", newValue: "2027"
 *   SemanticObject 查找（找到所有 dateField）
 *     ↓
 *   Mutation（逐个 replaceSemanticValue）
 *     ↓
 *   Render（GlyphRenderer 更新）
 *   Export（docBlocks 同步）
 *
 * 核心 API：
 *   - executeAction(semDoc, action) — 执行结构化 action
 *   - executeNaturalLanguage(semDoc, command) — 解析自然语言并执行
 */

import type { SemanticDocument, AnySemanticObject } from "./semantic-types";
import { replaceSemanticValue, type SemanticMutationResult } from "./semantic-mutation";

/** AI Action 类型 */
export type AIActionType =
  | "replace_all"    // 替换所有匹配类型的字段
  | "replace_one"    // 替换第一个匹配
  | "replace_by_label" // 按标签替换
  | "replace_by_id"  // 按 ID 替换
  | "detect_type"    // 检测文档类型
  | "summarize";     // 总结文档

/** AI Action 结构 */
export interface AIAction {
  /** Action 类型 */
  action: AIActionType;
  /** 目标字段类型（replace_all/replace_one 时） */
  fieldType?: AnySemanticObject["type"];
  /** 目标标签（replace_by_label 时） */
  label?: string;
  /** 目标 ID（replace_by_id 时） */
  objectId?: string;
  /** 新值 */
  newValue?: string;
  /** 原始命令 */
  command?: string;
}

/** AI Action 执行结果 */
export interface AIActionResult {
  /** 是否成功 */
  success: boolean;
  /** 执行的修改数量 */
  mutationCount: number;
  /** 最终的 EditableDocument */
  document: import("./types").EditableDocument;
  /** 最终的 SemanticDocument */
  semanticDocument: SemanticDocument;
  /** 修改的对象 ID 列表 */
  modifiedObjectIds: string[];
  /** 错误信息 */
  error?: string;
}

/**
 * 执行结构化 AI Action
 *
 * @param semDoc 当前 SemanticDocument
 * @param action AI Action
 * @returns AIActionResult
 */
export function executeAction(
  semDoc: SemanticDocument,
  action: AIAction
): AIActionResult {
  let currentSemDoc = semDoc;
  let mutationCount = 0;
  const modifiedObjectIds: string[] = [];

  try {
    switch (action.action) {
      case "replace_all": {
        if (!action.fieldType || !action.newValue) {
          return errorResult(semDoc, "fieldType and newValue required for replace_all");
        }
        const matching = currentSemDoc.objects.filter(
          (o) => o.type === action.fieldType
        );
        for (const obj of matching) {
          const result = replaceSemanticValue(currentSemDoc, obj.id, action.newValue!);
          if (result.mutated) {
            currentSemDoc = result.semanticDocument;
            mutationCount++;
            modifiedObjectIds.push(obj.id);
          }
        }
        break;
      }

      case "replace_one": {
        if (!action.fieldType || !action.newValue) {
          return errorResult(semDoc, "fieldType and newValue required for replace_one");
        }
        const obj = currentSemDoc.objects.find(
          (o) => o.type === action.fieldType
        );
        if (obj) {
          const result = replaceSemanticValue(currentSemDoc, obj.id, action.newValue!);
          if (result.mutated) {
            currentSemDoc = result.semanticDocument;
            mutationCount = 1;
            modifiedObjectIds.push(obj.id);
          }
        }
        break;
      }

      case "replace_by_label": {
        if (!action.label || !action.newValue) {
          return errorResult(semDoc, "label and newValue required for replace_by_label");
        }
        const lowerLabel = action.label.toLowerCase();
        const matching = currentSemDoc.objects.filter((o) =>
          o.label?.toLowerCase().includes(lowerLabel)
        );
        for (const obj of matching) {
          const result = replaceSemanticValue(currentSemDoc, obj.id, action.newValue!);
          if (result.mutated) {
            currentSemDoc = result.semanticDocument;
            mutationCount++;
            modifiedObjectIds.push(obj.id);
          }
        }
        break;
      }

      case "replace_by_id": {
        if (!action.objectId || !action.newValue) {
          return errorResult(semDoc, "objectId and newValue required for replace_by_id");
        }
        const result = replaceSemanticValue(currentSemDoc, action.objectId, action.newValue!);
        if (result.mutated) {
          currentSemDoc = result.semanticDocument;
          mutationCount = 1;
          modifiedObjectIds.push(action.objectId);
        }
        break;
      }

      case "detect_type":
      case "summarize": {
        // 这两个 action 不修改文档，只返回当前状态
        break;
      }

      default:
        return errorResult(semDoc, `Unknown action: ${action.action}`);
    }

    return {
      success: true,
      mutationCount,
      document: currentSemDoc.document,
      semanticDocument: currentSemDoc,
      modifiedObjectIds,
    };
  } catch (e: any) {
    return errorResult(currentSemDoc, e.message);
  }
}

/**
 * 解析自然语言命令并执行
 *
 * 本地解析（不调 LLM），支持以下模式：
 *   - "把所有日期改成 2027" → replace_all dateField "2027"
 *   - "把日期改成 03/04/2027" → replace_one dateField "03/04/2027"
 *   - "把姓名改成 MARIA" → replace_one nameField "MARIA"
 *   - "把所有 X 改成 Y" → replace_all
 *
 * 复杂命令可调用 LLM（通过 /api/llm/parse-intent）
 *
 * @param semDoc 当前 SemanticDocument
 * @param command 自然语言命令
 * @returns AIActionResult
 */
export function executeNaturalLanguage(
  semDoc: SemanticDocument,
  command: string
): AIActionResult {
  const action = parseLocalAction(command, semDoc);
  if (!action) {
    return errorResult(semDoc, `Cannot parse command: "${command}"`);
  }
  return executeAction(semDoc, action);
}

/**
 * 本地自然语言解析（无需 LLM）
 *
 * 支持的模式：
 *   - 把所有日期改成 X / change all dates to X
 *   - 把日期改成 X / change date to X
 *   - 把姓名改成 X / change name to X
 *   - 把 X 改成 Y / change X to Y（按标签匹配）
 */
function parseLocalAction(command: string, semDoc: SemanticDocument): AIAction | null {
  const trimmed = command.trim();

  // 模式 1：把所有 X 改成 Y / change all X to Y
  const allMatch = trimmed.match(/(?:把所有|change all|replace all)\s*(.+?)\s*(?:改成|to|with)\s*(.+)/i);
  if (allMatch) {
    const fieldType = resolveFieldType(allMatch[1].trim());
    if (fieldType) {
      return {
        action: "replace_all",
        fieldType,
        newValue: allMatch[2].trim(),
        command,
      };
    }
  }

  // 模式 2：把 X 改成 Y / change X to Y
  const oneMatch = trimmed.match(/(?:把|change|replace)\s*(.+?)\s*(?:改成|to|with)\s*(.+)/i);
  if (oneMatch) {
    const target = oneMatch[1].trim();
    const newValue = oneMatch[2].trim();
    const fieldType = resolveFieldType(target);
    if (fieldType) {
      return {
        action: "replace_one",
        fieldType,
        newValue,
        command,
      };
    }
    // 按标签匹配
    return {
      action: "replace_by_label",
      label: target,
      newValue,
      command,
    };
  }

  // 模式 3：检测文档类型
  if (/检测|detect|what type/i.test(trimmed)) {
    return { action: "detect_type", command };
  }

  return null;
}

/**
 * 把中文/英文字段名解析为 SemanticObjectType
 */
function resolveFieldType(name: string): AnySemanticObject["type"] | null {
  const lower = name.toLowerCase();
  if (/日期|date|data/i.test(lower)) return "dateField";
  if (/姓名|名字|name|nome/i.test(lower)) return "nameField";
  if (/地址|address|endereço/i.test(lower)) return "addressField";
  if (/签名|签名区域|signature|assinatura/i.test(lower)) return "signatureField";
  if (/cid|id/i.test(lower)) return "textField";
  return null;
}

/** 构造错误结果 */
function errorResult(semDoc: SemanticDocument, error: string): AIActionResult {
  return {
    success: false,
    mutationCount: 0,
    document: semDoc.document,
    semanticDocument: semDoc,
    modifiedObjectIds: [],
    error,
  };
}
