/**
 * dom-validator.ts — DOM Validator（Sprint-120 · Phase 1）
 *
 * ADR-045 · Document Object Model (DOM) for AI Documents。
 *
 * 这是 **DOM Validator**，不是 Scene Validator，也不是 Document Validator。
 * 它只校验 DOM 自身的结构约束（Page → Layer → Object），
 * 独立于 Builder / Scene / Painter / Export 存在。以后所有 Builder 都可以跑这个 Validator。
 *
 * ## 三层约束（PM 定义，Sprint-120 修正）
 *
 * ### 第一层 · Schema Validation（Structural Invariant，每页恒成立）
 *   Page 一定有 BaseLayer / ContentLayer / InteractionLayer / OverlayLayer / Runtime 五层容器。
 *   这是 Document **Schema** —— Schema 永远存在，Data 可以为空。
 *   空白页 / 封底 / 隔页 / 扫描页（OCR 未出 Glyph）都是合法 Data。
 *
 * ### 第二层 · Content Validation（对象归属）
 *   - editable=false 不能进入 ContentLayer
 *   - editable=true 不能进入 BaseLayer
 *   - SearchHighlight 等 overlay 对象不能进入 ContentLayer
 *   - Object 的 type / anchor / editable 必须是合法值
 *
 * ### 第三层 · Business Validation（格式/场景特有，由调用方注入，不进 Schema Validator）
 *   - OCR Document：至少一个 Glyph
 *   - Editor Mode：Selection 不能为空
 *   - Print Mode：Overlay 必须为空
 *   - PDF Document：BaseLayer 必须含 PdfFallback（这是 **PDF Document Builder 的 Builder Contract**，
 *     不是 DOM Contract —— Word/CAD/PPT 的 BaseLayer 可能是 Background/VectorSheet/SlideBackground）
 *
 * 纯函数（ADR-005），Node 可测。
 */

import { DomPage } from "./page";
import { DomObject, isDomObjectType } from "./object";
import { isAnchor } from "./anchor";
import { canPlaceObjectInLayer } from "./layer";

export interface DomValidationIssue {
  readonly page: number;
  readonly code: string;
  readonly message: string;
}

export interface DomValidationResult {
  readonly pass: boolean;
  readonly issues: readonly DomValidationIssue[];
}

/** 空结果（pass） */
export const PASS_RESULT: DomValidationResult = { pass: true, issues: [] };

/** Business Validation 规则：接收单页 DOM，返回该页的 business 问题（可为空） */
export type BusinessRule = (page: DomPage) => DomValidationIssue[];

/** 注入 Business 规则的校验入口（不注入则只跑 Schema + Content） */
export interface DomValidationOptions {
  readonly businessRules?: readonly BusinessRule[];
}

// ────────────────────────────────────────────────
// 第一层 · Schema Validation（Structural Invariant）
// ────────────────────────────────────────────────

/** 五层容器必须存在（Schema；Data 可为空） */
export function validateDomSchema(page: DomPage): DomValidationIssue[] {
  const issues: DomValidationIssue[] = [];
  const { metadata, layers } = page;

  if (!Array.isArray(layers.base)) {
    issues.push({ page: metadata.index, code: "NO_BASE_LAYER", message: `Page ${metadata.index} 必须存在 BaseLayer 容器（Schema）` });
  }
  if (!Array.isArray(layers.content)) {
    issues.push({ page: metadata.index, code: "NO_CONTENT_LAYER", message: `Page ${metadata.index} 必须存在 ContentLayer 容器（Schema）` });
  }
  if (!Array.isArray(layers.interaction)) {
    issues.push({ page: metadata.index, code: "NO_INTERACTION_LAYER", message: `Page ${metadata.index} 必须存在 InteractionLayer 容器（Schema）` });
  }
  if (!Array.isArray(layers.overlay)) {
    issues.push({ page: metadata.index, code: "NO_OVERLAY_LAYER", message: `Page ${metadata.index} 必须存在 OverlayLayer 容器（Schema）` });
  }
  if (!page.runtime) {
    issues.push({ page: metadata.index, code: "NO_RUNTIME", message: `Page ${metadata.index} 必须存在 Runtime（Schema）` });
  }
  return issues;
}

// ────────────────────────────────────────────────
// 第二层 · Content Validation（对象归属）
// ────────────────────────────────────────────────

/** 检查单个对象放入某层是否合法 */
function checkObjectPlacement(pageIndex: number, obj: DomObject, layer: "base" | "content", issues: DomValidationIssue[]): void {
  const kind = layer === "base" ? "BaseLayer" : "ContentLayer";
  if (!canPlaceObjectInLayer(obj, kind)) {
    issues.push({
      page: pageIndex,
      code: layer === "content" ? "NON_EDITABLE_IN_CONTENT" : "EDITABLE_IN_BASE",
      message: `Object ${obj.id} (editable=${obj.editable}) 不允许放入 ${kind}`,
    });
  }
}

/** 对象归属 + 字段合法值校验（Content Validation） */
export function validateDomContent(page: DomPage): DomValidationIssue[] {
  const issues: DomValidationIssue[] = [];
  const { metadata, layers } = page;

  for (const obj of layers.base) checkObjectPlacement(metadata.index, obj, "base", issues);
  for (const obj of layers.content) checkObjectPlacement(metadata.index, obj, "content", issues);

  for (const obj of [...layers.base, ...layers.content]) {
    if (!isDomObjectType(obj.type)) {
      issues.push({ page: metadata.index, code: "BAD_OBJECT_TYPE", message: `Object ${obj.id} type 非法: ${String(obj.type)}` });
    }
    if (!isAnchor(obj.anchor)) {
      issues.push({ page: metadata.index, code: "BAD_ANCHOR", message: `Object ${obj.id} anchor 非法: ${String(obj.anchor)}` });
    }
  }

  // Interaction/Overlay 不承载文档内容对象（类型层面已保证，此处仅防御）
  if (layers.interaction.some((o) => o.kind === "active-edit" && !o.bbox)) {
    issues.push({ page: metadata.index, code: "INTERACTION_BAD_BBOX", message: `Interaction active-edit 缺少 bbox` });
  }

  return issues;
}

// ────────────────────────────────────────────────
// 第三层 · Business Validation（调用方注入）
// ────────────────────────────────────────────────

/**
 * PDF 特有 Business Rule：BaseLayer 必须含 PdfFallback（页面光栅基座）。
 * 这是 **PDF Document Builder 的 Builder Contract**，不是 DOM Contract。
 * Word（Background）/ CAD（VectorSheet）/ PPT（SlideBackground）不需要此规则。
 */
export const pdfBaseLayerRule: BusinessRule = (page) => {
  if (!page.layers.base.some((o) => o.type === "PdfFallback")) {
    return [{ page: page.metadata.index, code: "PDF_NO_FALLBACK", message: `Page ${page.metadata.index} BaseLayer 必须含 PdfFallback（PDF Builder Contract）` }];
  }
  return [];
};

// ────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────

/**
 * 校验单个 Page：Schema + Content + 注入的 Business 规则。
 * @param page 单个页面
 * @param options 可选 businessRules（默认无）
 */
export function validateDomPage(page: DomPage, options?: DomValidationOptions): DomValidationIssue[] {
  return [
    ...validateDomSchema(page),
    ...validateDomContent(page),
    ...(options?.businessRules ?? []).flatMap((rule) => rule(page)),
  ];
}

/** 校验整个 DOM（DomPage[]），汇总所有 Page 的约束 */
export function validateDom(pages: readonly DomPage[], options?: DomValidationOptions): DomValidationResult {
  const issues: DomValidationIssue[] = [];
  for (const page of pages) {
    issues.push(...validateDomPage(page, options));
  }
  return issues.length === 0 ? PASS_RESULT : { pass: false, issues };
}
