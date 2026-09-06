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

import React, { useRef, useState, useEffect, useMemo } from "react";
import type { Segment } from "./types";
import { RenderLayer } from "../document-model/render-layer";

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
  onSelect: (id: string) => void;
  onStartEdit: (id: string) => void;
  onChange: (id: string, newText: string) => void;
  onEndEdit: () => void;
}

export function EditableTextNode({
  segment,
  isSelected,
  isEditing,
  allowEdit,
  onSelect,
  onStartEdit,
  onChange,
  onEndEdit,
}: EditableTextNodeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [localText, setLocalText] = useState(segment.text);
  const [isHovering, setIsHovering] = useState(false);
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
    ref.current.textContent = segment.text;
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
    const newText = ref.current?.textContent || "";
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
    color: showText ? font.color : "transparent",
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
    outline: isHovering ? "1px dashed rgba(59,130,246,0.4)" : "none",
    outlineOffset: isHovering ? "-1px" : "0",
    borderRadius: 2,
    // M7.8-014B: 编辑态强制 nowrap + overflow visible，禁止编辑框内换行、避免提交后几何落到两行之间。
    whiteSpace: "nowrap",
    overflow: isEditing ? "hidden" : "visible",
    // Sprint34.3: 编辑态 wordBreak 用 keep-all，禁止单词内部断行
    wordBreak: isEditing ? "keep-all" : "normal",
    cursor: isEditing ? "text" : allowEdit ? "pointer" : "text",
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
    zIndex: RenderLayer.EDITOR,
    // Bug 11: 浏览模式允许文字选择；编辑模式禁止选择（改为 click 进入编辑）
    userSelect: isEditing ? "text" : allowEdit ? "none" : "text",
    WebkitUserSelect: isEditing ? "text" : allowEdit ? "none" : "text",
  };

  return (
    <div
      ref={ref}
      style={baseStyle}
      contentEditable={isEditing}
      suppressContentEditableWarning
      data-segment-id={segment.id}
      onClick={(e) => {
        e.stopPropagation();
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
