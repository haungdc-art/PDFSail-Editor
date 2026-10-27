/**
 * editor/core/input/input.ts — EDITOR-CORE-008
 *
 * InputAdapter：归一化输入事件 → CORE-003 Command 的门面。
 *
 *     Keyboard / IME / Paste
 *              ↓
 *        InputAdapter            ← 本文件（纯函数式状态机，无 DOM）
 *              ↓
 *        EditorCommand[]
 *              ↓
 *        EditorHistory.commit()  ← 调用方负责（CORE-004）
 *              ↓
 *        EditorDocument
 *              ↓
 *        TextLayout              ← 009/010
 *
 * ── InputAdapter 不是 Editor Engine ───────────────────────────────
 *   · 不执行 Command（只产出）
 *   · 不持有文档真相（每次都从 `InputContext` 读，不缓存 document）
 *   · 不做 undo/redo、不做 layout、不做渲染
 *   · 唯一的内部状态是 **IME 组合状态**（这是输入协议本身要求的）
 */

import type { EditorCommand } from "../commands/types";
import { SetTextStyleCommand } from "../commands/set-text-style";
import { CompositionTracker, type CompositionState } from "./composition";
import { commandsForAction, insertOrReplace, resolveKeyAction } from "./keyboard";
import { commandsForPaste } from "./paste";
import { resolveTextStyleToggle } from "./resolve-text-style-toggle";
import {
  DEFAULT_INPUT_OPTIONS,
  type InputAdapterOptions,
  type InputAdapterResult,
  type InputContext,
  type InputEvent,
} from "./types";

export class InputAdapter {
  private readonly options: Required<InputAdapterOptions>;
  private readonly composition = new CompositionTracker();

  constructor(options: InputAdapterOptions = {}) {
    this.options = { ...DEFAULT_INPUT_OPTIONS, ...options };
  }

  /** IME 组合状态（只读视图） */
  get compositionState(): CompositionState {
    return this.composition.state;
  }

  /** 复位组合状态（换文档 / 失焦时调用） */
  reset(): void {
    this.composition.reset();
  }

  handle(event: InputEvent, context: InputContext): InputAdapterResult {
    switch (event.type) {
      case "text": {
        if (event.text === "") {
          return this.result([], "noop", ["空文本输入 → 0 个 Command"]);
        }
        return this.result(insertOrReplace(context, event.text), "insert", []);
      }

      case "keydown": {
        const action = resolveKeyAction(event, this.options);
        const printable = event.key.length === 1 ? event.key : "";
        const outcome = commandsForAction(action, context, printable);
        return this.result(outcome.commands, action.kind, outcome.warnings);
      }

      case "paste": {
        const outcome = commandsForPaste(context, event.text);
        return this.result(outcome.commands, "paste", outcome.warnings);
      }

      case "compositionStart": {
        // 捕获选区/插入点（组合期间的 UI 临时选区不作为 Document Truth）
        this.composition.start(context);
        return this.result([], "composition-start", []);
      }

      case "compositionUpdate": {
        // 只记录预览：0 Command、不改文档、不进 History（规范 §22）
        this.composition.update(event.text);
        return this.result([], "composition-update", []);
      }

      case "compositionEnd": {
        const outcome = this.composition.end(event.text);
        return this.result(outcome.commands, "composition-end", outcome.warnings);
      }

      case "compositionCancel": {
        const outcome = this.composition.cancel();
        return this.result([], "composition-cancel", outcome.warnings);
      }

      case "set-text-style": {
        // ★ F3B-6.21-H1-B：意图（format）已在 `beforeInputToInputEvent` 处归一化；
        //   此处只做「读 Core selection 当前 style → 翻转」的解析，绝不读 DOM。
        //   · 折叠 / 跨 TextBox / 跨 paragraph ⇒ `resolveTextStyleToggle` 返回 null
        //     ⇒ 0 Command（V1 no-op，不伪造 mutation、不入 History）。
        //   · 否则产出 **恰好 1 条** `SetTextStyleCommand`（range 来自 Core selection）。
        const style = resolveTextStyleToggle(context.document, context.selection, event.format);
        if (!style) {
          return this.result([], "set-text-style-noop", ["set-text-style 未解析出可应用的 style（折叠/跨段/uniform-on 翻转后无目标）"]);
        }
        return this.result(
          [new SetTextStyleCommand(context.selection, style)],
          "set-text-style",
          []
        );
      }

      default:
        // 穷尽性保护：新增事件类型时 TS 会在此报错
        return this.result([], "noop", ["未识别的输入事件"]);
    }
  }

  private result(
    commands: EditorCommand[],
    action: string,
    warnings: string[]
  ): InputAdapterResult {
    return {
      commands,
      action,
      warnings: warnings.slice(0, this.options.maxWarnings),
    };
  }
}

export function createInputAdapter(options?: InputAdapterOptions): InputAdapter {
  return new InputAdapter(options);
}

/** 无状态便捷入口（一次性事件，不含 IME 组合语义） */
export function handleInputEvent(
  event: Exclude<InputEvent, { type: "compositionStart" | "compositionUpdate" | "compositionEnd" | "compositionCancel" }>,
  context: InputContext,
  options?: InputAdapterOptions
): InputAdapterResult {
  return new InputAdapter(options).handle(event, context);
}
