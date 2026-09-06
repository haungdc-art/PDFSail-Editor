/**
 * editor-engine/types.ts — Commit 5
 *
 * Text Intelligence Layer 的核心类型定义。
 *
 * 数据流：
 *   PDF.js TextContent → RawGlyph → LineGroup → Segment → EditableTextNode
 *
 * 设计原则：
 *   - 每个 Segment 对应一个可编辑框（按标点切割）
 *   - 保留完整字体元数据（family/size/weight/color/transform）
 *   - 坐标同时保存 PDF pt 和 CSS px，避免反复转换
 */

import type { FontResolution } from "../editor/font-resolution";

/** 从 PDF.js getTextContent() 提取的原始 glyph（含字体元数据） */
export interface RawGlyph {
  /** 字符文本（可能是单字也可能是 word，取决于 PDF.js item 粒度） */
  str: string;
  /** PDF transform matrix [a, b, c, d, e, f] */
  transform: [number, number, number, number, number, number];
  /** 字体名（subset 前缀保留，如 "ABCDEF+Helvetica"） */
  fontName: string;
  /** 字体大小（pt，已从 transform 矩阵计算） */
  fontSize: number;
  /** 文本宽度（pt） */
  width: number;
  /** 文本高度（pt） */
  height: number;
  /** PDF.js 文本项颜色（[r,g,b,a]，0-1 或 0-255） */
  color?: number[];
  /** 水平缩放系数 Tz（1 = 无缩放） */
  hz?: number;
  /** PDF 坐标系下的 x（pt，= transform[4]） */
  pdfX: number;
  /** PDF 坐标系下的 y（pt，= transform[5]，bottom-left origin） */
  pdfY: number;
}

/** 同一行的 glyph 集合（已合并） */
export interface LineGroup {
  /** 合并后的完整文本 */
  text: string;
  /** PDF 坐标系下的 x（pt，行起始） */
  pdfX: number;
  /** PDF 坐标系下的 y（pt） */
  pdfY: number;
  /** 行宽（pt） */
  width: number;
  /** 行高（pt） */
  height: number;
  /** 主字体名（出现最多的 glyph 的字体） */
  fontName: string;
  /** 主字体大小（pt） */
  fontSize: number;
  /** 行颜色（取主 glyph 的 PDF.js 文本项颜色） */
  color?: number[];
  /** 行文本对齐方式（用于编辑态还原 PDF 布局） */
  textAlign?: "left" | "right" | "justify";
  /** 行水平缩放系数 Tz（1 = 无缩放） */
  hz?: number;
  /** 该行所有 glyph（保留以备后续精细编辑） */
  glyphs: RawGlyph[];
}

/** 按标点切割后的可编辑片段 */
export interface Segment {
  id: string;
  /** 片段文本（含结尾标点） */
  text: string;
  /** 原始文本（用于判断是否被修改过；修改过的 segment 不透明显示，覆盖底层 PDF canvas 原文） */
  originalText: string;
  /** PDF 坐标系 bbox（pt） */
  pdfX: number;
  pdfY: number;
  pdfW: number;
  pdfH: number;
  /** CSS 坐标系 bbox（px，已应用 zoom + 96/72 转换 + viewport scale）。注意：cssY 是 bbox 顶 = 基线 + 升部，不是基线本身 */
  cssX: number;
  cssY: number;
  cssW: number;
  cssH: number;
  /** CSS 坐标系基线（px）。M7.8-014F：EditableTextNode 需用 baseline - cssAscent 定位，与 GlyphRenderer 的 spanTop 一致 */
  cssBaseline: number;
  /** 字体元数据 */
  font: FontMeta;
  /** M7.8-020-PROD：统一字体解析结果（embedded/system/fallback）。EditableTextNode 只消费 resolvedFontFamily。 */
  fontResolution?: FontResolution;
  /** PDF 行对齐方式（编辑态还原布局） */
  textAlign?: "left" | "right" | "justify";
  /** PDF 水平缩放系数 Tz（1 = 无缩放；编辑态用于还原原文字宽） */
  hz?: number;
  /** 所属行 ID（便于跨行编辑时定位） */
  lineId: string;
  /** 是否是表格 cell（表格模式切割的） */
  isTableCell?: boolean;
  /**
   * M7.8-040：Segment → EditableDocument 的精确 source binding。
   * 由 buildSegmentFromGlyphs 在创建 Segment 时**直接由当前 glyph run** 产生，
   * 不依赖 indexOf(originalText) 反推。
   *
   * 复用 document-selection.ts 的 {blockId, lineId, startGlyphIndex, endGlyphIndex} 模型
   * （glyph 索引 = EditableLine.glyphs 下标；endGlyphIndex 含）。
   * operatorId/operatorCharIndex 仅作为 provenance，不作为主定位键。
   */
  source?: {
    blockId: string;
    lineId: string;
    /** 行在所属 block 内的序号。跨 Producer 语义对齐用：OCR 注入文档的 line.id 是 UUID 形式，
     *  与 Native 的 `pdf_${blockId}_l${lineIdx}` 约定不同，binding 在精确 id 不匹配时回退到此序号定位。
     *  可选：旧/外部构造的 Segment 可能不带，此时仅精确 id 匹配生效（OCR 注入文档需携带以触发回退）。 */
    lineIdx?: number;
    startGlyphIndex: number;
    endGlyphIndex: number;
  };
}

/** 字体元数据（Font Fidelity Layer 核心） */
export interface FontMeta {
  /** CSS font-family（已映射，如 "Helvetica", "Arial", "SimSun"） */
  family: string;
  /** PDF 原始字体名（如 "ABCDEF+Helvetica"） */
  rawFontName: string;
  /** CSS font-size（px，已转换 pt × zoom × 96/72） */
  size: number;
  /** CSS font-weight（400/700 等） */
  weight: number;
  /** CSS font-style（"normal" | "italic"） */
  style?: string;
  /** CSS color（如 "#000000"） */
  color: string;
  /** CSS line-height */
  lineHeight: number;
}

/** PDF.js TextContent item 的最小接口（避免依赖完整类型） */
export interface PdfTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName?: string;
  fontSize?: number;
}

/** PDF.js TextContent 的最小接口 */
export interface PdfTextContent {
  items: PdfTextItem[];
}
