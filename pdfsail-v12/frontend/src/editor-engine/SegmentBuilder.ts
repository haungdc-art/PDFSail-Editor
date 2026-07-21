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
      segments.push(buildSegment(line.text, line, mapper, fontAnalyzer, true));
      continue;
    }

    // 按标点切割
    const parts = splitByPunctuation(line.text);
    if (parts.length <= 1) {
      // 无标点：整行一个 segment
      segments.push(buildSegment(line.text, line, mapper, fontAnalyzer, false));
    } else {
      // 有标点：每个 part 一个 segment
      // 注意：切割后坐标需要按文本宽度比例分配
      let xOffset = 0;
      for (const part of parts) {
        if (!part) continue;
        const partWidth = estimateTextWidth(part, line.fontSize);
        const segment = buildSegmentWithOffset(
          part,
          line,
          xOffset,
          partWidth,
          mapper,
          fontAnalyzer,
          false
        );
        segments.push(segment);
        xOffset += partWidth;
      }
    }
  }

  return segments;
}

/** 按标点切割（保留标点） */
function splitByPunctuation(text: string): string[] {
  // 用正则切割，保留分隔符
  return text.split(PUNCT_REGEX).reduce<string[]>((acc, part, i) => {
    if (i === 0) {
      acc.push(part);
    } else if (i % 2 === 1) {
      // 标点：附加到前一个 part
      if (acc.length > 0) {
        acc[acc.length - 1] += part;
      } else {
        acc.push(part);
      }
    } else {
      // 标点后的文本：新 part
      acc.push(part);
    }
    return acc;
  }, []);
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

/** 构建一个 segment（整行） */
function buildSegment(
  text: string,
  line: LineGroup,
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  isTableCell: boolean
): Segment {
  const css = mapper.pdfToCss(line.pdfX, line.pdfY, line.width, line.height);
  const font = fontAnalyzer.analyze(line.fontName, line.fontSize);
  // 应用 viewportScale × cssScale，与原 textItems fontSize 一致（避免字体大小不匹配产生重影）
  font.size = mapper.scaleFontSize(line.fontSize);
  // 行高动态计算：让文字行高 = 编辑框高度，避免文字溢出编辑框
  // （cssH = maxFontSize × scale = font.size，所以 lineHeight = 1.0；但保留除法以防 font.size 与 cssH 微小差异）
  font.lineHeight = font.size > 0 ? css.h / font.size : 1.0;
  return {
    id: `seg_${line.pdfX.toFixed(0)}_${line.pdfY.toFixed(0)}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    originalText: text,
    pdfX: line.pdfX,
    pdfY: line.pdfY,
    pdfW: line.width,
    pdfH: line.height,
    cssX: css.x,
    cssY: css.y,
    cssW: css.w,
    cssH: css.h,
    font,
    lineId: `line_${line.pdfY.toFixed(0)}`,
    isTableCell,
  };
}

/** 构建带 x 偏移的 segment（切割后的片段） */
function buildSegmentWithOffset(
  text: string,
  line: LineGroup,
  xOffset: number,
  partWidth: number,
  mapper: CoordinateMapper,
  fontAnalyzer: FontAnalyzer,
  isTableCell: boolean
): Segment {
  const css = mapper.pdfToCss(line.pdfX + xOffset, line.pdfY, partWidth, line.height);
  const font = fontAnalyzer.analyze(line.fontName, line.fontSize);
  font.size = mapper.scaleFontSize(line.fontSize);
  font.lineHeight = font.size > 0 ? css.h / font.size : 1.0;
  return {
    id: `seg_${(line.pdfX + xOffset).toFixed(0)}_${line.pdfY.toFixed(0)}_${xOffset.toFixed(0)}_${Math.random().toString(36).slice(2, 6)}`,
    text,
    originalText: text,
    pdfX: line.pdfX + xOffset,
    pdfY: line.pdfY,
    pdfW: partWidth,
    pdfH: line.height,
    cssX: css.x,
    cssY: css.y,
    cssW: css.w,
    cssH: css.h,
    font,
    lineId: `line_${line.pdfY.toFixed(0)}`,
    isTableCell,
  };
}

/** 估算文本宽度（pt，简单实现） */
function estimateTextWidth(text: string, fontSize: number): number {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) || 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      w += fontSize; // CJK 全角
    } else {
      w += fontSize * 0.55; // 西文半角
    }
  }
  return w;
}
