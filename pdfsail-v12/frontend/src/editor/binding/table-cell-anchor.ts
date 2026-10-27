/**
 * editor/binding/table-cell-anchor.ts — F3B-6.28 · S2-v3：cell 编辑面**稳定锚**（纯契约）
 *
 * ── 背景（D1 根因，S3 取证）────────────────────────────────────────────
 *   cell 面首字符经 unit route 正确提交后，Core `deriveRun` strip 掉行内单 run 的
 *   glyph 索引 ⇒ 规划器门 2（run 包含关系）失败 ⇒ cell 面消失；而 regime-B 登记
 *   退出编辑才清除 ⇒ 降级单段路径按 base=0 插入 ⇒ 串格（T9/T11）。
 *   F1 单独修复（cell 面不登记 regime-B）消除串格但暴露段内倒序（XYZ→YZX，已回退）。
 *   ⇒ 正解不是修补降级偏移，而是让 cell 面在提交后**保持稳定身份**：本模块即该身份。
 *
 * ── 契约（cases/F3B-6.28-S2-v3-CellAnchor-Contract.md，v3，阶段 1 已通过）────
 *   establish：捕获锚字段前必须**重新证明轴等价性**（门 3 等价性在 establish 内再证一次，
 *     `axis-mismatch`）——两套文本坐标在该 cell 上逐字节一致才允许捕获 prefix/suffix。
 *   revalidate：检查序**钉死** C1 → C2 → C3 → C5(V1 → V1b → V2 → V3 → V4) → C4；
 *     身份失败优先于位置成功（IDENTITY-OVER-POSITION）：C4 通过不能挽救任一身份条件。
 *   C5 = 对**当前** legacy 轴重跑 S1（`resolveSegmentCell`）+ V1b 整 cell 内容证明：
 *     · V1  = S1 ok（行成员/lineId/区间/D3 位置内容证明/唯一包含）——entry segment 的
 *             glyph 区间与 originalText 均为 import 期不可变值 ⇒ 「当前 vs 不可变」；
 *     · V1b = 当前行在**锚记录区间**上的切片 === `cellTextAtEstablishment`
 *             （establishment 捕获且经轴等价证明的不可变基准）⇒ 语义身份的独立证据；
 *     · V2/V3 = 检测稳定性（当前检测 vs establishment 检测）⇒ 仅结构一致性，
 *             **不能**挽救 V1b 失败（自证循环排除）；
 *     · V4  = entry segment 区间被该 cell 包含（V1 唯一包含的推论，显式断言）。
 *   fail-closed：V1b 不等 ⇒ `cell-content-drift`；不可评估 ⇒ `legacy-row-unavailable`；
 *     均不以 V2/V3 一致性补救。
 *   **派生隔离**：`cellLen`/`cellText` 只作为每次消费的返回值，**绝不写入锚对象**；
 *     `cellTextAtEstablishment` 是独立的 establishment 基准，不得与派生 cellText 混用。
 *     （v1 设计曾把 cellLen 回写锚——已删除：不允许用缓存证明缓存。）
 *   **generation 术语**：C2 比的是 **document generation**（per-import），不是 Core
 *     revision（每次 mutation 递增）。锚故意在 revision 变化后存活；禁止把
 *     `document.version === anchor.*version` 当有效性判据（那等于锚首次提交即死）。
 *   **相邻 cell 失效的精确承诺**：只要相邻 cell 的变化导致当前文档不再满足固定
 *     prefix/suffix 的位置证明，锚就必须失效；若当前文本完全恢复为原状态（净零编辑），
 *     纯文本位置契约不负责识别曾经发生过的中间变化。
 *
 * ── 换宿主（同 cell 多 segment）────────────────────────────────────────
 *   `entrySegment.id !== anchor.entrySegmentId` 时不做任何特殊放行：新宿主必须过完整
 *   C5（V1 新段 D3 + V1b + V2/V3/V4）。过 ⇒ 经返回值交还新 entrySegmentId（由接线层
 *   effect 写回 ref）；不过 ⇒ 对应 reason 失败。**仅凭 cellIndex 相同不放行。**
 *
 * ── 硬边界 ─────────────────────────────────────────────────────────────
 *   纯函数：零 React / DOM / Command / ref / effect / tick / indexOf / 文本匹配 /
 *   提交 / 回滚 / Undo-Redo / 生产状态管理。不读生产门（`__cellUnitEditing` 归属
 *   `table-cell-unit.ts`，本模块 flag 无关）。
 *   本模块**已接生产**（S2-v3 阶段 4 已批准：PDFEditor.tsx memo 消费 revalidate +
 *   锚 effect 负责 establish/promote/失效/退出判定；生产门缺省 ON，见 table-cell-unit.ts）。
 */

import type { EditorDocument } from "../core/document/types";
import { paragraphTextOf } from "./paragraph-offset-core-target";
import {
  resolveSegmentCell,
  type CellResolverSegment,
  type CellResolverCellInterval,
  type SegmentCellRejectReason,
} from "./table-cell-resolver";

// ─────────────────────────────────────────────────────────────────────
//  S1 · 类型
// ─────────────────────────────────────────────────────────────────────

/** cell 墨迹盒（legacy glyph bbox 并集；与 Core 行盒同空间同尺度，S0 实测） */
export interface CellAnchorBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 行 glyph 投影（C5 的当前行输入；establishment 时同型） */
export interface CellAnchorGlyph {
  readonly char?: string;
}

/**
 * 锚记录 = **身份与边界权威**（establishment 时写入；唯一可变字段 = entrySegmentId）。
 * 刻意**不含** `cellLen` / `cellText` 等派生字段——它们每次消费时由 C4 现算。
 */
export interface CellAnchor {
  readonly lineId: string;
  readonly blockId: string;
  readonly cellIndex: number;
  readonly paragraphId: string;
  readonly textBoxId: string;
  /** cell 的段落级起点（= prefixText.length；IB-2-A invariant + 门 3 等价性证明） */
  readonly pStartUtf16: number;
  /** establishment 时从 Core 段落捕获的段首锚（C4.a 的不可变基准） */
  readonly prefixText: string;
  /** establishment 时从 Core 段落捕获的段尾锚（C4.b 的不可变基准） */
  readonly suffixText: string;
  /** establishment 时的 cell glyph 闭区间（V1b/V3 的比对基准） */
  readonly cellStartGlyphIndex: number;
  readonly cellEndGlyphIndex: number;
  /** establishment 时 legacy 行 cell 区间切片（V1b 的不可变基准；与派生 cellText 不同物） */
  readonly cellTextAtEstablishment: string;
  /** document generation（per-import，与 sidecarGenerationRef 同源）；C2 判据 */
  readonly documentGeneration: number;
  readonly cellBox: CellAnchorBox;
  /** 信息项（不作判据） */
  readonly establishedAtRevision: number;
  /** 入口宿主 segment（换宿主证明通过时由接线层 effect 更新；唯一可变字段） */
  entrySegmentId: string;
}

export interface EstablishCellAnchorInput {
  readonly lineId: string;
  readonly blockId: string;
  readonly cellIndex: number;
  readonly paragraphId: string;
  readonly textBoxId: string;
  /** cell 的段落级起点（来自门链产物 cellStartUtf16；IB-2-A invariant 下 = 行内 UTF-16） */
  readonly pStartUtf16: number;
  readonly cellStartGlyphIndex: number;
  readonly cellEndGlyphIndex: number;
  readonly cellBox: CellAnchorBox;
  readonly document: EditorDocument;
  readonly documentGeneration: number;
  readonly entrySegmentId: string;
  /** establishment 时该行 glyph（捕获 cellTextAtEstablishment 用） */
  readonly rowGlyphs: readonly CellAnchorGlyph[];
  /**
   * ★ 2026-10-24（ledger 路径）：establishment 时该 cell 的**当前 Core 内容**
   * （= 门链/台账假设验证过的 plan.cellText）。缺省 undefined ⇒ 轴等价性复核基准 =
   * legacy 行位置切片（既有行为逐字节不变）。
   *
   * 为什么需要：台账路径下该 cell 已被编辑过 ⇒ Core 内容 ≠ legacy 位置切片；
   * 既有轴复核（Core 切片 === legacy 切片）必然失败 ⇒ 锚无法建立 ⇒ 面在首次
   * 提交后消失（D1 同族）。传入本字段后：
   *   · 轴等价性复核改为 Core 切片 === establishedCellText（长度随当前内容）；
   *   · prefix/suffix 按当前内容长度捕获（C4 语义不变）；
   *   · `cellTextAtEstablishment` **仍存 legacy 位置切片**（V1b 的 legacy 轴漂移
   *     检测基准不变——legacy 行在 Core ownership 下不可变 ⇒ revalidate 持续通过）。
   */
  readonly establishedCellText?: string;
}

export type EstablishCellAnchorRejectReason =
  /** C1：段落不存在于当前 Core 文档 */
  | "paragraph-missing"
  /** 输入区间非法（非整数 / 逆序 / 越界 / pStart 越界 / prefix 长度与 pStart 不一致） */
  | "invalid-interval"
  /** 轴等价性复核失败：Core 段落切片 ≠ legacy 行 cell 区间切片（门 3 等价性再证） */
  | "axis-mismatch";

export type EstablishCellAnchorOutcome =
  | { readonly ok: true; readonly anchor: CellAnchor }
  | { readonly ok: false; readonly reason: EstablishCellAnchorRejectReason };

export interface RevalidateCellAnchorInput {
  readonly anchor: CellAnchor;
  /** 当前 Core 文档（C1；会话文档，`documentOf(session)`） */
  readonly document: EditorDocument | null | undefined;
  /** 当前 document generation（C2；sidecarGenerationRef.current） */
  readonly documentGeneration: number;
  /** Core ownership 是否仍成立（C3；会话存在且 ownership 未翻 legacy） */
  readonly coreOwned: boolean;
  /** 当前入口 segment（可能是换宿主后的新宿主；C5 的 V1 输入） */
  readonly entrySegment: CellResolverSegment | null | undefined;
  /** 当前 legacy 行 glyph（C5；null ⇒ 不可评估） */
  readonly rowGlyphs: readonly CellAnchorGlyph[] | null | undefined;
  /** 当前行全部 segment（C5；身份成员校验） */
  readonly rowSegments: readonly CellResolverSegment[];
  /** 当前检测产物（C5；调用方对当前行跑 detectTableCells 的区间投影） */
  readonly cells: readonly CellResolverCellInterval[];
}

export type CellAnchorRejectReason =
  // C1–C3（身份）
  | "paragraph-missing"
  | "generation-mismatch"
  | "ownership-lost"
  // C5（legacy 轴身份）
  | "legacy-row-unavailable"
  | "cell-content-drift"
  | "cell-interval-drift"
  | SegmentCellRejectReason
  // C4（Core 轴位置）
  | "prefix-mismatch"
  | "suffix-mismatch"
  | "length-underflow";

/** 派生结果（每次消费现算；**绝不**写入锚对象） */
export interface CellAnchorDerived {
  readonly cellText: string;
  readonly cellLen: number;
  readonly pStartUtf16: number;
  readonly pEndUtf16: number;
  /** 证明通过的入口宿主（可能与锚记录不同 ⇒ 接线层 effect 据此更新 ref） */
  readonly entrySegmentId: string;
}

export type RevalidateCellAnchorOutcome =
  | { readonly ok: true; readonly derived: CellAnchorDerived }
  | { readonly ok: false; readonly reason: CellAnchorRejectReason };

// ─────────────────────────────────────────────────────────────────────
//  S2 · 私有原语
// ─────────────────────────────────────────────────────────────────────

/** 闭区间字符串拼接（[cs, ce] inclusive；缺失 char 贡献空串）。非坐标换算。 */
function joinGlyphSlice(
  rowGlyphs: readonly CellAnchorGlyph[],
  cs: number,
  ce: number
): string {
  let s = "";
  for (let i = cs; i <= ce; i++) s += rowGlyphs[i]?.char ?? "";
  return s;
}

function isInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

// ─────────────────────────────────────────────────────────────────────
//  S3 · establish（捕获前必须再证轴等价性）
// ─────────────────────────────────────────────────────────────────────

/**
 * **建立 cell 锚**（S2-v3 唯一入口；调用方 = 完整门链成功后的接线层）。
 *
 * 顺序（fail-closed 前置）：C1 段落文本 → 输入区间合法性 → 捕获
 * `cellTextAtEstablishment` → **轴等价性复核**（Core 段落切片 vs legacy 行切片）→
 * 捕获 prefix/suffix → 建锚。
 */
export function establishCellAnchor(
  input: EstablishCellAnchorInput
): EstablishCellAnchorOutcome {
  // C1：段落必须存在于当前 Core 文档且文本可得
  const text = paragraphTextOf(input.document, input.paragraphId);
  if (text == null) return { ok: false, reason: "paragraph-missing" };

  // 输入区间合法性（glyph 闭区间 + 段落级起点）
  const cs = input.cellStartGlyphIndex;
  const ce = input.cellEndGlyphIndex;
  const pStart = input.pStartUtf16;
  if (!isInteger(cs) || !isInteger(ce) || ce < cs || cs < 0) {
    return { ok: false, reason: "invalid-interval" };
  }
  if (ce > input.rowGlyphs.length - 1) return { ok: false, reason: "invalid-interval" };
  if (!isInteger(pStart) || pStart < 0 || pStart > text.length) {
    return { ok: false, reason: "invalid-interval" };
  }

  // 捕获 establishment 基准（legacy 轴；V1b 的漂移检测基准 —— 不随编辑变化）
  const cellTextAtEstablishment = joinGlyphSlice(input.rowGlyphs, cs, ce);
  // 轴等价性复核基准：缺省 = legacy 位置切片（既有行为）；ledger 路径 = 调用方
  // 传入的当前内容（门链已做过位置内容证明，此处再证一次——establish 自包含）。
  const establishedText = input.establishedCellText ?? cellTextAtEstablishment;
  const establishedLen = establishedText.length;

  // ★ 轴等价性复核（门 3 等价性在 establish 内再证一次）：
  //   Core 段落在 [pStart, pStart+establishedLen) 的切片必须与复核基准逐字节相等。
  //   不等 ⇒ 两套文本坐标在该 cell 上不一致 ⇒ 不允许捕获 prefix/suffix。
  if (text.slice(pStart, pStart + establishedLen) !== establishedText) {
    return { ok: false, reason: "axis-mismatch" };
  }

  // prefixText = text.slice(0, pStart) ⇒ prefixText.length === pStart 由构造保证
  const prefixText = text.slice(0, pStart);
  const suffixText = text.slice(pStart + establishedLen);

  return {
    ok: true,
    anchor: {
      lineId: input.lineId,
      blockId: input.blockId,
      cellIndex: input.cellIndex,
      paragraphId: input.paragraphId,
      textBoxId: input.textBoxId,
      pStartUtf16: pStart,
      prefixText,
      suffixText,
      cellStartGlyphIndex: cs,
      cellEndGlyphIndex: ce,
      cellTextAtEstablishment,
      documentGeneration: input.documentGeneration,
      cellBox: input.cellBox,
      establishedAtRevision: input.document.version,
      entrySegmentId: input.entrySegmentId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  S4 · revalidate（检查序钉死：C1→C2→C3→C5(V1→V1b→V2→V3→V4)→C4）
// ─────────────────────────────────────────────────────────────────────

/**
 * **重验证 cell 锚**（每次 Core revision 变化后由接线层调用；memo 消费前亦自跑）。
 *
 * 身份失败优先于位置成功：任一步失败即返回该 reason，不继续评估后续条件。
 * 成功时返回**派生值**（cellText/cellLen/偏移/入口宿主）——绝不回写锚对象。
 */
export function revalidateCellAnchor(
  input: RevalidateCellAnchorInput
): RevalidateCellAnchorOutcome {
  const anchor = input.anchor;

  // ── C1：段落存在且文本可得 ──
  const text = input.document ? paragraphTextOf(input.document, anchor.paragraphId) : null;
  if (text == null) return { ok: false, reason: "paragraph-missing" };

  // ── C2：document generation 未变（per-import；**不是** Core revision） ──
  if (input.documentGeneration !== anchor.documentGeneration) {
    return { ok: false, reason: "generation-mismatch" };
  }

  // ── C3：Core ownership 仍成立 ──
  if (!input.coreOwned) return { ok: false, reason: "ownership-lost" };

  // ── C5：legacy 轴身份（V1 → V1b → V2 → V3 → V4） ──
  const rowGlyphs = input.rowGlyphs;
  if (rowGlyphs == null) return { ok: false, reason: "legacy-row-unavailable" };

  // V1：S1 重跑（行成员 / lineId / 区间合法 / D3 位置内容证明 / 唯一包含）
  const cellRes = resolveSegmentCell({
    segment: input.entrySegment,
    rowGlyphs,
    rowSegments: input.rowSegments,
    cells: input.cells,
  });
  if (!cellRes.ok) return { ok: false, reason: cellRes.reason };

  // V1b：整 cell 内容证明（语义身份的独立证据；基准 = establishment 捕获文本）
  //   不可评估 ⇒ legacy-row-unavailable（fail-closed；不由 V2/V3 补救）
  const cs = anchor.cellStartGlyphIndex;
  const ce = anchor.cellEndGlyphIndex;
  if (!isInteger(cs) || !isInteger(ce) || ce < cs || cs < 0 || ce > rowGlyphs.length - 1) {
    return { ok: false, reason: "legacy-row-unavailable" };
  }
  if (joinGlyphSlice(rowGlyphs, cs, ce) !== anchor.cellTextAtEstablishment) {
    return { ok: false, reason: "cell-content-drift" };
  }

  // V2：cellIndex 一致
  if (cellRes.cell.cellIndex !== anchor.cellIndex) {
    return { ok: false, reason: "cell-interval-drift" };
  }
  // V3：cell glyph 区间一致
  if (
    cellRes.cell.cellStartGlyphIndex !== cs ||
    cellRes.cell.cellEndGlyphIndex !== ce
  ) {
    return { ok: false, reason: "cell-interval-drift" };
  }
  // V4：entry segment 区间被该 cell 包含（V1 唯一包含的推论，显式断言）
  const seg = input.entrySegment;
  const segStart = seg?.source?.startGlyphIndex;
  const segEnd = seg?.source?.endGlyphIndex;
  if (!isInteger(segStart) || !isInteger(segEnd) || segStart < cs || segEnd > ce) {
    return { ok: false, reason: "cell-interval-drift" };
  }

  // ── C4：prefix/suffix 位置证明（Core 轴；自校正 cellLen） ──
  const L = text.length;
  const prefixLen = anchor.prefixText.length;
  const suffixLen = anchor.suffixText.length;
  if (L < prefixLen + suffixLen) return { ok: false, reason: "length-underflow" };
  if (text.slice(0, prefixLen) !== anchor.prefixText) {
    return { ok: false, reason: "prefix-mismatch" };
  }
  if (text.slice(L - suffixLen) !== anchor.suffixText) {
    return { ok: false, reason: "suffix-mismatch" };
  }
  const cellLen = L - prefixLen - suffixLen;
  const cellText = text.slice(prefixLen, L - suffixLen);

  return {
    ok: true,
    derived: {
      cellText,
      cellLen,
      pStartUtf16: prefixLen,
      pEndUtf16: prefixLen + cellLen,
      entrySegmentId: seg?.id ?? anchor.entrySegmentId,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  S5 · derive（C4 成立的纯派生；供 memo 消费）
// ─────────────────────────────────────────────────────────────────────

/**
 * 从锚派生 cell 面（`cellText` / 段落级区间）。**前提**：调用方已跑过
 * `revalidateCellAnchor` 且 ok（C1–C5 全部通过）——本函数只做 C4 纯派生，
* 不做身份验证（身份验证的权威在 revalidate）。
 */
export function deriveCellSurfaceFromAnchor(
  anchor: CellAnchor,
  document: EditorDocument | null | undefined
): { cellText: string; pStartUtf16: number; pEndUtf16: number } | null {
  if (!document) return null;
  const text = paragraphTextOf(document, anchor.paragraphId);
  if (text == null) return null;
  const L = text.length;
  const prefixLen = anchor.prefixText.length;
  const suffixLen = anchor.suffixText.length;
  if (L < prefixLen + suffixLen) return null;
  if (text.slice(0, prefixLen) !== anchor.prefixText) return null;
  if (text.slice(L - suffixLen) !== anchor.suffixText) return null;
  const cellLen = L - prefixLen - suffixLen;
  return {
    cellText: text.slice(prefixLen, L - suffixLen),
    pStartUtf16: prefixLen,
    pEndUtf16: prefixLen + cellLen,
  };
}
