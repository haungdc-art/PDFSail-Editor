/**
 * editor/core/input/keyboard.ts — EDITOR-CORE-008
 *
 * 键盘与字符输入 → CORE-003 Command。
 *
 * ── 映射（不新建第三套 EditOperation）─────────────────────────────
 *   字符输入（有选区）  → ReplaceTextCommand
 *   字符输入（折叠）    → InsertTextCommand
 *   选中后按键          → DeleteTextCommand / ReplaceTextCommand
 *   Backspace           → DeleteTextCommand（向前扩展一个 code point）
 *   Delete              → DeleteTextCommand（向后扩展一个 code point）
 *   Enter               → SplitParagraphCommand（有选区时 ReplaceTextCommand("\n")）
 *
 * ── 字符级导航基于 **document**，不基于 Layout ────────────────────
 * 「前一个 / 后一个 code point」是文档结构问题（run / 段落边界 + 代理对），
 * 不是几何问题，因此本文件只读 `EditorDocument`，不涉及任何 Layout 几何。
 *
 * ── 代理对安全（规范 §9）──────────────────────────────────────────
 * 前进/后退都按 code point 步进：emoji 会被整体删除，不会被劈成半个。
 *
 * ── 本阶段未建模 ──────────────────────────────────────────────────
 * 词/行级删除（Ctrl/Alt + Backspace/Delete）、方向键导航、Home/End、Tab。
 * 这些命中「none」并给出 warning，而不是静默做错事。
 */

import { DeleteTextCommand, InsertTextCommand, ReplaceTextCommand, SplitParagraphCommand } from "../commands/index";
import type { EditorCommand } from "../commands/types";
import type { EditorDocument, Paragraph } from "../document/types";
import { findTextBox, getParagraphText } from "../document/query";
import {
  paragraphOffsetToPosition,
  positionToParagraphOffset,
  resolveTextPosition,
  textPositionEquals,
} from "../position/index";
import type { Caret, TextPosition, TextRange } from "../position/types";
import { caretOf, type InputAdapterOptions, type InputContext } from "./types";
import { wordRangeAt, type WordDirection } from "./word-boundary";

// ─────────────────────────────────────────────────────────────────────
//  语义动作
// ─────────────────────────────────────────────────────────────────────

/**
 * 删除粒度。
 *
 * `word`（F3B-6.21-F2 / E-C5-2）：词级删除由 **Core word boundary resolver**
 * （`word-boundary.ts`，段落级 UTF-16 `[start,end)`）计算，**不**依赖浏览器
 * 的 `deleteWord*` 结果（F1 §8：Chromium 的 CJK 分词 ≠ 本仓库契约）。
 */
export type DeleteUnit = "char" | "word";

export type KeyAction =
  | { kind: "insertText" }
  | { kind: "deleteBackward"; unit: DeleteUnit }
  | { kind: "deleteForward"; unit: DeleteUnit }
  | { kind: "splitParagraph" }
  | { kind: "none"; reason: string };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

/**
 * 按键 → 语义动作。
 *
 * 注意：**可打印字符默认返回 none**（由 `text` 事件负责），
 * 以免 `keydown` 与 `beforeinput` 双重插入。只有显式开启
 * `insertOnPrintableKey` 才从按键插入。
 */
export function resolveKeyAction(
  input: KeyInput,
  options: Pick<InputAdapterOptions, "insertOnPrintableKey"> = {}
): KeyAction {
  const { key, ctrlKey = false, metaKey = false, altKey = false } = input;
  const modifier = ctrlKey || metaKey || altKey;

  if (key === "Enter") return { kind: "splitParagraph" };

  if (key === "Backspace") {
    // ★ F3B-6.21-F2：词级删除已在 E-C5-2 建模（由 Core word boundary resolver 计算区间）
    if (modifier) return { kind: "deleteBackward", unit: "word" };
    return { kind: "deleteBackward", unit: "char" };
  }
  if (key === "Delete" || key === "Del") {
    if (modifier) return { kind: "deleteForward", unit: "word" };
    return { kind: "deleteForward", unit: "char" };
  }

  if (!modifier && key.length === 1 && !isControlChar(key)) {
    return options.insertOnPrintableKey ? { kind: "insertText" } : { kind: "none", reason: "字符输入应由 text 事件提供" };
  }

  return { kind: "none", reason: `未处理的按键 "${key}"` };
}

function isControlChar(key: string): boolean {
  const code = key.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

// ─────────────────────────────────────────────────────────────────────
//  文档级字符导航
// ─────────────────────────────────────────────────────────────────────

// ★ F3B-6.21-F2（裁决 2）：步进原语的**唯一实现**已提到 `code-point.ts`，
//   由本文件与 `word-boundary.ts` **共用**（禁止第二套代理对步进实现）。
//   此处保留同名导出 ⇒ 既有 import 路径不变，但语义来源单一。
import { stepBack, stepForward } from "./code-point";

export { stepBack, stepForward };

/** 段落内某 run 的段落偏移起点（document 为真相） */
function paragraphRanges(paragraph: Paragraph): Map<string, { start: number; end: number }> {
  const map = new Map<string, { start: number; end: number }>();
  let cursor = 0;
  for (const run of paragraph.runs) {
    map.set(run.id, { start: cursor, end: cursor + run.text.length });
    cursor += run.text.length;
  }
  return map;
}

/** 前一个 code point 位置（跨 run / 跨段落），文档开头返回 null */
export function previousPosition(
  document: EditorDocument,
  position: TextPosition
): TextPosition | null {
  const resolved = resolveTextPosition(document, position);
  const { paragraph, run, paragraphIndex, runIndex } = resolved;

  if (position.offset > 0) {
    return {
      textBoxId: position.textBoxId,
      paragraphId: position.paragraphId,
      runId: run.id,
      offset: stepBack(run.text, position.offset),
    };
  }

  // run 开头 → 上一个 run 的末尾
  if (runIndex > 0) {
    const prev = paragraph.runs[runIndex - 1];
    return {
      textBoxId: position.textBoxId,
      paragraphId: position.paragraphId,
      runId: prev.id,
      offset: prev.text.length,
    };
  }

  // 段落开头 → 上一段落的最后一个 run 末尾
  const textBox = findTextBox(document, position.textBoxId);
  if (!textBox || paragraphIndex <= 0) return null;
  const prevParagraph = textBox.paragraphs[paragraphIndex - 1];
  const lastRun = prevParagraph.runs[prevParagraph.runs.length - 1];
  if (!lastRun) return null;
  return {
    textBoxId: position.textBoxId,
    paragraphId: prevParagraph.id,
    runId: lastRun.id,
    offset: lastRun.text.length,
  };
}

/** 后一个 code point 位置（跨 run / 跨段落），文档末尾返回 null */
export function nextPosition(
  document: EditorDocument,
  position: TextPosition
): TextPosition | null {
  const resolved = resolveTextPosition(document, position);
  const { paragraph, run, paragraphIndex, runIndex } = resolved;

  if (position.offset < run.text.length) {
    return {
      textBoxId: position.textBoxId,
      paragraphId: position.paragraphId,
      runId: run.id,
      offset: stepForward(run.text, position.offset),
    };
  }

  // run 末尾 → 下一个 run 的开头
  if (runIndex < paragraph.runs.length - 1) {
    const next = paragraph.runs[runIndex + 1];
    return {
      textBoxId: position.textBoxId,
      paragraphId: position.paragraphId,
      runId: next.id,
      offset: 0,
    };
  }

  // 段落末尾 → 下一段落的第一个 run 开头
  const textBox = findTextBox(document, position.textBoxId);
  if (!textBox || paragraphIndex >= textBox.paragraphs.length - 1) return null;
  const nextParagraph = textBox.paragraphs[paragraphIndex + 1];
  const firstRun = nextParagraph.runs[0];
  if (!firstRun) return null;
  return {
    textBoxId: position.textBoxId,
    paragraphId: nextParagraph.id,
    runId: firstRun.id,
    offset: 0,
  };
}

/** 段落内 run 的分布（诊断/测试用） */
export function runRangesOfParagraph(paragraph: Paragraph): Map<string, { start: number; end: number }> {
  return paragraphRanges(paragraph);
}

// ─────────────────────────────────────────────────────────────────────
//  动作 → Command
// ─────────────────────────────────────────────────────────────────────

export function isCollapsedRange(range: TextRange): boolean {
  return textPositionEquals(range.anchor, range.focus);
}

/** 字符输入：折叠 → Insert；有选区 → Replace（覆盖即替换） */
export function insertOrReplace(context: InputContext, text: string): EditorCommand[] {
  if (text === "") return [];
  if (isCollapsedRange(context.selection)) {
    return [new InsertTextCommand(caretOf(context).position, text)];
  }
  return [new ReplaceTextCommand(context.selection, text)];
}

/**
 * ★ F3B-6.21-F2（E-C5-2）：**词级删除区间 → TextRange**（段落级 UTF-16）。
 *
 * 坐标系链路（与 F 的退出条件一致，全部走 Core 既有原语）：
 *
 * ```text
 * TextPosition ─positionToParagraphOffset─▶ 段落内 UTF-16 offset
 *        │                                        │
 *        │                              wordRangeAt(paragraphText, offset, dir)
 *        │                                        ↓
 *        └────────────▶ [start, end) ─paragraphOffsetToPosition─▶ TextRange
 *                                                                  ↓
 *                                                          DeleteTextCommand
 * ```
 *
 * ⚠️ 作用域限制（V1）：只在**当前段落内**取词；caret 在段落开头且方向为 backward
 *    （或末尾且 forward）时返回 `null` ⇒ 退化为 no-op（**不**跨段落删，避免把
 *    「段落边界」与「词边界」两种语义混在一条命令里）。
 */
export function wordRangeInDocument(
  document: EditorDocument,
  position: TextPosition,
  direction: WordDirection
): TextRange | null {
  const { paragraph } = resolveTextPosition(document, position);
  const text = getParagraphText(paragraph);
  const offset = positionToParagraphOffset(document, position);
  const range = wordRangeAt(text, offset, direction);
  if (!range || range.end <= range.start) return null;
  return {
    anchor: paragraphOffsetToPosition(document, paragraph.id, range.start),
    focus: paragraphOffsetToPosition(document, paragraph.id, range.end),
  };
}

export interface ActionOutcome {
  commands: EditorCommand[];
  warnings: string[];
}

export function commandsForAction(
  action: KeyAction,
  context: InputContext,
  insertText = ""
): ActionOutcome {
  const warnings: string[] = [];
  const collapsed = isCollapsedRange(context.selection);
  const caret: Caret = caretOf(context);

  switch (action.kind) {
    case "insertText":
      return { commands: insertOrReplace(context, insertText), warnings };

    case "splitParagraph":
      // 有选区时 Enter = 用 "\n" 替换选区（一条 Command 完成删除 + 分段，§14）
      if (!collapsed) return { commands: [new ReplaceTextCommand(context.selection, "\n")], warnings };
      return { commands: [new SplitParagraphCommand(caret.position)], warnings };

    case "deleteBackward": {
      if (!collapsed) return { commands: [new DeleteTextCommand(context.selection)], warnings };
      // ★ F3B-6.21-F2（E-C5-2）：词级 ⇒ 由 resolver 给区间（**不是**浏览器给的）
      if (action.unit === "word") {
        const range = wordRangeInDocument(context.document, caret.position, "backward");
        if (!range) {
          warnings.push("光标前没有可删除的词 ⇒ Backspace(word) 为 no-op");
          return { commands: [], warnings };
        }
        return { commands: [new DeleteTextCommand(range)], warnings };
      }
      const prev = previousPosition(context.document, caret.position);
      if (!prev) {
        warnings.push("已在文档开头，Backspace 为 no-op");
        return { commands: [], warnings };
      }
      return { commands: [new DeleteTextCommand({ anchor: prev, focus: caret.position })], warnings };
    }

    case "deleteForward": {
      if (!collapsed) return { commands: [new DeleteTextCommand(context.selection)], warnings };
      if (action.unit === "word") {
        const range = wordRangeInDocument(context.document, caret.position, "forward");
        if (!range) {
          warnings.push("光标后没有可删除的词 ⇒ Delete(word) 为 no-op");
          return { commands: [], warnings };
        }
        return { commands: [new DeleteTextCommand(range)], warnings };
      }
      const next = nextPosition(context.document, caret.position);
      if (!next) {
        warnings.push("已在文档末尾，Delete 为 no-op");
        return { commands: [], warnings };
      }
      return { commands: [new DeleteTextCommand({ anchor: caret.position, focus: next })], warnings };
    }

    case "none":
    default:
      warnings.push(action.kind === "none" ? action.reason : "未识别的动作");
      return { commands: [], warnings };
  }
}
