/**
 * Tool Registry — Sprint 11 Task 2
 *
 * Document Agent 的工具注册表。
 *
 * 每个 Tool 是一个可被 Agent 调用的原子操作：
 *   - findField：查找语义字段
 *   - replaceValue：替换字段值
 *   - summarize：总结文档
 *   - extractTable：提取表格
 *   - compareFields：比较字段关系
 *   - validateDocument：验证文档完整性
 *
 * Tool 接口：
 *   { name, description, parameters, execute(context) → ToolResult }
 *
 * Agent Planner 通过 Tool Registry 组合多步骤计划。
 */

import type { EditableDocument } from "./types";
import type {
  SemanticDocument,
  AnySemanticObject,
  SemanticObjectType,
} from "./semantic-types";
import { querySemanticObjects, type SemanticQuery } from "./semantic-query";
import { replaceSemanticValue } from "./semantic-mutation";
import { analyzeDocument } from "./semantic-analyzer";
import { detectDocumentType, validateAgainstSchema } from "./document-schema";

/** 工具执行上下文 */
export interface ToolContext {
  document: EditableDocument;
  semanticDocument: SemanticDocument;
}

/** 工具参数（联合类型，每个工具有自己的参数） */
export interface ToolParams {
  [key: string]: unknown;
}

/** 工具执行结果 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 结果数据（工具特定） */
  data?: unknown;
  /** 人类可读的结果描述 */
  description: string;
  /** 发现的对象（findField 等返回） */
  objects?: AnySemanticObject[];
  /** 是否产生了文档修改 */
  modified: boolean;
  /** 修改后的文档（如果 modified=true） */
  modifiedDocument?: EditableDocument;
  /** 修改后的 SemanticDocument（如果 modified=true） */
  modifiedSemanticDocument?: SemanticDocument;
  /** 错误信息 */
  error?: string;
}

/** 工具定义 */
export interface Tool {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数描述（用于 Plan 生成） */
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  /** 是否高风险（需要用户确认） */
  highRisk: boolean;
  /** 执行函数 */
  execute: (ctx: ToolContext, params: ToolParams) => ToolResult | Promise<ToolResult>;
}

// ── 内置工具实现 ──

/** findField：查找语义字段 */
const findFieldTool: Tool = {
  name: "findField",
  description: "查找文档中的语义字段（如所有日期、患者姓名、签名等）",
  parameters: {
    type: { type: "SemanticObjectType", description: "字段类型（dateField/nameField/...）", required: false },
    role: { type: "string", description: "语义角色（如 patient/doctor）", required: false },
    labelKeywords: { type: "string[]", description: "标签关键词", required: false },
    scope: { type: "'first' | 'all'", description: "匹配范围", required: false },
  },
  highRisk: false,
  execute: (ctx, params) => {
    const query: SemanticQuery = {
      type: params.type as SemanticObjectType,
      role: params.role as string,
      labelKeywords: params.labelKeywords as string[],
      scope: params.scope as "first" | "all",
    };
    const result = querySemanticObjects(ctx.semanticDocument, query);
    return {
      success: true,
      objects: result.objects,
      description: `找到 ${result.count} 个匹配字段`,
      modified: false,
    };
  },
};

/** replaceValue：替换字段值 */
const replaceValueTool: Tool = {
  name: "replaceValue",
  description: "替换语义字段的值（保持位置/字体/baseline）",
  parameters: {
    objectId: { type: "string", description: "目标对象 ID", required: true },
    newValue: { type: "string", description: "新值", required: true },
  },
  highRisk: true,
  execute: (ctx, params) => {
    const objectId = params.objectId as string;
    const newValue = params.newValue as string;
    if (!objectId || !newValue) {
      return { success: false, description: "缺少 objectId 或 newValue", modified: false, error: "Missing parameters" };
    }
    const result = replaceSemanticValue(ctx.semanticDocument, objectId, newValue);
    if (!result.mutated) {
      return { success: false, description: `未修改（对象 ${objectId} 可能不存在或值相同）`, modified: false };
    }
    return {
      success: true,
      data: { oldValue: result.glyphMutation, newValue },
      description: `字段 ${objectId} 已从原值修改为 "${newValue}"`,
      modified: true,
      modifiedDocument: result.document,
      modifiedSemanticDocument: result.semanticDocument,
    };
  },
};

/** summarize：总结文档 */
const summarizeTool: Tool = {
  name: "summarize",
  description: "总结文档内容（文档类型 + 语义字段概览）",
  parameters: {},
  highRisk: false,
  execute: (ctx) => {
    const schema = detectDocumentType(ctx.semanticDocument);
    const validation = validateAgainstSchema(ctx.semanticDocument, schema);
    const objects = ctx.semanticDocument.objects;
    const summary = objects
      .map((o) => `- ${o.label || o.type}: "${o.value}" (confidence: ${o.confidence.toFixed(2)})`)
      .join("\n");
    return {
      success: true,
      data: { documentType: schema.documentType, typeLabel: schema.typeLabel, validation },
      description: `文档类型: ${schema.typeLabel} (confidence: ${schema.confidence.toFixed(2)})\n语义字段 (${objects.length}):\n${summary}`,
      modified: false,
    };
  },
};

/** extractTable：提取表格 */
const extractTableTool: Tool = {
  name: "extractTable",
  description: "提取文档中的表格数据",
  parameters: {},
  highRisk: false,
  execute: (ctx) => {
    const tables = ctx.semanticDocument.objects.filter((o) => o.type === "tableField");
    if (tables.length === 0) {
      return { success: false, description: "未找到表格字段", modified: false };
    }
    return {
      success: true,
      objects: tables,
      data: tables.map((t) => ({ id: t.id, value: t.value })),
      description: `找到 ${tables.length} 个表格`,
      modified: false,
    };
  },
};

/** compareFields：比较字段关系 */
const compareFieldsTool: Tool = {
  name: "compareFields",
  description: "比较字段之间的关系（如日期一致性、金额匹配）",
  parameters: {
    type: { type: "SemanticObjectType", description: "要比较的字段类型", required: true },
  },
  highRisk: false,
  execute: (ctx, params) => {
    const type = params.type as SemanticObjectType;
    const fields = ctx.semanticDocument.objects.filter((o) => o.type === type);

    if (fields.length < 2) {
      return {
        success: true,
        description: `只有 ${fields.length} 个 ${type} 字段，无需比较`,
        modified: false,
        data: { consistent: true, fields: fields.map((f) => f.value) },
      };
    }

    // 比较所有同类型字段的值是否一致
    const values = fields.map((f) => f.value);
    const allSame = values.every((v) => v === values[0]);
    const inconsistencies = allSame
      ? []
      : fields.filter((f) => f.value !== values[0]).map((f) => ({
          objectId: f.id,
          value: f.value,
          expected: values[0],
          label: f.label,
        }));

    return {
      success: true,
      data: {
        consistent: allSame,
        fieldCount: fields.length,
        values,
        inconsistencies,
      },
      description: allSame
        ? `${fields.length} 个 ${type} 字段值一致（均为 "${values[0]}"）`
        : `发现 ${inconsistencies.length} 处 ${type} 不一致：\n${inconsistencies.map((i) => `  - ${i.label || i.objectId}: "${i.value}"（期望 "${i.expected}"）`).join("\n")}`,
      modified: false,
    };
  },
};

/** validateDocument：验证文档完整性 */
const validateDocumentTool: Tool = {
  name: "validateDocument",
  description: "验证文档是否满足其类型的 Schema（必需字段是否齐全）",
  parameters: {},
  highRisk: false,
  execute: (ctx) => {
    const schema = detectDocumentType(ctx.semanticDocument);
    const validation = validateAgainstSchema(ctx.semanticDocument, schema);
    const missingNames = validation.missing.map((e) => e.type);
    return {
      success: true,
      data: {
        documentType: schema.documentType,
        valid: validation.valid,
        found: validation.found.map((e) => e.type),
        missing: missingNames,
      },
      description: validation.valid
        ? `✅ 文档类型 "${schema.typeLabel}" 验证通过，所有必需字段齐全`
        : `⚠️ 文档类型 "${schema.typeLabel}" 缺少 ${validation.missing.length} 个必需字段：${missingNames.join(", ")}`,
      modified: false,
    };
  },
};

// ── Tool Registry ──

/** 所有内置工具 */
const BUILTIN_TOOLS: Tool[] = [
  findFieldTool,
  replaceValueTool,
  summarizeTool,
  extractTableTool,
  compareFieldsTool,
  validateDocumentTool,
];

/** Tool Registry 类 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor() {
    // 注册内置工具
    for (const tool of BUILTIN_TOOLS) {
      this.tools.set(tool.name, tool);
    }
  }

  /** 注册自定义工具 */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** 获取工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 获取所有工具 */
  getAll(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** 获取所有工具名称 */
  getNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /** 检查工具是否存在 */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** 执行工具 */
  async execute(
    name: string,
    ctx: ToolContext,
    params: ToolParams
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        success: false,
        description: `工具 "${name}" 不存在`,
        modified: false,
        error: `Tool "${name}" not found`,
      };
    }
    try {
      return await tool.execute(ctx, params);
    } catch (e: any) {
      return {
        success: false,
        description: `工具 "${name}" 执行失败: ${e.message}`,
        modified: false,
        error: e.message,
      };
    }
  }
}

/** 全局 ToolRegistry 实例 */
let _globalRegistry: ToolRegistry | null = null;

/** 获取全局 ToolRegistry */
export function getToolRegistry(): ToolRegistry {
  if (!_globalRegistry) {
    _globalRegistry = new ToolRegistry();
  }
  return _globalRegistry;
}
