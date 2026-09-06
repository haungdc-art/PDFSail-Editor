/**
 * observation-trace.ts — Observation Trace（Sprint45 · Validation Baseline，D4）
 *
 * 目的：把 Diff 追踪到具体"哪个页面、哪个 Block/TextItem、哪个 Word"，
 *       而非笼统的 text-mismatch。
 *
 * 输出示例：
 *   Page 5 | Importer Block12.Word8 "€" | pdf.js item19.Word8 "C" | DIFF
 */
import type { Observation, PageObservation } from "./observation-model";
import { wordSequence } from "./observation-contract";

/** 单个可追踪差异 */
export interface TraceEntry {
  page: number;
  /** 期望侧定位（如 Block12.Word8） */
  expectedLoc: string;
  expectedWord: string;
  /** 实际侧定位（如 item19.Word8） */
  actualLoc: string;
  actualWord: string;
}

/** Trace 结果 */
export interface ObservationTrace {
  traceable: boolean;
  entries: TraceEntry[];
}

/** 词序列对齐：返回两序列中不一致的词对（按位置对齐） */
function alignWords(
  expectedWords: string[],
  actualWords: string[],
): Array<{ index: number; expected: string; actual: string }> {
  const n = Math.max(expectedWords.length, actualWords.length);
  const result = [];
  for (let i = 0; i < n; i++) {
    const e = expectedWords[i] ?? "";
    const a = actualWords[i] ?? "";
    if (e !== a) {
      result.push({ index: i, expected: e, actual: a });
    }
  }
  return result;
}

/** 从 pageObservation 中定位第 N 个词所属的 item（block/textitem） */
function locateWord(pageObs: PageObservation, wordIndex: number): { loc: string } {
  // 遍历 items，累加词数，找到 wordIndex 落在哪个 item
  let count = 0;
  for (const item of pageObs.items) {
    const wc = wordSequence(item.text).length;
    if (wordIndex < count + wc) {
      const within = wordIndex - count;
      return { loc: `${item.id}.Word${within + 1}` };
    }
    count += wc;
  }
  return { loc: `Word${wordIndex + 1}` };
}

/**
 * 追踪两页 Observation 的文本差异，定位到具体 item.word。
 * 仅当两页均有 items 时输出可追踪条目。
 */
export function tracePageDiff(expectedPage: PageObservation, actualPage: PageObservation): TraceEntry[] {
  const entries: TraceEntry[] = [];
  if (expectedPage.items.length === 0 || actualPage.items.length === 0) {
    return entries; // 无 trace 结构，无法定位
  }
  const eWords = wordSequence(expectedPage.text);
  const aWords = wordSequence(actualPage.text);
  const diffs = alignWords(eWords, aWords);
  for (const d of diffs) {
    const eLoc = locateWord(expectedPage, d.index);
    const aLoc = locateWord(actualPage, d.index);
    entries.push({
      page: expectedPage.page,
      expectedLoc: eLoc.loc,
      expectedWord: d.expected,
      actualLoc: aLoc.loc,
      actualWord: d.actual,
    });
  }
  return entries;
}

/**
 * 追踪两个 Observation 的所有页面差异。
 * 返回可追踪的条目（定位到 item.word）。
 */
export function traceObservations(expected: Observation, actual: Observation): ObservationTrace {
  const entries: TraceEntry[] = [];
  const maxPages = Math.max(expected.pageCount, actual.pageCount);
  for (let i = 0; i < maxPages; i++) {
    const e = expected.pages[i];
    const a = actual.pages[i];
    if (!e || !a) continue;
    const pageEntries = tracePageDiff(e, a);
    entries.push(...pageEntries);
  }
  return { traceable: entries.length > 0, entries };
}
