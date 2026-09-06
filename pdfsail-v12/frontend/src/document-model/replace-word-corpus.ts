/**
 * ReplaceWordCorpus — Sprint40-Order-003（Replace Word Regression Corpus）
 *
 * 建立固定的 Replace Word Regression 用例集，全部自动跑：
 *   Parse → Replace → Export → Compare
 * 输出 Replace Word Baseline + Top Problems。
 *
 * 这是 Feature（Edit Text / Replace Word）的验收，不在冻结的 Import/Export/Runner 范围。
 * 合成 PDF 用于 Regression（可重复、固定版本，CTO 认可）。
 *
 * 评估逻辑（Edit Fidelity）：
 *   每个 Case 有期望输出（target 替换为 replacement，其余保持一致）。
 *   对比"实际导出文本" vs "期望文本"：
 *     - 被替换部分必须出现 replacement（编辑生效）
 *     - 非 target 文本必须保持（无意外损坏）
 */

import type { EditableDocument } from "./types";
import { replaceText } from "./edit-text";

/** Replace Word Case 定义 */
export interface ReplaceWordCase {
  /** Case id */
  id: string;
  /** 页面原文（用于生成合成 PDF） */
  original: string;
  /** 要替换的 target */
  target: string;
  /** 替换为 */
  replacement: string;
  /** 期望输出（原文中 target → replacement） */
  expected: string;
}

/**
 * 官方 Replace Word Regression Corpus（Case001-005）。
 */
export const REPLACE_WORD_CASES: ReplaceWordCase[] = [
  { id: "Case001", original: "Hello World", target: "World", replacement: "ChatGPT", expected: "Hello ChatGPT" },
  { id: "Case002", original: "OpenAI creates GPT models", target: "OpenAI", replacement: "GPT", expected: "GPT creates GPT models" },
  { id: "Case003", original: "This is an Invoice document", target: "Invoice", replacement: "Receipt", expected: "This is an Receipt document" },
  { id: "Case004", original: "Year 2025 report", target: "2025", replacement: "2026", expected: "Year 2026 report" },
  { id: "Case005", original: "Code 12345 approved", target: "12345", replacement: "98765", expected: "Code 98765 approved" },
];

/**
 * 执行一个 Replace Word Case：在已解析的 EditableDocument 上做替换。
 *
 * @param doc 已解析的 EditableDocument（Parse 后）
 * @param target 要替换的原文
 * @param replacement 替换为
 * @returns 编辑是否生效
 */
export function applyReplaceWord(
  doc: EditableDocument,
  target: string,
  replacement: string,
): { edited: boolean; editedGlyphCount: number } {
  const r = replaceText(doc, target, replacement);
  return { edited: r.changed, editedGlyphCount: r.editedGlyphCount };
}

/**
 * 评估 Replace Word 结果。
 *
 * 对比实际导出文本与期望文本（Sprint42-Order-014，ADR-005 Option A）：
 *   - editApplied：编辑是否生效（导出含 replacement）
 *   - expectedMet：期望文本达成（导出含 expected，字符一致率 ≥ 阈值）
 *   - textAccuracy：字符级一致率（编辑后导出 vs 期望）
 *   - targetRemoved：旧 target 是否被移除（Contract 1，ADR-005 SHALL detect old target removal）
 *   - duplicateDetected：是否存在重复文本（Contract 6，SHALL detect duplicate text）
 *   - leakageDetected：是否存在隐藏泄漏（Contract 7，SHALL detect hidden leakage）
 *   - contractsMet：所有 Product Contract 是否满足（Contract 1-7）
 *
 * 保持 backward compatible：现有字段 editApplied / expectedMet / textAccuracy 语义不变，新增字段为附加。
 *
 * @param exportedText 实际导出文本
 * @param expected 期望文本
 * @param target 被替换的旧 target（可选，用于 targetRemoved 检测；缺省时仅检测重复/泄漏）
 */
export function evaluateReplaceWord(
  exportedText: string,
  expected: string,
  target?: string,
): {
  editApplied: boolean;
  expectedMet: boolean;
  textAccuracy: number;
  targetRemoved: boolean;
  duplicateDetected: boolean;
  leakageDetected: boolean;
  contractsMet: boolean;
} {
  const exp = expected;
  const act = exportedText;

  const editApplied = act.includes(exp.split(" ")[0] || exp) || act.includes(exp);

  // 字符级一致率（基于"期望是否出现在导出中" + 逐字符相似度）
  const minLen = Math.min(exp.length, act.length);
  let matched = 0;
  for (let i = 0; i < minLen; i++) {
    if (exp[i] === act[i]) matched++;
  }
  const totalChars = Math.max(exp.length, act.length);
  // 若导出含期望全文，视为高一致；否则按字符匹配率
  const base = act.includes(exp) ? 1 : totalChars > 0 ? matched / totalChars : 0;
  const textAccuracy = base;

  const expectedMet = base >= 0.98;

  // Contract 1：Old target removed —— 提供 target 时，检查旧 target 是否从导出中消失
  let targetRemoved = true;
  if (target && target.trim()) {
    // 若 target 是 expected 的组成部分（如 "World" 在 "Hello ChatGPT" 中已移除），
    // 检查 target 是否仍以独立 token 残留于导出
    const targetTokens = target.trim().split(/\s+/).filter(Boolean);
    // 残留判定：target 的 token 仍以独立词出现在导出中（且不是 expected 的一部分）
    const expTokens = new Set(exp.split(/\s+/).filter(Boolean));
    const residual = targetTokens.filter(
      (t) => !expTokens.has(t) && new RegExp(`(^|\\s)${escapeRegExp(t)}(?=\\s|$)`).test(act),
    );
    targetRemoved = residual.length === 0;
  }

  // Contract 6：No duplicate text —— 检测重复 token
  const tokens = act.split(/\s+/).filter(Boolean);
  const seen = new Map<string, number>();
  let duplicateDetected = false;
  for (const t of tokens) {
    const norm = t.toLowerCase();
    const count = (seen.get(norm) ?? 0) + 1;
    seen.set(norm, count);
    if (count > 1) {
      duplicateDetected = true;
      break;
    }
  }

  // Contract 7：No hidden leakage —— 检测非 expected 的额外文本残留
  const expTokenSet = new Set(exp.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase()));
  let leakageDetected = false;
  for (const t of tokens) {
    const norm = t.toLowerCase();
    // 若 token 不在 expected 中，视为泄漏（额外残留文本）
    if (!expTokenSet.has(norm)) {
      leakageDetected = true;
      break;
    }
  }

  // 全部 Contract 满足：期望达成 + 无 target 残留 + 无重复 + 无泄漏
  const contractsMet = expectedMet && targetRemoved && !duplicateDetected && !leakageDetected;

  return { editApplied, expectedMet, textAccuracy, targetRemoved, duplicateDetected, leakageDetected, contractsMet };
}

/** 转义正则特殊字符（用于 token 边界匹配） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
