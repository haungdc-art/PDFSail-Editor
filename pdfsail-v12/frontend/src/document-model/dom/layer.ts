/**
 * layer.ts — DOM Layer 类型（Sprint-120 · Phase 1）
 *
 * ADR-045：不按对象分类，按职责（Responsibility）分层。
 * Page 包含五层，任何新对象都能找到归属层，Layer 永不无限膨胀。
 *
 * 本文件是 Document Object Model（DOM）的一部分，**不 import EditableDocument**。
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

import { DomObject } from "./object";

/** Layer 职责类型 */
export type LayerKind =
  | "BaseLayer"         // 页面固有外观（光栅底图/背景/纸纹/装饰），不可编辑
  | "ContentLayer"      // 可编辑文档内容
  | "InteractionLayer"  // 编辑交互态（选区/光标/手柄/悬停），非文档内容
  | "OverlayLayer"      // 临时叠加（搜索/AI/审阅），非文档内容，不导出
  | "Runtime";          // 运行期状态（缓存/位图/dirty/可见性），非文档内容

/** LayerKind 全集 */
export const LAYER_KIND_VALUES: readonly LayerKind[] = [
  "BaseLayer", "ContentLayer", "InteractionLayer", "OverlayLayer", "Runtime",
];

/** 是否为合法 LayerKind */
export function isLayerKind(v: unknown): v is LayerKind {
  return typeof v === "string" && (LAYER_KIND_VALUES as readonly string[]).includes(v);
}

/** 该 Layer 是否可被 Edit 命令触达 */
export function isEditableLayer(kind: LayerKind): boolean {
  return kind === "ContentLayer";
}

/** 该 Layer 的内容是否参与导出 */
export function isExportedLayer(kind: LayerKind): boolean {
  return kind === "BaseLayer" || kind === "ContentLayer";
}

/** 根据对象 editable 推导其应归属的 Layer */
export function layerForEditable(editable: boolean): LayerKind {
  return editable ? "ContentLayer" : "BaseLayer";
}

/** 判断一个对象是否允许放进某个 Layer（结构约束：editable=false 不能进 ContentLayer） */
export function canPlaceObjectInLayer(obj: DomObject, kind: LayerKind): boolean {
  switch (kind) {
    case "ContentLayer":
      // ContentLayer 只允许可编辑对象
      return obj.editable === true;
    case "BaseLayer":
      // BaseLayer 只允许不可编辑对象
      return obj.editable === false;
    case "InteractionLayer":
    case "OverlayLayer":
    case "Runtime":
      // 交互/叠加/运行层不承载文档内容对象
      return false;
  }
}
