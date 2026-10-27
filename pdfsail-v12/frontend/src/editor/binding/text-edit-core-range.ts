/**
 * editor/binding/text-edit-core-range.ts — F3B-6.24-B2
 *
 * **TextEdit commit → paragraph-level Core `TextRange` resolver.**
 *
 * ── 背景（与 6.17 既有 canonical 链的关系）──────────────────────────────
 * 6.17 的 canonical 链是 `DOM Selection → CanonicalSelection → CoreSelectionTarget`
 * （`canonicalSelectionToCoreTarget`），服务于「原生文本选区 → Core」。
 * TextEdit Overlay 的 commit 走的不是这条链：它的坐标来自 **行**（blockId/lineId
 * + 行内 UTF-16 偏移），而不是 glyph 选区，也不经过 DOM selection。
 *
 * B1 审计结论：**不要碰 `canonicalToCoreTarget`**；直接在 text-edit 路径上
 * 建立 paragraph-level `TextRange`。`TextRange` 本来就是命令层消费的类型，
 * 不需要新造 range 类型。
 *
 * ── Resolver 形态 ───────────────────────────────────────────────────────
 *     (blockId, lineId, startUtf16, endUtf16)
 *                      ↓  owning paragraph（lineId → paragraphId 加速 + run.source 扫描）
 *        paragraphOffsetToPosition()
 *               ↙             ↘
 *            anchor          focus
 *               \             /
 *                TextRange
 *                    ↓
 *           Replace / Delete / Insert
 *
 * ── `lineId → paragraphId` 只是 runtime identity accelerator ──────────────
 * 不是 semantic truth。真正的语义真相应是 `EditorDocument`：resolver 先扫描
 * Core 文档的 run.source.lineId 找归属段落；**找不到时**才用 map 作为加速回退
 * （Core 编辑后 run 的 lineId 可能丢失，map 记录了「上次成功 commit 的归属」）。
 * 任一来源命中即有效；二者都未命中才 fail-closed。
 *
 * ── R1 一致性（B2 的完成条件）──────────────────────────────────────────
 * 打开时看到的 Core 当前文本、编辑 diff 使用的 baseline、commit resolver 使用的
 * paragraph 三者必须属于同一个 Core semantic state。`resolveCoreLineText` /
 * `coreLineGlyphs` 因此都从 **Core 文档**取数（调用方在 Core owns 时优先传入），
 * 与 resolver 同一个文档，保证偏移语义一致。
 */

import type { EditorDocument } from "../core/document/types";
import { allTextBoxes, findParagraph, getParagraphText } from "../core/document/query";
import { paragraphOffsetToPosition } from "../core/position";
import type { TextPosition, TextRange } from "../core/position/types";
import { DeleteTextCommand, InsertTextCommand, ReplaceTextCommand } from "../core/commands";
import type { EditorCommand } from "../core/commands";

/** `lineId → paragraphId` 的运行时加速表（只读快照，非语义真相） */
export type LineIdToParagraphId = ReadonlyMap<string, string>;

interface OwningParagraph {
  paragraphId: string;
  textBoxId: string;
}

/**
 * 找到 (blockId,lineId) 当前在 Core 文档里归属的段落。
 *
 * 优先级：
 *   1. 扫描 Core 文档，找第一个 `run.source.lineId === lineId` 的 run → 其段落。
 *      （Core 初次 rehydrate / 未编辑行：run.source 完整，直接命中）
 *   2. 用 `lineIdToParagraphId` 加速表回退（Core 编辑后 run.source.lineId 可能
 *      被 stripGlyphRange 清除，但上次成功 commit 已把 lineId→paragraphId 记进 map）。
 *
 * 两者都未命中 ⇒ 返回 null（调用方 fail-closed，不得猜测）。
 */
function findOwningParagraph(
  doc: EditorDocument,
  lineId: string,
  map?: LineIdToParagraphId
): OwningParagraph | null {
  for (const tb of allTextBoxes(doc)) {
    for (const p of tb.paragraphs) {
      if (p.runs.some((r) => r.source?.lineId === lineId)) {
        return { paragraphId: p.id, textBoxId: tb.id };
      }
    }
  }
  const pid = map?.get(lineId);
  if (pid) {
    for (const tb of allTextBoxes(doc)) {
      const p = findParagraph(tb, pid);
      if (p) return { paragraphId: pid, textBoxId: tb.id };
    }
  }
  return null;
}

function paragraphUtf16Length(doc: EditorDocument, paragraphId: string): number {
  for (const tb of allTextBoxes(doc)) {
    const p = findParagraph(tb, paragraphId);
    if (p) return getParagraphText(p).length;
  }
  return 0;
}

/**
 * 取指定 lineId 在当前 Core 文档里的**整行文本**（段落拼接）。
 *
 * 用于 B2 的 R1 一致性：打开时看到的文本、diff 的 baseline 都应来自 Core，
 * 与 commit resolver 同一个文档。Core 未拥有该文档 / lineId 不可解析时返回 null
 * （调用方回落 EditableDocument，行为不变）。
 */
export function resolveCoreLineText(
  doc: EditorDocument,
  lineId: string,
  map?: LineIdToParagraphId
): string | null {
  const owner = findOwningParagraph(doc, lineId, map);
  if (!owner) return null;
  const p = findParagraphParagraph(doc, owner.paragraphId);
  if (!p) return null;
  return getParagraphText(p);
}

/** 取指定 lineId 在当前 Core 文档里的逐 glyph 序列（用于 Adapter 的 UTF-16 长度换算）。 */
export function coreLineGlyphs(
  doc: EditorDocument,
  lineId: string,
  map?: LineIdToParagraphId
): ReadonlyArray<{ readonly char?: string; readonly originalChar?: string }> | null {
  const owner = findOwningParagraph(doc, lineId, map);
  if (!owner) return null;
  const p = findParagraphParagraph(doc, owner.paragraphId);
  if (!p) return null;
  const out: Array<{ char?: string; originalChar?: string }> = [];
  for (const run of p.runs) {
    for (const ch of Array.from(run.text)) {
      // Core run 一般无 originalChar（那是 PDF binding 事实）；用 char 保证 UTF-16 长度正确。
      out.push({ char: ch });
    }
  }
  return out;
}

function findParagraphParagraph(doc: EditorDocument, paragraphId: string) {
  for (const tb of allTextBoxes(doc)) {
    const p = findParagraph(tb, paragraphId);
    if (p) return p;
  }
  return null;
}

export type ResolveLineToCoreTargetResult =
  | {
      readonly ok: true;
      readonly range: TextRange;
      readonly paragraphId: string;
      readonly textBoxId: string;
    }
  | { readonly ok: false; readonly reason: "unresolved" | "out-of-bounds" };

/**
 * 把「行内 UTF-16 区间」解析为 Core `TextRange`。
 *
 * 纯函数、零副作用、零 Command 构造。坐标语义 = 行（段落）UTF-16 偏移。
 * 越界 / 未命中段落 ⇒ fail-closed（调用方回落 Legacy，绝不猜测）。
 */
export function resolveLineToCoreTarget(
  doc: EditorDocument,
  args: {
    readonly blockId: string;
    readonly lineId: string;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly lineIdToParagraphId?: LineIdToParagraphId;
  }
): ResolveLineToCoreTargetResult {
  const owner = findOwningParagraph(doc, args.lineId, args.lineIdToParagraphId);
  if (!owner) return { ok: false, reason: "unresolved" };

  const len = paragraphUtf16Length(doc, owner.paragraphId);
  if (args.startUtf16 < 0 || args.endUtf16 > len || args.startUtf16 > args.endUtf16) {
    return { ok: false, reason: "out-of-bounds" };
  }

  const anchor: TextPosition = paragraphOffsetToPosition(doc, owner.paragraphId, args.startUtf16);
  const focus: TextPosition = paragraphOffsetToPosition(doc, owner.paragraphId, args.endUtf16);
  return {
    ok: true,
    range: { anchor, focus },
    paragraphId: owner.paragraphId,
    textBoxId: owner.textBoxId,
  };
}

/**
 * 由 `TextRange` + 替换文本构造 Core Command（唯一构造点）。
 *
 * 与 `createSegmentCoreCommand` 同哲学：不写第二套 range resolution，复用命令层。
 *   - 折叠区间（anchor 全字段相等）+ 非空文本 ⇒ `InsertTextCommand`
 *   - 非空区间 + 空文本              ⇒ `DeleteTextCommand`
 *   - 非空区间 + 非空文本           ⇒ `ReplaceTextCommand`
 */
export function createTextEditCoreCommand(
  range: TextRange,
  newText: string
): { readonly kind: "insert" | "delete" | "replace"; readonly command: EditorCommand } {
  const isCollapsed =
    range.anchor.textBoxId === range.focus.textBoxId &&
    range.anchor.paragraphId === range.focus.paragraphId &&
    range.anchor.runId === range.focus.runId &&
    range.anchor.offset === range.focus.offset;
  if (newText === "") return { kind: "delete", command: new DeleteTextCommand(range) };
  if (isCollapsed) return { kind: "insert", command: new InsertTextCommand(range.anchor, newText) };
  return { kind: "replace", command: new ReplaceTextCommand(range, newText) };
}
