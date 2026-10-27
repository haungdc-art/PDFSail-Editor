/**
 * EditableTextNode — Commit 5 + Bug 8/10/11 fixes
 *
 * 单个可编辑文本节点组件。
 *
 * 特性：
 *   - 应用 FontMeta（font-family/size/weight/color/line-height）保持原字体保真度
 *   - Bug 8: 编辑模式下单击进入编辑（不再需要双击）
 *   - Bug 10: 编辑模式下文本不再溢出编辑框（pre-wrap + overflow hidden + auto height）
 *   - Bug 11: 浏览模式 (allowEdit=false) 下文本可选（user-select: text），不进入编辑
 *             编辑模式 (allowEdit=true) 下单击进入编辑，user-select: none
 *   - 编辑完成 onBlur 触发 onChange，把新文本回传
 *   - 不选中时背景透明，hover 浅蓝
 *
 * 替代原 PDFCanvas 里的 textItems.map 渲染逻辑。
 */

import React, { useRef, useState, useEffect, useMemo, useSyncExternalStore } from "react";
import type { Segment } from "./types";
import { RenderLayer } from "../document-model/render-layer";
// EDITOR-CORE-012-E2（方案 B）：Core 输入模式下本节点只作 input surface。
// 判定来自极小外部 store（PDFEditor 写入），**不读取 Core document、不投影文本**。
import {
  getCoreInputVisualState,
  isDomTextSuppressed,
  isUnitMemberSegment,
  segmentCommitContextFor,
  subscribeCoreInputVisualState,
  type EditingSurfaceGeometry,
} from "../editor/components/core-input-visual";
// F3B-6.27（提交收口）：整段面提交前必须按 **Binding 决定的 range** 把段落文本
// 降回本段切片。A′ 方案 A 让本面承载完整 Core 段落（`PDFEditor.tsx:5387/:5588`
// `scope.textContent = <整段>`），而 blur 提交读的就是这份 DOM ⇒ 若原样提交，
// 兄弟段前缀会被写进本段 `segment.text`（`useSelection.ts:105-106`）⇒ isModified
// ⇒ 该段 Legacy 面开始自绘 ⇒ 与 owned 编辑面并排画出两个「日期：」。
//
// ⚠️ range **只能**由 Binding ownership 决定（`segmentRangeOf`），UI 不得推算；
// ⚠️ 本节点不得直接 `textContent.slice(...)`，必须走 Binding 的窄投影函数。
import { resolveSegmentCommitSlice } from "../editor/binding/segment-commit-slice";
import {
  subscribeMultiSelection,
  isMultiSelected,
  toggleMultiSelected,
} from "../editor/components/multi-selection";

// M7.8-020-PROD：绝对兜底字体栈（仅当连 FontResolution 都缺失时才用，不含 Arial 作为 PDF 字体默认解）。
const FALLBACK_FONT_FAMILY = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, sans-serif";

// ── Sprint 33.5.9: Runtime Transform Debug ──
// Module-level counter to limit mount-time log output to first N elements.
let OVERLAY_DEBUG_MOUNT_COUNTER = 0;
const OVERLAY_DEBUG_MOUNT_MAX = 5;
const OVERLAY_DEBUG_MOUNT_COOLDOWN_MS = 2000;

/** Check if runtime overlay debug is enabled via __overlayRuntimeDebug flag */
function isOverlayRuntimeDebugEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as any).__overlayRuntimeDebugEnabled === true
  );
}

/** Reset the mount counter (called after cooldown) */
function resetOverlayDebugMountCounter() {
  OVERLAY_DEBUG_MOUNT_COUNTER = 0;
}

/**
 * 根据屏幕坐标获取光标位置 Range。
 * - Chrome/Safari: document.caretRangeFromPoint(x, y) → Range
 * - Firefox: document.caretPositionFromPoint(x, y) → CaretPosition（需转换为 Range）
 * - 失败返回 null
 */
function getCaretRangeFromPoint(x: number, y: number): Range | null {
  // Chrome/Safari
  if (typeof document.caretRangeFromPoint === "function") {
    return document.caretRangeFromPoint(x, y);
  }
  // Firefox
  const docAny = document as any;
  if (typeof docAny.caretPositionFromPoint === "function") {
    const pos = docAny.caretPositionFromPoint(x, y);
    if (pos && pos.offsetNode) {
      const range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
      range.collapse(true);
      return range;
    }
  }
  return null;
}

interface EditableTextNodeProps {
  segment: Segment;
  isSelected: boolean;
  isEditing: boolean;
  /** Bug 11: 是否允许编辑（true=编辑模式，单击进入编辑；false=浏览模式，文本可选） */
  allowEdit: boolean;
  /**
   * F3B-6.27 · P0-VPS（D1'）：该 segment 是否被**显式多选**纳入跨行范围。
   * 可选且默认 false ⇒ 未接线的调用方**逐字节不变**。
   */
  isMultiSelected?: boolean;
  onSelect: (id: string) => void;
  onStartEdit: (id: string) => void;
  /**
   * F3B-6.27 · P0-VPS（D1'）：Ctrl/Cmd+点击 ⇒ 切换多选集合成员，**不进入编辑**。
   * 未提供 ⇒ Ctrl/Cmd+点击退化为普通点击（保持既有行为）。
   */
  onToggleMultiSelect?: (id: string) => void;
  onChange: (id: string, newText: string) => void;
  onEndEdit: () => void;
}

export function EditableTextNode({
  segment,
  isSelected,
  isEditing,
  allowEdit,
  isMultiSelected: isMultiSelectedProp = false,
  onSelect,
  onStartEdit,
  onToggleMultiSelect,
  onChange,
  onEndEdit,
}: EditableTextNodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [localText, setLocalText] = useState(segment.text);
  const [isHovering, setIsHovering] = useState(false);
  // F3B-6.27 · P0-VPS（D1'）：显式多选状态经**极小 store** 分发（`EditableTextNode` 由
  // 冻结的 `PDFCanvas` 渲染，走 props 必须连带改 PDFCanvas —— 见 multi-selection.ts 头注）。
  // 返回 boolean（稳定标量）⇒ 集合变化时只会重渲"成员/非成员"两类节点各自的必要更新。
  const isMultiSelectedInStore = useSyncExternalStore(
    subscribeMultiSelection,
    () => isMultiSelected(segment.id),
    () => false
  );
  /** prop 注入与 store 两路取或：任一路标为已选即高亮 */
  const multiSelected = isMultiSelectedProp || isMultiSelectedInStore;
  // 记录点击坐标，用于进入编辑模式时定位光标到点击位置
  const clickPosRef = useRef<{ x: number; y: number } | null>(null);
  // M7.8-020-PROD：编辑态记录所在页宽度，用于限制输入不超出页面右边缘
  const [pageWidth, setPageWidth] = useState(0);

  // 同步外部 segment.text 变化（如 undo/redo）
  useEffect(() => {
    if (!isEditing) setLocalText(segment.text);
  }, [segment.text, isEditing]);

  // 进入编辑模式时聚焦 + 定位光标到点击位置
  useEffect(() => {
    if (!isEditing || !ref.current) return;
    // 记录所在页宽度，用于限制编辑不超出页面
    setPageWidth(ref.current.parentElement?.clientWidth || 0);
    // 编辑模式下 React 不渲染 children，需要手动设置初始文本
    // ★★ P0-F1：unit 面**不写** `segment.text` —— unit 的 DOM truth 由 PDFEditor 的
    //   A′ 写入点提供（P0-C/P0-E2-B 冻结的 unit 文本，含显式 structural separator）。
    //   ★ 绝不能在这里写 segment.text：unit 面装的是整段 unit，写单段切片会造成
    //   「文本被截短 + 兄弟段重复」= 历史上的「双 `日期：`」污染源。
    //   （单 paragraph 路径**逐字节不变** ⇒ F1.9 / G5）
    if (!isUnitSurface) ref.current.textContent = segment.text;
    ref.current.focus();

    const pos = clickPosRef.current;
    clickPosRef.current = null;

    // 优先用 caretRangeFromPoint 定位光标到点击位置
    let caretPlaced = false;
    if (pos) {
      const range = getCaretRangeFromPoint(pos.x, pos.y);
      if (range && ref.current.contains(range.startContainer)) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        caretPlaced = true;
      }
    }

    // Fallback：光标放在文本末尾
    if (!caretPlaced && ref.current.firstChild) {
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false); // false = 末尾
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    }
  }, [isEditing]);

  const handleBlur = () => {
    // ★★ P0-F1（D2 批准）：**unit 面 blur 一律 no-submit**。
    //   F1 只把 EditingUnit 接到 DOM surface，**不接 mutation**。
    //   且 `resolveSegmentCommitSlice` 是「whole paragraph DOM → one legacy segment」
    //   契约，而 unit 面是「whole unit DOM → multiple paragraphs / segments」
    //   —— **两者不是同一个 contract**，绝不能让它处理 unit 面。
    //   ★ **不打 console.warn**：no-submit 是**设计行为**，不是异常。
    //   （F1.6 / G4：onChange count === 0、commit count === 0、Legacy segment 不变）
    if (isUnitSurface) {
      onEndEdit();
      return;
    }
    const domText = ref.current?.textContent || "";
    // ── F3B-6.27 提交收口 ────────────────────────────────────────────
    //  整段面（regime A 之外的方案 A 面）提交前必须先按 Binding range 降回本段切片。
    //  非整段面 ⇒ passthrough，text 原样返回 ⇒ 既有行为逐字节不变。
    const ctx = segmentCommitContextFor(segment.id);
    const whole = ctx?.wholeParagraph === true;
    const decision = resolveSegmentCommitSlice({
      domCarriesWholeParagraph: whole,
      domText,
      segmentId: segment.id,
      segmentText: segment.text,
      range:
        whole && ctx
          ? {
              paragraphId: ctx.paragraphId,
              segmentId: ctx.segmentId,
              startUtf16: ctx.startUtf16,
              endUtf16: ctx.endUtf16,
              generation: ctx.generation,
            }
          : null,
      currentParagraphId: whole && ctx ? ctx.paragraphId : null,
      currentGeneration: whole && ctx ? ctx.generation : null,
    });
    if (!decision.ok) {
      // fail-closed：**不** onChange（否则整段回灌 Legacy ⇒ 重现本次缺陷）
      console.warn("[SEGMENT-COMMIT-SLICE] fail-closed：整段面缺合法 range，本次不提交", {
        segmentId: segment.id,
        reason: decision.reason,
      });
      onEndEdit();
      return;
    }
    const newText = decision.text;
    if (newText !== segment.text) {
      onChange(segment.id, newText);
      setLocalText(newText);
    }
    onEndEdit();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      ref.current?.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setLocalText(segment.text); // 撤销编辑
      // ★ D-3B-6 子任务 2B·F3″（2026-10-17，用户批准）：Escape 撤销必须**同步恢复
      //   contenteditable DOM**。`setLocalText` 只改 React state，而编辑模式不渲染
      //   children（:828-830）⇒ DOM 仍持有 A′ 写入的整段 unit 文本（实测 41 字）；
      //   随后的 `blur()` ⇒ handleBlur 读到 41 字 ⇒ 此刻 `isUnitSurface` 因 rebind
      //   后 ownedSegmentId 失配为 false（core-input-visual.ts:272 ctx=null）⇒
      //   `resolveSegmentCommitSlice` **passthrough** ⇒ onChange(41) ⇒
      //   commitSegmentCanonical ⇒ Core para_43 污染（Escape/reopen 后 46 字）。
      //   DOM 同步恢复后 domText === segment.text ⇒ handleBlur 的 onChange 分支
      //   （:235 `newText !== segment.text`）确定不触发 ⇒ 零提交 ⇒ 零 Core 写入。
      //   ★ unit 面输入逐键提交（beforeinput → Core 事务）⇒ Escape 时 Core 已含
      //     全部输入 ⇒ 恢复 DOM 不丢数据（Escape 语义 = 撤销**展示**，非撤销 Core）。
      //   ★ isUnitSurface 经 useSyncExternalStore 订阅（:481-487）⇒ 此处为最新值。
      if (!isUnitSurface && ref.current && ref.current.textContent !== segment.text) {
        ref.current.textContent = segment.text;
      }
      ref.current?.blur();
    }
  };

  // M7.8-034 Phase A: 移除 measureTextWidth / wouldExceedWidth / handleBeforeInput / handlePaste。
  // 这套「按页面右边缘拦截输入」的机制本身就是编辑态排版异常的来源之一：
  // 它把编辑容器宽度与页面右边缘绑定，配合 justify 会拉伸文本；
  // 且输入被静默吞掉（preventDefault）会让用户困惑。
  // 新模型：不限制输入长度，文本自然变长，编辑框跟着变长。

  // ── Sprint 33.5.9: Runtime Overlay Transform Debug (mount-time) ──
  // On mount, capture the actual DOM computed style and parent transform chain.
  // Gated behind window.__overlayRuntimeDebugEnabled = true.
  // Only logs first OVERLAY_DEBUG_MOUNT_MAX elements per cooldown window.
  const segmentForDebug = useMemo(() => ({ ...segment }), []); // snapshot at mount
  useEffect(() => {
    if (!isOverlayRuntimeDebugEnabled()) return;

    let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

    // Use rAF to wait for browser layout to complete before measuring
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;

      if (OVERLAY_DEBUG_MOUNT_COUNTER >= OVERLAY_DEBUG_MOUNT_MAX) {
        return;
      }
      OVERLAY_DEBUG_MOUNT_COUNTER++;

      const isFirst = OVERLAY_DEBUG_MOUNT_COUNTER === 1;

      // Cooldown: reset counter after N seconds so next batch of mounts gets logged
      if (OVERLAY_DEBUG_MOUNT_COUNTER === OVERLAY_DEBUG_MOUNT_MAX) {
        cooldownTimer = setTimeout(resetOverlayDebugMountCounter, OVERLAY_DEBUG_MOUNT_COOLDOWN_MS);
      }

      const computed = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();

      // Walk parent chain and collect CSS transforms (up to 3 levels)
      const transforms: { level: string; tag: string; className: string; transform: string }[] = [];
      let current: HTMLElement | null = el.parentElement;
      let level = 1;
      while (current && level <= 3) {
        const t = window.getComputedStyle(current).transform;
        transforms.push({
          level: level === 1 ? "parent" : level === 2 ? "grandparent" : "great-grandparent",
          tag: current.tagName.toLowerCase(),
          className: (current.className || "").substring(0, 40),
          transform: t === "none" ? "none" : t,
        });
        current = current.parentElement;
        level++;
      }

      // Final effective scale: multiply all matrix scales from transform chain
      let finalScale = 1;
      let testEl: HTMLElement | null = el;
      while (testEl) {
        const t = window.getComputedStyle(testEl).transform;
        if (t && t !== "none") {
          const vals = t.match(/matrix\(([^)]+)\)/);
          if (vals) {
            const parts = vals[1].split(",").map(Number);
            // For a uniform scale matrix: scaleX = a (matrix[0]), scaleY = d (matrix[3])
            const sx = Math.sqrt(parts[0] * parts[0] + parts[1] * parts[1]);
            finalScale *= sx;
          }
        }
        testEl = testEl.parentElement;
      }
      const scaledFontSize = parseFloat(computed.fontSize) * finalScale;

      if (isFirst) {
        console.group(
          "%c[Sprint33.5.9] Overlay Mount Debug — First Element",
          "font-weight:bold;color:#a855f7;",
        );
      } else {
        console.group(
          "%c[Sprint33.5.9] Overlay Mount Debug #" + OVERLAY_DEBUG_MOUNT_COUNTER,
          "color:#a855f7;",
        );
      }

      const expectedFontSize = segmentForDebug.font.size;
      const delta = parseFloat(computed.fontSize) - expectedFontSize;

      console.log(
        "%cElement%c %s %c\"%s\"",
        "color:#94a3b8;",
        "",
        el.tagName.toLowerCase(),
        "color:#f59e0b;",
        segmentForDebug.originalText.substring(0, 30),
      );
      console.log(
        "%c  fontSize: computed=%c%s%c expected=%c%s%c delta=%c%s",
        "color:#94a3b8;",
        "color:#22c55e;font-weight:bold;",
        computed.fontSize + "px",
        "color:#94a3b8;",
        "color:#06b6d4;",
        expectedFontSize + "px",
        "color:#94a3b8;",
        delta === 0 ? "color:#22c55e;" : "color:#ef4444;font-weight:bold;",
        delta === 0 ? "0" : (delta > 0 ? "+" : "") + delta + "px",
      );
      console.log(
        "%c  lineHeight: %c%s",
        "color:#94a3b8;",
        "",
        computed.lineHeight,
      );
      console.log(
        "%c  own transform: %c%s",
        "color:#94a3b8;",
        "",
        computed.transform,
      );
      console.table(transforms, ["level", "tag", "className", "transform"]);
      console.log(
        "%c  finalScale (chain): %c%s",
        "color:#94a3b8;",
        finalScale !== 1 ? "color:#ef4444;font-weight:bold;" : "color:#22c55e;",
        finalScale.toFixed(4) + (finalScale !== 1 ? " ⚠️" : ""),
      );
      console.log(
        "%c  scaled font size: %c%s",
        "color:#94a3b8;",
        "color:#f59e0b;",
        scaledFontSize.toFixed(2) + "px",
      );
      console.log(
        "%c  layout rect (browser): x=%c%d%c y=%c%d%c w=%c%d%c h=%c%d",
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(rect.x),
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(rect.y),
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(rect.width),
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(rect.height),
      );
      console.log(
        "%c  expected position: cssX=%c%d%c cssY=%c%d%c cssW=%c%d%c cssH=%c%d",
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(segmentForDebug.cssX),
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(segmentForDebug.cssY),
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(segmentForDebug.cssW),
        "color:#94a3b8;",
        "color:#06b6d4;", Math.round(segmentForDebug.cssH),
      );

      if (delta !== 0) {
        console.warn(
          "  %c⚠️ fontSize MISMATCH: computed %spx ≠ expected %spx (delta: %spx)",
          "color:#ef4444;font-weight:bold;",
          computed.fontSize,
          expectedFontSize,
          (delta > 0 ? "+" : "") + delta,
        );
      }
      if (finalScale !== 1) {
        console.warn(
          "  %c⚠️ Parent transform chain has non-identity scale: %s×",
          "color:#ef4444;font-weight:bold;",
          finalScale.toFixed(4),
        );
      }

      console.groupEnd();
    });

    return () => {
      cancelAnimationFrame(raf);
      if (cooldownTimer) clearTimeout(cooldownTimer);
    };
  }, [isEditing]); // re-run if editing state changes (re-mount element)

  const { font, cssX, cssY, cssW, cssH } = segment;

  // M7.8-034 Phase A：编辑态不再限制宽度上限。
  // 原实现 maxEditWidth = max(cssW, pageWidth - cssX)（到页面右边缘）会让编辑容器被撑到
  // 远大于段宽的尺寸；再叠加编辑态沿用 segment.textAlign，当原文为 justify 时，
  // 文本被两端对齐**拉伸**满容器 → 用户报告的「编辑态下文本被拉长」。
  // 正确产品模型：原字体/字号不动，文本自然变长，编辑框跟着变长（不做任何拉伸/缩放）。
  //   · 不设 maxWidth → 容器随内容自然伸展
  //   · 编辑态固定 left 对齐、禁用 textAlignLast → 杜绝 justify 拉伸

  // 重影修复策略：
  //   - PDF.js canvas 已渲染原始 PDF 文字（位图，最底层）
  //   - SEGMENTS LAYER 叠加在 canvas 上方
  //   - 未修改 segment：文字 + 背景全透明（看到底层 canvas 原文，避免重影）
  //   - 修改过的 segment（text !== originalText）：不透明文字 + 白色背景 + 黄色高亮边框
  //   - hover：浅蓝背景提示（未修改时文字仍透明）
  //   - 选中：浅紫背景 + 紫色边框
  //   - 编辑：白色背景 + 不透明文字
  const isModified = segment.text !== segment.originalText;
  const showText = isEditing || isModified;

  // ── EDITOR-CORE-012-E2（方案 B）─────────────────────────────────────
  // Core 输入模式下，本节点的 DOM 文本**不再承担文本视觉显示**：
  //   DOM  = input surface（contentEditable / beforeinput / IME / DOM selection）
  //   Core RenderFrame = 唯一文本视觉结果
  // 判定来自外部 store：`__coreInput === true` **且** 该 segment 已被 Core session 接管。
  // legacy 模式（或尚未被接管）→ false → 视觉行为逐字节不变。
  //
  // ⚠️ 这里**不做** Core → DOM text 投影（E2 明确禁止），也不改 localText。
  //
  // ★ F3B-6.27-G6 例外（2026-10-04 裁决，详见 components/core-editing-visual.test.ts 头注
  //   「E2-EXCEPTION」）：**编辑态输入面**是另一个语义 —— Core mutation 成立后，
  //   若本面仍停在进入编辑时的旧文本，caret 会封顶、点右边缘会掉出编辑面
  //   （实测：编辑前 DOM/Core 逐字逐宽一致 13/13、280/280；编辑后 DOM 13 / Core 14）。
  //   例外只允许在「isEditing ∧ Core-owned ∧ 已有 Core current text」时把
  //   **Core 段落文本**同步进本 contenteditable 的 textContent，并用既有
  //   `reconcileDomCaretAtOffset` 恢复 caret。
  //   例外**不**放宽：非编辑态 display / mask / `segment.text` / `originalText`
  //   / glyph·x·DOM 反推 / 新建 segment。**接线在 Step 3 落地**，此处尚未启用。
  const domTextSuppressed = useSyncExternalStore(
    subscribeCoreInputVisualState,
    () => isDomTextSuppressed(segment.id, isEditing, segment.source?.lineId ?? null)
  );

  // ── F3B-6.27 · S2（UNIT-MEMBER-VISIBILITY · V1）：非宿主 unit 成员文本隐藏 ──
  //   现象：unit 编辑期间非宿主成员 segment 的原文仍可见（z100，画在宿主 surface
  //   白底 / C3 clear 层之上）⇒ 与 Core 新布局叠加（用户报告的重复行）。
  //   修法（用户锁定 V1）：把 unit 成员身份纳入编辑态可见性规则 —— 活动 unit 的
  //   成员行上的 segment，其 original DOM 文本在编辑态一律不可见。
  //   ★ 与 `domTextSuppressed`（宿主判据∨成员判据的并集）**分开消费**：
  //     并集对宿主也为 true，但宿主文本必须保持可见（F3B-6.27-D2 设计）⇒
  //     着色隐藏只用**成员判据**（显式排除 ownedSegmentId）。
  //   ★ 不经 editingSurface / corePresentationActive ⇒ S1 缺陷态（几何被置空）
  //     下依然有效。
  const unitMemberTextHidden = useSyncExternalStore(
    subscribeCoreInputVisualState,
    () => isUnitMemberSegment(segment.id, segment.source?.lineId ?? null, isEditing)
  );

  // ── F3B-6.27 Step 2：编辑面几何（多视觉行时非 null）──
  //   经**既有**的极小 store 分发，因为 PDFCanvas.tsx 是冻结文件不能加 prop
  //   （该 store 的设计意图正是如此，见 core-input-visual.ts 头注）。
  //   仅 isEditing 消费；单行场景 store 恒为 null ⇒ 行为逐字节不变。
  const editingSurface: EditingSurfaceGeometry | null = useSyncExternalStore(
    subscribeCoreInputVisualState,
    () => {
      const st = getCoreInputVisualState();
      return st.ownedSegmentId === segment.id ? st.editingSurface : null;
    }
  );

  // ★★ P0-F1（D2 / F1.6）：本面是否为**显式 EditingUnit 面**。
  //   判据只读 store 的 **identity**（`unitId`），**不读文本**（store 不存文本）。
  //   unit 面与单 paragraph 面的**关键差异**（两条硬约束都挂在这个判据上）：
  //     ① 进入编辑时**不得**写 `segment.text`（否则覆盖 unit 文本 = "双 日期："污染源）
  //     ② blur **不得**提交（no-submit：F1 不接 mutation）
  const isUnitSurface = !!editingSurface && !!editingSurface.unitId;

  // M7.8-014F: cssY 是 PDF 基线(baseline)，不是 bbox 顶。
  // GlyphRenderer 渲染原文用 spanTop = baseline - cssAscent；
  // 若 EditableTextNode 直接 top:cssY，文字基线会被顶到 cssY+cssAscent（下移约一行），
  // 视觉上表现为“夹在两行之间”。这里测量字体 actualBoundingBoxAscent 并上移对齐基线。
  // M7.8-020-PROD：优先用统一解析出的字体 family（embedded/system/fallback），
  // 不再直接把 pdf.js 内部 loadedName 或 FontAnalyzer 的 Arial 映射作为 PDF 字体默认解。
  // 优先级：bridge 真实字形 > segment.font.family > fontResolution 通用族名 > 绝对兜底
  //
  // M7.8-034 说明：
  //   · embedded → editableFontFamily 是隔离 namespace 的 bridge family（__pdfsail_pdf_font_*，
  //     与 canvas 同一份字体字节），必须最优先，否则会退化成系统字体。
  //   · fallback → SegmentBuilder 已把 seg.font.family 置为 editableFontFamily
  //     （= PDF.js 的 fallbackName，如 "sans-serif"），即**与 canvas 同源**；
  //     这里取 segment.font.family 与取 resolutionFamily 是同一个值。
  //     不要在此处改回 document 字体栈（"'Proxima Nova', Arial, …"）——实测那样会与
  //     canvas 的 sans-serif 不同源，提交后字形肉眼可辨地不一致。
  const resolutionFamily = segment.fontResolution?.editableFontFamily;
  const isBridgeResolution =
    !!resolutionFamily && resolutionFamily.startsWith("__pdfsail_pdf_font_");
  const fontFamily =
    (isBridgeResolution ? resolutionFamily : null) ??
    segment.font?.family ??
    resolutionFamily ??
    (segment as any).pdfjsFontFamily ??
    FALLBACK_FONT_FAMILY;
  // Bridge 字体每个 family 只注册了一个具体字重/样式的字体文件（如 DejaVuSans-Bold）。
  // 若再叠加 segment.font.weight，浏览器会对已 bold 的文件做合成加粗，导致字重失真。
  // 对 Bridge 字体统一用 normal，让唯一字体文件自己表达字重/倾斜。
  const isBridgeFont = fontFamily.startsWith("__pdfsail_pdf_font_");
  const effectiveWeight = isBridgeFont ? "normal" : font.weight;
  const effectiveStyle = isBridgeFont ? "normal" : (font.style || "normal");
  // M7.8-020-PROD：根因修复——直接测量浏览器对“当前字体”实际排版的基线偏移，
  // 而不是用 canvas 的 fontBoundingBoxAscent / 经验 0.72 估算。
  // fontBoundingBoxAscent 是字体内最大字形升部，≠ CSS 行盒基线位置，不同字体偏差方向不一，
  // 导致有的 PDF 上移、有的下移。这里用零高 inline-block 标记基线，量得的就是渲染基线。
  const cssAscent = useMemo(() => {
    try {
      const wrap = document.createElement("span");
      wrap.style.position = "absolute";
      wrap.style.visibility = "hidden";
      wrap.style.fontSize = `${font.size}px`;
      wrap.style.fontFamily = fontFamily;
      wrap.style.fontWeight = effectiveWeight;
      wrap.style.fontStyle = effectiveStyle;
      wrap.style.lineHeight = "1";
      wrap.style.whiteSpace = "nowrap";
      // 末尾零高 inline-block 的顶边即为文本基线
      wrap.innerHTML = `x<span style="display:inline-block;height:0;width:0;"></span>`;
      document.body.appendChild(wrap);
      const baseline =
        (wrap.lastChild as HTMLElement).getBoundingClientRect().top -
        wrap.getBoundingClientRect().top;
      document.body.removeChild(wrap);
      if (baseline && baseline > 0) return baseline;
    } catch { /* noop */ }
    return font.size * 0.72;
  }, [fontFamily, font.size, effectiveWeight, effectiveStyle]);
  const alignedTop = segment.cssBaseline - cssAscent;

  // ── F3B-6.27 Step 2：编辑面几何（仅 isEditing 消费；isModified 刻意不套用）──
  //   Core `runLiveReflow` 把超宽段落软折行成多个视觉行，而 baseStyle 里既有的
  //   `whiteSpace: nowrap` + 固定单行 `height` + `overflow:hidden` 会把折行部分
  //   **裁掉**（用户报告的"只能单行编辑"）。editingSurface 非 null 时改用多行几何。
  //   ⚠️ 这里**刻意推翻** M7.8-014B 的旧约束（"编辑态高度固定 cssH，禁止高度膨胀
  //   导致提交错位"）—— 那条约束正是单行裁剪的成因；取舍显式记录，不做隐性改动。
  //   ⚠️ 宽度取 Core 的 requiredWidth 而非 auto：浏览器自然换行点实测比 Core 边界
  //   晚 1 个字符（Gate: offset 33 vs 32），宽度不足还会**额外**折行。
  const surfaceActive = isEditing && !!editingSurface;
  // ★★ 2026-10-18（用户缺陷「编辑框内两行行距太近，没有与原文行间距相等」）：
  //   unit 多行面的行距必须 = 原文行距（lineGap，来自成员行 Core 行盒 y 差，
  //   与提交层 flow 的 usedLineGap 同源）。baseStyle 的 `lineHeight: 1`
  //   （M7.8-014F，单行面语义：基线严格位于元素顶 + cssAscent）被继承 ⇒ 行距
  //   只有字号 21.46px，而原文行距实测 41.97px。
  //   ★ 半 leading 补偿：line-height > fontSize 时浏览器把文字**垂直居中**于行盒
  //     ⇒ 首行基线 = 面顶 + (lineGap − fontSize)/2 + cssAscent，比原基线低半个
  //     leading。用 `marginTop = −(lineGap − fontSize)/2` 把面上移等量，首行基线
  //     回到 `alignedTop + cssAscent`（M7.8-014F 语义在 unit 面重建；2.55px
  //     Core↔DOM 配准不回归）。clamp ≥ 0：行距 ≤ 字号时不上移（免白底露原文）。
  //   ★ 仅 unit 面（unitId 存在）生效；单段面（editingSurface === null 或无
  //     lineGap）**不加入这两个 key** ⇒ baseStyle 的 lineHeight:1 原样生效。
  const unitLineGap = editingSurface?.unitId ? editingSurface.lineGap ?? 0 : 0;
  const unitHalfLeading = unitLineGap > 0 ? Math.max(0, (unitLineGap - font.size) / 2) : 0;
  // ★★ F3B-6.27 · P0-SURFACE-Y（方案 A）：编辑面**不再覆盖 `top`**。
  //
  // 根因（真实 Chromium 实测，gd-swim-2026.pdf / FangSong_GB2312）：
  //   Core line box 的 y 是「**字形墨迹顶**」，而 legacy segment 的 `top` 是
  //   `alignedTop = segment.cssBaseline − cssAscent`（**基线对齐**，见 :460）。
  //   二者对同一行实测差 **+2.55px**（pre-edit `top=361.6` vs post-edit `top=364.15`，
  //   同层偏移 152.8 相同 ⇒ rect.y 514.39 → 516.94）。
  //   ⇒ ①编辑面整体下移 2.55px = 用户报告的「位置不一致」
  //     ②原字墨迹顶 514.39 < 白面顶 516.94 ⇒ 顶部露出 2.55px 窄条 = 「原文本残留」
  //   已排除：re-parent/portal（offsetParent 链 4 层一致）、position 变化、
  //           行盒/leading（range.h 与 lineHeight 前后相同）。
  //
  // 修法（最小面）：**垂直位置完全交回 legacy** —— 删掉 `top` 覆盖，继承 baseStyle 的
  // `alignedTop`（Δ=0 可证，与编辑前逐字节同位）；Core 仍贡献换行所必需的 `width`，
  // 而 `height` 改用 `coreBottom − alignedTop`（两者同处一个 CSS px 空间，可直接相减），
  // 使白面覆盖 `[alignedTop, coreBottom]`，**完整包含**原始墨迹 `[coreTop, coreBottom]`。
  //
  // 为什么不改 `left`：实测 `left` 编辑前后 Δ=0（366.17 → 366.17），本就没有漂移；
  // 删掉它反而会在 Core reflow 出多行（union.x0 ≠ cssX）时给首行起点引入新风险。**保持原样。**
  // 为什么不用 Core 的 `top`：`coreTop/coreBottom` 在生产逻辑零消费（仅 `__editingSurfaceGeometry`
  // 观测 hook），本改动不新增任何数据通路。
  //
  // 不动 `baseStyle` ⇒ 非编辑态、以及 `editingSurface === null` 的单行编辑面**逐字节不变**。
  const surfaceHeight = editingSurface ? editingSurface.coreBottom - alignedTop : 0;
  // ★ 2026-10-25（用户缺陷「紫色编辑框要加宽，不能换行」）：**cell 面**判据（unitId =
  //   `unit:cell:` 前缀，S2-v1 确定性派生；字面量与 binding/table-cell-unit.ts 的
  //   CELL_UNIT_ID_PREFIX 一致，由该测试文件的 G 守卫锁定防漂移）。
  //   cell 面宽度此前 = 格子墨迹盒宽（规划器 cellBox 约束）⇒ 输入比原格内容长就在
  //   面内折行（用户截图 "32.5/0" 两行，白底面高膨胀超出格高）。
  //   修复 = cell 面 `width: max-content`（白底随输入内容生长）+ `white-space: pre`
  //  （恒单行不折行），`minWidth` 保持墨迹盒宽 ⇒ 未输入时白底仍完整盖住原格。
  //   正文 unit 面与单段面（unitId 缺失）的宽度/换行**逐字节不变**。
  const isCellSurface =
    !!editingSurface && !!editingSurface.unitId && editingSurface.unitId.startsWith("unit:cell:");
  const surfaceStyle: React.CSSProperties = surfaceActive
    ? {
        left: editingSurface!.left,
        width: isCellSurface ? "max-content" : editingSurface!.width,
        minWidth: editingSurface!.width,
        maxWidth: "none",
        height: editingSurface!.unitId ? "auto" : surfaceHeight,
        minHeight: surfaceHeight,
        textIndent: editingSurface!.textIndent,
        // ★ 连续编辑视图·第一阶段（2026-10-18 用户授权）：**unit 面**（multi-member，
        //   geometry.unitId 存在）改用 `normal` —— 结构性 separator "\n" 在 normal 下
        //   渲染为**空格**而非强制换行 ⇒ 成员文本连续折行，词中拆分尾字（"补"/"400"/"混"）
        //   不再被强制成孤立行（用户截图缺陷；提交层软边界合并语义与此一致）。
        //   ★ DOM 文本**零改动**（仍含 "\n"）⇒ unit route 偏移映射 / A′ 门 / 2B 播种 /
        //     F5 恢复 / reconcile 全部按既有 unit 文本口径工作，零输入路由风险。
        //   ★ 折行点由浏览器按宽度决定（与提交层 flow 的 PDF advance 有 ±2% 差，
        //     为已知边界）；单段面（unitId 缺失）保持 pre-wrap 逐字节不变。
        //   ★ 2026-10-25：cell 面 = `pre`（恒单行，配合 max-content 宽度永不折行；
        //     cell 切片无 separator "\n"，pre 不引入新语义）。
        whiteSpace: editingSurface!.unitId ? (isCellSurface ? "pre" : "normal") : "pre-wrap",
        // ★ 2026-10-18（行距修复）：unit 面行距 = 原文行距 + 半 leading 补偿。
        //   条件展开：无 lineGap 时**不出现这两个 key**（否则会用 undefined 覆盖
        //   baseStyle 的 lineHeight:1，破坏单段面逐字节不变）。
        ...(unitLineGap > 0
          ? { lineHeight: `${unitLineGap}px`, marginTop: `${-unitHalfLeading}px` }
          : {}),
        // ── F3B-6.27 Step 2 修正：`word-break` 必须退出 keep-all ──
        // baseStyle 的 `wordBreak: "keep-all"`（Sprint34.3「编辑态禁止单词内部断行」）
        // 在**单行**编辑面成立；但编辑面一旦由 Core 驱动变成**多行**面，行的边界就由
        // Core 决定，`keep-all` 会与 Core 折行直接冲突。
        // 实测（gd-swim-2026.pdf，标题行 Core 折成 2 行 17+14 字，宽 423.81px）：
        //   keep-all  ⇒ DOM 产生 **3 个行盒**（行1 仅 "2026 年" = 66px，行2 413px，
        //                行3 354px；Range.getClientRects() 为权威行盒）
        //              ⇒ 3 × 29.53 = 88.6 > height 59.06 + overflow:hidden
        //              ⇒ **末行被裁**（scrollHeight 91 > clientHeight 59）
        //   normal    ⇒ 对照组同字体同宽仅 **2 行**（断点 offset 18）
        // 机理：keep-all 让"年广东省…"整段成为不可断单元，浏览器只肯在 offset 6
        //       后的空白处断，再用 break-word 硬切剩余部分 ⇒ 多出一个行盒。
        // ⚠️ 只在 surfaceActive 时放开；单行编辑面（editingSurface === null）逐字节不变。
        wordBreak: "normal",
        // 同理：外部样式表可能带来 `line-break: after-white-space`（非标准值），
        // 它同样会改变断行点，必须在 Core 驱动的多行面上显式复位。
        lineBreak: "auto",
      }
    : {};

  // ── M7.8-034 Phase A: 移除 horizontal scaling（scaleX）──
  // 旧实现（M7.8-020-PROD）测量文字在当前字体下的自然宽度，再按 PDF 期望宽度 cssW 做
  // scaleX，把字宽/右边缘强行对齐原文。这正是「编辑后字体被缩放」的根源：
  //   文字一变长 → 被硬塞进固定 cssW → 视觉上表现为字形被压扁。
  // 产品模型已改为：原字体、原字号一律不动，文本自然变长，容器跟随内容伸展。
  // 因此这里**不再做任何宽度测量与横向缩放**，只按内容自适应。
  //
  // 分段几何策略：
  //   - 编辑态        : auto（随输入伸展）
  //   - 已修改（可见）: max-content（容器=文本自然宽度，白底才能完整遮挡 canvas 原文）
  //   - 未修改（透明）: cssW（保持 PDF 原始命中区域，文字透明故宽度差异不可见）
  const isUnchanged = segment.text === segment.originalText;
  const boxWidth = isEditing ? "auto" : isModified ? "max-content" : cssW;
  const boxMinWidth = isModified ? 0 : cssW;
  const boxMaxWidth = isEditing ? "none" : isModified ? "none" : cssW;

  // M7.8-020-PROD：诊断——编辑/修改段是否真的命中 bridge 字体（而非 fallback 到系统字体）。
  useEffect(() => {
    if (!isEditing && !isModified) return;
    try {
      const spec = `${effectiveWeight} ${font.size}px ${fontFamily}`;
      const fontReady = document.fonts.check(spec);
      const el = ref.current;
      const cs = el ? getComputedStyle(el) : null;
      console.log(
        "[M7.8-020-PROD][FONT-DIAG]",
        JSON.stringify({
          id: segment.id,
          source: segment.fontResolution?.source,
          rawFontName: segment.font.rawFontName,
          metaName: segment.fontResolution?.metaName,
          fallbackName: segment.fontResolution?.fallbackName,
          bridge: isBridgeFont,
          family: fontFamily,
          weight: effectiveWeight,
          style: effectiveStyle,
          size: font.size,
          color: font.color,
          textAlign: segment.textAlign,
          hz: Math.round((segment.hz ?? 1) * 1000) / 1000,
          cssAscent: Math.round(cssAscent * 100) / 100,
          cssW: Math.round(cssW * 100) / 100,
          // M7.8-034 Phase A: scaleX/naturalWidth 已移除（禁止横向缩放）。
          boxWidth: boxWidth === "max-content" ? "max-content" : Math.round((boxWidth as number) * 100) / 100,
          fontReady,
          computedFamily: cs?.fontFamily,
          renderedWeight: cs?.fontWeight,
          renderedStyle: cs?.fontStyle,
        })
      );
    } catch { /* noop */ }
  }, [isEditing, isModified, fontFamily, font.size, effectiveWeight, effectiveStyle, cssAscent, isBridgeFont, cssW, segment.text, segment.textAlign]);
  const baseStyle: React.CSSProperties = {
    position: "absolute",
    left: cssX,
    top: alignedTop,
    // M7.8-013: 非编辑态锁定 width=cssW，严格服从 PDF segment 几何。
    // M7.8-014B: 编辑态宽度随内容自动伸展（auto），避免被 cssW 截断导致换行/错位。
    // M7.8-020-PROD: 字宽与画布不一致时，把容器缩到自然宽度再做 scaleX，保证视觉宽度=cssW。
    width: boxWidth,
    minWidth: boxMinWidth,
    // M7.8-034 Phase A: 编辑态不再设 maxWidth。
    // 原 maxEditWidth = max(cssW, pageWidth - cssX) 把容器撑到页面右边缘，
    // 与 justify 组合后会把文本两端对齐拉伸 → 「编辑态下文本被拉长」。
    maxWidth: isEditing ? undefined : boxMaxWidth,
    // M7.8-034 Phase A: 编辑态固定左对齐，不沿用原文的 justify。
    // justify 会按容器宽度重新分配字间距，必然改变字宽——与「保持原文排版」冲突。
    textAlign: "left",
    textAlignLast: undefined,
    // M7.8-034 Phase A: 不再施加 scaleX 横向缩放（原字体/字号/字宽一律保持原文）。
    transform: undefined,
    transformOrigin: undefined,
    // M7.8-014B: 编辑态高度固定为 cssH，保持编辑框在原文行位置，禁止换行后高度膨胀导致提交错位。
    height: cssH,
    minHeight: cssH,
    fontFamily,
    fontSize: font.size,
    fontWeight: effectiveWeight,
    fontStyle: effectiveStyle,
    // ★ F3B-6.27-D2：Core 接管时 **DOM 成为唯一可见文字真值**（不再抑制自己）。
    //   E2.1 曾把接管段的 DOM 文字/caret 设透明、底色设 transparent，于是屏幕上
    //   只剩 ① PDF 原字（PDF 原始 advance 几何）+ ② Core 度量画的 CaretLayer caret。
    //   两套几何不同源 ⇒ 三个用户症状：按看到的字去点光标落到别处、方向键"到不了最右"、
    //   以及"两个图层"（字是一层、caret 框是另一层且不贴合）。
    //   实测（gd-swim-2026.pdf / 真实 Chromium）：
    //     · DOM 自然排版宽度 === Core 字形宽度（515.61px === 515.61px，仅 0.99px 恒定偏移）
    //     · DOM selection、点击定位（0.15/0.3/0.45/0.6/0.75/0.9 → 6/13/16/20/24/27 单调）、
    //       方向键逐步（16→17→…→22）到段末（29）**全部正确**
    //   ⇒ 唯一缺陷就是被隐藏。删除抑制即可让 caret 与所见文字同源。
    //   ⚠️ 判据本身（ownedSegmentId === segmentId）语义未变，仍只对 Core 接管段生效，
    //      legacy 路径（domTextSuppressed === false）行为逐字节不变。
    color: showText && !unitMemberTextHidden ? font.color : "transparent",
    // ★ D2：接管态用**浏览器原生 caret**（不再隐藏）。它是 DOM 排版的一部分，
    //   因此必然与用户看到的文字对齐；Core 度量画的 CaretLayer caret 与之重合。
    caretColor: domTextSuppressed ? font.color : undefined,
    // M7.8-020-PROD：PDF.js 画布用灰度抗锯齿渲染文字，而 DOM 默认次像素(LCD)抗锯齿，
    // 后者会让字看起来更黑更粗。这里强制灰度 AA，让 overlay 墨迹与画布一致。
    WebkitFontSmoothing: "antialiased",
    MozOsxFontSmoothing: "grayscale",
    // M7.8-014F / M7.8-020-PROD: line-height 必须固定为 1，使文字基线
    // 严格位于元素顶 + cssAscent 处。normal 会按字体加 leading，把基线往下推，
    // 导致 overlay 下移、露出原文。
    lineHeight: 1,
    padding: 0,
    paddingTop: 0,
    margin: 0,
    // M7.8-006：边框改用 boxShadow / outline 渲染（不占布局），避免 1px/2px 边框把文字内容
    // 内缩，从而保证 EditableTextNode 文字墨迹与 PDF 原始 glyph 墨迹完全重合（不修改命中/编辑逻辑）。
    border: "0 solid transparent",
    boxShadow: isEditing
      ? "inset 0 0 0 2px #8b5cf6"
      : isSelected
      ? "inset 0 0 0 2px #8b5cf6"
      : isModified
      ? "inset 0 0 0 2px rgba(250,204,21,0.7)"   // V12: 已修改段黄色高亮边框（不再配白底）
      : "none",
    // F3B-6.27 · P0-VPS（D1'）：显式多选中的 segment 用绿色实线标出，
    // 让用户看得到"哪几段被圈进范围"。用 outline（不占布局），与既有 hover 虚线同一手法。
    outline: multiSelected
      ? "2px solid #22c55e"
      : isHovering
      ? "1px dashed rgba(59,130,246,0.4)"
      : "none",
    outlineOffset: multiSelected ? "-2px" : isHovering ? "-1px" : "0",
    borderRadius: 2,
    // M7.8-014B: 编辑态强制 nowrap + overflow visible，禁止编辑框内换行、避免提交后几何落到两行之间。
    whiteSpace: "nowrap",
    overflow: isEditing ? "hidden" : "visible",
    // Sprint34.3: 编辑态 wordBreak 用 keep-all，禁止单词内部断行
    wordBreak: isEditing ? "keep-all" : "normal",
    cursor: isEditing ? "text" : allowEdit ? "pointer" : "text",
    // ★ F3B-6.27-D2：接管段需要**不透明白底**遮住 ① PDF.js canvas 原字
    //   （否则 DOM 文字与原字同位叠加 = 真正的"两个图层"重影）。
    //   本元素 zIndex=100 > pdf-canvas(0)，白底即可自然遮挡，无需另加 mask 层。
    //   Core glyph span 在接管态不渲染（实测 totalSpans=0），故白底不会挡住 Core 层。
    background: isEditing
      ? "#ffffff"                    // M7.8-014E: 编辑态不透明白底，彻底遮挡底层原文
      : isModified
      ? "#ffffff"                  // M7.8-020-PROD：不透明白底遮挡 canvas 原文，避免重影导致颜色加深
      : isSelected
      ? "rgba(139,92,246,0.1)"
      : isHovering
      ? "rgba(59,130,246,0.08)"
      : "transparent",
    transition: "background 0.15s, border 0.15s, box-shadow 0.15s",
    pointerEvents: "auto",
    boxSizing: "border-box",
    // M7.8-014D: EditableTextNode 必须始终高于 segment-mask (z40) / glyph 层 (z30)，
    // 否则提交后非编辑态会被白色遮罩盖住，出现“文本空白”。
    // ★★ 2026-10-19（用户缺陷「点'100'光标停在'400'，只有第 1 行可以编辑」）：
    //   编辑态宿主面必须在**同层兄弟 segment 之上**。根因（实测 hittest，_out/user1019/）：
    //   unit 多行面覆盖 N 个成员行区域，而行 2..N 的**透明非宿主兄弟 segment**（原文层）
    //   与宿主面完全重叠且 DOM 靠后 ⇒ 同 zIndex 下 hit-test 兄弟赢（实测
    //   caretRangeFromPoint 15 采样 14 个 inHost=false）⇒ 点击行 2..N 的 caret/输入
    //   落错位置。+1（仅 isEditing 宿主，同一时刻唯一）⇒ 宿主面赢得 hit-test ⇒
    //   浏览器原生 caret 放置直接正确；非成员段与面盒不相交 ⇒ 点击切换编辑目标不受影响。
    zIndex: isEditing ? RenderLayer.EDITOR + 1 : RenderLayer.EDITOR,
    // Bug 11: 浏览模式允许文字选择；编辑模式禁止选择（改为 click 进入编辑）
    userSelect: isEditing ? "text" : allowEdit ? "none" : "text",
    WebkitUserSelect: isEditing ? "text" : allowEdit ? "none" : "text",
    // ★ F3B-6.27 Step 2：编辑面几何**最后展开** —— 必须覆盖上面既有的
    //   `width/height/whiteSpace`（nowrap + 单行），否则多行几何不生效。
    ...surfaceStyle,
  };

  return (
    <div
      ref={ref}
      style={baseStyle}
      contentEditable={isEditing}
      suppressContentEditableWarning
      data-segment-id={segment.id}
      // ★ F3B-6.27-STEP①：编辑面是 **paragraph 级**对象，不是某个 segment 的。
      //   挂上 paragraph 身份 ⇒ 「这个 segment 节点属于哪个 Core paragraph」可按属性
      //   判定。**注意 legacy 行 ≠ Core 段落**（实测：legacy 3 个 segment 对应 Core
      //   2 个 paragraph，见 EditingSurfaceGeometry.paragraphId 注释）——
      //   本属性只标识「编辑对象是谁」，**不**表达整个 legacy 行的归属。
      //   仅 Core 驱动的多行面挂；单行面（editingSurface===null）不挂 ⇒ 该路径逐字节不变。
      data-editing-paragraph-id={surfaceActive && editingSurface ? editingSurface.paragraphId : undefined}
      // ★★ P0-F1：unit 面身份（**结构身份，不是文本**）。F1.1 用它断言
      //   「一个 EditingUnit 只有一个 contenteditable 面」。
      //   单 paragraph 路径下为 undefined ⇒ 属性不出现 ⇒ DOM 逐字节不变（F1.9）。
      data-editing-unit-id={surfaceActive && editingSurface ? editingSurface.unitId : undefined}
      onClick={(e) => {
        e.stopPropagation();
        // ★ F3B-6.27 · P0-VPS（D1'）：Ctrl/Cmd+点击 = **显式多选**（加入/移出跨行范围）。
        //   刻意**不**进入编辑 —— 多选是"圈定范围"的意图，与"编辑某一段"是两件事。
        //   证据：拖选 / Shift+点击 在此 UI 下均无法跨行（每个 segment 是独立 absolute
        //   元素，mousedown 已被"进入编辑"占用，DOM selection 不跨元素扩展）
        //   ⇒ 跨行范围只能由**我们自己的选中集合**承载。
        //   集合写入 store（无需改 PDFCanvas）；若额外注入 prop 则一并通知。
        if (!isEditing && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          toggleMultiSelected(segment.id);
          onToggleMultiSelect?.(segment.id);
          return;
        }
        if (!isEditing) {
          if (allowEdit) {
            // Bug 8: 编辑模式下单击即进入编辑，记录点击坐标用于光标定位
            clickPosRef.current = { x: e.clientX, y: e.clientY };
            onStartEdit(segment.id);
          } else {
            // 浏览模式：让浏览器处理文本选择，不阻止默认行为
            onSelect(segment.id);
          }
        }
      }}
      onMouseEnter={() => {
        if (!isEditing) setIsHovering(true);
      }}
      onMouseLeave={() => {
        setIsHovering(false);
      }}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {/* 编辑模式下不渲染 React children，避免 re-render 覆盖 contentEditable DOM 导致光标重置。
          初始文本由 useEffect 通过 ref.current.textContent 设置。 */}
      {!isEditing && localText}
    </div>
  );
}
