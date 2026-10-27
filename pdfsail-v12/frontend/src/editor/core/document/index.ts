/**
 * editor/core/document/index.ts — EDITOR-CORE-001 统一出口
 *
 * 规范 §58：新代码只能依赖显式批准的稳定 API。
 * Editor Core 的文档模型一律从这里导入，不要直接 import 内部文件。
 */

export type {
  EditorDocument,
  EditorObject,
  EditorPage,
  FontStyle,
  ImageAsset,
  ImageAssetRef,
  ImageObject,
  Paragraph,
  ParagraphAlignment,
  TextBoxObject,
  TextRun,
  TextStyle,
  TextSourceBinding,
  TextSourceKind,
} from "./types";

export {
  DEFAULT_COLOR,
  DEFAULT_FONT_FAMILY,
  DEFAULT_FONT_SIZE,
  DEFAULT_FONT_STYLE,
  DEFAULT_FONT_WEIGHT,
  DEFAULT_LINE_HEIGHT_RATIO,
  bumpVersion,
  cloneEditorDocument,
  createEditorDocument,
  createEditorPage,
  createImageObject,
  createParagraph,
  createTextBox,
  createTextRun,
  createTextStyle,
  nextId,
  resetIdSequence,
  type CreateEditorDocumentInit,
  type CreateEditorPageInit,
  type CreateImageObjectInit,
  type CreateParagraphOptions,
  type CreateTextBoxInit,
} from "./factory";

export {
  allTextBoxes,
  countRuns,
  findPage,
  findPageByIndex,
  findParagraph,
  findRun,
  findTextBox,
  findTextBoxPage,
  getParagraphLength,
  getParagraphText,
  getTextBoxText,
  pointInTextBox,
} from "./query";

export {
  EditorDocumentParseError,
  deserializeEditorDocument,
  isValidEditorDocument,
  serializeEditorDocument,
  summarizeEditorDocument,
} from "./serialize";
