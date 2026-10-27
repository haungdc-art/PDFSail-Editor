/**
 * editor/core/layout/index.ts — EDITOR-CORE-006-B 统一出口
 *
 * 规范 §27 / §58：调用方从这里取 Layout API，不直接 import layout/*.ts 内部文件。
 */

export type {
  AdvanceSource,
  CaretGeometry,
  GlyphLayout,
  LayoutOptions,
  LayoutResult,
  LineLayout,
  ParagraphLayout,
  Point,
  Rect,
  ResolvedScale,
  RunLayout,
  SelectionGeometry,
  TextLayout,
} from "./types";
export { ADVANCE_SOURCE_ORDER, DEFAULT_LAYOUT_OPTIONS } from "./types";

export type {
  FontMetricsProviderOptions,
  GlyphMetrics,
  GlyphMetricsQuery,
  MetricsFn,
} from "./metrics";
export { FontMetricsProvider, createFontMetricsProvider } from "./metrics";

export type { BreakLine, BreakOptions, BreakResult, ParagraphStyleResolver } from "./breaker";
export {
  LineBreaker,
  NO_LINE_END_CHARS,
  NO_LINE_START_CHARS,
  createLineBreaker,
  isCJKIdeograph,
  isCJKPunctuation,
  splitByHardBreak,
} from "./breaker";

export type { LayoutErrorCode, LayoutTextBoxRequest } from "./reflow";
export {
  LayoutError,
  caretGeometryAt,
  layoutDocument,
  layoutTextBox,
  selectionGeometryFor,
} from "./reflow";

// EDITOR-CORE-009：唯一编排函数（Input → Command → History → afterDocument → Layout → 几何）
export type {
  CaretResolution,
  CaretTarget,
  LiveReflowContext,
  LiveReflowResult,
} from "./live-reflow";
export { isLiveReflowCommitted, resolveCaretTarget, runLiveReflow } from "./live-reflow";
