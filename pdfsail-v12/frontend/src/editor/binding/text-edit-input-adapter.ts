/**
 * editor/binding/text-edit-input-adapter.ts — F3B-6.17-3C-10C.1
 *
 * **TextEditInputAdapter Contract**（contract-only，纯函数，**不接生产**）。
 *
 * ── 解决的架构问题 ───────────────────────────────────────────────────
 * `EditSession`（textarea 输入面）是另一个主要生产输入面，但它**不能直接连接 Core**：
 *
 *     EditSession 说 glyph index（target.startGlyphIndex / glyphCaret.glyphIndex）
 *     Core        说 UTF-16（TextPosition.offset）
 *
 * 且 `EditSession.caret` 是 **code point** 偏移，而 textarea 的 `selectionStart` 是
 * **UTF-16 code unit** 偏移 —— 三者混用（3C-5 审计已记录）。
 *
 * 因此本模块只做一件事：
 *
 *     EditSession 输入（glyph / codepoint）
 *              ↓  ← 唯一允许方向：glyph → UTF-16（复用 glyphRangeToUtf16Range）
 *     TextEditInputIntent（blockId + lineId + UTF-16 [start,end) + text）
 *              ↓
 *     Core `InputEvent`（喂给**既有** `editor/core/input` 层）
 *
 * ── 硬规则（用户裁决）────────────────────────────────────────────────
 *   · **进入 Core 后只使用 UTF-16**；绝不把 glyph range 带进 Core
 *   · **禁止**实现 `UTF-16 → glyph` 逆映射（3C-9B 已定案：emoji/ligature 下不成立）
 *   · 本模块**只产出 intent**，**绝不构造 Command** —— 具体 Command 由既有 Core
 *     input/command 层决定（`InputEvent + InputContext` → `EditorCommand[]`）
 *   · 不 import `../core/commands`、不改 `EditSession` / `TextEditOverlay` / `PDFEditor` /
 *     `DocumentSelection` / Legacy mutation kernel
 *
 * ── 与既有 Core input 层的关系 ───────────────────────────────────────
 * `editor/core/input/types.ts` 已经定义了 `InputEvent`（text / keydown / paste /
 * composition*）与 `InputContext{document, selection: TextRange, caret}`。
 * 本模块的产物 = **该层的输入**（`coreInputEvent` + UTF-16 区间），因此不需要新 Command、
 * 也不需要第二套 Core input contract。
 */

import type { InputEvent as CoreInputEvent } from "../core/input";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";

// ─────────────────────────────────────────────────────────────────────
//  ① 审计表（EditSession 真实输入操作清单；**数据**，可测可查）
// ─────────────────────────────────────────────────────────────────────

/** Core 是否已有稳定等价形态 */
export type TextEditCoreSupport = "supported" | "unsupported";

export interface TextEditInputInventoryRow {
  /** 生产事件源 */
  readonly source: string;
  /** EditSession 侧入口（handler / 纯函数） */
  readonly sessionEntry: string;
  /** 当前 Legacy 落点（TextOperation / mutation kernel / 非 mutation） */
  readonly legacyOperation: string;
  /** Core 等价形态（`null` = Core 无对应或不宜现在迁移） */
  readonly coreEquivalent: string | null;
  /** 坐标换算 */
  readonly coordinate: string;
  readonly support: TextEditCoreSupport;
  /** unsupported 的理由（不静默降级） */
  readonly reason?: string;
}

/**
 * 3C-10C.1 审计结果（真实生产代码逐处确认）。
 *
 * ⚠️ 这是**事实表**，不是愿望表：`unsupported` 的行**不得**被 Adapter 假装支持。
 */
export const TEXT_EDIT_INPUT_INVENTORY: readonly TextEditInputInventoryRow[] = [
  {
    source: "textarea keydown（可打印字符）",
    sessionEntry: "handleKeyboardEdit → insertAtGlyph / replaceSelection",
    legacyOperation: "TextOperation.replace（onTextEditSave → mutateLineText）",
    coreEquivalent: 'InputEvent {type:"text"}',
    coordinate: "glyph → UTF-16（glyphRangeToUtf16Range）",
    support: "supported",
  },
  {
    source: "textarea Backspace",
    sessionEntry: "handleKeyboardEdit → backspaceAtGlyph / deleteSelection",
    legacyOperation: "TextOperation.delete（applyDelete，suffix 左移）",
    coreEquivalent: 'InputEvent {type:"keydown", key:"Backspace"}',
    coordinate: "glyph caret → UTF-16 caret",
    support: "supported",
  },
  {
    source: "textarea Delete",
    sessionEntry: "handleKeyboardEdit → deleteAtGlyph / deleteSelection",
    legacyOperation: "TextOperation.delete（applyDelete）",
    coreEquivalent: 'InputEvent {type:"keydown", key:"Delete"}',
    coordinate: "glyph caret → UTF-16 caret",
    support: "supported",
  },
  {
    source: "textarea paste",
    sessionEntry: "handlePasteEdit → insertAtGlyph",
    legacyOperation: "TextOperation.insert（applyTextOperation.insert）",
    coreEquivalent: 'InputEvent {type:"paste", text}',
    coordinate: "glyph → UTF-16",
    support: "supported",
  },
  {
    source: "textarea input（CJK/insertText 回收）",
    sessionEntry: "onTextInput → applyTextareaValue（M7.7-006B）",
    legacyOperation: "TextOperation.replace（整行替换）",
    coreEquivalent: 'InputEvent {type:"text"}',
    coordinate: "UTF-16 textarea value → 行内 UTF-16",
    support: "supported",
  },
  {
    source: "selection replacement（拖选/双击后输入）",
    sessionEntry: "replaceSelection / insertAtGlyph(selection 分支)",
    legacyOperation: "TextOperation.replace（单次 range replacement）",
    coreEquivalent: 'InputEvent {type:"text"} + 非折叠 TextRange',
    coordinate: "glyph range → UTF-16 range",
    support: "supported",
  },
  {
    source: "IME composition（start/update/end）",
    sessionEntry: "startComposition / updateComposition / endComposition",
    legacyOperation: "中间态不 mutation；end ⇒ 一次 insert/replace",
    coreEquivalent: 'InputEvent {type:"compositionEnd"}',
    coordinate: "码点 → UTF-16",
    support: "supported",
    reason: "仅 **compositionEnd** 产生语义输入；start/update 为 transient（Core 有 compositionState 但中间态不进 Document）",
  },
  {
    source: "Enter",
    sessionEntry: "TextEditOverlay.handleKeyDown（**commit**，非换行）",
    legacyOperation: "onTextEditSave（commit 整行）",
    coreEquivalent: 'InputEvent {type:"keydown", key:"Enter"}',
    coordinate: "glyph range → UTF-16 range",
    support: "supported",
    reason: "Core 有等价形态（insertParagraph）；但 textarea 面当前把 Enter 当 **commit** ⇒ Adapter 不得擅自改成换行语义",
  },
  {
    source: "方向键 ArrowLeft/ArrowRight（含 Shift）",
    sessionEntry: "moveGlyphCaret / moveGlyphCaretSelect",
    legacyOperation: "无 mutation（只动 session caret）",
    coreEquivalent: null,
    coordinate: "glyph caret（无文本变更）",
    support: "unsupported",
    reason: "Core 没有 glyph 级 caret identity；navigation 属 **UI caret 层**，不是 Document 输入",
  },
  {
    source: "Home / End（含 Shift）",
    sessionEntry: "moveGlyphCaretHome / …End / …SelectHome / …SelectEnd",
    legacyOperation: "无 mutation",
    coreEquivalent: null,
    coordinate: "glyph caret",
    support: "unsupported",
    reason: "同方向键：行首/行尾是 glyph-width 概念，Core 只有 UTF-16 文本坐标",
  },
  {
    source: "Ctrl/Cmd+A",
    sessionEntry: "selectAll",
    legacyOperation: "无 mutation",
    coreEquivalent: null,
    coordinate: "glyph caret",
    support: "unsupported",
    reason: "整行选择 = Legacy glyph 语义（Core 的 selection 由 TextRange 表达，属独立 contract）",
  },
  {
    source: "词级删除（Ctrl+Backspace / Alt+Backspace）",
    sessionEntry: "**无**（keydown 分支未覆盖）",
    legacyOperation: "无（浏览器默认行为被 textarea 吞掉）",
    coreEquivalent: null,
    coordinate: "n/a",
    support: "unsupported",
    reason: "生产未接线；不得在 Adapter 中发明词边界规则",
  },
  {
    source: "textarea 点击 / 双击 / 拖选（caret 定位）",
    sessionEntry: "syncCaretFromDomSelection / glyphCaretFromClick（click half 判定）",
    legacyOperation: "无 mutation（DOM caret → session caret）",
    coreEquivalent: null,
    coordinate: "UTF-16 ↔ 码点（**反向不成立**）",
    support: "unsupported",
    reason: "click half / glyph identity 是 **UI hit-test** 概念；Core 侧应由 CanonicalSelection 承担（3C-10S 已完成）",
  },
  {
    source: "blur / Esc / 150ms 提交窗口",
    sessionEntry: "TextEditOverlay.handleBlur / handleSave / onCancel",
    legacyOperation: "commit 或 cancel 整行",
    coreEquivalent: null,
    coordinate: "n/a",
    support: "unsupported",
    reason: "生命周期（何时 commit）属**输入面 orchestration**，不是 Document 输入 intent",
  },
  {
    source: "多段落 selection（ranges.length > 1）",
    sessionEntry: "createEditSession → **SAFE REJECT**（返回 null）",
    legacyOperation: "无（会话根本不创建）",
    coreEquivalent: null,
    coordinate: "n/a",
    support: "unsupported",
    reason: "Legacy 已 SAFE REJECT；Core 侧跨段落 range 未建模，绝不在 Adapter 里压缩成单段落",
  },
];

/** 该事件源是否已被 Core 建模（供调用方决定路由；绝不猜） */
export function textEditInputSupported(row: TextEditInputInventoryRow): boolean {
  return row.support === "supported";
}

// ─────────────────────────────────────────────────────────────────────
//  ② Adapter 输入（EditSession 侧的**结构投影**；Adapter 不拥有 session）
// ─────────────────────────────────────────────────────────────────────

/** glyph 级 caret（`EditSession.glyphCaret` 的结构投影） */
export interface TextEditGlyphCaretLike {
  readonly glyphIndex: number;
  readonly offset: "before" | "after";
}

/**
 * EditSession 的只读快照（Adapter 唯一可见的 Legacy 侧形态）。
 *
 * ⚠️ 刻意**不** import `EditSession` 类型：Adapter 只消费这些字段，
 *    这样它同样可用于 textarea / contentEditable 两条输入面（不绑定具体 session 实现）。
 */
export interface TextEditSessionSnapshot {
  readonly blockId: string;
  readonly lineId: string;
  /**
   * ADR-048 语义轴：决定 `caret` 的基准
   *   · `replace-selection` ⇒ session.text = **选中 fragment**，affected range = `target` glyph 区间
   *   · `text-edit`         ⇒ session.text = **整行 working text**，caret 是行内码点偏移
   */
  readonly editingMode: "replace-selection" | "text-edit";
  /** Legacy glyph 区间（**含端**）—— `EditSession.target` */
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
  /** `EditSession.caret`（session.text 内 **码点** 偏移；start===end = collapsed） */
  readonly caret: { readonly start: number; readonly end: number };
  /** 当前 session.text（text-edit 模式下 = 整行；用于码点 → UTF-16 换算） */
  readonly sessionText: string;
  /** 该行 glyph 序列（Legacy PDF binding 数据）——glyph → UTF-16 的**唯一**依据 */
  readonly glyphs: ReadonlyArray<{ readonly char?: string; readonly originalChar?: string }>;
}

/** Adapter 接受的输入操作（= 审计表中 `supported` 的行） */
export type TextEditInputRequest =
  /** 可打印字符 / IME end / textarea value 回收（替换当前 selection 或插入 caret） */
  | { readonly kind: "insert-text"; readonly text: string }
  /** 剪贴板粘贴（语义同 insert，但 Core 事件类型为 paste） */
  | { readonly kind: "paste"; readonly text: string }
  /** Backspace（有 selection ⇒ 删除 selection；collapsed ⇒ Core 的 Backspace 语义） */
  | { readonly kind: "delete-backward" }
  /** Delete（有 selection ⇒ 删除 selection；collapsed ⇒ Core 的 Delete 语义） */
  | { readonly kind: "delete-forward" }
  /**
   * 3C-10C.3A：**显式 range 删除**（= 把 affected range 删掉；`text` 恒为 ""）。
   *
   * 为什么需要它：`delete-backward/forward` 是 **caret + 键方向**语义（只删一个字符），
   * 而 session commit 的语义是「把 LCP/LCS 投影出的**跨度**整体删除」——
   * Legacy 侧对应 `TextOperation.delete`（`applyDelete`）。折叠 range ⇒ 无物可删 ⇒ fail-closed。
   */
  | { readonly kind: "delete-range" }
  /** Enter（Core 有等价形态；textarea 面当前把它当 commit —— 见审计表） */
  | { readonly kind: "insert-paragraph" };

/**
 * 被 contract 建模的 kind 白名单（**封闭集合**）。
 *
 * Shadow（3C-10C.2）会把真实按键原样喂进来 —— 未建模的导航键必须得到明确的
 * `unsupported-operation`，而不是被其它校验抢先报成 `out-of-bounds`。
 */
export const TEXT_EDIT_SUPPORTED_KINDS: readonly TextEditInputRequest["kind"][] = [
  "insert-text",
  "paste",
  "delete-backward",
  "delete-forward",
  "delete-range",
  "insert-paragraph",
];

// ─────────────────────────────────────────────────────────────────────
//  ③ Adapter 输出（intent；**不是** Command）
// ─────────────────────────────────────────────────────────────────────

export type TextEditInputIntentKind =
  | "insert"
  | "replace-range"
  | "delete-range"
  | "delete-backward"
  | "delete-forward"
  | "insert-paragraph"
  | "paste";

export interface TextEditInputIntent {
  readonly kind: TextEditInputIntentKind;
  readonly blockId: string;
  readonly lineId: string;
  /** **UTF-16 半开区间**（行内）；canonical / Core 同口径 */
  readonly range: { readonly startOffsetUtf16: number; readonly endOffsetUtf16: number };
  readonly text: string;
  /** 归一化后的 Core 输入事件（喂给既有 `editor/core/input`；本模块**不**构造 Command） */
  readonly coreInputEvent: CoreInputEvent;
  /** 诊断标签（不静默降级） */
  readonly action: string;
}

export type TextEditInputRejection =
  | "unresolved-line"
  | "empty-glyph-sequence"
  | "invalid-range"
  | "out-of-bounds"
  | "empty-input"
  | "unsupported-operation";

export type TextEditInputResult =
  | { readonly ok: true; readonly intent: TextEditInputIntent }
  | { readonly ok: false; readonly reason: TextEditInputRejection };

// ─────────────────────────────────────────────────────────────────────
//  ④ 坐标换算（**只有** glyph → UTF-16 这一个方向）
// ─────────────────────────────────────────────────────────────────────

/** 单个 glyph 的 UTF-16 长度（`char` 优先，回退 `originalChar`） */
function utf16LengthOf(glyph: { readonly char?: string; readonly originalChar?: string }): number {
  const ch = glyph.char ?? glyph.originalChar ?? "";
  return ch.length;
}

/**
 * glyph 级 caret → 行内 **UTF-16** 偏移。
 *
 * 语义（对应 `EditSession.glyphCaret`）：
 *   · `offset === "before"` ⇒ 该 glyph **之前**的 UTF-16 偏移
 *   · `offset === "after"`  ⇒ 该 glyph **之后**的 UTF-16 偏移
 *
 * ⚠️ 这是 `caretOffsetOf`（`glyphIndex + 1`，**码点**语义）的**正确 UTF-16 版本** ——
 *    emoji / ligature 下 `glyphIndex + 1` 与 UTF-16 偏移不相等。
 * ⚠️ 只做 glyph → UTF-16；**绝不**反过来。
 */
export function glyphCaretToUtf16Offset(
  glyphs: ReadonlyArray<{ readonly char?: string; readonly originalChar?: string }>,
  caret: TextEditGlyphCaretLike
): number {
  const index = Math.max(0, Math.min(caret.glyphIndex, Math.max(0, glyphs.length - 1)));
  let offset = 0;
  for (let i = 0; i < index; i++) offset += utf16LengthOf(glyphs[i]);
  if (caret.offset === "after") offset += utf16LengthOf(glyphs[index]);
  return offset;
}

/** 码点偏移 → UTF-16 偏移（session.text 内；仅 **前向**，与 `glyphRangeToUtf16Range` 同口径） */
export function codepointToUtf16Offset(text: string, codepointOffset: number): number {
  const chars = Array.from(text);
  const n = Math.max(0, Math.min(codepointOffset, chars.length));
  let offset = 0;
  for (let i = 0; i < n; i++) offset += chars[i].length;
  return offset;
}

/** 行内 UTF-16 长度（glyph char 累加；禁止用 `text.length === glyphCount` 假设） */
export function lineUtf16Length(
  glyphs: ReadonlyArray<{ readonly char?: string; readonly originalChar?: string }>
): number {
  let total = 0;
  for (const g of glyphs) total += utf16LengthOf(g);
  return total;
}

// ─────────────────────────────────────────────────────────────────────
//  ⑤ Adapter（纯函数）
// ─────────────────────────────────────────────────────────────────────

/** 区间解算结果（fail-closed：显式拒绝而非静默 clamp） */
type RangeResult =
  | { readonly ok: true; readonly range: { readonly startOffsetUtf16: number; readonly endOffsetUtf16: number } }
  | { readonly ok: false; readonly reason: TextEditInputRejection };

/**
 * 解出本次输入**作用的行内 UTF-16 区间**。
 *
 * · `replace-selection`：区间 = `target` glyph 区间（含端）→ `glyphRangeToUtf16Range`
 * · `text-edit`：区间 = `caret`（**码点**）→ UTF-16（基准 = `sessionText` = 整行）
 *
 * ⚠️ **显式越界校验**：`glyphRangeToUtf16Range` / `codepointToUtf16Offset` 对越界输入
 *    会**静默 clamp**（各自是纯换算工具，不做策略）。Adapter 是**策略层**：
 *    越界必须 fail-closed（否则会把「点到了不存在的 glyph」变成一次看似成功的编辑）。
 */
function affectedRangeUtf16(snapshot: TextEditSessionSnapshot, lineLength: number): RangeResult {
  if (snapshot.editingMode === "replace-selection") {
    const lastGlyph = snapshot.glyphs.length - 1;
    if (snapshot.startGlyphIndex > snapshot.endGlyphIndex) return { ok: false, reason: "invalid-range" };
    if (snapshot.startGlyphIndex < 0 || snapshot.endGlyphIndex > lastGlyph) {
      return { ok: false, reason: "out-of-bounds" };
    }
    const { start, end } = glyphRangeToUtf16Range(
      snapshot.glyphs as Parameters<typeof glyphRangeToUtf16Range>[0],
      snapshot.startGlyphIndex,
      snapshot.endGlyphIndex
    );
    return { ok: true, range: { startOffsetUtf16: start, endOffsetUtf16: end } };
  }

  // text-edit：caret 是 session.text 内**码点**偏移 —— 先校验，再换算（不依赖 clamp）
  const codepoints = Array.from(snapshot.sessionText).length;
  if (snapshot.caret.start > snapshot.caret.end) return { ok: false, reason: "invalid-range" };
  if (snapshot.caret.start < 0 || snapshot.caret.end > codepoints) {
    return { ok: false, reason: "out-of-bounds" };
  }
  const start = codepointToUtf16Offset(snapshot.sessionText, snapshot.caret.start);
  const end = codepointToUtf16Offset(snapshot.sessionText, snapshot.caret.end);
  if (end > lineLength) return { ok: false, reason: "out-of-bounds" };
  return { ok: true, range: { startOffsetUtf16: start, endOffsetUtf16: end } };
}

/**
 * EditSession 输入 → `TextEditInputIntent`（UTF-16 + Core `InputEvent`）。
 *
 * 失败一律 fail-closed（返回 reason）——**不**猜区间、**不**降级成插入、**不**回落 Legacy。
 */
export function toTextEditInputIntent(
  request: TextEditInputRequest,
  snapshot: TextEditSessionSnapshot,
  options: { readonly lineUtf16Length?: number } = {}
): TextEditInputResult {
  // ★ 先判操作是否被 contract 建模：未建模（Home/End/方向键/词删/click-half…）
  //   必须在**任何**区间解析之前就 fail-closed，否则会被越界判定抢先报成 out-of-bounds，
  //   把「不支持」误报成「输入非法」。
  if (!TEXT_EDIT_SUPPORTED_KINDS.includes(request.kind)) {
    return { ok: false, reason: "unsupported-operation" };
  }
  if (!snapshot.blockId || !snapshot.lineId) return { ok: false, reason: "unresolved-line" };
  if (snapshot.glyphs.length === 0) return { ok: false, reason: "empty-glyph-sequence" };

  const lineLength = options.lineUtf16Length ?? lineUtf16Length(snapshot.glyphs);
  const resolved = affectedRangeUtf16(snapshot, lineLength);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const range = resolved.range;

  const hasSelection = range.startOffsetUtf16 !== range.endOffsetUtf16;

  switch (request.kind) {
    case "insert-text": {
      if (request.text.length === 0) return { ok: false, reason: "empty-input" };
      return {
        ok: true,
        intent: {
          kind: hasSelection ? "replace-range" : "insert",
          blockId: snapshot.blockId,
          lineId: snapshot.lineId,
          range,
          text: request.text,
          coreInputEvent: { type: "text", text: request.text },
          action: hasSelection ? "selection-replace" : "insert",
        },
      };
    }
    case "paste": {
      if (request.text.length === 0) return { ok: false, reason: "empty-input" };
      return {
        ok: true,
        intent: {
          kind: "paste",
          blockId: snapshot.blockId,
          lineId: snapshot.lineId,
          range,
          text: request.text,
          coreInputEvent: { type: "paste", text: request.text },
          action: "paste",
        },
      };
    }
    case "delete-backward":
    case "delete-forward": {
      // 有 selection ⇒ Core 的 Delete 语义（删除选区）；collapsed ⇒ 键名区分左右
      const backward = request.kind === "delete-backward";
      const key = hasSelection ? "Delete" : backward ? "Backspace" : "Delete";
      return {
        ok: true,
        intent: {
          kind: hasSelection ? "replace-range" : backward ? "delete-backward" : "delete-forward",
          blockId: snapshot.blockId,
          lineId: snapshot.lineId,
          // collapsed 时区间为插入点（半开零宽）；Core 依 key 决定删左/删右
          range: hasSelection ? range : { startOffsetUtf16: range.startOffsetUtf16, endOffsetUtf16: range.startOffsetUtf16 },
          text: "",
          coreInputEvent: { type: "keydown", key },
          action: hasSelection ? "delete-selection" : backward ? "delete-backward" : "delete-forward",
        },
      };
    }
    case "delete-range": {
      // 3C-10C.3A：显式 range 删除（折叠 range ⇒ 无物可删 ⇒ fail-closed，绝不产生空删除）
      if (!hasSelection) return { ok: false, reason: "empty-input" };
      return {
        ok: true,
        intent: {
          kind: "delete-range",
          blockId: snapshot.blockId,
          lineId: snapshot.lineId,
          range,
          text: "",
          coreInputEvent: { type: "keydown", key: "Delete" },
          action: "delete-range",
        },
      };
    }
    case "insert-paragraph": {
      return {
        ok: true,
        intent: {
          kind: "insert-paragraph",
          blockId: snapshot.blockId,
          lineId: snapshot.lineId,
          range,
          text: "\n",
          coreInputEvent: { type: "keydown", key: "Enter" },
          action: "insert-paragraph",
        },
      };
    }
    default:
      // 类型层已穷尽；运行期兜底（例如 JS 调用方传入未建模 kind）
      return { ok: false, reason: "unsupported-operation" };
  }
}
