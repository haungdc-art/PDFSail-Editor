/**
 * GlyphRenderer — Sprint 5 Task 3 + Sprint 6 升级
 *
 * Sprint 5：RenderCommand[] → DOM span[]
 * Sprint 6 升级：
 *   - 支持选中高亮（selectedGlyphIds）
 *   - 支持 click selection（onGlyphClick 返回命中信息）
 *   - 支持 drag selection（onGlyphSelect 返回选择矩形）
 *   - 支持编辑回调（onGlyphEdit 触发 Document Mutation）
 *
 * 每个 span：
 *   - char：单个字符
 *   - font：从 styleRef 解析的 fontFamily/fontSize/fontWeight/color
 *   - position：absolute 定位（left/top/width/height）
 *   - 选中状态：蓝色边框高亮
 *
 * 坐标系：Document Space（CSS 显示坐标，与 PDFCanvas Interaction Layer 一致）
 */

import React, { useMemo, useRef, useState, useCallback, useEffect } from "react";

// M7.7-009B-2a: 诊断——测量 pdfjsFontFamily vs fontFamily 的文本宽度差异
// 仅对每个唯一字体组合测量一次，避免重复日志
const _009B_measuredFonts = new Set<string>();
import type {
  RenderCommand,
  DrawGlyphCommand,
  DrawRectCommand,
} from "./render-command";
import type { EditableStyle, BBox } from "./types";
import type { ViewRenderingMode } from "./view-mode";
import { groupCommands } from "./render-command";
import { RenderLayer } from "./render-layer";
import {
  buildTextFlow,
  boundaryFromPoint,
  deriveSelection,
} from "./selection-engine";
import type { Boundary } from "./selection-engine";
import { SelectionController } from "./selection-controller";
import { eventPointToDocumentPoint } from "./coordinate-transform";

// M7.7-066: 编辑层统一垂直偏移（editor / mask / replacement 同步）
const EDIT_LAYER_Y_OFFSET = 8;

/** 选中信息 */
export interface GlyphClickInfo {
  /** 点击的 glyph 命令 */
  glyph: DrawGlyphCommand;
  /** glyph 在渲染列表中的索引 */
  index: number;
  /** 点击位置（Document Space） */
  screenX: number;
  screenY: number;
}

/** 拖拽选择信息 */
export interface GlyphSelectInfo {
  /** 选择矩形（Document Space） */
  rect: { x1: number; y1: number; x2: number; y2: number };
  /** 选中的 glyph 命令列表 */
  glyphs: DrawGlyphCommand[];
}

export interface GlyphRendererProps {
  /** 渲染命令列表 */
  commands: RenderCommand[];
  /** 文档级样式表（用于解析 styleRef） */
  styles: EditableStyle[];
  /** 是否可交互（点击编辑） */
  interactive?: boolean;
  /** 选中的 glyph ID 集合（高亮显示） */
  selectedGlyphIds?: Set<string>;
  /** 点击 glyph 回调（Task 2: click selection） */
  onGlyphClick?: (info: GlyphClickInfo) => void;
  /** 拖拽选择回调（Task 2: drag selection） */
  onGlyphSelect?: (info: GlyphSelectInfo) => void;
  /** 编辑回调（Task 3: 触发 Document Mutation） */
  onGlyphEdit?: (glyph: DrawGlyphCommand, newText: string) => void;
  /** Task-013A: Selection 变化回调（暴露当前 DerivedSelection，供外部消费）。
   *  selected 有字符 → 传 DerivedSelection；无选区（caret/清除）→ 传 null。
   *  只暴露已有的 DerivedSelection，不创建新类型，不接 Provider/Toolbar/Command。 */
  onSelectionChanged?: (derived: import("./selection-engine").DerivedSelection | null) => void;
  /** M7.7-003: 拖选结束（mouseup，真实拖拽位移 > 5px）一次性提交最终选区。
   *  与 onSelectionChanged（拖拽中连续上报）区分：仅 mouseup 触发一次，且不含简单点击，
   *  供外部直接进入 inline EditSession（替代 Workspace "Update Text" 旧路径）。 */
  onDragSelectCommit?: (derived: import("./selection-engine").DerivedSelection | null) => void;
  /** M7.7-005: 双击选词后一次性回调（word DerivedSelection）。
   *  与 onSelectionChanged（高亮上报）区分：仅 dblclick 触发一次，供外部直接进入
   *  inline EditSession（选中词，caret 在词尾），不弹 SelectionActionMenu。 */
  onGlyphDoubleClick?: (derived: import("./selection-engine").DerivedSelection | null) => void;
  /** Sprint 32: 正在编辑的 block ID（此 block 的 glyph 会透明度设为 0） */
  editingBlockId?: string | null;
  /** M7.7-004 (Bug1): 正在编辑的 line ID。编辑态 block 级 mask 会盖住同 block 其他行，
   *  需裁剪 mask 到编辑行的 bbox（文本编辑是行级，textarea 已覆盖编辑行；其他行应保持可见）。 */
  editingLineId?: string | null;
  /** M7.7-004C: 编辑行真实文本覆盖盒（PDFEditor 扫描 canvas 后扩展的行级 bbox）。
   *  OCR glyph 墨迹盒比 pdf.js 实际渲染的文字窄（original.pdf L0 差 ~124px）→ 编辑框/mask
   *  按 glyph 包围盒会过窄，行尾原文露出。提供时优先于 glyph 推导（editingLineId），
   *  让 mask 覆盖到真实文字右缘。 */
  editingLineBox?: { x: number; y: number; width: number; height: number } | null;
  /** Sprint 33.3.4: blockId → rotation (deg)，用于块级旋转（如签名区域） */
  blockRotations?: Map<string, number>;
  /** Sprint 33.3.5 Task 4: blockId → regionId + rotation，用于签名区域分组渲染 */
  signatureRegionMap?: Map<string, { regionId: string; rotation: number }>;
  /** Sprint34.15: blockId → SignatureTransformContext（统一签名旋转 pivot = block originalBounds center） */
  signatureTransformContexts?: Map<string, import("./signature-transform-context").SignatureTransformContext>;
  /** M7.6-001: 显示模式。native-canvas = canvas 为唯一视觉源（隐藏 mask/rect/span，保留 hit-testing）。
   *  legacy-glyph = 旧行为（glyph 层可见并作为主显示层）。默认 legacy-glyph（仅显式传入时切换）。 */
  viewMode?: ViewRenderingMode;
  /** M7.7-003B-002 (Bug2): 已提交编辑过的 block 集合。native-canvas 下这些 block 也渲染 overlay
   *  （mask + span），让用户看到改后的文本（否则 commit 后无视觉源）。
   *  M7.7-004U: 由 block 级升级为 line 级 —— 只遮盖/重渲染「已编辑的行」，未编辑行保持 canvas 扫描原样。
   *  editedLineBoxes: lineId → 该行真实文字覆盖盒（openTextEditSession 扫描 canvas 扩展后的行级 bbox），
   *  commit 后 mask 用它盖住原扫描文字（而非过窄的 OCR 墨迹盒）。 */
  editedLines?: ReadonlySet<string>;
  editedLineBoxes?: Map<string, BBox>;
}

/**
 * GlyphRenderer 组件
 *
 * 渲染 RenderCommand[] 为 DOM 元素：
 *   - mask 矩形（白色背景 div）
 *   - glyph spans（每个字符一个绝对定位 span）
 *   - 选中高亮（蓝色边框）
 *   - 拖拽选择框
 */
export function GlyphRenderer({
  commands,
  styles,
  interactive = false,
  selectedGlyphIds,
  onGlyphClick,
  onGlyphSelect,
  onGlyphEdit,
  onSelectionChanged,
  onDragSelectCommit,
  onGlyphDoubleClick,
  editingBlockId = null,
  editingLineId = null,
  editingLineBox = null,
  blockRotations,
  signatureRegionMap,
  signatureTransformContexts,
  viewMode = "legacy-glyph",
  editedLines,
  editedLineBoxes,
}: GlyphRendererProps) {
  // console.log("[M7.7-015][RENDER]", {
  //   commandsLen: commands.length,
  //   editedLinesSize: editedLines?.size ?? 0,
  //   editedLineBoxesSize: editedLineBoxes?.size ?? 0,
  //   editedLinesArr: editedLines ? [...editedLines].slice(0, 3) : [],
  //   editedLineBoxesKeys: editedLineBoxes ? [...editedLineBoxes.keys()].slice(0, 3) : [],
  // });
  // M7.7-015B: 在 render 阶段检查 glyphs 是否包含已编辑行的 lineId
  // 注意：glyphs 在此处还是 undefined（useMemo 未执行），所以需要延迟到 JSX 中检查
  // M7.7-009B-2a: 诊断——检查所有 styles 是否包含 pdfjsFontFamily
  if (styles?.length > 0) {
    const styleSummary = styles.map((s, i) => `[${i}] pdfjsFontFamily="${s.pdfjsFontFamily ?? "(undefined)"}" fontFamily="${s.fontFamily?.substring(0, 30)}"`).join("; ");
    console.log(`[009B-2a] GlyphRenderer mounted, styles.length=${styles.length}, commands.length=${commands.length}`);
    console.log(`[009B-2a] styles summary: ${styleSummary}`);
  } else {
    console.log(`[009B-2a] GlyphRenderer mounted, styles empty, commands.length=${commands.length}`);
  }

  const isNativeCanvas = viewMode === "native-canvas";
  // M7.7-IMPLEMENT-000 Step2: native-canvas 懒加载 —— 仅活动编辑 block 渲染 glyph span，
  // 其余 text 保持几何索引（Geometry Index），不生成 glyph DOM。legacy-glyph 仍全量渲染。
  // M7.7-003B-002 (Bug2 修复): native-canvas 下**已提交编辑过的 block** 也渲染 overlay（mask + span），
  // 否则 commit 后 editingBlockId 清空、canvas 又依赖 [pdfDoc,page] 不重渲染 → 用户看不到改后的文本。
  // M7.7-004U: 升级为 line 级 —— 已编辑的「行」渲染 overlay，未编辑行保持 canvas 扫描原样。
  const isOverlayBlock = (bid: string): boolean => editingBlockId != null && bid === editingBlockId;
  const isOverlayLine = (cmd: DrawGlyphCommand): boolean => editingLineId != null && cmd.lineId === editingLineId;
  const isLineEdited = (lineId: string): boolean => editedLines?.has(lineId) ?? false;
  // M7.7-036: Committed line = 已编辑但不在编辑态（editingLineId 为空）
  const isCommittedLine = (lineId: string): boolean => isLineEdited(lineId) && editingLineId == null;
  // M7.8-014: 原生 glyph span 的隐藏判定。
  //   - 未编辑行：隐藏（canvas 扫描显示原文，span 仅留作 hit-testing，opacity 0）
  //   - 已提交编辑行（committed modified）：也隐藏 —— 改由 EditableTextNode 独占显示新文，
  //     避免「canvas 旧原文 + EditableTextNode 新文」双重显示（原 glyph 归属让位给 editable overlay）
  //   - 仅「正在编辑」的行（editingLineId 命中）：保留 span 可见（textarea 覆盖其上，无双重显示问题）
  // M7.8-0XX (OCR-EDIT-SYNC 修复): native-canvas 下，已提交编辑的 OCR 行没有 EditableTextNode 接管，
  // 必须渲染自身 glyph span 并置于 mask(z=40) 之上(z=50)，否则提交后页面看不到改后文本（symptom 2）。
  //   - 正在编辑的行：textarea 独占显示，span 隐藏（避免双重显示）。
  //   - 已提交编辑行（committed）：渲染 span（opacity 1, z=50）覆盖 mask 下的原图。
  //   - 未编辑行：隐藏（canvas 扫描原文可见；span 仅留 hit-testing）。
  // 注意（M7.8-0XX-fix 回退记录）：已提交行的 span 是「改后文本」的唯一显示源，不可隐藏。
  // 内联提交（TextEditOverlay → mutateLineText）只写 EditableDocument，不更新 segments，
  // 因此 EditableTextNode 的 isModified(segment.text !== segment.originalText) 仍为 false
  // → 其文字 color=transparent，无法接管显示。此时若隐藏 span，改后文本就没有任何显示源，
  // 只剩 editedLineBoxes 的白色 mask → 页面出现「空白块」（点击可再次拉起编辑框、导出正常）。
  // Fix 1 (Phase 1): 已编辑行的 span 永久可见，不受 editingLineId 影响。
  //   - 已编辑行（含 L0/L1 等非当前编辑行的已编辑行）span 显示（opacity 1, z=50 压在 mask 之上）。
  //   - 当前编辑行由 textarea 独占显示；shouldRenderGlyphSpan 控制其不渲染 span，避免与 textarea 双重显示。
  const shouldHideGlyphSpan = (cmd: DrawGlyphCommand): boolean => {
    if (isLineEdited(cmd.lineId)) return false; // 已编辑行：span 永久可见
    return editingLineId == null || cmd.lineId !== editingLineId;
  };
  const shouldRenderGlyphSpan = (cmd: DrawGlyphCommand): boolean => {
    if (!isNativeCanvas) return true;
    // native-canvas：当前编辑行由 textarea 独占（不渲染 span）；其余已编辑行渲染自身 span（改后文本唯一显示源）
    if (editingLineId && cmd.lineId === editingLineId) return false;
    return isLineEdited(cmd.lineId);
  };
  // M7.8-0XX: native-canvas 下 inline 编辑提交会生成 replacement canvas，GlyphRenderer 重渲染后
  // 改由 span 显示已提交文本。清理遗留 canvas/host，避免与新 span 重复显示导致页面错乱。
  useEffect(() => {
    if (!isNativeCanvas || typeof document === "undefined") return;
    const lineIds = new Set<string>();
    for (const cmd of commands) {
      if (cmd.type === "drawGlyph" && isLineEdited(cmd.lineId)) {
        lineIds.add(cmd.lineId);
      }
    }
    for (const lineId of lineIds) {
      const canvas = document.getElementById(`canvas-replace-${lineId}`);
      const host = document.getElementById(`glyph-renderer-rep-${lineId}`);
      if (canvas) canvas.remove();
      if (host) host.remove();
    }
  }, [commands, editedLines, editingLineId, isNativeCanvas]);
  const { glyphs, lines, rects, images } = useMemo(() => groupCommands(commands), [commands]);
  // M7.7-006D: 多页状态隔离 — 只渲染当前页有的 editedLineBoxes 条目，
  // 防止 page 1 的 mask 泄漏到 page 2
  const pageLineIds = useMemo(() => {
    const ids = new Set<string>();
    for (const cmd of commands) {
      if ("lineId" in cmd && cmd.lineId) ids.add(cmd.lineId);
    }
    return ids;
  }, [commands]);
  // M7.7-004 (Bug1): 正在编辑行的 bbox（该 block 中 lineId===editingLineId 的 glyph 并集）。
  //   block 级 mask 会盖住同 block 的其他行；编辑态只应遮盖编辑行本身（textarea 已覆盖它），
  //   mask 裁剪到该行 bbox 后，其他行保持 canvas 原文可见。
  const editedLineBox = useMemo(() => {
    // M7.7-004C: PDFEditor 扫描 canvas 后提供的行级真实覆盖盒优先（覆盖真实文字右缘，
    // 不依赖 OCR glyph 墨迹包围盒——后者比实际渲染窄 ~18%）。
    if (editingLineBox) return editingLineBox;
    if (!isNativeCanvas || !editingBlockId || !editingLineId) return null;
    let minX = Number.POSITIVE_INFINITY, minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY, maxY = Number.NEGATIVE_INFINITY;
    for (const g of glyphs) {
      if (g.blockId !== editingBlockId || g.lineId !== editingLineId) continue;
      if (g.x < minX) minX = g.x;
      if (g.y < minY) minY = g.y;
      const rx = g.x + g.width;
      const ry = g.y + g.height;
      if (rx > maxX) maxX = rx;
      if (ry > maxY) maxY = ry;
    }
    if (!Number.isFinite(minX)) return null;
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }, [editingLineBox, isNativeCanvas, editingBlockId, editingLineId, glyphs]);

  // ── Task-002: Selection Engine 接入 ──
  // 文本流（基于当前 glyph 命令，纯计算）
  const flow = useMemo(() => buildTextFlow(glyphs), [glyphs]);
  // 拖选状态：anchor / focus（Selection Model 最少状态）
  const selectionRef = useRef<{ anchor: Boundary; focus: Boundary } | null>(null);
  // M7.7-036: 已输出 RENDER_OWNER 日志的行 ID（避免重复日志）
  const loggedRenderOwnerLines = useRef(new Set<string>()).current;

  // ── Task-007C: SelectionController（统一入口）──
  // GlyphRenderer 不直接知道 Strategy，只调 Controller。boundaryFromPoint（HitTest）留在本组件。
  const selectionController = useMemo(() => new SelectionController(flow), [flow]);

  // 拖拽选择状态
  const [dragRect, setDragRect] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  // M7.7-003B fix: 真实拖拽（位移 > 5px）结束后，浏览器会紧接着派发原生 click 事件；
  // 若不抑制，该 click 会被 handleContainerClick 当作"点击文字"→ 打开 EditSession 并清掉浮层菜单。
  const suppressNextClickRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Task-006: Selection Highlight（仅渲染）──
  // Highlight 是 Renderer，只消费 Engine 的 SelectionRange.boxes，不重新计算 Selection。
  // 蓝色矩形覆盖选中的每个 glyph box。空选区（hasSelection=false）不渲染。
  const [highlightBoxes, setHighlightBoxes] = useState<{ x: number; y: number; width: number; height: number }[]>([]);
  const [hasSelection, setHasSelection] = useState(false);

  // Sprint 28: 可手动触发的 audit counter（解决 __auditPatchLayers 改了不重跑的问题）
  const [auditTrigger, setAuditTrigger] = useState(0);

  // ── Sprint 33 诊断：每次 render 输出 GlyphRenderer 状态 ──
  const renderLoggedRef = useRef(false);
  if (!renderLoggedRef.current || glyphs.length > 0) {
    console.log(
      "%c[GlyphRenderer] render%c interactive=%c%s%c glyphs=%c%d%c cmds=%d styles=%d editingBlockId=%s",
      "font-weight:bold;color:#8b5cf6;",
      "",
      interactive ? "font-weight:bold;color:#22c55e;" : "color:#ef4444;",
      interactive ? "YES" : "NO",
      "",
      glyphs.length > 0 ? "font-weight:bold;color:#22c55e;" : "color:#ef4444;",
      glyphs.length,
      "",
      commands.length,
      styles.length,
      editingBlockId ?? "(none)",
    );
    renderLoggedRef.current = true;
  }

  // ── M7.7-IMPLEMENT-000 Step1: Geometry Click Hit Test ──
  // Click 由容器级几何命中触发（boundaryFromPoint → flow 稳定身份）。**不依赖 glyph span 的 onClick**，
  // 因此未来移除 glyph DOM（Step2）后点击依然成立。
  const glyphByFlowId = useMemo(() => {
    const map = new Map<string, { cmd: DrawGlyphCommand; index: number }>();
    for (const para of flow.paragraphs) {
      for (const line of para.lines) {
        for (const tf of line.glyphs) {
          const idx = glyphs.findIndex(
            (g) =>
              g.blockId === tf.blockId &&
              g.lineId === tf.lineId &&
              g.char === tf.char &&
              Math.abs(g.x - tf.x) < 1e-6
          );
          if (idx >= 0) map.set(tf.glyphId, { cmd: glyphs[idx], index: idx });
        }
      }
    }
    return map;
  }, [flow, glyphs]);

  // 事件 → 容器坐标（Document Space）
  // M7.7-IMPLEMENT-004 (根因修复): clientX/clientY 与 getBoundingClientRect 都是 Screen Space
  // （视觉像素，browser zoom / DPR / CSS transform 会放大），而 flow glyph bbox / glyph span
  // 是 Document Space（CSS 布局像素，未缩放）。不归一化 → boundaryFromPoint / glyphCaretFromClick
  // 偏移 scale 倍 → 编辑框开错行/无法打开、光标落错字符。统一收敛到 coordinate-transform.ts。
  const pointFromEvent = useCallback((e: React.MouseEvent): { x: number; y: number } | null => {
    const el = containerRef.current;
    if (!el) return null;
    // M7.8-047 (T1): 容器自身 0×0（M7.7-074 的 replacement-canvas containing-block 语义，绝不可恢复 width/right/bottom）。
    // 改用有效 rect：原点取容器自身 rect（0×0 仍含正确的 left/top），缩放取 containing block（offsetParent）的
    // 真实尺寸 / clientWidth。仅改坐标换算来源，不触碰容器布局，保住 M7.7-074 语义。
    const originRect = el.getBoundingClientRect();
    const refEl = (el.offsetParent as HTMLElement | null) ?? el.parentElement ?? el;
    const refRect = refEl.getBoundingClientRect();
    const refClient = (refEl as HTMLElement).clientWidth || refRect.width;
    if (refRect.width <= 0 || refClient <= 0) return null;
    const rect = { left: originRect.left, top: originRect.top, width: refRect.width, height: refRect.height };
    return eventPointToDocumentPoint(e.clientX, e.clientY, rect, refClient);
  }, []);

  // ── M7.7-IMPLEMENT-000 Step1: 容器级 Geometical Click（不依赖 span）
  // 复用 boundaryFromPoint（HitTest）→ flow 稳定身份 → onGlyphClick。R4：未命中不帮用户猜。
  const handleContainerClick = useCallback(
    (e: React.MouseEvent) => {
      if (!interactive || !onGlyphClick) return;
      // 注意：此处不能按编辑模式拦截。未编辑行的 span 是隐藏的，点击必须经本容器的
      // boundaryFromPoint 命中才能打开编辑框；一旦拦截，点击原文将完全无反应。
      // M7.7-003B fix: 真实拖拽后的原生 click 应被抑制（拖选语义 ≠ 点击编辑语义）。
      // 该 click 紧随 mouseup 派发，flag 由 handleMouseUp 在位移 > 5px 时置位，此处消费。
      if (suppressNextClickRef.current) {
        suppressNextClickRef.current = false;
        e.stopPropagation();
        return;
      }
      const p = pointFromEvent(e);
      if (!p) return;
      // M7.7-011: Hit Test 审计 — 收集相邻行 Y 范围
      const hitCandidates: { lineId: string; minY: number; maxY: number; centerY: number; distY: number }[] = [];
      const tolerance = 4;
      for (const para of flow.paragraphs) {
        for (const line of para.lines) {
          if (line.glyphs.length === 0) continue;
          let minY = Infinity, maxY = -Infinity, maxH = 0;
          for (const g of line.glyphs) {
            if (g.y < minY) minY = g.y;
            if (g.y + g.height > maxY) maxY = g.y + g.height;
            if (g.height > maxH) maxH = g.height;
          }
          const lineTol = tolerance + maxH;
          if (p.y < minY - lineTol || p.y > maxY + lineTol) continue;
          const centerY = (minY + maxY) / 2;
          hitCandidates.push({ lineId: line.lineId, minY, maxY, centerY, distY: Math.abs(p.y - centerY) });
        }
      }
      hitCandidates.sort((a, b) => a.distY - b.distY);
      const boundary = boundaryFromPoint(p, flow);
      if (!boundary) {
        // console.log("[M7.7-011][HIT_TEST_AUDIT]", {
        //   clickX: p.x, clickY: p.y,
        //   nCandidates: hitCandidates.length,
        //   candidates: hitCandidates,
        //   result: "MISS",
        // });
        return;
      }
      const entry = glyphByFlowId.get(`${boundary.blockId}__${boundary.lineId}__${boundary.glyphLocalIndex}`);
      if (!entry) return;
      // M7.7-011: Hit Test 审计日志
      const selectedLine = hitCandidates.find(c => c.lineId === boundary.lineId);
      // console.log("[M7.7-011][HIT_TEST_AUDIT]", {
        //   clickX: p.x, clickY: p.y,
        //   nCandidates: hitCandidates.length,
        //   candidates: hitCandidates,
        //   selected: { lineId: boundary.lineId, glyphIdx: boundary.glyphLocalIndex, edge: boundary.edge, char: entry.cmd.char },
        //   selectedLineY: selectedLine ? { minY: selectedLine.minY, maxY: selectedLine.maxY, centerY: selectedLine.centerY, distY: selectedLine.distY } : "?",
        //   clickRelToSelected: selectedLine ? `${p.y < selectedLine.minY ? "ABOVE" : p.y > selectedLine.maxY ? "BELOW" : "INSIDE"}` : "?",
        // });
      e.stopPropagation();
      onGlyphClick({ glyph: entry.cmd, index: entry.index, screenX: p.x, screenY: p.y });
    },
    [interactive, onGlyphClick, pointFromEvent, flow, glyphByFlowId]
  );

  // 拖拽开始（在容器空白处）
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!interactive || !onGlyphSelect) return;
      // M7.7-003B fix: 新一轮交互开始，清除可能残留的"拖拽后抑制 click"标记
      // （mouseup 落在容器外时不会派发 click，flag 需在此重置，避免误吞下一次真实点击）。
      suppressNextClickRef.current = false;
      const p = pointFromEvent(e);
      if (!p) return;
      dragStartRef.current = { x: p.x, y: p.y };
      setDragRect({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });

      // ── Task-002: Selection Engine — mousedown 创建 Anchor ──
      // 命中文字才启动选择（未命中 → 不建立 anchor，符合 R4 不帮用户猜）
      const anchor = boundaryFromPoint(p, flow);
      console.log("[Selection] mousedown point", p, "flow.count", flow.count, "hit", anchor ? "YES" : "null", "dragStart set:", !!dragStartRef.current);
      if (anchor) {
        selectionRef.current = { anchor, focus: anchor };
        // 命中字符：boundary 的 edge=after 表示落在该字符后，before 表示该字符前。
        // 这里打印命中的字符本身（供 Task-004 验证点击 A → hit A）
        const g = flow.glyphIdToGlyph.get(`${anchor.blockId}__${anchor.lineId}__${anchor.glyphLocalIndex}`);
        console.log("[Selection] mousedown anchor:", anchor, "hitChar:", g ? `"${g.char}"` : "?");
        // 新选择开始：清空旧 highlight（mousemove 会用新的 range.boxes 重建）
        setHighlightBoxes([]);
        setHasSelection(false);
      } else {
        selectionRef.current = null;
        // ── Task-006 Case 3: 点击空白 → 取消选择，Highlight 消失 ──
        setHighlightBoxes([]);
        setHasSelection(false);
        // ── Task-013A: Expose DerivedSelection（清除选区 → null）──
        onSelectionChanged?.(null);
      }
    },
    [interactive, onGlyphSelect, pointFromEvent, flow, onSelectionChanged]
  );

  // 拖拽移动
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragStartRef.current || !onGlyphSelect) return;
      const p = pointFromEvent(e);
      if (!p) return;
      setDragRect({ ...dragStartRef.current, x2: p.x, y2: p.y });

      // ── Task-002: Selection Engine — mousemove 更新 Focus ──
      if (selectionRef.current) {
        const focus = boundaryFromPoint(p, flow);
        if (focus) {
          selectionRef.current.focus = focus;
          const range = deriveSelection(selectionRef.current, flow);
          console.log("[Selection] mousemove focus:", focus, "range:", { start: range.startIndex, end: range.endIndex, glyphs: range.glyphs.map((g) => g.char).join("") });
          // ── Task-006: Highlight 消费 Engine 的 range.boxes（Renderer 只画矩形，不重新算 Selection）──
          setHighlightBoxes(range.boxes);
          setHasSelection(range.glyphs.length > 0);
          // ── Task-013A: Expose DerivedSelection（暴露已有类型，不创建新类型）──
          onSelectionChanged?.(range.glyphs.length > 0 ? range : null);
        }
      }
    },
    [onGlyphSelect, pointFromEvent, flow, onSelectionChanged]
  );

  // 拖拽结束
  const handleMouseUp = useCallback(
    (e: React.MouseEvent) => {
      const p = pointFromEvent(e);
      const x2 = p?.x ?? 0;
      const y2 = p?.y ?? 0;
      const x1 = dragStartRef.current?.x ?? 0;
      const y1 = dragStartRef.current?.y ?? 0;
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);

      // M7.7-003B fix: 真实拖拽（位移 > 5px）→ 抑制紧随其后的原生 click（防 click-to-edit 抢占拖选菜单）。
      if (dx > 5 || dy > 5) suppressNextClickRef.current = true;

      // ── Task-002: Selection Engine — mouseup 固定 Selection ──
      if (selectionRef.current) {
        // 最终 focus（若有移动时的 focus 则用它；否则用 mouseup 位置）
        const finalFocus = selectionRef.current.focus;
        const range = deriveSelection(selectionRef.current, flow);
        const selText = range.glyphs.map((g) => g.char).join("");
        console.log("[Selection] mouseup final:", {
          anchor: selectionRef.current.anchor,
          focus: finalFocus,
          range: { start: range.startIndex, end: range.endIndex, isBackward: range.isBackward, glyphs: selText, glyphCount: range.glyphs.length },
        });
        console.log("[Selection] mouseup glyphs:", selText);
        // 上报给 PDFEditor（用 Engine 结果，文本流连续选择）
        onGlyphSelect({ rect: { x1, y1, x2, y2 }, glyphs: range.glyphs as DrawGlyphCommand[] });
        // ── Task-013A: Expose DerivedSelection（固定最终选区；无字符则 null）──
        onSelectionChanged?.(range.glyphs.length > 0 ? range : null);
        // ── M7.7-003: 拖选结束（真实拖拽位移 > 5px）一次性提交最终选区 ──
        // 仅真实拖拽触发（简单点击由 onGlyphClick 处理，避免双开 EditSession）。
        // 供 PDFEditor 直接进入 inline EditSession（替代 Workspace "Update Text" 旧路径）。
        if (range.glyphs.length > 0 && (dx > 5 || dy > 5)) {
          onDragSelectCommit?.(range);
        }
        selectionRef.current = null;
      } else if (dx > 5 || dy > 5) {
        // 兼容：未命中文字但拖拽（保留旧框选行为，作为过渡）
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        const selectedGlyphs = glyphs.filter((g) => {
          return g.x < maxX && g.x + g.width > minX && g.y < maxY && g.y + g.height > minY;
        });
        onGlyphSelect({ rect: { x1, y1, x2, y2 }, glyphs: selectedGlyphs });
      }
      dragStartRef.current = null;
      setDragRect(null);
    },
    [glyphs, onGlyphSelect, pointFromEvent, flow, onSelectionChanged, onDragSelectCommit]
  );

  // ── Task-007D: DoubleClick Wiring（只接线，不加业务逻辑）──
  // Mouse DoubleClick → boundaryFromPoint()（HitTest，属 GlyphRenderer）→ controller.expandWord() → Highlight
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!interactive || !onGlyphSelect) return;
      const p = pointFromEvent(e);
      if (!p) return;
      const boundary = boundaryFromPoint(p, flow);
      if (!boundary) return;
      const range = selectionController.expandWord(boundary);
      setHighlightBoxes(range.boxes);
      setHasSelection(range.glyphs.length > 0);
      // ── Task-013A: Expose DerivedSelection（双击选词）──
      onSelectionChanged?.(range.glyphs.length > 0 ? range : null);
      // M7.7-005: 双击选词后一次性通知外部 → 直接进入 inline EditSession（不弹 SelectionActionMenu）。
      // 注意：dblclick 前浏览器已派发两次 click（各自打开过 text-edit session）；M7.7-003A 的
      // session epoch guard 保证旧 blur 不会取消本 session，本回调的 session 是最终态。
      onGlyphDoubleClick?.(range.glyphs.length > 0 ? range : null);
      console.log("[Selection] dblclick word:", range.glyphs.map((g) => g.char).join(""));
    },
    [interactive, onGlyphSelect, pointFromEvent, flow, selectionController, onSelectionChanged, onGlyphDoubleClick]
  );

  // ── Sprint 23: Log DOM type on mount ──
  const domTypeRef = useRef(false);
  if (!domTypeRef.current && containerRef.current) {
    domTypeRef.current = true;
    // [Sprint23] GlyphRenderer DOM type - 已禁用
  }

  // ── Sprint 25: Coordinate System Audit ──
  const sprint25Ref = useRef(false);
  const firstGlyphCmd = glyphs.length > 0 ? glyphs[0] : null;
  useEffect(() => {
    if (sprint25Ref.current) return;
    const timer = setTimeout(() => {
      sprint25Ref.current = true;

      const pdfCanvas = document.querySelector("[data-layer='pdf-canvas']") as HTMLElement | null;
      const glyphContainer = document.querySelector("[data-layer='glyph']") as HTMLElement | null;
      const firstSpan = document.querySelector("[data-layer='glyph'] span") as HTMLElement | null;
      const wrapper = document.querySelector("[data-layer='wrapper']") as HTMLElement | null;

      const result: any = {
        pdfCanvas: pdfCanvas ? {
          rect: pdfCanvas.getBoundingClientRect(),
          offsetWidth: pdfCanvas.offsetWidth,
          offsetHeight: pdfCanvas.offsetHeight,
        } : null,
        glyphContainer: glyphContainer ? {
          rect: glyphContainer.getBoundingClientRect(),
          offsetWidth: glyphContainer.offsetWidth,
          offsetHeight: glyphContainer.offsetHeight,
          overflowParent: "wrapper (data-layer)",
        } : null,
        wrapper: wrapper ? {
          rect: wrapper.getBoundingClientRect(),
          computedOverflow: getComputedStyle(wrapper).overflow,
          computedPosition: getComputedStyle(wrapper).position,
        } : null,
        firstGlyphCmd: firstGlyphCmd ? {
          char: firstGlyphCmd.char,
          docX: firstGlyphCmd.x,
          docY: firstGlyphCmd.y,
          docW: firstGlyphCmd.width,
          docH: firstGlyphCmd.height,
        } : null,
        firstSpan: firstSpan ? {
          rect: firstSpan.getBoundingClientRect(),
          computedLeft: getComputedStyle(firstSpan).left,
          computedTop: getComputedStyle(firstSpan).top,
          computedPosition: getComputedStyle(firstSpan).position,
          textContent: firstSpan.textContent,
        } : null,
        scale: {
          viewportScale: (window as any).__sprint25_viewportScale ?? "unknown",
          cssScale: (window as any).__sprint25_cssScale ?? "unknown",
          canvasWidth: (window as any).__sprint25_canvasWidth ?? "unknown",
          canvasHeight: (window as any).__sprint25_canvasHeight ?? "unknown",
        },
        // 坐标系一致性检查
        coordCheck: firstGlyphCmd && glyphContainer ? {
          expectedSpanX_inContainer: firstGlyphCmd.x,
          expectedSpanY_inContainer: firstGlyphCmd.y,
          containerWidth: glyphContainer.offsetWidth,
          containerHeight: glyphContainer.offsetHeight,
          isXInBounds: firstGlyphCmd.x >= 0 && firstGlyphCmd.x <= glyphContainer.offsetWidth,
          isYInBounds: firstGlyphCmd.y >= 0 && firstGlyphCmd.y <= glyphContainer.offsetHeight,
        } : null,
      };

      console.log("[Sprint25] Coordinate System Audit", result);
      (window as any).__sprint25_audit = result;
    }, 150);
    return () => clearTimeout(timer);
  }, [glyphs.length]);

  // ═══════════════════════════════════════════════════════════════
  // Sprint 28: Layer Composite Audit
  // ═══════════════════════════════════════════════════════════════

  // Task 3 helper: 暴露 window.__triggerLayerAudit 使 audit 可手动重跑
  useEffect(() => {
    if (typeof window === "undefined") return;
    (window as any).__triggerLayerAudit = () => setAuditTrigger((c) => c + 1);
    return () => { delete (window as any).__triggerLayerAudit; };
  }, []);

  // Task 3: Layer Audit — 输出 patchDOM / canvas / glyph zIndex
  useEffect(() => {
    if (typeof window === "undefined") return;
    const audit = (window as any).__auditPatchLayers;
    if (!audit) return;

    const container = containerRef.current;
    if (!container) return;

    // 等待下一次微任务确保 DOM 已更新
    requestAnimationFrame(() => {
      const patchImgs = container.querySelectorAll<HTMLElement>("[data-sprint28-patch]");
      const patchAudits: any[] = [];

      patchImgs.forEach((el) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const parentEl = el.parentElement as HTMLElement | null;
        patchAudits.push({
          exists: true,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          zIndex: style.zIndex,
          opacity: style.opacity,
          parent: parentEl ? {
            tag: parentEl.tagName,
            zIndex: getComputedStyle(parentEl).zIndex,
          } : null,
        });
      });

      const canvasEl = document.querySelector("[data-layer='pdf-canvas']") as HTMLElement | null;
      const glyphEl = container;

      const result = {
        patchCount: patchImgs.length,
        patches: patchAudits.slice(0, 3), // 只取前 3 个避免过多日志
        patchDOM: patchAudits.length > 0 ? patchAudits[0] : { exists: false },
        canvas: {
          zIndex: canvasEl ? getComputedStyle(canvasEl).zIndex : "none",
          rect: canvasEl ? canvasEl.getBoundingClientRect() : null,
        },
        glyph: {
          zIndex: getComputedStyle(glyphEl).zIndex,
          rect: glyphEl.getBoundingClientRect(),
        },
        zIndexComparison: {
          patchVsCanvas: Number(container.style.zIndex || 0) > Number(canvasEl ? (getComputedStyle(canvasEl).zIndex || 0) : 0)
            ? "patch ABOVE canvas" : "patch BELOW canvas",
          patchVsGlyph: "patch is child of glyph container (zIndex of glyph root: " + getComputedStyle(glyphEl).zIndex + ")",
        },
      };

      (window as any).__sprint28_layerAudit = result;
      console.group("%c[Sprint 28] Layer Composite Audit", "font-weight:bold;color:#8b5cf6;");
      console.log("patchDOM:", result.patchDOM);
      console.log("canvas:", result.canvas);
      console.log("glyph:", result.glyph);
      console.log("%czIndexComparison:", "font-weight:bold;", result.zIndexComparison.patchVsCanvas, result.zIndexComparison.patchVsGlyph);
      console.log("Full result: %cwindow.__sprint28_layerAudit", "color:#999;");
      console.groupEnd();
    });
  }, [glyphs.length, auditTrigger]);
  // ── end Sprint 28 layer audit ──

  // Task 4: __hidePdfCanvas — 隐藏 PDF canvas，观察 patch 是否仍可见
  useEffect(() => {
    if (typeof window === "undefined") return;
    const shouldHide = (window as any).__hidePdfCanvas;
    if (shouldHide) {
      const canvasLayer = document.querySelector("[data-layer='pdf-canvas']") as HTMLElement;
      if (canvasLayer) {
        (canvasLayer as any).__sprint28_wasDisplay = canvasLayer.style.display || "";
        canvasLayer.style.display = "none";
        console.log("%c[Sprint 28] PDF canvas HIDDEN (__hidePdfCanvas=true). Patches should remain visible if they cover the canvas.",
          "font-weight:bold;color:#8b5cf6;");
      }
      return;
    }
    // cleanup: 恢复 PDF canvas
    const canvasLayer = document.querySelector("[data-layer='pdf-canvas']") as HTMLElement;
    if (canvasLayer && (canvasLayer as any).__sprint28_wasDisplay !== undefined) {
      canvasLayer.style.display = (canvasLayer as any).__sprint28_wasDisplay || "";
      delete (canvasLayer as any).__sprint28_wasDisplay;
    }
  }, [glyphs.length]);
  // ── end Sprint 28 hidePdfCanvas ──

  // ── Sprint 24 Task 24.5: Signature enhancement bypass ──
  const disableSigEnhance = typeof window !== "undefined" ? (window as any).__disableSignatureEnhancement : false;
  // When bypass is active: skip all mask/rect/patch img rendering, skip rotation on spans

  // M7.7-029: Font metric audit — compare overlay span font vs PDF font
  useEffect(() => {
    if (!editedLines || editedLines.size === 0) return;
    const timer = setTimeout(() => {
      const lineIds = [...editedLines];
      for (const lineId of lineIds) {
        const span = document.querySelector(`[data-line-id="${lineId}"][data-layer="overlay"]`) as HTMLElement | null;
        if (!span) continue;
        const char = span.getAttribute("data-cmd-char") || "";
        const cmdWidth = parseFloat(span.getAttribute("data-cmd-width") || "0");
        const cmdFontFamily = span.getAttribute("data-cmd-font") || "";
        const cmdFontSize = parseFloat(span.getAttribute("data-cmd-fontsize") || "0");
        const style = getComputedStyle(span);
        const spanFontFamily = style.fontFamily;
        const spanFontSize = style.fontSize;
        const spanOffsetWidth = span.offsetWidth;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        let browserMeasureWidth = 0;
        if (ctx) {
          ctx.font = `${spanFontSize} ${spanFontFamily}`;
          browserMeasureWidth = ctx.measureText(char).width;
        }
        console.log("[M7.7-029][FONT_COMPARE]", {
          lineId,
          cmdFontFamily,
          cmdFontSize,
          spanComputedFontFamily: spanFontFamily,
          spanComputedFontSize: spanFontSize,
          cmdWidth: Math.round(cmdWidth * 100) / 100,
          spanOffsetWidth,
          browserMeasureWidth: Math.round(browserMeasureWidth * 100) / 100,
          pdfGlyphWidth: Math.round(cmdWidth * 100) / 100,
        });
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [editedLines, editedLineBoxes, commands.length]);

  return (
    <div
      data-layer="glyph"
      ref={containerRef}
      className="glyph-renderer"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      // M7.7-IMPLEMENT-000 Step1: 容器级几何点击（不依赖 span）
      onClick={handleContainerClick}
      style={{
        position: "absolute",
        top: 0, left: 0,
        // M7.7-074: 作为 replacement canvas 的 containing block（原点 0,0；移除 right/bottom 填充——abs 子元素只依赖原点，不影响定位）
        // Sprint34.1: 统一层常量。原为魔数 99999（会压过编辑层），现用 RenderLayer.GLYPH=30。
        // 编辑框（RenderLayer.EDITOR=100）在其之上，不再被 glyph 覆盖。
        zIndex: RenderLayer.GLYPH,
        pointerEvents: interactive ? "auto" : "none",
      }}
    >
      {/* 1. Mask 矩形（白色遮盖原文）[Sprint 24 bypass][M7.7-IMPLEMENT-000 Step3: native 不创建（非仅隐藏）]
          M7.7-003B-002: 已提交编辑过的 block 需同时渲染 mask（白底盖住旧 canvas 文字）+ span，否则 overlay 新文字与 canvas 旧文字重叠。
          M7.7-004U: native-canvas 下由 block 级升级为 line 级 —— 只遮盖「已编辑的行」，未编辑行保持 canvas 扫描原样。 */}
      {!disableSigEnhance && lines.map((cmd, i) => {
        // M7.7-004 (Bug1): 编辑态 block 级 mask 会盖住同 block 的其他行（用户看到"点某行编辑，
        //   其他行文本被隐藏"）。编辑是行级 → mask 裁剪到编辑行的 bbox：
        //   - 能算出编辑行 bbox → 裁剪（其他行保持 canvas 原文可见，编辑行仍被白底遮盖）；
        //   - 算不出（editingLineId 缺失等）→ 编辑态跳过该 block mask（textarea 白底已覆盖编辑行）。
        if (isNativeCanvas && isOverlayBlock(cmd.blockId)) {
          // M7.7-004C: 直接用编辑行真实覆盖盒（PDFEditor 扫描 canvas 扩展后），不再与 block 级
          // mask 相交——block mask 也是 glyph 墨迹盒（过窄），相交会把真实文字右缘裁掉 → 行尾原文露出。
          // editedLineBox 已是"编辑行"级（lineId 过滤），多行 block 也只会盖编辑行（M7.7-004 Bug1 保持）。
          if (!editedLineBox) return null;
          return (
            <div
              key={`mask_${i}`}
              style={{
                position: "absolute",
                left: editedLineBox.x,
                top: editedLineBox.y,
                width: editedLineBox.width,
                height: editedLineBox.height,
                background: "#fff",
                pointerEvents: "none",
                zIndex: 1,
              }}
            />
          );
        }
        // legacy-glyph 模式：保留 block 级 mask（legacy 行为不变）
        return shouldRenderGlyphSpan(cmd as DrawGlyphCommand) && (
          <div
            key={`mask_${i}`}
            style={{
              position: "absolute",
              left: cmd.x,
              top: cmd.y,
              width: cmd.width,
              height: cmd.height,
              background: cmd.purpose === "mask" ? "#fff" : "transparent",
              pointerEvents: "none",
              zIndex: 1,
            }}
          />
        );
      })}

      {/* 1.1 M7.7-004U: native-canvas 下已提交编辑的「行」mask（line 级，只盖已编辑行）。
          用 openTextEditSession 扫描 canvas 扩展后的行级真实覆盖盒（覆盖真实文字右缘，
          非过窄的 OCR 墨迹盒）；未编辑行不生成 mask → canvas 扫描原文保持可见。 */}
      {isNativeCanvas && !disableSigEnhance && editedLineBoxes && editedLines && [...editedLineBoxes.entries()].filter(([lineId]) => pageLineIds.has(lineId)).map(([lineId, box]) => {
        // Fix 2 (Phase 2): 编辑行也渲染 mask —— 盖住编辑行右侧 canvas 原文漏出（如 L0 的 790→904）。
        // 层级安全：TextEditOverlay 容器 zIndex=RenderLayer.EDITOR(100) > GlyphRenderer(30)，
        // 故 mask(z=40, 在 GlyphRenderer 内) 位于 textarea 之下，不会盖住编辑框文字。
        // 仅已提交编辑的行（editedLines 含该行）渲染 mask；未提交行 editedLines 不含 → 832 跳过。
        if (!editedLines.has(lineId)) return null;
        // M7.7-070: mask 创建 — 行绑定验证（rect 与 replacement geometry 同源）
        console.log("[M7.7-070][MASK_CREATE]", {
          lineId,
          rect: {
            x: Math.round(box.x * 100) / 100,
            y: Math.round(box.y * 100) / 100,
            width: Math.round(box.width * 100) / 100,
            height: Math.round(box.height * 100) / 100,
          },
          sourceLineId: lineId,
          geometryId: lineId,
        });
        return (
          <div
            key={`editedmask_${lineId}`}
            data-line-id={lineId}
            data-layer="mask"
            style={{
              position: "absolute",
              left: box.x,
              top: box.y, // M7.8-0XX: mask 必须紧贴原文上沿，+8 会露出顶部原文并向下侵占下一行
              width: box.width,
              height: box.height,
              background: "#fff",
              pointerEvents: "none",
              zIndex: 40, // M7.7-069: 低于 replacement canvas (50)，让已提交的新文本可见
            }}
          />
        );
      })}

      {/* 1.5 Signature replacement zone 背景恢复矩形（兼容旧架构）[Sprint 24 bypass][M7.7-IMPLEMENT-000 Step3: native 不创建] */}
      {!disableSigEnhance && !isNativeCanvas && rects.map((cmd, i) => (
        <div
          key={`rect_${i}`}
          style={{
            position: "absolute",
            left: cmd.x,
            top: cmd.y,
            width: cmd.width,
            height: cmd.height,
            background: cmd.fill,
            opacity: cmd.opacity,
            pointerEvents: "none",
            zIndex: 1,
          }}
        />
      ))}

      {/*  1.8 Image rendering moved to BackgroundPatchLayer (Sprint 29) */}
      {/* ── Sprint 22 image red box overlay removed — now in BackgroundPatchLayer (Sprint 29) ── */}

      {/* 2. Glyph spans（每个字符独立定位，支持 CSS transform 旋转） */}
      {/* Sprint 33.3.4: block-level rotation for signature blocks */}
      {/* Sprint 33.3.5 Task 4: signature region grouping — one wrapper per region */}
      {(() => {
        // Group glyphs by blockId to support block-level rotation
        const blockGroups = new Map<string, { cmds: DrawGlyphCommand[]; indices: number[] }>();
        glyphs.forEach((cmd, i) => {
          const entry = blockGroups.get(cmd.blockId);
          if (entry) {
            entry.cmds.push(cmd);
            entry.indices.push(i);
          } else {
            blockGroups.set(cmd.blockId, { cmds: [cmd], indices: [i] });
          }
        });

        // M7.7-018: 几何坐标审计 — 比较 command bbox / mask bbox / estimated ink bbox
        if (editedLines && editedLines.size > 0) {
          const auditedLineId = editedLines.has("pdf_pdf_p1_block0_l17")
            ? "pdf_pdf_p1_block0_l17"
            : [...editedLines][0];
          // 1. 计算该行所有 glyph 的 command bbox 并集
          let cmdBbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
          let cmdBaseline: number | undefined;
          let cmdBaselineY: number | undefined;
          for (const [, g] of blockGroups) {
            for (const cmd of g.cmds) {
              if (cmd.lineId !== auditedLineId) continue;
              cmdBbox.minX = Math.min(cmdBbox.minX, cmd.x);
              cmdBbox.minY = Math.min(cmdBbox.minY, cmd.y);
              cmdBbox.maxX = Math.max(cmdBbox.maxX, cmd.x + cmd.width);
              cmdBbox.maxY = Math.max(cmdBbox.maxY, cmd.y + cmd.height);
              if (cmdBaseline === undefined && cmd.baseline !== undefined) {
                cmdBaseline = cmd.baseline;
                cmdBaselineY = cmd.y;
              }
            }
          }
          const cmdUnion = cmdBbox.minX !== Infinity
            ? { x: cmdBbox.minX, y: cmdBbox.minY, width: cmdBbox.maxX - cmdBbox.minX, height: cmdBbox.maxY - cmdBbox.minY }
            : null;

          // 2. 获取 editedLineBoxes mask bbox
          const maskBox = editedLineBoxes?.get(auditedLineId) ?? null;

          // 3. 估计 ink bbox（用第一个 glyph 的字体/字号 measureText）
          let estimatedInk: { top: number; bottom: number; actualAscent: number; actualDescent: number } | null = null;
          if (cmdUnion) {
            try {
              const firstGlyph = (() => {
                for (const [, g] of blockGroups) {
                  for (const cmd of g.cmds) {
                    if (cmd.lineId === auditedLineId) return cmd;
                  }
                }
                return null;
              })();
              if (firstGlyph) {
                const st = styles[firstGlyph.styleRef] || {};
                const fontSize = st.fontSize || 14;
                const fontFamily = st.pdfjsFontFamily || st.fontFamily || "sans-serif";
                const c = document.createElement("canvas");
                const ctx = c.getContext("2d");
                if (ctx) {
                  ctx.font = `${fontSize}px "${fontFamily}"`;
                  const m = ctx.measureText("Ay"); // "Ay" 含 ascent + descent
                  const baseline = firstGlyph.baseline ?? (firstGlyph.y + firstGlyph.height * 0.7);
                  estimatedInk = {
                    top: baseline - m.actualBoundingBoxAscent,
                    bottom: baseline + m.actualBoundingBoxDescent,
                    actualAscent: m.actualBoundingBoxAscent,
                    actualDescent: m.actualBoundingBoxDescent,
                  };
                }
              }
            } catch (_) { /* canvas measureText 可能因字体名异常而失败，静默跳过 */ }
          }

          // 4. 差异报告
          if (cmdUnion) {
            const maskOverlap = maskBox
              ? {
                  topDiff: Math.round((cmdUnion.y - maskBox.y) * 100) / 100,
                  bottomDiff: Math.round(((cmdUnion.y + cmdUnion.height) - (maskBox.y + maskBox.height)) * 100) / 100,
                  leftDiff: Math.round((cmdUnion.x - maskBox.x) * 100) / 100,
                  rightDiff: Math.round(((cmdUnion.x + cmdUnion.width) - (maskBox.x + maskBox.width)) * 100) / 100,
                }
              : null;
            const inkVsCmd = estimatedInk
              ? {
                  inkTopDiff: Math.round((cmdUnion.y - estimatedInk.top) * 100) / 100,
                  inkBottomDiff: Math.round(((cmdUnion.y + cmdUnion.height) - estimatedInk.bottom) * 100) / 100,
                }
              : null;
            // [M7.7-018][GEOMETRY_AUDIT] - 已禁用
          }
        }

        const result: React.ReactNode[] = [];

        // ── Sprint 33.3.5 Task 4: Signature region grouping ──
        // Sprint34.24: 每个 EditableBlock 拥有独立 GlyphContainer（block 级容器）。
        // 不再共享 region 级 rotation wrapper（那会导致多个 block 共享同一 DOM bbox）。
        if (signatureRegionMap && signatureRegionMap.size > 0) {

          // Sprint34.9 debug: 确认 blockId 与 signatureRegionMap 的匹配
          if (typeof console !== "undefined") {
            const mapKeySet = new Set(signatureRegionMap.keys());
            let matched = 0;
            let firstRotation = 0;
            const rows: string[] = [];
            for (const [blockId, group] of blockGroups) {
              const ri = signatureRegionMap.get(blockId);
              if (ri) { matched++; firstRotation = ri.rotation; }
              const text = group.cmds.slice(0, 15).map((c) => c.char).join("") + (group.cmds.length > 15 ? "..." : "");
              rows.push(`"${blockId}" inMap=${mapKeySet.has(blockId)} n=${group.cmds.length} text="${text}"`);
            }
            console.log(
              `%c[Sprint34.9][GlyphRender] mapSize=${signatureRegionMap.size} groupKeys=${blockGroups.size} matched=${matched} firstRotation=${firstRotation}`,
              "color:#22c55e;",
            );
            console.log("  GROUP_BLOCKS:\n" + rows.join("\n  "));
            console.log("  MAP_KEYS: " + JSON.stringify([...signatureRegionMap.keys()]));
          }

          // Sprint34.24: 从 Region 级容器重构为 Block 级容器。
          // 每个 EditableBlock 拥有独立 GlyphContainer（不共享 DOM bbox）。
          // 不再按 regionId 分组，直接遍历签名 block，每个 block 一个 wrapper。
          for (const [blockId, group] of blockGroups) {
            const ri = signatureRegionMap.get(blockId);
            // Sprint34.19: 只要属于签名区域（在 signatureRegionMap）就走签名渲染。
            if (!ri) continue;

            const cmds = group.cmds;
            if (cmds.length === 0) continue;
            // Sprint34.25: 容器尺寸必须来自 EditableBlock bbox（Geometry Source of Truth），
            // 禁止用 glyph union（按字符排版自然宽度）重新推导 bbox。
            // 项目规范：EditableBlock 是 PDF 编辑系统的几何真相源，任何 Renderer 不允许重新推导 bbox。
            const ctx0 = signatureTransformContexts?.get(blockId);
            const blockBounds = ctx0?.blocks?.[0]?.originalBounds;
            const fallbackX = Math.min(...cmds.map((c) => c.x));
            const fallbackY = Math.min(...cmds.map((c) => c.y));
            const blockX = blockBounds?.x ?? fallbackX;
            const blockY = blockBounds?.y ?? fallbackY;
            const blockW =
              blockBounds?.width ??
              Math.max(...cmds.map((c) => c.x + c.width)) - fallbackX;
            const blockH =
              blockBounds?.height ??
              Math.max(...cmds.map((c) => c.y + c.height)) - fallbackY;

            // Sprint34.15 Debug: 输出该 block 的 pivot（= originalBounds center）
            if (typeof console !== "undefined") {
              const text = cmds.slice(0, 15).map((c) => c.char).join("") + (cmds.length > 15 ? "..." : "");
              const pivot = ctx0?.pivot;
              console.log(
                `%c[Sprint34.15][SigGlyphTransform] blockId=${blockId} text="${text}" rotation=${ri.rotation} ` +
                `blockBBox=(x=${blockX.toFixed(1)},y=${blockY.toFixed(1)},w=${blockW.toFixed(1)},h=${blockH.toFixed(1)}) ` +
                `source="${blockBounds ? "EditableBlock" : "glyph-union(fallback)"}"`,
                "color:#22d3ee;",
              );
            }

            // P0-007 Commit 2+3（Remove Rotation Side Channel）：
            // Renderer 只消费 DrawGlyphCommand.transform（唯一 Rotation Source）。
            // 签名区不再用 signatureTransformContexts 做容器级 rotate；
            // 每个 glyph 绝对定位 + 消费 cmd.transform（OCR 真实旋转，matrix）。
            // 与 ADR-004 一致：Renderer 不知道 Region / Context / RotationMap。
            result.push(
              <div
                key={`sigblock_${blockId}`}
                data-sig-block-container={blockId}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: 0,
                  height: 0,
                  pointerEvents: "none",
                  zIndex: 3,
                  // P0-016 实验 A：仅验证 Block Rotate 能否叠加（glyph matrix 保留）。
                  // 保持 left:0/top:0（不改 glyph 坐标语义），只加 container 级 rotate。
                  ...(ri.rotation
                    ? {
                        transform: `rotate(${ri.rotation}deg)`,
                        transformOrigin: `${blockX + blockW / 2}px ${blockY + blockH / 2}px`,
                      }
                    : {}),
                }}
              >
                {cmds.map((cmd, ci) => {
                  // M7.7-010.11: 强制日志输出，证明代码路径被执行
                  if (ci === 0 || editedLineBoxes?.has(cmd.lineId)) {
                    // [M7.7-010.11][MAP_START] - 已禁用
                  }
                  const st = styles[cmd.styleRef] || {};
                  // M7.7-009B-2: 优先使用 pdfjsFontFamily（PDF.js 内部字体名，如 "g_d0_f1"），
                  // 回退到 CSS font-family（FontAnalyzer 映射结果）。
                  const ff = st.pdfjsFontFamily || st.fontFamily || "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif";
                  const fs = st.fontSize || 14;
                  const fw = st.fontWeight || "normal";
                  const fsi = st.fontStyle || "normal";
                  const c = st.color || "#000000";

                  // P0-016 Step B：删除 per-glyph matrix，rotation 由 block 容器统一承担。
                  // Block Rotation 完全替代 Glyph Rotation。glyph 不再生成 cssTf。

                  // M7.7-011A: Baseline Renderer — 使用 PDF baseline 定位 + CSS ascent
                  // 问题根源：强制 line-height = glyph height 会导致浏览器在压缩的 line box
                  // 里重新计算 baseline，与 PDF 基线不匹配，造成文字偏移。
                  // 正确方案：
                  // 1. span top = PDF baseline - CSS 字体测量的 ascent
                  // 2. line-height: normal 让浏览器不压缩字体
                  // 3. height 不设，利用 overflow: visible 让 descender 可见
                  let spanTop: number;
                  let spanLineHeight: string;
                  let spanHeight: number | undefined;
                  if (cmd.baseline !== undefined && typeof document !== "undefined") {
                    // 用 canvas 测量当前字体的实际 ascent
                    const canvas = document.createElement("canvas");
                    const ctx = canvas.getContext("2d");
                    if (ctx) {
                      const fontSpec = `${fw} ${fs}px ${ff}`;
                      ctx.font = fontSpec;
                      // M7.7-012: 用固定参考字符 "M" 测量 ascent，确保行内所有字符使用统一 ascent
                      // 之前用 cmd.char 逐字符测量导致不同字符 ascent 不同，同一行内 Y 位置不一致
                      const metrics = ctx.measureText("M");
                      const cssAscent = metrics.actualBoundingBoxAscent || Math.round(fs * 0.72);
                      // M7.7-028: 直接使用 CSS font ascent，不再限制 PDF ascent
                      spanTop = cmd.baseline - cssAscent;
                      // line-height: normal 让浏览器使用字体自然高度，不压缩
                      spanLineHeight = "normal";
                      // 不设高度，让浏览器自然排版，overflow: visible 保证可见
                      spanHeight = undefined;
                      // M7.7-028: Overlay glyph baseline alignment audit
                      if (ci === 0) {
                        console.log("[M7.7-028][OVERLAY_BASELINE]", {
                          lineId: cmd.lineId,
                          cmdY: Math.round(cmd.y * 100) / 100,
                          cmdHeight: Math.round(cmd.height * 100) / 100,
                          baseline: cmd.baseline !== undefined ? Math.round(cmd.baseline * 100) / 100 : null,
                          cssTop: Math.round(spanTop * 100) / 100,
                          fontSize: fs,
                          fontBoundingBoxAscent: metrics.fontBoundingBoxAscent,
                          fontBoundingBoxDescent: metrics.fontBoundingBoxDescent,
                        });
                      }
                      // M7.7-012: 渲染基线位置审计
                      if (ci === 0 || editedLineBoxes?.has(cmd.lineId)) {
                        const expectedBaseline = spanTop + cssAscent;
                        const baselineDelta = expectedBaseline - (cmd.baseline ?? 0);
                        // [M7.7-012][RENDER_BASELINE] - 已禁用
                      }
                      // 诊断日志：对比 PDF vs CSS ascent
                      if (ci === 0 || editedLineBoxes?.has(cmd.lineId)) {
                        // [M7.7-011A][BASELINE_RENDER] - 已禁用
                      }
                      // M7.7-024: Canvas glyph metric trace — block-rotated path
                      if (editedLines?.has(cmd.lineId)) {
                        // [M7.7-024][CANVAS_GLYPH_METRIC] - 已禁用
                      }
                      // M7.7-012A: 编辑行 span 位置核对——编辑框 textareaY 应 ≈ spanTop
                      if (editedLineBoxes?.has(cmd.lineId) && ci === 0) {
                        // [M7.7-012A][SPAN_POSITION] - 已禁用
                      }
                    } else {
                      // canvas context 不可用，fallback 回旧方案
                      spanTop = cmd.y;
                      spanLineHeight = `${cmd.height}px`;
                      spanHeight = cmd.height;
                    }
                  } else {
                    // 没有 baseline，fallback 回旧方案
                    spanTop = cmd.y;
                    spanLineHeight = `${cmd.height}px`;
                    spanHeight = cmd.height;
                  }
                  // M7.7-010.8: baseline 诊断（无条件，每行第一个 glyph 输出一次）
                  // 用于验证 PDF 原始 baseline 在渲染层的可用性（不受 commit 状态影响）
                  // M7.7-010.11: 坐标链追踪——无条件输出第一个 glyph + 任何已编辑 glyph
                  if (ci === 0 || editedLineBoxes?.has(cmd.lineId)) {
                    // [M7.7-010.8][BASELINE_AUDIT] - 已禁用
                    // M7.7-010.11: 坐标链追踪（仅首次渲染，非每帧）
                    // 追踪 cmd.y → DOM top 的完整路径，检查是否有重复坐标转换
                    requestAnimationFrame(() => {
                      const containerEl = containerRef.current;
                      const pageEl = containerEl?.parentElement;
                      const canvasEl = document.querySelector('[data-layer="pdf-canvas"]');
                      const containerRect = containerEl?.getBoundingClientRect();
                      const pageRect = pageEl?.getBoundingClientRect();
                      const canvasRect = canvasEl?.getBoundingClientRect();
                      // 计算 span 的预期 CSS top（cmd.y 相对于 page 容器，但 page 可能有 offset）
                      const pageTop = pageRect?.top ?? 0;
                      const containerTop = containerRect?.top ?? 0;
                      const expectedSpanTop = pageTop + cmd.y;
                      // [M7.7-010.11][COORD_TRACE] - 已禁用
                    });
                  }

                  // M7.7-015: 渲染决策审计（signature block 路径）
                  if (editedLines?.has(cmd.lineId)) {
                    // [M7.7-015][DRAW_GLYPH] - 已禁用 (signature)
                  }
                  // M7.7-020: DOM span 渲染审计（signature 路径）
                  if (editedLines?.has(cmd.lineId)) {
                    // [M7.7-020][SPAN_RENDER] - 已禁用 (signature)
                  }
                  return shouldRenderGlyphSpan(cmd) ? (
                    <span
                      key={`${cmd.blockId}__${cmd.lineId}__${ci}`}
                      data-line-id={cmd.lineId}
                      data-layer="overlay"
                      data-sig-block={cmd.blockId}
                      style={{
                        position: "absolute",
                        left: cmd.x,
                        top: spanTop,
                        width: cmd.width,
                        height: spanHeight,
                        fontFamily: ff,
                        fontSize: `${fs}px`,
                        fontWeight: String(fw),
                        fontStyle: fsi,
                        color: c,
                        lineHeight: spanLineHeight,
                        display: "inline-block",
                        textAlign: "left",
                        // M7.7-006C: 移除 verticalAlign:middle → 改用浏览器默认 baseline 对齐
                        // PDF baseline 在 glyph box ~71% 位置，middle 假设 50% → 偏下 ~5px
                        verticalAlign: "baseline",
                        whiteSpace: "pre",
                        overflow: "visible",
                        pointerEvents: interactive ? "auto" : "none",
                        cursor: interactive ? "text" : "default",
                        zIndex: 2,
                        // M7.6-001: native-canvas 下 glyph 文字不可见（opacity 0 保留 hit-testing）
                        ...(isNativeCanvas ? { opacity: 0 } : {}),
                        // P0-016 Step B：glyph 不再应用 matrix（block 容器统一旋转）。
                      }}
                    >
                      {cmd.char}
                    </span>
                  ) : null;
                })}
              </div>
            );
            blockGroups.delete(blockId); // handled by per-block container
          }
        }

        // ── Remaining block-level rendering (non-signature or non-region) ──
        for (const [blockId, group] of blockGroups) {
          const rotation = blockRotations?.get(blockId);
          const isBlockRotated = (rotation !== undefined && Math.abs(rotation) > 0.01);

          if (isBlockRotated) {
            // ── Block-level rotation: wrap in a rotated container ──
            const xs = group.cmds.map(c => c.x);
            const ys = group.cmds.map(c => c.y);
            const blockX = Math.min(...xs);
            const blockY = Math.min(...ys);
            const blockW = Math.max(...group.cmds.map(c => c.x + c.width)) - blockX;
            const blockH = Math.max(...group.cmds.map(c => c.y + c.height)) - blockY;

            result.push(
              <div
                key={`block-rot-${blockId}`}
                data-block-rotation={rotation}
                data-block-id={blockId}
                style={{
                  position: "absolute",
                  left: `${blockX}px`,
                  top: `${blockY}px`,
                  width: `${blockW}px`,
                  height: `${blockH}px`,
                  transform: `rotate(${rotation}deg)`,
                  transformOrigin: "left top",
                  pointerEvents: "none",
                  zIndex: 3,
                }}
              >
                {group.cmds.map((cmd, idx) => {
                  const i = group.indices[idx];
                  const style = styles[cmd.styleRef] || {};
                  // M7.7-009B-2: 优先使用 PDF.js 已加载的 @font-face 字体名（如 "g_d0_f1"）
                  // 确保 overlay 使用与 PDF.js canvas 相同的字体实例，替代 CSS font-family 猜测
                  const fontFamily = style.pdfjsFontFamily || style.fontFamily ||
                    "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif";
                  const localFontSize = style.fontSize || 14;
                  const fontWeight = style.fontWeight || "normal";
                  const fontStyleVal = style.fontStyle || "normal";
                  const color = style.color || "#000000";
                  const glyphId = `${cmd.blockId}__${cmd.lineId}__${i}`;
                  const isSelected = selectedGlyphIds?.has(glyphId) ?? false;

                  // M7.7-009B-2a: 诊断——比较 pdfjsFontFamily vs fontFamily 的文本宽度
                  if (style.pdfjsFontFamily && style.fontFamily && localFontSize > 0) {
                    const key = `${style.pdfjsFontFamily}|${style.fontFamily}|${localFontSize}`;
                    if (!_009B_measuredFonts.has(key)) {
                      _009B_measuredFonts.add(key);
                      try {
                        const cv = document.createElement("canvas");
                        const cctx = cv.getContext("2d");
                        if (cctx) {
                          cctx.font = `${localFontSize}px ${style.pdfjsFontFamily}`;
                          const w1 = cctx.measureText(cmd.char).width;
                          cctx.font = `${localFontSize}px ${style.fontFamily}`;
                          const w2 = cctx.measureText(cmd.char).width;
                          const ratio = w2 > 0 ? (w1 / w2) : 1;
                          console.log(
                            `[009B-2a] pdfjsFont="${style.pdfjsFontFamily}" css="${style.fontFamily}" size=${localFontSize} char="${cmd.char}" pdfjsW=${w1.toFixed(2)} cssW=${w2.toFixed(2)} ratio=${ratio.toFixed(4)}`,
                          );
                        }
                      } catch (_e) {
                        // 静默失败（某些环境可能不支持 canvas 测量）
                      }
                    }
                  }
                  // M7.7-011A: Baseline Renderer for rotated block glyph
                  let rSpanTop: number;
                  let rSpanLineHeight: string;
                  let rSpanHeight: number | undefined;
                  if (cmd.baseline !== undefined && typeof document !== "undefined") {
                    const rCanvas = document.createElement("canvas");
                    const rCtx = rCanvas.getContext("2d");
                    if (rCtx) {
                      const rFontSpec = `${fontWeight} ${localFontSize}px ${fontFamily}`;
                      rCtx.font = rFontSpec;
                      const rMetrics = rCtx.measureText("M");
                      const rCssAscent = rMetrics.actualBoundingBoxAscent || Math.round(localFontSize * 0.72);
                      // M7.7-028: 直接使用 CSS font ascent，不再限制 PDF ascent
                      rSpanTop = (cmd.baseline - rCssAscent) - blockY;
                      rSpanLineHeight = "normal";
                      rSpanHeight = undefined;
                      // M7.7-028: Overlay glyph baseline alignment audit
                      if (idx === 0) {
                        console.log("[M7.7-028][OVERLAY_BASELINE]", {
                          lineId: cmd.lineId,
                          cmdY: Math.round(cmd.y * 100) / 100,
                          cmdHeight: Math.round(cmd.height * 100) / 100,
                          baseline: cmd.baseline !== undefined ? Math.round(cmd.baseline * 100) / 100 : null,
                          cssTop: Math.round(rSpanTop * 100) / 100,
                          fontSize: localFontSize,
                          fontBoundingBoxAscent: rMetrics.fontBoundingBoxAscent,
                          fontBoundingBoxDescent: rMetrics.fontBoundingBoxDescent,
                        });
                      }
                    } else {
                      rSpanTop = cmd.y - blockY;
                      rSpanLineHeight = `${cmd.height}px`;
                      rSpanHeight = cmd.height;
                    }
                  } else {
                    rSpanTop = cmd.y - blockY;
                    rSpanLineHeight = `${cmd.height}px`;
                    rSpanHeight = cmd.height;
                  }
                  // M7.7-015: 渲染决策审计（block-rotated 路径）
                  if (editedLines?.has(cmd.lineId)) {
                    // [M7.7-015][DRAW_GLYPH] - 已禁用 (block-rotated)
                  }
                  // M7.7-020: DOM span 渲染审计（block-rotated 路径）
                  if (editedLines?.has(cmd.lineId)) {
                    // [M7.7-020][SPAN_RENDER] - 已禁用 (block-rotated)
                  }
                  return shouldRenderGlyphSpan(cmd) ? (
                    <span
                      key={glyphId}
                      data-line-id={cmd.lineId}
                      data-layer="overlay"
                      style={{
                        position: "absolute",
                        left: cmd.x - blockX,
                        top: rSpanTop,
                        width: cmd.width,
                        height: rSpanHeight,
                        fontFamily,
                        fontSize: `${localFontSize}px`,
                        fontWeight: String(fontWeight),
                        fontStyle: fontStyleVal,
                        color,
                        lineHeight: rSpanLineHeight,
                        display: "inline-block",
                        textAlign: "left",
                        // M7.7-006C: 移除 verticalAlign:middle → 改用浏览器默认 baseline 对齐
                        // PDF baseline 在 glyph box ~71% 位置，middle 假设 50% → 偏下 ~5px
                        verticalAlign: "baseline",
                        whiteSpace: "pre",
                        overflow: "visible",
                        pointerEvents: interactive ? "auto" : "none",
                        cursor: interactive ? "text" : "default",
                        ...(isSelected
                          ? {
                              boxShadow: "inset 0 0 0 2px rgba(59,130,246,0.8)",
                              background: "rgba(59,130,246,0.1)",
                            }
                          : {}),
                        // Fix 1: 已编辑行（committed 或编辑其他行时的已提交行）置于 mask(z=40) 之上(z=50)
                        zIndex:
                          isNativeCanvas && isLineEdited(cmd.lineId)
                            ? 50
                            : isSelected
                            ? 3
                            : 2,
                        // M7.6-001: native-canvas 下未编辑 glyph 文字不可见（opacity 0 保留 hit-testing）；
                        // M7.8-014: 已提交编辑（committed modified）行的 glyph span 也隐藏，改由 EditableTextNode
                        //   独占显示新文（避免 canvas 旧原文 + EditableTextNode 新文 双重显示）；
                        //   仅「正在编辑」的行（editingLineId 命中）保留 span 可见（textarea 覆盖其上）。
                        opacity:
                          isNativeCanvas && shouldHideGlyphSpan(cmd)
                            ? 0
                            : undefined,
                      }}
                    >
                      {cmd.char}
                    </span>
                  ) : null;
                })}
                {/* Sprint 33.3.5: Signature underline line */}
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: `${blockH - 1}px`,
                    width: `${blockW}px`,
                    height: "1px",
                    borderTop: "1px solid rgba(0,0,0,0.35)",
                  }}
                />
              </div>
            );
          } else {
            // ── No block rotation: flat rendering (original behavior) ──
            for (let idx = 0; idx < group.cmds.length; idx++) {
              const cmd = group.cmds[idx];
              const i = group.indices[idx];
              const style = styles[cmd.styleRef] || {};
              const fontFamily =
                style.pdfjsFontFamily || style.fontFamily ||
                "'Arial','Helvetica','SimSun','Noto Serif CJK SC',sans-serif";
              const localFontSize = style.fontSize || 14;
              const fontWeight = style.fontWeight || "normal";
              const fontStyleVal = style.fontStyle || "normal";
              const color = style.color || "#000000";
              const glyphId = `${cmd.blockId}__${cmd.lineId}__${i}`;
              const isSelected = selectedGlyphIds?.has(glyphId) ?? false;
              // M7.7-010.8: baseline 诊断（flat rendering 路径，每行第一个 glyph）
              if (idx === 0 || editedLineBoxes?.has(cmd.lineId)) {
                // [M7.7-010.8][BASELINE_AUDIT][FLAT] - 已禁用
                // M7.7-010.11: 坐标链追踪（flat rendering 路径，直接输出无需 DOM 查询）
                // [M7.7-010.11][COORD_TRACE] - 已禁用 (flat)
                // M7.7-011A: Font Metric Audit — PDF font vs CSS font
                // 测量当前 CSS 字体的 ascent 高度，与 PDF 对比
                if (typeof document !== "undefined") {
                  const canvas = document.createElement("canvas");
                  const ctx = canvas.getContext("2d");
                  if (ctx) {
                    const fontSpec = `${fontWeight} ${localFontSize}px ${fontFamily}`;
                    ctx.font = fontSpec;
                    // 测量文本基线到顶部的距离（ascent）
                    const metrics = ctx.measureText("M");
                    // 不同浏览器有不同的度量属性，全部输出
                    const fontMetrics = {
                      fontFamily,
                      pdfjsFontFamily: style.pdfjsFontFamily,
                      actualFontFamily: fontFamily,
                      fontWeight,
                      fontSize: localFontSize,
                      // 现代浏览器提供这些属性
                      actualBoundingBoxAscent: metrics.actualBoundingBoxAscent,
                      actualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
                      fontBoundingBoxAscent: metrics.fontBoundingBoxAscent,
                      fontBoundingBoxDescent: metrics.fontBoundingBoxDescent,
                      // 对比 PDF 的 ascent
                      pdfAscent: cmd.baseline !== undefined ? (cmd.baseline - cmd.y) : null,
                      pdfHeight: cmd.height,
                    };
                    // console.log("[M7.7-011A][FONT_METRIC_AUDIT]", fontMetrics);
                    // M7.7-024: Canvas glyph metric trace — measure actual ink bounds
                    // [M7.7-024][CANVAS_GLYPH_METRIC] - 已禁用 (flat)
                  }
                }
              }

              // Transform: 仅当存在非单位矩阵时应用 CSS transform
              const hasTransform =
                cmd.transform &&
                !(cmd.transform[0] === 1 && cmd.transform[1] === 0 &&
                  cmd.transform[2] === 0 && cmd.transform[3] === 1 &&
                  cmd.transform[4] === 0 && cmd.transform[5] === 0);
              const cssTransform = (!disableSigEnhance && hasTransform)
                ? `matrix(${cmd.transform![0]},${cmd.transform![1]},${cmd.transform![2]},${cmd.transform![3]},${cmd.transform![4]},${cmd.transform![5]})`
                : undefined;

              // M7.7-011A: Baseline Renderer for flat block glyph
              let fSpanTop: number;
              let fSpanLineHeight: string;
              let fSpanHeight: number | undefined;
              if (cmd.baseline !== undefined && typeof document !== "undefined") {
                const fCanvas = document.createElement("canvas");
                const fCtx = fCanvas.getContext("2d");
                if (fCtx) {
                  const fFontSpec = `${fontWeight} ${localFontSize}px ${fontFamily}`;
                  fCtx.font = fFontSpec;
                  // M7.7-012: 用固定参考字符 "M" 测量 ascent，确保行内所有字符使用统一 ascent
                  const charMetrics = fCtx.measureText("M");
                  const fCssAscent = charMetrics.actualBoundingBoxAscent || Math.round(localFontSize * 0.72);
                  // M7.7-028: 直接使用 CSS font ascent，不再限制 PDF ascent
                  fSpanTop = cmd.baseline - fCssAscent;
                  fSpanLineHeight = "normal";
                  fSpanHeight = undefined;
                  // M7.7-028: Overlay glyph baseline alignment audit
                  if (idx === 0) {
                    console.log("[M7.7-028][OVERLAY_BASELINE]", {
                      lineId: cmd.lineId,
                      cmdY: Math.round(cmd.y * 100) / 100,
                      cmdHeight: Math.round(cmd.height * 100) / 100,
                      baseline: cmd.baseline !== undefined ? Math.round(cmd.baseline * 100) / 100 : null,
                      cssTop: Math.round(fSpanTop * 100) / 100,
                      fontSize: localFontSize,
                      fontBoundingBoxAscent: charMetrics.fontBoundingBoxAscent,
                      fontBoundingBoxDescent: charMetrics.fontBoundingBoxDescent,
                    });
                  }
                  // M7.7-012: 渲染基线位置审计
                  if (idx === 0 || editedLineBoxes?.has(cmd.lineId)) {
                    const expectedBaseline = fSpanTop + fCssAscent;
                    const baselineDelta = expectedBaseline - (cmd.baseline ?? 0);
                    // [M7.7-012][RENDER_BASELINE] - 已禁用 (flat)
                  }
                  // M7.7-011A: 诊断日志（flat 路径）
                  if (idx === 0 || editedLineBoxes?.has(cmd.lineId)) {
                    // [M7.7-011A][BASELINE_RENDER][FLAT] - 已禁用
                  }
                } else {
                  fSpanTop = cmd.y;
                  fSpanLineHeight = `${cmd.height}px`;
                  fSpanHeight = cmd.height;
                }
              } else {
                fSpanTop = cmd.y;
                fSpanLineHeight = `${cmd.height}px`;
                fSpanHeight = cmd.height;
              }
              // M7.7-015: 渲染决策审计 — 是否跳过原始 glyph 绘制
              // 使用 editedLines（编辑状态权威来源）而非 editedLineBoxes（可能因 box==null 而不含该行）
              if (editedLines?.has(cmd.lineId)) {
                // [M7.7-015][DRAW_GLYPH] - 已禁用 (flat)
              }
              // M7.7-036: 每行首次渲染时输出 render ownership 状态
              if (isLineEdited(cmd.lineId) && !loggedRenderOwnerLines.has(cmd.lineId)) {
                loggedRenderOwnerLines.add(cmd.lineId);
                const state = isCommittedLine(cmd.lineId) ? "committed" : "editing";
                const canvasReplacementEl = typeof document !== "undefined" ? document.getElementById(`canvas-replace-${cmd.lineId}`) : null;
                console.log("[M7.7-036][RENDER_OWNER]", {
                  lineId: cmd.lineId,
                  state,
                  domGlyphVisible: false,
                  canvasReplacementVisible: !!canvasReplacementEl,
                });
              }
              if (shouldRenderGlyphSpan(cmd)) {
                // M7.7-020: DOM span 渲染审计（flat 路径）
                if (editedLines?.has(cmd.lineId)) {
                  // [M7.7-020][SPAN_RENDER] - 已禁用 (flat)
                }
              result.push(
                <span
                  key={glyphId}
                  data-line-id={cmd.lineId}
                  data-layer="overlay"
                  data-cmd-char={cmd.char}
                  data-cmd-width={cmd.width}
                  data-cmd-font={fontFamily}
                  data-cmd-fontsize={localFontSize}
                  // M7.8-0XX: native-canvas 下 committed span 在 z=50。点击直接用自身 cmd 构造
                  // GlyphClickInfo 调用 onGlyphClick，绕过 handleContainerClick 的 boundaryFromPoint
                  // 几何命中（已提交行的 flow 命中在部分情况下返回 null → 提前 return → 编辑打不开）。
                  // 直接把点击送进编辑入口，确保「改后文本可再次编辑」。
                  onClick={
                    isNativeCanvas && isLineEdited(cmd.lineId)
                      ? (e) => {
                          e.stopPropagation();
                          if (suppressNextClickRef.current) return; // 拖选后抑制，避免误开编辑
                          if (!onGlyphClick) return;
                          onGlyphClick({
                            glyph: cmd,
                            index: i,
                            screenX: e.clientX,
                            screenY: e.clientY,
                          });
                        }
                      : undefined
                  }
                  style={{
                    position: "absolute",
                    left: cmd.x,
                    top: fSpanTop,
                    width: cmd.width,
                    height: fSpanHeight,
                    fontFamily,
                    fontSize: `${localFontSize}px`,
                    fontWeight: String(fontWeight),
                    fontStyle: fontStyleVal,
                    color,
                    lineHeight: fSpanLineHeight,
                    display: "inline-block",
                    textAlign: "left",
                    // M7.7-006C: 移除 verticalAlign:middle → 改用浏览器默认 baseline 对齐
                    verticalAlign: "baseline",
                    whiteSpace: "pre",
                    overflow: "visible",
                    pointerEvents: interactive ? "auto" : "none",
                    cursor: interactive ? "text" : "default",
                    ...(cssTransform
                      ? { transform: cssTransform, transformOrigin: "0 0" }
                      : {}),
                    // M7.7-004U: 编辑后字符不再显示绿色边框（原 cmd.modified 样式已移除）。
                    ...(isSelected
                      ? {
                          boxShadow: "inset 0 0 0 2px rgba(59,130,246,0.8)",
                          background: "rgba(59,130,246,0.1)",
                        }
                      : {}),
                    // Fix 1: 已编辑行置于 mask(z=40) 之上(z=50)，编辑其他行时仍保持可见（不再变空白）
                    zIndex:
                      isNativeCanvas && isLineEdited(cmd.lineId)
                        ? 50
                        : isSelected
                        ? 3
                        : 2,
                    // M7.6-IMPLEMENT-002A: native-canvas 下未编辑 glyph 文字不可见（opacity 0 保留 hit-testing）；
                    //   已提交编辑行由上方 zIndex:50 保持可见，避免 canvas 旧原文 + overlay 新文双重显示。
                    opacity:
                      isNativeCanvas && shouldHideGlyphSpan(cmd)
                        ? 0
                        : undefined,
                  }}
                >
                  {cmd.char}
                </span>
              );
            }
            }
          }
        }

        return result;
      })()}

      {/* 3.5 Task-006: Selection Highlight（蓝色选区，仅渲染） */}
      {/* Highlight 只消费 Engine 的 range.boxes，逐个 glyph 画矩形，不重新计算 Selection */}
      {hasSelection && highlightBoxes.map((b, i) => (
        <div
          key={`sel-${i}`}
          style={{
            position: "absolute",
            left: b.x,
            top: b.y,
            width: b.width,
            height: b.height,
            background: "rgba(59,130,246,0.35)",
            pointerEvents: "none",
            zIndex: 3,
          }}
        />
      ))}

      {/* 4. 拖拽选择框 */}
      {dragRect && (
        <div
          style={{
            position: "absolute",
            left: Math.min(dragRect.x1, dragRect.x2),
            top: Math.min(dragRect.y1, dragRect.y2),
            width: Math.abs(dragRect.x2 - dragRect.x1),
            height: Math.abs(dragRect.y2 - dragRect.y1),
            border: "1px solid rgba(59,130,246,0.6)",
            background: "rgba(59,130,246,0.1)",
            pointerEvents: "none",
            zIndex: 4,
          }}
        />
      )}
    </div>
  );
}

/**
 * 便捷方法：从 EditableDocument 直接渲染某一页的 glyph
 */
export function renderPageGlyphs(
  commands: RenderCommand[],
  styles: EditableStyle[]
): React.ReactElement {
  return <GlyphRenderer commands={commands} styles={styles} />;
}
