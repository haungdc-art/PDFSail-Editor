/**
 * native-export-router.ts — M7.5-005E-C2B-2C-1 · Native Replace Path Routing
 *
 * 目标：让 Export pipeline「知道某个 block/line 已 native replaced」，
 *       从而对该区间的 overlay（白色 mask + 重新绘制文字）做短路，改用原生文本。
 *
 *   if (binding && replacementSuccess)
 *       → 跳过 overlay command（原 PDF content stream 已含 native 新文本，无需再遮+再画）
 *   else
 *       → fallback overlay（维持现状）
 *
 * 范围（C2B-2C-1 路由层）：
 *   ✅ 提供 NativeReplaceRouting 数据 + 纯函数 filterOverlayForNativeReplaced
 *   ✅ 复用现有 ExportCommand 的 blockId/lineIndex/purpose，不改命令字段
 *   ✅ minimal 接入 writeExportCommandsToPDF（可选参数，缺省 = 无路由 = 行为不变）
 *   ❌ 不删除 mask 全局逻辑 / 不重写 Renderer / 不改所有 Export command / 不接 Undo
 *
 * 粒度约定：
 *   - replacedLines：某 `blockId:lineIndex` 行已 native 替换 → 跳过该行重绘
 *   - fullyReplacedBlocks：某 block 整块已 native 替换 → 跳过该 block 的白色 mask + 全部重绘
 */

import type { ExportCommand } from "./export-command";
import type { EditableBlock } from "./types";

export interface NativeReplaceRouting {
  /** lineKey `${blockId}:${lineIndex}` → 该行已 native 替换，跳过 overlay 重绘 */
  replacedLines: Set<string>;
  /** blockId → 整块已 native 替换，跳过白色 mask + 全部重绘 */
  fullyReplacedBlocks: Set<string>;
}

export const EMPTY_NATIVE_ROUTING: NativeReplaceRouting = {
  replacedLines: new Set(),
  fullyReplacedBlocks: new Set(),
};

/** 生成 lineKey */
export function nativeLineKey(blockId: string, lineIndex: number): string {
  return `${blockId}:${lineIndex}`;
}

/**
 * 由替换记录构建路由。
 * records：{ blockId, lineIndex, blockFullyReplaced? }
 */
export function buildNativeReplaceRouting(
  records: Array<{
    blockId: string;
    lineIndex: number;
    /** 整块是否已 native 替换（跳过 mask）；默认按单行处理 */
    blockFullyReplaced?: boolean;
  }>,
): NativeReplaceRouting {
  const routing: NativeReplaceRouting = {
    replacedLines: new Set(),
    fullyReplacedBlocks: new Set(),
  };
  for (const r of records) {
    routing.replacedLines.add(nativeLineKey(r.blockId, r.lineIndex));
    if (r.blockFullyReplaced) routing.fullyReplacedBlocks.add(r.blockId);
  }
  return routing;
}

/**
 * C2B-2C-2 · 从 block 编辑态自动推导 Native Replace Routing（纯函数，不修改 block）。
 *
 * 规则（M7.7-004A 扩展）：
 *   - 某行 native-ready：该行所有 glyph 均 `nativeReplacementState.ready === true`
 *     且共享同一 `bindingId`（歧义 → 判定不 ready，安全回退 overlay）。
 *   - 某行未触碰：该行无任何 glyph 带 nativeReplacementState / modified 标记且原文未变
 *     → 原 PDF content stream 已正确承载该行，无需 mask + 重绘（避免未编辑原生文本被 Helvetica overlay 覆盖）。
 *   - 整块 skip-overlay：block 所有行（非空）均 native-ready 或未触碰 → 跳过该块白色 mask + 全部重绘。
 *   - 编辑过但 native 失败的行走 legacy overlay（mask + 重绘）。
 */
export function deriveNativeRoutingFromBlock(block: EditableBlock): NativeReplaceRouting {
  const routing: NativeReplaceRouting = {
    replacedLines: new Set(),
    fullyReplacedBlocks: new Set(),
  };
  if (block.type !== "text" || block.lines.length === 0) return routing;

  let allLinesSkipOverlay = true;
  for (let li = 0; li < block.lines.length; li++) {
    const glyphs = block.lines[li].glyphs;
    if (glyphs.length === 0) {
      allLinesSkipOverlay = false;
      continue;
    }
    const everyReady = glyphs.every((g) => g.nativeReplacementState?.ready === true);
    const bindingIds = new Set<string>();
    for (const g of glyphs) {
      const bid = g.nativeReplacementState?.bindingId;
      if (bid) bindingIds.add(bid);
    }
    const nativeReady = everyReady && bindingIds.size === 1;
    // 未触碰：无 native 绑定、无修改标记、原文未变 → 原 PDF 内容已承载
    const untouched =
      !nativeReady &&
      glyphs.every(
        (g) =>
          !g.nativeReplacementState &&
          g.modified !== true &&
          (g.originalChar ?? g.char) === g.char,
      );
    // M7.8-040R-3 Bug B：编辑过的行（line.edited）原 operator 已被 strip，native replay
    // 只能重绘被剥离后的空算子在 → 文字消失。必须强制走 overlay（整行重绘）而非 skip。
    // 仅靠 glyph.modified 不够：删除/无变化编辑的残留 glyph 未被标 modified。
    const edited = block.lines[li].edited === true;
    const skipOverlay = (nativeReady || untouched) && !edited;
    if (skipOverlay) {
      routing.replacedLines.add(nativeLineKey(block.id, li));
    } else {
      allLinesSkipOverlay = false;
    }
  }
  if (allLinesSkipOverlay) routing.fullyReplacedBlocks.add(block.id);
  return routing;
}

/**
 * C2B-2C-2 · 入口：给定一个 block + 其已生成的 overlay commands，
 * 根据编辑态自动推导 routing 并对 native-ready 区间短路 overlay。
 * 无 native-ready 时原样返回（fallback overlay）。
 */
export function filterOverlayFromBlockState(
  block: EditableBlock,
  commands: ExportCommand[],
): ExportCommand[] {
  const routing = deriveNativeRoutingFromBlock(block);
  return filterOverlayForNativeReplaced(commands, routing);
}

/**
 * c2b-2c-1 · 纯函数：过滤掉「已 native 替换区间」的 overlay command。
 * 不修改输入数组；空路由时原样返回（行为不变 / fallback overlay）。
 */
export function filterOverlayForNativeReplaced(
  commands: ExportCommand[],
  routing: NativeReplaceRouting,
): ExportCommand[] {
  if (commands.length === 0) return commands;
  const hasRouting =
    routing.fullyReplacedBlocks.size > 0 || routing.replacedLines.size > 0;
  if (!hasRouting) return commands;

  return commands.filter((c) => {
    if (c.type === "drawTextGlyph") {
      // 整块替换 或 该行替换 → 跳过重绘
      const lineKey = nativeLineKey(c.blockId, c.lineIndex ?? 0);
      return !routing.fullyReplacedBlocks.has(c.blockId) && !routing.replacedLines.has(lineKey);
    }
    if (c.type === "drawLine" && c.purpose === "mask") {
      // mask 是 block 级 → 仅整块替换时跳过
      return !routing.fullyReplacedBlocks.has(c.blockId);
    }
    return true;
  });
}