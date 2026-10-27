/**
 * editor/core/input/composition.ts — EDITOR-CORE-008
 *
 * IME 组合输入状态机（规范 §22）。008 的核心验收点。
 *
 * ── 必须成立的性质 ─────────────────────────────────────────────────
 *     compositionstart
 *     compositionupdate × N     → ❌ 0 个 Command（不改文档、不进 History）
 *     compositionend(finalText) → ✅ **恰好 1 个 Command**
 *
 * ── 为什么要在 start 时捕获选区 ─────────────────────────────────────
 * 组合期间的 UI 临时选区（通常由 DOM 渲染的 composition 高亮决定）
 * **不是** Document Truth。如果在 `compositionend` 时读取"当前"选区来猜插入点，
 * 就会出现「组合期间选区漂移 → 插入到错误位置」这一类经典 bug。
 * 因此：
 *
 *     compositionstart → 捕获 selection/caret
 *     compositionupdate × N → 只记录预览文本
 *     compositionend(text) → 用**捕获的** selection 构造 Command
 *
 * ── 不确定结果 ─────────────────────────────────────────────────────
 *   text 为空               → 0 个 Command（空组合，例如用户取消输入）
 *   没有 start 就 end       → 0 个 Command + warning（不在无捕获位置时瞎猜）
 *   cancel / 取消后 update  → 0 个 Command
 */

import { InsertTextCommand, ReplaceTextCommand } from "../commands/index";
import type { EditorCommand } from "../commands/types";
import type { Caret, TextRange } from "../position/types";
import { caretOf, type InputContext } from "./types";

export interface CompositionState {
  /** 是否处于组合中 */
  active: boolean;
  /** compositionstart 时捕获的选区（Document Truth 快照） */
  startSelection: TextRange | null;
  /** compositionstart 时捕获的插入点 */
  startCaret: Caret | null;
  /** 最近一次 compositionupdate 的文本（仅供诊断，不进入文档） */
  previewText: string;
  /** 收到的 update 次数（用于验证"中间态不产生 Command"） */
  updates: number;
  /** 本次组合最终产生的 Command 数（诊断） */
  committedCommands: number;
}

function emptyState(): CompositionState {
  return {
    active: false,
    startSelection: null,
    startCaret: null,
    previewText: "",
    updates: 0,
    committedCommands: 0,
  };
}

export interface CompositionEndResult {
  commands: EditorCommand[];
  warnings: string[];
}

export class CompositionTracker {
  private current: CompositionState = emptyState();

  get state(): CompositionState {
    return { ...this.current };
  }

  /** compositionstart：捕获选区与插入点 */
  start(context: InputContext): void {
    this.current = {
      ...emptyState(),
      active: true,
      startSelection: context.selection,
      startCaret: caretOf(context),
    };
  }

  /**
   * compositionupdate：**只记录**，绝不产生 Command、绝不修改文档。
   */
  update(text: string): void {
    if (!this.current.active) return;
    this.current.previewText = text;
    this.current.updates += 1;
  }

  /**
   * compositionend：用**捕获的** selection 产生恰好 0 或 1 个 Command。
   *
   * @param text 浏览器给出的最终组合文本（不是预览）
   */
  end(text: string): CompositionEndResult {
    const warnings: string[] = [];
    if (!this.current.active || !this.current.startSelection || !this.current.startCaret) {
      this.current = emptyState();
      warnings.push("compositionend 没有对应的 compositionstart：忽略（不在无捕获位置时猜测插入点）");
      return { commands: [], warnings };
    }

    const captured = this.current.startSelection;
    const capturedCaret = this.current.startCaret;
    this.current = emptyState();

    if (text === "") {
      warnings.push("组合文本为空 → 0 个 Command（空组合/取消）");
      return { commands: [], warnings };
    }

    const collapsed =
      captured.anchor.textBoxId === captured.focus.textBoxId &&
      captured.anchor.paragraphId === captured.focus.paragraphId &&
      captured.anchor.runId === captured.focus.runId &&
      captured.anchor.offset === captured.focus.offset;

    const command: EditorCommand = collapsed
      ? new InsertTextCommand(capturedCaret.position, text)
      : new ReplaceTextCommand(captured, text);

    this.current.committedCommands = 1;
    return { commands: [command], warnings };
  }

  /** compositioncancel：直接回到初始态 */
  cancel(): CompositionEndResult {
    const wasActive = this.current.active;
    this.current = emptyState();
    return {
      commands: [],
      warnings: wasActive ? [] : ["compositionCancel 没有对应的 compositionstart：忽略"],
    };
  }

  /** 强制复位（例如失焦 / 换文档） */
  reset(): void {
    this.current = emptyState();
  }
}

/** 便捷函数形态（无状态场景：start 后立刻 end） */
export function commandsForComposition(
  context: InputContext,
  text: string
): CompositionEndResult {
  const tracker = new CompositionTracker();
  tracker.start(context);
  return tracker.end(text);
}
