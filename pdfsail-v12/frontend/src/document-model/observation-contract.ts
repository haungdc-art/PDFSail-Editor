/**
 * observation-contract.ts — Observation Contract（Sprint45 · Validation Baseline，D3）
 *
 * layer: Core（Sprint45 Architecture Freeze 冻结）
 *
 * 目的：定义"哪些差异应该算差异，哪些差异应该被忽略"。
 * 没有 Contract，Diff 永远很多，却无法判断哪些 Diff 值得关注。
 *
 * 设计：按 Observation Level 定义一致性策略：
 *   Strict   —— 必须一致
 *   Ignore   —— 忽略（不算 Diff）
 *   Optional —— 不参与一致性判定（仅记录）
 */

/** 一致性策略 */
export type ComparePolicy = "strict" | "ignore" | "optional";

/** 单条规则 */
export interface ObservationRule {
  level: string;
  field: string;
  policy: ComparePolicy;
  note?: string;
}

/**
 * Observation Contract（默认规则集）。
 * 定义了 Document / Page / Text / Word / Glyph 各 Level 的一致性策略。
 */
export const OBSERVATION_CONTRACT: ObservationRule[] = [
  // Level 0 · Document
  { level: "document", field: "pageCount", policy: "strict", note: "总页数必须一致" },
  // Level 1 · Page
  { level: "page", field: "pageIndex", policy: "strict", note: "页索引必须一致" },
  // Level 2 · Text（归一化后）
  { level: "text", field: "wordCount", policy: "strict", note: "单词数必须一致" },
  { level: "text", field: "wordSequence", policy: "strict", note: "词序必须一致" },
  { level: "text", field: "firstWord", policy: "strict", note: "首词必须一致" },
  // 空白处理
  { level: "text", field: "whitespace", policy: "ignore", note: "空白差异忽略（如 Hello World vs Hello  World）" },
  { level: "text", field: "multipleSpaces", policy: "ignore", note: "多空格忽略" },
  { level: "text", field: "lineBreak", policy: "ignore", note: "换行差异忽略（词级拼接）" },
  // Level 3 · Word
  { level: "word", field: "case", policy: "ignore", note: "大小写差异忽略（可选，可改 strict）" },
  { level: "word", field: "hyphenation", policy: "ignore", note: "断词差异忽略" },
  // Level 4 · Glyph / BBox
  { level: "glyph", field: "bbox", policy: "optional", note: "Glyph bbox 不参与一致性判定（仅记录）" },
  { level: "glyph", field: "position", policy: "optional", note: "位置不参与判定" },
];

/** 查询某字段的策略 */
export function policyFor(level: string, field: string): ComparePolicy {
  const rule = OBSERVATION_CONTRACT.find((r) => r.level === level && r.field === field);
  return rule?.policy ?? "strict"; // 默认 strict（未定义则保守要求一致）
}

/** 归一化文本（应用 ignore 规则：空白/多空格/换行） */
export function normalizeTextForCompare(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 提取词序列（用于 wordSequence 对比） */
export function wordSequence(text: string): string[] {
  return text.match(/[A-Za-z0-9]+/g) ?? [];
}

/**
 * 判断两个文本是否满足 Contract（考虑 whitespace/multipleSpaces/lineBreak 忽略规则）。
 * 用于 text-mismatch 之前的一层过滤：若按 Contract 应忽略，则不产生 Diff。
 */
export function textMatchesContract(expected: string, actual: string): boolean {
  const eNorm = normalizeTextForCompare(expected);
  const aNorm = normalizeTextForCompare(actual);
  // 词序列严格一致（wordSequence strict）
  const eWords = wordSequence(eNorm).join(" ");
  const aWords = wordSequence(aNorm).join(" ");
  return eWords === aWords;
}
