/**
 * page-builder.ts — DOM Page Builder（Sprint-120 · Phase 2 · Task-1）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 *
 * Phase 2 核心架构转换：
 *   Builder 内部以 **Page 为唯一生产模型**，EditablePage 降级为兼容适配层。
 *
 *   Builder
 *       │
 *       ▼
 *   Page（唯一事实来源）
 *       │
 *       ├────────► EditablePage（兼容适配，非事实来源）
 *       │
 *       └────────► Scene（未来 Phase 3）
 *
 * 这不是 `EditableDocument → Mapper → Page`，而是 Builder 直接 `createPage()`。
 *
 * 边界（PM 批准）：
 *   - Builder 只负责：PdfFallback exists / ContentLayer 可编辑对象
 *   - Builder 不负责：bitmap（属于 Runtime Resource，Runtime.attachBitmap() 注入）
 *   - Builder 不 fake：Annotation / Decoration / Form 无数据 → 只建 Schema 容器，不建默认对象
 *   - 不引入 bitmap / canvas / ImageBitmap / pdf.js 对象
 *
 * 纯函数（ADR-005），Node 可测。
 */

import { DomPage, DEFAULT_RUNTIME, DomPageMetadata, InteractionObject, OverlayObject } from "./page";
import { DomObject } from "./object";
import { makePdfFallback, mapBlockToDomObject, BlockLike } from "./block-mapper";

/** Page Builder 输入：现有构建产物 + 页面元信息 */
export interface PageBuildInput {
  /** 页面元信息 */
  readonly metadata: DomPageMetadata;
  /** 可编辑 block 列表（来自现有 PDF Adapter / OCR Adapter 提取） */
  readonly blocks: readonly BlockLike[];
  /** 可编辑性 override（可选；默认由 block.regionType 推断） */
  readonly editableOverride?: ReadonlyMap<string, boolean>;
}

/** 空 Interaction/Overlay 层 */
const EMPTY_INTERACTION: readonly InteractionObject[] = [];
const EMPTY_OVERLAY: readonly OverlayObject[] = [];

/**
 * 构建一个 DOM Page（Builder 内部唯一生产模型）。
 *
 * - BaseLayer：恒含一个结构化 PdfFallbackObject（无 bitmap，bitmap 由 Runtime 注入）
 * - ContentLayer：可编辑 block 映射为 DomObject；不可编辑（stamp）归 BaseLayer
 * - Interaction/Overlay：默认空容器
 * - Runtime：默认 { dirty:false, visible:true }
 *
 * @param input 构建输入
 * @returns DomPage（保证五层容器存在，符合 Phase 1 Schema Validator）
 */
export function createPage(input: PageBuildInput): DomPage {
  const { metadata, blocks, editableOverride } = input;
  const contentObjects: DomObject[] = [];
  const baseObjects: DomObject[] = [];

  for (const block of blocks) {
    const obj = mapBlockToDomObject(block, metadata);
    // editable override（若提供）优先于 block 推断
    const editable = editableOverride?.get(block.id) ?? obj.editable;
    const finalObj: DomObject = editable === obj.editable ? obj : { ...obj, editable };
    if (finalObj.editable) {
      contentObjects.push(finalObj);
    } else {
      baseObjects.push(finalObj);
    }
  }

  // BaseLayer 恒含 PdfFallback（页面光栅基座）；stamp 等不可编辑对象也在此
  const baseLayer: readonly DomObject[] = [makePdfFallback(metadata.index, metadata.width, metadata.height), ...baseObjects];

  return {
    metadata,
    layers: {
      base: baseLayer,
      content: contentObjects,
      interaction: EMPTY_INTERACTION,
      overlay: EMPTY_OVERLAY,
    },
    runtime: { ...DEFAULT_RUNTIME },
  };
}
