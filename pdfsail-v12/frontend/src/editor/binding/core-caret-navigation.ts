/**
 * editor/binding/core-caret-navigation.ts — F3B-6.27-G9（Goal 3 ①：caret 步进边界）
 *
 * ── 为什么需要它（真实 Chromium 实测根因）────────────────────────────
 * 用户报告：「光标无法定位到选中的文本位置」「方向键向右移，卡在某处无法继续」。
 * gd-swim-2026.pdf 上复现到的确切机制：
 *
 *   1. Core 接管面（`[data-segment-id][contenteditable]`）的 DOM scope 是
 *      **一个 segment 元素 = 一个视觉行**；DOM 文本是**陈旧的** `segment.text`
 *      （Core 提交后 preventDefault，DOM 文本不回写，见 core-dom-caret 契约）。
 *   2. G3-A 用 Core 的 `nextPosition` 步进，而 **`nextPosition` 会跨段落**
 *      （core/input/keyboard.ts：段落末尾 → 下一段落第一个 run，offset 0）。
 *   3. caret 被推进到**另一个段落**后，`reconcileDomCaretFromCore` 用
 *      「该段落段落内 offset − 当前 segment base」换算 DOM offset ⇒ 负数/错位
 *      ⇒ DOM 光标**不动**。
 *   4. 紧随的 `selectionchange` 又把 Core caret 拉回 ⇒ Core/DOM 乒乓
 *      ⇒ **光标彻底卡死**（实测 marker 反复 `fromOffset: 1, toOffset: 0`）。
 *
 *   触发前提：Core 段落文本比陈旧 DOM **短**（替换/删除之后），caret 到段末时
 *   `nextPosition` 跨段落成功而 DOM 无处可去 ⇒ 冻结。
 *
 * ── 契约 ─────────────────────────────────────────────────────────────
 *   1. **视觉行编辑面 = 段落边界**：caret 步进绝不跨段落；到段末/段首 ⇒ 报边界。
 *   2. **code-point 安全**：复用 Core 唯一 `stepForward` / `stepBack`。
 *   3. **纯段落内空间计算**：先归一到段落内 UTF-16 offset 再回写 ⇒ 多 run 段落
 *      不会混用「run 相对 / 段落相对」offset。
 *   4. **fail-closed**：位置或段落解析失败 ⇒ `{ok:false, reason:"unresolved-position"}`。
 *   5. **不改 Core 语义**：Core 的 `nextPosition` / `previousPosition` 仍是文档级
 *      原语（Backspace/Delete 跨段落合法）；本模块只在编辑面这层加边界。
 */

import type { EditorDocument, Paragraph } from "../core/document/types";
import { findParagraph, getParagraphText } from "../core/document/query";
import { stepBack, stepForward } from "../core/input";
import type { Caret, EditorSelection, TextPosition } from "../core/position/types";
import {
  createCaret,
  createSelection,
  paragraphOffsetToPosition,
  positionToParagraphOffset,
} from "../core/position";

export type CaretStepDirection = "left" | "right";

export type CaretStepFailureReason = "paragraph-boundary" | "unresolved-position";

export type CaretStepOutcome =
  | { readonly ok: true; readonly position: TextPosition; readonly paragraphOffset: number }
  | { readonly ok: false; readonly reason: CaretStepFailureReason };

/** 段落实体（解析失败 ⇒ null，调用方 fail-closed）。 */
function paragraphOf(document: EditorDocument, paragraphId: string): Paragraph | null {
  for (const page of document.pages) {
    for (const object of page.objects) {
      if (object.type !== "text") continue;
      const found = findParagraph(object, paragraphId);
      if (found) return found;
    }
  }
  return null;
}

/** 段落内 code-point 步进（**不跨段落**）。 */
export function stepCaretWithinParagraph(args: {
  readonly document: EditorDocument;
  readonly position: TextPosition;
  readonly direction: CaretStepDirection;
}): CaretStepOutcome {
  const { document, position, direction } = args;
  const paragraph = paragraphOf(document, position.paragraphId);
  if (!paragraph) return { ok: false, reason: "unresolved-position" };

  let current: number;
  try {
    current = positionToParagraphOffset(document, position);
  } catch {
    return { ok: false, reason: "unresolved-position" };
  }

  const text = getParagraphText(paragraph);
  const next = direction === "right" ? stepForward(text, current) : stepBack(text, current);
  // ★ 边界：步进原地不动 ⇒ 段落首/末 ⇒ **不跨段落**（本模块核心契约）
  if (next === current) return { ok: false, reason: "paragraph-boundary" };

  try {
    return {
      ok: true,
      position: paragraphOffsetToPosition(document, paragraph.id, next),
      paragraphOffset: next,
    };
  } catch {
    return { ok: false, reason: "unresolved-position" };
  }
}

/**
 * Shift+Arrow 的**段落内**选区扩展。
 *
 * 与 Core `extendSelectionByCodePoint` 唯一差别：不跨段落；
 * anchor 永不因移动方向重新归一化（G2：anchor 保持原值，只移动 focus）。
 * 边界 ⇒ `null`（调用方保留原 selection，fail-closed）。
 */
export function extendSelectionWithinParagraph(args: {
  readonly document: EditorDocument;
  readonly selection: EditorSelection | null | undefined;
  readonly direction: CaretStepDirection;
}): { readonly selection: EditorSelection; readonly caret: Caret } | null {
  const { document, selection, direction } = args;
  // ★ fail-closed：selection 缺失（尚未播种 / 被重置）⇒ 返回 null，绝不解引用抛错。
  if (!selection || !selection.range) return null;
  const moved = stepCaretWithinParagraph({
    document,
    position: selection.range.focus,
    direction,
  });
  if (!moved.ok) return null;
  return {
    selection: createSelection(selection.range.anchor, moved.position),
    caret: createCaret(moved.position, "forward"),
  };
}

/**
 * 把「段落相对 offset」钳制到 Core 段落的真实长度。
 *
 * ★ 实测缺陷二：Core 接管面的 DOM 文本是**陈旧**的 `segment.text`，Core 段落文本
 *   可能已更短（替换/删除之后）⇒ 点击 / Ctrl+A 给出的 DOM offset 换算成段落
 *   offset 后**越界** ⇒ `coreCaretForSegmentParagraph` fail-closed ⇒ Core caret
 *   不更新 ⇒ 用户「点了没反应 / 光标定位不到」。
 *
 * 段落末尾之后不存在字符，唯一合法 caret 就是段落末 ⇒ 钳制是确定映射，不是猜测。
 * 段落缺失 ⇒ `null`（调用方 fail-closed）。
 */
export function clampOffsetToParagraph(args: {
  readonly document: EditorDocument;
  readonly paragraphId: string;
  readonly offsetUtf16: number;
}): number | null {
  const { document, paragraphId, offsetUtf16 } = args;
  const paragraph = paragraphOf(document, paragraphId);
  if (!paragraph) return null;
  if (!Number.isFinite(offsetUtf16)) return 0;
  const len = getParagraphText(paragraph).length;
  return Math.max(0, Math.min(len, Math.trunc(offsetUtf16)));
}
