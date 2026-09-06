/**
 * PreserveLayoutEngine — Task 2
 *
 * 实现 Adobe 风格的文本替换模式：优先保持原 PDF 布局。
 *
 * 与 ReconstructLayoutEngine 的区别：
 *   - Reconstruct：用 measureText 重新换行，超宽断行（适合新增文本）
 *   - Preserve：保持 OCR bbox / PDF native glyph 原始位置，禁止 reflow（适合编辑替换）
 *
 * 规则：
 *   1. 优先使用 OCR bbox / PDF native glyph 位置
 *   2. 保持原 line 数量（不增加/减少行）
 *   3. 保持 baseline（行 Y 坐标不变）
 *   4. 保持 fontSize（不缩小）
 *   5. 禁止 reflow（不重新换行，文本超出 bbox 宽度时溢出显示而非断行）
 *
 * 输入：EditableBlock（含 originalBounds + 初始 lines）
 * 输出：EditableLine[]（保持原始位置，glyph 位置从原文映射）
 *
 * 坐标系：Document Space（top-left origin, Y down）
 */

import type {
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
  TransformMatrix,
} from "./types";
import { IDENTITY_TRANSFORM } from "./types";
import { measureCharWidth } from "./text-measurement";

/**
 * 保持原始布局的 Block 重建。
 *
 * 与 reconstructBlockLayout 不同：
 *   - 不用 measureText 重新换行
 *   - 保持 originalBounds 的行数和位置
 *   - glyph 位置从原始 bbox 映射（保持 baseline）
 *
 * Sprint 5：preserve 区域（signature/stamp）的 glyph 使用原始 transform（恢复旋转角度），
 * 而非硬编码 IDENTITY_TRANSFORM。transform 从 block.lines 中初始 glyph 继承。
 *
 * @param block 待处理的 EditableBlock
 * @param styles 文档级样式表（可选）
 * @returns 新的 EditableBlock（lines 保持原始位置）
 */
export function preserveBlockLayout(
  block: EditableBlock,
  styles?: EditableStyle[]
): EditableBlock {
  const style = getBlockStyle(block, styles);
  const fontSize = style.fontSize || 14;
  const lineHeight = style.lineHeight || fontSize * 1.3;

  const originalBounds = block.originalBounds || block.bbox;

  // 拼接完整文本
  const fullText = block.lines
    .map((l) => l.glyphs.map((g) => g.char).join(""))
    .join("\n");

  // 规则 2：保持原 line 数量
  // 按换行符拆行，保持原始行结构
  const paragraphs = fullText.split("\n");
  const newLines: EditableLine[] = [];
  let currentY = originalBounds.y;
  const styleRef = block.lines[0]?.glyphs[0]?.styleRef ?? 0;

  // Sprint 5：提取初始 glyph 的 transform（preserve 区域的旋转角度）
  // 从 block.lines 中第一个 glyph 获取 transform，用于所有重建 glyph
  // 如果初始 glyph 没有 transform（undefined），使用 IDENTITY_TRANSFORM
  const blockTransform = block.lines[0]?.glyphs[0]?.transform ?? IDENTITY_TRANSFORM;

  for (const para of paragraphs) {
    // 规则 3：保持 baseline — 行 Y 坐标 = originalBounds.y + lineIdx × lineHeight
    // 规则 5：禁止 reflow — 不用 measureText 断行，整行作为一个 line
    const glyphs = buildPreservedGlyphs(
      para,
      style,
      originalBounds.x,
      currentY,
      lineHeight,
      styleRef,
      blockTransform
    );

    // 行宽度：使用 measureText 计算实际文本宽度（用于渲染参考）
    // 但行 bbox 宽度保持 originalBounds.width（不因文本短而缩小）
    const textWidth = glyphs.reduce((sum, g) => sum + g.bbox.width, 0);

    newLines.push({
      id: `${block.id}_L${newLines.length}`,
      bbox: {
        x: originalBounds.x,
        y: currentY,
        width: Math.max(originalBounds.width, textWidth),
        height: lineHeight,
      },
      glyphs,
      source: "vector",
      style: { ...style },
    });
    currentY += lineHeight;
  }

  // 规则 1 & 4：保持原始 bbox 高度和 fontSize
  // bbox 高度 = max(行数 × lineHeight, originalBounds.height)
  const preservedHeight = newLines.length * lineHeight;
  const finalHeight = Math.max(preservedHeight, originalBounds.height);

  return {
    ...block,
    layoutMode: "preserve",
    bbox: {
      x: originalBounds.x,
      y: originalBounds.y,
      width: originalBounds.width,
      height: finalHeight,
    },
    originalBounds: {
      ...originalBounds,
      height: finalHeight,
    },
    lines: newLines,
  };
}

/**
 * 批量保持布局。
 */
export function preserveBlocksLayout(
  blocks: EditableBlock[],
  styles?: EditableStyle[]
): EditableBlock[] {
  return blocks.map((b) => preserveBlockLayout(b, styles));
}

/**
 * 为一行字符生成保持位置的 glyph。
 *
 * 与 Reconstruct 模式的区别：
 *   - glyph.bbox = originalBBox（从原始位置映射）
 *   - 不重新计算换行
 *   - 字符宽度用 measureText（精确），但位置保持原始累加
 *
 * 关键：每个 glyph 同时保存 bbox（当前）和 originalBBox（原始），
 * 编辑后 bbox 可能变，originalBBox 保持不变用于回退和 Diff。
 */
function buildPreservedGlyphs(
  text: string,
  style: EditableStyle,
  lineX: number,
  lineY: number,
  lineHeight: number,
  styleRef: number,
  transform: TransformMatrix
): EditableGlyph[] {
  const chars = Array.from(text);
  const glyphs: EditableGlyph[] = [];
  let currentX = lineX;

  chars.forEach((char) => {
    const charWidth = measureCharWidth(char, style);
    const glyphBBox: BBox = {
      x: currentX,
      y: lineY,
      width: charWidth,
      height: lineHeight,
    };
    glyphs.push({
      char,
      originalChar: char,
      bbox: { ...glyphBBox },
      originalBBox: { ...glyphBBox }, // Preserve 模式：bbox = originalBBox
      styleRef,
      modified: false,
      // Sprint 5：使用传入的 transform（preserve 区域的旋转角度），
      // 而非硬编码 IDENTITY_TRANSFORM
      transform,
    });
    currentX += charWidth;
  });

  return glyphs;
}

/**
 * 获取 block 的样式（与 layout-engine.ts 一致）
 */
function getBlockStyle(block: EditableBlock, styles?: EditableStyle[]): EditableStyle {
  const firstLine = block.lines[0];
  if (!firstLine) return {};
  if (firstLine.style && Object.keys(firstLine.style).length > 0) {
    return firstLine.style;
  }
  if (styles) {
    const ref = firstLine.glyphs[0]?.styleRef;
    if (ref !== undefined && styles[ref]) {
      return styles[ref];
    }
  }
  return firstLine.style || {};
}
