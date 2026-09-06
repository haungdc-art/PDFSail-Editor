/**
 * Sprint 32: Text Block Extraction
 *
 * 从 RenderCommand[]（glyphCommands）中按 blockId 分组，
 * 提取每个 block 的文本和包围盒，供 TextEditOverlay 使用。
 */
import type { RenderCommand, DrawGlyphCommand } from "./render-command";
import { isDrawGlyph } from "./render-command";

export interface TextBlockInfo {
  /** block ID */
  id: string;
  /** 完整文本（按行拼接） */
  text: string;
  /** block 的 CSS 坐标包围盒 */
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 该 block 使用的字体大小（取第一个 glyph 的 fontSize） */
  fontSize: number;
}

/**
 * 从 render commands 中提取以 blockId 分组的文本块。
 *
 * 按 blockId 分组 → 提取文本 → 计算包围盒。
 * 用于：点击 glyph → 找到所属 block → 弹出编辑框。
 */
export function buildTextBlocks(commands: RenderCommand[]): TextBlockInfo[] {
  const glyphs = commands.filter(isDrawGlyph);

  // 按 blockId 分组
  const groups = new Map<string, DrawGlyphCommand[]>();
  for (const g of glyphs) {
    const list = groups.get(g.blockId) || [];
    list.push(g);
    groups.set(g.blockId, list);
  }

  const blocks: TextBlockInfo[] = [];

  for (const [blockId, cmds] of groups) {
    if (cmds.length === 0) continue;

    // 按 y 坐标排序（多行情况）
    cmds.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 2) return a.y - b.y;
      return a.x - b.x;
    });

    // 提取文本：按行分组
    const lines: string[] = [];
    let currentLine = "";
    let currentY = cmds[0].y;
    const tolerance = Math.max(2, cmds[0].height * 0.3);

    for (const g of cmds) {
      if (Math.abs(g.y - currentY) > tolerance) {
        if (currentLine) lines.push(currentLine);
        currentLine = g.char;
        currentY = g.y;
      } else {
        currentLine += g.char;
      }
    }
    if (currentLine) lines.push(currentLine);

    const text = lines.join("\n");

    // 计算包围盒
    const xs = cmds.map((g) => g.x);
    const ys = cmds.map((g) => g.y);
    const rights = cmds.map((g) => g.x + g.width);
    const bottoms = cmds.map((g) => g.y + g.height);

    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const right = Math.max(...rights);
    const bottom = Math.max(...bottoms);

    blocks.push({
      id: blockId,
      text,
      bbox: {
        x,
        y,
        width: right - x,
        height: bottom - y,
      },
      fontSize: cmds[0].fontSize ?? 12,
    });
  }

  return blocks;
}
