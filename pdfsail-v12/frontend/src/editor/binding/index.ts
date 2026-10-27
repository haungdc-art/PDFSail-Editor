/**
 * editor/binding/index.ts — EDITOR-CORE-011-B 统一出口
 *
 * Binding = **Core 的对侧 Adapter**（不是 Core 的子模块）。
 *
 * ── 依赖方向（单向，永不反向）──────────────────────────────────────
 *
 *     Editor Core  →  EditorRenderFrame
 *                          ↓
 *                    editor/binding          ← 允许 import Core + 旧 DTO
 *                          ↓
 *              RenderCommand / EditableStyle / EditableDocument
 *                          ↓
 *                     Legacy PDF layer
 *
 * **禁止反向**：`editor/core/**` 不得 import 本目录，也不得 import
 * `document-model` / `editor-engine` / `RenderCommand` / `EditableStyle`
 * （有架构级测试守卫，见 `binding.test.ts` 第 ⑦ 组）。
 *
 * ── 本模块只做翻译，不做三件事 ─────────────────────────────────────
 *   1. 不测量（无 `measureText` / canvas / 度量提供者）
 *   2. 不布局（几何逐字段透传，一个像素都不重算）
 *   3. 不伪造（不造 coverage / mask / patch；不凭空拼 legacy id）
 */

// provenance：PDF provenance 的唯一解析入口（runId → TextRun.source）
export type { PdfProvenance, RunContext } from "./provenance";
export {
  collectProvenance,
  findRunContext,
  findTextBoxByBlockId,
  findTextBoxById,
  isModifiedRun,
  provenanceOfBinding,
  resolvePdfProvenance,
  textBoxProvenance,
} from "./provenance";

// operator-provenance：Operator Provenance 的唯一纯计算入口（P1-C）
export type { GlyphProvenance, GlyphProvenanceInput } from "./operator-provenance";
export { computeOperatorProvenance } from "./operator-provenance";

// canonical-selection / dom-selection-shadow / production-selection-adapter（3C-10S.1~3A）
export type {
  CanonicalSelection,
  CanonicalSelectionRejection,
  CanonicalSelectionResult,
  CoreTextTarget,
  CoreTargetResult,
  DomSelectionRangeInput,
  GlyphSelectionInput,
} from "./canonical-selection";
export {
  canonicalSelectionsEqual,
  canonicalToCoreTarget,
  domSelectionToCanonical,
  glyphSelectionToCanonical,
} from "./canonical-selection";
export type { DomShadowDeps, SegmentIdentity } from "./dom-selection-shadow";
export { domSelectionShadow, domRangeToCanonicalShadow, findSegmentElement } from "./dom-selection-shadow";
export type {
  CanonicalSelectionSink,
  ProductionSelectionAdapterDeps,
  ProductionSelectionResult,
} from "./production-selection-adapter";
export { publishCanonicalSelection, publishDomSelection } from "./production-selection-adapter";

// canonical-selection-sink（3C-10S.3B-1）：双轨 selection 的第二条 sink（canonical / UTF-16）
export type { CanonicalSelectionProvider, CanonicalSelectionStore } from "./canonical-selection-sink";
export { createCanonicalSelectionStore } from "./canonical-selection-sink";

// canonical-selection-core-target（3C-10S.3B-2 B-2.1）：CanonicalSelection → CoreSelectionTarget
export type {
  CanonicalCoreTargetRejection,
  CanonicalCoreTargetResult,
  CoreSelectionTarget,
} from "./canonical-selection-core-target";
export {
  canonicalSelectionToCoreTarget,
  isValidCoreSelectionTarget,
} from "./canonical-selection-core-target";

// render-identity：渲染身份（blockId / lineId）+ 命名空间决策
export type {
  BlockIdSource,
  LegacyLineIdResolver,
  LegacyLineIdResolverInput,
  LineIdNamespace,
  RenderIdentity,
  RenderIdentityInput,
  RenderIdentityOptions,
} from "./render-identity";
export {
  CORE_LINE_ID_NAMESPACE,
  PDF_LINE_ID_NAMESPACE,
  coreBlockIdOf,
  defaultLegacyLineIdResolver,
  detectLineIdNamespaceMix,
  resolveRenderIdentity,
} from "./render-identity";

// render-command-bridge：EditorRenderFrame → RenderCommand[] + EditableStyle[]
export type {
  FontIdentityProvider,
  RenderCommandBridgeOptions,
  RenderCommandBridgeResult,
} from "./render-command-bridge";
export {
  BRIDGE_WARNING_DUPLICATE_KEY,
  BRIDGE_WARNING_DUPLICATE_LEGACY_LINE_ID,
  BRIDGE_WARNING_IDENTITY_MIX,
  BRIDGE_WARNING_INVALID_BOX,
  BRIDGE_WARNING_UNKNOWN_RUN,
  buildRenderCommands,
  toEditableStyle,
} from "./render-command-bridge";

// pdf-export-bridge：EditorDocument → EditableDocument
export type {
  EditableDocumentBridgeOptions,
  EditableDocumentBridgeResult,
} from "./pdf-export-bridge";
// pdf-metrics：legacy PDF advance → §18 L2 度量（012-A / A2）
export type {
  LegacyLineMetricsOptions,
  LegacyLineMetricsResult,
  LegacyLineMetricsStats,
} from "./pdf-metrics";
export { createLegacyLineMetrics } from "./pdf-metrics";
export { buildMetricsByTextBoxFromLegacy } from "./core-render-source";
// Step 1：字符身份对齐的 diff-aware 度量 provider（编辑后仍复用原 PDF advance）
export {
  alignByCharIdentity,
  createDiffedLineMetrics,
  lineTextOf,
} from "./diffed-line-metrics";
export type {
  CharIdentityPair,
  DiffAlignment,
  DiffedLineMetricsOptions,
  DiffedLineMetricsResult,
} from "./diffed-line-metrics";

// core-render-source：唯一编排 + 生产开关 + 成对切换（012-A / A3+A4）
export type {
  CoreRenderSourceFailure,
  CoreRenderSourceFromDocumentOptions,
  CoreRenderSourceOptions,
  CoreRenderSourceOutcome,
  CoreRenderSourceStats,
  CoreRenderSourceSuccess,
  RenderSourceSelection,
} from "./core-render-source";
export {
  CORE_RENDER_FLAG,
  buildCoreRenderSource,
  buildCoreRenderSourceFromDocument,
  checkImportedVisualLineGranularity,
  mergeCoreRenderCommands,
  readCoreRenderFlag,
  selectRenderSource,
} from "./core-render-source";

// core-image-render-adapter：C5-D-B Core ImageObject(assetRef) → 屏幕 DrawImageCommand
export type { CoreImageRenderOptions } from "./core-image-render-adapter";
export {
  buildCoreImageRenderCommands,
  isImageRenderCommand,
  rotationFromTransform,
} from "./core-image-render-adapter";

// core-text-render-shadow：F3B-6.18-B Core vs Legacy 文本渲染结构 shadow（纯比较，只读）
export type {
  BuildTextRenderShadowInput,
  DuplicateTextRisk,
  ShadowSegmentProjection,
  TextRenderShadowGlyph,
  TextRenderShadowLineDiff,
  TextRenderShadowReport,
} from "./core-text-render-shadow";
export {
  DEFAULT_TEXT_RENDER_SHADOW_TOLERANCE,
  SHADOW_RISK_BASELINE_ABSENT,
  SHADOW_RISK_LINE_CORE_MISSING,
  SHADOW_RISK_SEGMENT_OVERLAP,
  SHADOW_RISK_TRANSFORM_ABSENT,
  buildTextRenderShadow,
  countNonGlyphCommands,
  detectDuplicateTextRender,
  toShadowGlyphs,
} from "./core-text-render-shadow";

// core-input-source：DOM 输入 → Core（012-C / C1–C9）
export type {
  CoreInputHandleOptions,
  CoreInputOutcome,
  CoreInputResult,
  CoreInputSession,
  CoreInputSessionOptions,
  CoreInputSessionOutcome,
  CorePresentationState,
  CoreUndoRedoOutcome,
  DispatchBeforeInputArgs,
  DispatchBeforeInputOutcome,
  InputRoute,
} from "./core-input-source";
export {
  CORE_INPUT_FLAG,
  CORE_INPUT_FORBIDDEN_STATE_KEYS,
  beforeInputToInputEvent,
  compositionToInputEvent,
  compositionStateOf,
  // F3B-6.19-C（C2）：caret seeding 的**身份**路径（primary）
  coreCaretForBinding,
  // F3B-6.19-C（C2）：**Legacy 兼容回退**（文本匹配；非 primary identity resolver）
  coreCaretForSegment,
  // F3B-6.21-H1-B：DOM 非折叠选区 → Core range 选区（format 等 range 意图的播种路径）
  coreRangeForBinding,
  // F3B-6.19-C（C3）：presentation ownership / lifecycle contract
  corePresentationFor,
  createCoreInputSession,
  createCoreInputSessionFromDocument,
  dispatchBeforeInput,
  documentOf,
  // F3B-6.21-F2（E-C5-2）：词删后的 DOM caret 对账（与 E-C5-1 的 D6 同源）
  coreCaretParagraphOffset,
  documentStartPosition,
  handleCoreBeforeInput,
  handleCoreComposition,
  handleCoreInput,
  isCorePresentationCurrent,
  paragraphOffsetOf,
  readCoreInputFlag,
  redoCoreInput,
  snapshotSession,
  undoCoreInput,
  // IB-2-F6：不依赖唯一 run 的 caret / range 播种入口
  coreCaretForSegmentParagraph,
  coreRangeForSegmentParagraph,
} from "./core-input-source";

// F3B-6.21-G1：**Core→DOM caret 对账**基础能力（C5-3 navigation 的前置）
export type {
  CoreDomCaretReason,
  CoreDomCaretResult,
  DomCaretPlan,
  DomCaretPlanInput,
  ReconcileDomCaretArgs,
  ReconcileFromCoreArgs,
} from "./core-dom-caret";
export {
  planDomCaretOffsets,
  reconcileDomCaretAtOffset,
  reconcileDomCaretFromCore,
  // F3B-6.27-CARET：陈旧 DOM 折叠光标偏移 → Core 段落偏移（纯函数，窄契约）
  mapStaleAppendCaretOffset,
} from "./core-dom-caret";

// IB-2-A / IB-2-F：Segment → Paragraph 绑定区间的**唯一权威原语**
// （从行 glyph 序列推导段落级偏移 ⇒ 天然包含 segmenter 注入的段间分隔空格）
export type {
  SegmentBindingRange,
  SegmentParagraphRangeInput,
  SegmentRangeSource,
} from "./segment-paragraph-range";
export { resolveSegmentParagraphRange } from "./segment-paragraph-range";

// IB-2-F6：segment base（不依赖 run）+ paragraph offset → Core target 的播种入口
export type {
  ParagraphCoreTarget,
  ParagraphTargetRejection,
  SegmentGlyphRange,
  // 01H（PARAGRAPH-EDIT-ACCEPTANCE）H1：拆分产物归属判定的输入契约
  CommittedMutationEvidence,
} from "./paragraph-offset-core-target";
export {
  ownedParagraphIdForBinding,
  paragraphOffsetToCaretTarget,
  paragraphOffsetToCoreTarget,
  paragraphTextOf,
  refineSegmentBaseByParagraphText,
  resolveSegmentCoreTarget,
  resolveSegmentParagraphBaseUtf16,
  // 01H（H1）：当前编辑应落在哪个段落（生产与测试同一入口；内部仍优先 ownedParagraphIdForBinding）
  resolveEditingCaretParagraphId,
} from "./paragraph-offset-core-target";
export {
  // F3B-6.27-H2：**单一**编辑会话目标身份（establish / maintain 两条强度不同的规则）
  establishEditingTarget,
  resolveEditingTargetMaintain,
  resolveEditingTargetRebind,
  type EditingTargetIdentity,
  type EditingTargetInvalidReason,
  type EstablishEditingTargetInput,
  type EditingTargetMaintainInput,
  type EditingTargetMaintainResult,
  type EditingTargetRebindInput,
} from "./editing-target-identity";

export {
  EXPORT_WARNING_ASSUMED_RUNTIME,
  EXPORT_WARNING_CORE_ONLY_BLOCK_ID,
  EXPORT_WARNING_DUPLICATE_LEGACY_LINE_ID,
  EXPORT_WARNING_EMPTY_LINE_DEFAULT_STYLE,
  EXPORT_WARNING_GLYPH_TEXT_MISMATCH,
  EXPORT_WARNING_MISSING_LAYOUT,
  EXPORT_WARNING_MISSING_ORIGINAL_BOUNDS,
  EXPORT_WARNING_PAGE_METRICS_UNIT,
  EXPORT_WARNING_PROVENANCE_LESS_RUN,
  EXPORT_WARNING_TEXT_SOURCE_FALLBACK,
  EXPORT_WARNING_UNKNOWN_RUN,
  CORE_EXPORT_PRODUCTION_WIRED,
  assertCoreExportWired,
  buildEditableDocument,
} from "./pdf-export-bridge";

// ocr-import-draft：Manual OCR → Core Migration Step 2a
//（Raw OCR blocks → NormalizedOcrDraft intermediate draft；管线终点红线：不触碰 Core/Command/History/docBlocks）
export type {
  NormalizedOcrDraft,
  NormalizedOcrDraftItem,
  OcrGranularity,
  OcrGranularityReason,
  OcrImportCanvas,
  OcrImportRawBlock,
} from "./ocr-import-draft";
export {
  normalizeOcrImportDraft,
  OCR_CONTAINMENT_RATIO,
  OCR_MERGE_GAP_PX,
  OCR_MERGE_VERTICAL_OVERLAP_RATIO,
  OCR_OUT_OF_BOUNDS_DROP_RATIO,
  OCR_TAU_CONF,
  OCR_TAU_COUNT,
} from "./ocr-import-draft";
