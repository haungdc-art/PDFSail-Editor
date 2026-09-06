/**
 * page.ts — DOM Page 类型（Sprint-120 · Phase 1）
 *
 * ADR-045：Document → Pages[] → Page（按职责分层）。
 *
 *   Page
 *     ├── BaseLayer          （页面固有外观：PdfFallback/Background/Paper/Decoration，不可编辑）
 *     ├── ContentLayer       （可编辑文档内容：Glyph/Image/Table/Signature/Form/Annotation）
 *     ├── InteractionLayer   （编辑交互态：Selection/Caret/Resize Handle/Hover/Active Edit）
 *     ├── OverlayLayer       （临时叠加：Search Highlight/AI Highlight/Diff/Review）
 *     └── Runtime            （运行期状态：cache/bitmap/dirty/visibility）
 *
 * 本文件是 Document Object Model（DOM）的一部分，**不 import EditableDocument**。
 * 纯类型 + 纯函数（ADR-005），Node 可测。
 */

import { LayerKind } from "./layer";
import { DomObject } from "./object";
import { DomBBox } from "./object";

/** 页级元数据 */
export interface DomPageMetadata {
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** 页面语义区域/方向（可选） */
  readonly region?: string;
}

/** InteractionLayer 内容（编辑交互态，非文档内容） */
export interface InteractionObject {
  readonly kind: "selection" | "caret" | "resize-handle" | "hover" | "active-edit";
  readonly bbox: DomBBox;
}

/** OverlayLayer 内容（临时叠加，非文档内容，不导出） */
export interface OverlayObject {
  readonly kind: "search-highlight" | "ai-highlight" | "diff" | "review";
  readonly bbox: DomBBox;
}

/** Runtime 状态（运行期，非文档内容） */
export interface DomRuntime {
  readonly dirty: boolean;
  readonly visible: boolean;
}

/** 空 Runtime 状态 */
export const DEFAULT_RUNTIME: DomRuntime = { dirty: false, visible: true };

/**
 * DOM Page —— 一个页面的完整对象模型。
 * Layer 是结构性的（每页五层），对象按职责归入对应层。
 */
export interface DomPage {
  readonly metadata: DomPageMetadata;
  readonly layers: {
    readonly base: readonly DomObject[];          // BaseLayer
    readonly content: readonly DomObject[];        // ContentLayer
    readonly interaction: readonly InteractionObject[]; // InteractionLayer
    readonly overlay: readonly OverlayObject[];    // OverlayLayer
  };
  readonly runtime: DomRuntime;
}

/**
 * 层结构是否满足最小约束（Schema Invariant）：
 *   - 必须存在 BaseLayer 和 ContentLayer 层容器（结构性，每页恒有）
 *   - 注意：ContentLayer 内容可为空（空白页合法），不要求每页内容 >=1
 *   - PdfFallback 是否存在于 BaseLayer 是 PDF Document Builder 的 Builder Contract，
 *     不是 DOM Schema（Word/CAD/PPT 的 BaseLayer 可能不同）。
 */
export function hasRequiredLayers(page: DomPage): boolean {
  return (
    Array.isArray(page.layers.base) &&
    Array.isArray(page.layers.content) &&
    Array.isArray(page.layers.interaction) &&
    Array.isArray(page.layers.overlay) &&
    !!page.runtime
  );
}
