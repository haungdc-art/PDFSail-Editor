/**
 * F3B-6.17-B — Segment → Core Command 选择与构造（纯函数）
 *
 * ── 硬约束（6.17 §3）──────────────────────────────────────────────────
 *   · 只产生既有 Core Command：`InsertTextCommand` / `DeleteTextCommand` / `ReplaceTextCommand`
 *   · **不**新建 `SegmentCommand`
 *   · Core Command **不认识** Segment / glyphIndex / EditableDocument / docBlocks
 *     —— 本模块只把 Segment 坐标**翻译**成 `TextPosition / TextRange`
 *   · 一次 Segment semantic commit = 一个 Command = 一条 History entry（6.17 §8）
 */

import { createTextPosition } from "../core/position";
import type { TextRange } from "../core/position/types";
import {
  DeleteTextCommand,
  InsertTextCommand,
  ReplaceTextCommand,
} from "../core/commands";
import type { EditorCommand } from "../core/commands/types";
import type { CoreTextRangeRef } from "./segment-core-range";

export type SegmentCommandKind = "insert" | "delete" | "replace";

export interface DecideSegmentCommandInput {
  newText: string;
  /** UTF-16 区间（由 `resolveSegmentToCoreRange` 产出） */
  start: number;
  end: number;
}

/**
 * 判定应使用的 Core Command 种类。
 *
 *   newText === ""                 → delete
 *   start === end（空原区间）      → insert
 *   其余                            → replace（一次操作 = 一条 undo，符合 §8）
 */
export function decideSegmentCoreCommand(
  input: DecideSegmentCommandInput
): SegmentCommandKind {
  if (input.newText.length === 0) return "delete";
  if (input.start === input.end) return "insert";
  return "replace";
}

export interface SegmentCoreCommand {
  kind: SegmentCommandKind;
  command: EditorCommand;
  /** 该 Command 影响的 Core 文本区间（诊断/eligibility 用） */
  range: TextRange;
}

/**
 * 由 Core 文本区间构造 Core Command。
 *
 * 注意：Command 只接收 `TextPosition{textBoxId, paragraphId, runId, offset}`，
 * **不携带**任何 blockId/lineId/glyphIndex —— provenance 仅用于上游定位。
 */
export function createSegmentCoreCommand(input: {
  ref: CoreTextRangeRef;
  newText: string;
}): SegmentCoreCommand {
  const { ref, newText } = input;
  const anchor = createTextPosition(ref.textBoxId, ref.paragraphId, ref.runId, ref.start);
  const focus = createTextPosition(ref.textBoxId, ref.paragraphId, ref.runId, ref.end);
  const range: TextRange = { anchor, focus };

  const kind = decideSegmentCoreCommand({ newText, start: ref.start, end: ref.end });

  switch (kind) {
    case "delete":
      return { kind, command: new DeleteTextCommand(range), range };
    case "insert":
      return { kind, command: new InsertTextCommand(anchor, newText), range };
    default:
      return { kind, command: new ReplaceTextCommand(range, newText), range };
  }
}
