/**
 * RenderCommandDiff — 旧/新 RenderCommand 一致性验证器
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 4B
 *
 * 职责：compare(oldCommands, newCommands) → DiffResult
 *   全部数据化比较，禁止肉眼判断。
 *
 * 比较维度：
 *   command type / pageId(从 blockId 推断) / blockId / lineId / glyphIndex /
 *   char / styleRef / x / y / width / height / transform
 */

import type { RenderCommand, DrawGlyphCommand } from "../render-command";
import { isDrawGlyph } from "../render-command";

/** 单个不一致项（可直接定位） */
export interface CommandMismatch {
  /** 命令在 old 数组中的索引 */
  readonly commandIndex: number;
  /** page 定位（从 blockId 推断，可能为空） */
  readonly pageId: string;
  readonly blockId: string;
  readonly lineId: string;
  readonly glyphIndex: number;
  readonly field: string;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly delta?: number;
}

export interface DiffResult {
  /** 是否完全一致 */
  readonly identical: boolean;
  /** 命令数量差（new - old） */
  readonly commandCountDelta: number;
  /** glyph 数量差（new - old） */
  readonly glyphCountDelta: number;
  /** 不一致项 */
  readonly mismatches: CommandMismatch[];
  /** old 命令总数 */
  readonly commandCount: number;
  /** old glyph 总数 */
  readonly glyphCount: number;
}

/** 数值比较（容差，避免浮点噪声） */
function numEqual(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon;
}

/** 从 blockId 推断 pageId（如 "p0"、"page1" 或 "pdf_p1_block0" 中的 p\d） */
function inferPageId(blockId: string): string {
  const m = blockId.match(/(?:p|page)(\d+)/i);
  return m ? `page: ${m[1]}` : "";
}

/** 比较两个 glyph 命令，返回差异字段列表 */
function glyphDiff(
  oldG: DrawGlyphCommand,
  newG: DrawGlyphCommand,
  glyphIndex: number
): Omit<CommandMismatch, "commandIndex">[] {
  const base = {
    pageId: inferPageId(oldG.blockId),
    blockId: oldG.blockId,
    lineId: oldG.lineId,
    glyphIndex,
  };
  const out: Omit<CommandMismatch, "commandIndex">[] = [];
  if (oldG.char !== newG.char) out.push({ ...base, field: "char", oldValue: oldG.char, newValue: newG.char });
  if (oldG.blockId !== newG.blockId) out.push({ ...base, field: "blockId", oldValue: oldG.blockId, newValue: newG.blockId });
  if (oldG.lineId !== newG.lineId) out.push({ ...base, field: "lineId", oldValue: oldG.lineId, newValue: newG.lineId });
  if (oldG.styleRef !== newG.styleRef) out.push({ ...base, field: "styleRef", oldValue: oldG.styleRef, newValue: newG.styleRef });
  if (oldG.modified !== newG.modified) out.push({ ...base, field: "modified", oldValue: oldG.modified, newValue: newG.modified });
  if (!numEqual(oldG.x, newG.x)) out.push({ ...base, field: "x", oldValue: oldG.x, newValue: newG.x, delta: newG.x - oldG.x });
  if (!numEqual(oldG.y, newG.y)) out.push({ ...base, field: "y", oldValue: oldG.y, newValue: newG.y, delta: newG.y - oldG.y });
  if (!numEqual(oldG.width, newG.width)) out.push({ ...base, field: "width", oldValue: oldG.width, newValue: newG.width, delta: newG.width - oldG.width });
  if (!numEqual(oldG.height, newG.height)) out.push({ ...base, field: "height", oldValue: oldG.height, newValue: newG.height, delta: newG.height - oldG.height });
  const oldT = oldG.transform ?? [1, 0, 0, 1, 0, 0];
  const newT = newG.transform ?? [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < 6; i++) {
    if (!numEqual(oldT[i], newT[i])) {
      out.push({ ...base, field: `transform[${i}]`, oldValue: oldT[i], newValue: newT[i], delta: newT[i] - oldT[i] });
      break;
    }
  }
  return out;
}

/**
 * 比较旧/新 RenderCommand，返回 DiffResult。
 */
export function compare(
  oldCommands: RenderCommand[],
  newCommands: RenderCommand[]
): DiffResult {
  const oldGlyphs = oldCommands.filter(isDrawGlyph);
  const newGlyphs = newCommands.filter(isDrawGlyph);

  const mismatches: CommandMismatch[] = [];
  const commandCountDelta = newCommands.length - oldCommands.length;
  const glyphCountDelta = newGlyphs.length - oldGlyphs.length;

  if (commandCountDelta !== 0) {
    mismatches.push({
      commandIndex: -1,
      pageId: "",
      blockId: "",
      lineId: "",
      glyphIndex: -1,
      field: "commandCount",
      oldValue: oldCommands.length,
      newValue: newCommands.length,
      delta: commandCountDelta,
    });
  }
  if (glyphCountDelta !== 0) {
    mismatches.push({
      commandIndex: -1,
      pageId: "",
      blockId: "",
      lineId: "",
      glyphIndex: -1,
      field: "glyphCount",
      oldValue: oldGlyphs.length,
      newValue: newGlyphs.length,
      delta: glyphCountDelta,
    });
  }

  const compareLen = Math.min(oldGlyphs.length, newGlyphs.length);
  for (let i = 0; i < compareLen; i++) {
    const diffs = glyphDiff(oldGlyphs[i], newGlyphs[i], i);
    for (const d of diffs) {
      mismatches.push({ ...d, commandIndex: i });
      if (mismatches.length >= 50) break;
    }
    if (mismatches.length >= 50) break;
  }

  return {
    identical: mismatches.length === 0,
    commandCountDelta,
    glyphCountDelta,
    mismatches,
    commandCount: oldCommands.length,
    glyphCount: oldGlyphs.length,
  };
}

/**
 * 固定输出格式（Commit 4D）。
 */
export function formatDiffResult(r: DiffResult): string {
  if (r.identical) {
    return `Layout Diff PASS\ncommands: ${r.commandCount}\nglyphs: ${r.glyphCount}\n100% identical`;
  }
  const first = r.mismatches[0];
  if (!first) {
    return `Layout Diff FAIL\ncommands: ${r.commandCount}\nglyphs: ${r.glyphCount}\n<no mismatch detail>`;
  }
  const lines: string[] = [
    "Layout Diff FAIL",
    `commands: ${r.commandCount}  (delta ${r.commandCountDelta})`,
    `glyphs: ${r.glyphCount}  (delta ${r.glyphCountDelta})`,
    `total mismatches: ${r.mismatches.length}`,
  ];
  if (first.commandIndex >= 0) {
    if (first.pageId) lines.push(`Page: ${first.pageId}`);
    lines.push(`Block: ${first.blockId}`);
    lines.push(`Line: ${first.lineId}`);
    lines.push(`Glyph: ${first.glyphIndex}`);
  }
  lines.push(`Field: ${first.field}`);
  lines.push(`Old: ${first.oldValue}`);
  lines.push(`New: ${first.newValue}`);
  if (first.delta !== undefined) lines.push(`Delta: ${first.delta}`);
  return lines.join("\n");
}
