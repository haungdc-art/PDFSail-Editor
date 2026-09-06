/**
 * types.ts — DOM 顶层类型 & 统一导出（Sprint-120 · Phase 1）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 * PDF / Word / PPT / Excel / Markdown / Image / CAD 共享同一套 Document → Pages → Layers → Objects。
 *
 * 本文件是 Document Object Model（DOM）的一部分，**不 import EditableDocument**。
 * DOM 是一套独立模型，不是 EditableDocument 的 Extension / Patch。
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

import type { DomPage } from "./page";

export {
  isAnchor, isRegion, inferAnchorFromBBox, ANCHOR_VALUES, REGION_VALUES,
} from "./anchor";
export type { Anchor, Region } from "./anchor";
export {
  isDomObjectType, isNonEditableType, defaultEditableForType,
  NON_EDITABLE_TYPES, DOM_OBJECT_TYPE_VALUES,
} from "./object";
export type { DomObject, DomObjectType, DomBBox } from "./object";
export {
  isLayerKind, isEditableLayer, isExportedLayer, layerForEditable, canPlaceObjectInLayer,
  LAYER_KIND_VALUES,
} from "./layer";
export type { LayerKind } from "./layer";
export {
  DEFAULT_RUNTIME, hasRequiredLayers,
} from "./page";
export type { DomPage, DomPageMetadata, InteractionObject, OverlayObject, DomRuntime } from "./page";

/** 顶层 DOM Document（统一文档对象模型） */
export interface DomDocument {
  readonly pages: readonly DomPage[];
}
