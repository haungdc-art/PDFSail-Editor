/**
 * TextExtractor — Commit 5
 *
 * 从 PDF.js page.getTextContent() 提取 RawGlyph[]。
 *
 * 职责：
 *   - 调用 pdf.js getTextContent
 *   - 把每个 TextContent item 转换为 RawGlyph（含 transform/font 元数据）
 *   - 过滤空字符串和空白项
 *
 * 不做：
 *   - 合并行（由 SegmentBuilder 负责）
 *   - 坐标转换（由 CoordinateMapper 负责）
 *   - 字体映射（由 FontAnalyzer 负责）
 */

import type { PdfTextContent, RawGlyph } from "./types";

/**
 * 从 PDF.js TextContent 提取 RawGlyph 数组。
 *
 * @param textContent PDF.js page.getTextContent() 的返回值
 * @returns RawGlyph[]（保留所有原始元数据）
 */
export function extractGlyphs(textContent: PdfTextContent): RawGlyph[] {
  const glyphs: RawGlyph[] = [];
  for (const item of textContent.items) {
    const str = item.str || "";
    if (!str.trim()) continue; // 跳过纯空白

    const tm = item.transform;
    if (!tm || tm.length < 6) continue;

    // 字体大小：优先用 item.fontSize，否则从 transform 矩阵计算
    // transform = [a, b, c, d, e, f]
    // 与 coord.ts LockCoordSystem.fromPDF 保持一致：fontSize = sqrt(a² + b²)
    // （对于非倾斜字体 b=0，结果 = |a|；若用 sqrt(a² + d²) 对于非倾斜字体会变成 |a|×sqrt(2) 偏大）
    const fontSize =
      item.fontSize && item.fontSize > 0
        ? item.fontSize
        : Math.sqrt(tm[0] * tm[0] + tm[1] * tm[1]) || item.height || 12;

    glyphs.push({
      str,
      transform: [tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]] as [number, number, number, number, number, number],
      fontName: item.fontName || "unknown",
      fontSize,
      width: item.width || 0,
      height: item.height || fontSize,
      pdfX: tm[4],
      pdfY: tm[5],
    });
  }
  return glyphs;
}
