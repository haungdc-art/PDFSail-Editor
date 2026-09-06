/**
 * editable-page-compat.ts — Page → EditablePage 兼容适配层（Sprint-120 · Phase 2）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 *
 * Phase 2 架构转换：Builder 内部以 **Page 为唯一生产模型**，EditablePage 降级为兼容适配层。
 *
 *   Builder
 *       │
 *       ▼
 *   Page（唯一事实来源）
 *       │
 *       ├────────► EditablePage（此文件：兼容适配，非事实来源）
 *       │
 *       └────────► Scene（未来 Phase 3）
 *
 * 这是**单向**的（Page → EditablePage），**绝不引入反向**（EditablePage → Page）。
 * 当 EditablePage 完全退出历史舞台时，删除此文件，不做双向同步。
 *
 * ## 等价性契约（Builder Equivalence，Task-2）
 *
 * 为满足"旧链 EditablePage == 新链 Page→Compat→EditablePage"完全等价：
 * - `createPage()` 把原始 EditableBlock 映射为 DomObject（ContentLayer 或 BaseLayer），并保留 `sourceId`。
 * - 本适配**按 sourceBlocks 原始顺序**遍历，凡 `sourceId` 出现在 Page 任一层的，原样找回原始 EditableBlock。
 * - PdfFallback 等无 `sourceId` 的结构性对象被跳过（它们不是原始 EditableBlock）。
 * - 结果 EditablePage.blocks 与旧 Builder 直接产出的 blocks **在顺序与内容上完全一致**（等价性 Lock）。
 *
 * 纯函数（ADR-005），Node 可测。
 */

import type { EditablePage, EditableBlock } from "../types";
import { DomPage } from "./page";

/**
 * 将 DomPage 兼容适配为 EditablePage。
 *
 * 等价性保证：按 sourceBlocks 顺序，找回所有被 Page 各层承载的原始 EditableBlock，
 * 使 EditablePage.blocks 与旧 Builder 直接产出完全一致（Builder Equivalence）。
 *
 * @param page DOM Page（Builder 生产的事实来源）
 * @param sourceBlocks 原始 EditableBlock[]（PDF/OCR Adapter 产出的完成态，含 glyph/line 数据）
 * @returns EditablePage（兼容产物，非事实来源）
 */
export function domPageToEditablePage(page: DomPage, sourceBlocks: readonly EditableBlock[]): EditablePage {
  // 收集 Page 各层承载的 sourceId 集合
  const carriedSourceIds = new Set<string>();
  for (const obj of page.layers.content) if (obj.sourceId) carriedSourceIds.add(obj.sourceId);
  for (const obj of page.layers.base) if (obj.sourceId) carriedSourceIds.add(obj.sourceId);

  // 按 sourceBlocks 原始顺序，找回所有被 Page 承载的原始 block
  // 保证与旧 Builder 直接产出的 blocks 顺序/内容一致
  const blocks: EditableBlock[] = [];
  for (const src of sourceBlocks) {
    if (carriedSourceIds.has(src.id)) {
      blocks.push(src); // 原样返回，不修改
    }
  }

  return {
    index: page.metadata.index,
    width: page.metadata.width,
    height: page.metadata.height,
    blocks,
  };
}
