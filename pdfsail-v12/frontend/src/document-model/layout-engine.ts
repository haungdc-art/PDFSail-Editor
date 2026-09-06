/**
 * Layout Engine — Text Layout Reconstruction（Task 3 + Task 4）
 *
 * 职责：
 *   根据 EditableBlock 的 text + style + originalBounds，
 *   重建行级布局（EditableLine[]）和字符级位置（EditableGlyph.bbox）。
 *
 * 核心规则（Task 3）：
 *   1. 优先保持原始 bbox 高度（originalBounds.height）
 *   2. 禁止自动缩小字体（fontSize 从 style 固定）
 *   3. 超宽必须换行（用 measureText 精确测量）
 *   4. 保持 lineHeight（从 style.lineHeight 计算）
 *
 * Glyph Positioning（Task 4）：
 *   每个 Glyph 生成精确的 x/y/width/height，
 *   用 measureText 测量字符宽度，不均分 bbox。
 *
 * 输入：EditableBlock（含 text, style, originalBounds）
 * 输出：更新 lines[] 的 EditableBlock（每行有精确 bbox，每 glyph 有精确 bbox）
 *
 * 坐标系：Document Space（与 EditableDocument 一致，top-left origin, Y down）
 */

import type {
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  BBox,
  LayoutMode,
} from "./types";
import { IDENTITY_TRANSFORM } from "./types";
import {
  measureCharWidths,
  breakTextIntoLinesByWords,
} from "./text-measurement";
import { preserveBlockLayout } from "./preserve-layout-engine";

/**
 * 获取 block 的样式（取第一行第一 glyph 的 styleRef 对应的样式，或第一行 style）
 *
 * 注意：block 本身不存 styles 数组，styleRef 指向 document.styles。
 * 本函数接收 styles 数组参数以解析 styleRef。
 */
function getBlockStyle(block: EditableBlock, styles?: EditableStyle[]): EditableStyle {
  const firstLine = block.lines[0];
  if (!firstLine) return {};
  // 优先用 line.style（已内联）
  if (firstLine.style && Object.keys(firstLine.style).length > 0) {
    return firstLine.style;
  }
  // fallback: 从 styles 数组按 styleRef 查找
  if (styles) {
    const ref = firstLine.glyphs[0]?.styleRef;
    if (ref !== undefined && styles[ref]) {
      return styles[ref];
    }
  }
  return firstLine.style || {};
}

/**
 * 计算行的可用宽度（availableLineWidth）。
 *
 * 不直接使用 OCR paragraph bbox width（可能过宽或过窄），
 * 而是根据页面真实可用宽度计算：
 *
 *   availableLineWidth = pageWidth - blockX - rightMargin
 *
 * 其中：
 *   - pageWidth：页面总宽度（CSS 显示坐标）
 *   - blockX = originalBounds.x：原文区域左边界（即左边距 + original text region 偏移）
 *   - rightMargin：右侧安全边距（默认与左侧对称，即 blockX）
 *
 * 如果未提供 pageWidth，fallback 到 originalBounds.width（向后兼容）。
 *
 * @param originalBounds 原文 bbox
 * @param pageWidth 页面宽度（可选）
 * @returns 可用行宽
 */
export function computeAvailableLineWidth(
  originalBounds: BBox,
  pageWidth?: number
): number {
  if (pageWidth === undefined || pageWidth <= 0) {
    return originalBounds.width;
  }
  // 左边距 = originalBounds.x（原文区域距页面左边的距离）
  const leftMargin = originalBounds.x;
  // 右边距与左边距对称（保持页面左右留白一致）
  const rightMargin = leftMargin;
  // 可用宽度 = 页面宽度 - 左边距 - 右边距
  const available = pageWidth - leftMargin - rightMargin;
  // 安全下限：至少 50px，避免极端情况
  return Math.max(available, 50);
}

/**
 * 重建 Block 的行布局和 glyph 位置。
 *
 * 这是 Layout Engine 的主入口。
 *
 * @param block 待重建的 EditableBlock（lines 会被替换）
 * @param styles 文档级样式表（可选，用于解析 styleRef）
 * @param pageWidth 页面宽度（CSS 显示坐标，用于计算 availableLineWidth）
 * @returns 新的 EditableBlock（lines 已重建）
 *
 * 规则：
 *   1. 优先保持 originalBounds 高度（遮盖区域不变，原文不露出）
 *   2. 禁止缩小 fontSize
 *   3. 超宽换行（measureText 精确测量，英文按 word，中文按 character）
 *   4. lineHeight 从 style 计算
 *   5. 禁止直接使用 OCR paragraph bbox width，改用 availableLineWidth
 */
export function reconstructBlockLayout(
  block: EditableBlock,
  styles?: EditableStyle[],
  pageWidth?: number,
  hybrid?: { anchorMap?: Map<number, EditableGlyph> }
): EditableBlock {
  const style = getBlockStyle(block, styles);
  const fontSize = style.fontSize || 14;
  const lineHeight = style.lineHeight || fontSize * 1.3;

  // 原文 bbox（遮盖区域，必须完整覆盖）
  const originalBounds = block.originalBounds || block.bbox;

  // 关键修复：不用 OCR paragraph bbox width，改用 availableLineWidth
  const availableLineWidth = computeAvailableLineWidth(originalBounds, pageWidth);
  const maxWidth = availableLineWidth;

  // 拼接完整文本（保留 \n 作为强制换行点）
  const fullText = block.lines
    .map((l) => l.glyphs.map((g) => g.char).join(""))
    .join("\n");

  // 按换行符分段，每段用 measureText 换行
  const paragraphs = fullText.split("\n");
  const newLines: EditableLine[] = [];
  let currentY = originalBounds.y;
  let flatCP = 0; // 全局扁平 code-point 计数（不含 \n），与 anchorMap 的 key 对齐
  const styleRef = block.lines[0]?.glyphs[0]?.styleRef ?? 0;
  const anchorMap = hybrid?.anchorMap;

  for (const para of paragraphs) {
    const paraLen = Array.from(para).length;
    if (para.length === 0) {
      // 空行，保持行高
      newLines.push({
        id: `${block.id}_L${newLines.length}`,
        bbox: {
          x: originalBounds.x,
          y: currentY,
          width: maxWidth,
          height: lineHeight,
        },
        glyphs: [],
        source: "vector",
        style: { ...style },
      });
      currentY += lineHeight;
      // 空段落贡献 0 cp，flatCP 不变
      continue;
    }

    // 用 measureText 断行（英文按 word，中文按 character）
    const { lines: breakLines } = breakTextIntoLinesByWords(para, style, maxWidth);

    // 为每行生成 glyph（精确位置）
    for (const bl of breakLines) {
      const lineChars = Array.from(para).slice(bl.start, bl.end);
      const glyphs = buildGlyphs(
        lineChars,
        style,
        originalBounds.x,
        currentY,
        lineHeight,
        styleRef,
        anchorMap ? { globalOffset: flatCP + bl.start, anchorMap } : undefined
      );

      newLines.push({
        id: `${block.id}_L${newLines.length}`,
        bbox: {
          x: originalBounds.x,
          y: currentY,
          width: maxWidth,
          height: lineHeight,
        },
        glyphs,
        source: "vector",
        style: { ...style },
      });
      currentY += lineHeight;
    }
    flatCP += paraLen;
  }

  // 关键规则 1：保持原始 bbox 高度
  // 如果重建后总高度 < originalBounds.height（行数少了），不缩小高度
  // 如果重建后总高度 > originalBounds.height（行数多了），扩展高度（原文可能露出需遮盖更大区域）
  const reconstructedHeight = newLines.length * lineHeight;
  const finalHeight = Math.max(reconstructedHeight, originalBounds.height);

  const finalBlockBBox: BBox = {
    x: originalBounds.x,
    y: originalBounds.y,
    width: maxWidth,
    height: finalHeight,
  };

  return {
    ...block,
    bbox: finalBlockBBox,
    originalBounds: {
      ...originalBounds,
      height: finalHeight, // 遮盖区域也取 max，确保原文不露出
    },
    lines: newLines,
  };
}

/**
 * 批量重建多个 block 的布局。
 */
export function reconstructBlocksLayout(
  blocks: EditableBlock[],
  styles?: EditableStyle[],
  pageWidth?: number
): EditableBlock[] {
  return blocks.map((b) => reconstructBlockLayout(b, styles, pageWidth));
}

/**
 * 重建整个文档的布局。
 *
 * 对每个 page 的每个 block 调用 reconstructBlockLayout。
 * 使用每页的 page.width 计算 availableLineWidth。
 */
export function reconstructDocumentLayout<
  T extends { pages: Array<{ blocks: EditableBlock[]; width?: number }>; styles: EditableStyle[] }
>(doc: T): T {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      blocks: reconstructBlocksLayout(page.blocks, doc.styles, page.width),
    })),
  };
}

/**
 * 为一行字符生成精确位置的 glyph（Task 4: Glyph Positioning）
 *
 * 关键：用 measureText 测量每个字符宽度，不均分 bbox。
 * glyph.x 从行起点累加，glyph.width = measureText 宽度。
 */
/**
 * M7.8-048-FIX-REFLOW: hybrid layout 支持。
 * 当传入 anchorMap 时，对「不在 anchorMap 的 glyph」按原逻辑流水重排（edited run），
 * 对「在 anchorMap 的 glyph」直接采用原始 glyph 的真实几何（unchanged prefix/suffix），
 * 不做流水 —— 从而编辑前文/插入文字不会位移后续未改 glyph。
 *
 * anchorMap 的 key = newClean 的 code-point index（扁平、不含 \n），由调用方通过
 * oldText vs newText 的 common-prefix/suffix diff 计算；globalOffset 为本行首 glyph
 * 在该扁平序列中的 cp index，使 buildGlyphs 内部的局部 i 能映射到全局 key。
 */
function buildGlyphs(
  chars: string[],
  style: EditableStyle,
  lineX: number,
  lineY: number,
  lineHeight: number,
  styleRef: number,
  opts?: {
    globalOffset?: number;
    anchorMap?: Map<number, EditableGlyph>;
  }
): EditableGlyph[] {
  const widths = measureCharWidths(chars.join(""), style);
  // M7.9-NEWCHAR-ADVANCE-FIX：新增字符（无 anchor、由 Canvas measureText 定位）的字宽与
  // PDF 真实 advance 存在系统性偏差 —— 实测在原文 "bairro; Catumbi" 后插入 " de"，
  // 新增 "d→e" 间距只有 5.43，而原文同字体 "cidade" 的 "d→e" 为 7.34（约 0.74×）→
  // 新字符肉眼可见粘连。用同行 anchor（未改动字符，几何直接取自 PDF）的
  // 「PDF 真实字宽 ÷ Canvas 测量宽度」求出该偏差的倒数，据此校正新增字符宽度，
  // 使新字符与原文使用同一度量口径。无 anchor（整块全新文本）时 scale 保持 1，行为不变。
  let advanceScale = 1;
  if (opts?.anchorMap) {
    let pdfSum = 0;
    let canvasSum = 0;
    chars.forEach((char, i) => {
      const anchor = opts.anchorMap!.get((opts.globalOffset ?? 0) + i);
      if (anchor) {
        pdfSum += anchor.bbox.width;
        canvasSum += widths[i];
      }
    });
    if (pdfSum > 0 && canvasSum > 0) advanceScale = pdfSum / canvasSum;
  }
  const glyphs: EditableGlyph[] = [];
  let currentX = lineX;

  chars.forEach((char, i) => {
    const g = (opts?.globalOffset ?? 0) + i;
    const anchor = opts?.anchorMap?.get(g);

    if (anchor) {
      // unchanged glyph → 锚定原始几何，不流水
      const aBBox: BBox = {
        x: anchor.bbox.x,
        y: anchor.bbox.y,
        width: anchor.bbox.width,
        height: anchor.bbox.height,
      };
      glyphs.push({
        char: anchor.char ?? char,
        originalChar: anchor.originalChar ?? anchor.char ?? char,
        bbox: { ...aBBox },
        originalBBox: anchor.originalBBox ? { ...anchor.originalBBox } : { ...aBBox },
        styleRef: anchor.styleRef ?? styleRef,
        modified: anchor.modified ?? false,
        transform: anchor.transform ?? IDENTITY_TRANSFORM,
        baseline: anchor.baseline,
        metrics: anchor.metrics,
      });
      // 维持后续 edited glyph 的流水起点 = 本 glyph 右缘
      currentX = aBBox.x + aBBox.width;
    } else {
      // M7.9-NEWCHAR-ADVANCE-FIX：按 PDF/Canvas 度量偏差校正新增字符宽度（见上方 advanceScale）
      const charWidth = widths[i] * advanceScale;
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
        originalBBox: { ...glyphBBox }, // Reconstruct 模式也记录原始位置
        styleRef,
        modified: false,
        // Reconstruct 模式生成的 glyph 默认无旋转（OCR 文字不旋转）
        transform: IDENTITY_TRANSFORM,
      });
      currentX += charWidth;
    }
  });

  return glyphs;
}

// ── Sprint 3.5: LayoutMode 分派 ──

/**
 * 根据 LayoutMode 选择布局引擎处理 block。
 *
 * PRESERVE：保持原 PDF 布局（Adobe 风格文本替换）
 *   - 使用 preserveBlockLayout
 *   - 保持原 line 数量、baseline、fontSize
 *   - 禁止 reflow
 *
 * RECONSTRUCT：重建布局（measureText 换行）
 *   - 使用 reconstructBlockLayout
 *   - 超宽换行
 *
 * 默认模式：PRESERVE（OCR 替换场景优先保持原布局）
 *
 * @param block 待处理的 block
 * @param mode 布局模式（默认 "preserve"）
 * @param styles 文档级样式表
 */
export function layoutBlock(
  block: EditableBlock,
  mode: LayoutMode = "preserve",
  styles?: EditableStyle[],
  pageWidth?: number
): EditableBlock {
  // block 自身的 layoutMode 优先，其次用传入的 mode
  const effectiveMode = block.layoutMode || mode;

  if (effectiveMode === "preserve") {
    return preserveBlockLayout(block, styles);
  }
  return reconstructBlockLayout(block, styles, pageWidth);
}

/**
 * 批量布局处理（按 LayoutMode 分派）。
 */
export function layoutBlocks(
  blocks: EditableBlock[],
  mode: LayoutMode = "preserve",
  styles?: EditableStyle[],
  pageWidth?: number
): EditableBlock[] {
  return blocks.map((b) => layoutBlock(b, mode, styles, pageWidth));
}

/**
 * 重建整个文档的布局（按 LayoutMode 分派）。
 *
 * 对每个 page 的每个 block 调用 layoutBlock。
 * 默认使用 PRESERVE 模式（OCR 替换场景优先保持原布局）。
 */
export function layoutDocument<
  T extends { pages: Array<{ blocks: EditableBlock[]; width?: number }>; styles: EditableStyle[] }
>(doc: T, mode: LayoutMode = "preserve"): T {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      blocks: layoutBlocks(page.blocks, mode, doc.styles, page.width),
    })),
  };
}
