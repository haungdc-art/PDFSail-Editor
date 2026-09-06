/**
 * document-model — PDF Reconstruction Engine V1 统一文档模型
 *
 * Sprint 2 新增：
 *   - StyleResolver：文档级样式注册与去重
 *   - PDF Native Style Extractor：从 pdf.js 提取完整样式
 *   - OCR Style Resolver：4 级 fallback 推断 OCR 样式
 *
 * 架构位置：
 *
 *   GLM OCR ──→ OcrTextBlock ──┐
 *                              ├──→ EditableDocument ──→ TextBlock Adapter ──→ Editor
 *   pdf.js  ──→ RawGlyph ──────┘    (document-model/)
 *         ↓
 *   StyleResolver / PDF Style Extractor / OCR Style Resolver
 */

export type {
  EditableDocument,
  EditablePage,
  EditableBlock,
  EditableLine,
  EditableGlyph,
  EditableStyle,
  EditableTransform,
  BBox,
  TextSource,
  BlockType,
  LayoutMode,
  TransformMatrix,
  LayoutRegionType,
} from "./types";
export { IDENTITY_TRANSFORM, IDENTITY_EDITABLE_TRANSFORM } from "./types";

export { StyleResolver } from "./style-resolver";

export { CoordinateConverter, type CoordContext, type DocRect } from "./coordinate-converter";

export {
  measureCharWidth,
  measureTextWidth,
  measureCharWidths,
  breakTextIntoLines,
  breakTextIntoLinesByWords,
  clearMeasureCache,
} from "./text-measurement";

export {
  reconstructBlockLayout,
  reconstructBlocksLayout,
  reconstructDocumentLayout,
  layoutBlock,
  layoutBlocks,
  layoutDocument,
  computeAvailableLineWidth,
} from "./layout-engine";

export {
  preserveBlockLayout,
  preserveBlocksLayout,
} from "./preserve-layout-engine";

export {
  mapNewTextToOriginalGlyphs,
  replaceLineText,
  findAndReplaceInBlock,
  type GlyphMappingResult,
} from "./glyph-mapping";

export {
  extractPdfNativeStyle,
  extractStylesFromTextContent,
} from "./pdf-style-extractor";

export {
  resolveOcrBlockStyle,
  computePageStyleStats,
  type OcrStyleContext,
  type PageStyleStats,
} from "./ocr-style-resolver";

export {
  ocrBlocksToEditablePage,
  ocrBlocksToEditableDocument,
} from "./ocr-adapter";

// Story-7：OCR 类型唯一入口（Single Consumer Entry）。
// Document Model 内新代码从 document-model 获得 OcrTextBlock，而非直接 "../ocr/ocr-storage"。
export type { OcrTextBlock } from "./ocr-adapter";

// Sprint 4: Region Classifier
export {
  classifyRegion,
  classifyRegions,
} from "./region-classifier";

// Sprint 5: Geometry Detector
export {
  angleToTransformMatrix,
  transformMatrixToAngle,
  resolveBlockRotation,
  needsGeometryDetection,
  detectRotation,
  detectRotationFromImage,
  detectGeometry,
} from "./geometry-detector";

export { pdfLinesToEditableBlock } from "./pdf-native-adapter";

// M7.7-009A-1: Render Source Detection
export {
  extractImageRegions,
  extractTextItemRects,
  classifyLineRenderSources,
  detectLineRenderSource,
  auditLineRenderSource,
  auditPageRenderSources,
  calcMaxImageCoverage,
  calcMaxTextOperatorCoverage,
} from "./render-source-detector";
export type { RenderSource, ImageRegion, ImageOpCodes, LineSourceAudit } from "./render-source-detector";

export {
  editableBlockToTextBlock,
  convertToTextBlocks,
  convertEditableDocumentToBlocks,
} from "./textblock-adapter";

// Sprint 4: DocumentRenderer
export {
  renderBlock,
  renderPage,
  renderDocument,
  renderToBlocks,
  renderPageToBlocks,
  type RenderableTextObject,
} from "./document-renderer";

// Sprint 5: Glyph-Level Rendering
export {
  type RenderCommand,
  type DrawGlyphCommand,
  type DrawLineCommand,
  type DrawRectCommand,
  type DrawImageCommand,
  type BackgroundPatch,
  isDrawGlyph,
  isDrawLine,
  isDrawRect,
  isDrawImage,
  groupCommands,
} from "./render-command";

// Sprint 32: Text Block Extraction
export { buildTextBlocks, type TextBlockInfo } from "./text-block-extraction";

// Sprint 33: Document Layout Model
export {
  buildLayoutDocument,
  layoutDebugSummary,
  layoutDump,
  findEditTarget,
  type LayoutNodeType,
  type LayoutTransform,
  type LayoutNode,
  type LayoutDocument,
  type LayoutBuildParams,
  type LayoutDumpOptions,
} from "./document-layout-model";

// Sprint 33.3 / 33.3.2: Word-Level Line Reconstruction
export {
  reconstructLines,
  reconstructLinesWithDiagnostics,
  calculateVisualRightBoundary,
  joinWords,
  groupGlyphsIntoWords,
  normalizeWordTokens,
  singleWordPenalty,
  calculateLineStability,
  DEFAULT_LINE_SCORE,
  type OCRWord,
  type ReconstructedLine,
  type LineReconstructionOptions,
  type LineReconstructionResult,
  type LineReconstructionDecision,
  type LineScoreConfig,
  type BreakCandidate,
  type LineScoreDebugEntry,
} from "./layout/line-reconstruction";

// Sprint 33.3.2: Phrase Cohesion Engine
export {
  getPhraseScore,
  isProtectedPair,
  PROTECTED_PAIRS,
  normalizePhraseWord,
} from "./layout/phrase-cohesion";

export {
  renderBlockToCommands,
  renderPageToCommands,
  renderDocumentToCommands,
} from "./document-renderer";

// Sprint 20: Signature Composite Region Understanding
export type {
  SignatureCompositeRegion,
  CompositeRegionResult,
  CompositeRegionDebug,
} from "./signature-composite-region";

// Sprint 33.5.6: Signature Region Independent Render Model
export type {
  SignatureRenderRegion,
  SignatureChild,
} from "./types";

export {
  detectCompositeSignatureRegions,
} from "./signature-region-merger";

export {
  reconstructCompositeRegionBackgrounds,
  reconstructAllSignatureBackgrounds,
  type BackgroundReconstructorDebug,
} from "./signature-background-reconstructor";

// Sprint 31: Sub-Region Segmentation + 31.3: Semantic Classification
export {
  segmentSignatureRegion,
  classifySegments,
  pixelContrastScore,
  imageInkOverlapRatio,
  normalizeStampText,
  extractCRMNums,
  textSimilarity,
  isSprint31Enabled,
} from "./signature-region-segmenter";

export type {
  SignatureSubRegion,
  SignatureSubRegionType,
  SignatureRegionSegmentDebug,
  SignatureSegmentType,
  SegmentClassification,
  SignatureClassificationDebug,
} from "./signature-sub-region";

// Sprint 20.6: Unified Signature Suppression Manager
export {
  signatureSuppression,
  publishSignatureRenderDebug,
  type SignatureRenderDebug,
} from "./signature-suppression-manager";

// Sprint 21: Background Text Remover（全页 OCR 背景文字移除）
export {
  removeAllBlockText,
  type CleanBackgroundPatch,
  type BackgroundRemovalDebug,
} from "./background-text-remover";

export { GlyphRenderer, type GlyphRendererProps, renderPageGlyphs, type GlyphClickInfo, type GlyphSelectInfo } from "./glyph-renderer";
export { BackgroundPatchLayer, type BackgroundPatchLayerProps } from "./background-patch-layer";

// Sprint 6: Glyph Interaction Engine
export {
  GlyphHitMap,
  createGlyphHitMap,
  type GlyphHitRecord,
  type GlyphSelection,
} from "./glyph-hit-map";

export {
  mutateGlyphChar,
  mutateLineText,
  mutateFindAndReplace,
  mutateByHit,
  type MutationResult,
  type InverseData,
} from "./document-mutation";

// M5-004A: TextOperation Model（insert/delete/replace 统一抽象，ADR-049）
// M5-004C: OverflowState（detect only）
export {
  applyTextOperation,
  type TextOperation,
  type GlyphRange,
  type OverflowState,
} from "./text-operation";

// M5-004D: Identity-preserving Line Split（ADR-051）
export {
  splitLine,
  type LineSplitResult,
  type LineSplitOptions,
  type CaretMapping,
  type SelectionRangeMapping,
  type GlyphMigrationEntry,
} from "./line-split";

// M5-004E: OverflowResolver（overflow → identity-preserving line split，ADR-050/051）
export {
  resolveOverflow,
  type OverflowResolveResult,
  type ReflowMigration,
} from "./overflow-resolver";

// M6-001B: Operation History（operation-inverse Undo/Redo，ADR-052）
export {
  OperationHistory,
  applyInverse,
  applyInverseToDocument,
  operationTarget,
  type HistoryEntry,
  type HistorySelection,
  type UndoRedoResult,
} from "./operation-history";

// M7-004A: DerivedSelection → SelectionRange（鼠标拖选，利用 glyphLocalIndex）
export { derivedToSelectionRange } from "./derived-selection-range";

// Sprint 7: EditableDocument Export Engine
export {
  type ExportCommand,
  type DrawTextGlyphCommand,
  type DrawImageCommand as ExportDrawImageCommand,
  type DrawLineCommand as ExportDrawLineCommand,
  type RedactionCommand,
  isDrawTextGlyph,
  isDrawExportImage,
  isDrawExportLine,
  isRedaction,
  groupExportCommands,
} from "./export-command";

export {
  renderBlockToExportCommands,
  renderDocumentToExportCommands,
  writeExportCommandsToPDF,
  exportEditableDocument,
  type ExportContext,
} from "./export-renderer";

export {
  serializeEditableDocument,
  createDebugDocument,
  summarizeEditableDocument,
  summarizeBlockStyles,
  summarizeLayoutComparison,
  summarizeLayoutDiff,
} from "./debug";

// Sprint 8: Semantic Document Intelligence Layer
export type {
  SemanticObject,
  DateFieldObject,
  NameFieldObject,
  AddressFieldObject,
  SignatureFieldObject,
  TableFieldObject,
  TextFieldObject,
  AnySemanticObject,
  SemanticDocument,
  SemanticObjectType,
  SemanticSource,
  GlyphRef,
} from "./semantic-types";

export {
  isDateField,
  isNameField,
  isAddressField,
  isSignatureField,
  isTableField,
  isTextField,
} from "./semantic-types";

export {
  analyzeDocument,
  findSemanticObject,
  findSemanticObjectsByType,
  findSemanticObjectsByLabel,
} from "./semantic-analyzer";

export {
  replaceSemanticValue,
  replaceSemanticValues,
  replaceByLabel,
  replaceByType,
  type SemanticMutationResult,
} from "./semantic-mutation";

// Sprint 9: AI Document Understanding Layer
export type {
  DocumentSchema,
  DocumentType,
  EntityExpectation,
  EntityRelationship,
} from "./document-schema";

export {
  detectDocumentType,
  validateAgainstSchema,
  getAllSchemas,
} from "./document-schema";

export {
  executeAction,
  executeNaturalLanguage,
  type AIAction,
  type AIActionType,
  type AIActionResult,
} from "./ai-action-api";

export { extractSemanticWithLLM } from "./llm-semantic-extractor";

// Sprint 10: AI Document Agent Layer
export type {
  ActionPlan,
  PlanIntent,
  PlanOperation,
  PlanTarget,
  PlanExecutionResult,
  PlanVerification,
  DocumentAgentResponse,
} from "./action-plan";

export {
  querySemanticObjects,
  parseNaturalLanguageQuery,
  executeNaturalLanguageQuery,
  type SemanticQuery,
  type QueryResult,
} from "./semantic-query";

export {
  planDocumentAction,
  executePlans,
  verifyChanges,
  executeDocumentAction,
} from "./document-agent";

// Sprint 11: AI Agent Planning & Tool Architecture
export type {
  TaskStep,
  TaskPlan,
  AgentExecutionResult,
} from "./agent-core";

export {
  AgentPlanner,
  AgentExecutor,
  AgentVerifier,
  runAgent,
  undoLastAction,
} from "./agent-core";

export {
  ToolRegistry,
  getToolRegistry,
  type Tool,
  type ToolContext,
  type ToolParams,
  type ToolResult,
} from "./tool-registry";

export {
  ExecutionHistory,
  getExecutionHistory,
  type HistoryEntry,
  type UndoResult,
} from "./execution-history";
