/**
 * SignatureReplacementModel — Sprint 19
 *
 * Adobe 风格的签名区域替换架构：
 *   不是生成数千个 mask 矩形，而是用一张清理后的背景图
 *   完整替换签名区域的原图，然后在其上渲染可编辑 OCR 文字。
 *
 * 渲染顺序：Image → BackgroundPatch → EditableGlyph
 *
 * @deprecated 替代对象：
 *   - signatureMasksRef (数千个 DrawRectCommand)
 *   - suppressedGlyphIdsRef (分散的 block ID 集合)
 */

import type { BBox, EditableBlock } from "./types";

/**
 * 单个签名区域的完整替换模型。
 */
export interface SignatureReplacement {
  /** 唯一标识 */
  id: string;
  /** 类型标记 */
  type: "signature-replacement";

  /**
   * 替换区域的原始 bbox（CSS 显示坐标）。
   * 此区域内的原图将被背景补丁完全覆盖。
   */
  originalRegion: BBox;

  /**
   * 清理后的背景图像 data URL（image/png）。
   * 原文手写文字已被擦除，但签名横线、文档图形等被保留。
   * 直接作为 DrawImageCommand.src 注入渲染管道。
   */
  backgroundPatch: string;

  /**
   * 区域内保持可见/可编辑的 printed block。
   * 这些 block 的 glyph 将在背景补丁之上渲染。
   */
  editableTextBlocks: EditableBlock[];

  /**
   * 检测到的基线旋转角度（度，顺时针为正）。
   * 0 = 水平基线。该值应用于此区域内 editable text 的 glyph transform。
   */
  rotationAngle: number;

  /** 旋转检测的置信度（0-1） */
  rotationConfidence: number;

  /** 签名区域检测的总体置信度 */
  confidence: number;

  /** 使用的背景重建方法 */
  reconstructionMethod: "inpainting" | "fill" | "ocr-mask" | "ocr-mask-enhanced" | "ocr-mask-subregion" | "local-background-feather";
}

/**
 * 整个文档页面的签名替换集合。
 */
export interface PageSignatureReplacements {
  pageIndex: number;
  replacements: SignatureReplacement[];
  /** 所有被抑制的 handwritten block ID 的快速查找集合 */
  suppressedBlockIds: Set<string>;
}
