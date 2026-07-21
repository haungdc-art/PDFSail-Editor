/**
 * SegmentBuilder — Commit 5
 *
 * 把 RawGlyph[] 合并成 LineGroup[]，再按标点切割成 Segment[]。
 *
 * 合并规则（同行的 glyph）：
 *   1. y 偏差 < fontSize × 0.5（同一基线）
 *   2. x 间距 < fontSize × 1.5（连续）
 *
 * 标点切割规则：
 *   中文：。！？；：
 *   英文：.!?;:
 *   切割后每个片段包含结尾标点（不丢弃）
 *
 * 表格检测（启发式）：
 *   如果一行有 3+ 个连续等距的 glyph 块，标记为表格行，不做标点切割。
 */

import type { RawGlyph, LineGroup, Segment, FontMeta } from "./types";
import type { CoordinateMapper } from "./CoordinateMapper";
import type { FontAnalyzer } from "./FontAnalyzer";

/** 标点正则（中英文） */
const PUNCT_REGEX = /([。！？；：.!?;:])/;

/**
 * 把 RawGlyph[] 合并成 LineGroup[]。
 *
 * @param glyphs 原始 glyph 数组（顺序按 PDF 读取顺序）
 */
export function groupIntoLines(glyphs: RawGlyph[]): LineGroup[] {
  if (glyphs.length === 0) return [];

  // 先按 y 排序（PDF 坐标系 y 从下往上），同 y 按 x 排序
  const sorted = [...glyphs].sort((a, b) => {
    const yDiff = b.pdfY - a.pdfY; // y 大的在前（PDF 上方）
    if (Math.abs(yDiff) > 1) return yDiff;
    return a.pdfX - b.pdfX;
  });

  const lines: LineGroup[] = [];
  let currentLine: RawGlyph[] = [sorted[0]];
  let currentY = sorted[0].pdfY;
  let currentFontSize = sorted[0].fontSize;

  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i];
    const yDiff = Math.abs(g.pdfY - currentY);
    const yThreshold = currentFontSize * 0.5;

    // 检查是否换行
    if (yDiff > yThreshold) {
      lines.push(mergeLine(currentLine));
      currentLine = [g];
      currentY = g.pdfY;
      currentFontSize = g.fontSize;
    } else {
      // 同行：检查 x 是否连续
      const prev = currentLine[currentLine.length - 1];
      const xGap = g.pdfX - (prev.pdfX + prev.width);
      const xThreshold = currentFontSize * 3; // 允许较大间距
      if (xGap > xThreshold) {
        // x 间距过大，视为新行
        lines.push(mergeLine(currentLine));
        currentLine = [g];
        currentY = g.pdfY;
        currentFontSize = g.fontSize;
      } else {
        currentLine.push(g);
      }
    }
  }
  if (currentLine.length > 0) lines.push(mergeLine(currentLine));

  return lines;
}

/** 把一组同行 glyph 合并成一个 LineGroup */
function mergeLine(glyphs: RawGlyph[]): LineGroup {
  if (glyphs.length === 0) {
    return {
      text: "",
      pdfX: 0,
      pdfY: 0,
      width: 0,
      height: 0,
      fontName: "unknown",
      fontSize: 12,
      glyphs: [],
    };
  }

  const text = glyphs.map((g) => g.str).join("");
  const pdfX = glyphs[0].pdfX;
  const pdfY = glyphs[0].pdfY;
  const lastG = glyphs[glyphs.length - 1];
  const width = lastG.pdfX + lastG.width - pdfX;

  // 统计主字体（出现次数最多的）
  const fontCounts = new Map<string, number>();
  let maxFontSize = 0;
  for (const g of glyphs) {
    fontCounts.set(g.fontName, (fontCounts.get(g.fontName) || 0) + 1);
    if (g.fontSize > maxFontSize) maxFontSize = g.fontSize;
  }
  let mainFont = glyphs[0].fontName;
  let maxCount = 0;
  for (const [name, count] of fontCounts) {
    if (count > maxCount) {
      maxCount = count;
      mainFont = name;
    }
  }

  return {
    text,
    pdfX,
    pdfY,
    width,
    height: maxFontSize,
    fontName: mainFont,
    fontSize: maxFontSize,
    glyphs,
  };
}

/**
 * 把 LineGroup[] 按标点切割成 Segment[]。
 *
 * 切割策略：按 glyph 实际坐标切割（非估算宽度），确保每个 segment 的 cssX/cssW 精确对应 PDF 中的文本位置。
 *
 * @param lines 行数组
 * @param mapper 坐标映射器（PDF pt → CSS px）
 * @param fontAnalyzer 字体分析器（生成 FontMeta）
 */
export function buildSegments(
  lines: LineGroup[],
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer
): Segment[] {
  const segments: Segment[] = [];

  for (const line of lines) {
    // 检测是否是表格行（启发式：3+ 个等距 glyph 块）
    const isTable = detectTableLine(line);
    if (isTable) {
      // 表格行不切割，整行作为一个 segment
      segments.push(buildSegmentFromGlyphs(line.glyphs, line, mapper, fontAnalyzer, true));
      continue;
    }

    // 按标点切割 glyph 数组（用实际坐标，非估算宽度）
    const glyphGroups = splitGlyphsByPunctuation(line.glyphs);
    if (glyphGroups.length <= 1) {
      // 无标点：整行一个 segment
      segments.push(buildSegmentFromGlyphs(line.glyphs, line, mapper, fontAnalyzer, false));
    } else {
      // 有标点：每个 glyph group 一个 segment，坐标从 glyph 实际位置计算
      for (const glyphs of glyphGroups) {
        if (glyphs.length === 0) continue;
        segments.push(buildSegmentFromGlyphs(glyphs, line, mapper, fontAnalyzer, false));
      }
    }
  }

  return segments;
}

/**
 * 按标点切割 glyph 数组（保留标点在前一段）。
 *
 * 与 splitByPunctuation 不同，本函数按 glyph 粒度切割，
 * 每个 glyph group 的坐标直接从 glyph 实际 pdfX/width 计算，确保 cssX/cssW 精确。
 *
 * 切割规则：
 *   - 遍历每个 glyph，累积到 currentGroup
 *   - 检查 glyph.str 的最后一个字符是否是标点（。！？；：.!?;:）
 *   - 如果是标点，把 currentGroup 作为一个 group 输出，开始新的 group
 *   - 遍历结束后，剩余的 currentGroup 作为最后一个 group
 */
function splitGlyphsByPunctuation(glyphs: RawGlyph[]): RawGlyph[][] {
  if (glyphs.length === 0) return [];
  const groups: RawGlyph[][] = [];
  let currentGroup: RawGlyph[] = [];

  for (const g of glyphs) {
    currentGroup.push(g);
    // 检查 glyph.str 末尾是否是标点
    const lastChar = g.str[g.str.length - 1];
    if (PUNCT_REGEX.test(lastChar)) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);
  return groups;
}

/** 检测表格行（启发式：glyph x 间距等距且数量多） */
function detectTableLine(line: LineGroup): boolean {
  if (line.glyphs.length < 4) return false;
  // 检查 x 间距是否等距（标准差 < 平均值的 20%）
  const gaps: number[] = [];
  for (let i = 1; i < line.glyphs.length; i++) {
    const prev = line.glyphs[i - 1];
    const curr = line.glyphs[i];
    gaps.push(curr.pdfX - (prev.pdfX + prev.width));
  }
  if (gaps.length < 2) return false;
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  if (avg < line.fontSize * 0.5) return false; // 间距太小不算表格
  const variance = gaps.reduce((sum, g) => sum + (g - avg) ** 2, 0) / gaps.length;
  const stdDev = Math.sqrt(variance);
  return stdDev < avg * 0.3; // 间距稳定才算表格
}

/**
 * 从一组 glyph 构建 segment（坐标从 glyph 实际位置计算）。
 *
 * @param glyphs 同一 segment 的 glyph 数组（已是行内子集）
 * @param line 所属行（用于 fontName/fontSize/lineId）
 * @param mapper 坐标映射器
 * @param fontAnalyzer 字体分析器
 * @param isTableCell 是否表格 cell
 */
function buildSegmentFromGlyphs(
  glyphs: RawGlyph[],
  line: LineGroup,
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  isTableCell: boolean
): Segment {
  const text = glyphs.map((g) => g.str).join("");
  // pdfX = 第一个 glyph 的 pdfX；pdfW = 最后一个 glyph 右边缘 - 第一个 glyph 左边缘
  const firstG = glyphs[0];
  const lastG = glyphs[glyphs.length - 1];
  const pdfX = firstG.pdfX;
  const pdfW = lastG.pdfX + lastG.width - firstG.pdfX;
  const pdfY = line.pdfY;
  const pdfH = line.height;

  const css = mapper.pdfToCss(pdfX, pdfY, pdfW, pdfH);
  const font = fontAnalyzer.analyze(line.fontName, line.fontSize);
  // 应用 viewportScale × cssScale，与原 textItems fontSize 一致
  font.size = mapper.scaleFontSize(line.fontSize);
  // 行高动态计算：让文字行高 = 编辑框高度，避免文字溢出
  font.lineHeight = font.size > 0 ? css.h / font.size : 1.0;

  return {
    id: `seg_${pdfX.toFixed(0)}_${pdfY.toFixed(0)}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    originalText: text,
    pdfX,
    pdfY,
    pdfW,
    pdfH,
    cssX: css.x,
    cssY: css.y,
    cssW: css.w,
    cssH: css.h,
    font,
    lineId: `line_${pdfY.toFixed(0)}`,
    isTableCell,
  };
}
