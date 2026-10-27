/**
 * editor/binding/paragraph-offset-core-target.ts — IB-2-F5
 *
 * **Paragraph Offset → Core Target 解析契约**（纯函数，contract-only，**未接生产**）。
 *
 * ── 为什么需要本模块（case 10 的根因）────────────────────────────────
 * `canonicalToCoreTarget()` 的定位方式是「**先按 `run.source.(blockId, lineId)`
 * 找 run**」，因此当同一 `(blockId, lineId)` 命中 **多个** run 时只能
 * `multi-run` 拒绝。而 **A 段编辑后，Core 会把该 paragraph 拆成多个 run**
 * ⇒ 之后再编辑 B 段必然 `multi-run` ⇒ caret 播种失败 ⇒ Core 沿用 A 编辑后
 * 遗留的**陈旧 caret**（IB-2-F 实测：B 起点 / B 末尾两次点击结果完全相同）。
 *
 * ── 关键审计结论 ─────────────────────────────────────────────────────
 * 对 **Segment → Paragraph Binding** 而言，**run 不是需要被「定位」的对象，
 * 而是由 offset 推导出来的结果**。
 *
 *   IB-2-F 已证明 paragraph-relative offset 是**权威且正确**的：
 *     A = [0,20)   gap = [20,21)   B = [21,30)   ⇒ B local 9 → 21 + 9 = 30
 *
 *   因此正确顺序是：
 *     paragraph offset  →  resolveParagraphOffset  →  (runIndex, runOffset)
 *   而不是：
 *     先找到唯一 run  →  才能解释 offset
 *
 * ⇒ **不要为了 case 10 去放宽 `canonicalToCoreTarget()` 的 multi-run 约束**。
 *   那条约束保护的是「按 source 猜 run」这条旧路径；本模块绕过该路径，
 *   直接用 paragraph offset 定位，从而与 run 数量 / run 归属**完全解耦**。
 *
 * ── 复用既有原语（不重造坐标 Truth）──────────────────────────────────
 *   · `paragraphOffsetToPosition()`（core/position §19）—— paragraph offset → TextPosition
 *   · `resolveParagraphOffset()`（core/position/offset §20）—— 确定性 run 边界规则
 *   · `getParagraphTextLength()` —— 段落 UTF-16 总长（emoji 计 2）
 *
 * ── 契约：Run 边界规则（§20，本模块不重新定义，只显式依赖）────────────
 *   偏移落在某 run **末尾**时归属**当前 run**（offset = run.length），
 *   **而不是**下一个 run 的 offset 0。
 *   例：runs = ["est. civil; solteiro", " idade; 41"]，offset 20
 *       ⇒ { runIndex: 0, runOffset: 20 }（Run A 末尾），**不是** Run B 的 0。
 *   该规则由 `resolveParagraphOffset` 保证 **deterministic**，绝不依赖
 *   `find()` 的数组顺序碰巧命中。
 *
 * ── 契约：跨 Run selection ───────────────────────────────────────────
 *   Core 的 `TextRange { anchor, focus }` 本就允许两端位于不同 run
 *   （types.ts §6 只约束方向，不约束同 run）。
 *   ⇒ 本模块**不因跨 run 而拒绝**，而是通过 `crossesRuns` **如实上报**，
 *     由调用方根据自己的能力决定是否 fail-closed（primitive 报告，调用方裁决）。
 *   仅 `start > end`（反向）拒绝 —— 与既有 `canonicalToCoreTarget` 一致。
 *
 * ── fail-closed ─────────────────────────────────────────────────────
 *   段落不存在 / 段落无 run / offset 非有限整数 / 越界 / 反向 ⇒ 返回 reason，
 *   **绝不钳制后静默成功**（钳制会把越界点击伪装成合法 caret）。
 *   `offset === paragraphLength`（段落末尾）是**合法**的。
 */

import type { EditorDocument, Paragraph } from "../core/document/types";
import type { CommandType } from "../core/commands/types";
import {
  getParagraphTextLength,
  paragraphOffsetToPosition,
  type TextPosition,
} from "../core/position";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";

// ─────────────────────────────────────────────────────────────────────
//  S1 · 输入 / 输出结构
// ─────────────────────────────────────────────────────────────────────

export type ParagraphTargetRejection =
  | "missing-paragraph"
  | "missing-run"
  | "invalid-offset"
  | "reversed-range"
  /** IB-2-F6：segment base 不可解析（缺 glyph 区间 / 无行 glyph / 越界） */
  | "missing-segment-base";

/** Paragraph offset 解析出的 Core 目标（run 由 offset 推导，而非前置条件） */
export interface ParagraphCoreTarget {
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** 起点位置（run 由 offset 解析得到） */
  readonly anchor: TextPosition;
  /** 终点位置 */
  readonly focus: TextPosition;
  /** anchor / focus 是否位于不同 run（如实上报，供调用方裁决） */
  readonly crossesRuns: boolean;
  /** 仅当 `!crossesRuns`：run 内半开区间（与 `CoreTextTarget` 同口径，便于兼容消费） */
  readonly runId?: string;
  readonly startOffsetUtf16?: number;
  readonly endOffsetUtf16?: number;
}

export type ParagraphCoreTargetResult =
  | { readonly ok: true; readonly target: ParagraphCoreTarget }
  | { readonly ok: false; readonly reason: ParagraphTargetRejection };

// ─────────────────────────────────────────────────────────────────────
//  S2 · 解析原语
// ─────────────────────────────────────────────────────────────────────

/** 在全文档中定位段落及其所属 TextBox（图片对象无段落，跳过）。 */
function findParagraphOwner(
  document: EditorDocument,
  paragraphId: string
): { textBoxId: string; paragraph: Paragraph } | null {
  for (const page of document.pages ?? []) {
    for (const textBox of page.objects ?? []) {
      if (textBox.type !== "text") continue;
      const paragraph = (textBox.paragraphs ?? []).find((p) => p.id === paragraphId);
      if (paragraph) return { textBoxId: textBox.id, paragraph };
    }
  }
  return null;
}

/**
 * **Paragraph-relative UTF-16 offset → Core target**。
 *
 * @param document        Core `EditorDocument`
 * @param paragraphId     目标段落（由 `resolveSegmentParagraphRange` 或 session caret 提供）
 * @param startOffsetUtf16 起点（paragraph-relative，含分隔空格的段落坐标）
 * @param endOffsetUtf16   终点；省略 ⇒ 折叠 caret（start === end）
 */
export function paragraphOffsetToCoreTarget(
  document: EditorDocument,
  paragraphId: string,
  startOffsetUtf16: number,
  endOffsetUtf16: number = startOffsetUtf16
): ParagraphCoreTargetResult {
  const owner = findParagraphOwner(document, paragraphId);
  if (!owner) return { ok: false, reason: "missing-paragraph" };
  const { paragraph } = owner;
  if ((paragraph.runs ?? []).length === 0) return { ok: false, reason: "missing-run" };

  // offset 校验：**不钳制**（越界静默成功会把错误点击伪装成合法 caret）
  if (!Number.isFinite(startOffsetUtf16) || !Number.isFinite(endOffsetUtf16)) {
    return { ok: false, reason: "invalid-offset" };
  }
  const start = Math.trunc(startOffsetUtf16);
  const end = Math.trunc(endOffsetUtf16);
  const paragraphLength = getParagraphTextLength(paragraph);
  if (start < 0 || end < 0 || start > paragraphLength || end > paragraphLength) {
    return { ok: false, reason: "invalid-offset" };
  }
  if (start > end) return { ok: false, reason: "reversed-range" };

  let anchor: TextPosition;
  let focus: TextPosition;
  try {
    // ★ run 由 offset 推导（§20 确定性边界规则），与 run 数量 / 归属无关
    anchor = paragraphOffsetToPosition(document, paragraphId, start);
    focus = paragraphOffsetToPosition(document, paragraphId, end);
  } catch {
    return { ok: false, reason: "missing-paragraph" };
  }

  const base = {
    textBoxId: owner.textBoxId,
    paragraphId,
    anchor,
    focus,
    crossesRuns: anchor.runId !== focus.runId,
  };

  if (base.crossesRuns) return { ok: true, target: base };
  return {
    ok: true,
    target: {
      ...base,
      runId: anchor.runId,
      startOffsetUtf16: anchor.offset,
      endOffsetUtf16: focus.offset,
    },
  };
}

/**
 * 折叠 caret 便捷入口（等价于 `paragraphOffsetToCoreTarget(doc, id, offset, offset)`）。
 */
export function paragraphOffsetToCaretTarget(
  document: EditorDocument,
  paragraphId: string,
  offsetUtf16: number
): ParagraphCoreTargetResult {
  return paragraphOffsetToCoreTarget(document, paragraphId, offsetUtf16, offsetUtf16);
}

// ─────────────────────────────────────────────────────────────────────
//  S3 · IB-2-F6 · Segment base（**不依赖 run**，不负责 paragraphId）
// ─────────────────────────────────────────────────────────────────────

/** Segment 的 glyph 区间投影（`segment.source` 同构，只取 glyph 索引） */
export interface SegmentGlyphRange {
  readonly startGlyphIndex?: number;
  readonly endGlyphIndex?: number;
}

/**
 * **IB-2-F6：Segment 在 paragraph 内的 UTF-16 起点 base。**
 *
 * 输入只有两样 **import 期产物**：
 *   · `segment.source` 的 glyph 区间（`startGlyphIndex` / `endGlyphIndex`，含端）
 *   · 该行的完整 glyph 序列
 *
 * ⇒ **完全不依赖 run**：Core 编辑会把 run 的 `source` glyph 索引 strip，
 *   但**不会**改动 legacy 行 glyph 序列与 `segment.source`，因此本函数在
 *   「A 编辑后」依然可解析 —— 这正是 case 10 的关键。
 *
 * ⚠️ 职责边界：**不负责 paragraphId**（那来自当前可信的 Core session caret，
 *    见 `resolveSegmentCoreTarget`）。两者语义不同，不得混用。
 *
 * @returns base（paragraph-relative UTF-16，含段间分隔空格）；不可解析 ⇒ `null`
 */
export function resolveSegmentParagraphBaseUtf16(
  source: SegmentGlyphRange | null | undefined,
  lineGlyphs: ReadonlyArray<{ char?: string; originalChar?: string }>
): number | null {
  if (!source) return null;
  const sgStart = source.startGlyphIndex;
  const sgEnd = source.endGlyphIndex;
  if (sgStart == null || sgEnd == null) return null;
  if (!Number.isInteger(sgStart) || !Number.isInteger(sgEnd)) return null;
  if (sgEnd < sgStart) return null;
  if (!lineGlyphs || lineGlyphs.length === 0) return null;
  if (sgStart > lineGlyphs.length - 1 || sgEnd > lineGlyphs.length - 1) return null;

  // ★ 唯一 glyph→UTF-16 换算点（禁止另造坐标 Truth）
  const { start } = glyphRangeToUtf16Range(
    lineGlyphs as unknown as Parameters<typeof glyphRangeToUtf16Range>[0],
    sgStart,
    sgEnd
  );
  return start;
}

/**
 * **错行修复（gd-swim-2026.pdf 实测）：Core caret 的 paragraphId 归属校验。**
 *
 * ── 缺陷 ─────────────────────────────────────────────────────────────
 * Core session 的 `history.state.caret` 在**首次交互前**停在文档初始段落（第 0 段）。
 * 若直接把该 `paragraphId` 当作「用户正在编辑的段落」，则用户在**任意非首行**首次输入时，
 * 提交会被 targeting 到**第 0 段**（另一行），且**静默成功**（不报任何错）。
 *
 * 实测（cases/gd-swim-2026.pdf，真实 Chromium）：
 *   点击第 3 行「广东省体育局、广东省教育厅」→ DOM focusNode 正确，
 *   提交后 Core 段落变成 ["202", "X6 年广东省青少年游泳锦标赛", "竞赛规程", ...]
 *   ⇒ 文本被写进第 1 行标题并将其 split。
 *
 * ── 判据（deterministic，不猜、不按下标）────────────────────────────
 * 该 paragraph 必须**确实承载**当前 segment 的行身份：存在某个 run 满足
 * `run.source.lineId === binding.lineId`。命中才算可信 caret；否则返回 `null`，
 * 调用方落回按 lineId 精确解析的 `coreRangeForBinding` / `coreCaretForBinding`
 * （经 `canonicalToCoreTarget` 解析，与 caret 无关，恒正确）。
 *
 * 保持 IB-2-F6 的原意不变：那段设计要解决的是「A 段编辑后 run 的 glyph 索引被 strip
 * 仍可解析」—— 那种情况下 caret **确实**位于正确段落，本守卫会正常放行。
 *
 * @param position Core `TextPosition`（caret 或 selection.focus）
 * @param lineId   当前被编辑 segment 的 `source.lineId`
 * @returns 可信的 paragraphId；不可信 / 查不到 ⇒ `null`
 */
export function ownedParagraphIdForBinding(
  document: EditorDocument,
  position: { textBoxId: string; paragraphId: string } | null | undefined,
  lineId: string | null | undefined
): string | null {
  if (!position?.paragraphId || !lineId) return null;
  const owner = findParagraphOwner(document, position.paragraphId);
  if (!owner) return null;
  const ownsLine = (owner.paragraph.runs ?? []).some((r) => r.source?.lineId === lineId);
  return ownsLine ? owner.paragraph.id : null;
}

/**
 * 01H（PARAGRAPH-EDIT-ACCEPTANCE）H1 · 拆分产物的**事务证据**（只读，纯数据）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * 行尾 Enter 拆分后：
 *   · Core caret **确实**迁到新段落（`resolveCaretTarget` 的 split 分支正确）；
 *   · 但新空段落的 run **没有** `source.lineId`
 *     （`splitParagraphInTextBox` + `ensureNonEmptyRuns` 的 fallback run 无 source）；
 *   · `ownedParagraphIdForBinding` 因此返回 `null` ⇒ 旧回退按 `lineId` 解析
 *     ⇒ caret 被**重新播种回原段落** ⇒ 后续输入落到原段落开头。
 *
 * 仅凭「同 textBox」或「与旧段落相邻」**不能**证明候选段落属于本次编辑目标
 * （其他段落操作后也可能偶然成立）⇒ 必须由**事务本身**提供证据。
 *
 * ── 证据来源（确定性，不猜）────────────────────────────────────────
 * `EditorHistory` 的已提交事务（`entries()` / `commit()` 返回值）自带
 * `before` / `after` 两份文档快照 ⇒ 「本次 mutation 新建了哪些段落」可由
 * after\before 的段落 id 差集**确定性**算出。
 *
 * ⚠️ 本结构**不**表达归属；归属由 {@link resolveEditingCaretParagraphId}
 * 结合当前状态逐条验证。
 */
export interface CommittedMutationEvidence {
  /** 事务 id（用于校验「当前 applied 事务仍是该事务」） */
  readonly transactionId: string;
  readonly type: CommandType;
  /** after\before 的段落 id 差集（无新增 ⇒ 空数组） */
  readonly createdParagraphIds: readonly string[];
}

/**
 * 01H · H1：**当前编辑应落在哪个段落**（纯函数，生产与测试同一入口）。
 *
 * ── 判定顺序（固定，不得重排）───────────────────────────────────────
 *   ① `ownedParagraphIdForBinding` 成功 ⇒ 返回它（既有正确路径，零行为变化）
 *   ② 校验 Core caret 的候选段落真实存在，且属于有效 text 对象
 *   ③ 校验「同 textBox」——**仅必要条件**，不单独构成充分证明
 *   ④ 校验事务证据与当前状态匹配：
 *        · 事务类型确实是 `split-paragraph`
 *        · 当前 applied 事务仍是该事务（后续 mutation / Undo/Redo ⇒ 证据失效）
 *        · 候选段落仍存在于当前文档
 *        · 候选段落属于预期 textBox
 *   ⑤ 候选 id **恰好**属于该事务新建的段落集合（唯一确认，不挑选第一个）
 *   ⑥ 通过既有 caret 解析函数验证候选目标可解析
 *
 * ── fail-closed ────────────────────────────────────────────────────
 * 任一条件不成立 ⇒ `null`，保留既有回退路径。
 * 不得伪造 `source.lineId`；不得无条件接受 Core caret 的 `paragraphId`。
 */
export function resolveEditingCaretParagraphId(input: {
  /** 当前 Core 文档 */
  readonly document: EditorDocument;
  /** Core caret / selection.focus 的 TextPosition */
  readonly caretPosition: { readonly textBoxId: string; readonly paragraphId: string } | null | undefined;
  /** 当前被编辑 segment 的 `source.lineId` */
  readonly lineId: string | null | undefined;
  /** 已提交事务证据；`null` ⇒ 无证据，直接 fail-closed */
  readonly mutation: CommittedMutationEvidence | null;
  /** 当前已应用事务数（`history.appliedCount`），用于校验证据未过期 */
  readonly appliedCount: number;
  /** 当前 applied 事务（栈顶已应用事务）；`null` ⇒ 证据不可校验 */
  readonly appliedTransactionId: string | null;
}): string | null {
  const { document, caretPosition, lineId, mutation, appliedCount, appliedTransactionId } = input;

  if (!caretPosition?.paragraphId || !lineId) return null;

  // ① 既有归属校验优先（成功即保持原行为）
  const owned = ownedParagraphIdForBinding(document, caretPosition, lineId);
  if (owned !== null) return owned;

  // ② 候选段落必须真实存在且属于有效 text 对象
  const candidateOwner = findParagraphOwner(document, caretPosition.paragraphId);
  if (!candidateOwner) return null;

  // ③ 同 textBox 只是**必要条件**
  const lineOwner = findParagraphByLineId(document, lineId);
  if (!lineOwner || lineOwner.textBoxId !== candidateOwner.textBoxId) return null;

  // ④ 事务证据必须与**当前状态**匹配
  if (!mutation || mutation.type !== "split-paragraph") return null;
  if (!mutation.transactionId || mutation.transactionId !== appliedTransactionId) return null;
  if (!Number.isFinite(appliedCount) || appliedCount <= 0) return null;
  if (mutation.createdParagraphIds.length === 0) return null;

  // ⑤ 候选 id 必须**确实**是该事务新建的段落（不挑选、不推断）
  if (!mutation.createdParagraphIds.includes(caretPosition.paragraphId)) return null;

  // ⑥ 候选目标必须能被既有 caret 解析函数合法解析
  const caretTarget = paragraphOffsetToCaretTarget(document, caretPosition.paragraphId, 0);
  if (!caretTarget.ok) return null;

  return candidateOwner.paragraph.id;
}

/** 01H：按 `run.source.lineId` 定位承载该行的段落及其 textBox（找不到 ⇒ null） */
function findParagraphByLineId(
  document: EditorDocument,
  lineId: string | null | undefined
): { textBoxId: string; paragraph: Paragraph } | null {
  if (!lineId) return null;
  for (const page of document.pages ?? []) {
    for (const textBox of page.objects ?? []) {
      if (textBox.type !== "text") continue;
      for (const paragraph of textBox.paragraphs ?? []) {
        if ((paragraph.runs ?? []).some((r) => r.source?.lineId === lineId)) {
          return { textBoxId: textBox.id, paragraph };
        }
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
//  IB-2-F6 · Paragraph 的当前文本
// ─────────────────────────────────────────────────────────────────────
export function paragraphTextOf(document: EditorDocument, paragraphId: string): string | null {
  const owner = findParagraphOwner(document, paragraphId);
  if (!owner) return null;
  return (owner.paragraph.runs ?? []).map((r) => r.text ?? "").join("");
}

/**
 * **IB-2-F6：用「当前段落文本」校正 segment base。**
 *
 * ── 为什么需要校正 ─────────────────────────────────────────────────
 * `resolveSegmentParagraphBaseUtf16` 用的是 **import 期** 行 glyph 序列，
 * 它只对应**未被编辑**的 paragraph。一旦前序 segment 被编辑（插入/删除字符），
 * 段落文本长度变化 ⇒ 后续 segment 的真实起点随之平移，import 期 base 就**偏小/偏大**。
 *   实测（case 10）：A 末插入 X 后段落变长 1 ⇒ B 的真实起点由 21 变为 22，
 *   直接用 import 期 base 21 ⇒ Y 插到 "idade; 4Y1"（应为 "idade; 41Y"）。
 *
 * ── 判据（deterministic，不猜）─────────────────────────────────────
 * segment 文本在当前段落文本中 **恰好出现一次** ⇒ base = 该出现位置；
 * 出现 0 次（segment 自身已被编辑 / 文本漂移）或 **多次**（重复文本歧义）
 * ⇒ 返回 `null`（fail-closed，调用方回退到 import 期 base）。
 *
 * 分隔空格**不属于** segment 文本，因此 indexOf 自然落在 segment 真实起点之后，
 * 无需另行处理 separator。
 */
export function refineSegmentBaseByParagraphText(
  paragraphText: string | null | undefined,
  segmentText: string | null | undefined
): number | null {
  if (!paragraphText || !segmentText) return null;
  const first = paragraphText.indexOf(segmentText);
  if (first < 0) return null;
  if (paragraphText.indexOf(segmentText, first + 1) >= 0) return null; // 歧义 ⇒ 不猜
  return first;
}

/**
 * **IB-2-F6：Segment 局部 offset → Core target 的完整组合。**
 *
 *   paragraphId（当前可信 Core session caret）
 *        +
 *   segmentStartUtf16（本模块，来自行 glyph 序列）
 *        +
 *   localOffset（DOM 段内偏移）
 *        ↓
 *   paragraph-relative offset → `paragraphOffsetToCoreTarget`
 */
export function resolveSegmentCoreTarget(input: {
  document: EditorDocument;
  paragraphId: string;
  source: SegmentGlyphRange | null | undefined;
  lineGlyphs: ReadonlyArray<{ char?: string; originalChar?: string }>;
  localStart: number;
  localEnd?: number;
}): ParagraphCoreTargetResult {
  const base = resolveSegmentParagraphBaseUtf16(input.source, input.lineGlyphs);
  if (base === null) return { ok: false, reason: "missing-segment-base" };
  const localEnd = input.localEnd ?? input.localStart;
  if (!Number.isFinite(input.localStart) || !Number.isFinite(localEnd)) {
    return { ok: false, reason: "invalid-offset" };
  }
  return paragraphOffsetToCoreTarget(
    input.document,
    input.paragraphId,
    base + Math.trunc(input.localStart),
    base + Math.trunc(localEnd)
  );
}
