/**
 * Sprint 32 + M5-IMPLEMENT-003C-UI: Text Edit Overlay
 *
 * M5-IMPLEMENT-003C-UI（ADR-048）职责边界：
 *   TextEditOverlay 只做：input surface / keyboard event capture / focus management。
 *   **不拥有 text truth**：显示文本完全由 session.text 驱动（controlled textarea）。
 *   **不拥有 caret truth**：caret 由 EditSession.glyphCaret 表达（CaretLayer 渲染）。
 *   **不做 document mutation**：commit 由 onSave 交给 PDFEditor（002D 既有路径）。
 *
 * 键盘处理：
 *   - 方向键 / Backspace / Delete / 可打印字符 → onKeyboardEdit(e, session)，由 PDFEditor
 *     执行 editingMode 状态机（replace-selection → text-edit）并更新 EditSession。
 *   - Enter → onSave（commit）；Escape → onCancel（document 不变）。
 *
 * z-index: 40（在 glyph layer 30 之上）
 */
import { useRef, useEffect, useLayoutEffect, useState, useCallback } from "react";
import type { BBox } from "../../document-model/types";
import { RenderLayer } from "../../document-model/render-layer";
import type { EditSession } from "../../document-model/edit-session";
import { syncCaretFromDomSelection, domSelectionOffsetsOf } from "../../document-model/edit-session";

// M7.7-066: 编辑层统一垂直偏移（editor / mask / replacement 同步）
const EDIT_LAYER_Y_OFFSET = 8;

export interface TextEditOverlayProps {
  /** 编辑的 block ID */
  blockId: string;
  /** 当前 EditSession（文本 / editingMode / glyphCaret 的唯一 truth） */
  session: EditSession;
  /** block 的 CSS 坐标包围盒 */
  bbox: BBox;
  /** M7.7-003: 行级 CSS 归一化 transform（[a,b,c,d,e,f]，旋转/倾斜）。textEdit 为行内编辑，
   *  input surface 跟随文字方向（旋转/倾斜文本的 textarea 与 glyph 对齐，IME/光标位置正确）。可选。 */
  transform?: [number, number, number, number, number, number];
  /** 保存回调：返回新文本（002D commit 路径） */
  onSave: (blockId: string, newText: string) => void;
  /** 取消/关闭回调（document 不变） */
  onCancel: () => void;
  /** S33.3.3: 字号（CSS px，从 block style 获取） */
  fontSize?: number;
  /** S33.3.3: 字体族（CSS font-family，从 block style 获取） */
  fontFamily?: string;
  /**
   * PDF 原字体名（如 pdf.js 生成的 g_d0_f2）。优先用于 textarea font-family，
   * 使编辑框内渲染尽可能接近原 PDF 字形；若浏览器无法加载则回退到 fontFamily。
   */
  pdfjsFontFamily?: string;
  /** M7.7-003A: 字重（glyph styleRef → styles[].fontWeight，加粗原文保真；缺省 400） */
  fontWeight?: number;
  /** M7.7-003A: 行高（glyph styleRef → styles[].lineHeight，CSS px）。
   * PDF 排版与浏览器默认不同，不能用硬编码 1.25；优先级 glyph.lineHeight → fontSize*1.2 → 1.25。 */
  lineHeight?: number;
  /**
   * M5-003C-UI: 键盘编辑回调。
   * e = 捕获的 keydown；session = 当前 session。
   * PDFEditor handler 据此执行 editingMode 转换并返回新 session（setEditSession）。
   * 仅当 key 被处理时调用（否则走默认 textarea 行为，如 IME）。
   */
  onKeyboardEdit: (e: React.KeyboardEvent<HTMLTextAreaElement>, session: EditSession) => void;
  /**
   * M7-001: Paste 回调。
   * TextEditOverlay 只拦截 clipboard + preventDefault，把 text 转交 PDFEditor。
   * **textarea 仍只是 Input Surface，不拥有 text mutation**（避免 clipboard + session 双输入源）。
   * PDFEditor handler 调 insertAtGlyph 更新 session → commit → History 单 entry。
   */
  onPaste: (text: string, session: EditSession) => void;
  /**
   * M7.7-004 (Bug2): DOM caret → session caret 同步回调。
   * 用户用鼠标在 textarea 内点击/拖选会移动 DOM caret，但 session.glyphCaret 感知不到 →
   * insertAtGlyph 用旧 glyphCaret 定位 → "末尾点击后输入，文本插入到中间"。
   * TextEditOverlay 拦截鼠标事件，把 textarea selectionStart/End（UTF-16）经
   * syncCaretFromDomSelection 同步为 session caret/glyphCaret，再交由 PDFEditor setEditSession。
   * 不拥有 caret truth（PDFEditor 仍是 setter 唯一入口）。
   */
  onCaretChange?: (session: EditSession) => void;
  /**
   * M7.7-006B (CJK/insertText 回收): textarea input 事件回调。
   * 非 ASCII（中文等）经浏览器 insertText 直接改 textarea.value，不触发 keydown 逐字符。
   * 此回调把最终 value + 光标位置回收为 session（applyTextareaValue），否则 CJK 编辑静默丢失。
   * 英文走 keydown 管线已同步 → value===session.text → PDFEditor no-op。
   */
  onTextInput?: (value: string, cursorUtf16: number, session: EditSession) => void;
}

export function TextEditOverlay({
  blockId,
  session,
  bbox,
  transform,
  onSave,
  onCancel,
  fontSize,
  fontFamily,
  pdfjsFontFamily,
  fontWeight,
  lineHeight,
  onKeyboardEdit,
  onPaste,
  onCaretChange,
  onTextInput,
}: TextEditOverlayProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // M7.7-008A trace: overlay 收到的 style 参数
 

  // M7.7-003A: Epoch Guard —— session 对象身份即 epoch token（单一事实源）。
  // 每次 openTextEditSession 都会由 createEditSession 新建 EditSession 对象。
  // 若 blur 后 session 被重新打开（新对象，例如再次点击同一行/其他行），则当前挂起的
  // 150ms 定时器属于「旧 blur」的产物，不得用它取消「新 session」——身份比对后忽略。
  const sessionRef = useRef<EditSession | null>(null);
  // M7.7-005: session 打开时刻（= 本 session epoch 的起始时间）。
  // 双击的第一次点击（落在 glyph 容器）会打开本 session；第二次点击落在 textarea。
  // 用「距 session 打开 < 500ms 的 textarea 首次点击」识别双击（否则无 dblclick 事件可依赖）。
  const sessionOpenedAtRef = useRef<number>(Date.now());
  // M7.7-005: textarea 上最近一次点击（时间 + 位置）→ 识别「session 已打开后的连续两次点击」双击。
  const lastClickRef = useRef<{ t: number; x: number; y: number } | null>(null);
  useEffect(() => {
    const prev = sessionRef.current;
    sessionRef.current = session;
    // M7.7-003A: session 身份变化（新 epoch = 编辑被重新打开，如双击第二次点击 / 菜单 Edit Text）
    // → 立即恢复输入面聚焦，消灭「blur → 150ms timer 恢复」之间的打字死窗（用户双击后立刻键入）。
    // 仅当输入面失焦时补位（正常输入中 activeElement 已是 textarea → no-op；不干扰 IME/工具栏点击）。
    if (prev !== session) {
      // M7.7-005: 记录本 session epoch 打开时刻（双击检测基准）。
      sessionOpenedAtRef.current = Date.now();
      const ta = textareaRef.current;
      if (ta && document.activeElement !== ta) ta.focus();
      // M7.7-003A: 打开编辑时 caret 必须保留在 session.caret（Adobe 行为）。
      //   click 命中 glyph → glyphCaret/caret=30 → 此处把 DOM selection 设为 [30,30]。
      //   绝不可用 ta.select()（会覆盖成整行 [0,35] → 整行高亮 + 输入被当整行替换）。
      //   双击/拖选选中词（caret.start!==caret.end）→ 设 range，输入直接替换选中词。
      if (ta) {
        const { start, end } = domSelectionOffsetsOf(session);
        ta.setSelectionRange(start, end);
      }
    }
  });

  // 显示文本 = session.text（replace-selection 显示 fragment "W"；text-edit 显示整行）
  const displayText = session.text;
  // M7.7-013: 编辑框行高严格等于 fontSize px，不使用 'normal' 或 '1.2'。
  // 'normal' 让浏览器用字体自然行高（~19-22px），大于 PDF glyph box height（16.5px），
  // 导致 textarea 内部文字溢出，视觉上"上移"覆盖上一行。
  // 固定为 fontSize 确保 textarea 行盒 = PDF glyph box 高度，文字不溢出。
  const resolvedLineHeight = `${fontSize ?? 14}px`;
  const resolvedFontWeight = fontWeight ?? 400;

  // M7.7-004B (Bug2): 编辑框随内容自动伸缩。textarea 曾固定 width/height=bbox，
  // 输入更长文本后 overflow:hidden 把新文本裁剪遮住。这里读 textarea 的 scrollWidth/Height：
  // textarea 是 whiteSpace:pre（单行不换行）→ scrollWidth 恒等于真实内容宽（不依赖当前 width），
  // 无需把 ta 收缩到 0 再测量（手动改 ta.style.width 会被 React style diff 忽略而残留 0px）。
  // 取 max(内容, 原 bbox) 同步容器与 textarea 尺寸。setState 在 layout 阶段同步完成，无闪烁。
  const [surfaceSize, setSurfaceSize] = useState<{ w: number; h: number }>(() => ({
    w: bbox.width,
    h: bbox.height,
  }));
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    // M7.7-006C: 用 outline 替代 border → 不占布局空间
    // surface 高度 = max(scrollHeight, bbox.height)，不含 border → 不侵入下一行
    const contentW = ta.scrollWidth + 6 + 2; // padding 3px*2 + 光标余量 2
    // M7.7-013: scrollHeight 应 ≈ fontSize（lineHeight = fontSize px），
    // 不再被浏览器撑到 19-22px。取 max(内容, bbox.height) 保底。
    const contentH = ta.scrollHeight;
    setSurfaceSize({
      // M7.8-024: 保持编辑框宽度至少为原 bbox 宽度。
      // 原 bbox 宽度来自 PDF 真实排版；若 content 更小就收缩，会导致编辑框窄于原文行，
      // 视觉上仿佛字体被压缩或对齐异常。文本超出时自然向右延伸。
      w: Math.max(contentW, bbox.width, 24),
      h: Math.max(contentH, bbox.height),
    });
    // M7.7-011A: 坐标审计 — 编辑框实际 DOM 位置 vs PDF 坐标
    requestAnimationFrame(() => {
      const containerEl = ta.parentElement;
      if (!containerEl) return;
      const cr = containerEl.getBoundingClientRect();
      const tr = ta.getBoundingClientRect();
      const taStyle = getComputedStyle(ta);
      // M7.7-033A: 编辑框位置审计 — 排查 textarea 上移侵占上一行
      console.log("[M7.7-033A][TEXTAREA_POSITION]", {
        lineId: session?.target?.lineId ?? "unknown",
        bboxY: Math.round(bbox.y * 100) / 100,
        bboxHeight: Math.round(bbox.height * 100) / 100,
        textareaTop: Math.round(tr.top * 100) / 100,
        textareaHeight: Math.round(tr.height * 100) / 100,
        fontSize: fontSize ?? 14,
        lineHeight: taStyle.lineHeight,
        paddingTop: taStyle.paddingTop,
        paddingBottom: taStyle.paddingBottom,
        borderTopWidth: taStyle.borderTopWidth,
        boxSizing: taStyle.boxSizing,
        transform: transform ? `matrix(${transform.join(",")})` : "none",
        containerTop: Math.round(cr.top * 100) / 100,
        containerHeight: Math.round(cr.height * 100) / 100,
      });
    });
  }, [displayText, bbox.width, bbox.height, fontSize, fontFamily, pdfjsFontFamily]);

  // Auto-focus on mount（selection 交由上面的 session-identity effect 按 session.caret 设置，
  // 不再 ta.select()——那会覆盖 collapsed caret 成整行全选，见 M7.7-003A）
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta && document.activeElement !== ta) ta.focus();
  }, []);

  const handleSave = useCallback(() => {
    // M7.7-005: commit 读【最新 session】（ref），而非旧 render 闭包。
    // 输入走 onKeyboardEdit → setEditSession 是异步 React state；快速 blur 时闭包
    // displayText / session.originalText 仍是旧值 → 会 commit 旧文本或 onCancel 丢输入。
    // sessionRef.current 在每次渲染同步为最新 session，blur 的 150ms 窗口内已 flush → 读到新文本。
    const cur = sessionRef.current;
    // console.log("[M7.7-014][HANDLE_SAVE]", {
      //   status: cur?.status,
      //   text: cur?.text?.substring(0, 40),
      //   originalText: cur?.originalText?.substring(0, 40),
      //   trimmed: cur?.text?.trim()?.substring(0, 40),
      //   trimmedLen: cur?.text?.trim()?.length,
      //   equal: cur?.text?.trim() === cur?.originalText,
      // });
    if (!cur || cur.status !== "active") {
      onCancel();
      return;
    }
    const trimmed = cur.text.trim();
    if (trimmed && trimmed !== cur.originalText) {
      onSave(blockId, trimmed);
    } else {
      onCancel();
    }
  }, [blockId, onSave, onCancel]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      // 交给 PDFEditor handler 处理（方向 / Backspace / Delete / 可打印字符）
      // 由 handler 决定是否 preventDefault + 是否更新 session；无 glyphCaret 时 handler no-op（SAFE）。
      onKeyboardEdit(e, session);
    },
    [handleSave, onCancel, onKeyboardEdit, session]
  );

  // M7-001: Paste — 拦截 clipboard，转交 PDFEditor（textarea 不拥有 text mutation）。
  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text") ?? "";
      if (!text) return; // empty clipboard → safe no-op
      onPaste(text, session);
    },
    [onPaste, session]
  );

  // M7.7-006B (CJK/insertText 回收): 原生 input 监听（不用 React onInput——受控 textarea 的合成
  // onInput 不可靠）。非 ASCII 经浏览器 insertText 直接改 value（无 keydown 逐字符），此处把最终值回收。
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta || !onTextInput) return;
    const h = () => {
      const cur = sessionRef.current;
      if (cur && cur.status === "active") onTextInput(ta.value, ta.selectionStart, cur);
    };
    ta.addEventListener("input", h);
    return () => ta.removeEventListener("input", h);
  }, [onTextInput]);

  // M7.7-006C: 废弃 150ms blur timer → 立即 commit
  // 浏览器事件顺序：mousedown → blur → mouseup → click
  // blur 在 click 之前触发 → 立即 commit → session 变为 committed
  // → click handler 读 editSessionRef.current.status !== "active" → 跳过重复 commit
  // → openTextEditSession(newTarget) 安全打开新编辑
  // 150ms timer 的竞争条件：有时 timer 在 click 前触发（保存），有时在 click 后（跳过）→ 50% 丢失
  const handleBlur = useCallback(() => {
    handleSave();
  }, [handleSave]);

  // M7.7-005: 在文本中取「点击位置所在词」的区间（UTF-16 offset，与 textarea 同空间）。
  // 语义对齐 WordSelectionStrategy：词字符（字母/数字/CJK/货币/百分比）+ 连接符，空白/标点断开。
  // 独立实现（不依赖 glyph/flow），因为这里只有 textarea 的纯文本可计算。
  function wordRangeAt(text: string, pos: number): { start: number; end: number } {
    const len = text.length;
    const p = Math.max(0, Math.min(pos, len));
    const isWord = (i: number) => {
      if (i < 0 || i >= len) return false;
      const c = text[i];
      if (/[\p{L}\p{N}]/u.test(c)) return true;
      if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(c)) return true;
      if (/[$￥€¥%]/.test(c)) return true;
      if (/[-'@._:/]/.test(c)) return true;
      return false;
    };
    let start = p;
    while (start > 0 && isWord(start - 1)) start--;
    let end = p;
    while (end < len && isWord(end)) end++;
    if (end <= start) return { start: p, end: p };
    return { start, end };
  }

  // M7.7-004 (Bug2): DOM caret → session caret 同步（仅鼠标点击定位）。
  // textarea 是 controlled（session 是 text truth），onChange 被禁用 → DOM caret 移动只有浏览器知道。
  // 点击后读取 selectionStart/End（UTF-16 offset），经 syncCaretFromDomSelection 同步
  // session.caret + session.glyphCaret（insertAtGlyph 依赖 glyphCaret 定位插入点）。
  //
  // 关键：**不用 onSelect 同步**。React 的 onSelect 对程序化 select()（mount 全选）会**异步**派发，
  // 且闭包 session 可能已陈旧 → 迟到的事件会用旧 session 覆盖正确 session（实测导致输入的首字符丢失）。
  // mount 全选只是 UX 便利（整行可替换），不参与 DOM→session 同步。
  //
  // 点击同步必须**延迟**读取 selectionStart/End：实测浏览器在 click handler 运行时**尚未**更新
  // textarea selection（读到旧值 [0,9]），直到当前任务完成才把光标落到点击处（[9,9]）。
  // setTimeout(0) 推迟到下一任务即可读到新值；用 sessionRef.current 避免陈旧闭包覆盖新 session。
  // M7.7-004X (Bug1): 点击文本末尾，输入却插到中间。
  // 根因：末尾字符若是空格（视觉不可见），浏览器原生点击会把光标落在空格**前**
  // （selectionStart = len-1），后续输入插到倒数第2位（"…de " → 输 Z → "…deZ "）。
  // 修复：点击位置接近内容右缘（≤10px）→ 用户意图显然是"光标到文本真正末尾"，
  // 强制 caret = value.length（末尾之后），插入才落在真正末尾。
  //
  // M7.7-005 (Double Click Inline Activation): 双击选词。
  // 真实双击 = 第一次点击落在 glyph 容器（打开本 session）+ 第二次点击落在 textarea。
  // 因两次点击 target 不同，浏览器不会派发 dblclick 事件（无法用 onDoubleClick）。
  // 此处用「距 session 打开 < 500ms」或「textarea 上两次快速点击（<500ms 且位移 <8px）」识别双击，
  // 在点击同步的同时把 DOM selection 扩展为点击位置所在的词，再同步到 session caret（选中词）。
  const handleCaretSyncDeferred = useCallback((e?: React.MouseEvent<HTMLTextAreaElement>) => {
    const ta = textareaRef.current;
    if (!ta || !onCaretChange) return;
    const cur = sessionRef.current;
    if (!cur || cur.status !== "active") return;
    let forceEnd = -1;
    // M7.7-005: 双击识别（在 forceEnd 判定前，与坐标计算无关）
    const now = Date.now();
    const prev = lastClickRef.current;
    const isDouble =
      (now - sessionOpenedAtRef.current <= 500) ||
      (!!prev && now - prev.t <= 500 && Math.hypot((e?.clientX ?? 0) - prev.x, (e?.clientY ?? 0) - prev.y) <= 8);
    if (e) {
      lastClickRef.current = { t: now, x: e.clientX, y: e.clientY };
      const r = ta.getBoundingClientRect();
      const localX = e.clientX - r.left;
      // M7.7-004Z (Bug1): 页面级 zoom ≠ 100% 时，e.clientX-r.left 与 r.width 都是**屏幕/缩放**坐标，
      // 而 ta.scrollLeft + ta.clientWidth 是**布局/未缩放**坐标。两者比值即 zoom。
      // 若直接比较，点击文本末尾时会在错误阈值判断 → forceEnd 不触发 → 光标落在中间 → 输入插到中间。
      // 统一换算到布局坐标：localX / z 与 contentRight 比较。
      const z = ta.clientWidth > 0 ? r.width / ta.clientWidth : 1;
      const localXLayout = z > 0.01 ? localX / z : localX;
      // 内容右缘 = 当前可见内容右界（无横向滚动时 ≈ scrollWidth，含 border/padding）
      const contentRight = ta.scrollLeft + ta.clientWidth;
      if (localXLayout >= contentRight - 10) forceEnd = ta.value.length;
    }
    window.setTimeout(() => {
      const ta2 = textareaRef.current;
      if (!ta2) return;
      const latest = sessionRef.current;
      if (!latest || latest.status !== "active") return;
      let domStart = forceEnd >= 0 ? forceEnd : ta2.selectionStart;
      let domEnd = forceEnd >= 0 ? forceEnd : ta2.selectionEnd;
      // M7.7-005: 双击 → 扩展为点击位置所在的词（浏览器原生 dblclick 不触发，手动补选词）。
      // 参考位置 = session.caret.start（单击 1 命中 glyph 时由 glyphCaretFromClick 写入，码点偏移，
      //   正确落在被点字符上），**不是** textarea 的 selectionStart（textarea 重新排列整行，
      //   DOM 点击位置会漂移，双击 "JENNIFER" 可能落回首词 "Atesto"）。
      // 经 domSelectionOffsetsOf 转成 UTF-16 偏移再做纯文本词扩展（session.text = 文档整行）。
      if (isDouble) {
        const { start: cpStart, end: cpEnd } = domSelectionOffsetsOf(latest);
        const refPos = cpEnd > cpStart ? cpEnd : cpStart; // 用 selection 末端作为词锚（双击选区边缘）
        const wr = wordRangeAt(latest.text, refPos);
        if (wr.end > wr.start) {
          ta2.setSelectionRange(wr.start, wr.end);
          domStart = wr.start;
          domEnd = wr.end;
        }
      }
      const newSession = syncCaretFromDomSelection(latest, domStart, domEnd);
      if (newSession !== latest) onCaretChange(newSession);
    }, 0);
  }, [onCaretChange]);

  return (
    <div
      data-layer="textEdit"
      className="pdf-text-edit-overlay"
      style={{
        position: "absolute",
        left: bbox.x,
        top: bbox.y + EDIT_LAYER_Y_OFFSET, // M7.7-066: 统一垂直偏移
        // M7.7-004B (Bug2): 容器随内容伸缩（surfaceSize = max(内容, 原 bbox)），
        // 使 textarea 变大后编辑框整体跟随，不再裁剪新文本。
        width: surfaceSize.w,
        height: surfaceSize.h,
        zIndex: RenderLayer.EDITOR,
        // M7.7-003A: 容器 pointer-events:none → 再次点击（双击/点击其他行）穿透到下层
        // glyph 容器（z=30），重新触发 geometry click → 重新打开 EditSession（新 epoch）。
        // textarea 单独保持 pointer-events:auto（仍是输入面）。仅靠 epoch 守卫不够：
        // 第二次点击若被容器拦截则不会重新打开 session（epoch 不变），闪关仍会发生。
        pointerEvents: "none",
        // M7.7-003: 行级 transform → input surface 跟随文字方向（旋转/倾斜文本）。
        // 与 GlyphRenderer 一致：transform-origin "0 0"（bbox 左上角），平移归零由 bbox 承担。
        transform: transform && !(transform[0] === 1 && transform[1] === 0 && transform[2] === 0 && transform[3] === 1)
          ? `matrix(${transform[0]},${transform[1]},${transform[2]},${transform[3]},${transform[4] ?? 0},${transform[5] ?? 0})`
          : undefined,
        transformOrigin: "0 0",
      }}
    >
      {/* M7.7-003B-REVERT: 可见编辑框（Visible Input Surface）
          此前 M7.7-002 Model B 把输入面做成 1×1 全透明（Invisible Input Surface），
          只靠 CaretLayer 画竖线。结果用户"点击文本只能看到光标、看不到编辑框、打字无可见变化"，
          误判为"不能编辑"。此处改为**可见编辑框**：实时显示 session.text、光标可见，
          让编辑状态一目了然，符合"极度简单舒适的指哪打哪交互"。canvas 仍是提交时的视觉源。 */}
      <textarea
        ref={textareaRef}
        value={displayText}
        onChange={() => {
          /* session 是 text truth；浏览器直接改 value 不生效（防止第二套 text truth） */
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onBlur={handleBlur}
        // M7.7-004 (Bug2): 点击 → 延迟同步 DOM caret（浏览器 click 后才更新 selection；不用 onSelect，
        // 避免 mount 全选的异步 onSelect 用陈旧 session 覆盖正确 session）
        onClick={handleCaretSyncDeferred}
        aria-label="PDF 内联文本编辑"
        spellCheck={false}
        autoComplete="off"
        // M7.8-014A: textarea 默认 wrap="soft" 会在 width 边界自动换行，
        // 导致编辑态出现多行、提交后 canvas replacement / line box 扫描到错误几何（新文本错位到两行之间）。
        // wrap="off" 配合 whiteSpace:pre 强制单行，容器随 scrollWidth 水平扩展（见 surfaceSize 逻辑）。
        wrap="off"
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          // M7.7-004B: 跟随容器（surfaceSize）——编辑框随内容变长而变长
          width: "100%",
          // M7.7-013: 固定高度 = bbox.height（≈ fontSize），不继承容器 height:100%。
          // 之前用 height:100% 导致 textarea 被浏览器撑到 19px（因 line-height:normal 时
          // 浏览器 line box 高度≈19-22px > glyph box 16.5px），文字溢出上移。
          height: `${bbox.height}px`,
          // M7.7-013: vertical-align:top 防止 inline textarea 默认 baseline 对齐干扰
          verticalAlign: "top",
          // M7.7-011A: 移除全部 padding（包括左右 3px），使 textarea 内容盒 = ink bbox 大小，
          // 避免额外空间导致 textarea 比文字行高，侵占上一行。
          padding: "0",
          // M7.7-006C: 用 outline 替代 border → 不占布局空间，textarea 高度 = surfaceSize.h
          // border 会加 4px 到 box model → textarea 比 glyph 高 4px → 侵入下一行
          outline: "2px solid #8b5cf6",
          outlineOffset: -2,
          border: "none",
          borderRadius: 3,
          background: "rgba(255,255,255,0.98)",
          color: "#111827",
          caretColor: "#7c3aed",
          // M7.7-006C: 已用 outline 作为视觉边框，不再设 outline:none
          resize: "none",
          overflow: "hidden",
          whiteSpace: "pre",
          wordBreak: "keep-all",
          boxSizing: "border-box",
          fontSize: fontSize ?? 14,
          // M7.7-003A: 用 glyph 行高（或 fontSize*1.2），非浏览器默认 1.25 → 编辑框贴合原文排版
          lineHeight: resolvedLineHeight,
          fontWeight: resolvedFontWeight,
          // M7.8-024: 优先使用 PDF 原字体名，让编辑框内字形更接近原文；
          // 若浏览器无法加载该字体，CSS 会自然回退到 fontFamily。
          fontFamily: pdfjsFontFamily || fontFamily || "inherit",
          zIndex: 1,
          pointerEvents: "auto", // 输入面保持可交互（父容器 pointer-events:none）
        }}
      />
    </div>
  );
}
