/**
 * F3B-6.4B-2 — Segment Commit → canonical EditableDocument transaction
 *
 * 目标：**一次成功的 Segment commit = 一次 EditableDocument mutation + 一条 OperationHistory entry**。
 *
 * 设计原则（F3B-6.4B-0）：
 *   · 只复用 mutation kernel —— `findLineBySource → resolve current range → mutateLineText`；
 *   · **不**复制 `applySegmentEditsToDocument` 的批处理 bookkeeping
 *     （filter / group / sort / shift / editedLine.edited）—— 那些属于旧 export 补账逻辑。
 *
 * 副作用顺序（严格，见 F3B-6.4B-0 §4.2）：
 *   1. resolve segment range（ledger）
 *   2. capture beforeGlyphs
 *   3. mutateLineText
 *   4. setDocument（ref 写回 + version++）
 *   5. setBlocks（renderToBlocks 投影）
 *   6. markLineEdited   ← **不能提前**：它读的是已更新的 document
 *   7. pushHistory
 *
 * 本模块不持有文档状态；所有副作用通过 `SegmentCommitContext` 注入，便于测试。
 *
 * ── F3B-6.17-3C-3B：架构身份 = **Segment Legacy fallback mutation adapter** ──────
 *   · 本模块**不属于** Segment 的正常 semantic editing path。
 *   · 正常路径 = `Segment → Core Command → EditorDocument → Core Export`
 *     （编排在 `PDFEditor.commitSegmentCanonical`：Core 提交成功即 `return`）。
 *   · 只有当 Segment Core commit **未接管**（Core 失败 fallback / migration kill-switch）时，
 *     编排层才落到本模块执行 Legacy mutation；随后由 export ownership（`exportOwnershipRef`）
 *     决定走 Legacy Export（`ownership === "legacy"` + `if (!usedCore)`）。
 *   · 因此：**Core success ⇒ 本模块不可达 ⇒ 其中的 `mutateLineText` 调用不可达**。
 *   · ⚠️ 不要为「命名更漂亮」再加一层 wrapper（如 `legacySegmentAdapter → mutateLineText`）：
 *     那只会增加调用层级而不消除任何依赖。身份由本注释 + `C8/C9/C10` guard 固定。
 */

import type { EditableDocument, EditableGlyph } from "../../document-model/types";
import { mutateLineText, renderToBlocks } from "../../document-model";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";
import type { MutationResult } from "../../document-model/document-mutation";
import type { InverseData } from "../../document-model/document-mutation";
import type { TextOperation } from "../../document-model/text-operation";
import type { Segment } from "../../editor-engine/types";
import { findLineBySource } from "./segmentEditBinding";
import { sourceSegmentKey } from "./segmentPositionLedger";
import type { GlyphRange, SegmentSourcePositionLedger } from "./segmentPositionLedger";

/** CSS 坐标下的矩形（与 `markLineEdited` 的 `extraInkBox` 参数同形）。 */
export interface InkBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 收窄并校验 box：非有限值或非正面积 ⇒ null。 */
function normalizeBox(b: InkBox | null | undefined): InkBox | null {
  if (!b) return null;
  if (
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y) ||
    !Number.isFinite(b.width) ||
    !Number.isFinite(b.height)
  ) {
    return null;
  }
  if (!(b.width > 0) || !(b.height > 0)) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** 一组 glyph 的墨迹并集（`originalBBox` 优先，回退 `bbox`）。无一可用 ⇒ null。 */
export function unionGlyphInkBox(glyphs: readonly EditableGlyph[]): InkBox | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const g of glyphs) {
    const b = g.originalBBox ?? g.bbox;
    if (!b) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return normalizeBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
}

/**
 * 副作用注入契约。
 *
 * 所有回调由调用方（PDFEditor）提供真实实现；测试可注入 spy。
 */
export interface SegmentCommitContext {
  /** 读取当前文档真相 */
  getDocument: () => EditableDocument | null;
  /** 写回文档真相（实现方负责 ref 写入 + version bump） */
  setDocument: (doc: EditableDocument) => void;
  /** 刷新 docBlocks 投影 */
  setBlocks: (blocks: ReturnType<typeof renderToBlocks>) => void;
  /**
   * mask 路径。**必须在 setDocument 之后调用**——
   * `markLineEdited` 读取的是已更新的 `editableDocumentRef.current`。
   *
   * F3B-6.4B-6.1：第 3 参 `extraInkBox` 是**空行兜底**用的墨迹盒。
   * 详见 `commitSegmentToDocument` 步骤 6。
   */
  markLineEdited: (blockId: string, lineId: string, extraInkBox?: InkBox | null) => void;
  /**
   * 记录一条 OperationHistory entry。
   *
   * F3B-6.4B-4.4A：第 3 参 `segmentKey` = 本次 commit 的 canonical position identity
   * （`sourceSegmentKey(src)`）。commit 内部派生后透传给 `HistoryEntry.segmentKey`，
   * 使 **orchestration 层**在 undo/redo 时能定位应回退/重放哪条 ledger record。
   *
   * 注意：这只是 metadata 透传 —— 本模块与 OperationHistory 都**不**依赖 ledger。
   */
  pushHistory: (operation: TextOperation, result: MutationResult, segmentKey?: string) => void;
  /** 位置账本（original → current 映射） */
  ledger: SegmentSourcePositionLedger;
}

export interface SegmentCommitOutcome {
  ok: boolean;
  reason?:
    | "no-document"
    | "no-source"
    | "line-not-found"
    | "range-out-of-bounds"
    | "not-mutated";
  range?: GlyphRange;
  blockId?: string;
  lineId?: string;
  document?: EditableDocument;
  beforeGlyphs?: EditableGlyph[];
  afterGlyphs?: EditableGlyph[];
}

/** 生产开关名（`window.__segmentCanonicalCommit === true` 才启用，缺省 off）。 */
export const SEGMENT_CANONICAL_COMMIT_FLAG = "__segmentCanonicalCommit";

/**
 * 读取生产开关。**F3B-6.4B-3.2 起默认启用**；显式 `=== false` 时关闭（kill-switch 保留）。
 *
 * 历史：
 *   · B-2 默认关闭（B4 未处理，会二次 mutation）
 *   · B-3.1 再次关闭并如实上报 —— R2 实证确认 canonical commit 后翻页重建回显原文
 *     （`segmentsByPageRef` 只是 export snapshot，`editedSegmentsRef` 才是唯一 replay source）
 *   · B-3.2 打开：canonicalization 过滤已把 replay 与 export pending 解耦，
 *     R1–R7 全绿（显示保留 + 导出不二次 mutation）。
 *
 * 历史：B-2 阶段默认关闭 —— 因为当时未同步 `segment.originalText`（B4），
 * canonical commit 与旧 export safety-net（`applySegmentEditsToDocument`）
 * 同时生效会导致同一编辑被二次应用、文本损坏（见 segmentCommit.test.ts T12）。
 * B-3 完成 reconciliation 后（T13/T14 证明二次 mutation 消失）才翻为默认启用。
 */
export function readSegmentCanonicalCommitFlag(
  scope?: { [SEGMENT_CANONICAL_COMMIT_FLAG]?: unknown },
): boolean {
  const target =
    scope ?? (typeof window !== "undefined" ? (window as unknown as object) : undefined);
  if (!target) return false; // SSR
  return (target as Record<string, unknown>)[SEGMENT_CANONICAL_COMMIT_FLAG] !== false;
}

/**
 * F3B-6.4B-3 — canonical commit 成功后的 reconciliation（B4 closure）。
 *
 * 目标：让旧 Segment shadow 认为这次编辑**已经完成**，
 * 使 export safety-net（`applySegmentEditsToDocument`，筛选条件 `text !== originalText`）
 * 不再二次应用它。
 *
 * 只做三件事：
 *   1. `segment.text = newText` 且 `segment.originalText = newText`（不可变更新）
 *   2. `editedSegmentsRef` 保留 **oldKey → newText**（replay 条目，供翻页重建回放）
 *   3. 同步 `segmentsByPageRef` 的跨页快照 —— 否则旧快照在导出时仍满足
 *      `text !== originalText`，safety-net 仍会二次应用
 *
 * 关键（B-3.2）：第 2 条的 replay 条目与「export 是否 pending」是**两个不同职责**，
 * 由 export orchestration 层用 `ledger.isCanonicalized()` 把 canonical 的 segment 过滤掉。
 * 本函数不负责判定 export pending。
 *
 * **不删除** editedSegmentsRef / segmentsByPageRef / seg_block_* 任何一个结构。
 *
 * 本函数是纯数据变换（传入的 Map 会被就地更新，因为它们就是 ref 的 current），
 * 由 Segment state 的 owner（`useSelection`）调用 —— 避免产生第三套 Segment truth。
 */
export interface SegmentReconcileDeps {
  segments: Segment[];
  editedSegments: Map<string, string>;
  segmentsByPage: Map<number, Segment[]>;
  /** 必须与写入 editedSegments 时使用的 key 函数一致（= segEditKey） */
  keyOf: (s: Segment) => string;
}

export function reconcileSegmentEdit(
  deps: SegmentReconcileDeps,
  segmentId: string,
  newText: string,
): { segments: Segment[]; reconciled: boolean } {
  let found = false;
  const segments = deps.segments.map((s) => {
    if (s.id !== segmentId) return s;
    found = true;
    //
    // 用**旧** segment 计算 key：editedSegments 正是用旧 key 写入的（key 含旧 originalText）。
    //
    // F3B-6.4B-3.2：**保留** oldKey → newText，作为 **replay** 条目。
    // 依据（B-3.1 实证）：`editedSegmentsRef` 是翻页重建回放的**唯一** source
    // （segmentsByPageRef 只是 export snapshot，每次翻页被 PDFEditor.tsx:3355 覆盖）。
    //
    // ⚠️ 但这条 replay 条目**不得**再被 export 当作 pending：
    // 翻页重建后 snapshot 里的 segment 会变成 text('AAA') / originalText('AAAAA')，
    // 若交给 applySegmentEditsToDocument 会二次 mutation（B-3.1 R6 实证：'AAA...BBBBBBBBB'）。
    // 因此由 **export orchestration 层**用
    // `ledger.isCanonicalized(sourceSegmentKey(s.source))` 过滤掉它
    // —— binding 本身不认识 ledger，保持边界干净。
    // 注意（F3B-6.4B-4.1）：用的是 **canonical position identity**（source 坐标），
    // **不是** `segEditKey(s)`（那条是 replay identity，含会被本函数改写的 originalText）。
    deps.editedSegments.set(deps.keyOf(s), newText);
    return { ...s, text: newText, originalText: newText } as Segment;
  });
  if (!found) return { segments: deps.segments, reconciled: false };

  // 同步跨页快照（segmentsByPageRef 本轮不删除、不重构，只做内容对账）
  for (const [page, segs] of [...deps.segmentsByPage]) {
    deps.segmentsByPage.set(
      page,
      segs.map((s) =>
        s.id === segmentId ? ({ ...s, text: newText, originalText: newText } as Segment) : s,
      ),
    );
  }

  return { segments, reconciled: true };
}

/**
 * 执行一次 canonical Segment commit。
 *
 * **F3B-6.4B-4.1：ledger identity 由本函数内部从 `segment.source` 派生**
 * （`sourceSegmentKey(segment.source)`，即 canonical position identity），
 * 调用方**不再传入 key** —— 从 API 上杜绝误用 replay identity（`segEditKey`，
 * 含会被 reconciliation 改写的 `originalText`）当位置 key 的可能。
 *
 * ── F3B-6.17-3C-3B：**Segment Legacy fallback mutation adapter** ──────────────
 * 仅当 Segment Core commit **未接管**（Core 失败 fallback / migration kill-switch）时，
 * 由 orchestration（`PDFEditor.commitSegmentCanonical`）调用。
 * **Core 成功路径不经过本函数**；此处的 `mutateLineText` 仅服务 Legacy fallback capability。
 *
 * @param segment 被编辑的 Segment（提供 source）
 * @param newText 新文本
 * @param ctx     副作用注入
 */
export function commitSegmentToDocument(
  segment: Segment,
  newText: string,
  ctx: SegmentCommitContext,
): SegmentCommitOutcome {
  // ── 1. resolve segment range ──
  const doc = ctx.getDocument();
  if (!doc) return { ok: false, reason: "no-document" };

  const src = segment.source;
  if (!src) return { ok: false, reason: "no-source" };

  // canonical position identity：只由 source 坐标构成（跨 reconcile / undo / 重建稳定）
  const key = sourceSegmentKey(src);

  // 幂等登记原始区间（ledger 内部保证不覆盖）
  ctx.ledger.register(key, src);

  const line = findLineBySource(doc, src.blockId, src.lineId, src.lineIdx);
  if (!line) return { ok: false, reason: "line-not-found" };

  const range = ctx.ledger.currentRange(key);
  if (range.start < 0 || range.end >= line.glyphs.length || range.start > range.end) {
    return { ok: false, reason: "range-out-of-bounds" };
  }

  // ── 2. capture beforeGlyphs ──
  const beforeGlyphs: EditableGlyph[] = line.glyphs.slice(range.start, range.end + 1);

  // ── 3. mutateLineText ──
  const lineText = line.glyphs.map((g) => g.char).join("");
  // F3B-6.5-C: glyph 区间 → UTF-16 边界（累加 glyph.char.length，非 1:1 假设）。
  // start/end 继续作为 glyph index 传给 mutateLineText（range contract 不变）。
  const { start: utf16Start, end: utf16End } = glyphRangeToUtf16Range(
    line.glyphs,
    range.start,
    range.end,
  );
  const nextLineText =
    lineText.slice(0, utf16Start) + newText + lineText.slice(utf16End);
  const result = mutateLineText(doc, src.blockId, line.id, nextLineText, {
    start: range.start,
    end: range.end,
  });
  if (!result.mutated) return { ok: false, reason: "not-mutated", document: doc };

  // 记录长度增量（必须在 mutation 成功后）
  ctx.ledger.commit(key, newText.length);

  // ── 4. setDocument（ref + version++ 由实现方完成）──
  ctx.setDocument(result.document);

  // ── 5. setBlocks（renderToBlocks 投影）──
  ctx.setBlocks(renderToBlocks(result.document));

  // ── 6. markLineEdited —— 必须在 setDocument 之后 ──
  //
  // F3B-6.4B-6.1（F3B-6.4B-6 审计结论）：`markLineEdited` 的 `currentBox` 只在
  // 「mutation 后的行仍有 ≥1 个 glyph」时被计算；一旦整行被清空，`currentBox` 为 null，
  // 而 Segment 路径又没有 `originalLineBBoxRef`（只在 openTextEditSession 填）与 OCR 的
  // `extraInkBox`，且 `setEditedLineBoxes` 被 `if (finalBox)` 门控 ⇒ **不产盒**
  // ⇒ 同一时刻 reconcile 关掉了 segment overlay ⇒ 原 PDF 墨迹无人遮盖（原文字透出）。
  //
  // 兜底：**仅当** mutation 后该行不再有任何 glyph 时，把「mutation 前的几何」作为
  // `extraInkBox` 传入（beforeGlyphs 的 originalBBox 并集；不可用时退化为行级 bbox）。
  // 普通编辑路径（nextLineText 非空）**不传**，因此行为与修复前逐字节一致。
  //
  // ── F3B-6.4B-T1（P3 Audit §P3-3/§P3-7）：触发条件由「整行清空」拓宽为「**发生了 deletion**」──
  //
  // 判据 = **glyph 数下降**（`line.glyphs.length > mutation 后 glyph 数`），**不是** UTF-16 长度：
  //   · glyph 才是几何载体 —— 被删 glyph 一旦离开 `line.glyphs`，其 `originalBBox` 就再也读不到
  //     （`markLineEdited` 的 `affectedGlyphs` 只遍历**存活** glyph）；
  //   · 尾部删除时，被删区域**右侧没有任何「位置变化」的字形**可以顺带覆盖它
  //     （中段删除靠左移的后缀顺带覆盖，故本条件对它是冗余而非错误）⇒ 原墨迹残留。
  //
  // 几何来源复用**同一 mutation path 已有的** `beforeGlyphs`（本函数 step 2 捕获），
  // mutation 后的行用**已有的** `findLineBySource` 取 —— **不引入任何新的 document state**。
  // 不修改 `markLineEdited` / `affectedGlyphs` / union / padding / mask geometry：
  // 本处只决定「是否把 mutation 前的墨迹盒交出去」，合并仍由既有 union 完成（只外扩）。
  const afterLine = findLineBySource(result.document, src.blockId, src.lineId, src.lineIdx);
  const deletedGlyphs = line.glyphs.length > (afterLine?.glyphs.length ?? 0);
  const deletedInkBox = deletedGlyphs
    ? normalizeBox(unionGlyphInkBox(beforeGlyphs) ?? (line.bbox as InkBox))
    : undefined; // 无 deletion（纯替换 / 插入）⇒ **不传**（与修复前逐字节一致）
  ctx.markLineEdited(src.blockId, line.id, deletedInkBox);

  // ── 7. capture afterGlyphs + pushHistory ──
  // F3B-6.4B-T1：`afterLine` 已在 step 6 取过（同一 `findLineBySource` 调用）⇒ 此处复用，不重复查询。
  const afterGlyphs: EditableGlyph[] = afterLine
    ? afterLine.glyphs.slice(range.start, range.start + newText.length)
    : [];

  // mutateLineText 不产出 inverse → 按 F3B-6.4B-0 §4.4 手工构造（与 onTextEditSave 同源）
  const inverse: InverseData =
    beforeGlyphs.length > 0 || afterGlyphs.length > 0
      ? { kind: "replace", beforeGlyphs, afterGlyphs }
      : { kind: "replace", beforeGlyphs: [], afterGlyphs: [] };

  const operation: TextOperation = {
    type: "replace",
    blockId: src.blockId,
    lineId: line.id,
    range: { start: range.start, end: range.end },
    text: newText,
  } as TextOperation;

  // F3B-6.4B-4.4A：把本次 commit 的 canonical position identity 一并交给 history，
  // 使 orchestration 层在 undo/redo 时能定位本条 ledger record（4.4B 使用）。
  ctx.pushHistory(
    operation,
    {
      document: result.document,
      mutated: true,
      modifiedGlyphIds: result.modifiedGlyphIds,
      inverse,
    },
    key,
  );

  return {
    ok: true,
    range,
    blockId: src.blockId,
    lineId: line.id,
    document: result.document,
    beforeGlyphs,
    afterGlyphs,
  };
}
