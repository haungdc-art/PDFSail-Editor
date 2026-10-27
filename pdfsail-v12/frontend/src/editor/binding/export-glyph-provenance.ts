/**
 * editor/binding/export-glyph-provenance.ts — F3B-6.17-3C-6A.1-CB2
 *
 * Core → Legacy export bridge 的 **PDF operator provenance provider**（Binding 层）。
 *
 * ── 解决的问题（3C-6A 唯一 BLOCKED 项）────────────────────────────────
 * `buildEditableDocument` 构造 `EditableGlyph` 时只写 `char/bbox/styleRef/modified`
 * （+ 可选 metrics），**从不写 `operatorId`** ⇒ Core 导出产物进入
 * `stripReplacedTextOperators` 时 provenance 通道为空 ⇒ 只能退化到「文本匹配」兜底
 * （`export-renderer.ts#L352-375`：`!g.operatorId → continue`）。
 *
 * 而 Sidecar（import-time immutable）**本来就持有** operator provenance。
 * 本模块把它重新接上：
 *
 *     TextRun.source { kind, blockId, lineId, startGlyphIndex, endGlyphIndex }
 *              ↓  lookupLineBinding(sidecar, blockId, lineId)
 *          LineBinding.originalGlyphs[]
 *              ↓  run 内 UTF-16 偏移 → inclusive glyph 区间内逐 glyph 累加 originalChar.length
 *          OriginalGlyph { operatorId?, operatorCharIndex? }
 *              ↓
 *     EditableGlyph.operatorId / .operatorCharIndex
 *
 * ── 边界（严格）──────────────────────────────────────────────────────
 *   · **纯函数 / read-only**：不修改 `sidecar`、不修改 `EditorDocument`、不修改 Sidecar schema。
 *   · **不猜测**：任何不能确定性回溯的情形一律返回 UNKNOWN（`operatorId` 保持 `undefined`）。
 *     与 `document-model/types.ts#L349-354` 的既有契约一致：
 *     「两者留空（= UNKNOWN provenance）→ 导出时绝不删除该 glyph 所在算子，宁可保留原文也不误删」。
 *   · 本模块**不认识** render / mask / reconciliation / native replacement。
 */

import type { TextSourceBinding } from "../core/document/types";
import type { BindingSidecar, LineBinding, OriginalGlyph } from "./binding-sidecar";
import type { GlyphFontIdentity, GlyphMetrics } from "../../document-model/types";
import { lookupLineBinding } from "./binding-sidecar";

/**
 * 单个导出 glyph 的 PDF operator provenance。
 *
 * `provenanceUnknown: true` 仅用于**诊断/断言**（Sidecar 侧语义）；
 * `EditableGlyph` 上**只**写 `operatorId` / `operatorCharIndex`（不新增 legacy 字段）。
 */
export interface ExportGlyphProvenance {
  operatorId?: string;
  operatorCharIndex?: number;
  provenanceUnknown?: boolean;
}

/** provider 查询入参（由 bridge 逐 glyph 提供） */
export interface ExportGlyphProvenanceQuery {
  /** `TextRun.source`（原样传入，不做任何解释性推断） */
  source?: TextSourceBinding;
  /** 该 glyph 在 **run 内**的 UTF-16 偏移（= bridge 的 `runOffset`） */
  runOffset: number;
  /** 该 glyph 的文本（用于与原文做**精确**一致性校验；不一致 ⇒ fail-closed） */
  char: string;
}

/** 供 `EditableDocumentBridgeOptions.glyphProvenanceOf` 注入的回调 */
export type ExportGlyphProvenanceProvider = (
  query: ExportGlyphProvenanceQuery
) => ExportGlyphProvenance;

/** UNKNOWN 单例（`operatorId` 保持 undefined） */
const UNKNOWN: ExportGlyphProvenance = Object.freeze({ provenanceUnknown: true });

/**
 * 在 `[start, end]`（inclusive glyph 区间）内按 UTF-16 偏移定位原 glyph。
 *
 * 逐 glyph 累加 `originalChar.length`（与 `glyph-mapping.tokenizeContentStream` 侧
 * `glyphRangeToUtf16Range` 的累加口径一致）。
 *
 * ⚠️ 任一 glyph 缺 `originalChar`（空串）⇒ **立即 fail-closed（null）**：
 * 偏移一旦无法对齐，后续 glyph 的定位就不可信，绝不猜测。
 */
function glyphAtUtf16Offset(
  glyphs: readonly OriginalGlyph[],
  start: number,
  end: number,
  offset: number
): OriginalGlyph | null {
  if (offset < 0) return null;
  const hi = Math.min(end, glyphs.length - 1);
  let acc = 0;
  for (let i = start; i <= hi; i++) {
    const glyph = glyphs[i];
    const len = glyph?.originalChar?.length ?? 0;
    if (len === 0) return null;
    if (acc === offset) return glyph;
    acc += len;
  }
  return null;
}

/** 从 Sidecar 建 provider（`sidecar` 缺失 ⇒ 全部 UNKNOWN，fail-closed） */
export function createSidecarGlyphProvenanceProvider(
  sidecar: BindingSidecar | null | undefined
): ExportGlyphProvenanceProvider {
  return (query: ExportGlyphProvenanceQuery): ExportGlyphProvenance => {
    // ⓪ Sidecar 缺失（生成隔离 / export 无快照）⇒ 全部 UNKNOWN（fail-closed，且不得抛错）
    if (!sidecar) return UNKNOWN;
    const source = query.source;
    if (!source) return UNKNOWN;
    // ① 只认 pdf-native：OCR / generated / user 的文本与 PDF 算子无对应关系，绝不凭文本猜测
    if (source.kind !== "pdf-native") return UNKNOWN;
    if (!source.blockId || !source.lineId) return UNKNOWN;
    // ② 被编辑过的 run 会被 stripGlyphRange 清除 glyph 索引 ⇒ 无法确定性回溯
    if (source.startGlyphIndex == null || source.endGlyphIndex == null) return UNKNOWN;

    const line: LineBinding | undefined = lookupLineBinding(
      sidecar,
      source.blockId,
      source.lineId
    );
    if (!line) return UNKNOWN;

    const glyph = glyphAtUtf16Offset(
      line.originalGlyphs,
      source.startGlyphIndex,
      source.endGlyphIndex,
      query.runOffset
    );
    if (!glyph) return UNKNOWN;

    // ③ 精确一致性校验：偏移落点必须逐字符等于原文，否则说明 run 与 Sidecar 已错位
    if ((glyph.originalChar ?? "") !== query.char) return UNKNOWN;

    // ④ UNKNOWN provenance 保持 undefined（不伪造、不转字符串）
    if (!glyph.operatorId) return UNKNOWN;

    return glyph.operatorCharIndex === undefined
      ? { operatorId: glyph.operatorId }
      : { operatorId: glyph.operatorId, operatorCharIndex: glyph.operatorCharIndex };
  };
}

/**
 * Step 5A：字符级 PDF 度量 provider 的 query / provider 形态。
 *
 * 与 `ExportGlyphProvenanceQuery` **完全对称**（同一 `{source, runOffset, char}`），
 * 这样 Binding 层从 Sidecar 解读时可以复用同一套 fail-closed 规则。
 */
export type ExportGlyphMetricsQuery = ExportGlyphProvenanceQuery;

/**
 * 返回该 glyph 的 PDF 度量（含 `fontIdentity`）；无法确定性回溯 ⇒ `undefined`。
 *
 * ⚠️ 绝不伪造：`undefined` 时 bridge 不写 `glyph.metrics`，
 * exporter 看不到 `fontIdentity`，于是**如实**落到 CID 兜底字体。
 */
export type ExportGlyphMetricsProvider = (query: ExportGlyphMetricsQuery) => GlyphMetrics | undefined;

/**
 * 从 Sidecar 建度量 provider（sidecar 缺失 ⇒ 全部 undefined，fail-closed）。
 *
 * 规则与 `createSidecarGlyphProvenanceProvider` 同构：
 * ⓪ sidecar 缺失 ① 只认 pdf-native ② 被 stripGlyphRange 的 run 不回溯
 * ③ 行未命中 ④ 偏移落点越界 ⑤ 字符不一致（run 与 Sidecar 已错位）。
 *
 * 与 operator provenance 的区别：那个只为 `operatorId` 回溯；
 * 这个额外带回 `metrics` 与 `fontIdentity`（导出字体选择所需）。
 */
export function createSidecarGlyphMetricsProvider(
  sidecar: BindingSidecar | null | undefined
): ExportGlyphMetricsProvider {
  return (query) => {
    if (!sidecar) return undefined;
    const source = query.source;
    if (!source) return undefined;
    if (source.kind !== "pdf-native") return undefined;
    if (!source.blockId || !source.lineId) return undefined;
    if (source.startGlyphIndex == null || source.endGlyphIndex == null) return undefined;
    const line: LineBinding | undefined = lookupLineBinding(
      sidecar,
      source.blockId,
      source.lineId
    );
    if (!line) return undefined;
    const glyph = glyphAtUtf16Offset(
      line.originalGlyphs,
      source.startGlyphIndex,
      source.endGlyphIndex,
      query.runOffset
    );
    if (!glyph) return undefined;
    if ((glyph.originalChar ?? "") !== query.char) return undefined;
    if (!glyph.metrics && !glyph.fontIdentity) return undefined;
    return {
      ...(glyph.metrics ?? {}),
      ...(glyph.fontIdentity ? { fontIdentity: glyph.fontIdentity } : {}),
    } as GlyphMetrics;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ★ Step 5B：行级 export provenance（原字体身份）
// ─────────────────────────────────────────────────────────────────────────────

/** 行级查询入参：只需要 `run.source`（`blockId` + `lineId` 即可） */
export interface ExportLineFontQuery {
  /** `TextRun.source` 或 `TextBoxObject.source`（原样传入，不做解释性推断） */
  source?: TextSourceBinding;
}

/**
 * 供 `EditableDocumentBridgeOptions.lineFontIdentityOf` 注入的回调。
 *
 * 返回 `undefined` = 无法确定性回答 ⇒ bridge 不写 `EditableLine.originalFontIdentity`
 * ⇒ exporter 如实落到既有 CID 兜底（**绝不猜、绝不伪造**）。
 */
export type ExportLineFontIdentityProvider = (
  query: ExportLineFontQuery
) => GlyphFontIdentity | undefined;

/** 同一行内多个 glyph 身份是否指向同一个 PDF 字体对象 */
function fontIdentityKey(identity: GlyphFontIdentity): string {
  return identity.objectNumber != null
    ? `obj:${identity.objectNumber}`
    : `ref:${identity.fontRef ?? identity.baseFont ?? "?"}`;
}

/**
 * Step 5B：从 Sidecar 行绑定派生**行级**原字体身份。
 *
 * 为什么不走 glyph 级（`createSidecarGlyphMetricsProvider`）：
 *   Core 的 `stripGlyphRange`（§25）会在 run 被编辑后清掉 `startGlyphIndex/endGlyphIndex`
 *   ⇒ glyph 级 provider 必然 fail-closed ⇒ **编辑行的 `glyph.metrics` 恒为空**。
 *   但 `run.source.blockId/lineId` 仍保留（`provenance.ts` 契约），而
 *   「这一行原本用哪个内嵌字体」本来就是**行级**事实，因此可以在行级回答。
 *
 * fail-closed 规则（与既有 provider 同构）：
 *   ⓪ sidecar 缺失 ① 只认 pdf-native（OCR/generated/user 无内嵌字体可复用）
 *   ② 缺 blockId/lineId ③ 行未命中 ④ 行内出现**多个不同**字体身份（混排行）⇒ 不猜。
 *
 * 只读 + 深拷贝返回（Sidecar 是 import-time immutable 快照）。
 */
export function createSidecarLineFontIdentityProvider(
  sidecar: BindingSidecar | null | undefined
): ExportLineFontIdentityProvider {
  return (query: ExportLineFontQuery): GlyphFontIdentity | undefined => {
    if (!sidecar) return undefined;
    const source = query.source;
    if (!source) return undefined;
    if (source.kind !== "pdf-native") return undefined;
    if (!source.blockId || !source.lineId) return undefined;

    const line: LineBinding | undefined = lookupLineBinding(sidecar, source.blockId, source.lineId);
    if (!line) return undefined;

    // 逐 glyph 收集已捕获的身份；必须**唯一**（混排行 ⇒ 不猜 ⇒ 交兜底）
    let picked: GlyphFontIdentity | undefined;
    let pickedKey: string | undefined;
    for (const glyph of line.originalGlyphs) {
      const identity = glyph.fontIdentity;
      if (!identity) continue;
      const key = fontIdentityKey(identity);
      if (pickedKey === undefined) {
        pickedKey = key;
        picked = identity;
        continue;
      }
      if (pickedKey !== key) return undefined; // ④ 同行多字体 ⇒ fail-closed
    }

    return picked ? { ...picked } : undefined;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ★★ P0-1：glyph 级 raw-CID provenance provider（独立通道，不碰 glyph.metrics）
//
// 背景（FONT-1/5 点 census 定案）：编辑行 glyph.metrics 必须 fail-closed 空
//   （Step 5A/5B 契约、isMeasuredOnly），但 raw-CID 直发（emitRawCidGlyphs）
//   需要 `pdfCharCode + pdfTransform` 成对的第一手事实。
//
// 数据源：Sidecar 行 originalGlyphs（builder:177 已带 pdfCharCode，
//   :176 metrics.pdfTransform）—— 即原始 import 的第一手事实（实测 27/32 cid、32/32 tx）。
//
// 对齐策略（fail-closed 单调贪心）：
//   · 仅对有 PDF provenance（blockId+lineId）的字符做匹配
//   · 行内单调游标：只向前推进，绝不回退 ⇒ 原文顺序保持（插入型编辑）
//   · char 不匹配 / 无 cid / transform 残缺 ⇒ undefined ⇒ 该字符保持 fallback
//   · 绝不伪造 CID、绝不猜（P0-1 裁决：缺 pdfCharCode 的 5 个原字符统一 fallback）
// ─────────────────────────────────────────────────────────────────────────────
export interface SidecarGlyphRawProvenanceQuery {
  blockId: string | null;
  lineId: string | null;
  char: string;
}

export function createSidecarGlyphRawProvenanceProvider(
  sidecar: BindingSidecar | null | undefined
): (query: SidecarGlyphRawProvenanceQuery) =>
  { pdfCharCode?: number; pdfTransform?: readonly number[]; originalBBox?: { x: number; y: number; width: number; height: number } }
  | undefined {
  // 行内单调游标（lineId → 已消费的 originalGlyphs 下标）
  const cursor = new Map<string, number>();
  return (query) => {
    if (!sidecar || !query.blockId || !query.lineId || !query.char) return undefined;
    const line = lookupLineBinding(sidecar, query.blockId, query.lineId);
    if (!line?.originalGlyphs?.length) return undefined;
    const glyphs = line.originalGlyphs;
    let i = cursor.get(query.lineId) ?? 0;
    while (i < glyphs.length && (glyphs[i].originalChar ?? glyphs[i].char) !== query.char) i += 1;
    if (i >= glyphs.length) return undefined; // 新增字符 / 顺序失配 ⇒ fail-closed
    const g = glyphs[i]!;
    const tx = g.metrics?.pdfTransform;
    cursor.set(query.lineId, i + 1);
    // ★★ D-a-1（P0-2）：originalBBox 回填**独立于 cid**（实测 27/32 原字符无 pdfCharCode
    //   但 32/32 有 sourceBBox ⇒ 原始位置事实对全部原字符可得）。
    //   raw cid/transform 仍保持成对 fail-closed（P0-1 契约不变）。
    const hasRawCid =
      typeof g.pdfCharCode === "number" && Array.isArray(tx) && tx.length === 6;
    return {
      ...(hasRawCid ? { pdfCharCode: g.pdfCharCode, pdfTransform: tx } : {}),
      originalBBox: g.sourceBBox ? { ...g.sourceBBox } : undefined,
    };
  };
}
