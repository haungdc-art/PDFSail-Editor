/**
 * editor/core/input/types.ts — EDITOR-CORE-008
 *
 * Input Contract（规范 §21 / §49）。
 *
 * ── 唯一职责 ────────────────────────────────────────────────────────
 *     InputEvent  →  EditorCommand[]（CORE-003 的既有 Command）
 *
 * 而不是：
 *     DOM → 改 DOM text → 再同步 Document
 *
 * Input Adapter **不拥有文档真相**：它只把输入翻译成 Command，
 * 是否执行、何时进 History、执行后 caret 落在哪里，全部由调用方
 * 通过 CORE-004 的 `EditorHistory.commit()` 决定。
 *
 * ── 明确不做（008 禁止事项）─────────────────────────────────────────
 *   · React / DOM / contentEditable / textarea
 *   · PDF.js / Segment / EditableTextNode / EditSession / docBlocks
 *   · glyphIndex
 *   · 直接修改 EditorDocument
 *   · 自己实现 undo/redo（那是 CORE-004）
 *   · 自己实现 layout（那是 CORE-006-B）
 *   · 浏览器如何渲染输入（那是 009/010）
 *
 * ── 依赖边界（规范 §57）────────────────────────────────────────────
 *   允许：`../document`、`../position`、`../commands`
 *   禁止：其余一切（含 `../layout`、`../history` —— History 由**调用方**使用）
 *
 * ── 关于 caret/selection 恢复的架构决定 ────────────────────────────
 * 008 **不预测**编辑后的 caret。原因：真实结果位置取决于 Command 执行后的文档
 * （例如 InsertText 在带 provenance 的 run 上会新建 run，runId 无法从输入推导；
 * 文本含 "\n" 时还会新建段落，段落 id 由命令内部生成）。
 * 因此：
 *   · adapter 只产出 `commands`
 *   · 执行后状态由调用方交给 CORE-004 `commit()`；未提供时使用其 clamp 收敛
 *   · 009（Live Reflow）可在**结果文档**上重新定位 caret，而不是在这里猜
 * 这是刻意的职责切分，不是遗漏。
 */

import type { EditorCommand } from "../commands/types";
import type { EditorDocument } from "../document/types";
import type { Caret, TextRange } from "../position/types";

/**
 * 归一化输入事件。
 *
 * 未来由 UI 侧的 DOM adapter 负责把真实事件翻译成这些形态
 * （`beforeinput` → `text`；`keydown` → `keydown`；`paste` → `paste`；
 *   `compositionstart/update/end` → 对应事件）。
 * Editor Core 只认识这里的形态，**不认识 DOM**。
 */
export type InputEvent =
  /** 已由浏览器/IME 决定的字符输入（`beforeinput` / `insertText`） */
  | { type: "text"; text: string }
  /**
   * 原始按键。**只用于控制键**（Enter / Backspace / Delete 等）。
   * 可打印字符请走 `text` 事件，避免 `keydown` 与 `beforeinput` 双重插入。
   */
  | {
      type: "keydown";
      key: string;
      ctrlKey?: boolean;
      metaKey?: boolean;
      altKey?: boolean;
      shiftKey?: boolean;
    }
  /** 剪贴板文本粘贴 */
  | { type: "paste"; text: string }
  | { type: "compositionStart" }
  | { type: "compositionUpdate"; text: string }
  | { type: "compositionEnd"; text: string }
  /** 组合输入被取消（Esc / 失焦） */
  | { type: "compositionCancel" }
  /**
   * 文本样式切换意图（bold / italic / underline / strike）。
   * ⚠️ 仅携带 `format` 意图，**绝不携带 toggle 后的最终 style**；
   *   toggle 解析（读 Core selection 当前 style → 翻转）由调用方在 Core document 上完成。
   * 对应 `beforeinput` 的 `formatBold / formatItalic / formatUnderline / formatStrikeThrough`。
   */
  | { type: "set-text-style"; format: TextFormatKind };

/**
 * 可切换的文本样式能力。与 `TextStyle` 中的对应字段一一映射：
 *   bold → fontWeight；italic → fontStyle；underline → underline；strike → strike。
 */
export type TextFormatKind = "bold" | "italic" | "underline" | "strike";

/** 输入处理所需的只读上下文 */
export interface InputContext {
  /** 当前文档（只读；adapter 绝不修改它） */
  document: EditorDocument;
  /** 当前选区（文档坐标） */
  selection: TextRange;
  /** 当前插入点；缺省时用 `selection.focus` 构造（affinity = "forward"） */
  caret?: Caret;
}

/** adapter 产出 */
export interface InputAdapterResult {
  /** 要执行的命令序列；空数组 = 不产生任何 Command（例如 IME 中间态） */
  commands: EditorCommand[];
  /** 语义动作标签（诊断用，例如 "insert" / "composition-update" / "noop"） */
  action: string;
  /** 诊断信息（不静默降级） */
  warnings: string[];
}

export const DEFAULT_INPUT_OPTIONS: Required<InputAdapterOptions> = {
  insertOnPrintableKey: false,
  maxWarnings: 6,
};

export interface InputAdapterOptions {
  /**
   * `keydown` 收到单个可打印字符时是否直接插入。
   *
   * 缺省 **false** —— 现代浏览器应通过 `beforeinput`/`text` 事件输入字符，
   * 若同时从 `keydown` 插入会导致**双重输入**。
   * 仅在无 `beforeinput` 的环境（部分测试/旧环境）才开启。
   */
  insertOnPrintableKey?: boolean;
  maxWarnings?: number;
}

/** 从上下文取插入点（caret 缺省由 selection.focus 构造） */
export function caretOf(context: InputContext): Caret {
  return context.caret ?? { position: context.selection.focus, affinity: "forward" };
}
