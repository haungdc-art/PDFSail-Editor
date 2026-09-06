/**
 * MultiLineMutationPlan — 多行 mutation 计划层（M5-IMPLEMENT-002）
 *
 * 核心原则（PM）：
 *   1. Plan 与 Execute 分离 —— 先计算"我要把什么变成什么"，再执行 mutation。
 *   2. Atomicity —— 不允许边遍历 range 边改 document 造成半修改。
 *   3. Validate-then-Execute —— Plan 无法执行则 NO MUTATION。
 *
 * 本文件只定义 Plan 模型 + Validation + PlanBuilder（跨行 Delete 的结构计算），
 * **不执行 line merge 的 geometry 重算**（该部分依赖 reflow/geometry 策略，见 BLOCKED 说明）。
 *
 * 当前状态：
 *   - Plan 模型        ✅
 *   - Plan Validation  ✅
 *   - PlanBuilder      ✅（delete 结构部分）
 *   - Line Merge 执行  ❌ BLOCKED —— 合并后行的 y/x/baseline 需要 geometry 重算（reflow 策略），本任务不实现。
 *   - Replace/Rewrite/Translate/FixOcr 多行执行 → SAFE REJECT（NO MUTATION）。
 */
import type { EditableDocument } from "./types";
import type { SelectionRange } from "./current-selection";
import type { DocumentSelection } from "./document-selection";

export type MultiLineMutationKind = "delete" | "replace" | "rewrite" | "translate" | "fixOcr";

/** 有序的多行 glyph 区间（跨行），一个 range = 一个 line 上的精确 glyph interval */
export interface MultiLineMutationPlan {
  readonly kind: MultiLineMutationKind;
  readonly blockId: string;
  /** 有序 ranges（length >= 2） */
  readonly ranges: ReadonlyArray<SelectionRange>;
  /** 选中连续文本 */
  readonly selectedText: string;

  // ── delete 特化 ──
  readonly firstLineId: string;
  readonly lastLineId: string;
  /** 中间被删除的整行 lineId（有序） */
  readonly middleLineIds: ReadonlyArray<string>;
  /** first 行选中区间之前的剩余文本（保留） */
  readonly firstPrefix: string;
  /** last 行选中区间之后的剩余文本（保留） */
  readonly lastSuffix: string;
  /** 合并后新行文本 = firstPrefix + lastSuffix（line merge 目标） */
  readonly mergedText: string;

  // ── replace/rewrite/translate/fixOcr 特化（预留，本任务多行 SAFE REJECT） ──
  readonly replacementText?: string;
}

/** Plan 校验结果：合法 → 返回 true；非法 → 返回 false（NO MUTATION） */
export function validateMultiLinePlan(
  doc: EditableDocument,
  blockId: string,
  ranges: ReadonlyArray<SelectionRange>
): boolean {
  if (!doc || ranges.length < 2) return false; // 非多行（单行走 M4）
  const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === blockId);
  if (!block) return false;

  // 每 range 行必须存在
  for (const r of ranges) {
    const line = block.lines.find((l) => l.id === r.lineId);
    if (!line) return false;
    // range 必须非空且不反向
    if (r.startGlyphIndex < 0 || r.endGlyphIndex < r.startGlyphIndex) return false;
    if (r.endGlyphIndex >= line.glyphs.length) return false;
  }

  // 必须连续且有序（按 glyph 区间），且相邻 range 不重叠（跨行：前一行的 end 与后一行的 start 相邻边界）
  for (let i = 1; i < ranges.length; i++) {
    const prev = ranges[i - 1];
    const cur = ranges[i];
    // 同一 block 内，行必须不同且有序（按行出现顺序）
    if (prev.lineId === cur.lineId) return false; // 同一行不应分裂成多个 range
    const prevIdx = block.lines.findIndex((l) => l.id === prev.lineId);
    const curIdx = block.lines.findIndex((l) => l.id === cur.lineId);
    if (curIdx <= prevIdx) return false; // 乱序（reversed ordering）
  }
  return true;
}

/**
 * 构建多行 mutation Plan（当前仅 delete 的完整结构计算）。
 * 返回 null：非法 selection（NO MUTATION）。
 */
export function buildMultiLinePlan(
  doc: EditableDocument,
  selection: DocumentSelection,
  kind: MultiLineMutationKind,
  replacementText?: string
): MultiLineMutationPlan | null {
  const ranges = selection.ranges;
  if (!ranges || ranges.length < 2) return null;
  if (!validateMultiLinePlan(doc, selection.blockId, ranges)) return null;

  const block = doc.pages.flatMap((p) => p.blocks).find((b) => b.id === selection.blockId)!;
  const firstRange = ranges[0];
  const lastRange = ranges[ranges.length - 1];

  const firstLine = block.lines.find((l) => l.id === firstRange.lineId)!;
  const lastLine = block.lines.find((l) => l.id === lastRange.lineId)!;

  const firstPrefix = firstLine.glyphs.slice(0, firstRange.startGlyphIndex).map((g) => g.char).join("");
  const lastSuffix = lastLine.glyphs.slice(lastRange.endGlyphIndex + 1).map((g) => g.char).join("");

  // 中间整行（delete 时删除）：first 与 last 之间的行
  const middleLineIds: string[] = [];
  for (const r of ranges.slice(1, -1)) {
    middleLineIds.push(r.lineId);
  }

  return {
    kind,
    blockId: selection.blockId,
    ranges,
    selectedText: selection.text,
    firstLineId: firstRange.lineId,
    lastLineId: lastRange.lineId,
    middleLineIds,
    firstPrefix,
    lastSuffix,
    mergedText: firstPrefix + lastSuffix,
    replacementText,
  };
}
