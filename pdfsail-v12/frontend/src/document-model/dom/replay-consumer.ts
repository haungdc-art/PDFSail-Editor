/**
 * replay-consumer.ts — ReplayConsumer（Sprint-121 · Task-3）
 *
 * ADR-045 · Consumer Architecture。
 *
 * ## 第三个 Consumer：ReplayConsumer
 *
 *   Builder → Page（唯一事实来源）
 *     ├──► ValidatorConsumer.consume(DomDocument)   ✅ Task-1（是否合法）
 *     ├──► BenchmarkConsumer.consume(DomDocument)   ✅ Task-2（是否完整）
 *     └──► ReplayConsumer.consume(DomDocument)      ← 本文件（是否一致）
 *
 * ## 职责
 * ReplayConsumer 度量 DOM 的**一致性**（Deterministic / Fingerprint）。
 * 它以后很可能成为 Regression / Golden / CI / Benchmark Replay / Debug Replay 的基础，
 * 因此**必须 Deterministic**：同一份 Page，多次 consume，输出永远一致。
 *
 * ## Deterministic 保证（PM 要求）
 * - 纯函数，不依赖 Runtime / Cache / Time / Random / Global State
 * - 通过**规范化序列化 + 确定性哈希**（FNV-1a）计算指纹
 * - 同一输入 → 永远同一指纹
 *
 * ## 规范（Consumer Architecture）
 * - 实现统一 `Consumer<T, R>`，唯一入口 consume(DomDocument)
 * - 只消费 DOM（DomDocument），**禁止依赖 EditableDocument**
 * - 与 Validator / Benchmark **平行**，不调用其他 Consumer
 * - 纯消费，不修改输入
 *
 * 纯函数（ADR-005），Node 可测。
 */

import { Consumer } from "./consumer";
import { DomDocument } from "./types";

/** Replay 结果 */
export interface ReplayResult {
  readonly pass: boolean;
  /** DOM 确定性指纹（同一输入恒同；用于一致性对比） */
  readonly fingerprint: string;
  /** 页面数（诊断） */
  readonly pageCount: number;
}

/**
 * FNV-1a 32-bit 哈希（确定性、纯函数、无状态）。
 * @param str 输入字符串
 * @returns 32-bit 无符号整数
 */
export function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * 规范化序列化 DomDocument（确定性）。
 * 只序列化文档**内容**（metadata + 各层对象的 type/editable/anchor/bbox），
 * 忽略 id 前缀等可能不稳定的字段。同一逻辑输入恒得同一字符串。
 * @param document DOM 文档
 * @returns 规范化字符串
 */
export function serializeDeterministic(document: DomDocument): string {
  const parts: string[] = [];
  for (const page of document.pages) {
    const metas: string[] = [];
    metas.push(`${page.metadata.index}|${page.metadata.width}|${page.metadata.height}`);
    const base = page.layers.base.map((o) => `B:${o.type}:${o.editable}:${o.anchor}:${o.bbox.x},${o.bbox.y},${o.bbox.width},${o.bbox.height}`);
    const content = page.layers.content.map((o) => `C:${o.type}:${o.editable}:${o.anchor}:${o.bbox.x},${o.bbox.y},${o.bbox.width},${o.bbox.height}`);
    parts.push(`[${metas.join("")}|${base.join("|")}|${content.join("|")}]`);
  }
  return parts.join("");
}

/** 计算 DOM 确定性指纹 */
export function fingerprintOf(document: DomDocument): string {
  const serialized = serializeDeterministic(document);
  return fnv1a(serialized).toString(16);
}

/**
 * ReplayConsumer：度量 DOM 一致性（Deterministic fingerprint）。
 * 只消费 DomDocument，不依赖 EditableDocument，不调用其他 Consumer。
 * Deterministic：同一输入 → 同一 fingerprint。
 */
export class ReplayConsumer implements Consumer<DomDocument, ReplayResult> {
  /** Consumer Identity（稳定身份，为 Registry 准备） */
  readonly id = "replay";
  consume(document: DomDocument): ReplayResult {
    const fingerprint = fingerprintOf(document);
    // 一致性：本 Consumer 是纯函数，同一输入恒得同一 fingerprint → pass 恒 true
    // （真正的一致对比由调用方用 fingerprint 判断）
    return { pass: true, fingerprint, pageCount: document.pages.length };
  }
}

/**
 * 一致性判断：对比实际与期望指纹是否一致。
 * @param actual 实际 fingerprint
 * @param expected 期望 fingerprint
 * @returns 是否一致
 */
export function isReplayConsistent(actual: string, expected: string): boolean {
  return actual === expected;
}

/** 便捷工厂 */
export function createReplayConsumer(): ReplayConsumer {
  return new ReplayConsumer();
}
