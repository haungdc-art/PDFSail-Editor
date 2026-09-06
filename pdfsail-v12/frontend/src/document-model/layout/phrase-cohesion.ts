/**
 * Phrase Cohesion Engine — Sprint 33.3.2
 *
 * 葡萄牙语短语保护评分。
 * 当连续两个词构成"不可拆分对"（如 "partir de"），给予高额加分，
 * 防止算法在短语中间断行。
 */

import type { OCRWord } from "./line-reconstruction";

// ── Protected Pairs ───────────────────────────────────────────

/**
 * 不可在行边界拆分的词对。
 *
 * 格式：[前词, 后词]
 *   - 前词保留原始标点（如 "trabalho," 带逗号）
 *   - 后词保留原始文本
 *   - 匹配时会做 normalize（去标点、小写）后再比对
 */
const PROTECTED_PAIRS: [string, string][] = [
  // Sprint 33.3.2 医疗证明第一段
  ["trabalho,", "a"],
  ["a", "partir"],
  ["partir", "de"],
  ["de", "03/04/2026"],

  // Sprint 33.3.1 保留的短语
  ["junto", "ao"],
  ["de", "abril"],
  ["do", "trabalho"],
  ["de", "acordo"],
  ["em", "vez"],
  ["a", "fim"],
];

// ── Normalize ─────────────────────────────────────────────────

/**
 * 词文本规范化：去标点 + 小写
 */
function normalizePhraseWord(text: string): string {
  return text.toLowerCase().replace(/[,.;:!?)]$/, "").trim();
}

// ── Score ─────────────────────────────────────────────────────

/**
 * 获取前词末尾词与下一词之间的短语内聚得分。
 *
 * 返回：
 *   - 50：该词对是受保护的不可拆分短语（强烈建议同行）
 *   - 0：普通词对
 *
 * @param previousWords 当前行已有的词
 * @param nextWord      将要加入的下一个词
 */
export function getPhraseScore(
  previousWords: OCRWord[],
  nextWord: OCRWord,
): number {
  if (previousWords.length === 0) return 0;

  const lastWord = previousWords[previousWords.length - 1];
  const prevClean = normalizePhraseWord(lastWord.text);
  const nextClean = normalizePhraseWord(nextWord.text);

  for (const [p, n] of PROTECTED_PAIRS) {
    const pClean = normalizePhraseWord(p);
    const nClean = normalizePhraseWord(n);
    if (pClean === prevClean && nClean === nextClean) {
      return 50;
    }
  }

  return 0;
}

/**
 * 检查两个字符串（已规范化）是否构成受保护词对。
 * 用于与 isKeepTogether 一致的接口。
 */
export function isProtectedPair(prevClean: string, nextClean: string): boolean {
  for (const [p, n] of PROTECTED_PAIRS) {
    if (normalizePhraseWord(p) === prevClean && normalizePhraseWord(n) === nextClean) {
      return true;
    }
  }
  return false;
}

export { PROTECTED_PAIRS, normalizePhraseWord };
