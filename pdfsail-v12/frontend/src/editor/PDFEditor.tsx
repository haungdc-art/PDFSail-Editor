import React, { useEffect, useRef, useState, useCallback, useMemo, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { v4 as uuid } from "uuid";
import * as pdfjsLib from "pdfjs-dist";
import { PDFJS_WORKER_SRC } from "../pdfjs-worker-src";
import { computeSceneCompleteness, expectedFromCounts, actualFromCounts } from "../document-model/scene-completeness";
// Sprint-127 (唯一 Mission): Bitmap Runtime — PDFEditor 不再知道 Bitmap 判定逻辑，只消费 state
import { computeBitmapState, BITMAP_INITIAL_STATE, type BitmapRuntimeState } from "./runtime/bitmap-runtime";
import { PDFDocument } from "pdf-lib";
import type { Block, ImageBlock, TextBlock } from "./types";
import { LockCoordSystem } from "./coord";
import { EditorProvider, useEditor } from "./core/EditorProvider";
// F3B-6.23-C-Impl-1：canonical Undo/Redo 请求总线（唯一入口；路由在下方执行器）
import {
  registerUndoRedoExecutor,
  clearUndoRedoExecutor,
  notifyUndoRedoAvailability,
} from "./features/undo-redo-request";
// B2-B：Core projection 与 authored blocks 的统一 merge 接线（不可绕过 merge 直接 setDocBlocks 投影）
import { mergeDocBlocksProjection } from "./features/docBlocksProjectionMerge";
// B2-C-Implementation-1：OCR replacement contract（按 identity 替换，不按 page 全删）
import { replaceOcrProjection } from "./features/ocrProjectionReplacement";
import { OptionModals } from "./components/OptionModals";
import { PageThumbnails } from "./components/PageThumbnails";
import { MainToolbar } from "./components/MainToolbar";
import { SidePanel } from "./components/SidePanel";
import { DocumentWorkspace } from "./components/DocumentWorkspace";
import { PDFCanvas } from "./components/PDFCanvas";
import { DownloadButton } from "./components/DownloadButton";
import { PostLoadModal } from "./components/PostLoadModal";
import { FloatingToolbar } from "./components/FloatingToolbar";
import { FindReplaceBar } from "./components/FindReplaceBar";
import { EditModeToolbar } from "./components/EditModeToolbar";
import { savePendingPdf } from "../lib/indexedDB";
// Commit 5: Text Intelligence Layer
import { extractGlyphs } from "../editor-engine/TextExtractor";
import { groupIntoLines, buildSegments } from "../editor-engine/SegmentBuilder";
import { resolveDocumentFonts, unloadDocumentFonts, type FontResolution } from "./font-resolution";
import { FontAnalyzerImpl } from "../editor-engine/FontAnalyzer";
import { CoordinateMapperImpl } from "../editor-engine/CoordinateMapper";
import type { PdfTextContent, Segment } from "../editor-engine/types";
// PDF Reconstruction Engine V5 — Sprint 11: AI Agent Planning & Tool Architecture
import type { EditableDocument, EditableLine } from "../document-model";
// Task-011B: Composition Root（EditTool 装配，注入 FloatingToolbar）
import { EditTool } from "../document-model/edit-tool";
import { MapCapabilityRegistry } from "../document-model/map-capability-registry";
// Task-011C: ReplaceCommand Registration（Composition Root 装配 Runtime + ReplaceCommand）
import { EditorRuntime } from "../document-model/editor-runtime";
import { ReplaceCommand } from "../document-model/replace-command";
// F3B-6.17-3C-10A：replace capability 的 Core-aware Command（仅 replace，受 __replaceMode gate）
// F3B-6.17-3C-10S.3B-2：+ Core canonical entry（CanonicalSelection → CoreSelectionTarget → Command）
import {
  CapabilityReplaceCommand,
  createCapabilityCoreTelemetry,
  type CapabilityReplaceCommandDeps,
} from "./binding/capability-core-commit";
// Task-013B: 真实 CurrentSelectionProvider（Consistency Guard）
import { MapCurrentSelectionProvider } from "../document-model/map-current-selection-provider";
// M7-004A: SelectionRange（鼠标拖选 → 文本选区，与 Keyboard Selection 同构）
import type { SelectionRange } from "../document-model/current-selection";
import { derivedToSelectionRange } from "../document-model/derived-selection-range";
// Task-012A: DeleteCommand Registration（复制 ReplaceCommand 模式，机械执行）
import { DeleteCommand } from "../document-model/delete-command";
// Task-012B: RewriteCommand Registration（Reference: ReplaceCommand）
import { RewriteCommand } from "../document-model/rewrite-command";
// Task-012C: TranslateCommand Registration（Reference: ReplaceCommand）
import { TranslateCommand } from "../document-model/translate-command";
// Task-012D: FixOcrCommand Registration（Reference: ReplaceCommand）
import { FixOcrCommand } from "../document-model/fix-ocr-command";
// M7.7-009B-2A: Font Identity — 从 pdf.js commonObjs 提取字体身份并注入 EditableStyle
import { setFontIdentityCache, clearFontIdentityCache, normalizePdfFontName, inferFontWeight } from "../document-model/pdf-style-extractor";
// M5-IMPLEMENT-002B: EditSession 接线（B 路径 text/target truth）
import {
  createEditSession,
  updateSessionText,
  commitSession,
  cancelSession,
  moveGlyphCaret,
  moveGlyphCaretSelect,
  // M7.7-002: Home/End 导航（含 Shift 扩展 selection）
  moveGlyphCaretHome,
  moveGlyphCaretEnd,
  moveGlyphCaretSelectHome,
  moveGlyphCaretSelectEnd,
  insertAtGlyph,
  backspaceAtGlyph,
  deleteAtGlyph,
  deleteWordAtCaret,
  replaceSelection,
  selectAll,
  hasSelection,
  ensureGlyphCaretFromCaretPosition,
  applyTextareaValue,
  type EditSession,
} from "../document-model/edit-session";
import {
  OperationHistory,
  operationTarget,
  type HistoryEntry,
} from "../document-model/operation-history";
import { resolveEditTarget } from "../document-model/edit-session-target";
// M5-IMPLEMENT-003B-UI: Visual Caret（resolveCaretPosition 计算位置）
import { resolveCaretPosition } from "../document-model/edit-caret";
// M7.7-002/003: 编辑态 selection 高亮（selectionHighlightQuads 计算旋转四边形）
import { selectionHighlightQuads } from "../document-model/edit-selection-highlight";
// M7.7-IMPLEMENT-001: 点击 → glyph 级光标 → 直接进入编辑
import { glyphCaretFromClick, caretCharOffsetOf } from "../document-model/glyph-caret-from-click";
// M7.8-035-FIX：pdf.js loadedName → 原 PDF 字体资源的可靠溯源。
// 浏览器加载路径此前没有传它，glyph.fontIdentity / pdfCharCode 全空，
// Export 拿不到原始 Type3 资源 → 整行回落 page.drawText → Helvetica。
import { buildFontProvenanceMap } from "../document-model/pdf-font-provenance";
// Sprint34.15: 统一签名旋转 context（Editor / Export 共用 pivot）
// Sprint34.15/34.25: 统一签名旋转 context（pivot = block originalBounds center）
import {
  buildSignatureTransformContext,
  type SignatureTransformContext,
} from "../document-model/signature-transform-context";
// Sprint34.26（记录，仅本次）：per-block 图像级倾斜检测
import { detectTiltFromCanvas } from "../document-model/signature-tilt-detector";
import {
  StyleResolver,
  ocrBlocksToEditablePage,
  pdfLinesToEditableBlock,
  summarizeEditableDocument,
  summarizeBlockStyles,
  summarizeLayoutComparison,
  summarizeLayoutDiff,
  renderToBlocks,
  convertToTextBlocks,
  renderPageToCommands,
  mutateLineText,
  applyTextOperation,
  type TextOperation,
  type MutationResult,
  analyzeDocument,
  replaceSemanticValue,
  extractSemanticWithLLM,
  detectDocumentType,
  executeNaturalLanguage,
  planDocumentAction,
  executePlans,
  executeDocumentAction,
  AgentPlanner,
  AgentExecutor,
  AgentVerifier,
  runAgent,
  undoLastAction,
  getExecutionHistory,
  buildLayoutDocument,
  findEditTarget,
  type GlyphClickInfo,
  type GlyphSelectInfo,
  type TransformMatrix,
  resolveBlockRotation,
} from "../document-model";
// OCR-EDIT-SYNC：用与初始构建相同的 Layout Engine 重建整块（逐字位置自洽，根治导出打散/插空格）。
import { reconstructBlockLayout } from "../document-model/layout-engine";
import type { DrawGlyphCommand, DrawImageCommand, RenderCommand } from "../document-model/render-command";
import { isDrawGlyph } from "../document-model/render-command";
// EDITOR-CORE-012-A：Core 渲染源（**派生只读投影**，仅当 window.__coreRender === true 时启用）
import {
  buildCoreRenderSource,
  readCoreRenderFlag,
  selectRenderSource,
  type CoreRenderSourceOutcome,
  // EDITOR-CORE-012-C6：Core 输入接线（**只多这两组符号**，不引入新的状态模型）
  CORE_INPUT_FLAG,
  buildCoreRenderSourceFromDocument,
  buildMetricsByTextBoxFromLegacy,
  // F3B-6.19-C（C2）：caret seeding **身份**路径（primary）；`coreCaretForSegment` 降级为
  // Legacy 兼容回退（仅在 segment 缺 provenance 时使用）
  coreCaretForBinding,
  coreCaretForSegment,
  coreRangeForBinding,
  // IB-2-F（F2）：Segment → Paragraph 绑定区间的**唯一权威原语**。
  // 从**行 glyph 序列**推导段落级偏移 ⇒ 天然包含 segmenter 注入的段间分隔空格。
  resolveSegmentParagraphRange,
  // IB-2-F6：segment base 只由「行 glyph 序列 + segment.source glyph 区间」推导（不依赖 run）
  resolveSegmentParagraphBaseUtf16,
  // IB-2-F6：用当前段落文本校正 base（前序 segment 被编辑后 import 期 base 会平移）
  paragraphTextOf,
  refineSegmentBaseByParagraphText,
  // IB-2-F6：paragraph offset → Core 目标（run 由 offset 推导，不依赖唯一 run）
  coreCaretForSegmentParagraph,
  coreRangeForSegmentParagraph,
  // 错行修复：Core caret 的 paragraphId 归属校验（不猜、不按下标）
  ownedParagraphIdForBinding,
  // 01H（PARAGRAPH-EDIT-ACCEPTANCE）H1：拆分产物归属的唯一判定入口
  // （生产与测试同一函数；同 textBox / 相邻段落**不**单独作为归属证明）
  resolveEditingCaretParagraphId,
  // F3B-6.27-H2：**单一**编辑会话目标身份（establish / maintain 两条强度不同的规则）。
  // 用于收敛「当前编辑的是哪个段落」的四个互不一致解析源。
  establishEditingTarget,
  resolveEditingTargetMaintain,
  resolveEditingTargetRebind,
  type EditingTargetIdentity,
  type CommittedMutationEvidence,
  // F3B-6.19-C（C3）：presentation ownership / lifecycle contract
  corePresentationFor,
  isCorePresentationCurrent,
  type CorePresentationState,
  createCoreInputSession,
  createCoreInputSessionFromDocument,
  dispatchBeforeInput,
  handleCoreComposition,
  documentOf,
  // F3B-6.21-F2：组合活跃判据（Core CompositionTracker，不依赖浏览器 isComposing）
  compositionStateOf,
  // F3B-6.21-F2（E-C5-2）：词删后的 DOM caret 对账（与 E-C5-1 的 D6 同源）
  coreCaretParagraphOffset,
  // F3B-6.21-G1：**统一**的 Core→DOM caret 对账原语（取代内联 TreeWalker）
  reconcileDomCaretAtOffset,
  // F3B-6.21-G3-A：Core-owned segment 的 ArrowLeft/Right 经由本原语写回 DOM（唯一出口）
  reconcileDomCaretFromCore,
  // F3B-6.27-CARET：陈旧 DOM 折叠光标偏移 → Core 段落偏移（纯函数，窄契约）
  mapStaleAppendCaretOffset,
  readCoreInputFlag,
  redoCoreInput,
  undoCoreInput,
  type CoreInputSession,
  // F3B-6.18-B：Core vs Legacy 文本渲染结构 shadow（gated 只读观察，缺省关闭）
  buildTextRenderShadow,
} from "./binding";
// F3B-6.27-G5：Core → legacy segment 文本投影原语**保留但未接线**（见下方 DISABLED 注释）。
//   复接线的前置条件：Core 提供 per-segment text ownership。
// F3B-6.27-GEO：mask 几何原语（Core layout 视觉行并集）+ lineId → Core paragraph 归属解析
import { coreMaskGeometry, type CoreVisualLineBox } from "./binding/core-mask-geometry";
// F3B-6.28-M（D2″）：统一 ink 校正（纯几何 + 像素适配器分离）
import { correctBoxWithInkRows, scanInkRowsForRange } from "./features/ink-box-correction";
import {
  coreParagraphIdForLineId,
  resolveParagraphIdForLine,
  scanLineProvenanceClaim,
  writeLineIdentity,
  type LineIdentityLedger,
} from "./binding/core-segment-text-projection";
// F3B-6.27-G6（Step 3）：E2-EXCEPTION 判定原语（编辑面同步是否允许）
import { decideCoreEditingSurfaceSync } from "./components/core-editing-surface-sync";
// ── P0-F1（Explicit EditingUnit DOM Surface）───────────────────────────
// ⚠️ 只 import **具体文件**（不走 `./binding` barrel）：barrel 有实现清单守卫，
//    且本轮不扩大 barrel 改动面。
// · P0-A：唯一 unit 构建器（文本真值 = Core 真实段落文本，不接受注入文本）
import {
  buildEditingUnit,
  syntheticLineIdOf,
  // ★ F3B-6.27 CARET-LANDING (c)/(d)：unit caret 坐标权威（P0-A，已有单测 + round-trip）
  unitOffsetToParagraphOffset,
  paragraphOffsetToUnitOffset,
  type EditingUnit,
} from "./binding/editing-unit";
// · P0-C：唯一 unit surface 几何（D1 = A：复用它，不新建第二套几何）
import { createEditingUnitSurface } from "./binding/editing-unit-surface";
// · P0-F1 适配层：P0-C 输出 → 既有 EditingSurfaceGeometry（保留 constraint / coreBottom 求交语义）
import { adaptUnitSurfaceToEditingGeometry } from "./binding/editing-unit-surface-adapter";
import { readExplicitEditingUnit } from "./binding/editing-unit-surface-adapter";
// ── F3B-6.28 · S2-v1：表格 cell 编辑单元规划器（纯契约；生产门 `__cellUnitEditing`）──
// ⚠️ 门缺省值 = **ON**（2026-10-22 · C 方案：用户报告「点格子却整行编辑」⇒ cell 编辑
//   为默认粒度；回滚 = 显式 `false` 或 localStorage "0" 粘性 kill-switch）。
// ⚠️ 只 import 具体文件（同上方 P0-F1 约定，不走 barrel）。
import {
  planCellUnit,
  readCellUnitEditingFlag,
  CELL_UNIT_ID_PREFIX,
  type CellUnitPlan,
  type CellUnitPlanOutcome,
  type CellUnitGlyph,
} from "./binding/table-cell-unit";
// ── F3B-6.28 · S2-v3：cell 编辑面**稳定锚**（纯契约；接线属阶段 4）────────────────
//   D1 根因 = 首字符提交后规划器门 2（run 包含关系）失败 ⇒ cell 面消失 ⇒ 降级单段路径
//   按 base=0 插入 ⇒ 串格。锚让 cell 面在提交后**保持身份**（C1–C5 五条件重验证），
//   使 unit route 与 F5 caret 恢复跨提交持续工作；降级路径改为**安全退出**（不静默错乱）。
//   契约：cases/F3B-6.28-S2-v3-CellAnchor-Contract.md（阶段 1 已通过；§14 阶段 4 申请已批准）。
import { detectTableCells } from "./binding/table-cell-contract";
import { resolveSegmentCell, type CellResolverSegment } from "./binding/table-cell-resolver";
// ── F3B-6.28：cell 编辑**台账**（2026-10-24 用户缺陷「同行第二次格编辑回落整行」）──
//   行内任意一次 cell 事务提交后 run glyph 索引被 strip ⇒ 门 2 结构性死亡 ⇒
//   跨会话的第二格编辑无映射来源。台账记录每格最近提交内容；规划器在门 2 失败时
//   按台账重建「当前 Core 文本 ↔ legacy 行文本」映射（位置内容证明背书）。
import { createTableCellEditLedger, type TableCellEditLedger } from "./binding/table-cell-edit-ledger";
import {
  establishCellAnchor,
  revalidateCellAnchor,
  type CellAnchor,
  type CellAnchorDerived,
} from "./binding/table-cell-anchor";
// ── F3B-6.28 · C：监测聚合（纯模块；只收枚举 reason + 计数，零正文；契约 §17）────
import {
  createCellMonitorState,
  recordCellMonitorEvent,
  isRecordingEnabled,
  evaluateStopThreshold,
  applyAutoStop,
  snapshotCellMonitor,
  type CellMonitorState,
} from "./binding/cell-monitor";
// ── F3B-6.27 · P0-D0 Slice 2：unit route 的唯一三段（adapter → plan → transaction）──
// ⚠️ 三者都是**已冻结的纯函数**；本文件**只做接线**，不重实现任何 offset / 事务规则。
//   · adapter：浏览器 input intent → EditingUnit mutation intent（零 DOM，接线时才取 DOM 选区）
//   · plan：unit 区间 + replacement → per-line Core 操作计划（separator 语义由它唯一判定）
//   · transaction：plan → UnitTransactionCommand（**1 条 history entry** 的全部机制）
import { toEditingUnitInputIntent } from "./binding/editing-unit-input-adapter";
import { planUnitMutationMulti } from "./binding/editing-unit-mutation-plan";
import { createUnitTransactionCommand } from "./binding/editing-unit-transaction";
// ── F3B-6.28 · B2/B3：受控 EditingUnit gate（resolver 驱动，替换显式注入为默认来源）──
//   ★ 2026-10-15（用户验收裁决：「修复段落编辑入口与逻辑段落模型之间的连接」）：
//   `__unitEditing` 缺省 **ON**（`!== false`）；显式 `=== false` = 紧急回滚到
//   单文本框路径（B4 冻结前行为）。契约与 __coreTextEditInput / __segmentCoreMigration /
//   __exportRedraw 一致（默认 ON + 显式 false 关闭）。
//   resolver 本身仍 fail-closed：confirmed 多行组才走 unit 路径；单行 / unknown /
//   定位失败 ⇒ 维持单段落路径（不漏合并、不错合并）。
import { resolveControlledUnitGate, collectLineFeatures } from "./binding/editing-unit-gate";
import { findTextBoxByParagraphId, findTextBoxBySourceLineId } from "./binding/editing-unit-resolver";
// ── F3B-6.28 · C2/C3：提交后受控渲染（受影响范围 + 显示层行计算）──
import { computeAffectedScope } from "./binding/affected-scope-contract";
import { computeCommittedClearRects, computeCommittedOverlay } from "./binding/committed-unit-overlay";
import { computeFlowLayout, type FlowLineInput, type FlowSuccessorInput } from "./binding/logical-paragraph-flow-layout";
// F3B-6.28 · D 第一阶段：位移清除计划（导出 drop 投影输入；仅身份，无几何）
import type { DisplacedClearPlan, DisplacedClearTarget } from "./binding/affected-source-projection";
import { changedLineIdsOfTransaction } from "./binding/affected-source-projection";
// F3B-6.28 · D-3B-5：重绘场景授权（仅 D1 段落末尾追加；纯判定）
import {
  classifyExportRedrawScenario,
  EXPORT_REDRAW_AUTHORIZED_SCENARIOS,
} from "./binding/export-redraw-scenario";
import { getParagraphText } from "./core/document/query";
import { createDiffedLineMetrics } from "./binding/diffed-line-metrics";
// layoutTextBox 已在上方 "./core/layout" 导入（360 行既有 import，勿重复）
// P0-E1 rebind（自带 Core layout；编辑后 / render source 不可用时的 unit 几何来源）
import { rebindEditingUnit } from "./binding/editing-unit-rebind";
// ── Reflow 4B-4D-2A · 三段纯函数（零 DOM；**只走已证明可用的 4A 路径**）─────
//   ⚠️ 本组**不引入** P0-E2-A 的 reflow 函数（P0-E2-A 冻结为零生产接线；守卫 E2-A8b 不动）。
//   ★ 注意：守卫 E2-A8b 是**朴素文本匹配**，因此此处刻意**不写出**那个函数名，
//     否则连注释也会被判定为「接线」。
//   4A TextLayout→CoreVisualLineGeometry · 4B-1 × EditingUnit→分组几何 · 4B-4A→unit全局 flow lines
import { projectCoreVisualLines } from "./binding/core-visual-line-geometry";
import { buildSurfaceVisualGeometry } from "./binding/editing-surface-visual-geometry";
import {
  buildLogicalLinePartition,
  type LogicalLinePartition,
} from "./binding/logical-line-partition";
// B2-1/2/3：docBlocks 写世代守卫（与 ExportSafetyGate 同一架构思想）
import { bumpDocBlocksGeneration, guardedDocBlocksUpdate, segBlockId } from "./binding/docBlocksWriteGuard";
// B3-C-5-E-B-B：Add Image → Core（ImageAsset → Registry → AddBlockCommand → Core History）
import { AddBlockCommand, DeleteObjectCommand, MoveObjectCommand, ResizeObjectCommand } from "./core/commands";
import type { EditorCommand } from "./core/commands/types";
import { imageAssetRegistry } from "./binding/image-asset-registry";
import { computeImageBlockGeometry } from "./binding/core-image-geometry";
import { commitImageToCore } from "./binding/core-image-add";
// STEP-2c-C1：Manual OCR → Core wiring（W3/W4 raw TextBlock[] → 2a normalize → 2b materialize → 2c-B commit）。
// 与 Image→Core 同 ownership seam；旧 `useOCR` setBlocks 路径在 C1 保留（duplicate 是已知风险，C2 解决）。
import { commitOcrDraftToCore } from "./binding/core-ocr-add";
import {
  normalizeOcrImportDraft,
  type OcrImportRawBlock,
} from "./binding/ocr-import-draft";
import { normalizedOcrDraftToCoreObjects } from "./binding/ocr-core-object-draft";
import { markAsProjection } from "./features/docBlocksProjectionMerge";
// STEP-2c-C2-A-Impl：post-import OCR 的 export bounds registry（与 Sidecar 同生命周期边界）
import { ocrExportBoundsRegistry } from "./binding/ocr-export-bounds";
// F3B-6.17-3C-10C.3B-0：Core Input Undo/Redo 路由（由 **ownership** 决定 Ctrl+Z/Ctrl+Y 走哪条栈）
import {
  coreDocumentParagraphTexts,
  createCoreInputHistoryTelemetry,
  decideUndoRedoRoute,
  recordUndoRedo,
  recordUndoRedoNoop,
  resolveUndoRedoOwner,
  type UndoRedoOwner,
} from "./binding/core-input-history";
// F3B-6.2：Debug/Telemetry 统一门控（默认全部关闭，不持有任何文档状态）
import {
  isTextEditAuditEnabled,
  isPerfMonitorEnabled,
  isRenderPatchDebugEnabled,
} from "./debug/debug-flags";
// F3B-6.3A：Sprint33 layout debug 簇（原 3846-5947）已抽离，依赖以显式 contract 注入
import { useLayoutDebugRegistry } from "./debug/layout-debug";
// F3B-6.3B：Sprint34.17–34.27 audit cluster（原 2681-3849）已抽离，11 个 useEffect 1:1 保留
import { useSprint34AuditDebugRegistry } from "./debug/sprint34-audit-debug";
// F3B-6.4B-2：Segment canonical commit（Segment → EditableDocument + OperationHistory）
import {
  SegmentSourcePositionLedger,
  sourceSegmentKey,
} from "./features/segmentPositionLedger";
import {
  commitSegmentToDocument,
  readSegmentCanonicalCommitFlag,
  unionGlyphInkBox,
} from "./features/segmentCommit";
// F3B-6.4B-P1-1：History mutation 后 render state（mask）的**再派生**判据（纯函数）
import { decideRenderStateResync } from "./features/renderStateResync";
// F3B-6.4B-P2-A-B：redo 的空行重建只从**既有** History inverse.beforeGlyphs 重新派生（不新增状态来源）
import type { InverseData } from "../document-model/document-mutation";
import type { EditorDocument } from "./core/document";
import { initializeCoreDocument } from "./binding/build-core-export-context";
import { CoreDocumentLifecycle } from "./binding/core-document-lifecycle";
// F3B-6.12：Binding Sidecar（per-import immutable PDF fidelity snapshot）
import type { BindingSidecar } from "./binding/binding-sidecar";
import {
  buildBindingSidecarFromOcr,
  buildBindingSidecarFromPdfNative,
} from "./binding/binding-sidecar-builder";
import {
  computeOperatorProvenance,
  type GlyphProvenance,
  type GlyphProvenanceInput,
} from "./binding/operator-provenance";
import { decideSidecarLifecycle } from "./binding/binding-sidecar-lifecycle";
// F3B-6.14：Core + Sidecar production reconciliation（保留 legacy fallback）
import { decideReconciliationPath } from "./binding/reconciliation-eligibility";
import {
  MASK_INK_PADDING,
  applyMaskPadding,
  calculateReconciliationGeometry,
  reconciliationRenderBox,
} from "./binding/reconciliation-geometry";
import {
  classifyRenderStateByOriginText,
  diffAffectedParagraphIds,
  extractAffectedBindingLines,
  resolveBindingReconciliationTarget,
} from "./binding/reconciliation-target";
import { createCoreLayoutCurrentGeometryProvider } from "./binding/core-layout-current-geometry";
import { createFontMetricsProvider } from "./core/layout/metrics";
import { layoutTextBox } from "./core/layout";
// F3B-6.17 阶段二：Segment → Core Command 门控迁移（方案 A，默认 OFF）
// 注：createCoreInputSessionFromDocument 已由上方 "./binding" barrel 导入，此处**不再重复导入**
//     （重复导入会让 dev transform 抛 TS2300 → 整个 /editor 路由 500，应用无法 mount）
import { createSegmentCoreCommand } from "./binding/segment-core-command";
import { resolveSegmentToCoreRange } from "./binding/segment-core-range";
// F3B-6.17-3C-10S.3B-1：Canonical Selection production sink（双轨 selection 的第二条链）
//   DOM Selection → CanonicalSelection → canonicalSelectionStoreRef → CanonicalSelectionProvider
//   旧链（GlyphRenderer → DerivedSelection → currentDerivedSelectionRef）**完全不动**。
import { createCanonicalSelectionStore, type CanonicalSelectionStore } from "./binding/canonical-selection-sink";
import { publishDomSelection } from "./binding/production-selection-adapter";
import { findSegmentElement } from "./binding/dom-selection-shadow";
// F3B-6.27 · P0-VPS 最小第一步：「拖选跨行」范围的**纯判定**（只读，不建面、不 mutation）
import {
  resolveCrossLineRange,
  resolveCrossLineRangeFromSet,
} from "./binding/cross-line-selection-range";
// F3B-6.27 · P0-VPS（D1'）：显式多选集合的只读读取（拖选/Shift+点击已被证伪，见 multi-selection.ts）
import { getMultiSelectedSegmentIds, subscribeMultiSelection } from "./components/multi-selection";
// F3B-6.17-3C-10C.2：TextEdit Input Shadow（**只读观察**，默认关闭；绝不提交 Command）
import {
  createTextEditShadowRecorder,
  type TextEditLegacyRangeModel,
  type TextEditShadowRecorder,
} from "./binding/text-edit-input-shadow";
// F3B-6.17-3C-10C.3A：提交投影（中立层）+ TextEdit → Core commit 规划器
import { projectLegacyLineEdit, type LegacyLineEditProjection } from "./binding/text-edit-session-projection";
import {
  planTextEditCoreCommit,
  readCoreTextEditInputFlag,
  type TextEditCoreCommitInput,
  type TextEditCoreCommitPlan,
} from "./binding/text-edit-core-commit";
import {
  resolveLineToCoreTarget,
  createTextEditCoreCommand,
  resolveCoreLineText,
  coreLineGlyphs,
} from "./binding/text-edit-core-range";
import type { TextEditInputRequest } from "./binding/text-edit-input-adapter";
import {
  createSegmentCoreTelemetry,
  decideSegmentCommitPath,
  readSegmentCoreMigrationFlag,
  shouldAttemptCoreExport,
  type ExportOwnership,
  type SegmentFallbackReason,
} from "./binding/segment-core-commit";
import { createCaret, createCollapsedSelection, createSelection, paragraphOffsetToPosition } from "./core/position";
import {
  clampOffsetToParagraph,
  extendSelectionWithinParagraph,
  stepCaretWithinParagraph,
} from "./binding/core-caret-navigation";
// F3B-6.27 实现 checkpoint：per-segment range ownership + transaction snapshot ledger
//   ⚠️ 本批改动必须与 base/caret 换算**同一 commit** 落地，禁止拆分（拆分会产生 double-base）。
import {
  buildLineOwnership,
  domOffsetToParagraphOffset,
  paragraphOffsetToDomOffset,
  segmentBaseOf,
  sliceTextFor,
  segmentRangeMatchesParagraph,
  type SegmentRangeSeed,
} from "./binding/segment-range-session";
import {
  commitTransaction,
  createLedger,
  redoTransaction,
  undoTransaction,
  type SegmentRangeLedger,
} from "./binding/segment-range-ledger";
import type { SegmentRangeOwnership } from "./binding/segment-range-ownership";
// ★ F3B-6.27：提交收口需要 ownership 的**完整区间**（不只 base）
import { segmentRangeOf } from "./binding/segment-range-ownership";
import { findTextBox, findParagraph, getParagraphLength } from "./core/document/query";
// EDITOR-CORE-012-E2（方案 B）：Core 编辑期视觉反馈
//   · core-input-visual       : 声明「哪个 segment 的 DOM 文本让位于 Core glyph 层」（E2.1）
//   · core-editing-geometry   : CaretGeometry / SelectionGeometry → 既有 UI 层形状（E2.3/E2.4）
// ★ F3B-6.27：`segmentCommitContextFor` 供 EditableTextNode 的 blur 收口消费；
//   authority 仍是 Binding 的 `segmentRangeOf`（store 只是 transport）。
import {
  setCoreInputVisualState,
  type SegmentCommitContext,
} from "./components/core-input-visual";
import {
  coreCaretLayerPosition,
  coreSelectionQuads,
} from "./components/core-editing-geometry";
import type { CaretGeometry as CoreCaretGeometry, SelectionGeometry as CoreSelectionGeometry } from "./core/layout";
import { getViewRenderingMode } from "../document-model/view-mode";
// M7.7-004U-EditStyle：扫描件字体检测结果类型（运行时模块在 OCR 注入处动态 import）
import type { FontDetectionResult } from "../document-model/font-detector";
// M7.7-IMPLEMENT-004(a)：字体身份贯通 —— PDFEditor 浏览器 import 路径也建立
//   glyph.metrics.fontIdentity（此前仅 pdf-importer 传 pageMetrics，浏览器侧缺失 → Native 路径永不就绪）。
import { parsePdfFontMetrics, type PageFontMetrics } from "../document-model/pdf-font-metrics";
// M7.7-004A: Native 替换触发链路 —— edit commit 后验证原生替换 + 标记 nativeReady
//   （export 侧 exportDocumentNativeFirst 依据这些 ready 状态做真实 Tj/TJ 改写）
import { attemptNativeReplaceForLine } from "../document-model/native-batch-replace";
import { applyNativeReplacementResult } from "../document-model/native-replacement-state";
// Task-013B: 当前 DerivedSelection（Provider 消费）
import type { DerivedSelection } from "../document-model/selection-engine";
import { FidelityDebugPanel } from "./components/FidelityDebugPanel";
import { recordWorkspaceEvent } from "./components/workspace-telemetry";
// Sprint 32: Text Block Extraction
import { buildTextBlocks, type TextBlockInfo } from "../document-model/text-block-extraction";
import type { SignatureReplacement } from "../document-model/signature-replacement-model";
import type { SignatureCompositeRegion } from "../document-model/signature-composite-region";
import { signatureSuppression, publishSignatureRenderDebug } from "../document-model/signature-suppression-manager";
import type { CleanBackgroundPatch, BackgroundRemovalDebug } from "../document-model/background-text-remover";
import { produceTypographyMetrics } from "../document-model/typography-producer";
// Feature hooks (Commit 3)
import { useOCR } from "./features/useOCR";
import { usePageOps } from "./features/usePageOps";
// C-6-B：Core dirty 唯一纯判定（Page Ops 硬阻断）+ 阻断 Toast
import { isCoreDocumentDirty } from "./binding/core-document-dirty";
import { showToast } from "./features/toast";
import { useExport } from "./features/useExport";
import { usePayment } from "./features/usePayment";
import { useInlineTools } from "./features/useInlineTools";
import { useI18n } from "../i18n/I18nProvider";

pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_SRC;

// ── Debug: PDFEditor render counter (module-level) ──
let pdfEditorRenderCount = 0;

/**
 * M5-003C-UI Delete Integration: 计算被删 glyph range（单段删除 diff）。
 * orig = 原整行文本，edited = 编辑后文本（orig 删除一段连续字符）。
 * 用最长公共前缀 + 最长公共后缀定位被删区间 [start, end]（含 end，行内 index）。
 * 非单段删除（不符）→ 返回 null（调用方走默认 replace 语义）。
 */
function findDeletedGlyphRange(
  orig: string,
  edited: string
): { start: number; end: number } | null {
  const o = Array.from(orig);
  const e = Array.from(edited);
  // 最长公共前缀
  let prefix = 0;
  while (prefix < o.length && prefix < e.length && o[prefix] === e[prefix]) prefix++;
  // 最长公共后缀
  let suffix = 0;
  while (
    suffix < o.length - prefix &&
    suffix < e.length - prefix &&
    o[o.length - 1 - suffix] === e[e.length - 1 - suffix]
  ) suffix++;
  const removedStart = prefix;
  const removedEnd = o.length - suffix - 1; // 含 end
  if (removedStart > removedEnd) return null; // 无删除（纯替换/插入，非 delete）
  // 校验：edited 必须 = o[0..prefix) + o[removedEnd+1..)，否则非单段删除
  const expected = o.slice(0, prefix).concat(o.slice(removedEnd + 1));
  if (JSON.stringify(expected) !== JSON.stringify(e)) return null;
  return { start: removedStart, end: removedEnd };
}

/**
 * M5-003C-UI: 从 EditableDocument 读取指定行完整文本（glyph identity → 行文本）。
 * 供 replace-selection → text-edit 转换（ADR-048）注入 document context 使用。
 * 找不到 block/line → 返回 null。
 */
function getLineText(
  doc: EditableDocument | null | undefined,
  blockId: string,
  lineId: string
): string | null {
  if (!doc) return null;
  const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!block) return null;
  const line = block.lines.find((l) => l.id === lineId);
  if (!line) return null;
  return line.glyphs.map((g) => g.char).join("");
}

/**
 * F3B-6.17-3C-10C.2：把真实按键映射为 Adapter 的 request（**仅供 Shadow 观察**）。
 *
 * 未建模的导航键（Arrow / Home / End / Ctrl+A）返回**未经 contract 建模**的 kind，
 * 让 Adapter 明确判 `unsupported-operation` —— 这正是 Shadow 要观察的真实事实
 * （**不**在 Shadow 里把它们描述成有效输入）。
 */
function shadowRequestForKey(e: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}): TextEditInputRequest {
  if (e.key === "Backspace") return { kind: "delete-backward" };
  if (e.key === "Delete") return { kind: "delete-forward" };
  if (e.key === "Enter") return { kind: "insert-paragraph" };
  const unsupported = (tag: string): TextEditInputRequest =>
    ({ kind: tag }) as unknown as TextEditInputRequest;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") return unsupported("arrow-navigation");
  if (e.key === "Home" || e.key === "End") return unsupported("line-navigation");
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) return unsupported("select-all");
  if ((e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1) return unsupported("modifier-combo");
  return { kind: "insert-text", text: e.key };
}

/**
 * M7.7-004D: 扫描 canvas 得到编辑行"真实文字覆盖范围"。
 *
 * 背景：编辑框/mask 宽度取自 OCR glyph 墨迹包围盒，但墨迹盒比 pdf.js 实际渲染的文字窄
 * （original.pdf L0 墨迹盒到 doc x=755，canvas 实际渲染到 x≈823）→ 编辑框"短"，行尾原文露出。
 * 这里直接扫描 canvas 在编辑行带的暗像素，得到用户真正看到的文字左/右缘，作为扩展依据。
 *
 * M7.7-004R 升级（容忍坐标失配）：旧实现用"模型行 y 中间 50% 高度"作扫描带——一旦 OCR 模型坐标
 * 与 canvas 实际渲染出现垂直偏移（resize/zoom 后模型坐标保持 OCR 时的 scale，canvas 重新渲染在
 * 当前 scale），扫描带落在空白行 → 返回 null → 编辑框回退到窄墨迹盒（用户截图中"编辑框短、行尾
 * 原文露出"）。新实现改为：在模型行附近的宽窗内做垂直行带检测，按"距模型行中心最近、近平局取更
 * 宽"选取真正文字行，再量其 x 范围 —— 对偏移/缩放失配鲁棒。
 *
 * @param canvas  z0 的 pdf.js canvas
 * @param glyphEl data-layer="glyph" 容器（Document/CSS 坐标参照系）
 * @param lineBox 编辑行 glyph 并集 bbox（用于定位搜索窗，不要求与 canvas 完全对齐）
 * @returns 真实文字范围（glyph 容器相对坐标）；扫不到（无暗像素）返回 null
 */
function measureCanvasLineTextExtent(
  canvas: HTMLCanvasElement,
  glyphEl: HTMLElement,
  lineBox: { x: number; y: number; width: number; height: number },
): { left: number; right: number; top: number; bottom: number } | null {
  const cr = canvas.getBoundingClientRect();
  const gr = glyphEl.getBoundingClientRect();
  const ctx = canvas.getContext("2d");
  if (!ctx || cr.width <= 0 || cr.height <= 0 || gr.width <= 0 || gr.height <= 0) return null;

  // M7.7-004Z (Bug1/2/3 根因): 浏览器**页面级 zoom** ≠ 100% 时，getBoundingClientRect 返回**屏幕/缩放**坐标，
  // 而 lineBox（Document/CSS 坐标）与 clientWidth 是**未缩放**的布局坐标。两者比值即 browser zoom。
  // 若不做转换，measureCanvasLineTextExtent 产出的 left/top/width/height 会比实际大 zoom 倍 →
  //   Bug3 编辑框定位远离原文本/过宽；
  //   编辑框过宽 → 点击文本末尾落在空位 → DOM caret 落在中间 → Bug1 输入插到中间；
  //   坐标污染 commit/mask → 新文本未保存到正确位置、样式错位 → Bug2。
  // 修法：以 canvas 布局宽（clientWidth，不含 zoom）与屏幕宽（getBoundingClientRect）之比作为 zoom 因子，
  // 所有 doc↔canvas px 转换统一除以 browserZoom，使返回值恒处于 Document（未缩放）空间。
  const browserZoom = canvas.clientWidth > 0 ? cr.width / canvas.clientWidth : 1;
  const z = browserZoom > 0.01 ? browserZoom : 1;

  const lineW = lineBox.width;
  const lineH = lineBox.height;
  // 水平搜索范围：模型行左缘 -8 ~ 右缘 + max(80, 宽×0.5)。容纳 canvas 实际渲染比墨迹盒宽 ~18%，
  // 又不会扫到右侧远处另一栏文字。（lineBox.x 为 Document 坐标 → 乘 z 转屏幕再转 canvas px）
  const scanX0 = Math.max(0, Math.floor(((gr.left + lineBox.x * z - 8 - cr.left) / cr.width) * canvas.width));
  const scanX1 = Math.min(canvas.width - 1, Math.ceil(((gr.left + (lineBox.x + lineW) * z + Math.max(80, lineW * 0.5) - cr.left) / cr.width) * canvas.width));
  if (scanX1 <= scanX0) return null;

  // doc（glyph 容器，未缩放 Document 坐标）↔ canvas px：
  //   doc→px：doc 偏移 × z → 屏幕偏移 → / cr 尺寸 → × canvas
  //   px→doc：(px / canvas) × cr 屏幕尺寸 → / z → Document 偏移
  const docToPy = (dy: number) => Math.round(((gr.top + dy * z - cr.top) / cr.height) * canvas.height);
  const toDocX = (px: number) => ((px / canvas.width) * cr.width) / z;
  const toDocY = (py: number) => ((py / canvas.height) * cr.height) / z;

  // 垂直搜索窗：容忍 OCR 模型 y 与 canvas 实际行的偏移/缩放失配。
  // M7.7-012A: 去掉 lineBox.y * 0.35 项，因其在页面下方行时 padV 过大（如 y=573 时 padV=200px），
  // 导致扫描窗口包含相邻行，选错墨水带 → mask 位置错误、原文露出/被遮。
  // 改用 lineH * 3（约 50px）+ 60px 固定缓冲，足以覆盖 ascender/descender 而不含相邻行。
  const padV = Math.max(lineH * 3, 60);
  const modelYMid = lineBox.y + lineH / 2;
  const sy0 = Math.max(0, docToPy(lineBox.y - padV));
  const sy1 = Math.min(canvas.height - 1, docToPy(lineBox.y + lineH + padV));
  if (sy1 <= sy0) return null;

  const w = scanX1 - scanX0 + 1;
  const h = sy1 - sy0 + 1;
  const data = ctx.getImageData(scanX0, sy0, w, h).data;
  // 聚合文字行带（每行暗像素 > 2 视为有字，连续行合并为一带）
  const bands: { y0: number; y1: number; first: number; last: number }[] = [];
  let cur: { y0: number; y1: number; first: number; last: number } | null = null;
  for (let y = 0; y < h; y++) {
    const base = y * w;
    let first = -1, last = -1, cnt = 0;
    for (let x = 0; x < w; x++) {
      const i = (base + x) * 4;
      const r = data[i], gg = data[i + 1], b = data[i + 2];
      if (r < 170 && gg < 170 && b < 170) { if (first < 0) first = x; last = x; cnt++; }
    }
    if (cnt > 2) {
      if (!cur) cur = { y0: sy0 + y, y1: sy0 + y, first: scanX0 + first, last: scanX0 + last };
      else { cur.y1 = sy0 + y; cur.first = Math.min(cur.first, scanX0 + first); cur.last = Math.max(cur.last, scanX0 + last); }
    } else if (cur) { bands.push(cur); cur = null; }
  }
  if (cur) bands.push(cur);
  if (bands.length === 0) return null;

  // 排除极窄噪点带（< 12 canvas px）；若全被排除则退而求其次用全部带
  const meaningful = bands.filter((b) => (b.last - b.first) >= 12);
  const pool = meaningful.length > 0 ? meaningful : bands;

  // 选带：y 中心最接近模型行中心者胜出；差距 ≤ 0.3×行高（canvas px）的近平局取更宽者
  // （真正的文字行通常比邻行/墨迹盒更宽，且与模型行垂直最近）。
  // lineH 是 Document 坐标 → × z 转屏幕 → ×(canvas.height/cr.height) 转 canvas px。
  const tie = lineH * z * 0.3 * (canvas.height / cr.height);
  const modelPy = docToPy(modelYMid);
  let best = pool[0];
  let bestDist = Infinity, bestW = -1;
  for (const b of pool) {
    const dist = Math.abs((b.y0 + b.y1) / 2 - modelPy);
    const bw = b.last - b.first;
    if (dist < bestDist - tie || (Math.abs(dist - bestDist) <= tie && bw > bestW)) {
      best = b; bestDist = dist; bestW = bw;
    }
  }
  // M7.7-004W: left/right 取「与模型行左缘对齐的文字段」，而非整带极值/模型中心。
  // 背景：① 模型行 bbox 可能按 ~2x 横向放大（OCR 坐标失配，m77-004z：b0.L0 模型 686px vs
  //        canvas 墨迹 349px）→ 模型中心 x 不可信，落在真实文本右端，按中心选段只取到行尾碎片。
  //       ② best band 可能横向包含同排其他块/行的文字（如签名行右侧日期 "2026"）→ 整带极值过宽。
  // 做法：把 best band 的墨迹列按 x 间隙分段，段内允许 ≤16 列间隙（字符间距+词间距，
  //       m77-004z 实测字符间隙 1-8px），段间空隙 >16 列才切分（同排其他块/日期通常相距 ≥40px）。
  //       选「与模型行左缘对齐」的段：优先取与 [modelX0-20, modelX0+20] 相交的最大段
  //       （模型 x0 与墨迹左缘一致，误差 ~5px）；无相交段则取左缘距 modelX0 最近段。
  const modelX0Px = ((gr.left + lineBox.x * z - cr.left) / cr.width) * canvas.width;
  const colDark = new Uint8Array(w);
  for (let y = best.y0; y <= best.y1; y++) {
    const base = (y - sy0) * w;
    for (let x = 0; x < w; x++) {
      const i = (base + x) * 4;
      if (data[i] < 170 && data[i + 1] < 170 && data[i + 2] < 170) colDark[x] = 1;
    }
  }
  // 分段：连续暗列为一文字段；段内允许 ≤16 列间隙（字符/词间距），段间空隙 >16 列才切分。
  const segs: { s: number; e: number }[] = [];
  {
    const MAX_GAP = 16;
    let cs = -1, lastDark = -10;
    const flush = (end: number) => { if (cs >= 0 && lastDark - cs + 1 >= 2) segs.push({ s: cs, e: lastDark }); cs = -1; };
    for (let x = 0; x <= w; x++) {
      const on = x < w && colDark[x] === 1;
      if (on) {
        if (cs < 0 || x - lastDark > MAX_GAP) flush(lastDark);
        if (cs < 0) cs = x;
        lastDark = x;
      } else if (cs >= 0 && x - lastDark > MAX_GAP) {
        flush(lastDark);
      }
    }
    flush(lastDark);
  }
  let pick: { s: number; e: number } | null = null;
  if (segs.length > 0) {
    const nearLeft = segs.filter((sg) => {
      const segX0 = scanX0 + sg.s, segX1 = scanX0 + sg.e;
      return segX0 <= modelX0Px + 20 && segX1 >= modelX0Px - 20;
    });
    if (nearLeft.length > 0) {
      pick = nearLeft.reduce((a, b) => (b.e - b.s > a.e - a.s ? b : a));
    } else {
      pick = segs.reduce((a, b) =>
        Math.abs(scanX0 + b.s - modelX0Px) < Math.abs(scanX0 + a.s - modelX0Px) ? b : a
      );
    }
  }
  if (!pick) return null;
  const segLeft = scanX0 + pick.s;
  const segRight = scanX0 + pick.e;
  // 垂直范围：以 best band 中心为锚，扫描 ±0.9×行高内所有暗像素的 y 极值。
  // 背景：同一行文字墨迹可能因字符间空隙/浅色部分被切成多个 band（M7.7-004X 实测
  //       b0 墨迹 159..207 被切成多段），仅遍历 best band 只得到 ~14px 高底色 → mask
  //       高度不足 → 编辑行底部露出原文（Bug2）。
  // 修法：以 best band 中心扩展 ±0.9×行高（≥12 canvas px）扫描，x 限制在选中文字段
  //       （segLeft..segRight，避免同排其他块文字污染 y 极值）。
  const maxDistY = Math.max(12, lineH * z * 0.9 * (canvas.height / cr.height));
  const centerBandY = (best.y0 + best.y1) / 2;
  const xL = Math.max(0, segLeft - scanX0), xR = Math.min(w - 1, segRight - scanX0);
  let inkMinY = sy1, inkMaxY = sy0;
  for (let y = 0; y < h; y++) {
    const absY = sy0 + y;
    if (Math.abs(absY - centerBandY) > maxDistY) continue;
    const base = y * w;
    let cnt = 0;
    for (let x = xL; x <= xR; x++) {
      const i = (base + x) * 4;
      if (data[i] < 170 && data[i + 1] < 170 && data[i + 2] < 170) cnt++;
    }
    if (cnt > 0) { if (absY < inkMinY) inkMinY = absY; if (absY > inkMaxY) inkMaxY = absY; }
  }
  const ret = {
    left: toDocX(segLeft),
    right: toDocX(segRight),
    top: toDocY(inkMinY),
    bottom: toDocY(inkMaxY),
  };
  if (typeof console !== "undefined") {
    console.log(
      `Sprint34.7.1_MASKMISS lineW=${lineW.toFixed(1)} lineH=${lineH.toFixed(1)} inBox=[x=${lineBox.x.toFixed(1)},y=${lineBox.y.toFixed(1)},h=${lineBox.height.toFixed(1)}] modelYMid=${(lineBox.y + lineH / 2).toFixed(1)} sy0=${docToPy(lineBox.y - padV)} sy1=${docToPy(lineBox.y + lineH + padV)} centerBand=${(sy0 + centerBandY).toFixed(0)} maxDistY=${maxDistY.toFixed(1)} inkY=[${inkMinY},${inkMaxY}] ret=[top=${ret.top.toFixed(1)},bottom=${ret.bottom.toFixed(1)},h=${(ret.bottom - ret.top).toFixed(1)}]`,
      "color:#f59e0b;font-weight:bold;",
    );
  }
  return ret;
}

// ═══════════════════════════════════════════════════════════════════════════
//  F3B-6.27 · CARET-LANDING (c)/(d)：unit 面的 caret 坐标映射（**纯函数**，无状态）
//
//  ★ 实施前只读检查（2026-10-18）已确认的三条前提：
//    ① 权威映射 = 既有 P0-A `unitOffsetToParagraphOffset` / `paragraphOffsetToUnitOffset`
//       （`./binding/editing-unit.ts`，已有单测与 round-trip 覆盖）⇒ 此处只做**接线**，
//       不新造算法、不复用「上一次 Core caret 的 paragraphId」。
//    ② DOM offset 空间 ≡ unit 文本 offset 空间（实测：分隔符恒占 1 字符；
//       首开 / 编辑后 / 提交后 / 重开 各相位 `textContent.length === p43 + 1 + p46`）。
//    ③ paragraph ↔ line 为 **1:1**（`buildEditingUnit` 强制，`duplicate-paragraph-id`
//       即失败）⇒ `paragraphId → lineId` 是**确定性查表**，不是猜测。
//
//  ★ 失败语义（硬停止条件的运行时形态）：一律 **fail-closed + 有界诊断**；
//    **绝不**猜测段落、**绝不**回退 base 0、**绝不**把 separator 边界归给相邻段落。
// ═══════════════════════════════════════════════════════════════════════════

/** 映射失败诊断（**有界**：同 reason 仅首次变化时打印，计数聚合供探针读取） */
function noteCaretMappingFailure(where: string, reason: string, ctx?: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  const w = window as unknown as {
    __caretMappingFailures?: Record<string, number>;
    __caretMappingLastKey?: string;
  };
  w.__caretMappingFailures = w.__caretMappingFailures ?? {};
  const key = `${where}:${reason}`;
  w.__caretMappingFailures[key] = (w.__caretMappingFailures[key] ?? 0) + 1;
  if (w.__caretMappingLastKey !== key) {
    w.__caretMappingLastKey = key;
    console.warn(`[F3B-6.27][CARET-MAP] ${where} fail-closed: ${reason}`, ctx ?? {});
  }
}

/**
 * (d)：Core caret 的 `(paragraphId, localOffset)` → unit offset。
 * `paragraphId` 必须能**唯一**映射到当前 unit 的一条 line（1:1），否则显式失败。
 */
function mapCoreCaretToUnitOffset(
  unit: EditingUnit,
  paragraphId: string | null | undefined,
  localOffset: number
): { ok: true; unitOffset: number } | { ok: false; reason: string } {
  if (!paragraphId) return { ok: false, reason: "no-paragraph-id" };
  const line = unit.lines.find((l) => l.paragraphId === paragraphId);
  if (!line) return { ok: false, reason: "paragraph-not-in-unit" };
  const r = paragraphOffsetToUnitOffset(unit, line.lineId, localOffset);
  return r.ok ? { ok: true, unitOffset: r.unitOffset } : { ok: false, reason: r.reason };
}

/**
 * (c)：unit 面的 DOM offset（≡ unit offset）→ Core caret options。
 * offset 落在 **separator**（`boundary-not-in-paragraph`）或**越界**时显式失败，
 * 不归给相邻段落；段落内越界由既有确定性规则 `clampOffsetToParagraph` 收敛（G9 同口径）。
 */
function seedCaretOptionsForUnit(args: {
  readonly unit: EditingUnit;
  readonly document: EditorDocument;
  readonly domOffset: number;
}):
  | { ok: true; options: NonNullable<ReturnType<typeof coreCaretForSegmentParagraph>> }
  | { ok: false; reason: string } {
  const at = unitOffsetToParagraphOffset(args.unit, args.domOffset);
  if (!at.ok) return { ok: false, reason: at.reason };
  const clamped = clampOffsetToParagraph({
    document: args.document,
    paragraphId: at.paragraphId,
    offsetUtf16: at.localOffset,
  });
  if (clamped === null) return { ok: false, reason: "clamp-null" };
  const options = coreCaretForSegmentParagraph(args.document, at.paragraphId, clamped);
  if (!options) return { ok: false, reason: "caret-build-failed" };
  return { ok: true, options };
}

export default function PDFEditor() {
  // M7.7-007B: 翻页前 commit 当前编辑会话的守卫 ref。
  // 值在 PDFEditorInner 中设置（requestEditTransition），
  // 通过 EditorProvider → useDocument 使所有 setPage 调用（缩略图/prev/next/usePageOps）都先 commit。
  const pageChangeGuardRef = useRef<(() => void) | null>(null);

  return (
    <EditorProvider beforePageChangeRef={pageChangeGuardRef}>
      <PDFEditorInner pageChangeGuardRef={pageChangeGuardRef} />
    </EditorProvider>
  );
}
// ── 🎨 重新设计的矢量 Logo 组件 ──
export function PdfAideLogo({ size = 36 }: { size?: number }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      {/* 图标：暗蓝紫渐变底座 + 立体高光星芒 */}
      <div
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.28,
          background: "linear-gradient(135deg, #3b0764 0%, #1e1b4b 50%, #0f172a 100%)",
          border: "1px solid rgba(192, 132, 252, 0.3)",
          boxShadow: "0 0 20px rgba(139, 92, 246, 0.35), inset 0 1px 1px rgba(255,255,255,0.2)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          position: "relative",
          overflow: "hidden",
        }}
      >
        <svg
          width={size * 0.62}
          height={size * 0.62}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="starGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#e0e7ff" />
              <stop offset="100%" stopColor="#a855f7" />
            </linearGradient>
            <filter id="starGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="1" floodColor="#c084fc" floodOpacity="0.8" />
            </filter>
          </defs>
          {/* 四角/五角星芒形状 */}
          <path
            d="M12 2L14.5 9.5L22 12L14.5 14.5L12 22L9.5 14.5L2 12L9.5 9.5L12 2Z"
            fill="url(#starGrad)"
            filter="url(#starGlow)"
          />
        </svg>
      </div>

      {/* 文字标：PDF + AIDE 双色渐变 */}
      <span
        style={{
          fontSize: size * 0.65,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          fontFamily: "Inter, system-ui, sans-serif",
          lineHeight: 1,
        }}
      >
        <span style={{ color: "#a855f7" }}>PDF</span>
        <span
          style={{
            background: "linear-gradient(135deg, #a855f7 0%, #38bdf8 100%)",
            WebkitBackgroundClip: "text",
            WebkitTextFillColor: "transparent",
            marginLeft: 1,
          }}
        >
          aide
        </span>
      </span>
    </div>
  );
}

function PDFEditorInner({ pageChangeGuardRef }: { pageChangeGuardRef: React.MutableRefObject<(() => void) | null> }) {
  // All editor state unified via useEditor() (Commit 1 / Step 7)
  const {
    // document
    page, setPage,
    totalPages, setTotalPages,
    pdfDoc, setPdfDoc,
    fileName, setFileName,
    thumbnails, setThumbnails,
    thumbnailCol, setThumbnailCol,
    renderThumbnails,
    // selection
    docBlocks, setDocBlocks,
    textItems, setTextItems,
    showTextLayer, setShowTextLayer,
    selectedBlockId, setSelectedBlockId,
    editingBlock, setEditingBlock,
    ocrSelect, setOcrSelect,
    selectedText, setSelectedText, pendingEdit, setPendingEdit,
    saveStatus, setSaveStatus,
    setBlocks,
    // Commit 5: segments
    segments, setSegments, editingSegmentId, setEditingSegmentId, handleSegmentChange,
    // F3B-6.4B-3：canonical commit 成功后对账（由 Segment state owner 执行）
    reconcileSegmentCommit,
    // F3B-6.28-F（第六刀阶段 2）：Core undo/redo 后 segments 呈现态同步（owner 原语）
    resyncSegmentPresentationToCore,
    // M7.8-020-PROD: 跨页编辑持久化
    applySegmentEdits, clearSegmentEdits,
    // M7.8-041: 跨页 segment 累积（导出专用）
    segmentsByPageRef, getAllPageSegments,
    // tool
    textFormat, setTextFormat,
    highlightFormat, setHighlightFormat,
    annoFormat, setAnnoFormat,
    showSignature, setShowSignature,
    addingType, setAddingType,
    showFindReplace, setShowFindReplace,
    // workspace
    workspaceMode, showIntentModal, wsAction, wsHints, wsActionsDone, wsShowFlow,
    setWorkspaceMode, setShowIntentModal, setWsAction, setWsHints, setWsActionsDone, setWsShowFlow,
    generateLocalHints,
    // operation (V12 移植合并: processing/pay 状态 + 本项目保留的选项弹窗/完成弹窗状态)
    processingTool, setProcessingTool, processingLog, setProcessingLog,
    ocrBusy, setOcrBusy, showPayModal, setShowPayModal,
    setShowCompressOptions, setShowSplitOptions,
  } = useEditor();
  const { t } = useI18n();
  const navigate = useNavigate();

  // B2-B：只读暴露 docBlocks 供 e2e 观测投影/authored 块（observability hook，非生产逻辑，对齐 __editableDocument 体系）
  useEffect(() => {
    (window as any).__docBlocks = () => docBlocks;
  }, [docBlocks]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  /**
   * ★ 2026-10-23（用户缺陷「编辑后整页文本重影」）：**当前生效的 canvas 渲染任务**。
   *   编辑每提交一个字符 ⇒ `editableDocVersion++` ⇒ 主渲染 effect 重跑；旧实现只设
   *   `done` 标志（阻止后续逻辑）但**不取消 pdf.js renderTask** ⇒ 多个 render 并发
   *   画同一 canvas（`canvas.width=` 清空与异步 render 交错）⇒ 双绘 ⇒ 整页文本顶层
   *   ~2px 重影（实测：隐藏所有 span 后重影仍在 ⇒ 纯 canvas 层；未编辑基线无重影）。
   *   修复 = 重绘前、cleanup 时都 cancel 前序任务（pdf.js 标准用法）。
   */
  const canvasRenderTaskRef = useRef<{ cancel: () => void; promise: Promise<unknown> } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const coordRef = useRef<LockCoordSystem | null>(null);
  const dragRef = useRef<{ id: string; ox: number; oy: number; ox0: number; oy0: number; generation: number } | null>(null);
  const resizeRef = useRef<{ id: string; startX: number; startY: number; initW: number; initH: number; generation: number } | null>(null);
  const cssScaleRef = useRef(1); // canvas.clientWidth / canvas.width
  const canvasRenderedRef = useRef(false); // 标记渲染 effect 已设置正确的 cssScale
  // Sprint-109 (First Paint): Offscreen 底图 + Atomic Swap
  // pdf.js 渲染到 OffscreenCanvas（隐藏），scene.ready 后再 drawImage 到可见 canvas（原子替换）
  const offscreenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneReadyRef = useRef(false);
  const expectedSceneRef = useRef<any>(null); // Sprint-112: Expected Scene（来自 pdf.js Raw Inventory）
  const pdfBytesRef = useRef<ArrayBuffer | null>(null);
  const pdfLibDocRef = useRef<PDFDocument | null>(null);
  // M7.7-IMPLEMENT-004(a)：每页 PDF 原生字体度量（pageIndex 与 pdf.js 页序一致）。
  //   供 pdfLinesToEditableBlock 建立 glyph.metrics.fontIdentity / 真实逐字符 advance。
  const pageFontMetricsRef = useRef<ReturnType<typeof parsePdfFontMetrics> | null>(null);
  // F3B-6.23-C-Impl-4：drag/resize 已无 docBlocks-level undo（PatchBlocksCommand 路径已删），
  // 原 dragStartBlocksRef snapshot（供 push 进 CommandHistory）一并退出。
  // Commit 4+: 加载完成后的引导弹框
  const [showPostLoadModal, setShowPostLoadModal] = useState(false);
  // OCR 流程：来自 /ocr-result 的 task ID + 首次"Click any text to edit"引导
  const [ocrTaskId, setOcrTaskId] = useState<string | null>(null);
  const [showOcrHint, setShowOcrHint] = useState(false);
  const ocrBlocksInjectedRef = useRef(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  // Issue-003 (P0, Release QA): PDF 加载失败错误状态 —— 坏 PDF 不再无限 Loading
  const [pdfError, setPdfError] = useState<string | null>(null);
  // Sprint-109 (First Paint): 唯一 Reveal Gate —— scene.ready
  // 只有 scene.ready === true 时，z0 底图 + z30 编辑层才一次 Reveal（Atomic Swap），
  // 消灭 "原文→编辑层" 中间态。History/Selection 为 Lazy，不参与 Gate。
  const [sceneReady, setSceneReady] = useState(false);
  // Sprint-126 Task-3 (PM 拍板): 拆 Reveal Gate 为两态。
  //   sceneReadyBase: z0 底图 reveal（Physical 层）—— bitmapValid（底图渲染成功）即置位，
  //                   不等 Completeness，让扫描件先显示完整底图（Fallback = Bitmap Only）。
  //   sceneReady (原): z30 编辑层 reveal（Semantic 层）—— 维持 Completeness 判定（Scene 完整才显示 OCR 文本）。
  //   文本 PDF: 两者同时 true（Completeness 完整）→ 行为不变。
  //   扫描件 f8c295c7: sceneReadyBase=true（立即），sceneReady=false（Completeness 因 image 缺失不完整）→ z0 显示、z30 隐藏。
  const [sceneReadyBase, setSceneReadyBase] = useState(false);
  // Sprint-127 (唯一 Mission): Bitmap Runtime state —— PDFEditor 只消费 bitmapState.visible，不实现判定
  const [bitmapState, setBitmapState] = useState<BitmapRuntimeState>(BITMAP_INITIAL_STATE);
  // Sprint 12: PDF 模式检测（NativeText / ScannedOCR / Mixed）
  // F3B-6.20-B（#19）：联合类型移除死成员 `"mixed"` —— 全仓无 `setPdfMode("mixed")`、
  // 无 `pdfMode === "mixed"` 比较（仅 4210/5101 `scannedOCR`、4258 `nativeText` 会被写入）。
  // ⚠️ 既有基线问题（**本轮不修**，保持 tsc=418）：5643 行 `setPdfMode("unknown")` 中的
  //    `"unknown"` 不在本联合类型内，属既有类型错误，与本次删除无关。
  const [pdfMode, setPdfMode] = useState<"nativeText" | "scannedOCR" | null>(null);

  // PDF Reconstruction Engine V1 — Sprint 1: EditableDocument ref
  // 持有当前文档的 EditableDocument 表示（文档理解对象）。
  // 通过 window.__editableDocument 暴露，方便控制台调试（Task 5）。
  const editableDocumentRef = useRef<EditableDocument | null>(null);
  // M7.8-020-PROD: segments 镜像 ref，供导出时把文本编辑回写 EditableDocument
  const segmentsRef = useRef<Segment[]>([]);
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);
  // M6-001C: Operation History（operation-inverse Undo/Redo，ADR-052）
  const operationHistoryRef = useRef<OperationHistory | null>(null);
  if (!operationHistoryRef.current) operationHistoryRef.current = new OperationHistory();
  // Sprint 6: 文档版本号（编辑后递增，触发 GlyphRenderer 重新渲染）
  const [editableDocVersion, setEditableDocVersion] = useState(0);
  // Sprint 6: 选中的 glyph ID 集合
  const [selectedGlyphIds, setSelectedGlyphIds] = useState<Set<string>>(new Set());
  // Task-013A/013B: 当前 DerivedSelection（onSelectionChanged 更新，Provider 消费）
  const currentDerivedSelectionRef = useRef<DerivedSelection | null>(null);
  // ── F3B-6.17-3C-10S.3B-1：Canonical Selection production sink ──
  // 双轨 Selection Architecture（**两条链不中途互相转换**）：
  //   glyph    : GlyphRenderer → DerivedSelection → currentDerivedSelectionRef
  //              → MapCurrentSelectionProvider → Legacy Capability   （既有，完全不动）
  //   canonical: DOM Selection → CanonicalSelection → 本 store
  //              → CanonicalSelectionProvider → Core Capability      （新增，B-2 才消费）
  // 生产事件边界 = 原生 `selectionchange`（DOM selection 已稳定形成的最早生产边界）。
  // **不**挂 FloatingToolbar（UI 层）的 mouseup：那会造成 UI → Core 的反向依赖。
  const canonicalSelectionStoreRef = useRef<CanonicalSelectionStore | null>(null);
  if (!canonicalSelectionStoreRef.current) {
    canonicalSelectionStoreRef.current = createCanonicalSelectionStore();
  }
  // ── F3B-6.17-3C-10C.3B-0：Core Input Undo/Redo 路由的 ownership 记账 ──
  //   lastMutationOwner：最近一次 mutation 真正落到哪一侧（Core 提交成功 / Legacy funnel）
  //   lastUndoRedoOwner：当前 undo/redo **连续段**所在侧（任何新 mutation ⇒ null）
  // ★ 不变式：连续段内**绝不换侧**；owner = core 时**绝不触碰** Legacy OperationHistory。
  const lastMutationOwnerRef = useRef<UndoRedoOwner | null>(null);
  const lastUndoRedoOwnerRef = useRef<UndoRedoOwner | null>(null);
  const coreInputHistoryTelemetryRef = useRef(createCoreInputHistoryTelemetry());
  /** F3B-6.17-3C-10C.3B：既有 `onTextEditSave` 生产 handler 的自引用（由该函数体首行赋值） */
  const textEditSaveRef = useRef<((blockId: string, newText: string) => void) | null>(null);
  /** 记一次 mutation 的归属（写点只有两个：Core 提交成功 / Legacy funnel） */
  const markMutationOwner = useCallback((owner: UndoRedoOwner) => {
    lastMutationOwnerRef.current = owner;
    // 新 mutation ⇒ 旧连续段结束（下一次 undo 由新 mutation 的归属决定）
    lastUndoRedoOwnerRef.current = null;
  }, []);
  useEffect(() => {
    const store = canonicalSelectionStoreRef.current;
    if (!store) return;
    // 只读发布：读 DOM 选区 → canonical 语义 → sink；**不** preventDefault、**不**改选区。
    // ★ P0-VPS（D1'）：**多选集合**的只读观测，**独立于 DOM 选区**。
    //
    //   ⚠️ 为什么要独立：`onSelectionChange` 在 `:934` 处对「无 / 折叠的 DOM 选区」
    //   `store.sink.clear(); return;` —— 而 Ctrl/Cmd+点击**不产生**任何 DOM selection，
    //   所以集合变化若复用那条路径就**永远到不了**观测代码（实测 `__multiSelection` 恒 null）。
    //   故集合有自己的发布入口，并订阅它 ⇒ 多选状态永远可观测。
    const publishMultiSelectionObservation = () => {
      try {
        const selectedIds = getMultiSelectedSegmentIds();
        (window as any).__multiSelection = { count: selectedIds.length, segmentIds: selectedIds };
        // 集合为空 ⇒ 交回 `onSelectionChange` 的 DOM 分支负责（不覆盖它的结论）。
                // 但**必须**显式写 `empty-selection`：否则「集合由非空变空」时，`__crossLineRange`
                // 会**残留上一次集合的 ok 结论**（陈旧读数，比没有读数更危险）。
                if (selectedIds.length === 0) {
                  (window as any).__crossLineRange = { ok: false, reason: "empty-selection" };
                  return;
                }
        const d = coreInputSessionRef.current?.history.state.document ?? coreDocumentRef.current;
        (window as any).__crossLineRange = resolveCrossLineRangeFromSet({
          segments: segmentsRef.current ?? [],
          selectedSegmentIds: selectedIds,
          resolveParagraph: (lineId: string) => (d ? coreParagraphIdForLineId(d, lineId) : null),
        });
      } catch (e) {
        (window as any).__crossLineRange = { ok: false, reason: "probe-error", detail: String(e) };
      }
    };

    const onSelectionChange = () => {
      // 集合观测**先于**下方任何 early-return（否则无 DOM 选区时集合状态不可观测）
      publishMultiSelectionObservation();
      // ── F3B-6.17-3C-10S.3B-2：焦点被**UI 文本控件**接管 ≠ 用户取消选择 ──
      // 实测（真实 Chromium）：Toolbar 的 Replace 输入框 `autoFocus` 会把焦点移入 `<input>`，
      // 浏览器随即把文档选区变为空并派发 `selectionchange` ⇒ 若此处 clear，
      // 「拖选 → Toolbar 替换」这条用户路径上的 canonical 选区会被**我们自己的 UI** 抹掉。
      // 语义裁决：`clear()` 只在**用户显式取消选择**（焦点仍在文档内）时发生 ——
      // 与旧链一致（`currentDerivedSelectionRef` 只被下一次 selection 覆盖，不因 DOM 失焦清空）。
      // ⚠️ 只认 INPUT/TEXTAREA（不认 contenteditable：编辑态 segment 本身是 contenteditable）。
      const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
      const focusParkedInInput = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA");
      if (focusParkedInInput) return;

      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        store.sink.clear();
        return;
      }
      const range = selection.getRangeAt(0);
      const segmentElement = findSegmentElement(range.commonAncestorContainer);
      const segmentId = segmentElement?.getAttribute("data-segment-id") ?? null;
      publishDomSelection(
        { range, segmentElement, segmentId },
        {
          sink: store.sink,
          resolveSegment: (id) => {
            const seg = (segmentsRef.current ?? []).find((s) => s.id === id);
            if (!seg?.source?.blockId || !seg.source.lineId) return null;
            return {
              blockId: seg.source.blockId,
              lineId: seg.source.lineId,
              textLengthUtf16: (seg.text ?? "").length,
            };
          },
          // ★ IB-2-F（F2）：同样走 Binding 原语（含段间分隔空格）
          segmentStartOffsetUtf16Of: (id) =>
            segmentParagraphBaseUtf16(
              segmentsRef.current ?? [],
              id,
              coreInputSessionRef.current?.history.state.document ?? coreDocumentRef.current
            ),
        }
      );

      // ★ P0-VPS 最小第一步：只读发布「拖选跨行」范围判定（说明见上方注释）
      try {
        const domSel = typeof window !== "undefined" ? window.getSelection?.() ?? null : null;
        if (!domSel || domSel.rangeCount === 0) {
          (window as any).__crossLineRange = { ok: false, reason: "no-anchor" };
        } else {
          const aEl = findSegmentElement(domSel.anchorNode);
          const fEl = findSegmentElement(domSel.focusNode);
          (window as any).__crossLineRange = resolveCrossLineRange({
            segments: segmentsRef.current ?? [],
            anchorSegmentId: aEl ? aEl.getAttribute("data-segment-id") : null,
            focusSegmentId: fEl ? fEl.getAttribute("data-segment-id") : null,
            resolveParagraph: (lineId: string) => {
              const d =
                coreInputSessionRef.current?.history.state.document ?? coreDocumentRef.current;
              return d ? coreParagraphIdForLineId(d, lineId) : null;
            },
          });
        }
      } catch (e) {
        (window as any).__crossLineRange = { ok: false, reason: "probe-error", detail: String(e) };
      }
    };
    document.addEventListener("selectionchange", onSelectionChange);
    // ★ D1'：集合变化也刷新观测面（Ctrl/Cmd+点击不产生 DOM selectionchange）。
    //   订阅的是**专用入口**而非 onSelectionChange —— 后者会被「无 DOM 选区」守卫拦掉。
    const unsubscribeMultiSelection = subscribeMultiSelection(publishMultiSelectionObservation);
    // 挂载时立即发布一次 ⇒ `__multiSelection` 初始即可读（消除观测面的 null 窗口）
    publishMultiSelectionObservation();
    // 只读调试 / E2E 观测面：Core Capability 只经由 provider 读选区（不摸 ref）
    //
    // ★ P0-VPS 最小第一步（只读观测，非生产逻辑）：把「拖选跨行」的**范围判定结果**
    //   暴露为 `__crossLineRange`，用于在真实浏览器验证「哪些段被框住」是否正确。
    //   刻意**不**做三件事：不建编辑面、不改选区、不产生任何 mutation。
    //   （几何/映射/mutation 属后续阶段，见 cases/F3B-6.27-P0VPS-...md §13）
    if (typeof window !== "undefined") {
      (window as any).__canonicalSelectionProvider = store.provider;
      // ── F3B-6.17-3C-10C.3B-0：Core Input History 只读探针（B0 验收依赖它证明
      //   「Core 栈真实前进 / Legacy undo·redo = 0」；不含任何写能力）──
      // ── F3B-6.17-3C-10C.3B（Path B）：既有 EditSession surface 的受控入口 ──
      // 只**暴露既有生产函数**（openTextEditSession + onTextEditSave handler）——
      //   · 不新建 textarea        · 不 mock Adapter
      //   · 不直接 commitSegment   · 不直接写 editableDocumentRef
      //   · 不改 GlyphRenderer 挂载条件
      // 文档访问**只读**（从 editableDocumentRef 取行文本/bbox），语义与真实 UI 打开/提交一致。
      (window as any).__coreInputHistory = () => {
        const session = coreInputSessionRef.current;
        const tel = coreInputHistoryTelemetryRef.current;
        // 无 session（尚未发生 Core 提交）时退回 import-time 的 Core 文档 ——
        // 否则 no-op 场景读不到 Core 文档真实值（C.3B Case 6 依赖它断言"文档不变"）。
        const doc = session ? documentOf(session) : coreDocumentRef.current;
        return {
          hasSession: !!session,
          hasCoreDocument: !!doc,
          size: session?.history.size ?? 0,
          applied: session?.history.appliedCount ?? 0,
          canUndo: session?.history.canUndo ?? false,
          canRedo: session?.history.canRedo ?? false,
          paragraphs: doc ? coreDocumentParagraphTexts(doc) : [],
          lastMutationOwner: lastMutationOwnerRef.current,
          lastUndoRedoOwner: lastUndoRedoOwnerRef.current,
          telemetry: { ...tel },
        };
      };
    }
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      // ★ D1'：与上面成对，防止多选集合订阅泄漏（Effect 依赖数组为 []，仅挂载一次）
      unsubscribeMultiSelection();
    };
  }, []);
  // ── F3B-6.17-3C-10C.3B（Path B）：既有 EditSession surface 的受控入口 ────────────
  //   ★ 与 canonical DOM-selection sink **分开放置**：canonical 接线必须保持
  //     「零 glyph 坐标概念」（3C-10S.3B-1 守卫 ⑤-3），而 EditSession 本身是
  //     glyph 时代的生产 surface —— 两个输入源不合并（各自独立接线，只在 Core
  //     Command 边界汇合）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__textEditSurface = {
      open: (args: {
        blockId: string;
        lineId: string;
        startGlyphIndex?: number;
        endGlyphIndex?: number;
      }) => {
        const doc = editableDocumentRef.current;
        if (!doc) return null;
        let line: EditableLine | null = null;
        for (const pg of doc.pages ?? []) {
          for (const b of pg.blocks ?? []) {
            const found: EditableLine | undefined = (b.lines ?? []).find((l) => l.id === args.lineId);
            if (found) {
              line = found;
              break;
            }
          }
          if (line) break;
        }
        if (!line) return null;
        const glyphs = (line as { glyphs?: ReadonlyArray<{ char?: string }> }).glyphs ?? [];
        const legacyText = glyphs.map((g) => g.char ?? "").join("");
        // F3B-6.24-C：open 与 save 共用 Core 文本来源（Core owns 时优先；否则回落 Legacy）。
        // 门控与 save 路径（readCoreTextEditInputFlag）对称，保证「再次打开看到 Core 最新文本」。
        const coreEnabled = readCoreTextEditInputFlag();
        const coreTextForOpen =
          coreEnabled && coreDocumentRef.current != null
            ? resolveCoreLineText(coreDocumentRef.current, args.lineId, lineIdParagraphMapRef.current)
            : null;
        const text = coreTextForOpen ?? legacyText;
        const glyphCount = Array.from(text).length;
        const start = args.startGlyphIndex ?? 0;
        const end = args.endGlyphIndex ?? Math.max(0, glyphCount - 1);
        const range = { blockId: args.blockId, lineId: args.lineId, startGlyphIndex: start, endGlyphIndex: end };
        const session = createEditSession(
          { blockId: args.blockId, lineId: args.lineId, startGlyphIndex: start, endGlyphIndex: end },
          text,
          [range],
          undefined,
          "text-edit",
          { start, end }
        );
        openTextEditSession(
          args.blockId,
          {
            blockId: args.blockId,
            text,
            bbox: (line as { bbox?: { x: number; y: number; width: number; height: number } }).bbox ?? {
              x: 0,
              y: 0,
              width: 0,
              height: 0,
            },
            fontSize: 14,
          },
          session
        );
        return { text, glyphCount, start, end };
      },
      save: (blockId: string, newText: string) => {
        textEditSaveRef.current?.(blockId, newText);
      },
    };
  }, []);
  // ── F3B-6.17-3C-10C.2：TextEdit Input Shadow（**只读观察**）─────────────────
  //   gate = `window.__textEditShadow === true`（**缺省 false ⇒ 生产零行为变化、零开销**）
  //   观察对象：真实输入 → Legacy 语义落点（只读投影） vs Adapter 的 UTF-16 intent
  //   ★ 硬不变量：不提交任何 Core Command、不写 EditableDocument / EditorHistory /
  //     ownership / export / selection；任何异常静默吞掉（Shadow 绝不影响生产）。
  const textEditShadowRecorderRef = useRef<TextEditShadowRecorder | null>(null);
  if (!textEditShadowRecorderRef.current) {
    textEditShadowRecorderRef.current = createTextEditShadowRecorder();
  }
  const observeTextEditShadow = useCallback(
    (args: {
      request: TextEditInputRequest;
      session: EditSession;
      legacy: {
        kind: "replace" | "insert" | "delete" | "commit" | "cancel" | "none";
        trigger?: string;
        text?: string;
      };
      /** true ⇒ 语义 = 「整行 := request.text」（textarea 值回收路径）；区间按**文档行**建模 */
      wholeLine?: boolean;
      /** commit 观察点：Legacy 变更跨度投影（LCP/LCS，与 Legacy commit 同口径） */
      projection?: LegacyLineEditProjection;
    }) => {
      try {
        if (typeof window === "undefined") return;
        if ((window as unknown as Record<string, unknown>).__textEditShadow !== true) return;
        const recorder = textEditShadowRecorderRef.current;
        const doc = editableDocumentRef.current;
        const s = args.session;
        if (!recorder || !doc || !s) return;
        const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === s.target.blockId);
        const line = block?.lines.find((l) => l.id === s.target.lineId);
        if (!line || line.glyphs.length === 0) return;
        const glyphs = line.glyphs.map((g) => ({ char: g.char, originalChar: g.originalChar }));
        const lineText = glyphs.map((g) => g.char ?? g.originalChar ?? "").join("");

        // ── Legacy 区间来源（透明建模；见 text-edit-input-shadow 的 rangeModel 说明）──
        const legacyRange: { start: number; end: number; model: TextEditLegacyRangeModel } | null =
          args.projection
            ? { start: args.projection.glyphStartInclusive, end: args.projection.glyphEndInclusive, model: "lcp-lcs-projection" }
            : args.wholeLine
              ? { start: 0, end: line.glyphs.length - 1, model: "target-glyph-range" }
              : args.legacy.kind === "commit" || args.legacy.kind === "cancel" || args.legacy.kind === "none"
                ? null
                : s.editingMode === "replace-selection"
                  ? { start: s.target.startGlyphIndex, end: s.target.endGlyphIndex, model: "target-glyph-range" }
                  : {
                      start: s.caret.start,
                      end: Math.max(s.caret.start, s.caret.end) - 1,
                      model: "caret-codepoint-span",
                    };

        const snapshot = args.wholeLine
          ? {
              blockId: s.target.blockId,
              lineId: s.target.lineId,
              editingMode: "text-edit" as const,
              startGlyphIndex: 0,
              endGlyphIndex: line.glyphs.length - 1,
              caret: { start: 0, end: Array.from(lineText).length },
              sessionText: lineText,
              glyphs,
            }
          : args.projection
            ? {
                blockId: s.target.blockId,
                lineId: s.target.lineId,
                editingMode: "text-edit" as const,
                startGlyphIndex: 0,
                endGlyphIndex: line.glyphs.length - 1,
                caret: { start: args.projection.codepointStart, end: args.projection.codepointEnd },
                sessionText: lineText,
                glyphs,
              }
            : {
                blockId: s.target.blockId,
                lineId: s.target.lineId,
                editingMode: s.editingMode,
                startGlyphIndex: s.target.startGlyphIndex,
                endGlyphIndex: s.target.endGlyphIndex,
                caret: { start: s.caret.start, end: s.caret.end },
                sessionText: s.text,
                glyphs,
              };
        const record = recorder.record({
          request: args.request,
          snapshot,
          legacy: {
            kind: args.legacy.kind,
            startGlyphIndex: legacyRange?.start,
            endGlyphIndex: legacyRange?.end,
            text: args.legacy.text,
            trigger: args.legacy.trigger,
            rangeModel: legacyRange?.model ?? "none",
          },
        });
        (window as unknown as Record<string, unknown>).__c10c2Shadow = recorder.records();
        console.log("[C10C2.shadow]", {
          requestKind: record.requestKind,
          requestText: record.requestText,
          legacyKind: record.legacyKind,
          legacySlice: record.legacySlice,
          adapterKind: record.adapter.ok ? record.adapter.kind : `rejected:${record.adapter.reason}`,
          adapterRange: record.adapter.ok ? record.adapter.range : null,
          correctRange: record.correctRange,
          classification: record.classification,
          blocking: record.blocking,
          notes: record.notes,
        });
      } catch {
        // Shadow 绝不影响生产
      }
    },
    []
  );
  // M7-004A: 鼠标拖选产生的文本选区（SelectionRange，与 Keyboard Selection 同构）。
  // 004B 用它接入 pendingEdit/EditSession；004A 只完成 state 接入（不接 mutation/undo）。
  const [currentSelection, setCurrentSelection] = useState<SelectionRange | null>(null);
  // M7-004A debug: 暴露 currentSelection 供 runtime 验证（只读调试，非侵入）
  if (typeof window !== "undefined") (window as any).__currentSelection = currentSelection;
  // ── M7.7-003: 拖选 → 浮层 Action Menu（不直接 inline，不弹 Workspace）──
  // range/text 供 Edit Text / Copy / Ask AI；x/y = selection bounding box 的 top/right（世界 CSS 坐标）。
  const [selectionMenu, setSelectionMenu] = useState<{
    range: SelectionRange;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  // ── M7.7-003: Workspace 仅响应 AI 意图（Edit Text 永远 inline）──
  const [workspaceIntent, setWorkspaceIntent] = useState<"ai" | null>(null);
  // M7.7-003 debug: 暴露 selectionMenu / workspaceIntent 供 runtime 验证（只读调试，非侵入）
  if (typeof window !== "undefined") {
    (window as any).__selectionMenu = selectionMenu;
    (window as any).__workspaceIntent = workspaceIntent;
  }
  // Sprint 50 Fidelity Debug Mode（?debug=fidelity，非侵入，只读调试）
  const isFidelityDebug = useMemo(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("debug") === "fidelity",
    [],
  );
  const [debugGlyph, setDebugGlyph] = useState<{ glyph: DrawGlyphCommand; index: number } | null>(null);
  const [debugOverlay, setDebugOverlay] = useState({ source: true, glyph: true, baseline: true });

  // Sprint 19: 签名区域 Adobe 风格替换模型（按页缓存）
  // 每页存储 SignatureReplacement[]，含背景补丁图像 + 旋转角度 + 可编辑 block
  const signatureReplacementsRef = useRef<Map<number, SignatureReplacement[]>>(new Map());
  // Sprint 26: 存储 composite region 信息（按页），用于 patch coverage 验证
  const signatureRegionInfoRef = useRef<Map<number, SignatureCompositeRegion[]>>(new Map());
  const suppressedGlyphIdsRef = useRef<Set<string>>(new Set());
  const signatureRotationRef = useRef<Map<string, number>>(new Map()); // blockId → rotationAngle

  // Sprint 33.5.6: 签名区域独立渲染模型
  const signatureRegionsRef = useRef<import("../document-model/types").SignatureRenderRegion[]>([]);

  // Sprint 33.5.8: PDF textItems snapshot for overlay similarity comparison
  const docTextItemsRef = useRef<any[]>([]);
  // Keep docTextItemsRef in sync with textItems state for __overlaySimilarityDebug
  useEffect(() => {
    docTextItemsRef.current = textItems;
  }, [textItems]);

  // Sprint 21: 全页 OCR 背景文字移除（按页缓存 CleanBackgroundPatch[]）
  const backgroundRemovalRef = useRef<Map<number, CleanBackgroundPatch[]>>(new Map());

  // ── Render Pipeline Map（Phase 1）──
  (window as any).__renderPipelineMap = {
    description: "PDFSail Render Pipeline — Layer Stack",
    layers: [
      {
        index: 0, name: "PDF Canvas (pdf.js)", tagName: "canvas",
        parent: "div.pdf-canvas-layer", zIndex: "auto (DOM order)", opacity: 1,
        transform: "none", pointerEvents: "auto", position: "static",
        size: "viewport × 1.5 (canvas px) → CSS 100% width auto height",
        visible: true,
        owner: "pdf.js — PDFEditor.tsx line 645: pg.render({ canvasContext, viewport }).promise",
        notes: "原始扫描 PDF 位图。1.5x viewport 渲染到 canvas，CSS 缩放至容器宽度",
      },
      {
        index: 1, name: "Interaction Layer (container)", tagName: "div",
        parent: "wrapper div", zIndex: "auto (position:absolute on top)", opacity: 1,
        transform: "none", pointerEvents: "none",
        position: "position:absolute; top:0; left:0; right:0; bottom:0",
        size: "same as wrapper (210:297 aspect ratio container)",
        visible: true,
        owner: "PDFCanvas.tsx line 211",
        notes: "所有覆盖层（glyph/segments/blocks）的绝对定位容器",
        children: [] as string[],
      },
    ],
    layerChildren: {
      glyphRenderer: {
        index: "1.1", name: "GlyphRenderer", tagName: "div.glyph-renderer",
        zIndex: "auto (DOM order within interaction layer)", opacity: 1,
        transform: "none", pointerEvents: "auto (interactive) or none",
        position: "position:absolute; top:0; left:0; right:0; bottom:0",
        visible: "when glyphCommands.length > 0",
        owner: "PDFCanvas.tsx line 216-226",
        subLayers: [
          { z: 1, name: "Mask rects (white div)", element: "div", count: 0 },
          { z: 1, name: "Rect fills (signature bg)", element: "div", count: 0 },
          { z: 1, name: "Background patch images (cleanBG)", element: "img", count: 0, note: "Sprint 21 — DrawImageCommand → <img>" },
          { z: 1, name: "Background patch images (signature)", element: "img", count: 0, note: "Sprint 19 — DrawImageCommand → <img>" },
          { z: "auto", name: "Glyph spans (OCR text)", element: "span", count: 0, note: "每个字符一个 position:absolute span" },
        ],
      },
      segmentsLayer: { index: "1.2", name: "EditableTextNode[]", notes: "PDF 原生 text items（非 OCR 模式）" },
      textLayer: { index: "1.3", name: "Text preview divs", notes: "文本预览（非 OCR 模式）" },
      blocksLayer: { index: "1.4", name: "User blocks (text/image/sig/highlight/redact)", notes: "手动添加的 block" },
      portalRoot: { index: "1.5", name: "edit-portal-root", notes: "编辑框 Portal 容器" },
    },
  };
  // ── END Sprint 22 Render Pipeline Map ──

  // ── Debug: React render counter ──
  pdfEditorRenderCount += 1;
  (window as any).__pdfEditorRenderCount = pdfEditorRenderCount;
  console.log(`[PDFEditor] render #${pdfEditorRenderCount} | v=${editableDocVersion} doc=${!!editableDocumentRef.current} page=${page}`);

  // ── Sprint 32: Text Edit Overlay state ──
  const [editingBlockId, setEditingBlockId] = useState<string | null>(null);
  // M7.7-003B-002 (Bug2): 已提交编辑过的 block 集合。native-canvas 下这些 block 也渲染 overlay（mask+span），
  // 让用户看到改后的文本（否则 commit 后 editingBlockId 清空、canvas 不重渲染 → 看不到改后文本）。
  // M7.7-004U: 已提交编辑过的「行」集合（lineId 内嵌 blockId：${blockId}_l${idx} → 全局唯一）。
  // native-canvas 下这些行也渲染 overlay（mask + span），让用户看到改后文本；
  // 未编辑行保持 canvas 扫描原样（编辑其他行时已改行仍显示修改后文本）。
  const [editedLines, setEditedLines] = useState<ReadonlySet<string>>(new Set());
  // M7.7-021: editedLines ref 供 useEffect 闭包读取最新值（避免闭包陈旧）
  const editedLinesRef = useRef<ReadonlySet<string>>(editedLines);
  editedLinesRef.current = editedLines;
  // M7.7-004U: 已编辑行 → 真实文字覆盖盒（commit 后 mask 用）。用 glyph 并集 + canvas 扫描扩展，
  // 覆盖真实文字右缘（非过窄的 OCR 墨迹盒）。
  const [editedLineBoxes, setEditedLineBoxes] = useState<Map<string, { x: number; y: number; width: number; height: number }>>(new Map());
  // ══ F3B-6.28 · C2/C3：提交后受控显示层（__unitEditing gate；快照式纯派生）══
  //   unit 事务提交成功后记录 overlay 快照（A 流布局行 + displaced 平移行）；
  //   显示条件 = history.appliedCount ≥ 提交时值（undo 过头 ⇒ 隐藏；redo 回来 ⇒ 重现）。
  // ★★ 2026-10-19（用户缺陷「多 unit 依次提交后，先前编辑的显示丢失」）：
  //   单快照 state 被每次新 unit 提交**整体替换** ⇒ 之前 unit 的提交层（overlay 行 +
  //   span/mask 隐藏样式）全部消失 ⇒ 先前编辑的行回退为「mask 盖 canvas + 可见 glyph
  //   span 显示 legacy 原文」= 用户看到原文（"测试"消失）+ displaced 丢失后的错位叠加
  //   （实测 multi.json：e2 提交后 spanVisible 含 l9/l10 全部 34 个 span、overlays 只剩
  //   unit2 的 9 行；e3 后 222 个 span 全可见、overlays 只剩 unit3 的 2 行；Core 数据
  //   全程完好 ⇒ 纯显示层缺陷）。
  //   ⇒ 改为 **按 unitId 的多快照**：每个 unit 一次提交 upsert 一个条目；渲染时合并
  //     （见 mergeCommittedOverlays）。undo 过头仍按**每快照** appliedIndex 判定（该
  //     unit 的编辑被撤销 ⇒ 它的显示整体退出；更早 unit 的显示保留）。
  type CommittedUnitSnapshot = {
    unitId: string;
    appliedIndex: number;
    /** D-3B-6 缺陷 A/C 修复（2026-10-16）：提交时的显示页（1-based）。
     *  overlay/clear/样式按本页门控 ⇒ 切页后 fixed 层不得悬浮在其他页面内容上。 */
    pageIndex: number;
    /** ★ 滚动跟随（2026-10-18 用户缺陷裁定）：提交时的 window.scrollY。
     *  行/清除矩形存的是**视口坐标**（commit 时实测）；文档坐标 docY = cssY + commitScrollY，
     *  渲染 top = docY − 当前 scrollY ⇒ fixed 层与内容一起滚动（消除滚动后重复文本）。 */
    commitScrollY: number;
    lines: { text: string; cssX: number; cssY: number; cssW: number; cssH: number; sourceLineId: string; role: string; fontSize: number; fontFamily: string }[];
    /** C 收尾（R1）：清除层 —— 覆盖旧位置遗留 glyph span / mask 之上可能露出的原文墨迹 */
    clears: { sourceLineId: string; cssX: number; cssY: number; cssW: number; cssH: number }[];
    skipped: readonly string[];
  };
  const [committedUnitOverlays, setCommittedUnitOverlays] = useState<Record<string, CommittedUnitSnapshot>>({});
  /**
   * ★ 2026-10-22/23（用户缺陷链：整行竖线不完整 / 顶部重影 / **整行重影**）：
   *   **cell 单位提交过的行 → 该行需由 span 显示的字符区间**（glyph 索引闭区间，
   *   取自 `deriveCellSurfaceFromAnchor` 的 `pStartUtf16..pEndUtf16-1` = **提交后**
   *   Core 文本轴上被编辑格的区间）。
   *
   *   演进：最初对整行 span 加白底 + 隐藏整行 mask；实测（2026-10-23 严格对照）
   *   **span 与 canvas 原文字符存在advance 级错位**（span 覆盖整行 ⇒ 编辑行的全部
   *   格子都与 canvas 原文叠加 ⇒ 整行重影），而**未编辑格根本不需要 span**——
   *   canvas 原文就是正确显示。⇒ 最终语义：
   *     · 区间内 span：可见 + 逐字符白底（盖旧字形、显示新值）；
   *     · 区间外 span：**visibility:hidden**（canvas 原文承担显示，零重影）；
   *     · 整行 mask：隐藏（白块会盖住穿过文字带的表格竖线）。
   */
  const [cellCommittedSpans, setCellCommittedSpans] = useState<
    ReadonlyMap<string, ReadonlyArray<{ x: number; y: number; width: number; height: number }>>
  >(() => new Map());
  /**
   * ★ 2026-10-23：cell 面**打开时**的编辑格页内几何（segment DOM 实测：rect + scroll
   *   转页内坐标，与 glyph span 的 `style.left` 同空间）。提交块用它圈定「该行需要
   *   span 显示的几何区间」。
   *   ⚠️ 不用 `unitSurfaceNow.cellAnchor.box`：实测该字段在提交时为 {x:null,width:null}
   *   （来源链的 cellBox 在 cell 面重建路径上丢失），不可依赖。
   */
  const cellFaceGeomRef = useRef<{ lineId: string; x: number; y: number; width: number; height: number } | null>(null);
  // ★ 滚动跟随（2026-10-18 用户缺陷裁定）：committed overlay/clear 是 fixed 层，若不随
  //   内容滚动，滚动后会停在旧视口位置 ⇒ 与（已滚动到新位置的）canvas/span 文本重复
  //   （实测：下滚后 l5+l6 文本在「地点：茂名市。」下方重复出现）。
  //   机制：状态存**文档坐标** docY = cssY + commitScrollY；渲染 top = docY − 实时 scrollY
  //   （渲染时读实时值 ⇒ 任何 React 重渲染自纠）；滚动期间由本监听按**绝对值**直接改 DOM
  //   （无需 state 化 scrollY、不触发重渲染）。overlay 不可见（无提交/undo 过头）⇒ 不挂监听。
  useEffect(() => {
    if (Object.keys(committedUnitOverlays).length === 0) return;
    const sync = (): void => {
      const y = typeof window !== "undefined" ? window.scrollY : 0;
      const els = document.querySelectorAll<HTMLElement>("[data-commit-doc-y]");
      for (const el of Array.from(els)) {
        const docY = parseFloat(el.dataset.commitDocY ?? "");
        if (Number.isFinite(docY)) el.style.top = `${docY - y}px`;
      }
    };
    sync(); // 挂载即对齐（吸收「提交→渲染→effect」之间可能发生的滚动）
    window.addEventListener("scroll", sync, { passive: true });
    window.addEventListener("resize", sync, { passive: true });
    return () => {
      window.removeEventListener("scroll", sync);
      window.removeEventListener("resize", sync);
    };
  }, [committedUnitOverlays]);
  /**
   * ★★ 2026-10-19：多快照合并视图（渲染层唯一入口）。
   *
   * 有效快照 = `appliedCount >= appliedIndex`（undo 过头 ⇒ 该 unit 整体退出）。
   * 合并规则：
   *   · **hideLineIds**（span/mask 隐藏）：所有有效快照的 clears sourceLineId **并集** ——
   *     「成员行旧字形已被清除/重绘取代」是文档状态下的持久事实，跨 unit 累积，不随页门控
   *     （2026-10-16 缺陷 A 语义在多快照下保持）。
   *   · **clears / lines**（DOM 矩形）：按 sourceLineId 去重，取 **appliedIndex 最大**的
   *     快照版本 —— 其文本/几何基于最新 Core（同一行在早先 unit 中是 member-flow 行、
   *     在最近 unit 中是 displaced 行时，最近版本权威）。同一行多次清除矩形完全重叠
   *     ⇒ 去重同时消除潜在的双绘。
   *   · 每条目携带自己快照的 `pageIndex` / `commitScrollY`（页门控与滚动换算 per-snapshot）。
   */
  const mergeCommittedOverlays = ():
    | {
        hideLineIds: string[];
        clears: ({ unitId: string; pageIndex: number; commitScrollY: number } & CommittedUnitSnapshot["clears"][number])[];
        lines: ({ unitId: string; pageIndex: number; commitScrollY: number } & CommittedUnitSnapshot["lines"][number])[];
      }
    | null => {
    const session = coreInputSessionRef.current;
    if (!session) return null;
    const applied = session.history.appliedCount;
    const entries = Object.values(committedUnitOverlays).filter((s) => applied >= s.appliedIndex);
    if (entries.length === 0) return null;
    const hideLineIds = [...new Set(entries.flatMap((s) => s.clears.map((c) => c.sourceLineId)))];
    // clears：行级单条（清除矩形 = 该行原始 glyph 并集）⇒ 按 sourceLineId 去重，
    //   取 appliedIndex 最大的快照版本（其几何基于最新 Core）。
    const clearByLine = new Map<string, { idx: number; item: { unitId: string; pageIndex: number; commitScrollY: number } & CommittedUnitSnapshot["clears"][number] }>();
    for (const s of entries) {
      for (const c of s.clears) {
        const prev = clearByLine.get(c.sourceLineId);
        if (!prev || prev.idx <= s.appliedIndex) {
          clearByLine.set(c.sourceLineId, { idx: s.appliedIndex, item: { ...c, unitId: s.unitId, pageIndex: s.pageIndex, commitScrollY: s.commitScrollY } });
        }
      }
    }
    // lines：★★ 同一 sourceLineId 可对应**多条 flow 行**（折行行：C3 flow 以行首成员
    //   为锚 ⇒ l13 折成 2 行时两条都锚 l13）⇒ **绝不能按 sourceLineId 逐条去重**（会吞掉
    //   同组的多条 flow 行，实测 l13 只剩 "0" 一条）。正确语义 = 按 sourceLineId 分组、
    //   **每组取 appliedIndex 最大的快照的该组全部行**（跨快照版本冲突时最近快照权威：
    //   早先 unit 的 member-flow 行 vs 最近 unit 的 displaced 行，取后者）。
    const lineOwnerBySource = new Map<string, { idx: number; unitId: string }>();
    for (const s of entries) {
      for (const l of s.lines) {
        const prev = lineOwnerBySource.get(l.sourceLineId);
        if (!prev || prev.idx <= s.appliedIndex) {
          lineOwnerBySource.set(l.sourceLineId, { idx: s.appliedIndex, unitId: s.unitId });
        }
      }
    }
    const lines = entries.flatMap((s) =>
      s.lines
        .filter((l) => {
          const owner = lineOwnerBySource.get(l.sourceLineId);
          return !!owner && owner.unitId === s.unitId && owner.idx === s.appliedIndex;
        })
        .map((l) => ({ ...l, unitId: s.unitId, pageIndex: s.pageIndex, commitScrollY: s.commitScrollY })),
    );
    return {
      hideLineIds,
      clears: [...clearByLine.values()].map((v) => v.item),
      lines,
    };
  };
  // M7.7-006: 同步真实墨迹覆盖盒到 ref（handleExport 经 useExport 闭包读取最新值，避免 stale state）。
  const editedLineBoxesRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(editedLineBoxes);
  editedLineBoxesRef.current = editedLineBoxes;
  // M7.7-019: 存储打开编辑 session 时的原始行 bbox，用于 markLineEdited 中计算 mask 并集
  const originalLineBBoxRef = useRef<Map<string, { x: number; y: number; width: number; height: number }>>(new Map());
  // 标记某行已编辑：把 lineId 加入 editedLines + 记录其真实覆盖盒（幂等）。
  // M7.7-019: 从 EditableDocument（mutate 后）读取当前行 glyph 计算 mask bbox，
  // 并与 originalLineBBoxRef 中的原始 bbox 取并集，确保 mask 覆盖原始+编辑后的全部区域。
  const markLineEdited = useCallback((blockId: string, lineId: string, extraInkBox?: { x: number; y: number; width: number; height: number } | null) => {
    // console.log("[M7.7-014][MARK_ENTER]", { blockId, lineId });
    // M7.7-019: 从 EditableDocument 获取当前行 glyph bbox 并集
    const doc = editableDocumentRef.current;
    let currentBox: { x: number; y: number; width: number; height: number } | null = null;
    // F3B-6.15：共享 geometry kernel 的 glyph 输入（唯一并集实现在 reconciliation-geometry.ts）
    let kernelGlyphs: any[] = [];
    let glyphCount = 0;
    let firstBaseline: number | undefined;
    let currentGlyphY: number | undefined;
    let currentGlyphHeight: number | undefined;
    // M7.8-022A: 记录目标行所在的 lines 数组与索引 —— 用于取「下一行顶部」做 mask 下沿的邻行保护，
    // 防止 canvas ink 扫描把下一行墨迹纳入后把 mask 撑到下一行（导出时白块侵占下一行）。
    let blockLines: { bbox?: { y?: number } }[] | null = null;
    let lineIdx = -1;
    if (doc) {
      outer: for (const pg of doc.pages) {
        for (const b of pg.blocks) {
          if (b.id !== blockId) continue;
          for (let i = 0; i < b.lines.length; i++) {
            const line = b.lines[i];
            if (line.id !== lineId) continue;
            blockLines = b.lines;
            lineIdx = i;
            glyphCount = line.glyphs.length;
            if (line.glyphs.length > 0) {
              // ── M7.8-034 Phase B: mask 只覆盖「几何发生变化的 glyph」──
              // 旧实现用**整行** glyph 并集 → mask 横跨整行 → 遮住 replacement 前面
              // 未修改的文字（用户报告：同一行前段文本被遮住下半部分）。
              // 正确语义：mask = 被改动区域的 original ink bbox（原位置 ∪ 新位置）。
              //   1. modified glyph（字符被替换）→ 必须覆盖
              //   2. 字符未变但位置被推动的 glyph → 原位置墨迹仍需覆盖
              //   3. 其余未受影响的前缀/后缀 → 绝不纳入
              const affectedGlyphs = line.glyphs.filter((g) => {
                if (g.modified) return true;
                const ob = g.originalBBox;
                if (!ob) return false;
                return (
                  Math.abs(ob.x - g.bbox.x) > 0.5 ||
                  Math.abs(ob.y - g.bbox.y) > 0.5 ||
                  Math.abs(ob.width - g.bbox.width) > 0.5 ||
                  Math.abs(ob.height - g.bbox.height) > 0.5
                );
              });
              // 退化保护：若一个都没识别到（如整行重写），回退到整行
              const boxSourceGlyphs =
                affectedGlyphs.length > 0 ? affectedGlyphs : line.glyphs;
              // F3B-6.15：几何并集交由共享 kernel，这里只保留 kernel 输入所需的数据解析
              kernelGlyphs = boxSourceGlyphs;
              firstBaseline = (boxSourceGlyphs[0] as any)?.baseline;
              currentGlyphY = boxSourceGlyphs[0]?.bbox.y;
              currentGlyphHeight = boxSourceGlyphs[0]?.bbox.height;
            }
            break outer;
          }
        }
      }
    }
    // M7.7-019: 取原始 bbox 与当前 bbox 的并集，确保 mask 覆盖全部区域
    // M7.8-034 Phase B: 横向**不再**与整行 originalBox 取并集。
    //   originalBox 是打开编辑 session 时的**整行** bbox；若与它取横向并集，
    //   mask 会重新横跨整行 → 遮住 replacement 前面未修改的文字（Phase B 要修的现象）。
    //   横向严格使用「受影响 glyph」的 originalBBox ∪ bbox（已在 currentBox 中算好）。
    //   纵向仍取并集，保证 mask 高度覆盖原行 ink（ascender + descender 都要盖住）。
    const originalBox = originalLineBBoxRef.current.get(lineId) ?? null;
    // F3B-6.15：共享 geometry kernel —— 纵向并集的唯一实现在 reconciliation-geometry.ts
    const kernelInputs = kernelGlyphs.map((g: any) => ({
      sourceBBox: (g.originalBBox ?? undefined) as
        | { x: number; y: number; width: number; height: number }
        | undefined,
      currentBBox: g.bbox as { x: number; y: number; width: number; height: number },
    }));
    currentBox = calculateReconciliationGeometry({ originalGlyphs: kernelInputs });
    let finalBox = calculateReconciliationGeometry({
      originalLineBBox: originalBox ?? undefined,
      currentGeometry: currentBox ?? undefined,
      extraInkBox,
    });
    // OCR/扫描件：并入「原文真实墨迹盒」（canvas 扫描，见 commitBlockTextToDocument OCR 分支）。
    // 必要性：markLineEdited 横向只取「受影响 glyph 的 originalBBox ∪ bbox」（M7.8-034 Phase B
    // 刻意不再与整行原 bbox 取横向并集）。而 OCR glyph 的 originalBBox 全部克隆自 seedGlyph0
    // （每个字同一坐标），原文真实位置已丢失；且 OCR 段落 bbox 本身偏窄（OCR 断行读错时更明显）。
    // 两者叠加 → mask 只盖到新文字右缘，原文超出部分漏出（用户报告：残留 "balho, a"）。
    // F3B-6.15：extraInkBox 并集已并入共享 kernel（见上方 calculateReconciliationGeometry）
    // M7.7-021: Canvas ink boundary audit — scan canvas pixels to find actual ink bottom
    if (finalBox && canvasRef.current) {
      try {
        const c = canvasRef.current;
        const ctx = c.getContext("2d");
        if (ctx) {
          // canvas pixel coords = CSS coords * cssScale
          const cssScale = c.clientWidth / c.width;
          const scanLeft = Math.max(0, Math.floor((finalBox.x) / cssScale));
          const scanTop = Math.max(0, Math.floor((finalBox.y + finalBox.height * 0.5) / cssScale));
          const scanWidth = Math.min(c.width - scanLeft, Math.ceil(finalBox.width / cssScale));
          const scanHeight = Math.min(c.height - scanTop, Math.ceil(20 / cssScale));
          // Scan bottom of the cmd bbox area for non-white pixels
          const scanBottomY = Math.max(0, Math.floor((finalBox.y + finalBox.height - 2) / cssScale));
          const bottomRow = ctx.getImageData(scanLeft, scanBottomY, scanWidth, 1).data;
          let hasInkBelow = false;
          for (let px = 0; px < bottomRow.length; px += 4) {
            if (bottomRow[px] < 240 || bottomRow[px + 1] < 240 || bottomRow[px + 2] < 240) {
              hasInkBelow = true;
              break;
            }
          }
          // Scan full height to find the last non-white pixel row
          const fullCol = ctx.getImageData(scanLeft + Math.floor(scanWidth * 0.5), scanTop, 1, scanHeight).data;
          let lastInkRow = -1;
          for (let row = 0; row < scanHeight; row++) {
            const px = row * 4;
            if (fullCol[px] < 240 || fullCol[px + 1] < 240 || fullCol[px + 2] < 240) {
              lastInkRow = row;
            }
          }
          const canvasInkBottom = lastInkRow >= 0
            ? (scanTop + lastInkRow + 1) * cssScale
            : null;
          // console.log("[M7.7-021][INK_BOUNDARY]", {
          //   lineId,
          //   cmdBboxBottom: finalBox.y + finalBox.height,
          //   baseline: firstBaseline,
          //   canvasInkBottom,
          //   hasInkBelowCmdBbox: hasInkBelow,
          //   inkOvershoot: canvasInkBottom !== null
          //     ? Math.round((canvasInkBottom - (finalBox.y + finalBox.height)) * 100) / 100
          //     : null,
          //   cssScale,
          //   scanArea: { left: scanLeft, top: scanTop, width: scanWidth, height: scanHeight },
          // });
        }
      } catch (e) {
        // console.warn("[M7.7-021][INK_BOUNDARY] scan failed:", e);
      }
    }
    // M7.7-026: 约束 canvas ink 扫描范围 — baseline ± pdfAscent/pdfDescent + tolerance
    if (finalBox && canvasRef.current && firstBaseline !== undefined) {
      try {
        const c = canvasRef.current;
        const ctx = c.getContext("2d");
        if (ctx) {
          const cssScale = c.clientWidth / c.width;
          const pdfAscent = firstBaseline - finalBox.y;
          const pdfDescent = finalBox.y + finalBox.height - firstBaseline;
          const tolerance = 2;
          // T2 (F3B-6.4B): 派生上一行 bottom（bbox 模型，零成本复用 EditableLine.bbox）。
          // 用作 (B) 扫描上界与 (C) mask 上沿钳制边界。无上一行时保持 undefined → 退回现有安全行为。
          const prevLine = blockLines && lineIdx > 0 ? blockLines[lineIdx - 1] : undefined;
          const prevBBox = prevLine?.bbox as { y?: number; height?: number } | undefined;
          const prevLineBottomY = prevBBox?.y !== undefined && prevBBox?.height !== undefined ? prevBBox.y + prevBBox.height : undefined;
          // M7.8-022A: 邻行保护 — 扫描下沿不得越过「下一行顶部」。
          // pdfDescent 由 finalBox 派生，而 finalBox 是 originalBox ∪ currentBox 的并集；
          // 一旦并集纵向膨胀，扫描区会纳入下一行墨迹 → inkBottom 取到下一行 → mask 进一步膨胀
          // （正反馈）。导出时白色 mask 因此盖住下一行上半部分，即"修改行下移侵占下一行"。
          const nextLineTop = blockLines && lineIdx >= 0
            ? blockLines[lineIdx + 1]?.bbox?.y
            : undefined;
          // T2 (F3B-6.4B) B 放宽：扫描上界由「finalBox.y - tolerance」自指改为覆盖上一行 bottom，
          // 使扫描区能探到当前行 accent/ascender（其墨迹高于 glyph bbox 顶）。
          // 无上一行（首行 / lineIdx<=0）时退回现有安全行为 finalBox.y - tolerance。
          // F3B-6.28-K（D2′ 回滚注记）：已试验扫描上界再上扩 8px —— 实现正确但未触达生效
          //   路径（见下方回滚注记），已恢复原扫描范围。
          const scanRangeTop = prevLineBottomY !== undefined
            ? prevLineBottomY
            : firstBaseline - pdfAscent - tolerance;
          const rawScanRangeBottom = firstBaseline + pdfDescent + tolerance;
          const scanRangeBottom = nextLineTop !== undefined
            ? Math.min(rawScanRangeBottom, nextLineTop)
            : rawScanRangeBottom;
          // F3B-6.28-M（D2″ 第二阶段）：ink 扫描/钳制逻辑迁移到共享模块
          //   `features/ink-box-correction.ts`（纯几何 correctBoxWithInkRows +
          //   像素适配器 scanInkRowsForRange），供本处与 reconciliation 统一写入出口复用。
          const scan = scanInkRowsForRange(c, {
            leftCss: finalBox.x,
            topCss: scanRangeTop,
            bottomCss: scanRangeBottom,
            widthCss: finalBox.width,
          });
          const rawInkBounds = { top: Math.round(scanRangeTop * 100) / 100, bottom: Math.round(scanRangeBottom * 100) / 100 };
          let constrainedInkBounds = null;
          if (scan) {
            const corrected = correctBoxWithInkRows(
              { x: finalBox.x, y: finalBox.y, width: finalBox.width, height: finalBox.height },
              scan,
              {
                // M7.7-070 + T2 (F3B-6.4B) C 放松：上沿钳制 = 上一行 bbox 底（有上一行时）。
                topBoundary: prevLineBottomY !== undefined ? prevLineBottomY : finalBox.y,
                // M7.8-022A: 下沿保护 = 下一行顶部。
                bottomBoundary: nextLineTop,
              },
            );
            constrainedInkBounds = {
              top: Math.round(corrected.box.y * 100) / 100,
              bottom: Math.round((corrected.box.y + corrected.box.height) * 100) / 100,
            };
            if (corrected.corrected) {
              finalBox = corrected.box;
            }
          }
          console.log("[M7.7-026][INK_MASK_CONSTRAINED]", {
            lineId,
            baseline: Math.round(firstBaseline * 100) / 100,
            scanRange: { top: Math.round(scanRangeTop * 100) / 100, bottom: Math.round(scanRangeBottom * 100) / 100 },
            rawInkBounds,
            constrainedInkBounds,
            finalMask: constrainedInkBounds ? { x: Math.round(finalBox.x * 100) / 100, y: Math.round(finalBox.y * 100) / 100, width: Math.round(finalBox.width * 100) / 100, height: Math.round(finalBox.height * 100) / 100 } : null,
          });
        }
      } catch (e) {
        console.warn("[M7.7-026][INK_MASK_CONSTRAINED] scan failed:", e);
      }
    }
    // M7.7-019: 审计日志
    // console.log("[M7.7-019][MASK_SOURCE]", {
      //   lineId,
      //   blockId,
      //   originalBox,
      //   currentBox,
      //   finalBox,
      //   glyphCount,
      //   firstBaseline,
      //   currentGlyphY,
      //   currentGlyphHeight,
      //   originalBoxSource: originalBox ? "session_open" : "none",
      //   currentBoxSource: currentBox ? "EditableDocument" : "none",
      // });
    // 保留 M7.7-014 旧日志的兼容输出（从 finalBox 推导）
    if (finalBox) {
      // console.log("[M7.7-014][COMMIT_MASK]", {
      //   lineId,
      //   glyphCount,
      //   maskBox: { x: Math.round(finalBox.x * 100) / 100, y: Math.round(finalBox.y * 100) / 100, w: Math.round(finalBox.width * 100) / 100, h: Math.round(finalBox.height * 100) / 100 },
      //   glyphRange: { minY: Math.round(finalBox.y * 100) / 100, maxY: Math.round((finalBox.y + finalBox.height) * 100) / 100 },
      //   firstGlyphBaseline: firstBaseline !== undefined ? Math.round(firstBaseline * 100) / 100 : null,
      //   maskTopToBaseline: firstBaseline !== undefined ? Math.round((firstBaseline - finalBox.y) * 100) / 100 : null,
      // });
      // console.log(
      //   `Sprint34.7.1_MARK lineId=${lineId} glyphs=${glyphCount} accBox=${JSON.stringify({ x: Math.round(finalBox.x * 10) / 10, y: Math.round(finalBox.y * 10) / 10, w: Math.round(finalBox.width * 10) / 10, h: Math.round(finalBox.height * 10) / 10 })}`,
      //   "color:#f59e0b;font-weight:bold;",
      // );
      // M7.7-010.8: commit 后 baseline 审计
      // console.log("[M7.7-010.8][MARK_LINE_EDITED]", {
      //   lineId,
      //   blockId,
      //   nGlyphs: glyphCount,
      //   firstGlyph: { y: currentGlyphY, h: currentGlyphHeight, baseline: firstBaseline },
      //   baselineDiff: firstBaseline !== undefined && currentGlyphY !== undefined
      //     ? Math.round((currentGlyphY - firstBaseline) * 10) / 10
      //     : null,
      // });
    }
    // M7.7-054: Directional Mask Compensation — 仅向下扩展，避免侵占上一行
    const beforeBox = finalBox ? { y: finalBox.y, height: finalBox.height } : null;
    if (finalBox) {
      // F3B-6.15：padding 唯一实现在 reconciliation-geometry.applyMaskPadding
      finalBox = applyMaskPadding(finalBox);
      console.log("[M7.7-054][MASK_DIRECTIONAL]", {
        lineId,
        before: beforeBox,
        after: { y: finalBox.y, height: finalBox.height },
        padding: { top: MASK_INK_PADDING.top, bottom: MASK_INK_PADDING.bottom },
      });
    }
    setEditedLines((prev) => (prev.has(lineId) ? prev : new Set(prev).add(lineId)));
    if (finalBox) {
      setEditedLineBoxes((prev) => {
        const ex = prev.get(lineId);
        if (
          ex &&
          ex.x === finalBox.x &&
          ex.y === finalBox.y &&
          ex.width === finalBox.width &&
          ex.height === finalBox.height
        ) {
          return prev;
        }
        const m = new Map(prev);
        // M7.7-006B3: 永不收缩——重复编辑同一行时 acc 取 finalBox 并集，
        // 已包含 original + current 的 max 范围，确保 mask 覆盖原始+编辑后全部区域。
        if (ex) {
          const nx = Math.min(ex.x, finalBox.x);
          const ny = Math.min(ex.y, finalBox.y);
          const nr = Math.max(ex.x + ex.width, finalBox.x + finalBox.width);
          const nb = Math.max(ex.y + ex.height, finalBox.y + finalBox.height);
          m.set(lineId, { x: nx, y: ny, width: nr - nx, height: nb - ny });
        } else {
          m.set(lineId, finalBox);
        }
        return m;
      });
    }
  }, []);

  /**
   * F3B-6.4B-P1-1 —— History mutation（undo/redo）后**再派生**受影响行的 render state。
   *
   * 判据 = History 中是否仍有该行**生效**的编辑（`appliedLineIds()`，纯函数 `decideRenderStateResync`）：
   *
   *   · `recompute` ⇒ 用**当前 document** 重新派生 box（复用 `markLineEdited`，**几何算法不变**）
   *   · `remove`    ⇒ 移除该行 render state（**派生结论**：该行已无生效编辑，或行已不存在）
   *
   * 为什么是「再派生」而不是「undo 就 delete」：`editedLineBoxes` 是**按 lineId 聚合**的
   * 单调 upsert；同一行可被多次编辑，必须由 History 判定「是否**仍有**生效编辑」，
   * 而不能在 undo 时无条件删除某一行（否则无法表达 A edit → B edit → undo B 应恢复哪一版 box）。
   *
   * 已知边界（见 `features/renderStateResync.ts` 头注）：History maxSize 截断会漏判；
   * `recompute` 复用 markLineEdited 的「永不收缩」并集语义（同行多次编辑时 box 可能偏大，
   * 方向为**过度遮盖**而非 ink 泄漏）。
   *
   * 调用时机：**文档写回之后**（`markLineEdited` 读 `editableDocumentRef.current`）。
   */
  const resyncEditedRenderStateForLine = useCallback(
    (blockId: string, lineId: string, redoInverse?: InverseData | null) => {
      const doc = editableDocumentRef.current;
      let lineExists = false;
      if (doc) {
        outer: for (const pg of doc.pages) {
          for (const b of pg.blocks) {
            if (b.id !== blockId) continue;
            for (const l of b.lines) {
              if (l.id === lineId) {
                lineExists = true;
                break outer;
              }
            }
          }
        }
      }
      const action = decideRenderStateResync({
        lineId,
        lineExists,
        appliedLineIds: operationHistoryRef.current?.appliedLineIds() ?? new Set<string>(),
      });
      if (action === "recompute") {
        // F3B-6.4B-P2-A-B：successful redo 的空行重建 —— 从**既有** History inverse.beforeGlyphs
        // 重新派生 extraInkBox（不新增状态来源；beforeGlyphs 只是已有 History 数据的派生输入）。
        // 仅当 redo 的 inverse 为 replace 且 beforeGlyphs 非空时使用；其它 redo/undo/非 deletion 路径保持原行为。
        let extraInkBox: ReturnType<typeof unionGlyphInkBox> | undefined;
        if (redoInverse && redoInverse.kind === "replace" && redoInverse.beforeGlyphs.length > 0) {
          extraInkBox = unionGlyphInkBox(redoInverse.beforeGlyphs);
        }
        markLineEdited(blockId, lineId, extraInkBox);
        return;
      }
      // remove：由判定得出的**派生**结论（不是「undo 就无条件 delete」）
      setEditedLines((prev) => {
        if (!prev.has(lineId)) return prev;
        const next = new Set(prev);
        next.delete(lineId);
        return next;
      });
      setEditedLineBoxes((prev) => {
        if (!prev.has(lineId)) return prev;
        const next = new Map(prev);
        next.delete(lineId);
        return next;
      });
    },
    [markLineEdited],
  );
  const [textBlocks, setTextBlocks] = useState<TextBlockInfo[]>([]);
  const [textEdit, setTextEdit] = useState<{
    blockId: string;
    text: string;
    bbox: { x: number; y: number; width: number; height: number };
    fontSize?: number;
    fontFamily?: string;
    /** PDF 原字体名（如 g_d0_f2），传给 TextEditOverlay 以保持字形保真 */
    pdfjsFontFamily?: string;
    /** M7.7-003A: 字重（glyph styleRef → styles[].fontWeight，加粗原文保真） */
    fontWeight?: number;
    /** M7.7-003A: 行高（glyph styleRef → styles[].lineHeight，贴合 PDF 排版） */
    lineHeight?: number;
    /** M7.7-003: 行级 CSS 归一化 transform（textEdit 为行内编辑，跟随文字方向） */
    transform?: [number, number, number, number, number, number];
  } | null>(null);
  // M7.7-004C: 编辑行真实文字覆盖盒（openTextEditSession 扫描 canvas 扩展后的行级 bbox）。
  // 传给 glyph-renderer 的 editingLineBox → 编辑态 mask 覆盖真实文字右缘（而非过窄的 OCR 墨迹盒）。
  const [editLineBox, setEditLineBox] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  // ── M5-IMPLEMENT-002B: EditSession（B 编辑态的 text/target truth）──
  // EditSession = 当前用户正在编辑什么（target/text/caret）；Document Model = PDF 实际是什么。
  // textEdit 仅用于 overlay 定位（bbox）；text/target 的 source of truth 是 editSession。
  const [editSession, setEditSession] = useState<EditSession | null>(null);
  // M6-001C: 同步 ref，供 Ctrl+Z 全局监听读取"当前是否在编辑"（避免闭包陈旧）
  const editSessionRef = useRef<EditSession | null>(null);
  editSessionRef.current = editSession;
  // M7.7-IMPLEMENT-001: 暴露 active EditSession 供调试/浏览器验收断言（与 __editableDocument/__currentSelection 同模式）
  if (typeof window !== "undefined") (window as any).__editSession = editSession;

  // ── M7.7-P0-B (P0-2): EditSession eager 派发器 ──
  // 任何 setEditSession 都【立即】写 editSessionRef（而非等 React render 后的 effect flush）。
  // 这修复"点击画布另一行文字 → 丢最后字符"的真正根因：点击切换时 commit 读 editSessionRef，
  // 但 render-flush 前的旧 ref 不含最后一次按键的字符（e.g. 键入 ABC 后立刻切换，ref 可能仍是 AB）。
  const dispatchSession = useCallback((s: EditSession | null) => {
    editSessionRef.current = s;
    setEditSession(s);
    if (typeof window !== "undefined") (window as any).__editSession = s;
  }, []);
  // M7.7-006: 暴露已编辑行真实墨迹覆盖盒（供导出 M5 验收断言：mask 是否用了真实墨迹而非模型 bbox）
  if (typeof window !== "undefined") (window as any).__editedLineBoxes = editedLineBoxes;

  // M7.7-004C: glyphCommands 经 ref 读取（openTextEditSession 定义在 glyphCommands useMemo 之前，
  // 若把 glyphCommands 直接放入其 deps，deps 数组会在渲染期（声明行之前）求值 →
  // TDZ ReferenceError 崩溃整个编辑器。用 ref 每帧同步最新值，回调读 ref.current 不触发 TDZ，
  // 也避免把 700 行 useMemo 整体上移。
  const glyphCommandsRef = useRef<RenderCommand[] | undefined>(undefined);

  // ── M7.7-IMPLEMENT-001: 统一"打开编辑"入口（Click 与 Update Text 共用，single truth）──
  // 职责：setEditSession + setTextEdit + setEditingBlockId + 清 pendingEdit/currentSelection/selectedText。
  // 避免 Click path 与 Update path 两套逻辑。session 由调用方（createEditSession）构造。
  //
  // M7.7-006G: 单一数据源重构 — EditableDocument 为唯一信源，消除 glyphCommandsRef 时序依赖。
  //   根因：editableDocumentRef 同步赋值（立即可用），glyphCommandsRef 依赖 React render 后才更新，
  //   首次打开 PDF 立即点击时 glyphCommandsRef 未就绪 → bbox/style 退化 → 文字排版超出 textarea 可视区域。
  //   修复：openTextEditSession 内部从 EditableDocument 搜索目标 line，推导 bbox/style/fontMetrics，
  //   glyphCommandsRef 仅用于 canvas scan（mask 渲染层，非编辑层数据源）。
  const openTextEditSession = useCallback(
    (
      blockId: string,
      te: {
        blockId: string;
        text: string;
        bbox: { x: number; y: number; width: number; height: number };
        fontSize?: number;
        pdfjsFontFamily?: string;
        fontFamily?: string;
        fontWeight?: number;
        lineHeight?: number;
        transform?: [number, number, number, number, number, number];
      },
      session: EditSession | null
    ) => {
      // M7.7-006G: 从 EditableDocument（单一真源）推导 bbox/style/fontMetrics
      const doc = editableDocumentRef.current;
      const lineId = session?.target?.lineId;
      // M7.7-070: 编辑开始 — 行绑定验证入口（确认 edit target → lineId → geometry 一致）
      if (lineId) {
        console.log("[M7.7-070][EDIT_TARGET]", {
          lineId,
          text: te.text,
          bbox: {
            x: Math.round(te.bbox.x * 100) / 100,
            y: Math.round(te.bbox.y * 100) / 100,
            width: Math.round(te.bbox.width * 100) / 100,
            height: Math.round(te.bbox.height * 100) / 100,
          },
          screenRect: {
            x: Math.round(te.bbox.x * 100) / 100,
            y: Math.round(te.bbox.y * 100) / 100,
            width: Math.round(te.bbox.width * 100) / 100,
            height: Math.round(te.bbox.height * 100) / 100,
          },
          geometryId: lineId,
        });
      }
      let finalBbox = te.bbox;
      let lineBoxForMask: { x: number; y: number; width: number; height: number } | null = null;
      let fontWeight = te.fontWeight;
      let lineHeight = te.lineHeight;
      let fontFamily = te.fontFamily;
      let pdfjsFontFamily = te.pdfjsFontFamily;
      let fontSize = te.fontSize;

      if (doc && lineId) {
        // 搜索目标 line（pages → blocks → lines）
        let foundLine: EditableLine | undefined;
        let pageIndexForTrace = -1;
        for (const pg of doc.pages) {
          pageIndexForTrace++;
          for (const b of pg.blocks) {
            if (b.id === blockId) {
              foundLine = b.lines.find((l) => l.id === lineId);
              if (foundLine) break;
            }
          }
          if (foundLine) break;
        }

        if (foundLine && foundLine.glyphs.length > 0) {
          // M7.7-010B: 使用用户点击位置 glyph 的 fontWeight，而非第一个 glyph 或 dominant。
          // 混合样式行（如 Bold + Regular）中，textarea 用单一 fontWeight 渲染整行。
          // 用户点击 Bold 词 → textarea 用 Bold；点击 Regular 词 → textarea 用 Regular。
          // 这比用 dominant（多数文字是 Regular 则全部 Regular）更符合直觉。
          const clickGlyphIndex = session?.caret?.start ?? 0;
          const clickGlyph = foundLine.glyphs[Math.min(clickGlyphIndex, foundLine.glyphs.length - 1)];
          const clickStyleRef = clickGlyph?.styleRef ?? foundLine.glyphs[0]?.styleRef ?? 0;
          const st = doc.styles?.[clickStyleRef];
          if (st) {
            fontWeight = fontWeight ?? (typeof st.fontWeight === "number" ? st.fontWeight : undefined);
            lineHeight = lineHeight ?? st.lineHeight;
            fontFamily = fontFamily ?? st.fontFamily;
            pdfjsFontFamily = pdfjsFontFamily ?? st.pdfjsFontFamily;
            fontSize = fontSize ?? st.fontSize;
          }
          // [M7.7-008A] style 来源诊断
          // console.log("[M7.7-008A][STYLE_TRACE] openTextEditSession:", {
          //   pageIndex: pageIndexForTrace,
          //   blockId,
          //   lineId,
          //   clickGlyphIndex,
          //   clickStyleRef,
          //   stylesCount: doc.styles?.length,
          //   sourceStyle: st ? { fontSize: st.fontSize, fontFamily: st.fontFamily, fontWeight: st.fontWeight, lineHeight: st.lineHeight } : null,
          //   resolved: { fontSize, fontWeight, fontFamily, lineHeight },
          // });
          // M7.7-010 Audit-0+1: 检查 EditableDocument 中 glyph 的 styleRuns（连续字符的 styleRef 边界）
          const styleRuns: { styleRef: number; text: string; start: number; end: number; fontWeight: number | string }[] = [];
          let currentRun: { styleRef: number; text: string; start: number; end: number; fontWeight: number | string } | null = null;
          for (let gi = 0; gi < foundLine.glyphs.length; gi++) {
            const g = foundLine.glyphs[gi];
            const ref = g.styleRef ?? 0;
            const st = doc.styles?.[ref];
            const fw = st?.fontWeight ?? "?";
            if (!currentRun || currentRun.styleRef !== ref) {
              if (currentRun) styleRuns.push(currentRun);
              currentRun = { styleRef: ref, text: g.char, start: gi, end: gi, fontWeight: fw };
            } else {
              currentRun.text += g.char;
              currentRun.end = gi;
            }
          }
          if (currentRun) styleRuns.push(currentRun);
          console.log(`[M7.7-010][STYLE_BOUNDARY] lineId="${lineId}" glyphCount=${foundLine.glyphs.length} runs=${styleRuns.length}`, styleRuns.map(r => `  [${r.start}-${r.end}] styleRef=${r.styleRef} fontWeight=${r.fontWeight} text="${r.text.substring(0, 40)}"`));
          // 字符级 style 映射（前 10 个 + 后 5 个，中间有变化时展示）
          const charStyleSample = foundLine.glyphs.map((g, i) => `[${i}]${g.char}->styleRef=${g.styleRef}`);
          const sampleLen = charStyleSample.length;
          const sampleOut = sampleLen <= 20 ? charStyleSample : [
            ...charStyleSample.slice(0, 10),
            `  ... (${sampleLen - 15} chars omitted) ...`,
            ...charStyleSample.slice(sampleLen - 5),
          ];
          console.log(`[M7.7-010][GLYPH_STYLE_MAP] lineId="${lineId}"\n${sampleOut.join("\n")}`);
          // 从 EditableDocument 推导 bbox（glyph bbox 并集）
          const acc = foundLine.glyphs.reduce<{
            minX: number; minY: number; maxX: number; maxY: number;
          }>(
            (a, g) => ({
              minX: Math.min(a.minX, g.bbox.x),
              minY: Math.min(a.minY, g.bbox.y),
              maxX: Math.max(a.maxX, g.bbox.x + g.bbox.width),
              maxY: Math.max(a.maxY, g.bbox.y + g.bbox.height),
            }),
            { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
          );
          lineBoxForMask = { x: acc.minX, y: acc.minY, width: acc.maxX - acc.minX, height: acc.maxY - acc.minY };
          // M7.7-019: 存储原始行 bbox（打开编辑 session 时的真实 glyph 覆盖盒），
          // 供 markLineEdited 在 commit 后计算 mask 并集使用（确保 mask 覆盖原始+编辑后全部区域）。
          originalLineBBoxRef.current.set(lineId, { ...lineBoxForMask });
          // M7.7-014 Forensic: 编辑 mask 覆盖审计 — mask 是否完全覆盖原 PDF glyph
          // console.log("[M7.7-014][EDIT_MASK]", {
          //   lineId,
          //   glyphCount: foundLine.glyphs.length,
          //   maskBox: { x: Math.round(acc.minX * 100) / 100, y: Math.round(acc.minY * 100) / 100, w: Math.round((acc.maxX - acc.minX) * 100) / 100, h: Math.round((acc.maxY - acc.minY) * 100) / 100 },
          //   glyphRange: { minY: Math.round(acc.minY * 100) / 100, maxY: Math.round(acc.maxY * 100) / 100 },
          //   firstBaseline: foundLine.glyphs[0]?.baseline !== undefined
          //     ? Math.round(foundLine.glyphs[0].baseline * 100) / 100
          //     : null,
          //   maskTopToBaseline: foundLine.glyphs[0]?.baseline !== undefined
          //     ? Math.round((foundLine.glyphs[0].baseline - acc.minY) * 100) / 100
          //     : null,
          // });
          const modelBboxForTextarea = { ...lineBoxForMask };
          // M7.7-013 Audit-2: 编辑会话输入审计 — 确认 glyph 数据源正确
          // console.log("[M7.7-013][EDIT_SESSION_INPUT]", {
          //   lineId,
          //   pageIndex: pageIndexForTrace,
          //   glyphCount: foundLine.glyphs.length,
          //   firstGlyph: {
          //     y: Math.round(foundLine.glyphs[0]?.bbox.y * 100) / 100,
          //     baseline: Math.round((foundLine.glyphs[0] as any)?.baseline * 100) / 100,
          //     height: Math.round(foundLine.glyphs[0]?.bbox.height * 100) / 100,
          //   },
          //   lastGlyph: {
          //     y: Math.round(foundLine.glyphs[foundLine.glyphs.length - 1]?.bbox.y * 100) / 100,
          //     baseline: Math.round((foundLine.glyphs[foundLine.glyphs.length - 1] as any)?.baseline * 100) / 100,
          //     height: Math.round(foundLine.glyphs[foundLine.glyphs.length - 1]?.bbox.height * 100) / 100,
          //   },
          //   glyphRange: {
          //     minY: Math.round(acc.minY * 100) / 100,
          //     maxY: Math.round(acc.maxY * 100) / 100,
          //   },
          // });
          // M7.7-012: 编辑框 y 使用 baseline 定位，与 glyph-renderer 一致。
          // 需在 mask 计算之前计算 textareaY，以便 mask 与编辑框对齐。
          const firstGlyphBaseline = foundLine.glyphs[0]?.baseline;
          const lastGlyphBaseline = foundLine.glyphs[foundLine.glyphs.length - 1]?.baseline;
          let textareaY = modelBboxForTextarea.y;
          if (firstGlyphBaseline !== undefined && typeof document !== "undefined") {
            try {
              const mCanvas = document.createElement("canvas");
              const mCtx = mCanvas.getContext("2d");
              if (mCtx) {
                const mFontSpec = `${fontWeight ?? 400} ${fontSize ?? 16}px ${fontFamily ?? "sans-serif"}`;
                mCtx.font = mFontSpec;
                const mMetrics = mCtx.measureText("M");
                const mAscent = mMetrics.actualBoundingBoxAscent || Math.round((fontSize ?? 16) * 0.72);
                // M7.7-012B: 使用 PDF ascent 作为上限，避免 CSS ascent 大于 PDF ascent 时编辑框上移。
                const mPdfAscent = firstGlyphBaseline - modelBboxForTextarea.y;
                const mFinalAscent = Math.min(mAscent, mPdfAscent);
                textareaY = firstGlyphBaseline - mFinalAscent;
              }
            } catch (e) {
              // fallback: use model bbox y
            }
          }
          // M7.7-014: 删除 inkBbox 依赖。mask 使用 glyph model bbox（minY/maxY），
          // 不再使用 canvas scan（inkBbox）。inkBbox 会扫描到相邻行的墨迹像素，
          // 导致 mask 覆盖上一行文本。
          // lineBoxForMask 保持为 glyph bbox（acc 计算值，line 1054）
          finalBbox = { ...modelBboxForTextarea, y: textareaY };
          // M7.7-010.9: 编辑框几何数据诊断（含 baseline）
          // console.log("[M7.7-010.9][EDIT_SESSION_GEOMETRY]", {
          //   lineId,
          //   pageIndex: pageIndexForTrace,
          //   blockId,
          //   glyphCount: foundLine.glyphs.length,
          //   modelBbox: modelBboxForTextarea,
          //   finalBbox,
          //   lineBoxForMask,
          //   firstGlyphBaseline,
          //   lastGlyphBaseline,
          //   baselineToModelTop: firstGlyphBaseline !== undefined
          //     ? Math.round((firstGlyphBaseline - modelBboxForTextarea.y) * 10) / 10
          //     : null,
          //   fontSize,
          //   lineHeight,
          //   transform: te.transform,
          // });
          // M7.7-012A: 编辑框 y 位置根因审计
          // 对比 modelBbox.y, baseline, ascent, 和最终 textareaY
          // 如果 ascent 过大 → textareaY 过高 → 编辑框上移
          const mAscentAudit = (() => {
            if (typeof document === "undefined" || firstGlyphBaseline === undefined) return null;
            try {
              const c = document.createElement("canvas");
              const cx = c.getContext("2d");
              if (!cx) return null;
              const spec = `${fontWeight ?? 400} ${fontSize ?? 16}px ${fontFamily ?? "sans-serif"}`;
              cx.font = spec;
              const m = cx.measureText("M");
              return {
                fontSpec: spec,
                actualBoundingBoxAscent: m.actualBoundingBoxAscent,
                actualBoundingBoxDescent: m.actualBoundingBoxDescent,
                fontBoundingBoxAscent: (m as any).fontBoundingBoxAscent,
                fontBoundingBoxDescent: (m as any).fontBoundingBoxDescent,
              };
            } catch { return null; }
          })();
          // console.log("[M7.7-012A][EDITOR_Y_AUDIT]", {
          //   lineId,
          //   blockId,
          //   modelBboxY: modelBboxForTextarea.y,
          //   modelBboxBottom: modelBboxForTextarea.y + modelBboxForTextarea.height,
          //   firstGlyphBaseline,
          //   textareaY,
          //   yShiftUp: modelBboxForTextarea.y - textareaY,
          //   pdfAscent: firstGlyphBaseline !== undefined
          //     ? Math.round((firstGlyphBaseline - modelBboxForTextarea.y) * 100) / 100
          //     : null,
          //   cssAscent: mAscentAudit?.actualBoundingBoxAscent ?? null,
          //   ascentDiff: firstGlyphBaseline !== undefined && mAscentAudit
          //     ? Math.round(((firstGlyphBaseline - modelBboxForTextarea.y) - mAscentAudit.actualBoundingBoxAscent) * 100) / 100
          //     : null,
          //   fontMetrics: mAscentAudit,
          //   fontSize,
          //   fontFamily,
          //   fontWeight,
          // });
          // M7.7-011A: 坐标审计 — finalBbox 与模型坐标链
          // console.log("[M7.7-011A][COORD_FINAL_BBOX]", {
          //   lineId,
          //   blockId,
          //   modelBbox: modelBboxForTextarea,
          //   finalBbox,
          //   textareaY,
          //   baseline: firstGlyphBaseline,
          //   expectedSpanTop: firstGlyphBaseline !== undefined
          //     ? Math.round((firstGlyphBaseline - ((fontSize ?? 16) * 0.72)) * 100) / 100
          //     : null,
          // });
          // M7.7-013 Audit-3: 最终 bbox 来源审计 — 确认 finalBbox 与 glyph 数据源一致
          // console.log("[M7.7-013][BBOX_TRACE]", {
          //   lineId,
          //   modelBbox: finalBbox ? { x: Math.round(finalBbox.x * 100) / 100, y: Math.round(finalBbox.y * 100) / 100, w: Math.round(finalBbox.width * 100) / 100, h: Math.round(finalBbox.height * 100) / 100 } : null,
          //   finalBbox: finalBbox ? { y: Math.round(finalBbox.y * 100) / 100, h: Math.round(finalBbox.height * 100) / 100 } : null,
          //   baseline: firstGlyphBaseline !== undefined ? Math.round(firstGlyphBaseline * 100) / 100 : null,
          //   textareaY: typeof textareaY === "number" ? Math.round(textareaY * 100) / 100 : null,
          // });
        }
      }
      setEditingBlockId(blockId);
      setTextEdit({ ...te, bbox: finalBbox, fontWeight, lineHeight, fontFamily, pdfjsFontFamily, fontSize });
      setEditLineBox(lineBoxForMask);
      dispatchSession(session);
      // single truth：打开编辑后清 pendingEdit / currentSelection / selectedText
      setPendingEdit(null);
      setCurrentSelection(null);
      setSelectedText(null);
      // M7.7-003: 进入编辑 → 关闭拖选浮层菜单（inline-first）
      setSelectionMenu(null);
    },
    // M7.7-006G: 所有数据从 ref 读取（editableDocumentRef / canvasRef），不入 deps 避免 TDZ。
    []
  );

  // ── OCR-EDIT-SYNC: 段落块 Portal 编辑 → EditableDocument 同步 ──
  // 背景：扫描件（无原生文本层）经 OCR 注入的 docBlocks 是**段落级**文本块，
  // 页面显示（GlyphRenderer）与导出（export-renderer）都只消费 EditableDocument；
  // native-canvas 视图下 block 自身文字 span 隐藏，仅靠 EditableDocument 的 glyph 层呈现。
  //
  // 根因与根本修复：
  //   旧实现按 \n 逐行调用 mutateLineText（为原生 PDF 文本项设计），行数不一致时按比例切分；
  //   这会把 OCR「逐字精确测量」的 glyph 位置破坏，且无法对齐导出字体度量 →
  //   导出整行逐 glyph 绝对 x 绘制时字距错位（"Ate sto que" 被打散/插空格）。
  //   改用与初始构建相同的 Layout Engine（reconstructBlockLayout）整块重排：
  //   用同一测量字体重排整段，逐字位置自洽、行内自然字距，导出整行自然字距绘制 → 根治。
  //   原生 PDF 文本块（source !== "ocr"）保持逐行 mutation 路径，零影响。
  const commitBlockTextToDocument = useCallback(
    (blockId: string, text: string) => {
      const doc = editableDocumentRef.current;
      if (!doc || !blockId) return;

      let target: any = null;
      let targetPage: any = null;
      for (const pg of doc.pages) {
        const b = pg.blocks.find((x: any) => x.id === blockId);
        if (b) {
          target = b;
          targetPage = pg;
          break;
        }
      }
      if (!target || !target.lines || target.lines.length === 0) return;

      const oldText = target.lines
        .map((l: any) => (l.glyphs ?? []).map((g: any) => g.char).join(""))
        .join("\n");
      if (oldText === text) return; // 无变化 → 不触发无谓的版本递增/重渲染

      // ── F3B-6.25-E1-OCR-Impl：Core owned ⇒ 拒绝 block 文本 semantic mutation（禁止文档分裂）──
      //   与 TextEdit / Segment **同契约**：`owned` 后 `shouldRehydrate()` 恒 false ⇒
      //   本入口的 `reconstructBlockLayout`（OCR）/ `mutateLineText`（native）永不回补进 Core
      //   ⇒ Core 与 Legacy 各自只含一部分编辑，两条导出路都会丢 ⇒ 必须 fail-closed。
      //   ⇒ 拒绝时：不重建布局、不改 Legacy 文档、不翻 exportOwnership（保持 core）。
      //   ⚠️ 判据是 **owned**：未 owned 时 OCR/Legacy 路径完整保留
      //      （未建立 Core 时的 OCR 能力不受影响；那时 rehydrate 会吸收该编辑 ⇒ 无分歧）。
      if (coreLifecycleRef.current?.owned) {
        console.warn("[F3B-6.25][CORE_OWNED_LEGACY_BLOCK_EDIT_BLOCKED]", {
          reason: "core-owned-legacy-block-edit-blocked",
          blockId,
          owned: true,
        });
        return;
      }

      let next: any = doc;
      let linesToMark: any[] = [];
      // OCR/扫描件：原文真实墨迹覆盖盒（canvas 像素扫描得到，见下方 OCR 分支）。
      // 用途：markLineEdited 的横向范围只取「受影响 glyph 的 originalBBox ∪ bbox」，而 OCR glyph
      // 的 originalBBox 全部克隆自 seedGlyph0（同一坐标）→ 原文真实位置已丢失；加上 OCR 段落 bbox
      // 本身偏窄（OCR 断行读错），mask 只能盖到新文字右缘，原文超出部分漏出（残留 "balho, a"）。
      // 提交时 canvas 仍是 pdf.js 渲染的扫描原图（编辑文本由 GlyphRenderer 叠在独立图层），
      // 故扫描段落行带即可得到原文墨迹的真实横向范围。
      const ocrInkBoxes = new Map<string, { x: number; y: number; width: number; height: number }>();

      if (target.source === "ocr") {
        // OCR / 无原生文本层：用 Layout Engine 整块重建（逐字位置自洽）。
        const seedGlyph0: any = target.lines[0]?.glyphs[0] ?? null;
        const seedStyle: any = target.lines[0]?.style ?? {};
        // 重排基准：用 OCR 段落 bbox（= 表单文字宽度）作为 originalBounds/bbox，
        // 换行宽度 = 原文所在表单宽度，重建后行数与原文一致：
        //   ① 避免"整段 + 尾行"重复——整段编辑文本作为【单个段落】喂入，不再沿用原始
        //      多行 lines（旧实现把旧尾行当第二个段落，导出出现"整段 + 重复尾行"）；
        //   ② 避免整段挤成一行溢出表单右界（旧实现按 availableLineWidth=整页宽换行）。
        const ocrb: any =
          target.originalBounds && target.originalBounds.width > 0
            ? target.originalBounds
            : target.bbox;
        const useOcrWidth = !!(ocrb && ocrb.width > 50);
        const editedBlock: any = {
          ...target,
          originalBounds: ocrb,
          bbox: ocrb,
          // 把整段编辑后文本作为单个种子行（一个段落）喂入；reconstructBlockLayout
          // 按 \n 还原用户显式换行，再按 originalBounds 宽度逐词重排（与初始 OCR 布局一致）。
          lines: [
            {
              id: `${target.id}_L0`,
              bbox: ocrb ?? target.lines[0].bbox,
              glyphs: Array.from(text).map((c: string) => ({
                char: c,
                originalChar: c,
                bbox: seedGlyph0 ? { ...seedGlyph0.bbox } : { x: 0, y: 0, width: 0, height: 0 },
                originalBBox: seedGlyph0 ? { ...seedGlyph0.bbox } : { x: 0, y: 0, width: 0, height: 0 },
                styleRef: seedGlyph0?.styleRef ?? 0,
                modified: true,
                transform: seedGlyph0?.transform ?? [1, 0, 0, 1, 0, 0],
              })),
              source: target.lines[0]?.source ?? "ocr",
              style: { ...seedStyle },
            },
          ],
        };
        // pageWidth 传 undefined → computeAvailableLineWidth 回退为 originalBounds.width（表单宽度），
        // 文本按表单宽度换行而非整页宽（整页宽会让整段挤成一行溢出表单右界）。

        // ── M7.8-048-FIX-REFLOW: 携带原 block 真实逐字 bbox，使 unchanged glyph 锚定原始几何 ──
        // 收集原 block 扁平 glyph（cp 顺序，不含 \n），与 newText 做 common-prefix/suffix diff，
        // 把 unchanged 区间（prefix / suffix）映射到原始 glyph；编辑区间交由 buildGlyphs 流水重排。
        // 索引语义统一为 code-point（Array.from），不假设 text[i] === glyph[i] 的 code-unit 等价，
        // 以兼容 Unicode / surrogate / 空格 / 多 glyph 等情况（Constraint A）。
        const originalGlyphs: any[] = [];
        target.lines.forEach((l: any) => {
          (l.glyphs ?? []).forEach((g: any) => originalGlyphs.push(g));
        });
        const oldFull = target.lines
          .map((l: any) => (l.glyphs ?? []).map((g: any) => g.char).join(""))
          .join("\n");
        const oldCleanArr = Array.from(oldFull.replace(/\n/g, ""));
        const newCleanArr = Array.from((text ?? "").replace(/\n/g, ""));
        let p = 0;
        const maxP = Math.min(oldCleanArr.length, newCleanArr.length);
        while (p < maxP && oldCleanArr[p] === newCleanArr[p]) p++;
        let s = 0;
        const maxS = maxP - p;
        while (
          s < maxS &&
          oldCleanArr[oldCleanArr.length - 1 - s] === newCleanArr[newCleanArr.length - 1 - s]
        ) {
          s++;
        }
        const anchorMap = new Map<number, any>();
        for (let i = 0; i < p; i++) anchorMap.set(i, originalGlyphs[i]);
        for (let i = 0; i < s; i++) {
          const newIdx = newCleanArr.length - s + i;
          const oldIdx = oldCleanArr.length - s + i;
          anchorMap.set(newIdx, originalGlyphs[oldIdx]);
        }
        if (typeof console !== "undefined") {
          console.log("[REFLOW-HYBRID]", {
            blockId,
            oldLen: oldCleanArr.length,
            newLen: newCleanArr.length,
            prefix: p,
            suffix: s,
            anchorSize: anchorMap.size,
            editedRun: `${p}..${newCleanArr.length - s}`,
          });
        }

        let rebuilt: any = reconstructBlockLayout(
          editedBlock,
          doc.styles as any,
          useOcrWidth ? undefined : targetPage.width,
          { anchorMap }
        );
        // 修复（编辑器/导出"空白遮盖、只露文本头部"）：
        // reconstructBlockLayout 把 block/line 的 bbox.width 设为 availableLineWidth，传入
        // targetPage.width 时等于整页可用宽。Glyph Layer 的遮罩 patch 坐标直接取 EditableBlock.bbox
        // （见 glyphCommands 计算），于是白底遮罩被撑到整行宽，盖住原文右侧 → 编辑器与导出都出现
        // "空白遮盖、只露文本头部"。把 block 与每行的 bbox.width 收敛回原文覆盖区域宽度
        // （originalBounds.width），仅影响"遮盖/显示框"，glyph 真实像素 x 位置不受影响。
        const maskWidth =
          (target.originalBounds?.width as number | undefined) ??
          (target.bbox?.width as number | undefined) ??
          rebuilt.bbox.width;
        // 整块标记为已编辑：导出整行重绘（measured-only 路径自然字距），页面显示改后文本。
        rebuilt = {
          ...rebuilt,
          // 导出/预览统一走 RECONSTRUCT：用 glyph.bbox（buildGlyphs 逐字精确位置），
          // 而非 originalBBox。OCR 编辑时所有 glyph 的 originalBBox 都克隆自 seedGlyph0
          // （同一坐标），若走 PRESERVE 会把整段文字叠在第一字位置 → "导出打散"。
          layoutMode: "reconstruct",
          bbox: { ...rebuilt.bbox, width: maskWidth },
          lines: rebuilt.lines.map((l: any) => ({
            ...l,
            bbox: { ...l.bbox, width: maskWidth },
            glyphs: l.glyphs.map((g: any) => ({ ...g, modified: true })),
          })),
        };
        next = {
          ...doc,
          pages: doc.pages.map((pg: any) =>
            pg === targetPage
              ? {
                  ...pg,
                  blocks: pg.blocks.map((b: any) => (b.id === blockId ? rebuilt : b)),
                }
              : pg
          ),
        };
        linesToMark = rebuilt.lines;
        // ── F3B-6.25-C-Impl：`lineId → paragraphId` 加速表的**唯一结构失效点** ──
        //   本分支用 reconstructBlockLayout 整块重建 ⇒ 行 id 被**重新编号**为
        //   `${block.id}_L{n}` 且行数/行位可变（下标派生的 id 会指向不同内容）。
        //   而 Core 若已 owned，`shouldRehydrate()` 返回 false ⇒ Core 不重建、仍持有旧段落；
        //   此时若保留旧 map，后续 TextEdit 会在 scan miss 后命中**旧**归属 ⇒ 编辑落到旧段落。
        //   ⇒ 必须在此 clear。
        //   ⚠️ **仅**本分支：native 分支走 mutateLineText（不改 lineId，必须 retain），
        //      re-import 已有自己的 clear（F3B-6.24-B2），Core TextEdit 必须 retain。
        lineIdParagraphMapRef.current.clear();
        // ── 求「原文真实墨迹右缘」，确保导出遮罩盖住全部原文 ──
        // 背景：OCR 段落 bbox（ocrb）常窄于真实墨迹（OCR 断行可能读错，本例原文行1 实为
        // "...afastamento do trabalho, a"，墨迹延伸到 pt 1769，而 ocrb 只到 ~1506）。
        // 而 markLineEdited 的横向范围只取「受影响 glyph 的 originalBBox ∪ bbox」，OCR glyph 的
        // originalBBox 又全部克隆自 seedGlyph0（同一坐标）→ mask 只能盖到新文字右缘 →
        // 原文超出部分漏出（用户报告：残留 "balho, a"、原文行与新文本行同时显示）。
        //
        // 策略（扫描优先 + 兜底，避免单一手段失效就完全退化）：
        //   ① canvas 扫描：提交时 canvas 仍是 pdf.js 渲染的扫描原图（编辑文本在独立图层），
        //      在「原文段落行带」内找最右侧墨迹列（行带严格取 ocrb 上下界，不越界擦上下文）。
        //   ② 兜底：扫描不可用 / 未命中墨迹时，取「段落宽 ×1.5」并夹到页宽。
        //      宁可略宽（该行带内本就是本段原文），也不能漏盖导致原文残留。
        // 用段落级而非逐行：新文本行数/行位会变（本例 2 行→3 行），逐行行带会错位失效。
        {
          const boxLeft = ocrb.x - 2;
          const pageRight = (targetPage?.width as number) || ocrb.x + ocrb.width * 1.5;
          const fallbackRight = Math.min(pageRight, ocrb.x + ocrb.width * 1.5);
          let inkRight = fallbackRight;
          let inkSource = "fallback(1.5x)";
          try {
            const cv: any = canvasRef.current;
            const c2d: any = cv?.getContext?.("2d");
            if (c2d && cv && cv.width > 0 && cv.height > 0) {
              // 文档 CSS 坐标 → canvas 像素：canvas px = doc coord / cssScale
              const cssScale = cv.clientWidth > 0 ? cv.clientWidth / cv.width : 1;
              const bandTop = Math.max(0, Math.floor((ocrb.y - 2) / cssScale));
              const bandBottom = Math.min(
                cv.height,
                Math.ceil((ocrb.y + ocrb.height + 2) / cssScale)
              );
              const scanLeft = Math.max(0, Math.floor(boxLeft / cssScale));
              // 扫描上限：段落宽 ×2.5（OCR bbox 偏窄时仍能到达真实行尾），并夹在画布内
              const scanRight = Math.min(
                cv.width,
                Math.ceil((ocrb.x + ocrb.width * 2.5) / cssScale)
              );
              const sw = scanRight - scanLeft;
              const sh = bandBottom - bandTop;
              if (sw > 0 && sh > 0) {
                const pxData = c2d.getImageData(scanLeft, bandTop, sw, sh).data;
                let lastInkCol = -1;
                for (let col = 0; col < sw; col++) {
                  for (let row = 0; row < sh; row++) {
                    const p = (row * sw + col) * 4;
                    if (pxData[p] < 240 || pxData[p + 1] < 240 || pxData[p + 2] < 240) {
                      lastInkCol = col;
                      break;
                    }
                  }
                }
                if (lastInkCol >= 0) {
                  // +2 覆盖抗锯齿右缘，避免残留半透明描边
                  const scanned = (scanLeft + lastInkCol + 2) * cssScale;
                  if (Number.isFinite(scanned)) {
                    inkRight = Math.max(fallbackRight, scanned);
                    inkSource = "canvas-scan";
                  }
                }
              }
            }
          } catch {
            // 扫描失败 → 沿用 fallback，不影响文本落库与导出
          }
          const rightBound = Math.min(pageRight, inkRight);
          const paraInkBox = {
            x: boxLeft,
            y: ocrb.y - 2,
            width: Math.max(ocrb.width, rightBound - boxLeft + 4),
            height: ocrb.height + 4,
          };
          // 只对与「原文行带」重叠的重建行生效；新多出来的行（原文该处无墨迹）不套用，
          // 避免把遮罩横向拉到本无墨迹的行、误擦该行右侧其它内容。
          // M7.8-0XX: 必须按**行**裁剪 paraInkBox 的纵向范围，否则每行 mask 都是整段高度，
          // 会盖住同段其它行（用户报告：编辑后文本变空白、白块底部侵占下一行）。
          for (const ln of rebuilt.lines as any[]) {
            const lb = ln?.bbox;
            if (!lb) continue;
            const overlaps = lb.y < ocrb.y + ocrb.height && lb.y + lb.height > ocrb.y;
            if (!overlaps) continue;
            const padY = 4;
            const top = Math.max(paraInkBox.y, lb.y - padY);
            const bottom = Math.min(paraInkBox.y + paraInkBox.height, lb.y + lb.height + padY);
            if (bottom > top) {
              ocrInkBoxes.set(ln.id, {
                x: paraInkBox.x,
                y: top,
                width: paraInkBox.width,
                height: bottom - top,
              });
            }
          }
          if (typeof console !== "undefined") {
            console.log("[OCR_INK_SCAN]", {
              blockId,
              ocrb: { x: ocrb.x, y: ocrb.y, w: ocrb.width, h: ocrb.height },
              inkRight: +rightBound.toFixed(1),
              inkSource,
              paraInkBox,
              appliedLines: [...ocrInkBoxes.keys()],
            });
          }
        }
      } else {
        // 原生 PDF 文本块：保留逐行 mutation（行数一致按 \n 对应；不一致按比例切分）。
        const lineTexts: string[] = target.lines.map((l: any) =>
          (l.glyphs ?? []).map((g: any) => g.char).join("")
        );
        const byNewline = text.split("\n");
        let newLines: string[];
        if (byNewline.length === target.lines.length) {
          newLines = byNewline;
        } else {
          const total = lineTexts.reduce((s: number, t: string) => s + t.length, 0);
          newLines = [];
          let pos = 0;
          for (let i = 0; i < lineTexts.length - 1; i++) {
            const take = total > 0 ? Math.round((text.length * lineTexts[i].length) / total) : 0;
            newLines.push(text.slice(pos, pos + take));
            pos += take;
          }
          newLines.push(text.slice(pos));
        }
        for (let i = 0; i < target.lines.length; i++) {
          const r = mutateLineText(next, blockId, target.lines[i].id, newLines[i] ?? "");
          next = r.document;
          if (newLines[i] !== lineTexts[i]) linesToMark.push(target.lines[i]);
        }
      }

      editableDocumentRef.current = next;
      (window as any).__editableDocument = next;
      setEditableDocVersion((v) => v + 1);
      console.log("[COMMIT-DIAG] wrote next, blockId=", blockId, "newText=", (next.pages ?? []).flatMap((p: any) => p.blocks).find((b: any) => b.id === blockId)?.lines?.map((l: any) => l.glyphs?.map((g: any) => g.char).join("")).join(" | "));
      // 标记行已编辑（committed）→ GlyphRenderer 渲染改后文本 + 导出 mask/重绘。
      for (const l of linesToMark) {
        try {
          // ocrInkBox：仅 OCR/扫描件分支有值（原文真实墨迹盒），原生 PDF 分支为 null → 行为不变
          markLineEdited(blockId, l.id, ocrInkBoxes.get(l.id) ?? null);
        } catch {
          // canvas 墨迹扫描失败只影响 mask 范围，不影响文本落库与导出
        }
      }
    },
    [markLineEdited]
  );

  // ── M7.7-007: EditSession Lifecycle ──
  // commitActiveEdit: 提交当前活跃编辑（如有）→ document mutation + markLineEdited + 清理 session 状态。
  // 返回 true 表示已提交（有 dirty session），false 表示无活跃编辑。
  // 注意：onTextEditSave 内联已包含完整 save 逻辑（L7364-7488），此处仅提供可复用的退出入口。
  // 这些函数只读 ref（editSessionRef/editableDocumentRef），page 通过遍历所有 pages 定位 block（无需 page 参数）。
  const commitActiveEdit = useCallback((): boolean => {
    const session = editSessionRef.current;
    if (!session || session.status !== "active") return false;
    if (session.text === session.originalText) {
      // 文本未变 → 直接清理，不触发 document mutation
      dispatchSession(null);
      setEditingBlockId(null);
      setTextEdit(null);
      setEditLineBox(null);
      return true;
    }
    // 文本已变 → 通过 requestEditTransition 触发 blur → save 链路
    return requestEditTransition("COMMIT");
  }, []);

  // requestEditTransition: 统一退出入口。任何离开编辑环境的操作都必须先调用此函数。
  // 返回 true 表示已提交并清理，false 表示无活跃编辑无需处理。
  const requestEditTransition = useCallback((_reason: string): boolean => {
    const session = editSessionRef.current;
    // M7.7-007C Audit 1: 翻页前 EditSession 状态诊断
    if (session && session.status === "active") {
      // console.log("[M7.7-007C][AUDIT1] requestEditTransition before:", {
        //   reason: _reason,
        //   dirty: session.text !== session.originalText,
        //   text: session.text,
        //   original: session.originalText,
        //   targetLineId: session.target.lineId,
        //   page: page,
        // });
    }
    if (!session || session.status !== "active") return false;
    // 有活跃编辑 → 触发 blur/commit（textarea 会调用 onSave 或 onCancel）
    const ta = document.querySelector('[data-layer="textEdit"] textarea') as HTMLTextAreaElement | null;
    if (ta) {
      ta.blur();
    }
    // blur 后等待一帧让 commit 完成，再清理
    // 但注意：blur 是异步的，commit 可能在下一帧执行。
    // 对于同步退出，直接 dispatchSession(null) 清理
    dispatchSession(null);
    setEditingBlockId(null);
    setTextEdit(null);
    setEditLineBox(null);
    return true;
  }, []);

  // setPageWithCommit: 翻页前先提交当前编辑
  const setPageWithCommit = useCallback((p: number | ((prev: number) => number)) => {
    requestEditTransition("PAGE_CHANGE");
    setPage(p);
  }, [requestEditTransition, setPage]);

  // M7.7-007B: 注册翻页守卫 — 使所有通过 useEditor().setPage 的调用（缩略图/prev/next/usePageOps）
  // 都先 commit 当前编辑会话，再执行实际翻页。
  pageChangeGuardRef.current = () => requestEditTransition("PAGE_CHANGE");

  // ── Feature hooks (Commit 3) ──
  // 012-F2：Core 输入 session ref 提前声明，供下方 useExport 取真实生产 Core EditorDocument 做影子导出
  const coreInputSessionRef = useRef<CoreInputSession | null>(null);
  // EDITOR-CORE-012-F3B-1：import-time 持久化的唯一 Core EditorDocument 的**生命周期引用**。
  // ⚠️ 这不是"第二份 document state"——它只是持有由 import 边界一次性创建的、全 PDF 唯一的 Core 文档；
  //    数据所有权在 Core history/document model，session 与 export 都只"使用"它（见下方 useEffect）。
  const coreDocumentRef = useRef<EditorDocument | null>(null);
  // EDITOR-CORE-012-F3B-1.1：Core Document Ownership & Rehydration 状态机（每组件实例一个，纯逻辑、可单测）。
  // 它决定「legacy mutation 是否允许覆盖已存在的 Core document」——一旦 Core editing 开始 owning truth，
  // legacy mutation 不得再触发 Core re-import（避免重新制造 Legacy↔Core 双向 truth）。
  const coreLifecycleRef = useRef<CoreDocumentLifecycle | null>(null);
  if (!coreLifecycleRef.current) coreLifecycleRef.current = new CoreDocumentLifecycle();
  // lastLegacyDocRef：上一次用于 rehydrate 的 legacy doc 对象，避免 render-only version bump（doc 未变）重复派生。
  const lastLegacyDocRef = useRef<EditableDocument | null>(null);
  // F3B-6.12：Binding Sidecar —— per-import 的 immutable PDF fidelity snapshot。
  // 只持有引用；数据所有权在 builder。仅在真正 import 时构建，re-import 边界释放。
  const bindingSidecarRef = useRef<BindingSidecar | null>(null);
  /**
   * Step 4：pdf.js fontId -> FontResolution（`editableFontFamily`）的**渲染期**留存。
   * 原 resolutionMap 只是 page-load effect 的局部变量（只喂 buildSegments）。
   * 复用既有 font-resolution.ts 的解析结果，不新建字体注册机制；
   * 未解析 / 失败 ⇒ null ⇒ 可见层沿用 Core 既有 fontFamily（fail-open）。
   */
  const fontResolutionMapRef = useRef<Map<string, FontResolution> | null>(null);
  /**
   * ★ F3B-6.27-G3：`PDF 字体名 → editableFontFamily` 反查索引。
   *
   * 为什么需要（实测缺陷）：`fontResolutionMap` 的 key 是 **pdf.js fontId**（`g_d0_f3`），
   * 而 Core `TextStyle.sourceFontName` 存的是 **PDF BaseFont**（含 subset prefix，如
   * `NREKVL+FangSong_GB2312`）—— 两套命名空间对不上 ⇒ `map.get(sourceFontName)` 恒 miss
   * ⇒ Core 画布**所有**文本回落 sans ⇒ 与透明点击层（原 PDF 字体）字宽不一致
   * ⇒ 点击位置与视觉字符对不上。
   *
   * 生命周期：与 `fontResolutionMapRef` 同步更新/释放（同一 import 边界）。
   * 只登记**解析成功且有 editableFontFamily** 的项 ⇒ 查不到即回落，绝不猜。
   */
  const pdfFontNameIndexRef = useRef<Map<string, string> | null>(null);
  // F3B-6.17-3C-6B1.1：**编辑前** Core 快照（只写 import / rehydrate 边界）。
  // ⚠️ 不能用 `coreDocumentRef.current` 充当 before —— Core 提交后会把
  // `coreDocumentRef.current = documentOf(session)`（见本文件 Core 提交分支），
  // 那样导出时 before === after ⇒ 受影响行恒为空 ⇒ 原算子永远无法投影出来。
  const coreImportSnapshotRef = useRef<EditorDocument | null>(null);
  // F3B-6.28 · D 第一阶段：受控 unit 编辑的**位移清除计划**（哪些后续原始行被推移）。
  //   只登记身份 + 提交时 Core 事务水位；导出侧按水位校验（undo 过头 ⇒ 失效 ⇒ 不清除）。
  //   不含几何/屏幕坐标（重绘几何属第二阶段，届时才需要 flow 布局）。
  // ★★ 2026-10-19（用户缺陷「多 unit 依次提交后导出 fail」）：**多计划 Map**（与
  //   committedUnitOverlays 同构）。旧单计划被每次新 unit 提交**整体替换** ⇒ 只有
  //   最后一个 unit 的清除/重绘计划在效 ⇒ 先前 unit 的成员行不剥除/不重绘 ⇒
  //   D-3B-4 核验 clear-incomplete ⇒ E-01 拒绝导出。key = unitId。
  const unitDisplacedClearRef = useRef<Map<string, DisplacedClearPlan>>(new Map());
  /** 单调递增的 document generation（与 Core document 世代一致） */
  const sidecarGenerationRef = useRef(0);
  // F3B-6.24-B2：lineId → paragraphId 的**运行时加速表**（非 semantic truth）。
  // 真正语义真相应是 EditorDocument；此表仅在「Core 编辑后 run.source.lineId 被 stripGlyphRange 清除」
  // 时作回退，记录上次成功 commit 的归属。生命周期 = lazy seed（resolver 扫描 run.source 失败回退）+ success 补记 + re-import clear。
  const lineIdParagraphMapRef = useRef<Map<string, string>>(new Map());
  // ★ 空文本缺陷修复（SPEC v2.1 N2）：unit 成员 **identity ledger**（lineId → paragraphId）。
  //   根因：Core 删除命令整 run 删除分支丢弃 provenance + ensureNonEmptyRuns 补无 source 空 run
  //   ⇒ 段落仍在但 run.source.lineId 消失 ⇒ Binding 层消费链全部 fail-closed ⇒ 编辑面丢失。
  //   语义（SPEC v2.1 §3）：merge-write 累积（发布不删除）；唯一写入口 = writeLineIdentity
  //   （冲突不覆盖 / 无独立证据拒绝 / 旧值身份失效才替换 / generation 域校验）；
  //   定位 = **身份提示（hint），非 authority**——所有下游既有校验原样保留。
  //   生命周期：与 Sidecar/ SegmentRangeLedger 同边界（resetCoreDocumentGeneration 清空）。
  const unitIdentityLedgerRef = useRef<LineIdentityLedger | null>(null);
  // 01H（PARAGRAPH-EDIT-ACCEPTANCE）H1：上一次**已提交拆分事务**的证据（只读事实）。
  //   来源 = `handleCoreInput` 透出的事务信息（transactionId / type / createdParagraphIds），
  //   **不**由结构相似性推断。失效边界：后续 mutation（被覆盖）、Undo/Redo、换文档 / generation。
  const lastSplitMutationRef = useRef<CommittedMutationEvidence | null>(null);
  // 01H：当前「已应用事务」的 id（`history.entries()[appliedCount - 1].id`）。
  //   用于校验证据未过期：撤销 / 重做 / 新提交后必须与记录不一致 ⇒ 证据失效。
  const appliedTransactionIdRef = useRef<string | null>(null);
  // ─────────────────────────────────────────────────────────────────────
  //  F3B-6.27-H2：**单一**编辑会话目标身份（editing target）
  //
  //  背景（H2 只读追踪实证）：「当前编辑的是哪个段落」此前有四个互不一致的解析源
  //  （A′ 文本源 / 编辑面几何身份 / blur 提交上下文 / seed 回退）。H1 让 caret 正确
  //  留在新段落后，A′ 与其余三者的分歧被暴露 ⇒ 新段落文本被写进旧段落编辑面
  //  ⇒ blur 二次提交污染旧段落。
  //
  //  生命周期（**不是**「面与 caret 一致就永久有效」）：
  //    · establish：面打开时按 lineId 解析（`establishEditingTarget`）
  //    · rebind：拆分事务确认时，由事务证据解析出新段落 ⇒ 改写本身份
  //    · 失效：退出编辑 / 换文档 / generation 倒退 / 绑定段落消失 / caret 迁出
  //            ⇒ 一律**回退既有 lineId 解析**（fail-closed 到既有路径，不是到 null）
  //
  //  ⚠️ **只表达身份，不表达几何**：新段落没有原始 PDF 行盒，几何恒按 lineId 解析。
  //  ⚠️ **不存文本**：文本真值恒从 Core 派生（禁止把 DOM 文本当 truth）。
  const editingTargetRef = useRef<EditingTargetIdentity | null>(null);
  // ★ H2-B 只读观测面（与 `__editingSurfaceGeometry` / `__coreInputHistory` 同类：
  //   仅暴露引用，无任何写入方）—— 生命周期验收需要区分「ref 里的原始身份」与
  //   「消费点经 maintain 校验后的**有效**身份」（后者见 `__editingSurfaceGeometry`）。
  if (typeof window !== "undefined") {
    (window as any).__editingTarget = () => editingTargetRef.current;
  }
  // ref 变化**不**触发重渲染 ⇒ 需要 tick 让 `editingSurface`（useMemo）重算身份字段，
  // 否则 `data-editing-paragraph-id` 会停留在旧身份（H2-Q2 的时序风险）。
  const [editingTargetTick, setEditingTargetTick] = useState(0);
  // ★ F3B-6.28 · S2-v3：cell 编辑面**稳定锚**（纯契约 `binding/table-cell-anchor.ts`）。
  //   · 锚 ref 的**唯一写点** = 锚 effect（下方 `:6827` 之后）；memo 只读 + tick 传播
  //     （与 editingTargetRef/Tick 同惯例——ref 变化不触发重渲染）。
  //   · 生命周期 = **单次编辑会话**（entry 建立、exit 清除；跨会话不复用——重进走完整门链）。
  //   · 锚记录只存身份与边界权威字段；`cellLen`/`cellText` 是每次消费的派生值，绝不入锚。
  const cellAnchorRef = useRef<CellAnchor | null>(null);
  const [cellAnchorTick, setCellAnchorTick] = useState(0);
  const bumpCellAnchorTick = useCallback(() => setCellAnchorTick((t) => t + 1), []);
  // ★ F3B-6.28：cell 编辑台账（跨会话第二格编辑的映射来源；声明于 memo/提交块之前
  //   防 TDZ。清空点 = re-import / 文档重置边界，与 cellCommittedSpans 同生命周期）。
  const cellEditLedgerRef = useRef<TableCellEditLedger>(createTableCellEditLedger());
  // ★ F3B-6.28 · C：监测聚合（契约 §17；纯模块 `binding/cell-monitor.ts`）。
  //   · 只收**枚举 reason + 计数 + 相对时间**；零正文/零文本参数/零网络/零持久化；
  //   · 全部调用点位于 flag 门内或 unit route 已进入 ⇒ flag OFF 零执行零差异；
  //   · 关闭机制：`window.__cellMonitorEnabled === false` 或自动止损后停止记录；
  //   · 探针：`__cellMonitor`（活状态）+ `__cellMonitorSnapshot()`（深拷贝，仿 `__editingTarget`）。
  const cellMonitorRef = useRef<CellMonitorState | null>(null);
  if (cellMonitorRef.current === null) {
    const sid =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `s-${Math.random().toString(36).slice(2)}`;
    cellMonitorRef.current = createCellMonitorState(sid);
  }
  if (typeof window !== "undefined") {
    (window as any).__cellMonitor = cellMonitorRef.current;
    (window as any).__cellMonitorSnapshot = () => snapshotCellMonitor(cellMonitorRef.current!);
  }
  // 记录入口（同步内存写；唯一写点）。止损：cellWriteSuspect > 0 ⇒ 置 flag OFF。
  const recordCellMonitor = useCallback(
    (kind: Parameters<typeof recordCellMonitorEvent>[1], reason: string) => {
      const st = cellMonitorRef.current;
      if (!st || !isRecordingEnabled(st)) return;
      if (typeof window !== "undefined" && (window as any).__cellMonitorEnabled === false) return;
      recordCellMonitorEvent(st, kind, reason, Date.now());
      const stop = evaluateStopThreshold(st);
      if (stop.stop) {
        applyAutoStop(st, Date.now(), reason);
        // 止损：立即对后续会话生效 + **粘性 kill-switch**（重载后仍 OFF，直到清除）
        (window as any).__cellUnitEditing = false;
        try {
          window.localStorage?.setItem("__cellUnitEditing", "0");
        } catch { /* storage 不可用 ⇒ 仅本会话止损 */ }
      }
    },
    []
  );
  // ★ S2-v3 共享探针：门 1 提前（`detectTableCells` + `resolveSegmentCell`，纯 legacy 轴、
  //   零 Core 依赖）⇒ 入口 cell 键 + revalidate 的 legacy 侧输入。memo 与锚 effect 复用。
  //   ⚠️ 函数声明（组件作用域内提升）：与 `lineGlyphsFor`（:4335）同款惯例，
  //      memo/effect 消费时不入 deps（其输入全是 ref/state，随各自 deps 变化重算）。
  function probeCellEntry(segId: string | null): {
    entrySegment: CellResolverSegment;
    rowGlyphs: CellUnitGlyph[];
    rowSegments: CellResolverSegment[];
    cells: Array<{ index: number; startGlyphIndex: number; endGlyphIndex: number }>;
    cellIndex: number;
    lineId: string;
  } | null {
    if (!segId || !readCellUnitEditingFlag()) return null;
    const seg = (segmentsRef.current ?? []).find((s) => s.id === segId) ?? null;
    const lineId = (seg?.source as { lineId?: string } | undefined)?.lineId ?? null;
    const blockId = (seg?.source as { blockId?: string } | undefined)?.blockId ?? null;
    if (!seg || !lineId || !blockId) return null;
    const rowGlyphs = (lineGlyphsFor(blockId, lineId) ?? []) as unknown as CellUnitGlyph[];
    const rowSegments = (segmentsRef.current ?? []).filter((s) => s.source?.lineId === lineId);
    const detection = detectTableCells(rowGlyphs.map((g) => ({ char: g.char ?? "", bbox: g.bbox })));
    if (!detection.isTableRow) return null;
    const cells = detection.cells.map((c) => ({
      index: c.index,
      startGlyphIndex: c.startGlyphIndex,
      endGlyphIndex: c.endGlyphIndex,
    }));
    const entrySegment: CellResolverSegment = {
      id: seg.id,
      source: seg.source,
      originalText: (seg as { originalText?: string }).originalText,
    };
    const res = resolveSegmentCell({ segment: entrySegment, rowGlyphs, rowSegments, cells });
    if (!res.ok) return null;
    return { entrySegment, rowGlyphs, rowSegments, cells, cellIndex: res.cell.cellIndex, lineId };
  }
  // F3B-6.17-3C-0.5：本次 document generation 的 **export ownership**（"core" | "legacy"）。
  // 与 `segmentCoreActive`（Core 曾接管过的粘性 semantic 标记；F3B-6.18-D.1 起**不再**是
  // renderer 门控）**不同**：本信号由
  // **每次 Segment commit 的结果**驱动（core / legacy），并在 re-import 时复位 ⇒
  // 精确表达「当前文档的编辑真相是否已由 Core semantic path 完整接管」。
  // ⚠️ 必须在 `useExport(...)` 调用点**之前**声明（否则 TDZ，整个 /editor 路由崩溃）。
  const exportOwnershipRef = useRef<ExportOwnership>("core");
  // F3B-6.17-3C-10A：replace capability 的 Core/Legacy 路径可观测计数
  const capabilityReplaceTelemetryRef = useRef(
    createCapabilityCoreTelemetry()
  );
  // STEP-2c-C1：ref 间接层避免 TDZ（commitOcrBlocksToCore 在下方 L68xx 才声明）。onOcrResult 只在 OCR 完成后
  // 运行时触发，故经 ref 转发是安全的；window hook 同理。
  const commitOcrBlocksToCoreRef = useRef<((blocks: TextBlock[]) => boolean) | null>(null);
  const { handleOCR, handleOCRRegion } = useOCR({
    canvasRef,
    cssScaleRef,
    // ★ 必须返回**确定** boolean：true = Core 已认领（useOCR 据此跳过旧 setBlocks，杜绝 duplicate），
    //   false = Core 不可用/归一化为空 ⇒ 回落旧路径，OCR 不丢失。`?.` 会产生 `boolean | undefined`。
    onOcrResult: (blocks) => commitOcrBlocksToCoreRef.current?.(blocks) === true,
  });
  /**
   * B3-C-6-A：Page Ops 之后的**确定性** legacy 重建触发标志。
   *
   * 背景（C-6 Audit S1 根因）：Page Ops 使 Core/Sidecar/legacy 全部失效后，若停在新插入的
   * **空白页**，`[pdfDoc, page]` 构建 effect 会因 `hasNativeText === false` 走 scannedOCR
   * 分支直接 return —— 既不构建 EditableDocument、也不 bump `editableDocVersion`
   * ⇒ canonical rehydrate 永远不触发 ⇒ `coreDocumentRef` 恒为 null
   * ⇒ Add Image（`if (!coreDoc) return`）静默 fail-closed。
   *
   * 语义：本标志**仅**在 Page Ops 上下文置位，用于要求「即使当前页无文本也要构建该页并
   * bump version」，从而让**既有** rehydrate 链（`[editableDocVersion]` →
   * `shouldRehydrate()` → `initializeCoreDocument`）用新的 PDF/Legacy 页结构重新派生 Core。
   * 不改动 `hasNativeText` 的扫描件分类语义，也不创建第二套初始化/rehydrate 机制。
   */
  const pendingPageOpRebuildRef = useRef(false);

  // B3-C-5：Page Ops ⇒ Core generation 失效（**不是** Core mutation）。
  //   · 传**惰性箭头**（`() => resetCoreDocumentGeneration()`）而非值 ⇒ 避免 TDZ
  //     （resetCoreDocumentGeneration 是下方声明的 const，此处解引用会 ReferenceError）。
  //   · Page Ops 不进入 Core：不改 EditorDocument.pages、不 reparent、不记 ownership。
  const { handleAddBlankPage, handleDeletePage, handleMovePageUp, handleMovePageDown } = usePageOps({
    pdfLibDocRef,
    pdfBytesRef,
    onBeforePageChange: () => requestEditTransition("PAGE_CHANGE"),
    onPageStructureChanged: () => {
      // B3-C-6-A：置位「Page Ops ⇒ 必须确定性重建 legacy 页并 bump version」
      // （先置位再失效：新的 pdfDoc 发布后构建 effect 即可据此触发 rehydrate）
      pendingPageOpRebuildRef.current = true;
      resetCoreDocumentGeneration();
    },
    // C-6-B：Core dirty ⇒ 硬阻断 Page Op（数据丢失型状态转换）。
    //   · 判据走唯一纯判定 isCoreDocumentDirty（读 coreInputSessionRef.history.canUndo）；
    //   · dirty 时 Toast 提示 + 零 mutation（reset / reload / pdf-lib 均不触碰）。
    isCoreDocumentDirty: () => isCoreDocumentDirty(coreInputSessionRef.current),
    onCoreDirtyBlocked: () => {
      console.warn("[C6B][PAGE_OP_BLOCKED_CORE_DIRTY]", { reason: "core-document-dirty" });
      showToast("请先导出或撤销未保存的编辑，再进行页面操作");
    },
  });
  // ── F3B-6.4B-2 / 6.4B-3.2：Segment 位置账本 + 导出编排层过滤 ──
  // 必须在 useExport 调用点**之前**声明（否则 TDZ）。
  // lazy init 保证账本实例在多次 render 间稳定。
  const [segmentPositionLedger] = useState(() => new SegmentSourcePositionLedger());

  /**
   * F3B-6.4B-3.2：导出编排层过滤 —— 已 canonical commit 的 Segment 不再进入 legacy export mutation。
   *
   * 边界（重要）：过滤发生在 **PDFEditor / export orchestration**。
   * `segmentEditBinding.applySegmentEditsToDocument` 依旧不认识 ledger，
   * 也不认识任何 UI/editor transaction state —— 保持 binding 边界干净。
   *
   * 判据：`text !== originalText`（binding 自身筛选）**且** `!canonicalized`（此处过滤）。
   * 这样 `editedSegmentsRef` 里的 oldKey → newText 可以继续专职 replay，
   * 而不会被 export 当成 pending 二次应用（B-3.1 R6 实证的损坏形态）。
   *
   * 判据用的 identity（F3B-6.4B-4.1）：**`sourceSegmentKey(s.source)`** ——
   * canonical position identity，只由 source 坐标构成。
   * 不得改用 `segEditKey(s)`：它含 `originalText`，会被 reconciliation 改写，
   * 导致同一段落在 commit 前后是两个 key（B-4 实证 U5b 的根因）。
   * 无 source 的 segment 不可能是 canonical ⇒ 保持 legacy pending（返回 true）。
   *
   * ── F3B-6.4B-5.1（Candidate A）：坐标换算 ──────────────────────────────
   * 过滤之后，把仍 pending 的 segment 的 range 从 **source 坐标**换算为
   * **current document 坐标**，再交给 legacy safety-net。
   *
   * 为什么必须换算（B-5 实测）：`applySegmentEditsToDocument` 的批次 `shift` 初值恒为 0，
   * 只累加**入参批次内部**的位移。已 canonical 的 segment 被上面的过滤移除 ⇒ 批次不再完整
   * ⇒ 若不换算，后续 segment 会被压回 source 位置，产生错位（甚至把 no-op 编辑变成损坏）。
   *
   * 坐标语义三层，不要混为一谈：
   *   · 原始 Segment truth                     → **source coordinates**
   *   · legacy safety-net orchestration input  → **current coordinates**（本函数的输出）
   *   · applier 内部批次 shift                 → 仅处理该 current 批次内部的相对位移
   *
   * ⚠️ 必须创建**新对象**，绝不修改原 Segment（`Segment.source` 是 source truth）。
   */
  const getLegacyPendingSegments = useCallback(
    () =>
      getAllPageSegments()
        .filter((s) => {
          if (!s.source) return true;
          return !segmentPositionLedger.isCanonicalized(sourceSegmentKey(s.source));
        })
        .map((s) => {
          if (!s.source) return s; // 无 source 的 legacy 段走既有兜底
          const key = sourceSegmentKey(s.source);
          if (!segmentPositionLedger.has(key)) return s;
          const r = segmentPositionLedger.currentRange(key);
          return {
            ...s,
            source: {
              ...s.source,
              startGlyphIndex: r.start,
              endGlyphIndex: r.end,
            },
          };
        }),
    [getAllPageSegments, segmentPositionLedger],
  );

  // F3B-6.4B-3.2：导出改为消费「过滤掉已 canonicalized 的 segment」，
  // 未 canonical 的 legacy pending segment 仍走原有 safety-net（行为不变）。
  const { handleExport } = useExport({ coordRef, pdfBytesRef, cssScaleRef, editableDocumentRef, signatureRegionsRef, editedLineBoxesRef, segmentsRef, getAllPageSegments: getLegacyPendingSegments, coreInputSessionRef, coreDocumentRef, coreImportSnapshotRef, unitDisplacedClearRef, bindingSidecarRef, exportOwnershipRef });

  // F3B-6.23-D：E2E 验收 instrumentation（纯测试钩子，不影响生产行为）。
  // 导出按钮在 dev 模式点击后停在 "done" 阶段（disabled），无法重复触发导出；
  // 暴露原始 handleExport 供回归测试反复导出并捕获 blob（与 __coreInputHistory / __textEditSurface 等既有 instrumentation 一致）。
  (window as unknown as Record<string, unknown>).__handleExport = handleExport;

  // STEP-1 instrumentation（Manual OCR → Core Migration Contract §9 Step 1）：
  // 受控测试入口，仅转发现有 handler，不改变 UI / OCR 业务逻辑 / docBlocks 写入点 /
  // editableDocumentRef / coreDocumentRef / ownership / export。hook 长期保留与否待最终 acceptance 决定。
  (window as unknown as Record<string, unknown>).__handleOCR = handleOCR;
  (window as unknown as Record<string, unknown>).__handleOCRRegion = handleOCRRegion;
  // STEP-2c-C1：受控测试入口，直接把 raw OCR TextBlock[] 经生产 seam 写入 Core（免去依赖真实 tesseract）。
  (window as unknown as Record<string, unknown>).__commitOcrBlocksToCore = (blocks) =>
    commitOcrBlocksToCoreRef.current?.(blocks);

  // ── EDITOR-CORE-012-F3B-1 / F3B-1.1：Import-time Core Document 持久化 + Ownership 门控 ──
  // 真实 import boundary 由 `editableDocVersion` 统一触发：每次 `editableDocumentRef.current` 被赋值都会
  // bump 该版本（import / re-import / replace / SEM / undo-redo / 原生文本编辑 commit 都走同一信号）。
  // F3B-1.1 新增 ownership 门控（`coreLifecycleRef`）：
  //   · 首次 import（uninitialized）→ 派生 Core document；
  //   · 已 active 但 Core 尚未 owning（无 Core 编辑）→ 保持与 legacy 同步（rehydrate）；
  //   · Core 已开始 editing（owned）→ legacy mutation **禁止**覆盖 Core（跳过 rehydrate）；
  //   · re-import（`signalNewDocument` 在 loadPdfFromArrayBuffer 发出）→ 允许创建新 Core B 并释放旧 session。
  // `lastLegacyDocRef` 避免 doc 未变的 render-only bump 重复派生 Core document。
  useEffect(() => {
    const legacy = editableDocumentRef.current;
    if (!legacy) {
      coreDocumentRef.current = null;
      lastLegacyDocRef.current = null;
      coreLifecycleRef.current!.invalidate();
      return;
    }
    lastLegacyDocRef.current = legacy;
    if (coreLifecycleRef.current!.shouldRehydrate()) {
      coreDocumentRef.current = initializeCoreDocument(legacy);
      // F3B-6.17-3C-6B1.1：同一时刻固定「编辑前」快照（Core command 是纯变换 ⇒ 该对象保持 pristine）
      coreImportSnapshotRef.current = coreDocumentRef.current;
      coreLifecycleRef.current!.markActive();
    }
    // else：owned + legacy mutation（或 doc 未变的 bump）→ Core 拥有 truth，不重新派生，绝不覆盖编辑状态
    //
    // ★★ 2026-10-19（用户缺陷「翻到第 2 页就不能按段落编辑了」第二层根因）：**新渲染页增量并入**。
    //   legacy 页是懒渲染的（PDF.js 按需）⇒ 首次 import 时 Core 只含已渲染页（实测 1 页）；
    //   翻页 ⇒ 新页渲染 ⇒ legacy.pages 增长 ⇒ editableDocVersion bump ⇒ 本 effect。
    //   · 未 owned（无文本编辑）：shouldRehydrate ⇒ 全量重建（既有）✓；
    //   · **owned**（已有文本编辑）：整体 rehydrate 会**覆盖编辑** ⇒ 旧实现直接跳过
    //     ⇒ Core **永远**缺新页 ⇒ 新页段落定位失败（gate member-not-found，实测
    //     `findTextBoxBySourceLineId` direct=false、Core 无该页对象）⇒ 恒回落单段面
    //     （unitId=null）⇒ 提交不走 unit route ⇒ C2/C3 提交层不渲染（实测第 1 页编辑
    //     3 次后翻页，第 2 页编辑提交后 masks=0、overlays=0、跨页文本泄漏）。
    //   ⇒ owned 分支**增量并入**：只追加 Core 缺失 index 的页（新页用 legacy→Core 纯
    //     转换的产物；**已编辑页的 Core 版本原样保留** = 编辑真相不被覆盖）。
    //     经 `history.commit` 入栈（1 条 entry；幂等纯变换）。取舍：补页占一条 undo
    //     步（Ctrl+Z 第一次撤补页 = 该页编辑面退化，不损坏数据，redo 恢复）。
    else {
      const sessionNow = coreInputSessionRef.current;
      const coreNow = sessionNow ? documentOf(sessionNow) : coreDocumentRef.current;
      if (sessionNow && coreNow) {
        const haveIdx = new Set((coreNow.pages ?? []).map((p) => p.index));
        const missingLegacy = (legacy.pages ?? []).filter((p) => !haveIdx.has(p.index));
        if (missingLegacy.length > 0) {
          try {
            const fresh = initializeCoreDocument(legacy);
            const freshByIdx = new Map((fresh.pages ?? []).map((p) => [p.index, p] as const));
            const addPages = missingLegacy
              .map((p) => freshByIdx.get(p.index))
              .filter((p): p is (typeof fresh.pages)[number] => Boolean(p));
            if (addPages.length > 0) {
              const appendCommand: EditorCommand = {
                type: "append-rendered-pages",
                execute: (document: EditorDocument): EditorDocument => {
                  const have = new Set((document.pages ?? []).map((p) => p.index));
                  const add = (fresh.pages ?? []).filter((p) => !have.has(p.index));
                  if (add.length === 0) return document; // 幂等：同一引用 ⇒ 零 entry
                  return {
                    ...document,
                    pages: [...(document.pages ?? []), ...add].sort((a, b) => a.index - b.index),
                    version: document.version + 1,
                  };
                },
              };
              sessionNow.history.commit(appendCommand);
              coreDocumentRef.current = documentOf(sessionNow);
              // ★★ 2026-10-19（用户缺陷「导出 PDF 修改过的内容空白」总根因）：
              //   **编辑前快照同步并入新页（pristine 状态）**。drop 投影（导出剥离的
              //   唯一依据）以 `coreImportSnapshotRef` 为 before 做 before/after diff：
              //   快照只含第 1 页（import 时懒渲染）⇒ 补页后 after 的第 2..N 页在
              //   before 中不存在 ⇒ **整页全部判为 changed** ⇒ drop 投影剥离这些页的
              //   **全部**原算子 ⇒ 重绘只覆盖真正编辑的行 ⇒ 其余行在导出 PDF 中空白
              //   （实测用户文件：第 2 页 getTextContent len=0、第 1 页所有编辑行
              //   及相邻行空白）。
              //   语义：快照 = 「每页的编辑前状态」——p1 保持**编辑前**版本（p1 的
              //     编辑 diff 不受影响）、新页以**补页时（=编辑前）的 pristine 版本**
              //     进入 ⇒ 之后对新页的任何编辑 diff 正常（pristine vs 编辑后）。
              const snapNow = coreImportSnapshotRef.current;
              if (snapNow) {
                const snapIdx = new Set((snapNow.pages ?? []).map((p) => p.index));
                const snapNewPages = (fresh.pages ?? []).filter((p) => !snapIdx.has(p.index));
                if (snapNewPages.length > 0) {
                  coreImportSnapshotRef.current = {
                    ...snapNow,
                    pages: [...(snapNow.pages ?? []), ...snapNewPages].sort((a, b) => a.index - b.index),
                  } as typeof snapNow;
                }
              }
            }
          } catch {
            // fail-closed：并入失败 ⇒ 维持现状（新页回落单段面），绝不破坏既有编辑
          }
        }
      }
    }
  }, [editableDocVersion]);

  // ── F3B-6.17-3C-6B1.1-P1-C：Browser caller 预计算 per-page operator provenance ──
  // 唯一计算入口 = `computeOperatorProvenance`（binding/operator-provenance.ts）。
  // 扁平行下标与 `assignOperatorProvenance` / builder 同序（block→line→glyph）。
  function precomputeSidecarOperatorProvenance(
    doc: EditableDocument,
    pdfLibDoc: PDFDocument,
  ): Map<number, GlyphProvenance[] | null> {
    const map = new Map<number, GlyphProvenance[] | null>();
    for (let p = 0; p < doc.pages.length; p++) {
      const page = doc.pages[p];
      const input: GlyphProvenanceInput[] = [];
      for (const block of page.blocks ?? []) {
        for (const line of block.lines ?? []) {
          for (const g of line.glyphs ?? []) {
            input.push({ char: g.char, pdfTransform: g.metrics?.pdfTransform });
          }
        }
      }
      if (input.length === 0) {
        map.set(page.index, []);
        continue;
      }
      try {
        // 键用 page.index（1-based），与 Sidecar builder 的 pageIndex 对齐；
        // 计算入口用 **page.index − 1**（0-based 页索引）。★ 2026-10-19：旧实现传
        // **数组下标 p**——全文档（pages[i].index = i+1）时二者等价，但**子文档**
        // （懒渲染页增量并入的 sidecar 补条目，pages=[p2] 而 index=2）时会把第 2 页
        // 当第 1 页解析 ⇒ provenance 全空 ⇒ 3B4 投影失败 ⇒ 导出 E-01。
        map.set(page.index, computeOperatorProvenance(pdfLibDoc, page.index - 1, input));
      } catch {
        map.set(page.index, null);
      }
    }
    return map;
  }

  // ── F3B-6.12：Binding Sidecar 构建（只在**新 document generation** 时发生）──
  // 判据 = `bindingSidecarRef.current === null`，而该 ref **仅在 re-import 边界被置空**。
  // 因此 legacy mutation / Core rehydrate / Core command 都不会触发重建 ——
  // 重建会把「已编辑几何」误当成「原始 PDF 几何」（6.11 冻结的硬约束）。
  // fail-open：构建失败只丢弃 sidecar，绝不阻断导入。
  useEffect(() => {
    const decision = decideSidecarLifecycle({
      current: bindingSidecarRef.current,
      hasDocument: editableDocumentRef.current !== null,
      ocrInjected: ocrBlocksInjectedRef.current,
    });
    if (decision.action === "clear") {
      bindingSidecarRef.current = null;
      return;
    }
    if (decision.action !== "build") {
      // ★★ 2026-10-19（用户缺陷「download fail, please try again」）：**懒渲染新页的
      //   sidecar 条目增量并入**。sidecar（originalBounds 唯一来源，6.17 3B'-B.2）
      //   构建于 import 时——PDF.js 懒渲染 ⇒ 当时 legacy 只有第 1 页 ⇒ sidecar 只含
      //   p1 条目。翻页 ⇒ 新页渲染 ⇒ legacy.pages 增长 ⇒ editableDocVersion bump ⇒
      //   本 effect，但 current 非 null ⇒ decision = keep ⇒ 旧实现直接 return ⇒
      //   新页条目**永缺** ⇒ 新页编辑 run 在导出安全检查
      //   （findEditedBlocksMissingOriginalBounds）中查不到 bounds ⇒ E-01 unsafe ⇒
      //   download fail（实测 [CORE-EXPORT-FALLBACK] {reason: missing-original-bounds}、
      //   missing = pdf_p2_block0）。
      //   ⇒ **只并新页条目**：新页从未被编辑 ⇒ 其几何 = 真原始 PDF 几何 ⇒ 不违反
      //     6.11（重建禁令针对的是「已编辑页的几何被误当原始」）；**已编辑页的条目
      //     原样保留**。operatorProvenance 按子页预计算（PDF.js 未渲染页缺失 ⇒
      //     builder 退回 glyph.operatorId，legacy adapter 已写好，行为等价）。
      //   已知限制：新页 glyph 的算子 provenance 依赖同步 precompute（懒渲染页的
      //     textContent 未就绪时缺失）——导出引擎对该场景退回 legacy adapter 值。
      const cur = bindingSidecarRef.current;
      const legacyDocNow = editableDocumentRef.current;
      if (cur && legacyDocNow && legacyDocNow.pages.length > 1 && cur.origin) {
        // sidecar 已覆盖的最大页 index（从 lines key 前缀 `pdf_p<N>_` 提取）
        let covered = 1;
        for (const key of Object.keys(cur.lines)) {
          const m = /pdf_p(\d+)_/.exec(key);
          if (m) covered = Math.max(covered, Number(m[1]));
        }
        const missingPages = legacyDocNow.pages.filter((pg) => pg.index > covered);
        if (missingPages.length > 0 && sidecarGenerationRef.current > 0) {
          try {
            const subDoc = { ...legacyDocNow, pages: missingPages } as unknown as EditableDocument;
            let operatorProvenance: Map<number, GlyphProvenance[] | null> | undefined;
            if (cur.origin === "pdf-native") {
              const pdfLibDoc = pdfLibDocRef.current;
              if (pdfLibDoc) operatorProvenance = precomputeSidecarOperatorProvenance(subDoc, pdfLibDoc);
            }
            const sub = cur.origin === "ocr"
              ? buildBindingSidecarFromOcr(subDoc, cur.generation)
              : buildBindingSidecarFromPdfNative(subDoc, cur.generation, operatorProvenance);
            bindingSidecarRef.current = {
              ...cur,
              lines: { ...cur.lines, ...sub.lines },
              blocks: { ...cur.blocks, ...sub.blocks },
              pages: { ...(cur.pages ?? {}), ...(sub.pages ?? {}) },
            };
            console.log("[SIDECAR-APPEND]", {
              appendedPages: missingPages.map((p) => p.index),
              appendedLines: Object.keys(sub.lines).length,
              covered,
            });
          } catch (e) {
            // fail-closed：并入失败 ⇒ 维持现状（该页导出会被 E-01 拒绝，绝不静默回退 legacy）
            console.warn("[SIDECAR-APPEND] 新页条目并入失败（维持现状）:", e);
          }
        }
      }
      return;
    }
    const legacyDoc = editableDocumentRef.current;
    if (!legacyDoc) return;
    sidecarGenerationRef.current += 1;
    try {
      // F3B-6.17-3C-6B1.1-P1-C：pdf-native 路径预先 compute provenance（唯一计算入口在
      // `operator-provenance.ts`），builder 只 consume。pdfLibDocRef 在 import 时已加载，
      // 缺失时退回 glyph.operatorId（legacy adapter 已写好，行为等价）。
      let operatorProvenance: Map<number, GlyphProvenance[] | null> | undefined;
      if (decision.origin === "pdf-native") {
        const pdfLibDoc = pdfLibDocRef.current;
        if (pdfLibDoc) operatorProvenance = precomputeSidecarOperatorProvenance(legacyDoc, pdfLibDoc);
      }
      bindingSidecarRef.current =
        decision.origin === "ocr"
          ? buildBindingSidecarFromOcr(legacyDoc, sidecarGenerationRef.current)
          : buildBindingSidecarFromPdfNative(legacyDoc, sidecarGenerationRef.current, operatorProvenance);
      // [SIDECAR-DIAG] 构建概况 + 控制台只读探针（归因 E-01 用）
      try {
        const sc = bindingSidecarRef.current;
        (window as any).__bindingSidecar = sc;
        console.log("[SIDECAR-BUILT]", {
          origin: sc?.origin,
          generation: sc?.generation,
          lines: Object.keys(sc?.lines ?? {}).length,
          blocks: Object.keys(sc?.blocks ?? {}).length,
          pages: legacyDoc.pages.length,
        });
      } catch {}
    } catch (e) {
      // ★ 2026-10-28（用户验收「E-01 missing-original-bounds」）：构建失败此前**静默置 null**
      //   ⇒ 编辑不受影响（不读 sidecar）⇒ 导出 eligibility 时所有被编辑 run 查不到
      //   originalBounds ⇒ E-01。静默失败使该链路完全不可归因 ⇒ 显式暴露。
      console.error("[SIDECAR-BUILD-FAILED] sidecar 构建异常（fail-open 置 null；导出将被 E-01 拒绝）:", e);
      (window as any).__planbSidecarError = String(e);
      bindingSidecarRef.current = null;
    }
  }, [editableDocVersion]);

  // ── F3B-6.14：把 reconciliation 结果写入既有 render state ──
  // 复刻 `markLineEdited`(L1096-1105) 的 upsert 语义（单调 upsert、无 per-line 删除）。
  // **不修改** markLineEdited 本身：legacy 路径保持原样，Core 路径走本函数。
  const applyReconciliationToRenderState = useCallback(
    (entries: Array<{ lineId: string; box: { x: number; y: number; width: number; height: number } | null }>) => {
      if (entries.length === 0) return;
      setEditedLines((prev) => {
        const missing = entries
          .map((entry) => entry.lineId)
          .filter((lineId) => !prev.has(lineId));
        if (missing.length === 0) return prev;
        const next = new Set(prev);
        for (const lineId of missing) next.add(lineId);
        return next;
      });
      setEditedLineBoxes((prev) => {
        let next: Map<string, { x: number; y: number; width: number; height: number }> | null = null;
        for (const entry of entries) {
          const box = entry.box;
          if (!box) continue;
          const ex = prev.get(entry.lineId);
          if (
            ex &&
            ex.x === box.x &&
            ex.y === box.y &&
            ex.width === box.width &&
            ex.height === box.height
          ) {
            continue;
          }
          if (!next) next = new Map(prev);
          next.set(entry.lineId, box);
        }
        return next ?? prev;
      });
    },
    []
  );

  // ── F3B-1.1：Core 编辑提交后，把唯一的 Core document 真相源同步回 `coreDocumentRef` ──
  const [coreInputTick, setCoreInputTick] = useState(0);
  // F3B-6.17 阶段二：Segment Core 迁移可观测计数 + 「本次文档已走 Core Segment」语义标记。
  //
  // ⚠️ F3B-6.18-D.1：`segmentCoreActive` 是 **semantic ownership** 信号
  //   （「本文档的 Segment 编辑是否已由 Core semantic path 接管」），
  //   **绝不**再作为 render switch —— 渲染 ownership 由 `readCoreRenderFlag()` 独立决定。
  //   （Semantic ownership ≠ Rendering ownership；D.1 boundary ②。）
  const segmentCoreTelemetryRef = useRef(createSegmentCoreTelemetry());
  const [segmentCoreActive, setSegmentCoreActive] = useState(false);
  // `EditorHistory` 每次 commit 会产生**新的** document 对象（`documentOf(session)` 随之变化），而
  // `coreDocumentRef.current` 仍是 import 时的初始对象。不在此同步，则：
  //   · T35（coreDocumentRef === documentOf(session)）在编辑后失效；
  //   · T38（candidate export 输出 Core 编辑结果而非 legacy snapshot）失效。
  // 每次 Core 输入（coreInputTick）提交后，令 `coreDocumentRef.current = documentOf(session)` 并标记 owned，
  // 此后 legacy mutation 不再能覆盖 Core 真相源。
  useEffect(() => {
    const session = coreInputSessionRef.current;
    if (!session) return;
    coreDocumentRef.current = documentOf(session);
    coreLifecycleRef.current!.markOwned();
    // F3B-6.23-C-Impl-1：Core 栈变化（mutation/undo/redo 均经此 tick）⇒ 广播可用性快照
    refreshUndoRedoAvailability();

    // ── F3B-6.14：Core + Sidecar production reconciliation ──
    // 仅在本 effect（Core 输入提交后）执行；未启用 Core input 时 coreInputTick 不递增 ⇒ 完全不运行。
    // eligibility 决定路径：任一条件失败 ⇒ 记录 reason 并**不**更新 render state
    // （= 维持 6.14 之前的既有行为，不是把正确结果降级）。
    const sidecarNow = bindingSidecarRef.current;
    if (sidecarNow) {
      try {
        const afterDoc = documentOf(session);
        const historyLike = (
          session as unknown as {
            history?: { entries?: () => readonly unknown[] };
          }
        ).history;
        const entries = historyLike?.entries?.() ?? [];
        const last = entries[entries.length - 1] as
          | { before?: { document?: EditorDocument } }
          | undefined;
        const beforeDoc = last?.before?.document;
        const paragraphIds = beforeDoc ? diffAffectedParagraphIds(beforeDoc, afterDoc) : [];
        const affectedLines = extractAffectedBindingLines({
          document: afterDoc,
          affectedParagraphs: paragraphIds,
          // F3B-6.28：整行替换/清空后 after 段落只剩 generated run（无 source）⇒
          // 行身份按 6.13 契约回退。优先级：导入期快照（稳定，跨 replace/clear/
          // undo/redo 有效，随 re-import 释放）→ 最后一条事务的 before（仅第一笔有效）。
          originDocument: coreImportSnapshotRef.current,
          beforeDocument: beforeDoc,
        });
        const targets = resolveBindingReconciliationTarget({
          affectedLines,
          sidecar: sidecarNow,
          currentGeometryOf: createCoreLayoutCurrentGeometryProvider(
            afterDoc,
            createFontMetricsProvider({}),
            // Step 3：mask 几何必须使用与 Core 可见渲染**同一套** diff-aware 真实度量。
            // 只传空 provider 等于告诉 Core「不知道任何 PDF glyph 度量」⇒ mask 盒偏小/偏移，
            // 原墨迹顶部盖不住（实测约 3px 顶部露出）。只解决几何，不重新定义 ownership。
            buildMetricsByTextBoxFromLegacy(
              editableDocumentRef.current as EditableDocument,
              afterDoc
            ),
            // F3B-6.28-B：origin 只补行身份索引（after 优先）；布局盒仍来自 afterDoc。
            coreImportSnapshotRef.current
          ),
        });
        const decision = decideReconciliationPath({
          coreOwned: true,
          sidecar: sidecarNow,
          documentGeneration: sidecarGenerationRef.current,
          affectedLines,
          targets,
        });
        if (decision.path === "core-sidecar") {
          // ── F3B-6.28-C（第四刀）：render state 跟随 Document ──
          // 受影响行「当前文本 == 导入期文本」⇒ 无生效编辑（undo 回原文 / 手动改回原文）
          // ⇒ 移除该行 render state（复用既有 resyncEditedRenderStateForLine 的 remove 分支，
          //    不新增 per-line delete 站点）；文本不同 ⇒ 有效编辑 ⇒ upsert box（既有行为）。
          const classification = classifyRenderStateByOriginText({
            lines: affectedLines,
            originDocument: coreImportSnapshotRef.current,
            afterDocument: afterDoc,
          });
          if (classification.stale.length > 0) {
            for (const s of classification.stale) {
              resyncEditedRenderStateForLine(s.blockId, s.lineId);
            }
          }
          const staleKeys = new Set(classification.stale.map((s) => `${s.blockId}|${s.lineId}`));
          applyReconciliationToRenderState(
            targets
              .filter((t) => !staleKeys.has(`${t.blockId}|${t.lineId}`))
              .map((t) => {
                const cand = reconciliationRenderBox({
                  originalLineBBox: t.originalLineBBox,
                  originalGlyphs: t.originalGlyphs,
                  currentGeometry: t.currentGeometry,
                });
                if (!cand) return { lineId: t.lineId, box: null };
                // F3B-6.28-M（D2″）：统一写入出口的 ink 校正 —— 模型候选框不含墨迹上伸
                //   （CJK 5.02px / 西文 3.14px 实测）；经共享 ink 校正（含邻行钳制）补足。
                //   每次从模型候选框重算 ⇒ 不累积；canvas 不可用/扫描失败 ⇒ fail-closed 保留候选。
                const doc = editableDocumentRef.current;
                let prevBottom: number | undefined;
                let nextTop: number | undefined;
                let prevBBox: { x?: number; y?: number; width?: number; height?: number } | undefined;
                if (doc) {
                  outerRecon: for (const pg of doc.pages) {
                    for (const b of pg.blocks) {
                      for (let i = 0; i < b.lines.length; i++) {
                        if (b.lines[i].id !== t.lineId) continue;
                        prevBBox = b.lines[i - 1]?.bbox as { x?: number; y?: number; width?: number; height?: number } | undefined;
                        const nextB = b.lines[i + 1]?.bbox as { y?: number } | undefined;
                        if (prevBBox?.y !== undefined && prevBBox.height !== undefined) prevBottom = prevBBox.y + prevBBox.height;
                        if (nextB?.y !== undefined) nextTop = nextB.y;
                        break outerRecon;
                      }
                    }
                  }
                }
                // F3B-6.28-N（上界升级）：topBoundary 依据上一视觉行的**实际墨迹底**
                //   （canvas 扫描其 bbox 区域，从下往上首个 ink 行；阈值 <240 与 T2 一致，
                //   天然保留淡色 descender 在边界之上）。模型 bbox 底可比实墨底低 28px。
                //   探测失败 ⇒ fail-closed 退回模型 bbox 底（行为与升级前一致）。
                let prevInkBottom: number | undefined;
                if (canvasRef.current && prevBBox && prevBottom !== undefined) {
                  try {
                    const cssScale = canvasRef.current.clientWidth > 0 ? canvasRef.current.clientWidth / canvasRef.current.width : 0;
                    const pTop = Math.max(0, Math.floor((prevBBox.y ?? 0) / cssScale));
                    const pBottom = Math.floor(prevBottom / cssScale);
                    const pH = pBottom - pTop;
                    const pLeft = Math.max(0, Math.floor((prevBBox.x ?? cand.x) / cssScale));
                    const pWidth = Math.min(canvasRef.current.width - pLeft, Math.ceil((prevBBox.width ?? cand.width) / cssScale));
                    if (cssScale > 0 && pH > 0 && pWidth > 0) {
                      const pd = canvasRef.current.getContext("2d")?.getImageData(pLeft, pTop, pWidth, pH).data;
                      if (pd) {
                        for (let row = pH - 1; row >= 0; row--) {
                          let hasInk = false;
                          for (let col = 0; col < pWidth; col++) {
                            const px = (row * pWidth + col) * 4;
                            if (pd[px] < 240 || pd[px + 1] < 240 || pd[px + 2] < 240) { hasInk = true; break; }
                          }
                          if (hasInk) { prevInkBottom = (pTop + row + 1) * cssScale; break; }
                        }
                      }
                    }
                  } catch { prevInkBottom = undefined; }
                }
                const topBoundary =
                  prevInkBottom !== undefined
                    ? Math.min(prevBottom ?? prevInkBottom, Math.max(prevInkBottom, prevBBox?.y ?? prevInkBottom))
                    : prevBottom;
                const scan = scanInkRowsForRange(canvasRef.current, {
                  leftCss: cand.x,
                  topCss: topBoundary ?? cand.y,
                  bottomCss: nextTop ?? cand.y + cand.height,
                  widthCss: cand.width,
                });
                // 「只扩展顶部」：bottom 强制保持模型框底 ——
                //   ink 扫描的 inkBottom 会把下一行顶部墨迹计入（cjk 实测 330.97 > 下一行
                //   329.23，触发回滚条件后修正）⇒ 仅采纳校正后的 y，height 由模型框底回推。
                const res = scan
                  ? correctBoxWithInkRows(cand, scan, { topBoundary })
                  : { box: cand as { x: number; y: number; width: number; height: number }, corrected: false };
                const candBottom = cand.y + cand.height;
                const y2 = Math.min(res.box.y, candBottom);
                return {
                  lineId: t.lineId,
                  box: { x: cand.x, y: y2, width: cand.width, height: Math.max(0, candBottom - y2) },
                };
              })
          );
        } else if (decision.reason) {
          console.log("[F3B-6.14][RECONCILE_FALLBACK]", {
            stage: decision.reason,
            reason: decision.reason,
            generation: sidecarGenerationRef.current,
            affectedLines: affectedLines.length,
          });
        }
      } catch (error) {
        console.log("[F3B-6.14][RECONCILE_FALLBACK]", {
          stage: "reconciliation-error",
          reason: String(error),
        });
      }
    }
  }, [coreInputTick]);

  // M7.7-007: Export 前 commit 当前编辑会话，确保导出内容包含最新编辑
  const handleExportWithCommit = useCallback(async (skipPay?: boolean, download?: boolean) => {
    requestEditTransition("EXPORT");
    return await handleExport(skipPay, download);
  }, [handleExport, requestEditTransition]);

  const { handleStripePay, handlePaypalPay } = usePayment({ handleExport: handleExportWithCommit });
  const { processInline: processInlineRaw } = useInlineTools({ pdfBytesRef, coordRef, cssScaleRef });

  // ── V12 移植适配（D1：先转换后付费，保留本项目 paywall 链路）──
  // v12 原版的工具流程是「导出 → 存 IndexedDB → 跳 /paywall（付费后才转换）」；
  // 本项目保留原商业模式：先在本地完成转换 → 完成弹窗 → 用户点击下载时
  // uploadToR2AndRedirect 上传 R2 → 跳 www.pdfsail.com/[locale]/ready → /paywall。
  // 因此所有工具入口先用 handleExportWithCommit 拿到「含字形级编辑」的最终 PDF，
  // 再交给 useInlineTools 执行转换（extra.sourceBytes 透传）。
  const processInline = useCallback(async (tool: string, extra: any = {}) => {
    try {
      const result = await handleExportWithCommit(undefined, false);
      const sourceBytes = result ? new Uint8Array(await result.blob.arrayBuffer()) : undefined;
      await processInlineRaw(tool, { ...extra, sourceBytes });
    } catch (e) {
      console.error("processInline (with export) failed:", e);
    }
  }, [handleExportWithCommit, processInlineRaw]);

  // ── F3B-6.4B-P2-A: 当前页的**文档 line identity** ──
  //   mask identity matching 原先只看 `glyphCommands` 派生的 line id；而「整行清空」后
  //   该行 `glyphs = []` ⇒ 0 条命令 ⇒ 身份消失 ⇒ `editedLineBoxes` 的 box（B-6.1 已算好）
  //   被 gate 拦掉 ⇒ 原 PDF 墨迹继续可见（P2）。
  //   这里从 **当前页文档** 收集 line id 作为补充身份来源（命令身份仍由 GlyphRenderer 侧并入）。
  //   多页隔离不受影响：只取 `page` 这一页（p.index === page，与 renderPageToCommands 同一选择逻辑）。
  const documentPageLineIds = useMemo(() => {
    const ids = new Set<string>();
    const doc = editableDocumentRef.current;
    if (!doc) return ids;
    const pageData = doc.pages.find((p) => p.index === page);
    if (!pageData) return ids;
    for (const block of pageData.blocks) {
      for (const line of block.lines) ids.add(line.id);
    }
    return ids;
  }, [editableDocVersion, page]);

  // ── Task 1+2: useMemo 稳定 glyphCommands 引用 ──
  // 避免每次 render 都调用 renderPageToCommands 生成新数组，
  // 导致 GlyphRenderer useMemo 失效 → 重建所有 DOM span → 内存增长。
  // 仅在 editableDocVersion 或 page 变化时重新计算。
  // 注意：必须定义在所有引用它的 effect 之前（TDZ）。
  // Sprint 20.5: 双层防线签名 glyph 抑制。
  // 第 1 层：renderBlockToCommands 检查 suppressedGlyphBlockIds（核心过滤）
  // 第 2 层：forceFilterSuppressedGlyphs（安全网 — 驱逐任何漏网 glyph）
  // 渲染顺序：PDF image (z=0) → backgroundPatch image (z=1) → editable glyph (z=2)
  const glyphCommands = useMemo(() => {
    const doc = editableDocumentRef.current;
    if (
      editableDocVersion !== undefined &&
      doc
    ) {
      // ── Sprint 24 Task 24.5: 签名增强 bypass 开关 ──
      const disableSigEnhance = typeof window !== "undefined" ? (window as any).__disableSignatureEnhancement : false;

      const suppressedSet = disableSigEnhance ? new Set<string>() : suppressedGlyphIdsRef.current;
      // Sprint34.13: 传入 signatureRotationRef（blockId → rotation），供 mask geometry 计算旋转后包围盒。
      const baseCmds = renderPageToCommands(doc, page, suppressedSet, signatureRotationRef.current);

      // ── Sprint 20.5 第 2 层安全网：强制过滤 suppressed block 的 glyph ──
      // 不依赖 background patch。不依赖 mask。在 command 层面直接清除。
      const preFilterGlyphCount = baseCmds.filter(c => c.type === "drawGlyph").length;
      let filteredOutCount = 0;
      const renderedBlockIds = new Set<string>();
      const unexpectedRendered: string[] = [];
      const filteredCmds = baseCmds.filter((cmd) => {
        if (cmd.type === "drawGlyph" && "blockId" in cmd) {
          const bid = (cmd as any).blockId as string;
          if (suppressedSet.has(bid)) {
            filteredOutCount++;
            return false; // 驱逐
          }
          renderedBlockIds.add(bid);
          // 检查是否为意外的 rendered block（不应有 glyph 的 suppressed block）
          if (suppressedSet.has(bid)) {
            unexpectedRendered.push(bid);
          }
        }
        return true;
      });

      if (filteredOutCount > 0) {
        console.warn(
          `[SignatureGlyphFilter] SAFETY NET: forced-filtered ${filteredOutCount} glyph commands ` +
          `from suppressed blocks on page ${page}. ` +
          `(pre-filter: ${preFilterGlyphCount} glyphs → post-filter: ${preFilterGlyphCount - filteredOutCount})`,
        );
      }

      // 应用旋转角度到 editable glyphs（Sprint 24 bypass 时跳过）
      const rotationMap = signatureRotationRef.current;
      const rotatedCmds = disableSigEnhance
        ? filteredCmds
        : filteredCmds.map((cmd) => {
            if (
              cmd.type === "drawGlyph" &&
              rotationMap.has(cmd.blockId)
            ) {
              const angleDeg = rotationMap.get(cmd.blockId)!;
              if (Math.abs(angleDeg) > 0.5) {
                const angleRad = angleDeg * (Math.PI / 180);
                return {
                  ...cmd,
                  transform: [Math.cos(angleRad), Math.sin(angleRad), -Math.sin(angleRad), Math.cos(angleRad), 0, 0] as TransformMatrix,
                };
              }
            }
            return cmd;
          });

      // ── Sprint 21: 注入全页背景文字移除 patch（覆盖所有 OCR block） ──
      // Sprint 24 bypass 时跳过所有 patches，只保留纯 glyph
      // 变量声明在外部，供 debug 代码引用
      let cleanPatches: Array<{ blockId: string; bbox: { x: number; y: number; width: number; height: number }; dataURL: string }> = [];
      let sigBgImages: DrawImageCommand[] = [];
      let bgImages: DrawImageCommand[] = [];
      let cmds: RenderCommand[];
      // Sprint 26: 声明在外部，供 diagnostics 使用
      const sigReplacements: SignatureReplacement[] = signatureReplacementsRef.current.get(page) ?? [];
      if (disableSigEnhance) {
        console.log("[Sprint24] __disableSignatureEnhancement = true, skipping ALL patches, rotation, and suppression");
        cmds = rotatedCmds;
      } else {
        // 层顺序：cleanBG patches (z:1) → glyphs (z:2)
        sigBgImages = sigReplacements.map((rep) => ({
          type: "drawImage",
          src: rep.backgroundPatch,
          x: rep.originalRegion.x,
          y: rep.originalRegion.y,
          width: rep.originalRegion.width,
          height: rep.originalRegion.height,
          blockId: rep.id,
          patchId: `sig-patch-${rep.id}`,
          // Sprint34.11: 让 background patch 继承签名 rotation（与 glyph 一致）
          rotation: rep.rotationAngle ?? 0,
        }));

        cleanPatches = backgroundRemovalRef.current.get(page) ?? [];
        const cleanBgImages: DrawImageCommand[] = cleanPatches.map((p) => ({
          type: "drawImage",
          src: p.dataURL,
          x: p.bbox.x,
          y: p.bbox.y,
          width: p.bbox.width,
          height: p.bbox.height,
          blockId: p.blockId,
          patchId: `clean-patch-${p.blockId}`,
        }));

        // clean patches 先于签名 patches（覆盖范围更广，签名 patches 叠加在上面微调）
        bgImages = [...cleanBgImages, ...sigBgImages];
        cmds = [...bgImages, ...rotatedCmds];
      }

      // Sprint 20.5: 更新 debug — 记录实际渲染了哪些 block
      const glyphDebug = (window as any).__signatureGlyphDebug;
      if (glyphDebug) {
        glyphDebug.renderedBlocks = [...renderedBlockIds];
        glyphDebug.unexpectedRenderedBlocks = unexpectedRendered;
        (window as any).__signatureGlyphDebug = glyphDebug;

        // Sprint 20.6: 更新 __signatureRenderDebug 的 glyph 渲染数据
        const renderDebug = (window as any).__signatureRenderDebug;
        if (renderDebug?.pages) {
          const pageDebug = renderDebug.pages.find((p: any) => p.page === page);
          if (pageDebug) {
            pageDebug.glyphRenderedBlocks = [...renderedBlockIds];
            (window as any).__signatureRenderDebug = renderDebug;
          }
        }
      }

      // ================================================================
      // Sprint 20.6 DEBUG — Checkpoint C: glyph 渲染结果
      // ================================================================
      const leakedIds = [...renderedBlockIds].filter((bid) => suppressedSet.has(bid));

      const finalDebug = (window as any).__signatureFinalDebug;
      if (finalDebug) {
        finalDebug.renderedGlyphBlocks = [...renderedBlockIds];
        finalDebug.leakedBlocks = leakedIds;
        (window as any).__signatureFinalDebug = finalDebug;
      }

      if (leakedIds.length > 0) {
        console.error(
          "%c[Sprint 20.6 LEAK] %cDUPLICATE GLYPHS STILL RENDERING! %c" + leakedIds.length + " blocks leaked",
          "font-weight:bold;color:red;font-size:14px;",
          "font-weight:bold;color:red;",
          "color:red;",
          {
            leakedIds,
            suppressedSet: [...suppressedSet],
            renderedBlockIds: [...renderedBlockIds],
            allCommands: cmds.filter((c) => c.type === "drawGlyph").length,
          },
        );
      } else {
        console.log(
          "%c[Sprint 20.6 CLEAN] %cZero leaked glyphs. %c" + preFilterGlyphCount + " total → " +
          (preFilterGlyphCount - filteredOutCount) + " rendered, " + filteredOutCount + " suppressed",
          "font-weight:bold;color:#00aa00;",
          "color:#333;",
          "color:#00aa00;",
        );
      }

      // Checkpoint C summary: renderPageToCommands 参数验证
      const baseCmdsGlyphBlockIds = new Set(
        baseCmds.filter((c) => c.type === "drawGlyph").map((c) => (c as any).blockId as string),
      );
      const suppressedInBaseCmds = [...suppressedSet].filter((sid) => baseCmdsGlyphBlockIds.has(sid));
      console.log(
        "%c[Checkpoint C] %crenderPageToCommands received suppressedSet.size=" + suppressedSet.size +
        "; baseCmds had " + baseCmdsGlyphBlockIds.size + " unique glyph block IDs" +
        (suppressedInBaseCmds.length > 0
          ? "; ⚠ " + suppressedInBaseCmds.length + " suppressed blocks STILL in baseCmds before safety net"
          : "; ✓ No suppressed blocks in baseCmds (renderBlockToCommands filter working)"
        ),
        "font-weight:bold;color:#0066cc;",
        "color:#333;",
      );

      // ── Sprint 22 Phase 5: 坐标系统验证 ──
      // 对第一个 text block 输出完整坐标链
      // ── Sprint 22 Phase 1: 更新 Pipeline Map counts ──
      const pm = (window as any).__renderPipelineMap;
      if (pm?.layerChildren?.glyphRenderer?.subLayers) {
        pm.layerChildren.glyphRenderer.subLayers[0].count = filteredCmds.filter((c: any) => c.type === "drawRect" && c.purpose === "mask").length;
        pm.layerChildren.glyphRenderer.subLayers[1].count = filteredCmds.filter((c: any) => c.type === "drawRect" && c.purpose !== "mask").length;
        pm.layerChildren.glyphRenderer.subLayers[2].count = cleanPatches.length;
        pm.layerChildren.glyphRenderer.subLayers[3].count = sigBgImages.length;
        pm.layerChildren.glyphRenderer.subLayers[4].count = rotatedCmds.filter((c: any) => c.type === "drawGlyph").length;
      }
      if (pm?.layers?.[1]) {
        pm.layers[1].children = [
          "glyphRenderer", "segmentsLayer", "textLayer", "blocksLayer", "portalRoot"
        ];
      }

      console.log(
        `[glyphCommands] v=${editableDocVersion} page=${page} → ${cmds.length} commands ` +
        `(${bgImages.length} bg patches, ${filteredOutCount} forced-filtered, ` +
        `${rotatedCmds.filter(c => c.type === "drawGlyph" && (c as any).transform).length} rotated) ` +
        `glyphCount=${preFilterGlyphCount - filteredOutCount}`,
      );

      // ═══════════════════════════════════════════════════════════════
      // Sprint 26: Signature Background Patch Verification
      // ═══════════════════════════════════════════════════════════════
      {
        const sigRegions = signatureRegionInfoRef.current.get(page) ?? [];
        const pageBlocks = docBlocks.filter((b) => b.page === page);
        const patches: any[] = [];

        for (const rep of sigReplacements) {
          // 找到对应的 region（by id 匹配）
          const region = sigRegions.find((r) => r.id === rep.id);
          if (!region) continue;

          // 获取 duplicate block bboxes 和 editable block bboxes
          // Block 使用 x/y/w/h 结构
          const duplicateBBoxes: Array<{ blockId: string; bbox: { x: number; y: number; width: number; height: number } }> = [];
          const editableBBoxes: Array<{ blockId: string; bbox: { x: number; y: number; width: number; height: number } }> = [];

          for (const bid of region.duplicateBlockIds) {
            const block = pageBlocks.find((b) => b.id === bid);
            if (block) {
              duplicateBBoxes.push({ blockId: bid, bbox: { x: block.x, y: block.y, width: block.w, height: block.h } });
            }
          }
          for (const bid of region.editableBlockIds) {
            const block = pageBlocks.find((b) => b.id === bid);
            if (block) {
              editableBBoxes.push({ blockId: bid, bbox: { x: block.x, y: block.y, width: block.w, height: block.h } });
            }
          }

          // 计算 coverageRatio: patchArea ∩ duplicateArea / duplicateArea
          const patchBBox = rep.originalRegion;
          const coverageRatios: number[] = [];
          let allFullyCovered = true;

          for (const { blockId, bbox } of duplicateBBoxes) {
            // 计算交集
            const ix = Math.max(patchBBox.x, bbox.x);
            const iy = Math.max(patchBBox.y, bbox.y);
            const ix2 = Math.min(patchBBox.x + patchBBox.width, bbox.x + bbox.width);
            const iy2 = Math.min(patchBBox.y + patchBBox.height, bbox.y + bbox.height);
            const iw = Math.max(0, ix2 - ix);
            const ih = Math.max(0, iy2 - iy);
            const intersectionArea = iw * ih;
            const duplicateArea = bbox.width * bbox.height;
            const ratio = duplicateArea > 0 ? intersectionArea / duplicateArea : 0;
            coverageRatios.push(ratio);
            if (ratio < 0.95) allFullyCovered = false;
          }

          patches.push({
            patchId: rep.id,
            regionId: region.id,
            bbox: { x: patchBBox.x, y: patchBBox.y, width: patchBBox.width, height: patchBBox.height },
            x: patchBBox.x,
            y: patchBBox.y,
            width: patchBBox.width,
            height: patchBBox.height,
            originalBBox: { x: region.bbox.x, y: region.bbox.y, width: region.bbox.width, height: region.bbox.height },
            patchBBox: { x: patchBBox.x, y: patchBBox.y, width: patchBBox.width, height: patchBBox.height },
            patchImage: rep.backgroundPatch,
            patchSize: { width: patchBBox.width, height: patchBBox.height },
            sourceRegion: region.bbox,
            duplicateBlocks: duplicateBBoxes.map(({ blockId, bbox }) => ({ blockId, bbox })),
            editableBlocks: editableBBoxes.map(({ blockId, bbox }) => ({ blockId, bbox })),
            coverageRatios,
            coverageRatio: coverageRatios.length > 0
              ? coverageRatios.reduce((a, b) => a + b, 0) / coverageRatios.length
              : 1,
            allFullyCovered,
            verification: allFullyCovered ? "PASS" : "FAIL",
          });
        }

        // F3B-6.2：patch 诊断默认关闭（?debug=renderpatch 开启）。
        // 关闭时不再构造 diagnostics / patchDebugEntries，也不再向 window 持留完整 dataURL。
        // （缩进保持原样以最小化 diff；本块整体为 debug，无生产副作用。）
        if (isRenderPatchDebugEnabled()) {
        const diagnostics = { page, patchCount: patches.length, patches };
        (window as any).__sprint26_patchDiagnostics = diagnostics;

        // Sprint 27: 暴露 __signaturePatchDebug（不含 full dataURL 的日志版本 + 含 dataURL 的 window 版本）
        const patchDebugEntries = patches.map((p) => ({
          regionId: p.regionId ?? p.patchId,
          originalBBox: p.originalBBox,
          patchBBox: p.patchBBox,
          patchImage: `<dataURL length=${p.patchImage?.length ?? 0}>`,
          patchSize: p.patchSize,
        }));
        (window as any).__signaturePatchDebug = patches.map((p) => ({
          regionId: p.regionId ?? p.patchId,
          originalBBox: p.originalBBox,
          patchBBox: p.patchBBox,
          patchImage: p.patchImage,
          patchSize: p.patchSize,
        }));
        console.log("%c[Sprint 27] __signaturePatchDebug",
          "font-weight:bold;color:#ff6600;", patchDebugEntries);

        // 输出每个 patch 的详细诊断
        console.group("%c[Sprint 26] Patch Diagnostics %cpage=" + page,
          "font-weight:bold;color:#1e90ff;", "color:#333;");
        for (const p of patches) {
          console.log(`%cPatch ${p.patchId}`, "font-weight:bold;color:#1e90ff;", {
            bbox: p.bbox,
            sourceRegion: p.sourceRegion,
            duplicateCount: p.duplicateBlocks.length,
            duplicateBlocks: p.duplicateBlocks.map((d: any) => ({
              blockId: d.blockId,
              bbox: d.bbox,
            })),
            editableBlocks: p.editableBlocks.map((d: any) => ({
              blockId: d.blockId,
              bbox: d.bbox,
            })),
            coverageRatios: p.coverageRatios,
            avgCoverageRatio: p.coverageRatio,
            allFullyCovered: p.allFullyCovered,
            verification: p.verification,
          });
        }
        if (patches.length === 0) {
          console.log("%c(No signature background patches on this page)", "color:#999;");
        } else {
          const passCount = patches.filter((p: any) => p.allFullyCovered).length;
          console.log(
            `%c${passCount}/${patches.length} patches PASS (coverageRatio > 0.95)`,
            `font-weight:bold;color:${passCount === patches.length ? "#00aa00" : "#ff6600"};`,
          );
        }
        console.groupEnd();
        } // F3B-6.2：end if (isRenderPatchDebugEnabled())
      }
      // ── end Sprint 26 ──

      return cmds;
    }
    return undefined;
  }, [editableDocVersion, page]);

  // ══════════════════════════════════════════════════════════════════════
  // EDITOR-CORE-012-A · Core 渲染源（派生只读投影）
  //
  //   editableDocumentRef（既有唯一编辑真相）
  //        ↓ buildCoreRenderSource()（useMemo 派生，**不保存任何 state**）
  //   EditorDocument → Layout → EditorRenderFrame → RenderCommand[] + EditableStyle[]
  //
  // 设计要点（见 docs/editor-core-012a-wiring-audit.md）：
  //   · **没有** setEditorDocument / store：只是从既有 ref 派生只读快照
  //   · 开关 window.__coreRender（缺省 off）；Core 不可用 → **自动回退 legacy**
  //   · commands 与 styles **成对**切换（styleRef 指向 Core 自己产出的 styles 表）
  //   · mask / rect / image 仍由 legacy 提供（coverage ownership 属 PDF Binding，011-A）
  //   · 本阶段**不接输入**：编辑真相迁移属 012-C，故下面 glyphCommandsRef 仍指 legacy
  // ══════════════════════════════════════════════════════════════════════
  // F3B-6.18-D.1：Core 文本 renderer = **production default**。
  //   · `readCoreRenderFlag()` 缺省 ON；只有显式 `window.__coreRender === false` 才回退 legacy
  //     （emergency rollback；legacy 文本 renderer **不删除**）。
  //   · ⚠️ 渲染 ownership 与 semantic ownership **必须分离**（D.1 boundary ②）：
  //     此处**不得**再依赖 `segmentCoreActive` —— 那是「本文档的 Segment 编辑是否走过 Core」
  //     的语义信号（mutation / export ownership）；用它决定 renderer 会把两个关注点耦合。
  //   · Core 只接管**文本** glyph；mask / rect / image 仍由 legacy 提供（011-A ownership）。
  const coreRenderEnabled = readCoreRenderFlag();

  // ══════════════════════════════════════════════════════════════════════
  // EDITOR-CORE-012-C6 · Core 输入接线（开关 `window.__coreInput`，缺省 off）
  //
  //   输入：`wrapperRef` 上的 **capture-phase `beforeinput`**（单点挂载，天然覆盖全部
  //         EditableTextNode —— 因此**不必**改 PDFCanvas，也不必给 EditableTextNode 加 prop）
  //         ↓ dispatchBeforeInput（Core / legacy **互斥**：只有一条路径被调用）
  //   Core  : InputEvent → InputAdapter → Command → EditorHistory → EditorDocument
  //            → Live Reflow → RenderFrame → **渲染源直接取自 session 文档**（C6-A）
  //   legacy: 不拦截，DOM 默认行为继续（原 onBlur→onChange 路径逐字节不变）
  //
  // C6-E 由**结构**保证而不是靠约定：Core 路由时 `preventDefault()` → DOM 文本根本没变
  //   → 之后 onBlur 取到的 `textContent === segment.text` → **不可能**发生二次 mutation。
  //
  // ⚠️ 已知限制（本轮**未**做，均有明确理由）：
  //   1. `EditableTextNode.handleKeyDown` 对 Enter 是 `preventDefault + blur()`（`EditableTextNode.tsx:148-152`）
  //      → Enter 会先被 legacy 的 keydown 截走，`beforeinput(insertParagraph)` 不会到 Core。
  //      因此"Enter → 两个段落"目前**只在 binding/渲染源层验证**（可测），
  //      真实 DOM 层要等 C6 之后把 onKeyDown 的 Enter 移交 InputAdapter。
  //   2. 未建模输入（方向键 / Home/End / 词删 / 格式化）一律交回 legacy（`dispatchBeforeInput` 的
  //      `unsupported-input-type` 分支）—— C5 明确把这一批排除在本轮外。
  //   3. caret 只做**最小同步**（段内 DOM offset → 段落偏移）；跨段 range / 反向选区不做。
  //   4. legacy `editableDocVersion` 变更不会自动合并进 session（只告警）—— 属 013 的范围。
  // ══════════════════════════════════════════════════════════════════════
  const coreInputEnabled = readCoreInputFlag();
  /** 0 = 尚无 Core session；>0 = session 已建立（每次被接管的输入 +1，用于触发重算） */
  const coreInputActive = coreInputTick > 0 && coreInputSessionRef.current !== null;
  /** 已被 Core session 接管的 segment（E2.1 的归属判定 + 编辑期视觉来源切换） */
  const coreOwnedSegmentIdRef = useRef<string | null>(null);
  // ★ F3B-6.27 P0-D0 Slice 2：unit surface 的**最新值镜像**。
  //   ⚠️ 必须声明在 `beforeinput` effect **之前**：`explicitUnitSurface` 在该 effect 之后才计算，
  //      把它放进那个 effect 的 deps 会在 render 期触发 TDZ ReferenceError ⇒ 整个 /editor 崩溃
  //      （本文件已记录过两次同类事故）。故用 ref 镜像 + 下方 effect 同步，**不改**那个 deps。
  const unitSurfaceRef = useRef<{ unit: EditingUnit; text: string } | null>(null);

  // ══ 4B-4D-2A Step 4 · unit 视觉 partition（A′ 重建 `<br>` 的唯一依据）══════
  //
  //  ★ 语义：`{ unitId, text, partition }` 三者必须**同属一次计算**，否则不注入
  //    （「长度相同」不足：\"ABCX\" 与 \"ABCD\" 长度一致、caret/断点语义不同）。
  //  ★ `<br>` **不贡献 textContent**（4B-4B-0 实测 9/9 位置 diff=0）⇒
  //    `unit.text === DOM textContent` 这条 F5 前提**不受影响**。
  const unitPartitionRef = useRef<{
    unitId: string;
    text: string;
    partition: LogicalLinePartition;
  } | null>(null);

  /**
   * 按 partition **幂等重建** unit surface 的视觉断点（`<br>`）。
   *
   * ★ 为什么用 `<br>` 而不是 `display:block` 元素：`Range.toString()` 对块级元素
   *   会**额外产生 `\n`** ⇒ 破坏 4B-4C 建立的前缀 offset 口径；而 `<br>` 实测
   *   **零贡献**（4B-4B-0，9/9 位置 diff=0）。
   *
   * ★ 幂等实现：**先清空既有 `<br>`，再按 partition 重建**
   *   ⇒ 同一 (text, partition) 重复执行得到**完全相同的 DOM 结构**。
   *
   * ★ separator 的 `\n` **不转成** `<br>`：`white-space: pre-wrap` 已负责显式换行，
   *   额外注入会重复换行（partition 的 `needsExplicitBreak` 对 separator 恒为 false）。
   *
   * @returns 实际插入的 `<br>` 数量
   */
  const applyVisualBreaks = (scope: HTMLElement, p: LogicalLinePartition): number => {
    // ★★ 2026-10-19（用户缺陷「再次编辑时"测"字换行到第 3 行」）：unit 面**结构性恒不注入**
    //    `<br>`，折行完全交回浏览器自然换行。保留幂等清理（清掉历史残留）。
    //    根因（实测 brdiag，tests/e2e/_out/user1019/）：本函数唯一调用点是 A′ 的 unit
    //    写入分支 ⇒ unit 面恒 `white-space: normal`（F3B-6.27 第一阶段连续编辑视图）。
    //    但**宿主刚切换/面刚打开的第一帧**，React 的 surfaceStyle 尚未应用到该元素
    //    （computed = baseStyle 的 `nowrap`）⇒ 旧守卫（读 computed style）读到 nowrap
    //    ⇒ 放行 ⇒ 按当时的 partition 注入。而第一次编辑提交后 Core reflow 把变长的
    //    l10 段落折成 2 个视觉行 ⇒ partition = 3 视觉行 ⇒ 在"等。"/"测试"边界注入
    //    `<br>` ⇒ React 下一帧应用 normal 但**不会清除**命令式插入的 `<br>`（VDOM
    //    文本未变 ⇒ 不重置 children）⇒ 残留 ⇒ "测试"被赶到第 3 行（用户截图）。
    //    ⇒ 判定改为**结构性**：本函数只服务 unit 面（唯一调用点），unit 面的断行
    //      永远交回浏览器自然换行（与提交层 flow 的栏宽模型同源，2026-10-18 裁决的
    //      「段内连续重排」）。不读 computed style——它的时序不可靠（上一帧 nowrap、
    //      下一帧 normal，注入发生在错误的帧）。
    //    ★ DOM 文本零改动（仍含 "\n"）⇒ unit route 偏移映射 / A′ 门 / F5 恢复 /
    //      2B 播种 / reconcile 全部按既有 unit 文本口径工作，零输入路由风险。
    //    ★ partition 参数保留（调用点签名不变）；`p.flowLines` 不再消费。
    try {
      for (const b of Array.from(scope.querySelectorAll("br"))) b.remove();
      return 0;
    } catch {
      return 0; // fail-closed：清理失败 ⇒ 保持现状（绝不破坏文本）
    }
  };

  // ══ F5 · unit caret 恢复（裁决 B：由 beforeinput intent 派生）═══════════════
  //
  // 依据：Core `UnitTransactionCommand` **不产出 caret**（实测该文件零 "caret" 命中）
  //   ⇒ 不假装 Core 有一个不存在的 caret truth；caret 位置只能来自**事务语义本身**：
  //     insert / replace → `unitStart + replacementText.length`
  //     delete           → `unitStart`
  //   即 adapter 的 `postMutationUnitOffset`（**UTF-16** unit offset）。
  //
  // ★ 用 ref 而非 state：恢复发生在 A′ effect 内（DOM 写入之后），**不得**为此多一次 render。
  // ★ 严格失效（缺一不可）：
  //     `unitId` 相同 **且** `expectedText` 与写入文本**逐字节相等**
  //     ——「长度相同」不足（"ABCX" 与 "ABCD" 长度一致但 caret 语义不同）。
  // ★ 一次性：尝试恢复后（无论成败）立即清除 ⇒ 过期 caret 永不生效。
  // ★ **不做** boundary 收敛：只把 offset 交给 `reconcileDomCaretAtOffset`
  //   （内部走 `planDomCaretOffsets`）⇒ 不产生第二套 caret 规则。
  const pendingUnitCaretRef = useRef<{ unitId: string; expectedText: string; offset: number } | null>(
    null,
  );

  // ══ F3B-6.21-A-Impl：Core Session Revision & Ownership Lifecycle ══════
  //
  //   ⚠️⚠️ 两个 ownership 概念**必须保持分离**（R1 fail-safe 可见性不变量）：
  //      · **Core semantic ownership** = `coreOwnedSegmentIdRef`（Core 是否语义上认领该 segment）
  //      · **DOM visual suppression ownership** = 发布给 `CoreInputVisualState` 的 `ownedSegmentId`
  //   只有 `corePresentationActive === true`（几何确实可用）才允许 DOM 让位；
  //   否则会出现 zero-caret window（DOM caret 被隐藏 ∧ CaretLayer 无几何 ⇒ 看不到光标）。
  //
  //   Revision 归属：**Core Input Session 生命周期**（不是 `EditorDocument` ——
  //   `EditorDocument.version` 非单调：undo/redo 回退、rebuild 重置）。
  type CoreRevisionReason =
    | "core-mutation"
    | "ownership-transfer"
    | "caret-seed"
    | "selection-change"
    | "legacy-fallback"
    | "invalidate"
    | "session-generation";

  /** 唯一 presentation revision 信号（单调）。 */
  const [coreSessionRevision, setCoreSessionRevision] = useState(0);
  /** session 换代（re-import / 重建）；与 revision 一起使旧几何失效。 */
  const [coreSessionGeneration, setCoreSessionGeneration] = useState(0);

  /**
   * **单一 revision bump 入口**（消 G5：原先 6 处复制粘贴的收尾）。
   *
   * 所有会改变「Core 呈现所依赖状态」的事件都必须经此函数；
   * **禁止**在别处直接 `setCoreInputTick`，也禁止自造第二套刷新路径。
   */
  const noteCoreSessionChange = useCallback((reason: CoreRevisionReason) => {
    // `coreInputTick` 语义保留（`coreInputActive` / render source 仍需「是否发生过 Core mutation」）
    if (reason === "core-mutation") setCoreInputTick((n) => n + 1);
    setCoreSessionRevision((n) => n + 1);
    if (reason === "session-generation") setCoreSessionGeneration((g) => g + 1);
  }, []);

  /**
   * **#10：selection-change 幂等去重键**（上一次已同步到 Core 的 `segmentId:domOffset`）。
   *
   * 防反馈环的**源头边界**手段：只有当 DOM selection 真的**解析出不同的 offset** 时才
   * 写 session + bump revision ⇒ 不会「React 重渲染 → 再触发无意义 selectionchange → 再 bump」。
   * ⚠️ 刻意**不用** debounce / rAF / 循环计数 guard —— 那是掩盖症状；这里消除的是
   *    「对**未变化**的输入信号做状态写入」这一根因。
   */
  const lastCoreSelectionSyncRef = useRef<string | null>(null);
  /**
   * ★ F3B-6.27-G9：DOM→Core 播种**发生钳制**时的待回写记录。
   *
   * Core 接管面的 DOM 文本是陈旧的 `segment.text`，而 Core 段落可能已更短
   * ⇒ 点击给出的 DOM offset 会越界、被钳制到 Core 段落末尾。
   * 此时 DOM caret 仍停在陈旧位置 ⇒ 可见 caret 与 Core 真相不一致（= 用户报告的
   * 「光标无法定位」）。本 ref 承载「应落到的 segment-local UTF-16 offset」，
   * 由 `onSelectionChange` 在写入 Core selection 之后**回写 DOM**，维持不变量
   * 「Core caret ⇄ DOM caret 一致」。
   */
  const seedDivergenceRef = useRef<{ segmentId: string; localOffsetUtf16: number } | null>(null);
  /**
   * ★ F3B-6.27 实现 checkpoint：当前编辑行的 **SegmentRangeLedger**。
   *
   * 承载「Core paragraph → segment range → segment-local DOM text」的绑定状态，
   * 并按 Core transaction 快照维护（undo/redo 随文档一起恢复）。
   *
   * ⚠️ 生命周期：随 document generation 建立/失效（见 resetCoreDocumentGeneration 的置空）；
   *    它**不是** Sidecar（Sidecar 是 import-time immutable，本状态可变）。
   */
  const segmentRangeLedgerRef = useRef<SegmentRangeLedger | null>(null);
  /** 当前 ledger 对应的 Core paragraphId（用于判定是否仍适用） */
  const segmentRangeParagraphRef = useRef<string | null>(null);
  /**
   * ★ F3B-6.27 Step 3：`syncedCoreVersion` = ledger 最后一次与 Core 确认对齐时的
   *   **Core version**（fence）。
   *
   * ⚠️ 刻意**不是** `ledger.generation` —— 两者是不同计数器：`createLedger` 每次播种
   *   都从 0 起、只有 accepted mutation 才 +1，而 `coreDoc.version` 由 Core 自己递增
   *   ⇒ 直接比较会永远判 stale。详见 `binding/segment-range-ledger-sync.ts`。
   *
   * 生命周期：与 ledger 同生共死（`ensureSegmentRangeLedger` 播种时写入、
   *   `resetCoreDocumentGeneration` 置空）。
   */
  const segmentRangeFenceRef = useRef<number | null>(null);
  /** 最近一次 Core mutation 是否被 ownership 接受（`null` = 尚未尝试） */
  const segmentRangeLastMutationRef = useRef<"accepted" | "rejected" | "not-attempted">("not-attempted");

  /** 取得当前编辑行的 ownership（无 ⇒ null，调用方回退既有 base 行为） */
  const segmentRangeOwnershipOf = useCallback(
    (paragraphId: string | null): SegmentRangeOwnership | null => {
      const ledger = segmentRangeLedgerRef.current;
      if (!ledger || !paragraphId) return null;
      if (segmentRangeParagraphRef.current !== paragraphId) return null;
      return ledger.current;
    },
    []
  );

  /**
   * ★ 段落级 base 的**唯一口径**：优先 ownership 的 range.startUtf16，无则回退既有 base。
   *   （与 `domOffsetToParagraphOffset` / `paragraphOffsetToDomOffset` 同源，禁止各自算 base）
   */
  const rangeBaseOf = useCallback(
    (paragraphId: string | null, segmentId: string, fallbackBase: number): number => {
      const own = segmentRangeOwnershipOf(paragraphId);
      return segmentBaseOf(own, segmentId, fallbackBase);
    },
    [segmentRangeOwnershipOf]
  );

  /**
   * 为「当前正在编辑的行」建立 ownership + ledger。
   *
   * 种子来自**已验证的 Binding 解析原语** `resolveSegmentParagraphRange`
   * （经行 glyph 序列换算段落级 UTF-16 区间），**不**由文本搜索得到（I7）。
   */
  const ensureSegmentRangeLedger = useCallback(
    (segmentId: string, coreDoc: any): SegmentRangeLedger | null => {
      const segs = segmentsRef.current ?? [];
      const self = segs.find((s) => s.id === segmentId);
      const lineId = self?.source?.lineId;
      if (!lineId) return null;
      const glyphs = (self?.source?.blockId ? lineGlyphsFor(self.source.blockId, lineId) : null) as
        | ReadonlyArray<{ char?: string }>
        | null;
      if (!glyphs || glyphs.length === 0) return null;

      const seeds: SegmentRangeSeed[] = [];
      let blockId = self?.source?.blockId ?? "";
      let paragraphId: string | null = null;
      for (const s of segs) {
        if (s.source?.lineId !== lineId) continue;
        const range = resolveSegmentParagraphRange(
          coreDoc,
          { source: s.source } as never,
          glyphs as never
        );
        if (!range) continue;
        paragraphId = range.paragraphId;
        blockId = range.blockId;
        seeds.push({
          segmentId: s.id,
          startUtf16: range.segmentStartUtf16,
          endUtf16: range.segmentEndUtf16,
        });
      }
      if (!paragraphId || seeds.length === 0) return null;
      // 段落长度取自 Core 段落文本（段落级偏移的上界）
      const paragraphText = paragraphTextOf(coreDoc, paragraphId);
      if (paragraphText === null) return null;
      const ownership = buildLineOwnership({
        blockId,
        lineId,
        paragraphId,
        paragraphLength: paragraphText.length,
        seeds,
      });
      if (!ownership) return null;
      segmentRangeLedgerRef.current = createLedger(ownership, 0);
      segmentRangeParagraphRef.current = paragraphId;
      // ★ Step 3：播种成功 = ownership 与 Core 在此刻对齐 ⇒ 写下 fence。
      //   （fence 只在这里写；commitTransaction 不推进它，见 segment-range-ledger-sync.ts）
      segmentRangeFenceRef.current = typeof coreDoc?.version === "number" ? coreDoc.version : null;
      segmentRangeLastMutationRef.current = "not-attempted";
      return segmentRangeLedgerRef.current;
    },
    []
  );

  /**
   * **Document Generation Reset（canonical，唯一实现）** —— F3B-6.25-E1-OCR-Impl
   *
   * 语义：丢弃当前 Core/ownership/Sidecar 这一整代状态，使下一次 `editableDocVersion`
   * bump 时 `shouldRehydrate()` 为真 ⇒ 用**新的** legacy 文档重建 Core。
   *
   * 适用边界（**都必须是「换文档」而非「在 Core-owned 文档上改 Legacy」**）：
   *   ① re-import（`loadPdfFromArrayBuffer`）
   *   ② OCR injection（OCR 结果整体替换 `editableDocumentRef`）
   *   ③ B3-C-5：Page Ops（增 / 删 / 移动页）—— PDF 页结构由 pdf-lib 改写后，
   *      `editableDocumentRef` / `coreDocumentRef` / Sidecar 的页映射全部失效，
   *      必须整体作废并等待下一次从新 PDF 状态重新派生。
   *      ★ 语义 =「让 Core 失效」，**不是**「在 Core 上做页 mutation」：
   *        不创建 Page Command、不改 `EditorDocument.pages`、不改 `EditorPage.index`、
   *        不 reparent objects、不记 `markMutationOwner`（C-5 Audit：SPLIT_OWNERSHIP）。
   *
   * ⚠️ 抽取目的：避免 OCR 侧复制出**第二套** reset 顺序（顺序不一致会产生
   *    「session 还在但 document 已空」之类的中间态）。所有 generation 复位必须走本函数。
   */
  const resetCoreDocumentGeneration = useCallback(() => {
    // ★ 2026-10-25：提交态多行渲染快照同边界销毁（旧文档 lineId 的面宽快照对新文档无意义）。
    //   ⚠️ 置于守卫链（coreInputSessionRef→…→signalNewDocument，间距断言）起点之前：
    //      链内插入会撑爆 core-document-lifecycle 的 {0,200} 相邻窗口。
    setCommittedMultilineWidths({});
    // EDITOR-CORE-012-F3B-1.1：释放旧 Core 输入 session + Core document 置空，
    // 并向 lifecycle 发出「新文档」信号 ⇒ import boundary effect 允许创建新 Core（Invariant 3）。
    coreInputSessionRef.current = null;
    coreDocumentRef.current = null;
    // F3B-6.21-A-Impl（#11）：session 换代 ⇒ 旧几何立即失配（fail-closed）+ 清 selection 幂等键。
    lastCoreSelectionSyncRef.current = null;
    // ★ S1：semantic ownership 与 session **同边界**销毁（原本未清 ⇒ 理论上的跨文档残留；
    //   插桩核验：reset 后认领 effect 因 session/doc 为空在门②早退，ref 虽失生效路径，
    //   仍按契约显式置 null，杜绝「旧宿主 id 漂移进新文档」的任何可能）。
    coreOwnedSegmentIdRef.current = null;
    noteCoreSessionChange("session-generation");
    // F3B-6.17-3C-6B1.1：同时释放「编辑前」快照
    coreImportSnapshotRef.current = null;
    // F3B-6.28 · D 第一阶段：位移清除计划同边界销毁（否则旧文档的行会被误清除）
    unitDisplacedClearRef.current = new Map();
    // ★★ 2026-10-19（多快照）：提交层显示快照同边界销毁 —— 旧文档的 unitId/appliedIndex
    //   对新文档无意义；虽然 appliedCount 门控通常已兜住（新 session appliedCount=0），
    //   显式清空杜绝任何跨文档残留（与 unitDisplacedClearRef 同一生命周期语义）。
    setCommittedUnitOverlays({});
    // ★ 2026-10-22：cell 单位提交行的显示修复标记同边界销毁（旧文档的 lineId 对新文档无意义）
    setCellCommittedSpans(new Map());
    // ★ 2026-10-24：cell 编辑台账同边界销毁（lineId/cellIndex/paragraphId 对新文档无意义；
    //   跨文档残留会让台账假设在坐标上「碰巧」通过 ⇒ 静默错格）
    cellEditLedgerRef.current.clear();
    coreLifecycleRef.current!.signalNewDocument();
    // F3B-6.17-3C-0.5：新 generation ⇒ export ownership 复位 core（Core-first）
    exportOwnershipRef.current = "core";
    // F3B-6.17-3C-10C.3B-0：同时复位 undo/redo 路由记账（否则会撤销**旧文档**的 Core entry）
    lastMutationOwnerRef.current = null;
    lastUndoRedoOwnerRef.current = null;
    editableDocumentRef.current = null;
    // F3B-6.12：Sidecar 销毁边界
    bindingSidecarRef.current = null;
    // STEP-2c-C2-A-Impl：OCR export bounds 销毁边界（**必须与 Sidecar 同一边界**，
    // 否则 PDF A 的 ocr_<hash> 会泄漏到 PDF B ⇒ stale lookup / 错误 mask）。
    ocrExportBoundsRegistry.clear();
    // ★ F3B-6.27 实现 checkpoint：换文档 ⇒ SegmentRangeLedger 同边界销毁
    //   （与 Sidecar 同生命周期边界；Sidecar 是 import-time immutable，ledger 可变但同样随文档失效）
    segmentRangeLedgerRef.current = null;
    segmentRangeParagraphRef.current = null;
    // ★ Step 3：换文档 / generation 重置 ⇒ fence 与 lastMutation 必须一起清。
    //   漏掉 fence 会让新文档沿用旧 Core version ⇒ 误判 stale 或漏判。
    segmentRangeFenceRef.current = null;
    segmentRangeLastMutationRef.current = "not-attempted";
    // ★ F3B-6.27：换文档 ⇒ 提交收口上下文必须失效（否则新文档可能读到旧 range）。
    //   与 ledger 同生命周期边界；`enabled` 不变，故必须**显式**清空。
    setCoreInputVisualState({ segmentCommitContext: null });
    // F3B-6.24-B2：lineId→paragraphId 加速表销毁边界
    lineIdParagraphMapRef.current.clear();
    // ★ 空文本缺陷修复（SPEC v2.1 N2/W2）：identity ledger 销毁边界（与 Sidecar 同一边界；
    //   generation 由下一次 sidecar 构建时递增 ⇒ 旧域条目即使残留也会被域校验拒绝）。
    unitIdentityLedgerRef.current = null;
    // 01H（H1）：换文档 / generation ⇒ 拆分事务证据与 applied 事务 id 一并失效
    lastSplitMutationRef.current = null;
    appliedTransactionIdRef.current = null;
    // F3B-6.27-H2：换文档 ⇒ **编辑目标身份**必须失效（否则新文档会沿用旧段落 id）。
    editingTargetRef.current = null;
    // B2-1/2/3：换文档 ⇒ docBlocks 写世代递增，所有挂起的旧世代 writer（页面页号映射 /
    // 拖拽几何 / 旧 OCR 直写）在写盘时若发现世代已变 ⇒ 拒绝写入，避免旧映射污染新文档。
    bumpDocBlocksGeneration();
  }, [noteCoreSessionChange]);
  /**
   * F3B-6.21-E：本次 composition 的**起点 DOM offset**（`compositionstart` 时记录）。
   * 供 `compositionend` 的 D6 对账使用：把 DOM caret 放回「起点 + 提交文本长度」，
   * 使后续 beforeinput 的播种仍取到**逻辑正确**的 offset。
   */
  const lastCompositionStartOffsetRef = useRef<number | null>(null);

  // ══4B-4D-1 · Composition Guard ══════════════════════════════════════════
  //
  //  ★ 问题（4B-4B-1 实测）：IME composition 期间浏览器会往 surface 里插 composition
  //    文本；A′ effect 随即看到 `textContent !== unitAuthoritativeText` ⇒ 执行
  //    `scope.textContent = ...` ⇒**该赋值会清除全部子节点**，包括 `<br>`。
  //    实测 brCount 3 → 0 ⇒ Core partition 的视觉断点全部丢失。
  //
  //  ★ 职责边界（本次只做这一件）：
  //    composition **active 期间，A′ 不得重写 unit surface 的 DOM**。
  //    composition 期间 DOM 归浏览器所有；`compositionend` 之后由既有逻辑统一对账。
  //
  //  ★ 为什么用本地 ref 而不是 `compositionStateOf(session).active`：
  //    后者读 Core adapter 状态，存在与 DOM 事件不同步的窗口；本 ref 在**事件第一行**
  //    同步置位（先于所有 early return），保证「浏览器已开始/结束组合」与「A′ 的判断」同刻。
  //
  //  ★ 只作用于 **unit 面**：单段面 A′ 行为**逐字节不变**（不扩大回归面）。
  const compositionActiveRef = useRef(false);

  /**
   * **段内 DOM offset 解析（单一实现）**。
   *
   * 返回 `null` ⇒ DOM selection 不在该段内（调用方**不得**猜、不得认领）。
   * ★ R2：`EditableTextNode` 的 `[isEditing]` effect **先于**本组件 effect 执行，
   *   已 `focus()` + `caretRangeFromPoint` 落位 ⇒ 此处**同一次 commit 内同步可读**，
   *   无竞态、无需 rAF / retry。
   */
  const computeSegmentDomOffset = useCallback(
    (segmentId: string, target?: HTMLElement | null): number | null => {
      try {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        // 生命周期路径不传 target：按 data-segment-id 定位段元素
        const scope =
          target ??
          Array.from(document.querySelectorAll<HTMLElement>("[data-segment-id]")).find(
            (n) => n.getAttribute("data-segment-id") === segmentId
          ) ??
          null;
        if (!scope || !scope.contains(range.startContainer)) return null;
        const pre = range.cloneRange();
        pre.selectNodeContents(scope);
        pre.setEnd(range.startContainer, range.startOffset);
        return pre.toString().length;
      } catch {
        return null;
      }
    },
    []
  );

  /**
   * **段内 DOM 非折叠选区 → UTF-16 半开区间 [start, end) 的单一解析**（F3B-6.21-H1-B）。
   *
   * 返回 `null` ⇒ DOM selection 不在该段内（调用方**不得**猜、不得认领）。
   * 与 `computeSegmentDomOffset` 同源：用 `window.getSelection()` 的 `Range` 相对段 `scope`
   * 的 `toString().length` 取 **UTF-16** 偏移（与 Core 的 offset 口径一致；
   * surrogate pair 不会被拆成半宽）。
   * 折叠选区（`start === end`）也返回（调用方据此回退到 caret 路径），
   * 但**不**在本函数内做 range/caret 区分 —— 那是 `coreCaretOptionsFor` 的职责。
   */
  const computeSegmentDomRange = useCallback(
    (segmentId: string, target?: HTMLElement | null): { start: number; end: number } | null => {
      try {
        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        const scope =
          target ??
          Array.from(document.querySelectorAll<HTMLElement>("[data-segment-id]")).find(
            (n) => n.getAttribute("data-segment-id") === segmentId
          ) ??
          null;
        if (
          !scope ||
          !scope.contains(range.startContainer) ||
          !scope.contains(range.endContainer)
        ) {
          return null;
        }
        const preStart = range.cloneRange();
        preStart.selectNodeContents(scope);
        preStart.setEnd(range.startContainer, range.startOffset);
        const start = preStart.toString().length;
        const preEnd = range.cloneRange();
        preEnd.selectNodeContents(scope);
        preEnd.setEnd(range.endContainer, range.endOffset);
        const end = preEnd.toString().length;
        return { start, end };
      } catch {
        return null;
      }
    },
    []
  );

  /**
   * 段内 DOM offset → Core caret 的**单一播种入口**（原内联于 `onBeforeInput`）。
   *
   * 身份优先（C2 契约）：canonical `(blockId, lineId)` + offset ⇒ `coreCaretForBinding`；
   * **仅当** segment 缺 provenance 时回退 `coreCaretForSegment`（兼容回退，禁止当 primary）。
   *
   * ⚠️ 纯函数式：只**计算** options，不写 session —— 由调用方决定「写入 session」（生命周期播种）
   *    还是「直接交给 `dispatchBeforeInput`」（输入路径），避免两套 caret 状态。
   * 返回 `null` ⇒ 定位失败 ⇒ 调用方**不得认领**、不得猜。
   */
  /** 行的完整 glyph 序列（Binding 原语推导段落级偏移所需；与 `getGlyphs` 同口径）。 */
  function lineGlyphsFor(blockId: string, lineId: string) {
    const doc = editableDocumentRef.current;
    if (!doc) return null;
    for (const page of doc.pages ?? [])
      for (const block of page.blocks ?? []) {
        if (block.id !== blockId) continue;
        for (const line of block.lines ?? [])
          if (line.id === lineId) return line.glyphs ?? null;
      }
    return null;
  }

  /**
   * ★ IB-2-F（F2）：segment 在 paragraph 内的 UTF-16 起点 base。
   *
   * **权威来源 = Binding 原语 `resolveSegmentParagraphRange`** —— 它从**行 glyph
   * 序列**推导段落级偏移，因此天然包含 segmenter 在段之间注入的**分隔空格**。
   *
   * ⚠️ 为什么不能自行累加 `segment.text.length`（旧 IB-2-B 行为）：
   *   段间分隔空格**不属于任何 segment**（实测 fixture：行 glyph 序列 30 个，
   *   A=[0,20)、分隔空格=glyph[20]、B=[21,30)，而 A.text/B.text 都不含该空格）
   *   ⇒ 累加会漏掉它 ⇒ 非首段 base 偏小 ⇒ 插入字符落到错误位置
   *   （实测：B 末输入 X ⇒ `idade; 4X1`，应为 `idade; 41X`）。
   *
   * fail-closed：原语不可解析（缺 provenance / 无行 glyph / 无 run 覆盖该 glyph 区间
   * —— Core 编辑后 run 的 glyph 索引会被 strip）⇒ 退回既有 text 累加，
   * **保持既有行为**，绝不静默改用 0，也绝不猜 separator。
   */
  function segmentParagraphBaseUtf16(
    segments: ReadonlyArray<{
      id: string;
      text?: string;
      source?: { blockId?: string; lineId?: string; startGlyphIndex?: number; endGlyphIndex?: number } | null;
    }>,
    segmentId: string,
    /** Core document（可选）。缺失 ⇒ 无法走 Binding 原语，退回 text 累加（保持既有行为）。 */
    document?: Parameters<typeof resolveSegmentParagraphRange>[0] | null
  ): number {
    const self = segments.find((s) => s.id === segmentId);
    const src = self?.source ?? null;
    if (document && src?.blockId && src.lineId) {
      const glyphs = lineGlyphsFor(src.blockId, src.lineId);
      if (glyphs) {
        const range = resolveSegmentParagraphRange(document, { source: src }, glyphs);
        // ★ 权威：含段间分隔空格的段落级起点
        if (range) return range.segmentStartUtf16;
      }
    }
    // 回退：既有 text 累加（原 IB-2-B 行为，仅当 Binding 原语不可解析时）
    if (!self?.source?.lineId) return 0;
    const lineId = self.source.lineId;
    let base = 0;
    for (const s of segments) {
      if (s.id === segmentId) break;
      if (s.source?.lineId === lineId) base += (s.text ?? "").length;
    }
    return base;
  }

  const coreCaretOptionsFor = useCallback(
    (
      session: CoreInputSession,
      segmentId: string,
      target?: HTMLElement | null
    ): ReturnType<typeof coreCaretForSegment> => {
      const segment = (segmentsRef.current ?? []).find((s) => s.id === segmentId);
      if (!segment) return null;
      const segBinding = segment.source ?? null;
      const document = session.history.state.document;

      // ★ IB-2-F6：paragraphId **只**来自当前可信的 Core session caret
      //   （表达「正在编辑的是哪一个 paragraph」）。
      //   ⚠️ 绝不可由 `segment.source.blockId` 猜 paragraphId —— 硬边界：不猜。
      //   无可信 paragraphId ⇒ 走下方既有路径（不认领新路径）。
      const state = session.history.state;
      const caretPos = state.caret?.position ?? state.selection?.range?.focus ?? null;

      // ★ 错行修复：caret 的 paragraphId **只有在该段落确实承载当前 segment 的行时**才可信
      //   （首次交互前 session caret 停在第 0 段，与用户点击的 segment 无关 ⇒ 会静默写错行）。
      //   判据与实测证据见 `ownedParagraphIdForBinding`。
      //
      // ★ 01H（H1）：`ownedParagraphIdForBinding` 失败时，若当前 caret 指向的段落
      //   正是**上一次已提交拆分事务确定性新建**的段落，则沿用该段落身份 ——
      //   否则旧回退会按 `lineId` 把 caret 重新播种回原段落（实测：输入落到原段落开头）。
      //   证据来自事务本身（after\before 段落 id 差集），并逐条校验「与当前状态匹配」；
      //   同 textBox 只作必要条件，不单独构成充分证明。
      // ★ F3B-6.27-H2：判定失败（拆分证据已过期 —— H1 的证据是**单发**的，
      //   后续任何 mutation 都会让 `appliedTransactionId` 变化 ⇒ 证据失效）时，
      //   改由**编辑目标身份**维持（maintain）。这是 T2「第 2 个及之后的 chunk 回落到
      //   原段落」的根因：证据失效 ⇒ 回退按 lineId 解析 ⇒ 输入又落回旧段落开头。
      //
      //   ⚠️ maintain **不**取代 establish：身份的合法性仍来自建立那一刻的外部证据
      //   （owned 归属 / 拆分事务），此处只做一致性与存在性校验；失效 ⇒ 回退既有路径。
      const paragraphId =
        resolveEditingCaretParagraphId({
          document,
          caretPosition: caretPos,
          lineId: segBinding?.lineId,
          mutation: lastSplitMutationRef.current,
          appliedCount: session.history.appliedCount,
          appliedTransactionId: appliedTransactionIdRef.current,
        }) ??
        (() => {
          const maintain = resolveEditingTargetMaintain({
            target: editingTargetRef.current,
            segmentId,
            document,
            caretParagraphId: caretPos?.paragraphId ?? null,
            currentGeneration: document.version,
          });
          return maintain.ok ? maintain.paragraphId : null;
        })();

      // ★ IB-2-F6：base 只由「行 glyph 序列 + segment.source glyph 区间」推导，
      //   **不依赖 run** ⇒ A 段编辑后 run 的 glyph 索引被 strip 也依然可解析。
      const lineGlyphs =
        segBinding?.blockId && segBinding.lineId
          ? lineGlyphsFor(segBinding.blockId, segBinding.lineId)
          : null;
      const glyphBase = lineGlyphs ? resolveSegmentParagraphBaseUtf16(segBinding, lineGlyphs) : null;

      // ★ IB-2-F6：import 期 base 只对应「未编辑」的段落。若前序 segment 已被编辑，
      //   段落文本长度变化 ⇒ 本 segment 的真实起点平移 ⇒ 必须用**当前段落文本**校正。
      //   优先级：当前段落文本校正（唯一精确匹配） > import 期 glyph base。
      const paragraphText = paragraphId ? paragraphTextOf(document, paragraphId) : null;
      const refinedBase = refineSegmentBaseByParagraphText(paragraphText, segment.text ?? "");
      const paragraphBase = refinedBase ?? (glyphBase ?? null);

      // 回退 base（既有行为）：Binding 原语不可解析时
      const segBase = segmentParagraphBaseUtf16(segmentsRef.current ?? [], segmentId, document);
      // ★ 新路径可用判据：paragraphId 可信 且 base 可解析
      const useParagraphPath = paragraphId !== null && paragraphBase !== null;

      // ★★ F3B-6.27-P0（用户裁决）：regime 的唯一 authority = **已发生的事实**。
      //
      //   原实现按「当次 DOM 文本 === Core 段落文本」判定（STEP6），但：
      //     ① 它需要 `target`；而**真实的 DOM→Core 播种站点不传** `target`
      //        ⇒ `domTextNow` 恒为 null ⇒ 恒走「base 照加」回退
      //     ② 于是从第二次按键起，每次都比 Core 落后一个 base
      //        ⇒ 实测连续输入 "ABCDE" 得 "BCDE以补A"（回退量恰为 base=3）。
      //
      //   原则：**DOM 内容是结果，不是 regime identity；
      //   「系统已经确认进入哪种 regime」才是 identity。**
      //   `wholeParagraphSurfaceRef` 由 A′ 在**真正写入整段**的那一刻登记、退出编辑时撤销。
      const surfaceIsWholeParagraph = wholeParagraphSurfaceRef.current === segmentId;
      const surfaceBaseUtf16 = surfaceIsWholeParagraph
        ? 0
        : rangeBaseOf(paragraphId, segmentId, paragraphBase as number);

      // ★ F3B-6.21-H1-B：先判 DOM 是否为**非折叠**选区 ⇒ 走 range 播种路径。
      //   约束 #1：selection 只来自 Core session —— 本函数只是把 DOM range **播种**进 session；
      //   command 解析（`resolveTextStyleToggle`）绝不读 DOM，只读已同步的 Core selection。
      const domRange = computeSegmentDomRange(segmentId, target);
      if (domRange && domRange.end > domRange.start) {
        seedDivergenceRef.current = null; // range 路径由 coreRangeForSegmentParagraph 自行判定
        // ★ F3B-6.27 实现 checkpoint：base 统一取自 ownership（无则用既有 base）
        // ★ STEP6：regime B（DOM ≡ 整段）下 base 不适用 ⇒ 统一走 surfaceBaseUtf16
        const rangeBase = surfaceBaseUtf16;
        if (useParagraphPath) {
          // ★ F3B-6.27-G9：DOM 文本可能是**陈旧**的 segment.text（Core 编辑后不回写），
          //   而 Core 段落可能已更短 ⇒ 段落相对 offset 会越界 ⇒ fail-closed ⇒
          //   Core caret 不更新（用户「点了没反应 / 光标定位不到」）。
          //   段落末之后不存在字符 ⇒ 钳到段末是**确定映射**，不是猜测。
          const lo = clampOffsetToParagraph({
            document,
            paragraphId: paragraphId as string,
            offsetUtf16: rangeBase + domRange.start,
          });
          const hi = clampOffsetToParagraph({
            document,
            paragraphId: paragraphId as string,
            offsetUtf16: rangeBase + domRange.end,
          });
          if (lo !== null && hi !== null && hi > lo) {
            const opts = coreRangeForSegmentParagraph(document, paragraphId as string, lo, hi);
            if (opts) return opts; // 新路径成功 ⇒ 不依赖唯一 run
          }
          // 选区在陈旧区域完全塌缩到段末 ⇒ 退 caret 路径（下方统一处理）
        }
        if (segBinding?.blockId && segBinding?.lineId) {
          return coreRangeForBinding(
            session.history.state.document,
            { blockId: segBinding.blockId, lineId: segBinding.lineId },
            domRange.start,
            domRange.end,
            segBase
          );
        }
        // 段缺 provenance ⇒ range 无 identity，**不得**造 ⇒ 回退 null（命令解析会 fail-closed）
        return null;
      }
      // 折叠 ⇒ 既有 caret 路径（DOM selection 不可读时**段末**兜底，保持既有行为）
      let domOffset = computeSegmentDomOffset(segmentId, target) ?? segment.text.length;
      // ★ F3B-6.27-CARET → **875cf63 后已失效（保留为惰性兜底）**：
      //   这段是为「DOM 陈旧」时代写的：beforeinput 被 preventDefault ⇒ DOM 文本/光标都不被
      //   浏览器更新 ⇒ 第 2、3…个字符用同一个陈旧偏移插入 ⇒ `XY` → `YX`。
      //   **875cf63 的 A′ 同步已让 DOM 文本与 DOM caret 都跟随 Core**（实测 `domLen` 每次 +1），
      //   `segment.text` 也随之新鲜 ⇒ 「caret == 陈旧文本长度」这个前提**实测不再成立**
      //   ⇒ 本映射现在是**惰性的**（条件不满足 ⇒ 原样返回 domOffset）。
      //   真正修好倒序的是：Core 提交后**无条件**把 DOM caret 对账到 Core caret
      //   （见下方 `reconcileDomCaretFromCore`，此前被一个「只在 Core 变短时对账」的守卫
      //   挡住，导致 domCaret 恒为 29、每次都往同一偏移插入 → 实测 DCBA / 22 字全逆序）。
      //   纯函数与单测保留：一旦出现真正的陈旧 DOM（无 A′ 的路径）它仍然有效。
      //   ⚠️ 仍然刻意**不改** DOM 文本、**不**回写 `segment.text`：那会破坏
      //   D6 的 blur 去重契约与 6.4B「Core 为唯一真值、不回写 legacy」。
      domOffset = mapStaleAppendCaretOffset({
        domOffset,
        staleText: segment.text,
        coreText: paragraphText,
      });
      if (useParagraphPath) {
        // ★ F3B-6.27-G9：同上，越界钳到段末（点击落在陈旧区域也能定位到 Core 真实末尾）
        const caretBase = surfaceBaseUtf16;
        const clamped = clampOffsetToParagraph({
          document,
          paragraphId: paragraphId as string,
          // ★ F3B-6.27 实现 checkpoint：base 统一取自 ownership（避免 double-base）
          offsetUtf16: caretBase + domOffset,
        });
        if (clamped !== null) {
          const opts = coreCaretForSegmentParagraph(document, paragraphId as string, clamped);
          if (opts) {
            // ★ F3B-6.27-G9：若段落相对 offset 被**钳制**（陈旧 DOM 偏移越界，例如 Core
            //   文本已被替换得更短），DOM caret 会落在 Core 不存在的区域 ⇒ 记录「应落到的
            //   segment-local offset」，由 `onSelectionChange` 写回 DOM，保持不变量
            //   「Core caret ⇄ DOM caret 一致」⇒ 点击可正确定位。
            // ★★ F3B-6.27-P0：`local` 必须与 `caretBase` **同 regime**。
            //   regime B（面承载整段，DOM offset ≡ Core paragraph offset）下**不做
            //   base 换算**：否则 `paragraphOffsetToDomOffset` 会按 ownership 再减一次
            //   base（实测 3），把 `local` 算成 30 而 `domOffset` 是 33 ⇒ 被误判成
            //   「陈旧 DOM divergence」⇒ onSelectionChange 把 30 写回 DOM ⇒ 下一轮
            //   再减 3（实测阶梯 30→27→24→…→0）⇒ caret 最终被拉到段首，
            //   之后每个字符都插到段首（实测 ABCDE → "EDCB…以补A"）。
            const local = surfaceIsWholeParagraph
              ? clamped
              : paragraphOffsetToDomOffset(
                  segmentRangeOwnershipOf(paragraphId),
                  segmentId,
                  clamped,
                  caretBase
                );
            seedDivergenceRef.current =
              local === domOffset ? null : { segmentId, localOffsetUtf16: local };
            return opts; // ★ case 10：不再因 multi-run 失败而沿用陈旧 caret
          }
        }
      }
      return segBinding?.blockId && segBinding?.lineId
        ? coreCaretForBinding(
            session.history.state.document,
            { blockId: segBinding.blockId, lineId: segBinding.lineId },
            domOffset,
            segBase
          )
        : coreCaretForSegment(session, segment.text, domOffset);
    },
    [computeSegmentDomOffset, computeSegmentDomRange, rangeBaseOf, segmentRangeOwnershipOf]
  );
  /**
   * F3B-6.19-C（C3）：Core selection/caret **presentation** 的**派生**快照（唯一权威形态）。
   *
   * ⚠️ 与旧 `coreGeometryRef` 的本质区别（B3 实测缺陷）：
   *   旧 ref 由 `beforeinput` 成功分支**单点**写入，Toolbar / Capability / Segment /
   *   undo-redo 的 Core mutation **都不写它** ⇒ 那些 mutation 之后 presentation 仍被视为
   *   "Core authoritative"，而它读到的是 `null` 或**陈旧几何** ⇒ legacy 选区高亮被静默吞掉。
   *
   *   现在：由 `corePresentationFor(session)` 在**唯一信号** `coreInputTick`
   *   （所有 Core mutation 都会 bump）上**派生**重算 ⇒ **零 imperative 写点**
   *   （不再、也不允许在任何 mutation 点写几何 —— 单一刷新路径）。
   */
  const corePresentation = useMemo<CorePresentationState | null>(() => {
    const session = coreInputSessionRef.current;
    if (!session) return null;
    const derived = corePresentationFor(session);
    // F3B-6.21-A-Impl：注入**当前** revision 令牌（= 本次 memo 计算时刻的 revision）。
    //   令牌只在「memo 没重算但 revision 变了」时失配 ⇒ 由 isCorePresentationCurrent
    //   fail-closed（而不是静默复用 stale 几何）。
    //   ⚠️ `coreInputTick` / `editingSegmentId` 仍保留为**兜底触发**（可增量安全落地：
    //   即使某个 mutation 点尚未接入单一 helper，也不会误判失效）。
    return derived ? { ...derived, revision: coreSessionRevision } : null;
  }, [coreSessionRevision, coreSessionGeneration, coreInputTick, editingSegmentId]);

  /**
   * F3B-6.19-C（C3）：presentation ownership 判据 —— 由**当前状态**决定，
   * **不是**「这个 session 历史上是否用过 Core input」。
   *
   *   ① Core 输入面**当前**拥有正在编辑的 segment
   *      （`coreOwnedSegmentIdRef` 在离开编辑态 / flag 关闭时被清空 ⇒ 非历史粘性）
   *   ② 已派生的几何**仍然对应当前** document revision + 当前 session caret/selection
   *      （`isCorePresentationCurrent`）
   *
   * 任一不成立 ⇒ **fail-closed**：不使用 Core 几何，回落到既有（legacy）展示来源。
   * ⚠️ ② 是**真**判据：若 document 变了却没有 bump `coreInputTick`（几何未重算），
   *    `useMemo` 会保留上一次的 `documentVersion` ⇒ 判据失败 ⇒ **绝不使用 stale geometry**。
   */
  const corePresentationActive =
    corePresentation !== null &&
    editingSegmentId !== null &&
    coreOwnedSegmentIdRef.current === editingSegmentId &&
    // ★ F3B-6.21-A-Impl：令牌必须匹配**当前** revision（失配 ⇒ fail-closed）
    isCorePresentationCurrent(corePresentation, coreInputSessionRef.current, coreSessionRevision);

  // ══════════════════════════════════════════════════════════════════════
  // F3B-6.27-G5：Core → legacy `segments` 文本投影 —— **已停用（DISABLED）**
  //
  // ⚠️ 本处**刻意不接线**。原实现调用 `projectCoreTextOntoSegment`，已被移除，
  //    因为它会把工作区置于**已知劣化**状态。实测结论（gd-swim-2026.pdf）：
  //
  //   · scope correctness   ✅ 27/27（S1–S5 未编辑段保护契约全过）
  //   · 12 mask 误遮        ✅ 已修（收窄到 editingSegmentId 后 12 → 1）
  //   · Core mutation       ✅ `type` 路径确认 CORE-CHANGED=1
  //   · text ownership      ❌ **未解决** ⇒ 投影后被编辑 segment 的 text 变成 **""**
  //
  // 根因（真实结构，勿再假设 1:1）：
  //   1 视觉行 **可被切成多个 Legacy segment**（实测 l13/l16/l20 各 3 个），
  //   而 `1 lineId → 1 Core paragraph` 成立 ⇒ 1 个 Core paragraph 对应 N 个 segment
  //   ⇒ 无法从 paragraph 文本得到某一个 segment 的文本。
  //
  // 复接线的前置条件：Core 必须在**编辑语义层**输出稳定的
  //   `segmentId → currentText`（per-segment text ownership），
  //   而不是让 PDFEditor 从 paragraph 推导（已用源码守卫禁止 slice / glyphIndex）。
  //   届时可直接复用 `core-segment-text-projection.ts` 的 presentation scope 规则。
  // ══════════════════════════════════════════════════════════════════════

  // ── F3B-6.21-A-Impl：DOM visual handoff（★ R1 fail-safe 可见性不变量）──────

  // ── F3B-6.21-A-Impl：DOM visual handoff（★ R1 fail-safe 可见性不变量）──────
  //   发布给 EditableTextNode 的 `ownedSegmentId` **只代表 visual suppression ownership**，
  //   门槛是 `corePresentationActive`（几何可用），**不是** semantic ownership。
  //   ⇒ 几何不可用时 DOM caret 不会被隐藏（无 zero-caret window）。
  useEffect(() => {
    setCoreInputVisualState({
      enabled: coreInputEnabled,
      ownedSegmentId: corePresentationActive ? editingSegmentId : null,
    });
  }, [coreInputEnabled, corePresentationActive, editingSegmentId]);

  // ── F3B-6.21-A-Impl：Ownership Lifecycle（edit-enter / segment-switch / blur）──
  //
  //   把 Core 认领从 **input event** 迁移到 **edit lifecycle**（消 G4 ⇒ 消灭 S2/S3）：
  //     · editingSegmentId 变为非 null（进入 / 切换）⇒ 建/复用 session → 播种 caret → 认领
  //     · 变为 null（blur / 退出 / flag 关）⇒ 释放 semantic ownership + invalidate revision
  //   revision 必须先于 ownership 落地：否则认领不触发几何重算 ⇒ 仍 fail-closed。
  useEffect(() => {
    if (!coreInputEnabled || editingSegmentId === null) {
      // 视觉让位由上面的 handoff effect 统一撤销（此处只释放 semantic ownership）
      coreOwnedSegmentIdRef.current = null;
      lastCoreSelectionSyncRef.current = null;
      noteCoreSessionChange("invalidate");
      return;
    }
    // ① 建 / 复用 Core session（不再等首次输入）
    let session = coreInputSessionRef.current;
    if (!session) {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return; // 尚无 Core 文档 ⇒ 不认领（fail-closed）
      const created = createCoreInputSessionFromDocument(coreDoc);
      if (!created || !created.ok || !created.session) return;
      coreInputSessionRef.current = session = created.session;
    }
    // ② 播种 Core caret（★ R2：DOM selection 已就绪 —— 见 computeSegmentDomOffset 注释）
    //    ⚠️ 必须要求 DOM selection **真的可读**：不可读时不得猜（否则会把 caret 播到段末，
    //       制造「先播错、再靠 selectionchange 修」的抖动 —— 该抖动已被明确否决）。
    const seededOffset = computeSegmentDomOffset(editingSegmentId);
    if (seededOffset === null) return; // 不可读 ⇒ 不认领（保持非 Core 呈现）
    // ③ 语义认领（**semantic** ownership）—— ★ S1 候选 (i)：与 caret 播种**解耦**。
    //    认领门 = ① flag ∧ editingSegmentId ∧ session（上方已过）+ ② R2 DOM offset 可读
    //    （上方已过）；**不**包含 caret options —— 不是无条件认领。
    //    根因（s1j/s1k 插桩实证）：2A 宿主重定向 tick 上，session 与 DOM 选区均已有效，
    //    唯独 `coreCaretOptionsFor` 返回 null ⇒ 旧实现在此早退 ⇒ 认领停留在**旧宿主** ⇒
    //    `owned ≠ editingSegmentId` ⇒ `corePresentationActive=false` ⇒ 编辑面几何被发布为
    //    null ⇒ 面退回 legacy 单行盒并持续裁剪多行内容（S1 主缺陷）。
    //    caret 播种缺失只表示「Core caret 本次未同步」：selectionchange 同步通道
    //    （`owned===editingSegmentId` 门控）在认领生效后即激活，由后续选区事件补播。
    coreOwnedSegmentIdRef.current = editingSegmentId;
    // ④ caret 播种 —— fail-closed + 既有自愈通道，**不再**绑架认领。
    //    ★ CARET-LANDING (c)：unit 面存在 ⇒ 由 **unit 坐标权威**播种
    //      （DOM offset → paragraph + localOffset），不再沿用「上一次 Core caret 的
    //      paragraphId」——后者会让 caret 永久留在被点击行的段落（实测 para_46）。
    //      单段 / legacy（无 unit 面）⇒ 完全走既有 `coreCaretOptionsFor`，语义不变。
    const unitNow = unitSurfaceRef.current;
    let caretOptions: ReturnType<typeof coreCaretOptionsFor> = null;
    if (unitNow) {
      const seeded = seedCaretOptionsForUnit({
        unit: unitNow.unit,
        document: documentOf(session),
        domOffset: seededOffset,
      });
      if (seeded.ok) {
        caretOptions = seeded.options;
      } else {
        // 映射失败 ⇒ fail-closed（不猜段落、不回退既有解析）+ 有界诊断
        noteCaretMappingFailure("seed-unit", seeded.reason, { domOffset: seededOffset });
      }
    } else {
      caretOptions = coreCaretOptionsFor(session, editingSegmentId);
    }
    if (caretOptions) {
      session.history.updateSelection({ selection: caretOptions.selection, caret: caretOptions.caret });
      // 记录幂等键：紧接着的 selectionchange（若同 offset）不得再写一次
      lastCoreSelectionSyncRef.current = `${editingSegmentId}:${seededOffset}`;
    } else {
      // 播种失败 ⇒ 无「本次已同步」事实可去重 ⇒ 清幂等键，放行 selectionchange 自愈通道
      lastCoreSelectionSyncRef.current = null;
    }
    // 常驻通知：成功路径与旧实现**同序同频**（updateSelection 先于 notify）；
    // 新增通知仅发生在旧实现早退的播种失败路径（即修复目标）。
    noteCoreSessionChange("ownership-transfer");
  }, [
    coreInputEnabled,
    editingSegmentId,
    noteCoreSessionChange,
    coreCaretOptionsFor,
    computeSegmentDomOffset,
  ]);

  useEffect(() => {
    if (!coreInputEnabled) return;
    const root = wrapperRef.current;
    if (!root) return;

    const onBeforeInput = (event: Event) => {
      const native = event as InputEvent;
      const target = native.target as HTMLElement | null;
      const segmentId =
        target?.closest?.("[data-segment-id]")?.getAttribute("data-segment-id") ?? null;
      // 只接管"正在编辑的那一段"；其余输入不属于 Core 路径
      if (!segmentId || segmentId !== editingSegmentId) return;

      // ── F3B-6.21-E（D3）：composition-owned 事件必须**显式让位** ──────────
      //   浏览器在**每次 compositionupdate** 都会派发 `beforeinput(insertCompositionText)`
      //   （实测 F3B-6.21-D1 Addendum D1.1），它承载浏览器自身的组合态 DOM 更新
      //   （实测**未被** preventDefault，D1.2）。
      //   ⇒ 它**不得**进入普通 `unsupported-input-type` → legacy 回退路径
      //     （否则 Core CompositionTracker 与 Legacy 形成两条语义路径），
      //     也**不得** preventDefault（会破坏 IME）。
      //   组合的唯一语义提交点在 `compositionend`（见 onCompositionEnd）。
      if (
        native.inputType === "insertCompositionText" ||
        native.inputType === "insertFromComposition"
      ) {
        return;
      }

      let session = coreInputSessionRef.current;
      if (!session) {
        // F3B-1：优先消费 import-time 已持久化的唯一 Core 文档（不重新 adapter legacy doc）。
        // 仅在持久化 Core 文档尚不可用（极早交互竞态）时，回退到旧 legacy 引导分支。
        const coreDoc = coreDocumentRef.current;
        const created = coreDoc
          ? createCoreInputSessionFromDocument(coreDoc)
          : (() => {
              const legacyDoc = editableDocumentRef.current;
              if (!legacyDoc) return null;
              return createCoreInputSession(legacyDoc);
            })();
        if (!created || !created.ok) {
          // 建不起来就**完全不拦截** → 本次输入留在 legacy 路径（不制造双真相）
          console.warn("[CORE-012C6] Core session 创建失败，本次输入交回 legacy：", created?.reason);
          return;
        }
        coreInputSessionRef.current = session = created.session;
        // F3B-6.21-A-Impl：此处**只**写 **semantic** ownership。
        //   视觉让位（DOM 文本/caret 变透明）由 handoff effect 统一发布，门槛是
        //   `corePresentationActive` ⇒ 绝不出现「DOM caret 被隐藏 ∧ 无 Core caret」窗口（R1）。
        coreOwnedSegmentIdRef.current = segmentId;
        noteCoreSessionChange("ownership-transfer");
        console.log("[CORE-012C6] Core input session 已建立（消费 import-time Core 文档 / 兼容 legacy 引导）", {
          textBoxId: session.textBoxId,
          ownedSegmentId: segmentId,
          fromPersistedCoreDoc: !!coreDoc,
          warnings: created.warnings,
        });
      }

      // F3B-6.21-A-Impl：播种逻辑抽为**单一入口** `coreCaretOptionsFor`
      // （与 edit-enter 生命周期共用；身份优先契约见该函数注释）
      const caretOptions = coreCaretOptionsFor(session, segmentId, target) ?? {};

      // ── F3B-6.21-F2：composition-active 期间**词删显式让位** ──────────────
      //   F1 §9 实测：`deleteWord*` **会**在组合活跃期间出现（位于 `insertCompositionText`
      //   之后），且会打断当前组合。若 Core 此时改文档，会与尚未提交的
      //   CompositionTracker（`startSelection` / `startCaret`）冲突 ⇒ **不认领**
      //   （不 preventDefault、不改 Core），交给浏览器原生处理；残留由 `compositionend`
      //   的 D6 对账统一收敛（与 E-C5-1 的 D3「组合事件显式让位」同一判据族）。
      //
      //   ⚠️ 判据**不能只**用 `native.isComposing`：F2 实测（CDP 合成组合）该标志为
      //   **false**，而 CompositionTracker 已 `active` ⇒ 必须同时看 Core 自己的组合状态。
      if (
        native.inputType === "deleteWordBackward" ||
        native.inputType === "deleteWordForward"
      ) {
        if (native.isComposing || compositionStateOf(session).active) return;
      }

      // ══════════════════════════════════════════════════════════════════
      // ★★ F3B-6.27 · P0-D0 **Slice 2** · unit route（EditingUnit mutation 接线）
      //
      // ── 为什么放在这里（结构性互斥，而非纪律）──────────────────────────
      //   上方已完成 IME（insertCompositionText / insertFromComposition）与词删的
      //   **显式让位**（F3B-6.21-E/D3、F2）；本块紧接在 `dispatchBeforeInput` 之前
      //   ⇒ unit route 与既有 Core route 在**同一个决策点**二选一，**结构上**保证
      //   「一次 beforeinput 不可能产生两次 mutation」（既有 `dispatchBeforeInput`
      //   内部已保证 core/legacy 互斥，此处把互斥扩展到第三条路径）。
      //   ⚠️ 因此 unit route 一旦进入，**绝不**下落（成功与失败都 return）。
      //
      // ── 失败策略（用户裁决：严格 fail-closed）────────────────────────
      //   adapter / plan / transaction / commit 任一失败 ⇒
      //     preventDefault() → 不改 DOM、不改 Core、不改 Legacy、不进 handleInLegacy。
      //   ★ 禁止「失败后把 unit 完整文本塞回单 segment」与「fallback 到单 paragraph
      //     __coreInput」—— 两者都会破坏 F2 建立的 ownership 边界。
      //   ★ 本阶段**不产生**任何 UX 提示（失败即「这次输入没有效果」）。
      //
      // ── 与既有路径的差异（刻意）──────────────────────────────────────
      //   · **不**使用 `coreCaretOptionsFor`（单 paragraph 口径，套 unit DOM 语义错误）
      //   · **不**调用 `markLineEdited`（审计已证 Core input 路径从不调用它）
      //   · **不**直接调 `markOwned`（由既有 `coreInputTick` effect 统一处理）
      // ══════════════════════════════════════════════════════════════════
      const unitSurfaceEl = target?.closest?.("[data-editing-unit-id]") as HTMLElement | null;
      if (unitSurfaceEl) {
        // ① DOM 选区 → UTF-16 offsets。
        //
        // ★★ 4B-4C（唯一改动）：从「单文本节点 + r.startOffset」改为「**Range 前缀长度**」。
        //
        //   改动前：要求 `childNodes.length === 1 && firstChild.nodeType === 3`，
        //           且 selection 必须落在该唯一子节点上，否则 fail-closed。
        //   改动后：用「ed 起点 → caret 的 Range 前缀文本长度」作为 UTF-16 offset。
        //
        //   为什么等价（实测依据，4B-4B-0 真实 Chromium 9/9 位置）：
        //     · **单文本节点**下 `pre.toString().length` 与 `r.startOffset` **逐位置相等** ⇒
        //       本次替换在现有生产形态下是**零行为变化**（不是"近似等价"）。
        //     · 多节点（未来 `<br>`）下同一口径同样成立，且 `Range.toString()`
        //       **忽略 `<br>`**（实测 diff 恒为 0，零补偿）。
        //
        //   为什么必须提前支持多节点：`<br>` 一旦注入，`childNodes.length > 1` ⇒
        //   旧门必然 fail-closed ⇒ unit route完全不可用（实测 `textLen` 不变）。
        //
        //   ⚠️ 口径前提（已在4B-4B-0 核实）：`Range.toString()` 对 `<br>` **零贡献**；
        //      若将来改用 `display:block` 元素分块，它会**额外产生 `\n`** ⇒ 该口径失效。
        //      4B-4D 的 `<br>` 生命周期契约必须保持这一前提。
        //
        //   ⚠️ 性能：`toString()` 每次构造前缀字符串（O(n)）。当前 unit 面为
        //      段落级（实测 160 字符）可接受；若未来出现超长段落需另评估。
        recordCellMonitor("unitTxnAttempt", "unit-route"); // ★ C 监测
        let selStart: number | null = null;
        let selEnd: number | null = null;
        try {
          const sel = typeof window !== "undefined" ? window.getSelection?.() ?? null : null;
          if (sel && sel.rangeCount > 0) {
            const r = sel.getRangeAt(0);
            // start：unit 面起点 → 选区起点
            const preStart = document.createRange();
            preStart.selectNodeContents(unitSurfaceEl);
            preStart.setEnd(r.startContainer, r.startOffset);
            selStart = preStart.toString().length;
            // end：unit 面起点 → 选区终点（Range 的 start/end 是**文档序**，与选择方向无关
            //      ⇒ 保证 selStart <= selEnd，折叠选区时两者相等）
            const preEnd = document.createRange();
            preEnd.selectNodeContents(unitSurfaceEl);
            preEnd.setEnd(r.endContainer, r.endOffset);
            selEnd = preEnd.toString().length;
          }
        } catch {
          selStart = null;
          selEnd = null;
        }
        const failClosed = (reason?: string): void => {
          // ★ 阻断 DOM 变更（否则浏览器原生编辑将成为第二真相）
          native.preventDefault();
          // ★ F5 失效规则：**没有提交 ⇒ 不允许留下待恢复的 caret**。
          //   否则下一次无关的 A′ 写入可能把一个已过期的 offset 恢复成真实光标。
          pendingUnitCaretRef.current = null;
          if (reason) recordCellMonitor("unitTxnFail", reason); // ★ C 监测
        };
        if (selStart === null || selEnd === null) return failClosed("selection-missing");
        const unitSurfaceNow = unitSurfaceRef.current;
        if (!unitSurfaceNow) return failClosed("surface-missing");

        // ② adapter：input intent → EditingUnit mutation intent
        const intentOutcome = toEditingUnitInputIntent({
          unitText: unitSurfaceNow.text,
          domStart: selStart,
          domEnd: selEnd,
          inputType: native.inputType,
          data: native.data,
        });
        if (!intentOutcome.ok) return failClosed(`adapter:${intentOutcome.reason}`);
        const intent = intentOutcome.intent;

        // ③ P0-D plan（separator 的 consume/preserve 语义由它唯一判定）
        const planOutcome = planUnitMutationMulti(
          unitSurfaceNow.unit,
          intent.unitStart,
          intent.unitEnd,
          intent.replacementText,
        );
        if (!planOutcome.ok) return failClosed(`plan:${planOutcome.reason}`);

        // ④ transaction（纯转换；Core preflight 抛错即失败）
        let built: ReturnType<typeof createUnitTransactionCommand>;
        try {
          built = createUnitTransactionCommand(planOutcome.plan);
        } catch {
          return failClosed("txn-build");
        }

        // ⑤ commit：**1 条 history entry**（包装器 Command 的全部价值）
        let committed = false;
        try {
          committed = session.history.commit(built.command).changed !== false;
        } catch {
          return failClosed("commit-error");
        }
        // ★ C 监测：commit no-op（0 Command 折叠 / 跨段格式等不占 undo 步的情形）
        if (!committed) recordCellMonitor("unitTxnFail", "commit-noop");
        if (!committed) return failClosed();

        // ⑥ 成功：先阻断 DOM，再记 Core 归属（顺序与既有 Core route 一致）
        native.preventDefault();
        noteCoreSessionChange("core-mutation");
        exportOwnershipRef.current = "core";
        markMutationOwner("core");
        // ★ C 监测：跨格写入迹象（防御性断言）——cell 锚在位时，事务必须落在锚的段落与起点上
        const anchorForSuspect = cellAnchorRef.current;
        if (anchorForSuspect) {
          const line0 = unitSurfaceNow.unit.lines[0];
          const pStart = typeof line0?.paragraphStartUtf16 === "number" ? line0.paragraphStartUtf16 : 0;
          const sameParagraph = line0?.paragraphId === anchorForSuspect.paragraphId;
          const sameStart = pStart === anchorForSuspect.pStartUtf16;
          if (!sameParagraph || !sameStart) {
            recordCellMonitor("cellWriteSuspect", sameParagraph ? "outside-interval" : "wrong-paragraph");
          }
        }

        // ══ F3B-6.28 · C2/C3：提交后受控渲染（__unitEditing gate；fail-open）══
        //   C2：全部成员行进 mask 管线（文本未变的成员行——l6——也必须盖旧字，
        //       否则 blur 后 canvas 原字回显 = 用户截图残留）。
        //   C3：A 流布局 → C1 scope → overlay 行快照（z>mask 显示层；undo 过头隐藏）。
        //   fail-open：渲染层任何失败不回滚事务（事务已提交，Core 状态权威）。
        //   ★ 2026-10-15：gate 契约随入口一同翻转——缺省 ON（`!== false`），
        //     显式 false = 回滚到 C2/C3 之前的渲染行为（与入口 gate 同一开关）。
        if (
          typeof window !== "undefined" &&
          (window as unknown as Record<string, unknown>).__unitEditing !== false
        ) {
          try {
            const cUnit = unitSurfaceNow.unit;
            const cBlockId = cUnit.blockId;
            // ── C3 ──
            const cDoc = documentOf(session) as never;
            const legacyDoc = editableDocumentRef.current as never;
            const legacyLineById = new Map<string, never>();
            // F3B-6.28 · D-3B-5：lineId → legacy 页码（0-based）。位移行的页面归属
            //   判定（跨页推挤未授权）与 successors 收集都以它为准；不可判定 ⇒ null。
            const legacyLinePageById = new Map<string, number>();
            (legacyDoc as never as { pages?: never[] }).pages?.forEach(
              (pg: never, pi: number) => {
                for (const b of (pg as never as { blocks?: never[] }).blocks ?? []) {
                  for (const l of (b as never as { lines?: never[] }).lines ?? []) {
                    const id = (l as never as { id: string }).id;
                    legacyLineById.set(id, l);
                    legacyLinePageById.set(id, pi);
                  }
                }
              },
            );
            // ★ 2026-10-24（用户缺陷「提交后遮盖下一行」· unit 路径层）：
            //   成员行身份解析增加**稳定锚点兜底**。既有口径（lineId 直查）在两种
            //   编辑后形态下必失败，C3 整体 fail-open 静默消失 ⇒ C2/reconciliation 的
            //   多行高 mask 裸露盖住下一行（实测复现：整段替换后 C3 从首次按键即
            //   抛「成员数据缺失」，提交层全程缺位）：
            //     ① **整段替换**：Core run 变成 generated ⇒ `run.source.lineId` 被
            //        剥离（P0-D2 实证）⇒ memberText 按 lineId 反查不到段落全文；
            //     ② **合成 lineId**：rebind（P0-E1）在 lineId 丢失时合成
            //        `syn:<paragraphId>` ⇒ legacy 行/页码按该 id 查不到。
            //   兜底锚点 = **paragraphId**（P0-D2 裁决的「唯一稳定锚点」）：
            //     · memberText：Core 段落按 `p.id === paragraphId` 直取全文；
            //     · legacy 行/页码：经 identity ledger **反向映射**
            //       （paragraphId → lineId；ledger 为 lineId → paragraphId，
            //        merge-write 累积 ⇒ 编辑前的健康映射在编辑后仍可用）。
            //   顺序：既有口径优先 ⇒ 当前可用的全部场景**逐字节不变**；兜底只在
            //   既有口径失败时生效（失败场景此前的结局是静默无提交层）。
            const ledgerReverse = ((): Map<string, string> | null => {
              const entries = unitIdentityLedgerRef.current?.entries;
              if (!entries || entries.size === 0) return null;
              const rev = new Map<string, string>();
              for (const [lineId, entry] of entries) {
                const pid = entry.paragraphId;
                if (!pid || !lineId) continue;
                const existing = rev.get(pid);
                // 同段落被多个 lineId 主张 ⇒ 反向不唯一 ⇒ 该段落不可解析（不猜）
                if (existing !== undefined) { rev.set(pid, ""); continue; }
                rev.set(pid, lineId);
              }
              return rev;
            })();
            const effectiveLineIdOf = (m: { lineId: string; paragraphId: string }): string => {
              if (legacyLineById.has(m.lineId)) return m.lineId;
              const viaLedger = m.paragraphId ? ledgerReverse?.get(m.paragraphId) : undefined;
              if (viaLedger && legacyLineById.has(viaLedger)) return viaLedger;
              return m.lineId;
            };
            // ★ 2026-10-24：**有效成员单位** —— 合成 lineId（`syn:<pid>`，rebind
            //   产物）解析回真实 legacy lineId 后的 unit。C3 全链（flow / scope /
            //   overlay sourceLineId / changedLineIds / 导出计划 / hide-style）
            //   统一消费它：DOM 的 span/mask 与 segment.source 带的都是**真实**
            //   lineId ⇒ 合成 id 会使 hide-style 失配（mask 裸露）、锚 segment
            //   查找失败、导出计划键落空。不可解析的成员保持原 id（行为不变）。
            const cUnitEff: typeof cUnit = {
              ...cUnit,
              lines: cUnit.lines.map((m) => ({ ...m, lineId: effectiveLineIdOf(m) })),
            };
            const lg = (id: string): any => legacyLineById.get(id);
            const memberText = (lineId: string, paragraphId: string): string | null => {
              for (const page of (cDoc as { pages?: never[] }).pages ?? []) {
                for (const obj of (page as { objects?: never[] }).objects ?? []) {
                  if ((obj as { type?: string }).type !== "text") continue;
                  for (const p of (obj as { paragraphs?: never[] }).paragraphs ?? []) {
                    for (const r of (p as { runs?: never[] }).runs ?? []) {
                      if ((r as { source?: { lineId?: string } }).source?.lineId === lineId) {
                        return getParagraphText(p as never);
                      }
                    }
                    // 稳定锚点兜底：整段替换后 run.source 被剥离 ⇒ 按段落 id 直取
                    if (paragraphId && (p as { id?: string }).id === paragraphId) {
                      return getParagraphText(p as never);
                    }
                  }
                }
              }
              return null;
            };
            // ── C2 ── 成员行 + **被推进行**都进 mask：被推进行的旧字在原位置
            //   必须被盖（其新位置由 C3 overlay 显示）——只 mask 成员行会导致
            //   l7 新旧两处同时显示（双重文字）。
            //   ★ 2026-10-24：按**有效 legacy lineId**（合成 id 经 ledger 反向
            //     解析）打 mask —— 合成 id 直查 legacy 必不命中 ⇒ 成员行裸奔。
            for (const m of cUnitEff.lines) markLineEdited(cBlockId, m.lineId);
            const flowLines: FlowLineInput[] = [];
            let coreConstraintWidth = 0;
            for (const m of cUnitEff.lines) {
              const text = memberText(m.lineId, m.paragraphId);
              const ll = lg(m.lineId);
              // ★ 2026-10-24：`text === ""` 是**合法状态**（整段替换后 plan 把全部
              //   文本归入首成员段落，其余成员成为空段落——P0-D2 实证形态）⇒ 空成员
              //   进 flow（0 个输出行 ⇒ scope 判 incomplete ⇒ 不进 clears/overlay ⇒
              //   其 C2 mask 保持可见盖旧字，无新文本可画）。只有 null（解析失败）
              //   才是成员数据缺失。
              if (text === null || !ll) throw new Error(`C3 成员数据缺失: ${m.lineId}`);
              // ★ 真实度量管道（A-Integration 同款）：layoutTextBox + createDiffedLineMetrics
              //   （原字符 PDF advance、新字符 measured）——与生产渲染链同源。
              //   glyph.bbox.width（≈19.1）≠ GlyphLayout.advance（≈24.1），用前者会把
              //   N 算成 2（实测教训）。
              const diffed = createDiffedLineMetrics(ll, text);
              const laid: any = layoutTextBox(cDoc, m.textBoxId, diffed.metrics);
              const para: any = laid?.layout?.paragraphs?.[0];
              const textLen: number = para?.textLength ?? [...text].length;
              const advances: number[] = new Array(textLen).fill(Number.NaN);
              for (const ln of para?.lines ?? []) {
                for (const run of ln.runs ?? []) {
                  for (const gl of run.glyphs ?? []) {
                    for (let k = 0; k < gl.length; k++) advances[gl.textIndex + k] = gl.advance;
                  }
                }
              }
              const cw: number = laid?.layout?.constraintBox?.width ?? 0;
              if (cw > 0) coreConstraintWidth = Math.max(coreConstraintWidth, cw);
              // ★ 2026-10-24（用户缺陷「追加文本使行数增加 ⇒ 提交层消失」）：
              //   编辑使段落变长触发 Core Layout **折行** ⇒ 标准排版把**行尾空白
              //   折叠**（不渲染 ⇒ 无 glyph）⇒ advances 残留 NaN ⇒ flow
              //   `invalid-advance` fail-closed ⇒ C3 提交层整体缺位（实测
              //   l6 textLen=67 covered=66 badAt=66 ch=" " laidLines=2）。
              //   语义：折叠空白 = 排版上不渲染 ⇒ advance = 0（行尾 collapsing
              //   语义，与浏览器 white-space:normal 一致）。**非空白缺口保持
              //   NaN** ⇒ 继续走 invalid-advance fail-closed（真度量缺失不掩盖
              //   —— A-Integration I11 纪律不变）。
              for (let k = 0; k < advances.length; k++) {
                if (!Number.isFinite(advances[k]!) && /\s/.test(text[k] ?? "")) {
                  advances[k] = 0;
                }
              }
              flowLines.push({
                lineId: m.lineId, textBoxId: m.textBoxId, paragraphId: m.paragraphId, text, advances,
                x: ll.bbox?.x ?? 0, top: ll.bbox?.y ?? 0, height: ll.bbox?.height ?? 21.46,
                width: cw || ll.bbox?.width || 0,
              });
            }
            const lastMemberTop = Math.max(...cUnitEff.lines.map((m: never) => lg((m as { lineId: string }).lineId)?.bbox?.y ?? 0));
            const successors: FlowSuccessorInput[] = [];
            // F3B-6.28 · D-3B-5：successors 只从 **unit 成员所在页** 收集
            //   （此前硬编码 pages[0] ⇒ 多页文档上成员在第 2+ 页时既漏收集真后续行、
            //   又把第 1 页的行误判为后续 ⇒ 与导出侧流水线的页面口径不一致）。
            //   成员页不可判定（跨页 unit / 行缺失）⇒ 不收集（fail-closed，
            //   场景判定会因页面归属不唯一而拒绝登记）。
            // ★ 2026-10-24：成员页码按**有效 legacy lineId** 取（合成 id 经 ledger
            //   反向解析）——否则合成成员全落 -1 ⇒ 成员页不可判定 ⇒ successors 不
            //   收集 ⇒ 位移行不推进 ⇒ 变长段落与下一行重叠（遮盖的另一种形态）。
            const memberPageSet = new Set(
              cUnitEff.lines.map((m) => legacyLinePageById.get(m.lineId) ?? -1),
            );
            const memberPageIndex =
              memberPageSet.size === 1 && !memberPageSet.has(-1)
                ? ([...memberPageSet][0] as number)
                : null;
            const legacyPages = (legacyDoc as { pages?: never[] }).pages ?? [];
            const successorBlocks: never[] =
              memberPageIndex !== null
                ? ((legacyPages[memberPageIndex] as { blocks?: never[] } | undefined)?.blocks ?? [])
                : [];
            for (const b of successorBlocks) {
              if ((b as { id?: string }).id !== cBlockId) continue;
              for (const l of (b as { lines?: never[] }).lines ?? []) {
                const bb = (l as { bbox?: { y?: number; x?: number; width?: number; height?: number } }).bbox;
                if ((bb?.y ?? 0) <= lastMemberTop) continue;
                if (cUnitEff.lines.some((m: never) => (m as { lineId: string }).lineId === (l as { id: string }).id)) continue;
                const glyphs: any[] = (l as { glyphs?: any[] }).glyphs ?? [];
                successors.push({
                  textBoxId: (l as { id: string }).id, paragraphId: (l as { id: string }).id,
                  text: glyphs.map((g) => g.char ?? "").join(""),
                  x: bb?.x ?? 0, width: bb?.width ?? 0, top: bb?.y ?? 0, height: bb?.height ?? 21.46,
                });
              }
            }
            // ★ 行距（originalLineGap）：
            //   · 多行组 ⇒ 相邻行 y 差（既有冻结语义，flow 自算校验）；
            //   · **单行组**（cell 面恒单成员行）⇒ 原实现 gap=0 ⇒ originalLineGap
            //     =undefined ⇒ computeFlowLayout `missing-line-gap` fail-closed ⇒
            //     C3 提交层整体 fail-open 静默失败 ⇒ 提交态回落到 span+grMask
            //     （其顶部 ~2.4px 盖不住旧 canvas 文本 = 用户 2026-10-22 报告的
            //     「文本顶部重影」）。单行组的行距证据 = **同块相邻行** y 差
            //     （flow 契约：reflow 后行距必须 = 原始 PDF 行距）：优先后继行
            //     （与 successors 同源），无后继（块末行）⇒ 前导行；皆无 ⇒ 0 ⇒
            //     调用方 fail-closed（块内唯一行的罕见形态不建提交层，不猜行距）。
            const singleMemberGap = ((): number => {
              if (flowLines.length !== 1) return 0;
              const top = flowLines[0]!.top;
              let nextTop: number | null = null;
              for (const s of successors) {
                if (s.top > top && (nextTop == null || s.top < nextTop)) nextTop = s.top;
              }
              if (nextTop != null) return nextTop - top;
              let prevTop: number | null = null;
              for (const b of successorBlocks) {
                if ((b as { id?: string }).id !== cBlockId) continue;
                for (const l of (b as { lines?: never[] }).lines ?? []) {
                  const y = (l as { bbox?: { y?: number } }).bbox?.y;
                  if (typeof y !== "number" || y >= top) continue;
                  if (cUnitEff.lines.some((m: { lineId: string }) => m.lineId === (l as { id: string }).id)) continue;
                  if (prevTop == null || y > prevTop) prevTop = y;
                }
              }
              return prevTop != null ? top - prevTop : 0;
            })();
            const gap = flowLines.length > 1 ? flowLines[1]!.top - flowLines[0]!.top : singleMemberGap;
            // ── D-3B-0：changedLineIds 唯一来源 = **刚提交的事务**（非文本/几何反推）──
            //   事务操作段落 → unit 成员行；映射失败/不唯一 ⇒ 保守（硬断行 + unresolved）。
            const changedOutcome = changedLineIdsOfTransaction(
              cUnitEff.lines.map((m) => ({ lineId: m.lineId, textBoxId: m.textBoxId, paragraphId: m.paragraphId })),
              built.command.operations,
            );
            const changedLineIdsC3 = changedOutcome.ok ? changedOutcome.lineIds : undefined;
            if (!changedOutcome.ok) {
              console.warn(
                "[F3B-6.28][D3B-CHANGED] 事务无法唯一映射到成员行 ⇒ 保守模式（原始断行硬约束）：",
                changedOutcome.reason,
                changedOutcome.detail,
              );
            }
            const cFlow = computeFlowLayout({
              lines: flowLines,
              constraintWidth: coreConstraintWidth > 0 ? coreConstraintWidth : Math.max(...flowLines.map((f) => f.width)),
              originalLineGap: gap > 0 ? gap : undefined,
              successors,
              changedLineIds: changedLineIdsC3,
            });
            if (!cFlow.ok) throw new Error(`C3 flow: ${cFlow.reason}`);
            const cScope = computeAffectedScope(cUnitEff, cFlow, (id) => {
              const ll = lg(id);
              return ll?.bbox ? { x: ll.bbox.x, y: ll.bbox.y, width: ll.bbox.width, height: ll.bbox.height } : null;
            });
            if (!cScope.ok) throw new Error(`C3 scope: ${cScope.reason}`);
            // C2（续）：displaced 行的原位置 mask（在 scope 计算后——只有被流规则
            //   判定为"同栏且之后"的后续行才被推进/清除；无关行绝不加 mask）
            for (const item of cScope.items) {
              if (item.role !== "displaced-successor" || item.incomplete) continue;
              markLineEdited(cBlockId, item.sourceLineId);
            }
            // ── F3B-6.28 · D 第一/第二步：位移清除计划登记（导出侧用）────────────
            //   与上方 mask 循环**同一判据**（displaced-successor 且非 incomplete）⇒
            //   屏幕清除集与导出清除集结构上一致，不会出现「屏幕清了、导出没清」。
            //   只登记身份 + 事务证据（最后已应用事务的 id + 水位 + Sidecar 代次）；
            //   `incomplete` 项**不得**进入（几何不可信 ⇒ 不猜）。
            //   D 第二步（决策二）：同时登记 unit **全部成员行**（不论文本是否变化，
            //   都会被 flow 重绘 ⇒ 原算子必须剥离；l6 实测教训：文本未变 ⇒ diff 发现不了）。
            //
            //   ★ D 身份修复：成员行携带**提交时登记的 Core 段落身份**，来源 =
            //     unit 行映射（`cUnitEff.lines[].{textBoxId,paragraphId}`，有效
            //     lineId 口径）——与 unit 事务
            //     `built.command.operations[].paragraphId` 同源，并对事务逐条校验。
            //     **不再**依赖「编辑后从 run.source 反查 source key」：Core 编辑会剥离/
            //     替换 run source（§24/§25），反查在整行替换时拿不到 after 侧身份。
            //     三种身份显式区分：Core paragraph ID（bridge 匹配键）/
            //     source line ID（Sidecar 主键）/ operator ID（内容流算子）。
            const memberCoreIdentity = new Map<string, { textBoxId: string; paragraphId: string }>();
            for (const m of cUnitEff.lines) {
              memberCoreIdentity.set(m.lineId, { textBoxId: m.textBoxId, paragraphId: m.paragraphId });
            }
            // 事务身份校验：事务操作的每个 (textBoxId, paragraphId) 必须能在 unit 成员
            //   身份中唯一命中 ⇒ 否则身份来源不可信，**整个计划不登记**（fail-closed）。
            let identityTrusted = true;
            for (const op of built.command.operations) {
              const owner = [...memberCoreIdentity.entries()].find(
                ([, v]) => v.paragraphId === op.paragraphId,
              );
              if (!owner || owner[1].textBoxId !== op.textBoxId) {
                identityTrusted = false;
                break;
              }
            }
            const displacedClear: DisplacedClearTarget[] = [];
            const memberClear: DisplacedClearTarget[] = [];
            if (identityTrusted) {
              for (const item of cScope.items) {
                if (item.incomplete) continue;
                if (item.role === "displaced-successor") {
                  displacedClear.push({ blockId: cBlockId, lineId: item.sourceLineId });
                } else if (item.role === "unit-member") {
                  const identity = memberCoreIdentity.get(item.sourceLineId);
                  if (!identity) {
                    // 成员行拿不到 Core 段落身份 ⇒ 无法唯一映射 ⇒ 不登记该项（显式失败）
                    console.warn(
                      "[F3B-6.28][D1-IDENTITY] unit 成员行无 Core 段落身份，拒绝登记清除目标：",
                      item.sourceLineId,
                    );
                    identityTrusted = false;
                    break;
                  }
                  memberClear.push({
                    blockId: cBlockId,
                    lineId: item.sourceLineId,
                    coreIdentity: identity,
                  });
                }
              }
            }
            const appliedCount = session.history.appliedCount;
            const planEntries = session.history.entries();
            const appliedTxId = planEntries[appliedCount - 1]?.id ?? "";
            // ★ changedLineIds 与计划同生共死：映射不可信 ⇒ 计划整体不登记
            //   （导出侧随之回到保守模式，绝不沿用过期/不可信的变更声明）。
            const changedTrusted = changedOutcome.ok;
            // ── F3B-6.28 · D-3B-5：场景授权判定（用户 2026-10-14 裁决）────────
            //   生产 gate 已开启，但**只授权 D1 段落末尾追加**进入「原算子清除 +
            //   重绘」链；替换 / 删除 / 合并 / 多段落流动 / 跨页推挤 ⇒ 计划不登记
            //   ⇒ 导出侧拿不到计划 ⇒ 走既有路径（绝不半授权）。
            //   判据来源 = **事务本身**（operations）+ 位移行页面归属 + 提交后
            //   Core 段落长度（UTF-16，与 op 偏移同口径）——绝不从最终文本/几何
            //   反推（与 changedLineIds 同纪律：反推会把模型误差误判成用户编辑）。
            const coreParagraphLengthById = new Map<string, number>();
            for (const page of (cDoc as { pages?: never[] }).pages ?? []) {
              for (const obj of (page as { objects?: never[] }).objects ?? []) {
                if ((obj as { type?: string }).type !== "text") continue;
                for (const p of (obj as { paragraphs?: never[] }).paragraphs ?? []) {
                  const pid = (p as { id?: string }).id;
                  if (typeof pid === "string") {
                    coreParagraphLengthById.set(pid, getParagraphText(p as never).length);
                  }
                }
              }
            }
            const scenarioOutcome = classifyExportRedrawScenario({
              operations: built.command.operations.map((op) => ({
                paragraphId: op.paragraphId,
                startUtf16: op.startUtf16,
                endUtf16: op.endUtf16,
                replacement: op.replacement,
              })),
              paragraphLengthOf: (pid: string) => coreParagraphLengthById.get(pid) ?? null,
              // ★ 2026-10-24：有效 lineId 口径（与 memberClear / changedLineIds 同宗）
              memberLineIds: cUnitEff.lines.map((m) => m.lineId),
              // D-3B-6 步骤 3：成员段落 ID（契约 §3 条件 5 `paragraph-not-member` 判定所需）。
              //   来源与 memberLineIds 同宗（unit 行映射），不从文本/几何反推。
              memberParagraphIds: cUnitEff.lines.map((m) => m.paragraphId),
              displacedLineIds: displacedClear.map((d) => d.lineId),
              pageIndexOf: (lineId: string) => legacyLinePageById.get(lineId) ?? null,
            });
            // D-3B-6 步骤 3：判等改为「授权集合」成员判定（含 D1 + D2）。
            //   ★ 其余不变式一律不动：__exportRedraw 默认值、D1 判据、
            //     identityTrusted / changedTrusted / 清除范围。
            const scenarioAuthorized = EXPORT_REDRAW_AUTHORIZED_SCENARIOS.includes(
              scenarioOutcome.scenario,
            );
            // ★★ 2026-10-19（多计划）：按 unitId **upsert** —— 新 unit 提交不再替换
            //   之前 unit 的计划（先前编辑的剥除/重绘得以持续）；本 unit 授权失败 ⇒
            //   删除自己的条目（该 unit 退出重绘，走既有路径；不影响其他 unit）。
            if (
              identityTrusted &&
              changedTrusted &&
              scenarioAuthorized &&
              (displacedClear.length > 0 || memberClear.length > 0)
            ) {
              unitDisplacedClearRef.current.set(cUnit.unitId, {
                unitId: cUnit.unitId,
                sidecarGeneration: bindingSidecarRef.current?.generation ?? null,
                appliedTxId,
                appliedIndex: appliedCount,
                lines: displacedClear,
                memberLines: memberClear,
                changedLineIds: changedOutcome.ok ? changedOutcome.lineIds : [],
                scenario: scenarioOutcome.scenario,
                scenarioDetail: scenarioOutcome.detail,
              });
            } else {
              unitDisplacedClearRef.current.delete(cUnit.unitId);
            }
            if (!identityTrusted) {
              console.warn(
                "[F3B-6.28][D1-IDENTITY] unit 事务身份与成员行映射不一致 ⇒ 不登记清除计划（fail-closed，导出侧不剥离成员行）",
              );
            }
            if (!scenarioAuthorized) {
              // 场景未授权：显式失败 + 可观测（导出侧因此走既有路径，不做 unit 清除/重绘）
              console.warn(
                `[F3B-6.28][D1-SCENARIO] unit 事务不属于 ${EXPORT_REDRAW_AUTHORIZED_SCENARIOS.join(" / ")}` +
                  `（${scenarioOutcome.reason}）⇒ 不登记清除/重绘计划，导出走既有路径：`,
                scenarioOutcome.detail,
              );
              try {
                (globalThis as unknown as Record<string, unknown>).__d3b2ScenarioReject = {
                  reason: scenarioOutcome.reason,
                  detail: scenarioOutcome.detail,
                  scenario: scenarioOutcome.scenario,
                };
              } catch {
                /* ignore */
              }
            }
            // DOM 锚：成员/被推进行的首个 segment rect（viewport 系；fixed 渲染）。
            //   C 收尾：同时取该 segment 的**计算字体**（fontSize/fontFamily）——
            //   overlay 文本此前硬编码 21.4574px，与真实行尺寸不符 ⇒ overflow:hidden
            //   裁断新文本（实测 "地点：茂名市。" 只显示 "地点：茂名"）。锚 segment 是
            //   既有渲染层 ⇒ 计算样式是真实排版事实，非猜测。
            const segInfo = new Map<string, { x: number; y: number; marginTop: number; fontSize: number; fontFamily: string }>();
            const segRect = (lineId: string): { x: number; y: number; marginTop: number; fontSize: number; fontFamily: string } | null => {
              const hit = segInfo.get(lineId);
              if (hit) return hit;
              const segId = (segmentsRef.current ?? []).find((s) => s.source?.lineId === lineId)?.id;
              if (!segId) return null;
              const el = document.querySelector(`[data-segment-id="${segId}"]`) as HTMLElement | null;
              if (!el) return null;
              const r = el.getBoundingClientRect();
              const cs = window.getComputedStyle(el);
              const info = { x: r.x, y: r.y, marginTop: parseFloat(cs.marginTop) || 0, fontSize: parseFloat(cs.fontSize) || 0, fontFamily: cs.fontFamily };
              segInfo.set(lineId, info);
              return info;
            };
            // ── C 收尾（R1）：清除层 ──
            //   残差取证（tests/e2e/c23-audit · residual-attribution）：mask 对 canvas
            //   原墨迹覆盖完整（隐藏 span+overlay 后旧位置 0 墨迹），残差来自 glyph span
            //   （editedLines 命中 ⇒ span z50 渲染 legacy 原文，压在 mask z40 之上）。
            //   glyph-renderer 冻结 ⇒ 在 overlay 层（z45，高于 glyph 层）为每个受影响行
            //   加白底清除矩形：几何 = 原始 glyph 并集 + 既有 mask padding（共享 kernel，
            //   与 C2 mask 同源同语义；不扩大清除范围、不做坐标猜测）。
            //   视口换算用 glyph 层容器原点 —— mask/span 的同一坐标系，像素级对齐。
            const glyphLayerEl = document.querySelector('[data-layer="glyph"]') as HTMLElement | null;
            const glyphOrigin = glyphLayerEl ? glyphLayerEl.getBoundingClientRect() : null;
            const cOverlay = computeCommittedOverlay(
              cFlow,
              cScope,
              (sourceId) => {
                const ll = lg(sourceId);
                const r = segRect(sourceId);
                if (!ll?.bbox || !r) return null;
                return {
                  // ★ 2026-10-18（用户缺陷「日期没有与上一行对齐」）：锚点 x 必须取
                  //   **原始行位**（glyph 层原点 + legacy bbox.x），不得取 segment 现
                  //   rect.x —— 宿主 segment 已被 A′ 改写为整单元多行编辑面，其 rect.x
                  //   是**续行基准**（baseX = min 成员 x）而非该行原始左缘：实测 l5 面
                  //   left=323.08 vs 原行位 366.18（差 43.1px = 首行缩进）⇒ overlay
                  //   两行整体左移 2 字，首行与上一行（标题，同在 366.18）错位。
                  //   y 仍取 segment rect，但须**还原半 leading 补偿**：宿主面为保住
                  //   首行基线设了负 marginTop（行距修复，见 EditableTextNode），
                  //   getBoundingClientRect 已含该位移 ⇒ 不减则 overlay 整体上移
                  //   半个 leading（实测两行各上移 10.25px）。非宿主段 marginTop 恒 0
                  //   ⇒ 位移行/其他成员行不受影响。减去后即 alignedTop（基线对齐，
                  //   与 overlay 文本渲染同源；实测行 0 y=514.39 = 原 segment y，
                  //   行距 41.97 由 flow 保证）。
                  //   glyphOrigin 缺失 ⇒ 回落 r.x（旧行为，fail-open）。
                  rect: {
                    x: glyphOrigin ? glyphOrigin.x + ll.bbox.x : r.x,
                    y: r.y - r.marginTop,
                    width: ll.bbox.width,
                    height: ll.bbox.height,
                  },
                  flowInputTop: ll.bbox.y,
                  flowInputX: ll.bbox.x,
                };
              },
            );
            if (!cOverlay.ok) throw new Error(`C3 overlay: ${cOverlay.reason}`);
            const clearPlan = computeCommittedClearRects(cScope, (id) => (lg(id) as { glyphs?: unknown[] } | undefined)?.glyphs ?? null);
            const clears = glyphOrigin
              ? clearPlan.rects.map((c) => ({
                  sourceLineId: c.sourceLineId,
                  cssX: glyphOrigin.x + c.rect.x,
                  cssY: glyphOrigin.y + c.rect.y,
                  cssW: c.rect.width,
                  cssH: c.rect.height,
                }))
              : [];
            const displacedTexts: Record<string, string> = {};
            for (const item of cScope.items) {
              if (item.role !== "displaced-successor") continue;
              // ★ 位移行文本必须取 **Core 当前文本**（2026-10-18"再次提交"回归实测缺陷）：
              //   原实现取 legacy glyph 原文 ⇒ 先前提交对位移行的编辑（如 l10 的"测试"）
              //   会从提交层消失（span 已被清除层隐藏、overlay 又画旧文 ⇒ 内容不可见）。
              //   解析走统一入口（provenance 优先、ledger 兜底，与生产身份链一致）；
              //   legacy 原文仅作解析失败时的兜底（fail-open，不静默丢行）。
              const coreTextOfDisplaced = (() => {
                try {
                  const resolved = resolveParagraphIdForLine(
                    cDoc,
                    item.sourceLineId,
                    unitIdentityLedgerRef.current,
                    sidecarGenerationRef.current,
                  );
                  if (!resolved.ok) return null;
                  return findTextBoxByParagraphId(cDoc, resolved.paragraphId)?.text ?? null;
                } catch {
                  return null;
                }
              })();
              displacedTexts[item.sourceLineId] =
                coreTextOfDisplaced ??
                successors.find((s) => s.textBoxId === item.sourceLineId)?.text ??
                "";
            }
            // ★★ 2026-10-19（多快照）：按 unitId **upsert** —— 新 unit 提交不再替换
            //   之前 unit 的快照（先前编辑的提交层显示得以持续；见 state 声明处文档）。
            // ★★ 2026-10-22（用户缺陷「编辑提交后表格不存在、文本不在格子里，但导出 PDF
            //   正确」）：**cell 单位不登记 C3 显示快照**。C3 的「整行白块清除 + flow
            //   整行文本 overlay」是为**正文段落**设计的：
            //     · 清除块几何覆盖**整行带**（实测 1556×22，含上下表格边框线）
            //       ⇒ 表格线被擦 ⇒ 用户看到「表格不存在了」；
            //     · overlay 是 CSS 排版的一整行连续文本（度量来自锚 segment）
            //       ⇒ 丢失表格列位置 ⇒ 文字挤成一团、不在格子里。
            //   cell 面的显示改由 **glyph span（z50，逐字符原位定位）+ C2 mask 盖原文**
            //   承担（上方 markLineEdited 已调用，保留）——实测三态对照：表格线完整、
            //   新值 28.50 落在正确格子、其余格位置不变（截图 B2）。
            //   ⚠️ 导出侧不受影响：drop 投影 + raw-CID 逐字符重绘（R3 已验收，
            //      导出 PDF 表格正确）——显示与导出两条链在此**有意分歧**。
            if (!cUnit.unitId.startsWith(CELL_UNIT_ID_PREFIX)) {
              setCommittedUnitOverlays((prev) => ({
                ...prev,
                [cUnit.unitId]: {
                  unitId: cUnit.unitId,
                  appliedIndex: session.history.appliedCount,
                  // D-3B-6：提交时的显示页（用户在该页编辑并提交）⇒ 渲染层按页门控
                  pageIndex: page,
                  // ★ 滚动跟随：记录提交时 scrollY（行/clear 的 cssY 为视口坐标 ⇒ docY = cssY + 本值）
                  commitScrollY: typeof window !== "undefined" ? window.scrollY : 0,
                  lines: cOverlay.lines.map((l) => ({
                    // displaced 行的文本在 commit 块内已知（原文不变）⇒ 直接填入，
                    // 渲染层零查找（纯净派生快照）
                    text: l.text || displacedTexts[l.sourceLineId] || "",
                    cssX: l.cssX, cssY: l.cssY, cssW: l.cssW, cssH: l.cssH,
                    sourceLineId: l.sourceLineId, role: l.role,
                    // 排版度量来自锚 segment 计算样式（缺失 ⇒ 0，渲染层据此回退）
                    fontSize: segInfo.get(l.sourceLineId)?.fontSize ?? 0,
                    fontFamily: segInfo.get(l.sourceLineId)?.fontFamily ?? "",
                  })),
                  clears,
                  skipped: glyphOrigin ? cOverlay.skipped : [...cOverlay.skipped, "clears: glyph 层容器缺失，清除层未产出"],
                },
              }));
            } else {
              // cell 单位：显示层走 span 方案 ⇒ 若该 unit 曾登记过快照（理论上不发生），
              // 显式移除，避免旧快照的 clears/overlay 继续生效。
              setCommittedUnitOverlays((prev) => {
                if (!(cUnit.unitId in prev)) return prev;
                const next = { ...prev };
                delete next[cUnit.unitId];
                return next;
              });
              // ★ 2026-10-23：登记「该行需要 span 显示的几何区间」= **编辑格 cellBox**
              //   （X 范围；`unitSurfaceNow.cellAnchor.box` = cell 墨迹盒，与 span 的
              //   定位同空间）。只有盒内 span 可见（显示新值 + 白底盖旧字形）；盒外
              //   span 隐藏 ⇒ canvas 原文承担其他格显示 ⇒ 零重影、竖线完整。
              //   盒缺失 ⇒ 保守 fallback 整行（与旧语义一致）。
              const lineId = cUnitEff.lines[0]?.lineId ?? "";
              (window as any).__cellCommitDump = {
                faceGeom: cellFaceGeomRef.current,
                unitLineId: lineId,
              };
              const faceGeom = cellFaceGeomRef.current;
              const anchorBox =
                faceGeom && faceGeom.lineId === lineId
                  ? { x: faceGeom.x, y: faceGeom.y, width: faceGeom.width, height: faceGeom.height }
                  : null;
              // ★ 2026-10-24：多带显示——同一行可先后编辑**多个格**（跨会话），每格一个
              //   显示带（按 x 幂等 upsert：同格重复提交替换、异格追加）。旧单带 Map 的
              //   第二格提交会覆盖第一格 ⇒ 先前格的新值被 canvas 旧文回显（丢字/重影）。
              setCellCommittedSpans((prev) => {
                const newBand = anchorBox
                  ? { x: anchorBox.x, y: anchorBox.y, width: anchorBox.width, height: anchorBox.height }
                  : { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, width: Number.POSITIVE_INFINITY * 2, height: Number.POSITIVE_INFINITY * 2 };
                const prevBands = prev.get(lineId) ?? [];
                const idx = prevBands.findIndex((b) => b.x === newBand.x);
                if (idx >= 0) {
                  const b0 = prevBands[idx]!;
                  if (b0.y === newBand.y && b0.width === newBand.width && b0.height === newBand.height) return prev;
                  const next = new Map(prev);
                  next.set(lineId, prevBands.map((b, i) => (i === idx ? newBand : b)));
                  return next;
                }
                const next = new Map(prev);
                next.set(lineId, [...prevBands, newBand]);
                return next;
              });
              // ★ 2026-10-24：登记 cell 编辑台账（跨会话第二格编辑的映射来源；
              //   详见 table-cell-edit-ledger.ts 头注）。文本 = 本次事务后的 cell 内容
              //   （postMutationText；cell unit 的 unit 文本 == cell 文本）。
              //   每键刷新（last-write-wins）⇒ 记录恒为该格最新提交内容。
              const cellIdxParsed = Number.parseInt(
                cUnit.unitId.slice(CELL_UNIT_ID_PREFIX.length + lineId.length + 1),
                10,
              );
              const cellParagraphId = cUnitEff.lines[0]?.paragraphId ?? "";
              if (
                lineId &&
                Number.isInteger(cellIdxParsed) &&
                cellParagraphId &&
                typeof intentOutcome.postMutationText === "string"
              ) {
                cellEditLedgerRef.current.record({
                  lineId,
                  cellIndex: cellIdxParsed,
                  paragraphId: cellParagraphId,
                  newText: intentOutcome.postMutationText,
                });
              }
            }
            // C 收尾（R2 裁决）：来源映射缺失/几何不完整 ⇒ **显式失败可观测**，
            //   绝不静默"整页成功"。C3 整体 fail-open（事务已提交，不回滚），
            //   但缺口必须留痕（console + skipped + __c3diag）。
            const c3Skipped = [...cOverlay.skipped, ...(glyphOrigin ? [] : ["clears: glyph 层容器缺失"]), ...clearPlan.skipped];
            if (c3Skipped.length > 0) {
              console.warn(`[F3B-6.28][C3_SKIPPED] {unitId: ${cUnit.unitId}, count: ${c3Skipped.length}, detail: ${JSON.stringify(c3Skipped)}}`);
            }
            // C 阶段诊断（临时）：范围计算观测（window 变量供 spec 读取）。
            //   ★ 位置纪律：必须在 clears/clearPlan 声明**之后**（此前放在前面触发过 TDZ）。
            (window as unknown as Record<string, unknown>).__c3diag = {
              N: cFlow.metrics.newLineCount, delta: cFlow.metrics.delta,
              constraintWidth: coreConstraintWidth,
              displacedCount: cFlow.displaced.length, successors: successors.length,
              clears: clears.length, clearsSkipped: clearPlan.skipped, hasGlyphOrigin: !!glyphOrigin,
              scopeItems: cScope.items.map((i) => ({ id: i.sourceLineId, role: i.role, inc: i.incomplete })),
            };
          } catch {
            // fail-open：C2 已生效（mask），C3 显示层失败不回滚事务
          }
        }
        // ★ F5：登记「事务成功后 caret 应落在哪」。
        //   · `postMutationUnitOffset` 是**事务语义的直接结果**（Core 不产caret，裁决 B）
        //   · `expectedText` 是本次 mutation 的确定性文本 ⇒ A′ 写入时用它与 Core
        //     实际算出的 unit 文本**逐字节交叉验证**，不一致则不恢复（fail-closed）
        //   · 仅此处（唯一提交成功点）登记；任何 failClosed 分支都会清除它
        pendingUnitCaretRef.current = {
          unitId: unitSurfaceNow.unit.unitId,
          expectedText: intentOutcome.postMutationText,
          offset: intentOutcome.postMutationUnitOffset,
        };
        return; // ★ 绝不下落到 dispatchBeforeInput
      }

      const outcome = dispatchBeforeInput({
        coreEnabled: true,
        session,
        inputType: native.inputType,
        data: native.data,
        options: caretOptions,
        handleInLegacy: () => {
          /* legacy 路由：不拦截，让 DOM 默认行为继续（原路径逐字节不变） */
        },
      });

      if (outcome.route === "core") {
        // ★ F3B-6.21-H1-B：preventDefault 必须与 **Core 真的提交了一个 mutation** 绑定（约束 #2）。
        //   `set-text-style` 在折叠 / 跨段 / uniform-ON 翻转后无目标时解析为 0 Command
        //   （`committed === false`）⇒ **不阻断 DOM**，交由浏览器原生处理
        //   （V1 no-op：不伪造 mutation、不占 undo 步、不改 export ownership）。
        //   其它输入类型（text/paste/keydown）仅在命令实际改变文档时 `committed` 才为 true，
        //   因此本门控对它们同样安全，并消除了「0 Command 却阻断 DOM」的潜在丢字风险。
        if (!outcome.core?.ok || !outcome.core.result.committed) {
          return; // 已识别但无实际提交 ⇒ 不 preventDefault、不记账、不 bump
        }
        // C6-E：阻断 DOM 变更 → 之后的 onBlur 不会看到文本变化 → 不可能二次 mutation
        native.preventDefault();
        noteCoreSessionChange("core-mutation");
        // ★ F3B-6.21-H1-B：文本样式切换经由 Core 实际提交（已 `committed`）⇒ 标记。
        //   `preventDefault` 仅在 committed 时调用（约束 #2），故 marker 与「真的应用了 style」等价；
        //   折叠 / 跨段解析为 0 Command（committed=false）⇒ 不标记、不阻断 DOM（浏览器原生保留 V1 no-op）。
        if (native.inputType.startsWith("format")) {
          console.log(`[F3B-6.21-H1B] core-text-style {inputType: ${native.inputType}, committed: true}`);
        }
        // #12/G1：Core mutation ⇒ **归属记账补齐**（与 capability / segment / textedit 站点对称）。
        exportOwnershipRef.current = "core";
        markMutationOwner("core");

        // ── 01H（H1）：记录/失效「拆分事务证据」─────────────────────────
        //   只记录**已提交**事务透出的事实；任何后续 mutation 都会覆盖或清空它，
        //   因此不会把「曾经发生过的拆分」当成当前依据。
        if (
          outcome.core.result.transactionId &&
          outcome.core.result.transactionType === "split-paragraph"
        ) {
          lastSplitMutationRef.current = {
            transactionId: outcome.core.result.transactionId,
            type: outcome.core.result.transactionType,
            createdParagraphIds: outcome.core.result.createdParagraphIds ?? [],
          };
        } else {
          lastSplitMutationRef.current = null;
        }
        appliedTransactionIdRef.current = outcome.core.result.transactionId ?? null;

        // ── F3B-6.27-H2（rebind 站点说明）──────────────────────────────────
        //   rebind **不在**此处执行：实测此处 Core caret 尚未迁移到新段落
        //   （事务刚提交、live reflow 未跑完）⇒ `resolveEditingCaretParagraphId`
        //   仍经 ① 返回旧段落 ⇒ rebind 不生效。真正的 rebind 在 A′ effect
        //   （提交之后、Core caret 已收敛），见该处的 H2 注释。

        // ── F3B-6.21-F2（与 E-C5-1 的 D6 同源）：词删后的 **DOM caret 对账** ──
        //   `preventDefault()` ⇒ DOM 文本**没变**（⇒ blur 时 `textContent === segment.text`
        //   ⇒ **不可能**产生 SEGMENT_CORE_COMMIT，第二入口已消除），
        //   但 DOM caret 也停在**旧** offset ⇒ 下一次输入会从错误位置播种。
        //   纠正方式：用 **Core 自己的 caret 位移量**（同一段落内 UTF-16 delta）反推，
        //   不复制第二套「段落 ↔ DOM」映射。对账失败 ⇒ fail-open（不动 caret）。
        if (
          native.inputType === "deleteWordBackward" ||
          native.inputType === "deleteWordForward"
        ) {
          const domBefore = computeSegmentDomOffset(segmentId, target);
          const beforeOffset = coreCaretParagraphOffset(session, caretOptions.caret);
          const afterOffset = coreCaretParagraphOffset(session, outcome.core?.result?.caret);
          if (
            domBefore !== null &&
            beforeOffset !== null &&
            afterOffset !== null &&
            beforeOffset > afterOffset &&
            target
          ) {
            // ★ F3B-6.21-G1：改走**统一**的 Core→DOM 对账原语（不再内联 TreeWalker）。
            //   `markSynced` 只在成功时触发 ⇒ 不会产生「Core 写 DOM → selectionchange 回写」的环。
            reconcileDomCaretAtOffset({
              scope: target,
              startOffsetUtf16: domBefore - (beforeOffset - afterOffset),
              markSynced: (applied) => {
                lastCoreSelectionSyncRef.current = `${segmentId}:${applied.start}`;
              },
            });
          }
        }

        // ★ F3B-6.27（实测修正）：Core 提交后把 DOM caret 对账到 **Core 提交后**的 caret。
        //   ⚠️ 曾长期被一个守卫挡住（`coreOffset - baseNow < domRangeNow.end`，只在 Core 变短时
        //   对账），其理由是「DOM 陈旧时写回 DOM 会把字符插到上一个字符之前」。
        //   **该前提已被 875cf63 的 A′ 同步推翻** ⇒ 那条规避路径把 DOM caret 钉死在陈旧偏移。
        //   ★ 真正的倒序根因是**两处叠加**（逐步采样 coreLen/domLen/domCaret 定位）：
        //     ① A′ effect 传的是「写入前的旧 DOM caret」且缺 `markSynced`
        //        ⇒ 它写入 textContent 后触发的 selectionchange 被 `onSelectionChange`
        //           当成「用户移动 caret」**回写 Core** ⇒ Core caret 被拉回插入点之前；
        //     ② 本站点与 A′ 同时写 DOM caret，两处都以旧值为准 ⇒ 互相覆盖。
        //   实测修复后：before 32/29/29 → A 33/30/30 → B 34/31/31 → C 35/32/32
        //             （Core 文本 `…以补ABCD`，**顺序正确**；此前为 `…以补DCBA`）
        //   本站点保留（覆盖 beforeinput 时刻），A′ 覆盖 effect 时刻；两者都带 `markSynced`
        //   ⇒ 不会产生「Core 写 DOM → selectionchange 回写 Core」的环。
        if (target && outcome.core?.result?.caret) {
          reconcileDomCaretFromCore({
            session,
            caret: outcome.core.result.caret,
            scope: target,
            // ★ STEP②：boolean 与 base **同源**（避免 base-contradiction 静默失效）
                      ...surfaceBasePairFor(
                        session.history.state.caret?.position?.paragraphId ?? null,
                        segmentId,
                        session.history.state.document
                      ),
            markSynced: (applied) => {
              lastCoreSelectionSyncRef.current = `${segmentId}:${applied.start}`;
            },
          });
        }

        // ★ F3B-6.27 实现 checkpoint：Core 提交后**维护 SegmentRangeLedger**。
        //   语义：range 随 transaction 快照（Q2=A）—— 不是从 Core 文本重新推导。
        //   `ownerSegmentId` = 当前编辑段（Q6：调用上下文提供的 ownership evidence）。
        //   维护失败（Q1 跨段 / Q6 冲突等）⇒ 不写入 ledger（保持原状态，绝不猜）。
        try {
          const paraId = session.history.state.caret?.position?.paragraphId ?? null;
          const ledger = paraId
            ? segmentRangeLedgerRef.current ?? ensureSegmentRangeLedger(segmentId, session.history.state.document)
            : null;
          if (ledger && paraId && segmentRangeParagraphRef.current === paraId) {
            const tx: any = (session.history.entries?.() ?? []).slice(-1)[0] ?? null;
            const cmd: any = tx?.command;
            // ★ 命令形状兼容：replace/delete 有 `range`；**insert 只有 `position`**
            //   （实测 InsertTextCommand 无 range ⇒ 早期实现漏维护插入，切片少末尾字符）
            if (cmd && (cmd.range?.anchor || cmd.position)) {
              const beforeDoc: any = tx.before?.document;
              const para: any = beforeDoc
                ? (beforeDoc.pages ?? [])
                    .flatMap((pg: any) => pg.objects ?? [])
                    .flatMap((o: any) => (o.type === "text" ? (o.paragraphs ?? []) : []))
                    .find((p: any) => p.id === cmd.range.anchor.paragraphId)
                : null;
              if (para) {
                const offIn = (runId: string, off: number): number => {
                  let acc = 0;
                  for (const r of para.runs ?? []) {
                    if (r.id === runId) return acc + off;
                    acc += (r.text ?? "").length;
                  }
                  return Number.NaN;
                };
                const a = offIn(cmd.range.anchor.runId, cmd.range.anchor.offset);
                const f = offIn(cmd.range.focus.runId, cmd.range.focus.offset);
                const beforeLen = paragraphTextOf(beforeDoc, paraId);
                const afterLen = paragraphTextOf(session.history.state.document, paraId);
                const pStart = cmd.position
                  ? offIn(cmd.position.runId, cmd.position.offset)
                  : Number.NaN;
                const a2 = cmd.range ? a : pStart;
                const f2 = cmd.range ? f : pStart;
                if (Number.isFinite(a2) && Number.isFinite(f2) && beforeLen && afterLen) {
                  const lo = Math.min(a2, f2);
                  const hi = Math.max(a2, f2);
                  const newTextLength = afterLen.length - (beforeLen.length - (hi - lo));
                  if (newTextLength >= 0) {
                    const kindOf2 =
                      cmd.type === "insert-text"
                        ? ("insert" as const)
                        : cmd.type === "delete-text"
                          ? ("delete" as const)
                          : cmd.type === "replace-text"
                            ? ("replace" as const)
                            : ("other" as const);
                    const res = commitTransaction(ledger, {
                      paragraphId: paraId,
                      startUtf16: lo,
                      endUtf16: hi,
                      newTextLength,
                      commandKind: kindOf2,
                      ownerSegmentId: segmentId,
                    });
                    if (res.ok) segmentRangeLedgerRef.current = res.ledger;
                  }
                }
              }
            }
          }
        } catch {
          /* ledger 维护失败 ⇒ 不影响既有编辑路径 */
        }

        // F3B-6.19-C（C3）：**不再在此写几何**。presentation 由 `corePresentation`
        // （= `corePresentationFor(session)`，deps = revision / `coreInputTick`）从 session 的
        // **当前** document + selection + caret 派生 —— 单一刷新路径；
        // 本处的 revision bump 已经触发它，因此**零 imperative 写点**。
        return;
      }
      console.warn("[CORE-012C6] 未建模 / 未启用的输入，交回 legacy：", outcome.reason);
    };

    /**
     * EDITOR-CORE-012-E：Enter DOM handoff。
     *
     * legacy `EditableTextNode.handleKeyDown`（`:148-152`）对 Enter 是
     * `preventDefault() + ref.current.blur()` → 先截走事件，
     * `beforeinput(insertParagraph)` 根本不会产生 → Enter 到不了 Core。
     *
     * 这里在 **capture 阶段**（早于目标节点上的 React bubble handler：
     * React 17+ 在 root container 上挂监听，stopPropagation 会阻止事件冒泡回 root）
     * 把该事件**截住不派发**：
     *   · `stopPropagation()` —— legacy 的 keydown handler **完全看不到** Enter（不 blur、不 preventDefault）
     *   · **不调用 `preventDefault()`** —— 让浏览器继续产生 `beforeinput(insertParagraph)`，
     *     由上面的 beforeinput 监听交给 Core（Core 侧才会 preventDefault 掉 DOM mutation，
     *     因此不会出现「浏览器插 <div>/<br> + Core 再插一次」的双重 mutation）
     *
     * ⚠️ 绝不能改成 `preventDefault()`：那会让浏览器不产生 beforeinput，Enter 直接丢失。
     * ⚠️ IME 组合期间（`isComposing`）走同一分支（只截不 preventDefault）：让浏览器先确认组合，
     *    由既有的 `compositionend` 路径产出**恰好 1 条**命令（避免 mid-composition blur 丢字）。
     * ⚠️ `shiftKey` 不截 —— legacy 本身也不处理 shift+Enter，保持其原行为不变。
     */
    const onKeyDownCapture = (event: KeyboardEvent) => {
      // ★ F3B-6.21-G3-A：Core-owned segment surface 上的 ArrowLeft/ArrowRight caret navigation
      //   把 caret 移动的 ownership 从 Browser/DOM 转移到 Core。
      //   - 仅 collapsed caret（Shift+Arrow → G3-C；Home/End/Up/Down 不在 G3-A 边界内）。
      //   - 使用 G2 锁定的 **code-point** 步进（`stepCaretWithinParagraph`，绝不 offset±1 / glyphIndex / DOM 扫描）。
      //   - ★ F3B-6.27-G9：步进**限定当前段落**（视觉行编辑面边界），**绝不跨段落**。
      //   - 边界（段首/段末）⇒ fail-closed：不构造伪 caret，但**阻断原生 caret**
      //     （DOM 文本可能是陈旧的，放行会让 DOM caret 走进 Core 已不存在的区域）。
      //   - DOM 写入唯一经 G1 reconcileDomCaretFromCore；markSynced 置幂等键 ⇒ 紧随的 selectionchange 不回写（无环）。
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !event.shiftKey &&
        !event.isComposing &&
        coreInputEnabled &&
        editingSegmentId !== null &&
        coreInputSessionRef.current
      ) {
        const target = event.target as HTMLElement | null;
        const segEl = target?.closest?.("[data-segment-id]") as HTMLElement | null;
        const segId = segEl?.getAttribute("data-segment-id") ?? null;
        if (!segId || segId !== editingSegmentId) return;
        const session = coreInputSessionRef.current;
        const document = documentOf(session);
        // ★ 当前 Core caret：优先 session 存储的 caret，缺失时由 selection.focus 收敛
        const caretPos =
          session.history.state.caret?.position ?? session.history.state.selection.range.focus;
        // ★ F3B-6.27-G9：步进**限定在当前段落**（视觉行编辑面 = 段落边界）。
        //   实测缺陷：`nextPosition` 会跨段落推进到下一视觉行，而 DOM scope 只有
        //   当前 segment 一个元素 ⇒ reconcile 出的 offset 越界/负数 ⇒ DOM 光标不动，
        //   随后 selectionchange 又把 Core caret 拉回 ⇒ 光标卡死（用户报告的
        //   「方向键右移卡住、光标定位不到」）。跨段落步进只对文档级操作
        //   （Backspace/Delete）合法，故边界收在这里。
        const step = stepCaretWithinParagraph({
          document,
          position: caretPos,
          direction: event.key === "ArrowLeft" ? "left" : "right",
        });
        if (!step.ok) {
          // ★ 边界（段首/段末）⇒ 仍然**阻断原生 caret**：Core 是唯一真值，
          //   DOM 文本可能是陈旧的（编辑后），放行原生箭头会让 DOM caret 走进
          //   Core 已不存在的区域，随后输入落到错误位置。
          if (step.reason === "paragraph-boundary") {
            event.preventDefault();
            event.stopPropagation();
          }
          return;
        }
        const next = step.position;
        const newCaret = createCaret(next, "forward");
        session.history.updateSelection({
          selection: createCollapsedSelection(next),
          caret: newCaret,
        });
        reconcileDomCaretFromCore({
          session,
          caret: newCaret,
          scope: segEl,
          // ★ STEP②：boolean 与 base 同源
          ...surfaceBasePairFor(
            session.history.state.caret?.position?.paragraphId ?? null,
            segId,
            session.history.state.document
          ),
          markSynced: (applied) => {
            lastCoreSelectionSyncRef.current = `${segId}:${applied.start}`;
          },
        });
        noteCoreSessionChange("selection-change");
        console.log("[F3B-6.21-G3A] core-navigation", {
          key: event.key,
          paragraphId: caretPos.paragraphId,
          // `toOffset` = run 内相对 offset（既有诊断契约，保持不变）
          toOffset: next.offset,
          // `toParagraphOffset` = 段落内相对 offset（G9 新增，跨 run 时更可读）
          toParagraphOffset: step.paragraphOffset,
        });
        event.preventDefault();
        event.stopPropagation(); // 阻住同一 contentEditable 上的 legacy EditableTextNode.handleKeyDown 重复处理
        return;
      }

      // ★ F3B-6.21-G3-B：Core-owned segment surface 上的 Home/End caret navigation
      //   把 caret 移动的 ownership 从 Browser/DOM 转移到 Core（仅 collapsed caret）。
      //   - 与 G3-A 同门控/同段判定/同 Core→DOM 对账原语。
      //   - Home → paragraphOffsetToPosition(doc, paragraphId, 0)
      //   - End  → paragraphOffsetToPosition(doc, paragraphId, textUtf16Length)
      //   - 段落文本长度来自 **Core paragraph**（UTF-16，emoji 计 2），**绝不**从
      //     DOM textContent.length 反推（G2 锁定：DOM offset 不得回流 Core）。
      //   - 不做 visual-line Home/End、不跨 paragraph、不接 Shift+Home/End（G3-C）。
      //   - 边界（段落无 run / 段落缺失）⇒ fail-closed：no-op，不构造伪 caret、不 preventDefault。
      if (
        (event.key === "Home" || event.key === "End") &&
        !event.shiftKey &&
        !event.isComposing &&
        coreInputEnabled &&
        editingSegmentId !== null &&
        coreInputSessionRef.current
      ) {
        const target = event.target as HTMLElement | null;
        const segEl = target?.closest?.("[data-segment-id]") as HTMLElement | null;
        const segId = segEl?.getAttribute("data-segment-id") ?? null;
        if (!segId || segId !== editingSegmentId) return;
        const session = coreInputSessionRef.current;
        const document = documentOf(session);
        const caretPos =
          session.history.state.caret?.position ?? session.history.state.selection.range.focus;
        const textBox = findTextBox(document, caretPos.textBoxId);
        const paragraph = textBox ? findParagraph(textBox, caretPos.paragraphId) : null;
        if (!paragraph || paragraph.runs.length === 0) return; // ★ 段落缺失/无 run ⇒ fail-closed
        const textLen = getParagraphLength(paragraph); // ★ UTF-16 长度（emoji 计 2），源自 Core paragraph
        let next: ReturnType<typeof paragraphOffsetToPosition>;
        try {
          next =
            event.key === "Home"
              ? paragraphOffsetToPosition(document, caretPos.paragraphId, 0)
              : paragraphOffsetToPosition(document, caretPos.paragraphId, textLen);
        } catch {
          return; // ★ 解析失败 ⇒ fail-closed，不构造伪 caret / 不 preventDefault
        }
        // ★ CARET-LANDING (d)：**先**把导航目标 (paragraphId, offset) 换算成 unit offset。
        //   预检失败 ⇒ **整体 fail-closed**（Core 与 DOM 都不动、不 bump revision），
        //   避免「Core 已跳到段首/段尾、DOM 却没动」的不一致。
        const unitNow = unitSurfaceRef.current;
        const navOffset = event.key === "Home" ? 0 : textLen;
        const navMapped = unitNow
          ? mapCoreCaretToUnitOffset(unitNow.unit, caretPos.paragraphId, navOffset)
          : null;
        if (unitNow && (!navMapped || !navMapped.ok)) {
          noteCaretMappingFailure("nav-unit", navMapped ? navMapped.reason : "no-unit-map", {
            key: event.key,
            paragraphId: caretPos.paragraphId,
            navOffset,
          });
          return;
        }
        const newCaret = createCaret(next, "forward");
        session.history.updateSelection({
          selection: createCollapsedSelection(next),
          caret: newCaret,
        });
        if (unitNow && navMapped && navMapped.ok) {
          // ★ 走**既有** Core→DOM 唯一出口 `reconcileDomCaretAtOffset`，直接以 unit offset
          //   落位（`reconcileDomCaretFromCore` 只能「减 base」，无法表达 unit 内偏移叠加：
          //   那会把 `para_46:7` 错写成 DOM 7 而非 41）。
          const res = reconcileDomCaretAtOffset({
            scope: segEl,
            startOffsetUtf16: navMapped.unitOffset,
            markSynced: (applied) => {
              lastCoreSelectionSyncRef.current = `${segId}:${applied.start}`;
            },
          });
          if (!res.ok) {
            noteCaretMappingFailure("nav-reconcile", res.reason, {
              key: event.key,
              unitOffset: navMapped.unitOffset,
            });
            return;
          }
        } else {
          reconcileDomCaretFromCore({
            session,
            caret: newCaret,
            scope: segEl,
            // ★ STEP②：boolean 与 base 同源
            ...surfaceBasePairFor(
              session.history.state.caret?.position?.paragraphId ?? null,
              segId,
              session.history.state.document
            ),
            markSynced: (applied) => {
              lastCoreSelectionSyncRef.current = `${segId}:${applied.start}`;
            },
          });
        }
        noteCoreSessionChange("selection-change");
        console.log("[F3B-6.21-G3B] core-navigation", {
          key: event.key,
          paragraphId: caretPos.paragraphId,
          toOffset: event.key === "Home" ? 0 : textLen,
        });
        event.preventDefault();
        event.stopPropagation(); // 阻住同一 contentEditable 上的 legacy EditableTextNode.handleKeyDown 重复处理
        return;
      }

      // ★ F3B-6.21-G3-C：Core-owned segment surface 上的 Shift+Arrow **selection mutation**
      //   caret navigation（G3-A/B）→ selection mutation 的第一次升级；ownership 从 Browser/DOM 转移到 Core。
      //   - 仅 Shift+ArrowLeft/Right（Shift+Home/End / Ctrl+Shift / ArrowUp+Down / word/mouse 不在本边界）。
      //   - 与 G3-A/G3-B 同门控/同段判定/同 Core→DOM 对账原语（复用 G1 reconcileDomCaretFromCore 的 selection 入参）。
      //   - **anchor 永不因移动方向重新归一化**（G2 契约）：
      //       collapsed     → anchor = 当前 caret(==focus)，focus = 移动后的 focus；
      //       non-collapsed → anchor = 原 anchor，focus = 移动后的 focus（focus 恒为「移动端」）。
      //   - 步进原语 `extendSelectionWithinParagraph`（code-point 安全 + 段落内边界，绝不 offset±1 / glyphIndex / DOM 扫描）。
      //   - 边界（focus 已到段落首尾）⇒ fail-closed：保留原 selection（anchor 不动、focus 不动），
      //     并阻断原生（Core 为唯一真值）。
      //   - DOM 写入复用 G1 reconcileDomCaretFromCore({caret, selection})：它把 DOM 渲染归一化为 [min(a,f), max(a,f)]，
      //     但 **Core EditorSelection 仍保留原始 anchor/focus**（反向选择不丢真）。幂等键 `${segId}:${applied.start}`
      //     与 computeSegmentDomOffset 的 dedupe 口径一致（见 onSelectionChange），避免原生 selectionchange 回写环。
      if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        event.shiftKey &&
        !event.isComposing &&
        coreInputEnabled &&
        editingSegmentId !== null &&
        coreInputSessionRef.current
      ) {
        const target = event.target as HTMLElement | null;
        const segEl = target?.closest?.("[data-segment-id]") as HTMLElement | null;
        const segId = segEl?.getAttribute("data-segment-id") ?? null;
        if (!segId || segId !== editingSegmentId) return;
        const session = coreInputSessionRef.current;
        const document = documentOf(session);
        // ★ 读取当前 Core selection（collapsed 时 anchor==focus==caret；反向 selection 保留 anchor/focus 原序）
        //   ★ F3B-6.27-G9：`selection` 可能尚未播种（undefined）⇒ 用 caret 收敛出折叠 selection，
        //     避免解引用抛错（实测 `TypeError: reading 'range'`）并让 Shift+Arrow 仍然可用。
        const state = session.history.state;
        const anchorPos = state.caret?.position ?? state.selection?.range?.focus ?? null;
        if (!anchorPos) return; // 无可信 caret ⇒ fail-closed（不构造伪 selection）
        const selection = state.selection ?? createCollapsedSelection(anchorPos);
        // ★ F3B-6.27-G9：与 G3-A 同一边界 —— 段落内扩展，**不跨段落**
        //   （跨段落会把 selection 推到 DOM scope 之外的下一视觉行 ⇒ 与 G3-A 同一冻结机制）。
        const step = extendSelectionWithinParagraph({
          document,
          selection,
          direction: event.key === "ArrowLeft" ? "left" : "right",
        });
        if (!step) {
          // ★ 段首/段末 ⇒ 阻断原生（Core 为唯一真值，DOM 文本可能陈旧）
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        session.history.updateSelection({
          selection: step.selection,
          caret: step.caret,
        });
        reconcileDomCaretFromCore({
          session,
          caret: step.caret,
          selection: step.selection,
          scope: segEl,
          // ★ STEP②：boolean 与 base 同源
          ...surfaceBasePairFor(
            session.history.state.caret?.position?.paragraphId ?? null,
            segId,
            session.history.state.document
          ),
          markSynced: (applied) => {
            // 与 computeSegmentDomOffset 的 dedupe 口径一致：DOM range 的 start 偏移
            lastCoreSelectionSyncRef.current = `${segId}:${applied.start}`;
          },
        });
        noteCoreSessionChange("selection-change");
        console.log("[F3B-6.21-G3C] core-selection", {
          key: event.key,
          anchorOffset: step.selection.range.anchor.offset,
          focusOffset: step.selection.range.focus.offset,
          collapsed: selection.range.anchor.offset === selection.range.focus.offset,
        });
        event.preventDefault();
        event.stopPropagation(); // 阻住同一 contentEditable 上的 legacy EditableTextNode.handleKeyDown 重复处理
        return;
      }

      // 既有 Enter 处理（capture 阶段截住，只 stopPropagation、不 preventDefault）
      if (event.key !== "Enter" || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      const segmentId =
        target?.closest?.("[data-segment-id]")?.getAttribute("data-segment-id") ?? null;
      if (!segmentId || segmentId !== editingSegmentId) return;
      // 只截断派发；**不** preventDefault —— 让浏览器产生 beforeinput(insertParagraph)
      event.stopPropagation();
    };

    /**
     * #10：**真实** selection/caret 变化 → 同步 Core selection + bump revision。
     *
     * 不产生 mutation（`updateSelection` 不占 undo 步）。幂等键在**源头**做：
     * offset 未变 ⇒ 直接返回（不写 session、不 bump）⇒ 不存在反馈环。
     */
    const onSelectionChange = () => {
      if (!editingSegmentId) return;
      const session = coreInputSessionRef.current;
      if (!session) return;
      if (coreOwnedSegmentIdRef.current !== editingSegmentId) return;
      // ★ F3B-6.21-H1-B：优先解析**非折叠**段内 DOM 选区（range 同步）；
      //   折叠时 `computeSegmentDomRange` 仍返回 `{start:offset,end:offset}`，
      //   调用 `coreCaretOptionsFor` 时回退到 caret 路径。
      const domRange = computeSegmentDomRange(editingSegmentId);
      if (domRange === null) return; // DOM selection 不在本段 ⇒ 不属于本路径
      const key = `${editingSegmentId}:${domRange.start}:${domRange.end}`;
      if (lastCoreSelectionSyncRef.current === key) return; // ★ 幂等：未变化 ⇒ 不写、不 bump
      // ★ CARET-LANDING (c)：unit 面 ⇒ 同步路径同样由 **unit 坐标权威**解析
      //   （DOM offset 决定 paragraph，而非「上一次 Core caret 的 paragraphId」）。
      //   无 unit 面（单段 / legacy）⇒ 既有 `coreCaretOptionsFor` 语义逐字节不变。
      const unitNow = unitSurfaceRef.current;
      let options: ReturnType<typeof coreCaretOptionsFor> = null;
      if (unitNow) {
        const seeded = seedCaretOptionsForUnit({
          unit: unitNow.unit,
          document: documentOf(session),
          domOffset: domRange.start,
        });
        if (seeded.ok) {
          options = seeded.options;
        } else {
          noteCaretMappingFailure("sync-unit", seeded.reason, { domStart: domRange.start });
        }
      } else {
        options = coreCaretOptionsFor(session, editingSegmentId);
      }
      if (!options) return;
      session.history.updateSelection({ selection: options.selection, caret: options.caret });
      lastCoreSelectionSyncRef.current = key;
      noteCoreSessionChange("selection-change");

      // ★ F3B-6.27-G9：若本次 DOM→Core 映射发生**钳制**（陈旧 DOM 偏移越界），
      //   Core caret 已在真实末尾，而 DOM caret 还在陈旧区域 ⇒ 回写 DOM，
      //   维持「Core caret ⇄ DOM caret 一致」（否则点击定位不到、后续输入落错位置）。
      const divergence = seedDivergenceRef.current;
      if (divergence && divergence.segmentId === editingSegmentId) {
        seedDivergenceRef.current = null;        const scope = Array.from(
          document.querySelectorAll<HTMLElement>("[data-segment-id]")
        ).find((n) => n.getAttribute("data-segment-id") === editingSegmentId);
        if (scope) {
          reconcileDomCaretAtOffset({
            scope,
            startOffsetUtf16: divergence.localOffsetUtf16,
            markSynced: (applied) => {
              lastCoreSelectionSyncRef.current = `${editingSegmentId}:${applied.start}`;
            },
          });
        }
      }
    };

    // ⚠️ F3B-6.21-G1：此处**原有一个内联** `setDomCaretAtOffset`（自建 TreeWalker）。
    //   它已上提为 binding 的**唯一** Core→DOM 对账原语 `reconcileDomCaretAtOffset`
    //   （`./binding/core-dom-caret.ts`）：fail-closed + surrogate-safe + 回读自检。
    //   ⇒ 本文件**不得**再出现任何内联的 DOM caret walker（由 `core-dom-caret.test.ts` 守卫）。

    // ── F3B-6.21-E（D1–D7）：IME composition 接线 ─────────────────────────
    //   挂载层与 `beforeinput` / `keydown` **完全一致**（`root` native capture，D2），
    //   门控与段判定同源。链路：native composition event → `handleCoreComposition`
    //   → InputAdapter → CompositionTracker（**不绕过单一入口**，D1）。
    const compositionTargetOf = (
      event: Event
    ): { session: CoreInputSession; segmentId: string; el: HTMLElement } | null => {
      const el = event.target as HTMLElement | null;
      const segmentId = el?.closest?.("[data-segment-id]")?.getAttribute("data-segment-id") ?? null;
      if (!segmentId || segmentId !== editingSegmentId) return null;
      const session = coreInputSessionRef.current;
      if (!session) return null;
      return { session, segmentId, el: el as HTMLElement };
    };

    const onCompositionStart = (event: Event) => {
      // ★ 4B-4D-1：**先于所有 early return** 置位（含 `compositionTargetOf` 失败的情形）
      compositionActiveRef.current = true;
      const t = compositionTargetOf(event);
      if (!t) return;
      // D5 前置：`CompositionTracker.start` 捕获的是**当时**的 session selection/caret
      //   ⇒ 必须先把 session caret 播到组合插入点（与 beforeinput 路径同一播种入口）。
      const options = coreCaretOptionsFor(t.session, t.segmentId, t.el) ?? {};
      lastCompositionStartOffsetRef.current = computeSegmentDomOffset(t.segmentId, t.el);
      const outcome = handleCoreComposition(t.session, "start", "", options);
      // D3：start ⇒ 0 command / 0 history / 0 document mutation ⇒ **不 bump revision**
      if (outcome.ok && outcome.result.committed) {
        console.warn("[CORE-012E] compositionstart 不应产生 command");
      }
    };

    const onCompositionUpdate = (event: Event) => {
      const t = compositionTargetOf(event);
      if (!t) return;
      // D3：update ⇒ 0 command / 0 history / 0 document mutation（规范 §22）
      const outcome = handleCoreComposition(
        t.session,
        "update",
        (event as CompositionEvent).data ?? ""
      );
      if (outcome.ok && outcome.result.committed) {
        console.warn("[CORE-012E] compositionupdate 不应产生 command");
      }
    };

    const onCompositionEnd = (event: Event) => {
      // ★ 4B-4D-1：**先于所有 early return** 清位。
      //   本函数有 3 处early return（无 target / 未提交 / …），若在其后清位会漏。
      compositionActiveRef.current = false;
      const t = compositionTargetOf(event);
      if (!t) return;
      const data = (event as CompositionEvent).data ?? "";
      // D1.3（实测）：cancel **没有**独立 inputType，其形态是「compositionend 且 data 为空」
      const phase = data.length > 0 ? "end" : "cancel";

      // ★★ 2026-10-18（用户缺陷：IME 输入提交后新文本不显示 + 旧文本重影）──────────
      //   unit 面的组合提交**改走 unit route**（与键盘输入完全同一条码路），不再走
      //   下方单段 `handleCoreComposition`：后者只把文本提交进 Core，**不运行**
      //   C2/C3 提交层渲染 ⇒ overlay / 清除层 / span 隐藏 / mask 全不更新 ⇒
      //   提交后屏幕仍显示原文（canvas 原字 + 可见的旧 glyph span = 重影），
      //   新文本不可见（实测：Core 已有"测试"但 overlays=0、l10 span 可见且为原文）。
      //   做法（组合期间浏览器已把组合文本写进 DOM，与 Core 不同长 ⇒ 偏移不可直用）：
      //     ① DOM 回退到 unit 权威文本（`unitSurfaceRef` 镜像，= Core 当前文本）
      //     ② 选区落到组合起点（compositionstart 时捕获的 DOM offset）
      //     ③ 派发**合成** beforeinput(insertText) ⇒ unit route 全权处理
      //        （intent/plan/transaction/commit/C2/C3/F5 caret 恢复，与键盘同码）
      //   浏览器随后自身的 insertFromComposition 仍被上方 early-return 让位
      //   （不 preventDefault ⇒ DOM 交给 A′ 写入统一对账，绝不双提交）。
      //   ★ 任何前置不可信（无 unit 镜像 / 组合起点缺失或越界）或合成路径
      //     **未提交** ⇒ 回落既有单段 composition 路径（与修复前行为一致，绝不丢字）。
      const unitSurfaceElEnd = t.el.closest?.("[data-editing-unit-id]") as HTMLElement | null;
      if (unitSurfaceElEnd && data.length > 0) {
        const unitNow = unitSurfaceRef.current;
        const startOffset = lastCompositionStartOffsetRef.current;
        if (
          unitNow &&
          typeof startOffset === "number" &&
          Number.isInteger(startOffset) &&
          startOffset >= 0 &&
          startOffset <= unitNow.text.length
        ) {
          // ① 回退 DOM（组合期间被浏览器改过；幂等）
          if (t.el.textContent !== unitNow.text) t.el.textContent = unitNow.text;
          // ② 选区落到组合起点（折叠）
          try {
            const selEnd = typeof window !== "undefined" ? window.getSelection?.() ?? null : null;
            const firstText = t.el.firstChild;
            if (selEnd && firstText && firstText.nodeType === 3) {
              const rEnd = document.createRange();
              rEnd.setStart(firstText, Math.min(startOffset, firstText.textContent?.length ?? 0));
              rEnd.collapse(true);
              selEnd.removeAllRanges();
              selEnd.addRange(rEnd);
            }
          } catch {
            /* noop：选区失败 ⇒ 合成路径自行 fail-closed，回落下方单段路径 */
          }
          // ③ 合成 beforeinput ⇒ unit route（与键盘 insertText 同一处理器）
          const sizeBefore = t.session.history.size;
          try {
            t.el.dispatchEvent(
              new InputEvent("beforeinput", {
                inputType: "insertText",
                data,
                cancelable: true,
                bubbles: true,
              }),
            );
          } catch {
            /* noop */
          }
          if (t.session.history.size !== sizeBefore) {
            // ③b 合成路径已提交 ⇒ 清理 Core 组合态后返回（unit route 不消费
            //     CompositionTracker ⇒ 手动收口，否则 stale active 会让后续词删
            //     永久让位）。零文档变更。
            try {
              handleCoreComposition(t.session, "cancel");
            } catch {
              /* noop */
            }
            lastCompositionStartOffsetRef.current = null;
            return;
          }
          // ④ 合成路径未提交（unit route fail-closed）⇒ **不 return**，落入下方
          //    既有单段 composition 路径（共用收尾：commit + ownership 记账 + D6
          //    对账）——不重复任何 ownership 写入点（D10 守卫封闭集）。
        }
      }

      const outcome = handleCoreComposition(t.session, phase, data);
      if (!outcome.ok || !outcome.result.committed) {
        // 空组合 / cancel / 无 start 的 end ⇒ 0 command（无 Core mutation）⇒ 不 bump
        lastCompositionStartOffsetRef.current = null;
        return;
      }
      // Core mutation ⇒ 与 beforeinput / capability / segment 站点一致的归属记账 + revision
      exportOwnershipRef.current = "core";
      markMutationOwner("core");
      noteCoreSessionChange("core-mutation");

      // ── D6：DOM/Core reconciliation（第二入口的唯一消除手段，本轮**不**做 ownership-gated blur）
      //   组合期间浏览器已把组合文本写入 DOM（D1.2）；而 `segment.text` 是**未被 Core 写回**的旧值
      //   ⇒ 若不对账，blur 时 `textContent !== segment.text` 会再次触发 onChange
      //     → commitSegmentCanonical（= 第二入口；D1.4 实测 `blurProducedSegmentCoreCommit = true`）。
      //   做法：把 contentEditable 文本**回退为 `segment.text`**，并把 DOM caret 放回
      //   「组合起点 + 提交文本长度」⇒ 后续 beforeinput 播种仍取到正确 offset。
      //   ⚠️ 视觉无损：Core presentation active 时 DOM 文本已透明（domTextSuppressed）。
      const segment = (segmentsRef.current ?? []).find((s) => s.id === t.segmentId);
      const startOffset = lastCompositionStartOffsetRef.current;
      if (segment) {
        if (t.el.textContent !== segment.text) {
          t.el.textContent = segment.text;
        }
        if (startOffset !== null) {
          const logical = Math.min(startOffset + data.length, segment.text.length);
          // ★ F3B-6.21-G1：统一对账原语。`expectedText` = 上面刚回退到的 `segment.text`
          //   ⇒ 若此刻 DOM 已被别的路径改写 ⇒ `text-mismatch` ⇒ **不写**（fail-closed）。
          reconcileDomCaretAtOffset({
            scope: t.el,
            expectedText: segment.text,
            startOffsetUtf16: logical,
            markSynced: (applied) => {
              lastCoreSelectionSyncRef.current = `${t.segmentId}:${applied.start}`;
            },
          });
        }
      }
      lastCompositionStartOffsetRef.current = null;
    };

    root.addEventListener("keydown", onKeyDownCapture, true);
    root.addEventListener("beforeinput", onBeforeInput, true);
    root.addEventListener("compositionstart", onCompositionStart, true);
    root.addEventListener("compositionupdate", onCompositionUpdate, true);
    root.addEventListener("compositionend", onCompositionEnd, true);
    // ⚠️ `selectionchange` 派发在 **document**（不会冒泡到 root）⇒ 必须挂 document
    document.addEventListener("selectionchange", onSelectionChange, true);
    return () => {
      root.removeEventListener("keydown", onKeyDownCapture, true);
      root.removeEventListener("beforeinput", onBeforeInput, true);
      root.removeEventListener("compositionstart", onCompositionStart, true);
      root.removeEventListener("compositionupdate", onCompositionUpdate, true);
      root.removeEventListener("compositionend", onCompositionEnd, true);
      document.removeEventListener("selectionchange", onSelectionChange, true);
    };
  }, [
    coreInputEnabled,
    editingSegmentId,
    segments,
    computeSegmentDomOffset,
    coreCaretOptionsFor,
    noteCoreSessionChange,
    // ★ F3 Slice 2 的 unit surface 走 `unitSurfaceRef` 镜像（见下方声明处的 TDZ 注释），
    //   **刻意不进本 deps**：`explicitUnitSurface` 在本 effect **之后**才计算，
    //   放进 deps 会在 render 期触发 TDZ ReferenceError（整个 /editor 崩溃）。
  ]);

  const coreRenderSource = useMemo<CoreRenderSourceOutcome | null>(() => {
    // ══════════════════════════════════════════════════════════════════
    // ★★ F2.8（方案 A）：渲染源必须绑定**当前 Core Document 对象身份**。
    //
    // 缺陷（F2.7 定位）：分支判据此前是 `coreInputActive`，而它是
    //   `coreInputTick > 0 && session !== null`（:3356）——
    //   `coreInputTick` **只在 `noteCoreSessionChange("core-mutation")` 时 +1**，
    //   即它表达的是「是否发生过 Core mutation」，**不是**「是否有 session」。
    //   ⇒ 「已进入编辑、session 已建、但尚未提交任何 Core mutation」时
    //     `coreInputActive === false` ⇒ 渲染源走 012A 分支（legacy → Core **重新投影**），
    //     而 unit/单段几何消费者读的是 `documentOf(session)`（= import 期 Core 文档）。
    //     两个文档 **version 都是 1、页数/textBox 数相同，但 paragraph id 空间不相交**
    //     （实测 `para_1v/para_1y/21/24` vs `para_43/46`）
    //     ⇒ 按 paragraphId 跨文档取盒必然 miss（门 4953 fail-closed）。
    //
    // 修复：**身份优先**——只要当前持有 Core session，就以它持有的文档为唯一来源。
    //   ★ 刻意**不改** `coreInputActive` 的语义（它同时是渲染门控，
    //     `coreRenderEnabled = readCoreRenderFlag() || segmentCoreActive` 等处仍在用）。
    //
    // 行为等价性论证（逐条）：
    //   · 无 session            ⇒ 判据与旧 `coreInputActive` 同为 false ⇒ **逐字节不变**（仍 012A）
    //   · session 存在且 tick>0 ⇒ 旧判据已为 true ⇒ **逐字节不变**（仍 012C6，同一 session 文档）
    //   · 新覆盖的唯一区间      = 「session 存在但 tick===0」：此时 Core 文档 = import 期文档，
    //     且**不可能**已发生过 Core mutation（否则 tick>0）；若此前发生过 legacy mutation，
    //     `[editableDocVersion]` effect 已按 `shouldRehydrate()` 重新派生过 Core 文档
    //     ⇒ Core 文档即 legacy 的投影 ⇒ 内容一致，只是 identity 正确。
    // ══════════════════════════════════════════════════════════════════
    const f28SessionDoc = coreInputSessionRef.current
      ? documentOf(coreInputSessionRef.current)
      : null;
    // C6-A：session 已存在 → 渲染源**直接取自 session 文档**（绝不重新 import legacy）
    if (coreInputActive || f28SessionDoc) {
      const session = coreInputSessionRef.current;
      if (!session) return null;
      try {
const outcome = buildCoreRenderSourceFromDocument(f28SessionDoc ?? documentOf(session), {
          // Step 4：pdf.js fontId（style.sourceFontName）-> 真实字体 family。
          // 复用 bridge 既有的 fontIdentity.pdfjsFontFamilyOf，不新增 API；
          // 返回 undefined 即不覆盖（保留 Core 既有 fontFamily 为 fallback）。
          fontIdentity: {
            pdfjsFontFamilyOf: (_runId: string, style: { sourceFontName?: string }) => {
              const sfn = style?.sourceFontName;
              if (!sfn) return undefined;
              // ① 主路径（不变）：按 pdf.js fontId 查
              const byFontId = fontResolutionMapRef.current?.get(sfn);
              if (byFontId?.editableFontFamily) return byFontId.editableFontFamily;
              // ★ F3B-6.27-G3 修复：按 **PDF 字体名** 查（`FontResolution.pdfFontName`）。
              //   实测缺陷：`style.sourceFontName` 存的是 PDF BaseFont（含 subset prefix，如
              //   `NREKVL+FangSong_GB2312`），而 `fontResolutionMap` 的 key 是 pdf.js fontId
              //   （`g_d0_f3`）⇒ 两套命名空间对不上，主路径**对每个 Core run 都 miss**
              //   ⇒ 画布全部回落 sans；而透明点击层用原 PDF 字体 ⇒ 两套 advance metrics
              //   ⇒ 用户「按看到的字去点，光标落到另一个字符」。
              //   反查索引由 pdfFontNameIndexRef 维护（见其注释）。
              return pdfFontNameIndexRef.current?.get(sfn) ?? undefined;
            },
          },
          // ★ F3B-6.27-G3：**编辑后 run**（`sourceFontName` 丢失）的行级原字体回填。
          //   缺陷：编辑后画布用 sans、透明点击层用原 PDF 字体 ⇒ 两套 advance metrics
          //   不一致 ⇒ 用户「按看到的字去点，光标落到另一个字符」。
          //   行来源回溯（与导出路径 `lineSourceFallbackOf` 同款冗余）：
          //     ① import-time 快照按 paragraphId（replace 前后稳定）
          //     ② 同快照按结构位置 pageIndex:textBoxIndex:paragraphIndex（id 空间不一致时）
          //   命中后取**该行 legacy segment 的 fontResolution.editableFontFamily** ——
          //   与透明点击层（EditableTextNode 优先取同一字段）**必然同源**。
          //   ⚠️ 显示层专用，**不触碰 export provenance**（职责分离）。
          //   ⚠️ 不做「新字符是否在该子集字体中」的 coverage 判定（下一层 fallback 问题）。
          fontFamilyOfGeneratedLine: ({ paragraphId, pageIndex, textBoxIndex, paragraphIndex }) => {
            // 行来源回溯表：只取「带 lineId 的 run.source」，**每次重建渲染源时算一次**
            const src = (() => {
              const before = coreImportSnapshotRef.current;
              if (!before) return undefined;
              const pick = (obj: Record<string, unknown> | undefined, p: number, t: number) => {
                const paras = ((obj as { paragraphs?: Array<Record<string, unknown>> })?.paragraphs ??
                  []) as Array<{ id?: string; runs?: Array<{ source?: { blockId?: string; lineId?: string } }> }>;
                const para = paras[p];
                return para?.runs?.find((r) => r.source?.lineId)?.source;
              };
              const byId = (() => {
                for (let pi = 0; pi < before.pages.length; pi++) {
                  const objects = (before.pages[pi].objects ?? []) as Array<Record<string, unknown>>;
                  for (let ti = 0; ti < objects.length; ti++) {
                    const o = objects[ti];
                    if ((o as { type?: string })?.type !== "text") continue;
                    const paras = ((o as { paragraphs?: Array<Record<string, unknown>> }).paragraphs ??
                      []) as Array<{ id?: string; runs?: Array<{ source?: { blockId?: string; lineId?: string } }> }>;
                    for (let pii = 0; pii < paras.length; pii++) {
                      const s = paras[pii]?.runs?.find((r) => r.source?.lineId)?.source;
                      if (s?.lineId && paras[pii]?.id === paragraphId) return s;
                    }
                  }
                }
                return undefined;
              })();
              if (byId) return byId;
              // ② 结构位置
              const objects = (before.pages[pageIndex]?.objects ?? []) as Array<Record<string, unknown>>;
              return pick(objects[textBoxIndex], paragraphIndex, textBoxIndex);
            })();
            if (!src?.blockId || !src.lineId) return undefined;
            const seg = (segmentsRef.current ?? []).find(
              (s) => s.source?.blockId === src.blockId && s.source?.lineId === src.lineId
            );
            return seg?.fontResolution?.editableFontFamily ?? seg?.font?.family;
          },
          // Step 2: wire the diff-aware real per-glyph metrics into the Core visible layer.
          // Without this every TextBox falls back to createFallbackMetrics()
          // (advance = fontSize * 0.5 uniform), which is the recorded root cause of the
          // horizontal drift after an edit (see text-reflow-forensic.ts).
          metricsByTextBox: buildMetricsByTextBoxFromLegacy(
            editableDocumentRef.current as EditableDocument,
            documentOf(session)
          ),
        });
        if (!outcome.ok) {
          console.warn("[CORE-012C6] session 渲染源不可用，回退 legacy：", outcome.reason);
          return outcome;
        }
        console.log("[CORE-012C6] session 渲染源就绪", {
          documentVersion: documentOf(session).version,
          glyphs: outcome.stats.glyphs,
          multiParagraphTextBoxes: outcome.stats.multiParagraphTextBoxes,
          metricsFallbackTextBoxes: outcome.stats.metricsFallbackTextBoxes,
          advanceSources: outcome.stats.advanceSourceHistogram,
        });
        return outcome;
      } catch (error) {
        console.warn("[CORE-012C6] session 渲染源构造异常，回退 legacy：", error);
        return null;
      }
    }

    if (!coreRenderEnabled) return null;
    const doc = editableDocumentRef.current;
    if (!doc || editableDocVersion === undefined) return null;
    try {
      const outcome = buildCoreRenderSource(doc);
      if (!outcome.ok) {
        console.warn("[CORE-012A] Core 渲染源不可用，回退 legacy：", outcome.reason);
        return outcome;
      }
      console.log("[CORE-012A] Core 渲染源就绪", {
        pages: outcome.stats.pages,
        textBoxes: outcome.stats.textBoxes,
        layoutLines: outcome.stats.layoutLines,
        glyphs: outcome.stats.glyphs,
        wrappedParagraphs: outcome.stats.wrappedParagraphs,
        advanceSources: outcome.stats.advanceSourceHistogram,
        elapsedMs: Math.round(outcome.stats.elapsedMs * 10) / 10,
        warnings: outcome.warnings.slice(0, 5),
      });
      return outcome;
    } catch (error) {
      console.warn("[CORE-012A] Core 渲染源构造异常，回退 legacy：", error);
      return null;
    }
  }, [
    coreRenderEnabled,
    coreInputActive,
    coreInputTick,
    editableDocVersion,
    // ★ F2.8：session 建立（`noteCoreSessionChange("ownership-transfer")`）与换代
    //   只改 ref、不改 `coreInputTick` ⇒ 旧 deps 下本 memo 不会重算，渲染源会停留在
    //   「session 建立之前」的 012A 投影上。`coreSessionRevision` 对**所有**
    //   `noteCoreSessionChange` 调用单调 +1（:3393）⇒ 作为 identity 生命周期信号接入。
    //   ★ 复用既有信号，**不新增** generation 机制。
    coreSessionRevision,
  ]);

  const legacyRenderSource = useMemo(
    () => ({
      commands: glyphCommands ?? [],
      styles: editableDocumentRef.current?.styles ?? [],
    }),
    [glyphCommands, editableDocVersion]
  );

  const renderSource = useMemo(
    () => selectRenderSource(coreRenderEnabled, legacyRenderSource, coreRenderSource),
    [coreRenderEnabled, legacyRenderSource, coreRenderSource]
  );

  // ══════════════════════════════════════════════════════════════════════
  // ★ F3B-6.27-GEO（Goal 2 几何）：用 **Core layout 的视觉行并集** 替换 legacy 行盒
  //
  // 缺口（截图实证）：`editedLineBoxes` 的 **identity 正确、geometry 错误**。
  // legacy 只能描述**编辑前的一条** PDF line；Core mutation 后同一段可能绘制成
  // **多条** visual lines ⇒ 单行高白罩盖不住折行部分 ⇒ 原 PDF 末字透出（实测残留「厅」）。
  //
  // 数据源（已只读确认）：
  //   · `outcome.layouts[i].paragraphs[j].lines[k].box` = **reflow 后**的视觉行矩形
  //     （`runLiveReflow` 第 ③ 步基于 **after document** 布局 ⇒ 含折行）
  //   · 坐标系 = **Page Canvas Space**（`baseline` 注释明写），与既有 `editedLineBoxes`
  //     **同空间** ⇒ **无需 scale / transform 换算**
  //   · `layout.documentVersion` 作 generation 令牌（真实值，非编造）
  //
  // 边界：
  //   · **只换盒子，不改 lineId identity**、不改 `segments`、不放宽 E2
  //   · Core geometry 有效 ⇒ 只用 Core（**不与 legacy 求并集**，否则 Core 缩短后
  //     旧高度无法收缩）；Core geometry 缺失/陈旧 ⇒ **保留 legacy 盒**（fail-open）
  //   · 纯派生：不新增 state、不改 `editedLineBoxes` state
  // ══════════════════════════════════════════════════════════════════════
  // ── F3B-6.27 Step 2：编辑面几何（Core → CSS 像素，纯派生）────────────────
  //   ★ 仅当当前编辑段所属 Core 段落被 `runLiveReflow` 折成**多行**时才产出；
  //     单行 ⇒ null ⇒ EditableTextNode 走原路径 ⇒ 行为逐字节不变（E8）。
  //   为什么只在多行时启用：单行时 DOM 文本 = Core 段落文本（连续），段内 offset
  //   换算与既有 A′ 同步完全一致 ⇒ 零映射改动、零 caret 风险。
  //   几何**只来自 Core**（reflow 后的 `lines[].box`），绝不由 DOM 测量反推。
  //   ⚠️ 跨段落（一个编辑面覆盖多个 Core paragraph）不在本步：那需要 synthetic
  //      "\n" 与 DomOffsetMap，属后续 mutation 整合范围。
  // ★★ P0-F1 · Explicit EditingUnit surface（D3 = C：**生产不 resolve unit**）
  //
  //   唯一来源 = `window.__f1EditingUnit`（harness only，缺省 undefined ⇒ 本 useMemo
  //   恒返回 null ⇒ **生产逐字节不变**，F1.9/G5 成立）。
  //
  //   ★ 注入内容**只有身份**（unitId + paragraphIds），**没有文本**：
  //     unit 文本由 P0-A `buildEditingUnit` 从 **Core 真实段落文本**派生。
  //   ★ 几何走 P0-C `createEditingUnitSurface`（D1 = A，不新建第二套几何），
  //     再经 P0-F1 适配层补上既有语义所需的 `constraint` 与 `coreBottom` 求交。
  //   ★ **不做任何检测**：不猜「哪些 paragraph 属于同一 unit」。
  //   ★ 任一环节失败 ⇒ null ⇒ 逐字节回退到既有单 paragraph 面（G5）。
  const explicitUnitSurface = useMemo(() => {
    if (!coreInputEnabled || !editingSegmentId) return null;
    if (!coreRenderEnabled) return null;
    // ★ F3B-6.28 · B2/B3：unit 来源从「仅显式注入」扩展为「注入 **或** 受控 resolver」。
    //   ★ 2026-10-15：gate 缺省 ON（`!== false`）—— 入口连接逻辑段落模型（用户验收
    //   裁决：步骤 2 失败 ⇒ 优先修复入口与模型的连接）。显式 `=== false` = 回滚。
    //   resolver 仍 fail-closed：目标行属于 P0 **confirmed 多行组**才产出 unit 来源；
    //   单行 / unknown / 成员定位失败 ⇒ 维持单段落路径（行为逐字节不回退）。
    //   优先级：显式注入（harness 兼容）> 受控 resolver；两者皆无 ⇒ 无 unit 面。
    const injected = readExplicitEditingUnit();
    let unitSource: { unitId: string; paragraphIds: readonly string[]; separator: string } | null = injected;
    if (!unitSource && typeof window !== "undefined" && (window as unknown as Record<string, unknown>).__unitEditing !== false) {
      // ★★ 2026-10-19（用户缺陷「翻到第 2 页就不能按段落编辑了」）：行特征收集必须
      //   **跟随当前显示页**。旧调用缺省 pageIndex=0 ⇒ 只收集第 1 页的行 ⇒ 第 2..N 页
      //   的 targetLineId 在特征集里找不到 ⇒ gate `target-not-found` fail-closed ⇒
      //   恒回落单段面（unitId=null）⇒ ① 编辑面退化为 wholeParagraph 单段（无 unit
      //   连续编辑视图）；② 提交不走 unit route ⇒ C2/C3 提交层不渲染（实测第 2 页
      //   编辑提交后 masks=0、overlays=0，与 IME 缺陷同族）。
      // ★★ 2026-10-23（用户缺陷「非表格段落编辑态不能识别段落，编辑面只覆盖单行」）：
      //   `page - 1` 当作 **pages 数组下标**在懒渲染下是错的——legacy.pages 按
      //   **渲染/导航顺序**增长（实测翻 12 → 4 后 pages=[p1, p4, p12]）⇒ 下标 3 取到
      //   undefined（或错误页）⇒ 特征集为空/错页 ⇒ gate `target-not-found` ⇒ 单段面。
      //   修复 = 按 **page.index 身份**解析数组下标（与 `documentPageLineIds` 同口径）。
      //   `page` 为 1-based 显示页；`EditablePage.index` 同为 1-based。
      const legacyDocForGate = editableDocumentRef.current;
      const gatePageArrayIdx = legacyDocForGate?.pages?.findIndex((pg) => pg.index === page) ?? -1;
      const gateFeatures = collectLineFeatures(legacyDocForGate, gatePageArrayIdx);
      const targetLineId =
        (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId)?.source?.lineId ?? null;
      if (targetLineId) {
        const gate = resolveControlledUnitGate(gateFeatures, targetLineId, true, (lid) => {
          // coreDoc 在下方才定义 ⇒ 此处用 ref 兜底（与 5401 同口径）
          const gateDoc = (coreInputSessionRef.current ? documentOf(coreInputSessionRef.current) : coreDocumentRef.current) as never;
          // ★ C3（SPEC v2.1）：先 findTextBoxBySourceLineId（**本体不动**；多段声称时
          //   仍取首个命中 ⇒ split 场景行为逐字节不变）；仅**真正缺失**才走统一解析入口
          //   （歧义立即失败；ledger 只补 not-found，命中 ⇒ 该成员行恢复定位）。
          const direct = findTextBoxBySourceLineId(gateDoc, lid);
          if (direct) return direct.paragraphId;
          const recovered = resolveParagraphIdForLine(
            gateDoc,
            lid,
            unitIdentityLedgerRef.current,
            sidecarGenerationRef.current,
          );
          return recovered.ok ? recovered.paragraphId : null;
        });
        if (gate.ok) {
          unitSource = { unitId: gate.source.unitId, paragraphIds: gate.source.paragraphIds, separator: gate.source.separator };
        }
      }
    }
    // ★ F3B-6.28：coreDoc 提前取（提前取值不改变既有语义：unitSource 为空时
    //   最终仍 return null）。
    const session = coreInputSessionRef.current;
    const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
    if (!coreDoc) return null;

    // ── ★ F3B-6.28：表格 cell 编辑单元（**仍未接线**；S0/S1 结论见下）──────────
    //   用户裁决（2026-10-20）：「表格的识别不能按段落来，应该按表格格子来识别，
    //   一个格子相当于一个段落」。
    //
    //   已确证的事实（真实取证 `cases/gd-swim-2026.pdf` 第 11 页）：
    //   · 表格行在 legacy 层是**一条 visual line**（= 1 Core paragraph），其文本 =
    //     多个 cell 用空白 operator 拼接 ⇒ Core 侧 cell 只是 **paragraph 的子区间**
    //     （UTF-16 区间），不是新 paragraph ⇒ 契约层已支持（editing-unit.ts 的
    //     `paragraphStartUtf16`，缺省 0 ⇒ 既有行为逐字节不变）。
    //   · 表格行**不参与逻辑段落跨行合并**（logical-paragraph-contract 的
    //     `table-row-not-merged` 守卫）⇒ 编辑面不再横跨多行表格（已实测）。
    //
    //   ★★ S0 只读调查（2026-10-20，tests/s0/ 探针）**更正了本注释此前的错误记载**：
    //     旧文案称「`groupIntoLines` 把表格行拆成每 cell 一个 LineGroup ⇒
    //     `segment.source` 是 cell 内索引 ⇒ 两个索引口径冲突」——**该解释被实测否定**：
    //       · 同 pdfY 多 LineGroup = 空（表格行全部是单一 LineGroup，最大间隙比 0.69
    //         < 拆行阈值 3×fontSize）；pdf-importer 文档与 SegmentBuilder lines 逐行
    //         一致（26=26，行 ID/文本全同）；
    //       · `computeSourceGlyphRange` 遍历**整个 LineGroup** ⇒ source 区间本就是
    //         **行内** glyph 区间；全部 19 行字符级校验 100% 通过（区间切片 === 文本）。
    //     ⇒ 「索引体系冲突」不是真因；问题被重新定位为 **segment 如何唯一归属 cell**。
    //     当年浏览器观测（点 "24.50" 编辑面落在 "50米自由泳"）属实，但其根因**未能
    //     恢复**（接线代码已回退，不可考）——此处**不得**写成已确认的替代根因。
    //
    //   ★ S1 已完成（纯契约，未接生产）：`binding/table-cell-resolver.ts`
    //     `resolveSegmentCell` 按**区间包含关系**唯一归属 cell（一个 cell 可含多个
    //     segment——真实表头行 7 segment ↔ 6 cell）；多重/跨 cell/越界/来源不一致
    //     一律 fail-closed；零 indexOf、零文本匹配、零 ordinal。契约测试
    //     `table-cell-resolver.test.ts` 25/25（含真实 fixture 端到端：l11 七列依次
    //     归属 cell 0..6）。
    //     已知残留分歧（S0 实证，接入前需处理）：
    //       · segment 边界（gap>0.4×fontSize）≠ cell 边界（gap≥中位列宽×0.5）⇒
    //         segment 严格细于或等于 cell ⇒ 必须按包含关系，严禁 ordinal；
    //       · `lineGlyphsFor` 读**活** legacy 行：Legacy fallback 重写后 segment.source
    //         陈旧 ⇒ 解析器以 import 期 originalText 做位置内容证明予以拒绝（D3）；
    //       · 宽间隙表格（gap>3×fontSize）会被拆行 ⇒ 届时 cell = 独立行，cell 检测
    //         按行级 fail-closed（D2 负向）⇒ 跨文档通用性需单独评估。
    //     ⇒ 接入生产 cell 编辑路径属 S2，需独立授权；在本注释被替换前，此处维持
    //       既有整行/unit 行为不变。
    //
    // ── ★ F3B-6.28 · S2-v1 接线（用户 2026-10-20 授权；S3 浏览器验收未授权）──────
    //   门链（`binding/table-cell-unit.ts` 纯契约，22/22）：
    //     门 1 `resolveSegmentCell`（S1 区间包含唯一归属 + legacy 轴位置证明）；
    //     门 2 `resolveSegmentParagraphRange`（glyph 区间 → Core run 包含关系）；
    //     门 3 Core 轴位置证明（`coreText.slice(cell) === legacyGlyphSlice(cell)`）。
    //   ★ 门 2 是首轮接线**天然 fail-closed** 的关键：Core 编辑会把行内单 run 的
    //     glyph 索引 strip（helpers §25）⇒ 包含关系不再成立 ⇒ 回落整行。即 S2-v1
    //     语义 = **每行首个 cell 编辑**（同行连续编辑属 S2-v2/v3，未授权）；
    //     该行为由 R6 用**真实 ReplaceTextCommand + applyCommand** 证明，不是假设。
    //   ★ 门 3 把「两套文本坐标一致」变成显式校验：前格变长编辑 ⇒ 后续格
    //     `core-axis-drift` 回落，绝不静默错格；同长编辑 ⇒ 未受影响格仍可建面。
    //   ★ 生产门 `readCellUnitEditingFlag()`（2026-10-22 · C 方案：**缺省 ON** ⇒
    //     表格行点击即建 cell 面；显式 `false` / localStorage "0" = 回滚通道；
    //     SSR/无宿主 ⇒ OFF）。S3 全链验收（含 T9 连续输入）通过后翻转缺省值。
    //   ★ cell 面几何 = cell 墨迹盒（legacy glyph bbox 并集；S0 实测与 Core 行盒
    //     同空间同尺度）⇒ 面只覆盖该格 ⇒ 点击其他格命中各自 segment（targeting 正确）。
    //     约束宽 = cell 盒宽（**不得**继承行约束宽，否则面覆盖整行）。
    //   ★ 提交层列对齐（C3 flow 重绘会破坏表格列位）是**独立立项**，不在 S2 范围。
    // ★★ F3B-6.28 · S2-v3：cell 面稳定锚（契约 §3.2 memo 求值顺序）
    //   ① 门 1 提前（`probeCellEntry`：detectTableCells + resolveSegmentCell，纯 legacy 轴）；
    //   ② active 锚 + (lineId, cellIndex) 键匹配 ⇒ `revalidateCellAnchor`（C1→C2→C3→C5→C4），
    //      **跳过门 2/门 3**——门 2（run 包含关系）正是提交后必然失效的那个门（D1 根因）；
    //   ③ 无有效锚 ⇒ 完整门链 `planCellUnit`（fresh entry；锚由锚 effect 从本面晋升）。
    //   ⚠️ 派生值（cellText/cellLen）只作为面构造输入，绝不回写锚（契约 §2.7）。
    //   ⚠️ 锚的晋升/失效/退出判定全部在锚 effect（自包含：从已提交面 + 探针推导）——
    //      不经 memo 返回值传递（memo 无面时 early-return null 会丢载荷）。
    let cellPlan: CellUnitPlanOutcome | null = null;
    let cellAnchorDerived: CellAnchorDerived | null = null;
    const anchorNow = cellAnchorRef.current;
    if (!unitSource && readCellUnitEditingFlag()) {
      const probe = probeCellEntry(editingSegmentId);
      if (probe && anchorNow && probe.lineId === anchorNow.lineId && probe.cellIndex === anchorNow.cellIndex) {
        const revalidated = revalidateCellAnchor({
          anchor: anchorNow,
          document: coreDoc,
          documentGeneration: sidecarGenerationRef.current,
          coreOwned: coreInputSessionRef.current != null && exportOwnershipRef.current !== "legacy",
          entrySegment: probe.entrySegment,
          rowGlyphs: probe.rowGlyphs,
          rowSegments: probe.rowSegments,
          cells: probe.cells,
        });
        if (revalidated.ok) cellAnchorDerived = revalidated.derived;
      }
      if (!cellAnchorDerived) {
        cellPlan = probe
          ? planCellUnit({
              enabled: true,
              segment: probe.entrySegment,
              // 行 glyph = 该 lineId 的**当前** legacy 行序列（Core ownership 下 = import 期）
              rowGlyphs: probe.rowGlyphs as never,
              rowSegments: probe.rowSegments,
              document: coreDoc,
              // ★ 2026-10-24：cell 编辑台账——该行有过 cell 提交（run 被 strip）时，
              //   门 2 失败后按台账重建映射（同行第二格/再编辑的核心修复）。
              editLedger: cellEditLedgerRef.current.recordsOf(probe.lineId),
            })
          : { ok: false, reason: "missing-segment" };
      }
    }
    // 统一面来源：锚派生面（与 CellUnitPlan 同构的「虚拟计划」）或门链计划。
    //   unitId 与门链的确定性派生（`unit:cell:${lineId}:${cellIndex}`）逐字节一致
    //   ⇒ 跨提交单位身份稳定 ⇒ F5 pending caret 的 unitId 匹配不受影响。
    const cellAnchorSurface: CellUnitPlan | null =
      cellAnchorDerived && anchorNow
        ? {
            unitId: `${CELL_UNIT_ID_PREFIX}${anchorNow.lineId}:${anchorNow.cellIndex}`,
            anchor: {
              lineId: anchorNow.lineId,
              blockId: anchorNow.blockId,
              paragraphId: anchorNow.paragraphId,
              cellIndex: anchorNow.cellIndex,
            },
            textBoxId: anchorNow.textBoxId,
            cellStartUtf16: cellAnchorDerived.pStartUtf16,
            cellEndUtf16: cellAnchorDerived.pEndUtf16,
            cellText: cellAnchorDerived.cellText,
            cellBox: anchorNow.cellBox,
          }
        : null;
    const cellUnit = cellPlan && cellPlan.ok ? cellPlan.plan : cellAnchorSurface;
    if (!unitSource && !cellUnit) return null;
    // ★ S2-v1：unit 来源别名（多行 unit 注入/受控 gate 优先；cell unit 为单段形态）。
    //   cell 分支：paragraphIds = [该格所属段落]，separator 不适用（单行无分隔）。
    const us: { unitId: string; paragraphIds: readonly string[]; separator: string } = unitSource
      ? unitSource
      : {
          unitId: cellUnit!.unitId,
          paragraphIds: [cellUnit!.anchor.paragraphId],
          separator: "\n",
        };
    // ★★ F3-b1-B：unit surface 的几何**不再**以 `coreRenderSource.layouts` 为唯一来源。
    //   实测（真实 Chromium，跨段 replacement）：编辑后 `src.ok` 可能为 false（空段落让
    //   render source 构建失败）⇒ 旧硬门 `if (!src || !src.ok) return null;` 会让
    //   **unit 面与单段面同时消失**（实测 unitAttr 1→0、singleGeom=null）。
    //   ⇒ 这里只把它降级为「首选几何来源」：`src` 不可用时改走 P0-E1 rebind 自带的 layout
    //   （rebind 内部调用**同一个** `layoutTextBox`，不是第二套几何算法 —— 与既有单段面
    //   5166 现算回退同族）。
    const src = coreRenderSource;
    const srcLayouts: ReadonlyArray<{
      constraintBox?: { width?: number };
      paragraphs: ReadonlyArray<{
        paragraphId: string;
        box?: { y?: number };
        lines: ReadonlyArray<{ box: { x: number; y: number; width: number; height: number } }>;
      }>;
    }> = src && src.ok ? src.layouts : [];

    // ① 文本真值 = Core 真实段落文本（注入不含文本）
    const segBlockId = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId)?.source
      ?.blockId;
    if (typeof segBlockId !== "string" || !segBlockId) return null; // fail-closed：无 blockId 不建面
    const lineInputs: Array<{
      lineId: string;
      textBoxId: string;
      paragraphId: string;
      text: string;
      paragraphStartUtf16?: number;
    }> = [];
    for (const pid of us.paragraphIds) {
      // ★ 文本真值 = **Core 真实段落文本**（注入不含文本）。
      //   按 paragraphId 定位其所属 TextBox（与本文件 4756 既有遍历同构）。
      let textBoxId = "";
      let text = "";
      let lineId = "";
      for (const page of (coreDoc as unknown as { pages?: Array<{ objects?: unknown[] }> }).pages ?? []) {
        for (const obj of (page.objects ?? []) as Array<{ type?: string; id?: string; paragraphs?: unknown[] }>) {
          if (obj.type !== "text" || !Array.isArray(obj.paragraphs)) continue;
          const para = obj.paragraphs.find(
            (p) => (p as { id?: string }).id === pid
          ) as { runs?: Array<{ text?: string; source?: { lineId?: string } }> } | undefined;
          if (!para) continue;
          textBoxId = obj.id ?? "";
          for (const r of para.runs ?? []) {
            text += r.text ?? "";
            if (!lineId && r.source?.lineId) lineId = r.source.lineId;
          }
          break;
        }
        if (textBoxId) break;
      }
      if (!textBoxId) return null; // fail-closed：注入的 paragraph 不存在
      // 编辑后 lineId 可能已丢失（P0-D2 实测）⇒ 用 P0-A 唯一合成规则
      if (!lineId) lineId = syntheticLineIdOf(pid);
      lineInputs.push({
        lineId,
        textBoxId,
        paragraphId: pid,
        // ★ S2-v1：cell 面文本 = 该格**当前 Core 切片**（规划器门 3 已证其与 legacy
        //   位置切片逐字节一致 ⇒ 区间可原样透传；此处绝不回退到整段文本）。
        text: cellUnit ? cellUnit.cellText : text,
        // ★ paragraphStartUtf16 只表示段落内起始位置（既有语义）；身份由门 1/2 保证，
        //   不用它弥补身份不确定性。
        ...(cellUnit ? { paragraphStartUtf16: cellUnit.cellStartUtf16 } : {}),
      });
    }
    const built = buildEditingUnit({
      unitId: us.unitId,
      blockId: segBlockId,
      // ★ S2-v1：cell unit = 单行（visual-line）；多行 unit 保持 explicit-multi-line。
      kind: cellUnit ? "visual-line" : "explicit-multi-line",
      lines: lineInputs,
      separators: lineInputs.slice(0, -1).map((l) => ({ afterLineId: l.lineId, text: us.separator })),
    });
    if (!built.ok) return null;
    const unit = built.unit;

    // ② 几何（**首选**：`coreRenderSource.layouts`；缺失时走 ③ 的 rebind 自带 layout）
    const geos: Array<{ lineId: string; box: { x: number; y: number; width: number; height: number } }> = [];
    let constraint = 0;
    let missingBox = false;
    for (const l of lineInputs) {
      let box: { x: number; y: number; width: number; height: number } | null = null;
      // ★ S2-v1：cell 面几何 = cell 墨迹盒（legacy glyph bbox 并集；S0 实测与 Core
      //   行盒同空间同尺度）⇒ 面只覆盖该格 ⇒ 点击其他格命中各自 segment。
      //   **不**走 srcLayouts 的行盒（那是整行盒）——否则面覆盖整行、targeting 错格。
      if (cellUnit) {
        box = {
          x: cellUnit.cellBox.x,
          y: cellUnit.cellBox.y,
          width: cellUnit.cellBox.width,
          height: cellUnit.cellBox.height,
        };
      } else {
        for (const layout of srcLayouts) {
          const cb = layout.constraintBox;
          if (cb && typeof cb.width === "number" && cb.width > constraint) constraint = cb.width;
          for (const p of layout.paragraphs ?? []) {
            if (p.paragraphId !== l.paragraphId) continue;
            const first = (p.lines ?? [])[0];
            if (first?.box) box = { x: first.box.x, y: first.box.y, width: first.box.width, height: first.box.height };
          }
        }
      }
      if (!box) {
        missingBox = true;
        break;
      }
      geos.push({ lineId: l.lineId, box });
    }
    // ★ S2-v1：cell 面换行约束宽 = cell 盒宽。**不得**继承行约束宽（srcLayouts 的
    //   constraintBox ≈ 栏宽）——否则适配层把面宽撑到整行 ⇒ 点击 targeting 错格。
    if (cellUnit) constraint = Math.max(0, geos[0]?.box.width ?? 0);


    // ③ ★ F3-b1-B：rebind 路径（自带 layout；不依赖 coreRenderSource）
    //   触发条件：首选来源缺盒（编辑后空段落 / render source 不可用）。
    //   ★ 身份锚点仍是 **paragraphId**（P0-E1 硬约束 ①）；lineId 丢失时 rebind 自建
    //     `syn:<paragraphId>`（provenance = synthetic）。
    //   ★ `unitBefore` 传当前 unit：rebind 的 `textBefore/changed` 对本处只是信息项，
    //     我们只消费它的 `unit`（新文本）与 `geometry`（新行盒）。
    let unitForGeometry = unit;
    let geosForGeometry = missingBox ? [] : geos;
    let constraintForGeometry = constraint;
    if (missingBox) {
      // ★ rebind 内部会调 Core layout；任何异常都必须 **fail-closed**（返回 null ⇒ 无面），
      //   **绝不允许**把异常抛出 useMemo —— 那会让 React 卸载整棵树（实测：点 Edit 后
      //   整个 segment 层消失，contenteditableCount=0 / totalSegNodes=0）。
      let rebound: ReturnType<typeof rebindEditingUnit> | null = null;
      try {
        const entries = session?.history?.entries?.() ?? [];
        const lastTx = entries.length > 0 ? entries[entries.length - 1] : null;
        const beforeDoc =
          (lastTx as { before?: { document?: EditorDocument } } | null)?.before?.document ?? coreDoc;
        rebound = rebindEditingUnit({
          documentBefore: beforeDoc,
          documentAfter: coreDoc,
          unitBefore: unit,
          separator: us.separator,
          generation: coreDoc.version,
          currentGeneration: coreDoc.version,
        });
      } catch (e) {
        rebound = null; // fail-closed：拿不到 rebind ⇒ 无面（退化到既有单段面/无面）
      }
      
      if (!rebound) return null;
      if (!rebound.ok) return null; // fail-closed：两条几何来源都拿不到 ⇒ 无面
      const byParagraph = new Map(rebound.rebind.geometry.lines.map((g) => [g.paragraphId, g]));
      const mapped: typeof geosForGeometry = [];
      let rebindConstraint = 0;
      for (const l of rebound.rebind.unit.lines) {
        const g = byParagraph.get(l.paragraphId);
        if (!g) return null; // fail-closed：rebind 几何缺行
        mapped.push({ lineId: l.lineId, box: { x: g.box.x, y: g.box.y, width: g.box.width, height: g.box.height } });
        if (typeof g.contentWidth === "number" && g.contentWidth > rebindConstraint) {
          rebindConstraint = g.contentWidth;
        }
      }
      if (mapped.length !== rebound.rebind.unit.lines.length) return null;
 unitForGeometry = rebound.rebind.unit;
      geosForGeometry = mapped;
      constraintForGeometry = rebindConstraint;
    }

    const unitSurface = createEditingUnitSurface({
      unit: unitForGeometry,
      geometries: geosForGeometry,
      generation: coreDoc.version,
      currentGeneration: coreDoc.version,
    });
    
    if (!unitSurface.ok) return null;

    // ④ 适配层：补 constraint 与「与下一 Core paragraph 求交」（既有 4989-5035 语义）
    const unitBottom = unitSurface.surface.box.y + unitSurface.surface.box.height;
    const lineHeight = Math.max(2, ...geosForGeometry.map((g) => g.box.height || 0));
    // ★ 2026-10-18（用户缺陷「编辑框内两行行距太近」）：unit 面行距 = 相邻成员行
    //   Core 行盒 y 差（与 legacy bbox 同一空间；提交层 flow 的 usedLineGap 同源同值）。
    //   实测 l5→l6 = 41.97px，而继承自 baseStyle 的 lineHeight:1 只有 21.46px。
    //   ≥2 成员才可取（单成员面无相邻差 ⇒ 不传 ⇒ 单段/单成员面逐字节不变）。
    const unitLineGap =
      geosForGeometry.length >= 2
        ? Math.max(0, geosForGeometry[1]!.box.y - geosForGeometry[0]!.box.y)
        : 0;
    const candidateTops: number[] = [];
    if (missingBox) {
      // rebind 路径：候选顶来自 rebind 自己的行盒（Core 空间），不读 render source
      for (const l of unitForGeometry.lines) {
        const g = geosForGeometry.find((x) => x.lineId === l.lineId);
        if (g) candidateTops.push(g.box.y);
      }
    } else {
      for (const layout of srcLayouts) {
        for (const p of layout.paragraphs ?? []) {
          const ty = p.box?.y ?? 0;
          if (Number.isFinite(ty)) candidateTops.push(ty);
        }
      }
    }
    // ══ Reflow 4B-4D-2A · Gate A · Core visual partition（**纯读**，只走 4A 路径）══════
    //   数据源：**既有** `coreRenderSource.layouts`（B1 已实测含 para_43/para_46）。
    //   ★ 不接 P0-E2-A（它冻结为零生产接线，守卫 E2-A8b 不动；该守卫是朴素文本匹配）。
    //   ★ 任一环 fail-closed ⇒ `partition = null` ⇒ **不注入任何 `<br>`**（绝不部分注入）。
    let partition: LogicalLinePartition | null = null;
    // ★ S2-v1：cell 面**不**走 partition（其输入是整段的视觉行，与 cell 面文本不同源）
    //   ⇒ 不注入任何 `<br>`，断行交回 unit 面自然换行（白空间 normal）。
    if (!cellUnit) {
      try {
        const proj = projectCoreVisualLines({
          layouts: srcLayouts,
          paragraphIds: us.paragraphIds,
        });
        if (proj.ok) {
          const widthByTb: Record<string, number> = {};
          for (const g of proj.paragraphs) widthByTb[g.textBoxId] = g.constraintBox.width;
          const vis = buildSurfaceVisualGeometry({
            unit: unitForGeometry,
            visualLines: proj.lines,
            constraintWidthByTextBox: widthByTb,
          });
          if (vis.ok) {
            const part = buildLogicalLinePartition({
              unit: unitForGeometry,
              paragraphs: vis.geometry.groups,
            });
            if (part.ok) partition = part.partition;
          }
        }
      } catch {
        partition = null;
      }
    }

    // ④ 适配层：补 constraint /「与下一 Core paragraph 求交」/
    //    ★ 4B-4D-3：Core logical flow 高度下界（**抬升 coreBottom**，不改 P0-C）
    const adapted = adaptUnitSurfaceToEditingGeometry({
      unitSurface: unitSurface.surface,
      unitId: us.unitId,
      constraintWidth: constraintForGeometry,
      candidateTops,
      lineHeight,
      // ★ unit 面必须**至少**覆盖 Core logical flow（Σ flow line 行高，含 separator）。
      //   partition 为 null（fail-closed）⇒ 不传 ⇒ 逐字节保持既有行为。
      flowHeight: partition?.totalFlowHeight,
      // ★ 2026-10-18（行距修复）：行距 + 行距高度下界（见适配层 lineGap 文档）。
      lineGap: unitLineGap > 0 ? unitLineGap : undefined,
    });

    if (!adapted.ok) return null;

    // ★ R3（登记档案 §5.3.2.3）：unit 几何 paragraphId **跟随有效编辑目标**（身份/几何分离的
    //   DOM 标记修正）。目标段落属于本 unit ⇒ 用它；否则保持适配层 `paragraphIds[0]`。
    //   非空态：redirect 触发 ⇒ 目标被重建为**首成员段** ⇒ 覆盖值恰 = paragraphIds[0]
    //   ⇒ **无操作**（R3-G1 非空态零变化）；空态：无 redirect ⇒ 目标 = 被点成员段
    //   ⇒ 属性 = 该成员段（R3-G2）。
    //   时序（R3-G3）：establish（effect）bump editingTargetTick ⇒ 本 memo 重算 ⇒ 新 geometry
    //   经 store（sameSurface 比较含 paragraphId）通知 DOM；本求值早于 establish 一帧时
    //   用旧目标/无目标 ⇒ 回落适配层值（= 今天行为），随后同 tick 序列内刷新。
    const targetNow = editingTargetRef.current;
    const targetParagraphId =
      targetNow && (us.paragraphIds as readonly string[]).includes(targetNow.paragraphId)
        ? targetNow.paragraphId
        : null;
    const unitGeometry = targetParagraphId
      ? { ...adapted.geometry, paragraphId: targetParagraphId }
      : adapted.geometry;

    return {
      geometry: unitGeometry,
      // ★ 4B-4D-2A Step 4：Core 视觉断点（unit 全局 flow lines）。
      //   A′ 写入后据此**幂等重建** `<br>`；null ⇒ 不注入（fail-closed）。
      partition,
      text: unitSurface.surface.text,
      unitId: us.unitId,
      paragraphIds: us.paragraphIds,
      // ★ F3B-6.28 · S2-v1：cell 面锚身份（非 null ⇒ 本面是表格 cell 面）。
      //   消费者据此豁免「多行 unit」专属行为（宿主归一到行首段 / 行带遮罩 /
      //   成员行身份发布 / 行 glyph span 隐藏）——那些行为对 cell 面会把点击重定向到
      //   首格、涂白同行其他格、隐藏其他格原文（击穿 S2 验收 1/2）。
      //   ⚠️ 不进入 core-input-visual store ⇒ DOM 契约零变化（同 unit 字段的处理）。
      cellAnchor: cellUnit
        ? {
            lineId: cellUnit.anchor.lineId,
            cellIndex: cellUnit.anchor.cellIndex,
            paragraphId: cellUnit.anchor.paragraphId,
            box: cellUnit.cellBox,
          }
        : null,
      // ★ F3 Slice 2：把 P0-A 构建出的 `EditingUnit` **原样**带给接线层
      //   （planUnitMutationMulti 需要它；它的文本真值已由 P0-C 逐字节校验过
      //     `coreSurface.text === unit.text`，见 editing-unit-surface 的不变量 ①）。
      //   ⚠️ **不进入 core-input-visual store** ⇒ DOM 契约零变化。
      // ★ b1-B：可能是 rebind 重建后的 unit（文本已随 Core 事务更新）
      unit: unitForGeometry,
    };
    // ★ 2026-10-19：`page` 入 deps —— 翻页后 gate 特征集随页重算（第 2..N 页的行
    //   只有在特征集包含该页行时才可能建立 unit 面）。
  }, [coreInputEnabled, editingSegmentId, coreRenderEnabled, coreRenderSource, coreSessionRevision, editingTargetTick, cellAnchorTick, page]);

  // ★ F3 Slice 2：把 unit surface 的最新值同步进 ref（供 `beforeinput` 的 unit route 读取）。
  //   放在此处是因为 `explicitUnitSurface` 必须**先**算完；读取方（beforeinput effect）声明得更早，
  //   用 ref 跨越声明顺序，避免 TDZ（见 unitSurfaceRef 声明处注释）。
  useEffect(() => {
    unitSurfaceRef.current = explicitUnitSurface
      ? { unit: explicitUnitSurface.unit, text: explicitUnitSurface.text }
      : null;
    // ★ 4B-4D-2A Step 4：partition 与 unit surface **同源同代**（同一 memo 的产物）。
    //   额外做一次**长度一致性**校验：partition 的 unit 文本长度必须等于面文本长度，
    //   否则视为过期（fail-closed ⇒ 不注入 `<br>`）。
    const partNow = explicitUnitSurface?.partition ?? null;
    unitPartitionRef.current =
      partNow && partNow.unitTextLength === explicitUnitSurface!.text.length
        ? { unitId: explicitUnitSurface!.unitId, text: explicitUnitSurface!.text, partition: partNow }
        : null;
    // [TEMP-Eb0] E-b-0：Core visual bounds 观测（只读）—— partition 的 unit 全局 flow 行
    try {
      const p: any = partNow;
      if (p?.flowLines?.length) {
        const ys: number[] = [];
        for (const fl of p.flowLines) {
          if (typeof fl?.topUtf16 !== "number") continue;
        }
        (window as any).__coreVisBounds = {
          unitId: explicitUnitSurface!.unitId,
          flowLineCount: p.flowLines.length,
          totalFlowHeight: p.totalFlowHeight,
          // flowLines 携带 lineHeight（无 absolute y）⇒ 记录行高序列供对照
          lineHeights: p.flowLines.map((fl: any) => Math.round((fl?.lineHeight ?? 0) * 100) / 100),
        };
      } else {
        (window as any).__coreVisBounds = null;
      }
    } catch { /* ignore */ }
    // ★ F5 失效规则：**unitId 变了 / 面消失了 ⇒ pending caret 作废**（覆盖 blur、换面）。
    //   ⚠️ 必须**条件失效**，不能无条件清空：本次事务本身就会让 unit 文本变化并重跑本 effect，
    //   无条件清空会把刚登记的 pending 在 A′ 恢复之前抹掉 ⇒ caret 永不恢复。
    //   「同一个 unit 的文本变了」由 A′ 的 `expectedText` 全等校验负责，不在此处判。
    const nextUnitId = explicitUnitSurface?.unit.unitId ?? null;
    const pendingNow = pendingUnitCaretRef.current;
    if (pendingNow && pendingNow.unitId !== nextUnitId) {
      pendingUnitCaretRef.current = null;
    }
  }, [explicitUnitSurface]);

  // ★ 2026-10-23：给该行的 span 打区间标记（MutationObserver + rAF 节流重标；
  //   span 由冻结的 glyph-renderer 渲染、DOM 重建频繁 ⇒ 不能只打一次）：
  //   `data-cell-inrange="1"`：span 的 left 落在**编辑格几何盒**内 ⇒ 显示新值。
  //   （⚠️ 用几何而**不是**段落文本索引：实测 span 的 data-cmd-char 序列与段落
  //   文本存在 advance 级错位 ⇒ 索引定位会偏移 1 字符；几何与渲染位置同源）。
  //   旧字遮盖改由**整格白块**（渲染层 cell-committed-mask）承担——逐字符白底
  //   盖不住 advance 错位后的旧字边缘（用户缺陷「字体不同 + 残留」）。
  //   ⚠️ 位置：必须在 `explicitUnitSurface` 声明之后（引用它；勿上移到 state 区）。
  useEffect(() => {
    if (cellCommittedSpans.size === 0) return;
    const mark = (): void => {
      for (const [lid, bands] of cellCommittedSpans) {
        const nodes = document.querySelectorAll(`[data-layer="overlay"][data-line-id="${lid}"]`);
        nodes.forEach((n) => {
          const el = n as HTMLElement;
          const left = Number.parseFloat(el.style.left);
          // ★ 2026-10-24：多带——任一显示带命中即 inrange（同行多格跨会话编辑）
          const inRange =
            Number.isFinite(left) && bands.some((b) => left >= b.x - 1 && left <= b.x + b.width + 1);
          if (inRange) {
            if (el.getAttribute("data-cell-inrange") !== "1") el.setAttribute("data-cell-inrange", "1");
          } else if (el.hasAttribute("data-cell-inrange")) {
            el.removeAttribute("data-cell-inrange");
          }
        });
      }
    };
    mark();
    let raf = 0;
    const schedule = (): void => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        mark();
      });
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, [cellCommittedSpans]);
  // ★ 2026-10-23：捕获编辑格**页内几何**（cell 面打开期间持续刷新；提交块据此圈定
  //   span 显示的几何区间。实测 DOM rect + scroll 转页内 = 与 span `style.left` 同空间）。
  //   ⚠️ 位置：必须在 `explicitUnitSurface` 声明之后（引用它；勿上移到 state 区）。
  useEffect(() => {
    const cellAnchor = explicitUnitSurface?.cellAnchor;
    if (!editingSegmentId || !cellAnchor) return;
    const el = document.querySelector(`[data-segment-id="${editingSegmentId}"]`) as HTMLElement | null;
    if (!el) return;
    // 坐标基准：span 的 `style.left` 是**页容器局部坐标**（canvas 同容器）⇒
    // segment rect 必须减去 canvas 的视口 left/top，才能与 span 同空间比较。
    const canvasEl = document.querySelector("canvas");
    const cr = canvasEl ? canvasEl.getBoundingClientRect() : null;
    const r = el.getBoundingClientRect();
    // ★ 2026-10-23（用户缺陷「cell 编辑后文本侵占下一行、行间横线缺口」）：
    //   面内文本比格宽时 contenteditable 会**折行** ⇒ face rect 高度 = N 行
    //   （实测 "1:14.005" 在 54px 格宽内折成 2 行 ⇒ height 32.5 > 行距 31）⇒
    //   提交块据此画出的整格白块（height + 3.5，z10 > canvas）底部侵入下一行
    //   4px，盖断表格横线。竖直带改取**内容首行**矩形（Range.getClientRects()[0]，
    //   折行时它也只含首行）⇒ 白块高度恒 ≈ 单行文本带；空内容回退元素盒。
    let bandTop = r.top;
    let bandHeight = r.height;
    const contentRange = document.createRange();
    contentRange.selectNodeContents(el);
    const lineRects = contentRange.getClientRects();
    if (lineRects.length > 0) {
      bandTop = lineRects[0].top;
      bandHeight = Math.min(lineRects[0].height, r.height);
    }
    cellFaceGeomRef.current = {
      lineId: cellAnchor.lineId,
      x: r.left - (cr ? cr.left : 0),
      y: bandTop - (cr ? cr.top : 0),
      width: r.width,
      height: bandHeight,
    };
  }, [editingSegmentId, explicitUnitSurface]);

  // ══════════════════════════════════════════════════════════════════════
  //  F3B-6.28 · segment 提交**溢出位移**显示层（2026-10-25 用户缺陷
  //  「在这行增加了 de 后，把下一行变成了空白」）
  //  ── 根因（探针 leak1024f/g 实锤）──────────────────────────────────────
  //    单段（segment）提交路径没有单位路由的 C3 flow 机制：编辑行使 Core 重排
  //    溢出原行盒（1 行 → 2 行）时，reconciliation 的 mask = Core 布局并集
  //    （实测 456×32，两行高）盖住下一行 canvas，而下一行（独立段落、文本未变）
  //    无任何重绘 ⇒ 视觉消失；mask 右缘外还残留原行尾部字形。
  //  ── 本层职责（纯显示层；零提交路径改动）────────────────────────────────
  //    检测「mask 高度 ≫ legacy 行高」的 segment 行（排除 unit 行 = hideLineIds、
  //    cell 行 = cellCommittedSpans——它们各有显示机制）⇒ 对同页下方被重叠的
  //    legacy 行做**链式位移**：清带（白块盖原 canvas）+ 文本重绘（+dy），直到
  //    页内间隙吸收位移为止。undo/redo = appliedIndex 门控；翻页 = 页号门控。
  //  ── 已知边界 ──────────────────────────────────────────────────────────
  //    · 同页多行同时溢出时各链独立计算（首个溢出行优先占位）；
  //    · 位移行文本 = 其 Core 当前文本（未编辑行 = legacy 文本）；
  //    · 字体度量来自该行 segment DOM 计算样式（缺失回退编辑行度量）。
  // ══════════════════════════════════════════════════════════════════════
  const [segFlowOverlays, setSegFlowOverlays] = useState<
    Record<
      string,
      {
        appliedIndex: number;
        pageIndex: number;
        clears: { sourceLineId: string; x: number; y: number; w: number; h: number }[];
        lines: { sourceLineId: string; text: string; x: number; y: number; w: number; h: number; dy: number; fontSize: number; fontFamily: string }[];
      }
    >
  >(() => ({}));
  // ★★ 2026-10-25（用户缺陷「编辑框内文本 2 行，提交后只有 1 行 ⇒ 重排新增行空白」）：
  //   **提交态多行渲染快照**（lineId → 编辑面宽度）。根因：单段提交路径中，被改写
  //   segment 自身文本以 `white-space: nowrap`（M7.8-014B）渲染 ⇒ 恒 1 行；而 Core
  //   布局已重排为 2 行（mask 溢出 ⇒ segflow 正确位移后继）⇒ 第二行内容无处渲染
  //   = 空白带，且「面内 2 行 / 提交后 1 行」格式不一致（用户诉求：两者必须一样）。
  //   修复 = 编辑期间把面的宽度按 lineId 快照；提交后对「已改写」的该行 segment 注入
  //   `white-space: pre-wrap !important; width: 快照宽 !important` ⇒ 提交态渲染与
  //   编辑面是**同一元素同一几何** ⇒ 换行点按构造一致（第二行填充空带）。
  //   快照只在面存在时更新（编辑中每键刷新）；显式 unit 面不快照（unit 行有 C3 通道）；
  //   undo 回原文 ⇒ segment 不再 modified ⇒ 注入门关（快照残留无害）；re-import 清空。
  const [committedMultilineWidths, setCommittedMultilineWidths] = useState<
    Record<string, number>
  >(() => ({}));
  useEffect(() => {
    const session = coreInputSessionRef.current;
    if (!session || editedLineBoxes.size === 0) {
      setSegFlowOverlays((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const mergedHide = mergeCommittedOverlays();
    const hideSet = new Set(mergedHide ? mergedHide.hideLineIds : []);
    const cellSet = new Set(cellCommittedSpans.keys());
    const doc = editableDocumentRef.current;
    if (!doc) return;

    const pageOfLid = (lid: string): number | null => {
      const m = /pdf_p(\d+)_/.exec(lid);
      return m ? Number(m[1]) : null;
    };
    // 同页 legacy 行聚合（键 = lineId 自带页号；坐标 = 页局部，与 mask/span 同空间）
    const linesByPage = new Map<number, Array<{ id: string; x: number; y: number; w: number; h: number; text: string }>>();
    for (const pg of doc.pages ?? []) {
      for (const b of pg.blocks ?? []) {
        for (const l of b.lines ?? []) {
          const bb = l.bbox;
          const pid = pageOfLid(l.id ?? "");
          if (!bb || !(bb.width > 0) || pid == null) continue;
          if (!linesByPage.has(pid)) linesByPage.set(pid, []);
          linesByPage.get(pid)!.push({
            id: l.id ?? "",
            x: bb.x,
            y: bb.y,
            w: bb.width,
            h: bb.height,
            text: (l.glyphs ?? []).map((g: any) => g.char ?? "").join(""),
          });
        }
      }
    }
    const segFont = (lineId: string): { fontSize: number; fontFamily: string } | null => {
      const seg = (segmentsRef.current ?? []).find((s) => s.source?.lineId === lineId);
      if (!seg?.id) return null;
      const el = document.querySelector(`[data-segment-id="${seg.id}"]`) as HTMLElement | null;
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { fontSize: Number.parseFloat(cs.fontSize) || 0, fontFamily: cs.fontFamily || "" };
    };

    const next: Record<string, {
      appliedIndex: number;
      pageIndex: number;
      clears: { sourceLineId: string; x: number; y: number; w: number; h: number }[];
      lines: { sourceLineId: string; text: string; x: number; y: number; w: number; h: number; dy: number; fontSize: number; fontFamily: string }[];
    }> = {};
    for (const [lineId, box] of editedLineBoxes) {
      if (hideSet.has(lineId) || cellSet.has(lineId)) continue; // unit/cell 行各有显示机制
      const pid = pageOfLid(lineId);
      if (pid == null) continue;
      const pageLines = linesByPage.get(pid) ?? [];
      const legacy = pageLines.find((l) => l.id === lineId);
      if (!legacy) continue;
      const overflow = box.y + box.height - (legacy.y + legacy.h);
      if (overflow < legacy.h * 0.6) continue; // 无实质溢出 ⇒ 零差异（常规提交零波及）
      const editFont = segFont(lineId) ?? { fontSize: legacy.h, fontFamily: "" };
      const successors = pageLines
        .filter((l) => l.id !== lineId && l.y > legacy.y + 1)
        .sort((a, b) => a.y - b.y);
      const clears: { sourceLineId: string; x: number; y: number; w: number; h: number }[] = [];
      const lines: { sourceLineId: string; text: string; x: number; y: number; w: number; h: number; dy: number; fontSize: number; fontFamily: string }[] = [];
      let shift = overflow;
      let prevNewBottom = box.y + box.height;
      for (const s of successors) {
        const newTop = Math.max(s.y + shift, prevNewBottom + 2);
        const dy = newTop - s.y;
        if (dy <= 0.5) break; // 页内间隙吸收了位移 ⇒ 后续行不再移动
        const font = segFont(s.id) ?? editFont;
        clears.push({ sourceLineId: s.id, x: s.x - 2, y: s.y - 1, w: s.w + 8, h: s.h + 2 });
        lines.push({
          sourceLineId: s.id, text: s.text, x: s.x, y: s.y + dy, w: s.w, h: s.h, dy,
          fontSize: font.fontSize, fontFamily: font.fontFamily,
        });
        prevNewBottom = newTop + s.h;
        shift = dy;
      }
      if (lines.length === 0) continue;
      next[`segflow:${lineId}`] = {
        appliedIndex: session.history.appliedCount,
        pageIndex: pid,
        clears,
        lines,
      };
    }
    setSegFlowOverlays((prev) => {
      const pk = JSON.stringify(prev);
      const nk = JSON.stringify(next);
      return pk === nk ? prev : next;
    });
  }, [editedLineBoxes, cellCommittedSpans, coreInputTick]);

  // ══════════════════════════════════════════════════════════════════════
  //  F3B-6.28 · S2-v3 · **cell 锚 effect**（锚 ref 的唯一写点；契约 §3.3）
  //
  //  ⚠️ 自包含判定：不从 memo 返回值传递状态（memo 无面时 early-return null 会丢载荷），
  //     而是从**已提交面 + 探针 + 锚 ref** 现推四分支：
  //       ① 锚在 + 面仍是该 cell 面（键匹配）⇒ 换宿主写回 entrySegmentId（无其它动作）；
  //       ② 锚在 + 键匹配 + 面已不是 cell 面 ⇒ **锚失效**：清 ref + bump tick；
  //          同帧无任何 unit 面（explicitUnitSurface === null，即 D1 降级态）⇒ **安全退出**；
  //       ③ 锚在 + 键不匹配（入口移到别的 cell / 非表格行）⇒ 静默清旧锚（不回退会话，
  //          新入口走完整门链/回落路径 = S2-v1 行为）；
  //       ④ 面是 cell 面 + 无匹配锚 ⇒ **promotion**：从已提交面 + 探针组装 establish
  //          （含轴等价性复核）⇒ 再跑 C1–C5 ⇒ 写入 active（不 bump tick）。
  //  · 生命周期 = 单次编辑会话：flag 关闭 / editingSegmentId = null ⇒ 清锚。
  //  · 安全退出三层（契约 §5.2）：L3 清 pending caret ⇒ L1 blur（unit/cell 面恒 no-submit，
  //    EditableTextNode `isUnitSurface` 分支）⇒ L2 不碰 Core（退出路径无 undo/redo/commit）。
  //    ⚠️ 退出 ≠ 回滚；已提交 Core mutation 一律保留。
  //  ⚠️ deps **不含** cellAnchorTick：本 effect 自己 bump 的 tick 不回灌自身（memo 侧消费）。
  // ══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    // flag 关闭 / 会话结束 ⇒ 清锚（生命周期 = 单次编辑会话）
    if (!readCellUnitEditingFlag() || editingSegmentId == null) {
      if (cellAnchorRef.current !== null) {
        cellAnchorRef.current = null;
        bumpCellAnchorTick();
        recordCellMonitor("anchorLifecycle", "session-end"); // ★ C 监测
      }
      return;
    }
    const probe = probeCellEntry(editingSegmentId);
    const anchorNow = cellAnchorRef.current;
    const cellAnchorInfo = explicitUnitSurface?.cellAnchor ?? null;
    const surfaceIsThisCell =
      !!cellAnchorInfo && !!anchorNow &&
      cellAnchorInfo.lineId === anchorNow.lineId && cellAnchorInfo.cellIndex === anchorNow.cellIndex;
    const keyMatchesAnchor =
      !!probe && !!anchorNow && probe.lineId === anchorNow.lineId && probe.cellIndex === anchorNow.cellIndex;
    // 只读探针（S3 取证用；与 `__coreVisBounds` 同族，零行为影响）
    (window as any).__cellAnchor = anchorNow
      ? { status: surfaceIsThisCell ? "consumed" : "invalid", unitId: explicitUnitSurface?.unitId ?? null }
      : cellAnchorInfo
        ? { status: "pending", unitId: explicitUnitSurface?.unitId ?? null }
        : null;
    if (anchorNow && keyMatchesAnchor && !surfaceIsThisCell) {
      // ② 锚失效：该 cell 的面已消失（memo 同帧重建也失败 ⇒ D1 降级态）
      cellAnchorRef.current = null;
      bumpCellAnchorTick();
      recordCellMonitor("anchorLifecycle", "invalid"); // ★ C 监测
      if (!explicitUnitSurface) {
        // 同帧无任何 unit 面 ⇒ 结束编辑会话（L3 → L1/L2）
        pendingUnitCaretRef.current = null;
        recordCellMonitor("anchorSafeExit", "no-unit-surface"); // ★ C 监测
        exitEditMode();
      } else {
        recordCellMonitor("anchorSafeExit", "other"); // ★ C 监测（面被其它 unit 顶替）
      }
      return;
    }
    if (anchorNow && !keyMatchesAnchor) {
      // ③ 入口移到别的 cell / 非表格行 ⇒ 静默清旧锚（不回退会话）
      cellAnchorRef.current = null;
      bumpCellAnchorTick();
      recordCellMonitor("anchorLifecycle", "entry-moved"); // ★ C 监测
      return;
    }
    if (anchorNow) {
      // ① 锚在且面仍在：换宿主证明已由 memo 的 revalidate（C5 全证明）通过 ⇒ 写回新宿主
      if (anchorNow.entrySegmentId !== editingSegmentId) {
        cellAnchorRef.current = { ...anchorNow, entrySegmentId: editingSegmentId };
        recordCellMonitor("anchorLifecycle", "host-switch"); // ★ C 监测
      }
      return;
    }
    // ④ promotion：面是 cell 面但无锚 ⇒ 从已提交面 + 探针组装并晋升
    if (cellAnchorInfo && probe && explicitUnitSurface) {
      const line = (explicitUnitSurface.unit.lines ?? [])[0];
      const cellInterval = probe.cells.find((c) => c.index === cellAnchorInfo.cellIndex);
      const session = coreInputSessionRef.current;
      const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
      const src = probe.entrySegment.source as { blockId?: string } | undefined;
      if (line && cellInterval && coreDoc && src?.blockId) {
        const est = establishCellAnchor({
          lineId: cellAnchorInfo.lineId,
          blockId: src.blockId,
          cellIndex: cellAnchorInfo.cellIndex,
          paragraphId: cellAnchorInfo.paragraphId,
          textBoxId: line.textBoxId,
          pStartUtf16:
            typeof line.paragraphStartUtf16 === "number" ? line.paragraphStartUtf16 : 0,
          cellStartGlyphIndex: cellInterval.startGlyphIndex,
          cellEndGlyphIndex: cellInterval.endGlyphIndex,
          cellBox: cellAnchorInfo.box,
          document: coreDoc,
          documentGeneration: sidecarGenerationRef.current,
          entrySegmentId: editingSegmentId,
          rowGlyphs: probe.rowGlyphs,
          // ★ 2026-10-24（ledger 路径）：该 cell 已被编辑过 ⇒ Core 内容 ≠ legacy
          //   位置切片 ⇒ 既有轴复核必失败。传入面当前内容（= plan.cellText）作为
          //   轴复核基准；cellTextAtEstablishment 仍存 legacy 切片（V1b 基准不变）。
          establishedCellText: typeof line.text === "string" ? line.text : undefined,
        });
        if (est.ok) {
          // 晋升前再跑一遍 C1–C5（纵深防御，契约 §3.3）
          const revalidated = revalidateCellAnchor({
            anchor: est.anchor,
            document: coreDoc,
            documentGeneration: sidecarGenerationRef.current,
            coreOwned: coreInputSessionRef.current != null && exportOwnershipRef.current !== "legacy",
            entrySegment: probe.entrySegment,
            rowGlyphs: probe.rowGlyphs,
            rowSegments: probe.rowSegments,
            cells: probe.cells,
          });
          if (revalidated.ok) {
            cellAnchorRef.current = est.anchor;
            recordCellMonitor("anchorLifecycle", "promoted"); // ★ C 监测
          } else {
            cellAnchorRef.current = null;
            bumpCellAnchorTick();
          }
        }
      }
    }
  }, [explicitUnitSurface, editingSegmentId, coreInputTick, coreSessionRevision]);


  // ─────────────────────────────────────────────────────────────────────
  //  F3B-6.27-H2 · 编辑目标身份的 **establish / 清除**
  //
  //  · 面打开 ⇒ 按 lineId 解析（与 H2 之前 `editingSurface.paragraphId` 的来源**等价**）
  //  · 已有身份且仍是同一个 segment ⇒ **保持**（rebind 只能由拆分事务站点改写，此处不得覆盖）
  //  · 退出编辑 / 段落不可解析 ⇒ 清除 ⇒ 消费点回退既有 lineId 解析
  //
  //  ⚠️ 刻意**不**在这里做 rebind：rebind 需要「拆分事务证据」这一外部事实，
  //     只在 Core 提交成功的那个站点成立（见 `lastSplitMutationRef` 写入处）。
  useEffect(() => {
    if (editingSegmentId == null) {
      if (editingTargetRef.current !== null) editingTargetRef.current = null;
      return;
    }
    const session = coreInputSessionRef.current;
    const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
    if (!coreDoc) return;
    const seg = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId);
    const lineId = (seg?.source as { lineId?: string } | undefined)?.lineId;
    // ★ 空文本缺陷修复（SPEC v2.1 N1b/C1）：统一解析入口。
    //   unique ⇒ provenance（与旧 coreParagraphIdForLineId 命中路径一致）；
    //   ambiguous ⇒ 立即失败（目标不建立，ledger 不介入）；
    //   not-found ⇒ identity ledger hint（段落仍在、provenance 已丢时恢复目标身份）。
    const resolvedTarget = lineId
      ? resolveParagraphIdForLine(coreDoc, lineId, unitIdentityLedgerRef.current, sidecarGenerationRef.current)
      : null;
    const lineParagraphId = resolvedTarget?.ok ? resolvedTarget.paragraphId : null;
    if (!lineParagraphId) {
      if (editingTargetRef.current !== null) editingTargetRef.current = null;
      return;
    }
    const prev = editingTargetRef.current;
    if (prev && prev.segmentId === editingSegmentId) return; // 已建立 ⇒ 不覆盖（rebind 另有站点）
    const established = establishEditingTarget({
      segmentId: editingSegmentId,
      paragraphId: lineParagraphId,
      document: coreDoc,
      generation: coreDoc.version,
    });
    editingTargetRef.current = established;
    // ★ R3（登记档案 §5.3.2.3）：establish 是 ref 写、不触发重渲染 ⇒ 主动 bump tick，
    //   让 unit 几何 memo（deps 含 editingTargetTick）在**同一 tick 序列内**用新目标重算
    //   （G3 传播时序）。仅 establish 成功时 bump（面打开/换面一次，非每键）；
    //   本 effect 重入时 prev.segmentId === editingSegmentId 早退 ⇒ 无环。
    if (established) setEditingTargetTick((t) => t + 1);
  }, [editingSegmentId, coreInputTick, editingTargetTick]);

  const editingSurface = useMemo(() => {
    if (!coreInputEnabled || !editingSegmentId) return null;
    const src = coreRenderSource;
    if (!coreRenderEnabled || !src || !src.ok) return null;
    const session = coreInputSessionRef.current;
    const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
    if (!coreDoc) return null;
    const seg = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId);
    const lineId = (seg?.source as { lineId?: string } | undefined)?.lineId;
    if (!lineId) return null;
    // ★ 空文本缺陷修复（SPEC v2.1 N1b/C2）：统一解析入口（与 C1 同语义）。
    //   unique ⇒ provenance；ambiguous ⇒ 立即失败；not-found ⇒ identity ledger hint。
    const resolvedSurface = resolveParagraphIdForLine(
      coreDoc,
      lineId,
      unitIdentityLedgerRef.current,
      sidecarGenerationRef.current,
    );
    const paragraphId = resolvedSurface.ok ? resolvedSurface.paragraphId : null;
    if (!paragraphId) return null;
    // ★ F3B-6.27 方案 A：该 Core paragraph 是否由**多个** Legacy segment 共同拥有。
    //   判定与 A′ effect 用**同一个已验证解析器**（`coreParagraphIdForLineId`），
    //   绝不裸比 `source.lineId`（lineId 不是稳定 identity：实测 1 行可映射到 2~3 个 segment）。
    const multiSegmentRow = (() => {
      let n = 0;
      for (const s of segmentsRef.current ?? []) {
        const lid = (s as { source?: { lineId?: string } }).source?.lineId;
        if (!lid) continue;
        if (coreParagraphIdForLineId(coreDoc, lid) === paragraphId) n += 1;
      }
      return n > 1;
    })();
    // ★ H2-VIS（多行高度修复）：编辑目标身份段落（split 产物 / rebind 后）的
    //   reflow 行盒必须进入 union —— 否则面高度停留在原始单视觉行，
    //   reflow 出的第二行被 overflow:hidden 裁掉（实测 scrollHeight 43 > clientHeight 24）。
    //   几何来源仍是 **Core 布局结果**（ParagraphLayout.lines = reflow 后的全部视觉行，
    //   ParagraphLayout.height = Σ lineHeight，core/layout/types.ts:186-198）；
    //   `ParagraphLayout.paragraphId` 引用 EditorDocument.Paragraph.id（types.ts:187）
    //   ⇒ 与 identityParagraphId 同源，可直接匹配。
    //   ⚠️ 身份逻辑不动（约束 2）：identityParagraphId 只在此处与 return 的身份字段被
    //   读取；establish/maintain/ownedParagraphIdForBinding/事务证据全部原样。
    //   ⚠️ 身份未迁移（identity === lineId 解析的 paragraphId）时本扩展恒 no-op
    //   （条件逐字节等价于原 `p.paragraphId !== paragraphId ⇒ continue`）。
    const identityParagraphId = (() => {
      const target = editingTargetRef.current;
      const caretPid =
        (session?.history?.state?.caret?.position as { paragraphId?: string } | undefined)
          ?.paragraphId ??
        (session?.history?.state?.selection?.range?.focus as { paragraphId?: string } | undefined)
          ?.paragraphId ??
        null;
      const res = resolveEditingTargetMaintain({
        target,
        segmentId: editingSegmentId,
        document: coreDoc,
        caretParagraphId: caretPid,
        currentGeneration: coreDoc.version,
      });
      return res.ok ? res.paragraphId : null;
    })();
    const boxes: { x: number; y: number; width: number; height: number }[] = [];
    let identityLinesFound = false;
    for (const layout of src.layouts) {
      for (const p of layout.paragraphs) {
        if (p.paragraphId !== paragraphId) {
          if (p.paragraphId !== identityParagraphId) continue;
          identityLinesFound = true;
        }
        for (const l of p.lines) {
          boxes.push({ x: l.box.x, y: l.box.y, width: l.box.width, height: l.box.height });
        }
      }
    }
    // ★ 换行约束宽（TextBox 的 width）。**声明提前**：下面的现算回退与既有
    //   `src.layouts` 路径共用它（原先在并集计算之后才声明，现算回退会 TDZ）。
    let constraint = 0;

    // ★ F3B-6.27-①：Core render source 里**还没有**该段落时，现算一次 layout。
    //
    //   实测（进入编辑那一刻，临时探针）：
    //     · `src.layouts` 有 21 个 layout 却不含本段 ⇒ 旧代码只能 return null
    //       ⇒ 编辑面退回 legacy 单行盒（450.55px，而该行需要 514.36px；面里装切片 + nowrap）。
    //     · **Core 的 paragraph 对象没有 `paragraphId`、也没有 `text`**（实测 pid=null、text=""），
    //       段落全文在唯一一个 run 里 ⇒ 任何按 paragraphId / 段落文本的定位都必然失败。
    //     · 唯一可靠的身份是 **run provenance**（`run.source.{blockId,lineId}`，实测完整可用），
    //       本行的 textBox = `tb_44`。
    //
    //   `layoutTextBox(document, textBoxId, metrics)` 是纯函数、按需计算、**不依赖任何 mutation**
    //   （同 `binding/core-layout-current-geometry.ts` 的既有做法）⇒ 进入编辑即可拿到
    //   Core 自己的行盒与换行约束宽。
    //
    //   ⚠️ 只在 `boxes` 为空时启用（Core 已给出布局时一律用它，不与 legacy 求并集）。
    //   ⚠️ fail-open：定位不到 textBox 或布局抛错 ⇒ 保持既有行为。
    if (boxes.length === 0) {
      try {
        const segSrcAny = (seg as { source?: { blockId?: string; lineId?: string } } | undefined)?.source;
        const bId = segSrcAny?.blockId;
        const lId = segSrcAny?.lineId;
        if (bId && lId) {
          let textBoxId: string | null = null;
          for (const page of (coreDoc as { pages?: unknown[] }).pages ?? []) {
            for (const obj of (page as { objects?: unknown[] }).objects ?? []) {
              const o = obj as {
                type?: string;
                id?: string;
                paragraphs?: { runs?: { source?: { blockId?: string; lineId?: string } }[] }[];
              };
              if (o.type !== "text") continue;
              let hit = false;
              for (const p of o.paragraphs ?? []) {
                for (const r of p.runs ?? []) {
                  if (r.source?.blockId === bId && r.source?.lineId === lId) {
                    hit = true;
                    break;
                  }
                }
                if (hit) break;
              }
              if (hit && !textBoxId) textBoxId = o.id ?? null;
            }
          }
          if (textBoxId) {
            const laid = layoutTextBox(
              coreDoc as never,
              textBoxId,
              createFontMetricsProvider({})
            ) as {
              layout?: {
                paragraphs?: {
                  runs?: { source?: { blockId?: string; lineId?: string } }[];
                  lines?: { box?: { x: number; y: number; width: number; height: number } }[];
                }[];
                constraintBox?: { width?: number };
              };
            };
            const laidParas = laid.layout?.paragraphs ?? [];
            // 归属：优先按 run provenance 精确匹配；布局结果不带 run 时退回该 text box 全部段落
            let matched = laidParas.filter((p) =>
              (p.runs ?? []).some((r) => r.source?.blockId === bId && r.source?.lineId === lId)
            );
            if (matched.length === 0) matched = laidParas;
            for (const p of matched) {
              for (const l of p.lines ?? []) {
                if (!l.box) continue;
                boxes.push({ x: l.box.x, y: l.box.y, width: l.box.width, height: l.box.height });
              }
            }
            const cbW = laid.layout?.constraintBox?.width;
            if (typeof cbW === "number" && cbW > constraint) constraint = cbW;
          }
        }
      } catch {
        // fail-open：现算失败 ⇒ 保持既有行为（legacy 面）
      }
    }
    // ★ H2-VIS 现算兜底：`src.layouts` 是渲染链的布局快照，split 产生的身份段落可能
    //   尚未进入快照（快照滞后）⇒ 主路径拿不到它的 reflow 行盒。此时按需现算一次
    //   该 textBox 的布局，并按 paragraphId **精确**提取身份段落的行盒
    //   （刻意**不**退回「全部段落」——那是 boxes.length===0 场景的既有 fail-open，
    //   在追加模式下会造成无关段落扩张）。
    //   fail-open（约束 5）：定位不到 textBox / 布局抛错 / 段落无行盒 ⇒ 保持既有行为，
    //   绝不用 DOM 测量值补位。
    if (identityParagraphId && identityParagraphId !== paragraphId && !identityLinesFound) {
      try {
        const segSrcAny = (seg as { source?: { blockId?: string; lineId?: string } } | undefined)?.source;
        const bId = segSrcAny?.blockId;
        const lId = segSrcAny?.lineId;
        if (bId && lId) {
          let visTextBoxId: string | null = null;
          for (const page of (coreDoc as { pages?: unknown[] }).pages ?? []) {
            for (const obj of (page as { objects?: unknown[] }).objects ?? []) {
              const o = obj as {
                type?: string;
                id?: string;
                paragraphs?: { runs?: { source?: { blockId?: string; lineId?: string } }[] }[];
              };
              if (o.type !== "text") continue;
              let hit = false;
              for (const p of o.paragraphs ?? []) {
                for (const r of p.runs ?? []) {
                  if (r.source?.blockId === bId && r.source?.lineId === lId) {
                    hit = true;
                    break;
                  }
                }
                if (hit) break;
              }
              if (hit && !visTextBoxId) visTextBoxId = o.id ?? null;
            }
          }
          if (visTextBoxId) {
            const visLaid = layoutTextBox(
              coreDoc as never,
              visTextBoxId,
              createFontMetricsProvider({}),
            ) as {
              layout?: {
                paragraphs?: {
                  paragraphId?: string;
                  lines?: { box?: { x: number; y: number; width: number; height: number } }[];
                }[];
              };
            };
            for (const p of visLaid.layout?.paragraphs ?? []) {
              if (p.paragraphId !== identityParagraphId) continue;
              identityLinesFound = true;
              for (const l of p.lines ?? []) {
                if (!l.box) continue;
                boxes.push({ x: l.box.x, y: l.box.y, width: l.box.width, height: l.box.height });
              }
            }
          }
        }
      } catch {
        // fail-open：兜底现算失败 ⇒ 保持既有单行行为
      }
    }
    if (boxes.length < 2 && !multiSegmentRow) return null; // ★ 见下：多段行即使单行也要面
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, maxW = 0;
    for (const b of boxes) {
      if (b.x < x0) x0 = b.x;
      if (b.y < y0) y0 = b.y;
      if (b.x + b.width > x1) x1 = b.x + b.width;
      if (b.y + b.height > y1) y1 = b.y + b.height;
      if (b.width > maxW) maxW = b.width;
    }
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || x1 <= x0 || y1 <= y0) return null;
    // ★★ F3B-6.27 Step 2 高度校准：换行**约束宽**是 Core TextBox 的 width，
    //   不是任何一行的 box.width（那是"文字实际宽度"，可溢出约束宽）。
    //   实测（gd-swim-2026.pdf，段末追加 21 汉字后）：
    //     Core 逐字 advance 21.63 / DOM 21.45（Core 反而**更宽** 0.8%）
    //     Core 渲染 2 行（glyph y=386,406）而 DOM 排 3 行（scrollHeight 64 / 21.46）
    //   ⇒ 差异不来自字宽，而来自**容器宽度**：我曾把 union 宽 515.6 当编辑面宽度，
    //     它比 Core 的换行约束窄 ⇒ DOM 换行点更早 ⇒ 行数更多 ⇒ 最后一行被裁。
    //   `contentWidth` **不是**约束宽（见 core/layout/types.ts:134 与
    //   core-editing-hit-area.ts:88-92 的注释），必须取 TextBox.width。
    for (const layout of src.layouts) {
      if (!(layout.paragraphs ?? []).some((pp) => pp.paragraphId === paragraphId)) continue;
      // ★ `TextLayout.constraintBox` 就是 Core 的换行约束盒（实测 layout 的字段：
      //   textBoxId / documentVersion / **constraintBox** / paragraphs / height / …）。
      //   它比"绕道 objects[].width"更直接，也避免 textBoxId ↔ object.id 对应失败。
      const cb = (layout as { constraintBox?: { width?: number } }).constraintBox;
      if (cb && typeof cb.width === "number" && cb.width > constraint) constraint = cb.width;
    }
    // ★★ F3B-6.27-P1（段落面垂直边界）：与「紧随其后的 Core 段落」求交。
    //
    //   实测（Core 自己的行盒，gd-swim-2026.pdf）：
    //     para_43（编辑段，2 行）line2 y=385.61 h=21.46 ⇒ bottom **407.07**
    //     para_46（下一段）      line1 y=**406.12**
    //   ⇒ **Core 自身的相邻段落行盒就重叠 0.94px**（行高 > 段落间距）。
    //   面若照 union 铺到 407.07，在 DOM 尺度（约 3px）就会压住下一段落顶部。
    //
    //   ★ 仍然**只以 Core 行盒为几何来源**：不引入 `lineHeight * lineCount` 之类估算、
    //     不改 Core 布局、不重开「Core height 与 DOM CSS px 不一致」的问题。
    //     只是把 union 的下边界与后继段落首行顶取交集 —— 「不越出段落」是硬要求。
    //
    // ⚠️⚠️ **绝不能用 `pp.paragraphId === paragraphId` 来排除自身**（实测回归）：
    //   同一次渲染里 `coreRenderSource.layouts[].paragraphs[].paragraphId` 与本函数
    //   解析出的 `paragraphId` **可能不同源**（实测 layouts 里是 `para_2a`，而面记录
    //   `para_43`）⇒ 段落把自己当成「下一段」⇒ `bottom = y0` ⇒ **height = 0**
    //   ⇒ 编辑面把整行文字裁掉，屏幕上只剩白底与残留影子（用户报告）。
    //   ⇒ 改为**纯几何**判定：候选必须落在本段 union 底边附近（`y1 - 行高 ≤ ty < y1`），
    //      且**与本段同顶**的候选一律跳过（同顶不是「下一段」）。
    const lineH = Math.max(2, ...boxes.map((b) => b.height || 0));
    // ★★ 2026-10-25（用户缺陷「编辑框内换行 2 行但高度不够被裁，提交后下一行空白」）：
    //   P1 的裁剪语义 = 「面不得压住**紧随其后 Core 段落**的可见文本」。但 segflow
    //   位移层（本文件 ~7372）在提交溢出时已把后继行的**显示**下移 dy ⇒ 该段落的
    //   可见文本不再位于其 Core top ⇒ 按原 top 裁剪会把面裁回单行高（实测 face
    //   height 21.5 / scrollHeight 33 ⇒ 第二行被 overflow:hidden 裁掉，只露一条缝）。
    //   修复 = 裁剪候选若已被 segflow 位移（按 legacy 行几何匹配，Core↔DOM 配准差
    //   ~2.5px ⇒ 容差 6px），其显示顶 = ty + dy ⇒ 不再构成裁剪边界（跳过）。
    //   纯几何判定，与 P1 的「绝不按 paragraphId 排除自身」同一纪律；无位移时行为
    //   逐字节不变（候选仍按原 top 裁剪）。
    const isCandidateDisplaced = (top: number): boolean => {
      for (const entry of Object.values(segFlowOverlays)) {
        for (const l of entry.lines) {
          const legacyY = l.y - l.dy;
          if (Math.abs(legacyY - top) <= 6 && l.dy > 0.5) return true;
        }
      }
      return false;
    };
    let bottom = y1;
    for (const layout of src.layouts) {
      for (const pp of layout.paragraphs ?? []) {
        const ty = pp.box?.y ?? 0;
        if (!Number.isFinite(ty)) continue;
        if (ty <= y0 + 0.5) continue; // 与本段同顶 ⇒ 自身/同行另段，不是后继
        if (isCandidateDisplaced(ty)) continue; // ★ 显示已位移 ⇒ 不构成裁剪边界
        if (ty >= y1 - lineH && ty < bottom) bottom = ty;
      }
    }
    const clipped = bottom < y1;
    if (bottom < y0) bottom = y0;
    const r2 = (n: number) => Math.round(n * 100) / 100;
    // ★ F3B-6.27-H2：**身份与几何分离**（已按 H2-VIS 裁决修订）。
    //   几何仍以 lineId 解析的 `paragraphId` 为基（原始 PDF 行几何保留，约束 4）；
    //   H2-VIS 只在身份段落 reflow 出多行时把它的 **Core 布局行盒**并入 union
    //   （见上方 boxes 收集与现算兜底）——来源仍是 Core 布局结果，不是 DOM 反推。
    //   仅返回的身份字段在「编辑目标有效」时采用目标段落（H2 要求 #4）。
    return {
      // ★ F3B-6.27-STEP①：面携带 **paragraph** 身份（真正的编辑对象），
      //   `editingSegmentId` 只是触发者。DOM 侧据此挂 data-editing-paragraph-id，
      //   使「本 segment 节点属于哪个 Core paragraph」无需再靠矩形相交推断。
      //   ⚠️ legacy 行 ≠ Core 段落（实测 legacy 3 segment ↔ Core 2 paragraph），
      //   本字段不表达整个 legacy 行的归属；详见 EditingSurfaceGeometry.paragraphId。
      // ★ H2：优先采用**有效**编辑目标身份；无身份 ⇒ 逐字节保持既有 lineId 解析结果。
      paragraphId: identityParagraphId ?? paragraphId,
      // ★ B2：Core 空间的上下边界是**段落边界的 authority**（DOM 侧 top/height 是显示值）
      coreTop: r2(y0),
      coreBottom: r2(bottom),
      clippedToNextParagraph: clipped,
      left: r2(x0), top: r2(y0),
      // 宽度下限 = max(TextBox 约束宽, union 宽, 最宽行) —— 前者决定换行点，
      // 后两者保证不裁字（Core 允许 line box 溢出约束宽）。
      width: r2(Math.max(constraint, x1 - x0, maxW)),
      height: r2(bottom - y0),
      textIndent: r2(boxes[0]!.x - x0), // 悬挂缩进（CSS text-indent 只作用首行）
    };
    // ★ H2：`editingTargetTick` 使重绑定（rebind）能传播到本 useMemo（ref 变化本身不触发重渲染）。
  }, [
    coreInputEnabled,
    editingSegmentId,
    coreRenderEnabled,
    coreRenderSource,
    coreSessionRevision,
    editingTargetTick,
    segFlowOverlays, // ★ 2026-10-25：裁剪候选位移豁免（Fix A）依赖位移层状态
  ]);

  // ★★ P0-F1：显式 unit 面**优先**于单 paragraph 面（注入缺省时两者都保持既有行为）。
  //   ⚠️ 必须排在上面那个 editingSurface useMemo **之后**（否则 TDZ ——
  //     本文件 5220-5222 注释已记录过一次同类崩溃）。
  //   ⚠️ 也不得把它放进 3974 那个 ownedSegmentId effect 的 deps（同注释的告警）。
  const effectiveEditingSurface = explicitUnitSurface ? explicitUnitSurface.geometry : editingSurface;

  // ── 2026-10-25：提交态多行渲染快照（Fix B 采集侧；消费 = 渲染层 CSS 注入块）──
  //   单段面（unitId 缺失）存在即快照其宽度；每键刷新（Core reflow ⇒ width 变化）。
  //   ⚠️ 必须排在 editingSurface useMemo 之后（TDZ 纪律，见 5220 注释）。
  useEffect(() => {
    if (explicitUnitSurface) return; // unit 行显示由 C3 通道承担，不快照
    // ⚠️ 本 useMemo（单段面）返回类型恒无 unitId（unit 面走 explicitUnitSurface 通道），
    //    无需再判 unitId；上方 explicitUnitSurface 门已隔离。
    if (!editingSurface || !(editingSurface.width > 0)) return;
    const seg = segmentsRef.current.find((s) => s.id === editingSegmentId);
    const lid = (seg?.source as { lineId?: string } | undefined)?.lineId;
    if (!lid) return;
    setCommittedMultilineWidths((prev) =>
      prev[lid] === editingSurface.width ? prev : { ...prev, [lid]: editingSurface.width },
    );
  }, [editingSurface, explicitUnitSurface, editingSegmentId]);

  // ── D-3B-6 编辑态遮罩缺陷修复（2026-10-16，用户批准范围 A）─────────────
  //   根因（只读诊断实证）：unit 编辑面的 surface 只覆盖**所点击行**的单行 rect，
  //   而面文本是整段（para_43 + para_46）⇒ 其他成员行（如 l5）的原始 PDF 文本
  //   由 **base canvas** 绘制且无任何遮罩 ⇒ 与框内编辑文本形成视觉重复
  //   （探针实证：该区域 glyph span=0 / mask div=0，顶层是透明 segment + canvas）。
  //   ⇒ 修复 = 按成员行 lineId 渲染白底遮罩 div（与缺陷 A 的 C3 clear divs 同族：
  //   fixed 白矩形 + lineId 身份锚定），覆盖全部成员行的原始 canvas 文本。
  //   ★ 身份来源 = 当前有效编辑目标的 memberLineIds（explicitUnitSurface.unit.lines），
  //     **不按坐标猜测**。
  //   ★ D-3B-6 子任务 3（2026-10-17）：几何 = **legacy 行 bbox + glyph 层原点**
  //     （`origin + bbox`，探测实证 1:1：l5 x 313+183.06=496.06、l6 x 313+135=448，
  //     y 恒定 ~3px 墨迹顶差 ⇒ MASK_PAD=4 吸收）。**不再**用 segment DOM rect——
  //     A′ 会把宿主 segment 改写为整段多行 rect（实测 (569,555,502×24)→(448,555,625×75)），
  //     行内多 segment 也迫使逐个拼接；legacy bbox 是行级单一事实源，两者免疫。
  //   ★ fail-closed：legacy 行/glyph 层不可解析 ⇒ 该行不遮罩（保持既有行为），并记录
  //     __editMaskMissed + console 告警，绝不批量猜测。
  //   ★ 生命周期随 explicitUnitSurface：打开/目标切换/文档重算/关闭/Escape/提交/
  //     undo·redo/文档重置均随其重算或卸载；实测**切页会关闭编辑会话**（编辑面与遮罩
  //     一并卸载）⇒ 不悬浮他页；非 unit 编辑（unit 为 null）不渲染 ⇒ 单段落编辑行为
  //     逐字节不变。不改编辑框文本、段落拼接、flow 排版、glyph 身份映射及导出逻辑。
  const [editMaskRects, setEditMaskRects] = useState<
    ReadonlyArray<{ lineId: string; cssX: number; cssY: number; cssW: number; cssH: number }>
  >([]);
  useLayoutEffect(() => {
    if (!explicitUnitSurface) {
      setEditMaskRects([]);
      return;
    }
    // ★ S2-v1：cell 面遮罩 = **该格墨迹盒**（白底矩形盖住 cell 区域的 base canvas 原文），
    //   绝不行带遮罩——行带会把同一行其他 cell 的原文一并涂白（其他格必须保持可见）。
    //   几何 = glyph 层原点 + cell 盒（与行带同一换算；cell 盒与 legacy bbox 同空间）。
    if (explicitUnitSurface.cellAnchor) {
      const MASK_PAD_CELL = 4;
      const glEl0 = document.querySelector('[data-layer="glyph"]');
      const b = explicitUnitSurface.cellAnchor.box;
      if (glEl0 && b.width > 0 && b.height > 0) {
        const r0 = glEl0.getBoundingClientRect();
        setEditMaskRects([
          {
            lineId: explicitUnitSurface.cellAnchor.lineId,
            cssX: r0.x + b.x - MASK_PAD_CELL,
            cssY: r0.y + b.y - MASK_PAD_CELL,
            cssW: b.width + MASK_PAD_CELL * 2,
            cssH: b.height + MASK_PAD_CELL * 2,
          },
        ]);
      } else {
        // fail-closed：拿不到几何 ⇒ 不遮罩（cell 面自身白底仍覆盖主要区域）
        setEditMaskRects([]);
      }
      return;
    }
    // 子任务 3：行带 = glyph 层原点 + legacy bbox（MASK_PAD 吸收 bbox 墨迹顶 vs
    //   canvas 墨迹的 ~3px 差；行间距 ≈2 倍行高，pad 不会触及邻行）。
    const MASK_PAD = 4;
    const rects: { lineId: string; cssX: number; cssY: number; cssW: number; cssH: number }[] = [];
    const missed: string[] = [];
    const glEl = document.querySelector('[data-layer="glyph"]');
    const origin = glEl
      ? (() => {
          const r = glEl.getBoundingClientRect();
          return { x: r.x, y: r.y };
        })()
      : null;
    const doc = editableDocumentRef.current;
    for (const l of explicitUnitSurface.unit.lines) {
      if (!origin || !doc) {
        missed.push(l.lineId);
        continue;
      }
      // legacy 行按 lineId 精确查找（editableDocument 的 pages→blocks→lines）
      let bbox: { x: number; y: number; width: number; height: number } | null = null;
      for (const pg of doc.pages ?? []) {
        for (const b of pg.blocks ?? []) {
          for (const ln of b.lines ?? []) {
            if (ln.id === l.lineId && ln.bbox) {
              bbox = ln.bbox;
              break;
            }
          }
          if (bbox) break;
        }
        if (bbox) break;
      }
      if (!bbox || !(bbox.width > 0) || !(bbox.height > 0)) {
        missed.push(l.lineId);
        continue;
      }
      rects.push({
        lineId: l.lineId,
        cssX: origin.x + bbox.x - MASK_PAD,
        cssY: origin.y + bbox.y - MASK_PAD,
        cssW: bbox.width + MASK_PAD * 2,
        cssH: bbox.height + MASK_PAD * 2,
      });
    }
    if (missed.length > 0) {
      try {
        (window as unknown as Record<string, unknown>).__editMaskMissed = missed;
      } catch {
        /* ignore */
      }
      console.warn(
        "[F3B-6.28][EDIT-MASK] 成员行 segment 无法按 lineId 定位 ⇒ 该行不遮罩（fail-closed，保持既有行为）：",
        missed,
      );
    }
    setEditMaskRects(rects);
  }, [explicitUnitSurface, editingSegmentId]);

  // ── S2（UNIT-MEMBER-VISIBILITY · V1）：发布活动 unit 成员 lineId 集合 ──────
  //   与遮罩（editMaskRects）**同源同调度**：直读 explicitUnitSurface.unit.lines，
  //   useLayoutEffect ⇒ 与遮罩同帧落地（成员抑制不晚一帧闪现）。
  //   ★ **不经过** editingSurface / effectiveEditingSurface / corePresentationActive
  //     —— S1 插桩实证：编辑面几何通道在「提交后第二成员入口重开」时序下会被发布
  //     null，而 unit 会话（遮罩/A′/partition）仍活跃 ⇒ 成员身份必须独立通道。
  //   ★ replace 语义：换 unit / 关闭 ⇒ 整体替换或置 null ⇒ 新旧会话不残留身份。
  //   ★ store 侧逐元素比较 ⇒ memo 每次重算都发布也不会产生无意义重渲染。
  //   ★ fail-closed 边界（如实记录）：成员 lineId 为合成（`syn:<paragraphId>`，
  //     整段替换后 lineId 丢失时由 rebind 合成）时，legacy segment 的
  //     source.lineId 匹配不上 ⇒ 该成员不被抑制（不猜测、不误抑制）。
  //     这是**已知边界**而非缺陷：抑制漏一帧好过误抑制可见性。
  useLayoutEffect(() => {
    const lines = explicitUnitSurface?.unit.lines;
    // ★ S2-v1：cell 面**不发布行成员身份**（`unitMemberLineIds` 抑制的是「整面覆盖的
    //   成员行」；cell 面只覆盖一格，同行其他格的 segment/span 必须保持可见）。
    const members =
      lines && lines.length > 0 && !explicitUnitSurface?.cellAnchor ? lines.map((l) => l.lineId) : null;
    setCoreInputVisualState({ unitMemberLineIds: members });
    // ★ 空文本缺陷修复（SPEC v2.1 N2/W1）：unit 成员身份 ledger **merge-write**。
    //   · 唯一写入口 = `writeLineIdentity`（entries 无裸赋值写点；源码守卫钉死）；
    //   · 证据门（W0）：仅当该成员行当前仍被**唯一** provenance 主张（scan=unique 且
    //     与成员 paragraphId 一致）才写 —— ledger 来源的值不可回写（禁循环确认）；
    //   · provenance 已缺失（删除场景）⇒ 不写 ⇒ 健康期条目保留（发布不删除）；
    //   · 冲突不覆盖（W3/F1）：旧值段落仍存在 ⇒ 标记 conflict、读时 fail-closed；
    //   · generation 域校验（U3/F4）：与 sidecarGeneration 同源，换文档自然失效。
    // ★ S2-v1：cell 面同样不写身份 ledger —— 该行的 paragraphId 已由 cell 规划器
    //   门 2 显式解析（不需要也不应经 ledger 旁路）；ledger 只服务多行 unit 成员。
    if (lines && lines.length > 0 && !explicitUnitSurface?.cellAnchor) {
      const session = coreInputSessionRef.current;
      const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
      const generation = sidecarGenerationRef.current;
      if (coreDoc && typeof generation === "number" && Number.isFinite(generation)) {
        let ledger = unitIdentityLedgerRef.current;
        for (const l of lines) {
          const claim = scanLineProvenanceClaim(coreDoc, l.lineId);
          if (claim.kind !== "unique" || claim.paragraphId !== l.paragraphId) continue; // 无独立身份证据 ⇒ 不写
          const next = writeLineIdentity(ledger, generation, coreDoc, {
            lineId: l.lineId,
            paragraphId: l.paragraphId,
            evidence: "provenance-unique",
          });
          ledger = next.ledger;
        }
        unitIdentityLedgerRef.current = ledger;
      }
    }
  }, [explicitUnitSurface]);

  // ── D-3B-6 子任务 2A：unit 编辑宿主归一（2026-10-16）─────────────────────
  //   编辑宿主（A′ 写入、contentEditable、blur/sync 全部 keyed 在 editingSegmentId）
  //   恒定为 **unit 首成员行** 的 segment：点击非首成员行（如 l6）时把 editingSegmentId
  //   重定向到首成员行 ⇒ 面几何 = unit 并集（同时消除「编辑框只盖被点行」的裁切），
  //   且点击哪一行都不会再搬宿主（宿主恒 lines[0]）。
  //   ★ 首成员身份 = explicitUnitSurface.unit.lines[0].lineId（编辑目标身份，非坐标猜测）；
  //     segmentId 由 segmentsRef 按 source.lineId 反查（首个 ⇒ 确定性）。
  //   ★ 已是 canonical 首成员段 ⇒ no-op（无环）；定位不到 ⇒ fail-closed 保持既有行为。
  //   ★ canonical = segmentsRef 中**首个** source.lineId === lines[0].lineId 的 segment
  //     （l5 行有两个 segment：「日期：」前缀 + 「2026 年…」主体 ⇒ 点击任一/点击 l6 都必须
  //     归一到同一个，否则宿主随入口漂移 —— 验收探针实测抓到过该不一致）。
  //   ★ 声明位置在 A′ effect（下方 ~6801）**之前** ⇒ 同一 effect-flush 内先重定向，
  //     A′ 随后的运行即以首成员为宿主（被点行的 A′ 写入只存在于一个不可交互的窗口内，
  //     重渲染后该行 demote 并恢复自身原文 —— 与既有宿主搬迁后的恢复行为一致）。
  //   ★ caret 语义不在本步范围（子任务 2B 单独播种；当前 caret 本就恒 0，无回归面）。
  useEffect(() => {
    if (!editingSegmentId || !explicitUnitSurface) return;
    // ★ S2-v1：cell 面**豁免**宿主归一。多行 unit 的归一目的是「宿主恒 lines[0]」
    //   （面几何 = unit 并集）；cell 面只有一个成员行 = 被点行**本身**，宿主必须是
    //   被点 segment 自身。若按首成员段归一，点第 3 格会被重定向到行首格 ⇒ 面变成
    //   第 1 格 ⇒ 静默编辑错格（击穿 S2 验收 1/2：首/中/末列与多段 cell）。
    //   仍显式声明宿主稳定（供 2B 播种消费门），语义与 R1 空态分支一致。
    if (explicitUnitSurface.cellAnchor) {
      hostStableSegRef.current = editingSegmentId;
      return;
    }
    const firstLineId = explicitUnitSurface.unit.lines[0]?.lineId;
    // ★ R1（CARET-LANDING 空态变体 · 登记档案 §5.3.2.1）：重定向不可用 ⇒ **显式声明宿主稳定**。
    //   空态下 unit 成员 lineId 已退化为 `syn:<pid>`（P0-E1 合成）⇒ find 落空 ⇒ 不搬宿主；
    //   若不声明，`hostStableSegRef` 停留在上一会话旧值 ⇒ 2B 消费门（hostStable !== editingSegmentId）
    //   永远早退 ⇒ 空态播种被拦（机理见 §5.3.1 断点 2a）。
    //   V1 只对本次求值负责（surface 变化 ⇒ effect 重跑重新判定）；V2 后续找到 firstSegId 时
    //   下方照常覆盖 ⇒ 不粘滞；V3 无面早退不声明；V4 只服务 2B 的一次性播种判定。
    if (!firstLineId) {
      hostStableSegRef.current = editingSegmentId;
      return;
    }
    const firstSegId = (segmentsRef.current ?? []).find((s) => s.source?.lineId === firstLineId)?.id;
    if (!firstSegId) {
      hostStableSegRef.current = editingSegmentId;
      return;
    }
    hostStableSegRef.current = firstSegId;
    if (firstSegId === editingSegmentId) return;
    setEditingSegmentId(firstSegId);
  }, [editingSegmentId, explicitUnitSurface, setEditingSegmentId]);

  // ── D-3B-6 子任务 2B：caret 点击定位播种（2026-10-16）────────────────────
  //   基线（探测 pre1c/sub2b-baseline）：打开 unit 面后 caret 恒在 unit offset 0
  //   （点 l5/l6 任意 x，输入字符全部落在开头）——点击位置 → caret 的映射完全缺失。
  //   设计：① 全局 capture `pointerdown` 记录最后点击坐标；② editingSegmentId 变化
  //   （打开/换宿主）时把它登记为**待播种源**；③ 消费 effect（声明在 A′ effect 之后）
  //   在「宿主稳定 + A′ 文本已写入」时用 `document.caretRangeFromPoint(点击坐标)` 对
  //   **重建后的面 DOM** 做浏览器原生 hit-test ⇒ DOM 位置 → unit offset（`<br>` 计 1）
  //   ⇒ 复用既有 `reconcileDomCaretAtOffset` 落 caret（与 restoreUnitCaretIfPending
  //   同一原语、同一 markSynced 口径，不另起 selection 写入通道）。
  //   ★ 播种一次性：消费即清除；宿主迁移窗口（重定向 setState 未落地）不消费，
  //     等 canonical 宿主稳定后的下一轮再落（消费 effect 依赖 editingSegmentId 重入）。
  //   ★ 非命中（点在面外/工具栏）⇒ caretRangeFromPoint 不落在面内 ⇒ 不播种（caret
  //     保持既有行为），不猜测。
  const lastPointerDownRef = useRef<{ x: number; y: number; hitSegId: string | null } | null>(null);
  const unitCaretSeedRef = useRef<{ x: number; y: number; hitSegId: string | null } | null>(null);
  const hostStableSegRef = useRef<string | null>(null);
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      // ★ R2（登记档案 §5.3.2.2 L1）：**原子**记录「坐标 + 命中段」——三者同一次事件读出。
      //   capture 阶段（面出现前的 DOM）⇒ elementFromPoint 拿到的是 legacy segment 的原始命中；
      //   空态下宿主 rect 稍后会被面样式覆盖为 unit 盒，事后取命中段会错（§5.3.1 几何事实）。
      const hit = (typeof document !== "undefined" ? document.elementFromPoint(e.clientX, e.clientY) : null) as HTMLElement | null;
      const hitSegId = hit?.closest?.("[data-segment-id]")?.getAttribute("data-segment-id") ?? null;
      lastPointerDownRef.current = { x: e.clientX, y: e.clientY, hitSegId };
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, []);
  useEffect(() => {
    if (!editingSegmentId) {
      unitCaretSeedRef.current = null;
      return;
    }
    const pd = lastPointerDownRef.current;
    unitCaretSeedRef.current = pd ? { x: pd.x, y: pd.y, hitSegId: pd.hitSegId } : null;
  }, [editingSegmentId]);

  // ★ F3B-6.27-B2：只读暴露**当前编辑面几何**（含 Core 空间的 coreTop/coreBottom）。
  //   用途：段落边界判据落在 **Core 空间**（`coreBottom <= nextCoreParagraphTopCore`），
  //   不依赖 DOM↔Core 的 Y 配准（G9-YREG）。
  //   ⚠️ 纯只读观测面，与 `__coreGlyphCommands` 同构，不被生产代码消费。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__editingSurfaceGeometry = editingSurface
      ? {
          paragraphId: editingSurface.paragraphId,
          coreTop: editingSurface.coreTop,
          coreBottom: editingSurface.coreBottom,
          clippedToNextParagraph: editingSurface.clippedToNextParagraph,
          left: editingSurface.left,
          top: editingSurface.top,
          width: editingSurface.width,
          height: editingSurface.height,
        }
      : null;
  }, [editingSurface]);

  // ★ F3B-6.27-③：「编辑面**当前**承载的是整段还是切片」—— **显式事实，不推断**。
  //
  //   为什么必须是显式的：`coreCaretOptionsFor` 里 base 是否要减，取决于「此刻 DOM 里
  //   装的是切片还是整段」。此前用「该行是否多 segment」这个**静态事实**代替，
  //   两者在「进入编辑、还没发生 mutation」时恰好一致（都是切片），
  //   但一旦把整段文本写进面（方案 A 的同步、或进入即写），静态事实就变成**过期**。
  //   实测：把整段文本在进入时写入后面（那一版已撤回）立刻出现
  //   「不传 target 的播种点判不出 regime ⇒ 回退『切片 ⇒ 加 base』⇒ 每键重复计 base」
  //   ⇒ 字符散落、间隔恰为 base（实测 测(9) 试(12) 追(15) 加(18)）。
  //
  //   写点只有一处语义：**谁把整段文本写进了这个面**。由该处登记、由退出/切片写点清空。
  const wholeParagraphSurfaceRef = useRef<string | null>(null);
  // D-3B-6 子任务 2A：**最后一次 unit 面写入的宿主** segment id（专用追踪）。
  // wholeParagraphSurfaceRef 会被 entry-sync / general 等多条路径赋值，不能作为
  // 「unit 文本已写入该宿主」的依据 ⇒ 写入守卫的「宿主变更」判据改用本 ref。
  const lastUnitWriteHostRef = useRef<string | null>(null);

  // ★ 写入编辑面几何 —— **必须**位于上面的 useMemo 之后。
  //   `coreRenderSource`（4554）在原 `setCoreInputVisualState` effect（3837）**之后**定义，
  //   所以几何 useMemo 不可能排到那个 effect 之前；改为**第二个** effect 写同一个 store
  //   （`setCoreInputVisualState` 是 Partial 合并，两次调用安全）。
  //   ⚠️ 切勿把 `editingSurface` 放进上面那个 effect 的**依赖数组** ——
  //   依赖数组在渲染期求值，会读到尚未初始化的 const ⇒ TDZ 崩溃
  //   （实测 `ReferenceError: Cannot access 'editingSurface' before initialization`）。
  useEffect(() => {
    setCoreInputVisualState({
      // ★★ P0-F1：`effectiveEditingSurface` = 显式 unit 面 ?? 既有单 paragraph 面。
      //   注入缺省时它**就是** `editingSurface` ⇒ 生产行为逐字节不变（F1.9 / G5）。
      editingSurface: corePresentationActive ? effectiveEditingSurface : null,
    });
  }, [corePresentationActive, effectiveEditingSurface]);

  // ══ F3B-6.27：发布「提交收口上下文」（transport，非 authority）════════
  //
  //  发布条件（三者全部成立才发布 wholeParagraph 上下文）：
  //    ① regime 事实：该面**确实**承载完整 Core 段落
  //       （`wholeParagraphSurfaceRef` —— A′ 写入整段的那一刻登记的事实）
  //    ② Binding ownership 命中本段（`segmentRangeOf`）
  //    ③ fence：ledger 的 fence 与当前 Core document version 一致
  //       （否则 ctx 会携带 stale range ⇒ 提交时切错位置）
  //
  //  ⚠️ 为什么 consumer 侧还要再校验一遍 identity/fence：
  //    EditableTextNode 无权读 Core document，拿不到独立的「当前值」，
  //    只能把 ctx 自身透传给 contract ⇒ 那里的校验退化为**自洽校验**。
  //    **真正的 fence 在这里（producer）**，contract 侧是纵深防御。
  const segmentCommitContext = useMemo((): SegmentCommitContext | null => {
    if (!corePresentationActive) return null;
    if (!editingSegmentId) return null;
    // ① regime 事实
    if (wholeParagraphSurfaceRef.current !== editingSegmentId) return null;
    const session = coreInputSessionRef.current;
    const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
    const caretPos = session?.history?.state?.caret?.position ?? null;
    const paragraphId = corePresentation?.sourceCaret?.position?.paragraphId ?? caretPos?.paragraphId ?? null;
    if (!paragraphId || !coreDoc) return null;
    // ③ fence：ledger 必须与当前 Core 版本对齐
    if (segmentRangeFenceRef.current !== coreDoc.version) return null;
    // ② ownership 命中
    const own = segmentRangeOwnershipOf(paragraphId);
    if (!own) return null;
    const r = segmentRangeOf(own, editingSegmentId);
    if (!r) return null;
    return {
      wholeParagraph: true,
      paragraphId,
      segmentId: editingSegmentId,
      startUtf16: r.startUtf16,
      endUtf16: r.endUtf16,
      generation: coreDoc.version,
    };
  }, [
    corePresentationActive,
    editingSegmentId,
    corePresentation,
    coreInputTick,
    segmentRangeOwnershipOf,
  ]);

  // 独立 effect（与几何 effect 同款惯例：`coreRenderSource` 定义较晚，不能塞进上面的依赖）
  useEffect(() => {
    setCoreInputVisualState({ segmentCommitContext });
  }, [segmentCommitContext]);

  const editedLineBoxesCoreGeo = useMemo(() => {
    const src = coreRenderSource;
    if (!coreRenderEnabled || !src || !src.ok) return editedLineBoxes;
    const session = coreInputSessionRef.current;
    const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
    if (!coreDoc) return editedLineBoxes;
    if (editedLineBoxes.size === 0) return editedLineBoxes;

    // paragraphId → 该段落在 Core 中实际绘制出的视觉行盒子
    const byParagraph = new Map<string, CoreVisualLineBox[]>();
    const layoutVersion = new Map<string, number>();
    for (const layout of src.layouts) {
      for (const p of layout.paragraphs) {
        byParagraph.set(
          p.paragraphId,
          p.lines.map((l, i) => ({
            paragraphId: p.paragraphId,
            lineIndex: i,
            x: l.box.x,
            y: l.box.y,
            width: l.box.width,
            height: l.box.height,
          }))
        );
        layoutVersion.set(p.paragraphId, layout.documentVersion);
      }
    }
    if (byParagraph.size === 0) return editedLineBoxes;

    let changed = false;
    const next = new Map(editedLineBoxes);
    for (const [lineId, legacyBox] of editedLineBoxes) {
      const paragraphId = coreParagraphIdForLineId(coreDoc, lineId);
      if (!paragraphId) continue;
      const decision = coreMaskGeometry({
        paragraphId,
        coreLines: byParagraph.get(paragraphId) ?? [],
        legacyBox,
        generation: layoutVersion.get(paragraphId) ?? coreDoc.version,
        currentGeneration: coreDoc.version,
      });
      if (!decision.box) continue; // fail-open：保留 legacy 盒
      if (
        decision.box.x !== legacyBox.x ||
        decision.box.y !== legacyBox.y ||
        decision.box.width !== legacyBox.width ||
        decision.box.height !== legacyBox.height
      ) {
        next.set(lineId, decision.box);
        changed = true;
      }
    }
    return changed ? next : editedLineBoxes;
  }, [coreRenderEnabled, coreRenderSource, editedLineBoxes]);

  // ══════════════════════════════════════════════════════════════════════
  // ★ F3B-6.27-G6（Step 3）：**E2-EXCEPTION** —— Core-owned 活跃编辑面文本同步
  //
  // 缺陷（实测）：`EditableTextNode` 只在**进入编辑那一刻**写一次
  //   `ref.current.textContent = segment.text`，编辑期间 DOM 文本被冻结。
  //   编辑前 DOM/Core 逐字逐宽一致（13/13、280/280）；编辑后 `DOM 13 / Core 14`
  //   ⇒ 画布比编辑面宽 ⇒ **caret 封顶 12/13**，点右边缘（x ≥ 646）**掉出编辑面**。
  //
  // 触发源（唯一，**不以 `segment.text` 为触发** —— 实测 Core mutation 后它恒不变）：
  //   EditorTransaction / Core after ──▶ Binding（本 effect）──▶ active editing surface
  //
  // 边界（E2-EXCEPTION 全集，见 components/core-editing-visual.test.ts 头注）：
  //   · 仅「isEditing ∧ Core-owned surface ∧ 已有 Core current text」才写
  //   · **不写 `segment.text` / `originalText`**（本 effect 完全不碰 segments）
  //   · 不用于非编辑态 display / mask（mask 走 `__editedLineBoxes` 既有通道）
  //   · 不由 glyph / x / DOM 反推文本（文本直接取 Core paragraph）
  //   · 不创建 segment（实测 Core mutation 不改变 identity：28 → 28）
  //   · 写 textContent 后用既有 `reconcileDomCaretAtOffset` 恢复 caret
  //   · generation 令牌阻止**陈旧** Core mutation 覆盖新编辑状态
  //
  // 位置说明：放在 `onKeyDownCapture` **之后** ⇒ 不落入 T6c 的 `coreListener` 区间；
  // 本文件不触碰 `EditableTextNode` ⇒ T6a 的「`textContent =` 仅 1 处」**原样保留**。
  // ══════════════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════════════
  // ★ F3B-6.27-STEP4：**「DOM 编辑面是否承载整段」= 单一真相**
  //
  // 背景（实测，见 tests/e2e/f3b627-caret-timeline.spec.ts）：
  //   方案 A 之后多段行的 `scope.textContent` ≡ Core 段落全文 ⇒ DOM offset 与
  //   Core paragraph offset **恒等**。但 4 个 Core→DOM caret 回写点仍在按
  //   「scope 只装 segment 切片」的旧语义**减 segment base** ⇒ 每次输入后 caret
  //   被左移 `len(前序 segment)`（`日期：` 那行实测 33 → 30，四个字符完全一致）。
  //
  // 为什么必须显式化（而不是让每个调用点自己推断）：
  //   「减不减 base」完全取决于编辑面方案，而方案会变。若把判断藏在每个 handler 里，
  //   方案一变就会**静默**错位（这正是 IB-2-D 假设在方案 A 下的失效方式）。
  //   故抽成一个共用判定：**A′ 同步 effect 与全部 Core→DOM caret 回写点同源**。
  //
  // 口径：**权威 paragraphId 由调用点传入**（A′ effect 用 `corePresentation.sourceCaret`，
  //   caret 回写点用 `session.history.state.caret` —— 后者本就是这些站点 `rangeBaseOf` 用的
  //   paragraphId，故 base 判定与 base 取值必然同源）。
  //   ⚠️ 曾试过「由 segment 自己的 lineId 反推 paragraphId」，实测与权威值**不等** ⇒ 判定翻假、
  //      base 又被减（末态 caret 36−3=33）。paragraphId 一律外部传入，不反推。
  //
  // 计数口径：用**已验证解析器** `coreParagraphIdForLineId`（lineId → paragraphId），
  //   统计该 Core 段落对应的 legacy segment 数；`!== 1` ⇒ 承载整段。
  //   **不裸比 `source.lineId`**（lineId 不是稳定 identity：实测 l5→2、l13/l16/l20→3）。
  // ══════════════════════════════════════════════════════════════════════
  const domSurfaceCarriesWholeParagraph = useCallback(
    (_paragraphId: string | null | undefined, segmentId?: string | null): boolean => {
      const sid = segmentId ?? editingSegmentId;
      if (!sid) return false;
      // ★★ F3B-6.27-P0（用户裁决）：**regime 的唯一 authority = 已发生的事实**。
      //
      //   原则：**「当前 DOM 长什么样」不能作为 regime 的 authority；
      //   「系统已经确认进入哪种 regime」才是 authority。**
      //   （与 fence / ownership / paragraph surface 同一设计方向：
      //     不要从结果反推状态；状态必须由明确的生命周期事件建立。）
      //
      //   `wholeParagraphSurfaceRef` 由 A′ 同步 effect 在**真正写入整段**的那一刻登记
      //   （见写入点 `wholeParagraphSurfaceRef.current = multiSegmentSurface ? … : null`），
      //   退出编辑时撤销 ⇒ 它的语义就是「本次生命周期内已发生过整段写入」。
      //
      //   ❌ 已被本裁决移除的两个判据（都曾实测出错）：
      //     ① `domText === paragraphText`（内容比较）
      //        —— DOM 是**结果**。且在 A′ 写入**之前**的瞬间它必然不等
      //        （DOM 还是旧文本、Core 已是新文本）⇒ 第二次按键起 caret 被多减一次 base
      //        ⇒ 实测连续输入 "ABCDE" 得 "BCDE以补A"（回退量恰为 base=3）。
      //     ② `segmentCountForCoreLine !== 1`（静态计数）
      //        —— 计数描述的是「稳态拓扑」，与「面此刻装的是什么」无关。
      //        实测进入编辑瞬间 DOM 是 29 字切片，而计数已判为整段面。
      return wholeParagraphSurfaceRef.current === sid;
    },
    [editingSegmentId]
  );

  /**
   * ★★ F3B-6.27-STEP②：一次算出**彼此一致的一对**（boolean + base）。
   *
   * `reconcileDomCaretFromCore` → `resolveSegmentBaseForScope` 在
   * 「`domCarriesWholeParagraph=true` 却给非 0 base」时**故意 fail-closed**（`base-contradiction`）。
   * 那个守卫是对的（IB-2-D 的隐含假设在方案 A 下失效时正是靠它拦住静默错位），
   * 但此前 4 个回写点各自独立传这两个值 ⇒ 静态 boolean 与 base 天生可能矛盾
   * ⇒ caret 回写**静默失效**。故让两者**同源**：
   * 判为整段 ⇒ base 必为 0；判为切片 ⇒ base 取 `rangeBaseOf`。
   *
   * 判据本身仍由 `domSurfaceCarriesWholeParagraph`（内容优先）给出，此处不做二次推断。
   */
  const surfaceBasePairFor = useCallback(
    (
      paragraphId: string | null,
      segmentId: string | null,
      document: Parameters<typeof segmentParagraphBaseUtf16>[2]
    ): { domCarriesWholeParagraph: boolean; segmentStartUtf16: number } => {
      const whole = domSurfaceCarriesWholeParagraph(paragraphId, segmentId);
      return {
        domCarriesWholeParagraph: whole,
        segmentStartUtf16: whole
          ? 0
          : rangeBaseOf(
              paragraphId,
              segmentId,
              segmentParagraphBaseUtf16(segmentsRef.current ?? [], segmentId, document)
            ),
      };
    },
    [domSurfaceCarriesWholeParagraph]
  );

  useEffect(() => {
    if (editingSegmentId == null) {
      // ★ F3B-6.27-③ 退出编辑 ⇒ 撤销登记（面不再承载整段）
      if (wholeParagraphSurfaceRef.current !== null) wholeParagraphSurfaceRef.current = null;
      // D-3B-6 子任务 2A：unit 写入宿主同步注销（新会话重新按宿主变更判据放行写入）
      if (lastUnitWriteHostRef.current !== null) lastUnitWriteHostRef.current = null;
      return;
    }
    const session = coreInputSessionRef.current;
    const coreDoc = session ? documentOf(session) : coreDocumentRef.current;
    // 元素定位沿用既有 sanctioned 方式（与 computeSegmentDomRange/Offset 同款）
    const scope =
      Array.from(document.querySelectorAll<HTMLElement>("[data-segment-id]")).find(
        (n) => n.getAttribute("data-segment-id") === editingSegmentId
      ) ?? null;
    if (!coreDoc || !scope) return;
    const domText = scope.textContent ?? "";
    // Core 真值：只取 Core paragraph 文本（**绝不**从 DOM / glyph / x 推导）
    const caretParagraphId = corePresentation?.sourceCaret?.position?.paragraphId ?? "";
    // ★ F3B-6.27-H2：A′ 的文本源改为**编辑目标身份**（不再裸读 caret 段落）。
    //
    //   H2 之前此处直接取 caret 所在段落，且**没有**任何「该段落是否为面所绑定段落」
    //   的校验 ⇒ 拆分后 caret 迁到新段落 ⇒ A′ 把新段落文本写进旧段落的编辑面
    //   ⇒ blur 二次提交把新文本灌回旧段落（T1 实测：原段落被替换成长×40 + 原文）。
    //
    //   · 有**有效**目标 ⇒ 以目标为准（与编辑面身份、seed、blur 短路同源）
    //   · 无目标 ⇒ 逐字节保持既有行为（caret 段落）
    //   · caret 段落与目标**不一致** ⇒ fail-closed noSync（下方 ① 守卫）
    let reboundPid2: string | null = null;
    let reboundPid: string | null = null;
    const segNowH2 = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId);
    const segLineIdH2 = (segNowH2?.source as { lineId?: string } | undefined)?.lineId;
    // caret 的取法必须与 `coreCaretOptionsFor` **完全一致**
    // （`state.caret?.position ?? state.selection?.range?.focus`）—— 否则在某些
    // 事务后 `caret` 尚未设置 ⇒ 传入 null ⇒ 判定 fail-closed（rebind 静默不生效）。
    //   ⚠️ Core 的 caret/selection position 恒携带完整的 {textBoxId, paragraphId}
    //      （C1 实测），这里的可选性只是 selection 联合类型的宽化 ⇒ 显式收窄。
    const reboundCaretPos =
      (session?.history?.state?.caret?.position ??
        (session?.history?.state?.selection?.range?.focus as
          | { textBoxId?: string; paragraphId?: string }
          | undefined) ??
        null) as { textBoxId: string; paragraphId: string } | null;
    // ★ H2 · rebind 站点：
    //   H2-C 实测（`__h2cProbe`）：拆分事务在 beforeinput 成功分支即携带完整证据
    //   （`tx_5i / split-paragraph / created=[para_5g] / caretAfter=para_5g`），
    //   且 `lastSplitMutationRef` / `appliedTransactionIdRef` 在**下一次** mutation
    //   提交时被覆盖/清空（单发语义）⇒ rebind 必须发生在「拆分后的第一次 A′」：
    //   此刻证据仍在、Core caret 已收敛到新段落 ⇒ 证据与状态同时成立的唯一时刻。
    //   实测归属事实：新段落的 run **没有** lineId（shared-lineId 只存在于原段落），
    //   故 ① `ownedParagraphIdForBinding` 对新段落返回 null —— 这不是缺陷，
    //   恰恰使 H1 的 ① 不会把 rebind 拉回旧段落（④⑤⑥ 由拆分事务证据完成判定）。
    try {
      reboundPid = resolveEditingCaretParagraphId({
        document: coreDoc,
        caretPosition: reboundCaretPos,
        lineId: segLineIdH2,
        mutation: lastSplitMutationRef.current,
        appliedCount: session?.history?.appliedCount ?? 0,
        appliedTransactionId: appliedTransactionIdRef.current,
      });
      // ★ H2-C 实测更正：生产 beforeinput 路径的 transactionId **正常**
      //   （`__h2cProbe` 实测 `tx_5i / split-paragraph / created=[para_5g]`）。
      //   快照差集仅作为 H1 判据（①–⑥）中任一条不成立时的**等价证据**保留：
      //   两者的证据强度相同（都来自同一笔已提交事务），并非第二套猜测机制。
      reboundPid2 =
        reboundPid ??
        (() => {
          const entriesNow: any[] = (session?.history?.entries?.() ?? []) as any[];
          // ★ H2-B 实测修正：必须取「**已应用**栈顶」事务，而不是栈内最后一条 ——
          //   undo 会把 applied cursor 回退，但 stack 尾部仍保留 redo 分支的旧事务；
          //   「拆分证据」的语义主体是**当前 applied** 的事务（与 H1 的
          //   `appliedTransactionId` 同一口径）。取栈尾会使 redo 恢复出的新段落
          //   拿不到任何证据 ⇒ 身份停在旧段落 ⇒ 后续输入落错段落（S2 实测）。
          const appliedTop = session?.history?.appliedCount ?? 0;
          const lastTxNow: any = appliedTop > 0 ? entriesNow[appliedTop - 1] : null;
          return resolveEditingTargetRebind({
            document: coreDoc,
            target: editingTargetRef.current,
            segmentId: editingSegmentId,
            caretParagraphId:
              (reboundCaretPos as { paragraphId?: string } | null)?.paragraphId ?? null,
            beforeDocument: lastTxNow?.before?.document ?? null,
            afterDocument: lastTxNow?.after?.document ?? null,
          });
        })();
      if (reboundPid2 && reboundPid2 !== editingTargetRef.current?.paragraphId) {
        const nextTarget = establishEditingTarget({
          segmentId: editingSegmentId,
          paragraphId: reboundPid2,
          document: coreDoc,
          generation: coreDoc.version,
        });
        if (nextTarget) {
          editingTargetRef.current = nextTarget;
          setEditingTargetTick((t) => t + 1);
        }
      }
    } catch {
      /* rebind 失败 ⇒ 保持既有身份（不得吞掉已建立的合法身份） */
    }
    //   本文件既有注释已实测 `corePresentation.sourceCaret` 在同一 tick 内可能仍是
    //   **提交前**的值 ⇒ 用它判分歧会误判（把合法同步挡掉）。
    const realtimeCaretParagraphId =
      (session?.history?.state?.caret?.position as { paragraphId?: string } | undefined)?.paragraphId ??
      (session?.history?.state?.selection?.range?.focus as { paragraphId?: string } | undefined)
        ?.paragraphId ??
      null;
    const targetMaintain = resolveEditingTargetMaintain({
      target: editingTargetRef.current,
      segmentId: editingSegmentId,
      document: coreDoc,
      caretParagraphId: realtimeCaretParagraphId ?? (caretParagraphId || null),
      currentGeneration: coreDoc.version,
    });
    //   ⚠️ 仍保留「无 Core presentation ⇒ 无文本真值」的既有语义：
    //      `corePresentation` 为空时 `caretParagraphId` 恒为 ""，此时即使身份有效
    //      也不得凭空取得文本 ⇒ 逐字节保持既有 noSync 行为。
    const paragraphId =
      targetMaintain.ok && corePresentation ? targetMaintain.paragraphId : caretParagraphId;
    // ① H2 分歧守卫：目标存在且 caret 已迁出目标 ⇒ 本面不该被这次 mutation 覆盖。
    //   ★ D-3B-6 子任务 2A/2B 修正（2026-10-16）：unit 面**豁免**本守卫。
    //     实测耦合：unit 编辑宿主归一（2A）重定向到首成员行后，caret-divergence 把
    //     canonical 新宿主拦下（caret 已被播种在另一成员行的 region，如点 l6 输入后
    //     重定向到 l5 宿主）⇒ unit 文本不写入 ⇒ 面塌缩成宿主 segment 自身单行文本。
    //     unit 面的 authoritative text 是 unit 级 `explicitUnitSurface.text`（F2.9），
    //     caret 在成员行间移动/播种是该面的**正常语义**；T1（拆分后 caret 迁出）防护
    //     已由 H2 编辑目标身份（editingTargetRef）承担 ⇒ unit 模式不适用本判据。
    //     （判据用 `explicitUnitSurface === null`：`isUnitSurfaceText` 在 F2.9 处才声明。）
    if (
      explicitUnitSurface === null &&
      editingTargetRef.current !== null &&
      caretParagraphId !== "" &&
      !targetMaintain.ok &&
      targetMaintain.reason === "caret-divergence"
    ) {
      return;
    }
    const coreText = corePresentation ? paragraphTextOf(coreDoc, paragraphId) : null;
    // ══════════════════════════════════════════════════════════════════
    // ★★ F2.8(a) + F2.9 · **authoritative text 的唯一来源**
    //
    // 缺陷（F2.8 修复后实测）：unit 面**几何**已生效，但 DOM 文本仍是单 paragraph 文本
    //   ⇒ 因为本 effect 的同步判定 `coreText` 取的是 `corePresentation.sourceCaret`
    //   所在**单 paragraph** 的文本；unit 模式下 DOM 已等于它 ⇒ 命中「already-in-sync」
    //   幂等分支 ⇒ `decision.sync === false` ⇒ `if (!decision.sync) return;` 提前返回
    //   ⇒ `explicitUnitSurface.text`（P0-C/P0-E2-B 冻结的 unit 文本，含 structural separator）
    //   **从未被写进 DOM**。
    //
    // ★★ F2.9 的口径（本 effect 内**只允许有一个** authoritative text 决策点）：
    //   `unitAuthoritativeText` 是 unit surface 文本的**唯一来源**，
    //   下面**两个**消费点都必须读它，**禁止**各自重算：
    //     ① 同步判定的 `coreText` 输入（本行）
    //     ② DOM 写入点的 `text`（见下方「★ F2.9」注释）
    //   ⇒ 判定与写入**结构上**不可能不一致（这正是 F2.8(a) 之前的状态：
    //     两处各自算，判定算单段、写入算 unit ⇒ 永远命中 already-in-sync）。
    //
    //   · unit 模式 ⇒ authoritative text = `explicitUnitSurface.text`（含 structural separator）
    //   · 非 unit 模式 ⇒ `unitAuthoritativeText === null`，判定输入恒等于既有 `coreText`，
    //     写入点恒走既有 coreText / sliceTextFor / decision.text 链条 ⇒ **逐字节不变**
    //   · unit 模式 ⇒ 跳过 A3-2 入口同步（它写的是**单 paragraph** 文本，会覆盖 unit 文本）
    // ══════════════════════════════════════════════════════════════════
    const unitSurface = explicitUnitSurface;
    const unitAuthoritativeText = unitSurface ? unitSurface.text : null;
    const isUnitSurfaceText = unitAuthoritativeText !== null;
    const syncCoreText = unitAuthoritativeText !== null ? unitAuthoritativeText : coreText;
    // ★ F3B-6.27 实现 checkpoint：确保该行的 SegmentRangeLedger 已建立
    //   （种子来自已验证的 Binding 原语，失败 ⇒ 本行为无 ownership ⇒ 回退既有行为）
    //
    // ★★ F3B-6.27-H2（**本轮修复**）：守卫判据由「caret 段落」改为
    //   「**ledger 实际绑定的段落**（未建立时按 lineId 解析）」。
    //
    //   原因（H2 只读追踪实证）：`paragraphId` 在 H2 之后是**编辑目标段落**（拆分后 = 新段落），
    //   而新段落**永远没有** ownership（它没有 legacy segment / glyph range，
    //   `ensureSegmentRangeLedger` 内部按 segment 自身 glyph 区间推导 ⇒ 建出来的仍是旧段落）
    //   ⇒ 旧守卫 `!segmentRangeOwnershipOf(paragraphId)` 恒为 true ⇒ **每次 A′ 执行都重建
    //   ledger**（`createLedger(ownership, 0)` + 重设 fence）⇒ 事务栈与 fence 被反复重置。
    const ownershipParagraphId =
      segmentRangeParagraphRef.current ??
      (() => {
        const segLineId = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId)
          ?.source?.lineId;
        return segLineId ? coreParagraphIdForLineId(coreDoc, segLineId) : null;
      })();
    if (ownershipParagraphId && !segmentRangeOwnershipOf(ownershipParagraphId)) {
      ensureSegmentRangeLedger(editingSegmentId, coreDoc);
    }
    // ★ 该 Core 段落对应**多少个** legacy segment —— 用**已验证的解析器**
    //   （coreParagraphIdForLineId：lineId → paragraphId）统计，**不裸比 source.lineId**
    //   （lineId 不是稳定 identity；实测 multi-segment 行 l5→2、l13/l16/l20→3）。
    //   N !== 1 ⇒ 判定层 fail-open，绝不把整段文本灌进单个 segment（会复制兄弟段文本）。
    const segmentCountForCoreLine = (() => {
      if (!paragraphId) return 0;
      const target = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId);
      if (!target?.source?.lineId) return 0;
      let count = 0;
      for (const s of segmentsRef.current ?? []) {
        const lid = s.source?.lineId;
        if (!lid) continue;
        if (coreParagraphIdForLineId(coreDoc, lid) === paragraphId) count += 1;
      }
      return count;
    })();
    // ★ 最新事务的 command ⇒ 两条边界守卫的输入（**权威数据，非推导**）
    //   · commandKind：非 insert/delete/replace（含 split-paragraph）⇒ 不同步
    //     （实测 Enter 会新增段落 ⇒ 段→段落映射改变，算法语义不适用）
    //   · isCrossRun：range 跨越多个 run ⇒ 不同步
    //     （实测跨段插入的预测值比真值少 1 字符）
    const { commandKind, isCrossRun } = (() => {
      const NO = { commandKind: "other" as const, isCrossRun: false };
      const entries = session?.history?.entries?.() ?? [];
      const tx: any = entries.length > 0 ? entries[entries.length - 1] : null;
      const cmd: any = tx?.command;
      if (!tx || !cmd) return NO;
      const kind =
        cmd.type === "insert-text"
          ? ("insert" as const)
          : cmd.type === "delete-text"
            ? ("delete" as const)
            : cmd.type === "replace-text"
              ? ("replace" as const)
              : cmd.type === "split-paragraph"
                ? ("split-paragraph" as const)
                : ("other" as const);
      if (!cmd.range) return { commandKind: kind, isCrossRun: false };
      // 在**事务 before 快照**里求段落偏移（此时 run 结构完好）
      const beforeDoc: any = tx.before?.document;
      const para = beforeDoc
        ? (beforeDoc.pages ?? [])
            .flatMap((pg: any) => pg.objects ?? [])
            .flatMap((o: any) => (o.type === "text" ? (o.paragraphs ?? []) : []))
            .find((p: any) => p.id === cmd.range.anchor.paragraphId)
        : null;
      if (!para) return { commandKind: kind, isCrossRun: true }; // 判不出 ⇒ fail-open
      const offIn = (runId: string, off: number): number => {
        let acc = 0;
        for (const r of para.runs ?? []) {
          if (r.id === runId) return acc + off;
          acc += (r.text ?? "").length;
        }
        return Number.NaN;
      };
      const a = offIn(cmd.range.anchor.runId, cmd.range.anchor.offset);
      const f = offIn(cmd.range.focus.runId, cmd.range.focus.offset);
      if (!Number.isFinite(a) || !Number.isFinite(f)) return { commandKind: kind, isCrossRun: true };
      const lo = Math.min(a, f);
      const hi = Math.max(a, f);
      const anchorRun = (para.runs ?? []).find((r: any) => r.id === cmd.range.anchor.runId);
      if (!anchorRun) return { commandKind: kind, isCrossRun: true };
      const runStart = offIn(anchorRun.id, 0);
      const runEnd = runStart + (anchorRun.text ?? "").length;
      return { commandKind: kind, isCrossRun: !(lo >= runStart && hi <= runEnd) };
    })();
    // ★★ F3B-6.27-A3-2：**入口同步路径**（Scheme A entry-state）
    //
    //   目标状态机（用户裁决）：点击任意 segment → **立即**以整个 Core 段落进入编辑态。
    //
    //     click segment
    //       → resolve paragraph（lineId → paragraphId，已验证解析器）
    //       → read Core paragraph text
    //       → compute click → paragraph offset
    //       → 写整段到 DOM
    //       → restore paragraph caret（**同一位置**，不是段末）
    //       → wholeParagraphSurfaceRef = segmentId  ⇒ regime B 从入口即成立
    //
    //   ⚠️ **纯视图同步**：不改 Core document、不产生任何 command、不进 History、
    //      不改 document version。与下方「text command → sync」是**两条独立路径**
    //      （刻意不把入口复用成伪造的 mutation —— 那会污染 undo 栈与 ownership）。
    //
    //   仅对**多段段落面**生效（`segmentCountForCoreLine > 1`）；
    //   单段行逐字节保留原「切片面」行为。
    // ══════════════════════════════════════════════════════════════════
    // ★★ F2.8(a)-2 · unit 模式的**入口写入**（无 Core transaction 时）
    //
    // 为什么需要这一条独立分支（实测定位，非推测）：
    //   主判定路径 `decideCoreEditingSurfaceSync` 的 ④''' 守卫规定
    //   「非文本命令 ⇒ fail-open」；而**刚进入编辑、尚未产生任何 Core 事务**时
    //   `commandKind === "other"` ⇒ 恒 `non-text-command` ⇒ 永不写入。
    //   （F2 实测 `coreSize = 0`；此前 DOM 能拿到单段文本，靠的正是下方 A3-2 入口分支。）
    //   A3-2 写的是**单 paragraph** 文本，在 unit 模式下会覆盖 unit 文本 ⇒ 已在其
    //   条件里排除（`!explicitUnitForSync`）。于是 unit 模式需要**自己的**入口写入。
    //
    // 口径（刻意最简）：
    //   · 文本真值 = `explicitUnitSurface.text`（P0-C/P0-E2-B 冻结，含 structural separator）
    //   · **不做** caret 恢复：unit 的 offset 映射属 F5 范围（P0-F1 已登记该限制）
    //   · **不做** base / slice 运算：unit DOM offset ≡ unit offset
    //   · **不改** Core document、不产生 command、不进 History（与 A3-2 同性质）
    //   · 幂等：文本已等于 unit 文本 ⇒ 不重复写（不扰动 caret）
    // ══════════════════════════════════════════════════════════════════
    // ══ F5 · unit caret 恢复（唯一入口）═════════════════════════════════════
    //   · **不做** boundary 收敛：只把 offset 交给 `reconcileDomCaretAtOffset`
    //     （其内部走 `planDomCaretOffsets`）⇒ 不产生第二套 caret 规则
    //   · **不新增** selection 写入代码：与单段路径复用同一个调和函数
    //   · 幂等键口径与单段路径完全一致 ⇒ 恢复 caret 触发的 `selectionchange`
    //     不会被 `onSelectionChange` 当成「用户移动 caret」回写 Core（否则逐字倒序）
    //   · 形状恒为「判定 → 既有表达式」，**绝不**引入 recovery 分支
    const restoreUnitCaretIfPending = (scopeEl: HTMLElement, text: string): void => {
      const pending = pendingUnitCaretRef.current;
      if (!pending) return;
      // ★ 严格失效（缺一不可）：unitId 相同 **且** 文本逐字节相等。
      //   「长度相同」不足（"ABCX" 与 "ABCD" 长度一致、caret 语义不同）。
      if (pending.unitId !== unitSurface?.unit.unitId || pending.expectedText !== text) {
        pendingUnitCaretRef.current = null;
        return;
      }
      // ★ 一次性：无论调和成功与否都不再复用 ⇒ 过期 caret 永不生效
      pendingUnitCaretRef.current = null;
      reconcileDomCaretAtOffset({
        scope: scopeEl,
        startOffsetUtf16: pending.offset,
        endOffsetUtf16: pending.offset,
        expectedText: text,
        markSynced: (applied) => {
          lastCoreSelectionSyncRef.current = `${editingSegmentId}:${applied.start}`;
        },
      });
    };

    // ★ F5 失效规则：**非 unit 写入路径** ⇒ pending caret 立即作废。
    //   放在写入判定**之前**（而非某个具体写入点），从而一并覆盖 A3-2、单段 / 切片写入，
    //   不依赖各分支的 return 形状。用户在 unit 事务后主动移动 caret，再触发任何非 unit
    //   写入 ⇒ 光标**不会**被强行拉回（F5-4）。
    if (!isUnitSurfaceText) pendingUnitCaretRef.current = null;

    // ★ 4B-4D-1 Composition Guard：组合期间**不重写 unit surface**。
    //   `textContent=` 会清除全部子节点（含 `<br>`）⇒ 会摧毁 Core partition 的视觉断点。
    //   composition 期间 DOM 归浏览器；`compositionend` 后由既有逻辑统一对账。
    //   ⚠️ 只作用于 unit 面：单段面 A′ 行为逐字节不变。
    // ★ D-3B-6 子任务 2A 连带修复（2026-10-16）：写入条件除「文本不同」外，还要
    //   「**最后一次 unit 写入的宿主 ≠ 当前宿主**」（`lastUnitWriteHostRef`）——
    //   上一会话遗留的恰好相同的文本 + 宿主被多路径 ref 覆盖时，旧守卫会跳过写入
    //   ⇒ 随后 React 渲染把 DOM 重置为宿主 segment 自身文本 ⇒ 面塌缩成单行
    //   （实测：Escape 后重开，面 len 40→3）。宿主变更 ⇒ 必须重写（幂等：同一
    //   (text, partition) 重写得到相同 DOM 结构，见 applyVisualBreaks 契约）。
    if (session && scope && isUnitSurfaceText && !compositionActiveRef.current && (scope.textContent !== unitAuthoritativeText || lastUnitWriteHostRef.current !== editingSegmentId)) {
      lastUnitWriteHostRef.current = editingSegmentId;
      // ★ S2-v3 · F1（契约 §1.1）：cell 面**不登记** regime-B。
      //   regime-B 语义 = 「DOM 承载整段」，而 cell 面的 DOM 只承载 cell 切片 ⇒ 对 cell 面
      //   登记 regime-B 在语义上恒错；不登记 ⇒ 万一面被异常撤回，降级路径取 segment base
      //   （= cell 起点）而非 0。纵深防御：主路径是锚稳定 + 失效即安全退出。
      if (!unitSurface?.cellAnchor) wholeParagraphSurfaceRef.current = editingSegmentId;
      scope.textContent = unitAuthoritativeText;
      // ★ 4B-4D-2A Step 4：按 Core visual partition **幂等重建** `<br>`。
      //   ⚠️ 顺序是硬约束：**必须在 caret 恢复之前**。
      //     textContent → 注入 <br> → 恢复 caret
      //   反过来会让 caret 的 DOM anchor 落在被 split/插入之前的旧结构上 ⇒ 失效。
      //   ⚠️ 三重校验后才注入：unitId 相同 **且** text 逐字节相等（长度不足）。
      const partForSurface = unitPartitionRef.current;
      if (
        partForSurface &&
        partForSurface.unitId === unitSurface?.unit.unitId &&
        partForSurface.text === unitAuthoritativeText
      ) {
        applyVisualBreaks(scope, partForSurface.partition);
      }
      // ★ F5：unit 面写入后按「事务语义派生的 offset」恢复 caret（此前此处无任何恢复，
      //   导致 selection 被 textContent 赋值重置 ⇒ 下一次 Backspace 落在 offset 0）。
      restoreUnitCaretIfPending(scope, unitAuthoritativeText);
    }

    if (
      session &&
      scope &&
      // ★ F2.8(a)：unit 模式跳过 —— A3-2 写的是**单 paragraph** 文本，会覆盖 unit 文本
      !isUnitSurfaceText &&
      wholeParagraphSurfaceRef.current !== editingSegmentId &&
      segmentCountForCoreLine > 1
    ) {
      const entrySeg = (segmentsRef.current ?? []).find((s) => s.id === editingSegmentId);
      const entryLineId = (entrySeg?.source as { lineId?: string } | undefined)?.lineId;
      const entryParagraphId = entryLineId ? coreParagraphIdForLineId(coreDoc, entryLineId) : null;
      const entryCoreText = entryParagraphId ? paragraphTextOf(coreDoc, entryParagraphId) : null;
      if (entryParagraphId && entryCoreText != null && scope.textContent !== entryCoreText) {
        // ① 点击位置必须在覆盖 textContent **之前**读取，且此时 DOM 是切片（regime A）
        const sliceLocal = computeSegmentDomOffset(editingSegmentId, scope);
        const entryBase = rangeBaseOf(
          entryParagraphId,
          editingSegmentId,
          segmentParagraphBaseUtf16(segmentsRef.current ?? [], editingSegmentId, coreDoc)
        );
        const paraOff =
          sliceLocal == null
            ? entryCoreText.length
            : Math.max(0, Math.min(entryCoreText.length, sliceLocal + entryBase));
        // ② 写整段；**先登记 regime B**（它是后续一切 base 判定的 authority）
        scope.textContent = entryCoreText;
        wholeParagraphSurfaceRef.current = editingSegmentId;
        // ③ caret 回到同一 paragraph 位置（DOM≡整段 ⇒ DOM offset 恒等于 paragraph offset）
        reconcileDomCaretAtOffset({
          scope,
          startOffsetUtf16: paraOff,
          endOffsetUtf16: paraOff,
          expectedText: entryCoreText,
          // 必须 markSynced：否则本次写入触发的 selectionchange 会被当成「用户移动 caret」
          // 回写 Core，把刚建立的 entry caret 拉回切片坐标。
          markSynced: (applied) => {
            lastCoreSelectionSyncRef.current = `${editingSegmentId}:${applied.start}`;
          },
        });
        noteCoreSessionChange("editing-surface-entry-sync");
        return;
      }
    }

    const decision = decideCoreEditingSurfaceSync({
      isEditing: scope.isContentEditable,
      isActiveSegment: true, // 本 effect 只在 editingSegmentId 上运行
      isCoreOwned: coreOwnedSegmentIdRef.current === editingSegmentId,
      // ★ F2.8(a)：unit 模式以 unit 文本为同步真值（其余判据逐字不变）
      coreText: syncCoreText,
      domText,
      generation: corePresentation?.documentVersion ?? -1,
      currentGeneration: coreDoc.version,
      caretOffset: (() => {
        // ★ F3B-6.27（实测修正，字符倒序的真正根因）：这里必须是 **Core 提交后的 caret**
        //   段内偏移，而**不是**写入前的 DOM caret 偏移。
        //
        //   机制（gd-swim-2026.pdf，逐步采样 coreLen / domLen / domCaret）：
        //     before   32 / 29 / 29
        //     type(A)  33 / 30 / 29     ← Core 与 DOM 文本都正确增长，但 domCaret 停在 29
        //     type(B)  34 / 31 / 30     ← 慢一拍
        //     type(C)  35 / 32 / 31
        //   本 effect 在其后才写 `scope.textContent`，随后用 `caretOffset` 恢复 DOM caret。
        //   原实现传 `computeSegmentDomOffset(...)` = **写入前**读到的旧 DOM caret，
        //   于是每次都把 caret 恢复到**插入点之前** ⇒ 下一个字符插到上一个字符之前
        //   ⇒ 逐字倒序（实测 ABCD → DCBA；22 个汉字全部逆序）。
        //   Core caret 是唯一真值：Core 插入后 caret 就在插入点**之后**。
        //   ⚠️ 纯函数 `decideCoreEditingSurfaceSync` 的 `caretOffset` 语义是
        //   「写入后 caret 应落在哪」（其单测 C6/C7 只锁定"传入即返回、越界夹紧"），
        //   故这里改传 Core caret 不违反该契约。
        // ★ 必须取**实时** Core caret（`session.history.state.caret`），不能用
        //   `corePresentation.sourceCaret` —— 后者是 React 派生值，本 effect 与那次提交
        //   处于同一 tick，实测它仍是**插入前**的 caret，于是算出的段内偏移也是插入点之前
        //   ⇒ caret 恢复到插入点之前 ⇒ 下一个字符插到上一个字符之前 ⇒ 逐字倒序。
        //   实测（Core 已提交 A，段落长 33）：`session.history.state.caret` 段落内 offset = 33
        //   （正确，在插入点之后），而 `corePresentation.sourceCaret` 仍是 32。
        //
        //   ⚠️ **不要**在这里按「当前 DOM 文本长度」clamp：此 IIFE 在
        //   `decideCoreEditingSurfaceSync({...})` 的参数位置求值，此时**还没**执行下面的
        //   `scope.textContent = text`，读到的仍是**写入前**的旧长度。
        //   实测：Core 段落 33 / base 3 ⇒ 正确段内偏移 30，但旧 DOM 长度 29 ⇒ clamp 成 29
        //   ⇒ caret 又被写到插入点之前（逐字倒序）。越界由 `reconcileDomCaretAtOffset` 兜底。
        const coreCaret = session?.history?.state?.caret ?? null;
        if (!coreCaret) return computeSegmentDomOffset(editingSegmentId, scope);
        const liveParagraphId = coreCaret.position?.paragraphId ?? paragraphId;
        const paraOff = coreCaretParagraphOffset(session, coreCaret);
        if (paraOff === null) return computeSegmentDomOffset(editingSegmentId, scope);
        const baseNow = rangeBaseOf(
          liveParagraphId,
          editingSegmentId,
          segmentParagraphBaseUtf16(segmentsRef.current ?? [], editingSegmentId, coreDoc)
        );
        // ★★ F3B-6.27 方案 A（多段面）：DOM 元素承载的是**完整 Core 段落文本**
        //   （`decideCoreEditingSurfaceSync` 写的就是 coreText），所以 DOM offset 与
        //   Core paragraph offset 是**恒等**的 —— 此时再减 segment base 会整体左移。
        //   实测症状：`日期：`(base 3) 那行插入后 DOM 变成 "2Q026 年…"（字符被挪到段首）。
        //
        //   ⚠️ 只有多段面才这样；单段行 DOM 文本 == segment 文本，base 必须照减。
        //   ★ STEP4：**本处的 count 保持原样**（`segmentCountForCoreLine`，已验证）。
        //   只统一「base 消解规则」（`resolveSegmentBaseForScope`），**不改** count 的推导 ——
        //   曾把本行改成由 lineId 反推 paragraphId，实测扰动了 A′ 的 caret 写入
        //   （A′ 不再写 caret，末态 36−3=33），已回退。判定 ≠ 规则，两者分开收口。
        const domCarriesWholeParagraph = segmentCountForCoreLine !== 1;
        return Math.max(0, domCarriesWholeParagraph ? paraOff : paraOff - baseNow);
      })(),
      // ★ F3B-6.27 实现 checkpoint：此处传 `1` **只为了求值其余守卫**
      //   （isEditing / isCoreOwned / coreText / generation / commandKind / isCrossRun）。
      //   「多段行是否可同步」这个条件**不再**由 segmentCount 决定，而由
      //   **能否取得该 segment 的 Core 切片**决定 —— segmentCount 守卫当年之所以必须
      //   fail-open，正是因为拿不到切片、只能把整段灌进单个 segment（实测重复「日期：」）。
      segmentCountForCoreLine: 1,
      isCrossRun,
      commandKind,
    });
    if (!decision.sync) return;

    // ★ F3B-6.27 实现 checkpoint：Core 事务后**维护 SegmentRangeLedger**（Q2=A）。
    //   在这里维护（而不是 beforeinput 站点）：本 effect 已确认会在每次 Core mutation 后执行，
    //   且 `decideCoreEditingSurfaceSync` 已判定「本次 mutation 可同步」⇒ 才允许维护；
    //   被 fail-open 拒绝的 mutation **绝不**进入 ledger（否则 undo 会退到错误状态）。
    try {
      const ledger = segmentRangeLedgerRef.current;
      const entries: any[] = (session?.history?.entries?.() ?? []) as any[];
      const tx: any = entries.length > 0 ? entries[entries.length - 1] : null;
      if (ledger && paragraphId && segmentRangeParagraphRef.current === paragraphId && tx?.command) {
        const cmd: any = tx.command;
        const beforeDoc: any = tx.before?.document;
        const para: any = beforeDoc
          ? (beforeDoc.pages ?? [])
              .flatMap((pg: any) => pg.objects ?? [])
              .flatMap((o: any) => (o.type === "text" ? (o.paragraphs ?? []) : []))
              .find((p: any) => p.id === cmd.range?.anchor?.paragraphId)
          : null;
        const para2: any = para ?? (beforeDoc
          ? (beforeDoc.pages ?? [])
              .flatMap((pg: any) => pg.objects ?? [])
              .flatMap((o: any) => (o.type === "text" ? (o.paragraphs ?? []) : []))
              .find((p: any) => p.id === cmd.position?.paragraphId)
          : null);
        if (para2) {
          const offIn = (runId: string, off: number): number => {
            let acc = 0;
            for (const r of para2.runs ?? []) {
              if (r.id === runId) return acc + off;
              acc += (r.text ?? "").length;
            }
            return Number.NaN;
          };
          const fromRange = cmd.range ? offIn(cmd.range.anchor.runId, cmd.range.anchor.offset) : Number.NaN;
          const toRange = cmd.range ? offIn(cmd.range.focus.runId, cmd.range.focus.offset) : Number.NaN;
          const atPos = cmd.position ? offIn(cmd.position.runId, cmd.position.offset) : Number.NaN;
          const a = cmd.range ? fromRange : atPos;
          const f = cmd.range ? toRange : atPos;
          const beforeText = paragraphTextOf(beforeDoc, paragraphId);
          const afterText = coreText;
          if (Number.isFinite(a) && Number.isFinite(f) && beforeText && afterText) {
            const lo = Math.min(a, f);
            const hi = Math.max(a, f);
            const newTextLength = afterText.length - (beforeText.length - (hi - lo));
            if (newTextLength >= 0) {
              const res = commitTransaction(ledger, {
                paragraphId,
                startUtf16: lo,
                endUtf16: hi,
                newTextLength,
                commandKind,
                crossRun: isCrossRun,
                ownerSegmentId: editingSegmentId,
              });
              if (res.ok) {
                segmentRangeLedgerRef.current = res.ledger;
                segmentRangeLastMutationRef.current = "accepted";
                // ★ Step 3：accepted 后**有条件**推进 fence。
                //   条件 = 「本次 ledger 应用的恰好是最后一个 Core command」
                //   （`tx.after.document.version === coreDoc.version`）。
                //   若两者不等 ⇒ 本 effect 之前已漏了中间若干 Core command，
                //   ownership 只跟上了最后一个 ⇒ fence 必须**留在后面**，
                //   由一致性判定如实报 stale。绝不在此无条件推进（会伪造同步）。
                const afterVer = (tx as { after?: { document?: { version?: number } } })?.after?.document?.version;
                if (typeof afterVer === "number" && afterVer === coreDoc.version) {
                  segmentRangeFenceRef.current = coreDoc.version;
                }
              } else {
                // ★ Step 3：Core 已前进但 ownership 没推进（cross-segment-range /
                //   ambiguous-boundary-start / non-text-command 等）。此前**无任何信号**，
                //   ownership 静默陈旧。此处显式登记，让一致性判定能把它判成 stale。
                //   ⚠️ 只登记、不改同步行为：真正的 fail-closed 拦截属于
                //   Multi-Segment Editing Surface 接线（Contract C 的 C6/C8）。
                segmentRangeLastMutationRef.current = "rejected";
              }
            }
          }
        }
      }
    } catch {
      /* ledger 维护失败 ⇒ 不影响既有同步路径 */
    }

    const ownershipNow = segmentRangeOwnershipOf(paragraphId);
    // ★★ F3B-6.27 方案 A：多段面写**完整 Core 段落文本**，不按 segment 切片。
    //
    //   实测证据链（Gate-1 诊断，日期：行）：
    //     coreTextLen = 36（整段） → decisionTextLen = 36（契约也是整段）
    //     → 但 DOM 落在 33 = 36 − len("日期：")
    //   33 正是下面 `sliceTextFor` 的产物：Step 2 的原设计是「把整段切片后写进单个
    //   segment」，也因此才需要整套 `segmentParagraphBaseUtf16` / `rangeBaseOf` 的
    //   base 运算（因为写进去的是切片）。
    //
    //   方案 A 下 DOM offset ≡ Core paragraph offset ⇒ 切片与 base 都多余，
    //   且切片正是「编辑面少 3 个字、第 2 行空白」的来源。
    //
    //   ⚠️ 兄弟 segment 的 DOM 文本本来就透明（`isDomTextSuppressed` 只对 ownedSegmentId
    //      生效，canvas 画原字）⇒ 整段灌入**不会**产生重复文本。
    //   ⚠️ 单段行（`segmentCountForCoreLine === 1`）分支逐字节不变。
    const multiSegmentSurface = segmentCountForCoreLine > 1;
    // ★★ P0-F1 + F2.9 · surface mode 分派（D2 / G3 / G4 的守卫升级）：
    //   每个写入点**只写对应 surface 的 authoritative text**：
    //     · explicit unit surface → `unitAuthoritativeText`（= `explicitUnitSurface.text`，
    //       P0-C/P0-E2-B 冻结的 unit 文本；**唯一来源**已在上方定义）
    //     · single-paragraph surface → 既有 coreText / 切片逻辑（**逐字节不变**）
    //   ★ unit 模式下 **soft-wrap 不产生任何 `\n`**（P0-E2-B 冻结规则）：
    //     文本里的 `\n` 只来自显式 structural separator。
    //   ★ **禁止**把 `segment.text` 作为 unit 面的 DOM truth（"双 日期："污染源）。
    //   ★ F2.9：此处**不再**读 `explicitUnitSurface`，只读 `unitAuthoritativeText`
    //     ⇒ 判定输入与写入点共用同一来源，结构上不可能不一致。
    const text = unitAuthoritativeText !== null
      ? unitAuthoritativeText
      : multiSegmentSurface
        ? coreText // ≡ decision.text（契约 sync 分支恒为 text: input.coreText）
        : ownershipNow
          ? sliceTextFor(ownershipNow, coreText ?? "", editingSegmentId)
          : decision.text;
    if (text === null || text === undefined) return;
    // 写入说明：本 effect 在 Core 提交**之后**才跑，Core 与 DOM 文本在此之前必然已分叉
    //   （`already-in-sync` 幂等守卫因此通常成立与否取决于时序）。caret 用上面算出的
    //   **Core caret** 段内偏移恢复（不是写入前的旧 DOM caret）—— 否则逐字倒序。
    // ★ F3B-6.27-③ 登记：本次写入的是**整段**还是切片。
    //   写入点即事实来源；`domSurfaceCarriesWholeParagraph` 与播种判据都读它。
    // ★★ P0-F1：unit 面同样登记「承载整段/整 unit」（`domSurfaceCarriesWholeParagraph`
    //   与播种判据都读它）—— unit 面装的是**完整 unit 文本**，与切片语义相反。
    // ★ S2-v3 · F1（契约 §1.1）：**cell 面除外**——其 DOM 只承载 cell 切片，
    //   登记 regime-B 会让降级路径按 base=0 插入 ⇒ 串格（D1 根因链第 4 环）。
    wholeParagraphSurfaceRef.current =
      (isUnitSurfaceText && !unitSurface?.cellAnchor) || multiSegmentSurface ? editingSegmentId : null;
    scope.textContent = text;
    // ★★ P0-F1 的限制**依然成立且必须保留**：`decision.caretOffset` 是**单 paragraph**
    //   语义的产物，套到 unit 面上是错的 ⇒ unit 模式**绝不使用**它。
    // ★ F5 已实现：unit 面的 caret 一律走「beforeinput intent 派生」的那一个 offset
    //   （`restoreUnitCaretIfPending`）。没有 pending（浏览器原生写入、IME 让位、
    //   非 unit 事务等）⇒ 不做任何 caret 操作，绝不猜位置。
    if (isUnitSurfaceText) {
      restoreUnitCaretIfPending(scope, text);
      return;
    }
    if (decision.caretOffset === null) return;
    reconcileDomCaretAtOffset({
      scope,
      startOffsetUtf16: decision.caretOffset,
      endOffsetUtf16: decision.caretOffset,
      expectedText: text,
      // ★ 必须 markSynced —— 否则 A′ 写入 + 恢复 caret 触发的 `selectionchange`
      //   会被 `onSelectionChange` 当成「用户移动了 caret」**回写 Core** ⇒ Core caret 被拉回
      //   ⇒ 每次插入后 caret 慢一拍 ⇒ 逐字倒序（实测 ABCD → DCBA）。
      //   幂等键口径与 G3-A/G3-B/G3-C、`onSelectionChange` 的 dedupe 完全一致。
      markSynced: (applied) => {
        lastCoreSelectionSyncRef.current = `${editingSegmentId}:${applied.start}`;
      },
    });
  }, [
    coreInputTick,
    editingSegmentId,
    corePresentation,
    coreSessionRevision,
    coreOwnedSegmentIdRef,
    segmentRangeOwnershipOf,
    ensureSegmentRangeLedger,
    // ★ F2.8(a)：unit 面出现/变更时必须重跑本 effect（否则 unit 文本永远写不进 DOM）
    explicitUnitSurface,
  ]);

  // ── D-3B-6 子任务 2B（消费端）：宿主稳定 + A′ 文本已写入 ⇒ 按点击坐标播种 caret ──
  //   ⚠️ 必须声明在 A′ effect（上方）**之后**：消费依赖「A′ 已把 unit 文本写入宿主 DOM」
  //   ⇒ 同一 flush 内晚于 A′ 运行（对重建后的面做逐字符测位）。
  useEffect(() => {
    const seed = unitCaretSeedRef.current;
    if (!seed || !editingSegmentId || !explicitUnitSurface) return;
    if (hostStableSegRef.current !== editingSegmentId) return; // 宿主迁移中 ⇒ 下一轮再落
    const scope =
      Array.from(document.querySelectorAll<HTMLElement>("[data-segment-id]")).find(
        (n) => n.getAttribute("data-segment-id") === editingSegmentId
      ) ?? null;
    if (!scope) return;
    if ((scope.textContent ?? "") !== explicitUnitSurface.text) return; // A′ 未写完 ⇒ 下一轮
    unitCaretSeedRef.current = null; // 一次性：无论命中与否都不再复用
    // ★ 逐字符 Range 测位（宿主 DOM 自身）——**不用** `caretRangeFromPoint`：透明的
    //   非宿主兄弟 segment（同行 l5 有「日期：」+「2026 年…」两段）与宿主面完全重叠且
    //   DOM 靠后，会赢得 hit-test ⇒ startContainer 落在宿主之外（实测 out-of-scope）。
    const textNodes: { node: Text; acc: number }[] = [];
    let total = 0;
    const w2 = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = w2.nextNode(); n; n = w2.nextNode()) {
      textNodes.push({ node: n as Text, acc: total });
      total += n.nodeValue?.length ?? 0;
    }
    const charRects: { off: number; left: number; right: number; top: number; bottom: number }[] = [];
    const rng = document.createRange();
    for (const tn of textNodes) {
      const s = tn.node.nodeValue ?? "";
      for (let j = 0; j < s.length; j += 1) {
        if (s[j] === "\n") continue; // 换行符无墨迹
        try {
          rng.setStart(tn.node, j);
          rng.setEnd(tn.node, j + 1);
          const rc = rng.getBoundingClientRect();
          if (rc.height > 0) charRects.push({ off: tn.acc + j, left: rc.left, right: rc.right, top: rc.top, bottom: rc.bottom });
        } catch {
          /* 代理对半边界等 ⇒ 跳过该字符 */
        }
      }
    }
    // 点击 y 带内的行 → 行内按 x 定位（左缘前=首字符、右缘后=末字符+1）
    const lineChars = charRects.filter((c) => seed.y >= c.top - 2 && seed.y <= c.bottom + 2).sort((a, b) => a.left - b.left);
    let off: number | null = null;
    if (lineChars.length > 0) {
      const first = lineChars[0]!;
      const last = lineChars[lineChars.length - 1]!;
      if (seed.x <= first.left) off = first.off;
      else if (seed.x >= last.right) off = last.off + 1;
      else {
        for (const c of lineChars) {
          if (seed.x >= c.left && seed.x < c.right) { off = c.off; break; }
        }
        if (off == null) off = last.off + 1;
      }
    }
    if (off == null) {
      // ★ R2（登记档案 §5.3.2.2 L7）：**无墨迹回退**（空态 unit 文本仅 separator ⇒ 逐字符测位无墨迹）。
      //   pointerdown 命中段（面出现前的原始事实，L1）⇒ source.lineId ⇒ resolveParagraphIdForLine
      //   （provenance/ledger 同一入口）⇒ 若该段落是**当前 unit 成员** ⇒ 播 caret 到该成员
      //   startUtf16；任一环不成立 ⇒ 不播（fail-closed，caret 保持既有行为）。
      //   与逐字符路径互斥：本分支只在 off == null（点击带无墨迹）时进入，非空态不触及。
      const hitSeg = (segmentsRef.current ?? []).find((s) => s.id === seed.hitSegId);
      const hitLineId = (hitSeg?.source as { lineId?: string } | undefined)?.lineId;
      const seedSession = coreInputSessionRef.current;
      const seedDoc = seedSession ? documentOf(seedSession) : coreDocumentRef.current;
      const resolvedSeed = hitLineId && seedDoc
        ? resolveParagraphIdForLine(seedDoc, hitLineId, unitIdentityLedgerRef.current, sidecarGenerationRef.current)
        : null;
      const member = resolvedSeed?.ok
        ? explicitUnitSurface.unit.lines.find((l) => l.paragraphId === resolvedSeed.paragraphId)
        : null;
      if (member) {
        reconcileDomCaretAtOffset({
          scope,
          startOffsetUtf16: member.startUtf16,
          endOffsetUtf16: member.startUtf16,
          expectedText: explicitUnitSurface.text,
          markSynced: (applied) => {
            lastCoreSelectionSyncRef.current = `${editingSegmentId}:${applied.start}`;
          },
        });
      }
      return;
    }
    reconcileDomCaretAtOffset({
      scope,
      startOffsetUtf16: off,
      endOffsetUtf16: off,
      expectedText: explicitUnitSurface.text,
      markSynced: (applied) => {
        lastCoreSelectionSyncRef.current = `${editingSegmentId}:${applied.start}`;
      },
    });
  }, [editingSegmentId, explicitUnitSurface]);

  // F3B-6.18-D.1：只读诊断暴露「当前生效的文本 render source」+ 两个 ownership 信号。
  //
  //   目的：D.2 生产路径验收需要断言「normal boot → selected text render source = Core」，
  //   不能只靠截图推断。此处同时暴露 **rendering ownership**（source / coreRenderEnabled）
  //   与 **semantic ownership**（segmentCoreActive / coreInputActive），**刻意并置**以证明
  //   两者已分离（D.1 boundary ②）。
  //
  //   ⚠️ 纯只读：不参与任何渲染逻辑，绝不被生产代码消费。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__textRenderSource = {
      // rendering ownership（D.1：缺省 ON）
      source: renderSource.source,
      reason: renderSource.reason,
      coreRenderEnabled,
      // semantic ownership（与上面**互不影响**）
      segmentCoreActive,
      coreInputActive,
    };
  }, [renderSource, coreRenderEnabled, segmentCoreActive, coreInputActive]);

  // ★ F3B-6.27-G3：只读诊断暴露「当前生效的 glyph 命令 + 样式表」。
  //
  //   目的：G3 的验收不能只断言「字体名正确」—— 字体名相同但 metrics 仍可能不一致。
  //   必须能在浏览器里同时拿到「画布侧的逐 glyph advance/width」与「样式里的
  //   pdfjsFontFamily」，才能证明**视觉坐标系与点击坐标系已对齐**（见
  //   cases/F3B-6.27-*.md 的 B/C 段）。
  //
  //   ⚠️ 纯只读：与 `__textRenderSource` 同构，不参与任何渲染逻辑，绝不被生产代码消费。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const src = coreRenderEnabled ? coreRenderSource : null;
    (window as any).__coreGlyphCommands = src?.ok ? src.commands : null;
    // ★ F3B-6.27-G9-YREG：只读暴露 **Core 段落行盒**（Core 坐标系，未做任何 DOM 换算）。
    //   用途：把「段落边界」断言在 **Core 空间**（`surfaceBottomCore <= nextParagraphTopCore`），
    //   而不是 DOM 两个 rect 的像素间隙 —— 后者混入了 Core↔DOM 的 Y 配准偏移
    //   （实测约 2.5px，属独立问题 G9-YREG，不阻塞段落 ownership 判定）。
    //   ⚠️ 纯只读：与 `__coreGlyphCommands` 同构，不参与任何渲染/编辑逻辑。
    const lay: any = (coreRenderSource as any)?.ok ? (coreRenderSource as any).layouts : null;
    (window as any).__coreParagraphLayouts = Array.isArray(lay)
      ? lay.flatMap((l: any) =>
          (l?.paragraphs ?? []).map((pp: any) => ({
            paragraphId: pp?.paragraphId ?? null,
            top: pp?.box?.y ?? null,
            bottom: (pp?.box?.y ?? 0) + (pp?.box?.height ?? 0),
            lines: (pp?.lines ?? []).map((ln: any) => ({
              top: ln?.box?.y ?? null,
              height: ln?.box?.height ?? null,
            })),
          }))
        )
      : null;
    (window as any).__coreRenderStyles = src?.ok ? src.styles : null;
  }, [coreRenderEnabled, coreRenderSource]);

  // F3B-6.19-E：只读诊断暴露「当前 selection/caret presentation 的来源」。
  //
  //   目的：E1 需要断言「**默认启动、不设任何 flag** ⇒ Core selection/caret presentation 可用」，
  //   不能只靠截图推断。此处与 `__textRenderSource` 同构（纯只读、绝不被生产代码消费），
  //   并把 **开关**（coreInputEnabled / coreRenderEnabled）与 **决策**
  //   （source / presentationActive / presentationValid / ownsEditingSegment）分层暴露，
  //   同时并置 semantic ownership 信号以继续证明「semantic ≠ rendering ≠ presentation」。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__textSelectionSource = {
      // 开关（F3B-6.19-E：缺省 ON；只有显式 false 才 rollback）
      coreInputEnabled,
      coreRenderEnabled,
      // F3B-6.21-A-Impl：**四段式验收**所需的 revision / generation / owner 观测面
      revision: coreSessionRevision,
      generation: coreSessionGeneration,
      presentationRevision: corePresentation?.revision ?? null,
      // 当前 presentation 决策（C3 契约：当前所有权 + 几何未过期）
      source: corePresentationActive ? "core" : "legacy",
      presentationActive: corePresentationActive,
      presentationValid: isCorePresentationCurrent(corePresentation, coreInputSessionRef.current),
      ownsEditingSegment:
        editingSegmentId !== null && coreOwnedSegmentIdRef.current === editingSegmentId,
      editingSegmentId,
      // semantic ownership（与上面刻意并置，互不影响）
      segmentCoreActive,
      coreInputActive,
    };
  }, [
    coreInputEnabled,
    coreRenderEnabled,
    corePresentationActive,
    corePresentation,
    editingSegmentId,
    segmentCoreActive,
    coreInputActive,
  ]);

  // ────────────────────────────────────────────────────────────────────
  // EDITOR-CORE-012-E2（方案 B）：Core 接管编辑时，caret / selection 的
  // **presentation source** 切换为 Core 几何（CORE-006-B 原样产出，不重算）。
  //
  //   CaretGeometry      → CaretLayerPosition     → CaretLayer（既有通道）
  //   SelectionGeometry  → GlyphQuad[]            → SelectionHighlightLayer（既有通道）
  //
  // 两个既有 prop 通道（`caretPosition` / `selectionHighlight`）由 PDFEditor 计算，
  // 因此**不需要改 PDFCanvas**。Core 未接管时保持 legacy 计算（行为不变）。
  //
  // ⚠️ F3B-6.19-C（C3）修正：门控从「`coreInputTick > 0`（sticky 会话史）」改为
  //    「**当前** Core 拥有编辑面 + presentation 几何对应当前 document/selection/caret」
  //    （`corePresentationActive`）。B3 实测：Toolbar / Capability / Segment 的 Core mutation
  //    之后旧门控仍为真，导致 presentation 用 `null`／陈旧几何 ⇒ legacy 选区高亮被吞。
  //
  // ⚠️ 已知限制：Core layout 无旋转概念 → 旋转文本的 caret/selection 退化为轴对齐
  //   （legacy 的 resolveCaretPosition 会用 glyph.transform 处理旋转）。
  // ────────────────────────────────────────────────────────────────────
  const coreCaretPosition = useMemo(
    () => (corePresentationActive ? coreCaretLayerPosition(corePresentation?.caret ?? null) : null),
    [corePresentationActive, corePresentation]
  );
  const coreSelectionHighlight = useMemo(
    () => (corePresentationActive ? coreSelectionQuads(corePresentation?.selection ?? null) : []),
    [corePresentationActive, corePresentation]
  );

  // M7.7-004C: 同步最新 glyphCommands 到 ref（openTextEditSession 经 ref 读取，见声明处注释）。
  // 012-A 刻意**不改**这里：它属编辑路径（012-C），保持行为与 flag 无关。
  glyphCommandsRef.current = glyphCommands;

  // ══════════════════════════════════════════════════════════════════════
  // F3B-6.18-B · Core Text Renderer Shadow（gated 只读观察，缺省关闭）
  //
  //   目的：回答「如果 Core 成为唯一**文本** renderer，是否发生视觉/几何回归」。
  //   纯结构比较：legacy 文本命令（glyphCommands）vs Core 文本命令（buildCoreRenderSource），
  //   外加 Segment × Core 的**结构性文本重叠**观察（重复文本候选）。
  //   ⚠️ 只读：不选 renderSource、不改 __rendererMode、不碰 mask / image / docBlocks / Segment。
  //   gate：window.__coreTextRenderShadow === true（缺省 off ⇒ 零开销）。
  // ══════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (typeof window === "undefined") return;
    if ((window as unknown as Record<string, unknown>).__coreTextRenderShadow !== true) return;
    try {
      const legacyDoc = editableDocumentRef.current;
      if (!legacyDoc) return;
      const coreOutcome = buildCoreRenderSource(legacyDoc);
      const report = buildTextRenderShadow({
        legacyCommands: glyphCommands ?? [],
        coreCommands: coreOutcome.ok ? coreOutcome.commands : [],
        segments: segments.map((s) => ({
          blockId: s.source?.blockId ?? null,
          lineId: s.source?.lineId ?? null,
          text: s.text,
        })),
      });
      (window as unknown as Record<string, unknown>).__coreTextRenderShadowReport = report;
      console.log("[F3B-6.18-B][TEXT_RENDER_SHADOW]", {
        coreOk: coreOutcome.ok,
        coreReason: coreOutcome.ok ? null : coreOutcome.reason,
        verdict: report.verdict,
        legacyGlyphCount: report.legacyGlyphCount,
        coreGlyphCount: report.coreGlyphCount,
        divergentLines: report.divergentLines,
        maxPosDelta: Math.round(report.maxPosDelta * 1000) / 1000,
        riskFlags: report.riskFlags,
        duplicateTextLines: report.duplicateText.length,
      });
    } catch (error) {
      console.warn("[F3B-6.18-B][TEXT_RENDER_SHADOW] 构造异常（只读观察，不影响渲染）", error);
    }
  }, [glyphCommands, segments, editableDocVersion]);

  // TEMP-DEBUG: 暴露 measureCanvasLineTextExtent 供诊断（验证后移除）
  if (typeof window !== "undefined") {
    (window as any).__measureExtent = (blockId: string, lineId: string) => {
      const canvas = canvasRef.current;
      const glyphEl = document.querySelector('[data-layer="glyph"]') as HTMLElement | null;
      if (!canvas || !glyphEl) return null;
      const lineGlyphs = (glyphCommandsRef.current ?? [])
        .filter(isDrawGlyph)
        .filter((c) => c.blockId === blockId && c.lineId === lineId);
      if (!lineGlyphs.length) return null;
      const acc = lineGlyphs.reduce<{ minX: number; minY: number; maxX: number; maxY: number }>(
        (a, g) => ({ minX: Math.min(a.minX, g.x), minY: Math.min(a.minY, g.y), maxX: Math.max(a.maxX, g.x + g.width), maxY: Math.max(a.maxY, g.y + g.height) }),
        { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY }
      );
      const box = { x: acc.minX, y: acc.minY, width: acc.maxX - acc.minX, height: acc.maxY - acc.minY };
      const real = measureCanvasLineTextExtent(canvas, glyphEl, box);
      // 详细调试：canvas 引用信息
      const cr = canvas.getBoundingClientRect();
      const gr = glyphEl.getBoundingClientRect();
      const q = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
      const qr = q?.getBoundingClientRect();
      return {
        box, real,
        canvasRefRect: { x: +cr.left.toFixed(1), y: +cr.top.toFixed(1), w: +cr.width.toFixed(1), h: +cr.height.toFixed(1), pxW: canvas.width, pxH: canvas.height },
        glyphRect: { x: +gr.left.toFixed(1), y: +gr.top.toFixed(1), w: +gr.width.toFixed(1), h: +gr.height.toFixed(1) },
        queriedCanvasRect: qr ? { x: +qr.left.toFixed(1), y: +qr.top.toFixed(1), w: +qr.width.toFixed(1), h: +qr.height.toFixed(1), pxW: q?.width, pxH: q?.height } : null,
      };
    };
  }

  // ── Sprint 33: Document Layout Model ──
  // 从 EditableDocument 构建 LayoutNode 树，用于布局感知编辑。
  const layoutDocument = useMemo(() => {
    const doc = editableDocumentRef.current;
    if (!doc) return null;
    try {
      const sigRotations = signatureRotationRef.current;
      return buildLayoutDocument({
        editableDoc: doc,
        signatureRotations: sigRotations.size > 0 ? sigRotations : undefined,
      });
    } catch (e) {
      console.warn("[Sprint33] Layout build failed:", e);
      return null;
    }
  }, [editableDocVersion]);

  // ── Sprint 33.3.4: Block Rotation Map ──
  // Extract rotation (deg) from signature blocks in layout tree, keyed by sourceBlockId.
  const blockRotations = useMemo(() => {
    const map = new Map<string, number>();
    if (!layoutDocument) return map;
    for (const page of layoutDocument.pages) {
      for (const topNode of page.children) {
        if (topNode.type === "signature" && Math.abs(topNode.transform.rotation) > 0.01) {
          for (const child of topNode.children) {
            if (child.sourceBlockId) {
              map.set(child.sourceBlockId, topNode.transform.rotation);
            }
          }
        }
      }
    }
    return map;
  }, [layoutDocument]);

  // ── Sprint 33.3.5 Task 4: Signature Region Map ──
  // Maps blockId → {regionId, rotation} so the renderer can group
  // blocks from the same signature region under ONE rotation wrapper.
  // Sprint 33.5.6: Stable snapshot of signature regions (derived from ref)
  const signatureRegionsStable = useMemo(() => {
    return signatureRegionsRef.current;
  }, [editableDocVersion]);

  const signatureRegionMap = useMemo(() => {
    const map = new Map<string, { regionId: string; rotation: number }>();
    if (!layoutDocument) return map;
    const doc = editableDocumentRef.current;
    for (const page of layoutDocument.pages) {
      for (const topNode of page.children) {
        if (topNode.type !== "signature") continue;
        const regionId = topNode.id;
        // Sprint-50 Task-011：Restore per-block rotation。
        // 原：所有 child 共享 region 级 topNode.transform.rotation（Loss of Granularity）。
        // 改：每个 block 通过 resolveBlockRotation() 取自身权威旋转。
        for (const child of topNode.children) {
          if (!child.sourceBlockId) continue;
          const block = doc?.pages
            .flatMap((p) => p.blocks)
            .find((b) => b.id === child.sourceBlockId);
          const rotation = block ? resolveBlockRotation(block) : 0;
          map.set(child.sourceBlockId, { regionId, rotation });
        }
      }
    }
    // also expose for debug
    if (typeof window !== "undefined") {
      (window as any).__signatureRegionMap = map;
    }
    return map;
  }, [layoutDocument]);

  // ── Sprint34.15: Signature Transform Context ──
  // 统一 Editor 与 Export 的签名旋转 pivot = 每个 EditableBlock originalBounds center。
  // keyed by blockId → { regionId, rotation, pivot }。Editor (glyph-renderer) 与 Export 共用。
  const signatureTransformContexts = useMemo(() => {
    const map = new Map<string, SignatureTransformContext>();
    if (!layoutDocument) return map;
    const doc = editableDocumentRef.current;
    for (const page of layoutDocument.pages) {
      for (const topNode of page.children) {
        if (topNode.type !== "signature") continue;
        const regionId = topNode.id;
        // Sprint-50 Task-011：Restore per-block rotation。
        // 原：用 region 级 topNode.transform.rotation 统一应用到该区域所有行（Loss of Granularity）。
        // 改：每个 block 通过 resolveBlockRotation() 取自身权威旋转（混合倾斜印章各得其所）。
        for (const child of topNode.children) {
          if (!child.sourceBlockId) continue;
          const block = doc?.pages
            .flatMap((p) => p.blocks)
            .find((b) => b.id === child.sourceBlockId);
          if (!block?.originalBounds) continue;
          const blockText = block.lines
            .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
            .join(" ");
          const rot = resolveBlockRotation(block); // per-block 权威旋转
          map.set(
            child.sourceBlockId,
            buildSignatureTransformContext(
              child.sourceBlockId,
              regionId,
              rot,
              block.originalBounds,
              block,
              blockText,
            ),
          );
        }
      }
    }
    // Sprint34.15 Debug
    if (typeof console !== "undefined") {
      console.log(
        `%c[Sprint34.15][UnifiedSignatureTransform] contexts=${map.size}`,
        "color:#22d3ee;",
      );
      for (const [bid, ctx] of map) {
        const t = ctx.blocks[0]?.text?.substring?.(0, 30) ?? ctx.blocks[0]?.text ?? "";
        console.log(
          `  id=${bid} rotation=${ctx.rotation} pivot=(x=${ctx.pivot.x.toFixed(1)},y=${ctx.pivot.y.toFixed(1)}) text="${t}"`,
        );
      }
    }
    if (typeof window !== "undefined") {
      (window as any).__signatureTransformContexts = map;
    }
    return map;
  }, [layoutDocument, editableDocVersion]);

  // ── Sprint34.17–34.27 audit cluster ──
  // F3B-6.3B：实现已抽离至 ./debug/sprint34-audit-debug（useSprint34AuditDebugRegistry）。
  // 11 个 useEffect 1:1 保留（依赖数组各自独立，未合并 / 未重排）。
  useSprint34AuditDebugRegistry({
    editableDocumentRef,
    docTextItemsRef,
    suppressedGlyphIdsRef,
    signatureRotationRef,
    signatureTransformContexts,
    editableDocVersion,
    layoutDocument,
    glyphCommands,
    pdfDoc,
    page,
  });

  // ── Sprint 33: window.__layoutDebug() 暴露 ──
  // F3B-6.3A：实现已抽离至 ./debug/layout-debug（useLayoutDebugRegistry）。
  // 依赖以显式 contract 注入；本 hook 每次 render 无条件调用，hooks 顺序不变。
  useLayoutDebugRegistry({
    layoutDocument,
    editableDocumentRef,
    cssScaleRef,
    signatureRegionsRef,
    canvasRef,
    segmentsRef,
    docTextItemsRef,
    editedLineBoxesRef,
    signatureRegionMap,
    segments,
    editingSegmentId,
    textEdit,
  });

  // ── Sprint 33 诊断：window.__diagnoseClick() — 全链路点击诊断 ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__diagnoseClick = () => {
      const issues: string[] = [];
      const passes: string[] = [];

      // Gate 1: ocrTaskId
      if (ocrTaskId) {
        passes.push(`✓ ocrTaskId = "${ocrTaskId}"`);
      } else {
        issues.push(`✗ ocrTaskId = null → OCR 任务未关联（可能未走 OCR 流程）`);
      }

      // Gate 2: editableDocumentRef
      const doc = editableDocumentRef.current;
      if (doc) {
        passes.push(`✓ editableDocumentRef.current exists (pages: ${doc.pages.length}, styles: ${doc.styles.length})`);
      } else {
        issues.push(`✗ editableDocumentRef.current = null → EditableDocument 未构建`);
      }

      // Gate 3: editableDocVersion
      if (editableDocVersion !== -1) {
        passes.push(`✓ editableDocVersion = ${editableDocVersion}`);
      } else {
        issues.push(`✗ editableDocVersion = ${editableDocVersion} → glyphCommands useMemo 未触发`);
      }

      // Gate 4: enableClickToEdit
      const clickEnabled = !!(ocrTaskId) || !!doc;
      if (clickEnabled) {
        passes.push(`✓ enableClickToEdit = true`);
      } else {
        issues.push(`✗ enableClickToEdit = false → GlyphRenderer interactive=false`);
      }

      // Gate 5: glyphCommands
      const cmds = glyphCommands || [];
      const nonImage = cmds.filter((c) => c.type !== "drawImage");
      if (nonImage.length > 0) {
        passes.push(`✓ glyphCommands: ${cmds.length} total, ${nonImage.length} non-image`);
      } else {
        issues.push(`✗ glyphCommands: ${cmds.length} total, 0 non-image → GlyphRenderer 不渲染`);
      }

      // Gate 6: docStyles
      if (doc && doc.styles.length > 0) {
        passes.push(`✓ docStyles: ${doc.styles.length} styles`);
      } else if (doc) {
        issues.push(`✗ docStyles: 0 styles (EditableDocument 存在但无样式)`);
      } else {
        issues.push(`✗ docStyles: N/A (EditableDocument 不存在)`);
      }

      // Check DOM for GlyphRenderer
      const wrapper = wrapperRef.current;
      if (wrapper) {
        const glyphDiv = wrapper.querySelector('[data-layer="glyph-renderer"]');
        if (glyphDiv) {
          passes.push(`✓ DOM: GlyphRenderer div found`);
          const spans = glyphDiv.querySelectorAll("span");
          passes.push(`✓ DOM: ${spans.length} glyph spans in renderer`);
        } else {
          issues.push(`✗ DOM: No GlyphRenderer div in DOM (可能未渲染)`);
        }
      }

      console.log(
        "%c── Click Chain Diagnosis ──",
        "font-weight:bold;font-size:14px;color:#8b5cf6;",
      );
      for (const p of passes) {
        console.log(`  %c${p}`, "color:#22c55e;");
      }
      for (const i of issues) {
        console.log(`  %c${i}`, "color:#ef4444;font-weight:bold;");
      }
      if (issues.length === 0) {
        console.log(
          "%c  All gates pass! Click should work. If not, check z-index / pointer-events overlays.",
          "color:#f59e0b;font-weight:bold;",
        );
      }
      return { passes, issues };
    };
    return () => {
      delete (window as any).__diagnoseClick;
    };
  }, [ocrTaskId, editableDocVersion, glyphCommands, layoutDocument]);
  // deps: 这些依赖变化时需要刷新 diagnosis 闭包

  // pushUndo + setBlocks migrated to useSelection (Commit 1 / Step 5)

  // 选中 block 时同步工具栏（跨 tool/selection domain，暂留此处）
  useEffect(() => {
    if (!selectedBlockId) return;
    const b = docBlocks.find((x) => x.id === selectedBlockId);
    if (b && b.type === "text") {
      setTextFormat((prev) => ({
        fontFamily: b.fontFamily || prev.fontFamily,
        fontSize: b.fontSize || prev.fontSize,
        color: b.color || prev.color,
      }));
    }
  }, [selectedBlockId]);

  // handleUndo + handleRedo + Ctrl+Z listener migrated to useSelection (Commit 1 / Step 5)

  // V12: Ctrl+F 切换 Find & Replace 面板
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        setShowFindReplace((v) => !v);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [setShowFindReplace]);

  // ── F3B-6.23-C-Impl-1：Undo/Redo 可用性快照广播（Toolbar 的 canUndo/canRedo 来源）──
  //   快照语义与 decideUndoRedoRoute 一致：owner = core 时只看 Core 栈
  //   （无 session ⇒ false），**绝不**显示 Legacy 栈的可用性
  //   （B0 不变式「owner = core ⇒ Legacy undo/redo = 0」的读取面）。
  const refreshUndoRedoAvailability = useCallback(() => {
    const owner = lastUndoRedoOwnerRef.current ?? lastMutationOwnerRef.current ?? "legacy";
    const coreHistory = coreInputSessionRef.current?.history;
    const legacy = operationHistoryRef.current;
    notifyUndoRedoAvailability({
      canUndo: owner === "core" ? (coreHistory?.canUndo ?? false) : (legacy?.canUndo ?? false),
      canRedo: owner === "core" ? (coreHistory?.canRedo ?? false) : (legacy?.canRedo ?? false),
      owner,
    });
  }, []);

  // ── M6-001C → F3B-6.23-C-Impl-1：canonical Undo/Redo **唯一执行器** ──
  //   键盘 Ctrl+Z/Y 与 Toolbar Undo/Redo（经 requestUndo/requestRedo 总线）都落到这里。
  //   C0 裁决：Toolbar 与键盘行为必须一致 —— 旧 useSelection.CommandHistory（只回退
  //   docBlocks）已随 C-Impl-3 删除，本函数是全仓唯一的 undo/redo mutation 出口。
  //   路由由 **ownership** 决定（不是由某个输入开关决定）：
  //     core  → EditorHistory（Core 文档是真相源）
  //     legacy→ OperationHistory（rollback 能力，写回后重投影 docBlocks）
  const requestUndoRedo = useCallback(
    (doRedo: boolean) => {
      // 若正在编辑（EditSession active），不抢退（避免与键盘编辑冲突）。
      // C-Impl 行为保持：编辑中 Ctrl+Z/Y = no-op（6.22-E R3 既有事实，不新增 working-draft undo）。
      if (editSessionRef.current && editSessionRef.current.status === "active") return;

      const hist = operationHistoryRef.current;
      if (!hist) return;

      const doc = editableDocumentRef.current;
      if (!doc) return;

      // ── F3B-6.17-3C-10C.3B-0：Core-owned ⇒ 路由到 **Core History** ──────────
      //   路由由 **ownership** 决定（不是由某个输入开关决定）：Core 输入已接管编辑真相时，
      //   `Ctrl+Z/Ctrl+Y` 必须作用在 Core History 上，否则就是 ownership split
      //   （输入写 Core、撤销撤 Legacy ⇒ 撤不掉，甚至两边栈错位）。
      //   ① 同一连续段绝不换侧（`lastUndoRedoOwner` 粘住，仅新 mutation 可重置）
      //   ② owner = core 时**绝不**触碰 Legacy OperationHistory（即使 Core 到底 / 无 session）
      const route = decideUndoRedoRoute({
        lastMutationOwner: lastMutationOwnerRef.current,
        lastUndoRedoOwner: lastUndoRedoOwnerRef.current,
        doRedo,
        hasCoreSession: !!coreInputSessionRef.current,
        coreCanUndo: coreInputSessionRef.current?.history.canUndo ?? false,
        coreCanRedo: coreInputSessionRef.current?.history.canRedo ?? false,
      });
      if (route.route === "core") {
        const coreSession = coreInputSessionRef.current;
        const telemetry = coreInputHistoryTelemetryRef.current;
        if (route.reason !== "core-owner" || !coreSession) {
          // 路由判定的守卫：本方不可执行 ⇒ **no-op**（绝不落入 Legacy）
          recordUndoRedoNoop(telemetry, route.reason);
          console.log("[F3B-6.17][CORE_INPUT_UNDO]", { path: "no-op", reason: route.reason, doRedo });
          return;
        }
        const outcome = doRedo ? redoCoreInput(coreSession) : undoCoreInput(coreSession);
        if (!outcome.applied) {
          recordUndoRedoNoop(telemetry, "core-exhausted");
          console.log("[F3B-6.17][CORE_INPUT_UNDO]", { path: "no-op", reason: "core-exhausted", doRedo });
          return;
        }
        // ★ F3B-6.27 实现 checkpoint：range ledger **随 Core 事务一起回滚/重做**（Q2=A）。
        //   恢复的是快照对象本身（引用级），不是从 Core 文本重新推导。
        try {
          const ledger = segmentRangeLedgerRef.current;
          if (ledger) {
            const res = doRedo ? redoTransaction(ledger) : undoTransaction(ledger);
            if (res.ok) segmentRangeLedgerRef.current = res.ledger;
          }
        } catch {
          /* ledger 恢复失败 ⇒ 不影响既有 undo/redo 路径 */
        }
        recordUndoRedo(telemetry, "core", doRedo, "core-owner");
        lastUndoRedoOwnerRef.current = "core";
        // Core 文档真相源同步 + Core render 门控 + 触发 F3B-6.14 reconciliation
        coreDocumentRef.current = outcome.document;
        coreLifecycleRef.current?.markOwned();
        setSegmentCoreActive(true);
        noteCoreSessionChange("core-mutation");
        // #12/G2（**实现修正**）：Core undo/redo ⇒ 只补 **export ownership**（Core 文档是真相源）。
        //   ⚠️ 刻意**不**调 `markMutationOwner`：其语义是「**mutation** 落到哪一侧」，且实现里会
        //   复位 `lastUndoRedoOwnerRef`（结束旧连续段）⇒ 在此调用会**打断连续段粘性**
        //   （`3c10c3b0-core-undo-redo` 实测 `★ 连续段 = core` 失败）。
        //   撤销/重做不是 mutation —— 连续段归属由本分支上方 `lastUndoRedoOwnerRef = "core"` 维护。
        exportOwnershipRef.current = "core";
        // ── 01H（H1）：Undo/Redo ⇒ 拆分事务证据必须失效 ──────────────
        //   撤销拆分后若继续沿用旧记录，会把已不存在的「新段落」当成当前编辑目标。
        lastSplitMutationRef.current = null;
        appliedTransactionIdRef.current =
          (coreSession.history.entries()[coreSession.history.appliedCount - 1]?.id as string) ?? null;
        // ── F3B-6.28-F（第六刀阶段 2 · 路线 A）：segments 呈现态随 Core Document 同步 ──
        //   Core undo/redo 只回滚 Core Document；`editedSegments`（单调累积 replay）与
        //   `segments.text` 由 blur 链写入、从不回滚 ⇒ ① segment-mask 滞盖原文（undo 后行
        //   空白）② 翻页回放复活已撤销编辑。按 Core 真值 resync（fail-open）：段落回到
        //   导入期文本 ⇒ 逐成员恢复 originalText + 移除条目；中间态/redo ⇒ 经既有
        //   carriesWhole/sliceText 身份关系写。不触碰 ledger / originalText / PDFCanvas /
        //   export safety-net。
        try {
          const r = resyncSegmentPresentationToCore(
            outcome.document,
            coreImportSnapshotRef.current,
            {
              carriesWhole: (sid, pid) => domSurfaceCarriesWholeParagraph(pid, sid),
              sliceText: (sid, pid, paraText) => {
                const own = segmentRangeOwnershipOf(pid);
                return own ? sliceTextFor(own, paraText, sid) : null;
              },
            },
          );
          if (r.entriesRemoved + r.entriesUpdated + r.segmentsChanged > 0) {
            console.log("[F3B-6.28][SEGMENT_PRESENTATION_RESYNC]", r);
          }
        } catch {
          /* 同步失败不阻断 undo/redo（呈现态问题，不得放大为状态机故障） */
        }
        console.log("[F3B-6.17][CORE_INPUT_UNDO]", {
          path: doRedo ? "redo" : "undo",
          owner: "core",
          applied: outcome.applied,
          appliedCount: outcome.historyApplied,
          size: coreSession.history.size,
        });
        refreshUndoRedoAvailability();
        return;
      }

      // ── F3B-6.4B-4.4B：History ↔ Ledger 同步顺序（transaction-like）──
      //   ① **先 peek**（纯只读）取得本次将被消费的 entry 的 segmentKey；
      //   ② 再执行 History mutation；
      //   ③ **只有 mutation 成功后**才改变 Ledger —— undo/redo 失败时绝不触碰 ledger。
      //   非 Segment entry（segmentKey === undefined）⇒ Ledger 什么都不做（不伪造 record）。
      //   依赖方向：OperationHistory -X→ Ledger，本处是唯一的 orchestration 接点。
      const peeked = doRedo ? hist.peekRedo() : hist.peekUndo();
      const res = doRedo ? hist.redo(doc) : hist.undo(doc);
      if (!res.success) return;
      // ── F3B-6.17-3C-10C.3B-0：Legacy 侧实际执行 ⇒ 记账（owner = legacy 连续段）──
      recordUndoRedo(coreInputHistoryTelemetryRef.current, "legacy", doRedo, "legacy-owner");
      lastUndoRedoOwnerRef.current = "legacy";

      const segmentKey = peeked?.segmentKey;
      if (segmentKey !== undefined && segmentPositionLedger.has(segmentKey)) {
        if (doRedo) segmentPositionLedger.reapply(segmentKey);
        else segmentPositionLedger.revert(segmentKey);
      }

      editableDocumentRef.current = res.document;
      (window as any).__editableDocument = res.document;
      setEditableDocVersion((v) => v + 1);

      // ── F3B-6.4B-P1-1：History mutation 后同步**派生 render state**（mask）──
      //   与上面的 ledger 同步同族、同序：**只在 mutation 成功后**执行；
      //   且必须在文档写回**之后**（markLineEdited 读 editableDocumentRef.current）。
      //   判据 = History 中该行是否仍有生效编辑 ⇒ recompute（重算 box）或 remove（移除 render state）。
      if (peeked) {
        const target = operationTarget(peeked.operation);
        if (target.lineId) resyncEditedRenderStateForLine(target.blockId, target.lineId, doRedo ? peeked.inverse : null);
      }

      // ── C0 裁决的 canonical projection 路径 ──
      //   OperationHistory 是 docBlocks 的 projection 来源：undo/redo 后重投影 docBlocks，
      //   保证「Toolbar Undo ⇒ docBlocks changed, document unchanged」的旧撕裂不再可能出现。
      setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(res.document)));
      refreshUndoRedoAvailability();
    },
    [refreshUndoRedoAvailability, noteCoreSessionChange, segmentPositionLedger, resyncEditedRenderStateForLine, resyncSegmentPresentationToCore]
  );

  // 键盘入口：Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y
  // C-Impl-1 起这是**全仓唯一**的 undo/redo 键盘监听（useSelection 的旧监听已随 CommandHistory 删除
  // ⇒ 6.22-E R2「同一次 Ctrl+Z 触发两套 history」结构上不再存在）。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const isZ = e.key === "z" || e.key === "Z";
      const isY = e.key === "y" || e.key === "Y";
      if (!isZ && !isY) return;
      // Ctrl+Y 与 Ctrl+Shift+Z 均为 redo；Ctrl+Z 为 undo
      const doRedo = isY || (isZ && e.shiftKey);
      // 若正在编辑（EditSession active）：吞掉按键但**不**执行 undo
      //（保持 6.22-E 实测行为「编辑中 Ctrl+Z 无反应」，且不让浏览器原生 textarea undo 漏进来）
      if (editSessionRef.current && editSessionRef.current.status === "active") {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      requestUndoRedo(doRedo);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [requestUndoRedo, editSessionRef]);

  // C-Impl-1：把唯一执行器注册进 canonical 请求总线（Toolbar Undo/Redo 经此进入同一路由）
  useEffect(() => {
    registerUndoRedoExecutor(requestUndoRedo);
    refreshUndoRedoAvailability();
    return () => clearUndoRedoExecutor();
  }, [requestUndoRedo, refreshUndoRedoAvailability]);

  // ── F3B-6.23-C-Impl-5：canonical history reset（新文档加载边界）──
  //   取代旧 `clearHistory()`（CommandHistory.clear()）。清空的是**真正的** history 面：
  //     · Legacy OperationHistory（rollback 栈，结构保留、栈清空）
  //     · Segment ledger（与 History 同族的 position 记账）
  //     · ownership 记账（lastMutationOwner / lastUndoRedoOwner）
  //     · 路由 telemetry
  //   Core EditorHistory 随 session 释放（loadPdfFromArrayBuffer 下方 coreInputSessionRef=null）；
  //   export ownership 复位见下方既有代码（exportOwnershipRef = "core"）。
  //   ⚠️ OperationHistory 本身**不删除**（C0：它仍是 rollback 能力）。
  const resetCanonicalHistory = useCallback(() => {
    operationHistoryRef.current?.clear();
    segmentPositionLedger.reset();
    coreInputHistoryTelemetryRef.current = createCoreInputHistoryTelemetry();
    lastMutationOwnerRef.current = null;
    lastUndoRedoOwnerRef.current = null;
    refreshUndoRedoAvailability();
  }, [refreshUndoRedoAvailability, segmentPositionLedger]);

  // ── Debug: window.__ocrDebug — 输出完整 pipeline 状态 ──
  // 在 pdfMode / editableDocVersion / page / docBlocks 变化时刷新
  useEffect(() => {
    if (!pdfDoc) return;

    const doc = editableDocumentRef.current;

    // 1. editableDocument 统计
    let pageCount = 0;
    let blockCount = 0;
    let glyphCount = 0;
    if (doc) {
      pageCount = doc.pages.length;
      for (const pg of doc.pages) {
        blockCount += pg.blocks.length;
        for (const blk of pg.blocks) {
          for (const ln of blk.lines) {
            glyphCount += ln.glyphs.length;
          }
        }
      }
    }

    // 读取已 memoized 的 glyphCommands（不重新生成）
    const commands = glyphCommands || [];
    const drawGlyphs = commands.filter((c) => c.type === "drawGlyph") as DrawGlyphCommand[];
    const drawLines = commands.filter((c) => c.type === "drawLine");
    const maskCmds = drawLines.filter((c) => (c as any).purpose === "mask");
    const firstMask = maskCmds.length > 0
      ? { x: (maskCmds[0] as any).x, y: (maskCmds[0] as any).y, width: (maskCmds[0] as any).width, height: (maskCmds[0] as any).height }
      : null;
    const firstGlyph = drawGlyphs.length > 0
      ? { char: drawGlyphs[0].char, x: drawGlyphs[0].x, y: drawGlyphs[0].y, fontSize: doc?.styles[drawGlyphs[0].styleRef]?.fontSize ?? null }
      : null;

    // 2. renderLayers — 检测 DOM 中实际渲染的层
    const renderLayers: Array<{ name: string; zIndex: number; visible: boolean; count: number }> = [];
    const wrapper = wrapperRef.current;
    if (wrapper) {
      // imageLayer: canvas 元素
      const canvasEl = wrapper.querySelector("canvas");
      renderLayers.push({
        name: "imageLayer",
        zIndex: 0,
        visible: !!canvasEl,
        count: canvasEl ? 1 : 0,
      });

      // glyphRendererLayer: GlyphRenderer 容器（span 绝对定位）
      // GlyphRenderer 渲染的 span 没有 data 属性，通过检查 wrapper 内绝对定位 span 数量近似
      const allSpans = wrapper.querySelectorAll("span");
      let glyphSpanCount = 0;
      allSpans.forEach((s) => {
        const st = window.getComputedStyle(s);
        if (st.position === "absolute" && s.textContent && s.textContent.length <= 1) {
          glyphSpanCount++;
        }
      });
      renderLayers.push({
        name: "glyphRendererLayer",
        zIndex: 30,
        visible: glyphSpanCount > 0,
        count: glyphSpanCount,
      });

      // maskLayer: GlyphRenderer 中 purpose=mask 的 div（白色背景）
      // 这些是 lines 中 purpose=mask 渲染的 div
      const allDivs = wrapper.querySelectorAll(":scope > div > div > div");
      let maskDivCount = 0;
      allDivs.forEach((d) => {
        const st = window.getComputedStyle(d);
        if (st.position === "absolute" && st.backgroundColor === "rgb(255, 255, 255)") {
          maskDivCount++;
        }
      });
      renderLayers.push({
        name: "maskLayer",
        zIndex: 1,
        visible: maskDivCount > 0,
        count: maskDivCount,
      });

      // textLayer / segmentsLayer: 检查是否有 segments 或 textItems 渲染
      const segCount = wrapper.querySelectorAll('[data-segment-id]').length;
      renderLayers.push({
        name: "segmentsLayer",
        zIndex: 2,
        visible: segCount > 0,
        count: segCount,
      });

      // backgroundPatchLayer: BackgroundPatchLayer 中的 <img> 元素
      // 匹配 data-sprint29-patch 属性（BackgroundPatchLayer 实际使用的标记）
      const bgImgs = wrapper.querySelectorAll('[data-sprint29-patch]');
      const bgPatchCount = bgImgs.length;
      renderLayers.push({
        name: "backgroundPatchLayer",
        zIndex: 10,
        visible: bgPatchCount > 0,
        count: bgPatchCount,
      });

      // blocksLayer: pageBlocks div
      const blockDivs = wrapper.querySelectorAll(":scope > div > div > div[style*='position: absolute']");
      renderLayers.push({
        name: "blocksLayer",
        zIndex: 2,
        visible: blockDivs.length > 0,
        count: blockDivs.length,
      });
    }

    const debugInfo = {
      pdfMode,
      editableDocument: {
        pageCount,
        blockCount,
        glyphCount,
      },
      renderLayers,
      Mask: {
        maskCount: maskCmds.length,
        firstMask,
      },
      Glyph: {
        glyphCount: drawGlyphs.length,
        firstGlyph,
      },
      // 额外上下文
      _meta: {
        page,
        editableDocVersion,
        ocrTaskId,
        ocrBlocksInjected: ocrBlocksInjectedRef.current,
        docBlocksCount: docBlocks.length,
        pageBlocksCount: docBlocks.filter((b) => b.page === page).length,
        glyphCommandsCount: commands.length,
      },
    };

    (window as any).__ocrDebug = debugInfo;
    console.log("[__ocrDebug] Pipeline status:", debugInfo);
  }, [pdfDoc, pdfMode, editableDocVersion, page, glyphCommands]);

  // ── Sprint 31.2: Layer Debug — 运行时层诊断 ──
  useEffect(() => {
    if (typeof window === "undefined") return;

    (window as any).__sprint31_2_layerDebug = () => {
      const wrapper = wrapperRef.current;
      const result: any = {
        layers: [],
        domCheck: null,
      };

      if (wrapper) {
        // imageLayer: canvas
        const canvasEl = wrapper.querySelector("canvas");
        result.layers.push({
          name: "imageLayer",
          count: canvasEl ? 1 : 0,
          zIndex: 0,
        });

        // backgroundPatchLayer: img with data-sprint29-patch
        const bgImgs = wrapper.querySelectorAll("[data-sprint29-patch]");
        result.layers.push({
          name: "backgroundPatchLayer",
          count: bgImgs.length,
          visible: bgImgs.length > 0,
          zIndex: 10,
        });

        // glyphRendererLayer: absolute-positioned spans
        const allSpans = wrapper.querySelectorAll("span");
        let glyphSpanCount = 0;
        allSpans.forEach((s) => {
          const st = window.getComputedStyle(s);
          if (st.position === "absolute" && s.textContent && s.textContent.length <= 1) {
            glyphSpanCount++;
          }
        });
        result.layers.push({
          name: "glyphRendererLayer",
          count: glyphSpanCount,
          zIndex: 30,
        });

        // DOM check: patch element via data-layer attribute
        const patchEls = document.querySelectorAll("[data-layer='backgroundPatch']");
        result.domCheck = {
          selector: "[data-layer='backgroundPatch']",
          count: patchEls.length,
        };
        if (patchEls.length > 0) {
          const rect = patchEls[0].getBoundingClientRect();
          result.domCheck.firstElement = {
            tagName: (patchEls[0] as HTMLElement).tagName,
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        }

        // Patch img check: getBoundingClientRect of the first background patch img
        if (bgImgs.length > 0) {
          const img = bgImgs[0] as HTMLImageElement;
          const imgRect = img.getBoundingClientRect();
          result.patchImgRect = {
            x: Math.round(imgRect.x),
            y: Math.round(imgRect.y),
            width: Math.round(imgRect.width),
            height: Math.round(imgRect.height),
          };
          result.patchImgSrc = img.src.substring(0, 50) + "...";
        }
      }

      console.log("[Sprint31.2] layerDebug:", result);
      return result;
    };

    // ── Sprint 31.3: 语义分类 debug ──
    (window as any).__signatureClassificationDebug = () => {
      const data = (window as any).__sprint31_3_classification;
      if (!data) {
        console.warn("[Sprint31.3] 无分类数据，请先上传签名文档并等待处理完成");
        return null;
      }
      console.log("[Sprint31.3] classification:", JSON.stringify(data, null, 2));
      return data;
    };

    return () => {
      delete (window as any).__sprint31_2_layerDebug;
    };
  }, []);

  // ── Performance Monitor: 每秒输出 window.__glyphStats ──
  // 检测 glyphCount / renderCount / DOM span / memory 是否持续增长
  // Task 3: 不再调用 renderPageToCommands，直接读取已 memoized 的 glyphCommands
  useEffect(() => {
    if (!pdfDoc) return;
    // F3B-6.2：每秒性能采样默认关闭（?debug=perf 开启）——避免常驻 DOM 查询开销。
    if (!isPerfMonitorEnabled()) return;

    const interval = setInterval(() => {
      // 直接从 memoized glyphCommands 读取，不重新生成
      const commands = glyphCommands || [];
      const glyphCount = commands.filter((c) => c.type === "drawGlyph").length;
      const maskCount = commands.filter((c) => c.type === "drawLine" && (c as any).purpose === "mask").length;

      // DOM span 数量
      const domSpanCount = document.querySelectorAll("span").length;
      const glyphSpanCount = document.querySelectorAll(".glyph-renderer span").length;

      // React render 次数
      const renderCount = (window as any).__pdfEditorRenderCount || 0;

      // Memory（仅 Chrome）
      const mem = (performance as any).memory;
      const memoryInfo = mem
        ? {
            usedJSHeapSize: Math.round(mem.usedJSHeapSize / 1024 / 1024), // MB
            totalJSHeapSize: Math.round(mem.totalJSHeapSize / 1024 / 1024),
            jsHeapSizeLimit: Math.round(mem.jsHeapSizeLimit / 1024 / 1024),
          }
        : null;

      const stats = {
        timestamp: Date.now(),
        glyphCount,
        maskCount,
        renderCount,
        domSpanCount,
        glyphSpanCount,
        memory: memoryInfo,
      };

      (window as any).__glyphStats = stats;
      // console.log("[__glyphStats]", stats); // 已禁用，需要时取消注释
    }, 1000);

    return () => clearInterval(interval);
  }, [pdfDoc, glyphCommands]);

  // Render PDF
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;
    let done = false;
    canvasRenderedRef.current = false; // 重置：等待本次渲染完成
    (async () => {
      const pg = await pdfDoc.getPage(page);
      const vp = pg.getViewport({ scale: 1.5 });
      // Sprint-112: Expected Scene = pdf.js Raw Inventory（operator 分类）
      try {
        const OPS: any = (pdfjsLib as any).OPS;
        const ops = await pg.getOperatorList();
        let t = 0, im = 0, ve = 0, sh = 0, an = 0;
        for (const id of ops.fnArray) {
          if (id === OPS.showText || id === OPS.beginText) t++;
          else if (id === OPS.paintImageXObject || id === OPS.paintInlineImageXObject || id === OPS.paintImageMaskXObject) im++;
          else if (id === OPS.stroke || id === OPS.closeStroke) ve++;
          else if (id === OPS.fill || id === OPS.eoFill) sh++;
          else if (id === OPS.beginAnnotation) an++;
        }
        expectedSceneRef.current = { text: t || 0, image: im, vector: ve, shape: sh, annotation: an };
      } catch { expectedSceneRef.current = null; /* 无 operator 则退化为仅文本判定 */ }
      const canvas = canvasRef.current!;
      // ★ 2026-10-23（用户缺陷「编辑后整页文本重影」）：**串行化 canvas 重绘**。
      //   编辑每提交一个字符 ⇒ editableDocVersion++ ⇒ 本 async effect 重跑；旧实现
      //   各实例并发 `await getPage` 后各自「设 width 清空 + render」⇒ 多个 pdf.js
      //   renderTask 交错画同一 canvas ⇒ 双绘。修复 = cancel 前序 + 等其结束 + 清空
      //   + 渲染 ⇒ 最后一次渲染独占 canvas。
      // ★★ 2026-10-23（用户缺陷「其他页面同样位置的文本全被变成空白」）：**先检查
      //   done 再 cancel**——被取代的实例（await getPage 恢复后）若去 cancel 新实例
      //   **进行中**的渲染，然后自己因 done 退出 ⇒ canvas 停留在中断态（部分内容
      //   空白）。
      if (done) return;
      const prevTask = canvasRenderTaskRef.current;
      if (prevTask) {
        try {
          prevTask.cancel();
        } catch {
          /* 已完成/已取消 */
        }
        try {
          await prevTask.promise;
        } catch {
          /* cancelled ⇒ 正常 */
        }
      }
      // await 期间又被取代 ⇒ 退出（绝不清空/渲染，避免交错双绘）
      if (done) return;
      canvas.width = vp.width;
      canvas.height = vp.height;
      // 双保险：显式清空（width 赋值已重置内容，此处防御 pdf.js 预置 transform 残留）
      {
        const clearCtx = canvas.getContext("2d");
        if (clearCtx) {
          clearCtx.save();
          clearCtx.setTransform(1, 0, 0, 1, 0, 0);
          clearCtx.clearRect(0, 0, canvas.width, canvas.height);
          clearCtx.restore();
        }
      }
      // Sprint-109 (First Paint): pdf.js 渲染到可见 canvasRef（canvas 在 DOM 中，pdf.js 才能正确光栅化）。
      // z0 层由 sceneReady 门控 `visibility: hidden`，sceneReady 后与 z30 编辑层同帧 reveal（Atomic Reveal），
      // 消灭 "原文→编辑层" 中间态。（注：headless 中 pdf.js 无法渲染到脱离 DOM 的 canvas，故不用 offscreen）
      // M7.7-021: canvas 渲染审计 — 确认编辑后是否还在重绘 canvas（用 ref 避免闭包陈旧）
      const currentEditedLines = editedLinesRef.current;
      // console.log("[M7.7-021][CANVAS_DRAW]", {
        //   pageNum: page,
        //   canvasW: vp.width,
        //   canvasH: vp.height,
        //   hasEditedLines: currentEditedLines.size > 0,
        //   editedLineIds: [...currentEditedLines],
        //   timestamp: Date.now(),
        // });
      // pdf.js 的同 canvas 并发保护（内部注册表异步清理）⇒ cancel 后立即 render 可能
      // 抛 "Cannot use the same canvas during multiple render() operations" ⇒ 重试一次
      let renderTask = pg.render({ canvasContext: canvas.getContext("2d")!, viewport: vp });
      canvasRenderTaskRef.current = renderTask as unknown as {
        cancel: () => void;
        promise: Promise<unknown>;
      };
      try {
        await renderTask.promise;
      } catch {
        if (done) return;
        // 重试一次（首次失败多因 pdf.js 内部状态未清）
        await new Promise((r) => setTimeout(r, 80));
        if (done) return;
        const clearCtx = canvas.getContext("2d");
        if (clearCtx) {
          clearCtx.save();
          clearCtx.setTransform(1, 0, 0, 1, 0, 0);
          clearCtx.clearRect(0, 0, canvas.width, canvas.height);
          clearCtx.restore();
        }
        const retry = pg.render({ canvasContext: clearCtx, viewport: vp });
        canvasRenderTaskRef.current = retry as unknown as {
          cancel: () => void;
          promise: Promise<unknown>;
        };
        await retry.promise.catch(() => {
          /* cancelled（新渲染已接管）或二次失败：由后续重建兜底 */
        });
      }
      if (done) return;

      (window as any).__renderPipelineMap.layers[0].size = `${vp.width}×${vp.height} canvas px → CSS ${canvas.clientWidth}×${canvas.clientHeight}`;

      // CSS display scale — canvas pixel vs CSS display
      cssScaleRef.current = canvas.clientWidth / canvas.width;
      canvasRenderedRef.current = true; // 标记 cssScale 已就绪，OCR 注入 effect 可读取

      // Sprint-127 (唯一 Mission): Bitmap Runtime — PDFEditor 不实现 Bitmap 判定，只消费 bitmapState.visible。
      // computeBitmapState 纯函数：canvas → {ready,valid,visible,reason}（判定逻辑在 Bitmap Runtime 内）。
      const bs = computeBitmapState(canvas);
      setBitmapState(bs);
      if (bs.visible) {
        setSceneReadyBase(true); // z0 底图 reveal（Fallback = Bitmap Only），不等 Completeness
      } else {
        console.warn("[Sprint-127][bitmap] z0 HOLD, reason=", bs.reason, { w: canvas.width, h: canvas.height });
      }

      // ── Sprint 25: Expose viewport/canvas info to window ──
      (window as any).__sprint25_viewportScale = 1.5;
      (window as any).__sprint25_cssScale = cssScaleRef.current;
      (window as any).__sprint25_canvasWidth = vp.width;
      (window as any).__sprint25_canvasHeight = vp.height;

      coordRef.current = new LockCoordSystem({ scale: 1.5, width: vp.width, height: vp.height });

      // Extract text → CSS display coords (canvas px × cssScale)
      // 保留原 textItems（OCR/highlight 仍依赖）
      const tc = await pg.getTextContent();
      const s = cssScaleRef.current;
      const hasNativeText = tc.items.some((i: any) => i.str?.trim());
      // M7.7-009B-2b: 诊断——检查 hasNativeText 结果
      console.log(`[009B-2b] hasNativeText=${hasNativeText} items.length=${tc.items.length} firstItem.str="${(tc.items[0] as any)?.str?.substring(0, 30) ?? "(empty)"}"`);

      // ── B3-C-6-A：Page Ops 后的**确定性** legacy 重建（唯一触发点）────────────
      // 失效后若当前页无文本（典型 = 新插入的空白页），下面的 scannedOCR 分支会 return：
      // 既不构建 EditableDocument、也不 bump version ⇒ rehydrate 永不触发 ⇒ Core 恒 null
      // ⇒ Add Image 静默 fail-closed（C-6 Audit S1）。
      // 这里**仅**在 Page Ops 上下文构建该空页并 bump，之后仍由既有 canonical 链派生 Core：
      //   setEditableDocVersion ⇒ [editableDocVersion] effect ⇒ shouldRehydrate()
      //   ⇒ initializeCoreDocument(legacy)（不创建第二套初始化机制）
      if (!hasNativeText && pendingPageOpRebuildRef.current) {
        pendingPageOpRebuildRef.current = false;
        const prevDoc = editableDocumentRef.current;
        const emptyPage = {
          index: page,
          width: vp.width * s,
          height: vp.height * s,
          blocks: [],
          originYPt: (pg.view as number[])?.[1] ?? 0,
        };
        const merged = prevDoc
          ? [...prevDoc.pages.filter((p) => p.index !== page), emptyPage].sort((a, b) => a.index - b.index)
          : [emptyPage];
        const nextDoc: EditableDocument = {
          pages: merged,
          styles: prevDoc?.styles ?? [],
          metadata: {
            pageCount: pdfDoc.numPages,
            createdAt: Date.now(),
            ...(prevDoc?.metadata?.fileName !== undefined ? { fileName: prevDoc.metadata.fileName } : {}),
          },
          // ⚠️ runtime 是 EditableDocument 的必需字段（renderScale/cssScale/pageMetrics 属 runtime，
          //    不属于 metadata —— 不复制既有构建点把它们写进 metadata 的形态）。
          runtime: {
            renderScale: 1.5,
            cssScale: s,
            pageMetrics: merged.map((p) => ({ width: p.width, height: p.height })),
          },
        };
        editableDocumentRef.current = nextDoc;
        (window as any).__editableDocument = nextDoc;
        setEditableDocVersion((v) => v + 1);
        return;
      }

      // Sprint 12: PDF 模式检测
      // 扫描件无文本层（tc.items 为空或全是空白），textItems 为空
      if (!hasNativeText) {
        setTextItems([]);
        setSegments([]);
        segmentsByPageRef.current.clear();
        // 扫描件模式：不构建 PDF 原生 EditableDocument（避免覆盖 OCR 的）
        if (!ocrBlocksInjectedRef.current) {
          setPdfMode("scannedOCR");
          (window as any).__pdfMode = "scannedOCR";
          (window as any).__renderLayers = ["imageLayer", "maskLayer", "glyphRendererLayer"];
        }
        // Story-W1：扫描件自动 OCR（首页已渲染完成，后台识别后自动注入可编辑）。
        // 只调用 AutoOCRService，不内联 runFullOcr/saveOcrResult/taskId。
        if (!ocrBlocksInjectedRef.current && !ocrTaskId && pdfBytesRef.current) {
          import("../ocr/auto-ocr-service").then(({ startAutoOcr }) =>
            startAutoOcr(pdfBytesRef.current as ArrayBuffer, setOcrTaskId)
          );
        }
        // OCR 注入 effect 会构建 EditableDocument
        return;
      }

      // M7.7-009B-2b: 诊断——确认走 nativeText 路径
      console.log(`[009B-2b] PDF has native text, going to nativeText path, ocrBlocksInjected=${ocrBlocksInjectedRef.current}`);

      // M7.7-009B-2A: Audit — 从 pdf.js commonObjs 提取 FontFaceObject 字体身份信息
      console.log(`[009B-2a] FontFaceObject audit: pg.commonObjs=${typeof (pg as any).commonObjs} pg.commonObjs?.get=${typeof (pg as any).commonObjs?.get}`);
      try {
        const fontNames = [...new Set(tc.items.map((i: any) => i.fontName).filter(Boolean))];
        console.log(`[009B-2a] FontFaceObject audit: unique fontNames=${JSON.stringify(fontNames)}`);
        // 构建字体身份缓存
        const identityMap = new Map<string, { rawName: string; normalizedName: string; fontWeight: number }>();
        for (const fn of fontNames) {
          try {
            const fontObj = (pg as any).commonObjs?.get(fn);
            console.log(`[009B-2a] FontFaceObject audit: fontName="${fn}" fontObj=${typeof fontObj}`, fontObj);
            if (fontObj?.name) {
              const normalizedName = normalizePdfFontName(fontObj.name);
              const fontWeight = inferFontWeight(normalizedName);
              identityMap.set(fn, { rawName: fontObj.name, normalizedName, fontWeight });
              console.log(`[009B-2a] FontFaceObject audit: fontName="${fn}" -> name="${fontObj.name}" normalized="${normalizedName}" weight=${fontWeight}`);
            }
          } catch (e) {
            console.log(`[009B-2a] FontFaceObject audit: fontName="${fn}" -> error: ${e}`, e);
          }
        }
        // 将字体身份缓存注入 pdf-style-extractor
        setFontIdentityCache(identityMap as Map<string, any>);
        console.log(`[009B-2a] FontFaceObject audit: fontIdentityCache set with ${identityMap.size} entries`);
      } catch (e) {
        console.log(`[009B-2a] FontFaceObject audit: outer error: ${e}`, e);
      }

      // NativeText 模式：有文本层，正常提取
      if (!ocrBlocksInjectedRef.current) {
        setPdfMode("nativeText");
        (window as any).__pdfMode = "nativeText";
        (window as any).__renderLayers = ["imageLayer", "textLayer", "segmentsLayer"];
      }

      setTextItems(
        tc.items.filter((i: any) => i.str?.trim()).map((i: any) => {
          const c = coordRef.current!.fromPDF(i);
          return { id: crypto.randomUUID(), text: i.str, x: c.x * s, y: c.y * s, w: c.w * s, h: c.h * s, fontSize: c.fontSize * s };
        })
      );

      // Commit 5: Text Intelligence Layer
      // RawGlyph → LineGroup → Segment（标点切割 + 字体保真）
      const glyphs = extractGlyphs(tc as unknown as PdfTextContent);
      const lines = groupIntoLines(glyphs);
      const mapper = new CoordinateMapperImpl({
        viewportScale: 1.5,
        viewportHeight: vp.height / 1.5, // PDF pt height
        viewportWidth: vp.width / 1.5,   // PDF pt width
        cssScale: s,
        // M7.8-014: CropBox 平移补偿（vp.transform 含 cropbox 相对 mediabox 的偏移，
        // 否则所有由 mapper 算出的 y（segment/glyph baseline）整体偏高 crop_bottom·scale）。
        originXDevice: vp.transform[4],
        originYDevice: vp.transform[5],
      });
      const fontAnalyzer = new FontAnalyzerImpl();

      // M7.8-020-PROD：构建 segment 前统一解析字体（embedded→Bridge / system→真实系统字体 / 兜底）。
      // 解析会 await FontFace.load（=fontReady），节点渲染时字体已就绪，避免 Arial→PDF font 视觉跳变。
      // 解析结果按 documentId 缓存，翻页复用、PDF 切换隔离（不同 namespace）。
      const fontIds = [
        ...new Set((tc.items as any[]).map((i: any) => i.fontName).filter(Boolean)),
      ] as string[];
      let resolutionMap: Map<string, FontResolution> | undefined;
      try {
        resolutionMap = await resolveDocumentFonts(pdfDoc, fontIds);
      } catch (e) {
        console.warn("[M7.8-020-PROD] font resolution failed, fallback to FontAnalyzer family:", e);
      }
      // Step 4：留存供 Core 可见渲染复用（原只在 buildSegments 处局部消费）。
      fontResolutionMapRef.current = resolutionMap ?? null;
      // ★ F3B-6.27-G3：同时派生「PDF 字体名 → editableFontFamily」反查索引。
      //   Core `TextStyle.sourceFontName` 是 PDF BaseFont（含 subset prefix），与 map 的
      //   pdf.js fontId key 不同命名空间；没有这张表，Core 画布对**每个** run 都 miss
      //   ⇒ 全部回落 sans（与透明点击层字宽不一致 ⇒ 点击定位错位）。
      //   只登记解析成功且确有 family 的项；重名时保持**首次**登记（与 legacy 一致）。
      if (resolutionMap) {
        const idx = new Map<string, string>();
        for (const fr of resolutionMap.values()) {
          const name = fr?.pdfFontName;
          if (!name || !fr?.editableFontFamily) continue;
          if (!idx.has(name)) idx.set(name, fr.editableFontFamily);
        }
        pdfFontNameIndexRef.current = idx;
      } else {
        pdfFontNameIndexRef.current = null;
      }

      const built = buildSegments(lines, mapper, fontAnalyzer, page, resolutionMap);
      // M7.8-020-PROD：setSegments 是全局单份 state，翻页会被该页新 segments 整份替换。
      // 这里回放此前保存的编辑，避免翻页后上一页的修改丢失。
      const segs = applySegmentEdits(built);
      setSegments(segs);
      // M7.8-041：把本页 segments 累积进跨页 Map，导出时展开全部页（不依赖全局 segments 只存当前页）。
      segmentsByPageRef.current.set(page, segs);

      // PDF Reconstruction Engine V1 — Sprint 2: 构建 EditableDocument（PDF 原生来源）
      // 使用 StyleResolver 注册样式到文档级 styles 数组，
      // glyph.styleRef 指向 styles 索引（不每 glyph 复制 style）。
      // Sprint 12: 扫描 OCR 模式下跳过（OCR 注入 effect 已构建 EditableDocument）
      if (ocrBlocksInjectedRef.current && pdfMode === "scannedOCR") {
        // OCR 模式：不覆盖 OCR 的 EditableDocument，但递增 version 让 GlyphRenderer 更新
        setEditableDocVersion(v => v + 1);
        return;
      }
      try {
        const vpScale = 1.5;
        const pageWidthCss = vp.width * s;
        const pageHeightCss = vp.height * s;

        // Sprint 2：每页用独立 resolver，合并到文档级 resolver
        // （简化：PDF 原生流程每页重建 resolver；OCR 流程会覆盖整个文档）
        const pageResolver = new StyleResolver();

        // M7.8-035-FIX：与 pdf-importer.ts 对齐，把字体 provenance 传进 adapter。
        // 真实 PDF 常把 /Font 挂在 Form XObject /Resources 下（page /Font 为空），
        // 此时 pageMetrics 里根本没有这些字体 → glyph.fontIdentity 恒为空
        // → Export 无法引用原 Type3 资源 → 整行 page.drawText → Helvetica。
        // provenance 用 FontBBox + CharProcCount 从原 PDF object graph 直接判定字体，
        // 不依赖 pageMetrics，也不依赖 fontIdentity === undefined 猜测。
        let provenance: Awaited<ReturnType<typeof buildFontProvenanceMap>> | undefined;
        try {
          if (pdfLibDocRef.current && pdfDoc) {
            provenance = await buildFontProvenanceMap(pdfLibDocRef.current, pdfDoc, page - 1);
          }
        } catch (e) {
          console.warn("[M7.8-035-FIX] buildFontProvenanceMap failed, 导出字体溯源不可用:", e);
          provenance = undefined;
        }

        const editableBlock = pdfLinesToEditableBlock(
          lines,
          mapper,
          fontAnalyzer,
          `pdf_p${page}_block0`,
          pageResolver,
          // M7.7-IMPLEMENT-004(a)：浏览器 import 路径也传 pageMetrics，
          //   建立 glyph.metrics.fontIdentity（Native 编辑链路的字体身份前提）。
          pageFontMetricsRef.current?.[page - 1],
          // M7.8-035-FIX：原 PDF 字体资源溯源（Type3 / Form XObject 字体的唯一可靠来源）
          provenance
        );

        const editablePage = {
          index: page,
          width: pageWidthCss,
          height: pageHeightCss,
          blocks: [editableBlock],
          // M7.8-035-FIX-4：MediaBox 下边界（y0）。CSS 原点在 y1，导出翻转基准 = height + y0。
          // MediaBox.y0 ≠ 0 的 PDF 缺这个值会导致导出 mask 整体偏移，擦到下一行。
          originYPt: (pg.view as number[])?.[1] ?? 0,
        };

        // 合并到 editableDocumentRef（多页累积，合并 pageResolver 的 styles）
        const existing = editableDocumentRef.current;
        if (existing) {
          // M7.7-007C Audit 3 + Fix: 检查当前页是否已存在于 document 中。
          // 如果已存在（说明之前编辑过），跳过 rebuild 避免覆盖用户编辑。
          // 仅在首次加载或页面不存在时重建 document。
          const pageExists = existing.pages.some((p) => p.index === page);
          if (pageExists) {
            // console.log("[M7.7-007C][AUDIT3] page already exists in doc, SKIP rebuild:", {
            //   page,
            //   existingPages: existing.pages.map((p) => p.index),
            //   existingLineTexts: existing.pages
            //     .filter((p) => p.index === page)
            //     .flatMap((p) => p.blocks)
            //     .flatMap((b) => b.lines)
            //     .map((l) => l.glyphs.map((g) => g.char).join("")),
            // });
            // 递增 version 让 GlyphRenderer 更新（canvas 重新渲染），但不覆盖 document
            setEditableDocVersion((v) => v + 1);
            return;
          }

          // console.log("[M7.7-007C][AUDIT3] page NOT in doc, building for first time:", {
          //   page,
          //   existingPages: existing.pages.map((p) => p.index),
          // });
          const docResolver = new StyleResolver();
          // 重新注册已有 styles
          for (const st of existing.styles) docResolver.register(st);
          // 重新注册本页 styles，建立 local→global styleRef 映射
          // M7.7-008B: 使用 register() 真实返回值（考虑去重），而非简单偏移
          const pageStyles = pageResolver.toArray();
          const styleRemap: Record<number, number> = {};
          for (let i = 0; i < pageStyles.length; i++) {
            styleRemap[i] = docResolver.register(pageStyles[i]);
          }
          // 使用 remap 重新映射本页 glyph 的 styleRef
          const remappedPage = {
            ...editablePage,
            blocks: editablePage.blocks.map((b) => ({
              ...b,
              lines: b.lines.map((l) => ({
                ...l,
                glyphs: l.glyphs.map((g) => ({
                  ...g,
                  styleRef: styleRemap[g.styleRef] ?? g.styleRef,
                })),
              })),
            })),
          };
          const otherPages = existing.pages.filter((p) => p.index !== page);
          editableDocumentRef.current = {
            pages: [...otherPages, remappedPage].sort((a, b) => a.index - b.index),
            styles: docResolver.toArray(),
            metadata: {
              ...existing.metadata,
              pageCount: Math.max(existing.metadata.pageCount, page),
            },
          };
        } else {
          editableDocumentRef.current = {
            pages: [editablePage],
            styles: pageResolver.toArray(),
            metadata: {
              pageCount: pdfDoc.numPages,
              createdAt: Date.now(),
              renderScale: vpScale,
              cssScale: s,
              fileName,
            },
          };
          // M7.7-009B-2a: 诊断——检查所有 styles 是否包含 pdfjsFontFamily
          const styleSummary = editableDocumentRef.current?.styles?.map((s, i) => `[${i}] pdfjsFontFamily="${s.pdfjsFontFamily ?? "(undefined)"}" fontFamily="${s.fontFamily?.substring(0, 30)}"`).join("; ") ?? "(no styles)";
          console.log(`[009B-2a] EditableDocument built: styles.length=${editableDocumentRef.current?.styles?.length ?? 0}, ${styleSummary}`);
        }

        // 暴露到 window 供控制台调试（Task 5）
        (window as any).__editableDocument = editableDocumentRef.current;

        // M7.7-008A trace: style table 快照（每页的 styleRef → glyph 映射）
        const doc = editableDocumentRef.current;
        if (doc) {
          const pageStyles = doc.pages.map((pg) => {
            const lineInfos = pg.blocks.flatMap((b) => b.lines.map((l) => {
              const firstG = l.glyphs[0];
              const st = firstG ? doc.styles[firstG.styleRef] : null;
              return {
                lineId: l.id,
                glyphCount: l.glyphs.length,
                styleRef: firstG?.styleRef,
                style: st ? { fontSize: st.fontSize, fontFamily: st.fontFamily, fontWeight: st.fontWeight, lineHeight: st.lineHeight } : null,
              };
            }));
            return { pageIndex: pg.index, lineCount: lineInfos.length, lines: lineInfos };
          });
          // console.log("[M7.7-008A][STYLE_TABLE] multi-page style snapshot:", JSON.stringify(pageStyles, null, 2));
        }

        // ── M5-RUNTIME-002A-FIX: NativeText EditableDocument version propagation ──
        // nativeText 构建/替换 EditableDocument 成功后，递增 editableDocVersion，
        // 使 glyphCommands useMemo（deps [editableDocVersion, page]）重算 → GlyphRenderer 渲染。
        // 仅 nativeText 路径（scannedOCR 分支在 4527-4531 已递增并 return，不会走到此处）。
        // Version 对应"EditableDocument 已构建/更新"，非 render 强制，避免 render loop。
        setEditableDocVersion((v) => v + 1);
      } catch (e) {
        console.warn("[EditableDocument] PDF native build failed:", e);
      }

      // ── Sprint-109/112 (First Paint): 唯一 Reveal Gate = Scene Completeness ──
      // Ready 不是时间/OCR/Canvas，而是 Expected Scene == Actual Scene。
      // Expected 来自 pdf.js Raw Inventory（operator 分类），Actual 来自 Scene Builder 输出。
      // 仅当 Completeness = 100% 才 sceneReady=true → z0 底图与 z30 编辑层同帧 reveal。
      if (canvasRef.current && !sceneReadyRef.current) {
        requestAnimationFrame(() => {
          try {
            // 1) Expected Scene：来自 render effect 计算的 pdf.js Raw Inventory（expectedSceneRef）
            const exp = expectedSceneRef.current;
            const expected = expectedFromCounts({
              text: exp?.text ?? 0,
              image: exp?.image ?? 0,
              vector: exp?.vector ?? 0,
              shape: exp?.shape ?? 0,
              annotation: exp?.annotation ?? 0,
            });

            // 2) Actual Scene：从 EditableDocument（Scene Builder 输出）
            const ed = editableDocumentRef.current;
            let glyphCount = 0, imageCount = 0;
            for (const pg2 of ed?.pages || []) for (const blk of pg2.blocks || []) {
              if (blk.type === "image") imageCount++;
              for (const ln of blk.lines || []) glyphCount += ln.glyphs?.length || 0;
            }
            const actual = actualFromCounts({ text: glyphCount, image: imageCount, vector: 0, shape: 0, annotation: 0 });

            // 3) Completeness
            const comp = computeSceneCompleteness(expected, actual);
            // 诊断埋点（仅日志，不影响 Reveal 逻辑）：打印每个 block 的 type/kind，
            // 区分两种根因：① blocks 里有 pdf-fallback → 统计漏了（改 imageCount 判断）
            //                 ② blocks 里没有 pdf-fallback → Scene Builder 根本没产出来（改 Builder）
            const blockDump = (ed?.pages || []).map((pg2) => ({
              page: pg2.pageNumber ?? pg2.index,
              blocks: (pg2.blocks || []).map((b) => ({ type: b.type, kind: (b as { kind?: string }).kind })),
            }));
            console.log("[Sprint-112][scene-hold]", JSON.stringify({ expected, actual, completeness: comp.ratio, missing: comp.missing.map((m) => m.type), blocks: blockDump }));

            // 4) 仅 Completeness 100% 才立即 reveal（PM Rule: scene.ready = Expected==Actual）
            //    不完整时的策略（PM Sprint-112 决策）：
            //    - Debug 模式（import.meta.env.DEV）: 保留 2s 兜底 reveal + 打印 missing，便于调试
            //    - Release 模式: 不依赖时间兜底 —— 要么显示完整 Scene，要么进入显式降级路径
            //      （PdfFallbackObject 底图），绝不显示"半成品"。
            const missingLog = comp.missing.map((m) => `${m.type}(${m.actual}/${m.expected})`).join(",");
            if (comp.complete) {
              sceneReadyRef.current = true;
              setSceneReady(true);
              return;
            }
            if (import.meta.env.DEV) {
              console.warn("[Sprint-112][debug] scene incomplete, fallback reveal in 2s. missing:", missingLog);
              setTimeout(() => {
                if (!sceneReadyRef.current) { sceneReadyRef.current = true; setSceneReady(true); }
              }, 2000);
            } else {
              // Release：不 reveal 半成品。若底图（pdf-fallback）已就绪则 reveal 完整底图（降级），
              // 否则保持 loading（由 Scene Builder 补齐后触发）。绝不显示缺失 image/vector 的中间态。
              console.warn("[Sprint-112][release] scene incomplete, HOLD (no half-finished reveal). missing:", missingLog);
            }
          } catch (e) { console.warn("[Sprint-112] completeness err", e); sceneReadyRef.current = true; setSceneReady(true); }
        });
      }
    })();
    return () => {
      done = true;
      // ★ 2026-10-23：卸载/依赖变化时取消进行中的 canvas 渲染，避免与下一次渲染交错双绘
      try {
        canvasRenderTaskRef.current?.cancel();
      } catch {
        /* 已完成/已取消 */
      }
    };
  }, [pdfDoc, page]);

  // M7.8-020-PROD：PDF 卸载/切换时清理字体解析缓存（销毁 patchedDoc，释放内存；FontFace 由 fontFaceCache 自管）。
  useEffect(() => {
    return () => {
      if (pdfDoc) unloadDocumentFonts(pdfDoc);
      // ★ F3B-6.27-G3：与 fontResolutionMapRef 同生命周期释放反查索引（换文档 ⇒ 旧 family 失效）
      fontResolutionMapRef.current = null;
      pdfFontNameIndexRef.current = null;
    };
  }, [pdfDoc]);

  // ── OCR 流程：注入 OCR blocks + 显示首次引导 ──
  // 当 pdfDoc 加载完成 + ocrTaskId 存在时，等待首屏 canvas 渲染（cssScaleRef 设置完成），
  // 从 IndexedDB 读取 OCR 结果，将 canvas-pixel space (scale=1.5) 坐标 × cssScale → CSS 显示坐标，
  // 作为 text blocks 注入 docBlocks，并显示 "Click any text to edit" 引导弹框。
  useEffect(() => {
    console.log(
      "[Sprint31.1] OCR 注入 effect 触发",
      JSON.stringify({
        hasPdfDoc: !!pdfDoc,
        hasOcrTaskId: !!ocrTaskId,
        ocrBlocksInjected: ocrBlocksInjectedRef.current,
        pdfMode,
        sprint31Enabled: typeof window !== "undefined" ? !!(window as any).__sprint31_enabled : "no-window",
      }),
    );
    if (!pdfDoc || !ocrTaskId || ocrBlocksInjectedRef.current) return;
    let cancelled = false;

    const injectOcrBlocks = async () => {
      // 等待渲染 effect 完成：canvasRenderedRef.current = true 表示
      // canvas.width 已设为实际 viewport 宽度（非默认 300），cssScaleRef.current 已正确计算
      const startWait = Date.now();
      while (Date.now() - startWait < 5000) {
        if (canvasRenderedRef.current) {
          break;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      if (cancelled) return;

      try {
        const { getOcrResult } = await import("../ocr/ocr-storage");
        const result = await getOcrResult(ocrTaskId);
        if (!result || !result.blocks?.length) {
          // 无 OCR 结果，仍显示引导 — 已禁用引导弹框
          // setShowOcrHint(true);
          return;
        }
        const s = cssScaleRef.current;

        // ===== RG-5A-2 Production Hook（旁路 Runtime Validation，fire-and-forget）=====
        // Production Hook Rules:
        //   1. Single call site.
        //   2. Wrapped by try/catch (fire-and-forget).
        //   3. Never affects production flow (no await, no latency added).
        //   4. No retries.
        //   5. Can be removed by deleting this call.
        // Rollback: delete this block, nothing else.
        // Feature Flag: 默认 OFF，可 10% / 50% / 100% 逐步打开（Observation Window 分阶段放量）。
        const runtimeValidationEnabled = false;
        if (runtimeValidationEnabled) {
          void import("../document-model/production-wiring").then(({ runProductionWiring }) =>
            runProductionWiring({
              // Temporary document identity for observation only.
              docId: ocrTaskId,
              ocrBlocks: result.blocks,
              renderCanvas: async (pageNum: number) => {
                // scale=2.0（RENDER_SCALE），与 OCR 阶段 buildGeometryForBlocks 需求一致
                const pdfPage = await pdfDoc.getPage(pageNum);
                const vp = pdfPage.getViewport({ scale: 2.0 });
                const canvas = document.createElement("canvas");
                canvas.width = vp.width;
                canvas.height = vp.height;
                const ctx = canvas.getContext("2d")!;
                await pdfPage.render({ canvasContext: ctx, viewport: vp }).promise;
                return canvas;
              },
            }).catch((e) => {
              // No retries. 失败仅记录，不影响生产。
              console.warn("[RG-5A] Production Wiring skipped", e);
            }),
          );
        }

        // === Document Text Block Engine ===
        // 不拆行！保留段落整体，用 OCR 给的单行 fontSize，CSS pre-wrap 自然换行
        // 段落 bbox 做遮盖（覆盖全部原文），fontSize 从 OCR 单行高度算出
        const { ocrBlocksToDocumentBlocks } = await import("./document-engine");

        // OCR blocks → DocumentTextBlock（段落级，不拆行）
        const docBlocks = ocrBlocksToDocumentBlocks(result.blocks);

        // DocumentTextBlock → editor Block（乘 cssScale 转 CSS 显示坐标）
        const blocksToInject: Block[] = docBlocks.map((b) => ({
          id: b.id,
          type: "text" as const,
          page: b.page,
          x: b.bbox.x * s,
          y: b.bbox.y * s,
          w: b.bbox.width * s,
          h: b.bbox.height * s,  // 段落总高度（多行）
          text: b.text,
          fontSize: b.style.fontSize * s,  // 单行字号（OCR 已算好）
          fontFamily: b.style.fontFamily,
          color: b.style.color,
        }));

        if (cancelled) return;

        setDocBlocks((prev) => [...prev, ...blocksToInject]);
        ocrBlocksInjectedRef.current = true;
        // setShowOcrHint(true); // 已禁用引导弹框

        // PDF Reconstruction Engine V1 — Sprint 2: 构建 EditableDocument（OCR 来源）
        // 使用 StyleResolver + OCR Style Resolver 推断完整样式（4 级 fallback）。
        // 不影响现有 blocksToInject 注入逻辑，仅并行构建文档理解对象。
        // 关键：完整保留 OCR 原始 text，禁止任何 truncate。
        try {
          // Sprint 2：创建文档级 StyleResolver（所有页共用）
          const docResolver = new StyleResolver();

          // 按 page 分组 OCR blocks（OCR 结果可能跨多页）
          const blocksByPage = new Map<number, typeof result.blocks>();
          for (const b of result.blocks) {
            const arr = blocksByPage.get(b.page) || [];
            arr.push(b);
            blocksByPage.set(b.page, arr);
          }

          // 获取页面尺寸（从当前 pdfDoc）
          const pages = [];
          for (const [pageNum, pageBlocks] of blocksByPage) {
            const pdfPage = await pdfDoc.getPage(pageNum);
            const vp = pdfPage.getViewport({ scale: 1.5 });
            const pageWidthCss = vp.width * s;
            const pageHeightCss = vp.height * s;

            // ── Signature Layout Normalizer ──
            // 修复 GLM OCR 将横向签名误识别为竖排文字的问题。
            // 在 ocrBlocksToEditablePage 之前运行，拆分竖排 signature block 为多个横向 block。
            // 使用 flatMap 模式：old block 被删除（不进入 EditableDocument，避免 duplicate glyph）。
            const { normalizeSignatureLayout } = await import("../document-model/signature-layout-normalizer");
            const pageHeightEditor = pageHeightCss / s; // 转回 scale=1.5
            // W2 Task-1：ocrRatio = OCR canvas scale / editor scale = 2.0/1.5。
            // normalizer 用它把 1.5 空间 block 转回 2.0 空间 _ocrCanvasBbox（供 geometry-pipeline 在 2.0 canvas 上 crop）。
            // 此前传 1 导致 _ocrCanvasBbox 停在 1.5 空间，签名块 crop 偏移 25%。
            const ocrRatio = 2.0 / 1.5;
            // ── Sprint-49A Integration：OCR_PIPELINE_V2 接线（Zero Behavior Change）──
            // false（默认）→ 旧流程（下方原逻辑）；true → 新 Pipeline（SplitNormalizer 包装同一 normalizeSignatureLayout）。
            // 两条链路最终调用同一个 normalizeSignatureLayout，行为一致，可随时回滚。
            const { OCR_PIPELINE_V2 } = await import("../document-model/pipeline");
            let normalizedBlocks: typeof pageBlocks;
            if (OCR_PIPELINE_V2) {
              const { normalizeSignatureBlocks } = await import("../document-model/pipeline");
              normalizedBlocks = normalizeSignatureBlocks(pageBlocks, pageHeightEditor, ocrRatio);
            } else {
              normalizedBlocks = [];
              for (const b of pageBlocks) {
                const r = normalizeSignatureLayout(b, pageHeightEditor, ocrRatio);
                if (r.changed) {
                  console.log("[SignatureNormalizer Pipeline]", {
                    before: {
                      id: r.originalBlockId,
                      text: b.text,
                      bbox: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) },
                    },
                    after: {
                      count: r.blocks.length,
                      blocks: r.blocks.map(nb => ({
                        id: nb.id,
                        text: nb.text.length > 50 ? nb.text.slice(0, 47) + "..." : nb.text,
                        bbox: { x: Math.round(nb.x), y: Math.round(nb.y), w: Math.round(nb.w), h: Math.round(nb.h) },
                      })),
                    },
                  });
                }
                normalizedBlocks.push(...r.blocks);
              }
            }

            // ── Sprint-1 Commit 3：Geometry Distributor（Ownership 迁移）──
            // Normalizer → Distributor → Adapter。Distributor 是唯一 Child Geometry Owner。
            // parentBlocks = normalize 前的原始 blocks（含 Parent Geometry）。
            const { distributeGeometry } = await import("../ocr/geometry-distributor");
            const distributedBlocks = distributeGeometry({ parentBlocks: pageBlocks, childBlocks: normalizedBlocks });

            // Sprint 2：尝试提取 PDF 原生样式（用于 OCR 样式推断的规则 1）
            let pdfNativeStyles: Array<{ bbox: any; style: any }> | undefined;
            try {
              const tc = await pdfPage.getTextContent();
              if (tc.items.length > 0) {
                const { extractStylesFromTextContent } = await import("../document-model");
                const { CoordinateMapperImpl } = await import("../editor-engine/CoordinateMapper");
                const mapper = new CoordinateMapperImpl({
                  viewportScale: 1.5,
                  viewportHeight: vp.height / 1.5,
                  viewportWidth: vp.width / 1.5,
                  cssScale: s,
                  originXDevice: vp.transform[4],
                  originYDevice: vp.transform[5],
                });
                const styles = extractStylesFromTextContent(tc.items as any, s, 1.5);
                pdfNativeStyles = (tc.items as any[]).map((item, i) => {
                  const c = mapper.pdfToCss(
                    item.transform[4],
                    item.transform[5],
                    item.width || 50,
                    item.height || 12
                  );
                  return {
                    bbox: { x: c.x, y: c.y, width: c.w, height: c.h },
                    style: styles[i] || {},
                  };
                }).filter((x: any) => x.bbox.width > 0);
              }
            } catch {
              // PDF 无文本层或提取失败，pdfNativeStyles 保持 undefined
            }

            // ── M7.7-004U-EditStyle: 扫描件字体检测 ──
            // 扫描件（无文本层）的 OCR 样式来自 fallback，编辑后文字字体与原扫描字体不一致
            // （用户反馈"编辑后字体样式与原文本完全不一样"）。用已渲染的页面 canvas
            // （scale=1.5，与 OCR block 同空间）逐块做候选字体 Jaccard 匹配，
            // 产出 per-block + dominant 字体，注入 OCR 样式解析（只覆盖 fontFamily/fontWeight）。
            let fontDetection: FontDetectionResult | null = null;
            try {
              const canvas = canvasRef.current;
              // 仅当前显示页的 canvas 与 OCR block 同空间；其他页跳过（走拉丁优先 fallback）。
              if (canvas && pageNum === page) {
                const { detectFontsFromCanvas } = await import("../document-model/font-detector");
                fontDetection = detectFontsFromCanvas(canvas, distributedBlocks);
                if (fontDetection?.dominant) {
                  console.log(
                    `[FontDetector] page=${pageNum} dominant=${fontDetection.dominant.fontFamily} w=${fontDetection.dominant.fontWeight} ` +
                    `conf=${fontDetection.dominant.confidence.toFixed(3)} matched=${fontDetection.byBlock.size}/${distributedBlocks.length}`,
                  );
                }
              }
            } catch (e) {
              console.warn("[FontDetector] 跳过（不影响主流程）", e);
            }
            // DEBUG hook（与 __sprint* 一致）：暴露 OCR block 几何 + 检测结果，供诊断 spec 复读
            if (typeof window !== "undefined") {
              (window as any).__fontDetectionDebug = {
                cssScale: s,
                canvasW: canvasRef.current?.width,
                canvasH: canvasRef.current?.height,
                blocks: (distributedBlocks as any[]).map((b: any) => ({
                  id: b.id, x: b.x, y: b.y, w: b.w, h: b.h,
                  text: (b.text ?? "").slice(0, 60), fontSize: b.fontSize,
                })),
                result: fontDetection
                  ? {
                      dominant: fontDetection.dominant,
                      byBlock: Object.fromEntries(
                        [...fontDetection.byBlock.entries()].map(([k, v]) => [
                          k, { family: v.fontFamily, weight: v.fontWeight, conf: Number(v.confidence.toFixed(3)) },
                        ]),
                      ),
                    }
                  : null,
              };
            }

            const editablePage = ocrBlocksToEditablePage(
              distributedBlocks,
              pageNum,
              pageWidthCss,
              pageHeightCss,
              s,
              docResolver,
              { pdfNativeStyles, fontDetection }
            );

            // ── Sprint 20: Signature Composite Region Detection ──
            // 将空间相邻、语义相关的多个 OCR block 理解为单个复合签名区域。
            // 解决 Sprint 19 中 "1 个物理签名 → 7 个 OCR block → 多个独立区域" 的问题。
            const { detectCompositeSignatureRegions } = await import("../document-model/signature-region-merger");
            const sigResult = detectCompositeSignatureRegions(editablePage.blocks, pageHeightCss);
            if (sigResult.regions.length > 0) {
              console.log("[SignatureCompositeDetector] Identified composite signature regions:", {
                page: pageNum,
                regionCount: sigResult.regions.length,
                totalSourceBlocks: sigResult.regions.reduce((s, r) => s + r.sourceBlockIds.length, 0),
                suppressedGlyphCount: sigResult.suppressedGlyphBlockIds.size,
              });
              for (const r of sigResult.regions) {
                console.log(`  Region ${r.id}: mode=${r.mode} source=${r.sourceBlockIds.length} editable=${r.editableBlockIds.length} duplicates=${r.duplicateBlockIds.length} rotation=${r.rotation.angle}°`);
              }
            }

            // ── P0-004 Task 3：临时禁用 Signature Suppression + 背景重建（验证 OCR Facts）──
            // 让 Editor 直接显示 OCR 全部 Block。验证两个签名恢复后，再重新启用。
            const P0_DISABLE_SIGNATURE_SUPPRESSION = true; // ← P0 临时开关，验证后改回 false
            if (!P0_DISABLE_SIGNATURE_SUPPRESSION) {
              // Sprint 20.6: 注册到统一的 SignatureSuppressionManager
              // 使 renderDocument / renderToBlocks / renderPage 也能访问 suppressed block IDs
              signatureSuppression.setSuppressedBlockIds(pageNum, sigResult.suppressedGlyphBlockIds);
            }

            // Sprint 20: 复合区域背景重建
            const {
              reconstructCompositeRegionBackgrounds,
            } = await import("../document-model/signature-background-reconstructor");
            const canvas = canvasRef.current;
            const reconResult = P0_DISABLE_SIGNATURE_SUPPRESSION
              ? { replacements: [] as SignatureReplacement[], debug: [] as any[] }
              : (canvas
                  ? reconstructCompositeRegionBackgrounds(
                      sigResult.regions,
                      canvas,
                      cssScaleRef.current,
                    )
                  : { replacements: [] as SignatureReplacement[], debug: [] as any[] });

            signatureReplacementsRef.current.set(pageNum, reconResult.replacements);
            // Sprint 26: 存储 region 信息用于 patch coverage 验证
            signatureRegionInfoRef.current.set(pageNum, sigResult.regions);

            // 构建 suppressedGlyphIds 和 rotation map（仅当前页签名区域的 editable blocks）
            signatureRotationRef.current.clear();
            const sigEditableBlockIds = new Set<string>();
            for (const r of sigResult.regions) {
              for (const id of r.editableBlockIds) {
                sigEditableBlockIds.add(id);
                // Sprint36.2（TD-002）：签名子块 rotation 走旁路集合（signatureRotationRef），
                // 不再写入 EditableBlock.transform（Document 是只读 Facts，业务不得改 Geometry）。
                // ADR-006：Single Source of Truth = composite.rotation.angle。
                // Task 2：正确读取 region.rotation.angle（此前 (r as any).rotation 取到 {angle,confidence} 对象，类型错误）。
                const regionRot = (r.rotation as { angle?: number } | undefined)?.angle ?? 0;
                const incomingRot = regionRot;
                console.log(
                  `[SignatureRotationTrace] Stage:PDFEditor Block:${id} ` +
                  `incomingRotation:${incomingRot.toFixed ? incomingRot.toFixed(3) : incomingRot} ` +
                  `storedRotation:${incomingRot.toFixed ? incomingRot.toFixed(3) : incomingRot}`,
                );
                // ADR-006：写真实角度（此前硬编码 0，导致 Export 无签名旋转）。
                signatureRotationRef.current.set(id, incomingRot);
              }
            }
            // Sprint36.2（TD-002）：不再对 EditableBlock 写 block.transform。
            // 签名子块 rotation=0 已由 signatureRotationRef（旁路）承载；
            // document-renderer 的 mask rotation 优先取 rotationMap（signatureRotationRef），
            // 签名容器旋转由 signatureRegionMap / signatureTransformContexts（旁路）驱动。
            const sigRegionMap = new Map<string, { regionId: string; rotation: number }>();
            for (const rep of reconResult.replacements) {
              for (const block of rep.editableTextBlocks) {
                if (sigEditableBlockIds.has(block.id)) {
                  // Sprint34.25：印刷块（editableTextBlocks）保持水平（rotation=0）。
                  // 手写签名（suppressed）的倾斜由背景图 sigBgImages 单独处理（见下方 sigBgImages 构建）。
                  // 不再对印刷块应用图像检测 —— 否则会误伤水平印刷行（如 TABOAO）。
                  const blockRot = 0;
                  if (typeof console !== "undefined") {
                    const _b = block as any;
                    console.log(
                      `%c[Sprint34.26][BlockGeometry] text="${(_b.lines?.map?.((l: any) => l.glyphs.map((g: any) => g.char).join("")).join(" ") ?? "").substring(0, 40)}" ` +
                      `rotation=${blockRot.toFixed(3)} (source=printed/horizontal)`,
                      "color:#06b6d4;",
                    );
                  }
                }
              }
            }
            // Persist region map on window for debug / renderer
            if (typeof window !== "undefined") {
              (window as any).__signatureRegionMap = sigRegionMap;
            }

            // ── Sprint 33.5.6: Build per-block SignatureRenderRegion[] ──
            // KEY: Each block is its own rotation unit with origin at block.top-left.
            // This guarantees offsetX=0 / offsetY=0 → delta ≈ 0 after rotation.
            // Composite regions that span across physically separated blocks
            // (e.g. "Dr. Jefferson" at x=580 + "TABOAO" at x=37) would produce
            // large coordinate shifts if using a shared union-bbox origin.
            const sigRegions: import("../document-model/types").SignatureRenderRegion[] = [];
            // Sprint34.11: 从 editablePage.blocks 中按 regionType==="signature" 收集签名 block，
            // 从 signatureRotationRef 取 rotation，排除误归入的日期 block（如 "TABOAO"）。
            // 这样 Export 签名区与 Editor 渲染（layoutDocument 签名节点）一致，且不含日期。
            for (const block of editablePage.blocks) {
              if (block.regionType !== "signature") continue;
              const rot = signatureRotationRef.current.get(block.id) ?? 0;
              const text = block.lines.map((l: any) => l.glyphs.map((g: any) => g.char).join("")).join(" ");
              // Sprint34.12 Debug: 输出所有 signature editable block（含被过滤的 TABOAO），
              // 用于对比 Editor mask 与 Export mask 的 originalBounds / bbox / rotation。
              if (typeof console !== "undefined") {
                const ob = block.originalBounds as any;
                const bb = block.bbox as any;
                console.log(
                  `%c[Sprint34.12][SigEditable] id=${block.id} rot=${rot} ` +
                  `originalBounds=(x=${ob?.x?.toFixed?.(1)},y=${ob?.y?.toFixed?.(1)},w=${ob?.width?.toFixed?.(1)},h=${ob?.height?.toFixed?.(1)}) ` +
                  `bbox=(x=${bb?.x?.toFixed?.(1)},y=${bb?.y?.toFixed?.(1)},w=${bb?.width?.toFixed?.(1)},h=${bb?.height?.toFixed?.(1)}) ` +
                  `text="${text.substring(0, 40)}"`,
                  "color:#22d3ee;",
                );
              }
              if (Math.abs(rot) < 0.01) continue;
              if (!text.trim()) continue;
              // 防御性排除日期特征 block（TABOAO / 日期行），避免误导出
              if (/TABOAO|abril|de \d{1,2} de \d{4}|2026/.test(text)) continue;

              const fontSize = block.lines[0]?.style?.fontSize ?? 12;
              const fontFamily = block.lines[0]?.style?.fontFamily ?? "sans-serif";

              sigRegions.push({
                id: `sig_${block.id}`,
                type: "signature",
                bbox: { ...block.bbox },
                rotation: rot,
                coordinateSpace: "pdf",
                children: [{
                  text,
                  offsetX: 0, // origin = block's own top-left → offset is zero
                  offsetY: 0,
                  font: { family: fontFamily, size: fontSize },
                  sourceBlockId: block.id,
                }],
                sourceBlockIds: [block.id],
                pageIndex: pageNum - 1,
              });
            }

            if (sigRegions.length > 0) {
              const prev = signatureRegionsRef.current;
              // Remove old regions for this page, append new
              const filtered = prev.filter(r => r.pageIndex !== (pageNum - 1));
              signatureRegionsRef.current = [...filtered, ...sigRegions];
              console.log(
                `%c[Sprint 33.5.6] %cBuilt ${sigRegions.length} SignatureRegion(s) for page ${pageNum}`,
                "color:#f59e0b;font-weight:bold;", "color:#e2e8f0;",
              );
              // Sprint34.11 Debug: 输出 export 用签名 region 的 rotation + children 文本
              if (typeof console !== "undefined") {
                console.log(
                  `%c[Sprint34.11][SigRegions] count=${sigRegions.length} rotations=[${sigRegions.map((r) => (r as any).rotation).join(",")}]`,
                  "color:#0ea5e9;",
                );
                for (const r of sigRegions) {
                  const childrenText = ((r as any).children ?? [])
                    .map((c: any) => (c?.text ?? "").substring(0, 30))
                    .join(" | ");
                  console.log(
                    `  region ${(r as any).id} rot=${(r as any).rotation} bbox=(x=${Math.round((r as any).bbox?.x)},y=${Math.round((r as any).bbox?.y)}) children="${childrenText}"`,
                  );
                }
              }
            }
            // P0-004 Task 3：临时禁用 suppressed 注入，让 Editor 显示全部 OCR blocks
            if (!P0_DISABLE_SIGNATURE_SUPPRESSION) {
              for (const id of sigResult.suppressedGlyphBlockIds) {
                suppressedGlyphIdsRef.current.add(id);
              }
            }

            // ================================================================
            // Sprint 20.6 DEBUG — Checkpoint A+B: 单一窗口确认全链路数据
            // ================================================================
            const allDuplicateIds: string[] = [];
            for (const r of sigResult.regions) {
              for (const id of r.duplicateBlockIds) allDuplicateIds.push(id);
            }
            const suppressedArr = [...sigResult.suppressedGlyphBlockIds];

            (window as any).__signatureFinalDebug = {
              page: pageNum,
              // Checkpoint A: SignatureCompositeDetector 输出
              detectedDuplicateBlocks: allDuplicateIds,
              duplicateBlockDetail: sigResult.regions.map((r) => ({
                regionId: r.id,
                mode: r.mode,
                sourceBlockIds: r.sourceBlockIds,
                editableBlockIds: r.editableBlockIds,
                duplicateBlockIds: r.duplicateBlockIds,
              })),
              // Checkpoint B: suppressedGlyphIdsRef 内容
              suppressedBlockIds: suppressedArr,
              suppressedRefSize: suppressedGlyphIdsRef.current.size,
              // Checkpoint C: 由 glyphCommands useMemo 填充
              renderedGlyphBlocks: [] as string[],
              leakedBlocks: [] as string[],
              // 额外诊断
              allPageBlockIds: editablePage.blocks.map((b) => b.id),
              allPageBlockTexts: editablePage.blocks.map((b) => ({
                id: b.id,
                text: b.lines.map((l) => l.glyphs.map((g) => g.char).join("")).join(" ").substring(0, 80),
              })),
            };

            console.log(
              "%c[Sprint 20.6 FINAL DEBUG] %cCheckpoints A+B captured",
              "font-weight:bold;color:#ff6600;",
              "color:#333;",
              {
                detectedDuplicateBlocks: allDuplicateIds,
                suppressedBlockIds: suppressedArr,
                allPageBlockIds: (window as any).__signatureFinalDebug.allPageBlockIds,
                idMatchCheck: allDuplicateIds.every((did) => suppressedArr.includes(did))
                  ? "✓ ALL duplicate IDs present in suppressedBlockIds"
                  : "✗ SOME duplicate IDs MISSING from suppressedBlockIds!" + suppressedArr.length + " vs " + allDuplicateIds.length,
              },
            );

            // Sprint 20.5: 综合签名调试信息
            const glyphDebugRegions = sigResult.regions.map((r) => ({
              id: r.id,
              mode: r.mode,
              sourceBlocks: r.sourceBlockIds,
              editableBlocks: r.editableBlockIds.map((id) => {
                const b = editablePage.blocks.find((bb) => bb.id === id);
                const text = b ? b.lines.map(l => l.glyphs.map(g => g.char).join("")).join(" ") : "(missing)";
                return { id, text };
              }),
              suppressedBlocks: r.duplicateBlockIds.map((id) => {
                const b = editablePage.blocks.find((bb) => bb.id === id);
                const text = b ? b.lines.map(l => l.glyphs.map(g => g.char).join("")).join(" ") : "(missing)";
                return { id, text };
              }),
              rotation: r.rotation,
              confidence: r.confidence,
            }));

            const glyphDebug = {
              page: pageNum,
              regionCount: sigResult.regions.length,
              totalSourceBlocks: sigResult.regions.reduce((s, r) => s + r.sourceBlockIds.length, 0),
              totalEditableBlocks: sigResult.regions.reduce((s, r) => s + r.editableBlockIds.length, 0),
              totalSuppressedBlocks: sigResult.regions.reduce((s, r) => s + r.duplicateBlockIds.length, 0),
              suppressedGlyphBlockIds: [...sigResult.suppressedGlyphBlockIds],
              regions: glyphDebugRegions,
              // renderedBlocks 将在 rendering 阶段补充
              renderedBlocks: [] as string[],
              unexpectedRenderedBlocks: [] as string[],
            };
            (window as any).__signatureGlyphDebug = glyphDebug;
            (window as any).__signatureCompositeDebug = sigResult.debug;
            (window as any).__signatureReplacementDebug = reconResult.debug;

            // ── F3B-6.17 3B'-A.1：OCR page-level originYPt capture ──
            // 唯一来源 = pdf.js `page.view[1]`（PDF MediaBox y0），与 pdf-native import
            // （pdf-importer L193）同源。**不填 0**、**不从 Legacy EditableDocument 读**、
            // **不由 Core Layout 推导**；不可得时保持 `undefined`（由 export orchestration 走 Legacy fallback）。
            if (editablePage.originYPt === undefined) {
              try {
                const ocrPdfPage = await pdfDoc.getPage(editablePage.index);
                const y0 = (ocrPdfPage?.view as number[] | undefined)?.[1];
                if (y0 !== undefined) editablePage.originYPt = y0;
              } catch {
                // 保持 undefined（不伪造）
              }
            }
            pages.push(editablePage);
          }
          pages.sort((a, b) => a.index - b.index);

          // ── F3B-6.25-E1-OCR-Impl：OCR injection = **document generation replacement** ──
          //   它不是「在 Core-owned 文档上偷偷改 Legacy」（那会被 E1 的禁止分裂契约拦住），
          //   而是**整体换文档** ⇒ 必须先 canonical reset（丢弃旧 Core generation：
          //   session / document / snapshot / Sidecar / lineId 表 / ownership），
          //   再用 OCR 文档重建新 Core；ownership 复位为 **core**（不是 legacy —— 旧世代已废弃）。
          //   ⚠️ 与 re-import 共用 `resetCoreDocumentGeneration` ⇒ 不存在第二套 reset 顺序。
          resetCoreDocumentGeneration();
          // OCR 流程覆盖 editableDocumentRef（OCR 优先于 PDF 原生）
          editableDocumentRef.current = {
            pages,
            styles: docResolver.toArray(),
            metadata: {
              fileName,
              pageCount: pdfDoc.numPages,
              createdAt: Date.now(),
              renderScale: 1.5,
              cssScale: s,
            },
          };

          // Sprint 12: 设置 PDF 模式为 ScannedOCR + 更新 renderLayers
          setPdfMode("scannedOCR");
          (window as any).__pdfMode = "scannedOCR";
          (window as any).__renderLayers = ["imageLayer", "cleanBackgroundLayer", "glyphRendererLayer"];

          // ── Sprint 21: 全页 OCR 背景文字移除 ──
          // 对每个有 OCR block 的页面，生成 CleanBackgroundPatch[]，擦除原文文字
          try {
            const { removeAllBlockText } = await import("../document-model/background-text-remover");
            const allDebug: BackgroundRemovalDebug[] = [];

            for (const pageNum of blocksByPage.keys()) {
              // 渲染该页到 offscreen canvas（如果当前页正好是 canvas 所示页则复用）
              let pageCanvas: HTMLCanvasElement;
              if (pageNum === page) {
                pageCanvas = canvasRef.current!;
              } else {
                // 离屏渲染其他页
                const pdfPage = await pdfDoc.getPage(pageNum);
                const vp = pdfPage.getViewport({ scale: 1.5 });
                pageCanvas = document.createElement("canvas");
                pageCanvas.width = vp.width;
                pageCanvas.height = vp.height;
                const pgCtx = pageCanvas.getContext("2d")!;
                try {
                  await pdfPage.render({ canvasContext: pgCtx, viewport: vp }).promise;
                } catch {
                  console.warn(`[Sprint 21] Failed to render page ${pageNum} to offscreen canvas`);
                  continue;
                }
              }

              if (!pageCanvas) continue;

              const pageBlocks = editableDocumentRef.current!.pages.find((p) => p.index === pageNum)?.blocks ?? [];
              const { patches, debug } = removeAllBlockText(
                pageCanvas,
                pageBlocks,
                pageNum,
                cssScaleRef.current,
              );

              backgroundRemovalRef.current.set(pageNum, patches);
              allDebug.push(debug);
            }

            (window as any).__backgroundRemovalDebug = allDebug;
            console.log(
              "%c[Sprint 21] Background text removal complete",
              "font-weight:bold;color:#3366ff;",
              {
                pagesProcessed: allDebug.length,
                totalPatches: allDebug.reduce((s, d) => s + d.patchCount, 0),
                totalCoveragePct: allDebug.map((d) => d.coverage),
                perPage: allDebug.map((d) => ({
                  page: d.page,
                  blocks: d.totalBlocks,
                  patches: d.patchCount,
                  coverage: d.coverage + "%",
                })),
              },
            );
          } catch (err) {
            console.warn("[Sprint 21] Background text removal failed:", err);
          }

          // 暴露到 window 供控制台调试（Task 5）
          (window as any).__editableDocument = editableDocumentRef.current;
          // 控制台摘要输出（精简：仅保留 EditableDocument 摘要，避免大量日志导致崩溃）
          console.log(summarizeEditableDocument(editableDocumentRef.current));
          // console.log(summarizeBlockStyles(editableDocumentRef.current));
          // console.log(summarizeLayoutComparison(editableDocumentRef.current));
          // console.log(summarizeLayoutDiff(editableDocumentRef.current));

          // Sprint 12: 递增 version 触发 GlyphRenderer 渲染
          setEditableDocVersion(v => v + 1);

          // Sprint 9: AI Document Understanding — LLM 语义提取 + 文档类型检测
          try {
            // 先用规则分析（快速，无需网络）
            const ruleSemDoc = analyzeDocument(editableDocumentRef.current);
            (window as any).__semanticDocument = ruleSemDoc;

            // 文档类型检测
            const schema = detectDocumentType(ruleSemDoc);
            (window as any).__documentSchema = schema;
            console.log("[Sprint 9] Document type detected:", {
              type: schema.documentType,
              label: schema.typeLabel,
              confidence: schema.confidence,
              detectedBy: schema.detectedBy,
            });
            console.log("[Sprint 9] Rule-based semantic objects:", {
              objects: ruleSemDoc.objects.length,
              typeCounts: ruleSemDoc.metadata.typeCounts,
            });
            ruleSemDoc.objects.forEach((obj) => {
              console.log(
                `  [${obj.type}] "${obj.value}" (confidence: ${obj.confidence}, label: ${obj.label || "none"}, by: ${obj.detectedBy})`
              );
            });

            // 异步调用 LLM 提取（更精确，无需规则关键词）
            extractSemanticWithLLM(editableDocumentRef.current).then((llmSemDoc) => {
              (window as any).__semanticDocument = llmSemDoc;
              const llmSchema = detectDocumentType(llmSemDoc);
              (window as any).__documentSchema = llmSchema;
              console.log("[Sprint 9] LLM semantic extraction complete:", {
                objects: llmSemDoc.objects.length,
                typeCounts: llmSemDoc.metadata.typeCounts,
                documentType: llmSchema.documentType,
              });
              llmSemDoc.objects.forEach((obj) => {
                console.log(
                  `  [${obj.type}] "${obj.value}" (confidence: ${obj.confidence}, by: ${obj.detectedBy}, reason: ${obj.reason || "none"})`
                );
              });
            }).catch((e) => {
              console.warn("[Sprint 9] LLM semantic extraction failed:", e);
            });

            // 暴露 AI Action API 到 window
            (window as any).__replaceSemanticValue = (
              objectId: string,
              newValue: string
            ) => {
              if (!editableDocumentRef.current) return;
              const semDoc = (window as any).__semanticDocument;
              if (!semDoc) return;
              const result = replaceSemanticValue(semDoc, objectId, newValue);
              if (result.mutated) {
                editableDocumentRef.current = result.document;
                (window as any).__editableDocument = result.document;
                (window as any).__semanticDocument = result.semanticDocument;
                setEditableDocVersion((v) => v + 1);

                setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));

                console.log("[Sprint 9] Semantic mutation applied:", {
                  objectId,
                  newValue,
                  modifiedGlyphIds: result.glyphMutation.modifiedGlyphIds,
                });
              }
            };

            // Sprint 9 Task 5: 自然语言 AI Action API
            (window as any).__aiAction = (command: string) => {
              const semDoc = (window as any).__semanticDocument;
              if (!semDoc) {
                console.warn("[Sprint 9] No semantic document available");
                return;
              }
              const result = executeNaturalLanguage(semDoc, command);
              if (result.success && result.mutationCount > 0) {
                editableDocumentRef.current = result.document;
                (window as any).__editableDocument = result.document;
                (window as any).__semanticDocument = result.semanticDocument;
                setEditableDocVersion((v) => v + 1);

                setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));

                console.log("[Sprint 9] AI Action executed:", {
                  command,
                  mutationCount: result.mutationCount,
                  modifiedObjectIds: result.modifiedObjectIds,
                });
              } else {
                console.log("[Sprint 9] AI Action result:", result);
              }
            };

            // Sprint 10: Document Agent API（可规划）
            // __documentAgent.plan(command) — 生成计划（不执行）
            // __documentAgent.execute(plans) — 执行计划
            // __documentAgent.run(command) — 一步执行（plan + execute + verify）
            (window as any).__documentAgent = {
              /** 生成计划（不执行，等待确认） */
              plan: (command: string) => {
                const semDoc = (window as any).__semanticDocument;
                if (!semDoc || !editableDocumentRef.current) {
                  console.warn("[Sprint 10] No document available");
                  return null;
                }
                const response = planDocumentAction(
                  command,
                  editableDocumentRef.current,
                  semDoc
                );
                console.log("[Sprint 10] Document Agent plan:", response);
                return response;
              },

              /** 执行计划 */
              execute: (plans: any[]) => {
                const semDoc = (window as any).__semanticDocument;
                if (!semDoc) {
                  console.warn("[Sprint 10] No semantic document");
                  return null;
                }
                const result = executePlans(semDoc, plans);
                if (result.success) {
                  // 更新文档
                  editableDocumentRef.current = result.verification ? semDoc.document : semDoc.document;
                  // 重新分析获取最新 SemanticDocument
                  const newSemDoc = analyzeDocument(editableDocumentRef.current);
                  (window as any).__editableDocument = editableDocumentRef.current;
                  (window as any).__semanticDocument = newSemDoc;
                  setEditableDocVersion((v) => v + 1);

                  setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(editableDocumentRef.current)));

                  console.log("[Sprint 10] Plans executed:", result);
                  console.log("[Sprint 10] Verification:", result.verification);
                  console.log("[Sprint 10] Summary:", result.summary);
                }
                return result;
              },

              /** 一步执行（plan + execute + verify） */
              run: (command: string) => {
                const semDoc = (window as any).__semanticDocument;
                if (!semDoc || !editableDocumentRef.current) {
                  console.warn("[Sprint 10] No document available");
                  return null;
                }
                const { response, result } = executeDocumentAction(
                  command,
                  editableDocumentRef.current,
                  semDoc
                );

                console.log("[Sprint 10] Document Agent response:", response);
                if (result) {
                  // 更新文档
                  const newSemDoc = analyzeDocument(editableDocumentRef.current);
                  editableDocumentRef.current = newSemDoc.document;
                  (window as any).__editableDocument = newSemDoc.document;
                  (window as any).__semanticDocument = newSemDoc;
                  setEditableDocVersion((v) => v + 1);

                  setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(newSemDoc.document)));

                  console.log("[Sprint 10] Execution result:", result);
                  console.log("[Sprint 10] Summary:", result.summary);
                }
                return { response, result };
              },
            };

            // Sprint 11: AI Agent Planning & Tool Architecture
            // __agent.plan(command) — 生成多步骤计划
            // __agent.execute(plan) — 执行计划
            // __agent.run(command) — 一步执行
            // __agent.undo() — 撤销
            // __agent.history() — 查看历史
            (window as any).__agent = {
              /** 生成多步骤计划 */
              plan: (command: string) => {
                const semDoc = (window as any).__semanticDocument;
                if (!semDoc || !editableDocumentRef.current) return null;
                const planner = new AgentPlanner();
                const plan = planner.plan(command, editableDocumentRef.current, semDoc);
                console.log("[Sprint 11] Agent plan:", plan);
                return plan;
              },

              /** 执行计划 */
              execute: async (plan: any) => {
                const semDoc = (window as any).__semanticDocument;
                if (!semDoc || !editableDocumentRef.current) return null;
                const executor = new AgentExecutor();
                const result = await executor.execute(plan, editableDocumentRef.current, semDoc);
                if (result.success) {
                  editableDocumentRef.current = result.document;
                  (window as any).__editableDocument = result.document;
                  (window as any).__semanticDocument = result.semanticDocument;
                  setEditableDocVersion((v) => v + 1);
                  setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));
                  console.log("[Sprint 11] Agent execute result:", result);
                  console.log("[Sprint 11] Summary:", result.summary);
                  console.log("[Sprint 11] Verification:", result.verification);
                }
                return result;
              },

              /** 一步执行 */
              run: async (command: string) => {
                const semDoc = (window as any).__semanticDocument;
                if (!semDoc || !editableDocumentRef.current) return null;
                const { plan, result } = await runAgent(command, editableDocumentRef.current, semDoc);
                console.log("[Sprint 11] Agent plan:", plan);
                if (result) {
                  editableDocumentRef.current = result.document;
                  (window as any).__editableDocument = result.document;
                  (window as any).__semanticDocument = result.semanticDocument;
                  setEditableDocVersion((v) => v + 1);
                  setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));
                  console.log("[Sprint 11] Agent run result:", result);
                  console.log("[Sprint 11] Summary:", result.summary);
                } else if (plan.needsConfirmation) {
                  console.log("[Sprint 11] Plan needs confirmation. Call __agent.execute(plan) to proceed.");
                }
                return { plan, result };
              },

              /** 撤销 */
              undo: () => {
                const result = undoLastAction();
                if (result.success && result.document) {
                  editableDocumentRef.current = result.document;
                  (window as any).__editableDocument = result.document;
                  if (result.semanticDocument) {
                    (window as any).__semanticDocument = result.semanticDocument;
                  }
                  setEditableDocVersion((v) => v + 1);
                  setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));
                  console.log("[Sprint 11] Undo:", result.description);
                } else {
                  console.log("[Sprint 11] Undo failed:", result.description);
                }
                return result;
              },

              /** 查看历史 */
              history: () => {
                const hist = getExecutionHistory();
                const summary = hist.summarize();
                console.log("[Sprint 11] Execution history:", summary);
                return { entries: hist.getHistory(), summary, canUndo: hist.canUndo };
              },
            };
          } catch (e) {
            console.warn("[Sprint 9] AI document understanding failed:", e);
          }

          // Sprint 4：从 EditableDocument 通过 DocumentRenderer 生成 docBlocks
          let renderedBlocks = renderToBlocks(editableDocumentRef.current);
          if (renderedBlocks.length === 0) {
            // Fallback：DocumentRenderer 失败时用 TextBlock Adapter
            console.warn("[DocumentRenderer] renderToBlocks returned empty, falling back to TextBlock Adapter");
            renderedBlocks = convertToTextBlocks(editableDocumentRef.current);
          }
          if (renderedBlocks.length > 0) {
            // ★ B2-C-Implementation-1：只替换**本次 OCR 对应**的内容。
            //   旧实现按 page 全删（`prev.filter(b => !ocrPages.has(b.page))`）
            //   ⇒ 会误删同页用户 text / image / signature 及该页无关 projection。
            //   新判据 = id（本次 OCR materialization，与 projection 同 ocr.id）
            //          ∪ projection identity（本次 OCR 覆盖页的陈旧投影）。
            setDocBlocks((prev) =>
              replaceOcrProjection(prev, {
                ocrBlockIds: new Set(result.blocks.map((b: any) => b.id)),
                ocrPages: new Set(result.blocks.map((b: any) => b.page)),
                projected: renderedBlocks,
              })
            );
          }

          // Sprint 20.6: 发布综合渲染验证 debug
          try {
            const doc = editableDocumentRef.current;
            const allPageNums = result.blocks.map((b: any) => b.page).filter(
              (p: number, i: number, arr: number[]) => arr.indexOf(p) === i,
            );
            for (const pn of allPageNums) {
              const suppressedIds = signatureSuppression.getSuppressedBlockIds(pn);
              const suppressedArr = [...suppressedIds];
              const pageBlocks = renderedBlocks.filter((b: any) => b.page === pn);
              const domRenderedIds = pageBlocks.map((b: any) => b.source?.blockId || b.id || "").filter(Boolean);
              const unexpected = domRenderedIds.filter((id: string) => suppressedIds.has(id));

              publishSignatureRenderDebug(pn, {
                page: pn,
                suppressedBlockIds: suppressedArr,
                domRenderedBlocks: domRenderedIds,
                glyphRenderedBlocks: [], // 由 glyphCommands useMemo 填充
                unexpectedBlocks: unexpected,
              });
            }
          } catch (debugErr) {
            console.warn("[SignatureRenderDebug] build failed:", debugErr);
          }
        } catch (e) {
          console.warn("[EditableDocument] OCR build failed:", e);
        }

        // OCR blocks 注入后立即重新渲染缩略图（包含文本块）
        // 注意：thumbBlocks 使用 canvas-px 坐标（scale=1.5，未乘 cssScale），
        // renderThumbnails 内部通过 ratio = thumbScale/editorScale 转换到缩略图画布坐标
        if (pdfDoc) {
          const thumbBlocks = docBlocks.map(b => ({
            page: b.page,
            x: b.bbox.x, y: b.bbox.y, w: b.bbox.width, h: b.bbox.height,
            text: b.text || "",
            fontSize: b.style.fontSize,
            color: b.style.color,
            fontFamily: b.style.fontFamily,
          }));
          renderThumbnails(pdfDoc, thumbBlocks);
        }
      } catch (err) {
        console.error("[PDFEditor] OCR blocks injection failed:", err);
        // setShowOcrHint(true); // 已禁用引导弹框
      }
    };

    injectOcrBlocks();
    return () => { cancelled = true; };
  }, [pdfDoc, ocrTaskId]);

  // Drag + Resize（F3B-6.23-C-Impl-4：docBlocks 级几何拖拽**无 canonical undo**）
  // C0 裁决：page ops / drag / resize / add block 目前只有 docBlocks-level 变更，
  // 没有 EditableDocument/Core mutation 的 canonical equivalent ⇒ **明确保留为 no-undo**
  //（旧实现 push PatchBlocksCommand 到 CommandHistory 的路径已随 C-Impl-3 删除；
  //  不得为让测试绿而伪造 Core history entry —— 后续 MIGRATION_REQUIRED）。
  useEffect(() => {
    const move = (e: MouseEvent) => {
      // 关键：在事件触发时把 drag/resize 引用捕获到本地常量。
      // setDocBlocks 的 updater 在 React 后续渲染阶段才执行；若期间发生 mouseup
      // 把 dragRef.current 置 null，原代码读 dragRef.current!.id 会抛
      // "Cannot read properties of null (reading 'id')"（PDFEditor.tsx:7305 崩溃）。
      const drag = dragRef.current;
      const resize = resizeRef.current;
      if (drag) {
        const { id, ox0, ox, oy0, oy, generation } = drag;
        setDocBlocks((prev) =>
          guardedDocBlocksUpdate({ generation }, prev, (p) =>
            p.map((b) =>
              b && b.id === id
                ? { ...b, x: ox0 + e.clientX - ox, y: oy0 + e.clientY - oy }
                : b
            )
          )
        );
      }
      if (resize) {
        const { id, initW, startX, initH, startY, generation } = resize;
        setDocBlocks((prev) =>
          guardedDocBlocksUpdate({ generation }, prev, (p) =>
            p.map((b) =>
              b && b.id === id
                ? { ...b, w: Math.max(30, initW + e.clientX - startX), h: Math.max(30, initH + e.clientY - startY) }
                : b
            )
          )
        );
      }
    };
    const up = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (drag) {
        const { id, ox0, ox, oy0, oy } = drag;
        // 拖拽过程（pointermove × N）已把 docBlocks 镜像更新到最终位置；
        // 仅对 Core-owned 图片在 mouseup 提交**一次** MoveObjectCommand（绝不在每帧写 Core）。
        if (isCoreImageObject(id)) {
          const finalX = ox0 + e.clientX - ox;
          const finalY = oy0 + e.clientY - oy;
          moveImageFromCore(id, finalX, finalY);
        }
      }
      const resize = resizeRef.current;
      if (resize) {
        const { id, initW, startX, initH, startY } = resize;
        // 与 move 同口径：mousemove × N 只更新 docBlocks 镜像，mouseup 才提交**一次**
        // ResizeObjectCommand（绝不在每帧写 Core）。
        // 绝对几何：w/h 由拖拽基线重算（与 mousemove 的 Math.max(30, …) **同口径**，
        // 保证 docBlocks 镜像与 Core ImageObject 数值一致）；
        // x/y 不变（右下角 handle）⇒ 取自 Core ImageObject（Core 是真相源）。
        if (isCoreImageObject(id)) {
          const origin = coreImageOriginOf(id);
          if (origin) {
            resizeImageFromCore(
              id,
              origin.x,
              origin.y,
              Math.max(30, initW + e.clientX - startX),
              Math.max(30, initH + e.clientY - startY)
            );
          }
        }
      }
      dragRef.current = null;
      resizeRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 静默上传到 R2 备份（不阻塞现有流程）
    const R2_UPLOAD_URL = import.meta.env.VITE_R2_UPLOAD_URL || "https://pdfaide-r2.haung-dc.workers.dev/upload";
    fetch(R2_UPLOAD_URL, {
      method: "POST",
      headers: { "X-File-Name": encodeURIComponent(file.name) },
      body: file,
    }).catch(() => {});
    await loadPdfFromArrayBuffer(await file.arrayBuffer(), file.name);
  };

  /**
   * 从 ArrayBuffer 加载 PDF（Commit 4+：支持 ?file=URL 跨域加载）
   * 被 handleUpload（本地文件）和 loadFromUrl（远程 URL）共用。
   */
  const loadPdfFromArrayBuffer = async (buf: ArrayBuffer, name: string) => {
    setPdfLoading(true);
    setPdfError(null); // Issue-003: 重置错误态
    setFileName(name);
    setDocBlocks([]);
    setTextItems([]);
    // F3B-6.23-C-Impl-5：canonical history reset（取代旧 CommandHistory.clear()）
    resetCanonicalHistory();
    // M7.8-020-PROD：同时清空跨页 segment 编辑缓存，避免把上一份 PDF 的编辑带到新文档
    clearSegmentEdits();

    // M7.7-012B: 新文档加载时清理所有编辑态/渲染态，避免残留上一份 PDF 的内容。
    setEditedLineBoxes(new Map());
    setEditedLines(new Set());
    setEditingBlockId(null);
    dispatchSession(null);
    setTextEdit(null);
    setEditLineBox(null);
    setCurrentSelection(null);
    setSelectedText(null);
    setPendingEdit(null);
    glyphCommandsRef.current = undefined;
    // EDITOR-CORE-012-F3B-1.1：re-import 边界。释放旧 Core 输入 session，并把 Core document 置空，
    // 同时向 lifecycle 发出「新 PDF 加载」信号——后续 doc 重建并 bump version 时，import boundary effect
    // 会允许创建**新的** Core document（Core B），旧 Core A 与旧 session A 一并失效（Invariant 3）。
    // F3B-6.25-E1-OCR-Impl：generation 复位统一走 **canonical 唯一实现**
    // （re-import 与 OCR injection 共用 ⇒ 不可能出现第二套 reset 顺序）。
    // 原内联序列详见 `resetCoreDocumentGeneration`。
    resetCoreDocumentGeneration();

    // Sprint 31.1: 重置所有 OCR 注入相关状态（重新上传时关键）
    ocrBlocksInjectedRef.current = false;
    import("../ocr/auto-ocr-service").then(({ resetAutoOcr }) => resetAutoOcr()); // Story-W1 重置
    setOcrTaskId(null);
    signatureReplacementsRef.current = new Map();
    signatureRegionInfoRef.current = new Map();
    suppressedGlyphIdsRef.current = new Set();
    signatureRotationRef.current = new Map();
    setPdfMode("unknown");
    (window as any).__pdfMode = "unknown";

    pdfBytesRef.current = buf;
    try {
      // Issue-003 (P0, Release QA): 坏 PDF / 解析失败时，2s 内给 Error，不再无限 Loading。
      pdfLibDocRef.current = await PDFDocument.load(buf.slice(0), { ignoreEncryption: true });
      // M7.7-IMPLEMENT-004(a)：从已加载的 pdf-lib doc 解析每页字体度量（失败不阻断，Native 路径回退）。
      try {
        pageFontMetricsRef.current = parsePdfFontMetrics(pdfLibDocRef.current);
      } catch (e) {
        // console.warn("[M7.7-IMPLEMENT-004] parsePdfFontMetrics failed:", e);
        pageFontMetricsRef.current = null;
      }
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(0), cMapUrl: "/cmaps/", cMapPacked: true, standardFontDataUrl: "/standard_fonts/" }).promise;
      setPdfDoc(pdf);
      // 调试钩子：暴露 pdf.js 文档代理，供 M7.8-017A 等控制台探针读取 commonObjs（纯可观测性，不改逻辑）
      (window as any).__pdfDoc = pdf;
      setTotalPages(pdf.numPages);
      setPage(1);
      renderThumbnails(pdf);
      setPdfLoading(false);
    } catch (err) {
      console.error("[Issue-003] PDF 加载失败:", err);
      setPdfLoading(false);
      setPdfError(`无法打开该 PDF：${err instanceof Error ? err.message : "文件无效或已损坏"}。请上传一个有效的 PDF 文件。`);
      return;
    }
    if (workspaceMode) setShowIntentModal(true);
    // OCR 流程：跳过 PostLoadModal，改由 OCR blocks 注入完成后显示"Click any text to edit"引导
    const savedOcrTaskId = sessionStorage.getItem("pdfaide_ocr_task_id");
    if (savedOcrTaskId) {
      setOcrTaskId(savedOcrTaskId);
      sessionStorage.removeItem("pdfaide_ocr_task_id");
      // ocrBlocksInjectedRef 已在 loadPdfFromArrayBuffer 顶部重置
    } else {
      // Commit 4+: 加载完成后显示引导弹框
      // RQ-003（Release QA）：开发环境下不显示 Paywall/PostLoadModal，
      // 避免首次用户 UAT 时被 Paywall 遮挡 PDF 首帧视觉确认。
      // import.meta.env.DEV 在生产构建为 false（tree-shake 掉此分支）。
      if (!import.meta.env.DEV) {
        setShowPostLoadModal(true);
      }
    }
  };

  // V12: 从 sessionStorage / IndexedDB 读取首页上传的 PDF
  useEffect(() => {
    (async () => {
      // ── 跨站入口：www.pdfsail.com/edit-pdf 上传后跳转过来 ──
      // 支持 ?file=<绝对URL>、?r2=<R2 key 或 token>、?fileKey=<token>，可选 ?name=<文件名>
      try {
        const ingressFlag = "__pdfsailUrlIngress";
        const params = new URLSearchParams(window.location.search);
        const fileParam = params.get("file");
        const r2Param = params.get("r2") || params.get("fileKey");
        if ((fileParam || r2Param) && !(window as any)[ingressFlag]) {
          (window as any)[ingressFlag] = true;
          const nameParam = params.get("name") || "document.pdf";
          const srcUrl =
            fileParam ||
            `https://www.pdfsail.com/api/r2-file?key=${encodeURIComponent(
              r2Param!.indexOf("/") >= 0 ? r2Param! : `editor/results/${r2Param}.pdf`
            )}`;
          const resp = await fetch(srcUrl, { mode: "cors" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const buf = await resp.arrayBuffer();
          await loadPdfFromArrayBuffer(buf, nameParam);
          // 加载成功后清掉 URL 参数，避免刷新时重复拉取
          ["file", "r2", "fileKey", "name"].forEach((k) => params.delete(k));
          const qs = params.toString();
          window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
          return;
        }
      } catch (err) {
        console.error("[ingress] Failed to load PDF from URL:", err);
        (window as any).__pdfsailUrlIngress = false;
      }

      const SESSION_PDF_KEY = "pdfaide_pending_pdf";
      const raw = sessionStorage.getItem(SESSION_PDF_KEY);
      if (!raw) return;
      sessionStorage.removeItem(SESSION_PDF_KEY);
      try {
        const meta = JSON.parse(raw);
        if (meta.useIndexedDB) {
          // 大文件走 IndexedDB
          const { getPendingPdf, clearPendingPdf } = await import("../lib/indexedDB");
          const rec = await getPendingPdf();
          if (rec) {
            const buf = await rec.blob.arrayBuffer();
            await loadPdfFromArrayBuffer(buf, meta.name || rec.fileName || "document.pdf");
            await clearPendingPdf();
          }
        } else if (meta.data) {
          // 小文件：base64 → ArrayBuffer
          const binStr = atob(meta.data);
          const buf = new ArrayBuffer(binStr.length);
          const view = new Uint8Array(buf);
          for (let i = 0; i < binStr.length; i++) view[i] = binStr.charCodeAt(i);
          await loadPdfFromArrayBuffer(buf, meta.name || "document.pdf");
        }
      } catch (err) {
        console.error("Failed to load PDF from session:", err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // renderThumbnails migrated to useDocument (Commit 1 / Step 6)
  // OCR / PageOps / Export / Payment / InlineTools migrated to features/ (Commit 3)

  const updateSelectedFormat = (patch: Partial<{ fontFamily: string; fontSize: number; color: string }>) => {
    // 更新选中的 block（浏览模式）
    if (selectedBlockId) {
      setBlocks((prev) => prev.map((b) => b.id === selectedBlockId && b.type === "text" ? { ...b, ...patch } as TextBlock : b));
    }
    // 更新当前编辑的 segment（edit 模式）
    if (editingSegmentId) {
      setSegments((prev) => prev.map((s) => {
        if (s.id !== editingSegmentId) return s;
        const newFont = { ...s.font };
        if (patch.fontFamily !== undefined) newFont.family = patch.fontFamily;
        if (patch.fontSize !== undefined) newFont.size = patch.fontSize;
        if (patch.color !== undefined) newFont.color = patch.color;
        return { ...s, font: newFont };
      }));
      // 同步到对应的 docBlock
      const blockId = segBlockId(editingSegmentId);
      setBlocks((prev) => prev.map((b) =>
        b.id === blockId ? { ...b, ...patch } as TextBlock : b
      ));
      // 即时更新 DOM 样式
      const elem = document.querySelector(`[data-segment-id="${editingSegmentId}"]`) as HTMLElement | null;
      if (elem) {
        if (patch.fontFamily !== undefined) elem.style.fontFamily = patch.fontFamily;
        if (patch.fontSize !== undefined) elem.style.fontSize = `${patch.fontSize}px`;
        if (patch.color !== undefined) elem.style.color = patch.color;
      }
    }
  };

  const addBlock = (type: Block["type"], extra: any = {}) => {
    setBlocks((prev) => [...prev, { id: uuid(), type, page, x: 100, y: 100, w: 100, h: 30, ...extra } as Block]);
  };

  const imageInputRef = useRef<HTMLInputElement>(null);

  /**
   * B3-C-5-E-B-B：Add Image → Core 的**唯一** producer 入口。
   * 字节 → ImageAsset（注册进 registry）→ 几何 → AddBlockCommand → Core History。
   * 不写 docBlocks ImageBlock；无 Core 文档（fail-closed）时直接返回（Add Image 不可用，不偷偷双写 docBlocks）。
   */
  const addImageFromBytes = useCallback(
    (bytes: Uint8Array, mime: string, opts: { x?: number; y?: number } = {}) => {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return; // Core OFF / 未初始化：Add Image unavailable
      const assetId = `asset://${uuid()}`;
      imageAssetRegistry.register({ id: assetId, bytes, mime });
      const geom = computeImageBlockGeometry(bytes, mime);
      let session = coreInputSessionRef.current;
      if (!session) {
        const created = createCoreInputSessionFromDocument(coreDoc);
        if (!created.ok || !created.session) return;
        session = created.session;
        coreInputSessionRef.current = session;
      }
      commitImageToCore(session, {
        assetRef: assetId,
        pageIndex: page,
        x: opts.x ?? 100,
        y: opts.y ?? 100,
        width: geom.width,
        height: geom.height,
      });
      coreDocumentRef.current = documentOf(session);
      coreLifecycleRef.current?.markOwned();
      exportOwnershipRef.current = "core";
      // B3-C-3：登记 undo/redo ownership（与文本 Core mutation 同一语义，见 compositionend 站点）。
      // 缺此行 ⇒ lastMutationOwner 恒为 null ⇒ decideUndoRedoRoute 回退 "legacy"
      // ⇒ Ctrl+Z/Y 走空的 Legacy OperationHistory ⇒ 图片 Add/Delete/Move 撤销不了。
      markMutationOwner("core");
      noteCoreSessionChange("core-mutation");
      setAddingType(null);
    },
    [page, markMutationOwner]
  );

  /**
   * STEP-2c-C1：Manual OCR（W3/W4 raw `TextBlock[]`）→ Core EditorDocument。
   *
   * 严格镜像 `addImageFromBytes` 的 ownership seam，并在其后补一步 OCR 专属投影
   * （Core 2b 产物 `ImportBoxDraft` → `markAsProjection` → `replaceOcrProjection` → docBlocks）。
   *
   * ★ 返回值即“是否认领”，用于消除 duplicate（C1 验收项「无重复 OCR block」）：
   *   本函数返回 `true` ⇒ `useOCR` **跳过**旧 `setBlocks`，docBlocks 中只有本次 `ocr_<hash>` 投影；
   *   返回 `false` ⇒ 回落到旧 `setBlocks`（随机 uuid 块）。两条路径**互斥**，不会同时产出。
   *
   * 旧 `setBlocks` 路径在 C1 **保留但仅作 rollback**（不删除）：Core 不可用 / 归一化为空 /
   * commit 抛错时才生效，保证 OCR 不丢失。C2 再统一移除旧路径。
   *
   * 契约（与 image 同）：Core 不可用（coreDocumentRef 为 null / session 不可建）→ 早退 fail-closed，
   * 且**不**改动 ownership / exportOwnership / history，交回旧 setBlocks 承载。
   */
  const commitOcrBlocksToCore = useCallback(
    (blocks: TextBlock[]): boolean => {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return false; // Core OFF / 未初始化：OCR 仍由旧 setBlocks 路径承载
      if (blocks.length === 0) return false;

      const canvas = canvasRef.current;
      const cssScale = cssScaleRef.current ?? 1;
      const canvasW = canvas ? canvas.width * cssScale : 1;
      const canvasH = canvas ? canvas.height * cssScale : 1;

      // 2a normalize：TextBlock → OcrImportRawBlock（额外字段 id/type 由 binding 忽略）
      const raw: OcrImportRawBlock[] = blocks.map((b) => ({
        text: b.text,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        fontSize: b.fontSize ?? 12,
        page: b.page,
      }));
      const draft = normalizeOcrImportDraft(raw, { width: canvasW, height: canvasH });
      if (draft.items.length === 0) return false; // 归一化后为空 ⇒ 不认领（C1 不引入副作用）

      let session = coreInputSessionRef.current;
      if (!session) {
        const created = createCoreInputSessionFromDocument(coreDoc);
        if (!created.ok || !created.session) return false;
        session = created.session;
        coreInputSessionRef.current = session;
      }

      // 2c-B：单次 AddOcrTextBlocksCommand commit（无论 1 个还是多个 block 都并为一个 transaction）
      // commit 失败 ⇒ 不认领，交回旧 setBlocks 路径（rollback），绝不半途改 ownership。
      try {
        commitOcrDraftToCore(session, draft);
      } catch (e) {
        console.warn("[STEP-2c-C1][OCR_CORE_FALLBACK]", { reason: String(e) });
        return false;
      }
      coreDocumentRef.current = documentOf(session);
      coreLifecycleRef.current?.markOwned();
      exportOwnershipRef.current = "core";
      markMutationOwner("core");
      noteCoreSessionChange("core-mutation");

      // OCR 专属投影：只把本次 Core OCR 对象投影到 docBlocks（与 import 期 OCR materialization 同形态）。
      // 此时旧 `useOCR` setBlocks 已被调用方跳过（本函数返回 true），故不存在随机 uuid 重复块。
      // ★ 投影机制：normalizedOcrDraftToEditorDocument 产出的是 Core EditorDocument（page.objects），
      //   而 renderToBlocks 只消费 legacy EditableDocument（page.blocks）—— 直接传 Core doc 会抛
      //   "doc.pages / page.blocks is not iterable"。故此处由 normalizedOcrDraftToCoreObjects 的
      //   ImportBoxDraft（与 materializeImport 进入 Core 的同一几何/文本）直接构造 Block，
      //   经 markAsProjection 标记 __coreProjection，交 replaceOcrProjection 合入 docBlocks。
      const ocrObjects = normalizedOcrDraftToCoreObjects(draft);

      // ── STEP-2c-C2-A-Impl：注册 OCR detection bounds（Core export mask 的第二来源）──
      // 几何**只**来自 commit-time draft（normalizedOcrDraftToCoreObjects），
      // 绝不从 Core TextBox 的当前 bbox 反读 —— 后者会随后续编辑漂移 ⇒ mask 错位 ⇒ 重影。
      // 用途唯一：导出时白色 mask 掉该区域的原始扫描墨迹（避免 ghost/overlap）。
      ocrExportBoundsRegistry.register(
        ocrObjects.pages.flatMap((ocrPage) =>
          ocrPage.boxes.flatMap((box) => {
            const blockId = box.source?.blockId;
            if (!blockId) return [];
            return [
              {
                blockId,
                bbox: { x: box.x, y: box.y, width: box.width, height: box.height },
                pageIndex: ocrPage.index,
              },
            ];
          })
        )
      );

      const projected: Block[] = [];
      for (const ocrPage of ocrObjects.pages) {
        for (const box of ocrPage.boxes) {
          // ImportBoxDraft.source 在类型层 optional（builder 恒写），防御性 fail-safe：缺失则跳过该 box
          const blockId = box.source?.blockId;
          if (!blockId) continue;
          const text = box.paragraphs[0]?.runs[0]?.text ?? "";
          projected.push(
            markAsProjection({
              id: blockId,
              type: "text",
              page: ocrPage.index,
              x: box.x,
              y: box.y,
              w: box.width,
              h: box.height,
              text,
              source: box.source,
            } as TextBlock)
          );
        }
      }
      setDocBlocks((prev) =>
        replaceOcrProjection(prev, {
          ocrBlockIds: new Set(draft.items.map((it) => it.id)),
          ocrPages: new Set(draft.items.map((it) => it.page)),
          projected,
        })
      );
      // 认领成功：调用方（useOCR）据此跳过旧 setBlocks ⇒ docBlocks 中不存在随机 uuid 重复块。
      return true;
    },
    [markMutationOwner, noteCoreSessionChange]
  );
  // STEP-2c-C1：让 useOCR（上方）与 window hook 经 ref 转发时拿到最新实现。
  commitOcrBlocksToCoreRef.current = commitOcrBlocksToCore;

  /**
   * B3-C-5-E-B-H-Impl：判断给定 block id 是否对应 Core EditorDocument 中的 ImageObject。
   * 只有 Core-owned 图片才走 DeleteObjectCommand；其余（docBlocks 直写图片）走 setBlocks filter。
   */
  const isCoreImageObject = useCallback((imageId: string): boolean => {
    const coreDoc = coreDocumentRef.current;
    if (!coreDoc) return false;
    for (const page of coreDoc.pages) {
      const oi = page.objects.findIndex((o) => o.id === imageId);
      if (oi >= 0) return page.objects[oi].type === "image";
    }
    return false;
  }, []);

  /**
   * B3-C-5-E-B-H-Impl：Core-owned 图片删除。
   * 顺序严格按 Add Image ownership 模式：commit → 同步 coreDocumentRef → markOwned → exportOwnership=core
   * → noteCoreSessionChange("core-mutation")（内部 setCoreInputTick 触发 Core 重渲染 + 下方 sync effect）。
   * 绝对不调用 imageAssetRegistry.remove/clear（资源按 Reference 复用，删除对象不影响资产解析）。
   */
  const deleteImageFromCore = useCallback(
    (imageId: string) => {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return; // fail-closed：无 Core 文档不删除
      let session = coreInputSessionRef.current;
      if (!session) {
        const created = createCoreInputSessionFromDocument(coreDoc);
        if (!created.ok || !created.session) return;
        session = created.session;
        coreInputSessionRef.current = session;
      }
      let changed = true;
      try {
        changed = session.history.commit(new DeleteObjectCommand({ objectId: imageId })).changed !== false;
      } catch {
        // missing-object 等：不影响 docBlocks，不抛到 UI
        return;
      }
      coreDocumentRef.current = documentOf(session);
      coreLifecycleRef.current?.markOwned();
      exportOwnershipRef.current = "core";
      if (changed) markMutationOwner("core");
      noteCoreSessionChange("core-mutation");
    },
    [markMutationOwner]
  );

  /**
   * B3-C-3 Move Image：Core-owned 图片移动。
   * 复用既有 `MoveObjectCommand`（绝对坐标，UI 从拖拽基线重算绝对值，Command 不记 delta），
   * 仅在 drag mouseup 提交**一次**，绝不在 pointermove 连续提交（interaction ≠ semantic mutation）。
   * 与 deleteImageFromCore 同一 ownership 模式：commit → 同步 coreDocumentRef → markOwned
   * → exportOwnership=core → noteCoreSessionChange("core-mutation")（内部 setCoreInputTick 触发 Core 重渲染 + sync effect）。
   * 拖拽过程只更新 docBlocks 镜像（见下方 drag/resize useEffect）；只有 mouseup 落一次 Core Command。
   */
  const moveImageFromCore = useCallback(
    (imageId: string, x: number, y: number) => {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return; // fail-closed：无 Core 文档不移动
      let session = coreInputSessionRef.current;
      if (!session) {
        const created = createCoreInputSessionFromDocument(coreDoc);
        if (!created.ok || !created.session) return;
        session = created.session;
        coreInputSessionRef.current = session;
      }
      let changed = true;
      try {
        changed = session.history.commit(new MoveObjectCommand({ objectId: imageId, x, y })).changed !== false;
      } catch {
        // missing-object 等：不影响 docBlocks，不抛到 UI
        return;
      }
      coreDocumentRef.current = documentOf(session);
      coreLifecycleRef.current?.markOwned();
      exportOwnershipRef.current = "core";
      // ★ §5 no-op（坐标完全相同 ⇒ 不入栈）时**不得**夺走 undo 归属，
      //   否则「点击图片未拖动」会把 owner 改成 core，令更早的 Legacy 编辑撤不掉
      //   （与 3C-10C.3B-0 文本站点 `if (changed) markMutationOwner("core")` 同口径）。
      if (changed) markMutationOwner("core");
      noteCoreSessionChange("core-mutation");
    },
    [markMutationOwner]
  );

  /**
   * B3-C-4 Resize Image：Core-owned 图片缩放。
   * 复用既有 `ResizeObjectCommand`（**绝对几何**：x/y/width/height 一次给全；
   * rotation / transform / assetRef 由 Command 的 spread 原样保留，本函数绝不写它们）。
   * 严格沿用 C-3 Move 的边界：
   *   · mousemove × N 只更新 docBlocks 镜像（**绝不**每帧提交 Command）
   *   · mouseup 提交**一次** ResizeObjectCommand（interaction ≠ semantic mutation）
   *   · no-op（几何完全相同 ⇒ ResizeObjectCommand §5 返回同一引用 ⇒ changed=false）
   *     不抢 ownership、不产生 history entry
   * ownership 模式与 move/delete 完全一致：commit → 同步 coreDocumentRef → markOwned
   * → exportOwnership=core → （changed 才）markMutationOwner("core") → noteCoreSessionChange。
   */
  const resizeImageFromCore = useCallback(
    (imageId: string, x: number, y: number, width: number, height: number) => {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return; // fail-closed：无 Core 文档不缩放
      let session = coreInputSessionRef.current;
      if (!session) {
        const created = createCoreInputSessionFromDocument(coreDoc);
        if (!created.ok || !created.session) return;
        session = created.session;
        coreInputSessionRef.current = session;
      }
      let changed = true;
      try {
        changed =
          session.history.commit(
            new ResizeObjectCommand({ objectId: imageId, x, y, width, height })
          ).changed !== false;
      } catch {
        // invalid-geometry / missing-object 等：不影响 docBlocks，不抛到 UI
        return;
      }
      coreDocumentRef.current = documentOf(session);
      coreLifecycleRef.current?.markOwned();
      exportOwnershipRef.current = "core";
      // ★ §5 no-op（几何完全相同 ⇒ 不入栈）时**不得**夺走 undo 归属（同 moveImageFromCore）
      if (changed) markMutationOwner("core");
      noteCoreSessionChange("core-mutation");
    },
    [markMutationOwner]
  );

  /**
   * B3-C-4：读取 Core ImageObject 的当前 x/y。
   * resize handle 在右下角 ⇒ 缩放**不改变原点**；x/y 必须以 Core 文档为准（Core 是真相源，
   * 这里的 window 级 mouseup handler 处于 deps=[] 的 effect 中，读不到最新 docBlocks）。
   */
  const coreImageOriginOf = useCallback((imageId: string): { x: number; y: number } | null => {
    const coreDoc = coreDocumentRef.current;
    if (!coreDoc) return null;
    for (const pg of coreDoc.pages) {
      const obj = pg.objects.find((o) => o.id === imageId);
      if (obj) return obj.type === "image" ? { x: obj.x, y: obj.y } : null;
    }
    return null;
  }, []);

  /**
   * B3-C-5-E-B-H-Impl：图片删除统一入口。
   * Core-owned → DeleteObjectCommand；否则 → docBlocks filter。两条路径互斥，绝不双写。
   */
  const deleteImage = useCallback(
    (imageId: string) => {
      if (isCoreImageObject(imageId)) {
        deleteImageFromCore(imageId);
      } else {
        setBlocks((prev) => prev.filter((x) => x.id !== imageId));
      }
    },
    [isCoreImageObject, deleteImageFromCore]
  );

  /**
   * B3-C-5-E-B-H-Impl：把 Core EditorDocument 中的图片对象镜像成 docBlocks 透明命中区（无 src → 不绘 <img>），
   * 使 Core-owned 图片可经 PDFCanvas 双击删除。绝不动 imageAssetRegistry；只增删 docBlocks 中的同步块。
   * 仅管理「曾经由本函数同步过的 id」（syncedImageBlockIdsRef），不触碰 legacy docBlocks 图片块。
   */
  const syncedImageBlockIdsRef = useRef<Set<string>>(new Set());
  const syncImageBlocksFromCore = useCallback(() => {
    const coreDoc = coreDocumentRef.current;
    const coreImages: Array<{ id: string; page: number; x: number; y: number; width: number; height: number }> = [];
    if (coreDoc) {
      for (const page of coreDoc.pages) {
        for (const obj of page.objects) {
          if (obj.type === "image") {
            coreImages.push({ id: obj.id, page: page.index, x: obj.x, y: obj.y, width: obj.width, height: obj.height });
          }
        }
      }
    }
    const coreIds = new Set(coreImages.map((i) => i.id));
    setBlocks((prev) => {
      const synced = syncedImageBlockIdsRef.current;
      const next: Block[] = [];
      for (const b of prev) {
        if (b.type === "image" && synced.has(b.id) && !coreIds.has(b.id)) {
          continue; // 删除已不在 Core 文档中的同步命中区
        }
        if (b.type === "image" && synced.has(b.id) && coreIds.has(b.id)) {
          const img = coreImages.find((i) => i.id === b.id)!;
          next.push({ ...b, x: img.x, y: img.y, w: img.width, h: img.height }); // 同步几何（移动/缩放后对齐）
          continue;
        }
        next.push(b); // 保留文本块 / legacy 图片块等
      }
      const presentSynced = new Set(
        next.filter((b) => b.type === "image" && coreIds.has(b.id)).map((b) => b.id)
      );
      for (const img of coreImages) {
        if (!presentSynced.has(img.id)) {
          // 透明命中区：type=image 但 src 为空（falsy）→ PDFCanvas 不绘 <img>，背景已由 CSS 透明
          next.push({ id: img.id, type: "image", page: img.page, x: img.x, y: img.y, w: img.width, h: img.height, src: "" } as ImageBlock);
        }
      }
      syncedImageBlockIdsRef.current = coreIds;
      return next;
    });
  }, [setBlocks]);

  useEffect(() => {
    syncImageBlocksFromCore();
  }, [coreInputTick, syncImageBlocksFromCore]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        addImageFromBytes(new Uint8Array(result), file.type || "image/png");
      }
    };
    reader.readAsArrayBuffer(file);
    e.target.value = "";
  };

  // resize drag state moved up (Commit 4: TDZ fix)

  const pageBlocks = docBlocks.filter((b) => b.page === page);

  // generateLocalHints + origUpload migrated to useWorkspaceState (Commit 1 / Step 2)

  /**
   * Bug 15: 退出 Edit 模式并提交当前编辑的文本。
   * 通过 blur 当前 contentEditable 元素触发 handleBlur，从而调用 onChange 提交文本。
   */
  const exitEditMode = useCallback(() => {
    // 如果有正在编辑的 segment，先 blur 其 DOM 元素以触发 handleBlur 提交文本
    if (editingSegmentId) {
      const elem = document.querySelector(`[data-segment-id="${editingSegmentId}"]`) as HTMLElement | null;
      if (elem && document.activeElement === elem) {
        elem.blur();
      }
    }
    setEditingSegmentId(null);
    setShowTextLayer(false);
  }, [editingSegmentId, setEditingSegmentId, setShowTextLayer]);

  /**
   * Bug 5: convert 下拉菜单点击处理（V12 移植适配：先转换后付费，保留本项目 paywall 链路）
   * - compress：打开压缩质量选项弹窗（用户选择后经 processInline 本地转换）
   * - word/excel/jpg：先经 handleExportWithCommit 导出含字形级编辑的最终 PDF，
   *   本地完成转换 → 完成弹窗 → 用户点击下载时 uploadToR2AndRedirect
   *   上传 R2 → 跳 www.pdfsail.com/[locale]/ready → /paywall
   */
  const onConvertClick = useCallback(async (tool: string) => {
    if (tool === "compress") {
      setShowCompressOptions(true);
      return;
    }
    await processInline(tool);
  }, [processInline, setShowCompressOptions]);

  /**
   * Bug 9 + 16: 根据当前状态推导编辑器模式，显示在顶部 header。
   */
  const currentModeInfo = (() => {
    if (!pdfDoc) return null;
    if (showTextLayer) return { label: t("mode.edit"), color: "#3b82f6", bg: "#eff6ff" };
    if (showFindReplace) return { label: "🔍 Find Mode", color: "#0ea5e9", bg: "#f0f9ff" };
    if (addingType === "highlight") return { label: "🟡 Highlight", color: "#ca8a04", bg: "#fefce8" };
    if (addingType === "redact") return { label: "⬛ Redact", color: "#1e293b", bg: "#f1f5f9" };
    if (addingType === "annotate") return { label: "📌 Annotate", color: "#3b82f6", bg: "#eff6ff" };
    if (addingType === "ocr") return { label: "🎯 OCR Region", color: "#8b5cf6", bg: "#f5f3ff" };
    return { label: t("mode.browse"), color: "#64748b", bg: "#f8fafc" };
  })();

  // ── Sprint 23: Render Tree Diagnostic ──
  // [Sprint23] Rendering Tree - 已禁用

  // ── Task-011B/011C: Composition Root（EditTool 装配，Strangler 双路径）──
  // 011B 建立依赖（Toolbar → EditTool → Registry/Provider）。保留 Legacy applyReplace 等路径。
  // 011C 装配 Runtime + 注册 ReplaceCommand：
  //   EditorRuntime 把 PDFEditor 已有的 editableDocumentRef + setEditableDocVersion + setDocBlocks
  //   作为运行时注入 ReplaceCommand；registry.register("replace", cmd) 后，
  //   Toolbar 的 editTool.execute({capability:"replace"}) 新路径真实生效。
  // 不修改任何 Contract：EditTool / Registry / CapabilityCommand / CurrentSelection 全部不变。
  const editTool = useMemo(() => {
    const registry = new MapCapabilityRegistry();

    const runtime = new EditorRuntime({
      getDocument: () => editableDocumentRef.current,
      applyDocument: (result) => {
        if (!result.mutated) return;
        editableDocumentRef.current = result.document;
        (window as any).__editableDocument = result.document;
        setEditableDocVersion((v) => v + 1);
        setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));
      },
    });

    // F3B-6.17-3C-10A → E4：replace / rewrite / translate 三者共用同一 Core-aware 执行器；
    // delete / fixOcr 仍是纯 Legacy（无 Core 等价语义）。
    // 既有 ReplaceCommand / RewriteCommand / TranslateCommand 作为 Legacy fallback 注入（不修改其行为）；
    // 能力名经 deps.capability 透传，仅用于意图标记，不改变 Core 命令构造。
    const capabilityReplaceCoreDeps: Omit<
      CapabilityReplaceCommandDeps,
      "legacy" | "capability" | "readOwned"
    > = {
      readFlag: () => (window as unknown as Record<string, unknown>).__replaceMode === "new",
      getCore: () => {
        // 与 Segment 迁移同形态：无 session 时由当前 Core document 建立
        let session = coreInputSessionRef.current;
        if (!session) {
          const coreDoc = coreDocumentRef.current;
          if (!coreDoc) return null;
          const created = createCoreInputSessionFromDocument(coreDoc);
          if (!created || !created.ok || !created.session) return null;
          session = created.session;
          coreInputSessionRef.current = session;
        }
        return { document: documentOf(session), session };
      },
      getGlyphs: (blockId, lineId) => {
        const doc = editableDocumentRef.current;
        if (!doc) return null;
        for (const page of doc.pages ?? [])
          for (const block of page.blocks ?? []) {
            if (block.id !== blockId) continue;
            for (const line of block.lines ?? [])
              if (line.id === lineId) return line.glyphs ?? [];
          }
        return null;
      },
      onCoreSuccess: (changed: boolean) => {
        const session = coreInputSessionRef.current;
        if (session) coreDocumentRef.current = documentOf(session);
        coreLifecycleRef.current!.markOwned();
        // 触发 F3B-6.14 的 Core + Sidecar reconciliation
        noteCoreSessionChange("core-mutation");
        // 3C-10C.3B-0：Core 提交**真的改了文档** ⇒ mutation 落点 = core（Ctrl+Z 走 Core History）。
        // no-op（changed === false）不入栈，故**不得**夺走 undo 归属。
        if (changed) markMutationOwner("core");
      },
      onOwnership: (owner) => {
        exportOwnershipRef.current = owner === "core" ? "core" : "legacy";
      },
      telemetry: capabilityReplaceTelemetryRef.current,
    };
    registry.register("replace", new CapabilityReplaceCommand({
      ...capabilityReplaceCoreDeps,
      readOwned: () => coreLifecycleRef.current?.owned === true,
      legacy: new ReplaceCommand(runtime),
    }));
    registry.register("rewrite", new CapabilityReplaceCommand({
      capability: "rewrite",
      ...capabilityReplaceCoreDeps,
      readOwned: () => coreLifecycleRef.current?.owned === true,
      legacy: new RewriteCommand(runtime),
    }));
    registry.register("translate", new CapabilityReplaceCommand({
      capability: "translate",
      ...capabilityReplaceCoreDeps,
      readOwned: () => coreLifecycleRef.current?.owned === true,
      legacy: new TranslateCommand(runtime),
    }));
    registry.register("delete", new DeleteCommand(runtime));
    registry.register("fixOcr", new FixOcrCommand(runtime));

    // ── Task-013B: 真实 CurrentSelectionProvider（Consistency Guard）──
    // 从 onSelectionChanged 更新的 ref 读取 DerivedSelection → CurrentSelection。
    // Guard：selection.blockId/lineId 不存在于当前 document → 返回 null。
    const provider = new MapCurrentSelectionProvider({
      getDerivedSelection: () => currentDerivedSelectionRef.current,
      getDocument: () => editableDocumentRef.current,
    });

    // ── F3B-6.17-3C-10S.3B-2 → F3B-6.25-B2：Core canonical entry（双轨 selection 的第二条链）──
    //   DOM Selection → CanonicalSelection → CanonicalSelectionProvider
    //     → resolveLineToCoreTarget → createTextEditCoreCommand → EditorDocument
    // 只在 **glyph 链不可用**（原生文本无 DerivedSelection）时被 EditTool 咨询。
    // **Core-only + fail-closed**：解析失败 = 什么都不做（不回落 Legacy ⇒ Legacy mutation = 0）。
    const canonicalEntry = {
      provider: { current: () => canonicalSelectionStoreRef.current?.provider.current() ?? null },
      execute: ({ capability, selection, payload }: { capability: string; selection: { blockId: string; lineId: string; startOffsetUtf16: number; endOffsetUtf16: number }; payload?: Record<string, unknown> }) => {
        // 3C-10S.3B-2：`replace`；3C-10B.1：`delete`（空串替换）；3C-10B.2：`rewrite`（带文本 replacement）
        // —— 三者共享同一条 range replacement 链（createTextEditCoreCommand 是唯一 Command 构造点）。
        // `translate` / `fixOcr` 未接 ⇒ fail-closed（返回，**不**回落 Legacy）。
        if (capability !== "replace" && capability !== "delete" && capability !== "rewrite") return;
        const text = capability === "delete" ? "" : payload?.text == null ? "" : String(payload.text);
        // 只读诊断：把「哪次 capability 进入 canonical Core path」记明（便于归因/回归）
        console.log("[CAPABILITY_CORE_CANONICAL_ENTRY]", { capability, textLength: text.length });
        const telemetry = capabilityReplaceTelemetryRef.current;
        if (telemetry) telemetry.attempt += 1;

        // 与 Segment / 3C-10A 同一形态：无 session 时由当前 Core document 建立
        let session = coreInputSessionRef.current;
        if (!session) {
          const coreDoc = coreDocumentRef.current;
          if (!coreDoc) return;
          const created = createCoreInputSessionFromDocument(coreDoc);
          if (!created || !created.ok || !created.session) return;
          session = created.session;
          coreInputSessionRef.current = session;
        }

        // F3B-6.25-B2：旧 `replaceFromCanonicalSelection` 缺省拒绝折叠区间
        //（allowCollapsedInsertion 缺省 false ⇒ empty-selection fail-closed），此处保持同语义。
        if (selection.startOffsetUtf16 === selection.endOffsetUtf16) return;

        const failClosed = (reason: string) => {
          console.log("[CAPABILITY_CORE_CANONICAL]", { path: "fail-closed", reason });
          if (telemetry) {
            telemetry.fallback += 1;
            telemetry.lastReason = reason;
          }
        };

        // B2 resolver：行（段落）UTF-16 区间 → Core TextRange（fail-closed：unresolved / out-of-bounds）
        const resolved = resolveLineToCoreTarget(documentOf(session), {
          blockId: selection.blockId,
          lineId: selection.lineId,
          startUtf16: selection.startOffsetUtf16,
          endUtf16: selection.endOffsetUtf16,
          lineIdToParagraphId: lineIdParagraphMapRef.current,
        });
        if (!resolved.ok) {
          failClosed(resolved.reason);
          return;
        }

        let changed = false;
        try {
          const built = createTextEditCoreCommand(resolved.range, text);
          // 注意：此处提交调用不得与 Segment Core 提交点（commitSegmentCanonical 内）
          // 使用相同的 `session.history.commit(<ident>)` 单行字面形式——
          // segment-core-commit.test.ts D11 / segment-core-path-dependency.test.ts C9
          // 以该子串的**首个出现位置**作为 Segment 提交点锚点（D11 且不剥注释）。
          const coreHistory = session.history;
          const applied = coreHistory.commit(built.command) as { changed?: boolean } | undefined;
          changed = applied?.changed === true;
        } catch {
          failClosed("commit-error");
          return;
        }
        if (telemetry) telemetry.success += 1;
        // 与 Segment / capability 同一 success 语义
        const s = coreInputSessionRef.current;
        if (s) coreDocumentRef.current = documentOf(s);
        coreLifecycleRef.current!.markOwned();
        // 触发 F3B-6.14 的 Core + Sidecar reconciliation
        noteCoreSessionChange("core-mutation");
        // 3C-10C.3B-0：Core 提交**真的改了文档** ⇒ mutation owner = core
        if (changed) markMutationOwner("core");
        exportOwnershipRef.current = "core";
      },
    };

    return new EditTool(registry, provider, canonicalEntry);
  }, []);

  // ── M7-001: Paste → EditSession（insertAtGlyph 纯 session 层，不 mutation）──
  // 复用 insertAtGlyph（multi-char 已支持），更新 session.text + glyphCaret。
  // commit 走现有 onTextEditSave → applyTextOperation.insert → 单 History entry（undo 一次撤销整段）。
  const handlePasteEdit = useCallback(
    (text: string, session: EditSession) => {
      const willInsert = session.status === "active" && !!session.glyphCaret;
      // F3B-6.17-3C-10C.2：Shadow 观察（只读；gate 缺省关闭）
      observeTextEditShadow({
        request: { kind: "paste", text },
        session,
        legacy: { kind: willInsert ? "insert" : "none", trigger: "paste", text },
      });
      if (!willInsert) return;
      dispatchSession(insertAtGlyph(session, text));
    },
    []
  );

  // ── M6-001C: 提交后把 operation push 进 OperationHistory ──
  // F3B-6.4B-4.4A：这是**全仓唯一**的 OperationHistory.push 调用点（funnel）。
  // 第 3 参 `segmentKey` 仅由 Segment canonical commit 提供（经 ctx.pushHistory 透传），
  // 其它 producer（glyph delete / onTextEditSave）不传 ⇒ entry.segmentKey 为 undefined。
  const pushOperationToHistory = useCallback(
    (operation: TextOperation, result: MutationResult, segmentKey?: string) => {
      // ── F3B-6.17-3C-10C.3B-0：Legacy mutation 落点记账 ──
      //   本函数是**全仓唯一**的 OperationHistory.push 调用点（funnel）
      //   ⇒ 被调用即代表一次 Legacy mutation 落地（即使无 inverse 不可入栈）。
      //   之后 `Ctrl+Z` 必须作用在 Legacy 侧（B0 的 ownership 路由输入）。
      markMutationOwner("legacy");
      const hist = operationHistoryRef.current;
      if (!hist || !result.inverse) return;
      // caret/selection：003C 阶段用 glyphCaret 表达；此处以 operation target 粗略映射
      const t = operationTarget(operation);
      hist.push({
        operation,
        inverse: result.inverse,
        // 纯 metadata；不伪造：非 Segment entry 保持 undefined
        segmentKey,
        beforeCaret: undefined,
        afterCaret: undefined,
      });
      void t;
      // C-Impl-1：Legacy 栈变化 ⇒ 广播可用性快照（Toolbar canUndo/canRedo）
      refreshUndoRedoAvailability();
    },
    [refreshUndoRedoAvailability]
  );

  // ── F3B-6.4B-2: Segment canonical commit ──────────────────────────────
  // 注：`segmentPositionLedger` 与 `getLegacyPendingSegments` 已**上移到 useExport 之前**声明
  //     —— 它们在 useExport 调用点（约 1841 行）即被引用，声明在下会构成 TDZ。

  /**
   * Segment 编辑 → canonical EditableDocument transaction。
   *
   * 严格顺序（F3B-6.4B-0 §4.2）：
   *   resolve range → capture beforeGlyphs → mutateLineText
   *   → setDocument → renderToBlocks → markLineEdited → pushHistory
   * `markLineEdited` 读取的是**已更新**的 document，故必须排在 setDocument 之后。
   *
   * 开关：`window.__segmentCanonicalCommit`，**F3B-6.4B-3.2 起默认启用**，
   * 仅显式 `=== false` 时关闭（kill-switch 保留，见 readSegmentCanonicalCommitFlag）。
   * ledger identity 由 `commitSegmentToDocument` 内部从 `segment.source` 派生
   * （F3B-6.4B-4.1：canonical position identity），此处不再传 key。
   */
  const commitSegmentCanonical = useCallback(
    (segmentId: string, newText: string) => {
      if (!readSegmentCanonicalCommitFlag()) return;
      const seg = (segmentsRef?.current ?? []).find((s) => s.id === segmentId);
      if (!seg) return;

      // ★ F3B-6.27（缺陷修复，真实 Chromium 复现）：Core 接管段的 blur 二次提交必须**短路**。
      //   机制（gd-swim-2026.pdf）：把「竞赛天数 6 天」的 "6" 改成 "7" 后退出编辑，
      //   Core 段落从 32 字符变成 **42** 字符（尾部 `7 天，具体日期以补` 重复），
      //   Core 把它排成两行 ⇒ 第二行压到下一行 `充通知为准）；` 上 ⇒ 用户看到的
      //   「修改后文本与原文本重叠 / 出现换行」。
      //   成因链：875cf63 的 A′ 把 **Core 文本写进 DOM**，但刻意**不回写 `segment.text`**
      //   （当时的取舍正是为了避开 blur 二次提交）⇒ 退出编辑时
      //   `EditableTextNode.handleBlur` 的 `newText !== segment.text` **必然成立**
      //   ⇒ 触发 legacy `onChange` ⇒ `commitSegmentCanonical` 把整段文本再灌回 Core；
      //   `resolveSegmentToCoreRange` 的 glyph 范围与实际不符 ⇒ Core 段落被**追加**。
      //   判据：该段所属 Core 段落的**切片**已等于 newText ⇒ Core 已是该内容
      //        ⇒ 本次提交只是 A′ 的镜像，**必须短路**（Core 为唯一真值）。
      //   ⚠️ fail-open：任何判据不可用（无 ownership / 段落不可解析）⇒ 继续既有路径，
      //      绝不因判据失败而吞掉真实的用户编辑。
      try {
        const coreDocNow = coreDocumentRef.current;
        const segSrcNow = seg.source as { lineId?: string } | undefined;
        // ★ F3B-6.27-H2：候选段落 = ①**有效编辑目标** ②lineId 解析（既有）。
        //
        //   H2 之前只试 ② ⇒ 拆分后 caret 迁到新段落、A′ 把新段落文本写进本面，
        //   而 ② 解析出的仍是**旧段落** ⇒ `paraText(旧) !== newText(新)` ⇒ 不短路
        //   ⇒ Core 用旧段落的 glyph 区间去替换整段 ⇒ 旧段落被污染（T1 实测）。
        //
        //   ⚠️ 两个候选**都试**（去重后）：Core 输入面是**逐键提交**，blur 提交本质上
        //      只是 A′ 的冗余镜像 ⇒ 任一候选命中镜像判据即短路。
        //   ⚠️ 此处**不**传 caret（blur 时 caret 已可能被浏览器/退出流程改变）
        //      ⇒ maintain 只校验「段落存在 + 同 textBox + version 未倒退」。
        const mirrorCandidates: string[] = [];
        const targetMaintain = resolveEditingTargetMaintain({
          target: editingTargetRef.current,
          segmentId,
          document: coreDocNow,
          currentGeneration: coreDocNow?.version ?? null,
        });
        if (targetMaintain.ok) mirrorCandidates.push(targetMaintain.paragraphId);
        const linePid =
          coreDocNow && segSrcNow?.lineId
            ? coreParagraphIdForLineId(coreDocNow, segSrcNow.lineId)
            : null;
        if (linePid && !mirrorCandidates.includes(linePid)) mirrorCandidates.push(linePid);
        for (const pid of mirrorCandidates) {
          const own = segmentRangeOwnershipOf(pid);
          const paraText = paragraphTextOf(coreDocNow, pid);
          if (paraText === null) continue;
          // ★ F3B-6.27-P1：判据必须跟随「面里装的是什么」而变。
          //   方案 A 之后整段面的 newText 是**整段**文本，而 `slice` 只是该段的切片
          //   ⇒ `slice === newText` **永不成立** ⇒ 上面的 blur 二次提交短路从未触发
          //   ⇒ `resolveSegmentToCoreRange` 的 glyph 区间（切片）去替换整段内容
          //   ⇒ Core 段落被追加成「前缀 + 整段 + 尾部」（实测 65 字，双 `日期：`）。
          //   这与已修的两处同源：Core→DOM 多减 base、DOM→Core 多加 base。
          const domCarriesWhole = domSurfaceCarriesWholeParagraph(pid, segmentId);
          if (domCarriesWhole) {
            // 整段面：Core 段落文本即 newText ⇒ 本次提交只是 A′ 的镜像 ⇒ 短路
            if (paraText === newText) return;
          } else if (own) {
            // 切片面：逐字节沿用既有判据
            const slice = sliceTextFor(own, paraText, segmentId);
            if (slice !== null && slice === newText) return;
          }
          // ★ H2：Core 接管面 + 面文本 === 候选段落**全文** ⇒ 本次提交只是 A′ 的镜像。
          //   覆盖「编辑目标被重绑定到新段落」的情形：新段落既没有 ownership（没有
          //   legacy segment / glyph range），也没有 regime B 登记（A′ 只在
          //   `multiSegmentSurface` 时登记）⇒ 上面两支**都判不到** ⇒ 必须补这一支，
          //   否则 blur 会把新段落文本按旧段落的 glyph 区间灌回旧段落（T1 实测）。
          //   ⚠️ 仅在 Core 接管该段时启用：Legacy 路径下 blur 提交是**唯一**提交，
          //      不得因文本巧合相等而吞掉真实编辑。
          if (paraText === newText && coreOwnedSegmentIdRef.current === segmentId) return;
        }
      } catch { /* 判据失败 ⇒ fail-open 继续既有路径 */ }

      // ── F3B-6.17 阶段二：Core 门控迁移（方案 A，默认 OFF）─────────────
      // 结构：orchestrator 先尝试 Core；失败 → **继续走下方既有 Legacy 分支**。
      // 绝不在 Command 内部 fallback（避免 Legacy mutation 变成 Core 的隐式依赖）。
      if (readSegmentCoreMigrationFlag()) {
        const telemetry = segmentCoreTelemetryRef.current;
        telemetry.attempt += 1;
        let reason: SegmentFallbackReason | undefined;
        try {
          const coreDoc = coreDocumentRef.current;
          const segSrc = seg.source as
            | { blockId?: string; lineId?: string; startGlyphIndex?: number; endGlyphIndex?: number }
            | undefined;
          const legacyDoc = editableDocumentRef.current;
          let lineGlyphs: { char: string; originalChar?: string }[] | null = null;
          if (legacyDoc && segSrc?.blockId && segSrc?.lineId) {
            for (const pg of legacyDoc.pages ?? []) {
              for (const bl of pg.blocks ?? []) {
                if (bl.id !== segSrc.blockId) continue;
                for (const ln of bl.lines ?? []) {
                  if (ln.id === segSrc.lineId) {
                    lineGlyphs = (ln.glyphs ?? []).map((g: any) => ({
                      char: g.char,
                      originalChar: g.originalChar,
                    }));
                    break;
                  }
                }
              }
            }
          }
          const ref = coreDoc && segSrc && lineGlyphs
            ? resolveSegmentToCoreRange({
                document: coreDoc,
                source: {
                  blockId: String(segSrc.blockId),
                  lineId: String(segSrc.lineId),
                  startGlyphIndex: Number(segSrc.startGlyphIndex ?? 0),
                  endGlyphIndex: Number(segSrc.endGlyphIndex ?? 0),
                },
                glyphs: lineGlyphs,
              })
            : null;
          // ── REENTER-SPLIT-01 / P9.2：range-切片一致性校验（fail-closed）────────
          //   Enter 拆段后，旧 segment 的注册区间（如旧行 [0,3)「日期：」）可能被解析到
          //   新段落；ReplaceText 会做「前缀替换+拼接」⇒ 源 runs 72/40 → 112/80。
          //   校验：目标段落在 range 处的实际文本必须等于该 segment 的注册切片文本。
          //   失配/无法证明 ⇒ 不创建 Core 命令（decision 走 legacy 收尾），绝不猜测。
          let rangeConsistent = true;
          let rangeConsistencyReason = "";
          try {
            if (ref && coreDoc && segSrc?.lineId) {
              const pidResolved = coreParagraphIdForLineId(coreDoc, segSrc.lineId);
              const paraTextNow = pidResolved ? paragraphTextOf(coreDoc, pidResolved) : null;
              const ownNow = segmentRangeOwnershipOf(pidResolved);
              const sliceNow =
                ownNow && paraTextNow != null ? sliceTextFor(ownNow, paraTextNow, segmentId) : null;
              const check = segmentRangeMatchesParagraph({
                paragraphText: paraTextNow ?? "",
                start: ref.start,
                end: ref.end,
                expectedSliceText: sliceNow,
              });
              if (!check.ok) {
                rangeConsistent = false;
                rangeConsistencyReason = `${check.reason}: ${check.detail}`;
              }
            }
          } catch (e) {
            rangeConsistent = false;
            rangeConsistencyReason = "diag-error: " + String(e).slice(0, 120);
          }
          if (!rangeConsistent) {
            console.warn(
              `[P9-FIX] segment core commit skipped（identity/range 轴错位，fail-closed） segmentId=${segmentId} reason=${rangeConsistencyReason}`,
            );
          }
          const built = ref && rangeConsistent ? createSegmentCoreCommand({ ref, newText }) : null;
          const decision = decideSegmentCommitPath({
            migrationEnabled: true,
            coreDocument: coreDoc,
            ref,
            command: built?.command ?? null,
            // F3B-6.18-D.1：Core 文本 render 已是 production default（与本次提交无关）；
            // `segmentCoreActive` 只记录 semantic ownership，不再是 render 门控。
            renderSourceAvailable: true,
          });
          if (decision.path === "core" && built) {
            // 复用/创建 Core session（**不依赖** `__coreInput`）
            let session = coreInputSessionRef.current;
            if (!session && coreDoc) {
              const outcome = createCoreInputSessionFromDocument(coreDoc);
              if (outcome && outcome.ok) {
                session = outcome.session ?? null;
                if (session) coreInputSessionRef.current = session;
              }
            }
            if (session) {
              const commitResult = session.history.commit(built.command) as { changed?: boolean } | undefined;
              coreDocumentRef.current = documentOf(session);
              coreLifecycleRef.current!.markOwned();
              // 3C-0.5：本次编辑由 Core 接管（ownership 保持/回到 core）
              exportOwnershipRef.current = "core";
              // 打开 Core render（仅本文档）+ 触发 6.14 的 reconciliation effect
              setSegmentCoreActive(true);
              noteCoreSessionChange("core-mutation");
              telemetry.success += 1;
              // 3C-10C.3B-0：Segment Core 提交**真的改了文档** ⇒ mutation owner = core
              if (commitResult?.changed !== false) markMutationOwner("core");
              console.log("[F3B-6.17][SEGMENT_CORE_COMMIT]", {
                kind: built.kind,
                textBoxId: ref?.textBoxId,
                paragraphId: ref?.paragraphId,
                start: ref?.start,
                end: ref?.end,
                success: telemetry.success,
              });
              return;
            }
            reason = "no-core-document";
          } else {
            reason = decision.reason;
          }
        } catch (error) {
          reason = "commit-error";
          console.warn("[F3B-6.17][SEGMENT_CORE_COMMIT] failed:", error);
        }
        telemetry.fallback += 1;
        telemetry.lastReason = reason;
        // ── F3B-6.25-E1-Impl：禁止文档分裂（Core owned ⇒ 拒绝 Legacy semantic mutation）──
        //   与 TextEdit 同契约：`owned` 后 Legacy 编辑永不回补进 Core ⇒ 两条导出路都会丢编辑。
        //   ⇒ fail-closed：拒绝本次编辑，并**保持 ownership = core**（Core 仍持有全部已接受编辑）。
        //   ⚠️ 必须早于下方 `exportOwnershipRef.current = "legacy"`（否则翻了 ownership 却不写入 ⇒ 导出丢 Core 编辑）。
        if (coreLifecycleRef.current?.owned) {
          console.warn("[F3B-6.25][CORE_OWNED_LEGACY_SEGMENT_EDIT_BLOCKED]", {
            reason: "core-owned-legacy-segment-edit-blocked",
            segmentId,
            coreReason: reason,
            owned: true,
          });
          return;
        }
        // ★ F3B-6.17-3C-0.5：Core **未接管**本次编辑 ⇒ 该文档 export ownership = legacy。
        //   否则 Core Export 会在下载时接管（Core 产物不读 legacy 编辑）⇒ 本次编辑静默丢失。
        exportOwnershipRef.current = "legacy";
        // #12/G3：ownership 翻转 ⇒ 同步 bump revision（presentation 不得继续按 Core 归属呈现）
        noteCoreSessionChange("legacy-fallback");
        console.log("[F3B-6.17][SEGMENT_CORE_FALLBACK]", {
          reason,
          attempt: telemetry.attempt,
          fallback: telemetry.fallback,
        });
        // ↓ 落到下方既有 Legacy canonical 分支
      } else {
        // ── F3B-6.25-E1-Impl：kill-switch 关闭迁移 ⇒ Core 未尝试；若已 owned 同样禁止分裂。
        if (coreLifecycleRef.current?.owned) {
          console.warn("[F3B-6.25][CORE_OWNED_LEGACY_SEGMENT_EDIT_BLOCKED]", {
            reason: "core-owned-legacy-segment-edit-blocked",
            segmentId,
            coreReason: "migration-flag-off",
            owned: true,
          });
          return;
        }
        // ★ F3B-6.17-3C-0.5：migration 关闭 ⇒ 根本未尝试 Core ⇒ 同样归 legacy ownership
        exportOwnershipRef.current = "legacy";
        // #12/G3：同上
        noteCoreSessionChange("legacy-fallback");
      }
      const out = commitSegmentToDocument(seg, newText, {
        getDocument: () => editableDocumentRef.current,
        setDocument: (doc) => {
          editableDocumentRef.current = doc;
          (window as any).__editableDocument = doc;
          setEditableDocVersion((v) => v + 1);
        },
        setBlocks: (blocks) => {
          setDocBlocks((prev) => mergeDocBlocksProjection(prev, blocks));
        },
        // F3B-6.4B-6.1：空行兜底时会带上 extraInkBox（普通编辑为 undefined，行为不变）
        markLineEdited: (blockId, lineId, extraInkBox) =>
          markLineEdited(blockId, lineId, extraInkBox),
        // F3B-6.4B-4.4A：canonical commit 的 segmentKey 由此透传进 HistoryEntry
        pushHistory: (operation, result, segmentKey) =>
          pushOperationToHistory(operation, result, segmentKey),
        ledger: segmentPositionLedger,
      });
      // F3B-6.4B-3：只有 canonical mutation **真正成功** 才 reconcile；
      // 失败（mutated=false / 未找到 line / range 越界）时保持 pending，
      // 让旧 export safety-net 仍有机会处理（见 segmentCommit.test.ts T17）。
      if (out.ok) reconcileSegmentCommit(segmentId, newText);
    },
    [
      markLineEdited,
      pushOperationToHistory,
      segmentPositionLedger,
      reconcileSegmentCommit,
    ]
  );

  // （getLegacyPendingSegments 已上移到 useExport 之前声明）

  // ── M7-004B-UI: Selection → pendingEdit（与 onGlyphClick 共享同一 editing entry）──
  // 职责：把 Mouse Drag SelectionRange 转成 pendingEdit，让 DocumentWorkspace（依赖 selectedText
  //       + pendingEdit）在 drag 后出现且 "Update Text" 可触发。
  // 数据源统一：text 用 identity-driven extraction（line.glyphs[range]），bbox/fontSize 用
  //   findEditTarget（与 onGlyphClick 同一 layout 来源）。不重新测量、不做 DOM/text 回查。
  // pendingEdit.text 是 selection fragment（非整行）——pendingEdit ≠ EditSession，
  //   进入编辑时 004B 的 onUpdateText 会把整行 working text 装进 EditSession。
  const createPendingEditFromSelection = useCallback(
    (range: SelectionRange) => {
      if (!editableDocumentRef.current) return null;
      const block = editableDocumentRef.current.pages
        .flatMap((p) => p.blocks)
        .find((b) => b.id === range.blockId);
      const line = block?.lines.find((l) => l.id === range.lineId);
      if (!line) return null;
      const start = Math.max(0, Math.min(range.startGlyphIndex, line.glyphs.length - 1));
      const end = Math.max(start, Math.min(range.endGlyphIndex, line.glyphs.length - 1));
      // identity-driven extraction：SelectionRange + glyph identity（非 text search / indexOf）
      const text = line.glyphs.slice(start, end + 1).map((g) => g.char).join("");
      // bbox/fontSize：复用 onGlyphClick 的 layout 来源（findEditTarget），保持两路径一致
      let bbox = { x: 0, y: 0, width: 0, height: 0 };
      let fontSize = 14;
      if (layoutDocument) {
        const target = findEditTarget(layoutDocument, range.blockId, range.lineId);
        if (target) {
          bbox = target.bbox;
          fontSize = target.fontSize;
        }
      }
      return {
        blockId: range.blockId,
        text,
        bbox,
        fontSize,
        lineId: range.lineId,
        startGlyphIndex: start,
        endGlyphIndex: end,
      };
    },
    [layoutDocument]
  );

  // ── M7.7-003: 拖选结束 → 直接进入 inline EditSession（替代 Workspace "Update Text" 旧路径）──
  // 职责：把 SelectionRange 转成 text-edit EditSession（caret = selection），直接 openTextEditSession。
  //   - 与 Workspace onUpdateText 的 Route A（currentSelection 分支）共用同一语义（DRY）。
  //   - 整行 working text 装进 session；caret = selection range（排他 end，与 Keyboard selection 一致）。
  //   - single truth：openTextEditSession 清 pendingEdit/currentSelection/selectedText。
  const openTextEditFromSelectionRange = useCallback(
    (range: SelectionRange | null) => {
      if (!range || !editableDocumentRef.current) return;
      const selBlock = editableDocumentRef.current.pages
        .flatMap((p) => p.blocks)
        .find((b) => b.id === range.blockId);
      const selLine = selBlock?.lines.find((l) => l.id === range.lineId);
      if (!selLine) return;
      // B2-R1：打开时看到的文本应来自「当前 Core 文档」（Core owns 时），与 diff baseline / resolver 同步。
      // F3B-6.25-B-Impl：与另两条 open 路径（surface open / click-to-edit）**统一门控**
      //   —— 必须经 `readCoreTextEditInputFlag()`，保证 open↔save 同源：
      //   flag OFF（emergency rollback）时不得读 Core。因为 Core 可能已领先 Legacy
      //   （Segment / capability / undo-redo 提交 Core 后跳过 Legacy 且 markOwned 阻止回补），
      //   此时若 open=Core 而 save=Legacy，Legacy commit 会用**legacy 行文本**做 diff
      //   ⇒ glyph range 错位 ⇒ Legacy 被错误改写。
      const coreTextForOpen =
        readCoreTextEditInputFlag() && coreDocumentRef.current != null
          ? resolveCoreLineText(coreDocumentRef.current, selLine.id, lineIdParagraphMapRef.current)
          : null;
      const fullLineText = coreTextForOpen ?? selLine.glyphs.map((g) => g.char).join("");
      const selStart = Math.max(0, range.startGlyphIndex);
      // SelectionRange.endGlyphIndex 是"含"的；EditSession caret 的 end 是"排他"的（+1 转换）
      const selEnd = Math.max(selStart, Math.min(range.endGlyphIndex + 1, selLine.glyphs.length));
      // M7.7-004 (Text Run Preservation): EditSessionTarget.endGlyphIndex 语义是**含**的
      //   （与 replaceSelection / commit 处 mutateLineText 的 range.end 一致，见 edit-session.ts 契约）。
      //   此前误把"排他"的 selEnd 直接当"含"的 endGlyphIndex，导致拖选替换时把选区后一个字符
      //   （如 "JENNIFER " 的空格）也圈进替换区 → replacement 不还原该空格 → "MARY MARTINS" 粘连。
      //   此处 caret（排他）与 target（含）分开传递：caret 保持 selEnd，target 用 selEnd - 1。
      const targetEnd = Math.max(selStart, Math.min(range.endGlyphIndex, selLine.glyphs.length - 1));
      const pe = createPendingEditFromSelection(range); // bbox/fontSize：findEditTarget（与 onGlyphClick 同源）
      // M7.7-004X (Bug2): 拖选编辑同样用文档字体（避免系统字体撑宽编辑框 + 样式不一致）
      const selStyles = editableDocumentRef.current?.styles;
      const selFontFamily = selStyles && selLine.glyphs[0] ? selStyles[selLine.glyphs[0].styleRef]?.fontFamily : undefined;
      openTextEditSession(
        range.blockId,
        {
          blockId: range.blockId,
          text: fullLineText,
          bbox: pe?.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
          fontSize: pe?.fontSize ?? 14,
          fontFamily: selFontFamily,
        },
        createEditSession(
          { blockId: range.blockId, lineId: range.lineId, startGlyphIndex: selStart, endGlyphIndex: targetEnd },
          fullLineText,
          [range],
          undefined,
          // Mouse Selection 直接进入 text-edit（line working state），caret range 走 selection 分支
          "text-edit",
          { start: selStart, end: selEnd }
        )
      );
    },
    [createPendingEditFromSelection, openTextEditSession]
  );

  // ── M7.7-005: 双击选词 → 直接进入 inline EditSession ──
  // 语义（Adobe 模式）：单击定位 caret，双击选词并进入编辑。
  //   - DerivedSelection → SelectionRange → openTextEditFromSelectionRange（与拖选 "Edit Text" 同入口，
  //     caret = 选中词范围，输入直接替换选中词）。
  //   - 不弹 SelectionActionMenu（openTextEditSession 会清 selectionMenu/currentSelection）。
  //   - dblclick 前的两次 click 各自打开过 text-edit session；M7.7-003A 的 session epoch guard
  //     保证旧 blur 不会取消本 session，本回调的 session 是最终态。
  const handleGlyphDoubleClick = useCallback(
    (derived: import("../document-model/selection-engine").DerivedSelection | null) => {
      if (!derived) return;
      const range = derived.glyphIds.size > 0 ? derivedToSelectionRange(derived) : null;
      if (!range) return;
      openTextEditFromSelectionRange(range);
    },
    [openTextEditFromSelectionRange]
  );

  // ── F3B-6.17-3C-10C.3A：TextEdit commit → Core ────────────────────────
  //   EditSession（working text，**不是** document truth）
  //     → Adapter（Codepoint → UTF-16，唯一坐标收敛点）
  //     → CoreInputIntent
  //     → canonical 链（唯一 hierarchy 解析 + 唯一 Command 构造点）
  //     → ReplaceTextCommand / DeleteTextCommand → EditorDocument
  //
  //   与 Segment canonical commit（3C-0.5）**同一 ownership 模式**：
  //     Core 成功 ⇒ ownership = core + 打开 Core render + tick（Legacy mutation = 0）
  //     任何失败 ⇒ 返回失败 plan，调用方**继续走既有 Legacy 分支**（不在此 fallback 之外做任何事）
  //   ⚠️ Legacy mutation 绝不成为 Core 的隐式依赖（失败信息只回报给调用方）。
  const tryCommitTextEditToCore = useCallback((input: TextEditCoreCommitInput): TextEditCoreCommitPlan => {
    const plan = planTextEditCoreCommit(input);
    if (!plan.ok) return plan;

    // 与 Segment / 3C-10A 同一形态：无 session 时由当前 Core document 建立
    let session = coreInputSessionRef.current;
    if (!session) {
      const coreDoc = coreDocumentRef.current;
      if (!coreDoc) return { ok: false, reason: "no-core-document", detail: "coreDocumentRef.current === null" };
      const created = createCoreInputSessionFromDocument(coreDoc);
      if (!created || !created.ok || !created.session) {
        return { ok: false, reason: "no-core-document", detail: "core-session-unavailable" };
      }
      session = created.session;
      coreInputSessionRef.current = session;
    }

    // B2：直接用 (blockId, lineId, UTF-16) → paragraph-level `TextRange` 解析（不依赖 canonicalToCoreTarget / DOM selection）
    const coreDoc = documentOf(session);
    const resolve = resolveLineToCoreTarget(coreDoc, {
      blockId: plan.canonicalSelection.blockId,
      lineId: plan.canonicalSelection.lineId,
      startUtf16: plan.canonicalSelection.startOffsetUtf16,
      endUtf16: plan.canonicalSelection.endOffsetUtf16,
      lineIdToParagraphId: lineIdParagraphMapRef.current,
    });
    if (!resolve.ok) {
      return { ok: false, reason: "core-commit-failed", detail: `resolve:${resolve.reason}` };
    }
    const built = createTextEditCoreCommand(resolve.range, plan.replacementText);

    let changed = true;
    try {
      const res = session.history.commit(built.command) as { changed?: boolean } | undefined;
      changed = res?.changed ?? true;
    } catch {
      return { ok: false, reason: "core-commit-failed", detail: "commit-error" };
    }

    // 与 Segment / 3C-10A 同一 success 语义（原 replaceFromCanonicalSelection 的 onCoreSuccess 主体）
    const s = coreInputSessionRef.current;
    if (s) coreDocumentRef.current = documentOf(s);
    coreLifecycleRef.current!.markOwned();
    // 3C-0.5：本次编辑由 Core semantic path 接管 ⇒ export ownership = core
    exportOwnershipRef.current = "core";
    // F3B-6.18-D.1：renderer **不再**由 semantic ownership 决定（Core render 已是默认）；
    // 此处只记 semantic ownership + 触发 F3B-6.14 的 Core + Sidecar reconciliation effect
    setSegmentCoreActive(true);
    noteCoreSessionChange("core-mutation");
    // 3C-10C.3B-0：Core 提交**真的改了文档** ⇒ mutation owner = core（Ctrl+Z 走 Core History）
    if (changed) markMutationOwner("core");
    console.log("[F3B-6.17][TEXT_EDIT_CORE_COMMIT]", {
      blockId: plan.canonicalSelection.blockId,
      lineId: plan.canonicalSelection.lineId,
      range: [plan.canonicalSelection.startOffsetUtf16, plan.canonicalSelection.endOffsetUtf16],
      replacementLen: plan.replacementText.length,
      changeKind: plan.changeKind,
    });
    // B2：成功补记 lineId → paragraphId（下次编辑即使 run.source.lineId 已丢失仍可解析）
    lineIdParagraphMapRef.current.set(plan.canonicalSelection.lineId, resolve.paragraphId);
    return { ...plan, commandType: built.kind };
  }, []);

  // ── M7.7-003: 拖选浮层 Action Menu 操作（Edit Text / Copy / Ask AI）──
  // 语义（Adobe 模式）：
  //   Edit Text → 直接进入 inline EditSession（复用 openTextEditFromSelectionRange）。
  //   Copy     → 复制选中文本到剪贴板。
  //   Ask AI   → 打开右侧 DocumentWorkspace（workspaceIntent="ai"），保留 pendingEdit 兜底。
  const handleMenuEditText = useCallback(() => {
    if (!selectionMenu) return;
    const range = selectionMenu.range;
    setSelectionMenu(null);
    openTextEditFromSelectionRange(range);
  }, [selectionMenu, openTextEditFromSelectionRange]);

  const handleMenuCopy = useCallback(() => {
    if (!selectionMenu) return;
    const text = selectionMenu.text;
    setSelectionMenu(null);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(text).catch(() => {});
    }
  }, [selectionMenu]);

  const handleMenuAskAI = useCallback(() => {
    if (!selectionMenu) return;
    const { range, text } = selectionMenu;
    const pe = createPendingEditFromSelection(range); // Workspace "Update Text" 兜底保留
    setSelectionMenu(null);
    setSelectedText(text);
    setPendingEdit(pe);
    setWorkspaceIntent("ai");
  }, [selectionMenu, createPendingEditFromSelection]);

  // ── M5-IMPLEMENT-003C-UI: Keyboard → EditSession（ADR-048 editingMode 状态机）──
  // 职责：keyboard event → editingMode transition → session update（不 mutation、不 reflow、不 overflow）。
  // TextEditOverlay 只捕获并转发；本 handler 是唯一编辑状态机入口。
  const handleKeyboardEdit = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, session: EditSession) => {
      if (!editableDocumentRef.current) return;
      if (session.status !== "active") return;

      // Enter/Escape 已由 TextEditOverlay 处理（commit/cancel），不在此重复。
      if (e.key === "Enter" || e.key === "Escape") return;

      // M7-003: Ctrl+A → 选中整行（仅 text-edit 模式；replace-selection 由首次输入状态机处理）
      if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        dispatchSession(selectAll(session));
        return;
      }

      // IME 组合输入（中文/日文）不拦截：让 textarea 默认行为走完，避免破坏 composition。
      if (e.nativeEvent.isComposing) return;

      // M7-004C: 提前补建 glyphCaret（caret re-anchor）。
      //   Mouse Selection（Route A）replace/delete 后 session 无 glyphCaret + caret collapsed，
      //   若在 guard 之后才补建，会被下方 guard（无 glyphCaret + collapsed → no-op）提前拦截。
      //   因此在 guard 前补建，让单字符输入/删除/方向键都能定位。
      //   ensureGlyphCaretFromCaretPosition 有 selection / 已有 glyphCaret 时 no-op（无副作用）。
      const anchored = ensureGlyphCaretFromCaretPosition(session);

      // M7-004B: guard 放宽 —— 无 glyphCaret 但**有 selection range** 时放行（Mouse Selection → EditSession）。
      //   invariant：可编辑条件 = glyphCaret exists OR selection range exists。
      //   无 glyphCaret 且 collapsed caret → SAFE no-op（无 glyph 级定位，无法做单字符/方向键编辑）。
      //   方向键分支下方仍依赖 glyphCaret（无 glyphCaret 时自然 no-op，由各纯函数 guard 兜底）。
      if (!anchored.glyphCaret && !hasSelection(anchored)) return;

      // F3B-6.17-3C-10C.2：Shadow 观察（**只读**；gate `__textEditShadow` 缺省 false ⇒ 零开销）
      observeTextEditShadow({
        request: shadowRequestForKey(e),
        session: anchored,
        legacy: {
          kind:
            e.key === "Backspace" || e.key === "Delete"
              ? "delete"
              : e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey
                ? anchored.editingMode === "replace-selection"
                  ? "replace"
                  : "insert"
                : "none",
          trigger: `keydown:${e.key}`,
          text: e.key.length === 1 ? e.key : "",
        },
      });

      // 方向键：只移动 glyphCaret，不改 text（无 mutation）。
      // M7-002: Shift+Arrow 扩展 selection（anchor/focus），否则纯移动 caret。
      if (e.key === "ArrowLeft") { e.preventDefault(); dispatchSession(e.shiftKey ? moveGlyphCaretSelect(anchored, -1) : moveGlyphCaret(anchored, -1)); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); dispatchSession(e.shiftKey ? moveGlyphCaretSelect(anchored, 1) : moveGlyphCaret(anchored, 1)); return; }

      // M7.7-002: Home/End 导航（行首/行尾）。Shift+Home/End → 扩展 selection（anchor/focus 模型）。
      if (e.key === "Home") { e.preventDefault(); dispatchSession(e.shiftKey ? moveGlyphCaretSelectHome(anchored) : moveGlyphCaretHome(anchored)); return; }
      if (e.key === "End") { e.preventDefault(); dispatchSession(e.shiftKey ? moveGlyphCaretSelectEnd(anchored) : moveGlyphCaretEnd(anchored)); return; }

      // ── replace-selection → text-edit 转换（首次输入）──
      if (anchored.editingMode === "replace-selection") {
        // 选中态下 Backspace/Delete 无可删（选中整个 fragment）→ SAFE no-op
        if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); return; }
        const ch = e.key;
        if (ch.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          // 从 Document Model 读取目标行完整文本（ADR-048: handler 注入 document context）
          const lineText = getLineText(
            editableDocumentRef.current,
            anchored.target.blockId,
            anchored.target.lineId
          );
          if (lineText === null) return;
          dispatchSession(replaceSelection(anchored, lineText, ch));
        }
        return;
      }

      // ── text-edit：直接用 003C 纯函数 ──
      // F3B-6.22-B2: Ctrl/Cmd + Backspace/Delete → 词删除（EditSession working-draft 域）。
      // 只有本组合键真正接管时才 preventDefault（不先抢默认再发现不支持）。
      //
      // F3B-6.22-D-Impl：原条件里的 `!anchored.composing` **已删除**。
      //   它引用的是 `EditSession.composing`，而该字段由 `startComposition()` 写入、
      //   **生产零调用者**（D-0 实测 composing 恒 null）⇒ 该条件**永远为 true**，
      //   会制造「此处有 composition 防线」的错误认知。
      //   composition 期间**真正**的防线是本函数开头的（L7115）：
      //     `if (e.nativeEvent.isComposing) return;`
      //   ⇒ 不建立第二个 composition truth；B2 自身保持单纯。
      if (
        (e.key === "Backspace" || e.key === "Delete") &&
        (e.ctrlKey || e.metaKey) &&
        !e.altKey
      ) {
        const dir: "backward" | "forward" = e.key === "Backspace" ? "backward" : "forward";
        const next = deleteWordAtCaret(anchored, dir);
        // 接管本组合键：始终 preventDefault，由 working-draft 拥有词删除语义（避免 textarea 原生 desync）。
        e.preventDefault();
        if (next !== anchored) dispatchSession(next);
        return;
      }
      if (e.key === "Backspace") { e.preventDefault(); dispatchSession(backspaceAtGlyph(anchored)); return; }
      // M5-003C-UI Delete Integration: Delete 删 caret 右侧 glyph（对称于 Backspace 删左侧）。
      // commit 时走 TextOperation.delete → applyDelete（suffix 左移），不绕回 replace。
      if (e.key === "Delete") { e.preventDefault(); dispatchSession(deleteAtGlyph(anchored)); return; }
      const ch = e.key;
      if (ch.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        dispatchSession(insertAtGlyph(anchored, ch));
      }
    },
    []
  );

  // ★ committed 层滚动跟随（2026-10-18）：实时 scrollY（渲染期读 ⇒ 重渲染自纠；
  //   滚动期间由 data-commit-doc-y 监听按绝对值直接改 DOM top）。
  const commitScrollNow = (): number => (typeof window !== "undefined" ? window.scrollY : 0);

  return (
    <div data-layer="pdfsail-root" style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", overflow: "hidden" }}>
      {/* ══ F3B-6.28 · C3：提交后受控显示层（__unitEditing gate）══
          unit 事务提交后编辑面消失，本层按 A 流布局（PDF 原始行距）+ C1 来源映射
          显示新内容：unit 成员覆盖的 flow 视觉行 + 被推进的后续行（原位置 + delta）。
          显示条件 = appliedCount ≥ 提交时值（undo 过头 ⇒ 隐藏；redo 回来 ⇒ 重现）。
          z 序：高于 mask(z40)/glyph(z30)——被 C2 mask 盖住的旧字位置由本层补新字。

          C 收尾（R1 残差）：清除层（committed-unit-clear）——取证证明 mask 之上的
          残留来自 glyph span（editedLines 命中 ⇒ span z50 渲染 legacy 原文，而
          Core 编辑不写 legacy ⇒ span 画的是**原文**），overlay 文本层只盖新位置。
          清除层 = 每个受影响行的「原始 glyph 并集 + mask padding」（共享 kernel，
          与 C2 mask 同源），白底、pointerEvents:none、与文本层同 z（DOM 顺序在前）。
          旧字来源被盖住 ⇒ 每行文本只在**新位置**出现一次；来源可追溯
          （data-clear-source）。 */}
      {/* ── D-3B-6 编辑态遮罩缺陷修复（2026-10-16）：unit 编辑期间按成员行
          lineId 遮盖**全部成员行**的原始 canvas 文本 ──
          根因与身份/fail-closed 纪律见 editMaskRects 声明处（本文件 ~6464）。
          z=10：高于 base canvas（pdf-canvas z0），低于 glyph 层容器（z30，内含
          segment/surface 的局部 z100）⇒ 只遮 canvas 原文，不遮编辑面/span。
          与缺陷 A 的 C3 clear divs 同族：fixed 白矩形 + data-mask-source 行身份 +
          随编辑面生命周期卸载；非 unit 编辑不渲染 ⇒ 单段落编辑行为不变。 */}
      {/* ── 编辑期成员字形抑制（2026-10-18 用户缺陷实证）：unit 编辑期间，成员行的
          glyph span（**含 Core 重排后的折行/合并字形**）一律 visibility:hidden ⇒
          编辑面（CE）是 unit 区域唯一显示层。
          根因（edv-editing.png 截图 + 分层盘点实证）：glyph 层按 Core 布局重排，
          而 CE 的 DOM 折行（字体度量）与 Core 布局（PDF advance）存在 ±2% 差 ⇒
          重排字形（如 l5 折行尾「补」@496,582、合并行「补充通知为准）；」）从
          编辑面边缘露出，与 CE 自身文本重复（用户截图：两个"补"/重复的
          "育类校外培训机构等。"）。既有 S2 抑制（isUnitMemberSegment）只覆盖
          segment DOM 文本，不覆盖 glyph span ⇒ 本补丁补齐 span 侧。
          span 自带 data-line-id ⇒ 零猜测映射；空态合成 lineId（syn:<pid>）匹配
          不上 ⇒ 选择器空转（fail-closed，不误伤）；退出编辑/面关闭 ⇒ style 卸载
          ⇒ span 恢复。与 committed 阶段的 clears-based 隐藏同机制同形态。 */}
      {/* ★ S2-v1：cell 面**不**隐藏整行 glyph span —— 面自身白底（z100）只覆盖该格，
          同行其他格的 span/原文必须保持可见（多行 unit 才需要整面抑制）。 */}
      {explicitUnitSurface && !explicitUnitSurface.cellAnchor && (
        <style>
          {explicitUnitSurface.unit.lines
            .map((l) => `[data-layer="overlay"][data-line-id="${l.lineId}"]`)
            .join(",") + "{visibility:hidden}"}
        </style>
      )}
      {/* ★ S2-v1 修复（2026-10-22 用户缺陷「编辑态其他格不显示文本」）：
          PDFCanvas 的 SEGMENTS MASK LAYER 在编辑态把**同一 lineId 的全部
          segment** 涂白（z40，高于 glyph 容器 z30 ⇒ 连 Core span 一并盖住，
          实测其他格只剩 ~2px 缝）。该过滤条件为「整行 unit 面」设计——面覆盖
          整行 ⇒ 兄弟段原文必须遮（面是唯一显示源）；但 cell 面只覆盖**一格**，
          同行其他格的原文/span 必须保持可见。
          修复 = 按遮罩自带的 `data-mask-segment-id`（F3B-6.27-G1 迁移的独立
          属性）**精确隐藏非宿主 segment 的遮罩**；宿主格遮罩保留（编辑面白底
          即该格唯一显示源）。遮罩属性是纯 id ⇒ 零文本/坐标猜测；文本确被编辑
          （seg.text !== originalText）的兄弟段不躲（其 canvas 原文本就该被遮）；
          无 cell 面 ⇒ 不渲染 ⇒ 单段/多行 unit 行为逐字节不变。 */}
      {(() => {
        const cellAnchor = explicitUnitSurface?.cellAnchor;
        if (!cellAnchor || !editingSegmentId) return null;
        const siblings = (segmentsRef.current ?? []).filter(
          (s) =>
            s.source?.lineId === cellAnchor.lineId &&
            s.id !== editingSegmentId &&
            s.text === s.originalText
        );
        if (siblings.length === 0) return null;
        return (
          <style>
            {siblings.map((s) => `[data-mask-segment-id="${s.id}"]`).join(",") + "{display:none}"}
          </style>
        );
      })()}
      {/* ★ 2026-10-22（用户缺陷「被编辑的表格整行竖线不完整、文本顶部有重影」）：
          cell 单位提交后，`markLineEdited` 的**整行白 mask（z40）**会盖住穿过文字带的
          表格**竖线**（竖线在 canvas z0，mask 在其上）⇒ 行带内竖线断开；且 mask 顶沿
          比 canvas 墨迹低 ~2.4px ⇒ 顶部重影。
          修复 = 仅对这些行：① 隐藏整行 mask（竖线恢复完整）；
          ② 给逐字符 span 加白底（box-shadow 上扩 3px / 下扩 2px，不改布局）——
          白底 = 字符墨迹盒，只盖自己的旧字形、不碰格线，上扩 3px 覆盖 canvas 顶部残差。
          span 文本 = Core 新文本（逐字符原位）⇒ 新值显示、列位置保持。
          非 cell 单位行（正文段落 / 多行 unit）不受影响（选择器按 lineId 精确限定）。 */}
      {cellCommittedSpans.size > 0 && (() => {
        // ★ 2026-10-23（用户缺陷「翻页后前后页内容混在一起」）：span 是**视口绝对定位**
        //   的 DOM，glyph-renderer 对 editedLines 的行**跨页持续渲染**（实测翻页到第 13 页
        //   后 p12 的 55 个 span 仍 visible 残留在页面底部 y=603）⇒ 新页 canvas 内容与
        //   旧行 span 重叠。修复 = 按 lineId 自带的页号（`pdf_p<N>_`）与**当前显示页**比较：
        //   非当前页的行 → span **与 mask** 都 `visibility:hidden`（mask 漏隐藏会盖住
        //   其他页同坐标内容，见下方 stale 规则）；当前页的行 → 白底/隐藏 mask 规则。
        const pageOf = (lid: string): number | null => {
          const m = /pdf_p(\d+)_/.exec(lid);
          return m ? Number(m[1]) : null;
        };
        const entries = [...cellCommittedSpans.entries()];
        const active = entries.filter(([lid]) => pageOf(lid) === page);
        const stale = entries.filter(([lid]) => pageOf(lid) !== page);
        if (active.length === 0 && stale.length === 0) return null;
        return (
          <>
            <style>
              {stale.length > 0 &&
                // ★ 2026-10-23（用户缺陷「表格 cell 编辑后，其他页同坐标文本被清空」）：
                //   glyph-renderer 对 editedLines 的行**跨页持续渲染** mask（白底 z40，
                //   页容器局部坐标）——旧规则只隐藏 stale 页的 span，**漏了 mask** ⇒
                //   编辑页的整行白块悬浮在其他页同坐标内容上（实测：第 12 页编辑
                //   l8 后翻到第 11 页，l8 的 mask（611.7×16.1 @y429.3）盖住第 11 页
                //   「二、达到成绩标准…」行 ⇒ 文本被清空）。span 与 mask 必须**一起**
                //   按 lineId 页号隐藏（mask 的几何来自该行，跨页即污染）。
                stale
                  .map(
                    ([lid]) =>
                      `[data-layer="overlay"][data-line-id="${lid}"],[data-layer="mask"][data-line-id="${lid}"]`,
                  )
                  .join(",") + "{visibility:hidden}"}
              {active.length > 0 &&
                active.map(([lid]) => `[data-layer="mask"][data-line-id="${lid}"]`).join(",") +
                  "{visibility:hidden}"}
              {active
                .map(
                  ([lid]) =>
                    // ★ 区间外 span 默认隐藏（canvas 原文承担显示 ⇒ 其他格零重影）；
                    //   区间内 span（data-cell-inrange）可见（显新值）。旧字遮盖由
                    //   **整格白块**（下方 cell-committed-mask）承担——逐字符白底盖不住
                    //   advance 错位后的旧字边缘（用户缺陷「字体不同 + 残留」）。
                    `[data-layer="overlay"][data-line-id="${lid}"]{visibility:hidden;position:relative;z-index:0;background:transparent;box-shadow:none}` +
                    `\n[data-layer="overlay"][data-line-id="${lid}"][data-cell-inrange="1"]{visibility:visible}`,
                )
                .join("\n")}
            </style>
            {/* ★ 2026-10-23（用户缺陷「字体样式不同 + 原文本残留」）：**整格白块**——
                几何 = 编辑格 cellBox（页容器局部坐标，面打开时 segment DOM 实测），
                上扩 1.5px / 下扩 2px（盖住 canvas 旧字墨迹的全部边缘——span 与 canvas
                有 ~2.4px 基线差 + advance 错位 ⇒ 逐字符白底必有漏缝）。
                ★★ 2026-10-24（用户缺陷「编辑后字体不一样 + 原文残留重影」）：左右由
                「内缩 1px」改为**外扩 3px**——cellBox 是 DOM 面盒，与 canvas 旧墨迹
                存在 advance 级错位（逐字符累积 ~2px/行宽），内缩会让旧墨迹两侧边缘
                露出 = 残留重影（实测 mask [404,442] vs 旧墨迹 [403,~445+]）。外扩 3px
                的安全边界：真实表格列间隙 ≥18px（墨迹缘→竖线 ~9px），首列墨迹→左边框
                ≥6px ⇒ 3px 外扩不触碰任何表格线。**Portal 到 background 容器**（glyph
                span 的定位祖先）⇒ 与 span 同坐标系；z10 = canvas(z0) 之上、glyph(z30) 之下。 */}
            {createPortal(
              active.flatMap(([lid, bands]) =>
                bands.map((box, bi) => (
                  <div
                    key={`cellmask-${lid}-${bi}`}
                    data-layer="cell-committed-mask"
                    data-mask-source={lid}
                    style={{
                      position: "absolute",
                      left: box.x - 3,
                      top: box.y - 1.5,
                      width: Math.max(box.width + 6, 4),
                      height: box.height + 3.5,
                      background: "#fff",
                      pointerEvents: "none",
                      zIndex: 10,
                    }}
                  />
                )),
              ),
              document.querySelector('[data-layer="background"]') ?? document.body,
            )}
          </>
        );
      })()}
      {/* ★★ 2026-10-25（用户缺陷「在这行增加了 de 后，把下一行变成了空白」）：
          segment 提交溢出位移层 —— 编辑行 Core 重排溢出原行盒时，下方被 mask 覆盖的
          legacy 行在此清带（z10 白块）+ 位移重绘（z11 文本）。机制与门控见
          segFlowOverlays effect 注释；坐标 = 页局部（background 容器，与
          cell-committed-mask 同空间同滚动语义）。常规提交（无溢出）零渲染。 */}
      {(() => {
        const session = coreInputSessionRef.current;
        if (!session || Object.keys(segFlowOverlays).length === 0) return null;
        const applied = session.history.appliedCount;
        // ★ 2026-10-25（用户缺陷「添加文本后编辑下一行出现重复文本」）：
        //   位移重绘行的文本如果**正是当前编辑目标**（用户点开该行编辑面），其显示由
        //   编辑面（contenteditable 白底）承担——segflow-line 若继续渲染，会与编辑面
        //   同时可见 = 同一段文字出现两份（实测探针 novdup：面 @legacy 位 + 重绘
        //   @位移位并存）。与 C3 多快照的 explicitUnitSurface 豁免同语义（单段路径
        //   孪生缺口）。清带保留（盖 canvas 旧墨迹，编辑面关闭前仍需要）。
        let editingFlowLineId: string | null = null;
        if (editingSegmentId != null) {
          const seg = segmentsRef.current.find((s) => s.id === editingSegmentId);
          editingFlowLineId = seg?.source?.lineId ?? null;
        }
        // ★ 2026-10-25（用户缺陷「翻页再返回后 2021 残留在 2022 下面」）：本层的重绘文本
        //   取自 **legacy 文档** —— 对 Core-owned 已编辑行是陈旧文本（实测编辑 2021→2022
        //   后本层仍画 "dezembro de 2021"）。已改写行的显示由其**自身 segment**（transform
        //   跟随位移）承担 ⇒ 本层跳过其文本行（清带保留盖 canvas 旧墨迹），同时消灭双绘。
        const modifiedFlowLineIds = new Set(
          segments
            .filter((s) => s.text !== s.originalText && s.source?.lineId != null)
            .map((s) => s.source!.lineId!),
        );
        const out: React.ReactElement[] = [];
        for (const [key, entry] of Object.entries(segFlowOverlays)) {
          if (applied < entry.appliedIndex) continue; // undo 过头 ⇒ 隐藏（redo 回来 ⇒ 重现）
          if (entry.pageIndex !== page) continue; // 翻页门控
          for (const c of entry.clears) {
            out.push(
              <div
                key={`${key}-clear-${c.sourceLineId}`}
                data-layer="segflow-clear"
                data-clear-source={c.sourceLineId}
                style={{
                  position: "absolute",
                  left: c.x,
                  top: c.y,
                  width: Math.max(c.w, 4),
                  height: Math.max(c.h, 4),
                  background: "#fff",
                  pointerEvents: "none",
                  zIndex: 10,
                }}
              />,
            );
          }
          for (const l of entry.lines) {
            if (editingFlowLineId && l.sourceLineId === editingFlowLineId) continue;
            if (modifiedFlowLineIds.has(l.sourceLineId)) continue; // ★ 已改写行：自身 segment 承担显示
            out.push(
              <div
                key={`${key}-line-${l.sourceLineId}`}
                data-layer="segflow-line"
                data-overlay-source={l.sourceLineId}
                style={{
                  position: "absolute",
                  left: l.x,
                  top: l.y,
                  width: Math.max(l.w, 4),
                  height: Math.max(l.h, 4),
                  background: "#fff",
                  color: "#111",
                  fontSize: l.fontSize > 0 ? l.fontSize : 14,
                  fontFamily: l.fontFamily || undefined,
                  lineHeight: `${Math.max(l.h, 4)}px`,
                  whiteSpace: "pre",
                  overflow: "visible",
                  // ★ 必须显式 auto：background 容器（portal 目标）pointer-events:none，
                  //   不声明会**继承** none ⇒ 永远不可命中（实测 linePE=none）。
                  pointerEvents: "auto",
                  cursor: "text",
                  zIndex: 11,
                }}
                onMouseDown={(ev) => {
                  // 拦截 mousedown 冒泡：否则「点击 segment 外 ⇒ 退出编辑」的 document
                  // 监听会在 pointerdown setState 之后、click 之前把状态重置回 null
                  // （实测 ceCount=0 的根因）。
                  ev.stopPropagation();
                }}
                onClick={(ev) => {
                  // ★ 2026-10-25（用户缺陷「编辑框和文本没有重合…文本不能点击进入编辑态」）：
                  //   位移行的**唯一显示来源**是本重绘层（未编辑行 glyph span 不渲染、
                  //   canvas 原文被清带盖住）——pointerEvents:none 使它无法进入编辑，
                  //   而其 segment 仍在 legacy 原位（与显示位错开 delta）⇒ 点文本无反应。
                  //   修复 = click 时以该行 segment 进入编辑（setEditingSegmentId，与
                  //   PDFCanvas onStartEdit 同一入口）。入口放在 **click** 而非
                  //   pointerdown：pointerdown 里 setState 会被紧随的 mousedown 冒泡
                  //   （点外关闭）重置。stopPropagation 阻断点外关闭看到本次点击；
                  //   点击坐标已由 document 级 pointerdown capture 记录（2B 播种链输入，
                  //   capture 先于本 handler ⇒ 不受 stopPropagation 影响）。
                  ev.stopPropagation();
                  const seg = segmentsRef.current.find((s) => s.source?.lineId === l.sourceLineId);
                  if (!seg) return;
                  setEditingSegmentId(seg.id);
                }}
              >
                {l.text}
              </div>,
            );
          }
        }
        if (out.length === 0) return null;
        return createPortal(out, document.querySelector('[data-layer="background"]') ?? document.body);
      })()}
      {/* ★★ 2026-10-25（用户缺陷「下一行的文本下移到了蓝色编辑框的下面，蓝色编辑框内无文本」）：
          位移行的 segment 命中层/编辑面**跟随位移**。segflow 位移层把行的显示文本重绘到
          +dy 位置（segflow-line z11），但该行的 segment 元素（非编辑态=透明命中层 + 悬停
          虚线框；编辑态=白底编辑面）仍锚 legacy 原位 ⇒ 悬停框（空）留在原位、可见文本在
          下方 = 用户看到的「空蓝框 + 框外文本」；点进去编辑面也开在原位（与显示位错开 dy，
          94847513 已知边界的本环收口）。
          修复 = 对位移行的全部 segment 注入 `transform: translateY(dy)`，与 segflow-line
          同步移动：悬停框 / 点击目标 / 编辑面三者与显示文本重合；编辑面打开时白底恰好
          盖住显示位（该行的 segflow-line 由既有 editingFlowLineId 豁免隐藏，清带保留盖
          canvas 旧墨迹）。
          ⚙️ 用 transform 而非 top：baseStyle 内联 `top`（M7.8-014 系冻结语义），样式表
            无法覆盖；baseStyle 的 transform 恒为 undefined（内联不落属性）⇒ 本规则直接
            生效，且不与 surfaceStyle 的 left/width/height 覆盖冲突（编辑面随元素整体下移）。
          ⚙️ 只动 segment（命中/编辑层），不动 glyph span / mask / edit-unit-mask：后三者
            的几何分别来自 Core 布局与 legacy bbox（子任务 3 口径），各自职责不变。
          门控与 segflow 渲染层完全一致（session + appliedIndex + 页号）：undo 过头 / 翻页
          ⇒ 规则卸载 ⇒ segment 回到 legacy 原位（与 canvas 原文恢复同步）。 */}
      {(() => {
        const session = coreInputSessionRef.current;
        if (!session || Object.keys(segFlowOverlays).length === 0) return null;
        const applied = session.history.appliedCount;
        const rules: string[] = [];
        for (const entry of Object.values(segFlowOverlays)) {
          if (applied < entry.appliedIndex) continue; // undo 过头 ⇒ 与 segflow-line 一起消失
          if (entry.pageIndex !== page) continue; // 翻页门控
          for (const l of entry.lines) {
            const dy = Math.round(l.dy * 100) / 100;
            if (!(dy > 0)) continue;
            // ★ 2026-10-25（用户缺陷「翻页再返回后样式漂移」）：必须读**响应式 segments**
            //   而非 segmentsRef —— 翻页返回会重解析 segment（id 随机后缀重新生成），而
            //   segmentsRef 由 effect 滞后一拍同步 ⇒ 渲染新 segment 的那一帧 ref 仍持旧
            //   数组 ⇒ 规则瞄准已死 id ⇒ 注入永久失效（pre-wrap/transform 全丢）。
            for (const seg of segments) {
              if (seg.source?.lineId !== l.sourceLineId) continue;
              rules.push(`[data-segment-id="${seg.id}"]{transform:translateY(${dy}px)}`);
            }
          }
        }
        if (rules.length === 0) return null;
        return <style>{rules.join("\n")}</style>;
      })()}
      {/* ★★ 2026-10-25（用户缺陷「编辑框内文本 2 行，提交后只有 1 行 ⇒ 重排新增行空白」）：
          **提交态多行渲染**（Fix B 消费侧；采集 = committedMultilineWidths 快照 effect）。
          根因：单段提交后被改写 segment 以自身文本渲染（isModified ⇒ showText），而
          baseStyle 的 `white-space: nowrap`（M7.8-014B）使其恒 1 行；Core 布局已重排
          为 N 行（segflow 据此正确位移后继）⇒ 第 2..N 行内容无处渲染 = 空白带，且与
          编辑面（pre-wrap 多行）格式不一致。
          修复 = 对「有面宽快照且已改写」的行 segment 注入
            `white-space: pre-wrap !important; width: <快照宽>px !important`
          （baseStyle 内联 nowrap/width ⇒ 必须 !important）。提交态元素与编辑面是
          **同一元素同一几何** ⇒ 换行点按构造一致；overflow 非 editing 态本就 visible
          ⇒ 第二行自然显示（z100 > mask z40）。`:not([contenteditable="true"])` 排除
          编辑态 —— 编辑态由 surfaceStyle 内联接管（避免快照滞后一帧与内联宽度竞争）。
          门控：segment.text !== originalText（undo 回原文 ⇒ 门关，快照残留无害）；
          仅单段面快照（unit 行有 C3 通道）；re-import 清空。
          已知边界：行仍只以首行盒参与命中（点第二行文本不进入编辑 —— 点首行即可，
          整行同一 segment）。 */}
      {(() => {
        const entries = Object.entries(committedMultilineWidths);
        if (entries.length === 0) return null;
        const rules: string[] = [];
        for (const [lid, w] of entries) {
          if (!(w > 0)) continue;
          // ★ 2026-10-25（翻页往返样式漂移）：读**响应式 segments**（同 transform 块注释
          //   —— 翻页返回重解析 segment id，segmentsRef 滞后一拍 ⇒ 注入瞄准死 id 失效）。
          for (const seg of segments) {
            if (seg.source?.lineId !== lid) continue;
            if (seg.text === seg.originalText) continue; // 未改写/已 undo ⇒ 不注入
            rules.push(
              `[data-segment-id="${seg.id}"]:not([contenteditable="true"]){white-space:pre-wrap !important;width:${w}px !important}`,
            );
          }
        }
        if (rules.length === 0) return null;
        return <style>{rules.join("\n")}</style>;
      })()}
      {explicitUnitSurface &&
        editMaskRects.map((m, i) => (
          <div
            key={`editmask-${m.lineId}-${i}`}
            data-layer="edit-unit-mask"
            data-mask-source={m.lineId}
            style={{
              position: "fixed",
              left: m.cssX,
              top: m.cssY,
              width: Math.max(m.cssW, 4),
              height: Math.max(m.cssH, 4),
              background: "#fff",
              pointerEvents: "none",
              zIndex: 10,
            }}
          />
        ))}
      {/* ── D-3B-6 缺陷 A 修复（2026-10-16）：成员行原始 glyph span 的精确隐藏 ──
          根因（只读诊断实证）：glyph 层按 Core 布局重排后，变更行的折行字形（如「补」）
          会落到清除矩形之外（DOM 内联折行逃逸），与 C3 overlay 的 flow 行同时可见 ⇒
          视觉上同字重复。修复 = 按 C3 清除计划的 sourceLineIds **精确**隐藏对应 glyph
          span（span 自带 data-line-id ⇒ 零猜测映射；不含该 lineId 的 span 一律不触碰，
          未命中即保持现状 = fail-closed）。
          ★ 同族扩展：GlyphRenderer 的编辑行 **mask div**（data-layer="mask"，白底、
            z40、几何=编辑后行盒）同样不随切页卸载 ⇒ 在非目标页擦除他人内容（实测抹掉
            第 2 页「3.女子全能」行上半）——用同一 lineId 选择器一并隐藏。
          ★ 生命周期：**只跟随 appliedIndex（不随页门控）** —— 「成员行旧字形已被清除/
            重绘取代」是文档状态下的持久事实，切页后 span/mask 也不得复活（否则在非
            目标页露出残影/擦除带）；undo 过头 ⇒ style 卸载 ⇒ 自动恢复；redo ⇒ 再隐藏。
            页 1 上 mask 隐藏后原墨迹仍由 C3 clear 矩形（z45 > glyph 容器 z30）覆盖。
          不扩大白色清除矩形、不改 Core 文本 / flow 排版 / glyph 身份映射 / 导出内容流。 */}
      {/* ★★ 2026-10-19（用户缺陷「跨页文本叠加」）：hideLineIds 的 style **无条件渲染**
          （只要存在有效快照）——span/mask 隐藏是文档状态下的**持久事实**（2026-10-16
          缺陷 A 语义：只跟随 appliedIndex，不随页门控），**编辑面打开与否、当前显示
          哪一页都不得影响**。实测（p2g 探针）：编辑行 Core glyph span（z50，
          `position:absolute` 页内坐标）在翻页后落进新页视口（lid=p1_l5 的"期"字出现在
          第 2 页 y=140），而旧实现把 style 挂在 `!explicitUnitSurface` 门内 ⇒ 编辑面
          一打开 style 即卸载 ⇒ span 复活 ⇒ 跨页文本叠加。 */}
      {(() => {
        const mergedHide = mergeCommittedOverlays();
        if (!mergedHide || !coreInputSessionRef.current) return null;
        return (
          <style>
            {mergedHide.hideLineIds
              .map(
                (lid) =>
                  `[data-layer="overlay"][data-line-id="${lid}"],[data-layer="mask"][data-line-id="${lid}"]{visibility:hidden}`,
              )
              .join("\n")}
          </style>
        );
      })()}
      {/* ★★ 2026-10-24（用户缺陷「第 1 页修改后的文本显示在第 2 页」）：**单段提交行**
          的跨页泄漏修复。单段（非 unit/cell）提交路径不产生 C3 快照 ⇒ 其行不在
          hideLineIds ⇒ glyph span（z50，页内坐标）与 mask（z40）在翻页后跨页持续可见
          （实测探针 leak1024b：页 1 编辑 l20 后翻页 2，67 个元素跨页可见——66 个 span
          含新文本 + 1 个 mask；unit 编辑行因 hideLineIds 覆盖而不泄漏，与用户截图
          「泄漏的恰是两个单段编辑的 bullet 行」一致）。
          修复 = 按**行所属页**（lineId 自带 `pdf_p<N>_` 前缀，与 cell 显示块同款解析）
          门控：非当前显示页 ⇒ 隐藏该行的 span + mask；当前显示页**不新增任何规则**
          （页内「mask 盖原文 + span 显新值」显示机制逐字节不变）。
          纯增量 hidden 规则：与 hideLineIds（无条件隐藏）组合安全——CSS 中任一
          hidden 即隐藏，绝不把已隐藏的层变回可见。unit 行在 hideLineIds 内 ⇒ 跳过
          （其显示由 C3 overlay 承担）；cell 行与其 stale 页规则重复但同向无害。 */}
      {(() => {
        if (editedLineBoxes.size === 0) return null;
        const mergedHide = mergeCommittedOverlays();
        const hideSet = new Set(mergedHide ? mergedHide.hideLineIds : []);
        const rules: string[] = [];
        for (const lid of editedLineBoxes.keys()) {
          if (hideSet.has(lid)) continue;
          const m = /pdf_p(\d+)_/.exec(lid);
          if (!m) continue;
          if (Number(m[1]) === page) continue;
          rules.push(
            `[data-layer="overlay"][data-line-id="${lid}"],[data-layer="mask"][data-line-id="${lid}"]{visibility:hidden}`,
          );
        }
        if (rules.length === 0) return null;
        return <style>{rules.join("\n")}</style>;
      })()}
      {/* 多快照的清除矩形 / overlay 行：编辑面打开时**只**跳过当前编辑 unit 的快照
          （其显示由编辑面白底承担，z101 盖住），其他 unit 的已提交显示持续渲染。
          ★ 2026-10-24（用户缺陷「再编辑另一段时先前编辑的文本不见」）：旧门
          `explicitUnitSurface` 是一刀切——打开任何编辑面就停渲染**全部**快照，而
          hideLineIds（无条件隐藏）持续隐藏这些行的 span/mask ⇒ 先前编辑的行回退为
          canvas 原文（实测探针 leak1024c：提交日期段后 overlays=2/clears=2；打开
          「1.男子」段面后 overlays=0/clears=0，日期段回显原值「6 天」、追加文本消失）。
          新门按 unitId 过滤：同一 unit 的旧快照仍跳过（重新进入同段编辑时面承担显示）。 */}
      {(() => {
        const merged = mergeCommittedOverlays();
        if (!merged || !coreInputSessionRef.current) return null;
        const editingUnitId = explicitUnitSurface?.unitId ?? null;
        const clears = merged.clears.filter(
          (c) => page === c.pageIndex && c.unitId !== editingUnitId,
        );
        const lines = merged.lines.filter(
          (l) => page === l.pageIndex && l.unitId !== editingUnitId,
        );
        if (clears.length === 0 && lines.length === 0) return null;
        return (
          <>
            {clears.map((c) => (
                <div
                  key={`c3clear-${c.unitId}-${c.sourceLineId}`}
                  data-layer="committed-unit-clear"
                  data-clear-source={c.sourceLineId}
                  data-commit-doc-y={c.cssY + c.commitScrollY}
                  style={{
                    position: "fixed",
                    left: c.cssX,
                    top: c.cssY + c.commitScrollY - commitScrollNow(),
                    width: Math.max(c.cssW, 4),
                    height: Math.max(c.cssH, 4),
                    background: "#fff",
                    pointerEvents: "none",
                    zIndex: 45,
                  }}
                />
              ))}
            {lines.map((l) => (
                <div
                  key={`c3-${l.unitId}-${l.sourceLineId}`}
                  data-layer="committed-unit-overlay"
                  data-overlay-source={l.sourceLineId}
                  data-commit-doc-y={l.cssY + l.commitScrollY}
                  style={{
                    position: "fixed",
                    left: l.cssX,
                    top: l.cssY + l.commitScrollY - commitScrollNow(),
                    width: Math.max(l.cssW, 4),
                    height: Math.max(l.cssH, 4),
                    background: "#fff",
                    color: "#111",
                    // C 收尾：字号/字体来自锚 segment 计算样式（真实排版事实）。
                    //   旧实现硬编码 21.4574px 与真实行尺寸不符 ⇒ overflow:hidden 裁断新文本
                    //   （实测 "地点：茂名市。" 只显示 "地点：茂名"）。缺失时回退旧值（fail-open）。
                    fontSize: l.fontSize > 0 ? l.fontSize : 21.4574,
                    fontFamily: l.fontFamily || undefined,
                    lineHeight: `${Math.max(l.cssH, 4)}px`,
                    whiteSpace: "pre",
                    // C 收尾：不裁断。DOM 字宽 ≈ PDF advance（±2%，长数字/拉丁行实测 +7px），
                    //   overflow:hidden 会把末字符裁掉一半（实测 l13/l14/l16/l20 scrollWidth
                    //   超出 7px）。放行溢出 ⇒ 文本完整；溢出方向是行尾右侧空白边距，
                    //   与 segment 层对同一文本的渲染一致，不构成遮挡。
                    overflow: "visible",
                    pointerEvents: "none",
                    zIndex: 45,
                  }}
                >
                  {l.text}
                </div>
              ))}
          </>
        );
      })()}
      {/* ── 顶部 Header Bar：Logo + 模式指示器 + Download ── */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 20px",
        background: "linear-gradient(90deg,#f8fafc,#f1f5f9)",
        borderBottom: "1px solid #e2e8f0",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Bug 6: 编辑器页面增加 PDFAIDE Logo */}
          <PdfAideLogo size={38} />
          {pdfDoc && (
            <span style={{ fontSize: 12, color: "#64748b" }}>{fileName}</span>
          )}
          {/* Bug 9 + 16: 显示当前模式 */}
          {currentModeInfo && (
            <span style={{
              fontSize: 12,
              fontWeight: 600,
              color: currentModeInfo.color,
              background: currentModeInfo.bg,
              padding: "4px 12px",
              borderRadius: 12,
              border: `1px solid ${currentModeInfo.color}33`,
            }}>
              {currentModeInfo.label}
            </span>
          )}
        </div>
        <DownloadButton handleExport={handleExportWithCommit} disabled={!pdfDoc} />
      </div>
      <div style={{ display: "flex" }}>
        {/* ── 左侧缩略图面板（可收展） ── */}
        <PageThumbnails />

        {/* ── 中间：画布区 ── */}
        <div style={{ flex: 1 }}>
        {/* TOOLBAR */}
        <MainToolbar
          handleUpload={handleUpload}
          addBlock={addBlock}
          imageInputRef={imageInputRef}
          handleImageSelect={handleImageSelect}
          handleOCR={handleOCR}
          pdfBytesRef={pdfBytesRef}
          processInline={processInline}
          exitEditMode={exitEditMode}
          onConvertClick={onConvertClick}
        />

        {/* V12: Find & Replace 面板 */}
        {showFindReplace && (
          <FindReplaceBar onClose={() => setShowFindReplace(false)} />
        )}

        {/* CANVAS */}
        {pdfLoading && (
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
            /* Issue-002 (P0, Release QA): 不透明背景完全覆盖底层的 "Upload a PDF" 空态文案，
               避免 "Loading + Upload" 矛盾 */
            background: "#ffffff",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            zIndex: 9998,
          }}>
            <div style={{
              width: 48, height: 48,
              border: "4px solid #e2e8f0",
              borderTopColor: "#3b82f6",
              borderRadius: "50%",
              animation: "spin 0.8s linear infinite",
            }} />
            {/* Issue-002 (P0, Release QA): Loading 文案与状态一致，避免 "Loading PDF + Upload a PDF" 矛盾 */}
            <p style={{ marginTop: 16, fontSize: 14, color: "#64748b" }}>Opening your document, please wait...</p>
            <p style={{ marginTop: 4, fontSize: 12, color: "#94a3b8" }}>Parsing PDF &amp; preparing the editor…</p>
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
          </div>
        )}

        {/* Issue-003 (P0, Release QA): PDF 加载失败错误态 —— 坏 PDF 2s 内报错，不再无限 Loading */}
        {pdfError && (
          <div style={{
            position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
            background: "rgba(255,255,255,0.97)",
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            zIndex: 9999, padding: 32, textAlign: "center",
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "#fee2e2", color: "#dc2626",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 28, marginBottom: 16,
            }}>!</div>
            <p style={{ fontSize: 17, fontWeight: 600, color: "#1e293b", marginBottom: 8 }}>无法打开这个 PDF</p>
            <p style={{ fontSize: 14, color: "#64748b", maxWidth: 420, marginBottom: 20 }}>{pdfError}</p>
            <button
              onClick={() => setPdfError(null)}
              style={{
                padding: "10px 24px", borderRadius: 8, background: "#3b82f6",
                color: "#fff", fontSize: 14, fontWeight: 600, border: "none", cursor: "pointer",
              }}
            >Try another file</button>
          </div>
        )}
        <PDFCanvas
          canvasRef={canvasRef}
          wrapperRef={wrapperRef}
          dragRef={dragRef}
          resizeRef={resizeRef}
          addBlock={addBlock}
          // B3-C-5-E-B-B：PDFCanvas 的 image 放置路径不开辟第二套 ingestion，
          // 而是复用 MainToolbar 的文件选择器 → handleImageSelect → Core commit。
          requestImageFile={() => imageInputRef.current?.click()}
          deleteImage={deleteImage}
          handleOCRRegion={handleOCRRegion}
          handleUpload={handleUpload}
          exitEditMode={exitEditMode}
          // OCR-EDIT-SYNC: 段落块 Portal 编辑提交 → 同步回 EditableDocument
          onBlockTextCommit={commitBlockTextToDocument}
          enableClickToEdit={!!ocrTaskId || !!editableDocumentRef.current}
          // EDITOR-CORE-012-A：commands / styles **成对**来自 renderSource
          // （flag off 时为 legacy 原引用；flag on 时为 Core glyph + legacy 非 glyph）
          glyphCommands={renderSource.commands}
          docStyles={renderSource.styles}
          sceneReady={sceneReady}
          sceneReadyBase={sceneReadyBase}
          // F3B-6.19-C（C3）：presentation ownership 由 **当前状态**（`corePresentationActive`）
          // 决定，**不再**由「历史上是否用过 Core input」（旧 `coreInputActive`，sticky）决定。
          // 不可用 / 过期 ⇒ fail-closed 到既有（legacy）几何来源。
          caretPosition={
            // ★ 2026-10-25（用户缺陷「编辑态编辑框外还有一条随光标移动的竖线」）：
            //   任何 contentEditable 编辑面（segment/unit/cell，全部经 editingSegmentId
            //   打开）期间必须隐藏 CaretLayer —— 面内有浏览器原生光标，CaretLayer 的
            //   字形/Core 度量光标与 DOM 面几何不同源，位置会漂出面外 = 双光标。
            //   与 PDFCanvas M7.7-004B 的 `textEdit` 隐藏门同语义（该门只覆盖旧 textarea
            //   面；PDFCanvas 冻结 ⇒ 在 prop 源隐藏）。非编辑态行为不变。
            editingSegmentId != null
              ? null
              : corePresentationActive
                ? coreCaretPosition
                : resolveCaretPosition(editableDocumentRef.current, editSession?.glyphCaret)
          }
          selectionHighlight={
            corePresentationActive
              ? coreSelectionHighlight
              : selectionHighlightQuads(editableDocumentRef.current, editSession)
          }
          // M7.7-003: 拖选浮层 Action Menu（SelectionActionMenu，位置 + 操作回调）
          selectionMenu={selectionMenu}
          onMenuEditText={handleMenuEditText}
          onMenuCopy={handleMenuCopy}
          onMenuAskAI={handleMenuAskAI}
          onMenuDismiss={() => setSelectionMenu(null)}
          editSession={editSession}
          onKeyboardEdit={handleKeyboardEdit}
          onPaste={handlePasteEdit}
          // M7.7-004 (Bug2): textarea DOM caret → session caret 同步（末尾点击后输入定位正确）
          onCaretChange={(s: EditSession) => dispatchSession(s)}
          // M7.7-006B (CJK/insertText 回收): 非 ASCII 经浏览器 insertText 改 value，无 keydown 逐字符。
          // 用 applyTextareaValue 全量回收；value===session.text（英文已同步）→ no-op 不打断 keydown 管线。
          onTextInput={(value: string, cursorUtf16: number, s: EditSession) => {
            // M7.7-006B-DIAG
            console.log(`[TXTIN] value=${JSON.stringify(value)} cur=${cursorUtf16} s=${JSON.stringify(s.text)} equal=${value === s.text}`);
            if (value === s.text) return; // 英文 keydown 管线已同步 → 跳过（防重复 lastOp/竞态）
            // F3B-6.17-3C-10C.2：Shadow 观察（整行值回收路径；只读）
            observeTextEditShadow({
              request: { kind: "insert-text", text: value },
              session: s,
              wholeLine: true,
              legacy: { kind: "replace", trigger: "textarea-input", text: value },
            });
            dispatchSession(applyTextareaValue(s, value, cursorUtf16));
          }}
          selectedGlyphIds={selectedGlyphIds}
          // M7.7-003B-002 (Bug2): 已提交编辑过的行 → native-canvas 下也渲染改后文本 overlay
          // M7.7-004U: 行级（editedLines + editedLineBoxes），只重渲染已编辑行，未编辑行保持扫描原样
          editedLines={editedLines}
          editedLineBoxes={editedLineBoxesCoreGeo}
          // F3B-6.4B-P2-A: 当前页文档 line identity（空行没有 RenderCommand，需靠它参与 mask identity matching）
          documentPageLineIds={documentPageLineIds}
          onGlyphClick={(info: GlyphClickInfo) => {
            // Sprint 50 Fidelity Debug：仅 debug 模式附加记录，不改变默认选中/编辑行为
            if (isFidelityDebug) {
              setDebugGlyph({ glyph: info.glyph as any, index: info.index });
            }
            // Task 2: click selection — 选中单个 glyph
            const glyphId = `${info.glyph.blockId}__${info.glyph.lineId}__${info.index}`;
            setSelectedGlyphIds(new Set([glyphId]));

            // B-3 埋点：Selection Count
            recordWorkspaceEvent("selection", {
              blockId: info.glyph.blockId,
              textLen: info.glyph.char.length,
            });

            // Sprint 33: Use layoutDocument for layout-aware editing
            const blockId = info.glyph.blockId;
            const lineId = info.glyph.lineId;

            // M7.7-005: 点击画布内【文字】= 离开当前编辑 → 先提交 active 编辑，再处理新点击。
            // 否则 openTextEditSession(新 target) 替换 session → 旧 blur 因 target 不同跳过保存 → 丢输入。
            // 仅当：①有 active 编辑 ②文本有改动 ③点击目标不同于当前编辑行（同行点击=仅移光标，不提交）。
            // 空白点击不经过本 handler（boundary 未命中），由 blur 兜底保存。
            const activeBeforeClick = editSessionRef.current;
            if (
              activeBeforeClick &&
              activeBeforeClick.status === "active" &&
              activeBeforeClick.text.trim() !== activeBeforeClick.originalText &&
              (activeBeforeClick.target.blockId !== blockId || activeBeforeClick.target.lineId !== lineId)
            ) {
              // console.log("[M7.7-005] canvas click while editing → commit first:", blockId, lineId);
              requestEditTransition("CLICK_OTHER_TEXT");
            }

            if (layoutDocument) {
              const target = findEditTarget(layoutDocument, blockId, lineId);
              if (target) {
                // M7.7-IMPLEMENT-001: 点击直接进入编辑（Adobe Click → Caret）——
                // 用点击位置（info.screenX）推导 glyph 级光标，创建 text-edit session（整行 working text，
                // collapsed caret 落在点击字符），并统一走 openTextEditSession 清 pendingEdit/currentSelection。
                const lineGlyphs = glyphCommands
                  .filter(isDrawGlyph)
                  .filter((c) => c.blockId === blockId && c.lineId === lineId);
                // M7.7-004X (Bug2): 文档检测字体 —— glyph.styleRef → editableDocument.styles[styleRef].fontFamily。
                // 编辑框必须用文档字体（否则系统默认字体更宽 → 编辑框被撑宽 + 样式不一致，连锁 Bug1/2/3）。
                const docStyles = editableDocumentRef.current?.styles;
                const lineFontFamily = docStyles && lineGlyphs[0] ? docStyles[lineGlyphs[0].styleRef]?.fontFamily : undefined;
                // B2-R1 / F3B-6.24-C：open 与 save 共用 Core 文本来源，门控与 save 对称（readCoreTextEditInputFlag）。
                // 与 save 路径一致：Core 不可用时（flag off / 无 Core 文档）回落 Legacy，保证 open↔save 同源。
                const coreTextForOpen =
                  readCoreTextEditInputFlag() && coreDocumentRef.current != null
                    ? resolveCoreLineText(coreDocumentRef.current, lineId, lineIdParagraphMapRef.current)
                    : null;
                const fullLineText = coreTextForOpen ?? lineGlyphs.map((g) => g.char).join("");
                if (fullLineText) {
                  const caret = glyphCaretFromClick(lineGlyphs, info.screenX);
                  const caretChar = caretCharOffsetOf(caret);
                  const range = {
                    blockId,
                    lineId,
                    startGlyphIndex: 0,
                    endGlyphIndex: Math.max(0, lineGlyphs.length - 1),
                  };
                  // M7.7-003B-002: 编辑框 bbox 用「被点行」自身的 glyph 包围盒，而不是 findEditTarget 的
                  //   paragraph 级 bbox（paragraph 会覆盖整段多行 → 编辑框出现在段落顶部而非点击的那行文字上）。
                  //   lineGlyphs 是当前页与该行同 domain 的命令（CSS 坐标，与 overlay 同空间），直接取并集。
                  //   注意：reduce 用 minX/minY/maxX/maxY 四值累计，最后再算 width/height（避免 0/Infinity 初始值导致宽高变 Infinity）。
                  const lineBoxAcc = lineGlyphs.reduce<{
                    minX: number; minY: number; maxX: number; maxY: number;
                  }>(
                    (acc, g) => ({
                      minX: Math.min(acc.minX, g.x),
                      minY: Math.min(acc.minY, g.y),
                      maxX: Math.max(acc.maxX, g.x + g.width),
                      maxY: Math.max(acc.maxY, g.y + g.height),
                    }),
                    { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
                  );
                  const lineBox = {
                    x: lineBoxAcc.minX,
                    y: lineBoxAcc.minY,
                    width: lineBoxAcc.maxX - lineBoxAcc.minX,
                    height: lineBoxAcc.maxY - lineBoxAcc.minY,
                  };
                  // 行包围盒非法（空行 / 无尺寸）→ 回退 paragraph 级 bbox
                  const safeBox =
                    Number.isFinite(lineBox.x) && Number.isFinite(lineBox.y) &&
                    Number.isFinite(lineBox.width) && Number.isFinite(lineBox.height) &&
                    lineBox.width > 0 && lineBox.height > 0
                      ? lineBox
                      : target.bbox;
                  // M7.7-011B: EditSession 全链路审计
                  const docRef = editableDocumentRef.current;
                  let docLineGlyphCount = 0;
                  let docMinY = 0, docMaxY = 0;
                  if (docRef) {
                    for (const pg of docRef.pages) {
                      for (const b of pg.blocks) {
                        if (b.id === blockId) {
                          const dl = b.lines.find((l) => l.id === lineId);
                          if (dl && dl.glyphs.length > 0) {
                            docLineGlyphCount = dl.glyphs.length;
                            docMinY = Math.min(...dl.glyphs.map((g: any) => g.bbox.y));
                            docMaxY = Math.max(...dl.glyphs.map((g: any) => g.bbox.y + g.bbox.height));
                          }
                        }
                      }
                    }
                  }
                  const cmdGlyphCount = lineGlyphs.length;
                  const cmdMinY = lineGlyphs.reduce((a: number, g: any) => Math.min(a, g.y), Infinity);
                  const cmdMaxY = lineGlyphs.reduce((a: number, g: any) => Math.max(a, g.y + g.height), -Infinity);
                  // console.log("[M7.7-011B][SESSION_TRUTH]", {
                  //   click: { blockId: info.glyph.blockId, lineId: info.glyph.lineId, char: info.glyph.char, screenX: info.screenX },
                  //   hitTest: { blockId, lineId },
                  //   target: { text: target.text.substring(0, 50), fontSize: target.fontSize },
                  //   safeBox,
                  //   glyphCommands: { count: cmdGlyphCount, minY: cmdMinY, maxY: cmdMaxY },
                  //   editableDoc: { glyphCount: docLineGlyphCount, minY: docMinY, maxY: docMaxY },
                  //   geometryMatch: Math.abs(cmdMinY - docMinY) < 1 && Math.abs(cmdMaxY - docMaxY) < 1,
                  // });
                  // M7.7-012A: 点击位置 vs safeBox vs glyph 范围对比
                  const clickY = info.screenY;
                  // console.log("[M7.7-012A][CLICK_VS_GLYPH]", {
                  //   blockId,
                  //   lineId,
                  //   clickY,
                  //   clickYRelative: clickY - safeBox.y,
                  //   safeBoxY: safeBox.y,
                  //   safeBoxBottom: safeBox.y + safeBox.height,
                  //   cmdMinY,
                  //   cmdMaxY,
                  //   clickToSafeBoxTop: clickY - safeBox.y,
                  //   clickToGlyphTop: clickY - cmdMinY,
                  //   clickToGlyphBottom: cmdMaxY - clickY,
                  //   editableDocMinY: docMinY,
                  //   editableDocMaxY: docMaxY,
                  // });
                  openTextEditSession(
                    blockId,
                    {
                      blockId,
                      text: fullLineText,
                      bbox: safeBox,
                      fontSize: target.fontSize,
                      // M7.7-004X (Bug2): 编辑框用文档字体（否则系统字体 → 样式不一致 + 编辑框过宽）
                      fontFamily: lineFontFamily,
                      // M7.7-003: 行级 transform（首 glyph 携带，行内共享）→ input surface 跟随文字方向
                      transform: lineGlyphs[0]?.transform,
                    },
                    createEditSession(
                      range,
                      fullLineText,
                      [range],
                      caret,
                      // M7.7: 点击即插入编辑 → text-edit（非 replace-selection）
                      "text-edit",
                      { start: caretChar, end: caretChar } // collapsed caret 落在点击字符
                    )
                  );
                  return;
                }
                // 无文本 glyph（空行等）→ 回退 Context Workspace（pendingEdit 保留作 fallback）
                setSelectedText(target.text);
                setSaveStatus("idle");
                setPendingEdit({
                  blockId,
                  text: target.text,
                  bbox: target.bbox,
                  fontSize: target.fontSize,
                  lineId,
                  startGlyphIndex: info.index,
                  endGlyphIndex: info.index,
                });
                console.log("[Sprint33] context workspace ready (empty line, edit deferred to Update Text)");
                return;
              }
            }

            // Fallback to Sprint 32 block-level lookup
            const blocks = buildTextBlocks(glyphCommands);
            setTextBlocks(blocks);
            const target = blocks.find((b) => b.id === blockId);
            if (target) {
              console.log("[Sprint32] click → block resolved (fallback)", { blockId, text: target.text.substring(0, 40) });
              // Context Workspace：同样延迟编辑，等待 "Update Text" 动作。
              setSelectedText(target.text);
              setSaveStatus("idle");
              setPendingEdit({
                blockId,
                text: target.text,
                bbox: target.bbox,
                fontSize: (target as any).fontSize ?? 14,
                // M5-IMPLEMENT-002C-FIX: 忠实传递点击 glyph 的字符级 target
                lineId,
                startGlyphIndex: info.index,
                endGlyphIndex: info.index,
              });
              console.log("[Sprint32] context workspace ready (fallback)");
            }
          }}
          onGlyphSelect={(info: GlyphSelectInfo) => {
            // Task 2: drag selection — 框选多个 glyph
            const ids = new Set<string>();
            info.glyphs.forEach((g, i) => {
              ids.add(`${g.blockId}__${g.lineId}__sel_${i}`);
            });
            setSelectedGlyphIds(ids);
          }}
          onSelectionChanged={(derived) => {
            // Task-013B: 更新当前 DerivedSelection（Provider 消费）
            currentDerivedSelectionRef.current = derived;
            // M7-004A: 把拖选映射为文本选区（SelectionRange），供 debug 暴露 + Route A 兜底。
            // 不做文本回查，直接用 glyphLocalIndex（identity 来自 runtime object）。
            const range = derived && derived.glyphIds.size > 0 ? derivedToSelectionRange(derived) : null;
            // M7.7-003: 拖选后不 setSelectedText/setPendingEdit（不弹 DocumentWorkspace）。
            // 拖选结束的入口 = onDragSelectCommit → SelectionActionMenu（浮层）。
            setCurrentSelection(range);
            if (!range) {
              setCurrentSelection(null);
              setPendingEdit(null);
              setSelectedText(null);
              setWorkspaceIntent(null);
              setSelectionMenu(null);
            }
          }}
          onDragSelectCommit={(derived) => {
            // M7.7-003: 拖选结束（mouseup，真实拖拽）→ 显示 SelectionActionMenu（浮层）。
            // 不再直接 inline、不再弹 Workspace。Edit Text → inline；Ask AI → Workspace。
            // M7.7-005 fix: 双击亦触发 handleMouseUp（用户真实双击的第二次 mouseup 位移 < 5px，
            //   被上述"真实拖拽"门禁排除）→ 不拦截；仅在真实拖拽（位移 > 5px）时弹菜单。
            const range = derived && derived.glyphIds.size > 0 ? derivedToSelectionRange(derived) : null;
            if (!range) {
              setSelectionMenu(null);
              return;
            }
            const block = editableDocumentRef.current?.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === range.blockId);
            const line = block?.lines.find((l) => l.id === range.lineId);
            if (!line) {
              setSelectionMenu(null);
              return;
            }
            const start = Math.max(0, range.startGlyphIndex);
            const end = Math.max(start, Math.min(range.endGlyphIndex, line.glyphs.length - 1));
            const text = line.glyphs.slice(start, end + 1).map((g) => g.char).join("");
            // 菜单锚点 = selection bounding box 的 top/right（世界 CSS 坐标，与 wrapper 同空间）
            let minX = Number.POSITIVE_INFINITY;
            let minY = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let maxY = Number.NEGATIVE_INFINITY;
            for (const b of derived.boxes ?? []) {
              minX = Math.min(minX, b.x);
              minY = Math.min(minY, b.y);
              maxX = Math.max(maxX, b.x + b.width);
              maxY = Math.max(maxY, b.y + b.height);
            }
            if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
              setSelectionMenu(null);
              return;
            }
            setSelectionMenu({ range, text, x: maxX, y: minY });
            // 拖选 = Inline Selection 状态（非 AI 意图、非编辑）→ 关闭 Workspace
            setWorkspaceIntent(null);
            setSelectedText(null);
            setPendingEdit(null);
          }}
          onGlyphDoubleClick={handleGlyphDoubleClick}
          onGlyphEdit={(glyph: DrawGlyphCommand, newText: string) => {
            // Task 3: Document Mutation — 编辑后更新 EditableDocument
            if (!editableDocumentRef.current) return;
            // ── F3B-6.25-E2-Impl：Core owned ⇒ 拒绝 glyph 文本 semantic mutation（禁止文档分裂）──
            //   与 TextEdit / Segment / OCR Block **同契约**：`owned` 后 GlyphRenderer 双击编辑
            //   若继续写 Legacy（mutateLineText → editableDocumentRef 写回），会制造 Core/Legacy
            //   divergence（E1 已封闭的同一 invariant）。
            //   ⇒ 拒绝时：不写 Legacy 文档、不调 mutateLineText、不重建 docBlocks、不调 markLineEdited
            //     （Fidelity 操作也不应误触发）、不翻 exportOwnership（保持 core）。
            //   ⚠️ 判据是 **owned**：未 owned 时 GlyphRenderer 双击编辑路径完整保留。
            if (coreLifecycleRef.current?.owned) {
              console.warn("[F3B-6.25][CORE_OWNED_LEGACY_GLYPH_EDIT_BLOCKED]", {
                reason: "core-owned-legacy-glyph-edit-blocked",
                blockId: glyph.blockId,
                lineId: glyph.lineId,
                owned: true,
              });
              return;
            }

const result = mutateLineText(
              editableDocumentRef.current,
              glyph.blockId,
              glyph.lineId,
              newText
            );
            if (result.mutated) {
              // 更新 EditableDocument（ref + version 触发重渲染）
              editableDocumentRef.current = result.document;
              (window as any).__editableDocument = result.document;
              setEditableDocVersion(v => v + 1);

              // 同步更新 docBlocks（Export 仍依赖 TextBlock）
              setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));

              console.log("[Sprint 6] Document mutated:", {
                blockId: glyph.blockId,
                lineId: glyph.lineId,
                newText,
                modifiedGlyphIds: result.modifiedGlyphIds,
              });

              // M7.8-022 Phase A（glyph layer —— 编辑实际发生的对象）：
              // 本路径此前只调 mutateLineText 更新 EditableDocument，
              // 却从不调 markLineEdited → editedLineBoxes 无该行
              // → 导出 mask 走 fallback（line.bbox ∪ glyph 并集，不含 ascender/descender）
              // → 原 PDF 文字未被完全遮盖（"原文露出 / 修改行下移 / 侵占下一行"）。
              //
              // 这里接入与 TextEditOverlay 相同的统一路径：
              //   glyph edit → markLineEdited → canvas ink scan → editedLineBoxes → mask
              //
              // 时序正确性：canvasRef 是 pdf.js 原始渲染层，不会被 replacement 覆盖，
              // 故此刻扫描得到的仍是**原始墨迹**；而 editableDocumentRef 已更新，
              // 因此 finalBox = originalBox ∪ currentBox 能同时覆盖编辑前后区域。
              if (glyph.blockId && glyph.lineId) {
                markLineEdited(glyph.blockId, glyph.lineId);
              }
            }
          }}
          editingBlockId={editingBlockId}
          // M7.7-004C: 编辑行真实文字覆盖盒（openTextEditSession 扫描 canvas 扩展）→ mask 覆盖真实文字
          editingLineBox={editLineBox}
          textEdit={textEdit}
          onTextEditSave={(textEditSaveRef.current = function commitTextEditSave(blockId: string, newText: string) {
            // ── F3B-6.17-3C-10C.3B（Path B）：本 handler 在**渲染期**被记入 ref ──
            // （见 JSX 属性处的 `textEditSaveRef.current = function …`，
            //   因为 TextEditOverlay 在本 fixture 下不挂载，handler 不会被 React 调用）
            // harness 只调用它（与 TextEditOverlay 的 blur/Enter 同一入口），
            // 不新建第二套输入实现、不 mock Adapter、不直接写文档。

            if (!editableDocumentRef.current) return;
            console.log("[Sprint32] text changed → blockId:", blockId, "newText:", newText.substring(0, 40));

            // M7.7-005: 块定位优先用 active session 自己的 target。
            // 点击切换场景（onGlyphClick 用本函数先提交当前 active 编辑）参数 blockId 是【新点击】目标，
            // 而 active 编辑可能落在别的块；若按参数 blockId 定位会找错块 → 目标行 lineId 不存在 → 静默丢编辑。
            // 遍历 pages 按 session.target.blockId 定位；无 active（普通点击提交）时回退参数 blockId。
            const doc = editableDocumentRef.current;
            const activeForSave = editSessionRef.current;
            const pageIndex = page - 1;
            let block: any = null;
            if (activeForSave && activeForSave.status === "active") {
              for (let pi = 0; pi < doc.pages.length; pi++) {
                const b = doc.pages[pi].blocks.find((x) => x.id === activeForSave.target.blockId);
                if (b) { block = b; break; }
              }
            }
            if (!block) {
              block = doc.pages[pageIndex]?.blocks.find((b) => b.id === blockId) ?? null;
            }
            if (!block) {
              console.warn("[Sprint32] Block not found in document:", blockId);
              setEditingBlockId(null);
              setTextEdit(null);
              return;
            }

            // ── M5-IMPLEMENT-002B + M5-VERIFY-003: EditSession 精确 range commit ──
            // EditSession 存在且 active（单行 block 被 createEditSession 接受）→
            // 用 session 的精确 range mutation（几何保真）。
            // M7.7-001 (Click → Caret): 放宽为"editSession 精确 line target 存在"。
            // 原实现要求 block.lines.length === 1，导致多行 block 中点击单行（如 JENNIFER 所在 2 行 block）SAFE REJECT。
            // 现在用 session target 的稳定 lineId 定位目标行，仅 mutate 该行（单行 range），不影响 block 内其他行。
            // M7.7-005: 用最新 session（ref）而非 props 闭包 —— blur 的 commit 可能在输入
            // setEditSession flush 后触发，props editSession 是旧 render 值 → 会用旧 target/text 提交。
            // editSessionRef.current 每次渲染同步为最新 editSession，handleSave 读到的新文本与之同批次。
            const active = editSessionRef.current;
            if (active && active.status === "active") {
              // F3B-6.17-3C-10C.2：Shadow 观察（commit 观察点；**只读**，在任何 mutation 之前）
              //   真实 UI 语义：Enter / blur 都被 overlay 收敛成 commit（Core 侧等价形态是 insertParagraph）
              {
                const saveLine =
                  block.lines.find((l: EditableLine) => l.id === active.target.lineId) ?? block.lines[0];
                const preText = saveLine
                  ? saveLine.glyphs.map((g: { char?: string }) => g.char ?? "").join("")
                  : "";
                observeTextEditShadow({
                  request: { kind: "insert-paragraph" },
                  session: active,
                  legacy: { kind: "commit", trigger: "commit" },
                  projection: saveLine ? projectLegacyLineEdit({ lineText: preText, newText }) : undefined,
                });
              }
              // ── F3B-6.17-3C-10C.3A：TextEdit commit → Core ────────────────
              //   门控 `__coreTextEditInput`：**ON 是 production default**（C.3B 通过），
              //   只有 **explicit false** 才回到 Legacy EditSession（emergency rollback）。
              //   Core 成功 ⇒ ownership = core、Legacy mutation = 0，直接收尾；
              //   任何失败（no-change / adapter 拒绝 / canonical 链 fail-closed）
              //   ⇒ **继续走下方既有 Legacy 分支**（Legacy 仍是可用 fallback）。
              if (readCoreTextEditInputFlag()) {
                const coreLine =
                  block.lines.find((l: EditableLine) => l.id === active.target.lineId) ?? block.lines[0];
                // B2-R1 + REENTER-SPLIT-01/P9：baseline 必须来自「命令执行目标的同一文档实例」。
                // Core 接管输入路径（beforeinput → adapter）已把本次输入提交进 **session 当前文档**；
                // 若 baseline 仍取 coreDocumentRef（持久化文档，未含 session 内编辑）⇒ LCS diff
                // 产出「第二次插入」⇒ 源 runs 72/40 → 112/80（重复绘制根因）。
                // ⇒ session 存在时 baseline 取 documentOf(session)；缺失时回退持久化文档；
                //    解析失败 ⇒ core-baseline-unresolved（fail-closed 不变）。
                // REENTER-SPLIT-01 / P9：baseline 归一到 session 当前文档（命令执行目标实例）；
                // session 缺失 ⇒ 回退持久化文档（现状）。解析语义由 text-edit-baseline.ts 契约锁定。
                const coreDocForBaseline = (() => {
                  const s = coreInputSessionRef.current;
                  if (s) {
                    try { return documentOf(s); } catch { /* fallthrough */ }
                  }
                  return coreDocumentRef.current;
                })();
                const baselineText =
                  coreDocForBaseline != null
                    ? resolveCoreLineText(coreDocForBaseline, active.target.lineId, lineIdParagraphMapRef.current)
                    : null;
                const baselineGlyphs =
                  coreDocForBaseline != null
                    ? coreLineGlyphs(coreDocForBaseline, active.target.lineId, lineIdParagraphMapRef.current)
                    : null;
                // F3B-6.25-A-Impl：Core baseline 不可用 ⇒ **明确边界**，绝不把 Legacy 行文本
                // （`coreLine.glyphs`）喂给 Core planner —— 那会重演 6.24 前的 silent seam
                // （Core owner 却用 stale Legacy baseline 做 diff ⇒ offset 越界 ⇒ 静默落 Legacy）。
                // 现在：不可解析 ⇒ `core-baseline-unresolved` ⇒ TEXT_EDIT_CORE_FALLBACK ⇒ Legacy commit。
                const corePlan: TextEditCoreCommitPlan | null = !coreLine
                  ? null
                  : coreDocForBaseline == null
                    ? { ok: false, reason: "no-core-document", detail: "coreDocumentRef.current === null" }
                    : baselineText == null || baselineGlyphs == null
                      ? {
                          ok: false,
                          reason: "core-baseline-unresolved",
                          detail: "resolveCoreLineText/coreLineGlyphs === null",
                        }
                      : tryCommitTextEditToCore({
                          blockId: active.target.blockId,
                          lineId: active.target.lineId,
                          lineText: baselineText,
                          newText,
                          glyphs: baselineGlyphs,
                        });
                if (corePlan && corePlan.ok) {
                  // Core 已接管 ⇒ 只做 UI 收尾（**零** Legacy mutation）
                  setSaveStatus("saved");
                  recordWorkspaceEvent("save", { blockId, textLen: newText.length });
                  dispatchSession(null);
                  setEditingBlockId(null);
                  setTextEdit(null);
                  return;
                }
                console.log("[F3B-6.17][TEXT_EDIT_CORE_FALLBACK]", {
                  reason: corePlan ? corePlan.reason : "no-line",
                  detail: corePlan && !corePlan.ok ? corePlan.detail : "",
                });
              }

              // ── F3B-6.25-E1-Impl：禁止文档分裂（Core owned ⇒ 拒绝 Legacy semantic mutation）──
              //   E0 证明：`owned` 后 `shouldRehydrate()` 恒 false ⇒ Legacy 编辑**永不**回补进 Core，
              //   两份文档各自只含一部分编辑，且架构中不存在 merge ⇒ 无论导出走 Core 还是 Legacy 都会丢编辑。
              //   ⇒ fail-closed：拒绝本次编辑（保留此前全部状态），而不是「写入后静默丢失」。
              //   ⚠️ 判据是 **owned**，不是「flag 是否关闭」：
              //        not owned（含 Core OFF 的 emergency rollback）⇒ Legacy mutation 会被 rehydrate 吸收 ⇒ 保留 fallback；
              //        owned                                        ⇒ 必分歧 ⇒ 拒绝。
              //   ⚠️ 本门必须早于任何 `exportOwnershipRef` 写入（否则 ownership 翻成 legacy 却不写入 ⇒ 导出反而丢 Core 编辑）。


              if (coreLifecycleRef.current?.owned) {
                console.warn("[F3B-6.25][CORE_OWNED_LEGACY_TEXT_EDIT_BLOCKED]", {
                  reason: "core-owned-legacy-text-edit-blocked",
                  blockId,
                  lineId: active.target.lineId,
                  owned: true,
                });
                dispatchSession(null);
                setEditingBlockId(null);
                setTextEdit(null);
                return;
              }

              const updated = updateSessionText(active, newText);
              const committed = commitSession(updated);
              const target = committed.target;
              const line = block.lines.find((l) => l.id === target.lineId) ?? block.lines[0];
              if (!line) {
                // console.warn("[M7.7-001] target line not found", target.lineId);
                dispatchSession(null);
                setEditingBlockId(null);
                setTextEdit(null);
                return;
              }
              const lineText = line.glyphs.map((g) => g.char).join("");

              // M5-003C-UI Delete Integration: 最近操作为 delete 且 diff 定位到**单段删除** → 走 TextOperation.delete → applyDelete。
              // 不绕回 M4 replace（replace 保留 suffix 原位 → delete 产生空隙）。
              // 注意：session 是"未提交的 working draft"，document 仍是原行；diff 基于"原行 vs session 最终文本"。
              //   仅当最终文本 = 原行删去一段连续字符（纯单段删除）时才能正确映射 glyph range。
              //   复合编辑（如 replace 后又 delete）diff 会失败 → 回退到下方 M4 replace（保证文本持久化，避免静默丢编辑）。
              let deleteApplied = false;
              if (committed.lastOp === "delete") {
                const delRange = findDeletedGlyphRange(lineText, committed.text);
                if (delRange) {
                  const result = applyTextOperation(editableDocumentRef.current, {
                    type: "delete",
                    blockId: target.blockId,
                    lineId: target.lineId,
                    range: delRange,
                  });
                  if (result.mutated) {
                    editableDocumentRef.current = result.document;
                    (window as any).__editableDocument = result.document;
                    setEditableDocVersion((v) => v + 1);
                    setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));
                    // M7.7-003: 提交后不再 setSelectedText → Workspace 不再弹出（inline-first，右侧不压缩）。
                    setSaveStatus("saved");
                    recordWorkspaceEvent("save", { blockId, textLen: committed.text.length });
                    // M7.7-003B-002 (Bug2): 该行已提交编辑 → native-canvas 下也渲染 overlay，让改后文本可见
                    // M7.7-004U: 行级标记（只重渲染已编辑的行，未编辑行保持 canvas 扫描原样）
                    markLineEdited(target.blockId, target.lineId);
                    deleteApplied = true;
                    // F3B-6.25-D3-Impl（D-1）：Legacy 语义 mutation **真的发生** ⇒ 本次文档导出归属 = legacy。
                    //   否则 Core Export 会接管下载，而这次 Legacy 编辑不在 Core 文档里 ⇒ 下载丢编辑，
                    //   `__coreTextEditInput=false` 的 emergency rollback 因此失效。
                    //   ⚠️ 只在 `result.mutated === true` 内写 ⇒ no-op 编辑不改变 ownership。
                    exportOwnershipRef.current = "legacy";
                    // M6-001C: push delete operation 进 History（供 Ctrl+Z 撤销）
                    pushOperationToHistory(
                      { type: "delete", blockId: target.blockId, lineId: target.lineId, range: delRange },
                      result
                    );
                  }
                }
              }
              if (deleteApplied) {
                dispatchSession(null);
                setEditingBlockId(null);
                setTextEdit(null);
                return;
              }

              // M5-003C-UI: 003C-UI 后 session.text = 整行 working text（非 002D fragment）。
              // 直接传整行给 mutateLineText（M4 full-line 契约），M6-001C 手工构造 replace inverse。
              // 单 caret（start===end）时 target 仅单 glyph，但用户常跨多字符替换/插入，
              // 用整行新文本与旧文本的 LCP/LCS 推断真实编辑区间，避免 suffix 重复/重叠（压缩 bug）。
              let start = target.startGlyphIndex;
              let end = Math.min(target.endGlyphIndex, line.glyphs.length - 1);
              if (start === end) {
                const oldText = line.glyphs.map((g) => g.char).join("");
                let p = 0;
                const minLen = Math.min(oldText.length, newText.length);
                while (p < minLen && oldText[p] === newText[p]) p++;
                let s = 0;
                while (s < oldText.length - p && s < newText.length - p && oldText[oldText.length - 1 - s] === newText[newText.length - 1 - s]) s++;
                start = p;
                end = oldText.length - 1 - s;
                if (start > end) {
                  // 纯插入：空 range，插入点在 start 之前。
                  // 必须保持 end = start - 1；若 start=0 则 end=-1，此时不能 clamp 到 0，
                  // 否则会退化为替换第一个 glyph，破坏插入语义。
                  end = start - 1;
                } else {
                  end = Math.max(0, Math.min(end, line.glyphs.length - 1));
                }
              }
              // M6-001C: 先捕获 beforeGlyphs（range 内原 glyph，供 undo 恢复）
              const beforeGlyphs = line.glyphs.slice(Math.min(start, end), Math.max(start, end) + 1);
              // M7.7-010 Audit-3: Commit 前 glyph 样式诊断（styleRuns + 字符级映射）
              const beforeGlyphData = line.glyphs.map((g, i) => `[${i}]${g.char}->styleRef=${g.styleRef}`);
              const beforeGlyphSummary = beforeGlyphData.length <= 30 ? beforeGlyphData.join(" ") : (
                beforeGlyphData.slice(0, 15).join(" ") + " ... (" + (beforeGlyphData.length - 20) + " chars omitted) ... " + beforeGlyphData.slice(-5).join(" ")
              );
              const beforeStyleRuns: { styleRef: number; text: string; fontWeight: number | string }[] = [];
              let beforeRun: { styleRef: number; text: string; fontWeight: number | string } | null = null;
              for (const g of line.glyphs) {
                const ref = g.styleRef ?? 0;
                const st = editableDocumentRef.current?.styles?.[ref];
                const fw = st?.fontWeight ?? "?";
                if (!beforeRun || beforeRun.styleRef !== ref) {
                  if (beforeRun) beforeStyleRuns.push(beforeRun);
                  beforeRun = { styleRef: ref, text: g.char, fontWeight: fw };
                } else {
                  beforeRun.text += g.char;
                }
              }
              if (beforeRun) beforeStyleRuns.push(beforeRun);
              console.log(`[M7.7-010][COMMIT_BEFORE] lineId="${target.lineId}" glyphs=${line.glyphs.length} runs=${beforeStyleRuns.length}:`, beforeStyleRuns.map(r => `  [styleRef=${r.styleRef} fontWeight=${r.fontWeight}] "${r.text.substring(0, 50)}"`));
              console.log(`[M7.7-010][COMMIT_BEFORE_MAP] lineId="${target.lineId}"\n  ${beforeGlyphSummary}`);

              const result = mutateLineText(
                editableDocumentRef.current,
                target.blockId,
                target.lineId,
                newText, // 整行新文本
                { start, end }
              );

              // M7.7-010 Audit-3: Commit 后 glyph 样式诊断（styleRuns + 字符级映射）
              if (result.mutated) {
                const auditLine = result.document.pages
                  .flatMap((p) => p.blocks)
                  .find((b) => b.id === target.blockId)
                  ?.lines.find((l) => l.id === target.lineId);
                if (auditLine) {
                  const afterGlyphData = auditLine.glyphs.map((g, i) => `[${i}]${g.char}->styleRef=${g.styleRef}`);
                  const afterGlyphSummary = afterGlyphData.length <= 30 ? afterGlyphData.join(" ") : (
                    afterGlyphData.slice(0, 15).join(" ") + " ... (" + (afterGlyphData.length - 20) + " chars omitted) ... " + afterGlyphData.slice(-5).join(" ")
                  );
                  const afterStyleRuns: { styleRef: number; text: string; fontWeight: number | string }[] = [];
                  let afterRun: { styleRef: number; text: string; fontWeight: number | string } | null = null;
                  for (const g of auditLine.glyphs) {
                    const ref = g.styleRef ?? 0;
                    const st = result.document.styles?.[ref];
                    const fw = st?.fontWeight ?? "?";
                    if (!afterRun || afterRun.styleRef !== ref) {
                      if (afterRun) afterStyleRuns.push(afterRun);
                      afterRun = { styleRef: ref, text: g.char, fontWeight: fw };
                    } else {
                      afterRun.text += g.char;
                    }
                  }
                  if (afterRun) afterStyleRuns.push(afterRun);
                  console.log(`[M7.7-010][COMMIT_AFTER] lineId="${target.lineId}" glyphs=${auditLine.glyphs.length} runs=${afterStyleRuns.length}:`, afterStyleRuns.map(r => `  [styleRef=${r.styleRef} fontWeight=${r.fontWeight}] "${r.text.substring(0, 50)}"`));
                  console.log(`[M7.7-010][COMMIT_AFTER_MAP] lineId="${target.lineId}"\n  ${afterGlyphSummary}`);
                }
              }
              if (result.mutated) {
                editableDocumentRef.current = result.document;
                (window as any).__editableDocument = result.document;
                setEditableDocVersion((v) => v + 1);
                // M7.7-007C Audit 2: commit 后 Document 验证
                const auditLine = result.document.pages
                  .flatMap((p) => p.blocks)
                  .find((b) => b.id === target.blockId)
                  ?.lines.find((l) => l.id === target.lineId);
                // console.log("[M7.7-007C][AUDIT2] commit result:", {
                //   page: page,
                //   blockId: target.blockId,
                //   lineId: target.lineId,
                //   newText,
                //   docLineText: auditLine?.glyphs.map((g) => g.char).join("") ?? "(line not found)",
                //   lineGlyphCount: auditLine?.glyphs.length,
                // });
                setDocBlocks((prev) => mergeDocBlocksProjection(prev, renderToBlocks(result.document)));
                // M7.7-003: 提交后不再 setSelectedText → Workspace 不再弹出（inline-first，右侧不压缩）。
                setSaveStatus("saved");
                recordWorkspaceEvent("save", { blockId, textLen: newText.length });
                // M7.7-003B-002 (Bug2): 该行已提交编辑 → native-canvas 下也渲染 overlay，让改后文本可见
                // M7.7-004U: 行级标记（只重渲染已编辑的行，未编辑行保持 canvas 扫描原样）
                markLineEdited(target.blockId, target.lineId);
                // F3B-6.25-D3-Impl（D-1）：同上 —— Legacy 语义 mutation 真的发生 ⇒ 导出归属 = legacy。
                //   （Core plan 失败 / flag OFF 后落到本分支；no-op 时 `result.mutated` 为 false ⇒ 不写。）
                exportOwnershipRef.current = "legacy";

                // M6-001C: 构造 replace inverse（beforeGlyphs + afterGlyphs）并 push 进 History。
                // 关键：operation.text 必须是**replacement fragment**（非整行），
                //       使 redo 的 applyTextOperation.replace 能正确重建整行（ADR-049 fragment 语义）。
                const suffixLen = line.glyphs.length - (end + 1);
                const fragment = newText.slice(start, Math.max(start, newText.length - suffixLen));
                const afterLine = result.document.pages.flatMap((p) => p.blocks).find((b) => b.id === target.blockId)?.lines.find((l) => l.id === target.lineId);
                let afterGlyphs: typeof beforeGlyphs = [];
                if (afterLine) {
                  afterGlyphs = afterLine.glyphs.slice(start, Math.max(start, afterLine.glyphs.length - suffixLen));
                }

                // M7.7-031: Canvas Glyph Replacement Proof — 用 canvas 替代 DOM overlay 验证 ghosting
                // F3B-6.2：以下为像素 / 生命周期审计（M7.7-031 起，约 2000 行）。
                // 默认关闭 —— 关闭时整段不执行；开启时保持原有行为。
                // 生产 mutation / commit / history / export 全部在其前后独立执行，不受本开关影响。
                if (isTextEditAuditEnabled() && afterLine && afterLine.glyphs.length > 0) {
                  const glyphs = afterLine.glyphs;
                  // 计算行的 ink bbox
                  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                  for (const g of glyphs) {
                    if (g.bbox.x < minX) minX = g.bbox.x;
                    if (g.bbox.x + g.bbox.width > maxX) maxX = g.bbox.x + g.bbox.width;
                    if (g.bbox.y < minY) minY = g.bbox.y;
                    if (g.bbox.y + g.bbox.height > maxY) maxY = g.bbox.y + g.bbox.height;
                  }
                  const canvasId = `canvas-replace-${target.lineId}`;
                  // M7.7-034: 唯一实例 ID
                  if (!(window as any).__replacementCanvasInstance) (window as any).__replacementCanvasInstance = 0;
                  const instanceId = `rci-${(window as any).__replacementCanvasInstance++}`;
                  let replaceCanvas = document.getElementById(canvasId) as HTMLCanvasElement | null;
                  if (!replaceCanvas) {
                    replaceCanvas = document.createElement("canvas");
                    replaceCanvas.id = canvasId;
                    replaceCanvas.dataset.instanceId = instanceId;
                    replaceCanvas.dataset.mountedAt = "0";
                    replaceCanvas.dataset.drawCount = "0";
                    console.log("[M7.7-049][CANVAS_LIFECYCLE]", {
                      lineId: target.lineId,
                      action: "CREATE",
                      canvasId,
                      instanceId,
                      mountedAt: null,
                      unmountedAt: null,
                      parent: null,
                      rect: null,
                      drawCount: 0,
                    });
                    replaceCanvas.style.position = "absolute";
                    replaceCanvas.style.zIndex = "50"; // M7.7-069: replacement canvas 高于 mask(40)，已提交新文本可见
                    replaceCanvas.style.pointerEvents = "none";
                    // M7.7-074: canvas 改为 local 0,0；挂载延后到下方 host 块（per-line containing block 承载页坐标）
                    replaceCanvas.style.left = "0px";
                    replaceCanvas.style.top = "0px";
                    console.log("[M7.7-049][CANVAS_LIFECYCLE]", {
                      lineId: target.lineId,
                      action: "CREATE_PENDING_MOUNT",
                      canvasId,
                      instanceId,
                      mountedAt: null,
                      unmountedAt: null,
                      parent: null,
                      rect: null,
                      drawCount: 0,
                    });
                    console.log("[M7.7-034][CREATE_REPLACEMENT]", {
                      lineId: target.lineId,
                      instanceId,
                      timestamp: Date.now(),
                    });
                    console.log("[M7.7-040][CANVAS_CREATE]", {
                      canvasId,
                      instanceId,
                      width: 0,
                      height: 0,
                      timestamp: Date.now(),
                    });
                  }
                  const cw = Math.ceil(maxX - minX);
                  const ch = Math.ceil(maxY - minY);
                  // M7.7-068: Replacement Canvas Viewport Fix
                  // 常量必须在 replaceCanvas.height 赋值之前声明，否则 TDZ ReferenceError 会中断绘制（glyph 不可见 root cause）
                  const MIN_CANVAS_PAD = 0; // M7.7-070: 最小上下内边距为 0；只在 ascent 需要时才向上扩展，避免无意义侵占上一行
                  const EDIT_LAYER_Y_OFFSET = 8; // M7.7-066: 统一垂直偏移（mask/textEdit 用，canvas 不再强制跟随）
                  // M7.7-070: 动态测量本行所有 glyph 的实际 ascent/descent，计算最小 padding。
                  // 目标：screenBaseline = PDF baseline，同时 canvas 侵入上一行的空间最小化。
                  let maxAscent = 0;
                  let maxDescent = 0;
                  const measureCtx = document.createElement("canvas").getContext("2d");
                  const lineBaseline = glyphs[0]
                    ? glyphs[0].baseline ?? afterLine.baseline ?? (glyphs[0].bbox.y + glyphs[0].bbox.height * 0.8)
                    : minY + ch * 0.8;
                  for (const g of glyphs) {
                    const s = result.document.styles[g.styleRef] || {};
                    const family = s.pdfjsFontFamily || s.fontFamily || "sans-serif";
                    const size = s.fontSize || 12;
                    const weight = s.fontWeight || "normal";
                    const fStyle = s.fontStyle || "normal";
                    if (measureCtx) {
                      measureCtx.font = `${fStyle} ${weight} ${size}px ${family}`;
                      const m = measureCtx.measureText(g.char);
                      maxAscent = Math.max(maxAscent, m.actualBoundingBoxAscent || size * 0.6);
                      maxDescent = Math.max(maxDescent, m.actualBoundingBoxDescent || size * 0.2);
                    } else {
                      maxAscent = Math.max(maxAscent, size * 0.6);
                      maxDescent = Math.max(maxDescent, size * 0.2);
                    }
                  }
                  const baselineOffset = lineBaseline - minY;
                  // M7.7-071: LineGeometry Y anchor — 以 baseline + 字体 ascent/descent 建立视觉框，不再依赖 bbox.y 决定 canvas 上沿。
                  const ascent = maxAscent;          // 本行实测最大 ascent
                  const descent = maxDescent;        // 本行实测最大 descent
                  const insetPad = Math.max(MIN_CANVAS_PAD, 3); // 视觉框内边距（≥3px 避免 glyph 顶/底裁切）
                  const inkTop = lineBaseline - ascent;     // glyph ink 上沿
                  const inkBottom = lineBaseline + descent; // glyph ink 下沿
                  const canvasPaddingTop = Math.max(MIN_CANVAS_PAD, Math.ceil(maxAscent - baselineOffset + 0.5));
                  const canvasPaddingBottom = Math.max(MIN_CANVAS_PAD, Math.ceil(maxDescent + 0.5));
                  // M7.7-072: 唯一 LineGeometry — 所有 layer 的 Y 锚点都从这里派生，baseline 不被任何 layer 改变。
                  // glyphLocalBaseline = canvas 内 glyph baseline 位置（与下方 fillText 使用的 glyphLocalY 同公式）。
                  const glyphLocalBaseline = canvasPaddingTop + baselineOffset;
                  // 核心不变量：canvasTop + glyphLocalBaseline === sourceBaseline（永远成立，禁止用 visualTop 替代）
                  const canvasTop = lineBaseline - glyphLocalBaseline;
                  // mask 不参与 glyph 坐标：maskTop = inkTop - padding（仅用于遮罩定位，绘制不依赖它）
                  const maskTop = inkTop - insetPad;
                  // canvas height 必须 >= fontSize + verticalPadding*2；禁止等于 glyph bbox height（会裁切导致不可见）
                  const _repStyle = (result.document.styles && glyphs[0] && result.document.styles[glyphs[0].styleRef]) || {};
                  const _repFontSize = _repStyle.fontSize || 12;
                  const canvasHeight = Math.max(
                    canvasPaddingTop + canvasPaddingBottom + Math.ceil(_repFontSize), // fontSize + verticalPadding*2
                    ch + canvasPaddingTop + canvasPaddingBottom // 覆盖整行 ink bbox，避免上下裁切
                  );
                  replaceCanvas.width = cw;
                  replaceCanvas.height = canvasHeight;
                  // M7.7-074: per-line host 作为 replacement canvas 的 containing block（承载页坐标），canvas 用 local 0,0
                  {
                    const glyphLayer = document.querySelector('[data-layer="glyph"]') as HTMLElement | null;
                    const repHostId = `glyph-renderer-rep-${target.lineId}`;
                    let repHost = document.getElementById(repHostId) as HTMLElement | null;
                    if (!repHost && glyphLayer) {
                      repHost = document.createElement("div");
                      repHost.id = repHostId;
                      repHost.className = "glyph-renderer-replacement";
                      repHost.style.position = "absolute";
                      repHost.style.left = `${minX}px`;       // 页坐标 X
                      repHost.style.top = `${canvasTop}px`;   // 页坐标 Y（= baseline - glyphLocalBaseline，保持 M7.7-072 baseline invariant）
                      repHost.style.width = "0px";
                      repHost.style.height = "0px";
                      repHost.style.pointerEvents = "none";
                      glyphLayer.appendChild(repHost);
                    }
                    if (repHost) {
                      if (replaceCanvas.parentElement !== repHost) repHost.appendChild(replaceCanvas);
                      replaceCanvas.style.left = "0px";        // local
                      replaceCanvas.style.top = "0px";         // local
                      replaceCanvas.dataset.mountedAt = String(Date.now());
                      const mountParent = repHost.tagName.toLowerCase() + (repHost.id ? `#${repHost.id}` : "");
                      const mountRect = replaceCanvas.getBoundingClientRect();
                      console.log("[M7.7-049][CANVAS_LIFECYCLE]", {
                        lineId: target.lineId,
                        action: "MOUNT",
                        canvasId,
                        instanceId: replaceCanvas.dataset.instanceId,
                        mountedAt: replaceCanvas.dataset.mountedAt,
                        unmountedAt: null,
                        parent: mountParent,
                        rect: { left: Math.round(mountRect.left * 100) / 100, top: Math.round(mountRect.top * 100) / 100, width: Math.round(mountRect.width * 100) / 100, height: Math.round(mountRect.height * 100) / 100 },
                        drawCount: parseInt(replaceCanvas.dataset.drawCount || "0") || 0,
                      });
                      // M7.7-074: MutationObserver 检测 canvas 从 host 移除
                      const existingObserver = (repHost as any).__replacementObserver;
                      if (existingObserver) existingObserver.disconnect();
                      const observer = new MutationObserver((mutations) => {
                        for (const m of mutations) {
                          for (const removedNode of m.removedNodes) {
                            if (removedNode instanceof HTMLElement && removedNode.id === canvasId) {
                              const unmountedAt = Date.now();
                              console.log("[M7.7-034][REMOVE_REPLACEMENT]", {
                                lineId: target.lineId,
                                instanceId: removedNode.dataset.instanceId ?? "unknown",
                              });
                              console.log("[M7.7-049][CANVAS_LIFECYCLE]", {
                                lineId: target.lineId,
                                action: "UNMOUNT",
                                canvasId,
                                instanceId: removedNode.dataset.instanceId ?? "unknown",
                                mountedAt: removedNode.dataset.mountedAt ?? "0",
                                unmountedAt: String(unmountedAt),
                                parent: null,
                                rect: null,
                                drawCount: parseInt(removedNode.dataset.drawCount || "0") || 0,
                              });
                            }
                          }
                        }
                      });
                      observer.observe(repHost, { childList: true, subtree: true });
                      (repHost as any).__replacementObserver = observer;
                    }
                  }
                  // M7.7-074: SCREEN_ALIGNMENT 验收（canvas 在 host 内 local 0,0 → deltaY≈0）
                  {
                    const repHostForAlign = document.getElementById(`glyph-renderer-rep-${target.lineId}`) as HTMLElement | null;
                    const rRect = replaceCanvas.getBoundingClientRect();
                    const hRect = repHostForAlign ? repHostForAlign.getBoundingClientRect() : null;
                    console.log("[M7.7-074][SCREEN_ALIGNMENT]", {
                      lineId: target.lineId,
                      glyphRendererRect: hRect ? { top: Math.round(hRect.top * 100) / 100, left: Math.round(hRect.left * 100) / 100, height: Math.round(hRect.height * 100) / 100 } : null,
                      replacementRect: { top: Math.round(rRect.top * 100) / 100, left: Math.round(rRect.left * 100) / 100, height: Math.round(rRect.height * 100) / 100 },
                      deltaY: hRect ? Math.round((rRect.top - hRect.top) * 100) / 100 : null,
                    });
                  }
                  // 读取 mask 元素（仅用于记录/对齐校验，不参与 glyph 坐标与 canvasTop）
                  const maskEl = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                  replaceCanvas.style.top = `${canvasTop}px`;
                  // M7.7-072: baseline invariant 断言（任何 layer 不得改变 baseline）
                  {
                    const actualBaseline = canvasTop + glyphLocalBaseline;
                    const delta = actualBaseline - lineBaseline;
                    if (Math.abs(delta) >= 0.5) {
                      console.error("[M7.7-072][BASELINE_INVARIANT_VIOLATED]", {
                        lineId: target.lineId,
                        sourceBaseline: Math.round(lineBaseline * 100) / 100,
                        actualBaseline: Math.round(actualBaseline * 100) / 100,
                        delta: Math.round(delta * 100) / 100,
                      });
                    }
                  }
                  replaceCanvas.style.background = "transparent"; // M7.7-069: 取消红色调试背景，改用透明背景 + 黑字
                  // M7.7-070: replacement 创建 — 行绑定验证（geometry 用 glyph bbox 并集，与 mask box 同源）
                  console.log("[M7.7-070][REPLACEMENT_CREATE]", {
                    lineId: target.lineId,
                    rect: {
                      x: Math.round(minX * 100) / 100,
                      y: Math.round(minY * 100) / 100,
                      width: cw,
                      height: ch,
                    },
                    geometryId: target.lineId,
                  });
                  // M7.7-072: GEOMETRY — 唯一 LineGeometry 输出（baseline 不变；canvasTop 由 baseline-glyphLocalBaseline 派生）
                  console.log("[M7.7-072][GEOMETRY]", {
                    lineId: target.lineId,
                    inkTop: Math.round(inkTop * 100) / 100,
                    inkBottom: Math.round(inkBottom * 100) / 100,
                    baseline: Math.round(lineBaseline * 100) / 100,
                    canvasTop: Math.round(canvasTop * 100) / 100,
                    glyphLocalBaseline: Math.round(glyphLocalBaseline * 100) / 100,
                    maskTop: Math.round(maskTop * 100) / 100,
                    invariant: Math.abs((canvasTop + glyphLocalBaseline) - lineBaseline) < 0.5,
                  });
                  // M7.7-064: 验证 replacement canvas 是否跟随 mask Y offset
                  const repCR = replaceCanvas.getBoundingClientRect();
                  const maskElCR = maskEl ? maskEl.getBoundingClientRect() : null;
                  console.log("[M7.7-064][REPLACEMENT_OFFSET]", {
                    lineId: target.lineId,
                    offset: EDIT_LAYER_Y_OFFSET,
                    replacement: { left: Math.round(repCR.left * 100) / 100, top: Math.round(repCR.top * 100) / 100, width: Math.round(repCR.width * 100) / 100, height: Math.round(repCR.height * 100) / 100 },
                    mask: maskElCR ? { left: Math.round(maskElCR.left * 100) / 100, top: Math.round(maskElCR.top * 100) / 100, width: Math.round(maskElCR.width * 100) / 100, height: Math.round(maskElCR.height * 100) / 100 } : null,
                    glyphInkBBox: { minY: Math.round(minY * 100) / 100, maxY: Math.round(maxY * 100) / 100, height: Math.round((maxY - minY) * 100) / 100 },
                    replacementFollowsMask: maskElCR ? Math.round((repCR.top - maskElCR.top) * 100) / 100 === EDIT_LAYER_Y_OFFSET : "no mask",
                  });
                  // M7.7-066: 编辑层垂直偏移校准验证
                  {
                    const editorOverlay = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="textEdit"]`) as HTMLElement | null;
                    console.log("[M7.7-066][EDIT_LAYER_OFFSET]", {
                      lineId: target.lineId,
                      offset: EDIT_LAYER_Y_OFFSET,
                      editorTopBefore: editorOverlay ? Math.round((parseFloat(editorOverlay.style.top) - EDIT_LAYER_Y_OFFSET) * 100) / 100 : "no editor",
                      editorTopAfter: editorOverlay ? Math.round(parseFloat(editorOverlay.style.top) * 100) / 100 : "no editor",
                      maskTopBefore: maskEl ? Math.round((maskEl.offsetTop - EDIT_LAYER_Y_OFFSET) * 100) / 100 : "no mask",
                      maskTopAfter: maskEl ? Math.round(maskEl.offsetTop * 100) / 100 : "no mask",
                      replacementTopBefore: Math.round(minY * 100) / 100,
                      replacementTopAfter: Math.round(canvasTop * 100) / 100,
                      sync: maskEl
                        ? Math.round((canvasTop - maskEl.offsetTop) * 100) / 100 === 0
                          ? "OK"
                          : `MISMATCH: mask=${Math.round(maskEl.offsetTop * 100) / 100}, repl=${Math.round(canvasTop * 100) / 100}`
                        : "no mask",
                    });
                  }
                  // M7.7-040: 追踪 draw 次数
                  const drawCount = (parseInt(replaceCanvas.dataset.drawCount || "0") || 0) + 1;
                  replaceCanvas.dataset.drawCount = String(drawCount);
                  const ctx = replaceCanvas.getContext("2d");
                  if (ctx) {
                    // M7.8-024: canvas 高度为 canvasHeight，必须用 canvasHeight 清除，否则底部残留旧像素。
                    ctx.clearRect(0, 0, cw, canvasHeight);
                    const styles = result.document.styles || [];
                    // M7.7-032: 使用 PDF.js 内部字体名（如 g_d0_f2）替代 CSS font-family fallback
                    const firstStyle = styles[glyphs[0].styleRef] || {};
                    const pdfFontName = firstStyle.pdfjsFontFamily || firstStyle.fontFamily || "sans-serif";
                    const pdfFontSize = firstStyle.fontSize || 12;
                    const pdfFontWeight = firstStyle.fontWeight || "normal";
                    const pdfFontStyle = firstStyle.fontStyle || "normal";
                    let fontLoaded = false;
                    try {
                      fontLoaded = document.fonts?.check(`${pdfFontStyle} ${pdfFontWeight} ${pdfFontSize}px "${pdfFontName}"`) ?? false;
                    } catch (_e) { /* font check 可能抛出异常 */ }

                    // M7.7-033: 获取当前 canvas transform 和 PDF canvas transform
                    const currentTransform = ctx.getTransform();
                    const pdfCanvasEl = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                    let pdfCanvasTransform: string | null = null;
                    if (pdfCanvasEl) {
                      const pdfCtx = pdfCanvasEl.getContext("2d");
                      if (pdfCtx) {
                        const t = pdfCtx.getTransform();
                        pdfCanvasTransform = `matrix(${t.a},${t.b},${t.c},${t.d},${t.e},${t.f})`;
                      }
                    }

                    // 设置字体（所有三种方法共用）
                    const fontSpec = `${pdfFontStyle} ${pdfFontWeight} ${pdfFontSize}px ${pdfFontName}`;
                    ctx.font = fontSpec;

                    // M7.7-033: 三种绘制方法测试
                    const firstGlyph = glyphs[0];
                    const firstStyle2 = styles[firstGlyph.styleRef] || {};
                    const firstFontFamily = firstStyle2.pdfjsFontFamily || firstStyle2.fontFamily || "sans-serif";
                    const firstFontSize = firstStyle2.fontSize || 12;
                    const firstFontWeight = firstStyle2.fontWeight || "normal";
                    const firstFontStyle = firstStyle2.fontStyle || "normal";
                    const firstColor = firstStyle2.color || "#000000";
                    const firstBaseline = firstGlyph.baseline ?? afterLine.baseline ?? (firstGlyph.bbox.y + firstGlyph.bbox.height * 0.8);
                    const firstX = firstGlyph.bbox.x - minX;
                    const firstY = firstGlyph.bbox.y - minY;
                    const firstBaselineOffset = firstBaseline - minY;

                    // 方法 A: fillText(char, x, y) — textBaseline = "top"
                    ctx.font = `${firstFontStyle} ${firstFontWeight} ${firstFontSize}px ${firstFontFamily}`;
                    ctx.textBaseline = "top";
                    ctx.fillStyle = "#0000ff";
                    ctx.fillText(firstGlyph.char, firstX, firstY);

                    // 方法 B: fillText(char, x, baseline) — textBaseline = "alphabetic"
                    ctx.textBaseline = "alphabetic";
                    ctx.fillStyle = "#ff0000";
                    ctx.fillText(firstGlyph.char, firstX, firstBaselineOffset);

                    // 方法 C: setTransform(pdfTransform) + fillText(char, x, baseline)
                    if (pdfCanvasEl) {
                      const pdfCtx2 = pdfCanvasEl.getContext("2d");
                      if (pdfCtx2) {
                        const t = pdfCtx2.getTransform();
                        ctx.save();
                        ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
                        ctx.textBaseline = "alphabetic";
                        ctx.fillStyle = "#00ff00";
                        // 方法 C 使用 document 坐标（不减去 minX/minY），因为 setTransform 全局对齐
                        ctx.fillText(firstGlyph.char, firstGlyph.bbox.x, firstBaseline);
                        ctx.restore();
                      }
                    }

                    // 日志输出
                    console.log("[M7.7-033][DRAW_COORD]", {
                      lineId: target.lineId,
                      glyph: firstGlyph.char,
                      glyphX: firstGlyph.bbox.x,
                      glyphY: firstGlyph.bbox.y,
                      glyphBaseline: firstBaseline,
                      canvasWidth: cw,
                      canvasHeight: ch,
                      currentTransform: `matrix(${currentTransform.a},${currentTransform.b},${currentTransform.c},${currentTransform.d},${currentTransform.e},${currentTransform.f})`,
                      pdfCanvasTransform,
                      methodA: { x: firstX, y: firstY, textBaseline: "top" },
                      methodB: { x: firstX, y: firstBaselineOffset, textBaseline: "alphabetic" },
                      methodC: { pdfTransform: pdfCanvasTransform, x: firstGlyph.bbox.x, y: firstBaseline, textBaseline: "alphabetic" },
                    });

                    // 原始方法（当前生产路径）保留
                    ctx.save();
                    // 恢复原始 transform
                    ctx.setTransform(currentTransform);
                    for (const glyph of glyphs) {
                      const style = styles[glyph.styleRef] || {};
                      const family = style.pdfjsFontFamily || style.fontFamily || "sans-serif";
                      const size = style.fontSize || 12;
                      const weight = style.fontWeight || "normal";
                      const fStyle = style.fontStyle || "normal";
                      const color = style.color || "#000000";
                      ctx.font = `${fStyle} ${weight} ${size}px ${family}`;
                      ctx.fillStyle = color;
                      ctx.textBaseline = "alphabetic";
                      const bl = glyph.baseline ?? afterLine.baseline ?? (glyph.bbox.y + glyph.bbox.height * 0.8);
                      const glyphLocalX = glyph.bbox.x - minX;
                      // M7.7-070: screenBaseline = (minY - canvasPaddingTop) + canvasPaddingTop + (bl - minY) = bl（精确 baseline）
                      const glyphLocalY = canvasPaddingTop + (bl - minY);
                      ctx.fillText(glyph.char, glyphLocalX, glyphLocalY);
                    }
                    ctx.restore();
                    // M7.7-067: Replacement Glyph Coordinate Rebase — 验证 glyph 坐标是否使用 canvas local coordinate
                    {
                      const firstGlyphCheck = glyphs[0];
                      const firstBLCheck = firstGlyphCheck.baseline ?? afterLine.baseline ?? (firstGlyphCheck.bbox.y + firstGlyphCheck.bbox.height * 0.8);
                      console.log("[M7.7-067][GLYPH_DRAW_COORD]", {
                        lineId: target.lineId,
                        offset: EDIT_LAYER_Y_OFFSET,
                        canvasTop: Math.round(canvasTop * 100) / 100,
                        canvasHeight: canvasHeight,
                        glyphX: Math.round((firstGlyphCheck.bbox.x - minX) * 100) / 100,
                        glyphY: Math.round((firstBLCheck - canvasTop) * 100) / 100, // M7.7-069: baseline - canvasTop
                        baseline: Math.round(firstBLCheck * 100) / 100,
                        screenY: Math.round((firstBLCheck - canvasTop + canvasTop) * 100) / 100, // = baseline (screen)
                      });
                    }
                    // M7.7-068: Replacement Canvas Viewport Fix — 验证 canvas 尺寸与 glyph 渲染状态
                    console.log("[M7.7-068][GUARD]", { lineId: target.lineId, phase: "before" });
                    try {
                      const firstGlyphCheck = glyphs[0];
                      const style = styles[firstGlyphCheck.styleRef] || {};
                      const family = style.pdfjsFontFamily || style.fontFamily || "sans-serif";
                      const size = style.fontSize || 12;
                      const weight = style.fontWeight || "normal";
                      const fStyle = style.fontStyle || "normal";
                      const fontStr = `${fStyle} ${weight} ${size}px ${family}`;
                      const bl = firstGlyphCheck.baseline ?? afterLine.baseline ?? (firstGlyphCheck.bbox.y + firstGlyphCheck.bbox.height * 0.8);
                      const glyphLocalX = firstGlyphCheck.bbox.x - minX;
                      const glyphLocalY = canvasPaddingTop + (bl - minY); // M7.7-070: 等价于 bl - canvasTop，与生产路径一致
                      let textBounds: { width: number; actualBoundingBoxAscent: number; actualBoundingBoxDescent: number } | null = null;
                      try {
                        ctx.save();
                        ctx.setTransform(currentTransform);
                        ctx.font = fontStr;
                        textBounds = ctx.measureText(firstGlyphCheck.char);
                        ctx.restore();
                      } catch (_e) {}
                      console.log("[M7.7-068][GLYPH_RENDER_STATE]", {
                        lineId: target.lineId,
                        canvasWidth: cw,
                        canvasHeight: canvasHeight,
                        paddingTop: canvasPaddingTop,
                        paddingBottom: canvasPaddingBottom,
                        font: fontStr,
                        fillStyle: style.color || "#000000",
                        globalAlpha: ctx.globalAlpha,
                        glyphLocalX: Math.round(glyphLocalX * 100) / 100,
                        glyphLocalY: Math.round(glyphLocalY * 100) / 100,
                        textBounds: textBounds ? {
                          width: Math.round(textBounds.width * 100) / 100,
                          ascent: Math.round(textBounds.actualBoundingBoxAscent * 100) / 100,
                          descent: Math.round(textBounds.actualBoundingBoxDescent * 100) / 100,
                        } : null,
                        fitInCanvas: textBounds
                          ? (glyphLocalY - (textBounds.actualBoundingBoxAscent || 0) >= 0 && glyphLocalY + (textBounds.actualBoundingBoxDescent || 0) <= canvasHeight)
                          : "unknown",
                        canvasStyle: {
                          top: replaceCanvas.style.top,
                          left: replaceCanvas.style.left,
                          width: replaceCanvas.width,
                          height: replaceCanvas.height,
                          background: replaceCanvas.style.background,
                          display: replaceCanvas.style.display,
                          visibility: replaceCanvas.style.visibility,
                          opacity: replaceCanvas.style.opacity,
                          zIndex: replaceCanvas.style.zIndex,
                          position: replaceCanvas.style.position,
                        },
                      });
                    } catch (_e) {
                      console.log("[M7.7-068][ERROR]", { lineId: target.lineId, error: String(_e) });
                    }
                    // M7.7-069: 验证 glyph 最终 screen baseline 是否等于原始 PDF baseline
                    {
                      const fg = glyphs[0];
                      const fbl = fg.baseline ?? afterLine.baseline ?? (fg.bbox.y + fg.bbox.height * 0.8);
                      const fLocalY = fbl - canvasTop; // M7.7-069: baseline - canvasTop
                      const screenBaseline = canvasTop + fLocalY;
                      const expectedBaseline = fbl;
                      const delta = Math.round((screenBaseline - expectedBaseline) * 100) / 100;
                      console.log("[M7.7-069][GLYPH_FINAL_COORD]", {
                        lineId: target.lineId,
                        canvasTop: Math.round(canvasTop * 100) / 100,
                        glyphLocalY: Math.round(fLocalY * 100) / 100,
                        screenBaseline: Math.round(screenBaseline * 100) / 100,
                        expectedBaseline: Math.round(expectedBaseline * 100) / 100,
                        delta,
                        pass: Math.abs(delta) <= 1,
                      });
                    }
                    // M7.7-065: 验证 glyph 坐标转换
                    const firstGlyph2 = glyphs[0];
                    const firstBL2 = firstGlyph2.baseline ?? afterLine.baseline ?? (firstGlyph2.bbox.y + firstGlyph2.bbox.height * 0.8);
                    console.log("[M7.7-065][GLYPH_LOCAL]", {
                      lineId: target.lineId,
                      canvasTop: Math.round(canvasTop * 100) / 100,
                      canvasHeight: ch,
                      glyphOriginalY: Math.round(firstGlyph2.bbox.y * 100) / 100,
                      glyphOriginalBaseline: Math.round(firstBL2 * 100) / 100,
                      glyphLocalX: Math.round((firstGlyph2.bbox.x - minX) * 100) / 100,
                      glyphLocalY: Math.round((firstBL2 - minY) * 100) / 100,
                      minY: Math.round(minY * 100) / 100,
                    });
                    const drawRect = replaceCanvas.getBoundingClientRect();
                    console.log("[M7.7-049][CANVAS_LIFECYCLE]", {
                      lineId: target.lineId,
                      action: "DRAW",
                      canvasId,
                      instanceId,
                      mountedAt: replaceCanvas.dataset.mountedAt,
                      unmountedAt: null,
                      parent: replaceCanvas.parentElement ? replaceCanvas.parentElement.tagName.toLowerCase() + (replaceCanvas.parentElement.id ? `#${replaceCanvas.parentElement.id}` : "") : null,
                      rect: { left: Math.round(drawRect.left * 100) / 100, top: Math.round(drawRect.top * 100) / 100, width: Math.round(drawRect.width * 100) / 100, height: Math.round(drawRect.height * 100) / 100 },
                      drawCount: parseInt(replaceCanvas.dataset.drawCount || "0") || 0,
                    });
                    // M7.7-037: 对比 PDF canvas 与 replacement canvas 的 glyph 位置
                    const pdfCanvasEl2 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                    const repCR = replaceCanvas ? replaceCanvas.getBoundingClientRect() : null;
                    if (pdfCanvasEl2 && replaceCanvas && repCR) {
                      const pdfCR = pdfCanvasEl2.getBoundingClientRect();
                      const firstGlyphPdf = afterLine.glyphs[0];
                      const fBaseline = firstGlyphPdf.baseline ?? afterLine.baseline ?? (firstGlyphPdf.bbox.y + firstGlyphPdf.bbox.height * 0.8);
                      // PDF canvas 上 glyph 的像素位置（需要 viewport 缩放因子）
                      // PDF canvas 的 CSS 缩放比 = canvas.clientWidth / canvas.width
                      const pdfCssScale = pdfCanvasEl2.clientWidth > 0 ? pdfCanvasEl2.clientWidth / pdfCanvasEl2.width : 1;
                      // PDF canvas 上 glyph 的 CSS 像素位置
                      const pdfCssX = pdfCR.left + firstGlyphPdf.bbox.x * pdfCssScale;
                      const pdfCssY = pdfCR.top + firstGlyphPdf.bbox.y * pdfCssScale;
                      const pdfCssBaseline = pdfCR.top + fBaseline * pdfCssScale;
                      // Replacement canvas 上 glyph 的 CSS 像素位置
                      const repCssX = repCR.left + (firstGlyphPdf.bbox.x - minX);
                      const repCssY = repCR.top + (firstGlyphPdf.bbox.y - minY);
                      const repCssBaseline = repCR.top + (fBaseline - minY);
                      console.log("[M7.7-037][GLYPH_DELTA]", {
                        lineId: target.lineId,
                        char: firstGlyphPdf.char,
                        pdf: {
                          modelX: Math.round(firstGlyphPdf.bbox.x * 100) / 100,
                          modelY: Math.round(firstGlyphPdf.bbox.y * 100) / 100,
                          modelBaseline: Math.round(fBaseline * 100) / 100,
                          cssX: Math.round(pdfCssX * 100) / 100,
                          cssY: Math.round(pdfCssY * 100) / 100,
                          cssBaseline: Math.round(pdfCssBaseline * 100) / 100,
                          cssScale: Math.round(pdfCssScale * 1000) / 1000,
                        },
                        replacement: {
                          canvasLeft: Math.round(repCR.left * 100) / 100,
                          canvasTop: Math.round(repCR.top * 100) / 100,
                          drawX: Math.round((firstGlyphPdf.bbox.x - minX) * 100) / 100,
                          drawY: Math.round((fBaseline - minY) * 100) / 100,
                          cssX: Math.round(repCssX * 100) / 100,
                          cssY: Math.round(repCssY * 100) / 100,
                          cssBaseline: Math.round(repCssBaseline * 100) / 100,
                        },
                        delta: {
                          x: Math.round((repCssX - pdfCssX) * 100) / 100,
                          y: Math.round((repCssY - pdfCssY) * 100) / 100,
                          baseline: Math.round((repCssBaseline - pdfCssBaseline) * 100) / 100,
                        },
                      });
                    }
                    // 隐藏 DOM overlay spans
                    const overlayEls = document.querySelectorAll(`[data-line-id="${target.lineId}"][data-layer="overlay"]`) as NodeListOf<HTMLElement>;
                    overlayEls.forEach(el => el.style.display = "none");
                    console.log("[M7.7-031][CANVAS_REPLACE]", {
                      lineId: target.lineId,
                      glyphCount: glyphs.length,
                      font: ctx.font,
                      baseline: afterLine.baseline,
                      scale: 1,
                      sampleChar: glyphs[0].char,
                    });
                    console.log("[M7.7-032][PDF_FONT_BIND]", {
                      lineId: target.lineId,
                      pdfFontName,
                      canvasFont: ctx.font,
                      fontLoaded,
                      sampleChar: glyphs[0].char,
                    });
                  }
                }
                pushOperationToHistory(
                  { type: "replace", blockId: target.blockId, lineId: target.lineId, range: { start, end }, text: fragment },
                  { document: editableDocumentRef.current, mutated: true, modifiedGlyphIds: [], inverse: { kind: "replace", beforeGlyphs, afterGlyphs } }
                );
                // M7.7-004A: 编辑提交后尝试原生替换（验证 + 标记 nativeReady）。
                //   仅当原始行文本 === 单个算子整文本才可能命中（004A 范围；多算子/部分行留待 004B Text Run）。
                //   run 覆盖整行（originalText=原行整文本, replacementText=新行整文本）→ 成功后整行 glyph nativeReady=true，
                //   供 Export 侧 exportDocumentNativeFirst 做真实 Tj/TJ 改写（短路 Helvetica overlay）。
                const lineIdx = block.lines.findIndex((l) => l.id === line.id);
                if (lineIdx >= 0 && afterLine && afterLine.glyphs.length > 0 && pdfBytesRef.current) {
                  attemptNativeReplaceForLine(pdfBytesRef.current, pageIndex, {
                    blockId: target.blockId,
                    lineIndex: lineIdx,
                    pageIndex,
                    glyphStart: 0,
                    glyphEnd: afterLine.glyphs.length - 1,
                    originalText: lineText,
                    replacementText: newText,
                  }).then((r) => {
                    if (r.success && editableDocumentRef.current) {
                      editableDocumentRef.current = applyNativeReplacementResult(editableDocumentRef.current, r.targets);
                      (window as any).__editableDocument = editableDocumentRef.current;
                      setEditableDocVersion((v) => v + 1);
                      // console.log("[M7.7-004A] native replace ok → nativeReady:", r.targets.map((t) => t.bindingId));
                    } else {
                      // console.log("[M7.7-004A] native replace fallback (overlay):", r.reason ?? "skip", JSON.stringify(lineText), "→", JSON.stringify(newText));
                    }
                  });
                }
              }
              dispatchSession(null);
              setEditingBlockId(null);
              setTextEdit(null);
              return;
            }

            // ── M5-VERIFY-003: Multi-line → SAFE REJECT（NO MUTATION）──
            // 多行 block（editSession 为 null，因 createEditSession 拒绝 ranges.length>1）：
            // 不再回退旧的 Legacy 整段编辑逻辑（避免产生第二条 Truth Path）。
            // Multi-line 编辑在 M5-IMPLEMENT-005 前保持 SAFE REJECT：不产生部分 mutation。
            console.warn("[M5-VERIFY-003] Multi-line block edit: SAFE REJECT (NO MUTATION), Multi-line 未实现");
            dispatchSession(null);
            setEditingBlockId(null);
            setTextEdit(null);
          })}
          onTextEditCancel={() => {
            console.log("[Sprint32] edit cancelled");
            recordWorkspaceEvent("cancel");
            // M5-IMPLEMENT-002B: cancelSession → document 完全不变（丢弃 session）
            if (editSession) dispatchSession(cancelSession(editSession));
            dispatchSession(null);
            setEditingBlockId(null);
            setTextEdit(null);
          }}
          blockRotations={blockRotations}
          // F3B-6.4B-2：原实现是死代码（PDFCanvas 从未调用它），且只做 markLineEdited。
          // 现改为 canonical commit —— Segment → EditableDocument mutation + OperationHistory entry。
          onSegmentCommit={commitSegmentCanonical}
          signatureRegionMap={signatureRegionMap}
          signatureRegions={signatureRegionsStable}
          signatureTransformContexts={signatureTransformContexts}
        />
        {isFidelityDebug && debugGlyph && (
          <FidelityDebugPanel
            glyph={debugGlyph.glyph}
            index={debugGlyph.index}
            editableDocument={editableDocumentRef.current}
            pdfTextItems={docTextItemsRef.current}
            showSourceBounds={debugOverlay.source}
            showGlyphBounds={debugOverlay.glyph}
            showBaseline={debugOverlay.baseline}
          />
        )}
      </div>

      {/* ── 右侧：统一上下文面板 ── */}
      <SidePanel
        handleAddBlankPage={handleAddBlankPage}
        handleDeletePage={handleDeletePage}
        handleMovePageUp={handleMovePageUp}
        handleMovePageDown={handleMovePageDown}
        updateSelectedFormat={updateSelectedFormat}
        processInline={processInline}
        handleExport={handleExportWithCommit}
      />

      {/* ── 右侧：Document Workspace（AI Document Workspace，仅 Ask AI 打开） ── */}
      <DocumentWorkspace
        intent={workspaceIntent}
        onUpdateText={(intent) => {
          // "Update Text"：用点击时解析的 intent 打开现有 TextEditOverlay，
          // Editor 仍是那个 Editor，只是从"默认行为"变成"第一个 Action"。
          // M5-IMPLEMENT-002B + 002C-FIX + 002D: 创建 EditSession（B 编辑态 text/target truth）。
          // 002C-FIX：若 onGlyphClick 已传递字符级 target（lineId + startGlyphIndex）→ 优先字符级。
          // 002D：input surface 语义 = 被选中的字符（方案 A Character Replacement）——
          //       textarea 显示/编辑的是被点击的字符（W），而非整行。

          // ── M7-004B: Mouse Drag Selection → EditSession（Route A）──
          // 优先级最高：currentSelection（004A 拖选产生的 SelectionRange）存在时，忽略字符级 click target。
          // Route A 语义：session.text = 完整行 working truth，caret = selection range，
          //   target = SelectionRange（与 EditSessionTarget 同构），editingMode = "replace-selection"。
          // 创建成功后 setCurrentSelection(null) —— 把 selection truth 迁移进 EditSession.caret，
          //   避免 Mouse Selection + EditSession selection 两个 truth 并存（M5/M6 消灭 double truth 原则）。
          if (currentSelection) {
            const sel = currentSelection;
            // M7.7-003: 复用共享 openTextEditFromSelectionRange（与 onDragSelectCommit 同一语义）。
            //   整行 working text + caret = selection range + text-edit；openTextEditSession 清
            //   pendingEdit/currentSelection/selectedText（single truth）。
            openTextEditFromSelectionRange(sel);
            return;
          }

          const hasCharTarget =
            typeof intent.lineId === "string" &&
            typeof intent.startGlyphIndex === "number" &&
            typeof intent.endGlyphIndex === "number";

          if (hasCharTarget) {
            // hasCharTarget 已保证这些字段存在；显式提取以便 TS 收窄
            const charLineId = intent.lineId as string;
            const charStart = intent.startGlyphIndex as number;
            const charEnd = intent.endGlyphIndex as number;
            // 从 Document Model 提取点击字符作为 originalText + input surface 值（单字符 range）
            const block = editableDocumentRef.current?.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === intent.blockId);
            const line = block?.lines.find((l) => l.id === charLineId);
            const charText = line?.glyphs[charStart]?.char ?? intent.text.slice(charStart, charStart + 1) ?? "";
            const charRange = { blockId: intent.blockId, lineId: charLineId, startGlyphIndex: charStart, endGlyphIndex: charEnd };
            // M7.7-004X (Bug2): 字符级点击同样用文档字体
            const charStyles = editableDocumentRef.current?.styles;
            const charFontFamily = charStyles && line?.glyphs[charStart]
              ? charStyles[line.glyphs[charStart].styleRef]?.fontFamily
              : undefined;
            openTextEditSession(
              intent.blockId,
              { blockId: intent.blockId, text: charText, bbox: intent.bbox, fontSize: intent.fontSize, fontFamily: charFontFamily },
              createEditSession(
                { blockId: intent.blockId, lineId: charLineId, startGlyphIndex: charStart, endGlyphIndex: charEnd },
                charText,
                [charRange],
                // M5-IMPLEMENT-003A: 点击 glyph → glyph 级 caret（glyphIndex identity 保留）
                { lineId: charLineId, glyphIndex: charStart, offset: "before", affinity: "forward" }
              )
            );
          } else {
            // Fallback：无字符级 target → block-level（首行整行 range），input surface = 整行
            const resolved = resolveEditTarget(editableDocumentRef.current, intent.blockId);
            // M7.7-004X (Bug2): block-level fallback 用文档字体（首 glyph styleRef）
            const fbBlock = editableDocumentRef.current?.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === intent.blockId);
            const fbFirstGlyph = fbBlock?.lines[0]?.glyphs[0];
            const fbStyles = editableDocumentRef.current?.styles;
            const fbFontFamily = fbStyles && fbFirstGlyph ? fbStyles[fbFirstGlyph.styleRef]?.fontFamily : undefined;
            // ADR-048: block-level fallback 已是整行文本 → 直接 text-edit（无需 replace-selection 转换）
            openTextEditSession(
              intent.blockId,
              { blockId: intent.blockId, text: intent.text, bbox: intent.bbox, fontSize: intent.fontSize, fontFamily: fbFontFamily },
              resolved ? createEditSession(resolved.target, resolved.firstLineText, resolved.ranges, undefined, "text-edit") : null
            );
          }
        }}
      />

      <OptionModals
        addBlock={addBlock}
        handleStripePay={handleStripePay}
        handlePaypalPay={handlePaypalPay}
        processInline={processInline}
      />

      {showPostLoadModal && (
        <PostLoadModal
          onClose={() => setShowPostLoadModal(false)}
          onEditText={() => {
            setShowPostLoadModal(false);
            setShowTextLayer(true);
          }}
          onToWord={() => {
            setShowPostLoadModal(false);
            processInline("word");
          }}
          onCompress={() => {
            setShowPostLoadModal(false);
            // V12 移植适配：保留本项目的压缩质量选项弹窗
            setShowCompressOptions(true);
          }}
          onToExcel={() => {
            setShowPostLoadModal(false);
            processInline("excel");
          }}
          onToJpg={() => {
            setShowPostLoadModal(false);
            processInline("jpg");
          }}
          onRemoveWatermark={() => {
            setShowPostLoadModal(false);
            processInline("watermark");
          }}
          onSplit={() => {
            setShowPostLoadModal(false);
            // V12 移植适配：保留本项目的 Split 模式选项弹窗
            setShowSplitOptions(true);
          }}
        />
      )}

      {/* OCR 流程：来自 /ocr-result 的首次"Click any text to edit"引导 */}
      {showOcrHint && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9998,
          }}
          onClick={() => setShowOcrHint(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: "#fff",
              borderRadius: 16,
              padding: "32px 36px",
              width: 480,
              maxWidth: "90vw",
              boxShadow: "0 20px 60px rgba(0,0,0,0.25)",
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 44, marginBottom: 12 }}>👆</div>
            <h2 style={{ margin: "0 0 8px", fontSize: 22, fontWeight: 800, color: "#1e293b" }}>
              {t("ocr.editorHint")}
            </h2>
            <p style={{ margin: "0 0 24px", fontSize: 14, color: "#64748b", lineHeight: 1.6 }}>
              {t("ocr.editorHintDesc")}
            </p>
            <button
              onClick={() => setShowOcrHint(false)}
              style={{
                padding: "12px 32px",
                background: "linear-gradient(135deg, #7c3aed 0%, #2563eb 100%)",
                color: "#fff",
                border: "none",
                borderRadius: 10,
                fontSize: 15,
                fontWeight: 700,
                cursor: "pointer",
                boxShadow: "0 8px 20px rgba(124, 58, 237, 0.3)",
              }}
            >
              {t("ocr.editorGotIt")}
            </button>
          </div>
        </div>
      )}

      {/* V12: 字符级选择浮出菜单（替换/删除/重写/翻译）—— Bug 11: 仅浏览模式显示 */}
      {!showTextLayer && pdfDoc && <FloatingToolbar editTool={editTool} />}

      {/* Bug 13: Edit 模式下的浮出菜单（+、-、删除）—— 仅 Edit 模式且有正在编辑的 segment 时显示 */}
      {showTextLayer && editingSegmentId && <EditModeToolbar />}

      </div>
    </div>
  );
}
