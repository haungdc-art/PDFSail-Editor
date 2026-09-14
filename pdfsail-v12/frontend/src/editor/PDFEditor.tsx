import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { v4 as uuid } from "uuid";
import * as pdfjsLib from "pdfjs-dist";
import { computeSceneCompleteness, expectedFromCounts, actualFromCounts } from "../document-model/scene-completeness";
// Sprint-127 (唯一 Mission): Bitmap Runtime — PDFEditor 不再知道 Bitmap 判定逻辑，只消费 state
import { computeBitmapState, BITMAP_INITIAL_STATE, type BitmapRuntimeState } from "./runtime/bitmap-runtime";
import { PDFDocument } from "pdf-lib";
import type { Block, TextBlock } from "./types";
import { LockCoordSystem } from "./coord";
import { EditorProvider, useEditor } from "./core/EditorProvider";
import { PatchBlocksCommand } from "./core/engine";
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
// M7.8-042-FIX：内联构建的 doc 补建 Original Operator Provenance（glyph → operatorId）。
// 此前只有 parsePdfToEditableDocument 导入路径会建立 provenance，内联路径缺失 →
// 导出期 strip 只能靠文本兜底剥离，非连续算子行（表格行）剥离失败 → 原文残留成重影。
import { assignOperatorProvenanceForPage } from "../document-model/pdf-importer";
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
  layoutDebugSummary,
  layoutDump,
  findEditTarget,
  calculateVisualRightBoundary,
  groupGlyphsIntoWords,
  joinWords,
  getPhraseScore,
  calculateLineStability,
  type GlyphClickInfo,
  type GlyphSelectInfo,
  type TransformMatrix,
  resolveBlockRotation,
} from "../document-model";
// OCR-EDIT-SYNC：用与初始构建相同的 Layout Engine 重建整块（逐字位置自洽，根治导出打散/插空格）。
import { reconstructBlockLayout } from "../document-model/layout-engine";
import type { DrawGlyphCommand, DrawImageCommand, RenderCommand } from "../document-model/render-command";
import { isDrawGlyph } from "../document-model/render-command";
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
import { useExport } from "./features/useExport";
import { usePayment } from "./features/usePayment";
import { useInlineTools } from "./features/useInlineTools";
import { useI18n } from "../i18n/I18nProvider";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

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
// ── 🎨 PDFSail 矢量 Logo 组件（原 PdfAideLogo 重命名：本项目品牌为 PDFSail）──
export function PdfSailLogo({ size = 36 }: { size?: number }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 12 }}>
      {/* 图标：暗蓝紫渐变底座 + 帆船（呼应 Sail 品牌名） */}
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
            <linearGradient id="sailGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#e0e7ff" />
              <stop offset="100%" stopColor="#a855f7" />
            </linearGradient>
            <filter id="sailGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="1" floodColor="#c084fc" floodOpacity="0.8" />
            </filter>
          </defs>
          {/* 主帆 + 副帆 + 船体 */}
          <path d="M12 2L12 14L4.5 14Z" fill="url(#sailGrad)" filter="url(#sailGlow)" />
          <path d="M14 5.5L14 14L19.5 14Z" fill="url(#sailGrad)" opacity="0.85" />
          <path
            d="M4 16L20 16L16.5 20L7.5 20Z"
            fill="url(#sailGrad)"
            opacity="0.95"
            filter="url(#sailGlow)"
          />
        </svg>
      </div>

      {/* 文字标：PDF + SAIL 双色渐变 */}
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
          Sail
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
    undoRef, setBlocks, handleUndo, handleRedo, clearHistory,
    // Commit 5: segments
    segments, setSegments, editingSegmentId, setEditingSegmentId, handleSegmentChange,
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

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const coordRef = useRef<LockCoordSystem | null>(null);
  const dragRef = useRef<{ id: string; ox: number; oy: number; ox0: number; oy0: number } | null>(null);
  const resizeRef = useRef<{ id: string; startX: number; startY: number; initW: number; initH: number } | null>(null);
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
  // Commit 4: drag/resize 开始时的 blocks snapshot，用于 mouseup 时 push 一个 PatchBlocksCommand
  const dragStartBlocksRef = useRef<Block[] | null>(null);
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
  const [pdfMode, setPdfMode] = useState<"nativeText" | "scannedOCR" | "mixed" | null>(null);

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
              const acc = boxSourceGlyphs.reduce<{ minX: number; minY: number; maxX: number; maxY: number }>(
                (a, g) => {
                  // 每个受影响 glyph 取 originalBBox（原文墨迹位置）∪ bbox（编辑后位置）
                  const ob = g.originalBBox;
                  return {
                    minX: Math.min(a.minX, g.bbox.x, ob ? ob.x : g.bbox.x),
                    minY: Math.min(a.minY, g.bbox.y, ob ? ob.y : g.bbox.y),
                    maxX: Math.max(
                      a.maxX,
                      g.bbox.x + g.bbox.width,
                      ob ? ob.x + ob.width : g.bbox.x + g.bbox.width,
                    ),
                    maxY: Math.max(
                      a.maxY,
                      g.bbox.y + g.bbox.height,
                      ob ? ob.y + ob.height : g.bbox.y + g.bbox.height,
                    ),
                  };
                },
                { minX: Number.POSITIVE_INFINITY, minY: Number.POSITIVE_INFINITY, maxX: Number.NEGATIVE_INFINITY, maxY: Number.NEGATIVE_INFINITY },
              );
              currentBox = { x: acc.minX, y: acc.minY, width: acc.maxX - acc.minX, height: acc.maxY - acc.minY };
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
    let finalBox = currentBox;
    if (originalBox && currentBox) {
      const minY = Math.min(originalBox.y, currentBox.y);
      const maxY = Math.max(originalBox.y + originalBox.height, currentBox.y + currentBox.height);
      finalBox = { x: currentBox.x, y: minY, width: currentBox.width, height: maxY - minY };
    } else if (originalBox && !currentBox) {
      finalBox = originalBox;
    }
    // OCR/扫描件：并入「原文真实墨迹盒」（canvas 扫描，见 commitBlockTextToDocument OCR 分支）。
    // 必要性：markLineEdited 横向只取「受影响 glyph 的 originalBBox ∪ bbox」（M7.8-034 Phase B
    // 刻意不再与整行原 bbox 取横向并集）。而 OCR glyph 的 originalBBox 全部克隆自 seedGlyph0
    // （每个字同一坐标），原文真实位置已丢失；且 OCR 段落 bbox 本身偏窄（OCR 断行读错时更明显）。
    // 两者叠加 → mask 只盖到新文字右缘，原文超出部分漏出（用户报告：残留 "balho, a"）。
    if (extraInkBox) {
      if (!finalBox) {
        finalBox = { ...extraInkBox };
      } else {
        const minX = Math.min(finalBox.x, extraInkBox.x);
        const minY = Math.min(finalBox.y, extraInkBox.y);
        const maxX = Math.max(finalBox.x + finalBox.width, extraInkBox.x + extraInkBox.width);
        const maxY = Math.max(finalBox.y + finalBox.height, extraInkBox.y + extraInkBox.height);
        finalBox = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
      }
    }
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
          const scanRangeTop = firstBaseline - pdfAscent - tolerance;
          // M7.8-022A: 邻行保护 — 扫描下沿不得越过「下一行顶部」。
          // pdfDescent 由 finalBox 派生，而 finalBox 是 originalBox ∪ currentBox 的并集；
          // 一旦并集纵向膨胀，扫描区会纳入下一行墨迹 → inkBottom 取到下一行 → mask 进一步膨胀
          // （正反馈）。导出时白色 mask 因此盖住下一行上半部分，即"修改行下移侵占下一行"。
          const nextLineTop = blockLines && lineIdx >= 0
            ? blockLines[lineIdx + 1]?.bbox?.y
            : undefined;
          const rawScanRangeBottom = firstBaseline + pdfDescent + tolerance;
          const scanRangeBottom = nextLineTop !== undefined
            ? Math.min(rawScanRangeBottom, nextLineTop)
            : rawScanRangeBottom;
          // Convert to canvas pixel coords
          const scanLeft = Math.max(0, Math.floor(finalBox.x / cssScale));
          const scanTop = Math.max(0, Math.floor(scanRangeTop / cssScale));
          const scanWidth = Math.min(c.width - scanLeft, Math.ceil(finalBox.width / cssScale));
          const scanHeight = Math.min(c.height - scanTop, Math.ceil((scanRangeBottom - scanRangeTop) / cssScale));
          const imageData = ctx.getImageData(scanLeft, scanTop, scanWidth, scanHeight);
          const data = imageData.data;
          // Scan rows for ink top/bottom
          let inkTopRow: number | null = null;
          let inkBottomRow: number | null = null;
          for (let row = 0; row < scanHeight; row++) {
            for (let col = 0; col < scanWidth; col++) {
              const px = (row * scanWidth + col) * 4;
              if (data[px] < 240 || data[px + 1] < 240 || data[px + 2] < 240) {
                if (inkTopRow === null) inkTopRow = row;
                inkBottomRow = row;
                break;
              }
            }
          }
          const rawInkBounds = { top: Math.round(scanRangeTop * 100) / 100, bottom: Math.round(scanRangeBottom * 100) / 100 };
          let constrainedInkBounds = null;
          if (inkTopRow !== null && inkBottomRow !== null) {
            const rawInkTop = (scanTop + inkTopRow) * cssScale;
            // M7.7-070: mask 上沿不得低于 glyph bbox 上沿，避免 canvas ink 扫描误把上一行纳入后 mask 向上侵占。
            const inkTop = Math.max(rawInkTop, finalBox.y);
            // M7.8-022A: 与 inkTop 对称的下沿保护 —— mask 下沿绝不越过下一行顶部。
            // M7.7-070 只保护了上沿（防侵占上一行），下沿缺失导致 mask 可向下无限膨胀。
            const rawInkBottom = (scanTop + inkBottomRow + 1) * cssScale;
            const inkBottom = nextLineTop !== undefined
              ? Math.min(rawInkBottom, nextLineTop)
              : rawInkBottom;
            constrainedInkBounds = { top: Math.round(inkTop * 100) / 100, bottom: Math.round(inkBottom * 100) / 100 };
            finalBox = { x: finalBox.x, y: inkTop, width: finalBox.width, height: Math.max(0, inkBottom - inkTop) };
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
    const MASK_INK_PADDING = { top: 0, bottom: 3, left: 1, right: 1 };
    const beforeBox = finalBox ? { y: finalBox.y, height: finalBox.height } : null;
    if (finalBox) {
      finalBox = {
        x: finalBox.x - MASK_INK_PADDING.left,
        y: finalBox.y - MASK_INK_PADDING.top,
        width: finalBox.width + MASK_INK_PADDING.left + MASK_INK_PADDING.right,
        height: finalBox.height + MASK_INK_PADDING.top + MASK_INK_PADDING.bottom,
      };
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
  const { handleOCR, handleOCRRegion } = useOCR({ canvasRef, cssScaleRef });
  const { handleAddBlankPage, handleDeletePage, handleMovePageUp, handleMovePageDown } = usePageOps({ pdfLibDocRef, pdfBytesRef, onBeforePageChange: () => requestEditTransition("PAGE_CHANGE") });
  const { handleExport } = useExport({ coordRef, pdfBytesRef, cssScaleRef, editableDocumentRef, signatureRegionsRef, editedLineBoxesRef, segmentsRef, getAllPageSegments });

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
      }
      // ── end Sprint 26 ──

      return cmds;
    }
    return undefined;
  }, [editableDocVersion, page]);

  // M7.7-004C: 同步最新 glyphCommands 到 ref（openTextEditSession 经 ref 读取，见声明处注释）。
  glyphCommandsRef.current = glyphCommands;

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

  // ── Sprint34.17: Signature Glyph Coordinate Alignment Debug ──
  // 对比 Editor signature glyph 与原 PDF textItem 的位置差异，定位 baseline/坐标系偏移。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__sigGlyphCoordDebug = () => {
      const doc = editableDocumentRef.current;
      const items = docTextItemsRef.current || [];
      if (!doc) {
        console.warn("[Sprint34.17] No EditableDocument.");
        return null;
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = block.lines
          .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
          .join(" ")
          .trim();
        const g0 = block.lines?.[0]?.glyphs?.[0];
        const glyphBBox = g0?.bbox
          ? { x: g0.bbox.x, y: g0.bbox.y, w: g0.bbox.width, h: g0.bbox.height }
          : block.bbox;
        // 原 PDF textItem（按文本包含匹配；扫描件无原生文本时为 null）
        const item =
          (text &&
            items.find((ti: any) => ti.text && text.includes(ti.text.trim()))) ||
          null;
        // DOM: 签名 span 的 getBoundingClientRect，并转换到文档坐标（与 glyphBBox 同系）。
        // 文档坐标 = span相对wrapper像素 × (文档宽 / wrapper.clientWidth)
        let domRect: any = null;
        let docCoords: any = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          const wrapperEl = document.querySelector(
            '[data-layer="wrapper"]',
          ) as HTMLElement | null;
          if (el && wrapperEl) {
            const r = el.getBoundingClientRect();
            const wRect = wrapperEl.getBoundingClientRect();
            const wrapperW = wrapperEl.clientWidth || 1;
            // 页面文档宽：从 doc 里包含该 block 的 page（CSS 文档坐标宽度）
            const ownerPage = doc.pages.find((p: any) =>
              p.blocks.some((b: any) => b.id === blockId),
            );
            const pageDocWidth = ownerPage?.width || wrapperW;
            const scale = wrapperW / pageDocWidth; // 显示缩放
            const docX = (r.x - wRect.x) / scale;
            const docY = (r.y - wRect.y) / scale;
            domRect = {
              x: r.x, y: r.y, width: r.width, height: r.height,
              offsetLeft: (el as any).offsetLeft,
              offsetTop: (el as any).offsetTop,
            };
            docCoords = { x: docX, y: docY, w: r.width / scale, h: r.height / scale };
          }
        } catch {
          domRect = null;
        }
        rows.push({
          blockId,
          text: text.substring(0, 40),
          rotation: ctx.rotation,
          pivot: { x: ctx.pivot.x, y: ctx.pivot.y },
          glyphBBox,
          domRect,
          docCoords,
          pdfItem: item ? { text: item.text, x: item.x, y: item.y, w: item.w, h: item.h } : null,
          deltaX: item ? glyphBBox.x - item.x : null,
          deltaY: item ? glyphBBox.y - item.y : null,
          // 重绘 span 文档坐标 vs OCR 目标坐标的差异
          domDeltaX: docCoords ? glyphBBox.x - docCoords.x : null,
          domDeltaY: docCoords ? glyphBBox.y - docCoords.y : null,
        });
      }
      // Sprint34.17: 可读逐行输出（避免嵌套对象需手动展开），直接显示 deltaX/deltaY
      if (typeof console !== "undefined") {
        console.log(
          "%c[Sprint34.17][SigGlyphCoord]",
          "font-weight:bold;color:#06b6d4;",
          rows,
        );
        for (const r of rows) {
          const g = r.glyphBBox;
          const p = r.pdfItem;
          const d = r.docCoords;
          console.log(
            `%c[Sprint34.17][Row] ${r.text} rot=${r.rotation} ` +
              `glyph=(x=${g?.x?.toFixed?.(1)},y=${g?.y?.toFixed?.(1)}) ` +
              `dom=(x=${d?.x?.toFixed?.(1)},y=${d?.y?.toFixed?.(1)}) ` +
              `domDeltaX=${r.domDeltaX?.toFixed?.(1) ?? "n/a"} domDeltaY=${r.domDeltaY?.toFixed?.(1) ?? "n/a"} ` +
              `pdf=${p ? `(x=${p.x.toFixed(1)},y=${p.y.toFixed(1)})` : "(none)"} ` +
              `deltaX=${r.deltaX?.toFixed?.(1) ?? "n/a"} deltaY=${r.deltaY?.toFixed?.(1) ?? "n/a"}`,
            "color:#22d3ee;",
          );
        }
      }
      return rows;
    };
    return () => {
      delete (window as any).__sigGlyphCoordDebug;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.27: __sigBlockPositionAudit ──
  // 普适性诊断：枚举整页所有 OCR block，输出每个 block 的文本/坐标/suppress/editable/rotation。
  // 纯只读，不改任何检测/渲染/判定逻辑。仅限本次（Sprint34.27）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__sigBlockPositionAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.27][SigBlockPositionAudit] No EditableDocument.");
        return null;
      }
      const suppressed = suppressedGlyphIdsRef.current;
      const editableIds = new Set(signatureTransformContexts.keys());

      const rows: any[] = [];
      for (const page of doc.pages) {
        for (const block of page.blocks) {
          const text = (block.lines ?? [])
            .map((l: any) => (l.glyphs ?? []).map((g: any) => g.char).join(""))
            .join(" ")
            .trim();
          const ob = block.originalBounds as any;
          const bb = block.bbox as any;
          rows.push({
            blockId: block.id,
            page: page.index,
            text: text.substring(0, 60),
            bbox_y: bb?.y != null ? +bb.y.toFixed(1) : null,
            bbox: bb ? { x: +bb.x.toFixed(1), y: +bb.y.toFixed(1), w: +bb.width.toFixed(1), h: +bb.height.toFixed(1) } : null,
            originalBounds_y: ob?.y != null ? +ob.y.toFixed(1) : null,
            originalBounds: ob ? { x: +ob.x.toFixed(1), y: +ob.y.toFixed(1), w: +ob.width.toFixed(1), h: +ob.height.toFixed(1) } : null,
            regionType: block.regionType ?? "-",
            suppressed: suppressed.has(block.id) ? "YES" : "no",
            editable: editableIds.has(block.id) ? "YES" : "no",
            rotation: signatureRotationRef.current.get(block.id) ?? 0,
          });
        }
      }
      rows.sort((a, b) => (a.originalBounds_y ?? a.bbox_y ?? 0) - (b.originalBounds_y ?? b.bbox_y ?? 0));
      if (typeof console !== "undefined") {
        console.group(
          "%c[Sprint34.27][SigBlockPositionAudit]",
          "font-weight:bold;color:#f59e0b;",
        );
        console.log(`totalBlocks=${rows.length} suppressed=${suppressed.size} editableCtx=${editableIds.size}`);
        console.table(rows.map((r) => ({
          y: r.originalBounds_y ?? r.bbox_y,
          regionType: r.regionType,
          suppressed: r.suppressed,
          editable: r.editable,
          rot: r.rotation,
          text: r.text,
        })));
        console.groupEnd();
        console.log("Full rows: window.__sigBlockPositionAuditResult");
      }
      (window as any).__sigBlockPositionAuditResult = rows;
      return rows;
    };
    return () => {
      delete (window as any).__sigBlockPositionAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.17: Rotation Source Audit ──
  // 对比 EditableBlock.rotation（来自 detectRegionRotation 线性回归）与 PDF 原生 textItem transform 角度。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__rotationAudit = async () => {
      if (!pdfDoc) {
        console.warn("[Sprint34.17][RotationAudit] No pdfDoc");
        return null;
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const blockText = (ctx.blocks[0]?.text ?? "").trim();
        if (!blockText) continue;
        // 找到 block 所在页（blockId 在 doc 中）
        const ownerPageIndex = editableDocumentRef.current?.pages.findIndex((p: any) =>
          p.blocks.some((b: any) => b.id === blockId),
        );
        let item: any = null;
        try {
          const pg = await pdfDoc.getPage((ownerPageIndex ?? 0) + 1);
          const tc = await pg.getTextContent();
          // 按文本包含匹配原 PDF textItem
          item = tc.items.find(
            (ti: any) => ti.str && blockText.includes(ti.str.trim()),
          );
        } catch (e) {
          item = null;
        }
        const transform = item?.transform as number[] | undefined;
        const pdfAngle1 = transform
          ? (Math.atan2(transform[1], transform[0]) * 180) / Math.PI
          : null;
        const pdfAngle2 = transform
          ? (Math.atan2(transform[2], transform[3]) * 180) / Math.PI
          : null;
        rows.push({
          blockId,
          text: blockText.substring(0, 40),
          editableRotation: ctx.rotation,
          textItemTransform: transform ? [...transform] : null,
          pdfAngle1_atan2_t1_t0: pdfAngle1,
          pdfAngle2_atan2_t2_t3: pdfAngle2,
        });
      }
      console.log(
        "%c[Sprint34.17][RotationAudit]",
        "font-weight:bold;color:#06b6d4;",
        rows,
      );
      for (const r of rows) {
        console.log(
          `%c[Sprint34.17][RotRow] ${r.text} editableRotation=${r.editableRotation} ` +
            `transform=${r.textItemTransform ? JSON.stringify(r.textItemTransform.map((n: number) => +n.toFixed(3))) : "null"} ` +
            `angle1(atan2 t1,t0)=${r.pdfAngle1_atan2_t1_t0?.toFixed?.(2) ?? "n/a"} ` +
            `angle2(atan2 t2,t3)=${r.pdfAngle2_atan2_t2_t3?.toFixed?.(2) ?? "n/a"}`,
          "color:#f59e0b;",
        );
      }
      return rows;
    };
    return () => {
      delete (window as any).__rotationAudit;
    };
  }, [pdfDoc, page, signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.18: Signature Overlay Alignment Audit ──
  // 对比三层几何：Source OCR → EditableBlock → DOM render，定位坐标/rotation 偏移。
  // ── P0-008: Find First Identity ──
  // 定位第一处把 OCR transform 变成 Identity Matrix 的代码。
  // 打印 Editable 阶段（glyph.transform）与 Command 阶段（DrawGlyphCommand.transform），
  // 对比判断 transform 在哪丢失。只读诊断，不修改任何旋转逻辑。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__findFirstIdentity = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[P0-008] No EditableDocument.");
        return null;
      }
      const rows: any[] = [];
      for (const page of doc.pages) {
        for (const block of page.blocks) {
          const text = (block.lines ?? [])
            .map((l: any) => (l.glyphs ?? []).map((g: any) => g.char).join(""))
            .join(" ")
            .trim();
          if (!text) continue;
          const glyph = block.lines?.[0]?.glyphs?.[0];
          if (!glyph) continue;
          const isIdentity = (t?: any) =>
            !t ||
            (t[0] === 1 && t[1] === 0 && t[2] === 0 && t[3] === 1 && t[4] === 0 && t[5] === 0);
          rows.push({
            text: text.substring(0, 40),
            blockId: block.id,
            regionType: block.regionType ?? "-",
            layoutMode: block.layoutMode ?? "-",
            editable_transform: glyph.transform ?? "IDENTITY",
            editable_isIdentity: isIdentity(glyph.transform),
            editable_originalChar: glyph.originalChar ?? glyph.char,
          });
        }
      }
      // Command 阶段：通过 renderPageToCommands 读取 DrawGlyphCommand.transform
      const cmdRows: any[] = [];
      try {
        const suppressed = suppressedGlyphIdsRef.current;
        for (const page of doc.pages) {
          const cmds = renderPageToCommands(doc, page, suppressed, signatureRotationRef.current);
          for (const c of cmds) {
            if (c.type !== "drawGlyph") continue;
            const g = c as any;
            cmdRows.push({
              text: g.char,
              blockId: g.blockId,
              transform: g.transform ?? "IDENTITY",
            });
          }
        }
      } catch (e) {
        console.warn("[P0-008] Command audit failed", e);
      }
      console.log(
        "%c[P0-008][Editable Stage] (EditableBlock.glyph.transform)",
        "font-weight:bold;color:#22d3ee;",
        rows.filter((r) => r.text.toLowerCase().includes("jefferson") || r.text.toLowerCase().includes("jeferson")),
      );
      console.log(
        "%c[P0-008][Command Stage] (DrawGlyphCommand.transform) 前 10 条",
        "font-weight:bold;color:#f59e0b;",
        cmdRows.slice(0, 10),
      );
      return { editable: rows, command: cmdRows };
    };
    return () => {
      delete (window as any).__findFirstIdentity;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__sigGeometryAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.18] No EditableDocument.");
        return null;
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim();
        // 1. Source OCR geometry
        const sourceBBox = block.originalBounds ?? block.bbox;
        const sourceCenter = {
          x: sourceBBox.x + sourceBBox.width / 2,
          y: sourceBBox.y + sourceBBox.height / 2,
        };
        // 2. EditableBlock geometry
        const editableBBox = block.bbox;
        // 3. DOM render geometry (转文档坐标)
        let domBBox: any = null;
        let containerBBox: any = null;
        let computedTransform: string | null = null;
        let transformOrigin: string | null = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          const wrapperEl = document.querySelector(
            '[data-layer="wrapper"]',
          ) as HTMLElement | null;
          if (el && wrapperEl) {
            const r = el.getBoundingClientRect();
            const wRect = wrapperEl.getBoundingClientRect();
            const wrapperW = wrapperEl.clientWidth || 1;
            const pageDocWidth =
              doc.pages.find((p: any) =>
                p.blocks.some((b: any) => b.id === blockId),
              )?.width || wrapperW;
            const scale = wrapperW / pageDocWidth;
            domBBox = {
              x: (r.x - wRect.x) / scale,
              y: (r.y - wRect.y) / scale,
              width: r.width / scale,
              height: r.height / scale,
            };
            containerBBox = {
              x: wRect.x, y: wRect.y,
              width: wRect.width, height: wRect.height,
            };
            computedTransform = getComputedStyle(el).transform;
            transformOrigin = getComputedStyle(el).transformOrigin;
          }
        } catch {
          // ignore
        }
        // 4. 自动偏移
        const deltaX = domBBox ? domBBox.x - sourceBBox.x : null;
        const deltaY = domBBox ? domBBox.y - sourceBBox.y : null;
        rows.push({
          text: text.substring(0, 40),
          blockId,
          sourceBBox: { x: sourceBBox.x, y: sourceBBox.y, width: sourceBBox.width, height: sourceBBox.height },
          sourceCenter,
          sourceRotation: ctx.rotation,
          editableBBox: { x: editableBBox.x, y: editableBBox.y, width: editableBBox.width, height: editableBBox.height },
          editableRotation: ctx.rotation,
          domBBox,
          containerBBox,
          computedTransform,
          transformOrigin,
          deltaX,
          deltaY,
        });
      }
      console.log(
        "%c[Sprint34.18][SigSourceGeometry]",
        "font-weight:bold;color:#06b6d4;",
        rows.map((r) => ({ text: r.text, id: r.blockId, sourceBBox: r.sourceBBox, sourceCenter: r.sourceCenter, sourceRotation: r.sourceRotation })),
      );
      console.log(
        "%c[Sprint34.18][SigEditableGeometry]",
        "font-weight:bold;color:#22d3ee;",
        rows.map((r) => ({ text: r.text, editableBBox: r.editableBBox, editableRotation: r.editableRotation, transformOrigin: r.transformOrigin })),
      );
      console.log(
        "%c[Sprint34.18][SigDOMGeometry]",
        "font-weight:bold;color:#f59e0b;",
        rows.map((r) => ({ text: r.text, domBBox: r.domBBox, containerBBox: r.containerBBox, computedTransform: r.computedTransform })),
      );
      console.log(
        "%c[Sprint34.18][SigAlignmentDiff]",
        "font-weight:bold;color:#ef4444;",
        rows.map((r) => ({ text: r.text, deltaX: r.deltaX, deltaY: r.deltaY, rotationDiff: r.sourceRotation })),
      );
      return rows;
    };
    return () => {
      delete (window as any).__sigGeometryAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.20: Glyph Geometry Audit ──
  // 对比 EditableBlock bbox 与实际 glyph 绘制坐标，重点验证 baseline / font ascent-descent 偏移。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__glyphGeometryAudit = () => {
      const doc = editableDocumentRef.current;
      // Sprint34.20 diagnostic: context / doc 状态
      if (typeof console !== "undefined") {
        console.log(
          `%c[GlyphGeometryAudit] ctxSize=${signatureTransformContexts.size} doc=${!!doc} pages=${doc?.pages?.length} layoutDoc=${!!layoutDocument}`,
          "color:#ef4444;",
        );
        if (typeof window !== "undefined") {
          const dbg = (window as any).__signatureTransformContexts;
          console.log("[GlyphGeometryAudit] __signatureTransformContexts size=", dbg?.size ?? "n/a");
        }
      }
      if (!doc) {
        console.warn("[Sprint34.20] No EditableDocument.");
        return null;
      }
      // Sprint34.20 DOM 全局诊断（必定输出，确认 wrapper / 签名 span / glyphCommands 状态）
      if (typeof console !== "undefined") {
        try {
          const wrapperN = document.querySelectorAll('[data-layer="wrapper"]').length;
          const sigSpanN = document.querySelectorAll("[data-sig-block]").length;
          const dataLayers = Array.from(document.querySelectorAll("[data-layer]"))
            .map((el) => (el as HTMLElement).getAttribute("data-layer"))
            .slice(0, 20)
            .join(",");
          console.log(
            `%c[GlyphGeometryAudit][DOM] wrapper=${wrapperN} data-sig-block=${sigSpanN} data-layers=[${dataLayers}]`,
            "background:#7c3aed;color:#fff;font-weight:bold;",
          );
        } catch (e) {
          console.warn("[GlyphGeometryAudit][DOM] diag failed", e);
        }
      }
      const rows: any[] = [];
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim();
        // Sprint34.20 diagnostic: suppressed 状态 + 该 block 是否有 glyph 渲染命令
        if (typeof console !== "undefined") {
          const isSuppressed = suppressedGlyphIdsRef.current?.has(blockId);
          const gCount = (glyphCommands ?? []).filter(
            (c: any) => c.type === "drawGlyph" && c.blockId === blockId,
          ).length;
          console.log(
            `%c[GlyphGeometryAudit][RenderDiag] ${text} suppressed=${isSuppressed} glyphCmds=${gCount}`,
            isSuppressed ? "color:#ef4444;" : "color:#22d3ee;",
          );
        }
        const sourceBBox = block.originalBounds ?? block.bbox;
        const editableBBox = block.bbox;
        const style = (block.lines?.[0] as any)?.style || {};
        const fontSize = style.fontSize || 14;
        const fontFamily = style.fontFamily || "sans-serif";
        const lineHeight = fontSize * 1.3;
        // DOMRect（第一个字符 span，转文档坐标）
        let domRect: any = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          const wrapperEl = document.querySelector(
            '[data-layer="wrapper"]',
          ) as HTMLElement | null;
          // Sprint34.20 diagnostic: 若找不到 span/wrapper，输出原因
          if (!el) {
            const spans = Array.from(document.querySelectorAll("[data-sig-block]"));
            const n = spans.length;
            const ids = spans
              .map((s) => (s as HTMLElement).dataset.sigBlock)
              .slice(0, 10)
              .join(",");
            console.log(
              `%c[GlyphGeometryAudit][DomDiag] ${text} span NOT FOUND (total [data-sig-block]=${n}; ids=[${ids}])`,
              "color:#ef4444;",
            );
          }
          if (!wrapperEl) {
            console.log(
              `%c[GlyphGeometryAudit][DomDiag] wrapper NOT FOUND (total [data-layer] = ${document.querySelectorAll("[data-layer]").length})`,
              "color:#ef4444;",
            );
          }
          if (el && wrapperEl) {
            const r = el.getBoundingClientRect();
            const wRect = wrapperEl.getBoundingClientRect();
            const pageDocWidth =
              doc.pages.find((p: any) =>
                p.blocks.some((b: any) => b.id === blockId),
              )?.width || wrapperEl.clientWidth || 1;
            const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
            domRect = {
              x: (r.x - wRect.x) / scale,
              y: (r.y - wRect.y) / scale,
              width: r.width / scale,
              height: r.height / scale,
            };
          }
        } catch {
          domRect = null;
        }
        // font metrics（ascent / descent）
        let ascent: number | null = null;
        let descent: number | null = null;
        try {
          const cv = document.createElement("canvas");
          const cctx = cv.getContext("2d");
          if (cctx) {
            cctx.font = `${fontSize}px ${fontFamily}`;
            const m = cctx.measureText("Mg");
            if (typeof m.actualBoundingBoxAscent === "number") ascent = m.actualBoundingBoxAscent;
            if (typeof m.actualBoundingBoxDescent === "number") descent = m.actualBoundingBoxDescent;
          }
        } catch {
          // ignore
        }
        const deltaX = domRect ? domRect.x - sourceBBox.x : null;
        const deltaY = domRect ? domRect.y - sourceBBox.y : null;
        // baselineOffset: 文字底部 vs bbox 底部
        const baselineOffset =
          domRect && sourceBBox
            ? domRect.y + domRect.height - (sourceBBox.y + sourceBBox.height)
            : null;
        rows.push({
          text: text.substring(0, 40),
          blockId,
          sourceBBox: { x: sourceBBox.x, y: sourceBBox.y, width: sourceBBox.width, height: sourceBBox.height },
          editableBBox: { x: editableBBox.x, y: editableBBox.y, width: editableBBox.width, height: editableBBox.height },
          domRect,
          fontSize,
          lineHeight,
          baselineOffset,
          ascent,
          descent,
          deltaX,
          deltaY,
        });
      }
      console.log(
        "%c[GlyphGeometryAudit]",
        "font-weight:bold;color:#06b6d4;",
        rows,
      );
      for (const r of rows) {
        console.log(
          `%c[GlyphGeometryAudit] ${r.text} ` +
            `font=${r.fontSize} lineH=${r.lineHeight} ` +
            `ascent=${r.ascent?.toFixed?.(1) ?? "n/a"} descent=${r.descent?.toFixed?.(1) ?? "n/a"} ` +
            `baselineOffset=${r.baselineOffset?.toFixed?.(1) ?? "n/a"} ` +
            `deltaX=${r.deltaX?.toFixed?.(1) ?? "n/a"} deltaY=${r.deltaY?.toFixed?.(1) ?? "n/a"} ` +
            `srcTop=${r.sourceBBox?.y?.toFixed?.(1)} domTop=${r.domRect?.y?.toFixed?.(1)}`,
          "color:#f59e0b;",
        );
      }
      return rows;
    };
    return () => {
      delete (window as any).__glyphGeometryAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.20: Geometry Truth Audit ──
  // 三套几何统一对比：OCR → Editable → DOM，rAF 后读真实渲染位置。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__geometryTruthAudit = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.20] No EditableDocument.");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          const rows: any[] = [];
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ocr = block.originalBounds ?? block.bbox;
            const editable = block.bbox;
            const rotation = ctx.rotation;
            // DOM（转文档坐标，与 OCR/Editable 同系）
            let dom: any = null;
            try {
              const el = document.querySelector(
                `[data-sig-block="${blockId}"]`,
              ) as HTMLElement | null;
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              if (el && wrapperEl) {
                const r = el.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                dom = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
              }
            } catch {
              dom = null;
            }
            const ocrToEditable = editable
              ? { dx: editable.x - ocr.x, dy: editable.y - ocr.y }
              : null;
            const editableToDom =
              editable && dom
                ? { dx: dom.x - editable.x, dy: dom.y - editable.y }
                : null;
            rows.push({
              text,
              ocr: { x: ocr.x, y: ocr.y, w: ocr.width, h: ocr.height },
              editable: {
                x: editable.x,
                y: editable.y,
                w: editable.width,
                h: editable.height,
                rotation,
              },
              dom,
              ocrToEditable,
              editableToDom,
            });
          }
          // Sprint34.21: 统一格式输出，用 console.table 展开避免 Chrome 折叠
          console.log(
            "%c[Sprint34.21][GeometryTruthDetail]",
            "font-weight:bold;color:#06b6d4;",
          );
          const tableRows = rows.map((r) => ({
            text: r.text,
            "OCR.x": +r.ocr.x.toFixed(1),
            "OCR.y": +r.ocr.y.toFixed(1),
            "OCR.w": +r.ocr.w.toFixed(1),
            "OCR.h": +r.ocr.h.toFixed(1),
            "ED.x": r.editable ? +r.editable.x.toFixed(1) : null,
            "ED.y": r.editable ? +r.editable.y.toFixed(1) : null,
            "ED.w": r.editable ? +r.editable.w.toFixed(1) : null,
            "ED.h": r.editable ? +r.editable.h.toFixed(1) : null,
            "ED.rot": r.editable ? +r.editable.rotation.toFixed(3) : null,
            "DOM.x": r.dom ? +r.dom.x.toFixed(1) : null,
            "DOM.y": r.dom ? +r.dom.y.toFixed(1) : null,
            "DOM.w": r.dom ? +r.dom.width.toFixed(1) : null,
            "DOM.h": r.dom ? +r.dom.height.toFixed(1) : null,
            "OCR->ED.dx": r.ocrToEditable ? +r.ocrToEditable.dx.toFixed(2) : null,
            "OCR->ED.dy": r.ocrToEditable ? +r.ocrToEditable.dy.toFixed(2) : null,
            "ED->DOM.dx": r.editableToDom ? +r.editableToDom.dx.toFixed(2) : null,
            "ED->DOM.dy": r.editableToDom ? +r.editableToDom.dy.toFixed(2) : null,
          }));
          console.table(tableRows);
          // 同时输出文本行，便于复制（console.table 表格不便粘贴）
          for (const r of rows) {
            const d = (v: any) => (v === null || v === undefined ? "n/a" : (+v).toFixed(1));
            const d2 = (v: any) => (v === null || v === undefined ? "n/a" : (+v).toFixed(2));
            console.log(
              `[GT] ${r.text} | OCR(x=${d(r.ocr.x)},y=${d(r.ocr.y)},w=${d(r.ocr.w)},h=${d(r.ocr.h)}) ` +
                `| ED(x=${r.editable ? d(r.editable.x) : "n/a"},y=${r.editable ? d(r.editable.y) : "n/a"},w=${r.editable ? d(r.editable.w) : "n/a"},h=${r.editable ? d(r.editable.h) : "n/a"},rot=${r.editable ? (+r.editable.rotation).toFixed(3) : "n/a"}) ` +
                `| DOM(x=${r.dom ? d(r.dom.x) : "n/a"},y=${r.dom ? d(r.dom.y) : "n/a"},w=${r.dom ? d(r.dom.width) : "n/a"},h=${r.dom ? d(r.dom.height) : "n/a"}) ` +
                `| ocr->ed(dx=${d2(r.ocrToEditable?.dx)},dy=${d2(r.ocrToEditable?.dy)}) ` +
                `| ed->dom(dx=${d2(r.editableToDom?.dx)},dy=${d2(r.editableToDom?.dy)})`,
            );
          }
          resolve(rows);
        });
      });
    };
    return () => {
      delete (window as any).__geometryTruthAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.22: Glyph Container Geometry Audit ──
  // 测量整个文本容器（签名 wrapper），对比 EditableBBox，计算 scale 与 diff。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__glyphContainerTruth = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.22] No EditableDocument.");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          const rows: any[] = [];
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ed = block.bbox;
            let container: any = null;
            try {
              const el = document.querySelector(
                `[data-sig-block="${blockId}"]`,
              ) as HTMLElement | null;
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              if (el && wrapperEl) {
                // Sprint34.24: 容器 = 该 block 的独立 GlyphContainer（data-sig-block-container）
                const containerEl = document.querySelector(
                  `[data-sig-block-container="${blockId}"]`,
                ) as HTMLElement | null;
                const cEl = containerEl || el;
                const r = cEl.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                container = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
              }
            } catch {
              container = null;
            }
            const widthRatio = ed && container ? container.width / ed.width : null;
            const heightRatio = ed && container ? container.height / ed.height : null;
            rows.push({
              text,
              editable: { x: ed.x, y: ed.y, w: ed.width, h: ed.height },
              domContainer: container,
              scale: { widthRatio, heightRatio },
              diff: container
                ? {
                    dx: container.x - ed.x,
                    dy: container.y - ed.y,
                    dw: container.width - ed.width,
                    dh: container.height - ed.height,
                  }
                : null,
            });
          }
          console.log(
            "%c[Sprint34.22][GlyphContainerTruth]",
            "font-weight:bold;color:#06b6d4;",
            "",
          );
          const tableRows = rows.map((r) => ({
            text: r.text,
            "ED.x": r.editable ? +r.editable.x.toFixed(1) : null,
            "ED.y": r.editable ? +r.editable.y.toFixed(1) : null,
            "ED.w": r.editable ? +r.editable.w.toFixed(1) : null,
            "ED.h": r.editable ? +r.editable.h.toFixed(1) : null,
            "DOM.x": r.domContainer ? +r.domContainer.x.toFixed(1) : null,
            "DOM.y": r.domContainer ? +r.domContainer.y.toFixed(1) : null,
            "DOM.w": r.domContainer ? +r.domContainer.width.toFixed(1) : null,
            "DOM.h": r.domContainer ? +r.domContainer.height.toFixed(1) : null,
            "wRatio": r.scale?.widthRatio ? +r.scale.widthRatio.toFixed(3) : null,
            "hRatio": r.scale?.heightRatio ? +r.scale.heightRatio.toFixed(3) : null,
            "dx": r.diff ? +r.diff.dx.toFixed(2) : null,
            "dy": r.diff ? +r.diff.dy.toFixed(2) : null,
            "dw": r.diff ? +r.diff.dw.toFixed(2) : null,
            "dh": r.diff ? +r.diff.dh.toFixed(2) : null,
          }));
          console.table(tableRows);
          for (const r of rows) {
            const f1 = (v: any) => (v == null ? "n/a" : (+v).toFixed(1));
            const f2 = (v: any) => (v == null ? "n/a" : (+v).toFixed(3));
            console.log(
              `[GCT] ${r.text} | ED(x=${f1(r.editable.x)},y=${f1(r.editable.y)},w=${f1(r.editable.w)},h=${f1(r.editable.h)}) ` +
                `| DOM(x=${r.domContainer ? f1(r.domContainer.x) : "n/a"},y=${r.domContainer ? f1(r.domContainer.y) : "n/a"},w=${r.domContainer ? f1(r.domContainer.width) : "n/a"},h=${r.domContainer ? f1(r.domContainer.height) : "n/a"}) ` +
                `| wRatio=${f2(r.scale?.widthRatio)} hRatio=${f2(r.scale?.heightRatio)} ` +
                `| diff(dx=${f2(r.diff?.dx)},dy=${f2(r.diff?.dy)},dw=${f2(r.diff?.dw)},dh=${f2(r.diff?.dh)})`,
            );
          }
          resolve(rows);
        });
      });
    };
    return () => {
      delete (window as any).__glyphContainerTruth;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.23: GlyphRenderer Block Isolation Audit ──
  // 验证每个 EditableBlock 是否有独立 glyph container，还是多个 block 共享同一 region container。
  useEffect(() => {
    if (typeof window === "undefined") return;

    // __glyphTreeAudit: 输出 DOM 树结构（Region → Container → Blocks → glyphs）
    (window as any).__glyphTreeAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.23] No doc");
        return;
      }
      console.log(
        "%c[Sprint34.23][GlyphTree]",
        "font-weight:bold;color:#06b6d4;",
      );
      // 收集所有签名 block 的容器（offsetParent wrapper）
      const seen = new Set<string>();
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim();
        const el = document.querySelector(
          `[data-sig-block="${blockId}"]`,
        ) as HTMLElement | null;
        const containerEl = el?.offsetParent as HTMLElement | null;
        const containerKey = containerEl
          ? `${containerEl.style.left}|${containerEl.style.top}|${containerEl.style.width}|${containerEl.style.height}`
          : "none";
        seen.add(containerKey);
        const glyphCount = el
          ? document.querySelectorAll(`[data-sig-block="${blockId}"]`).length
          : 0;
        console.log(
          `Block: text="${text}" blockId=${blockId} ` +
            `containerId=${containerEl ? (containerEl as any).dataset?.regionId ?? "?" : "none"} ` +
            `containerKey=[${containerKey}] ` +
            `glyphCount=${glyphCount} ` +
            (seen.size > 0 ? `SHARED=${[...seen].length > 1 ? "independent" : "check"}` : ""),
        );
      }
      console.log(
        `%c[Sprint34.23][GlyphTree] Distinct container keys = ${seen.size} (blocks = ${signatureTransformContexts.size})`,
        "color:#ef4444;font-weight:bold;",
      );
      console.log(
        seen.size < signatureTransformContexts.size && signatureTransformContexts.size > 0
          ? "%c>>> 多个 block 共享同一容器 → renderer 粒度错误（region 级渲染）"
          : "%c>>> 每个 block 独立容器（block 级渲染）",
        "color:#f59e0b;font-weight:bold;",
      );
    };

    // __glyphMappingAudit: Block → DOM 映射表，验证是否共享 DOM bbox
    (window as any).__glyphMappingAudit = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.23] No doc");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          const rows: any[] = [];
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ed = block.bbox;
            let dom: any = null;
            let containerKey: string | null = null;
            try {
              const el = document.querySelector(
                `[data-sig-block="${blockId}"]`,
              ) as HTMLElement | null;
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              if (el && wrapperEl) {
                // Sprint34.24: 容器 = 该 block 的独立 GlyphContainer
                const containerEl = document.querySelector(
                  `[data-sig-block-container="${blockId}"]`,
                ) as HTMLElement | null;
                const cEl = containerEl || el;
                const r = cEl.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                dom = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
                containerKey = `${dom.x.toFixed(1)}|${dom.y.toFixed(1)}|${dom.width.toFixed(1)}|${dom.height.toFixed(1)}`;
              }
            } catch {
              dom = null;
            }
            rows.push({
              text,
              editable: { w: ed.width, h: ed.height, cx: ed.x + ed.width / 2, cy: ed.y + ed.height / 2 },
              dom: dom
                ? { w: dom.width, h: dom.height, cx: dom.x + dom.width / 2, cy: dom.y + dom.height / 2 }
                : null,
              containerKey,
              ratio: dom
                ? {
                    w: dom.width / ed.width,
                    h: dom.height / ed.height,
                  }
                : null,
              centerOffset: dom
                ? {
                    dx: dom.x + dom.width / 2 - (ed.x + ed.width / 2),
                    dy: dom.y + dom.height / 2 - (ed.y + ed.height / 2),
                  }
                : null,
            });
          }
          console.log(
            "%c[Sprint34.23][GlyphMapping]",
            "font-weight:bold;color:#06b6d4;",
            "",
          );
          const table = rows.map((r) => ({
            text: r.text,
            "ED.w": r.editable ? +r.editable.w.toFixed(1) : null,
            "ED.h": r.editable ? +r.editable.h.toFixed(1) : null,
            "ED.cx": r.editable ? +r.editable.cx.toFixed(1) : null,
            "ED.cy": r.editable ? +r.editable.cy.toFixed(1) : null,
            "DOM.w": r.dom ? +r.dom.w.toFixed(1) : null,
            "DOM.h": r.dom ? +r.dom.h.toFixed(1) : null,
            "DOM.cx": r.dom ? +r.dom.cx.toFixed(1) : null,
            "DOM.cy": r.dom ? +r.dom.cy.toFixed(1) : null,
            "ratio.w": r.ratio ? +r.ratio.w.toFixed(3) : null,
            "ratio.h": r.ratio ? +r.ratio.h.toFixed(3) : null,
            "center.dx": r.centerOffset ? +r.centerOffset.dx.toFixed(2) : null,
            "center.dy": r.centerOffset ? +r.centerOffset.dy.toFixed(2) : null,
            containerKey: r.containerKey,
          }));
          console.table(table);
          // 检查是否共享容器（只统计有 DOM 的 block；DOM=null 的 suppressed block 无容器不算共享）
          const keyed = rows.filter((r) => !!r.containerKey);
          const keys = keyed.map((r) => r.containerKey);
          const unique = new Set(keys).size;
          const noDomCount = rows.length - keyed.length;
          console.log(
            `%c[Sprint34.23][GlyphMapping] DOM bboxes distinct=${unique} (blocks with DOM=${keyed.length}, no-DOM/suppressed=${noDomCount})`,
            "color:#ef4444;font-weight:bold;",
          );
          console.log(
            unique < keyed.length
              ? "%c>>> 多个渲染 block 共享同一 DOM bbox → renderer 粒度错误（region 级容器）"
              : `%c>>> 每个渲染 block 独立 DOM bbox（distinct=${unique} == rendered=${keyed.length}）`,
            "color:#f59e0b;font-weight:bold;",
          );
          resolve(rows);
        });
      });
    };

    return () => {
      delete (window as any).__glyphTreeAudit;
      delete (window as any).__glyphMappingAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.24: GlyphContainer Size Source Audit ──
  // 定位 EditableBlock → GlyphContainer → Glyph DOM 在哪一步丢失 width。
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__glyphSizeSourceAudit = () => {
      return new Promise((resolve) => {
        const doc = editableDocumentRef.current;
        if (!doc) {
          console.warn("[Sprint34.24] No doc");
          resolve(null);
          return;
        }
        requestAnimationFrame(() => {
          console.log(
            "%c[Sprint34.24][GlyphSizeSource]",
            "font-weight:bold;color:#06b6d4;",
          );
          for (const [blockId, ctx] of signatureTransformContexts) {
            const block = doc.pages
              .flatMap((p) => p.blocks)
              .find((b) => b.id === blockId);
            if (!block) continue;
            const text = (ctx.blocks[0]?.text ?? "").trim();
            const ed = block.bbox;
            // GlyphContainer DOM bbox
            let dom: any = null;
            let computed: any = null;
            try {
              const wrapperEl = document.querySelector(
                '[data-layer="wrapper"]',
              ) as HTMLElement | null;
              const cEl = document.querySelector(
                `[data-sig-block-container="${blockId}"]`,
              ) as HTMLElement | null;
              if (cEl && wrapperEl) {
                const r = cEl.getBoundingClientRect();
                const wRect = wrapperEl.getBoundingClientRect();
                const pageDocWidth =
                  doc.pages.find((p: any) =>
                    p.blocks.some((b: any) => b.id === blockId),
                  )?.width || wrapperEl.clientWidth || 1;
                const scale = (wrapperEl.clientWidth || 1) / pageDocWidth;
                dom = {
                  x: (r.x - wRect.x) / scale,
                  y: (r.y - wRect.y) / scale,
                  width: r.width / scale,
                  height: r.height / scale,
                };
                const cs = getComputedStyle(cEl);
                computed = {
                  display: cs.display,
                  width: cs.width,
                  maxWidth: cs.maxWidth,
                  minWidth: cs.minWidth,
                  transform: cs.transform,
                  boxSizing: cs.boxSizing,
                  position: cs.position,
                  flex: cs.flex,
                  flexBasis: cs.flexBasis,
                };
              }
            } catch {
              dom = null;
            }
            // textMeasure: canvas measureText vs glyph advance sum
            let canvasWidth: number | null = null;
            let glyphAdvanceWidth: number | null = null;
            try {
              const style = (block.lines?.[0] as any)?.style || {};
              const fs = style.fontSize || 14;
              const ff = style.fontFamily || "sans-serif";
              const cv = document.createElement("canvas");
              const cctx = cv.getContext("2d");
              if (cctx) {
                cctx.font = `${fs}px ${ff}`;
                canvasWidth = cctx.measureText(text).width;
              }
              let sum = 0;
              for (const l of block.lines ?? []) for (const g of (l as any).glyphs ?? []) sum += g.width ?? 0;
              glyphAdvanceWidth = sum;
            } catch {
              // ignore
            }
            // Render Contract: input(EditableBlock) vs output(GlyphContainer)
            const violation =
              dom && Math.abs(dom.width - ed.width) > 0.5;
            console.log(`%c[Sprint34.24][GlyphSizeSource] text="${text}"`, "color:#22d3ee;");
            console.log(
              `  EditableBlock: x=${ed.x.toFixed(1)} y=${ed.y.toFixed(1)} w=${ed.width.toFixed(1)} h=${ed.height.toFixed(1)}`,
            );
            console.log(
              `  GlyphContainer: x=${dom ? dom.x.toFixed(1) : "n/a"} y=${dom ? dom.y.toFixed(1) : "n/a"} w=${dom ? dom.width.toFixed(1) : "n/a"} h=${dom ? dom.height.toFixed(1) : "n/a"}`,
            );
            console.log(
              `  widthSource: EditableBlock=${ed.width.toFixed(1)} DOM=${dom ? dom.width.toFixed(1) : "n/a"} => ${violation ? "VIOLATION (renderer 重新测量)" : "ok"}`,
            );
            console.log("  computedStyle:", computed);
            console.log(
              `  textMeasure: canvasWidth=${canvasWidth ? canvasWidth.toFixed(1) : "n/a"} glyphAdvanceWidth=${glyphAdvanceWidth ? glyphAdvanceWidth.toFixed(1) : "n/a"}`,
            );
            console.log(
              `%c[Sprint34.24][RenderContract] input width=${ed.width.toFixed(1)} output width=${dom ? dom.width.toFixed(1) : "n/a"} violation=${violation}`,
              violation ? "color:#ef4444;font-weight:bold;" : "color:#22d3ee;",
            );
          }
          resolve(null);
        });
      });
    };
    return () => {
      delete (window as any).__glyphSizeSourceAudit;
    };
  }, [signatureTransformContexts, editableDocVersion]);

  // ── Sprint34.25: Rotation Chain Audit ──
  // 一次性输出 rotation 全链路：signatureRotationRef → signatureTransformContexts → layout → 实际 span
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__rotationChainAudit = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.25] No doc");
        return;
      }
      console.log(
        "%c[Sprint34.25][RotationChain]",
        "font-weight:bold;color:#06b6d4;",
      );
      for (const [blockId, ctx] of signatureTransformContexts) {
        const block = doc.pages
          .flatMap((p) => p.blocks)
          .find((b) => b.id === blockId);
        if (!block) continue;
        const text = (ctx.blocks[0]?.text ?? "").trim().substring(0, 40);
        const refRot = signatureRotationRef.current.get(blockId);
        const ctxRot = ctx.rotation;
        // layout 里该 block 所在 signature 节点的 rotation
        let layoutRot: number | null = null;
        let regionId = "";
        try {
          for (const pg of layoutDocument?.pages ?? []) {
            for (const topNode of pg.children) {
              if (topNode.type === "signature") {
                for (const ch of topNode.children) {
                  if (ch.sourceBlockId === blockId) {
                    layoutRot = topNode.transform.rotation;
                    regionId = topNode.id;
                  }
                }
              }
            }
          }
        } catch {
          layoutRot = null;
        }
        // 实际渲染 span 的 style.transform
        let spanTransform: string | null = null;
        try {
          const el = document.querySelector(
            `[data-sig-block="${blockId}"]`,
          ) as HTMLElement | null;
          if (el) spanTransform = el.style.transform || "none";
        } catch {
          spanTransform = null;
        }
        console.log(
          `%c[Sprint34.25][RotationChain] ${text}`,
          "color:#22d3ee;",
        );
        console.log(
          `  signatureRotationRef=${refRot?.toFixed?.(3) ?? "undefined"} ` +
            `signatureTransformContexts.rotation=${ctxRot?.toFixed?.(3)} ` +
            `layout.regionId=${regionId || "-"} layout.transform.rotation=${layoutRot?.toFixed?.(3) ?? "null"} ` +
            `span.style.transform="${spanTransform}"`,
        );
      }
    };
    return () => {
      delete (window as any).__rotationChainAudit;
    };
  }, [signatureTransformContexts, layoutDocument, editableDocVersion]);

  // ── Sprint 33: window.__layoutDebug() 暴露 ──
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__layoutDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33] No layout document. Upload a PDF with OCR first.");
        return null;
      }
      const summary = layoutDebugSummary(layoutDocument);
      console.log("[Sprint33] Layout Debug:");
      for (const page of summary.pages) {
        console.log(`  Page: ${page.id}`);
        for (const node of page.topLevel) {
          console.log(
            `    ${node.type}: "${node.textPreview}"`,
            `| lines:${node.lineCount} words:${node.wordCount} glyphs:${node.glyphCount}`,
            `| rot:${node.rotation.toFixed(1)}°`,
          );
        }
      }
      // Also attach full tree for JSON inspection
      (window as any).__layoutTree = layoutDocument;
      return summary;
    };
    (window as any).__layoutDump = (maxDepth?: number, maxTextLen?: number) => {
      if (!layoutDocument) {
        console.warn("[Sprint33] No layout document. Upload a PDF with OCR first.");
        return;
      }
      const dump = layoutDump(layoutDocument, {
        maxDepth: maxDepth ?? 3,
        maxTextLen: maxTextLen ?? 72,
      });
      console.log(dump);
      return dump;
    };
    // Sprint 33.3.5 Task 1: Dump only signature nodes with rotation + children
    (window as any).__signatureLayoutDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.5] No layout document. Upload a PDF with OCR first.");
        return null;
      }
      console.group("%c[Sprint33.3.5] Signature Layout Debug", "font-weight:bold;color:#a855f7;");
      const results: any[] = [];
      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "signature") continue;
          const sigInfo: any = {
            id: topNode.id,
            type: topNode.type,
            bbox: topNode.bbox,
            rotation: topNode.transform.rotation,
            transform: topNode.transform,
            children: [],
          };
          for (const child of topNode.children) {
            const childInfo: any = {
              id: child.id,
              type: child.type,
              bbox: child.bbox,
              rotation: child.transform.rotation,
              sourceBlockId: child.sourceBlockId,
              grandChildren: child.children?.map((gc: any) => ({
                id: gc.id,
                type: gc.type,
                bbox: gc.bbox,
                sourceBlockId: gc.sourceBlockId,
              })) || [],
            };
            sigInfo.children.push(childInfo);
          }
          results.push(sigInfo);
          console.log(`%c${sigInfo.id}%c rot=${sigInfo.rotation.toFixed(1)}° bbox=(${sigInfo.bbox.x.toFixed(0)},${sigInfo.bbox.y.toFixed(0)} ${sigInfo.bbox.width.toFixed(0)}x${sigInfo.bbox.height.toFixed(0)})`,
            "font-weight:bold;color:#a855f7;", "color:#666;");
          for (const child of sigInfo.children) {
            const isLine = child.type === "signature_line";
            const label = isLine ? `  ${child.type}` : `  ${child.type}`;
            const extra = child.sourceBlockId ? ` blockId=${child.sourceBlockId}` : "";
            console.log(`    %c${label}%c rot=${child.rotation.toFixed(0)}° bbox=(${child.bbox.x.toFixed(0)},${child.bbox.y.toFixed(0)} ${child.bbox.width.toFixed(0)}x${child.bbox.height.toFixed(0)})${extra}${isLine ? " (synthesized line)" : ""}`,
              isLine ? "color:#94a3b8;" : "color:#cbd5e1;", "color:#666;");
          }
        }
      }
      if (results.length === 0) {
        console.log("  (no signature nodes found in layout tree)");
      }
      console.groupEnd();
      return results;
    };

    // Sprint 33.3.5.1: Dump transform chain from EditableDocument perspective.
    // Confirms that only the parent SIGNATURE block carries rotation,
    // and that child text blocks remain at rotation=0 (no double-rotation).
    (window as any).__editableTransformDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.5.1] No EditableDocument. Upload a PDF with OCR first.");
        return null;
      }
      if (!layoutDocument) {
        console.warn("[Sprint33.3.5.1] No LayoutDocument for cross-referencing signature nodes.");
        return null;
      }

      // Build a lookup: editableBlockId → signature node rotation from LayoutTree
      const sigBlockRotations = new Map<string, number>();
      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "signature") continue;
          const sigRot = topNode.transform.rotation;
          for (const child of topNode.children) {
            if (child.sourceBlockId) {
              sigBlockRotations.set(child.sourceBlockId, sigRot);
            }
          }
        }
      }

      console.group("%c[Sprint33.3.5.1] EditableDocument Transform Debug", "font-weight:bold;color:#22d3ee;");

      const allSigBlocks: any[] = [];

      for (let pi = 0; pi < doc.pages.length; pi++) {
        const page = doc.pages[pi];
        for (const block of page.blocks) {
          // Sprint 33.3.5.2: Identify signature blocks via LayoutTree sigBlockRotations
          // (no longer by block.transform.rotation, since child blocks now carry rotation=0)
          const isSig = block.regionType === "signature"
            || sigBlockRotations.has(block.id);

          if (!isSig) continue;

          const blockText = block.lines
            .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
            .join(" ");

          const entry: any = {
            id: block.id,
            type: block.type,
            regionType: block.regionType,
            text: blockText.substring(0, 60),
            transform: block.transform || null,
            layoutSigRot: sigBlockRotations.get(block.id) ?? null,
            children: null as any[] | null,
            page: pi + 1,
          };

          // If this is a parent signature block with children, dump them
          if (block.children && block.children.length > 0) {
            entry.children = block.children.map((child: any) => ({
              id: child.id,
              type: child.type,
              regionType: child.regionType,
              text: child.lines
                ?.map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
                .join(" ") || "-",
              transform: child.transform || null,
            }));
          }

          allSigBlocks.push(entry);
        }
      }

      if (allSigBlocks.length === 0) {
        console.log("  (no signature blocks with transform found in EditableDocument)");
      } else {
        for (const b of allSigBlocks) {
          const rotStr = b.transform?.rotation != null
            ? `${b.transform.rotation.toFixed(1)}°`
            : "undefined";
          const layoutStr = b.layoutSigRot != null
            ? ` (layout: ${b.layoutSigRot.toFixed(1)}°)`
            : " (not in layout tree)";
          const hasChildren = b.children && b.children.length > 0;
          const isParent = b.type === "SIGNATURE" || b.regionType === "signature";

          console.log(
            `%c${isParent ? "SIGNATURE_BLOCK" : b.regionType || b.type}%c "${b.text}"%c rot=${rotStr}${layoutStr}${hasChildren ? ` children:${b.children.length}` : ""}`,
            "font-weight:bold;color:#22d3ee;",
            "color:#e2e8f0;",
            "color:#94a3b8;",
          );

          if (b.children) {
            for (const child of b.children) {
              const cRot = child.transform?.rotation ?? 0;
              const cRotStr = cRot !== 0 ? `${cRot.toFixed(1)}° ⚠️ DOUBLE-ROTATION!` : "0°";
              const cColor = cRot !== 0 ? "color:#ef4444;font-weight:bold;" : "color:#64748b;";
              console.log(`    %c├── "${child.text}"%c rotation:${cRotStr}`,
                "color:#cbd5e1;", cColor);
            }
          }

          if (!b.children && b.transform?.rotation) {
            // Block has transform but no children — it is a signature SUB-block
            const parentRot = b.layoutSigRot;
            if (parentRot != null && Math.abs(parentRot) > 0.01) {
              console.log(`    %c↳ parent rotation: ${parentRot.toFixed(1)}° (from LayoutTree SIGNATURE node)`,
                "color:#64748b;");
            }
          }
        }
      }

      console.groupEnd();
      return allSigBlocks;
    };

    // Sprint 33.3.5.2: Dump signature coordinate systems.
    // Shows world (absolute) ↔ local (relative to parent container) coordinates.
    // Parent uses left-top as transform-origin; children use local coords with rotation=0.
    (window as any).__signatureCoordinateDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.5.2] No EditableDocument. Upload a PDF with OCR first.");
        return null;
      }

      // Use signatureRegionMap (from layout tree) to identify which blocks belong
      // to signature regions. Child blocks now have rotation=0, so we can't detect
      // them by block.transform.rotation anymore (correctly!).
      const layoutMap: Map<string, { regionId: string; rotation: number }> | undefined =
        typeof window !== "undefined" ? (window as any).__signatureRegionMap : undefined;

      if (!layoutMap || layoutMap.size === 0) {
        console.warn("[Sprint33.3.5.2] No __signatureRegionMap. Try __signatureLayoutDebug() first.");
        return null;
      }

      // Build region groups from layoutMap
      const regionGroups: Map<string, { blocks: any[]; rotation: number }> = new Map();

      for (const page of doc.pages) {
        for (const block of page.blocks) {
          const ri = layoutMap.get(block.id);
          if (!ri) continue;
          if (!regionGroups.has(ri.regionId)) {
            regionGroups.set(ri.regionId, { blocks: [], rotation: ri.rotation });
          }
          regionGroups.get(ri.regionId)!.blocks.push(block);
        }
      }

      console.group(
        "%c[Sprint33.3.5.2] Signature Coordinate System Debug",
        "font-weight:bold;color:#f59e0b;",
      );
      let totalBlockCount = 0;
      regionGroups.forEach(g => { totalBlockCount += g.blocks.length; });
      console.log(`  %c${totalBlockCount} signature sub-blocks in ${regionGroups.size} region(s)`,
        "color:#94a3b8;");

      const allResults: any[] = [];

      for (const [regionId, group] of regionGroups) {
        const { blocks, rotation } = group;

        // Compute parent bbox (world coordinates) = union of all child bboxes
        const parentX = Math.min(...blocks.map(b => b.bbox.x));
        const parentY = Math.min(...blocks.map(b => b.bbox.y));
        const parentW = Math.max(...blocks.map(b => b.bbox.x + b.bbox.width)) - parentX;
        const parentH = Math.max(...blocks.map(b => b.bbox.y + b.bbox.height)) - parentY;

        console.group(
          `%cSIGNATURE_BLOCK %c${regionId}`,
          "font-weight:bold;color:#f59e0b;",
          "color:#94a3b8;",
        );
        console.log(`  bbox: %cx:${parentX.toFixed(1)} y:${parentY.toFixed(1)} w:${parentW.toFixed(1)} h:${parentH.toFixed(1)}`,
          "color:#64748b;");
        console.log(`  rotation: %c${rotation.toFixed(1)}°%c  origin: %cleft top (0 0)`,
          "color:#f59e0b;", "color:#94a3b8;", "color:#64748b;");
        console.log("  Children:");

        const children: any[] = [];
        for (const block of blocks) {
          const text = block.lines
            .map((l: any) => l.glyphs.map((g: any) => g.char).join(""))
            .join(" ");
          const worldX = block.bbox.x;
          const worldY = block.bbox.y;
          const localX = worldX - parentX;
          const localY = worldY - parentY;
          const childRot = block.transform?.rotation ?? 0;

          children.push({
            text: text.substring(0, 50),
            id: block.id,
            world: { x: +worldX.toFixed(1), y: +worldY.toFixed(1) },
            local: { x: +localX.toFixed(1), y: +localY.toFixed(1) },
            rotation: childRot,
          });
        }

        // Sort children by localY (top to bottom) then localX (left to right)
        children.sort((a: any, b: any) => {
          const yDiff = a.local.y - b.local.y;
          if (Math.abs(yDiff) > 5) return yDiff;
          return a.local.x - b.local.x;
        });

        for (const child of children) {
          const rotIndicator = child.rotation !== 0
            ? `%c⚠️ rot=${child.rotation}°`
            : "%c✓ rotation:0";
          const rotColor = child.rotation !== 0
            ? "color:#ef4444;font-weight:bold;"
            : "color:#22c55e;";

          console.log(
            `    %c"${child.text}"%c`,
            "color:#e2e8f0;font-weight:bold;", "",
          );
          console.log(
            `      %cworld:%c (${child.world.x}, ${child.world.y})  %clocal:%c (${child.local.x}, ${child.local.y})`,
            "color:#64748b;", "color:#94a3b8;",
            "color:#64748b;", "color:#94a3b8;",
          );
          console.log(`      ${rotIndicator}`, rotColor);
        }

        allResults.push({
          regionId,
          bbox: { x: parentX, y: parentY, w: parentW, h: parentH },
          rotation,
          origin: "left top",
          children,
        });

        console.groupEnd();
      }

      // Summary: any DOUBLE-ROTATION detected?
      const doubleRotCount = allResults.reduce(
        (sum, r) => sum + r.children.filter((c: any) => c.rotation !== 0).length,
        0,
      );
      if (doubleRotCount > 0) {
        console.log(
          `%c⚠️ DOUBLE-ROTATION DETECTED: ${doubleRotCount} child block(s) have non-zero rotation!`,
          "color:#ef4444;font-weight:bold;font-size:1.1em;",
        );
      } else {
        console.log(
          "%c✅ All children at rotation=0. Only parent SIGNATURE_BLOCK carries rotation.",
          "color:#22c55e;font-weight:bold;",
        );
      }

      console.groupEnd();
      return allResults;
    };

    (window as any).__lineReconstructionDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.1] No layout document.");
        return null;
      }
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.1] No EditableDocument.");
        return null;
      }

      const results: Array<{
        paragraphId: string;
        originalOCRLines: string[];
        reconstructedLines: string[];
        decisions: Array<{ word: string; moved: boolean; reason: string }>;
      }> = [];

      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "paragraph") continue;
          if (topNode.children.length === 0) continue;

          const targetBlock = doc.pages[0]?.blocks.find(
            (b) => b.id === topNode.children[0]?.sourceBlockId,
          );
          const originalLines: string[] = [];
          if (targetBlock) {
            for (const line of targetBlock.lines) {
              originalLines.push(line.glyphs.map((g) => g.char).join(""));
            }
          }

          const reconstructedLines = topNode.children
            .filter((c: any) => c.type === "line")
            .map((l: any) => l.text ?? "");

          const decisions: Array<{ word: string; moved: boolean; reason: string }> = [];
          const origWords = originalLines.join(" ").split(" ");
          const reconWords = reconstructedLines.join(" ").split(" ");

          // 对比原行与重建行：找出 moved words
          for (let ri = 0; ri < reconstructedLines.length; ri++) {
            const rWords = reconstructedLines[ri].split(" ");
            const lastRWord = rWords[rWords.length - 1]?.toLowerCase();
            if (lastRWord && ["a", "de", "para"].includes(lastRWord)) {
              decisions.push({
                word: lastRWord,
                moved: false,
                reason: "natural_break_preposition",
              });
            }
          }

          results.push({
            paragraphId: topNode.id,
            originalOCRLines: originalLines,
            reconstructedLines,
            decisions: decisions.slice(0, 20),
          });
        }
      }

      if (results.length === 0) {
        console.warn("[Sprint33.3.1] No paragraph nodes found in layout document.");
        return null;
      }

      console.log(
        "%c── Line Reconstruction Debug ──",
        "font-weight:bold;font-size:14px;color:#8b5cf6;",
      );
      for (const r of results) {
        console.group(`Paragraph: ${r.paragraphId}`);
        console.log("%cOriginal OCR lines:", "color:#f59e0b;");
        for (const l of r.originalOCRLines) {
          console.log(`  "${l}"`);
        }
        console.log("%cReconstructed lines:", "color:#22c55e;");
        for (const l of r.reconstructedLines) {
          console.log(`  "${l}"`);
        }
        if (r.decisions.length > 0) {
          console.log("%cDecisions:", "color:#8b5cf6;");
          console.table(r.decisions);
        }
        console.groupEnd();
      }
      return results;
    };

    // ── Sprint34.4.2: __ocrLineDebug() 数据确认 ──
    // 目标：确认 OCR 数据结构能力，判断能否做 Adobe 级换行恢复。
    // 输出：OCR 原始 lines（text+bbox） + 每行 word 级信息 + 三个问题的回答。
    (window as any).__ocrLineDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint34.4.2] No EditableDocument.");
        return null;
      }
      const page = doc.pages[0];
      if (!page) {
        console.warn("[Sprint34.4.2] No page.");
        return null;
      }

      console.log(
        "%c── OCR Line / Word Coordinate Inspection ──",
        "font-weight:bold;font-size:14px;color:#0ea5e9;",
      );

      // 按空格对 glyph 分组推导 word bbox（与 line-reconstruction.ts 的 word 推导一致）
      const wordsFromGlyphs = (glyphs: any[]) => {
        const words: Array<{ text: string; bbox: { x: number; y: number; width: number; height: number } }> = [];
        let current: any[] = [];
        const flush = () => {
          if (current.length === 0) return;
          const xs = current.map((g) => g.bbox.x);
          const ys = current.map((g) => g.bbox.y);
          const rights = current.map((g) => g.bbox.x + g.bbox.width);
          const bottoms = current.map((g) => g.bbox.y + g.bbox.height);
          words.push({
            text: current.map((g) => g.char).join(""),
            bbox: {
              x: Math.min(...xs),
              y: Math.min(...ys),
              width: Math.max(...rights) - Math.min(...xs),
              height: Math.max(...bottoms) - Math.min(...ys),
            },
          });
          current = [];
        };
        for (const g of glyphs) {
          if (g.char === " ") {
            flush();
          } else {
            current.push(g);
          }
        }
        flush();
        return words;
      };

      const blockCount = page.blocks.length;
      let totalLines = 0;
      let lineHasBbox = true;
      let anyWordBbox = false;

      for (let bi = 0; bi < page.blocks.length; bi++) {
        const block = page.blocks[bi];
        // EditableBlock/EditableLine 无 text 字段，需从 glyph 拼接
        const blockText = block.lines
          .map((l) => l.glyphs.map((g) => g.char).join(""))
          .join("\n");
        totalLines += block.lines.length;
        for (const line of block.lines) {
          const b = line.bbox;
          if (!b || (b.x === 0 && b.y === 0 && b.width === 0 && b.height === 0)) {
            lineHasBbox = false;
          }
          const words = wordsFromGlyphs(line.glyphs);
          if (words.length > 0) anyWordBbox = true;

          console.group(
            `Block ${bi} "${blockText.substring(0, 40)}" regionType=${block.regionType ?? "?"} layoutMode=${block.layoutMode ?? "?"} lines=${block.lines.length}`,
          );
          console.log(`  line: "${line.glyphs.map((g) => g.char).join("")}"`);
          console.log(
            `  bbox: x=${b?.x} y=${b?.y} w=${b?.width} h=${b?.height} (${block.lines.length === 1 ? "单行段落" : "多行段落"})`,
          );
          console.log(`  glyphs: ${line.glyphs.length}`);
          if (words.length > 0) {
            console.table(
              words.map((w, i) => ({
                word: w.text,
                x: Math.round(w.bbox.x),
                y: Math.round(w.bbox.y),
                w: Math.round(w.bbox.width),
                h: Math.round(w.bbox.height),
              })),
            );
          }
          console.groupEnd();
        }
      }

      // ── 三个问题的结论 ──
      console.log(
        "%c── 结论（用于判断 Adobe 级换行恢复能力）──",
        "font-weight:bold;color:#f59e0b;",
      );
      console.log(`[问题1] 两行来自哪里？`);
      console.log(
        `  → 当前 line 边界来自 OcrTextBlock.text 的 split("\\n")（OCR 文本换行符）。` +
          `实测本页 blocks=${blockCount}，lines 总计=${totalLines}。` +
          `单行段落（OCR 未提供换行）会合并为 1 行。`,
      );
      console.log(`[问题2] GLM OCR 有没有 word bbox？`);
      console.log(
        `  → OcrTextBlock 原始类型【无】word 字段（仅 block 级 bbox + text + fontSize + label）。` +
          `word bbox 是我们从 glyph 坐标按空格分组【自己推导】的（上面的 word 表格即为推导结果）。` +
          `lineHasBbox=${lineHasBbox}，word 可推导=${anyWordBbox}。`,
      );
      console.log(`[问题3] LayoutTree 保存 line.text 还是 line.words[]？`);
      console.log(
        `  → LayoutTree 的 line 节点保存【line.text】+ 子 glyph 节点；` +
          `word 是渲染/编辑时由 buildWordNodes 临时分组，不持久化在 LayoutNode 上。`,
      );
      return {
        blockCount,
        totalLines,
        lineHasBbox,
        anyWordBbox,
        verdict: "OCR 无 word bbox，word 级需自行从 glyph 推导；line 边界仅依赖 OCR text 换行符",
      };
    };

    // Sprint 33.3.1: Candidate scoring debug
    (window as any).__lineReconstructionScoreDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.1] No layout document.");
        return null;
      }
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.1] No EditableDocument.");
        return null;
      }

      const debugEntries: Array<{
        paragraphId: string;
        visualRight: number;
        originalOCRLines: string[];
        reconstructedLines: string[];
      }> = [];

      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "paragraph") continue;
          if (topNode.children.length === 0) continue;

          const targetBlock = doc.pages[0]?.blocks.find(
            (b) => b.id === topNode.children[0]?.sourceBlockId,
          );

          const originalLines: string[] = [];
          const allGlyphs: any[] = [];
          if (targetBlock) {
            for (const line of targetBlock.lines) {
              originalLines.push(line.glyphs.map((g: any) => g.char).join(""));
              for (const g of line.glyphs) allGlyphs.push(g);
            }
          }

          const reconstructedLines = topNode.children
            .filter((c: any) => c.type === "line")
            .map((l: any) => l.text ?? "");

          // Import 和计算 visualRight
          const words = groupGlyphsIntoWords(allGlyphs);
          const visualRight = calculateVisualRightBoundary(words);

          debugEntries.push({
            paragraphId: topNode.id,
            visualRight: Math.round(visualRight * 100) / 100,
            originalOCRLines: originalLines,
            reconstructedLines,
          });
        }
      }

      if (debugEntries.length === 0) {
        console.warn("[Sprint33.3.1] No paragraph nodes found.");
        return null;
      }

      console.log(
        "%c── Candidate Score Debug ──",
        "font-weight:bold;font-size:14px;color:#a78bfa;",
      );
      for (const entry of debugEntries) {
        console.group(`Paragraph: ${entry.paragraphId}`);
        console.log("%cVisual Right Boundary: %c" + entry.visualRight + "px",
          "color:#ec4899;", "font-weight:bold;");
        console.log("%cOriginal OCR lines:", "color:#f59e0b;");
        for (const l of entry.originalOCRLines) {
          console.log(`  "${l}"`);
        }
        console.log("%cReconstructed lines:", "color:#22c55e;");
        for (let li = 0; li < entry.reconstructedLines.length; li++) {
          const prefix = li === entry.reconstructedLines.length - 1 ? "  └ " : "  ├ ";
          console.log(`${prefix}"${entry.reconstructedLines[li]}"`);
        }
        console.groupEnd();
      }

      return debugEntries;
    };

    // ── Sprint 33.3.2: Line Stability Debug ─────────────────────

    window.__lineStabilityDebug = () => {
      if (!layoutDocument) {
        console.warn("[Sprint33.3.2] No layout document.");
        return [];
      }
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.3.2] No EditableDocument.");
        return [];
      }

      const result: Array<{
        paragraphId: string;
        candidates: Array<{
          lines: string[];
          score: number;
        }>;
        selected: number;
      }> = [];

      for (const page of layoutDocument.pages) {
        for (const topNode of page.children) {
          if (topNode.type !== "paragraph") continue;
          if (topNode.children.length <= 1) continue; // need at least 2 lines

          const targetBlock = doc.pages[0]?.blocks.find(
            (b: any) => b.id === topNode.children[0]?.sourceBlockId,
          );
          if (!targetBlock) continue;

          // Collect all glyphs from the block's OCR lines
          const allGlyphs: any[] = [];
          for (const line of targetBlock.lines) {
            for (const g of line.glyphs) allGlyphs.push(g);
          }
          if (allGlyphs.length === 0) continue;

          const words = groupGlyphsIntoWords(allGlyphs);
          const visualRight = calculateVisualRightBoundary(words);

          // Current arrangement from layout tree
          const layoutLines = topNode.children.filter((c: any) => c.type === "line");
          const currentLines: any[][] = [];
          const currentTexts: string[] = [];
          for (const ll of layoutLines) {
            // line node 上没有 words 属性，从 children (word nodes) 重建 OCRWord[]
            const wordNodes = (ll.children ?? []).filter((c: any) => c.type === "word");
            if (wordNodes.length === 0) continue;
            const wordsArr: any[] = wordNodes.map((wn: any) => ({
              text: wn.text ?? "",
              bbox: wn.bbox ?? { x: 0, y: 0, width: 0, height: 0 },
              glyphs: [],
            }));
            currentLines.push(wordsArr);
            currentTexts.push(ll.text ?? "");
          }
          if (currentLines.length <= 1) continue;

          const entry: typeof result[0] = {
            paragraphId: topNode.id,
            candidates: [],
            selected: 0,
          };

          // Candidate 0: current arrangement
          const currentScore = calculateLineStability(currentLines, visualRight);
          entry.candidates.push({
            lines: currentTexts,
            score: currentScore,
          });

          // Candidate 1: merge short lines where applicable
          const mergedLines: any[][] = [];
          const mergedTexts: string[] = [];
          let i = 0;
          let didMerge = false;
          while (i < currentLines.length) {
            if (
              i < currentLines.length - 1 &&
              currentLines[i + 1].length === 1
            ) {
              const cohesionScore = getPhraseScore(currentLines[i], currentLines[i + 1][0]);
              if (cohesionScore >= 0) {
                mergedLines.push([...currentLines[i], ...currentLines[i + 1]]);
                mergedTexts.push(joinWords(
                  [...currentLines[i], ...currentLines[i + 1]],
                ));
                i += 2;
                didMerge = true;
                continue;
              }
            }
            mergedLines.push(currentLines[i]);
            mergedTexts.push(layoutLines[i]?.text ?? "");
            i++;
          }

          if (didMerge && mergedLines.length !== currentLines.length) {
            const mergedScore = calculateLineStability(mergedLines, visualRight);
            entry.candidates.push({
              lines: mergedTexts,
              score: mergedScore,
            });
            if (mergedScore > currentScore) {
              entry.selected = 1;
            }
          }

          result.push(entry);
        }
      }

      console.log(
        "%c── Line Stability Debug (S33.3.2) ──",
        "font-weight:bold;font-size:14px;color:#22d3ee;",
      );
      console.log("%cWeights: width(0.35) + phrase(0.35) + balance(0.20) + originalOCR(0.10)",
        "color:#94a3b8;");
      for (const e of result) {
        console.group(`Paragraph: ${e.paragraphId}`);
        for (let ci = 0; ci < e.candidates.length; ci++) {
          const c = e.candidates[ci];
          const marker = ci === e.selected ? " >>> SELECTED" : "";
          console.log(
            `%cCandidate ${ci}: score=%c${c.score}%c${marker}`,
            ci === e.selected ? "font-weight:bold;color:#22c55e;" : "color:#94a3b8;",
            "font-weight:bold;",
            ci === e.selected ? "color:#22c55e;font-weight:bold;" : "color:#94a3b8;",
          );
          for (let li = 0; li < c.lines.length; li++) {
            console.log(`  "${c.lines[li]}"`);
          }
        }
        console.groupEnd();
      }

      return result;
    };

    // ── Sprint 33.3.3 Task 1: Text Metric Debug ──
    (window as any).__textMetricDebug = () => {
      if (!editableDocumentRef.current) {
        console.warn("[Sprint33.3.3] No EditableDocument.");
        return [];
      }
      const doc = editableDocumentRef.current;
      const cssScale = cssScaleRef.current;
      const renderScale = 1.5;
      const metrics: any[] = [];

      // EditableDocument: pages → blocks (no doc.blocks)
      for (const page of doc.pages) {
        for (const block of page.blocks) {
          // Reconstruct text from glyphs across all lines
          const blockText = block.lines
            .map((l) => l.glyphs.map((g) => g.char).join(""))
            .join(" ");
          // Style: first line's style → fontSize; fallback to first glyph's styleRef → doc.styles
          const firstLine = block.lines[0];
          const firstGlyphStyleRef = firstLine?.glyphs[0]?.styleRef ?? -1;
          const docStyleEntry = firstGlyphStyleRef >= 0 ? doc.styles[firstGlyphStyleRef] : null;
          const overlayFontSize = firstLine?.style?.fontSize
            ?? docStyleEntry?.fontSize
            ?? 14;
          // Back-calculate OCR fontSize: overlayFontSize / cssScale → canvas px at scale=1.5
          const ocrCanvasFontSize = cssScale > 0 ? overlayFontSize / cssScale : overlayFontSize;
          // Back-calculate PDF pt equivalent
          const pdfFontSizePt = ocrCanvasFontSize / renderScale;

          metrics.push({
            id: block.id,
            text: blockText.substring(0, 60),
            bbox: { ...block.bbox },
            coordinateSpace: "css-px",
            ocrCanvasFontSize,
            overlayFontSize,       // fontSize actually used by GlyphRenderer (CSS px)
            pdfFontSizePt,         // approximate PDF pt equivalent
            scale: { renderScale, cssScale },
            blockStyle: firstLine?.style ?? docStyleEntry ?? null,
            lines: block.lines.length,
            glyphs: block.lines.reduce((sum, l) => sum + l.glyphs.length, 0),
            regionType: block.regionType,
          });
        }
      }
      if (metrics.length === 0) {
        console.warn("[Sprint33.3.3] No blocks found in document.");
        return [];
      }
      console.table(metrics.map(m => ({
        id: m.id,
        fontSize_css: m.overlayFontSize,
        fontSize_pdfPt: m.pdfFontSizePt.toFixed(1),
        bbox_w: m.bbox.width.toFixed(1),
        bbox_h: m.bbox.height.toFixed(1),
        lines: m.lines,
        glyphs: m.glyphs,
        regionType: m.regionType ?? "-",
        text: m.text,
      })));
      return metrics;
    };

    // ── Sprint 33.5.6: Signature Export Debug ──
    // Verifies that the export's coordinate rotation matches the expected mathematical rotation.
    //
    // Previous version compared raw source vs rotated export → always showed large deltas
    // because rotation naturally shifts positions (e.g. 1125pt × sin(1.3°) ≈ 25pt).
    //
    // Fix: compare rot(source) — the mathematically expected rotated position — vs export.
    // delta = |exportPos - rotatePoint(sourcePos, origin, rotation)|
    // This measures coordinate conversion accuracy, independent of the rotation effect.
    (window as any).__signatureExportDebug = () => {
      const regions = signatureRegionsRef.current;
      if (!regions || regions.length === 0) {
        console.warn("[Sprint 33.5.6] No SignatureRegions. Process a PDF with OCR and signature detection first.");
        return null;
      }

      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint 33.5.6] No EditableDocument.");
        return null;
      }

      const renderScale = 1.5;
      const cssScale = cssScaleRef.current;
      const totalScale = renderScale * cssScale;

      console.group(
        "%c[Sprint 33.5.6] Signature Export Coordinate Debug",
        "font-weight:bold;color:#f59e0b;",
      );

      const allResults: any[] = [];
      let totalCoordDelta = 0;
      let maxCoordDelta = 0;
      let totalRotationShift = 0;
      let maxRotationShift = 0;

      for (const region of regions) {
        const page = doc.pages[region.pageIndex];
        if (!page) continue;
        const pageHeightPt = page.height / totalScale;

        // Origin in PDF pt (block's own top-left — per-block region)
        const originPtX = region.bbox.x / totalScale;
        const originPtY = pageHeightPt - (region.bbox.y / totalScale);

        const rad = (region.rotation * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);

        const children: any[] = [];

        for (const child of region.children) {
          const block = page.blocks.find(b => b.id === child.sourceBlockId);
          if (!block) continue;

          // Source in PDF pt (top-left of block, pre-rotation)
          const srcPtX = block.bbox.x / totalScale;
          const srcPtY = pageHeightPt - (block.bbox.y / totalScale);

          // Local offset in PDF pt
          const localPtX = child.offsetX / totalScale;
          const localPtY = -child.offsetY / totalScale;

          // 1. Export position — what renderSignatureRegionToExportCommands produces
          const exportPtX = originPtX + localPtX * cos - localPtY * sin;
          const exportPtY = originPtY + localPtX * sin + localPtY * cos;

          // 2. Expected = rotate(sourcePt around origin) — the mathematically expected result
          const dx = srcPtX - originPtX;
          const dy = srcPtY - originPtY;
          const expectedX = originPtX + dx * cos - dy * sin;
          const expectedY = originPtY + dx * sin + dy * cos;

          // 3. Coordinate conversion delta = export vs expected
          const coordDeltaX = exportPtX - expectedX;
          const coordDeltaY = exportPtY - expectedY;
          const coordDelta = Math.sqrt(coordDeltaX * coordDeltaX + coordDeltaY * coordDeltaY);

          // 4. Rotation shift = source vs rotated (information only)
          const rotShiftX = exportPtX - srcPtX;
          const rotShiftY = exportPtY - srcPtY;
          const rotShift = Math.sqrt(rotShiftX * rotShiftX + rotShiftY * rotShiftY);

          totalCoordDelta += coordDelta;
          maxCoordDelta = Math.max(maxCoordDelta, coordDelta);
          totalRotationShift += rotShift;
          maxRotationShift = Math.max(maxRotationShift, rotShift);

          children.push({
            text: child.text.substring(0, 40),
            source: { x: +srcPtX.toFixed(2), y: +srcPtY.toFixed(2) },
            expected: { x: +expectedX.toFixed(2), y: +expectedY.toFixed(2) },
            exportPos: { x: +exportPtX.toFixed(2), y: +exportPtY.toFixed(2) },
            coordDelta: +coordDelta.toFixed(3),
            rotShift: +rotShift.toFixed(3),
          });
        }

        const regionResult = { regionId: region.id, rotation: region.rotation, children };
        allResults.push(regionResult);

        console.group(
          `%cSIGNATURE EXPORT %c${region.id}`,
          "font-weight:bold;color:#f59e0b;", "color:#94a3b8;",
        );
        console.log(`  %crotation:%c ${region.rotation.toFixed(1)}° %corigin:%c (${originPtX.toFixed(1)}, ${originPtY.toFixed(1)}) pt`,
          "color:#f59e0b;", "color:#e2e8f0;", "color:#64748b;", "color:#94a3b8;");

        for (const child of children) {
          const cdOk = child.coordDelta < 0.5;
          const coordStr = cdOk
            ? `%c✓ coord Δ:${child.coordDelta}`
            : `%c⚠️ coord Δ:${child.coordDelta}`;
          const cdColor = cdOk ? "color:#22c55e;" : "color:#ef4444;font-weight:bold;";
          const rotStr = child.rotShift < 0.5
            ? " (rot shift negligible)"
            : ` (rot shift: ${child.rotShift.toFixed(1)})`;

          console.log(
            `    %c"${child.text}"%c${rotStr}`,
            "color:#cbd5e1;", "color:#64748b;",
          );
          console.log(
            `      %csource:%c (${child.source.x}, ${child.source.y})  %cexpected:%c (${child.expected.x}, ${child.expected.y})  %cexport:%c (${child.exportPos.x}, ${child.exportPos.y})  ${coordStr}`,
            "color:#64748b;", "color:#94a3b8;",
            "color:#64748b;", "color:#f59e0b;",
            "color:#64748b;", "color:#94a3b8;",
            cdColor,
          );
        }

        console.groupEnd();
      }

      const childCount = allResults.reduce((s: number, r: any) => s + r.children.length, 0);
      const avgCoordDelta = childCount > 0 ? totalCoordDelta / childCount : 0;
      const avgRotShift = childCount > 0 ? totalRotationShift / childCount : 0;

      console.log("%c── Summary ──", "color:#94a3b8;");
      console.log(`  coord Δ (export vs expected): avg ${avgCoordDelta.toFixed(3)} pt  max ${maxCoordDelta.toFixed(3)} pt`);
      console.log(`  rot shift (source vs export):  avg ${avgRotShift.toFixed(3)} pt  max ${maxRotationShift.toFixed(3)} pt`);
      if (avgCoordDelta < 0.5 && maxCoordDelta < 1) {
        console.log("  %c✅ Export coordinate conversion EXACT. Per-block origin → zero drift.", "color:#22c55e;font-weight:bold;");
      } else {
        console.log("  %c⚠️ Coordinate conversion drift detected in export path.", "color:#ef4444;font-weight:bold;");
      }
      if (avgRotShift < 0.5) {
        console.log("  %c✅ Per-block rotation has negligible position shift (≤ 0.5 pt).", "color:#22c55e;");
      } else {
        console.log("  %c⚠️ Rotation shift > 0.5 pt — block origin is far from text position.", "color:#ef4444;");
      }

      console.groupEnd();
      return { regions: allResults, avgCoordDelta, maxCoordDelta, avgRotShift, maxRotationShift };
    };

    // ── Sprint34.11: Signature Region Export Isolation Debug ──
    // 只读诊断：对比 Editor signature map 与 Export signatureRegionsRef，
    // 确认 Export signature region 是否错误包含日期 block（TABOAO）。
    (window as any).__signatureRegionIsolationDebug = () => {
      console.log(
        "%cCODE_VERSION: SPRINT34.11.1 (sigRegions now built from reconResult.replacements)",
        "font-weight:bold;color:#ef4444;",
      );
      const doc = editableDocumentRef.current;
      const blockText = (blockId: string): string => {
        if (!doc) return "(no doc)";
        for (const page of doc.pages) {
          for (const b of page.blocks) {
            if (b.id === blockId) {
              return b.lines.map((l) => l.glyphs.map((g) => g.char).join("")).join("\\n").substring(0, 40);
            }
          }
        }
        return "(not found)";
      };

      // ── 1. Editor signature map ──
      console.log(
        "%c── [EDITOR_SIGNATURE_REGION] ──",
        "font-weight:bold;color:#22c55e;",
      );
      const editorBlocks: Array<{ id: string; text: string }> = [];
      for (const [blockId, v] of signatureRegionMap.entries()) {
        editorBlocks.push({ id: blockId, text: blockText(blockId) });
        console.log(
          `  block ${blockId.slice(0, 8)} rotation=${(v as any).rotation} text="${blockText(blockId)}"`,
        );
      }

      // ── 2. Export signatureRegionsRef ──
      console.log(
        "%c── [EXPORT_SIGNATURE_REGION] ──",
        "font-weight:bold;color:#f59e0b;",
      );
      const exportBlocks: Array<{ id: string; text: string }> = [];
      const regions = signatureRegionsRef.current ?? [];
      for (const r of regions as any[]) {
        const src = r.sourceBlockIds?.[0] ?? "(none)";
        console.log(
          `  region ${r.id} rotation=${r.rotation} sourceBlockIds=[${(r.sourceBlockIds ?? []).map((s: string) => s.slice(0, 8)).join(",")}]`,
        );
        for (const c of (r.children ?? []) as any[]) {
          const bid = c.blockId ?? c.sourceBlockId ?? src;
          exportBlocks.push({ id: bid, text: (c.text ?? "").substring(0, 40) });
          console.log(`    child blockId=${bid.slice(0, 8)} text="${(c.text ?? "").substring(0, 40)}"`);
        }
      }

      // ── 3. 差异对比 ──
      console.log(
        "%c── [SIGNATURE_REGION_DIFF] ──",
        "font-weight:bold;color:#8b5cf6;",
      );
      const editorTexts = new Set(editorBlocks.map((b) => b.text));
      const exportTexts = new Set(exportBlocks.map((b) => b.text));
      const editorOnly = editorBlocks.filter((b) => !exportTexts.has(b.text)).map((b) => b.text);
      const exportOnly = exportBlocks.filter((b) => !editorTexts.has(b.text)).map((b) => b.text);
      console.log("  Editor only:", editorOnly);
      console.log("  Export only:", exportOnly);
      console.log(
        "  ➡️ Export 是否包含 TABOAO/日期：",
        exportOnly.some((t) => /TABOAO|abril|2026/.test(t)) ? "✅ 是（根因确认）" : "❌ 否",
      );

      return { editorBlocks, exportBlocks, editorOnly, exportOnly };
    };

    // ── Sprint 33.5.8: Overlay Transform Debug ──
    // Checks the full coordinate scaling chain:
    //   PDF pt → (* renderScale) → canvas px → (* cssScale) → CSS display px
    // The GlyphRenderer uses CSS px for position and fontSize.
    // This debug exposes every scaling factor so we can identify
    // whether fontSize is unintentionally multiplied by devicePixelRatio,
    // double-counts viewportScale, or has any other scale leakage.
    (window as any).__overlayTransformDebug = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        console.warn("[Sprint33.5.8] Canvas not available.");
        return null;
      }

      const renderScale = 1.5; // PDF.js render scale (hardcoded)
      const cssScale = cssScaleRef.current;
      const dpr = window.devicePixelRatio || 1;
      const canvasScale = renderScale * cssScale; // PDF pt → CSS px

      const info = {
        pdfDimensions: {
          description: "PDF page size (pt)",
          width: +(canvas.width / renderScale).toFixed(1),
          height: +(canvas.height / renderScale).toFixed(1),
        },
        viewport: {
          description: "PDF.js viewport (canvas px at renderScale)",
          width: canvas.width,
          height: canvas.height,
          scale: renderScale,
        },
        cssDisplay: {
          description: "Canvas CSS display size (px)",
          clientWidth: canvas.clientWidth,
          clientHeight: canvas.clientHeight,
        },
        scaling: {
          renderScale,
          cssScale: +cssScale.toFixed(4),
          devicePixelRatio: dpr,
          canvasScale: +canvasScale.toFixed(4),
          explanation:
            "For a 12pt PDF font: CSS fontSize = 12 × renderScale × cssScale = 12 × " +
            renderScale +
            " × " +
            (+cssScale).toFixed(4) +
            " = " +
            (12 * canvasScale).toFixed(2) +
            " CSS px",
        },
      };

      console.group(
        "%c[Sprint33.5.8] Overlay Transform Chain",
        "font-weight:bold;color:#06b6d4;",
      );
      console.table({
        "PDF width (pt)": info.pdfDimensions.width,
        "PDF height (pt)": info.pdfDimensions.height,
        "Canvas width (px)": canvas.width,
        "Canvas height (px)": canvas.height,
        "CSS clientWidth": canvas.clientWidth,
        "CSS clientHeight": canvas.clientHeight,
        renderScale: renderScale,
        cssScale: +cssScale.toFixed(4),
        devicePixelRatio: dpr,
        "12pt → CSS px": +(12 * canvasScale).toFixed(2),
      });
      console.log(
        "%cScale chain: %cPDF pt %c→ %c×" +
          renderScale +
          " (render) %c→ %cc×" +
          (+cssScale).toFixed(4) +
          " (cssScale) %c→ %cCSS px",
        "color:#06b6d4;font-weight:bold;",
        "color:#94a3b8;",
        "color:#f59e0b;",
        "color:#06b6d4;",
        "color:#f59e0b;",
        "color:#06b6d4;",
        "color:#94a3b8;",
      );
      console.log(
        "  %cIf a block.style.fontSize > %c" +
          (12 * canvasScale).toFixed(1) +
          "px%c for a 12pt PDF font, fontSize has scale leakage.",
        "color:#f59e0b;",
        "color:#ef4444;font-weight:bold;",
        "color:#f59e0b;",
      );
      console.groupEnd();
      return info;
    };

    // ── M7.8-023: EDIT_STYLE_SOURCE_AUDIT ──
    // 追踪「原始 PDF glyph fontSize → Segment.font.size → editingSegment.font.size
    //   → 编辑框最终 fontSize」完整数据链，定位 16px fallback / 覆盖发生在哪个节点。
    // 用法：编辑态下在 console 执行 __editStyleAudit()
    (window as any).__editStyleAudit = () => {
      const doc = editableDocumentRef.current;
      const segs: any[] = (segmentsRef?.current ?? []) as any[];
      // 真实变量：editingSegmentId（useEditor 返回）、textEdit（useState）、showTextLayer
      const editingId: string | null = editingSegmentId ?? null;

      // ① PDF glyph 节点定位策略：
      //   a) 优先找含 glyph.modified=true 的行（编辑已写回模型的证明）
      //   b) 次之找 editedLineBoxes 记录的行（markLineEdited 写过，但模型未必同步）
      //   c) 兜底取第一个 block 的第一行（仅用于观察基准字号）
      const editedIds = new Set<string>(editedLineBoxesRef?.current?.keys?.() ?? []);
      let glyphNode: any = null;
      let locateBy = "none";
      if (doc) {
        outerGlyph: for (const pg of doc.pages) {
          for (const b of pg.blocks) {
            for (const l of b.lines) {
              const byModified = l.glyphs.some((g: any) => g.modified);
              const byEditedBox = editedIds.has(l.id);
              if (!byModified && !byEditedBox) continue;
              locateBy = byModified ? "glyph.modified" : "editedLineBoxes";
              const ref = l.glyphs[0]?.styleRef ?? 0;
              const st = doc.styles?.[ref] ?? {};
              glyphNode = {
                blockId: b.id,
                lineId: l.id,
                locatedBy: locateBy,
                glyphCount: l.glyphs.length,
                modifiedCount: l.glyphs.filter((g: any) => g.modified).length,
                styleRef: ref,
                "glyph.style.fontSize": st.fontSize,
                "glyph.style.fontFamily": st.fontFamily,
                "glyph.style.fontWeight": st.fontWeight,
                "glyph.style.fontStyle": st.fontStyle,
                pdfjsFontFamily: st.pdfjsFontFamily,
                "line.style.fontSize": l.style?.fontSize,
                glyphBBoxHeight: l.glyphs[0]?.bbox?.height,
                lineText: l.glyphs.map((g: any) => g.char).join("").slice(0, 60),
              };
              break outerGlyph;
            }
          }
        }
        // 兜底：观察基准（标明未编辑，仅供对比）
        if (!glyphNode && doc.pages[0]?.blocks[0]?.lines[0]) {
          const l: any = doc.pages[0].blocks[0].lines[0];
          const ref = l.glyphs[0]?.styleRef ?? 0;
          const st = doc.styles?.[ref] ?? {};
          glyphNode = {
            blockId: doc.pages[0].blocks[0].id,
            lineId: l.id,
            locatedBy: "fallback-first-line(未找到任何编辑痕迹)",
            glyphCount: l.glyphs.length,
            modifiedCount: l.glyphs.filter((g: any) => g.modified).length,
            styleRef: ref,
            "glyph.style.fontSize": st.fontSize,
            "glyph.style.fontFamily": st.fontFamily,
            "glyph.style.fontWeight": st.fontWeight,
            "glyph.style.fontStyle": st.fontStyle,
            pdfjsFontFamily: st.pdfjsFontFamily,
            "line.style.fontSize": l.style?.fontSize,
            glyphBBoxHeight: l.glyphs[0]?.bbox?.height,
            lineText: l.glyphs.map((g: any) => g.char).join("").slice(0, 60),
          };
        }
      }
      const editedLineBoxCount = editedIds.size;
      const editedLineBoxSample = [...editedIds].slice(0, 5);

      // ② Segment 节点
      const segNode = segs.length
        ? segs.slice(0, 400).map((s: any) => ({
            id: s.id,
            "segment.font.size": s.font?.size,
            "segment.font.family": s.font?.family,
            "segment.font.weight": s.font?.weight,
            "segment.font.style": s.font?.style,
            text: (s.text ?? "").slice(0, 40),
          }))
        : null;

      // ③ editingSegment 节点
      const editingSeg = editingId ? segs.find((s: any) => s.id === editingId) : null;
      const editingNode = editingSeg
        ? {
            id: editingSeg.id,
            "editingSegment.font.size": editingSeg.font?.size,
            "editingSegment.font.family": editingSeg.font?.family,
            "editingSegment.font.weight": editingSeg.font?.weight,
          }
        : null;

      // ④ 编辑框最终节点（TextEditOverlay 的 textEdit 状态）
      const te: any = textEdit;
      const overlayNode = te
        ? {
            "textEdit.fontSize": te.fontSize,
            "textEdit.fontFamily": te.fontFamily,
            "textEdit.fontWeight": te.fontWeight,
            "textEdit.lineHeight": te.lineHeight,
            "textEdit.bbox.height": te.bbox?.height,
          }
        : null;
      // 路径判定：EditModeToolbar(+/- 字号) 仅在 showTextLayer && editingSegmentId 时渲染
      // （PDFEditor.tsx: {showTextLayer && editingSegmentId && <EditModeToolbar />}），
      // 即「segment 编辑路径」；textEdit 非空则是「TextEditOverlay 路径」。
      const pathNode = {
        showTextLayer: (window as any).__showTextLayer ?? undefined,
        editingSegmentId: editingId,
        "走 segment 路径(EditModeToolbar)": !!editingId,
        "走 TextEditOverlay 路径": !!te,
        "两条路径同时激活": !!editingId && !!te,
      };

      // ⑤ 一致性判定（不使用"看起来差不多"，用精确相等）
      const gFs = glyphNode?.["glyph.style.fontSize"];
      const eFs = editingNode?.["editingSegment.font.size"];
      const oFs = overlayNode?.["textEdit.fontSize"];
      // 注意：必须排除「三者皆 undefined」造成的假相等（undefined === undefined）。
      const hasG = gFs !== undefined && gFs !== null;
      const hasE = eFs !== undefined && eFs !== null;
      const hasO = oFs !== undefined && oFs !== null;
      const verdict = {
        "数据完整性（三者是否都取到值）": hasG && hasE && hasO,
        "缺失节点": [
          !hasG ? "glyph(未找到 modified 行)" : null,
          !hasE ? "editingSegment(editingSegmentId 为空)" : null,
          !hasO ? "textEdit(TextEditOverlay 未激活)" : null,
        ].filter(Boolean),
        "glyph vs editingSegment fontSize 相等": hasG && hasE ? gFs === eFs : "N/A(缺值)",
        "glyph vs textEdit fontSize 相等": hasG && hasO ? gFs === oFs : "N/A(缺值)",
        "editingSegment vs textEdit fontSize 相等": hasE && hasO ? eFs === oFs : "N/A(缺值)",
        "是否出现 16 兜底": [gFs, eFs, oFs].some((v) => v === 16),
        "实测值": { glyph: gFs, editingSegment: eFs, textEdit: oFs },
        "提示":
          "若 glyph 为 undefined，说明 editableDocument 中没有任何 glyph.modified=true —— " +
          "即编辑未通过 onTextEditSave 写回模型（典型：走 segment/EditModeToolbar 路径）。",
      };

      console.group("%c[M7.8-023] EDIT_STYLE_SOURCE_AUDIT", "font-weight:bold;color:#06b6d4;");
      console.log("⓪ 当前激活路径：", pathNode);
      console.log(
        `   editedLineBoxes 条数=${editedLineBoxCount} 样例=${JSON.stringify(editedLineBoxSample)}`,
      );
      console.log("① PDF glyph 节点：", glyphNode);
      console.log("③ editingSegment 节点：", editingNode);
      console.log("④ 编辑框（TextEditOverlay）节点：", overlayNode);
      console.log("⑤ 一致性判定：", verdict);
      if (segNode) {
        console.log("② Segment 全表（前 400）：");
        console.table(segNode);
      }
      console.groupEnd();
      return { glyphNode, segNode, editingNode, overlayNode, verdict };
    };

    // ── M7.8-024: EXPORT_COORDINATE_TRACE（只读）──
    // 用法：__pgsExportTrace()            → 追踪 line 17（默认）
    //      __pgsExportTrace(17)          → 追踪指定 lineIndex
    //      __pgsExportTrace("block0_l17") → 按 lineId 追踪
    // 只读取模型数据 + 调用 traceExportCoordinate，不修改任何生产状态。
    (window as any).__pgsExportTrace = async (target?: number | string) => {
      const mod = await import("../document-model/export-renderer");
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[M7.8-024] editableDocument 为空");
        return null;
      }
      const page = doc.pages[0];
      const block = page?.blocks?.[0];
      if (!block) {
        console.warn("[M7.8-024] 未找到 block");
        return null;
      }
      let line: any = null;
      let lineIndex = -1;
      if (typeof target === "string") {
        for (let i = 0; i < block.lines.length; i++) {
          if (block.lines[i].id === target) {
            line = block.lines[i];
            lineIndex = i;
            break;
          }
        }
      } else {
        lineIndex = target ?? 17;
        line = block.lines[lineIndex];
      }
      if (!line) {
        console.warn(`[M7.8-024] 未找到 line: ${target ?? 17}`);
        return null;
      }
      const rs = doc.runtime?.renderScale ?? 1.5;
      const cs = doc.runtime?.cssScale ?? 1;
      const maskBox = editedLineBoxesRef?.current?.get?.(line.id);
      const neighborLines = block.lines.slice(lineIndex, lineIndex + 2);
      // Phase C：提供 line.bbox、canvas 与上下行边界，用于只读像素扫描真实墨迹
      const prevLine = block.lines[lineIndex - 1] as any;
      const nextLine = block.lines[lineIndex + 1] as any;
      const prevLineBottom =
        prevLine?.bbox?.y !== undefined ? prevLine.bbox.y + prevLine.bbox.height : undefined;
      const nextLineTop = nextLine?.bbox?.y;
      const t = mod.traceExportCoordinate(
        line,
        doc.styles as any,
        page.height,
        rs,
        cs,
        maskBox,
        neighborLines,
        {
          lineBBox: (line as any).bbox,
          canvas: canvasRef?.current ?? null,
          prevLineBottom,
          nextLineTop,
          cssScale: cs,
        }
      );
      console.group(
        `%c[M7.8-024] EXPORT_COORDINATE_TRACE  line=${t.lineId} (index ${lineIndex})`,
        "font-weight:bold;color:#06b6d4;"
      );
      console.log(
        `glyphCount=${t.glyphCount} renderScale=${rs} cssScale=${cs} totalScale=${t.totalScale} pageHeightPt=${Math.round(t.pageHeightPt * 100) / 100}`
      );
      console.table(t.rows);
      console.log("%c摘要（Y 链）", "font-weight:bold;color:#f59e0b;");
      console.log(t.summary);
      console.log(
        `%c⭐ first divergence = ${t.firstDivergence}`,
        "font-weight:bold;color:#22c55e;"
      );
      console.log("%c水平 / 垂直独立性证明", "font-weight:bold;color:#f59e0b;");
      console.log(t.independenceProof);
      console.log("%cMASK 追踪（白色遮盖块）", "font-weight:bold;color:#ef4444;");
      console.log((t as any).mask);
      console.log("%cPhase C · 覆盖率判定（READ ONLY）", "font-weight:bold;color:#8b5cf6;");
      console.log(JSON.stringify((t as any).phaseC, null, 2));
      console.groupEnd();
      return t;
    };

    // ── Sprint 33.5.8: Overlay Similarity Debug ──
    // Compares GlyphRenderer overlay fontSize vs. PDF textContent fontSize
    // for the same text block (matched by spatial proximity).
    // If overlay fontSize ≫ PDF fontSize (e.g. 47px vs 16px),
    // there's a scale leakage in the EditableDocument pipeline.
    (window as any).__overlaySimilarityDebug = () => {
      const doc = editableDocumentRef.current;
      if (!doc) {
        console.warn("[Sprint33.5.8] No EditableDocument. Process a PDF first.");
        return null;
      }

      const renderScale = 1.5;
      const cssScale = cssScaleRef.current;
      const items = docTextItemsRef?.current || [];

      console.group(
        "%c[Sprint33.5.8] Overlay vs PDF Text Similarity",
        "font-weight:bold;color:#06b6d4;",
      );

      const rows: any[] = [];
      let totalRatio = 0;
      let count = 0;

      for (let pi = 0; pi < doc.pages.length; pi++) {
        const page = doc.pages[pi];
        const pageHeightPt =
          cssScale > 0 ? page.height / cssScale / renderScale : 0;

        for (const block of page.blocks) {
          if (block.type !== "text") continue;
          const blockText = block.lines
            .map((l: any) =>
              l.glyphs.map((g: any) => g.char).join(""),
            )
            .join(" ")
            .trim();
          if (!blockText) continue;

          const firstStyle = block.lines[0]?.style;
          const overlayFontSize = firstStyle?.fontSize ?? null;
          if (overlayFontSize === null) continue;

          // Back-calculate overlay fontSize to PDF pt
          const overlayFontSizePt =
            cssScale > 0 && renderScale > 0
              ? overlayFontSize / cssScale / renderScale
              : NaN;

          // Find nearest textItem by spatial bounding-box overlap
          const blockCx = block.bbox.x + block.bbox.width / 2;
          const blockCy = block.bbox.y + block.bbox.height / 2;
          const pageTextItems = items.filter(
            (ti: any) =>
              typeof ti.pageIndex === "number"
                ? ti.pageIndex === pi
                : true,
          );

          let bestItem: any = null;
          let bestDist = Infinity;
          for (const ti of pageTextItems) {
            const tcx = ti.x + ti.w / 2;
            const tcy = ti.y + ti.h / 2;
            const dist = Math.sqrt(
              (blockCx - tcx) ** 2 + (blockCy - tcy) ** 2,
            );
            if (dist < bestDist) {
              bestDist = dist;
              bestItem = ti;
            }
          }

          // Only match if within a reasonable distance (30% of block diagonal)
          const diag = Math.sqrt(
            block.bbox.width ** 2 + block.bbox.height ** 2,
          );
          const isMatch = bestItem && bestDist < diag * 0.3;
          const pdfFontSizePx = isMatch ? bestItem.fontSize : null;
          const ratio =
            pdfFontSizePx && pdfFontSizePx > 0
              ? overlayFontSize / pdfFontSizePx
              : null;

          if (ratio !== null) {
            totalRatio += ratio;
            count++;
          }

          rows.push({
            text: blockText.substring(0, 35),
            "overlay CSS px": +overlayFontSize.toFixed(2),
            "overlay PDF pt (back-calc)": +overlayFontSizePt.toFixed(1),
            "nearest textItem px":
              pdfFontSizePx !== null
                ? +pdfFontSizePx.toFixed(2)
                : "(no match)",
            "scale ratio":
              ratio !== null ? ratio.toFixed(3) + "×" : "—",
            "match dist": +bestDist.toFixed(1),
          });

          if (rows.length >= 30) break; // limit output
        }
        if (rows.length >= 30) break;
      }

      const avgRatio = count > 0 ? totalRatio / count : 0;

      console.table(rows);
      console.log(
        "%cAvg overlay/PDF ratio: %c" +
          avgRatio.toFixed(3) +
          "×",
        "color:#94a3b8;",
        avgRatio < 1.3
          ? "color:#22c55e;font-weight:bold;"
          : "color:#ef4444;font-weight:bold;",
      );
      if (avgRatio > 1.3) {
        console.log(
          "  %c⚠️ Overlay fontSize is ~%s× PDF fontSize. Scale leakage detected.",
          "color:#ef4444;font-weight:bold;",
          avgRatio.toFixed(1),
        );
        console.log(
          "  %c  Expected: avg ratio ≈ 1.0 (both in CSS px).",
          "color:#f59e0b;",
        );
      } else {
        console.log(
          "  %c✅ Overlay fontSize matches PDF text within tolerance.",
          "color:#22c55e;font-weight:bold;",
        );
      }

      console.groupEnd();
      return { rows, avgRatio, count };
    };

    // ── Sprint 33.5.9: Runtime Overlay Transform Debug ──
    // Iterates all [data-segment-id] DOM overlay elements and prints:
    //   1. Scale state snapshot (cssScale, renderScale, dpr, viewport)
    //   2. Per-element: computed fontSize, expected fontSize, delta
    //   3. Full parent transform chain (element → parent → grandparent → great-grandparent)
    //   4. Browser layout rect vs expected position from Segment data
    // Also enables EditableTextNode mount-time debug via __overlayRuntimeDebugEnabled flag.


    (window as any).__overlayRuntimeDebug = () => {
      // ── Step 1: Enable mount-time debug in EditableTextNode ──
      (window as any).__overlayRuntimeDebugEnabled = true;

      // ── Step 2: Snapshot scale state ──
      const canvas = canvasRef.current;
      const renderScale = 1.5;
      const cssScale = cssScaleRef.current;
      const dpr = window.devicePixelRatio || 1;

      console.group(
        "%c[Sprint33.5.9] Runtime Overlay Transform Debug",
        "font-weight:bold;color:#a855f7;",
      );

      console.log(
        "%c── Scale State Snapshot ──",
        "font-weight:bold;color:#06b6d4;",
      );
      console.table({
        cssScale: +cssScale.toFixed(4),
        renderScale,
        devicePixelRatio: dpr,
        canvasScale: +(renderScale * cssScale).toFixed(4),
        zoom: +((window as any).__zoom__ ?? "N/A"),
        viewportW: canvas ? canvas.width : "N/A",
        viewportH: canvas ? canvas.height : "N/A",
        clientW: canvas ? canvas.clientWidth : "N/A",
        clientH: canvas ? canvas.clientHeight : "N/A",
        "12pt→CSSpx": +(12 * renderScale * cssScale).toFixed(2),
      });
      console.log(
        "  %cScale chain: PDF pt %c→ %c×" +
          renderScale +
          " (render) %c→ %c×" +
          (+cssScale).toFixed(4) +
          " (cssScale) %c→ %cCSS px",
        "color:#a855f7;",
        "color:#94a3b8;",
        "color:#06b6d4;",
        "color:#94a3b8;",
        "color:#06b6d4;",
        "color:#94a3b8;",
        "color:#a855f7;",
      );

      // ── Step 3: Query all overlay DOM elements ──
      const overlayEls = document.querySelectorAll("[data-segment-id]");
      console.log(
        "%c── Overlay Elements Found: %d ──",
        "font-weight:bold;color:#06b6d4;",
        overlayEls.length,
      );

      if (overlayEls.length === 0) {
        console.warn(
          "  No [data-segment-id] elements in DOM. Segments may not have mounted yet.",
        );
        console.groupEnd();
        return { scaleState: { cssScale, renderScale, dpr }, elements: [] };
      }

      // ── Helper: walk parent chain and collect transforms ──
      const getTransformChain = (el: HTMLElement): any[] => {
        const chain: any[] = [];
        let current: HTMLElement | null = el.parentElement;
        let level = 1;
        while (current && level <= 3) {
          const cs = window.getComputedStyle(current);
          chain.push({
            level: level === 1 ? "parent" : level === 2 ? "grandparent" : "great-grandparent",
            tag: current.tagName.toLowerCase(),
            id: current.id || "—",
            className: typeof current.className === "string"
              ? current.className.replace(/\s+/g, " ").trim().substring(0, 50)
              : "—",
            transform: cs.transform === "none" ? "none" : cs.transform,
          });
          current = current.parentElement;
          level++;
        }
        return chain;
      };

      // ── Helper: compute final scale by multiplying all parent matrix scales ──
      const computeFinalScale = (el: HTMLElement): number => {
        let scale = 1;
        let current: HTMLElement | null = el;
        while (current) {
          const t = window.getComputedStyle(current).transform;
          if (t && t !== "none") {
            const vals = t.match(/matrix[\d]*\(([^)]+)\)/);
            if (vals) {
              const parts = vals[1].split(",").map(Number);
              const sx = Math.sqrt(parts[0] * parts[0] + parts[1] * parts[1]);
              scale *= sx;
            }
          }
          current = current.parentElement;
        }
        return scale;
      };

      // ── Step 4: Per-element analysis ──
      const results: any[] = [];
      const maxToShow = 15;

      for (let i = 0; i < Math.min(overlayEls.length, maxToShow); i++) {
        const el = overlayEls[i] as HTMLElement;
        const segId = el.getAttribute("data-segment-id") || "";
        const computed = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const chain = getTransformChain(el);
        const finalScale = computeFinalScale(el);

        const hasNonNoneTransform = chain.some(
          (c: any) => c.transform !== "none",
        );

        if (hasNonNoneTransform) {
          console.group(
            "%c[%d] %c⚠️ %s",
            "color:#94a3b8;",
            i,
            "color:#ef4444;font-weight:bold;",
            segId.substring(0, 8),
          );
        } else {
          console.group(
            "%c[%d] %s",
            "color:#94a3b8;",
            i,
            segId.substring(0, 8),
          );
        }

        const owningSeg = segments.find((s: any) => s.id === segId);
        const expectedFontSize = owningSeg?.font?.size ?? "unknown";
        const actualFontSize = parseFloat(computed.fontSize);
        const delta = expectedFontSize === "unknown" ? NaN : actualFontSize - expectedFontSize;

        console.log(
          "%ctext:%c \"%s\"",
          "color:#94a3b8;",
          "color:#f59e0b;",
          (el.textContent || "").substring(0, 40),
        );
        console.log(
          "%cfontSize: calc=%c%s%c expected=%c%s%c delta=%c%s",
          "color:#94a3b8;",
          "color:#22c55e;", actualFontSize + "px",
          "color:#94a3b8;",
          "color:#06b6d4;", expectedFontSize + "px",
          "color:#94a3b8;",
          isNaN(delta) || delta === 0 ? "color:#22c55e;" : "color:#ef4444;font-weight:bold;",
          isNaN(delta) ? "N/A" : (delta === 0 ? "0" : (delta > 0 ? "+" : "") + delta + "px"),
        );
        console.log(
          "%clineHeight: %s",
          "color:#94a3b8;",
          computed.lineHeight,
        );
        console.log(
          "%cown transform: %c%s",
          "color:#94a3b8;",
          "",
          computed.transform,
        );
        if (chain.length > 0) {
          console.log("%c── Parent Transform Chain ──", "color:#94a3b8;");
          console.table(chain, ["level", "tag", "id", "className", "transform"]);
        }
        console.log(
          "%cfinalScale: %c%s",
          "color:#94a3b8;",
          finalScale !== 1 ? "color:#ef4444;font-weight:bold;" : "color:#22c55e;",
          finalScale.toFixed(4) + (finalScale !== 1 ? " ⚠️ NON-IDENTITY" : ""),
        );
        console.log(
          "%crect (browser): x=%d y=%d w=%d h=%d",
          "color:#94a3b8;",
          Math.round(rect.x), Math.round(rect.y),
          Math.round(rect.width), Math.round(rect.height),
        );
        if (owningSeg) {
          const expectedRect = {
            x: owningSeg.cssX, y: owningSeg.cssY,
            w: owningSeg.cssW, h: owningSeg.cssH,
          };
          const rectMatch =
            Math.abs(rect.x - expectedRect.x) < 5 &&
            Math.abs(rect.y - expectedRect.y) < 5 &&
            Math.abs(rect.width - expectedRect.w) < 5 &&
            Math.abs(rect.height - expectedRect.h) < 5;
          console.log(
            "%cexpected rect: x=%d y=%d w=%d h=%d %s",
            "color:#94a3b8;",
            Math.round(expectedRect.x), Math.round(expectedRect.y),
            Math.round(expectedRect.w), Math.round(expectedRect.h),
            rectMatch ? "✅" : "⚠️",
          );
        }

        results.push({
          id: segId.substring(0, 12),
          text: (el.textContent || "").substring(0, 30),
          computedFontSize: actualFontSize,
          expectedFontSize,
          delta: isNaN(delta) ? "N/A" : delta,
          finalScale: +finalScale.toFixed(4),
          hasTransformChain: hasNonNoneTransform,
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        });

        console.groupEnd();
      }

      if (overlayEls.length > maxToShow) {
        console.log(
          "  ... and %d more elements (not shown).",
          overlayEls.length - maxToShow,
        );
      }

      // ── Summary ──
      const elementsWithTransform = results.filter((r: any) => r.hasTransformChain);
      const elementsWithFontDelta = results.filter((r: any) => typeof r.delta === "number" && Math.abs(r.delta) > 2);

      console.log("%c── Summary ──", "font-weight:bold;color:#06b6d4;");
      console.log(
        "  Total overlay elements: %d",
        overlayEls.length,
      );
      console.log(
        "  %cElements with non-identity parent transform: %c%d",
        elementsWithTransform.length > 0 ? "color:#ef4444;" : "color:#22c55e;",
        elementsWithTransform.length > 0 ? "color:#ef4444;font-weight:bold;" : "",
        elementsWithTransform.length,
      );
      console.log(
        "  %cElements with fontSize delta > 2px: %c%d",
        elementsWithFontDelta.length > 0 ? "color:#ef4444;" : "color:#22c55e;",
        elementsWithFontDelta.length > 0 ? "color:#ef4444;font-weight:bold;" : "",
        elementsWithFontDelta.length,
      );

      if (elementsWithTransform.length > 0) {
        console.warn(
          "  ⚠️ CASE A/B detected: Overlay has parent transform scale. Check parent chain above.",
        );
      }
      if (elementsWithFontDelta.length > 0) {
        console.warn(
          "  ⚠️ CASE C detected: fontSize mismatch between computed and expected.",
        );
      }
      if (elementsWithTransform.length === 0 && elementsWithFontDelta.length === 0) {
        console.log("  %c✅ All overlay elements look clean (no transform chain, no fontSize delta).", "color:#22c55e;");
      }

      console.groupEnd();
      return { scaleState: { cssScale, renderScale, dpr }, elements: results, summary: { total: overlayEls.length, withTransform: elementsWithTransform.length, withFontDelta: elementsWithFontDelta.length } };
    };

    // ── Sprint 33.3.3 Task 5: Adobe Similarity Debug ──
    (window as any).__adobeSimilarityDebug = () => {
      if (!editableDocumentRef.current || !layoutDocument) {
        console.warn("[Sprint33.3.3] Need EditableDocument + LayoutDocument.");
        return null;
      }
      const doc = editableDocumentRef.current;
      const cssScale = cssScaleRef.current;
      const renderScale = 1.5;

      // Flatten: doc.pages[].blocks[] (not doc.blocks)
      const allBlocks: { block: typeof doc.pages[0]["blocks"][0]; pageIdx: number }[] = [];
      for (let pi = 0; pi < doc.pages.length; pi++) {
        for (const block of doc.pages[pi].blocks) {
          allBlocks.push({ block, pageIdx: pi });
        }
      }

      const result: any = {
        totalBlocks: allBlocks.length,
        fontMismatchBlocks: 0,
        fontMismatchPercent: 0,
        lineMismatchBlocks: 0,
        lineMismatchPercent: 0,
        positionMismatchTotalPx: 0,
        details: [] as any[],
      };

      // Expected "normal" values for a standard document
      const minReasonableFontSize = 8;   // CSS px (too small)
      const maxReasonableFontSize = 24;  // CSS px (too large)

      for (const { block, pageIdx } of allBlocks) {
        // Reconstruct text from glyphs
        const blockText = block.lines
          .map((l) => l.glyphs.map((g) => g.char).join(""))
          .join(" ");
        // Style: first line's style → fontSize; fallback to glyph styleRef
        const firstLine = block.lines[0];
        const firstGlyphStyleRef = firstLine?.glyphs[0]?.styleRef ?? -1;
        const docStyleEntry = firstGlyphStyleRef >= 0 ? doc.styles[firstGlyphStyleRef] : null;
        const overlayFontSize = firstLine?.style?.fontSize
          ?? docStyleEntry?.fontSize
          ?? 14;

        // Font mismatch: fontSize outside reasonable range
        const fontMismatch = overlayFontSize < minReasonableFontSize
          || overlayFontSize > maxReasonableFontSize;

        // Line count (EditableBlock has .lines array; no ocrLineCount meta)
        const currentLineCount = block.lines.length;

        // Position mismatch: bbox x deviation
        const expectedLeftEdge = 70; // CSS px
        const posMismatch = Math.abs(block.bbox.x - expectedLeftEdge);

        result.details.push({
          id: block.id,
          text: blockText.substring(0, 40),
          overlayFontSize,
          fontMismatch,
          currentLines: currentLineCount,
          lineMismatch: false,  // no original ocrLineCount to compare against
          bboxX: block.bbox.x,
          posMismatchPx: posMismatch,
          page: pageIdx,
          regionType: block.regionType,
        });

        if (fontMismatch) result.fontMismatchBlocks++;
        result.positionMismatchTotalPx += posMismatch;
      }

      const total = allBlocks.length || 1;
      result.fontMismatchPercent = ((result.fontMismatchBlocks / total) * 100).toFixed(1);
      result.lineMismatchPercent = "N/A";
      result.positionMismatchTotalPx = result.positionMismatchTotalPx.toFixed(1);

      console.group("%c[Sprint33.3.3] Adobe Similarity Metrics", "font-weight:bold;color:#3b82f6;");
      console.log("Total blocks:", result.totalBlocks);
      console.log(`Font mismatch:  ${result.fontMismatchPercent}% (${result.fontMismatchBlocks}/${result.totalBlocks})`);
      console.log(`Line mismatch:  N/A (no OCR metadata in EditableDocument)`);
      console.log(`Position mismatch: ${result.positionMismatchTotalPx} px total`);
      console.table(result.details.map((d: any) => ({
        id: d.id,
        page: d.page,
        fontSize: d.overlayFontSize,
        fontOK: !d.fontMismatch,
        lines: d.currentLines,
        regionType: d.regionType ?? "-",
        posErr: d.posMismatchPx.toFixed(1),
        text: d.text,
      })));
      console.groupEnd();

      return result;
    };

    // ── Sprint 33.3.4 Task 1 & 2: Position Coordinate Calibration ──
    (window as any).__positionMetricDebug = () => {
      if (!layoutDocument || !editableDocumentRef.current) {
        console.warn("[Sprint33.3.4] Need layoutDocument + EditableDocument.");
        return null;
      }
      const layout = layoutDocument;
      const edDoc = editableDocumentRef.current;
      const details: any[] = [];

      // Flatten all block-level nodes from the layout tree.
      // Key invariant: nodes that carry sourceBlockId are our comparison targets:
      //   - Reconstructed-paragraph path: line nodes have sourceBlockId (set in buildParagraphWithReconstructedLines)
      //   - Signature path:       inner signature sub-blocks have sourceBlockId (set in buildBlockNode)
      //   - Other/preserve path:  paragraph nodes have sourceBlockId (set in buildBlockNode)
      // Nodes without sourceBlockId are intermediate containers → recurse into their children.
      function walkLayout(node: any, ancestors: any[] = []): any[] {
        if (node.sourceBlockId) {
          return [{ node, ancestors }];
        }
        if (node.children?.length) {
          const result: any[] = [];
          for (const child of node.children) {
            result.push(...walkLayout(child, [...ancestors, node]));
          }
          return result;
        }
        return [];
      }

      const blockNodes: any[] = [];
      for (const page of layout.pages) {
        for (const topNode of page.children) {
          blockNodes.push(...walkLayout(topNode, []));
        }
      }

      // Build editable block map for quick lookup
      const editableBlocks = new Map<string, any>();
      for (const page of edDoc.pages) {
        for (const block of page.blocks) {
          editableBlocks.set(block.id, block);
        }
      }

      for (const { node, ancestors } of blockNodes) {
        const nodeBlockId = node.sourceBlockId;
        if (!nodeBlockId) continue;

        const editableBlock = editableBlocks.get(nodeBlockId);
        const isSignature = ancestors.some((a: any) => a.type === "signature");
        const parentSig = ancestors.find((a: any) => a.type === "signature");

        // Try to find rendered DOM element for this block
        let domRect: DOMRect | null = null;
        try {
          const el = document.querySelector(`[data-block-id="${nodeBlockId}"]`);
          if (el) {
            domRect = el.getBoundingClientRect();
          }
        } catch (_) {
          // DOM not available
        }

        const detail: any = {
          text: (node.text || "").substring(0, 50),
          sourceBlockId: nodeBlockId,
          type: node.type,
          isSignature,
          coordinateSpace: node.coordinateSpace || "?",

          layout: {
            bbox: { ...node.bbox },
            space: node.coordinateSpace || "CSS_PIXEL",
            rotation: node.transform?.rotation ?? 0,
          },

          editable: editableBlock
            ? { bbox: { ...editableBlock.bbox }, regionType: editableBlock.regionType }
            : { bbox: null, note: "not found" },

          renderer: domRect
            ? { x: Math.round(domRect.left * 100) / 100, y: Math.round(domRect.top * 100) / 100,
                w: Math.round(domRect.width * 100) / 100, h: Math.round(domRect.height * 100) / 100 }
            : null,
        };

        // Parent-child: if signature, compare parent bbox with child
        if (parentSig) {
          detail.signature = {
            parentBbox: { ...parentSig.bbox },
            childX: node.bbox.x,
            childY: node.bbox.y,
            deltaX: node.bbox.x - parentSig.bbox.x,
            deltaY: node.bbox.y - parentSig.bbox.y,
            isAbsoluteCoords: true, // confirmed: children use page-absolute bbox
            rotation: parentSig.transform?.rotation ?? 0,
          };
        }

        details.push(detail);
      }

      // Summary statistics
      let totalPosErr = 0;
      let signatureBlocks = 0;
      for (const d of details) {
        if (d.layout.bbox && d.editable?.bbox) {
          const dx = Math.abs(d.layout.bbox.x - d.editable.bbox.x);
          const dy = Math.abs(d.layout.bbox.y - d.editable.bbox.y);
          totalPosErr += dx + dy;
        }
        if (d.isSignature) signatureBlocks++;
      }

      console.group("%c[Sprint33.3.4] Position Metric Debug", "font-weight:bold;color:#22c55e;");
      console.log(`Blocks: ${details.length} (signature: ${signatureBlocks})`);
      console.log(`Total layout↔editable position delta: ${totalPosErr.toFixed(1)} px`);
      if (signatureBlocks > 0) {
        console.log("%cSignature parent-child analysis:", "font-weight:bold;color:#f59e0b;");
        for (const d of details.filter((d: any) => d.signature)) {
          console.log(`  ${d.text}`, d.signature);
        }
      }
      console.table(details.map((d: any) => ({
        text: d.text,
        type: d.type,
        sig: d.isSignature ? "Y" : "-",
        space: d.coordinateSpace,
        lx: d.layout.bbox.x.toFixed(1),
        ly: d.layout.bbox.y.toFixed(1),
        ex: d.editable?.bbox?.x?.toFixed(1) ?? "-",
        ey: d.editable?.bbox?.y?.toFixed(1) ?? "-",
        rot: d.layout.rotation.toFixed(1),
      })));
      console.groupEnd();

      return details;
    };

    return () => {
      delete (window as any).__layoutDebug;
      delete (window as any).__layoutTree;
      delete (window as any).__layoutDump;
      delete (window as any).__signatureLayoutDebug;
      delete (window as any).__editableTransformDebug;
      delete (window as any).__signatureCoordinateDebug;
      delete (window as any).__signatureRegionIsolationDebug;
      delete (window as any).__signatureExportDebug;
      delete (window as any).__lineReconstructionDebug;
      delete (window as any).__lineReconstructionScoreDebug;
      delete (window as any).__ocrLineDebug;
      delete (window as any).__lineStabilityDebug;
      delete (window as any).__textMetricDebug;
      delete (window as any).__adobeSimilarityDebug;
      delete (window as any).__positionMetricDebug;
      delete (window as any).__overlayTransformDebug;
      delete (window as any).__overlaySimilarityDebug;
      delete (window as any).__overlayRuntimeDebug;
      delete (window as any).__overlayRuntimeDebugEnabled;
    };
  }, [layoutDocument]);

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

  // ── M6-001C: Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y → OperationHistory undo/redo ──
  // 注意：useSelection 的 Ctrl+Z 监听在 New Replace 模式下 warn + no-op（不冲突）。
  // 本监听在 New Replace 模式下执行真实 OperationHistory undo/redo，并刷新 render。
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const isZ = e.key === "z" || e.key === "Z";
      const isY = e.key === "y" || e.key === "Y";
      if (!isZ && !isY) return;
      // 若正在编辑（EditSession active），不抢退（避免与键盘编辑冲突）
      if (editSessionRef.current && editSessionRef.current.status === "active") return;

      const hist = operationHistoryRef.current;
      if (!hist) return;
      if (isZ) {
        e.preventDefault();
        const doRedo = e.shiftKey;
        const doc = editableDocumentRef.current;
        if (!doc) return;
        const res = doRedo ? hist.redo(doc) : hist.undo(doc);
        if (res.success) {
          editableDocumentRef.current = res.document;
          (window as any).__editableDocument = res.document;
          setEditableDocVersion((v) => v + 1);
          const renderedBlocks = renderToBlocks(res.document);
          if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
        }
      } else if (isY) {
        e.preventDefault();
        const doc = editableDocumentRef.current;
        if (!doc) return;
        const res = hist.redo(doc);
        if (res.success) {
          editableDocumentRef.current = res.document;
          (window as any).__editableDocument = res.document;
          setEditableDocVersion((v) => v + 1);
          const renderedBlocks = renderToBlocks(res.document);
          if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [editSessionRef]);

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
      canvas.width = vp.width;
      canvas.height = vp.height;
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
      await pg.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
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

        // M7.8-042-FIX：与导入路径（parsePdfToEditableDocument）对齐，为新构建页建立
        // glyph → operatorId 溯源。必须在 merge 进 editableDocumentRef 之前（页仍是纯原文，
        // 内容身份对齐的 Gstr 不含用户编辑，命中率最高）。失败闭环：留空 → 导出绝不误删。
        try {
          if (pdfLibDocRef.current) {
            await assignOperatorProvenanceForPage(editablePage, pdfLibDocRef.current, page - 1);
          }
        } catch (e) {
          console.warn("[M7.8-042-FIX] assignOperatorProvenanceForPage failed, 导出按文本兜底剥离:", e);
        }

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
    return () => { done = true; };
  }, [pdfDoc, page]);

  // M7.8-020-PROD：PDF 卸载/切换时清理字体解析缓存（销毁 patchedDoc，释放内存；FontFace 由 fontFaceCache 自管）。
  useEffect(() => {
    return () => {
      if (pdfDoc) unloadDocumentFonts(pdfDoc);
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

            pages.push(editablePage);
          }
          pages.sort((a, b) => a.index - b.index);

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

                const renderedBlocks = renderToBlocks(result.document);
                if (renderedBlocks.length > 0) {
                  setDocBlocks(renderedBlocks);
                }

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

                const renderedBlocks = renderToBlocks(result.document);
                if (renderedBlocks.length > 0) {
                  setDocBlocks(renderedBlocks);
                }

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

                  const renderedBlocks = renderToBlocks(editableDocumentRef.current);
                  if (renderedBlocks.length > 0) {
                    setDocBlocks(renderedBlocks);
                  }

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

                  const renderedBlocks = renderToBlocks(newSemDoc.document);
                  if (renderedBlocks.length > 0) {
                    setDocBlocks(renderedBlocks);
                  }

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
                  const renderedBlocks = renderToBlocks(result.document);
                  if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
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
                  const renderedBlocks = renderToBlocks(result.document);
                  if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
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
                  const renderedBlocks = renderToBlocks(result.document);
                  if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
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
            // 用渲染后的 blocks 替换之前注入的 blocksToInject
            setDocBlocks((prev) => {
              // 移除之前注入的 OCR blocks（按 page 匹配）
              const ocrPages = new Set(result.blocks.map((b: any) => b.page));
              const nonOcrBlocks = prev.filter((b) => !ocrPages.has(b.page));
              return [...nonOcrBlocks, ...renderedBlocks];
            });
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

  // Drag + Resize (Commit 4: drag 期间高频 setDocBlocks 不进 history；mouseup 时 push 一个 PatchBlocksCommand)
  useEffect(() => {
    const move = (e: MouseEvent) => {
      // 关键：在事件触发时把 drag/resize 引用捕获到本地常量。
      // setDocBlocks 的 updater 在 React 后续渲染阶段才执行；若期间发生 mouseup
      // 把 dragRef.current 置 null，原代码读 dragRef.current!.id 会抛
      // "Cannot read properties of null (reading 'id')"（PDFEditor.tsx:7305 崩溃）。
      const drag = dragRef.current;
      const resize = resizeRef.current;
      // drag/resize 首次触发时，通过 setDocBlocks updater 拿 latest state（no-op 返回），记录 prev snapshot
      if ((drag || resize) && !dragStartBlocksRef.current) {
        setDocBlocks((prev) => {
          dragStartBlocksRef.current = JSON.parse(JSON.stringify(prev));
          return prev;
        });
      }
      if (drag) {
        const { id, ox0, ox, oy0, oy } = drag;
        setDocBlocks((prev) =>
          prev.map((b) =>
            b && b.id === id
              ? { ...b, x: ox0 + e.clientX - ox, y: oy0 + e.clientY - oy }
              : b
          )
        );
      }
      if (resize) {
        const { id, initW, startX, initH, startY } = resize;
        setDocBlocks((prev) =>
          prev.map((b) =>
            b && b.id === id
              ? { ...b, w: Math.max(30, initW + e.clientX - startX), h: Math.max(30, initH + e.clientY - startY) }
              : b
          )
        );
      }
    };
    const up = () => {
      // drag/resize 结束：push 一个 PatchBlocksCommand(prev, current)，让此次操作进入 undo 历史
      if (dragStartBlocksRef.current) {
        const prevSnapshot = dragStartBlocksRef.current;
        dragStartBlocksRef.current = null;
        let pushed = false;
        setDocBlocks((current) => {
          if (!pushed) {
            undoRef.push(new PatchBlocksCommand(prevSnapshot, current));
            pushed = true;
          }
          return current; // no-op
        });
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
    clearHistory(); // Commit 4: 新文档加载，清空 undo/redo 历史
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
    editableDocumentRef.current = null;

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
      const blockId = `seg_block_${editingSegmentId}`;
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
  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      addBlock("image", { src: reader.result as string, w: 160, h: 160 });
    };
    reader.readAsDataURL(file);
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
        const renderedBlocks = renderToBlocks(result.document);
        if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
      },
    });

    registry.register("replace", new ReplaceCommand(runtime));
    registry.register("delete", new DeleteCommand(runtime));
    registry.register("rewrite", new RewriteCommand(runtime));
    registry.register("translate", new TranslateCommand(runtime));
    registry.register("fixOcr", new FixOcrCommand(runtime));

    // ── Task-013B: 真实 CurrentSelectionProvider（Consistency Guard）──
    // 从 onSelectionChanged 更新的 ref 读取 DerivedSelection → CurrentSelection。
    // Guard：selection.blockId/lineId 不存在于当前 document → 返回 null。
    const provider = new MapCurrentSelectionProvider({
      getDerivedSelection: () => currentDerivedSelectionRef.current,
      getDocument: () => editableDocumentRef.current,
    });

    return new EditTool(registry, provider);
  }, []);

  // ── M7-001: Paste → EditSession（insertAtGlyph 纯 session 层，不 mutation）──
  // 复用 insertAtGlyph（multi-char 已支持），更新 session.text + glyphCaret。
  // commit 走现有 onTextEditSave → applyTextOperation.insert → 单 History entry（undo 一次撤销整段）。
  const handlePasteEdit = useCallback(
    (text: string, session: EditSession) => {
      if (session.status !== "active" || !session.glyphCaret) return;
      dispatchSession(insertAtGlyph(session, text));
    },
    []
  );

  // ── M6-001C: 提交后把 operation push 进 OperationHistory ──
  const pushOperationToHistory = useCallback(
    (operation: TextOperation, result: MutationResult) => {
      const hist = operationHistoryRef.current;
      if (!hist || !result.inverse) return;
      // caret/selection：003C 阶段用 glyphCaret 表达；此处以 operation target 粗略映射
      const t = operationTarget(operation);
      hist.push({
        operation,
        inverse: result.inverse,
        beforeCaret: undefined,
        afterCaret: undefined,
      });
      void t;
    },
    []
  );

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
      const fullLineText = selLine.glyphs.map((g) => g.char).join("");
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

  return (
    <div data-layer="pdfsail-root" style={{ border: "1px solid #e2e8f0", borderRadius: 12, background: "#fff", boxShadow: "0 2px 12px rgba(0,0,0,0.06)", overflow: "hidden" }}>
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
          {/* 编辑器页头 Logo（PDFSail 品牌） */}
          <PdfSailLogo size={38} />
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
        <DownloadButton handleExport={handleExportWithCommit} cssScaleRef={cssScaleRef} disabled={!pdfDoc} />
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
          handleOCRRegion={handleOCRRegion}
          handleUpload={handleUpload}
          exitEditMode={exitEditMode}
          // OCR-EDIT-SYNC: 段落块 Portal 编辑提交 → 同步回 EditableDocument
          onBlockTextCommit={commitBlockTextToDocument}
          enableClickToEdit={!!ocrTaskId || !!editableDocumentRef.current}
          glyphCommands={glyphCommands}
          docStyles={editableDocumentRef.current?.styles || []}
          sceneReady={sceneReady}
          sceneReadyBase={sceneReadyBase}
          caretPosition={resolveCaretPosition(editableDocumentRef.current, editSession?.glyphCaret)}
          selectionHighlight={selectionHighlightQuads(editableDocumentRef.current, editSession)}
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
            dispatchSession(applyTextareaValue(s, value, cursorUtf16));
          }}
          selectedGlyphIds={selectedGlyphIds}
          // M7.7-003B-002 (Bug2): 已提交编辑过的行 → native-canvas 下也渲染改后文本 overlay
          // M7.7-004U: 行级（editedLines + editedLineBoxes），只重渲染已编辑行，未编辑行保持扫描原样
          editedLines={editedLines}
          editedLineBoxes={editedLineBoxes}
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
                const fullLineText = lineGlyphs.map((g) => g.char).join("");
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
              const renderedBlocks = renderToBlocks(result.document);
              if (renderedBlocks.length > 0) {
                setDocBlocks(renderedBlocks);
              }

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
          onTextEditSave={(blockId: string, newText: string) => {
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
                    const renderedBlocks = renderToBlocks(result.document);
                    if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
                    // M7.7-003: 提交后不再 setSelectedText → Workspace 不再弹出（inline-first，右侧不压缩）。
                    setSaveStatus("saved");
                    recordWorkspaceEvent("save", { blockId, textLen: committed.text.length });
                    // M7.7-003B-002 (Bug2): 该行已提交编辑 → native-canvas 下也渲染 overlay，让改后文本可见
                    // M7.7-004U: 行级标记（只重渲染已编辑的行，未编辑行保持 canvas 扫描原样）
                    markLineEdited(target.blockId, target.lineId);
                    deleteApplied = true;
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
                const renderedBlocks = renderToBlocks(result.document);
                if (renderedBlocks.length > 0) setDocBlocks(renderedBlocks);
                // M7.7-003: 提交后不再 setSelectedText → Workspace 不再弹出（inline-first，右侧不压缩）。
                setSaveStatus("saved");
                recordWorkspaceEvent("save", { blockId, textLen: newText.length });
                // M7.7-003B-002 (Bug2): 该行已提交编辑 → native-canvas 下也渲染 overlay，让改后文本可见
                // M7.7-004U: 行级标记（只重渲染已编辑的行，未编辑行保持 canvas 扫描原样）
                markLineEdited(target.blockId, target.lineId);

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
                if (afterLine && afterLine.glyphs.length > 0) {
                  const glyphs = afterLine.glyphs;
                  // M7.7-042: 统一像素审计辅助函数（alpha 感知）
                  const _auditPixels = (imageData: ImageData) => {
                    const totalPixels = imageData.width * imageData.height;
                    let opaquePixels = 0, inkPixels = 0, blackPixels = 0;
                    for (let i = 0; i < imageData.data.length; i += 4) {
                      const r = imageData.data[i], g = imageData.data[i+1], b = imageData.data[i+2], a = imageData.data[i+3];
                      const isOpaque = a > 10;
                      if (isOpaque) opaquePixels++;
                      if (isOpaque && (r < 250 || g < 250 || b < 250)) inkPixels++;
                      if (isOpaque && r < 80 && g < 80 && b < 80) blackPixels++;
                    }
                    return { totalPixels, opaquePixels, inkPixels, blackPixels };
                  };
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
                  // M7.7-075: TEXT_SOURCE_AUDIT — 枚举本行所有 DOM 文本源（含 AI overlay / glyph / replacement canvas）
                  {
                    const sources: Array<{
                      selector: string;
                      dataLayer: string | null;
                      textContent: string;
                      rect: { top: number; left: number; width: number; height: number };
                      visibility: string;
                      display: string;
                      zIndex: string;
                      parentLayer: string | null;
                    }> = [];
                    const auditEls = new Set<HTMLElement>();
                    document.querySelectorAll(`[data-line-id="${target.lineId}"]`).forEach((e) => auditEls.add(e as HTMLElement));
                    document.querySelectorAll(`#canvas-replace-${target.lineId}`).forEach((e) => auditEls.add(e as HTMLElement));
                    document.querySelectorAll(`[data-line-id="${target.lineId}"][data-layer="overlay"]`).forEach((e) => auditEls.add(e as HTMLElement));
                    document.querySelectorAll(`[data-line-id="${target.lineId}"][data-layer="mask"]`).forEach((e) => auditEls.add(e as HTMLElement));
                    auditEls.forEach((el) => {
                      const cs = getComputedStyle(el);
                      const r = el.getBoundingClientRect();
                      const parent = el.parentElement;
                      const parentLayer = parent ? (parent.getAttribute("data-layer") || (typeof parent.className === "string" && parent.className) || parent.tagName.toLowerCase()) : null;
                      sources.push({
                        selector: el.id ? `#${el.id}` : (el.getAttribute("data-layer") ? `[data-layer="${el.getAttribute("data-layer")}"]` : el.tagName.toLowerCase()),
                        dataLayer: el.getAttribute("data-layer"),
                        textContent: (el.textContent || "").replace(/\s+/g, " ").slice(0, 80),
                        rect: { top: Math.round(r.top * 100) / 100, left: Math.round(r.left * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 },
                        visibility: cs.visibility,
                        display: cs.display,
                        zIndex: cs.zIndex,
                        parentLayer,
                      });
                    });
                    console.log("[M7.7-075][TEXT_SOURCE_AUDIT]", { lineId: target.lineId, count: sources.length, sources });
                  }
                  // M7.7-075: AI overlay 隔离 — committed edit render 时，overlay 不参与（避免与 replacement canvas 重复文本残留）
                  // 不删除 overlay 功能：仅在其与 replacement canvas 同行的 committed 渲染期隐藏；replacement 缺失时不隐藏。
                  {
                    const aiOverlayEls = document.querySelectorAll(`[data-line-id="${target.lineId}"][data-layer="overlay"]`) as NodeListOf<HTMLElement>;
                    let hidden = 0;
                    aiOverlayEls.forEach((el) => {
                      el.style.display = "none";
                      el.dataset.aiIsolated = "1";
                      hidden++;
                    });
                    if (hidden > 0) {
                      console.log("[M7.7-075][OVERLAY_ISOLATED]", { lineId: target.lineId, hidden });
                    }
                  }
                  // M7.7-050: 读取 mask 元素（仅用于记录/对齐校验，不参与 glyph 坐标与 canvasTop）
                  const maskEl = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                  const maskBoxY = maskEl ? maskEl.offsetTop : minY;
                  const maskBoxBottom = maskEl ? maskEl.offsetTop + maskEl.offsetHeight : (minY + ch);
                  const maskHeight = maskEl ? maskEl.offsetHeight : (inkBottom - inkTop + insetPad * 2);
                  replaceCanvas.style.top = `${canvasTop}px`;
                  // M7.7-073: FINAL_SCREEN_RECT_AUDIT — 只读，仅打印真实 DOM rect（不改任何逻辑）
                  // (a) MASK_SCREEN — 无论 maskEl 是否存在都打印（缺失时字段记 null，便于发现未创建 mask）
                  {
                    const mr = maskEl ? maskEl.getBoundingClientRect() : null;
                    const mParent = maskEl ? (maskEl.offsetParent as HTMLElement | null) : null;
                    const mParentRect = mParent ? mParent.getBoundingClientRect() : null;
                    console.log("[M7.7-073][MASK_SCREEN]", {
                      lineId: target.lineId,
                      maskFound: !!maskEl,
                      localTop: maskEl ? Math.round(maskEl.offsetTop * 100) / 100 : null,
                      localHeight: maskEl ? Math.round(maskEl.offsetHeight * 100) / 100 : null,
                      getBoundingClientRect: mr
                        ? { top: Math.round(mr.top * 100) / 100, bottom: Math.round(mr.bottom * 100) / 100, height: Math.round(mr.height * 100) / 100 }
                        : null,
                      parentTransform: mParent ? getComputedStyle(mParent).transform : "none",
                      parentRect: mParentRect ? { top: Math.round(mParentRect.top * 100) / 100, height: Math.round(mParentRect.height * 100) / 100 } : null,
                    });
                  }
                  // (b) REPLACEMENT_SCREEN
                  {
                    const rr = replaceCanvas.getBoundingClientRect();
                    const rParent = replaceCanvas.offsetParent as HTMLElement | null;
                    console.log("[M7.7-073][REPLACEMENT_SCREEN]", {
                      lineId: target.lineId,
                      styleTop: Math.round(canvasTop * 100) / 100,
                      styleHeight: Math.round(canvasHeight * 100) / 100,
                      getBoundingClientRect: {
                        top: Math.round(rr.top * 100) / 100,
                        bottom: Math.round(rr.bottom * 100) / 100,
                        height: Math.round(rr.height * 100) / 100,
                      },
                      offsetParent: rParent ? rParent.tagName.toLowerCase() + (rParent.id ? `#${rParent.id}` : "") : null,
                      parentTransform: rParent ? getComputedStyle(rParent).transform : "none",
                    });
                  }
                  // (c) PARENT_CHAIN — 从 replacement canvas 向上遍历真实 DOM 链
                  {
                    const chain: Array<{ element: string; rect: { top: number; left: number; height: number }; transform: string; position: string }> = [];
                    let node: HTMLElement | null = replaceCanvas;
                    let depth = 0;
                    while (node && depth < 12) {
                      const ncs = getComputedStyle(node);
                      const nr = node.getBoundingClientRect();
                      chain.push({
                        element: node.tagName.toLowerCase() + (node.id ? `#${node.id}` : "") + (node.className && typeof node.className === "string" ? `.${node.className.trim().split(/\s+/).join(".")}` : ""),
                        rect: { top: Math.round(nr.top * 100) / 100, left: Math.round(nr.left * 100) / 100, height: Math.round(nr.height * 100) / 100 },
                        transform: ncs.transform,
                        position: ncs.position,
                      });
                      node = node.parentElement;
                      depth++;
                    }
                    console.log("[M7.7-073][PARENT_CHAIN]", chain);
                  }
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
                    maskHeight: Math.round(maskHeight * 100) / 100,
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
                  console.log("[M7.7-050][REPLACEMENT_ALIGN]", {
                    lineId: target.lineId,
                    mask: { top: Math.round(maskBoxY * 100) / 100, bottom: Math.round(maskBoxBottom * 100) / 100 },
                    replacement: { top: Math.round(maskBoxY * 100) / 100, bottom: Math.round((maskBoxY + canvasHeight) * 100) / 100 },
                    delta: { top: Math.round((maskBoxY - minY) * 100) / 100, baseline: 0 },
                  });
                  // M7.7-051: CSS Stacking Context Audit
                  const _getStackingInfo = (el: HTMLElement | null) => {
                    if (!el) return { tag: "null", position: "null", zIndex: "null", stackingContext: "null" };
                    const cs = getComputedStyle(el);
                    let ctx: HTMLElement | null = el.parentElement;
                    let ctxDesc = "root (html)";
                    while (ctx) {
                      const ccs = getComputedStyle(ctx);
                      if (ccs.zIndex !== "auto" && ccs.position !== "static") { ctxDesc = `${ctx.tagName.toLowerCase()}${ctx.id ? "#"+ctx.id : ""} (zIndex:${ccs.zIndex}, position:${ccs.position})`; break; }
                      if (ccs.opacity !== "1") { ctxDesc = `${ctx.tagName.toLowerCase()}${ctx.id ? "#"+ctx.id : ""} (opacity:${ccs.opacity})`; break; }
                      if (ccs.transform !== "none") { ctxDesc = `${ctx.tagName.toLowerCase()}${ctx.id ? "#"+ctx.id : ""} (transform:${ccs.transform.slice(0,40)}...)`; break; }
                      if (ccs.isolation === "isolate") { ctxDesc = `${ctx.tagName.toLowerCase()}${ctx.id ? "#"+ctx.id : ""} (isolation:isolate)`; break; }
                      ctx = ctx.parentElement;
                    }
                    return { tag: el.tagName.toLowerCase() + (el.id ? "#"+el.id : ""), position: cs.position, zIndex: cs.zIndex, stackingContext: ctxDesc };
                  };
                  const pdfCanvasEl = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLElement | null;
                  const glyphLayerEl = document.querySelector('[data-layer="glyph"]') as HTMLElement | null;
                  const maskElForStack = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                  console.log("[M7.7-051][CSS_STACKING]", {
                    pdfCanvas: _getStackingInfo(pdfCanvasEl),
                    glyphLayer: _getStackingInfo(glyphLayerEl),
                    mask: _getStackingInfo(maskElForStack),
                    replacement: _getStackingInfo(replaceCanvas),
                  });
                  // M7.7-063: Lifecycle tracker helper
                  const _recordLifecycle = (lineId: string, action: string, c: CanvasRenderingContext2D, w: number, h: number) => {
                    const lc = (window as any).__replacementLifecycle ?? {};
                    if (!lc[lineId]) lc[lineId] = { drawSequence: [], canvasCount: 0 };
                    lc[lineId].canvasCount = document.querySelectorAll(`canvas[id^="canvas-replace"]`).length;
                    let inkPixels = -1;
                    try {
                      const d = c.getImageData(0, 0, w, h);
                      let ip = 0;
                      for (let i = 0; i < d.data.length; i += 4) {
                        if (d[i+3] > 10 && (d[i] < 250 || d[i+1] < 250 || d[i+2] < 250)) ip++;
                      }
                      inkPixels = ip;
                    } catch (_) { /* ignore */ }
                    lc[lineId].drawSequence.push({ action, inkPixels, timestamp: Date.now() });
                    (window as any).__replacementLifecycle = lc;
                  };
                  // M7.7-040: 追踪 draw 次数
                  const drawCount = (parseInt(replaceCanvas.dataset.drawCount || "0") || 0) + 1;
                  replaceCanvas.dataset.drawCount = String(drawCount);
                  const ctx = replaceCanvas.getContext("2d");
                  // M7.7-041: 替换 canvas context 方法追踪突变
                  if (ctx) {
                    console.log("[M7.7-041][DEBUG] wrapping ctx methods", { canvasId, lineId: target.lineId });
                    const _origFillText = ctx.fillText.bind(ctx);
                    const _origClearRect = ctx.clearRect.bind(ctx);
                    const _origFillRect = ctx.fillRect.bind(ctx);
                    const _origDrawImage = ctx.drawImage.bind(ctx);
                    const _origPutImageData = ctx.putImageData.bind(ctx);
                    const _canvasId = canvasId;
                    const _lineId = target.lineId;
                    let _firstBlack = true;
                    const _scanBlack = (tag: string, ...args: any[]) => {
                      const w = replaceCanvas.width, h = replaceCanvas.height;
                      if (w === 0 || h === 0) { console.log("[M7.7-041][DEBUG] skip zero dim", { tag, w, h }); return; }
                      try {
                        const d = ctx.getImageData(0, 0, w, h);
                        const { totalPixels, opaquePixels, inkPixels, blackPixels } = _auditPixels(d);
                        console.log("[M7.7-042][SCAN]", { tag, totalPixels, opaquePixels, inkPixels, blackPixels, args: args.slice(0, 3).map(a => typeof a === "number" ? Math.round(a * 100) / 100 : a) });
                        if (blackPixels > 0 && _firstBlack) {
                          _firstBlack = false;
                          console.log("[M7.7-042][FIRST_BLACK]", {
                            canvasId: _canvasId,
                            lineId: _lineId,
                            operation: tag,
                            args: args.map(a => typeof a === "number" ? Math.round(a * 100) / 100 : a),
                            totalPixels,
                            opaquePixels,
                            inkPixels,
                            blackPixels,
                            stack: new Error().stack?.split("\n").slice(2, 8).join(" | "),
                          });
                        }
                      } catch (_) {}
                    };
                    ctx.fillText = function(...a: any[]) {
                      const r = _origFillText(...a as [string, number, number, (number | undefined)?]);
                      _scanBlack("fillText", ...a);
                      return r;
                    } as typeof ctx.fillText;
                    ctx.clearRect = function(...a: any[]) {
                      const r = _origClearRect(...a as [number, number, number, number]);
                      _scanBlack("clearRect", ...a);
                      return r;
                    } as typeof ctx.clearRect;
                    ctx.fillRect = function(...a: any[]) {
                      const r = _origFillRect(...a as [number, number, number, number]);
                      _scanBlack("fillRect", ...a);
                      return r;
                    } as typeof ctx.fillRect;
                    ctx.drawImage = function(...a: any[]) {
                      const r = _origDrawImage(...a as any);
                      _scanBlack("drawImage", ...a);
                      return r;
                    } as typeof ctx.drawImage;
                    ctx.putImageData = function(...a: any[]) {
                      const r = _origPutImageData(...a as any);
                      _scanBlack("putImageData", ...a);
                      return r;
                    } as typeof ctx.putImageData;
                  }
                  if (ctx) {
                    // M7.7-040: clearRect 前扫描
                    console.log("[M7.7-042][BEFORE_CLEAR_ENTERED]", { canvasId, cw, ch, lineId: target.lineId });
                    let bcAudit: ReturnType<typeof _auditPixels> | null = null;
                    try {
                      const beforeClear = ctx.getImageData(0, 0, cw, ch);
                      bcAudit = _auditPixels(beforeClear);
                      console.log("[M7.7-042][BEFORE_CLEAR]", {
                        canvasId,
                        drawCount,
                        lineId: target.lineId,
                        bitmapSize: { width: cw, height: ch },
                        ...bcAudit,
                        isReused: replaceCanvas.dataset.instanceId !== instanceId,
                      });
                    } catch (e) {
                      console.error("[M7.7-042][BEFORE_CLEAR_ERROR]", { canvasId, cw, ch, error: String(e) });
                    }
                    // M7.7-063: Lifecycle — CLEAR
                    _recordLifecycle(target.lineId, "CLEAR", ctx, cw, canvasHeight);
                    // M7.8-024: canvas 高度为 canvasHeight，必须用 canvasHeight 清除，否则底部残留旧像素。
                    ctx.clearRect(0, 0, cw, canvasHeight);
                    try {
                      const afterClear = ctx.getImageData(0, 0, cw, ch);
                      const acAudit = _auditPixels(afterClear);
                      console.log("[M7.7-042][CLEAR]", {
                        canvasId,
                        drawCount,
                        lineId: target.lineId,
                        before: bcAudit,
                        after: acAudit,
                        cleared: (bcAudit?.blackPixels ?? 0) > 0 && acAudit.blackPixels === 0,
                      });
                    } catch (e) {
                      console.error("[M7.7-042][CLEAR_ERROR]", { canvasId, cw, ch, error: String(e) });
                    }
                    // M7.7-063: Lifecycle — CREATE (after clear)
                    _recordLifecycle(target.lineId, "CREATE", ctx, cw, ch);
                    // M7.7-063: Helper — 绘制结束后输出最终汇总
                    const _lifecycleSummary = (lineId: string) => {
                      const lc = (window as any).__replacementLifecycle?.[lineId];
                      if (lc) {
                        console.log("[M7.7-063][REPLACEMENT_BITMAP_LIFECYCLE]", {
                          lineId,
                          canvasCount: lc.canvasCount,
                          drawSequence: lc.drawSequence,
                        });
                        // 清理，避免重复累积
                        delete (window as any).__replacementLifecycle[lineId];
                      }
                    };
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
                    _recordLifecycle(target.lineId, "DRAW_A", ctx, cw, ch);

                    // 方法 B: fillText(char, x, baseline) — textBaseline = "alphabetic"
                    ctx.textBaseline = "alphabetic";
                    ctx.fillStyle = "#ff0000";
                    ctx.fillText(firstGlyph.char, firstX, firstBaselineOffset);
                    _recordLifecycle(target.lineId, "DRAW_B", ctx, cw, ch);

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
                        _recordLifecycle(target.lineId, "DRAW_C", ctx, cw, ch);
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

                    // M7.7-042: 绘制前后像素审计（alpha 感知）
                    const beforeRepData = ctx.getImageData(0, 0, cw, ch);
                    const beforeRepAudit = _auditPixels(beforeRepData);
                    const firstDrawGlyph = glyphs[0];
                    const firstDrawStyle = styles[firstDrawGlyph.styleRef] || {};
                    const firstDrawFont = `${firstDrawStyle.fontStyle || "normal"} ${firstDrawStyle.fontWeight || "normal"} ${firstDrawStyle.fontSize || 12}px ${firstDrawStyle.pdfjsFontFamily || firstDrawStyle.fontFamily || "sans-serif"}`;
                    const firstDrawBl = firstDrawGlyph.baseline ?? afterLine.baseline ?? (firstDrawGlyph.bbox.y + firstDrawGlyph.bbox.height * 0.8);
                    const sampleGlyphs = glyphs.slice(0, 3).map(g => {
                      const s = styles[g.styleRef] || {};
                      return {
                        char: g.char,
                        x: Math.round((g.bbox.x - minX) * 100) / 100,
                        y: Math.round((g.bbox.y - minY) * 100) / 100,
                        width: Math.round(g.bbox.width * 100) / 100,
                        height: Math.round(g.bbox.height * 100) / 100,
                        font: `${s.fontSize || 12}px ${s.pdfjsFontFamily || s.fontFamily || "sans-serif"}`,
                        baseline: Math.round((g.baseline ?? afterLine.baseline ?? (g.bbox.y + g.bbox.height * 0.8) - minY) * 100) / 100,
                      };
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
                    const afterRepData = ctx.getImageData(0, 0, cw, ch);
                    const afterRepAudit = _auditPixels(afterRepData);
                    console.log("[M7.7-042][REPLACEMENT_DRAW]", {
                      lineId: target.lineId,
                      glyphCount: glyphs.length,
                      canvasRect: { width: cw, height: ch },
                      ctxFont: ctx.font,
                      ctxFillStyle: ctx.fillStyle,
                      sampleGlyphs,
                      beforeImageData: beforeRepAudit,
                      afterImageData: afterRepAudit,
                      firstGlyph: {
                        char: firstDrawGlyph.char,
                        x: Math.round((firstDrawGlyph.bbox.x - minX) * 100) / 100,
                        y: Math.round((firstDrawBl - minY) * 100) / 100,
                        font: firstDrawFont,
                        baseline: Math.round(firstDrawBl * 100) / 100,
                      },
                    });
                    console.log("[M7.7-042][AFTER_DRAW]", {
                      canvasId,
                      drawCount,
                      lineId: target.lineId,
                      ...afterRepAudit,
                      pctBlack: Math.round((afterRepAudit.blackPixels / (afterRepAudit.totalPixels || 1)) * 10000) / 100,
                    });
                    // M7.7-063: Lifecycle — DRAW (production path)
                    _recordLifecycle(target.lineId, "DRAW", ctx, cw, ch);
                    // M7.7-063: 输出最终汇总
                    _lifecycleSummary(target.lineId);
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
                    // M7.7-038: Canvas Ink Coverage Audit
                    console.log("[M7.7-042][BEFORE_MASK_ENTERED]", { lineId: target.lineId, hasRepCR: !!repCR });
                    const pdfCanvasNode = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                    if (pdfCanvasNode && repCR) {
                      const pdfCtx = pdfCanvasNode.getContext("2d");
                      const pdfCR2 = pdfCanvasNode.getBoundingClientRect();
                      const cssScaleX = pdfCanvasNode.clientWidth > 0 ? pdfCanvasNode.width / pdfCanvasNode.clientWidth : 1;
                      const cssScaleY = pdfCanvasNode.clientHeight > 0 ? pdfCanvasNode.height / pdfCanvasNode.clientHeight : 1;
                      // 将 ink bbox 转换为 PDF canvas 内部像素坐标
                      const scanLeft = Math.round((repCR.left - pdfCR2.left) * cssScaleX);
                      const scanTop = Math.round((repCR.top - pdfCR2.top) * cssScaleY);
                      const scanW = Math.round(repCR.width * cssScaleX);
                      const scanH = Math.round(repCR.height * cssScaleY);
                      if (pdfCtx && scanW > 0 && scanH > 0) {
                        try {
                          const beforeData = pdfCtx.getImageData(scanLeft, scanTop, scanW, scanH);
                          const beforeMaskAudit = _auditPixels(beforeData);
                          console.log("[M7.7-042][BEFORE_MASK]", {
                            lineId: target.lineId,
                            bbox: { left: scanLeft, top: scanTop, width: scanW, height: scanH },
                            ...beforeMaskAudit,
                            note: "PDF canvas pixel data - mask is CSS overlay, does not affect canvas data",
                          });
                        } catch (e) {
                          console.error("[M7.7-042][BEFORE_MASK_ERROR]", { lineId: target.lineId, error: String(e) });
                        }
                        // AFTER_MASK: 等待下一帧让 React 渲染 mask
                        requestAnimationFrame(() => {
                          requestAnimationFrame(() => {
                            try {
                              const maskEl = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                              // M7.7-073 (edit-path): 此处 mask 已渲染，捕获真实屏幕 rect 与 replacement canvas 对比
                              if (maskEl) {
                                const mScreen73 = maskEl.getBoundingClientRect();
                                const repCanvas73 = document.getElementById(canvasId) as HTMLCanvasElement | null;
                                const rScreen73 = repCanvas73 ? repCanvas73.getBoundingClientRect() : null;
                                console.log("[M7.7-073][EDIT_MASK_SCREEN]", {
                                  lineId: target.lineId,
                                  maskLocalTop: Math.round(maskEl.offsetTop * 100) / 100,
                                  maskLocalHeight: Math.round(maskEl.offsetHeight * 100) / 100,
                                  maskScreen: { top: Math.round(mScreen73.top * 100) / 100, bottom: Math.round(mScreen73.bottom * 100) / 100, height: Math.round(mScreen73.height * 100) / 100 },
                                  repScreen: rScreen73 ? { top: Math.round(rScreen73.top * 100) / 100, bottom: Math.round(rScreen73.bottom * 100) / 100, height: Math.round(rScreen73.height * 100) / 100 } : null,
                                  deltaTop: rScreen73 ? Math.round((mScreen73.top - rScreen73.top) * 100) / 100 : null,
                                });
                              }
                              if (maskEl) {
                                // M7.7-051: Mask Ink Padding Test — 增加 mask top/bottom padding 消除残留
                                // M7.7-069: mask 扩展会覆盖相邻行，先恢复 0；残留问题用 replacement canvas 置顶 + 黑字覆盖解决
                                const maskPadding = 0; // 保持 mask 原始大小，避免覆盖上一行/下一行
                                const oldMaskTop = parseFloat(maskEl.style.top) || 0;
                                const oldMaskHeight = maskEl.offsetHeight || parseFloat(maskEl.style.height) || 0;
                                maskEl.style.top = `${oldMaskTop - maskPadding}px`;
                                maskEl.style.height = `${oldMaskHeight + maskPadding * 2}px`;
                                // M7.7-069: mask 调整后 React 可能把它排到 replacement canvas 前面，重新置顶 canvas 保证黑字可见
                                // M7.7-074: 重新置顶到 per-line host（而非直接挂 glyphLayer），保持 local 坐标关系
                                const repHostForTop = document.getElementById(`glyph-renderer-rep-${target.lineId}`) as HTMLElement | null;
                                const replaceCanvasForTop = document.getElementById(canvasId) as HTMLCanvasElement | null;
                                if (repHostForTop && replaceCanvasForTop) repHostForTop.appendChild(replaceCanvasForTop);
                                else if (replaceCanvasForTop) (document.querySelector('[data-layer="glyph"]') as HTMLElement | null)?.appendChild(replaceCanvasForTop);
                                // 扫描 mask 区域内的 PDF ink
                                const pdfCanvasForScan = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                let remainingPdfInkPixels = -1;
                                if (pdfCanvasForScan) {
                                  const pdfCR = pdfCanvasForScan.getBoundingClientRect();
                                  const maskCR = maskEl.getBoundingClientRect();
                                  const scanLeft = Math.max(0, Math.round((maskCR.left - pdfCR.left) * (pdfCanvasForScan.width / pdfCR.width)));
                                  const scanTop = Math.max(0, Math.round((maskCR.top - pdfCR.top) * (pdfCanvasForScan.height / pdfCR.height)));
                                  const scanW = Math.min(pdfCanvasForScan.width - scanLeft, Math.round(maskCR.width * (pdfCanvasForScan.width / pdfCR.width)));
                                  const scanH = Math.min(pdfCanvasForScan.height - scanTop, Math.round(maskCR.height * (pdfCanvasForScan.height / pdfCR.height)));
                                  if (scanW > 0 && scanH > 0) {
                                    const pdfCtx = pdfCanvasForScan.getContext("2d");
                                    if (pdfCtx) {
                                      const imgData = pdfCtx.getImageData(scanLeft, scanTop, scanW, scanH);
                                      remainingPdfInkPixels = 0;
                                      for (let i = 0; i < imgData.data.length; i += 4) {
                                        const r = imgData.data[i], g = imgData.data[i+1], b = imgData.data[i+2], a = imgData.data[i+3];
                                        if (a > 10 && (r < 250 || g < 250 || b < 250)) remainingPdfInkPixels++;
                                      }
                                    }
                                  }
                                }
                                console.log("[M7.7-051][MASK_PADDING_RESULT]", {
                                  lineId: target.lineId,
                                  padding: maskPadding,
                                  maskRect: { top: Math.round((oldMaskTop - maskPadding) * 100) / 100, bottom: Math.round((oldMaskTop - maskPadding + oldMaskHeight + maskPadding * 2) * 100) / 100 },
                                  remainingPdfInkPixels,
                                  visualResult: remainingPdfInkPixels > 0 ? "⚠️ 仍有 PDF ink 未被 mask 覆盖" : "✅ mask 完全覆盖 PDF ink",
                                });
                                // M7.7-052: Verify Real Mask DOM
                                const maskSelectors = [
                                  `[data-line-id="${target.lineId}"][data-layer="mask"]`,
                                  `[data-layer="mask"]`,
                                  `[id*="mask"]`,
                                  `[class*="mask"]`,
                                ];
                                const maskElements = maskSelectors.map(sel => ({
                                  selector: sel,
                                  count: document.querySelectorAll(sel).length,
                                }));
                                const allMaskEls = document.querySelectorAll(`[data-layer="mask"]`);
                                const maskElDetails = Array.from(allMaskEls).map(el => {
                                  const cs = getComputedStyle(el);
                                  return {
                                    tag: el.tagName.toLowerCase(),
                                    id: el.id || null,
                                    class: el.className && typeof el.className === "string" ? el.className.trim().split(/\s+/).join(".") : null,
                                    rect: {
                                      left: Math.round(el.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(el.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(el.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(el.getBoundingClientRect().height * 100) / 100,
                                    },
                                    display: cs.display,
                                    opacity: cs.opacity,
                                    background: cs.backgroundColor,
                                    zIndex: cs.zIndex,
                                    lineId: el.getAttribute("data-line-id") || null,
                                  };
                                });
                                const maskCount = allMaskEls.length;
                                // Pipeline tracing
                                const editedLineBoxes = (window as any).__editedLineBoxes;
                                const editableDoc = (window as any).__editableDocument;
                                const lineInDoc = editableDoc ? editableDoc.pages.some((p: any) => p.blocks.some((b: any) => b.lines.some((l: any) => l.id === target.lineId))) : false;
                                const lineInEditedBoxes = editedLineBoxes ? editedLineBoxes.has(target.lineId) : false;
                                const editingLineId = (window as any).__editingLineId;
                                const isStillEditing = editingLineId === target.lineId;
                                console.log("[M7.7-052][MASK_DOM]", {
                                  lineId: target.lineId,
                                  count: maskCount,
                                  elements: maskElDetails,
                                  selectorResults: maskElements,
                                });
                                if (maskCount === 0) {
                                  console.log("[M7.7-052][MASK_PIPELINE]", {
                                    editedLineBoxExists: lineInEditedBoxes,
                                    lineInDocument: lineInDoc,
                                    rendererReceived: lineInEditedBoxes && lineInDoc,
                                    isStillEditing,
                                    maskCreated: false,
                                    note: isStillEditing ? "Line is still in editing mode, mask is skipped by renderer" : lineInEditedBoxes ? "editedLineBoxes has the line but mask not rendered — check isNativeCanvas/disableSigEnhance/glyph renderer props" : "editedLineBoxes does not contain the line — markLineEdited may not have been called",
                                  });
                                }
                                const maskStyle = getComputedStyle(maskEl);
                                const maskCR = maskEl.getBoundingClientRect();
                                // 检查 mask 的 computed style
                                const maskOpaque = maskStyle.opacity === "1" || maskStyle.opacity === "";
                                const maskZIndex = parseInt(maskStyle.zIndex) || 0;
                                const maskBg = maskStyle.backgroundColor;
                                // 再次扫描 PDF canvas（数据不变，但作为对照）
                                const afterData = pdfCtx.getImageData(scanLeft, scanTop, scanW, scanH);
                                const afterMaskPdfAudit = _auditPixels(afterData);
                                // 检查替换 canvas 的像素
                                const replaceCanvasEl = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                let repAudit = { totalPixels: 0, opaquePixels: 0, inkPixels: 0, blackPixels: 0 };
                                if (replaceCanvasEl) {
                                  const repCtx2 = replaceCanvasEl.getContext("2d");
                                  if (repCtx2) {
                                    const repData = repCtx2.getImageData(0, 0, replaceCanvasEl.width, replaceCanvasEl.height);
                                    repAudit = _auditPixels(repData);
                                  }
                                }
                                console.log("[M7.7-042][AFTER_MASK]", {
                                  lineId: target.lineId,
                                  mask: {
                                    visible: maskStyle.display !== "none",
                                    opacity: maskStyle.opacity,
                                    zIndex: maskZIndex,
                                    bgColor: maskBg,
                                    cssRect: {
                                      left: Math.round(maskCR.left * 100) / 100,
                                      top: Math.round(maskCR.top * 100) / 100,
                                      width: Math.round(maskCR.width * 100) / 100,
                                      height: Math.round(maskCR.height * 100) / 100,
                                    },
                                  },
                                  pdfCanvas: afterMaskPdfAudit,
                                  replacementCanvas: repAudit,
                                  conclusion: maskOpaque && maskZIndex >= 1
                                    ? "Mask is opaque and visible. If ghosting remains, source is replacement canvas (not PDF canvas)."
                                    : "Mask may be transparent or behind PDF canvas. Check z-index/opacity.",
                                });
                                // M7.7-043: Final Compositing Layer Audit
                                const _getDomPath = (el: Element | null): string => {
                                  if (!el) return "null";
                                  const parts: string[] = [];
                                  let current: Element | null = el;
                                  while (current && current !== document.body) {
                                    const tag = current.tagName.toLowerCase();
                                    const id = current.id ? `#${current.id}` : "";
                                    const cls = current.className && typeof current.className === "string" ? `.${current.className.trim().split(/\s+/).join(".")}` : "";
                                    parts.unshift(`${tag}${id}${cls}`);
                                    current = current.parentElement;
                                  }
                                  return parts.join(" > ") || "unknown";
                                };
                                const pdfCanvasLayer = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLElement | null;
                                const pdfCanvasStyle = pdfCanvasLayer ? getComputedStyle(pdfCanvasLayer) : null;
                                const maskRect = maskEl.getBoundingClientRect();
                                const centerX = maskRect.left + maskRect.width / 2;
                                const centerY = maskRect.top + maskRect.height / 2;
                                const hitEl = document.elementFromPoint(centerX, centerY);
                                const repCanvasEl = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLElement | null;
                                const repCanvasStyle = repCanvasEl ? getComputedStyle(repCanvasEl) : null;
                                const maskParent = maskEl.parentElement;
                                const repCanvasParent = repCanvasEl?.parentElement ?? null;
                                const pdfCanvasParent = pdfCanvasLayer?.parentElement ?? null;
                                console.log("[M7.7-043][COMPOSITE]", {
                                  lineId: target.lineId,
                                  pdfCanvas: {
                                    rect: pdfCanvasLayer ? {
                                      left: Math.round(pdfCanvasLayer.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(pdfCanvasLayer.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(pdfCanvasLayer.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(pdfCanvasLayer.getBoundingClientRect().height * 100) / 100,
                                    } : null,
                                    zIndex: pdfCanvasStyle?.zIndex ?? null,
                                    position: pdfCanvasStyle?.position ?? null,
                                    parent: _getDomPath(pdfCanvasParent),
                                  },
                                  mask: {
                                    rect: {
                                      left: Math.round(maskRect.left * 100) / 100,
                                      top: Math.round(maskRect.top * 100) / 100,
                                      width: Math.round(maskRect.width * 100) / 100,
                                      height: Math.round(maskRect.height * 100) / 100,
                                    },
                                    zIndex: maskStyle.zIndex,
                                    position: maskStyle.position,
                                    parent: _getDomPath(maskParent),
                                  },
                                  replacementCanvas: {
                                    rect: repCanvasEl ? {
                                      left: Math.round(repCanvasEl.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(repCanvasEl.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(repCanvasEl.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(repCanvasEl.getBoundingClientRect().height * 100) / 100,
                                    } : null,
                                    zIndex: repCanvasStyle?.zIndex ?? null,
                                    position: repCanvasStyle?.position ?? null,
                                    parent: _getDomPath(repCanvasParent),
                                  },
                                  hitTest: {
                                    centerPoint: { x: Math.round(centerX * 100) / 100, y: Math.round(centerY * 100) / 100 },
                                    element: hitEl ? `${hitEl.tagName.toLowerCase()}${hitEl.id ? `#${hitEl.id}` : ""}${hitEl.className && typeof hitEl.className === "string" ? `.${hitEl.className.trim().split(/\s+/).join(".")}` : ""}` : "null",
                                    elementPath: _getDomPath(hitEl),
                                  },
                                  domPaths: {
                                    mask: _getDomPath(maskEl),
                                    replacementCanvas: _getDomPath(repCanvasEl),
                                    pdfCanvas: _getDomPath(pdfCanvasLayer),
                                  },
                                });
                                // M7.7-044: Replacement Canvas Duplication Audit
                                const allReplaceCanvases = document.querySelectorAll('canvas[id^="canvas-replace"]');
                                const canvasList = Array.from(allReplaceCanvases).map(c => {
                                  const cs = getComputedStyle(c);
                                  return {
                                    id: c.id,
                                    rect: {
                                      left: Math.round(c.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(c.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(c.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(c.getBoundingClientRect().height * 100) / 100,
                                    },
                                    zIndex: cs.zIndex,
                                    opacity: cs.opacity,
                                    visibility: cs.visibility,
                                    parentPath: _getDomPath(c.parentElement),
                                  };
                                });
                                const lineIdElements = document.querySelectorAll(`[data-line-id="${target.lineId}"]`);
                                const lineIdElList = Array.from(lineIdElements).map(el => {
                                  const cs = getComputedStyle(el);
                                  return {
                                    tag: el.tagName.toLowerCase(),
                                    class: el.className && typeof el.className === "string" ? el.className.trim().split(/\s+/).join(".") : "",
                                    rect: {
                                      left: Math.round(el.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(el.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(el.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(el.getBoundingClientRect().height * 100) / 100,
                                    },
                                    zIndex: cs.zIndex,
                                    display: cs.display,
                                    opacity: cs.opacity,
                                  };
                                });
                                console.log("[M7.7-044][REPLACEMENT_CANVAS_LIST]", {
                                  lineId: target.lineId,
                                  count: allReplaceCanvases.length,
                                  canvases: canvasList,
                                });
                                console.log("[M7.7-044][LINE_ID_ELEMENTS]", {
                                  lineId: target.lineId,
                                  count: lineIdElements.length,
                                  elements: lineIdElList,
                                });
                                // M7.7-045: Adjacent Line Render Audit
                                const neighborLineIds = [target.lineId.replace("l17", "l16"), target.lineId, target.lineId.replace("l17", "l18")];
                                const neighborLines = neighborLineIds.map(lid => {
                                  const maskEl2 = document.querySelector(`[data-line-id="${lid}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvas2 = document.querySelector(`canvas#canvas-replace-${lid}`) as HTMLCanvasElement | null;
                                  const maskStyle2 = maskEl2 ? getComputedStyle(maskEl2) : null;
                                  const repCanvasStyle2 = repCanvas2 ? getComputedStyle(repCanvas2) : null;
                                  return {
                                    lineId: lid,
                                    edited: lid === target.lineId,
                                    hasMask: !!maskEl2,
                                    hasReplacementCanvas: !!repCanvas2,
                                    canvasRect: repCanvas2 ? {
                                      left: Math.round(repCanvas2.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(repCanvas2.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(repCanvas2.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(repCanvas2.getBoundingClientRect().height * 100) / 100,
                                    } : null,
                                    maskRect: maskEl2 ? {
                                      left: Math.round(maskEl2.getBoundingClientRect().left * 100) / 100,
                                      top: Math.round(maskEl2.getBoundingClientRect().top * 100) / 100,
                                      width: Math.round(maskEl2.getBoundingClientRect().width * 100) / 100,
                                      height: Math.round(maskEl2.getBoundingClientRect().height * 100) / 100,
                                    } : null,
                                    maskZIndex: maskStyle2?.zIndex ?? null,
                                    repCanvasZIndex: repCanvasStyle2?.zIndex ?? null,
                                    maskDisplay: maskStyle2?.display ?? null,
                                    repCanvasDisplay: repCanvasStyle2?.display ?? null,
                                  };
                                });
                                // Pixel scan for l16 and l18
                                const neighborPixelScans: any[] = [];
                                const pdfCanvasNode2 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                if (pdfCanvasNode2) {
                                  const pdfCtx2 = pdfCanvasNode2.getContext("2d");
                                  const pdfCR2 = pdfCanvasNode2.getBoundingClientRect();
                                  const cssScaleX2 = pdfCanvasNode2.clientWidth > 0 ? pdfCanvasNode2.width / pdfCanvasNode2.clientWidth : 1;
                                  const cssScaleY2 = pdfCanvasNode2.clientHeight > 0 ? pdfCanvasNode2.height / pdfCanvasNode2.clientHeight : 1;
                                  neighborLineIds.forEach(lid => {
                                    const el = document.querySelector(`[data-line-id="${lid}"]`) as HTMLElement | null;
                                    if (el && pdfCtx2) {
                                      const elCR = el.getBoundingClientRect();
                                      const scanLeft2 = Math.round((elCR.left - pdfCR2.left) * cssScaleX2);
                                      const scanTop2 = Math.round((elCR.top - pdfCR2.top) * cssScaleY2);
                                      const scanW2 = Math.round(elCR.width * cssScaleX2);
                                      const scanH2 = Math.round(elCR.height * cssScaleY2);
                                      if (scanW2 > 0 && scanH2 > 0) {
                                        try {
                                          const imgData = pdfCtx2.getImageData(scanLeft2, scanTop2, scanW2, scanH2);
                                          const audit = _auditPixels(imgData);
                                          neighborPixelScans.push({
                                            lineId: lid,
                                            screenRect: { left: scanLeft2, top: scanTop2, width: scanW2, height: scanH2 },
                                            ...audit,
                                          });
                                        } catch (e) {
                                          neighborPixelScans.push({ lineId: lid, error: String(e) });
                                        }
                                      }
                                    }
                                  });
                                }
                                console.log("[M7.7-045][LINE_NEIGHBOR_STATUS]", {
                                  targetLineId: target.lineId,
                                  lines: neighborLines,
                                  neighborPixelScans,
                                });
                                // M7.7-046: Mask Occlusion Pixel Audit
                                (function maskOcclusionAudit() {
                                  const pdfCanvasNode3 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                  const maskEl3 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvasEl3 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  if (!pdfCanvasNode3 || !maskEl3) {
                                    console.log("[M7.7-046][MASK_ONLY]", {
                                      lineId: target.lineId,
                                      error: "pdfCanvasNode or maskEl not found",
                                      hasPdfCanvas: !!pdfCanvasNode3,
                                      hasMask: !!maskEl3,
                                    });
                                    return;
                                  }
                                  const pdfCtx3 = pdfCanvasNode3.getContext("2d");
                                  const pdfCR3 = pdfCanvasNode3.getBoundingClientRect();
                                  const cssScaleX3 = pdfCanvasNode3.clientWidth > 0 ? pdfCanvasNode3.width / pdfCanvasNode3.clientWidth : 1;
                                  const cssScaleY3 = pdfCanvasNode3.clientHeight > 0 ? pdfCanvasNode3.height / pdfCanvasNode3.clientHeight : 1;
                                  const maskCR3 = maskEl3.getBoundingClientRect();
                                  const scanLeft3 = Math.round((maskCR3.left - pdfCR3.left) * cssScaleX3);
                                  const scanTop3 = Math.round((maskCR3.top - pdfCR3.top) * cssScaleY3);
                                  const scanW3 = Math.round(maskCR3.width * cssScaleX3);
                                  const scanH3 = Math.round(maskCR3.height * cssScaleY3);
                                  let canvasInkBefore = { totalPixels: 0, opaquePixels: 0, inkPixels: 0, blackPixels: 0 };
                                  if (pdfCtx3 && scanW3 > 0 && scanH3 > 0) {
                                    try {
                                      const beforeData = pdfCtx3.getImageData(scanLeft3, scanTop3, scanW3, scanH3);
                                      canvasInkBefore = _auditPixels(beforeData);
                                    } catch (e) {
                                      // ignore
                                    }
                                  }
                                  // Hide replacement canvas temporarily
                                  const origDisplay = repCanvasEl3?.style.display ?? "";
                                  if (repCanvasEl3) {
                                    repCanvasEl3.style.display = "none";
                                  }
                                  // Wait a frame for browser to re-render, then check with elementFromPoint
                                  requestAnimationFrame(() => {
                                    // elementFromPoint grid scan within mask area
                                    const maskRect = maskEl3.getBoundingClientRect();
                                    const hitTestPoints: { x: number; y: number; hitTag: string; hitId: string; hitClass: string }[] = [];
                                    const steps = 5;
                                    for (let row = 0; row < steps; row++) {
                                      for (let col = 0; col < steps; col++) {
                                        const px = maskRect.left + (maskRect.width * (col + 0.5)) / steps;
                                        const py = maskRect.top + (maskRect.height * (row + 0.5)) / steps;
                                        const hit = document.elementFromPoint(px, py);
                                        const tag = hit?.tagName?.toLowerCase() ?? "null";
                                        const id = hit?.id ?? "";
                                        const cls = hit?.className && typeof hit.className === "string" ? hit.className.trim().split(/\s+/).join(".") : "";
                                        hitTestPoints.push({ x: Math.round(px), y: Math.round(py), hitTag: tag, hitId: id, hitClass: cls });
                                      }
                                    }
                                    // Check if mask was hit
                                    const maskHits = hitTestPoints.filter(h => h.hitId === `mask-${target.lineId}` || h.hitClass.includes("mask"));
                                    const repCanvasHits = hitTestPoints.filter(h => h.hitId === `canvas-replace-${target.lineId}`);
                                    // Restore replacement canvas
                                    if (repCanvasEl3) {
                                      repCanvasEl3.style.display = origDisplay;
                                    }
                                    console.log("[M7.7-046][MASK_ONLY]", {
                                      lineId: target.lineId,
                                      canvasInkBefore,
                                      bbox: { left: scanLeft3, top: scanTop3, width: scanW3, height: scanH3 },
                                      mask: {
                                        rect: {
                                          left: Math.round(maskRect.left * 100) / 100,
                                          top: Math.round(maskRect.top * 100) / 100,
                                          width: Math.round(maskRect.width * 100) / 100,
                                          height: Math.round(maskRect.height * 100) / 100,
                                        },
                                        zIndex: getComputedStyle(maskEl3).zIndex,
                                        opacity: getComputedStyle(maskEl3).opacity,
                                        display: getComputedStyle(maskEl3).display,
                                      },
                                      hitTest: {
                                        gridSize: steps,
                                        totalPoints: steps * steps,
                                        maskHits: maskHits.length,
                                        repCanvasHits: repCanvasHits.length,
                                        samplePoints: hitTestPoints.slice(0, 9),
                                        conclusion: maskHits.length > 0
                                          ? `Mask covers ${maskHits.length}/${steps * steps} grid points. PDF canvas ink is occluded.`
                                          : "Mask not hit by elementFromPoint. PDF canvas may be visible through mask.",
                                      },
                                      remainingInkPixels: maskHits.length > 0 ? 0 : canvasInkBefore.inkPixels,
                                    });
                                  });
                                })();
                                // M7.7-055: Mask Dominance Test — 隐藏 replacement，仅 mask 显示
                                (function maskDominanceTest() {
                                  const pdfCanvas5 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                  const maskEl5 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvasEl5 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  if (!pdfCanvas5 || !maskEl5) return;
                                  const pdfCtx5 = pdfCanvas5.getContext("2d");
                                  if (!pdfCtx5) return;
                                  const pdfCR5 = pdfCanvas5.getBoundingClientRect();
                                  const cssScaleX5 = pdfCanvas5.clientWidth > 0 ? pdfCanvas5.width / pdfCanvas5.clientWidth : 1;
                                  const cssScaleY5 = pdfCanvas5.clientHeight > 0 ? pdfCanvas5.height / pdfCanvas5.clientHeight : 1;
                                  const maskCR5 = maskEl5.getBoundingClientRect();
                                  const scanLeft5 = Math.round((maskCR5.left - pdfCR5.left) * cssScaleX5);
                                  const scanTop5 = Math.round((maskCR5.top - pdfCR5.top) * cssScaleY5);
                                  const scanW5 = Math.round(maskCR5.width * cssScaleX5);
                                  const scanH5 = Math.round(maskCR5.height * cssScaleY5);
                                  // Hide replacement canvas temporarily
                                  const origDisplay5 = repCanvasEl5?.style.display ?? "";
                                  if (repCanvasEl5) repCanvasEl5.style.display = "none";
                                  requestAnimationFrame(() => {
                                    let remainingPixels = -1;
                                    let pdfInkVisible = false;
                                    if (scanW5 > 0 && scanH5 > 0) {
                                      try {
                                        const imgData = pdfCtx5.getImageData(scanLeft5, scanTop5, scanW5, scanH5);
                                        const audit = _auditPixels(imgData);
                                        remainingPixels = audit.inkPixels;
                                        pdfInkVisible = audit.inkPixels > 0;
                                      } catch (e) {
                                        // ignore
                                      }
                                    }
                                    // Restore
                                    if (repCanvasEl5) repCanvasEl5.style.display = origDisplay5;
                                    console.log("[M7.7-055][MASK_ONLY_RESULT]", {
                                      lineId: target.lineId,
                                      replacementVisible: false,
                                      maskVisible: true,
                                      pdfInkVisible,
                                      remainingPixels,
                                    });
                                  });
                                })();
                                // M7.7-056: Mask Pixel Mapping — mask screen rect → canvas bitmap coords
                                (function maskPixelMapping() {
                                  const pdfCanvas6 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                  const maskEl6 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  if (!pdfCanvas6 || !maskEl6) return;
                                  const maskCR6 = maskEl6.getBoundingClientRect();
                                  const pdfCR6 = pdfCanvas6.getBoundingClientRect();
                                  const cssScaleX6 = pdfCanvas6.clientWidth > 0 ? pdfCanvas6.width / pdfCanvas6.clientWidth : 1;
                                  const cssScaleY6 = pdfCanvas6.clientHeight > 0 ? pdfCanvas6.height / pdfCanvas6.clientHeight : 1;
                                  const canvasLocalMaskRect = {
                                    x: Math.round((maskCR6.left - pdfCR6.left) * cssScaleX6),
                                    y: Math.round((maskCR6.top - pdfCR6.top) * cssScaleY6),
                                    width: Math.round(maskCR6.width * cssScaleX6),
                                    height: Math.round(maskCR6.height * cssScaleY6),
                                  };
                                  // Compute model ink bbox from editable document
                                  let pdfInkBBox = { x: -1, y: -1, width: -1, height: -1 };
                                  const editableDoc6 = (window as any).__editableDocument;
                                  if (editableDoc6) {
                                    for (const pg of editableDoc6.pages) {
                                      for (const b of pg.blocks) {
                                        for (const line of b.lines) {
                                          if (line.id !== target.lineId) continue;
                                          if (line.glyphs.length > 0) {
                                            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                                            for (const g of line.glyphs) {
                                              if (g.bbox.x < minX) minX = g.bbox.x;
                                              if (g.bbox.y < minY) minY = g.bbox.y;
                                              if (g.bbox.x + g.bbox.width > maxX) maxX = g.bbox.x + g.bbox.width;
                                              if (g.bbox.y + g.bbox.height > maxY) maxY = g.bbox.y + g.bbox.height;
                                            }
                                            pdfInkBBox = { x: Math.round(minX), y: Math.round(minY), width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
                                          }
                                          break;
                                        }
                                      }
                                    }
                                  }
                                  // Convert model ink bbox to canvas bitmap coords
                                  const inkCanvasLocal = {
                                    x: Math.round((pdfInkBBox.x) / cssScaleX6),
                                    y: Math.round((pdfInkBBox.y) / cssScaleY6),
                                    width: Math.round(pdfInkBBox.width / cssScaleX6),
                                    height: Math.round(pdfInkBBox.height / cssScaleY6),
                                  };
                                  // Compute overlap between mask rect and ink rect in canvas coords
                                  const overlapX = Math.max(0, Math.min(canvasLocalMaskRect.x + canvasLocalMaskRect.width, inkCanvasLocal.x + inkCanvasLocal.width) - Math.max(canvasLocalMaskRect.x, inkCanvasLocal.x));
                                  const overlapY = Math.max(0, Math.min(canvasLocalMaskRect.y + canvasLocalMaskRect.height, inkCanvasLocal.y + inkCanvasLocal.height) - Math.max(canvasLocalMaskRect.y, inkCanvasLocal.y));
                                  const overlapArea = overlapX * overlapY;
                                  const inkArea = inkCanvasLocal.width * inkCanvasLocal.height;
                                  const percent = inkArea > 0 ? Math.round((overlapArea / inkArea) * 10000) / 100 : 0;
                                  console.log("[M7.7-056][MASK_MAPPING]", {
                                    lineId: target.lineId,
                                    canvasRect: {
                                      left: Math.round(pdfCR6.left * 100) / 100,
                                      top: Math.round(pdfCR6.top * 100) / 100,
                                      width: Math.round(pdfCR6.width * 100) / 100,
                                      height: Math.round(pdfCR6.height * 100) / 100,
                                      bitmapWidth: pdfCanvas6.width,
                                      bitmapHeight: pdfCanvas6.height,
                                    },
                                    maskRect: {
                                      left: Math.round(maskCR6.left * 100) / 100,
                                      top: Math.round(maskCR6.top * 100) / 100,
                                      width: Math.round(maskCR6.width * 100) / 100,
                                      height: Math.round(maskCR6.height * 100) / 100,
                                    },
                                    canvasLocalMaskRect,
                                    pdfInkBBox,
                                    overlap: { percent },
                                  });
                                })();
                                // M7.7-060: Mask Pixel Verify — 隐藏 replacement，扫描 mask 区域是否仍有可见 ink
                                (function maskPixelVerify() {
                                  const pdfCanvas10 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                  const maskEl10 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvas10 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  if (!pdfCanvas10 || !maskEl10) return;
                                  const pdfCtx10 = pdfCanvas10.getContext("2d");
                                  if (!pdfCtx10) return;
                                  const pdfCR10 = pdfCanvas10.getBoundingClientRect();
                                  const cssScaleX10 = pdfCanvas10.clientWidth > 0 ? pdfCanvas10.width / pdfCanvas10.clientWidth : 1;
                                  const cssScaleY10 = pdfCanvas10.clientHeight > 0 ? pdfCanvas10.height / pdfCanvas10.clientHeight : 1;
                                  const maskCR10 = maskEl10.getBoundingClientRect();
                                  const scanLeft10 = Math.max(0, Math.round((maskCR10.left - pdfCR10.left) * cssScaleX10));
                                  const scanTop10 = Math.max(0, Math.round((maskCR10.top - pdfCR10.top) * cssScaleY10));
                                  const scanW10 = Math.min(pdfCanvas10.width - scanLeft10, Math.round(maskCR10.width * cssScaleX10));
                                  const scanH10 = Math.min(pdfCanvas10.height - scanTop10, Math.round(maskCR10.height * cssScaleY10));
                                  // Hide replacement canvas
                                  const origDisplay10 = repCanvas10?.style.display ?? "";
                                  if (repCanvas10) repCanvas10.style.display = "none";
                                  requestAnimationFrame(() => {
                                    let pdfInkPixelsBefore = -1;
                                    let afterMaskVisiblePixels = 0;
                                    let uncoveredBBox: { x: number; y: number; width: number; height: number } | null = null;
                                    if (scanW10 > 0 && scanH10 > 0) {
                                      try {
                                        const imgData = pdfCtx10.getImageData(scanLeft10, scanTop10, scanW10, scanH10);
                                        const data = imgData.data;
                                        // Count all ink pixels (before mask — "content" of PDF canvas)
                                        pdfInkPixelsBefore = 0;
                                        for (let i = 0; i < data.length; i += 4) {
                                          const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
                                          if (a > 10 && (r < 250 || g < 250 || b < 250)) pdfInkPixelsBefore++;
                                        }
                                        // Find uncovered pixels: non-white non-transparent pixels still visible through mask
                                        let minUx = scanW10, minUy = scanH10, maxUx = 0, maxUy = 0;
                                        for (let row = 0; row < scanH10; row++) {
                                          for (let col = 0; col < scanW10; col++) {
                                            const px = (row * scanW10 + col) * 4;
                                            const r = data[px], g = data[px+1], b = data[px+2], a = data[px+3];
                                            // Uncovered = opaque + non-white (ink pixel not masked by white div)
                                            if (a > 10 && (r < 250 || g < 250 || b < 250)) {
                                              afterMaskVisiblePixels++;
                                              if (col < minUx) minUx = col;
                                              if (row < minUy) minUy = row;
                                              if (col > maxUx) maxUx = col;
                                              if (row > maxUy) maxUy = row;
                                            }
                                          }
                                        }
                                        if (afterMaskVisiblePixels > 0) {
                                          uncoveredBBox = {
                                            x: Math.round((scanLeft10 + minUx) * 100 / cssScaleX10) / 100,
                                            y: Math.round((scanTop10 + minUy) * 100 / cssScaleY10) / 100,
                                            width: Math.round((maxUx - minUx + 1) * 100 / cssScaleX10) / 100,
                                            height: Math.round((maxUy - minUy + 1) * 100 / cssScaleY10) / 100,
                                          };
                                        }
                                      } catch (e) {
                                        // ignore
                                      }
                                    }
                                    // Restore
                                    if (repCanvas10) repCanvas10.style.display = origDisplay10;
                                    console.log("[M7.7-060][MASK_PIXEL_VERIFY]", {
                                      lineId: target.lineId,
                                      pdfInkPixelsBefore,
                                      afterMaskVisiblePixels,
                                      uncoveredPixels: afterMaskVisiblePixels,
                                      uncoveredBBox,
                                    });
                                  });
                                })();
                                // M7.7-062: Composite Pixel Verify — 用 elementFromPoint 密集网格模拟合成截图验证 mask 覆盖
                                (function compositePixelVerify() {
                                  const maskEl12 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvas12 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  if (!maskEl12) return;
                                  const maskCR12 = maskEl12.getBoundingClientRect();
                                  // Hide replacement canvas
                                  const origDisplay12 = repCanvas12?.style.display ?? "";
                                  if (repCanvas12) repCanvas12.style.display = "none";
                                  // Temporarily enable pointer events on mask so elementFromPoint can detect it
                                  const origPointerEvents12 = maskEl12.style.pointerEvents;
                                  maskEl12.style.pointerEvents = "auto";
                                  requestAnimationFrame(() => {
                                    // Scan with elementFromPoint at step=2px for pixel-level coverage
                                    const step = 2;
                                    const cols = Math.floor(maskCR12.width / step);
                                    const rows = Math.floor(maskCR12.height / step);
                                    let coveredCount = 0;
                                    let whiteCount = 0;
                                    let remainingDarkCount = 0;
                                    let minUx = cols, minUy = rows, maxUx = 0, maxUy = 0;
                                    for (let row = 0; row < rows; row++) {
                                      for (let col = 0; col < cols; col++) {
                                        const px = maskCR12.left + (col + 0.5) * step;
                                        const py = maskCR12.top + (row + 0.5) * step;
                                        const hit = document.elementFromPoint(px, py);
                                        if (!hit) continue;
                                        // Check if the hit element is the mask or a descendant of mask
                                        let isMask = false;
                                        let el: Element | null = hit;
                                        while (el) {
                                          if (el === maskEl12 || (el.getAttribute && el.getAttribute("data-line-id") === target.lineId && el.getAttribute("data-layer") === "mask")) {
                                            isMask = true;
                                            break;
                                          }
                                          el = el.parentElement;
                                        }
                                        if (isMask) {
                                          // Mask is on top — pixel is white (covered)
                                          whiteCount++;
                                          coveredCount++;
                                        } else {
                                          // Something else is on top — likely PDF canvas ink
                                          remainingDarkCount++;
                                          if (col < minUx) minUx = col;
                                          if (row < minUy) minUy = row;
                                          if (col > maxUx) maxUx = col;
                                          if (row > maxUy) maxUy = row;
                                        }
                                      }
                                    }
                                    const totalPoints = cols * rows;
                                    const beforeCompositeInkPixels = totalPoints; // Total points = "ink area" in composite
                                    const afterMaskCompositePixels = coveredCount;
                                    let uncoveredBBox = null;
                                    if (remainingDarkCount > 0) {
                                      uncoveredBBox = {
                                        left: Math.round((maskCR12.left + minUx * step) * 100) / 100,
                                        top: Math.round((maskCR12.top + minUy * step) * 100) / 100,
                                        width: Math.round(((maxUx - minUx + 1) * step) * 100) / 100,
                                        height: Math.round(((maxUy - minUy + 1) * step) * 100) / 100,
                                      };
                                    }
                                    console.log("[M7.7-062][COMPOSITE_PIXEL_VERIFY]", {
                                      lineId: target.lineId,
                                      screenRect: {
                                        left: Math.round(maskCR12.left * 100) / 100,
                                        top: Math.round(maskCR12.top * 100) / 100,
                                        width: Math.round(maskCR12.width * 100) / 100,
                                        height: Math.round(maskCR12.height * 100) / 100,
                                      },
                                      beforeCompositeInkPixels,
                                      afterMaskCompositePixels: whiteCount,
                                      whitePixels: whiteCount,
                                      remainingDarkPixels: remainingDarkCount,
                                      uncoveredBBox,
                                    });
                                    // Restore
                                    maskEl12.style.pointerEvents = origPointerEvents12;
                                    if (repCanvas12) repCanvas12.style.display = origDisplay12;
                                  });
                                })();
                                // M7.7-063: Visible Residual Scan — 用 elementFromPoint 密集网格查找 mask 外的 PDF residual 屏幕坐标
                                (function visibleResidualScan() {
                                  const maskEl13 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvas13 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  if (!maskEl13) return;
                                  const maskCR13 = maskEl13.getBoundingClientRect();
                                  // 扩展扫描区域：上下各 +10px
                                  const expandPx = 10;
                                  const scanRect = {
                                    left: maskCR13.left,
                                    top: maskCR13.top - expandPx,
                                    width: maskCR13.width,
                                    height: maskCR13.height + expandPx * 2,
                                  };
                                  // 隐藏 replacement canvas
                                  const origDisplay13 = repCanvas13?.style.display ?? "";
                                  if (repCanvas13) repCanvas13.style.display = "none";
                                  // 临时启用 mask pointer events
                                  const origPE13 = maskEl13.style.pointerEvents;
                                  maskEl13.style.pointerEvents = "auto";
                                  requestAnimationFrame(() => {
                                    const step = 2;
                                    const cols = Math.floor(scanRect.width / step);
                                    const rows = Math.floor(scanRect.height / step);
                                    let darkPixels = 0;
                                    let minUx = cols, minUy = rows, maxUx = 0, maxUy = 0;
                                    for (let row = 0; row < rows; row++) {
                                      for (let col = 0; col < cols; col++) {
                                        const px = scanRect.left + (col + 0.5) * step;
                                        const py = scanRect.top + (row + 0.5) * step;
                                        const hit = document.elementFromPoint(px, py);
                                        if (!hit) continue;
                                        // Check if mask is on top
                                        let isMask = false;
                                        let el: Element | null = hit;
                                        while (el) {
                                          if (el === maskEl13 || (el.getAttribute && el.getAttribute("data-line-id") === target.lineId && el.getAttribute("data-layer") === "mask")) {
                                            isMask = true;
                                            break;
                                          }
                                          el = el.parentElement;
                                        }
                                        if (!isMask) {
                                          darkPixels++;
                                          if (col < minUx) minUx = col;
                                          if (row < minUy) minUy = row;
                                          if (col > maxUx) maxUx = col;
                                          if (row > maxUy) maxUy = row;
                                        }
                                      }
                                    }
                                    // Compute pixel bbox in screen coordinates
                                    let darkPixelBBox = null;
                                    let residualTop = null, residualBottom = null;
                                    if (darkPixels > 0) {
                                      const bboxLeft = Math.round((scanRect.left + minUx * step) * 100) / 100;
                                      const bboxTop = Math.round((scanRect.top + minUy * step) * 100) / 100;
                                      const bboxRight = Math.round((scanRect.left + (maxUx + 1) * step) * 100) / 100;
                                      const bboxBottom = Math.round((scanRect.top + (maxUy + 1) * step) * 100) / 100;
                                      darkPixelBBox = {
                                        left: bboxLeft,
                                        top: bboxTop,
                                        width: Math.round((bboxRight - bboxLeft) * 100) / 100,
                                        height: Math.round((bboxBottom - bboxTop) * 100) / 100,
                                      };
                                      residualTop = Math.round((bboxTop - maskCR13.top) * 100) / 100;
                                      residualBottom = Math.round((bboxBottom - (maskCR13.top + maskCR13.height)) * 100) / 100;
                                    }
                                    console.log("[M7.7-063][VISIBLE_RESIDUAL_SCAN]", {
                                      lineId: target.lineId,
                                      maskRect: { top: Math.round(maskCR13.top * 100) / 100, bottom: Math.round((maskCR13.top + maskCR13.height) * 100) / 100, left: Math.round(maskCR13.left * 100) / 100, width: Math.round(maskCR13.width * 100) / 100, height: Math.round(maskCR13.height * 100) / 100 },
                                      compositeScanRect: { top: Math.round(scanRect.top * 100) / 100, width: Math.round(scanRect.width * 100) / 100, height: Math.round(scanRect.height * 100) / 100 },
                                      darkPixels,
                                      darkPixelBBox,
                                      residualTop,
                                      residualBottom,
                                    });
                                    // Restore
                                    maskEl13.style.pointerEvents = origPE13;
                                    if (repCanvas13) repCanvas13.style.display = origDisplay13;
                                  });
                                })();
                                // M7.7-064: Mask Internal Scan — 仅扫描 maskRect 范围内未被 mask 覆盖的 ink 像素
                                (function maskInternalScan() {
                                  const maskEl14 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  const repCanvas14 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  if (!maskEl14) return;
                                  const maskCR14 = maskEl14.getBoundingClientRect();
                                  const origDisp14 = repCanvas14?.style.display ?? "";
                                  if (repCanvas14) repCanvas14.style.display = "none";
                                  const origPE14 = maskEl14.style.pointerEvents;
                                  maskEl14.style.pointerEvents = "auto";
                                  requestAnimationFrame(() => {
                                    const step = 2;
                                    const cols = Math.floor(maskCR14.width / step);
                                    const rows = Math.floor(maskCR14.height / step);
                                    let uncoveredInkPixels = 0;
                                    for (let row = 0; row < rows; row++) {
                                      for (let col = 0; col < cols; col++) {
                                        const px = maskCR14.left + (col + 0.5) * step;
                                        const py = maskCR14.top + (row + 0.5) * step;
                                        const hit = document.elementFromPoint(px, py);
                                        if (!hit) continue;
                                        let isMask = false;
                                        let el: Element | null = hit;
                                        while (el) {
                                          if (el === maskEl14 || (el.getAttribute && el.getAttribute("data-line-id") === target.lineId && el.getAttribute("data-layer") === "mask")) {
                                            isMask = true;
                                            break;
                                          }
                                          el = el.parentElement;
                                        }
                                        if (!isMask) uncoveredInkPixels++;
                                      }
                                    }
                                    console.log("[M7.7-064][MASK_INTERNAL_SCAN]", {
                                      lineId: target.lineId,
                                      maskRect: { top: Math.round(maskCR14.top * 100) / 100, left: Math.round(maskCR14.left * 100) / 100, width: Math.round(maskCR14.width * 100) / 100, height: Math.round(maskCR14.height * 100) / 100 },
                                      scanPoints: cols * rows,
                                      uncoveredInkPixels,
                                    });
                                    maskEl14.style.pointerEvents = origPE14;
                                    if (repCanvas14) repCanvas14.style.display = origDisp14;
                                  });
                                })();
                                // M7.7-047: Mask Top Alignment Fix
                                (function maskAlignmentAudit() {
                                  const pdfCanvasNode4 = document.querySelector('[data-layer="pdf-canvas"] canvas') as HTMLCanvasElement | null;
                                  const maskEl4 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  if (!pdfCanvasNode4 || !maskEl4) return;
                                  const pdfCtx4 = pdfCanvasNode4.getContext("2d");
                                  const pdfCR4 = pdfCanvasNode4.getBoundingClientRect();
                                  const cssScaleX4 = pdfCanvasNode4.clientWidth > 0 ? pdfCanvasNode4.width / pdfCanvasNode4.clientWidth : 1;
                                  const cssScaleY4 = pdfCanvasNode4.clientHeight > 0 ? pdfCanvasNode4.height / pdfCanvasNode4.clientHeight : 1;
                                  const maskCR4 = maskEl4.getBoundingClientRect();
                                  const scanLeft4 = Math.round((maskCR4.left - pdfCR4.left) * cssScaleX4);
                                  const scanTop4 = Math.round((maskCR4.top - pdfCR4.top) * cssScaleY4);
                                  const scanW4 = Math.round(maskCR4.width * cssScaleX4);
                                  const scanH4 = Math.round(maskCR4.height * cssScaleY4);
                                  if (!pdfCtx4 || scanW4 <= 0 || scanH4 <= 0) return;
                                  let inkTop = -1;
                                  let inkBottom = -1;
                                  try {
                                    const imgData = pdfCtx4.getImageData(scanLeft4, scanTop4, scanW4, scanH4);
                                    // Scan rows to find first/last with ink
                                    for (let row = 0; row < scanH4; row++) {
                                      for (let col = 0; col < scanW4; col++) {
                                        const idx = (row * scanW4 + col) * 4;
                                        const alpha = imgData.data[idx + 3];
                                        const r = imgData.data[idx];
                                        const g = imgData.data[idx + 1];
                                        const b = imgData.data[idx + 2];
                                        if (alpha > 10 && (r < 80 || g < 80 || b < 80)) {
                                          if (inkTop === -1) inkTop = row;
                                          inkBottom = row;
                                          break;
                                        }
                                      }
                                    }
                                  } catch (e) { /* ignore */ }
                                  const canvasInkTop = inkTop >= 0 ? scanTop4 + inkTop : -1;
                                  const canvasInkBottom = inkBottom >= 0 ? scanTop4 + inkBottom : -1;
                                  const maskTop = Math.round(maskCR4.top * 100) / 100;
                                  const maskBottom = Math.round(maskCR4.bottom * 100) / 100;
                                  const maskTopMinusInkTop = inkTop >= 0 ? Math.round((maskCR4.top - (scanTop4 + inkTop)) * 100) / 100 : null;
                                  const maskBottomMinusInkBottom = inkBottom >= 0 ? Math.round((maskCR4.bottom - (scanTop4 + inkBottom)) * 100) / 100 : null;
                                  // Get model bbox from afterLine
                                  const modelBBox = afterLine && afterLine.glyphs.length > 0 ? {
                                    y: Math.round(afterLine.glyphs[0].bbox.y * 100) / 100,
                                    height: Math.round((afterLine.glyphs[0].bbox.y + afterLine.glyphs[0].bbox.height) * 100) / 100,
                                  } : null;
                                  const needsTopCompensation = inkTop >= 0 && maskCR4.top > (scanTop4 + inkTop);
                                  const needsBottomCompensation = inkBottom >= 0 && maskCR4.bottom < (scanTop4 + inkBottom);
                                  console.log("[M7.7-047][MASK_ALIGNMENT]", {
                                    lineId: target.lineId,
                                    modelBBox,
                                    maskRect: {
                                      top: maskTop,
                                      bottom: maskBottom,
                                      height: Math.round(maskCR4.height * 100) / 100,
                                    },
                                    canvasInk: {
                                      top: Math.round(canvasInkTop * 100) / 100,
                                      bottom: Math.round(canvasInkBottom * 100) / 100,
                                      scanRect: { left: scanLeft4, top: scanTop4, width: scanW4, height: scanH4 },
                                    },
                                    diff: {
                                      maskTopMinusInkTop,
                                      maskBottomMinusInkBottom,
                                    },
                                    coverage: {
                                      topOk: inkTop < 0 || maskCR4.top <= (scanTop4 + inkTop),
                                      bottomOk: inkBottom < 0 || maskCR4.bottom >= (scanTop4 + inkBottom),
                                    },
                                    needsFix: {
                                      topCompensation: needsTopCompensation,
                                      bottomCompensation: needsBottomCompensation,
                                      topDelta: needsTopCompensation ? Math.round((maskCR4.top - (scanTop4 + inkTop)) * 100) / 100 : 0,
                                      bottomDelta: needsBottomCompensation ? Math.round(((scanTop4 + inkBottom) - maskCR4.bottom) * 100) / 100 : 0,
                                    },
                                  });
                                })();
                                // M7.7-048: Replacement Canvas Isolation
                                requestAnimationFrame(() => {
                                  const repCanvasEl4 = document.getElementById(`canvas-replace-${target.lineId}`) as HTMLCanvasElement | null;
                                  const maskEl5 = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                  if (!repCanvasEl4) return;
                                  // 在 hide 前捕获 rect（M7.7-046 的 rAF 已恢复 canvas）
                                  const beforeHideRect = repCanvasEl4.getBoundingClientRect();
                                  console.log("[M7.7-048][BEFORE_HIDE_RECT]", {
                                    lineId: target.lineId,
                                    rect: {
                                      left: Math.round(beforeHideRect.left * 100) / 100,
                                      top: Math.round(beforeHideRect.top * 100) / 100,
                                      width: Math.round(beforeHideRect.width * 100) / 100,
                                      height: Math.round(beforeHideRect.height * 100) / 100,
                                    },
                                    canvasLocal: { width: repCanvasEl4.width, height: repCanvasEl4.height },
                                  });
                                  const maskCR5 = maskEl5 ? maskEl5.getBoundingClientRect() : null;
                                  const firstLineGlyph = afterLine?.glyphs[0];
                                  const lastLineGlyph = afterLine?.glyphs[afterLine.glyphs.length - 1];
                                  console.log("[M7.7-048][REPLACEMENT_RECT]", {
                                    lineId: target.lineId,
                                    canvasScreenRect: {
                                      left: Math.round(beforeHideRect.left * 100) / 100,
                                      top: Math.round(beforeHideRect.top * 100) / 100,
                                      width: Math.round(beforeHideRect.width * 100) / 100,
                                      height: Math.round(beforeHideRect.height * 100) / 100,
                                    },
                                    canvasLocalRect: {
                                      width: repCanvasEl4.width,
                                      height: repCanvasEl4.height,
                                    },
                                    maskScreenRect: maskCR5 ? {
                                      left: Math.round(maskCR5.left * 100) / 100,
                                      top: Math.round(maskCR5.top * 100) / 100,
                                      width: Math.round(maskCR5.width * 100) / 100,
                                      height: Math.round(maskCR5.height * 100) / 100,
                                    } : null,
                                    baselineLocal: firstLineGlyph ? Math.round((firstLineGlyph.baseline ?? 0) * 100) / 100 : null,
                                    firstGlyphY: firstLineGlyph ? Math.round(firstLineGlyph.bbox.y * 100) / 100 : null,
                                    lastGlyphY: lastLineGlyph ? Math.round(lastLineGlyph.bbox.y * 100) / 100 : null,
                                  });
                                  // Step 1: Hide replacement canvas
                                  const allRepCanvases = document.querySelectorAll('canvas[id^="canvas-replace"]');
                                  allRepCanvases.forEach(el => (el as HTMLElement).style.display = "none");
                                  console.log("[M7.7-048][STEP1]", { lineId: target.lineId, action: "HIDDEN", canvasesHidden: allRepCanvases.length, note: "Observe if ghosting disappeared" });
                                  // Step 2 (after 2s): Show only replacement canvas
                                  const step2Timer = setTimeout(() => {
                                    allRepCanvases.forEach(el => (el as HTMLElement).style.display = "");
                                    const pdfCanvasLayer = document.querySelector('[data-layer="pdf-canvas"]') as HTMLElement | null;
                                    const maskLayer = document.querySelector(`[data-line-id="${target.lineId}"][data-layer="mask"]`) as HTMLElement | null;
                                    if (pdfCanvasLayer) pdfCanvasLayer.style.visibility = "hidden";
                                    if (maskLayer) maskLayer.style.display = "none";
                                    console.log("[M7.7-048][STEP2]", { lineId: target.lineId, action: "REPLACEMENT_ONLY", note: "Observe if replacement text looks correct" });
                                    // Restore all after 2 more seconds
                                    const restoreTimer = setTimeout(() => {
                                      allRepCanvases.forEach(el => (el as HTMLElement).style.display = "");
                                      if (pdfCanvasLayer) pdfCanvasLayer.style.visibility = "";
                                      if (maskLayer) maskLayer.style.display = "";
                                      console.log("[M7.7-048][RESTORE]", { lineId: target.lineId, action: "RESTORED" });
                                    }, 2000);
                                  }, 2000);
                                });
                              } else {
                                console.log("[M7.7-038][AFTER_MASK]", {
                                  lineId: target.lineId,
                                  error: "mask element not found",
                                });
                              }
                            } catch (e) {
                              console.error("[M7.7-042][AFTER_MASK_ERROR]", { lineId: target.lineId, error: String(e) });
                            }
                          });
                        });
                      }
                    }
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
          }}
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
          onSegmentCommit={(segmentId) => {
            // M7.8-022 Phase A: segment 编辑提交 → 进入统一 mask 路径
            // （markLineEdited → canvas ink scan → editedLineBoxes）。
            // 身份映射用 Segment 自带的 PDF 坐标 pdfX/pdfY（稳定、不受重复文本影响），
            // 而非 originalText 匹配。此处 canvas 尚未被 replacement 覆盖，
            // 故 ink scan 扫到的是原始墨迹。
            const seg = (segmentsRef?.current ?? []).find((s: any) => s.id === segmentId);
            const doc = editableDocumentRef.current;
            if (!seg || !doc || seg.pdfY === undefined) return;
            const ts = (doc.runtime?.renderScale ?? 1.5) * (doc.runtime?.cssScale ?? 1);
            const segPage = String(seg.lineId ?? "").split("_")[1];
            let hit: any = null;
            for (const pg of doc.pages) {
              if (segPage && String(pg.index) !== segPage) continue;
              for (const b of pg.blocks) {
                for (const l of b.lines) {
                  if (!l.glyphs?.length) continue;
                  // line 的 PDF y = (pageHeightCss - bbox.y) / totalScale
                  const d = Math.abs((pg.height - l.bbox.y) / ts - seg.pdfY);
                  if (d > 2) continue;
                  // x 必须落在该行范围内，排除跨行误命中
                  const x0 = l.bbox.x / ts;
                  const x1 = (l.bbox.x + l.bbox.width) / ts;
                  if (
                    seg.pdfX !== undefined &&
                    (seg.pdfX < x0 - 2 || seg.pdfX > x1 + 2)
                  ) {
                    continue;
                  }
                  if (!hit || d < hit.d) hit = { blockId: b.id, lineId: l.id, d };
                }
              }
            }
            if (hit) markLineEdited(hit.blockId, hit.lineId);
          }}
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
