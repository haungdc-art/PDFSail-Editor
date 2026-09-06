/**
 * Text Extraction Layer — 文本提取统一入口
 *
 * 把两个来源统一为 DocumentTextBlock：
 *   1. PDF 原生文本 (pdf.js TextContent) → source.type = "pdf_text"
 *   2. OCR 识别文本 (GLM-OCR)           → source.type = "ocr"
 *
 * 输出的 DocumentTextBlock 经过 Line Detection 拆成行级 block，
 * 再转换为编辑器的 Block 类型注入 docBlocks。
 */

import type { DocumentTextBlock, TextStyle, TextSource } from "./types";
import type { OcrTextBlock } from "../../ocr/ocr-storage";

/**
 * OCR TextBlock → DocumentTextBlock（段落级）
 *
 * OCR 块的坐标在 canvas-pixel space at scale=1.5（ocr-utils.ts 约定）。
 * 调用方负责在注入编辑器时乘以 cssScale 转 CSS 显示坐标。
 *
 * 输出的是段落级 block，后续由 Line Detector 拆成行级。
 */
export function ocrBlockToDocumentBlock(
  ocr: OcrTextBlock,
  sourceRef?: number
): DocumentTextBlock {
  // OCR 块的 fontSize 已经是单行字号（ocr-utils.ts 中 singleLineHeight * 0.72）
  // lineHeight = fontSize / 0.72 ≈ fontSize * 1.389
  const fontSize = ocr.fontSize;
  const lineHeight = fontSize / 0.72;

  const style: TextStyle = {
    fontSize,
    lineHeight,
    fontFamily: '"Noto Sans SC", "Microsoft YaHei", "PingFang SC", sans-serif',
    color: "#000000",
  };

  const source: { type: TextSource; ref?: number } = {
    type: "ocr",
    ref: sourceRef,
  };

  return {
    id: ocr.id,
    page: ocr.page,
    bbox: {
      x: ocr.x,
      y: ocr.y,
      width: ocr.w,
      height: ocr.h,
    },
    text: ocr.text,
    type: "paragraph",
    style,
    source,
    children: undefined,
  };
}

/**
 * 批量转换 OCR blocks → DocumentTextBlock[]
 */
export function ocrBlocksToDocumentBlocks(
  ocrBlocks: OcrTextBlock[]
): DocumentTextBlock[] {
  return ocrBlocks.map((b, i) => ocrBlockToDocumentBlock(b, i));
}

/**
 * pdf.js text item → DocumentTextBlock（行级，因为 pdf.js 的 text item 通常已经是行级或词级）
 *
 * 坐标系：pdf.js transform → canvas-pixel space at given scale
 */
export function pdfTextItemToDocumentBlock(
  item: { str: string; transform: number[] },
  page: number,
  viewportHeight: number,
  scale: number,
  index: number
): DocumentTextBlock | null {
  if (!item.str || !item.transform || item.str.trim().length === 0) return null;

  // transform[4] = X, transform[5] = Y (PDF 坐标，底部 0)
  // transform[0] = fontSize X, transform[3] = fontSize Y
  const x = item.transform[4] * scale;
  const fontSize = Math.abs(item.transform[0] || 12) * scale;
  const y = viewportHeight - item.transform[5] * scale - fontSize;
  const lineHeight = fontSize * 1.3;

  // 测量文本宽度
  const text = item.str;

  return {
    id: `pdf_text_${page}_${index}`,
    page,
    bbox: {
      x,
      y,
      width: text.length * fontSize * 0.5, // 粗略估算，pdf.js 不直接给 width
      height: lineHeight,
    },
    text,
    type: "line",
    style: {
      fontSize,
      lineHeight,
      color: "#000000",
    },
    source: { type: "pdf_text", ref: index },
    children: undefined,
  };
}
