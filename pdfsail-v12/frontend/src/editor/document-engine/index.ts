/**
 * document-engine — PDF 编辑语义中间层
 *
 * 架构：
 *   PDF / OCR
 *      ↓
 *   Text Extraction Layer（统一为 DocumentTextBlock）
 *      ↓
 *   Line Detector（段落→行拆分）
 *      ↓
 *   Layout Engine（measureText 换行）
 *      ↓
 *   Editor Renderer / PDF Export
 *
 * V1 目标：解决 OCR 文字替换后布局错乱、字体大小变化、多行文本无法保持原样
 */

export type { DocumentTextBlock, TextStyle, TextSource, TextBlockType, BBox, LineInfo } from "./types";
export { wrapText, measureText, estimateLineCount } from "./layout-engine";
export { splitParagraphToLines, splitAllParagraphsToLines, fuseWithPdfTextLayer } from "./line-detector";
export { ocrBlockToDocumentBlock, ocrBlocksToDocumentBlocks, pdfTextItemToDocumentBlock } from "./text-extraction";
