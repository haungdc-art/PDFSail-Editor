/**
 * editor/features/ocrProjectionReplacement.ts — B2-C-Implementation-1
 *
 * **OCR replacement contract**（纯函数）：把 W2「按 page 删除该页全部 block」
 * 改成「只替换**本次 OCR 对应**的内容」。
 *
 * ── 为什么需要本模块（B2-C audit 确认的 production bug）────────────────
 * 旧 W2：
 *   ```ts
 *   const ocrPages = new Set(result.blocks.map(b => b.page));
 *   const nonOcrBlocks = prev.filter(b => !ocrPages.has(b.page));
 *   return [...nonOcrBlocks, ...renderedBlocks];
 *   ```
 * 语义是「OCR 某页完成 ⇒ 把该页**所有** docBlocks 清掉」⇒ 会误删：
 *   · 用户手加的 TextBlock / ImageBlock / Signature（authored）
 *   · 该页已有的 Core projection
 *
 * ── (b) 架构契约（用户裁决）───────────────────────────────────────────
 *   OCR result → 临时 docBlocks materialization → EditableDocument
 *              → renderToBlocks() → __coreProjection
 *   ⇒ OCR 文本一旦进入 EditableDocument，**Core projection 就是它的语义真相源**。
 *   ⇒ 不为 OCR authored 制造独立 id namespace（否决 (a)）；
 *     也不要求 merge 对 OCR authored 提供长期保护。
 *
 * ⚠️ 因此 **OCR authored block 与 Core projection block 共享同一 `ocr.id`**（已知且被接受）。
 *    本模块的删除判据必须同时考虑 **id** 与 **projection identity**，
 *    **不能**只用一个 `Set(id)` 猜（那会误伤同 id 的合法 authored，或漏删陈旧投影）。
 *
 * ── 删除 / 保留矩阵 ──────────────────────────────────────────────────
 *   删除：
 *     D1  prev.id ∈ ocrBlockIds
 *         —— 本次 OCR 的旧 materialization（W1 注入的 authored，id = ocr.id）
 *            以及上一次同 id 的 projection。
 *     D2  isCoreProjectionBlock(prev) && prev.page ∈ ocrPages
 *         —— 本次 OCR 覆盖页上的**陈旧 Core projection**（将被新投影整体替换）。
 *   保留：
 *     K1  用户 authored text / image / signature（**即使同页**也不删）
 *     K2  非 OCR 页上的 Core projection（与本次 OCR 无关）
 *   追加：
 *     全部 projected（renderToBlocks 产出，已标 __coreProjection）
 */

import type { Block } from "../types";
import { isCoreProjectionBlock } from "./docBlocksProjectionMerge";

export interface OcrReplacementInput {
  /** 本次 OCR 产出的 block id 集合（= `ocr.id`；与 projection 同 id） */
  readonly ocrBlockIds: ReadonlySet<string>;
  /** 本次 OCR 覆盖的页码（1-based；仅用于定位**陈旧 projection**，不是全页删除判据） */
  readonly ocrPages: ReadonlySet<number>;
  /** `renderToBlocks(EditableDocument)` 产出（已标 `__coreProjection`） */
  readonly projected: readonly Block[];
}

/**
 * 用本次 OCR 的 projection 替换 docBlocks 中「本次 OCR 对应」的内容，
 * **保留**用户 authored 与无关页 projection。
 *
 * 纯函数：不修改入参，返回新数组。
 */
export function replaceOcrProjection(
  previous: readonly Block[],
  input: OcrReplacementInput
): Block[] {
  const { ocrBlockIds, ocrPages, projected } = input;

  const kept: Block[] = [];
  for (const prev of previous) {
    // D1：本次 OCR 对应的旧 materialization / 同 id 旧投影
    if (ocrBlockIds.has(prev.id)) continue;
    // D2：本次 OCR 覆盖页上的陈旧 Core projection
    if (isCoreProjectionBlock(prev) && ocrPages.has(prev.page)) continue;
    // K1 / K2：其余（用户 authored + 无关页 projection）保留
    kept.push(prev);
  }

  // 追加新投影（OCR → EditableDocument → Core projection 的真相源）
  return [...kept, ...projected];
}
