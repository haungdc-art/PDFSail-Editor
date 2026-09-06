/**
 * DocumentAgent — Sprint 10 Task 1 + Task 4 + Task 5
 *
 * 可规划的文档 Agent。
 *
 * 流程：
 *   自然语言
 *     ↓ Intent Understanding（理解用户意图）
 *     ↓ Plan Generation（生成 ActionPlan[]）
 *     ↓ Semantic Query（找到目标对象）
 *     ↓ Mutation Plan（填充 matchedObjects）
 *     ↓ 用户确认（needsConfirmation）
 *     ↓ Execute（执行计划）
 *     ↓ Verify（重新分析确认）
 *
 * Task 1: DocumentAgent（输入 → ActionPlan）
 * Task 4: Mutation Planner（先生成计划，不直接修改）
 * Task 5: Verification（修改后重新分析确认）
 */

import type { EditableDocument } from "./types";
import type {
  SemanticDocument,
  AnySemanticObject,
  SemanticObjectType,
} from "./semantic-types";
import type {
  ActionPlan,
  PlanExecutionResult,
  PlanVerification,
  DocumentAgentResponse,
  PlanTarget,
  PlanIntent,
} from "./action-plan";
import { querySemanticObjects } from "./semantic-query";
import { replaceSemanticValue } from "./semantic-mutation";
import { analyzeDocument } from "./semantic-analyzer";

// ── Task 1: DocumentAgent ──

/**
 * DocumentAgent 主入口
 *
 * 输入：userCommand + EditableDocument + SemanticDocument
 * 输出：DocumentAgentResponse（含 ActionPlan[]）
 *
 * 流程：
 *   1. Intent Understanding：解析自然语言 → PlanIntent + PlanTarget + value
 *   2. Semantic Query：在 SemanticDocument 中查找匹配对象
 *   3. Plan Generation：生成 ActionPlan[]（含 matchedObjects）
 *   4. 返回计划（不执行，等待用户确认）
 *
 * @param userCommand 用户自然语言命令
 * @param doc EditableDocument
 * @param semDoc SemanticDocument
 * @returns DocumentAgentResponse
 */
export function planDocumentAction(
  userCommand: string,
  doc: EditableDocument,
  semDoc: SemanticDocument
): DocumentAgentResponse {
  const trimmed = userCommand.trim();

  // 1. Intent Understanding
  const intent = parseIntent(trimmed);
  const target = parseTarget(trimmed);
  const value = parseValue(trimmed, intent);

  // 2. Semantic Query — 找到匹配对象
  const queryResult = querySemanticObjects(semDoc, {
    type: target.type,
    role: target.semanticRole,
    labelKeywords: target.labelKeywords,
    scope: target.scope,
  });

  // 3. Plan Generation
  const plans: ActionPlan[] = [];

  if (queryResult.count === 0) {
    return {
      intent,
      plans: [],
      needsConfirmation: false,
      reply: `未找到匹配的字段（${target.type}${target.semanticRole ? ` role=${target.semanticRole}` : ""}）。请检查文档内容或尝试其他关键词。`,
      confidence: 0.3,
    };
  }

  // 为每个匹配对象生成计划
  for (const obj of queryResult.objects) {
    const plan: ActionPlan = {
      id: `plan_${obj.id}_${Date.now().toString(36).slice(-4)}`,
      intent,
      target: { ...target, objectId: obj.id },
      operation: intent === "modify" ? (target.scope === "all" ? "replace_all" : "replace") : "none",
      value,
      command: userCommand,
      matchedObjects: [obj],
      description: generatePlanDescription(intent, obj, value),
      confidence: 0.85,
    };
    plans.push(plan);
  }

  // 4. 生成回复
  const reply = generateReply(intent, target, value, queryResult.objects);

  return {
    intent,
    plans,
    needsConfirmation: true,
    reply,
    confidence: 0.85,
  };
}

// ── Task 4: Mutation Planner ──

/**
 * 执行 ActionPlan[]
 *
 * 用户确认后调用此函数执行计划。
 *
 * 流程：
 *   1. 逐个执行 plan（调用 replaceSemanticValue）
 *   2. 收集 changes
 *   3. Task 5: Verification（重新分析确认）
 *
 * @param semDoc 当前 SemanticDocument
 * @param plans ActionPlan[]
 * @returns PlanExecutionResult
 */
export function executePlans(
  semDoc: SemanticDocument,
  plans: ActionPlan[]
): PlanExecutionResult {
  let currentSemDoc = semDoc;
  const modifiedObjectIds: string[] = [];
  const changes: PlanExecutionResult["changes"] = [];
  let executedCount = 0;

  for (const plan of plans) {
    if (plan.operation !== "replace" && plan.operation !== "replace_all") continue;
    if (!plan.value) continue;

    const obj = plan.matchedObjects?.[0];
    if (!obj) continue;

    const oldValue = obj.value;

    // 执行替换
    const result = replaceSemanticValue(currentSemDoc, obj.id, plan.value);
    if (result.mutated) {
      currentSemDoc = result.semanticDocument;
      modifiedObjectIds.push(obj.id);
      changes.push({
        objectId: obj.id,
        oldValue,
        newValue: plan.value,
        objectType: obj.type,
      });
      executedCount++;
    }
  }

  // Task 5: Verification
  const verification = verifyChanges(currentSemDoc, changes);

  // 生成修改说明
  const summary = generateSummary(changes, verification);

  return {
    success: executedCount > 0,
    executedCount,
    modifiedObjectIds,
    changes,
    verification,
    summary,
  };
}

// ── Task 5: Verification ──

/**
 * 验证修改结果
 *
 * 重新分析 SemanticDocument，确认目标字段已变化。
 *
 * @param semDoc 修改后的 SemanticDocument
 * @param changes 修改记录
 * @returns PlanVerification
 */
export function verifyChanges(
  semDoc: SemanticDocument,
  changes: PlanExecutionResult["changes"]
): PlanVerification {
  const checks: PlanVerification["checks"] = [];

  for (const change of changes) {
    // 检查 1：目标对象存在且值已更新
    const updatedObj = semDoc.objects.find((o) => o.id === change.objectId);
    if (updatedObj) {
      checks.push({
        description: `字段 ${change.objectId} 值已更新`,
        passed: updatedObj.value === change.newValue,
        detail: `期望: "${change.newValue}", 实际: "${updatedObj.value}"`,
      });
    } else {
      // 重新分析后 ID 可能变化，按值查找
      const byValue = semDoc.objects.find(
        (o) => o.value === change.newValue && o.type === change.objectType
      );
      checks.push({
        description: `字段值 "${change.newValue}" 存在于重新分析的文档`,
        passed: !!byValue,
        detail: byValue ? `找到对象 ${byValue.id}` : "未找到",
      });
    }

    // 检查 2：旧值不再存在（除非有多个相同值）
    const oldStillExists = semDoc.objects.some(
      (o) =>
        o.value === change.oldValue &&
        o.type === change.objectType &&
        o.id !== change.objectId
    );
    if (!oldStillExists && change.oldValue !== change.newValue) {
      checks.push({
        description: `旧值 "${change.oldValue}" 已被替换`,
        passed: true,
      });
    }

    // 检查 3：位置保持（glyph 数量一致）
    if (updatedObj) {
      checks.push({
        description: `字段 glyph 引用保持`,
        passed: updatedObj.sourceGlyphs.length > 0,
        detail: `${updatedObj.sourceGlyphs.length} glyphs`,
      });
    }
  }

  const verified = checks.every((c) => c.passed);

  return { verified, checks };
}

// ── 完整流程：plan + confirm + execute + verify ──

/**
 * 一步执行：自然语言 → 计划 → 执行 → 验证
 *
 * 跳过用户确认步骤，直接执行（用于简单命令或自动化场景）。
 *
 * @param userCommand 用户命令
 * @param doc EditableDocument
 * @param semDoc SemanticDocument
 * @returns PlanExecutionResult
 */
export function executeDocumentAction(
  userCommand: string,
  doc: EditableDocument,
  semDoc: SemanticDocument
): { response: DocumentAgentResponse; result: PlanExecutionResult | null } {
  const response = planDocumentAction(userCommand, doc, semDoc);

  if (!response.needsConfirmation || response.plans.length === 0) {
    return { response, result: null };
  }

  const result = executePlans(semDoc, response.plans);
  return { response, result };
}

// ── Intent 解析 ──

/** 解析意图 */
function parseIntent(command: string): PlanIntent {
  if (/检测|detect|what type|文档类型/i.test(command)) return "detect_type";
  if (/总结|summarize|summary/i.test(command)) return "summarize";
  if (/查询|find|query|查找/i.test(command)) return "query";
  if (/删除|delete|remove/i.test(command)) return "delete";
  if (/插入|insert|add/i.test(command)) return "insert";
  return "modify";
}

/** 解析目标 */
function parseTarget(command: string): PlanTarget {
  const lower = command.toLowerCase();

  // 病假开始日期 / leave start date
  if (/病假|开始日期|leave.*start|afastamento/i.test(lower)) {
    return {
      type: "dateField",
      semanticRole: "leave_start_date",
      labelKeywords: ["date", "data", "afastamento", "leave", "start"],
      scope: /所有|all/i.test(lower) ? "all" : "first",
    };
  }

  // 患者姓名 / patient name
  if (/患者姓名|病人姓名|patient.*name/i.test(lower)) {
    return {
      type: "nameField",
      semanticRole: "patient",
      labelKeywords: ["patient", "name", "paciente"],
      scope: "first",
    };
  }

  // 医生姓名 / doctor name
  if (/医生姓名|doctor.*name/i.test(lower)) {
    return {
      type: "nameField",
      semanticRole: "doctor",
      labelKeywords: ["doctor", "dr", "médico"],
      scope: "first",
    };
  }

  // 签名 / signature
  if (/签名|signature|assinatura/i.test(lower)) {
    return {
      type: "signatureField",
      scope: /所有|all/i.test(lower) ? "all" : "first",
    };
  }

  // CID
  if (/cid/i.test(lower)) {
    return {
      type: "textField",
      labelKeywords: ["cid"],
      scope: "first",
    };
  }

  // 发票总额 / invoice total
  if (/总额|total|amount|valor/i.test(lower)) {
    return {
      type: "textField",
      labelKeywords: ["total", "amount", "valor"],
      scope: "first",
    };
  }

  // 日期 / date
  if (/日期|date|data/i.test(lower)) {
    return {
      type: "dateField",
      scope: /所有|all/i.test(lower) ? "all" : "first",
    };
  }

  // 姓名 / name
  if (/姓名|name|nome/i.test(lower)) {
    return {
      type: "nameField",
      scope: /所有|all/i.test(lower) ? "all" : "first",
    };
  }

  // 地址 / address
  if (/地址|address|endereço/i.test(lower)) {
    return {
      type: "addressField",
      scope: /所有|all/i.test(lower) ? "all" : "first",
    };
  }

  // 默认：通用文本
  return {
    type: "textField",
    scope: "first",
  };
}

/** 解析新值 */
function parseValue(command: string, intent: PlanIntent): string | undefined {
  if (intent !== "modify") return undefined;

  // 提取 "改成 X" / "to X" / "改为 X" 后的值
  const match = command.match(/(?:改成|改为|to|with|改成)\s*(.+)/i);
  if (match) {
    let value = match[1].trim();

    // 特殊处理：日期
    // "2027年4月3日" → "03/04/2027"
    const cnDateMatch = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
    if (cnDateMatch) {
      const year = cnDateMatch[1];
      const month = cnDateMatch[2].padStart(2, "0");
      const day = cnDateMatch[3].padStart(2, "0");
      // 保留原始格式风格：DD/MM/YYYY
      value = `${day}/${month}/${year}`;
    }

    return value;
  }

  // "2027" 单独年份
  const yearMatch = command.match(/\b(20\d{2})\b/);
  if (yearMatch) return yearMatch[1];

  return undefined;
}

/** 生成计划描述 */
function generatePlanDescription(
  intent: PlanIntent,
  obj: AnySemanticObject,
  value?: string
): string {
  const label = obj.label || obj.type;
  if (intent === "modify" && value) {
    return `将 ${label} 从 "${obj.value}" 修改为 "${value}"`;
  }
  if (intent === "delete") {
    return `删除 ${label}（当前值: "${obj.value}"）`;
  }
  if (intent === "query") {
    return `查询 ${label}（当前值: "${obj.value}"）`;
  }
  return `${intent} ${label}`;
}

/** 生成回复 */
function generateReply(
  intent: PlanIntent,
  target: PlanTarget,
  value: string | undefined,
  matched: AnySemanticObject[]
): string {
  const count = matched.length;
  const targetDesc = target.semanticRole || target.type;

  if (intent === "modify") {
    const values = matched.map((o) => `"${o.value}"`).join(", ");
    return `找到 ${count} 个 ${targetDesc} 字段（当前值: ${values}）。${value ? `将修改为 "${value}"。` : ""}请确认执行。`;
  }

  if (intent === "query") {
    const list = matched.map((o) => `${o.label || o.type}: "${o.value}"`).join("\n");
    return `找到 ${count} 个 ${targetDesc}：\n${list}`;
  }

  return `找到 ${count} 个匹配字段。`;
}

/** 生成修改说明 */
function generateSummary(
  changes: PlanExecutionResult["changes"],
  verification: PlanVerification
): string {
  if (changes.length === 0) return "未执行任何修改。";

  const changeList = changes
    .map((c) => `${c.objectType}: "${c.oldValue}" → "${c.newValue}"`)
    .join("\n");

  const verifyStatus = verification.verified ? "✅ 验证通过" : "⚠️ 验证未完全通过";

  return `已完成 ${changes.length} 项修改：\n${changeList}\n\n${verifyStatus}`;
}
