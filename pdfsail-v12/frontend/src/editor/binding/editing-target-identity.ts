/**
 * editor/binding/editing-target-identity.ts — F3B-6.27 · H2 **编辑会话目标身份**（纯 contract）
 *
 * ── 问题（H2 只读追踪实证）───────────────────────────────────────────
 * 「当前编辑的是哪个段落」此前有**四个互不一致的解析源**：
 *   ① A′ 文本同步（`PDFEditor.tsx` corePresentation.sourceCaret.paragraphId）
 *   ② 编辑面几何身份（`coreParagraphIdForLineId(coreDoc, lineId)`）
 *   ③ blur 提交上下文（caret 段落 + ownership 硬门）
 *   ④ seed 回退（按 `lineId` 解析）
 * H1 之前四者碰巧一致（caret 被错误拉回旧段落）；H1 让 caret 正确留在新段落后，
 * ① 与其余三者的分歧被暴露 ⇒ 新段落文本被写进旧段落的编辑面 ⇒ blur 二次提交污染旧段落。
 *
 * ── 本模块的职责 ────────────────────────────────────────────────────
 * 提供**单一**编辑目标身份（`EditingTargetIdentity`），并给出两条**不同强度**的规则：
 *   · establish（建立）：身份在面打开 / 拆分事务确认时建立，**必须**由外部事实
 *     （lineId 解析 / 拆分事务证据）给出 paragraphId —— 见 `establishEditingTarget`。
 *   · maintain（维持）：后续每次消费前校验身份**仍与当前 Core 文档一致**
 *     —— 见 `resolveEditingTargetMaintain`。失效 ⇒ 调用方回退 lineId 解析（fail-closed）。
 *
 * ⚠️ 两条规则刻意**分离**：maintain 不做「身份自己证明自己」的自反判定
 *    （身份的合法性来自 establish 那一刻的外部证据，之后只做一致性与存在性校验）。
 *
 * ── 纪律 ────────────────────────────────────────────────────────────
 * · 纯模块：零 React / DOM / Core mutation / 坐标换算。
 * · **不**修改 `resolveEditingCaretParagraphId` 的 ①–⑥ 判据顺序（其单测锁定顺序）。
 * · **不**触碰 ownership / ledger schema、不伪造 `source.lineId`、不推导 glyph range。
 * · **不**表达几何：身份只回答「编辑的是谁」，不回答「面多大」。
 */

import type { EditorDocument } from "../core/document/types";

/** 单一编辑目标身份（**不含文本**：文本真值恒从 Core 派生） */
export interface EditingTargetIdentity {
  /** 承载该面的 legacy segment（触发者） */
  readonly segmentId: string;
  /** 真正的编辑对象（Core paragraph） */
  readonly paragraphId: string;
  /** 该段落所属的 text object（校验用） */
  readonly textBoxId: string;
  /** 建立时的 Core document version（仅用于检测「文档被换掉 / 回退」） */
  readonly generation: number;
}

export type EditingTargetInvalidReason =
  /** 无身份（未建立 / 已清除） */
  | "no-target"
  /** segment 不匹配（换了编辑面） */
  | "segment-mismatch"
  /** 绑定段落已不存在于当前文档（含 undo/redo / 换文档） */
  | "paragraph-missing"
  /** 绑定段落仍在，但已不属于建立时的 text object */
  | "textbox-mismatch"
  /** Core version 倒退（换文档 / 回滚）⇒ 身份不可信 */
  | "generation-regressed"
  /** Core caret 已迁出绑定段落 ⇒ 与 Core 状态冲突 */
  | "caret-divergence";

export interface EstablishEditingTargetInput {
  readonly segmentId: string | null | undefined;
  /** 由**外部事实**解析出的段落（lineId 解析 / 拆分事务证据），不得由本模块推断 */
  readonly paragraphId: string | null | undefined;
  readonly document: EditorDocument | null | undefined;
  readonly generation: number | null | undefined;
}

export interface EditingTargetMaintainInput {
  readonly target: EditingTargetIdentity | null | undefined;
  readonly segmentId: string | null | undefined;
  readonly document: EditorDocument | null | undefined;
  /** 当前 Core caret 所在段落；**给了才做**一致性校验（不给 ⇒ 跳过该条） */
  readonly caretParagraphId?: string | null;
  /** 当前 Core document version；给了才做「倒退」校验 */
  readonly currentGeneration?: number | null;
}

/**
 * rebind：**重绑定**编辑目标（把身份迁到拆分新建的段落）。
 *
 * ── 为什么需要第二条规则 ────────────────────────────────────────────
 * H1 的 `resolveEditingCaretParagraphId` 依赖事务透出的 `transactionId`
 * 与 `appliedTransactionId` 对齐。该链路在生产**可用**
 * （H2-C 实测：`tx_5i / split-paragraph / created=[para_5g]`；此前「生产
 * transactionId 为 null」的诊断是观测 bug，已更正）。但它**单发失效**：
 * 任何后续 mutation（输入的每一个字符）都会覆盖/清空拆分事务证据 ⇒
 * 拆分后若 H1 判定在 A′ 时刻错过（时序竞态），后续输入再无证据可依。
 *
 * 本函数改用**同一事务自带的 before/after 文档快照**做等价判定：
 * 「caret 所在段落是否恰好是本次事务新建的那一个」。证据强度与 H1 相同
 * （都是事务事实，不是结构相似性推断），只是来源不同；作为 H1 判据
 * （①–⑥）中任一条不成立时的兜底路径，先 H1 后快照。
 *
 * ── 判据（全部成立才重绑定，任一不成立即 `null`）───────────────────
 *   ① caret 段落存在，且属于一个 text object
 *   ② 与既有目标同 textBox（无既有目标时跳过该条）
 *   ③ 该段落**恰好**是本次事务新建的段落集合里**唯一**的一个（after \ before）
 *      ⇒ 多段落新建 / 非新建 ⇒ 不猜、不挑第一个
 *   ④ 与既有目标不同（幂等：重复调用不抖动）
 *
 * ⚠️ 本函数**不**复制 `resolveEditingCaretParagraphId` 的 ①–⑥ 判据；
 *    两者是「同一结论的两条证据路径」，调用方先试前者、失败再试本函数。
 */
export interface EditingTargetRebindInput {
  readonly document: EditorDocument | null | undefined;
  readonly target: EditingTargetIdentity | null | undefined;
  readonly segmentId: string | null | undefined;
  readonly caretParagraphId: string | null | undefined;
  /** 最近一次**已应用**事务的 before 快照 */
  readonly beforeDocument: EditorDocument | null | undefined;
  /** 最近一次已应用事务的 after 快照 */
  readonly afterDocument: EditorDocument | null | undefined;
}

function collectParagraphIds(document: EditorDocument | null | undefined): string[] {
  const ids: string[] = [];
  if (!document) return ids;
  for (const page of document.pages ?? []) {
    for (const obj of page.objects ?? []) {
      if (obj.type !== "text") continue;
      for (const paragraph of obj.paragraphs ?? []) ids.push(paragraph.id);
    }
  }
  return ids;
}

export function resolveEditingTargetRebind(
  input: EditingTargetRebindInput
): string | null {
  const { document, target, segmentId, caretParagraphId, beforeDocument, afterDocument } = input;
  if (!document || !segmentId || !caretParagraphId) return null;
  if (target && target.segmentId !== segmentId) return null;
  if (target && target.paragraphId === caretParagraphId) return null; // 幂等

  const textBoxIdNow = findTextBoxIdOf(document, caretParagraphId);
  if (textBoxIdNow === null) return null;
  if (target && textBoxIdNow !== target.textBoxId) return null;

  const beforeIds = new Set(collectParagraphIds(beforeDocument));
  const created = collectParagraphIds(afterDocument).filter((id) => !beforeIds.has(id));
  if (created.length !== 1) return null; // 不唯一 ⇒ 不猜
  if (created[0] !== caretParagraphId) return null;
  return caretParagraphId;
}

export type EditingTargetMaintainResult =
  | { readonly ok: true; readonly paragraphId: string }
  | { readonly ok: false; readonly reason: EditingTargetInvalidReason };

/** 按 paragraphId 定位所属 text object（找不到 ⇒ null）。与归属判定无关，只做存在性证明。 */
function findTextBoxIdOf(
  document: EditorDocument,
  paragraphId: string
): string | null {
  for (const page of document.pages ?? []) {
    for (const obj of page.objects ?? []) {
      if (obj.type !== "text") continue;
      for (const paragraph of obj.paragraphs ?? []) {
        if (paragraph.id === paragraphId) return obj.id;
      }
    }
  }
  return null;
}

/**
 * establish：建立编辑目标身份。
 *
 * ⚠️ `paragraphId` **必须**由调用方给出（lineId 解析或拆分事务证据），本模块不推断、
 *    不挑选、不回退 —— 推断权属于调用方，本模块只负责「记录 + 校验可记录」。
 * 段落不在文档中 ⇒ `null`（拒绝建立，调用方保持无身份状态）。
 */
export function establishEditingTarget(
  input: EstablishEditingTargetInput
): EditingTargetIdentity | null {
  const { segmentId, paragraphId, document, generation } = input;
  if (!segmentId || !paragraphId || !document) return null;
  const textBoxId = findTextBoxIdOf(document, paragraphId);
  if (textBoxId === null) return null;
  return {
    segmentId,
    paragraphId,
    textBoxId,
    generation: Number.isFinite(generation as number) ? (generation as number) : 0,
  };
}

/**
 * maintain：校验既有身份**是否仍适用于当前状态**。
 *
 * ── 校验顺序（固定）─────────────────────────────────────────────────
 *   ① 无身份 / segment 不匹配 ⇒ 失效（换面即失效，不跨面复用）
 *   ② 绑定段落仍存在于当前文档，且仍属于建立时的 text object
 *   ③ Core version **未倒退**（倒退 = 换文档 / 回滚 ⇒ 身份不可信）
 *   ④ 若给出 caret 段落 ⇒ 必须与绑定段落一致（与 Core 状态冲突即失效）
 *
 * ⚠️ version **只判倒退、不判相等**：每次 Core 提交都会推进 version，
 *    判相等会让身份在第一次提交后立即失效 ⇒ 维持不住「拆分后连续输入」。
 * ⚠️ 失效 ⇒ 调用方**回退 lineId 解析**（fail-closed 到既有路径），**不是** fail 到 null。
 */
export function resolveEditingTargetMaintain(
  input: EditingTargetMaintainInput
): EditingTargetMaintainResult {
  const { target, segmentId, document } = input;
  if (!target) return { ok: false, reason: "no-target" };
  if (!segmentId || target.segmentId !== segmentId) {
    return { ok: false, reason: "segment-mismatch" };
  }
  if (!document) return { ok: false, reason: "paragraph-missing" };

  const textBoxIdNow = findTextBoxIdOf(document, target.paragraphId);
  if (textBoxIdNow === null) return { ok: false, reason: "paragraph-missing" };
  if (textBoxIdNow !== target.textBoxId) return { ok: false, reason: "textbox-mismatch" };

  const currentGeneration = input.currentGeneration;
  if (
    Number.isFinite(currentGeneration as number) &&
    Number.isFinite(target.generation) &&
    (currentGeneration as number) < target.generation
  ) {
    return { ok: false, reason: "generation-regressed" };
  }

  const caretParagraphId = input.caretParagraphId;
  if (caretParagraphId != null && caretParagraphId !== target.paragraphId) {
    return { ok: false, reason: "caret-divergence" };
  }

  return { ok: true, paragraphId: target.paragraphId };
}
