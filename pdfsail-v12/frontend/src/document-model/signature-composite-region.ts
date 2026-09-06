/**
 * SignatureCompositeRegion — Sprint 20
 *
 * 复合签名区域理解模型。
 *
 * 解决的问题：
 *   Sprint 19 将多个 OCR block 误判为多个独立区域，
 *   但实际上它们属于同一个物理签名复合体。
 *
 * 例如：
 *   Block 5: "Dr. Jefferson Aguiar Maciel"      (printed)
 *   Block 6: "Médico"                            (printed)
 *   Block 7: "CRM-SP 269473"                    (printed)
 *   Block 9: "JEFERSON AGUIAR MACIEL"           (handwritten, duplicate of Block 5)
 *   Block 10: "CRM:269473 - CNS..."             (handwritten, duplicate of Block 7)
 *   Block 11: "MEDICO CLÍNICO"                  (handwritten, duplicate of Block 6)
 *
 *   → 1 个 SignatureCompositeRegion（不是 3+ 个独立区域）
 *
 * 渲染顺序: Image (z=0) → BackgroundPatch (z=1) → EditableGlyph (z=2)
 */

import type { BBox, EditableBlock } from "./types";

/**
 * 单个复合签名区域。
 */
export interface SignatureCompositeRegion {
  /** 唯一标识 */
  id: string;

  /** 区域包围盒（CSS 显示坐标，覆盖所有 source blocks） */
  bbox: BBox;

  /**
   * 所有属于该签名区域的 OCR block ID 列表。
   * 包括 printed（可编辑）和 handwritten（重复/被抑制）的所有 block。
   */
  sourceBlockIds: string[];

  /** 区域内的所有原始 block 引用 */
  sourceBlocks: EditableBlock[];

  /**
   * 可编辑/可见的 block ID 列表（printed blocks）。
   * 这些 block 的 glyph 渲染在背景补丁之上，保持可见和可编辑。
   */
  editableBlockIds: string[];

  /**
   * 被替换的重复 OCR block ID 列表（handwritten blocks）。
   * 这些 block 与 editable blocks 语义重复（如手写 OCR 的 "JEFERSON AGUIAR MACIEL"
   * 与打印的 "Dr. Jefferson Aguiar Maciel"），不应渲染。
   * glyph 生成被抑制，原图被背景补丁覆盖。
   *
   * P0-006：此字段不再用于"删除/隐藏 OCR block"。
   * 所有 sourceBlockIds 的 block 都保留在 Document 中；此字段仅保留历史信息。
   */
  duplicateBlockIds: string[];

  /**
   * P0-006（Signature Policy V2）：默认可编辑 block。
   * Policy 只决定"默认编辑哪个 block"，不决定任何 OCR block 是否存在。
   * 所有 blockIds 的 block 都存在、可点中、可编辑。
   */
  defaultEditableBlockId: string;

  /** 检测到的基线旋转 */
  rotation: {
    /** 旋转角度（度，顺时针为正） */
    angle: number;
    /** 旋转检测置信度（0-1） */
    confidence: number;
  };

  /** 签名区域检测总体置信度（0-1） */
  confidence: number;

  /** 区域模式 */
  mode: "printed" | "handwritten" | "mixed";
}

/**
 * 复合签名区域检测结果。
 */
export interface CompositeRegionResult {
  regions: SignatureCompositeRegion[];
  /**
   * 所有需要抑制 glyph 渲染的 block ID 集合。
   * = 所有 duplicateBlockIds 的并集。
   */
  suppressedGlyphBlockIds: Set<string>;
  /** debug 信息 */
  debug: CompositeRegionDebug;
}

/**
 * 复合签名区域调试信息。
 */
export interface CompositeRegionDebug {
  candidateBlockCount: number;
  clusterCount: number;
  regionCount: number;
  regions: Array<{
    bbox: { x: number; y: number; width: number; height: number };
    mode: string;
    sourceBlocks: string[];
    editable: string[];
    duplicate: string[];
    editableTexts: string[];
    duplicateTexts: string[];
    rotation: { angle: number; confidence: number };
    confidence: number;
    similarityPairs: Array<{
      blockIdA: string;
      blockIdB: string;
      textA: string;
      textB: string;
      similarity: number;
    }>;
  }>;
}
