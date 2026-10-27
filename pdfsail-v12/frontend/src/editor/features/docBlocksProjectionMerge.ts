/**
 * B2-B-A — docBlocks Projection Merge Contract
 *
 * 背景（以当前代码树为准，不依赖历史记忆）：
 *   docBlocks: Block[] 是一个 heterogeneous 容器，混合三类内容：
 *
 *   (A) Core / EditableDocument 文本投影
 *       —— 由 renderToBlocks() 产生，id = EditableBlock.id（如 pdf_p1_block0），
 *          并携带 __coreProjection === true 标记。
 *
 *   (B) 用户创作对象（image / signature / redact / highlight / comment）
 *       —— 由 addBlock 直接写入，id 为 uuid；renderToBlocks 永远不会产生这些类型。
 *
 *   (C) 用户创作文本（manual addBlock("text")、PDFCanvas 编辑、MainToolbar、
 *       FindReplaceBar、useOCR region 注入等）
 *       —— 也是 TextBlock，但没有 __coreProjection 标记，因此被当作创作文本保留。
 *
 *   另外：当前 13 个 production call site 全部是
 *       setDocBlocks(renderToBlocks(...))  ← 全量替换，会清空 (B)/(C) 类创作对象。
 *
 * 身份判定（可靠条件）：
 *   - 一个 TextBlock 是 “Core 投影所有” 当且仅当 __coreProjection === true。
 *     只有投影生产者（renderToBlocks）允许打这个标记。
 *   - 非 text 的 Block 永远是用户创作对象 → 永远保留。
 *   - 无标记的 TextBlock（manual / OCR 注入 / 工具栏 / 查找替换）→ 视为创作文本 → 保留。
 *
 * 合并规则：
 *   - 非 text 的 previous block → 保留。
 *   - 有标记的 previous TextBlock（旧投影）：
 *       · 若 id 在新投影中存在 → 由新投影替换（下方统一加入，避免重复）；
 *       · 若 id 不存在于新投影 → Core 文档已删除该文本 → 丢弃（避免 stale ghost）。
 *   - 无标记的 previous TextBlock（创作文本）：
 *       · 若 id 与某个新投影 id 冲突 → 投影优先（丢弃创作文本，Core 真相优先）；
 *       · 否则 → 保留。
 *   - 新投影（projected）全部加入（Core 文本当前真相）。
 *
 * 顺序约定（确定性，便于渲染）：
 *   结果 = [previous 中的创作 block（保持原相对顺序）] ++ [projected（保持 renderToBlocks 顺序）]。
 *   投影 block 一律放在末尾，创作对象保留其相对位置。B2-D（annotation ownership）
 *   可后续细化空间顺序，本阶段只保证“不丢失 / 不残留 / 不重复”。
 *
 * 本阶段只建立 contract + pure implementation + tests，不接入生产（不改 13 个 call site）。
 */

import type { Block, TextBlock } from "../types";

/** 带投影标记的 TextBlock（结构扩展，不修改 Block 联合本身以外的运行时行为）。 */
export type ProjectionTextBlock = TextBlock & { __coreProjection?: boolean };

/** 判定一个 block 是否为 Core 投影所有（可被重投影 / 删除）。 */
export function isCoreProjectionBlock(block: Block): boolean {
  return (
    block.type === "text" &&
    (block as ProjectionTextBlock).__coreProjection === true
  );
}

/**
 * B2-B 生产接线时使用：给 renderToBlocks 的输出打投影标记。
 * 保持其它字段不变，只追加一个布尔标记。
 */
export function markAsProjection(block: Block): Block {
  return {
    ...(block as unknown as Record<string, unknown>),
    __coreProjection: true,
  } as unknown as Block;
}

/**
 * 合并 previous（当前 docBlocks）与 projected（本次 renderToBlocks 输出）。
 *
 * 见文件头部的合并规则与顺序约定。纯函数：不修改入参，返回新数组。
 */
export function mergeDocBlocksProjection(
  previous: Block[],
  projected: Block[]
): Block[] {
  const projectedById = new Map<string, Block>();
  for (const p of projected) projectedById.set(p.id, p);

  const result: Block[] = [];
  for (const prev of previous) {
    if (isCoreProjectionBlock(prev)) {
      // 旧投影：被新投影替换（下方加入）或 Core 已删除（丢弃）。
      continue;
    }
    // 创作 block（含无标记文本）：保留，除非 id 与投影冲突（投影优先）。
    if (projectedById.has(prev.id)) continue;
    result.push(prev);
  }
  // 加入全部新投影（Core 文本当前真相）。
  for (const p of projected) result.push(p);
  return result;
}
