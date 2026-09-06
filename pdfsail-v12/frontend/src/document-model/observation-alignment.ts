/**
 * observation-alignment.ts — Observation Alignment（Sprint45 · Validation Baseline）
 *
 * ⚠️ STATUS: PROTOTYPE（原型验证，非正式基线）
 *   ARB 决定：Alignment 建立在 Observation Semantics 之上。
 *   在定义 Semantic Unit 之前，Alignment 的"不同 Representation 对应同一 Identity"
 *   假设尚未验证，保留本实现作为探索证据，但不当作正式架构。
 *
 * 目的：把不同工具（Importer / pdf.js）的 Observation 对齐到同一 Identity，
 *       证明它们对应同一 Ground Truth（Representation 不同但 Identity 相同）。
 *
 * 升级自 Observation Trace：
 *   Trace       —— 我知道哪里不同。
 *   Alignment   —— 我知道它们其实对应同一个 Ground Truth。
 */
import type { Observation } from "./observation-model";
import { wordSequence } from "./observation-contract";
import {
  makeIdentity,
  identitiesMatch,
  identityKey,
} from "./observation-identity";

/** 对齐条目：期望侧与实侧对齐到同一 Identity */
export interface AlignmentEntry {
  page: number;
  /** Identity（归一化文本） */
  identityText: string;
  /** 期望侧定位（source + item ids） */
  expectedLoc: string;
  /** 实际侧定位 */
  actualLoc: string;
  /** 是否匹配（同一 Ground Truth） */
  matched: boolean;
  /** 具体差异（不匹配时） */
  note?: string;
}

/** Alignment 结果 */
export interface ObservationAlignmentResult {
  alignable: boolean;
  entries: AlignmentEntry[];
  matchCount: number;
  mismatchCount: number;
}

/**
 * 对齐两个 Observation。
 * 方法：按页，用词序列贪心对齐（期望侧 item 聚合 vs 实侧 item 聚合），
 *       对比 Identity（归一化词序列），标记匹配/不匹配。
 */
export function alignObservations(
  expected: Observation,
  actual: Observation,
): ObservationAlignmentResult {
  const entries: AlignmentEntry[] = [];
  let matchCount = 0;
  let mismatchCount = 0;
  const maxPages = Math.max(expected.pageCount, actual.pageCount);

  for (let pi = 0; pi < maxPages; pi++) {
    const e = expected.pages[pi];
    const a = actual.pages[pi];
    if (!e || !a) continue;

    // 期望侧（Importer）每个 item 视为一个语义单元
    const eItems = e.items.map((it) => ({ id: it.id, text: it.text, consumed: false }));
    // 实际侧（pdf.js）每个 item 同理
    const aItems = a.items.map((it) => ({ id: it.id, text: it.text, consumed: false }));

    // 贪心对齐：期望侧逐 item，尝试在实侧匹配
    for (const eIt of eItems) {
      if (eIt.consumed) continue;
      const eId = makeIdentity(`e-p${pi + 1}`, pi + 1, eIt.text);
      const eWords = eId.words;

      // 在实侧找连续未消费 items，拼成尽量接近的词序列
      let matchedActual: string[] = [];
      let matchedText = "";
      let matchedKey = "";
      for (let i = 0; i < aItems.length; i++) {
        if (aItems[i].consumed) continue;
        const candidate = wordSequence(aItems[i].text);
        const joined = [...matchedText.split(" "), ...candidate].filter(Boolean).join(" ");
        const candWords = wordSequence(joined);
        // 若候选词数 <= 期望词数，加入
        if (candWords.length <= eWords.length) {
          matchedText = joined;
          matchedKey = identityKey(joined);
          matchedActual.push(aItems[i].id);
          aItems[i].consumed = true;
        } else {
          break;
        }
        if (matchedKey === eId.normalizedText) break;
      }

      const aId = makeIdentity(`a-p${pi + 1}`, pi + 1, matchedText || eIt.text);
      const matched = identitiesMatch(eId, aId) || eWords.length === 0;
      const entry: AlignmentEntry = {
        page: pi + 1,
        identityText: eId.normalizedText,
        expectedLoc: `importer.${eIt.id}`,
        actualLoc: matchedActual.length > 0 ? `pdfjs.${matchedActual.join("+")}` : "(no match)",
        matched,
      };
      if (!matched) {
        entry.note = `text differs: "${eId.normalizedText}" vs "${aId.normalizedText}"`;
        mismatchCount++;
      } else {
        matchCount++;
      }
      entries.push(entry);
    }
  }

  return {
    alignable: entries.length > 0,
    entries,
    matchCount,
    mismatchCount,
  };
}
