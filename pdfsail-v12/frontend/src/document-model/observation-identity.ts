/**
 * observation-identity.ts — Observation Identity（Sprint45 · Validation Baseline）
 *
 * ⚠️ STATUS: PROTOTYPE（原型验证，非正式基线）
 *   ARB 决定：Identity 建立在 Observation Semantics 之上。
 *   在定义 Semantic Unit 之前，Identity 不具备足够语义基础，
 *   保留本实现作为"方向值得探索"的证据，但不当作正式架构。
 *
 * 目的：证明"不同 Representation 对应同一个 Ground Truth"。
 * 例如：
 *   Importer Block12 "Invoice Number"
 *   pdf.js   Item17 "Invoice" + Item18 "Number"
 * 都映射到同一 Identity（normalizedText="Invoice Number"）。
 *
 * 与 Trace 的区别：
 *   Trace（知道哪里不同）
 *   Identity（证明它们其实是同一个 Ground Truth）
 */
import { wordSequence } from "./observation-contract";

/** Observation Identity：一组"归一化后文本相同"的观测的公共身份 */
export interface ObservationIdentity {
  /** 身份 ID（文档内唯一） */
  id: string;
  /** 归一化文本（匹配键） */
  normalizedText: string;
  /** 词序列 */
  words: string[];
  /** 出现页（首个） */
  page: number;
}

/**
 * 从归一化文本生成 Identity 键（用词序列作为匹配依据）。
 * 允许聚合粒度不同（"Invoice Number" == "Invoice" + "Number"）。
 */
export function identityKey(normalizedText: string): string {
  return wordSequence(normalizedText).join(" ");
}

/** 从文本生成一个 Identity */
export function makeIdentity(id: string, page: number, text: string): ObservationIdentity {
  const words = wordSequence(text);
  return {
    id,
    normalizedText: words.join(" "),
    words,
    page,
  };
}

/** 两个 Identity 是否匹配（词序列一致） */
export function identitiesMatch(a: ObservationIdentity, b: ObservationIdentity): boolean {
  return a.words.join(" ") === b.words.join(" ");
}

/**
 * 从一页的 Observation items 构建 Identity 列表。
 * 每个 item 生成一个 Identity（pdf.js 侧可能多个 item 拼接才对应一个 Importer block）。
 */
export function buildIdentityList(
  source: string,
  page: number,
  items: Array<{ id: string; text: string }>,
): Array<{ identity: ObservationIdentity; sourceItems: string[] }> {
  const list: Array<{ identity: ObservationIdentity; sourceItems: string[] }> = [];
  for (const item of items) {
    const words = wordSequence(item.text);
    if (words.length === 0) continue;
    list.push({
      identity: {
        id: `${source}-p${page}-${item.id}`,
        normalizedText: words.join(" "),
        words,
        page,
      },
      sourceItems: [item.id],
    });
  }
  return list;
}
