/**
 * editor/binding/core-segment-text-projection.ts — F3B-6.27-G5
 *
 * Core → legacy segment 文本**投影**（presentation mirror，不是第二份 authoritative state）。
 *
 * ── 为什么存在（实测根因）────────────────────────────────────────────
 * Core 编辑后 legacy `segments[].text` 从不更新，而 PDFCanvas 的遮罩判据是
 * `seg.text !== seg.originalText`（PDFCanvas.tsx:1656-1658）⇒ 遮罩不渲染 ⇒ 原文残留；
 * 同时透明点击层仍按**原文**排版，点击/光标换算与画布绘制的**编辑后**文字不同源。
 *
 * ── 为什么不能用「paragraphText.slice(...)」反推 ────────────────────────
 * 反推需要在 Core 段落里猜「这一段占多少字符」，而 Core 编辑会让 `startGlyphIndex/endGlyphIndex`
 * 失效（编辑段 run 变 `generated`、lineId 被 strip ⇒ glyph 包含关系解析失败），
 * 恰好在**最需要**的时候拿不到值（C6-F 已记录该失效）。
 * 本原语改用**稳定身份** `lineId → paragraphId`，完全不经 glyph/glyphIndex/字体 advance。
 *
 * ── 契约（fail-open，绝不猜）────────────────────────────────────────────
 * · lineId 缺失 / 无归属映射 / 段落不存在 ⇒ 返回 `undefined`
 *   ⇒ 调用方**保留原 `seg.text`**，绝不写入猜测值（契约 C4）。
 * · 段落不存在于 Core 文档（尚未 import / 已被删）⇒ `undefined`。
 * · **纯函数**：不读 window / DOM / ref，不写任何状态。
 */

import type { EditorDocument } from "../core/document/types";
import { paragraphTextOf } from "./paragraph-offset-core-target";

/**
 * 在 **Core 文档自身**里解析「拥有该 `lineId` 的段落」。
 *
 * 为什么不能只依赖外部映射表（实测教训）：`lineIdParagraphMapRef` 只在
 * 「Core 编辑后 run.source.lineId 被 stripGlyphRange 清除」时才作回退填充，
 * 在真实编辑流程里**常常是空的** ⇒ 投影退化为 no-op（fail-open 但不生效）。
 * Core 文档才是真值：run 的 `source.lineId` 是段落归属的**第一手证据**。
 *
 * fail-open：文档为空 / 无该 lineId / 多个段落同时声称（数据不一致）⇒ `null`（不猜）。
 */
export function coreParagraphIdForLineId(
  document: EditorDocument,
  lineId: string | null | undefined
): string | null {
  if (!lineId) return null;
  let found: string | null = null;
  for (const page of document.pages ?? []) {
    for (const obj of (page.objects ?? []) as Array<{ type?: string; paragraphs?: Array<{ id?: string; runs?: Array<{ source?: { lineId?: string } | null }> }> }>) {
      if (obj.type !== "text") continue;
      for (const para of obj.paragraphs ?? []) {
        if (!para?.id) continue;
        const owns = (para.runs ?? []).some((r) => r?.source?.lineId === lineId);
        if (!owns) continue;
        // 数据不一致（一个 lineId 被多个段落声称）⇒ 不猜
        if (found !== null && found !== para.id) return null;
        found = para.id;
      }
    }
  }
  return found;
}

/** segment 的最小身份投影（与 editor-engine `Segment` 的 source 同构，只取 lineId） */
export interface SegmentLineIdentity {
  readonly source?: { readonly lineId?: string } | null;
}

/**
 * 解析某个 segment 当前在 **Core 文档**里的文本。
 *
 * @param document            Core 文档（真值）
 * @param segment             segment 身份投影（只需 `source.lineId`）
 * @param paragraphIdByLineId `lineId → paragraphId` 权威映射（由 commit 归属维护；
 *                             典型来源是 PDFEditor 的 `lineIdParagraphMapRef`）
 * @returns Core 文本；无法确定身份时 `undefined`（调用方须 fail-open 保留原值）
 */
export function coreSegmentTextOf(
  document: EditorDocument,
  segment: SegmentLineIdentity | null | undefined,
  paragraphIdByLineId: ReadonlyMap<string, string> | null | undefined
): string | undefined {
  const lineId = segment?.source?.lineId;
  if (!lineId) return undefined; // 契约 C4：无身份 ⇒ 不猜
  // 归属解析：Core 文档自身为真值；外部映射表只作可选快路径（实测它常常是空的）
  const paragraphId = coreParagraphIdForLineId(document, lineId) ?? paragraphIdByLineId?.get(lineId);
  if (!paragraphId) return undefined; // 契约 C4：无归属 ⇒ 不猜
  const text = paragraphTextOf(document, paragraphId);
  return text ?? undefined; // 段落不存在 ⇒ undefined ⇒ fail-open
}

/**
 * ★ 契约 S1（scope correctness）：**只**投影 Core 实际拥有的那一个 segment。
 *
 * ── 为什么必须收窄（实测：12 个误遮）─────────────────────────────────────
 * 真实 PDF 中 **1 视觉行可被切成多个 Legacy segment**（gd-swim-2026.pdf：
 * l13/l16/l20 各 3 个 segment），而 `1 lineId → 1 Core paragraph` 成立。
 * ⇒ 若按整列表投影，同一行的**每个** segment 都会被写入**整行** Core 文本
 *   ⇒ 全部 `text !== originalText` ⇒ **误遮** + 整行重复渲染（12 个 mask 的来源）。
 *
 * ── 未编辑 segment 为什么不需要投影 ──────────────────────────────────────
 * 它们的 legacy 文本本来就是 Core 真值（实测投影前 `changedCount = 0`），
 * 因此**保持原样**才是正确行为，而不是重新赋值。
 *
 * 契约：
 *   S1 只有 `id === segmentId` 的那一项可能变化；其余**一律原样返回**（含引用不变）
 *   S2 `originalText` 永不改写
 *   S3 目标段解析不出 Core 文本 ⇒ **整表不动**（fail-open，返回同一引用）
 *   S4 幂等：无变化时返回同一引用 ⇒ 无反馈环
 */
export function projectCoreTextOntoSegment<T extends SegmentLineIdentity & { id: string; text: string }>(
  segments: readonly T[],
  document: EditorDocument,
  segmentId: string | null | undefined,
  paragraphIdByLineId?: ReadonlyMap<string, string> | null
): readonly T[] {
  if (!segmentId) return segments; // S3
  const index = segments.findIndex((s) => s.id === segmentId);
  if (index < 0) return segments; // S3
  const target = segments[index]!;
  const coreText = coreSegmentTextOf(document, target, paragraphIdByLineId);
  if (coreText === undefined || coreText === target.text) return segments; // S3 / S4
  const next = segments.slice();
  next[index] = { ...target, text: coreText }; // S2：只改 text
  return next;
}

/**
 * 批量投影：把 Core 文本套到 segment 列表上（**只改 text，不增删、不改 originalText**）。
 *
 * · 无 Core 文本的 segment **原样保留**（契约 C4 fail-open）
 * · `originalText` 永不改动 ⇒ 遮罩判据 `text !== originalText` 仍由 Core 真值驱动
 * · 输入不变时输出同一引用（幂等，无反馈环）
 */
export function projectCoreTextOntoSegments<T extends SegmentLineIdentity & { text: string }>(
  segments: readonly T[],
  document: EditorDocument,
  paragraphIdByLineId: ReadonlyMap<string, string> | null | undefined
): readonly T[] {
  let changed = false;
  const next = segments.map((s) => {
    const coreText = coreSegmentTextOf(document, s, paragraphIdByLineId);
    if (coreText === undefined || coreText === s.text) return s;
    changed = true;
    return { ...s, text: coreText };
  });
  return changed ? next : segments;
}

// ─────────────────────────────────────────────────────────────────────
//  F3B-6.27 · 空文本缺陷修复（SPEC v2.1 · N1a / N1b / N2）
//
//  根因（已证；Core 契约**不改**）：删除命令整 run 删除分支
//  （core/document/helpers.ts:314-316）按 §24/§25 有意丢弃 provenance，
//  `ensureNonEmptyRuns`（:94-97）补一个**无 source** 的空 run ⇒ 段落仍在、
//  文本为空，但 `run.source.lineId` 消失 ⇒ Binding 层消费链（unit gate locate /
//  单段面 memo / H2 目标 effect）全部退化为 fail-closed ⇒ 编辑面丢失。
//
//  修复形状（纯函数；不猜、不跨段、不绕过既有保护门）：
//    N1a scanLineProvenanceClaim     三态：unique / ambiguous / not-found
//    N1b resolveParagraphIdForLine   统一入口：unique ⇒ provenance（旧行为逐字节一致）；
//                                    ambiguous ⇒ 立即失败（ledger **永不**介入）；
//                                    仅 not-found 查 identity ledger（hint，非 authority）。
//    N2  writeLineIdentity           ledger 唯一写入口；冲突规则 = SPEC v2.1 §3.0
//                                    （U1 首写 / U2 身份失效替换 / U3 域作废；
//                                     F1 冲突不覆盖 / F2 无独立证据拒绝）。
// ─────────────────────────────────────────────────────────────────────

/** N1a：provenance 主张的三态判定（`coreParagraphIdForLineId` 的显式化，不互相调用） */
export type LineProvenanceClaim =
  | { readonly kind: "unique"; readonly paragraphId: string }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "not-found" };

/**
 * N1a：扫描「哪些段落通过 run.source.lineId 声称该 lineId」。
 *
 * 与 `coreParagraphIdForLineId` 的遍历逻辑同构，但把它的二值结果（id | null）
 * 拆成三态——null 无法区分「无人声称（缺失，可恢复）」与「多人声称（数据不一致，
 * 必须暴露）」，而这两类的正确处理方向相反（SPEC v2.1 P0）。
 */
export function scanLineProvenanceClaim(
  document: EditorDocument,
  lineId: string | null | undefined
): LineProvenanceClaim {
  if (!lineId) return { kind: "not-found" };
  let found: string | null = null;
  for (const page of document.pages ?? []) {
    for (const obj of (page.objects ?? []) as Array<{ type?: string; paragraphs?: Array<{ id?: string; runs?: Array<{ source?: { lineId?: string } | null }> }> }>) {
      if (obj.type !== "text") continue;
      for (const para of obj.paragraphs ?? []) {
        if (!para?.id) continue;
        const owns = (para.runs ?? []).some((r) => r?.source?.lineId === lineId);
        if (!owns) continue;
        // 数据不一致（一个 lineId 被多个段落声称）⇒ 显式歧义，不猜
        if (found !== null && found !== para.id) return { kind: "ambiguous" };
        found = para.id;
      }
    }
  }
  return found === null ? { kind: "not-found" } : { kind: "unique", paragraphId: found };
}

/** 结构存在性判据（SPEC v2.1 §3.1 注释）：段落对象是否仍在当前 document 中。 */
function paragraphExistsIn(document: EditorDocument, paragraphId: string): boolean {
  for (const page of document.pages ?? []) {
    for (const obj of (page.objects ?? []) as Array<{ type?: string; paragraphs?: Array<{ id?: string }> }>) {
      if (obj.type !== "text") continue;
      for (const para of obj.paragraphs ?? []) {
        if (para?.id === paragraphId) return true;
      }
    }
  }
  return false;
}

/**
 * 独立身份证据（SPEC v2.1 §3.0 U1 / W0）。
 * `ledger` 来源的值**不可**回写——禁循环确认（ledger 是 hint，不是证据）。
 */
export type LineIdentityEvidence = "provenance-unique" | "h2-identity";

/** ledger 条目（SPEC v2.1 §3.1）：单条目两态，`conflictedWith` 仅诊断用。 */
export interface LineIdentityLedgerEntry {
  readonly paragraphId: string;
  readonly conflictedWith?: string;
}

/** identity ledger 数据模型：`generation` = 文档身份域键（与 sidecarGeneration 同源）。 */
export interface LineIdentityLedger {
  readonly generation: number;
  readonly entries: ReadonlyMap<string, LineIdentityLedgerEntry>;
}

export type WriteLineIdentityResult = "written" | "noop" | "replaced" | "conflicted" | "rejected";

/**
 * N2：ledger **唯一写入口**（SPEC v2.1 §3.1；源码守卫钉死 `entries` 无裸赋值写点）。
 *
 * 写入算法（顺序即规则）：
 * ```
 * W0  evidence 非独立身份证据            ⇒ rejected（零状态变化；F2）
 * W0' lineId/paragraphId 为空            ⇒ rejected
 * W0'' 新值段落不在当前 document          ⇒ rejected（不写不可解析提示）
 * W0''' currentGeneration 不可得         ⇒ rejected（ledger 静默 no-op，安全方向）
 * U3  ledger.generation !== currentGeneration ⇒ 整表作废后按 W1 重写
 * W1  条目不存在                          ⇒ written（U1 首写）
 * W2  条目存在且同值                      ⇒ noop（幂等；conflict 状态**不**因此解除）
 * W3  条目存在且不同值：
 *       旧值段落已不在 document            ⇒ replaced（U2 身份失效替换）
 *       旧值段落仍存在                    ⇒ conflicted（F1：保留旧值 + conflictedWith，不覆盖）
 * ```
 *
 * 纯函数：返回**新** ledger 对象（调用方整体赋值给 ref），不原地修改入参。
 */
export function writeLineIdentity(
  ledger: LineIdentityLedger | null | undefined,
  currentGeneration: number,
  document: EditorDocument,
  input: {
    readonly lineId: string;
    readonly paragraphId: string;
    readonly evidence: LineIdentityEvidence;
  }
): { readonly ledger: LineIdentityLedger | null; readonly result: WriteLineIdentityResult } {
  const reject = { ledger: ledger ?? null, result: "rejected" as const };
  // W0 / W0' / W0''：无独立身份证据（含 ledger 循环确认）/ 空值 / 新值不可解析 ⇒ 拒绝
  if (input.evidence !== "provenance-unique" && input.evidence !== "h2-identity") return reject;
  if (!input.lineId || !input.paragraphId) return reject;
  if (!paragraphExistsIn(document, input.paragraphId)) return reject;
  // W0'''：generation 不可得 ⇒ 拒绝（不建无域键的 ledger）
  if (typeof currentGeneration !== "number" || !Number.isFinite(currentGeneration)) return reject;
  // U3：文档身份域变化 ⇒ 整表作废（随后按 W1 重写）
  const base: LineIdentityLedger =
    !ledger || ledger.generation !== currentGeneration
      ? { generation: currentGeneration, entries: new Map() }
      : ledger;
  const entry = base.entries.get(input.lineId);
  if (!entry) {
    const entries = new Map(base.entries);
    entries.set(input.lineId, { paragraphId: input.paragraphId });
    return { ledger: { generation: base.generation, entries }, result: "written" };
  }
  if (entry.paragraphId === input.paragraphId) {
    // W2：幂等保留；conflict 状态不因重复发布解除（两次发布都曾是健康确认）
    return { ledger: base, result: "noop" };
  }
  const entries = new Map(base.entries);
  if (!paragraphExistsIn(document, entry.paragraphId)) {
    // U2：旧映射身份已失效（段落不在当前 document）⇒ 唯一合法的替换
    entries.set(input.lineId, { paragraphId: input.paragraphId });
    return { ledger: { generation: base.generation, entries }, result: "replaced" };
  }
  // F1：冲突且旧值仍存在 ⇒ 保留旧值（仅诊断）+ 标记冲突；**不得覆盖**
  entries.set(input.lineId, { paragraphId: entry.paragraphId, conflictedWith: input.paragraphId });
  return { ledger: { generation: base.generation, entries }, result: "conflicted" };
}

export type ResolveParagraphForLineResult =
  | { readonly ok: true; readonly paragraphId: string; readonly via: "provenance" | "ledger" }
  | {
      readonly ok: false;
      readonly reason:
        | "no-line-id"
        | "provenance-ambiguous"
        | "no-provenance-no-ledger"
        | "ledger-generation-mismatch"
        | "ledger-conflict"
        | "ledger-stale-paragraph-gone";
    };

/**
 * N1b：`lineId → paragraphId` 统一解析入口（SPEC v2.1 §1 Q1 / §3.2）。
 *
 * 优先级（fail-closed 语义不变）：
 *   ① unique      ⇒ provenance（与 `coreParagraphIdForLineId` 命中路径一致）
 *   ② ambiguous   ⇒ `provenance-ambiguous` 立即失败，**ledger 不介入**（P0 冻结）
 *   ③ not-found   ⇒ 查 ledger（hint）：generation 校验 → conflict 校验 → 存在性校验
 *
 * ⚠️ 旧行为保持：`coreParagraphIdForLineId` 返回 null 的两种情形（缺失/歧义）在本函数
 *    分别为「ledger 可恢复的失败」与「立即失败」——除 not-found+ledger 命中这一**新增**
 *    恢复路径外，其余结果与旧逐字节等价。
 */
export function resolveParagraphIdForLine(
  document: EditorDocument,
  lineId: string | null | undefined,
  ledger: LineIdentityLedger | null | undefined,
  currentGeneration: number
): ResolveParagraphForLineResult {
  if (!lineId) return { ok: false, reason: "no-line-id" };
  const scan = scanLineProvenanceClaim(document, lineId);
  if (scan.kind === "unique") {
    return { ok: true, paragraphId: scan.paragraphId, via: "provenance" };
  }
  if (scan.kind === "ambiguous") {
    // P0（冻结）：数据不一致必须暴露，任何 fallback 都会掩盖它
    return { ok: false, reason: "provenance-ambiguous" };
  }
  // not-found ⇒ 唯一的 ledger 咨询窗口
  if (!ledger) return { ok: false, reason: "no-provenance-no-ledger" };
  if (
    typeof currentGeneration !== "number" ||
    !Number.isFinite(currentGeneration) ||
    ledger.generation !== currentGeneration
  ) {
    return { ok: false, reason: "ledger-generation-mismatch" };
  }
  const entry = ledger.entries.get(lineId);
  if (!entry) return { ok: false, reason: "no-provenance-no-ledger" };
  // F1：冲突条目的保留值**不返回**（它只是诊断信息）
  if (entry.conflictedWith !== undefined) return { ok: false, reason: "ledger-conflict" };
  if (!paragraphExistsIn(document, entry.paragraphId)) {
    return { ok: false, reason: "ledger-stale-paragraph-gone" };
  }
  return { ok: true, paragraphId: entry.paragraphId, via: "ledger" };
}
