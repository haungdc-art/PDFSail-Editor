/**
 * editor/core/render/index.ts — EDITOR-CORE-010-B 统一出口
 *
 * 规范 §27：调用方从这里取 Render Frame API，
 * 不要直接 import render/*.ts 内部文件。
 */

export type {
  BuildRenderFrameOptions,
  EditorGlyphBox,
  EditorRenderFrame,
} from "./types";

export {
  FRAME_WARNING_CARET_TEXT_BOX_MISMATCH,
  FRAME_WARNING_GLYPH_TEXT_MISMATCH,
  FRAME_WARNING_MISSING_PARAGRAPH,
  FRAME_WARNING_MISSING_RUN,
  FRAME_WARNING_MISSING_TEXT_BOX,
  FRAME_WARNING_STALE_LAYOUT,
} from "./types";

export { buildRenderFrame, renderFrameFromLiveReflow } from "./frame";
