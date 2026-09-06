/**
 * ExportCommand — Sprint 7 Task 1
 *
 * PDF 导出命令模型。
 *
 * 从 EditableDocument 生成，独立于渲染用的 RenderCommand。
 * RenderCommand 面向屏幕（CSS px），ExportCommand 面向 PDF（pt 坐标系）。
 *
 * 类型：
 *   - DrawTextGlyph：绘制单个字符（glyph 级精确导出）
 *   - DrawImage：绘制图片
 *   - DrawLine：绘制矩形（mask 遮盖 / 背景线）
 *   - Redaction：涂黑遮盖
 *
 * 坐标系：PDF pt（bottom-left origin, Y up）
 * 转换由 ExportRenderer 负责（CSS px → PDF pt）
 */

import type {
  GlyphFontIdentity,
  GlyphMetrics,
  TransformMatrix,
} from "./types";

/** ExportCommand 类型标记 */
export type ExportCommandType =
  | "drawTextGlyph"
  | "drawImage"
  | "drawLine"
  | "redaction";

/** 绘制单个字符（glyph 级精确导出） */
export interface DrawTextGlyphCommand {
  type: "drawTextGlyph";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 字符内容 */
  char: string;
  /** 位置（PDF pt，bottom-left origin） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /**
   * 文字基线纵坐标（PDF pt，bottom-left origin）。
   * 由导出阶段根据 glyph 真实 baseline（与 native replay / 编辑器预览一致）换算得到。
   * 缺省时回退到 g.y（bbox 底部近似 baseline），绝不能再退回 g.y + g.height（那是 bbox 顶部，会让文字整体上移一整行高）。
   */
  baseline?: number;
  /** 字体大小（PDF pt） */
  fontSize: number;
  /** 字体 family（CSS font-family 字符串） */
  fontFamily: string;
  /** 字体 weight */
  fontWeight: string | number;
  /** 字体 style */
  fontStyle: string;
  /** 颜色（#RRGGBB） */
  color: string;
  /** 所属 block ID */
  blockId: string;
  /**
   * Sprint34.7: 所属 line 索引（可选）。
   * 用于 export 阶段按 EditableDocument line 边界逐行导出，避免重新 wrap。
   */
  lineIndex?: number;
  /**
   * Sprint34.11: 旋转角度（度，CSS 顺时针为正，与 glyph 一致）。
   * 导出 drawText 时用于旋转字形（需取负转 PDF 系）。
   */
  rotation?: number;
  /** 是否被修改过 */
  modified: boolean;
  /**
   * CSS 归一化 transform matrix [a, b, c, d, e, f]（可选）。
   * 仅保留旋转/倾斜，导出时用于恢复 PDF 原始旋转角度。
   */
  transform?: [number, number, number, number, number, number];
  /**
   * M7.5-005A：PDF Native Font Identity（可选）。源自 EditableGlyph.metrics.fontIdentity，
   * 供 Export 侧"看见"原字体资源（fontRef/baseFont/subtype/embedded/encoding）。
   * 本阶段仅透传，不消费（005B Font Resolver 再引用）。
   */
  fontIdentity?: GlyphFontIdentity;
  /**
   * M7.8-035R: 原 PDF 字符编码（pdfCharCode）。导出原生字体重绘时需要用它直接选择
   * 原字体（特别是 Type3）中的字形，而不是把 Unicode 当普通字符串嵌入回退字体。
   */
  pdfCharCode?: number;
  /**
   * M7.5-005A：PDF 原始综合变换矩阵（TextMatrix×FontMatrix×CTM，PDF pt 域，可选）。
   * 源自 EditableGlyph.metrics.pdfTransform。本阶段仅透传，不消费（005C Matrix Writer 再写回）。
   */
  pdfTransform?: TransformMatrix;
  /**
   * M7.5-005A：glyph 级 PDF 原生度量（advanceWidth/fontMatrix/pdfTransform/fontIdentity，可选）。
   * 保留完整 Native 上下文，避免逐字段复制丢信息。
   */
  glyphMetrics?: GlyphMetrics;
}

/** 绘制图片 */
export interface DrawImageCommand {
  type: "drawImage";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 图片 src（data URL 或 URL） */
  src: string;
  /** 位置（PDF pt） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /** 所属 block ID */
  blockId: string;
  /**
   * Sprint34.11: 旋转角度（度，CSS 顺时针为正，与 glyph 一致）。
   * 导出时若存在则用 PDF transform 绕 bbox 左上角旋转（需取负转 PDF 系）。
   */
  rotation?: number;
}

/** 绘制矩形（mask 遮盖 / 背景线） */
export interface DrawLineCommand {
  type: "drawLine";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 位置（PDF pt） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /** 用途：mask = 白色遮盖，background = 背景填充 */
  purpose: "mask" | "background";
  /** 所属 block ID */
  blockId: string;
}

/** 涂黑遮盖 */
export interface RedactionCommand {
  type: "redaction";
  /** Sprint39: 目标页码（0-based），用于多页 PDF 按页写入 */
  pageIndex: number;
  /** 位置（PDF pt） */
  x: number;
  y: number;
  /** 尺寸（PDF pt） */
  width: number;
  height: number;
  /** 所属 block ID */
  blockId: string;
}

/** ExportCommand 联合类型 */
export type ExportCommand =
  | DrawTextGlyphCommand
  | DrawImageCommand
  | DrawLineCommand
  | RedactionCommand;

/** 类型守卫 */
export function isDrawTextGlyph(
  cmd: ExportCommand
): cmd is DrawTextGlyphCommand {
  return cmd.type === "drawTextGlyph";
}

export function isDrawExportImage(
  cmd: ExportCommand
): cmd is DrawImageCommand {
  return cmd.type === "drawImage";
}

export function isDrawExportLine(cmd: ExportCommand): cmd is DrawLineCommand {
  return cmd.type === "drawLine";
}

export function isRedaction(cmd: ExportCommand): cmd is RedactionCommand {
  return cmd.type === "redaction";
}

/**
 * 按类型分组 ExportCommand（便于批量写入 PDF）
 */
export function groupExportCommands(commands: ExportCommand[]): {
  textGlyphs: DrawTextGlyphCommand[];
  images: DrawImageCommand[];
  lines: DrawLineCommand[];
  redactions: RedactionCommand[];
} {
  const textGlyphs: DrawTextGlyphCommand[] = [];
  const images: DrawImageCommand[] = [];
  const lines: DrawLineCommand[] = [];
  const redactions: RedactionCommand[] = [];

  for (const cmd of commands) {
    if (isDrawTextGlyph(cmd)) textGlyphs.push(cmd);
    else if (isDrawExportImage(cmd)) images.push(cmd);
    else if (isDrawExportLine(cmd)) lines.push(cmd);
    else if (isRedaction(cmd)) redactions.push(cmd);
  }

  return { textGlyphs, images, lines, redactions };
}
