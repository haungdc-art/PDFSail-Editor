/**
 * EditSession — 统一文本编辑会话（M5-IMPLEMENT-002A）
 *
 * 设计原则（PM）：
 *   1. EditSession 是"交互状态"，不是 Document Truth。Document Truth 仍是 Document Model。
 *   2. Target 使用稳定 identity（blockId/lineId/glyph range），禁止 DOM element / text / indexOf / 坐标。
 *   3. Keyboard 不直接 mutation —— 只更新 session.text/caret；commit 时才执行 document mutation。
 *   4. Commit 用现有 Precise Range Mutation；Cancel 丢弃 session，document 完全不变。
 *   5. Multi-line（ranges.length > 1）→ SAFE REJECT（createEditSession 返回 null）。
 *   6. 本任务只建立 EditSession Foundation（单行），后续接入 Caret/Keyboard/Insert/Delete。
 *
 * 不可变性：EditSession 每次更新返回新对象（readonly 语义，便于 diff/undo 未来接入）。
 */
import type { SelectionRange } from "./current-selection";

/** EditSession 的稳定 target（进入时固定，不可变） */
export interface EditSessionTarget {
  readonly blockId: string;
  readonly lineId: string;
  /** 目标 glyph 区间（含 endGlyphIndex）—— 进入编辑时的精确 range */
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
}

export type EditSessionStatus = "active" | "committed" | "cancelled";

/**
 * GlyphCaret — glyph 级光标（M5-IMPLEMENT-003A）
 *
 * 语义：光标位于 lineId 行的 glyphIndex 字符的 offset 侧。
 *   - "before"：光标在字符左侧（点击字符左半 / 行首）
 *   - "after" ：光标在字符右侧（点击字符右半 / 行尾）
 * affinity：选择方向（forward = 向右选择，backward = 向左），供 selection 扩展用（003B/003C）。
 *
 * 与 target 的关系（003A 目标）：
 *   点击 W → target={start:6,end:6} + glyphCaret={glyphIndex:6, offset:"before"}，二者统一。
 */
export interface GlyphCaret {
  readonly lineId: string;
  readonly glyphIndex: number;
  readonly offset: "before" | "after";
  readonly affinity: "forward" | "backward";
}

export interface EditSession {
  readonly id: string;
  /** 稳定 target identity（进入时固定） */
  readonly target: EditSessionTarget;
  /** 进入时目标区间文本（用于 cancel 恢复 / diff） */
  readonly originalText: string;
  /** 多行 ranges（M5 预留；length>1 时创建被拒绝） */
  readonly ranges?: ReadonlyArray<SelectionRange>;
  /** working text（session 内可变，commit 前不写 document） */
  text: string;
  /** caret/selection（session.text 内的字符偏移；start===end 为 collapsed caret） */
  caret: { start: number; end: number };
  /**
   * M7-002: Shift+Arrow selection 的锚点（session.text 字符偏移）。
   * 首次 Shift+Arrow 时固定为当前 caret 位置；后续移动只动 focus（另一端点）。
   * 释放 Shift 或 commit 后由调用方清除（collapsed caret 无需 anchor）。
   */
  selectionAnchor?: number;
  /**
   * M5-IMPLEMENT-003A: glyph 级光标（glyph identity truth）。
   * 点击 glyph 时创建（glyphIndex = target.startGlyphIndex），保留 glyph identity。
   * 与 `caret`（session.text 偏移）并存：`glyphCaret` 是 glyph 级 Truth，`caret` 是过渡/输入代理层。
   */
  readonly glyphCaret?: GlyphCaret;
  readonly mode: "single" | "multi";
  /**
   * ADR-048: 编辑语义轴（与 mode 行数轴正交）。
   *   - "replace-selection"：点击字符准备替换（002D，session.text = 被选 fragment）
   *   - "text-edit"：连续文本编辑（003C，session.text = 整行 working text）
   * 首次输入触发 replace-selection → text-edit 单向转换（PDFEditor handler 负责 upgrade）。
   */
  readonly editingMode: "replace-selection" | "text-edit";
  /**
   * M5-003C-UI Delete Integration: 最近一次键盘操作类型。
   * commit 时据此分派到 TextOperation（delete → applyDelete 的 suffix 左移），
   * 而非统一走 M4 replace（replace 会保留 suffix 原位 → delete 产生空隙）。
   * 可选，向后兼容（未设置 = 默认 replace 语义）。
   */
  readonly lastOp?: "insert" | "delete" | "replace";
  /**
   * M7-005: transient IME composition 状态。
   * composition 不是普通输入：中间态（拼音 "ni" 等）不进 TextOperation / Undo / Mutation。
   *   - text ：当前 composition 的 preview 文本（transient，非 committed working text）。
   *   - start/end：composition 将替换的区间（进入 composition 时的 caret range，字符偏移，排他）。
   * 仅 `endComposition` 把 final text 一次性替换进 session.text（产生一个 insert/replace 操作）。
   */
  readonly composing?: {
    readonly text: string;
    readonly start: number;
    readonly end: number;
  };
  readonly status: EditSessionStatus;
}

let _idCounter = 0;

/**
 * 创建 EditSession。多行（ranges.length > 1）→ 返回 null（SAFE REJECT）。
 * 单行（或无 ranges）→ 创建 active session。
 * M5-003A: 可选 glyphCaret（点击 glyph 时的 glyph 级光标）。
 */
export function createEditSession(
  target: EditSessionTarget,
  originalText: string,
  ranges?: ReadonlyArray<SelectionRange>,
  glyphCaret?: GlyphCaret,
  editingMode: "replace-selection" | "text-edit" = "replace-selection",
  initialCaret?: { start: number; end: number }
): EditSession | null {
  // Multi-line 暂不支持：SAFE REJECT（不产生部分编辑）
  if (ranges && ranges.length > 1) return null;

  const len = originalText.length;
  // M7-004B: 可选初始 caret（selection 路径用 selection range 初始化，而非默认末尾）。
  // 向后兼容：未传时保持原默认 caret={len,len}（可被点击位置/后续操作覆盖）。
  const caret = initialCaret
    ? clampCaret(initialCaret, len)
    : { start: len, end: len };
  return {
    id: `edit_${++_idCounter}`,
    target,
    originalText,
    ranges,
    text: originalText,
    caret,
    glyphCaret,
    mode: "single",
    editingMode,
    status: "active",
  };
}

/** 更新 working text（只改 session，不 mutation）。可选更新 caret。 */
export function updateSessionText(
  session: EditSession,
  newText: string,
  caret?: { start: number; end: number }
): EditSession {
  if (session.status !== "active") return session;
  return {
    ...session,
    text: newText,
    caret: caret ?? clampCaret(session.caret, newText.length),
  };
}

/** 更新 caret/selection（session.text 内的字符偏移） */
export function updateSessionCaret(
  session: EditSession,
  caret: { start: number; end: number }
): EditSession {
  if (session.status !== "active") return session;
  return { ...session, caret: clampCaret(caret, session.text.length) };
}

/** Commit：标记 status=committed（实际的 document mutation 由调用方用 Precise Range 执行） */
export function commitSession(session: EditSession): EditSession {
  if (session.status !== "active") return session;
  return { ...session, status: "committed" };
}

/** Cancel：丢弃 session（document 完全不变） */
export function cancelSession(session: EditSession): EditSession {
  return { ...session, status: "cancelled" };
}

// ═══════════ M5-IMPLEMENT-003C: Keyboard → GlyphCaret → EditSession ═══════════
// 这些函数操作"整行 working text（session.text）+ glyphCaret"，纯逻辑，不直接 mutation。
// commit 时才把 session.text（整行新文本）通过 Precise Range Mutation 写回 document。

/** 当前 caret 在 session.text 内的字符偏移（glyphCaret 推导） */
function caretOffsetOf(session: EditSession): number {
  const gc = session.glyphCaret;
  if (!gc) return session.caret.start;
  return gc.offset === "after" ? gc.glyphIndex + 1 : gc.glyphIndex;
}

/**
 * M7-004C: 从 collapsed caret 位置补建 GlyphCaret（caretOffsetOf 的逆操作）。
 *
 * 场景：Mouse Selection（Route A）replace/delete 后 caret collapse 到某字符位置，
 *   session 无 glyphCaret（selection 用 range 编辑），导致后续单字符输入/方向键无法定位。
 *
 * 规则（PM）：
 *   - 已有 glyphCaret → no-op（原样返回）。
 *   - caret 有 selection（start!==end）→ no-op（selection 用 range 编辑，不需要 glyphCaret）。
 *   - caret collapsed 且无 glyphCaret → 从 caret 字符偏移补建 glyphCaret：
 *       pos>0  → glyphIndex = pos-1, offset="after"（光标在 pos-1 字符右侧）
 *       pos=0  → glyphIndex = 0,     offset="before"（行首）
 *   lineId 来自 session.target.lineId（稳定 identity，不依赖 DOM/文本回查）。
 */
export function ensureGlyphCaretFromCaretPosition(session: EditSession): EditSession {
  if (session.status !== "active") return session;
  if (session.glyphCaret) return session;
  if (session.caret.start !== session.caret.end) return session;
  const pos = Math.max(0, Math.min(session.caret.start, session.text.length));
  const glyphIndex = pos === 0 ? 0 : pos - 1;
  const offset: "before" | "after" = pos === 0 ? "before" : "after";
  return {
    ...session,
    glyphCaret: {
      lineId: session.target.lineId,
      glyphIndex,
      offset,
      affinity: "forward",
    },
  };
}

// ═══════════ M7.7-004 (Bug2): DOM caret ↔ session caret 同步 ═══════════
// textarea 的 selectionStart/End 是 UTF-16 code unit offset；session.caret 是 code point offset。
// 用户用鼠标点击/选择 textarea 时，DOM caret 移动但 session.glyphCaret 不感知 →
// insertAtGlyph 用旧 glyphCaret 定位 → "在末尾点击后输入，文本插入到中间"。

/** 字符偏移 → UTF-16 offset（session.text 内） */
function charToUtf16(text: string, charPos: number): number {
  return Array.from(text).slice(0, Math.max(0, Math.min(charPos, Array.from(text).length))).join("").length;
}

/**
 * M7.7-004 (Bug2): 从 DOM caret（textarea selectionStart/End，UTF-16 offset）同步 session。
 *   - collapsed caret（start===end）→ 同时更新 caret + glyphCaret（insertAtGlyph 用 glyphCaret 定位）。
 *   - selection（start!==end）→ 更新 caret（insertAtGlyph/backspaceAtGlyph 的 selection 分支用 caret 定位）。
 *   - 重置 selectionAnchor（鼠标选择是独立 truth，覆盖 Shift+Arrow 锚点）。
 * 未 active / 值未变 → no-op（返回原 session）。
 */
export function syncCaretFromDomSelection(
  session: EditSession,
  domStart: number,
  domEnd: number
): EditSession {
  if (session.status !== "active") return session;
  const text = session.text;
  const u16Start = Math.max(0, Math.min(domStart, text.length));
  const u16End = Math.max(u16Start, Math.min(domEnd, text.length));
  const chars = Array.from(text);
  // UTF-16 offset → code point offset
  const countChars = (u16: number): number => {
    if (u16 >= text.length) return chars.length;
    return Array.from(text.slice(0, u16)).length;
  };
  const start = countChars(u16Start);
  const end = countChars(u16End);
  if (start === session.caret.start && end === session.caret.end) return session;
  const collapsed = start === end;
  const glyphIndex = start === 0 ? 0 : start - 1;
  const offset: "before" | "after" = start === 0 ? "before" : "after";
  return {
    ...session,
    caret: { start, end },
    selectionAnchor: undefined,
    glyphCaret: collapsed
      ? session.glyphCaret
        ? { ...session.glyphCaret, glyphIndex, offset }
        : { lineId: session.target.lineId, glyphIndex, offset, affinity: "forward" }
      : session.glyphCaret, // selection 走 range 编辑，glyphCaret 保持（insertAtGlyph 不依赖它）
  };
}

/**
 * M7.7-004 (Bug2): session caret/selection → DOM（UTF-16）offset。
 * 供 TextEditOverlay 在 session 变化后恢复 textarea 的 selection（与 session 保持单一 truth）。
 */
export function domSelectionOffsetsOf(session: EditSession): { start: number; end: number } {
  return {
    start: charToUtf16(session.text, session.caret.start),
    end: charToUtf16(session.text, session.caret.end),
  };
}

// ═══════════ M7-005: IME Composition State（transient，不进 Mutation/Undo）═══════════
// composition 不是普通输入：中间态（拼音/部首）不进 TextOperation/Undo/Mutation。
// 只有 endComposition 把 final text 一次性替换进 session.text（产生一个 insert/replace 操作）。

/**
 * M7-005: 开始 composition。记录当前 caret range 为 composition 将替换的区间。
 * 已在 composing → no-op。无 mutation。
 */
export function startComposition(session: EditSession): EditSession {
  if (session.status !== "active") return session;
  if (session.composing) return session;
  const len = session.text.length;
  const start = Math.max(0, Math.min(session.caret.start, len));
  const end = Math.max(start, Math.min(session.caret.end, len));
  return {
    ...session,
    composing: { text: "", start, end },
  };
}

/**
 * M7-005: 更新 composition preview 文本（transient，不改 session.text，不进 Undo）。
 * 未 composing → no-op。无 mutation。
 */
export function updateComposition(session: EditSession, text: string): EditSession {
  if (session.status !== "active" || !session.composing) return session;
  return {
    ...session,
    composing: { ...session.composing, text },
  };
}

/**
 * M7-005: 结束 composition。用 final text 一次性替换 composing 的区间 [start,end)，
 * 更新 session.text + caret + lastOp，并清除 composing。
 * 未 composing → no-op。此调用是唯一写 session.text 的 composition 入口（对应一次 insert/replace）。
 */
export function endComposition(session: EditSession): EditSession {
  if (session.status !== "active" || !session.composing) return session;
  const comp = session.composing;
  const chars = Array.from(session.text);
  const start = Math.max(0, Math.min(comp.start, chars.length));
  const end = Math.max(start, Math.min(comp.end, chars.length));
  const finalText = comp.text;
  const newText = chars.slice(0, start).join("") + finalText + chars.slice(end).join("");
  const newCaretIdx = start + Array.from(finalText).length;
  const replacedSelection = end > start;
  const gc = session.glyphCaret;
  return {
    ...session,
    text: newText,
    caret: { start: newCaretIdx, end: newCaretIdx },
    selectionAnchor: undefined,
    lastOp: replacedSelection ? "replace" : "insert",
    composing: undefined,
    glyphCaret: gc ? { ...gc, glyphIndex: Math.max(0, newCaretIdx - 1), offset: "after" as const } : undefined,
  };
}

/**
 * 移动 glyph caret（delta = ±1，ArrowLeft/Right）。无 mutation。
 * 只在行内移动（0 .. text.length-1），不跨行。
 */
export function moveGlyphCaret(session: EditSession, delta: number): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  const gc = session.glyphCaret;
  const maxIndex = Math.max(0, session.text.length - 1);
  const newIndex = Math.max(0, Math.min(gc.glyphIndex + delta, maxIndex));
  // M7-002: 非 Shift 移动 → collapsed caret + 清除 selectionAnchor（结束 selection）。
  const newCharOffset = newIndex + 1; // offset "after" → glyphIndex+1
  return {
    ...session,
    caret: { start: newCharOffset, end: newCharOffset },
    selectionAnchor: undefined,
    glyphCaret: { ...gc, glyphIndex: newIndex, offset: "after" },
  };
}

/**
 * M7-002: Shift+Arrow 扩展 selection（anchor/focus 模型）。
 *   - 首次 Shift+Arrow：锚定当前 caret（selectionAnchor），移动 focus。
 *   - 后续：只移动 focus（另一端保持 anchor 固定）。
 *   - caret = { start: min(anchor,focus), end: max(anchor,focus) }；glyphCaret 移到 focus。
 * 释放 Shift（moveGlyphCaret）或 commit 后清除 selectionAnchor（collapsed）。
 */
export function moveGlyphCaretSelect(session: EditSession, delta: number): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  const gc = session.glyphCaret;
  const focus = caretOffsetOf(session); // 当前 caret 字符偏移
  const anchor = session.selectionAnchor ?? focus; // 首次 Shift 固定锚点
  const maxIndex = session.text.length;
  const newFocus = Math.max(0, Math.min(focus + delta, maxIndex));
  const start = Math.min(anchor, newFocus);
  const end = Math.max(anchor, newFocus);
  return {
    ...session,
    caret: { start, end },
    selectionAnchor: anchor,
    glyphCaret: { ...gc, glyphIndex: newFocus === 0 ? 0 : newFocus - 1, offset: "after" },
  };
}

/**
 * M7-003: 是否有 selection（caret.start !== caret.end）。
 */
export function hasSelection(session: EditSession): boolean {
  return session.caret.start !== session.caret.end;
}

/**
 * M7.7-002 (Home/End): 光标移到行首（glyphIndex=0, offset="before"）。
 * 非 Shift → collapsed caret + 清除 selectionAnchor（结束 selection）。
 */
export function moveGlyphCaretHome(session: EditSession): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  return {
    ...session,
    caret: { start: 0, end: 0 },
    selectionAnchor: undefined,
    glyphCaret: { ...session.glyphCaret, glyphIndex: 0, offset: "before" },
  };
}

/**
 * M7.7-002 (Home/End): 光标移到行尾（glyphIndex=text.length-1, offset="after"）。
 * 非 Shift → collapsed caret + 清除 selectionAnchor（结束 selection）。
 */
export function moveGlyphCaretEnd(session: EditSession): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  const len = session.text.length;
  return {
    ...session,
    caret: { start: len, end: len },
    selectionAnchor: undefined,
    glyphCaret: {
      ...session.glyphCaret,
      glyphIndex: len === 0 ? 0 : len - 1,
      offset: "after",
    },
  };
}

/**
 * M7.7-002 (Home/End + Shift): Shift+Home → 从 anchor 扩展到行首。
 * anchor/focus 语义与 moveGlyphCaretSelect 一致：固定 anchor，focus 移到 0。
 */
export function moveGlyphCaretSelectHome(session: EditSession): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  const focus = caretOffsetOf(session);
  const anchor = session.selectionAnchor ?? focus; // 首次 Shift+Home 锚定当前位置
  return {
    ...session,
    caret: { start: Math.min(anchor, 0), end: Math.max(anchor, 0) },
    selectionAnchor: anchor,
    glyphCaret: { ...session.glyphCaret, glyphIndex: 0, offset: "before" },
  };
}

/**
 * M7.7-002 (Home/End + Shift): Shift+End → 从 anchor 扩展到行尾。
 * anchor/focus 语义与 moveGlyphCaretSelect 一致：固定 anchor，focus 移到 text.length。
 */
export function moveGlyphCaretSelectEnd(session: EditSession): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  const focus = caretOffsetOf(session);
  const anchor = session.selectionAnchor ?? focus; // 首次 Shift+End 锚定当前位置
  const len = session.text.length;
  return {
    ...session,
    caret: { start: Math.min(anchor, len), end: Math.max(anchor, len) },
    selectionAnchor: anchor,
    glyphCaret: {
      ...session.glyphCaret,
      glyphIndex: len === 0 ? 0 : len - 1,
      offset: "after",
    },
  };
}

/**
 * M7-003: Ctrl+A → 选中整行文本。caret = [0, text.length]。
 */
export function selectAll(session: EditSession): EditSession {
  if (session.status !== "active" || !session.glyphCaret) return session;
  const len = session.text.length;
  return {
    ...session,
    caret: { start: 0, end: len },
    selectionAnchor: 0,
    glyphCaret: { ...session.glyphCaret, glyphIndex: len === 0 ? 0 : len - 1, offset: "after" },
  };
}

/**
 * M7-003: 删除 selection 区间 [start,end]，collapse 到 start。
 * 无 selection → no-op（返回原 session）。供 Backspace/Delete 在 selection 存在时调用。
 */
export function deleteSelection(session: EditSession): EditSession {
  // M7-004B: guard 放宽 —— 无 glyphCaret 但**有 selection range** 时放行（Mouse Selection 无 glyphCaret）。
  //   invariant：可编辑条件 = glyphCaret exists OR selection range exists。
  //   无 glyphCaret 且 collapsed caret（无 selection）→ SAFE no-op（无定位能力）。
  if (session.status !== "active" || (!session.glyphCaret && !hasSelection(session))) return session;
  if (!hasSelection(session)) return session;
  const chars = Array.from(session.text);
  const start = Math.max(0, Math.min(session.caret.start, chars.length));
  const end = Math.max(start, Math.min(session.caret.end, chars.length));
  if (start === end) return session;
  const newText = chars.slice(0, start).join("") + chars.slice(end).join("");
  const gc = session.glyphCaret;
  return {
    ...session,
    text: newText,
    caret: { start, end: start },
    selectionAnchor: undefined,
    lastOp: "delete",
    glyphCaret: gc ? { ...gc, glyphIndex: start === 0 ? 0 : start - 1, offset: "after" } : undefined,
  };
}

/**
 * 在 glyph caret 位置插入文本。更新 text + glyphCaret（caret 移到插入后）。
 * 例：caret 在 glyphIndex=6 before（W 前），插入 "X" → "HELLO XWORLD"，caret → X 后。
 * M7-003: 若存在 selection → 用插入文本**替换** selection 区间（collapse 到插入后）。
 */
export function insertAtGlyph(session: EditSession, text: string): EditSession {
  // M7-004B: guard 放宽 —— 无 glyphCaret 但**有 selection range** 时放行（Mouse Selection）。
  if (session.status !== "active" || (!session.glyphCaret && !hasSelection(session))) return session;
  const gc = session.glyphCaret;
  const chars = Array.from(session.text);
  const inserted = Array.from(text);

  // M7-003: selection 存在 → replace range（替换选中文本）
  if (hasSelection(session)) {
    const start = Math.max(0, Math.min(session.caret.start, chars.length));
    const end = Math.max(start, Math.min(session.caret.end, chars.length));
    const newText = chars.slice(0, start).join("") + inserted.join("") + chars.slice(end).join("");
    const newCaretIdx = start + inserted.length;
    return {
      ...session,
      text: newText,
      caret: { start: newCaretIdx, end: newCaretIdx },
      selectionAnchor: undefined,
      lastOp: "replace",
      glyphCaret: gc ? { ...gc, glyphIndex: newCaretIdx === 0 ? 0 : newCaretIdx - 1, offset: "after" } : undefined,
    };
  }

  const insertPos = caretOffsetOf(session);
  const newText = chars.slice(0, insertPos).join("") + inserted.join("") + chars.slice(insertPos).join("");
  const newCaretIdx = insertPos + inserted.length;
  return {
    ...session,
    text: newText,
    caret: { start: newCaretIdx, end: newCaretIdx },
    lastOp: "insert",
    glyphCaret: gc ? { ...gc, glyphIndex: newCaretIdx - 1, offset: "after" } : undefined,
  };
}

/**
 * Backspace：删除 glyph caret 左侧的字符。更新 text + glyphCaret。
 * 例：caret 在 glyphIndex=6 after（W 右侧），Backspace → 删 W，caret → 移到 W 前。
 */
export function backspaceAtGlyph(session: EditSession): EditSession {
  // M7-004B: guard 放宽 —— 无 glyphCaret 但**有 selection range** 时放行（Mouse Selection）。
  // 有 selection → 走 deleteSelection（无 glyphCaret 也支持）；无 selection → 单字符逻辑需 glyphCaret（guard 保证）。
  if (session.status !== "active" || (!session.glyphCaret && !hasSelection(session))) return session;
  // M7-003: 有 selection → 删除整个 selection（不删左侧单字符）
  if (hasSelection(session)) return deleteSelection(session);
  const gc = session.glyphCaret;
  const delPos = caretOffsetOf(session) - 1; // 删 caret 左侧字符
  if (delPos < 0) return session; // 行首，无可删
  const chars = Array.from(session.text);
  const newText = chars.slice(0, delPos).join("") + chars.slice(delPos + 1).join("");
  const newCaretIdx = Math.max(0, delPos);
  return {
    ...session,
    text: newText,
    caret: { start: newCaretIdx, end: newCaretIdx },
    lastOp: "delete",
    glyphCaret: gc ? { ...gc, glyphIndex: newCaretIdx === 0 ? 0 : newCaretIdx - 1, offset: "after" } : undefined,
  };
}

/**
 * Delete：删除 glyph caret 右侧的字符。更新 text + glyphCaret（与 backspaceAtGlyph 对称）。
 * 例：caret 在 W before（HELLO|WORLD），Delete → 删 W → HELLO ORLD，caret 仍停在 O 前。
 * 语义（PM）：Backspace 删左侧，Delete 删右侧；Delete 不改变 caret 的字符偏移。
 */
export function deleteAtGlyph(session: EditSession): EditSession {
  // M7-004B: guard 放宽 —— 无 glyphCaret 但**有 selection range** 时放行（Mouse Selection）。
  if (session.status !== "active" || (!session.glyphCaret && !hasSelection(session))) return session;
  // M7-003: 有 selection → 删除整个 selection（不删 caret 右侧单字符）
  if (hasSelection(session)) return deleteSelection(session);
  const gc = session.glyphCaret;
  const delPos = caretOffsetOf(session); // 删 caret 右侧/当前 glyph
  const chars = Array.from(session.text);
  if (delPos >= chars.length) return session; // 行尾，无可删
  const newText = chars.slice(0, delPos).join("") + chars.slice(delPos + 1).join("");
  const newCaretIdx = Math.min(delPos, newText.length);
  return {
    ...session,
    text: newText,
    caret: { start: newCaretIdx, end: newCaretIdx },
    lastOp: "delete",
    glyphCaret: gc
      ? { ...gc, glyphIndex: newCaretIdx === 0 ? 0 : newCaretIdx - 1, offset: "after" }
      : undefined,
  };
}

/**
 * ADR-048: 首次输入的 replace-selection → text-edit 转换（纯逻辑，无 mutation）。
 *
 * 语义（002D → 003C）：
 *   点击 W：session.editingMode="replace-selection"，text="W"，target={6,6}，glyphCaret={6,before}。
 *   输入 X：handler 从 document 读取完整行 fullLineText="HELLO WORLD"，调用本函数：
 *     → replace selected glyph（range {6,6}: W→X）→ text="HELLO XORLD"
 *     → editingMode="text-edit"，glyphCaret 移到 X 后（由新文本解析，非旧 index++）。
 *
 * 参数 fullLineText 由 handler 从 Document Model 读取（本函数无 document context）。
 */
export function replaceSelection(
  session: EditSession,
  fullLineText: string,
  replacement: string
): EditSession {
  if (session.status !== "active") return session;
  if (session.editingMode !== "replace-selection") return session;

  const chars = Array.from(fullLineText);
  const start = Math.max(0, Math.min(session.target.startGlyphIndex, chars.length));
  const end = Math.max(start, Math.min(session.target.endGlyphIndex, chars.length - 1));
  const newLine =
    chars.slice(0, start).join("") + replacement + chars.slice(end + 1).join("");
  const caretIdx = start + Array.from(replacement).length;

  return {
    ...session,
    text: newLine,
    editingMode: "text-edit",
    caret: { start: caretIdx, end: caretIdx },
    lastOp: "replace",
    glyphCaret: {
      lineId: session.target.lineId,
      glyphIndex: Math.max(0, caretIdx - 1),
      offset: "after",
      affinity: session.glyphCaret?.affinity ?? "forward",
    },
  };
}

function clampCaret(c: { start: number; end: number }, len: number): { start: number; end: number } {
  const start = Math.max(0, Math.min(c.start, len));
  const end = Math.max(start, Math.min(c.end, len));
  return { start, end };
}

/**
 * M7.7-006B (CJK/insertText 回收)：以 textarea 的最新值重建 session。
 *
 * 根因：非 ASCII（尤其中文）在浏览器/headless 下经「浏览器 insertText」直接改 textarea.value，
 *   不触发 keydown 逐字符（handleKeyboardEdit 只认 keydown）。原 onChange 为空 handler →
 *   textarea.value 变成 "姓名：李" 但 session.text 停在 "姓名：张三" → commit 时
 *   text == originalText → onCancel（编辑静默丢失）。
 *
 * 修法：把 textarea 最终 value 一次性回收为 session 的新 text，caret collapsed 到
 *   textarea.selectionStart（UTF-16），转 text-edit、清 selection/composing、glyphCaret 重定位。
 *   与 keydown 逐插入（insertAtGlyph）互不干扰：英文走 keydown（React 已同步 value，onChange
 *   命中 value===text → no-op）；CJK 走本函数。
 */
export function applyTextareaValue(
  session: EditSession,
  value: string,
  cursorUtf16: number
): EditSession {
  if (session.status !== "active") return session;
  // textarea.selectionStart 是 UTF-16 编码单元；value.length 也是 UTF-16，两者同空间（BMP 常用汉字 1 单元）。
  const c = Math.max(0, Math.min(cursorUtf16, value.length));
  const gc = session.glyphCaret;
  return {
    ...session,
    text: value,
    caret: { start: c, end: c },
    selectionAnchor: undefined,
    editingMode: "text-edit",
    composing: undefined,
    lastOp: "replace",
    glyphCaret: gc
      ? {
          ...gc,
          glyphIndex: value.length === 0 ? 0 : Math.max(0, c - 1),
          offset: value.length === 0 || c === 0 ? "before" : "after",
        }
      : undefined,
  };
}
