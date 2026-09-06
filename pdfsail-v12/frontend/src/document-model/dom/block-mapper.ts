/**
 * block-mapper.ts — EditableBlock → DomObject 映射纯函数（Sprint-120 · Phase 2 · Task-1）
 *
 * 从 editable-document-mapper.ts 提取的复用逻辑。
 * Builder（page-builder.ts）和 Mapper（editable-document-mapper.ts）共用，
 * 保证"Block → Object"映射单一事实来源。
 *
 * 映射规则（PM 批准）：
 *   - text → Glyph / Signature / Decoration（stamp）
 *   - image → Image
 *   - table → Table
 *   - editable 由 regionType 决定（stamp 恒不可编辑）
 *   - anchor 由 bbox + 页面尺寸推断（位置与可编辑性解耦）
 *
 * 本文件是 Document Object Model（DOM）的一部分，**不 import EditableDocument**。
 * 纯函数（ADR-005），Node 可测。
 */

import { DomObject, DomObjectType, isNonEditableType } from "./object";
import { inferAnchorFromBBox, Anchor } from "./anchor";

/** Block 映射所需的最小输入（结构与 EditableBlock 兼容，但不依赖它） */
export interface BlockLike {
  id: string;
  type: string;
  regionType?: string;
  bbox: { x: number; y: number; width: number; height: number };
}

/** 根据 BlockLike 推断 DOM 对象类型 */
export function inferDomType(block: BlockLike): DomObjectType {
  switch (block.type) {
    case "image":
      return "Image";
    case "table":
      return "Table";
    case "text":
      switch (block.regionType) {
        case "signature":
          return "Signature";
        case "stamp":
          return "Decoration"; // 印章是不可编辑装饰
        case "footer":
          return "Glyph"; // 可编辑页脚文本 → Glyph（editable 由调用方决定）
        default:
          return "Glyph";
      }
    default:
      return "Unknown";
  }
}

/** 根据 BlockLike 推断 editable */
export function inferEditable(block: BlockLike): boolean {
  // stamp（印章）恒不可编辑
  if (block.type === "text" && block.regionType === "stamp") return false;
  return true;
}

/** 根据 bbox + 页面尺寸推断 anchor（位置，与可编辑性解耦） */
export function inferAnchor(
  bbox: { x: number; y: number; width: number; height: number },
  page: { width: number; height: number },
): Anchor {
  return inferAnchorFromBBox(bbox, page);
}

/** 生成页面光栅底图（BaseLayer PdfFallback），仅结构，不含 bitmap */
export function makePdfFallback(pageIndex: number, width: number, height: number): DomObject {
  return {
    id: `pdf-fallback-page-${pageIndex}`,
    type: "PdfFallback",
    editable: false,
    anchor: "NONE", // 铺满全页，无特定位置锚点
    bbox: { x: 0, y: 0, width, height },
    pageIndex,
    runtimeRef: `page-${pageIndex}-raster`, // 仅标识，bitmap 由 Runtime.attachBitmap() 注入
  };
}

/** 将单个 BlockLike 映射为 DomObject（editable 决定归 ContentLayer 或 BaseLayer） */
export function mapBlockToDomObject(block: BlockLike, page: { width: number; height: number }): DomObject {
  const type = inferDomType(block);
  const editable = inferEditable(block);
  // 非可编辑类型（Decoration/PdfFallback/Paper）恒 editable=false
  const finalEditable = isNonEditableType(type) ? false : editable;
  return {
    id: `obj-${block.id}`,
    type,
    editable: finalEditable,
    anchor: inferAnchor(block.bbox, page),
    bbox: { ...block.bbox },
    sourceId: block.id, // 引用原始 block，供兼容适配找回数据
  };
}
