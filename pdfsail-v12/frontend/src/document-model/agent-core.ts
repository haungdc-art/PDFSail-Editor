/**
 * Agent Core — Sprint 11 Task 1 + Task 3 + Task 4
 *
 * 将 DocumentAgent 拆分为三个核心组件：
 *   - AgentPlanner：意图理解 → 多步骤计划生成
 *   - AgentExecutor：工具执行 → 逐步骤运行
 *   - AgentVerifier：验证修改结果
 *
 * Task 1: 拆分 Agent Core
 * Task 3: Multi-step Plan（多步骤任务计划）
 *   用户："检查合同日期并修改错误日期"
 *   Plan: [findField → compareFields → identify inconsistency → replaceValue → verify]
 * Task 4: Human Confirmation（高风险操作必须确认）
 *   - delete
 *   - 批量修改（>1 个对象）
 *   - 金额修改
 *
 * 流程：
 *   User Intent → AgentPlanner → TaskStep[] → Human Confirmation → AgentExecutor → AgentVerifier
 */

import type { EditableDocument } from "./types";
import type { SemanticDocument, AnySemanticObject } from "./semantic-types";
import type { PlanExecutionResult, PlanVerification } from "./action-plan";
import {
  ToolRegistry,
  getToolRegistry,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool-registry";
import {
  ExecutionHistory,
  getExecutionHistory,
  type HistoryEntry,
} from "./execution-history";
import { analyzeDocument } from "./semantic-analyzer";
import { replaceSemanticValue } from "./semantic-mutation";
import { querySemanticObjects } from "./semantic-query";
import { detectDocumentType, validateAgainstSchema } from "./document-schema";

// ── Task 3: Multi-step Plan ──

/** 单个任务步骤 */
export interface TaskStep {
  /** 步骤 ID */
  id: string;
  /** 步骤序号（1-based） */
  stepNumber: number;
  /** 工具名称 */
  tool: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 步骤描述（人类可读） */
  description: string;
  /** 是否高风险（需要确认） */
  highRisk: boolean;
  /** 依赖的前置步骤 ID（可选） */
  dependsOn?: string[];
  /** 执行结果（执行后填充） */
  result?: ToolResult;
  /** 是否已执行 */
  executed: boolean;
}

/** 多步骤任务计划 */
export interface TaskPlan {
  /** 计划 ID */
  id: string;
  /** 原始用户命令 */
  command: string;
  /** 意图描述 */
  intent: string;
  /** 步骤列表 */
  steps: TaskStep[];
  /** 是否需要用户确认（Task 4） */
  needsConfirmation: boolean;
  /** 确认原因（如果需要确认） */
  confirmationReason?: string;
  /** 给用户的回复 */
  reply: string;
  /** 置信度 */
  confidence: number;
}

/** Agent 执行结果 */
export interface AgentExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 执行的步骤数量 */
  executedSteps: number;
  /** 最终的 EditableDocument */
  document: EditableDocument;
  /** 最终的 SemanticDocument */
  semanticDocument: SemanticDocument;
  /** 修改详情 */
  changes: PlanExecutionResult["changes"];
  /** 验证结果 */
  verification: PlanVerification;
  /** 修改说明 */
  summary: string;
  /** 历史记录条目 */
  historyEntry?: HistoryEntry;
  /** 错误信息 */
  error?: string;
}

// ── Task 1: AgentPlanner ──

/**
 * AgentPlanner — 意图理解 + 多步骤计划生成
 *
 * 输入：userCommand + EditableDocument + SemanticDocument
 * 输出：TaskPlan（含多步骤）
 *
 * 支持：
 *   - 简单命令 → 单步骤计划
 *   - 复杂命令（如"检查并修改"）→ 多步骤计划
 *   - 高风险检测 → needsConfirmation = true
 */
export class AgentPlanner {
  private registry: ToolRegistry;

  constructor(registry?: ToolRegistry) {
    this.registry = registry || getToolRegistry();
  }

  /**
   * 生成任务计划
   *
   * @param command 用户命令
   * @param doc EditableDocument
   * @param semDoc SemanticDocument
   * @returns TaskPlan
   */
  plan(
    command: string,
    doc: EditableDocument,
    semDoc: SemanticDocument
  ): TaskPlan {
    const trimmed = command.trim();
    const steps: TaskStep[] = [];
    let stepNum = 0;

    // ── 复杂命令：检查 + 修改 ──
    if (/检查.*修改|check.*fix|verify.*correct/i.test(trimmed)) {
      // 多步骤计划
      const type = this.detectFieldType(trimmed);

      // Step 1: findField
      steps.push(this.createStep(++stepNum, "findField", {
        type,
        scope: "all",
      }, `查找所有 ${type} 字段`));

      // Step 2: compareFields
      steps.push(this.createStep(++stepNum, "compareFields", {
        type,
      }, `比较 ${type} 字段一致性`, [steps[0].id]));

      // Step 3: replaceValue（如果有不一致）
      steps.push(this.createStep(++stepNum, "replaceValue", {
        objectId: "${step1.inconsistencies[0].objectId}",
        newValue: "${step1.consistentValue}",
      }, `修改不一致的 ${type} 字段`, [steps[1].id], true));

      // Step 4: validateDocument
      steps.push(this.createStep(++stepNum, "validateDocument", {},
        `验证文档完整性`, [steps[2].id]));

      return {
        id: `plan_${Date.now()}`,
        command: trimmed,
        intent: "check_and_fix",
        steps,
        needsConfirmation: true,
        confirmationReason: "包含修改操作，需要确认",
        reply: `将执行 ${steps.length} 步操作：检查 ${type} 一致性 → 修改不一致项 → 验证。请确认执行。`,
        confidence: 0.8,
      };
    }

    // ── 检查/验证命令 ──
    if (/检查|验证|check|validate|verify/i.test(trimmed)) {
      const type = this.detectFieldType(trimmed);
      steps.push(this.createStep(++stepNum, "findField", { type, scope: "all" }, `查找所有 ${type} 字段`));
      steps.push(this.createStep(++stepNum, "compareFields", { type }, `比较 ${type} 一致性`, [steps[0].id]));
      steps.push(this.createStep(++stepNum, "validateDocument", {}, `验证文档完整性`, [steps[1].id]));

      return {
        id: `plan_${Date.now()}`,
        command: trimmed,
        intent: "check",
        steps,
        needsConfirmation: false,
        reply: `将执行 ${steps.length} 步检查操作。`,
        confidence: 0.85,
      };
    }

    // ── 总结命令 ──
    if (/总结|summarize/i.test(trimmed)) {
      steps.push(this.createStep(++stepNum, "summarize", {}, `总结文档`));
      return {
        id: `plan_${Date.now()}`,
        command: trimmed,
        intent: "summarize",
        steps,
        needsConfirmation: false,
        reply: `将生成文档总结。`,
        confidence: 0.9,
      };
    }

    // ── 修改命令 ──
    if (/改成|改为|change|replace|修改/i.test(trimmed)) {
      const type = this.detectFieldType(trimmed);
      const value = this.extractValue(trimmed);
      const scope = /所有|all/i.test(trimmed) ? "all" : "first";

      // Step 1: findField
      steps.push(this.createStep(++stepNum, "findField", { type, scope }, `查找 ${type} 字段`));

      // Step 2: replaceValue
      if (value) {
        const isHighRisk = scope === "all" || type === "textField"; // 批量或金额 = 高风险
        steps.push(this.createStep(++stepNum, "replaceValue", {
          objectId: "${step1.objects[0].id}",
          newValue: value,
        }, `将 ${type} 修改为 "${value}"`, [steps[0].id], isHighRisk));

        // Step 3: verify
        steps.push(this.createStep(++stepNum, "validateDocument", {}, `验证修改结果`, [steps[1].id]));
      }

      const needsConfirmation = steps.some((s) => s.highRisk);
      return {
        id: `plan_${Date.now()}`,
        command: trimmed,
        intent: "modify",
        steps,
        needsConfirmation,
        confirmationReason: needsConfirmation ? "包含高风险修改操作" : undefined,
        reply: needsConfirmation
          ? `将执行 ${steps.length} 步操作，包含修改。请确认执行。`
          : `将执行 ${steps.length} 步操作。`,
        confidence: 0.85,
      };
    }

    // ── 默认：查询 ──
    const type = this.detectFieldType(trimmed);
    steps.push(this.createStep(++stepNum, "findField", { type, scope: "all" }, `查找 ${type} 字段`));
    return {
      id: `plan_${Date.now()}`,
      command: trimmed,
      intent: "query",
      steps,
      needsConfirmation: false,
      reply: `将查询 ${type} 字段。`,
      confidence: 0.7,
    };
  }

  /** 创建步骤 */
  private createStep(
    stepNum: number,
    tool: string,
    params: Record<string, unknown>,
    description: string,
    dependsOn?: string[],
    highRisk: boolean = false
  ): TaskStep {
    const toolDef = this.registry.get(tool);
    return {
      id: `step_${stepNum}`,
      stepNumber: stepNum,
      tool,
      params,
      description,
      highRisk: highRisk || (toolDef?.highRisk ?? false),
      dependsOn,
      executed: false,
    };
  }

  /** 从命令检测字段类型 */
  private detectFieldType(command: string): AnySemanticObject["type"] {
    const lower = command.toLowerCase();
    if (/日期|date|data/i.test(lower)) return "dateField";
    if (/姓名|name|nome/i.test(lower)) return "nameField";
    if (/地址|address/i.test(lower)) return "addressField";
    if (/签名|signature/i.test(lower)) return "signatureField";
    if (/cid/i.test(lower)) return "textField";
    if (/总额|total|amount|金额/i.test(lower)) return "textField";
    return "textField";
  }

  /** 从命令提取新值 */
  private extractValue(command: string): string | undefined {
    const match = command.match(/(?:改成|改为|to|with)\s*(.+)/i);
    if (match) {
      let value = match[1].trim();
      const cnDate = value.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
      if (cnDate) {
        value = `${cnDate[3].padStart(2, "0")}/${cnDate[2].padStart(2, "0")}/${cnDate[1]}`;
      }
      return value;
    }
    const yearMatch = command.match(/\b(20\d{2})\b/);
    if (yearMatch) return yearMatch[1];
    return undefined;
  }
}

// ── Task 1: AgentExecutor ──

/**
 * AgentExecutor — 逐步骤执行 TaskPlan
 *
 * 流程：
 *   1. 按顺序执行每个 TaskStep
 *   2. 解析步骤间参数依赖（${step1.objects[0].id}）
 *   3. 收集修改结果
 *   4. 记录到 ExecutionHistory（Task 5）
 */
export class AgentExecutor {
  private registry: ToolRegistry;
  private history: ExecutionHistory;

  constructor(registry?: ToolRegistry, history?: ExecutionHistory) {
    this.registry = registry || getToolRegistry();
    this.history = history || getExecutionHistory();
  }

  /**
   * 执行 TaskPlan
   *
   * @param plan TaskPlan
   * @param doc EditableDocument
   * @param semDoc SemanticDocument
   * @returns AgentExecutionResult
   */
  async execute(
    plan: TaskPlan,
    doc: EditableDocument,
    semDoc: SemanticDocument
  ): Promise<AgentExecutionResult> {
    let currentDoc = doc;
    let currentSem = semDoc;
    let executedSteps = 0;
    const changes: PlanExecutionResult["changes"] = [];
    const stepResults: Record<string, ToolResult> = {};

    for (const step of plan.steps) {
      // 解析参数依赖（${stepX.xxx}）
      const resolvedParams = this.resolveParams(step.params, stepResults);

      const ctx: ToolContext = {
        document: currentDoc,
        semanticDocument: currentSem,
      };

      const result = await this.registry.execute(step.tool, ctx, resolvedParams);
      step.result = result;
      step.executed = true;
      stepResults[step.id] = result;
      executedSteps++;

      // 如果工具修改了文档，更新当前状态
      if (result.modified && result.modifiedDocument && result.modifiedSemanticDocument) {
        currentDoc = result.modifiedDocument;
        currentSem = result.modifiedSemanticDocument;

        // 收集修改
        if (result.data && typeof result.data === "object") {
          const data = result.data as { oldValue?: string; newValue?: string };
          if (data.newValue) {
            changes.push({
              objectId: (resolvedParams.objectId as string) || "unknown",
              oldValue: data.oldValue || "",
              newValue: data.newValue,
              objectType: "dateField", // 简化，实际从对象获取
            });
          }
        }
      }

      // 如果步骤失败，停止执行
      if (!result.success && step.highRisk) {
        return {
          success: false,
          executedSteps,
          document: currentDoc,
          semanticDocument: currentSem,
          changes,
          verification: { verified: false, checks: [{ description: `步骤 ${step.stepNumber} 失败`, passed: false, detail: result.error }] },
          summary: `执行在第 ${step.stepNumber} 步失败：${result.description}`,
          error: result.error,
        };
      }
    }

    // Task 5: 记录到历史
    const summary = this.generateSummary(plan, changes);
    const historyEntry = this.history.record(
      plan.command,
      doc,
      currentDoc,
      changes,
      summary,
      semDoc,
      currentSem
    );

    // Task 5: Verification
    const verification = this.verify(currentSem, changes);

    return {
      success: true,
      executedSteps,
      document: currentDoc,
      semanticDocument: currentSem,
      changes,
      verification,
      summary,
      historyEntry,
    };
  }

  /**
   * 解析参数中的 ${stepX.xxx} 引用
   */
  private resolveParams(
    params: Record<string, unknown>,
    stepResults: Record<string, ToolResult>
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && value.includes("${")) {
        // 解析 ${step1.objects[0].id} 格式
        resolved[key] = this.resolveTemplate(value, stepResults);
      } else {
        resolved[key] = value;
      }
    }

    return resolved;
  }

  /** 解析模板字符串 */
  private resolveTemplate(
    template: string,
    stepResults: Record<string, ToolResult>
  ): unknown {
    // 简化解析：${step1.objects[0].id}
    const match = template.match(/^\$\{(\w+)\.(\w+)(?:\[(\d+)\])?\.?(\w+)?\}$/);
    if (!match) return template;

    const [, stepId, field1, indexStr, field2] = match;
    const result = stepResults[stepId];
    if (!result) return template;

    let value: unknown = result;
    if (field1 === "objects" && result.objects) {
      const idx = indexStr ? parseInt(indexStr) : 0;
      value = result.objects[idx];
    } else if (field1 === "data" && result.data) {
      value = (result.data as Record<string, unknown>)[field2 || ""];
    }

    if (value && typeof value === "object" && field2) {
      return (value as Record<string, unknown>)[field2] || template;
    }

    // 特殊处理：compareFields 的 inconsistencies
    if (field1 === "inconsistencies" && result.data) {
      const data = result.data as { inconsistencies?: Array<{ objectId: string }> };
      if (data.inconsistencies && data.inconsistencies.length > 0) {
        return data.inconsistencies[0].objectId;
      }
    }
    if (field1 === "consistentValue" && result.data) {
      const data = result.data as { values?: string[] };
      if (data.values && data.values.length > 0) {
        return data.values[0];
      }
    }

    return template;
  }

  /** 生成摘要 */
  private generateSummary(plan: TaskPlan, changes: PlanExecutionResult["changes"]): string {
    if (changes.length === 0) {
      return `完成 ${plan.steps.length} 步操作（无修改）。`;
    }
    const changeList = changes
      .map((c) => `${c.objectType}: "${c.oldValue}" → "${c.newValue}"`)
      .join("\n");
    return `完成 ${plan.steps.length} 步操作，${changes.length} 项修改：\n${changeList}`;
  }

  /** 验证 */
  private verify(semDoc: SemanticDocument, changes: PlanExecutionResult["changes"]): PlanVerification {
    const checks: PlanVerification["checks"] = [];

    for (const change of changes) {
      const byValue = semDoc.objects.find(
        (o) => o.value === change.newValue && o.type === change.objectType
      );
      checks.push({
        description: `字段值 "${change.newValue}" 存在`,
        passed: !!byValue,
      });
    }

    // 文档完整性验证
    const schema = detectDocumentType(semDoc);
    const validation = validateAgainstSchema(semDoc, schema);
    checks.push({
      description: `文档完整性验证（${schema.typeLabel}）`,
      passed: validation.valid,
      detail: validation.valid ? "所有必需字段齐全" : `缺少：${validation.missing.map((e) => e.type).join(", ")}`,
    });

    return { verified: checks.every((c) => c.passed), checks };
  }
}

// ── Task 1: AgentVerifier ──

/**
 * AgentVerifier — 验证修改结果
 *
 * 独立验证组件，可单独调用。
 */
export class AgentVerifier {
  /**
   * 验证修改
   *
   * @param semDoc 修改后的 SemanticDocument
   * @param changes 修改记录
   */
  verify(
    semDoc: SemanticDocument,
    changes: PlanExecutionResult["changes"]
  ): PlanVerification {
    const checks: PlanVerification["checks"] = [];

    for (const change of changes) {
      const updated = semDoc.objects.find(
        (o) => o.value === change.newValue && o.type === change.objectType
      );
      checks.push({
        description: `${change.objectType} 值已更新为 "${change.newValue}"`,
        passed: !!updated,
        detail: updated ? `找到对象 ${updated.id}` : "未找到",
      });
    }

    // Schema 验证
    const schema = detectDocumentType(semDoc);
    const validation = validateAgainstSchema(semDoc, schema);
    checks.push({
      description: `文档 Schema 验证（${schema.typeLabel}）`,
      passed: validation.valid,
      detail: validation.valid ? "通过" : `缺少：${validation.missing.map((e) => e.type).join(", ")}`,
    });

    return { verified: checks.every((c) => c.passed), checks };
  }

  /**
   * 检查日期一致性
   */
  checkDateConsistency(semDoc: SemanticDocument): {
    consistent: boolean;
    dates: string[];
    inconsistencies: Array<{ objectId: string; value: string }>;
  } {
    const dates = semDoc.objects.filter((o) => o.type === "dateField");
    const values = dates.map((d) => d.value);
    const allSame = values.every((v) => v === values[0]);
    const inconsistencies = allSame
      ? []
      : dates.filter((d) => d.value !== values[0]).map((d) => ({ objectId: d.id, value: d.value }));

    return { consistent: allSame, dates: values, inconsistencies };
  }
}

// ── 便捷函数 ──

/**
 * 一步执行：自然语言 → 计划 → 执行 → 验证
 *
 * 适用于简单命令或自动化场景。
 */
export async function runAgent(
  command: string,
  doc: EditableDocument,
  semDoc: SemanticDocument
): Promise<{ plan: TaskPlan; result: AgentExecutionResult | null }> {
  const planner = new AgentPlanner();
  const plan = planner.plan(command, doc, semDoc);

  if (plan.needsConfirmation) {
    // 返回计划，等待确认
    return { plan, result: null };
  }

  // 无需确认，直接执行
  const executor = new AgentExecutor();
  const result = await executor.execute(plan, doc, semDoc);
  return { plan, result };
}

/**
 * 撤销最后一次操作
 */
export function undoLastAction(): import("./execution-history").UndoResult {
  return getExecutionHistory().undo();
}
