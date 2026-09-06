/**
 * observation-diff.ts — Observation Diff（Sprint45 · Validation Baseline，Deliverable 3）
 *
 * 目的：任何 FAIL 必须先有 Diff（而非只有 PASS/FAIL）。
 * 输出具体差异：文本级 / 单词数级 / bbox 级 / 页数级。
 * 依赖 Observation Contract：Diff 必须按 Contract 判定（空白忽略、词序列严格）。
 */
import type { Observation, PageObservation } from "./observation-model";
import { textMatchesContract, normalizeTextForCompare, wordSequence } from "./observation-contract";

/** 差异类型 */
export type DiffKind =
  | "page-count"
  | "text-mismatch"
  | "word-count-mismatch"
  | "first-word-mismatch"
  | "bbox-count-mismatch";

/** 单条差异 */
export interface ObservationDiffItem {
  kind: DiffKind;
  page?: number;
  expected: string | number;
  actual: string | number;
  /** 人类可读描述 */
  note: string;
}

/** Diff 结果 */
export interface ObservationDiffResult {
  consistent: boolean;
  diffs: ObservationDiffItem[];
}

/**
 * 比较两个 Observation（expected = Ground Truth 或参考，actual = 待测工具）。
 * 返回结构化 Diff，而非单一 PASS/FAIL。
 */
export function diffObservations(expected: Observation, actual: Observation): ObservationDiffResult {
  const diffs: ObservationDiffItem[] = [];

  // 1. 页数
  if (expected.pageCount !== actual.pageCount) {
    diffs.push({
      kind: "page-count",
      expected: expected.pageCount,
      actual: actual.pageCount,
      note: `page count differs (${expected.pageCount} vs ${actual.pageCount})`,
    });
  }

  // 2. 逐页对比
  const maxPages = Math.max(expected.pageCount, actual.pageCount);
  for (let i = 0; i < maxPages; i++) {
    const e = expected.pages[i];
    const a = actual.pages[i];
    const page = i + 1;

    if (!e || !a) continue; // 页数差异已报

    // 文本级差异 —— 按 Contract 判定：
    //   whitespace / multipleSpaces / lineBreak → ignore
    //   wordSequence / wordCount / firstWord → strict
    const eNorm = normalizeTextForCompare(e.text);
    const aNorm = normalizeTextForCompare(a.text);
    const eWords = wordSequence(eNorm);
    const aWords = wordSequence(aNorm);

    // Contract: 若归一化词序列一致，则文本差异视为可忽略（whitespace/多空格/换行）
    if (!textMatchesContract(e.text, a.text)) {
      diffs.push({
        kind: "text-mismatch",
        page,
        expected: e.text,
        actual: a.text,
        note: describeTextDiff(e.text, a.text),
      });
    }
    // 单词数（基于归一化词序列，Contract: strict）
    if (eWords.join(" ") !== aWords.join(" ")) {
      // 仅当确实不同才报（避免重复报 text-mismatch）
      if (!eWords.join(" ").startsWith(aWords.join(" ")) && !aWords.join(" ").startsWith(eWords.join(" "))) {
        diffs.push({
          kind: "word-count-mismatch",
          page,
          expected: eWords.length,
          actual: aWords.length,
          note: `word count differs (${eWords.length} vs ${aWords.length})`,
        });
      }
    }
    // 第一个单词（Contract: strict）
    const eFirst = eWords[0] ?? "";
    const aFirst = aWords[0] ?? "";
    if (eFirst !== aFirst) {
      diffs.push({
        kind: "first-word-mismatch",
        page,
        expected: eFirst,
        actual: aFirst,
        note: `first word differs ("${eFirst}" vs "${aFirst}")`,
      });
    }
    // bbox 数（Contract: optional，不参与一致性判定，仅当差异大时记录）
    if (e.bboxCount !== a.bboxCount) {
      diffs.push({
        kind: "bbox-count-mismatch",
        page,
        expected: e.bboxCount,
        actual: a.bboxCount,
        note: `bbox count differs (${e.bboxCount} vs ${a.bboxCount})`,
      });
    }
  }

  return { consistent: diffs.length === 0, diffs };
}

/** 描述文本差异（识别多余空格/字符差异） */
function describeTextDiff(expected: string, actual: string): string {
  if (expected.length === actual.length) {
    // 找出第一个不同字符位置
    for (let i = 0; i < expected.length; i++) {
      if (expected[i] !== actual[i]) {
        return `char mismatch at index ${i} ("${expected[i]}" vs "${actual[i]}")`;
      }
    }
    return "text differs (same length)";
  }
  if (actual.includes(expected)) {
    return `actual has extra content: ${JSON.stringify(actual.slice(expected.length, expected.length + 20))}`;
  }
  if (expected.includes(actual)) {
    return `actual missing content: ${JSON.stringify(expected.slice(actual.length, actual.length + 20))}`;
  }
  return `text differs (len ${expected.length} vs ${actual.length})`;
}
