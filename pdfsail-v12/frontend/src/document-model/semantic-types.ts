/**
 * SemanticObject — Sprint 8 Task 1
 *
 * 在 EditableDocument 上增加语义层，让 AI 可以理解和操作文档。
 *
 * 层级结构（Sprint 8 新增）：
 *   EditableDocument
 *     └─ EditablePage
 *          └─ EditableBlock
 *               └─ EditableLine
 *                    └─ EditableGlyph
 *
 *   SemanticDocument（新增）
 *     └─ SemanticObject[]（语义字段）
 *          ├─ TextField
 *          ├─ DateField
 *          ├─ NameField
 *          ├─ AddressField
 *          ├─ SignatureField
 *          └─ TableField
 *
 * SemanticObject 通过 sourceGlyphs 关联到 EditableGlyph，
 * AI Agent 通过 SemanticObject 操作文档（如「把日期改成 2027」）。
 *
 * 坐标系：CSS 显示坐标（与 EditableDocument 一致）
 */

import type { BBox } from "./types";

/** 语义对象类型 */
export type SemanticObjectType =
  | "textField"
  | "dateField"
  | "nameField"
  | "addressField"
  | "signatureField"
  | "tableField";

/** 语义来源标记 */
export type SemanticSource = "pattern" | "layout" | "keyword" | "position" | "ai_inferred" | "llm";

/** Glyph 引用（指向 EditableDocument 中的 glyph） */
export interface GlyphRef {
  /** 所属 block ID */
  blockId: string;
  /** 所属行 ID */
  lineId: string;
  /** glyph 在行内的索引 */
  glyphIndex: number;
  /** glyph 的字符内容（冗余存储，便于快速访问） */
  char: string;
}

/**
 * SemanticObject — 语义字段基类
 *
 * 所有语义字段共享的基础结构。
 */
export interface SemanticObject {
  /** 唯一 ID */
  id: string;
  /** 语义类型 */
  type: SemanticObjectType;
  /** 字段值（当前值，可能被 AI 修改） */
  value: string;
  /** 原始值（用于差异检测和回退） */
  originalValue?: string;
  /** 字段标签（如 "Patient Name"、"Appointment Date"） */
  label?: string;
  /** 关联的 source blocks（EditableDocument 中的 block ID 列表） */
  sourceBlocks: string[];
  /** 关联的 source glyphs（精确到字符级） */
  sourceGlyphs: GlyphRef[];
  /** 字段 bbox（CSS 显示坐标，涵盖所有 source glyphs） */
  bbox: BBox;
  /** 置信度（0-1，Semantic Analyzer 的识别置信度） */
  confidence: number;
  /** 识别来源（pattern/layout/keyword/position/ai_inferred/llm） */
  detectedBy: SemanticSource;
  /** 页码 */
  page: number;
  /** 是否被修改过 */
  modified: boolean;
  /** Sprint 9 Task 3: 证据 glyph ID 列表（支持此语义判断的 glyph） */
  evidenceGlyphs?: GlyphRef[];
  /** Sprint 9 Task 3: 推理原因（LLM 给出的判断依据） */
  reason?: string;
}

/** 日期字段 */
export interface DateFieldObject extends SemanticObject {
  type: "dateField";
  /** 解析后的日期（ISO 格式，如 "2026-03-04"） */
  parsedDate?: string;
  /** 日期格式（如 "DD/MM/YYYY"、"MM/DD/YYYY"） */
  format?: string;
}

/** 姓名字段 */
export interface NameFieldObject extends SemanticObject {
  type: "nameField";
  /** 姓名类型（patient/doctor/signer/recipient） */
  nameRole?: "patient" | "doctor" | "signer" | "recipient" | "unknown";
}

/** 地址字段 */
export interface AddressFieldObject extends SemanticObject {
  type: "addressField";
  /** 地址组成部分 */
  components?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    country?: string;
  };
}

/** 签名字段 */
export interface SignatureFieldObject extends SemanticObject {
  type: "signatureField";
  /** 签名类型（handwritten/digital/stamp） */
  signatureType?: "handwritten" | "digital" | "stamp";
  /** 是否已签名 */
  isSigned: boolean;
}

/** 表格字段 */
export interface TableFieldObject extends SemanticObject {
  type: "tableField";
  /** 表格行 × 列 */
  rows: number;
  cols: number;
  /** 单元格值（rows × cols 二维数组） */
  cells: string[][];
}

/** 文本字段（通用） */
export interface TextFieldObject extends SemanticObject {
  type: "textField";
  /** 文本类型（paragraph/heading/label/value） */
  textRole?: "paragraph" | "heading" | "label" | "value";
}

/** SemanticObject 联合类型 */
export type AnySemanticObject =
  | TextFieldObject
  | DateFieldObject
  | NameFieldObject
  | AddressFieldObject
  | SignatureFieldObject
  | TableFieldObject;

/**
 * SemanticDocument — 语义文档
 *
 * EditableDocument + SemanticObject[] 的组合。
 * SemanticObject 通过 sourceGlyphs 引用 EditableDocument 中的 glyph。
 */
export interface SemanticDocument {
  /** 关联的 EditableDocument */
  document: import("./types").EditableDocument;
  /** 识别出的语义对象列表 */
  objects: AnySemanticObject[];
  /** 分析元数据 */
  metadata: {
    /** 分析时间戳 */
    analyzedAt: number;
    /** 识别的对象数量 */
    objectCount: number;
    /** 按类型分组统计 */
    typeCounts: Record<SemanticObjectType, number>;
  };
}

/** 类型守卫 */
export function isDateField(obj: AnySemanticObject): obj is DateFieldObject {
  return obj.type === "dateField";
}

export function isNameField(obj: AnySemanticObject): obj is NameFieldObject {
  return obj.type === "nameField";
}

export function isAddressField(obj: AnySemanticObject): obj is AddressFieldObject {
  return obj.type === "addressField";
}

export function isSignatureField(obj: AnySemanticObject): obj is SignatureFieldObject {
  return obj.type === "signatureField";
}

export function isTableField(obj: AnySemanticObject): obj is TableFieldObject {
  return obj.type === "tableField";
}

export function isTextField(obj: AnySemanticObject): obj is TextFieldObject {
  return obj.type === "textField";
}
