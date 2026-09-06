/**
 * TextExtractor — Commit 5
 *
 * 从 PDF.js page.getTextContent() 提取 RawGlyph[]。
 *
 * 职责：
 *   - 调用 pdf.js getTextContent
 *   - 把每个 TextContent item 转换为 RawGlyph（含 transform/font 元数据）
 *   - 仅过滤真正的空字符串（保留空格 item，与 Adobe pdf.js 基准一致）
 *
 * 不做：
 *   - 合并行（由 SegmentBuilder 负责）
 *   - 坐标转换（由 CoordinateMapper 负责）
 *   - 字体映射（由 FontAnalyzer 负责）
 *
 * Sprint-99 Root Cause #2 修复：
 *   原代码 `if (!str.trim()) continue` 会丢弃 pdf.js 产生的「空格 TextItem」（str 为空格、length>0），
 *   而 Adobe 基准（benchmark-render-adapters.ts）只丢弃 str.length===0 的项。
 *   导致文档模型系统性少 25% glyph（glyph-lost）。改为仅过滤空串，与 Adobe 粒度一致。
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
    // Sprint-99 修复：只过滤真正空串，保留空格 item（与 Adobe pdf.js 基准粒度一致），
    // 消除系统性 glyph-lost（空格 TextItem 占文本层 ~25%）。
    if (!str) continue;

    const tm = item.transform;
    if (!tm || tm.length < 6) continue;

    // 字体大小：transform = [a, b, c, d, e, f]
    // M7.8-020-PROD：优先用 PDF.js 给出的 item.fontSize（已含 Tfs 与文本矩阵的纵向缩放，
    // 是 canvas 实际渲染字高）。若不存在，回退到垂直方向缩放 sqrt(c²+d²)。
    // 旧实现用水平缩放 sqrt(a²+b²) = Tfs×Th，当 PDF 用水平拉伸/压缩（Tz）且 Th≠1 时，
    // 字号会被算错；现在不再用水平缩放决定字号。
    const vScale = Math.sqrt(tm[2] * tm[2] + tm[3] * tm[3]);
    const hScale = Math.sqrt(tm[0] * tm[0] + tm[1] * tm[1]);
    const fontSize =
      (item.fontSize && item.fontSize > 0 ? item.fontSize : 0) ||
      (vScale > 0 ? vScale : 0) ||
      hScale ||
      item.height ||
      12;

    glyphs.push({
      str,
      transform: [tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]] as [number, number, number, number, number, number],
      fontName: item.fontName || "unknown",
      fontSize,
      // M7.8-020-PROD：水平缩放系数 Tz（hScale/vScale）。PDF 两端对齐常靠它拉伸/压缩字距，
      // 1 表示无水平缩放。编辑态可据此还原原文字宽。
      hz: fontSize > 0 ? hScale / fontSize : 1,
      width: item.width || 0,
      height: item.height || fontSize,
      color: (item as any).color,
      pdfX: tm[4],
      pdfY: tm[5],
    });
  }
  return glyphs;
}
