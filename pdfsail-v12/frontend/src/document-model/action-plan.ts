/**
 * ActionPlan Model — Sprint 10 Task 2
 *
 * 可规划的文档操作计划。
 *
 * 与 Sprint 9 AIAction 的区别：
 *   - AIAction：直接执行（无规划阶段）
 *   - ActionPlan：先生成计划 → 用户确认 → 执行 → 验证
 *
 * 结构：
 *   {
 *     intent: "modify",
 *     target: { type: "dateField", semanticRole: "leave_start_date" },
 *     operation: "replace",
 *     value: "2027-04-03"
 *   }
 *
 * 流程：
 *   自然语言 → Intent Understanding → Plan Generation
 *     → Semantic Query（找到目标对象）
 *     → Mutation Plan（生成 ActionPlan[]）
 *     → 用户确认
 *     → Execute
 *     → Verify
 */

import type { SemanticObjectType, AnySemanticObject } from "./semantic-types";

/** 操作意图 */
export type PlanIntent =
  | "modify"       // 修改字段
  | "delete"       // 删除字段
  | "insert"       // 插入字段
  | "query"        // 查询（不修改）
  | "summarize"    // 总结
  | "detect_type"; // 检测类型

/** 操作类型 */
export type PlanOperation =
  | "replace"      // 替换值
  | "replace_all"  // 替换所有匹配
  | "delete"       // 删除
  | "insert"       // 插入
  | "query"        // 查询
  | "none";        // 无操作（查询/总结）

/** 计划目标 */
export interface PlanTarget {
  /** 语义对象类型 */
  type: SemanticObjectType;
  /** 语义角色（如 "leave_start_date"、"patient_name"、"invoice_total"） */
  semanticRole?: string;
  /** 标签关键词（用于匹配 label） */
  labelKeywords?: string[];
  /** 具体 objectId（如果已确定） */
  objectId?: string;
  /** 匹配范围：first / all */
  scope: "first" | "all";
}

/** ActionPlan — 单个操作计划 */
export interface ActionPlan {
  /** 计划唯一 ID */
  id: string;
  /** 意图 */
  intent: PlanIntent;
  /** 目标 */
  target: PlanTarget;
  /** 操作 */
  operation: PlanOperation;
  /** 新值（replace 时） */
  value?: string;
  /** 原始命令 */
  command?: string;
  /** 匹配到的 SemanticObject（查询后填充） */
  matchedObjects?: AnySemanticObject[];
  /** 计划描述（人类可读） */
  description?: string;
  /** 置信度（意图解析置信度） */
  confidence?: number;
}

/** 计划执行结果 */
export interface PlanExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 执行的计划数量 */
  executedCount: number;
  /** 修改的对象 ID 列表 */
  modifiedObjectIds: string[];
  /** 修改前后的值对比 */
  changes: Array<{
    objectId: string;
    oldValue: string;
    newValue: string;
    objectType: SemanticObjectType;
  }>;
  /** 验证结果 */
  verification?: PlanVerification;
  /** 修改说明（人类可读） */
  summary: string;
  /** 错误信息 */
  error?: string;
}

/** 验证结果（Task 5） */
export interface PlanVerification {
  /** 是否验证通过 */
  verified: boolean;
  /** 验证检查项 */
  checks: Array<{
    /** 检查描述 */
    description: string;
    /** 是否通过 */
    passed: boolean;
    /** 详情 */
    detail?: string;
  }>;
}

/** Agent 响应 */
export interface DocumentAgentResponse {
  /** 理解的意图 */
  intent: PlanIntent;
  /** 生成的计划 */
  plans: ActionPlan[];
  /** 是否需要用户确认 */
  needsConfirmation: boolean;
  /** 给用户的回复（人类可读） */
  reply: string;
  /** 置信度 */
  confidence: number;
}
