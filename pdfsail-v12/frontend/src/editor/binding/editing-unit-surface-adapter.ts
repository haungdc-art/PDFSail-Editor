/**
 * editing-unit-surface-adapter.ts — F3B-6.27 · P0-F1 · unit surface → 编辑面几何适配层（纯函数）
 *
 * ── 为什么需要适配层（用户裁决 D1 = A 的直接后果）──────────────────
 *   D1 选定**复用 P0-C 的 createEditingUnitSurface**（不新建第二套几何）。
 *   但 P0-C 的输出**不包含**既有 EditingSurfaceGeometry 语义所需的两个输入：
 *     ① 换行约束宽（TextLayout.constraintBox.width）
 *        —— 既有 4989-5006 实测：宽度必须取 TextBox.width 而非 box.width，
 *           否则浏览器换行点更早、行数变多、末行被裁（P0-SURFACE-Y 教训）。
 *     ② 与后继 Core paragraph 首行顶求交（coreBottom / clippedToNextParagraph）
 *        —— 既有 5007-5035 实测：**绝不能用 paragraphId 排除自身**
 *           （实测 layouts 的 paragraphId 与面记录的可能不同源 ⇒ height=0 ⇒ 整行被裁）。
 *   ⇒ 按用户指示「增加一个适配层，而不是修改 P0-C 的 geometry contract」，
 *     本模块只做映射，P0-C 的 createEditingUnitSurface 契约**零改动**。
 *
 * ── 本模块不做什么 ──────────────────────────────────────────────────
 *   · 不 resolve unit（D3 = C：生产不 resolve，只在显式注入时生效）
 *   · 不读 window / 不读 Core document（纯数据进，纯几何出）
 *   · 不新增几何算法：union / firstLineIndent / requiredWidth 全部来自 P0-C
 *   · 不做文本注入（文本由 PDFEditor 写入 DOM surface，store 不存文本）
 *
 * 硬边界：0 React / 0 DOM / 0 Core import / 0 Command / 0 History
 */

import type { EditingSurfaceGeometry } from "../components/core-input-visual";

export interface UnitSurfaceAdaptInput {
  /** P0-C createEditingUnitSurface(...).surface 的必需子集 */
  readonly unitSurface: {
    readonly box: { x: number; y: number; width: number; height: number };
    readonly firstLineIndent: number;
    readonly requiredWidth: number;
    readonly ownership: readonly { paragraphId: string; textBoxId: string }[];
  };
  readonly unitId: string;
  /** 换行约束宽（Core TextLayout.constraintBox.width 的最大值；0 = 未知） */
  readonly constraintWidth: number;
  /**
   * unit 之下所有候选 paragraph 顶（Core 空间 y）。
   * ★ 调用方**必须已排除 unit 自身**（用几何判定，见 pickNextParagraphTop）。
   */
  readonly candidateTops: readonly number[];
  /** unit 内行盒高度最大值（用于"下一段必须紧邻本段底边"的几何判定） */
  readonly lineHeight: number;
  /**
   * ★★ 4B-4D-3：Core **logical flow 的自然高度**（= `LogicalLinePartition.totalFlowHeight`）。
   *
   * 缺省 `undefined` ⇒ 逐字节保持既有行为（单 paragraph 面不受影响）。
   *
   * ★ 为什么在这里（而不是 `EditableTextNode`）：
   *   陈旧点在 **unit surface geometry** 这一层，而 `EditableTextNode` 的
   *   `surfaceHeight = coreBottom − alignedTop` 是**已冻结的稳定边界**，不得改。
   *   ⇒ 本层把 `coreBottom` 抬升到「至少覆盖 flow」，`EditableTextNode` 公式不变。
   *
   * ★ 坐标系纪律：本模块只工作在 **Core 空间**（`unitTop = box.y`），
   *   **不知道也不使用** `alignedTop`（那是 legacy/DOM 侧的概念）。
   *   ⇒ 抬升在 Core 空间内完成：`coreBottom = unitTop + max(baseHeight, flowHeight)`。
   *
   * ★ 只保证 `height >= flowHeight`，**不**保证覆盖 DOM `scrollHeight`。
   */
  readonly flowHeight?: number;
  /**
   * ★ 2026-10-18（用户缺陷「编辑框内行距太近」）：unit 的 **原文行距**（CSS px，
   *   与 box/left/top 同一空间）= 相邻成员行 Core 行盒 y 差（调用方从
   *   `geosForGeometry` 相邻 box.y 求差；≥2 成员才有，单成员/缺失 ⇒ 不传）。
   *
   * 两个用途（都不改 P0-C / 不改 EditableTextNode 公式）：
   *   ① 原样投递到 `EditingSurfaceGeometry.lineGap`（EditableTextNode 的 unit 面
   *      据此设 line-height + 半 leading 补偿，见该字段文档）；
   *   ② 面**高度下界**：`N × lineGap`（N = ownership.length）。
   *      行距 41.97 下两行需 83.94px，而既有 flowHeight 口径（Σ 行盒高 ≈ N×21.46）
   *      只有 66.92 ⇒ 不抬升则末行被 overflow:hidden 裁掉。
   *      ★ 与 flowHeight 同一模式：只做**下界**抬升，`clipped` 求交语义如实保留；
   *        均匀行距下抬升后 coreBottom 仍比下一行顶低（含 segment 基线对齐偏移 δ
   *        ≈ 2.55 的过覆盖），不侵入下一行。
   */
  readonly lineGap?: number;
}

export type UnitSurfaceAdaptFailure = "empty-ownership" | "invalid-box";

export type UnitSurfaceAdaptOutcome =
  | { readonly ok: true; readonly geometry: EditingSurfaceGeometry; readonly clipped: boolean }
  | { readonly ok: false; readonly reason: UnitSurfaceAdaptFailure };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 纯几何：挑出「紧随 unit 之后的那个 paragraph 顶」。
 *
 * ★ 与既有 5019-5035 的实测教训一致：
 *   - 与本段**同顶**（ty <= unitTop + 0.5）的候选跳过（自身 / 同顶兄弟段）
 *   - 候选必须紧邻 unit 底边（unitBottom - lineHeight <= ty < unitBottom）
 *   - 绝不接受调用方按 paragraphId 排除自身（实测会 height=0）
 */
export function pickNextParagraphTop(
  unitTop: number,
  unitBottom: number,
  lineHeight: number,
  candidateTops: readonly number[]
): number | null {
  let best: number | null = null;
  for (const ty of candidateTops) {
    if (!Number.isFinite(ty)) continue;
    if (ty <= unitTop + 0.5) continue;
    if (ty < unitBottom - lineHeight) continue;
    if (ty >= unitBottom) continue;
    if (best === null || ty < best) best = ty;
  }
  return best;
}

/**
 * 把 P0-C 的 unit surface 映射为既有 EditingSurfaceGeometry 形状。
 *
 * 保留的既有语义（逐条对应）：
 *   · left/top/width/height ← P0-C union box（round2）
 *   · width 下限 = max(P0-C requiredWidth, constraintWidth)
 *   · coreBottom / clippedToNextParagraph ← 与下一 Core paragraph 求交
 *   · textIndent ← P0-C firstLineIndent（悬挂缩进）
 *   · paragraphId ← unit 内首个 paragraph（兼容旧消费者；unit 身份另由 unitId/paragraphIds 表达）
 */
export function adaptUnitSurfaceToEditingGeometry(
  input: UnitSurfaceAdaptInput
): UnitSurfaceAdaptOutcome {
  const owner = input.unitSurface.ownership;
  if (!owner || owner.length === 0) return { ok: false, reason: "empty-ownership" };
  const box = input.unitSurface.box;
  if (!Number.isFinite(box.x) || !Number.isFinite(box.y) || box.width <= 0 || box.height <= 0) {
    return { ok: false, reason: "invalid-box" };
  }

  const unitTop = box.y;
  const unitBottom = box.y + box.height;
  const lineHeight = Math.max(2, input.lineHeight || 0);
  const nextTop = pickNextParagraphTop(unitTop, unitBottom, lineHeight, input.candidateTops);
  const clipped = nextTop !== null && nextTop < unitBottom;
  const bottom = clipped && nextTop !== null ? nextTop : unitBottom;
  if (bottom < unitTop) return { ok: false, reason: "invalid-box" };

  const paragraphIds = owner.map((o) => o.paragraphId);

  // ══ 4B-4D-3：Core logical flow 高度（unit 面必须**至少**覆盖它）═══════════
  //   背景（审计实证）：P0-C 只取每个 paragraph 的 `lines[0]` ⇒ 面高度与
  //   「paragraph 折成几行」无关；再经 `pickNextParagraphTop` 求交后被裁到
  //   **unit 内第二个 paragraph 的顶**（实测 406.12）⇒ 高度恒 44.52px。
  //   ⇒ 这里用 flow 高度做**下界**抬升。
  //
  //   ★ 坐标系：全程 Core 空间（unitTop = box.y），**不涉及** alignedTop。
  //   ★ 只做下界：既有 `bottom`（含与下一 paragraph 求交的语义）**更大时保持原值**。
  const baseHeight = bottom - unitTop;
  const fh = Number.isFinite(input.flowHeight) ? (input.flowHeight as number) : 0;
  const flowHeight = fh > 0 ? round2(fh) : undefined;
  // ── 2026-10-18（行距修复）：按**行距**的高度下界 ──
  //   行距下界 = N × lineGap。注意**不能**减半 leading：EditableTextNode 的
  //   `surfaceHeight = coreBottom − alignedTop` 以 alignedTop 为盒顶基准，而半
  //   leading 补偿（marginTop 负值）把盒顶又上移了半个 leading ⇒ 盒实际为
  //   [alignedTop − 半leading, coreBottom − 半leading]，内容需 N × lineGap
  //   恰好等于该跨度。实测教训：减半 leading 版本 scrollH 84 > clientH 76
  //   （末行行盒底被 overflow:hidden 裁 7.7px）。
  //   alignedTop = unitTop − δ（δ ≈ 2.55，segment 基线对齐顶 vs Core 行盒顶）⇒
  //   本层在 Core 空间按 N × lineGap 抬升，DOM 侧自然多覆盖 δ（过覆盖方向安全）。
  const gapRaw = input.lineGap;
  const gap = Number.isFinite(gapRaw) && (gapRaw as number) > 0 ? (gapRaw as number) : 0;
  const pitchHeight = gap > 0 ? round2(owner.length * gap) : 0;
  const height = Math.max(baseHeight, fh > 0 ? fh : 0, pitchHeight);

  return {
    ok: true,
    clipped,
    geometry: {
      paragraphId: paragraphIds[0]!,
      coreTop: round2(unitTop),
      coreBottom: round2(unitTop + height),
      // ★ 求交语义**如实保留**：即便 flow 抬升生效，`clipped` 仍报告
      //   「Core 空间里确实存在紧随的下一 paragraph」这一**几何事实**，不改写。
      clippedToNextParagraph: clipped,
      left: round2(box.x),
      top: round2(unitTop),
      // 宽度下限 = max(P0-C requiredWidth, 换行约束宽)
      width: round2(Math.max(input.unitSurface.requiredWidth, input.constraintWidth || 0, box.width)),
      height: round2(height),
      textIndent: round2(input.unitSurface.firstLineIndent),
      unitId: input.unitId,
      paragraphIds,
      flowHeight,
      lineGap: gap > 0 ? round2(gap) : undefined,
    },
  };
}
/**
 * ── P0-F1 · 显式注入入口（**harness only**）──────────────────────────
 * ★★ D3 = C（用户裁决）：**生产不 resolve multi-paragraph unit**。
 *   本函数是**唯一**的 unit 来源，且：
 *     · 缺省 `window.__f1EditingUnit === undefined` ⇒ 返回 null
 *       ⇒ 生产行为**逐字节不变**（G5 / F1.9）
 *     · 注入内容**只有身份**（unitId + paragraphIds），**没有文本**
 *       ⇒ 文本真值仍由 Core 段落文本经 P0-A `buildEditingUnit` 派生，
 *         不存在"配置文本"成为第二套真值的可能
 *     · **不做任何检测**：不猜「哪些 paragraph 属于同一 unit」，
 *         不使用同 block / 连续 lineIdx 等 heuristic
 *
 * 注入形状（测试用）：
 *   window.__f1EditingUnit = { unitId: string; paragraphIds: string[]; separator?: string }
 */
export interface ExplicitEditingUnit {
  readonly unitId: string;
  readonly paragraphIds: readonly string[];
  readonly separator: string;
}

export const EXPLICIT_UNIT_FLAG = "__f1EditingUnit";

/** 读显式注入；任何不合法形状 ⇒ null（fail-closed，不猜、不补默认值） */
export function readExplicitEditingUnit(): ExplicitEditingUnit | null {
  if (typeof window === "undefined") return null;
  const raw = (window as unknown as Record<string, unknown>)[EXPLICIT_UNIT_FLAG];
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { unitId?: unknown; paragraphIds?: unknown; separator?: unknown };
  if (typeof o.unitId !== "string" || !o.unitId) return null;
  if (!Array.isArray(o.paragraphIds) || o.paragraphIds.length < 2) return null;
  const ids: string[] = [];
  for (const p of o.paragraphIds) {
    if (typeof p !== "string" || !p) return null;
    if (ids.includes(p)) return null;
    ids.push(p);
  }
  const sep = o.separator === undefined ? "\n" : o.separator;
  if (typeof sep !== "string" || sep.length === 0) return null;
  return { unitId: o.unitId, paragraphIds: ids, separator: sep };
}