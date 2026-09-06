/**
 * Region Classifier — Task 1: Semantic/Layout classifier
 *
 * 根据 OCR Block 的文本内容 + bbox 位置 + GLM-OCR label 推断 LayoutRegionType。
 *
 * 输入：OCRRegion（Consumer Contract，含 text, label, y, h）
 * 输出：LayoutRegionType（paragraph | signature | table | stamp | footer）
 *
 * 分类策略（优先级从高到低）：
 *   1. GLM-OCR label 直接映射（如果 OCR 返回了明确的区域类型）
 *   2. 文本内容关键词匹配（签名、印章、页脚等特征词）
 *   3. bbox 位置启发式（页脚在页面底部 1/6 区域）
 *   4. 默认：paragraph
 *
 * 坐标系：OcrTextBlock 坐标在 canvas-pixel space at scale=1.5（ocr-utils.ts 约定）。
 * 本 Classifier 接收 pageHeight 参数用于位置判断（可选）。
 */

import type { LayoutRegionType } from "./types";

/**
 * Consumer Contract（Interface Segregation，Story-8）。
 *
 * region-classifier 只消费 OCR 文本块的这 4 个字段，因此定义自己的最小契约。
 * Producer（OcrTextBlock）结构兼容本契约即可，Consumer 不依赖 OcrTextBlock 类型。
 */
export interface OCRRegion {
  /** 文本内容 */
  text: string;
  /** GLM-OCR 区域标签（可选） */
  label?: string;
  /** 块顶部 Y（canvas px at scale=1.5） */
  y: number;
  /** 块高度（canvas px at scale=1.5） */
  h: number;
}

/**
 * GLM-OCR label → LayoutRegionType 映射表。
 *
 * GLM-OCR 常见 label：
 *   text, paragraph, title, header → paragraph
 *   signature, sign → signature
 *   table → table
 *   stamp, seal, red_seal → stamp
 *   footer, page_number, page_footer → footer
 *   figure, image → （已在 ocr-utils.ts 中过滤，不会到达此处）
 */
const LABEL_MAP: Record<string, LayoutRegionType> = {
  // 正文类
  text: "paragraph",
  paragraph: "paragraph",
  body: "paragraph",
  body_text: "paragraph",
  title: "paragraph",
  header: "paragraph",
  heading: "paragraph",
  caption: "paragraph",
  // 签名类
  signature: "signature",
  sign: "signature",
  signed_name: "signature",
  autograph: "signature",
  // 表格类
  table: "table",
  table_cell: "table",
  // 印章类
  stamp: "stamp",
  seal: "stamp",
  red_seal: "stamp",
  redstamp: "stamp",
  // 页脚类
  footer: "footer",
  page_footer: "footer",
  page_number: "footer",
  footnote: "footer",
};

/**
 * 签名/手写关键词（中英文）。
 * 匹配到这些关键词的 block 倾向于 signature 类型。
 */
const SIGNATURE_KEYWORDS = [
  // 中文
  "签名", "签字", "签署", "医师签名", "盖章", "手写",
  // 英文
  "signature", "signed", "sign here", "authorized signature",
  "physician signature", "attending physician",
];

/**
 * 印章关键词。
 */
const STAMP_KEYWORDS = [
  // 中文
  "公章", "专用章", "医疗专用章", "诊断专用章", "证明专用章",
  // 英文
  "seal", "stamp", "official seal",
];

/**
 * 页脚关键词。
 */
const FOOTER_KEYWORDS = [
  // 中文
  "第", "页", "共", "页码",
  // 英文
  "page ", "page ", "of ", "copyright", "all rights reserved",
];

/**
 * 表格特征：文本含制表符或大量连续空格（表格单元格分隔）。
 */
function hasTableCellSeparators(text: string): boolean {
  return /\t/.test(text) || / {3,}/.test(text);
}

/**
 * 判断 bbox 是否在页面底部 1/6 区域（页脚特征）。
 *
 * @param ocrY block 的 y 坐标（canvas px at scale=1.5）
 * @param ocrH block 的高度
 * @param pageHeight 页面总高度（canvas px at scale=1.5，可选）
 */
function isAtPageFooter(ocrY: number, ocrH: number, pageHeight?: number): boolean {
  if (pageHeight === undefined || pageHeight <= 0) return false;
  // 页脚通常在底部 1/6 区域
  const footerThreshold = pageHeight * (5 / 6);
  return ocrY >= footerThreshold;
}

/**
 * 检查文本是否匹配任意关键词（不区分大小写）。
 */
function matchesKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * 分类 OCR block 的区域类型。
 *
 * @param ocr OCR 文本块（canvas px at scale=1.5）
 * @param pageHeight 页面总高度（canvas px at scale=1.5，可选，用于页脚判断）
 * @returns LayoutRegionType
 *
 * 分类优先级：
 *   1. GLM-OCR label 直接映射
 *   2. 印章关键词（印章特征最明显，优先判断）
 *   3. 签名关键词
 *   4. 表格特征（制表符/多空格分隔）
 *   5. 页脚位置 + 页脚关键词
 *   6. 默认 paragraph
 */
export function classifyRegion(
  ocr: OCRRegion,
  pageHeight?: number
): LayoutRegionType {
  const text = ocr.text || "";

  // 1. GLM-OCR label 直接映射
  if (ocr.label) {
    const labelLower = ocr.label.toLowerCase().trim();
    const mapped = LABEL_MAP[labelLower];
    if (mapped) {
      return mapped;
    }
  }

  // 2. 印章关键词
  if (matchesKeyword(text, STAMP_KEYWORDS)) {
    return "stamp";
  }

  // 3. 签名关键词
  if (matchesKeyword(text, SIGNATURE_KEYWORDS)) {
    return "signature";
  }

  // 4. 表格特征：制表符或大量连续空格
  if (hasTableCellSeparators(text)) {
    return "table";
  }

  // 5. 页脚：位置在底部 + 含页脚关键词
  if (isAtPageFooter(ocr.y, ocr.h, pageHeight) && matchesKeyword(text, FOOTER_KEYWORDS)) {
    return "footer";
  }

  // 6. 默认：正文段落
  return "paragraph";
}

/**
 * 批量分类 OCR blocks 的区域类型。
 *
 * @param ocrBlocks 同一页的 OCR 文本块
 * @param pageHeight 页面总高度（canvas px at scale=1.5，可选）
 * @returns 每个 block 对应的 LayoutRegionType
 */
export function classifyRegions(
  ocrBlocks: OCRRegion[],
  pageHeight?: number
): LayoutRegionType[] {
  return ocrBlocks.map((ocr) => classifyRegion(ocr, pageHeight));
}
