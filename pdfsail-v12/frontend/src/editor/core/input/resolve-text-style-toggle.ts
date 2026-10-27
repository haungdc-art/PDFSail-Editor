/**
 * editor/core/input/resolve-text-style-toggle.ts — F3B-6.21-H1-A
 *
 * 把 `format*` 意图解析为「要应用的最终 Partial<TextStyle>」。
 *
 * 设计要点（H 审计 + H1-A 裁决）：
 *   ① InputEvent.set-text-style **只携带 format 意图**（bold/italic/underline/strike），
 *      绝不携带 toggle 后的最终 style。
 *   ② toggle 解析**必须发生在 Core document 上**：读 selection 当前覆盖的 run 的 style，
 *      再翻转；绝不靠 document.queryCommandState / DOM Selection / DOM computedStyle。
 *   ③ 选择器语义（产品契约，非随手决定）：
 *        - 折叠选区（collapsed / 空选择）→ V1 no-op ⇒ 返回 null（不伪造 mutation）。
 *        - 选区覆盖的 run **全部 ON** ⇒ 翻转 OFF；否则（mixed 或 全部 OFF）⇒ 翻转 ON
 *          （即「any-off → on」，统一覆盖 uniform / mixed / multi-run same-paragraph 三类）。
 *        - 跨 TextBox / 跨 paragraph 选择 ⇒ V1 不支持 ⇒ 返回 null（fail-closed）。
 */

import type { EditorDocument, TextStyle } from "../document/types";
import { findParagraph, findTextBox } from "../document/query";
import type { TextFormatKind } from "./types";
import type { TextRange } from "../position/types";
import {
  isCollapsedRange,
  normalizeTextRange,
  positionToParagraphOffset,
} from "../position/index";

/** 给定 run 的 style，判断该 format 属性当前是否「ON」 */
export function formatPropertyIsOn(style: TextStyle, format: TextFormatKind): boolean {
  switch (format) {
    case "bold":
      return style.fontWeight === 700;
    case "italic":
      return style.fontStyle === "italic";
    case "underline":
      return style.underline === true;
    case "strike":
      return style.strike === true;
  }
}

/** 给定 format 与「是否要变成 ON」，产出要应用的最终 Partial<TextStyle> */
export function resolveFormatToggleStyle(
  format: TextFormatKind,
  on: boolean
): Partial<TextStyle> {
  switch (format) {
    case "bold":
      return { fontWeight: on ? 700 : 400 };
    case "italic":
      return { fontStyle: on ? "italic" : "normal" };
    case "underline":
      return { underline: on };
    case "strike":
      return { strike: on };
  }
}

/**
 * 解析 set-text-style 意图，返回要应用的最终 style；无目标时返回 null
 * （V1 no-op / fail-closed，调用方据此不伪造 mutation、不入 History）。
 */
export function resolveTextStyleToggle(
  doc: EditorDocument,
  selection: TextRange,
  format: TextFormatKind
): Partial<TextStyle> | null {
  // ① 折叠 / 空选区 ⇒ V1 no-op（collapsed caret pending-style deferred）
  if (isCollapsedRange(selection)) return null;

  const anchor = selection.anchor;
  const focus = selection.focus;

  // ② 跨 TextBox / 跨 paragraph ⇒ V1 不支持，fail-closed（与 SetTextStyleCommand 同边界）
  if (anchor.textBoxId !== focus.textBoxId) return null;
  if (anchor.paragraphId !== focus.paragraphId) return null;

  const tb = findTextBox(doc, anchor.textBoxId);
  if (!tb) return null;
  const para = findParagraph(tb, anchor.paragraphId);
  if (!para) return null;

  const norm = normalizeTextRange(doc, selection);
  const start = positionToParagraphOffset(doc, norm.anchor);
  const end = positionToParagraphOffset(doc, norm.focus);
  if (!(end > start)) return null; // 归一化后仍无覆盖 ⇒ 无目标

  // ③ 收集「与选区重叠」的每个 run 的当前 ON/OFF
  //    （边界部分覆盖的 run 也算：其文本会被 SetTextStyleCommand 拆分后套用）
  let acc = 0;
  const onFlags: boolean[] = [];
  for (const run of para.runs) {
    const runStart = acc;
    const runEnd = acc + run.text.length;
    acc = runEnd;
    const overlaps = runStart < end && start < runEnd;
    if (overlaps) onFlags.push(formatPropertyIsOn(run.style, format));
  }
  if (onFlags.length === 0) return null;

  // ④ uniform ON ⇒ 翻 OFF；否则（mixed / 全部 OFF）⇒ 翻 ON
  const allOn = onFlags.every((v) => v);
  return resolveFormatToggleStyle(format, !allOn);
}
