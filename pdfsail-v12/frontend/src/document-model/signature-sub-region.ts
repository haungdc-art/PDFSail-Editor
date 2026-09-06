/**
 * Sprint 31 / 31.3: Signature Sub-Region Data Model
 *
 * 旧类型（Sprint 31，仍用于实际 mask 生成）：
 *   - editable-text:   保留
 *   - duplicate-text:  擦除（OCR mask → inpaint）
 *   - signature-line:  保护
 *   - background:      无需处理
 *
 * 新类型（Sprint 31.3，语义分类，当前仅 debug 输出）：
 *   - printed_text:   正常打印文字（保留）
 *   - stamp_text:      印章/重复文字（mask）
 *   - signature_text:  手写签名（保留）
 *   - signature_line:  签名横线（保留）
 *   - artifact:        噪声/伪影（mask）
 */
import type { BBox } from "./types";

// ── Sprint 31 旧类型（保留，维持现有 mask 链路） ──

export type SignatureSubRegionType =
  | "editable-text"
  | "duplicate-text"
  | "signature-line"
  | "background";

export interface SignatureSubRegion {
  /** 唯一标识 */
  id: string;
  /** 区域类型 */
  type: SignatureSubRegionType;
  /** CSS 显示坐标包围盒 */
  bbox: BBox;
  /** 所属 OCR block ID 列表 */
  sourceBlockIds: string[];
  /** 区域文本内容（用于 debug） */
  text?: string;
  /** 检测置信度 */
  confidence: number;
}

/** 区域分割调试输出 */
export interface SignatureRegionSegmentDebug {
  region: string;
  segments: SignatureSubRegion[];
  summary: {
    editableText: number;
    duplicateText: number;
    signatureLine: number;
    background: number;
  };
  protectedBboxes: BBox[];
  maskBboxes: BBox[];
}

// ── Sprint 31.3 新语义分类（当前仅 debug 输出） ──

/** 签名区域语义分段类型 */
export type SignatureSegmentType =
  | "printed_text"
  | "stamp_text"
  | "signature_text"
  | "signature_line"
  | "artifact";

/** 单个语义分段的分类结果 */
export interface SegmentClassification {
  /** 唯一标识 */
  id: string;
  /** 语义类型 */
  type: SignatureSegmentType;
  /** 分类置信度 (0-1) */
  confidence: number;
  /** CSS 坐标包围盒 */
  bbox: BBox;
  /** 对应 block ID */
  sourceBlockIds: string[];
  /** 文本内容 */
  text?: string;
  /** 最终动作 */
  action: "keep" | "mask";
  /** 分类依据 */
  reasons: string[];
}

/** Sprint 31.3 分类调试输出 */
export interface SignatureClassificationDebug {
  region: string;
  compositeBbox: BBox;
  rotation: { angle: number; confidence: number };
  segments: SegmentClassification[];
  summary: {
    printed_text: number;
    stamp_text: number;
    signature_text: number;
    signature_line: number;
    artifact: number;
    keepCount: number;
    maskCount: number;
  };
}
