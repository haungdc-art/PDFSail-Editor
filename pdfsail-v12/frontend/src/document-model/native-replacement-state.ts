/**
 * native-replacement-state.ts — M7.5-005E-C2B-2C-3A · Native Replacement State Producer
 *
 * 目标：回答「谁写入 EditableGlyph.nativeReplacementState」——建立唯一 producer：
 *
 *   Native replace success（checksum OK + patch OK + reload OK）
 *        │
 *        ▼
 *   glyph.nativeReplacementState = { bindingId, ready:true/false }
 *
 * 修正 Export 侧 C2B-2C-1/2 的缺口（此前 Export 消费、但 Editor/Mutation 未生产）。
 *
 * 允许（本阶段）：
 *   ✅ 提供 export metadata producer（把 native 替换结果沉淀到 Document Model）
 *   ✅ 提供 mutation success callback（applyNativeReplacementResult 作为 commit 后的回调入口）
 *   ✅ edit commit integration 入口
 *
 * 禁止（边界）：
 *   ❌ 修改 TextOperation 语义（不改 applyTextOperation / mutateLineText 契约）
 *   ❌ 修改 Undo 模型（不改 OperationHistory / inverse）
 *   ❌ 修改 Selection
 *
 * 语义：
 *   - ready=true   → 该区间已由原 PDF content stream 承担，Export 短路 overlay。
 *   - ready=false  → native 替换失败，Export 走 overlay fallback（不破坏）。
 *   每次 produce 以 `bindingId` 标识同一 native 替换（line/block 级共享）；
 *   Export 侧 deriveNativeRoutingFromBlock 要求行内同 bindingId + all-ready 才判定整行 native-ready。
 */

import type { EditableDocument, EditableBlock, EditableGlyph } from "./types";

export interface NativeReplacementTarget {
  /** 命中 block ID */
  blockId: string;
  /** 参与替换的 line 索引 */
  lineIndex: number;
  /** 目标页码（0-based，可选） */
  pageIndex?: number;
  /** 参与替换的 glyph 区间起点（含）；缺省 0 */
  glyphStart?: number;
  /** 参与替换的 glyph 区间终点（含）；缺省 = 行末 */
  glyphEnd?: number;
  /** native replacement 标识（此行/块共享） */
  bindingId: string;
  /** 是否替换成功就绪 */
  ready: boolean;
  /** M7.7-004A：原生替换的目标算子整文本（单一事实源，供 Export native rewrite 精确匹配） */
  originalText?: string;
  /** M7.7-004A：编辑后的替换文本（单一事实源，native rewrite 的写入目标） */
  replacementText?: string;
}

/**
 * block 级 producer（纯函数，不可变，不修改输入）。
 * 把 native 替换结果标记到目标行 glyph 上。
 */
export function produceNativeReplacementState(
  block: EditableBlock,
  target: NativeReplacementTarget,
): EditableBlock {
  const line = block.lines[target.lineIndex];
  if (!line) return block;

  const start = Math.max(0, target.glyphStart ?? 0);
  const end = Math.min(line.glyphs.length - 1, target.glyphEnd ?? line.glyphs.length - 1);
  if (start > end) return block;

  const glyphs: EditableGlyph[] = line.glyphs.map((g, i) => {
    if (i < start || i > end) return g;
    return {
      ...g,
      nativeReplacementState: {
        bindingId: target.bindingId,
        ready: target.ready,
        originalText: target.originalText ?? g.nativeReplacementState?.originalText,
        replacementText: target.replacementText ?? g.nativeReplacementState?.replacementText,
      },
    };
  });

  return {
    ...block,
    lines: block.lines.map((l, ii) =>
      ii === target.lineIndex ? { ...l, glyphs } : l,
    ),
  };
}

/**
 * 文档级 producer / edit-commit success callback（不可变）。
 *
 * 调用方在「native 替换尝试」之后调用：
 *   - 全部成功 → targets 全 ready:true（Export 短路该区间 overlay）。
 *   - 任一失败 → 对应 target ready:false（Export 回退 overlay，避免混合态）。
 *
 * 按 block 批量应用到同一行时，多次 produce 顺序应用（后写覆盖）。
 */
export function applyNativeReplacementResult(
  doc: EditableDocument,
  targets: NativeReplacementTarget[],
): EditableDocument {
  if (targets.length === 0) return doc;

  const byBlock = new Map<string, NativeReplacementTarget[]>();
  for (const t of targets) {
    const arr = byBlock.get(t.blockId) || [];
    arr.push(t);
    byBlock.set(t.blockId, arr);
  }

  const pages = doc.pages.map((page) => ({
    ...page,
    blocks: page.blocks.map((block) => {
      const list = byBlock.get(block.id);
      if (!list) return block;
      let cur = block;
      for (const t of list) cur = produceNativeReplacementState(cur, t);
      return cur;
    }),
  }));

  return { ...doc, pages };
}