/**
 * DocumentTextBlock — PDF 编辑语义中间层的数据模型
 *
 * 设计思想：PDF 不是一堆文字，而是一组有空间、有样式、有关系的 Text Block。
 *
 * 层级结构：
 *   Page → Paragraph Block → Line Block → Word Block
 *
 * 来源统一：
 *   - PDF 原生文本 (pdf.js TextContent) → source.type = "pdf_text"
 *   - OCR 识别文本 (GLM-OCR)           → source.type = "ocr"
 *   - AI 生成文本                       → source.type = "ai_generated"
 */

/** Block 类型 */
export type TextBlockType = "paragraph" | "line" | "word" | "title" | "table";

/** 文本来源 */
export type TextSource = "pdf_text" | "ocr" | "ai_generated";

/** 排版样式 */
export interface TextStyle {
  fontFamily?: string;
  fontSize: number;       // CSS px
  fontWeight?: string;    // "normal" | "bold"
  color?: string;         // "#RRGGBB"
  lineHeight: number;     // 行高（CSS px）
  alignment?: "left" | "center" | "right";
}

/** 几何信息 */
export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** DocumentTextBlock — 语义中间层的核心数据模型 */
export interface DocumentTextBlock {
  id: string;

  page: number;

  /** 几何信息（CSS px，与编辑器 docBlocks 同坐标系） */
  bbox: BBox;

  /** 文本内容 */
  text: string;

  /** 结构类型 */
  type: TextBlockType;

  /** 排版样式 */
  style: TextStyle;

  /** 来源信息 */
  source: {
    type: TextSource;
    /** 原始 OCR region index 或 pdf.js item index */
    ref?: number;
  };

  /** 子块（层级结构：paragraph → line → word） */
  children?: DocumentTextBlock[];
}

/**
 * LineInfo — Layout Engine 产出的单行信息
 */
export interface LineInfo {
  text: string;
  width: number;   // 实际文本宽度（CSS px）
  x: number;       // 行起点 X
  y: number;       // 行起点 Y（top）
  height: number;  // 行高
}
