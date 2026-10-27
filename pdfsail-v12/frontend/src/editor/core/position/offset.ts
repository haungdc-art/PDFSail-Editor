/**
 * editor/core/position/offset.ts — EDITOR-CORE-002
 *
 * 纯长度工具（§18）。只做计算，不做查找、不做校验、不抛位置错误（除显式说明）。
 *
 * 核心约束（§18）：
 *   getParagraphTextLength ≠ sum(run.length) + 人为 newline
 *   newline 是 **段落之间的结构边界**，不是段落文本的一部分。
 *   需要跨段落文本时用 range.ts 的 getTextRangeText()（显式以 "\n" 连接）。
 */

import type { Paragraph, TextRun } from "../document/types";

/**
 * Run 的文本长度 = UTF-16 code unit 数。
 *
 * 严禁改用 Array.from(text).length（那是 code point 数）。
 */
export function getRunTextLength(run: TextRun): number {
  return run.text.length;
}

/**
 * 段落的文本长度 = 所有 run 的 UTF-16 长度之和。
 *
 * **不包含**结尾 newline：newline 属于段落之间的结构边界（§18）。
 */
export function getParagraphTextLength(paragraph: Paragraph): number {
  let n = 0;
  for (const run of paragraph.runs) n += run.text.length;
  return n;
}

/**
 * 段落坐标系：某个 run 起始处的段落内偏移。
 *
 * runIndex 越界时返回段落总长（= 段落末尾），与 paragraphOffsetToPosition 的
 * "超出末尾取末尾" 行为保持一致，避免两处边界语义分叉。
 */
export function getRunStartOffsetInParagraph(paragraph: Paragraph, runIndex: number): number {
  let n = 0;
  const limit = Math.min(runIndex, paragraph.runs.length);
  for (let i = 0; i < limit; i++) n += paragraph.runs[i].text.length;
  return n;
}

/**
 * 把段落内偏移解析成 (runIndex, run 内偏移)。
 *
 * 边界语义（§20）：偏移落在 run 末尾时归属**当前 run**（offset = run.length），
 * 而不是下一个 run 的 offset 0 —— 两种表示都合法，这里取前者以保证 round-trip 稳定。
 */
export function resolveParagraphOffset(
  paragraph: Paragraph,
  offset: number
): { runIndex: number; runOffset: number } {
  const target = Math.max(0, Math.trunc(Number.isFinite(offset) ? offset : 0));
  let acc = 0;
  for (let i = 0; i < paragraph.runs.length; i++) {
    const len = paragraph.runs[i].text.length;
    if (target <= acc + len) return { runIndex: i, runOffset: target - acc };
    acc += len;
  }
  // 超出末尾 → 最后一个 run 的末尾（无 run 时返回 0/0，调用方需自行判空）
  const lastIndex = paragraph.runs.length - 1;
  if (lastIndex < 0) return { runIndex: 0, runOffset: 0 };
  return { runIndex: lastIndex, runOffset: paragraph.runs[lastIndex].text.length };
}
