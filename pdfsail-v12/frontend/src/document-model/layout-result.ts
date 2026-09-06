/**
 * LayoutResult — Layout Engine 的纯计算结果（Layout Layer）
 *
 * Sprint36 · TD-003（LayoutResult）· Commit 3A：仅定义 Contract（接口），不实现。
 *
 * ADR-003 约束（冻结）：
 *   - 全部 readonly（纯计算结果，不可变）。
 *   - 全部用 blockId 关联，不引用 EditableBlock。
 *   - 不含任何业务字段（regionType / layoutMode 等）。
 *   - 保存 Layout Geometry：paragraph bbox / line bbox / glyph bbox。
 *   - 与 Geometry（Facts）分离：OCR/PDF bbox 属于 EditableDocument，此处只放 Layout 计算结果。
 */

import type { TransformMatrix } from "./types";

/** 轴对齐矩形（CSS 坐标） */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 单个 glyph 的排版结果 */
export interface LayoutGlyphResult {
  /** 该 glyph 的排版后包围盒（Layout Geometry） */
  readonly bbox: Rect;
  /** 旋转/倾斜变换矩阵 [a,b,c,d,e,f]（排版后，非 OCR/PDF 原始 transform） */
  readonly transform?: TransformMatrix;
}

/** 单行排版结果 */
export interface LayoutLineResult {
  /** 关联 EditableLine id（供 FactsSnapshot 关联） */
  readonly lineId: string;
  /** 行包围盒（Layout Geometry） */
  readonly bbox: Rect;
  /** 该行 glyph 排版结果 */
  readonly glyphs: ReadonlyArray<LayoutGlyphResult>;
}

/** 单个 block 的排版结果 */
export interface LayoutBlockResult {
  /** 关联 EditableBlock 的 id（唯一关联，不引用 block 对象） */
  readonly blockId: string;
  /** 段落包围盒（Layout Geometry） */
  readonly paragraphBounds: Rect;
  /** 行排版结果 */
  readonly lines: ReadonlyArray<LayoutLineResult>;
}

/** 单页排版结果 */
export interface LayoutPageResult {
  /** 关联 EditablePage 的 id */
  readonly pageId: string;
  /** 页内 block 排版结果 */
  readonly blocks: ReadonlyArray<LayoutBlockResult>;
}

/** 文档级排版结果（Layout Engine 的输出，只读） */
export interface LayoutResult {
  readonly pages: ReadonlyArray<LayoutPageResult>;
}
