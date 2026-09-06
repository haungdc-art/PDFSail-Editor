/**
 * EditorState 类型契约 + State 归属表
 *
 * Commit 1 阶段：只做 state 迁移，不改业务逻辑
 * 迁移顺序（按风险从低到高）：
 *   Step 2: useWorkspaceState  (不碰 PDF，最安全)
 *   Step 3: useOperationState  (compress/export/convert loading 统一)
 *   Step 4: useToolState       (Toolbar 立即变干净)
 *   Step 5: useSelection       (涉及 pdf.js 坐标，有风险)
 *   Step 6: useDocument        (PDF 加载/render 核心，最后做)
 *
 * Canvas 冻结区（PDFEditor.tsx L68-75 ref + L113-170 render/drag/resize）
 *   → Commit 2 才整段搬到 PDFCanvas.tsx，不重写
 */

import type { Block } from "../types";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PDFDocument } from "pdf-lib";

// ═══════════════════════════════════════════════════════════════════
//  Domain: Workspace  (Step 2 — 最先迁移)
// ═══════════════════════════════════════════════════════════════════

export interface WorkspaceHint {
  type: string;
  text: string;
  action: string;
}

export interface WorkspaceAction {
  label: string;
  action: string;
  reason: string;
}

export interface WorkspaceState {
  workspaceMode: boolean;
  showIntentModal: boolean;
  wsAction: WorkspaceAction | null;
  wsHints: WorkspaceHint[];
  wsActionsDone: string[];
  wsShowFlow: boolean;
}

// ═══════════════════════════════════════════════════════════════════
//  Domain: Operation  (Step 3 — 工具处理 + 模态开关)
// ═══════════════════════════════════════════════════════════════════

export interface OperationState {
  // 处理状态
  processingTool: string | null;
  processingLog: string[];
  ocrBusy: boolean;
  showPayModal: boolean;
  // 工具选项模态
  showCompressOptions: boolean;
  showSplitOptions: boolean;
  showRotateOptions: boolean;
  showPageNumOptions: boolean;
  // 工具参数
  splitMode: "all" | "range";
  splitRange: [number, number];
  rotateDeg: 90 | 180 | 270;
  rotateMode: "all" | "current";
  pageNumOpts: {
    position: "bottom" | "top";
    align: "center" | "left" | "right";
    format: string;
    startFrom: number;
    fontSize: number;
    color: string;
  };
  compressQuality: number;
}

// ═══════════════════════════════════════════════════════════════════
//  Domain: Tool  (Step 4 — Toolbar 工具格式)
// ═══════════════════════════════════════════════════════════════════

export type AddingType = "image" | "highlight" | "ocr" | "redact" | "annotate" | null;

export interface TextFormat {
  fontFamily: string;
  fontSize: number;
  color: string;
}

export interface HighlightFormat {
  type: "text" | "freehand" | "underline" | "strike" | "wavy";
  color: string;
  opacity: number;
}

export interface AnnoFormat {
  aType: "note" | "highlight" | "strike" | "underline";
  color: string;
}

export interface ToolState {
  textFormat: TextFormat;
  highlightFormat: HighlightFormat;
  annoFormat: AnnoFormat;
  showTools: boolean;
  showSignature: boolean;
  addingType: AddingType;
  /** V12: Find & Replace 面板开关 */
  showFindReplace: boolean;
}

// ═══════════════════════════════════════════════════════════════════
//  Domain: Selection  (Step 5 — 涉及坐标，有风险)
//  Note: docBlocks 虽然是核心编辑数据，但和 selection 强耦合
//        (selectedBlockId / editingBlock 都依赖 docBlocks)
//        所以合并到 useSelection 中管理
// ═══════════════════════════════════════════════════════════════════

export interface EditingBlock {
  id: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontFamily?: string;
  color?: string;
}

export interface OCRSelect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export interface SelectionState {
  docBlocks: Block[];
  textItems: any[];
  showTextLayer: boolean;
  selectedBlockId: string | null;
  editingBlock: EditingBlock | null;
  ocrSelect: OCRSelect | null;
}

// ═══════════════════════════════════════════════════════════════════
//  Domain: Document  (Step 6 — PDF 加载/render 核心，最后做)
// ═══════════════════════════════════════════════════════════════════

export interface DocumentState {
  page: number;
  totalPages: number;
  pdfDoc: PDFDocumentProxy | null;
  fileName: string;
  thumbnails: string[];
  thumbnailCol: boolean;
}

// ═══════════════════════════════════════════════════════════════════
//  Domain: History  (Commit 4 改造为 Command Pattern)
//  当前仍是 snapshot 模式，由 useSelection 内部管理 undoRef
// ═══════════════════════════════════════════════════════════════════

// 暂未独立成 hook，与 useSelection 共生
// Commit 4 引入 Command Pattern 后才独立

// ═══════════════════════════════════════════════════════════════════
//  EditorState 总契约（EditorProvider 暴露的形状）
// ═══════════════════════════════════════════════════════════════════

export interface EditorState
  extends WorkspaceState,
    OperationState,
    ToolState,
    SelectionState,
    DocumentState {}

/**
 * State 归属表（40 个 state 实际归类，作为迁移依据）
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │ Workspace (6) — Step 2                                          │
 * ├────────────────────────────────────────────────────────────────┤
 * │ workspaceMode, showIntentModal, wsAction,                       │
 * │ wsHints, wsActionsDone, wsShowFlow                              │
 * │ + generateLocalHints (纯函数)                                   │
 * │ - origUpload (dead code, 删除)                                  │
 * └────────────────────────────────────────────────────────────────┘
 * ┌────────────────────────────────────────────────────────────────┐
 * │ Operation (12) — Step 3                                         │
 * ├────────────────────────────────────────────────────────────────┤
 * │ processingTool, processingLog, ocrBusy, showPayModal,           │
 * │ showCompressOptions, showSplitOptions,                          │
 * │ showRotateOptions, showPageNumOptions,                          │
 * │ splitMode, splitRange, rotateDeg, rotateMode,                   │
 * │ pageNumOpts, compressQuality                                    │
 * └────────────────────────────────────────────────────────────────┘
 * ┌────────────────────────────────────────────────────────────────┐
 * │ Tool (6) — Step 4                                               │
 * ├────────────────────────────────────────────────────────────────┤
 * │ textFormat, highlightFormat, annoFormat,                        │
 * │ showTools, showSignature, addingType                            │
 * └────────────────────────────────────────────────────────────────┘
 * ┌────────────────────────────────────────────────────────────────┐
 * │ Selection (6) — Step 5  (含 docBlocks 核心)                     │
 * ├────────────────────────────────────────────────────────────────┤
 * │ docBlocks, textItems, showTextLayer,                            │
 * │ selectedBlockId, editingBlock, ocrSelect                        │
 * │ + undoRef / pushUndo / setBlocks / handleUndo / handleRedo      │
 * └────────────────────────────────────────────────────────────────┘
 * ┌────────────────────────────────────────────────────────────────┐
 * │ Document (6) — Step 6  (Canvas 冻结区相邻)                      │
 * ├────────────────────────────────────────────────────────────────┤
 * │ page, totalPages, pdfDoc, fileName,                             │
 * │ thumbnails, thumbnailCol                                        │
 * └────────────────────────────────────────────────────────────────┘
 *
 * 合计 36 个 state（原 40 个中: origUpload 不是 state, 4 个 ref 不计入）
 */
