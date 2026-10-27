/**
 * editor/binding/table-cell-unit.ts — F3B-6.28 · S2-v1：cell 编辑单元**规划器**（纯契约）
 *
 * ── 用户裁决（2026-10-20，S2-v1 授权）────────────────────────────────────
 *   > 按以下顺序建面：
 *   >   1. `resolveSegmentCell` 唯一定位 cell；
 *   >   2. `resolveSegmentParagraphRange` 唯一定位 Core paragraph 与 run；
 *   >   3. 创建单行 cell unit（paragraphStartUtf16 = cellStartUtf16，文本 = 当前 Core
 *   >      段落对应 cell 切片，unitId 由 (lineId, cellIndex) 确定性派生）。
 *   > 任一门失败、身份不唯一或来源不一致，均回落整行编辑；禁止默认选择首格。
 *
 * ── 三门链（本模块 = 门 1..3 的组合，全部显式可测）────────────────────────
 *   门 1 `resolveSegmentCell`（S1）：区间包含唯一归属 + legacy 轴位置内容证明。
 *   门 2 `resolveSegmentParagraphRange`：segment.source glyph 区间 → Core run
 *        包含关系 ⇒ paragraphId/runId。
 *        ★ 这是**首轮接线天然 fail-closed** 的关键：Core 编辑（replace/delete/中间
 *          插入）会把行内单 run 经 `deriveRun` strip 掉 glyph 索引（helpers.ts
 *          `deleteWithinParagraph` §25）⇒ 包含关系不再成立 ⇒ 门 2 失败 ⇒ 回落整行。
 *          ⇒ S2-v1 的实际语义 = **每行首个 cell 编辑**；该行为由契约测试证明。
 *        ★ 2026-10-24（用户缺陷「第一次格编辑正确，再次进入编辑态错误」）：门 2
 *          失败且调用方传入该行 **cell 编辑台账**（`editLedger`，table-cell-edit-ledger
 *          产物）⇒ 走台账映射分支（整行重建内容证明 / pristine 内容证明，双假设
 *          均带位置校验）⇒ 同行任意格可再次 cell 编辑；证明不成立仍 fail-closed。
 *   门 3 Core 轴位置证明：`coreParagraphText.slice(cellStart, cellEnd)` 必须等于
 *        **legacy 行 glyph 的位置切片**（legacyCellText）。
 *        ★ 为什么需要：门 1 的证明只覆盖 legacy 轴（活文档被 mutateLineText 重写）；
 *          Core 轴漂移（段落文本与 import 期行文本分离）是另一回事。门 3 把「两套
 *          文本坐标一致」从推理变成**显式校验**——不一致 ⇒ `core-axis-drift` 回落，
 *          绝不静默错格（验收项 5）。
 *        ★ 它是**位置性**判据（区间锚定切片比对），不是文本搜索：不因重复列值而歧义。
 *
 * ── 文本真值纪律 ───────────────────────────────────────────────────────
 *   cellText 取 **Core 段落切片**（Core 是文本真值）；legacyCellText 只作为门 3 的
 *   期望值。两坐标系的区间在门 3 通过后**原样透传**，不重新推导。
 *   `paragraphStartUtf16` 仅表示段落内起始位置（既有语义），**不**替代 paragraph
 *   身份解析，也**不**用来修补不一致的文本来源。
 *
 * ── D2（跨 LineGroup）──────────────────────────────────────────────────
 *   本模块**只看被点 segment 所在行**的 glyph（调用方传入单行），结构上不可能跨组推断。
 *   宽间隙表格被 `groupIntoLines` 拆行后，每组自成本行 ⇒ 单组 glyph 跑 cell 检测
 *   列左界不足 ⇒ `not-table-row` ⇒ 回落（保守方案，`SegmentBuilder` 不改）。
 *
 * ── 硬边界 ─────────────────────────────────────────────────────────────
 *   纯函数：零 React / 零 DOM / 零 Command / 零 mutation / 零 indexOf / 零文本匹配。
 *   本模块**只规划**（产出 plan），不建 DOM、不执行编辑、不判提交资格。
 *   生产启用门 = `readCellUnitEditingFlag()`（2026-10-22 · C 方案：**缺省 ON**；
 *   显式 `false` / 粘性 kill-switch `localStorage "0"` ⇒ OFF；SSR 无宿主 ⇒ OFF）。
 */

import type { EditorDocument } from "../core/document/types";
import { detectTableCells } from "./table-cell-contract";
import {
  resolveSegmentCell,
  type CellResolverSegment,
  type CellResolverSegmentSource,
} from "./table-cell-resolver";
import { resolveSegmentParagraphRange } from "./segment-paragraph-range";
import { paragraphTextOf } from "./paragraph-offset-core-target";
import { glyphRangeToUtf16Range } from "../../document-model/glyph-mapping";
import type { TableCellEditRecord } from "./table-cell-edit-ledger";

// ─────────────────────────────────────────────────────────────────────
//  S1 · 类型
// ─────────────────────────────────────────────────────────────────────

/** 行 glyph 投影（char + bbox；bbox 供 cell 检测与面几何使用） */
export interface CellUnitGlyph {
  readonly char?: string;
  readonly bbox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/** cell unit 的锚身份（(lineId, cellIndex) 确定性派生 unitId 的输入） */
export interface CellUnitAnchor {
  readonly lineId: string;
  readonly blockId: string;
  readonly paragraphId: string;
  readonly cellIndex: number;
}

/** cell 编辑面几何盒（legacy glyph bbox 并集；S0 实测与 Core 行盒同空间同尺度） */
export interface CellUnitBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** 规划成功：接线层据此建单行 cell unit（本模块不建 DOM） */
export interface CellUnitPlan {
  /** 确定性 unitId：`unit:cell:${lineId}:${cellIndex}` */
  readonly unitId: string;
  readonly anchor: CellUnitAnchor;
  readonly textBoxId: string;
  readonly runId?: string;
  /** cell 在 Core paragraph 内的 UTF-16 半开区间（与段落同坐标系，原样透传） */
  readonly cellStartUtf16: number;
  readonly cellEndUtf16: number;
  /** cell 当前 Core 文本（= 段落切片；文本真值取 Core） */
  readonly cellText: string;
  /** cell 墨迹盒（null 不可能：缺失即拒绝，见 cell-geometry-unavailable） */
  readonly cellBox: CellUnitBox;
}

export type CellUnitRejectReason =
  /** 生产门被显式关闭（kill-switch / 显式 false；缺省 ON） */
  | "flag-off"
  /** 无 Core 文档 ⇒ 门 2 无从执行 */
  | "no-core-document"
  /** 门 1 reasons（S1 全量透传，语义不变） */
  | "not-table-row"
  | "missing-segment"
  | "segment-not-in-row"
  | "line-mismatch"
  | "missing-source"
  | "invalid-glyph-range"
  | "range-out-of-bounds"
  | "missing-original-anchor"
  | "stale-mapping"
  | "no-cell"
  | "spans-multiple-cells"
  | "ambiguous"
  /** 门 2：无 run 的 source glyph 区间包含该 segment（Core 编辑后被 strip 等） */
  | "paragraph-unresolved"
  /** 段落文本/TextBox 定位失败 */
  | "paragraph-text-unavailable"
  | "textbox-unresolved"
  /** 门 3：Core 轴位置证明失败（两套文本坐标不一致）⇒ 不静默错格 */
  | "core-axis-drift"
  /** cell 墨迹盒缺失（无几何不建面） */
  | "cell-geometry-unavailable";

export type CellUnitPlanOutcome =
  | { readonly ok: true; readonly plan: CellUnitPlan }
  | { readonly ok: false; readonly reason: CellUnitRejectReason };

export interface PlanCellUnitInput {
  /** 生产启用门（由调用方读 `window.__cellUnitEditing === true` 后传入） */
  readonly enabled: boolean;
  /** 被点 segment（id / source / import 期 originalText） */
  readonly segment: CellResolverSegment | null | undefined;
  /** 被点 segment 所在行的**当前**完整 glyph 序列（legacy 行） */
  readonly rowGlyphs: readonly CellUnitGlyph[];
  /** 该行全部 segment（身份成员校验；顺序不得影响结果） */
  readonly rowSegments: readonly CellResolverSegment[];
  /** Core 文档（门 2 的 run 包含关系 + 门 3 的段落文本） */
  readonly document: EditorDocument | null | undefined;
  /**
   * ★ 2026-10-24：该行的 **cell 编辑台账**记录（`table-cell-edit-ledger` 产物；
   * 调用方按 lineId 预过滤）。缺省空 ⇒ 行为逐字节不变。
   *
   * 背景（用户缺陷「第一次格编辑正确，再次进入编辑态错误」）：行的任意一次 cell
   * 事务提交后，Core `deriveRun` strip 掉 run 的 glyph 索引 ⇒ 门 2 结构性死亡 ⇒
   * 该行任何格的规划都落 `paragraph-unresolved` ⇒ 回落整行编辑面（两列拼一起）。
   * 台账在用光门 2 之后提供第二条映射路（见 ledger 分支注释）；记录陈旧（撤销）
   * 由**位置内容证明**兜底，绝不产生错误区间。
   */
  readonly editLedger?: readonly TableCellEditRecord[];
}

/** cell unitId 前缀（接线层与测试据此识别 cell 面；多行 unit 用 `unit:p…` 形态） */
export const CELL_UNIT_ID_PREFIX = "unit:cell:";

/**
 * 生产启用门（2026-10-22 · C 方案：**缺省 ON**；契约 §18 修订）。
 *
 * 背景：S2-v1 接线时按「灰度 B 方案」缺省 OFF（显式 opt-in 才建 cell 面）；
 * D1（连续输入串格）由 S2-v3 稳定锚修复且 S3 全链验收通过（T9：XYZ 全落 cell1、
 * 顺序正确）后，用户 2026-10-22 报告「点击表格某格却整行编辑」⇒ 裁定 cell 编辑
 * 为**默认编辑粒度**（本函数即该裁定的唯一落点）。
 *
 * 优先级（从高到低）：
 *   1. `window.__cellUnitEditing === false` ⇒ OFF（显式关闭；测试 / 控制台 / 自动止损）
 *   2. localStorage `__cellUnitEditing === "0"` ⇒ OFF（**粘性 kill-switch**：
 *      监测自动止损写入 ⇒ 重载后仍 OFF，直到清除）
 *   3. `window.__cellUnitEditing === true` ⇒ ON（显式启用）
 *   4. localStorage `__cellUnitEditing === "1"` ⇒ ON（旧灰度 opt-in 通道，兼容保留）
 *   5. URL `?cellUnit=1` ⇒ ON（旧灰度 URL 通道，兼容保留；每页加载缓存一次）
 *   6. 其余 ⇒ **ON（缺省：表格 cell 编辑为默认粒度）**
 *
 * 回滚 = `window.__cellUnitEditing = false`（本会话）或 localStorage "0"（跨会话
 * 粘性）；监测自动止损（cellWriteSuspect > 0）会同时写两者，无需改代码。
 * ⚠️ 本函数位于渲染热路径：URL 参数每次加载只解析一次（SPA 编辑路由内 search 不变）；
 *    localStorage 为同步微成本读取（保证 kill-switch **即时生效**，不缓存）。
 * ⚠️ storage/location 读取抛错 ⇒ OFF（保守：无法验证粘性 kill-switch 时回落既有
 *    整行编辑行为，与 S2 各门 fail-closed 同方向）。
 */
let cachedUrlSearch: string | null = null;
let cachedUrlOptIn = false;
export function readCellUnitEditingFlag(): boolean {
  if (typeof window === "undefined") return false; // SSR / Node ⇒ OFF（无宿主不建面）
  const w = window as unknown as Record<string, unknown>;
  if (w.__cellUnitEditing === false) return false; // 显式关闭（最高优先级）
  try {
    const ls = window.localStorage?.getItem("__cellUnitEditing") ?? null;
    if (ls === "0") return false; // 粘性 kill-switch（自动止损 / 手动回滚）
    if (w.__cellUnitEditing === true) return true; // 显式启用
    if (ls === "1") return true; // 旧灰度 opt-in 通道（兼容保留）
    const search = window.location?.search ?? "";
    if (cachedUrlSearch !== search) {
      cachedUrlSearch = search;
      cachedUrlOptIn = new URLSearchParams(search).get("cellUnit") === "1";
    }
    if (cachedUrlOptIn) return true; // 旧灰度 URL 通道（兼容保留）
    return true; // ★ C 方案：缺省 ON（cell 编辑为默认粒度）
  } catch {
    return false; // storage/location 不可读 ⇒ 无法验证 kill-switch ⇒ 保守回落整行
  }
}

// ─────────────────────────────────────────────────────────────────────
//  S2 · 规划原语（三门链，顺序固定；fail-closed 优先于归属）
// ─────────────────────────────────────────────────────────────────────

/** 在 Core 文档中定位段落所属 TextBox（只读遍历；找不到 ⇒ null） */
function findTextBoxIdOfParagraph(
  document: EditorDocument,
  paragraphId: string
): string | null {
  for (const page of document.pages ?? []) {
    for (const obj of page.objects ?? []) {
      if (obj.type !== "text") continue;
      for (const para of obj.paragraphs ?? []) {
        if (para?.id === paragraphId) return obj.id ?? null;
      }
    }
  }
  return null;
}

/** legacy 行 glyph 的位置切片（闭区间；与 cell 契约同口径，非文本搜索） */
function glyphSlice(
  rowGlyphs: readonly CellUnitGlyph[],
  startGlyphIndex: number,
  endGlyphIndex: number
): string {
  let s = "";
  for (let i = startGlyphIndex; i <= endGlyphIndex; i++) s += rowGlyphs[i]?.char ?? "";
  return s;
}

/**
 * **cell 编辑单元规划**（S2-v1 唯一入口）。
 *
 * 三门链全部通过 ⇒ `{ok:true, plan}`；任一失败 ⇒ `{ok:false, reason}`（调用方回落整行）。
 * 零匹配/多重/跨 cell/越界/来源不一致/Core 轴漂移**一律失败**，绝不默认首格。
 */
export function planCellUnit(input: PlanCellUnitInput): CellUnitPlanOutcome {
  // 门 0：生产启用门（缺省 ON；仅显式关闭时不尝试）
  if (!input.enabled) return { ok: false, reason: "flag-off" };

  const document = input.document;
  if (!document) return { ok: false, reason: "no-core-document" };

  const segment = input.segment;
  if (!segment || !segment.id) return { ok: false, reason: "missing-segment" };
  const source: CellResolverSegmentSource | null | undefined = segment.source;
  if (!source || !source.blockId || !source.lineId) return { ok: false, reason: "missing-source" };

  // ── D2：cell 检测只看**本行** glyph（结构上不可能跨 LineGroup 推断）──
  //   投影为 CellGlyphInput（char 必填）；bbox 原样透传供几何判据使用。
  const detection = detectTableCells(
    input.rowGlyphs.map((g) => ({ char: g.char ?? "", bbox: g.bbox })),
  );
  if (!detection.isTableRow) return { ok: false, reason: "not-table-row" };

  // ── 门 1：segment → cell 唯一归属（S1 全量 fail-closed 透传）──
  const cellRes = resolveSegmentCell({
    segment,
    rowGlyphs: input.rowGlyphs,
    rowSegments: input.rowSegments,
    cells: detection.cells.map((c) => ({
      index: c.index,
      startGlyphIndex: c.startGlyphIndex,
      endGlyphIndex: c.endGlyphIndex,
    })),
  });
  if (!cellRes.ok) return { ok: false, reason: cellRes.reason };
  const cell = cellRes.cell;

  // ── 门 2：segment → Core paragraph + run（glyph 区间包含关系）──
  //   ★ Core 编辑后行内 run 的 glyph 索引被 strip ⇒ 此处失败。S2-v1 语义 = 每行
  //     首个 cell 编辑；2026-10-24 起门 2 失败且该行有 cell 编辑台账时走台账映射
  //     （下方 ledger 分支），否则维持回落整行（既有行为逐字节不变）。
  const ledgerRecords = input.editLedger ?? [];
  const binding = resolveSegmentParagraphRange(document, { source }, input.rowGlyphs);
  if (!binding && ledgerRecords.length === 0) {
    return { ok: false, reason: "paragraph-unresolved" };
  }

  // ── 段落文本 + TextBox（Core 真值）+ cell 当前区间/文本 ──
  let planParagraphId: string;
  let planTextBoxId: string;
  let planRunId: string | undefined;
  let cellStartUtf16: number;
  let cellEndUtf16: number;
  let planCellText: string;

  if (binding) {
    // ── pristine 路径（S2-v1 既有语义，逐字节不变）──
    const coreText = paragraphTextOf(document, binding.paragraphId);
    if (coreText == null) return { ok: false, reason: "paragraph-text-unavailable" };
    const textBoxId = findTextBoxIdOfParagraph(document, binding.paragraphId);
    if (!textBoxId) return { ok: false, reason: "textbox-unresolved" };

    // ── 门 3：Core 轴位置证明（区间锚定切片比对，非文本搜索）──
    //   legacyCellText = legacy 行 glyph 在 cell 区间上的位置切片；
    //   Core 侧同区间切片必须逐字节相等 ⇒ 两套坐标在该 cell 上一致，区间才准透传。
    const legacyCellText = glyphSlice(input.rowGlyphs, cell.cellStartGlyphIndex, cell.cellEndGlyphIndex);
    if (coreText.slice(cell.cellStartUtf16, cell.cellEndUtf16) !== legacyCellText) {
      return { ok: false, reason: "core-axis-drift" };
    }
    planParagraphId = binding.paragraphId;
    planTextBoxId = textBoxId;
    planRunId = binding.runId;
    cellStartUtf16 = cell.cellStartUtf16;
    cellEndUtf16 = cell.cellEndUtf16;
    planCellText = coreText.slice(cell.cellStartUtf16, cell.cellEndUtf16);
  } else {
    // ── ledger 分支（2026-10-24 用户缺陷「同行第二次格编辑回落整行」）────────
    //   门 2 已死（run glyph 索引被 strip）+ 台账有该行记录 ⇒ 重建「当前 Core 段落
    //   文本 ↔ legacy 行文本」映射。两条假设都带**位置内容证明**（非文本搜索）：
    //   假设 1（台账）：Core 文本 === 原始行文本按台账逐格替换的整行重建
    //     （整行内容证明 —— 同时校验未记录格未被外部路径改动）；
    //   假设 2（pristine）：Core 文本 === 原始行文本（记录陈旧/编辑已全撤）⇒ 恒等映射。
    //   都不成立 ⇒ core-axis-drift（fail-closed，绝不静默错格）。
    const pidSet = new Set(ledgerRecords.map((r) => r.paragraphId));
    const foreignLine = ledgerRecords.some((r) => r.lineId !== source.lineId);
    if (pidSet.size !== 1 || foreignLine) return { ok: false, reason: "paragraph-unresolved" };
    const ledgerPid = ledgerRecords[0]!.paragraphId;
    const coreText = paragraphTextOf(document, ledgerPid);
    if (coreText == null) return { ok: false, reason: "paragraph-text-unavailable" };
    const textBoxId = findTextBoxIdOfParagraph(document, ledgerPid);
    if (!textBoxId) return { ok: false, reason: "textbox-unresolved" };

    const legacyCellText = glyphSlice(input.rowGlyphs, cell.cellStartGlyphIndex, cell.cellEndGlyphIndex);
    const rowText = input.rowGlyphs.map((g) => g.char ?? "").join("");
    // 全部检测 cell 的 legacy UTF-16 区间（唯一换算点现算；不自行累加）
    const utf16OfCellIndex = new Map<number, { start: number; len: number }>();
    for (const c of detection.cells) {
      const r = glyphRangeToUtf16Range(
        input.rowGlyphs as unknown as Parameters<typeof glyphRangeToUtf16Range>[0],
        c.startGlyphIndex,
        c.endGlyphIndex,
      );
      utf16OfCellIndex.set(c.index, { start: r.start, len: r.end - r.start });
    }

    // 假设 1：按台账重建整行（从右往左替换，避免前序偏移失效）
    let rebuilt = rowText;
    let recordsValid = true;
    const byStartDesc = [...ledgerRecords].sort(
      (a, b) => (utf16OfCellIndex.get(b.cellIndex)?.start ?? 0) - (utf16OfCellIndex.get(a.cellIndex)?.start ?? 0),
    );
    for (const rec of byStartDesc) {
      const iv = utf16OfCellIndex.get(rec.cellIndex);
      if (!iv) {
        recordsValid = false;
        break;
      }
      rebuilt = rebuilt.slice(0, iv.start) + rec.newText + rebuilt.slice(iv.start + iv.len);
    }
    if (recordsValid && rebuilt === coreText) {
      const recK = ledgerRecords.find((r) => r.cellIndex === cell.cellIndex);
      let shift = 0;
      for (const rec of ledgerRecords) {
        const iv = utf16OfCellIndex.get(rec.cellIndex);
        if (iv && iv.start < cell.cellStartUtf16) shift += rec.newText.length - iv.len;
      }
      cellStartUtf16 = cell.cellStartUtf16 + shift;
      planCellText = recK ? recK.newText : legacyCellText;
      cellEndUtf16 = cellStartUtf16 + planCellText.length;
    } else if (coreText === rowText) {
      // 假设 2：pristine（记录陈旧）⇒ 恒等映射
      cellStartUtf16 = cell.cellStartUtf16;
      cellEndUtf16 = cell.cellEndUtf16;
      planCellText = legacyCellText;
    } else {
      return { ok: false, reason: "core-axis-drift" };
    }
    planParagraphId = ledgerPid;
    planTextBoxId = textBoxId;
    planRunId = undefined;
  }

  // cell 墨迹盒（检测产物；缺失不建面）
  const detected = detection.cells.find((c) => c.index === cell.cellIndex);
  const box = detected?.bbox;
  if (!box || !(box.width > 0) || !(box.height > 0)) {
    return { ok: false, reason: "cell-geometry-unavailable" };
  }

  return {
    ok: true,
    plan: {
      unitId: `${CELL_UNIT_ID_PREFIX}${source.lineId}:${cell.cellIndex}`,
      anchor: {
        lineId: source.lineId,
        blockId: source.blockId,
        paragraphId: planParagraphId,
        cellIndex: cell.cellIndex,
      },
      textBoxId: planTextBoxId,
      runId: planRunId,
      cellStartUtf16,
      cellEndUtf16,
      // 文本真值 = Core 当前 cell 内容（pristine 路径已证等于 legacy 位置切片；
      // ledger 路径由整行重建内容证明背书）
      cellText: planCellText,
      cellBox: { x: box.x, y: box.y, width: box.width, height: box.height },
    },
  };
}
