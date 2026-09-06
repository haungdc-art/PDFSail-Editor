/**
 * BackgroundPatch — Sprint 31.2 标准 Patch 对象结构
 *
 * 描述一个已生成的背景补丁，包含其位置、图片数据和生成方法。
 * 在 reconstructCompositeRegion() → renderLayers → DOM 这条链路中使用。
 */
export interface BackgroundPatch {
  /** 唯一补丁标识 */
  id: string;
  /** 所属区域 ID（composite_sig_1 等） */
  regionId: string;
  /** 补丁包围盒（CSS 显示坐标） */
  bbox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 补丁图片 dataURL */
  image: string;
  /** 生成方法 */
  method: "local-background-feather" | "ocr-mask";
  /** 层叠顺序 */
  zIndex: number;
}

/**
 * RenderCommand — Sprint 5 Task 1
 *
 * Glyph 级渲染命令模型。
 *
 * 从 TextBlock 抽象升级为 RenderCommand，实现 Adobe 级字符位置控制。
 *
 * 类型：
 *   - DrawGlyph：绘制单个字符（精确 x/y/width/height/styleRef）
 *   - DrawLine：绘制行背景/遮盖（原文遮盖矩形）
 *   - DrawImage：绘制图片
 *
 * 数据流：
 *   EditableDocument → DocumentRenderer → RenderCommand[] → GlyphRenderer → DOM span[]
 *
 * 坐标系：Document Space（CSS 显示坐标，top-left origin, Y down）
 */

import type { BBox, TransformMatrix } from "./types";

/** RenderCommand 类型标记 */
export type RenderCommandType = "drawGlyph" | "drawLine" | "drawRect" | "drawImage";

/** 绘制单个字符 */
export interface DrawGlyphCommand {
  type: "drawGlyph";
  /** 字符内容 */
  char: string;
  /** 字符位置和尺寸（CSS 显示坐标） */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 指向文档级 styles 数组的索引 */
  styleRef: number;
  /** 所属 block ID（用于交互定位） */
  blockId: string;
  /** 所属行 ID（用于行级操作） */
  lineId: string;
  /** 是否被修改过 */
  modified: boolean;
  /**
   * CSS 归一化 transform matrix [a, b, c, d, e, f]。
   * 仅保留旋转/倾斜（缩放归一化为 1，平移归零）。
   * 无旋转时为 [1, 0, 0, 1, 0, 0]。
   * GlyphRenderer 渲染为 CSS `transform: matrix(a,b,c,d,e,f)`。
   */
  transform?: TransformMatrix;
  /**
   * CSS 显示坐标下的真实基线（Original Fact，Milestone-1 Baseline）。
   * 来自 EditableGlyph.baseline（= RawGlyph.pdfY 经 pdfYToCssY 纯坐标转换）。
   * 与 bbox.y（box-top）不同，这是真实基线位置。
   */
  baseline?: number;
}

/** 绘制行背景/遮盖矩形（保留用于行级背景/下划线等） */
export interface DrawLineCommand {
  type: "drawLine";
  /** 矩形位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 用途：mask = 原文白色遮盖，background = 行背景 */
  purpose: "mask" | "background";
  /** 所属 block ID */
  blockId: string;
}

/** 绘制填充矩形（像素级覆盖，用于 signature replacement zone 等大面积背景恢复） */
export interface DrawRectCommand {
  type: "drawRect";
  /** 矩形位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 填充颜色 */
  fill: string;
  /** 不透明度 */
  opacity: number;
  /** 所属 block / region ID */
  blockId: string;
  /** 用途说明（mask = 背景恢复遮罩） */
  purpose?: "mask" | "background";
}

/** 绘制图片 */
export interface DrawImageCommand {
  type: "drawImage";
  /** 图片 src（data URL 或 URL） */
  src: string;
  /** 位置和尺寸 */
  x: number;
  y: number;
  width: number;
  height: number;
  /** 所属 block ID */
  blockId: string;
  /** 唯一 patch 标识符（如 "sig-patch-{regionId}"），用于 DOM 定位和调试 */
  patchId?: string;
  /**
   * Sprint34.11: 旋转角度（度，CSS 顺时针为正，与 glyph rotation 一致）。
   * 用于让 signature background patch 与 glyph 使用同一 rotation（如 -1.3°）。
   * 缺省时不旋转（0）。
   */
  rotation?: number;
}

/** RenderCommand 联合类型 */
export type RenderCommand =
  | DrawGlyphCommand
  | DrawLineCommand
  | DrawRectCommand
  | DrawImageCommand;

/** 类型守卫 */
export function isDrawGlyph(cmd: RenderCommand): cmd is DrawGlyphCommand {
  return cmd.type === "drawGlyph";
}

export function isDrawLine(cmd: RenderCommand): cmd is DrawLineCommand {
  return cmd.type === "drawLine";
}

export function isDrawRect(cmd: RenderCommand): cmd is DrawRectCommand {
  return cmd.type === "drawRect";
}

export function isDrawImage(cmd: RenderCommand): cmd is DrawImageCommand {
  return cmd.type === "drawImage";
}

/**
 * 按类型分组 RenderCommand（便于 GlyphRenderer 批量渲染）
 */
export function groupCommands(commands: RenderCommand[]): {
  glyphs: DrawGlyphCommand[];
  lines: DrawLineCommand[];
  rects: DrawRectCommand[];
  images: DrawImageCommand[];
} {
  const glyphs: DrawGlyphCommand[] = [];
  const lines: DrawLineCommand[] = [];
  const rects: DrawRectCommand[] = [];
  const images: DrawImageCommand[] = [];

  for (const cmd of commands) {
    if (isDrawGlyph(cmd)) glyphs.push(cmd);
    else if (isDrawLine(cmd)) lines.push(cmd);
    else if (isDrawRect(cmd)) rects.push(cmd);
    else if (isDrawImage(cmd)) images.push(cmd);
  }

  return { glyphs, lines, rects, images };
}
