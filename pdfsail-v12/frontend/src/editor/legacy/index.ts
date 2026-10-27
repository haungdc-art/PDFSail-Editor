/**
 * editor/legacy/index.ts — EDITOR-CORE-005 统一出口
 *
 * 单向依赖（§57）：
 *
 *     legacy / PDF Core  →  editor/legacy（本目录）  →  editor/core
 *
 * editor/core 下任何文件都不得 import 本目录或本目录内出现的 legacy 类型。
 * 本目录是「允许认识 legacy」的唯一受控边界（§58）。
 */

export type {
  ImportBoxDraft,
  ImportImageDraft,
  ImportOptions,
  ImportPageDraft,
  ImportParagraphDraft,
  ImportResult,
  ImportRunDraft,
  LayoutGranularity,
  Rect,
  StyleInput,
} from "./common";

export {
  DEFAULT_PAGE_HEIGHT,
  DEFAULT_PAGE_WIDTH,
  ingestImageDataUrl,
  materializeImport,
  normalizeColor,
  normalizeFontStyle,
  normalizeFontWeight,
  splitParagraphs,
  toSourceKind,
  toTextStyle,
  unionRect,
} from "./common";

export { segmentsToEditorDocument } from "./segment-adapter";
export { blocksToEditorDocument } from "./blocks-adapter";
export { semanticDocumentToEditorDocument } from "./semantic-adapter";
export { ocrBlocksToEditorDocument, type OcrImportOptions } from "./ocr-adapter";
export { editableDocumentToEditorDocument } from "./editable-document-adapter";
export { VISUAL_LINE_WIDTH_SLACK } from "./editable-document-adapter";
export {
  lineGroupsToEditorDocument,
  pdfColorToCss,
  type LineGroupImportOptions,
  type PdfToCanvasMapper,
} from "./line-group-adapter";
