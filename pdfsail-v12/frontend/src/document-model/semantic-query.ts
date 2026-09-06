/**
 * Semantic Query Engine — Sprint 10 Task 3
 *
 * 语义查询引擎，支持自然语言查询 SemanticDocument。
 *
 * 支持：
 *   - find all dates → 所有 DateField
 *   - find patient name → NameField（role=patient）
 *   - find signature field → SignatureField
 *   - find invoice total → TextField（label 含 total/amount）
 *   - find CID → TextField（label 含 CID）
 *
 * 查询语法：
 *   query(semDoc, { type, role, label, scope })
 *
 * 返回匹配的 SemanticObject[]
 */

import type {
  SemanticDocument,
  AnySemanticObject,
  SemanticObjectType,
} from "./semantic-types";

/** 查询条件 */
export interface SemanticQuery {
  /** 类型 */
  type?: SemanticObjectType;
  /** 语义角色（如 patient/doctor/signer） */
  role?: string;
  /** 标签关键词 */
  labelKeywords?: string[];
  /** 值正则 */
  valuePattern?: RegExp;
  /** 匹配范围 */
  scope?: "first" | "all";
}

/** 查询结果 */
export interface QueryResult {
  /** 匹配的对象 */
  objects: AnySemanticObject[];
  /** 匹配数量 */
  count: number;
  /** 查询描述 */
  description: string;
}

/**
 * 执行语义查询
 *
 * @param semDoc SemanticDocument
 * @param query 查询条件
 * @returns QueryResult
 */
export function querySemanticObjects(
  semDoc: SemanticDocument,
  query: SemanticQuery
): QueryResult {
  let results = semDoc.objects;

  // 按类型过滤
  if (query.type) {
    results = results.filter((o) => o.type === query.type);
  }

  // 按角色过滤（检查 nameRole 或 label）
  if (query.role) {
    const lowerRole = query.role.toLowerCase();
    results = results.filter((o) => {
      // NameFieldObject 有 nameRole
      if (o.type === "nameField" && "nameRole" in o) {
        const nameRole = (o as { nameRole?: string }).nameRole;
        if (nameRole?.toLowerCase() === lowerRole) return true;
      }
      // 检查 label
      if (o.label?.toLowerCase().includes(lowerRole)) return true;
      return false;
    });
  }

  // 按标签关键词过滤
  if (query.labelKeywords && query.labelKeywords.length > 0) {
    results = results.filter((o) =>
      query.labelKeywords!.some((kw) =>
        o.label?.toLowerCase().includes(kw.toLowerCase())
      )
    );
  }

  // 按值正则过滤
  if (query.valuePattern) {
    results = results.filter((o) => query.valuePattern!.test(o.value));
  }

  // scope
  if (query.scope === "first") {
    results = results.slice(0, 1);
  }

  return {
    objects: results,
    count: results.length,
    description: describeQuery(query),
  };
}

/**
 * 自然语言查询解析
 *
 * 支持的查询模式：
 *   - "find all dates" / "所有日期" → type=dateField, scope=all
 *   - "find patient name" / "患者姓名" → type=nameField, role=patient
 *   - "find signature" / "签名" → type=signatureField
 *   - "find invoice total" / "发票总额" → type=textField, labelKeywords=[total,amount]
 *   - "find CID" → type=textField, labelKeywords=[cid]
 *
 * @param command 自然语言查询
 * @returns SemanticQuery | null
 */
export function parseNaturalLanguageQuery(command: string): SemanticQuery | null {
  const lower = command.toLowerCase().trim();

  // all dates
  if (/(?:all\s+dates|所有日期|所有日期字段)/i.test(lower)) {
    return { type: "dateField", scope: "all", description: "all dates" } as SemanticQuery;
  }

  // patient name
  if (/(?:patient\s+name|患者姓名|病人姓名|nome.*paciente)/i.test(lower)) {
    return { type: "nameField", role: "patient", scope: "first" };
  }

  // doctor name
  if (/(?:doctor\s+name|医生姓名|dr.*name)/i.test(lower)) {
    return { type: "nameField", role: "doctor", scope: "first" };
  }

  // signature
  if (/(?:signature|签名|assinatura)/i.test(lower)) {
    return { type: "signatureField", scope: "all" };
  }

  // invoice total
  if (/(?:invoice\s+total|total\s+amount|发票总额|金额)/i.test(lower)) {
    return { type: "textField", labelKeywords: ["total", "amount", "valor"], scope: "first" };
  }

  // CID
  if (/(?:cid|诊断码)/i.test(lower)) {
    return { type: "textField", labelKeywords: ["cid", "diagnosis"], scope: "first" };
  }

  // address
  if (/(?:address|地址|endereço)/i.test(lower)) {
    return { type: "addressField", scope: "all" };
  }

  // generic: find all X
  const findAllMatch = lower.match(/(?:find\s+all|所有|查询所有)\s*(.+)/);
  if (findAllMatch) {
    const type = resolveTypeFromName(findAllMatch[1].trim());
    if (type) return { type, scope: "all" };
  }

  // generic: find X
  const findMatch = lower.match(/(?:find|查找|查询)\s*(.+)/);
  if (findMatch) {
    const type = resolveTypeFromName(findMatch[1].trim());
    if (type) return { type, scope: "first" };
  }

  return null;
}

/**
 * 执行自然语言查询
 *
 * @param semDoc SemanticDocument
 * @param command 自然语言查询
 * @returns QueryResult | null
 */
export function executeNaturalLanguageQuery(
  semDoc: SemanticDocument,
  command: string
): QueryResult | null {
  const query = parseNaturalLanguageQuery(command);
  if (!query) return null;
  return querySemanticObjects(semDoc, query);
}

/** 从名称解析类型 */
function resolveTypeFromName(name: string): SemanticObjectType | null {
  const lower = name.toLowerCase();
  if (/date|日期/i.test(lower)) return "dateField";
  if (/name|姓名/i.test(lower)) return "nameField";
  if (/address|地址/i.test(lower)) return "addressField";
  if (/signature|签名/i.test(lower)) return "signatureField";
  if (/table|表格/i.test(lower)) return "tableField";
  return null;
}

/** 生成查询描述 */
function describeQuery(query: SemanticQuery): string {
  const parts: string[] = [];
  if (query.type) parts.push(`type=${query.type}`);
  if (query.role) parts.push(`role=${query.role}`);
  if (query.labelKeywords) parts.push(`labels=[${query.labelKeywords.join(",")}]`);
  if (query.scope) parts.push(`scope=${query.scope}`);
  return parts.join(", ");
}
