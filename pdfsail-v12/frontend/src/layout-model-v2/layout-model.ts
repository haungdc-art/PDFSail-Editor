/**
 * layout-model-v2.ts — Layout Model（Rendering Preparation，Layer 3）
 *
 * Sprint-63 Task-001：Semantic Layout Engine
 *
 * 分层（四层架构）：
 *   Layer 1 Source → Layer 2 Semantic → Layer 3 Layout → Layer 4 Renderer
 *
 * Layout 属于 Rendering Preparation，独立于 Semantic（Run）。
 * Layout 用 runId / glyphId 引用 Semantic，**不复制业务数据**（text/style/...）。
 *
 * ADR-006：Semantic Layer Never Owns Layout。
 *   Run 永远不知道自己的位置。Layout 引用 Semantic，单向。
 *
 * 层级：
 *   LayoutDocument
 *     └─ LayoutPage
 *          └─ LayoutParagraph
 *               └─ LayoutLine
 *                    └─ LayoutRun
 *                         └─ LayoutGlyph（Position only）
 */

import type { BBox } from "../document-model/types";

/** Layout schema 版本 */
export const LAYOUT_SCHEMA_VERSION = 1;

/** 布局文档（Immutable） */
export interface LayoutDocument {
  schemaVersion: number;
  id: string;
  /** 对应的语义文档 id */
  semanticDocumentId: string;
  pages: ReadonlyArray<LayoutPage>;
}

/** 布局页面 */
export interface LayoutPage {
  index: number;
  paragraphs: ReadonlyArray<LayoutParagraph>;
}

/** 布局段落 */
export interface LayoutParagraph {
  id: string;
  lines: ReadonlyArray<LayoutLine>;
}

/** 布局行 */
export interface LayoutLine {
  id: string;
  runs: ReadonlyArray<LayoutRun>;
}

/**
 * LayoutRun — 可渲染的 Run。
 * 通过 runId 引用 Semantic Run，不复制业务数据。
 */
export interface LayoutRun {
  id: string;
  /** 引用语义 Run id */
  runId: string;
  glyphs: ReadonlyArray<LayoutGlyph>;
  /** baseline（相对行顶的 Y 偏移） */
  baseline: number;
  /** 原点（左上角，页面 CSS 坐标） */
  origin: { x: number; y: number };
  /** 整段边界 */
  bounds: BBox;
}

/**
 * LayoutGlyph — 仅 Position。
 * 没有 Text / Style / Semantic。只有坐标。
 */
export interface LayoutGlyph {
  id: string;
  /** 引用语义 glyph id（若存在）或字符索引 */
  glyphId: string;
  /** 字符左上角 x（页面 CSS 坐标） */
  x: number;
  /** 字符左上角 y（页面 CSS 坐标） */
  y: number;
  /** 推进宽度 */
  advance: number;
  /** baseline（绝对 Y，页面 CSS 坐标） */
  baseline: number;
}
