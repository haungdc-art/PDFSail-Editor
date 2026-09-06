/**
 * Line Detector — 段落→行 拆分引擎（V2: source layer / render layer 分离）
 *
 * 核心职责：
 *   把 OCR 段落级 TextBlock 拆成行级 TextBlock，同时保留段落 bbox 用于原文遮盖。
 *
 * V2 改进（按 "source layer 和 render layer 彻底分离" 文档）：
 *   1. 行数估算：用段落高度 / 单行高度 推断行数（不再用 measureText 重新排版）
 *   2. originalBounds：每个行 block 保留段落 bbox，用于白色遮盖原文
 *   3. 文本分配：按估算行数均匀分配文字（不改变原始 fontSize）
 *
 * 渲染流程：
 *   Block.originalBounds → 白色矩形覆盖原文（source layer mask）
 *   Block.bbox           → 画新文字（render layer）
 */

import type { DocumentTextBlock, BBox } from "./types";

/**
 * 给 DocumentTextBlock 增加 originalBounds 字段
 *（保留段落 bbox，用于白色遮盖原文）
 */
export interface LineBlockWithOriginal extends DocumentTextBlock {
  /** 原文段落 bbox（用于白色遮盖，source layer） */
  originalBounds: BBox;
}

/**
 * 用段落高度估算行数
 *
 * 段落高度 / 单行行高 = 行数
 * 例如：height=42.9, lineHeight=14.3 → 3 行
 */
function estimateLineCount(paragraphHeight: number, lineHeight: number): number {
  if (lineHeight <= 0) return 1;
  const count = Math.round(paragraphHeight / lineHeight);
  return Math.max(1, count);
}

/**
 * 把文本分配到 N 行
 *
 * 策略：
 *   1. 按空格分词
 *   2. 均匀分配到 N 行（每行 wordCount/N 个词）
 *   3. 如果文本本身含换行符，优先尊重原始换行
 */
function distributeTextToLines(text: string, lineCount: number): string[] {
  // 如果文本本身含换行符，优先用原始换行
  const naturalLines = text.split("\n").filter((l) => l.length > 0);
  if (naturalLines.length >= lineCount) {
    // 原始换行数 >= 估算行数，用原始换行
    return naturalLines.slice(0, lineCount);
  }

  if (lineCount === 1) return [text];

  // 按空格分词，均匀分配
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [text];

  const wordsPerLine = Math.ceil(words.length / lineCount);
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    const start = i * wordsPerLine;
    const end = Math.min(start + wordsPerLine, words.length);
    lines.push(words.slice(start, end).join(" "));
  }

  // 如果最后一行为空，移除
  return lines.filter((l) => l.length > 0);
}

/**
 * 段落→行拆分（V2: 高度估算 + originalBounds）
 *
 * @param paragraph OCR 段落 block
 * @returns 行级 block 数组，每个 block 含 originalBounds（段落 bbox）
 */
export function splitParagraphToLines(
  paragraph: DocumentTextBlock
): LineBlockWithOriginal[] {
  const { bbox, text, style, page, source, id } = paragraph;

  if (!text || !bbox.width) {
    return [{ ...paragraph, type: "line", originalBounds: bbox }];
  }

  // Step 1: 用段落高度估算行数（不用 measureText 重新排版）
  const lineCount = estimateLineCount(bbox.height, style.lineHeight);

  // Step 2: 分配文本到行
  const lines = distributeTextToLines(text, lineCount);

  // Step 3: 每行生成独立 block，保留段落 bbox 作为 originalBounds
  const actualLineCount = lines.length;
  const lineHeight = style.lineHeight;

  const lineBlocks: LineBlockWithOriginal[] = lines.map((lineText, i) => ({
    id: `${id}_L${i}`,
    page,
    bbox: {
      x: bbox.x,
      y: bbox.y + i * lineHeight,
      width: bbox.width,
      height: lineHeight,
    },
    text: lineText,
    type: "line" as const,
    style: { ...style },
    source: { ...source, ref: i },
    children: undefined,
    // 关键：保留段落 bbox 用于白色遮盖原文（source layer）
    originalBounds: {
      x: bbox.x,
      y: bbox.y,
      width: bbox.width,
      height: Math.max(bbox.height, actualLineCount * lineHeight),
    },
  }));

  return lineBlocks;
}

/**
 * 批量拆分：把段落级 block 数组全部拆成行级
 */
export function splitAllParagraphsToLines(
  blocks: DocumentTextBlock[]
): LineBlockWithOriginal[] {
  const result: LineBlockWithOriginal[] = [];
  for (const b of blocks) {
    if (b.type === "paragraph" || (b.children && b.children.length > 0)) {
      result.push(...splitParagraphToLines(b));
    } else {
      // 非段落 block，补充 originalBounds
      result.push({ ...b, type: "line", originalBounds: b.bbox });
    }
  }
  return result;
}

/**
 * 方法 2（推荐）：融合 pdf.js TextContent + OCR 段落
 *
 * 当 PDF 有文本层时，用 pdf.js Y 坐标精确分行。
 * 仍保留 originalBounds = 段落 bbox。
 */
export function fuseWithPdfTextLayer(
  ocrBlocks: DocumentTextBlock[],
  pdfTextItems: { str: string; transform: number[] }[],
  viewportHeight: number,
  scale: number
): LineBlockWithOriginal[] {
  if (!pdfTextItems || pdfTextItems.length === 0) {
    return splitAllParagraphsToLines(ocrBlocks);
  }

  const yThreshold = 5 * scale;
  const lineGroups: { y: number; items: { str: string; x: number }[] }[] = [];

  for (const item of pdfTextItems) {
    if (!item.str || !item.transform) continue;
    const y = viewportHeight - item.transform[5] * scale;
    const x = item.transform[4] * scale;

    const group = lineGroups.find((g) => Math.abs(g.y - y) < yThreshold);
    if (group) {
      group.items.push({ str: item.str, x });
      group.y = (group.y + y) / 2;
    } else {
      lineGroups.push({ y, items: [{ str: item.str, x }] });
    }
  }

  const pdfLines = lineGroups
    .map((g) => {
      g.items.sort((a, b) => a.x - b.x);
      return {
        y: g.y,
        text: g.items.map((it) => it.str).join(" ").replace(/\s+/g, " ").trim(),
      };
    })
    .filter((l) => l.text.length > 0)
    .sort((a, b) => a.y - b.y);

  if (pdfLines.length === 0) {
    return splitAllParagraphsToLines(ocrBlocks);
  }

  const result: LineBlockWithOriginal[] = [];

  for (const ocrBlock of ocrBlocks) {
    const { bbox, style, page, source, id } = ocrBlock;

    const containedLines = pdfLines.filter(
      (l) => l.y >= bbox.y - style.lineHeight && l.y <= bbox.y + bbox.height + style.lineHeight
    );

    if (containedLines.length === 0) {
      result.push(...splitParagraphToLines(ocrBlock));
      continue;
    }

    containedLines.forEach((line, i) => {
      result.push({
        id: `${id}_L${i}`,
        page,
        bbox: {
          x: bbox.x,
          y: line.y - style.lineHeight * 0.8,
          width: bbox.width,
          height: style.lineHeight,
        },
        text: line.text,
        type: "line" as const,
        style: { ...style },
        source: { ...source, ref: i },
        children: undefined,
        originalBounds: bbox,
      });
    });
  }

  return result;
}
