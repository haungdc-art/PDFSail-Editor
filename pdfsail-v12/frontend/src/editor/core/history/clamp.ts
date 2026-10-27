/**
 * editor/core/history/clamp.ts — EDITOR-CORE-004
 *
 * 把 selection / caret 收敛到新 document 上。
 *
 * 用途：commit 时调用方若不显式给出"编辑后的选区/光标"，History 需要保证
 * 不会持久化非法 TextPosition（规范 §35：no invalid TextPosition is persisted）。
 *
 * 策略（由强到弱）：
 *   ① clampTextPosition（对象仍存在 → 钳制 offset）
 *   ② 该 TextBox 的首段首 run offset 0（run/paragraph 被删除）
 *   ③ 文档第一个 TextBox 的首段首 run offset 0（TextBox 不存在）
 *   ④ 保留原位置（文档已无任何 TextBox，无从映射）
 */

import { allTextBoxes } from "../document/query";
import type { EditorDocument, TextBoxObject } from "../document/types";
import { clampTextPosition } from "../position/index";
import type { Caret, EditorSelection, TextPosition } from "../position/types";
import type { EditorHistoryState } from "./types";

function firstPositionOf(tb: TextBoxObject): TextPosition | null {
  const paragraph = tb.paragraphs[0];
  if (!paragraph || paragraph.runs.length === 0) return null;
  return {
    textBoxId: tb.id,
    paragraphId: paragraph.id,
    runId: paragraph.runs[0].id,
    offset: 0,
  };
}

function fallbackPosition(document: EditorDocument, textBoxId: string): TextPosition | null {
  const boxes = allTextBoxes(document);
  const preferred = boxes.find((tb) => tb.id === textBoxId);
  return firstPositionOf(preferred ?? boxes[0]) ?? null;
}

export function safeClampPosition(
  document: EditorDocument,
  position: TextPosition
): TextPosition {
  try {
    return clampTextPosition(document, position);
  } catch {
    // run / paragraph / textBox 已不存在 → 回退到该 TextBox（或首个 TextBox）起点
    return fallbackPosition(document, position.textBoxId) ?? position;
  }
}

/** 把快照的 selection / caret 收敛到给定 document */
export function clampSnapshotToDocument(
  document: EditorDocument,
  snapshot: EditorHistoryState
): EditorHistoryState {
  const { anchor, focus } = snapshot.selection.range;
  return {
    document,
    selection: {
      range: {
        anchor: safeClampPosition(document, anchor),
        focus: safeClampPosition(document, focus),
      },
    },
    caret: {
      position: safeClampPosition(document, snapshot.caret.position),
      affinity: snapshot.caret.affinity,
    },
  };
}
