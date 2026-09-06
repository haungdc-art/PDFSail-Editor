/**
 * object.ts — DOM Object 类型（Sprint-120 · Phase 1）
 *
 * ADR-045 统一 Object 结构：
 *   Object { type, editable, anchor, bbox }
 *
 * - `editable` 决定归属：true → ContentLayer；false → BaseLayer
 * - `anchor` 只描述位置（TOP/BOTTOM/LEFT/RIGHT 或 region），与可编辑性解耦
 * - `type` 是对象类型（Glyph/Image/Table/Signature/Form/Annotation/Decoration/PdfFallback/...）
 *
 * 本文件是 Document Object Model（DOM）的一部分，**不 import EditableDocument**。
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

import { Anchor } from "./anchor";

/** 几何 bbox（CSS 坐标） */
export interface DomBBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** DOM 对象类型（工程语言，不是业务术语） */
export type DomObjectType =
  | "Glyph"           // 文本 glyph
  | "Image"           // 内嵌图片
  | "Table"           // 表格结构
  | "Signature"       // 签名
  | "Form"            // 表单
  | "Annotation"      // 标注
  | "Decoration"      // 页眉/页脚/logo/装饰（不可编辑）
  | "PdfFallback"     // 页面光栅底图/背景（不可编辑）
  | "Paper"           // 纸纹/页面底色（不可编辑）
  | "Unknown";

/** DomObjectType 全集 */
export const DOM_OBJECT_TYPE_VALUES: readonly DomObjectType[] = [
  "Glyph", "Image", "Table", "Signature", "Form", "Annotation",
  "Decoration", "PdfFallback", "Paper", "Unknown",
];

/** 是否为合法 DomObjectType */
export function isDomObjectType(v: unknown): v is DomObjectType {
  return typeof v === "string" && (DOM_OBJECT_TYPE_VALUES as readonly string[]).includes(v);
}

/** DOM 对象（Builder 输出；editable 决定 Layer 归属） */
export interface DomObject {
  readonly id: string;
  readonly type: DomObjectType;
  /** true → ContentLayer；false → BaseLayer */
  readonly editable: boolean;
  /** 位置锚点（与可编辑性解耦） */
  readonly anchor: Anchor;
  /** 几何 */
  readonly bbox: DomBBox;
  /**
   * 所属页（1-based，可选）。
   * PdfFallback 等页级对象用它标识归属页。
   */
  readonly pageIndex?: number;
  /**
   * 运行期资源引用（可选，仅标识，不含实际资源）。
   * Builder 只声明 `runtimeRef`（如 "page-1-raster"），
   * 不持有 bitmap/canvas/ImageBitmap —— 那属于 Runtime Resource，
   * 由 Runtime.attachBitmap() 在运行期注入。
   */
  readonly runtimeRef?: string;
  /**
   * 源数据引用（可选）：指向原始 Block / 数据源 id。
   * 用于兼容适配（Page → EditablePage）时找回原始 glyph/line 数据。
   */
  readonly sourceId?: string;
}

/** 内置的不可编辑类型（editable 恒 false，归 BaseLayer） */
export const NON_EDITABLE_TYPES: readonly DomObjectType[] = [
  "Decoration", "PdfFallback", "Paper",
];

/** 判断某类型是否恒不可编辑 */
export function isNonEditableType(type: DomObjectType): boolean {
  return (NON_EDITABLE_TYPES as readonly string[]).includes(type);
}

/** 根据 type 推导默认 editable（可被显式覆盖，但 Decoration/PdfFallback/Paper 恒 false） */
export function defaultEditableForType(type: DomObjectType): boolean {
  return !isNonEditableType(type);
}
