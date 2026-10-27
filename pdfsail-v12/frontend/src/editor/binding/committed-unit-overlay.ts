/**
 * committed-unit-overlay.ts — F3B-6.28 · C3：提交后受控显示层（纯函数）
 *
 * ── 定位（用户 C 阶段裁决）────────────────────────────────────────────
 *   unit 事务提交后编辑面消失 ⇒ canvas 原字回显（取证实锤：mask 只有 l5）。
 *   本模块把 **C1 受影响范围 + A 流布局** 转成提交后显示层的行清单：
 *     · unit 成员覆盖的 flow 视觉行（新文本、新位置——PDF 原始行距）
 *     · 被推进的后续行（原文不变、位置 = 原位置 + delta）
 *   渲染层（PDFEditor）把这些行画成 z>mask 的受控 overlay（白底+文本）。
 *
 * ── 定位规则（DOM 锚定）───────────────────────────────────────────────
 *   A 流布局行盒是 **import/Page 系**（unitTop = 成员行 import bbox top），
 *   与 DOM 的换算按**成员行锚定**：
 *     cssY(fl) = anchorDomY(成员行) + (fl.box.y − 该成员 flowInput top)
 *   由于 A 的行距 = 原始 PDF 行距（= import 相邻差），成员行的 import→DOM
 *   偏移对**同组行**一致 ⇒ 相对换算无漂移（l5 锚 108.36：406.03→514.39、
 *   452.83→561.19…）。
 *   displaced 行：cssY = 其自身 DOM 锚 + delta（原文不变，纯平移）。
 *
 * ── fail-closed（门槛 7）──────────────────────────────────────────────
 *   锚缺失（DOM rect 查不到）/ incomplete 项 ⇒ 该行**不渲染**且记入 skipped
 *   （调用方据此显式失败——不能只画一半然后宣称成功）。
 */

import type { AffectedScopeItem, ScopeRect } from "./affected-scope-contract";
import type { FlowLayoutResult } from "./logical-paragraph-flow-layout";
import { MASK_INK_PADDING, calculateReconciliationGeometry } from "./reconciliation-geometry";

/** 提交后显示层的一行（DOM CSS 坐标） */
export interface OverlayLine {
  readonly text: string;
  readonly cssX: number;
  readonly cssY: number;
  readonly cssW: number;
  readonly cssH: number;
  /** 来源（可追溯：unit 成员行或被推进行） */
  readonly sourceLineId: string;
  readonly role: "unit-member" | "displaced-successor";
}

export interface CommittedOverlayPlan {
  readonly ok: true;
  readonly lines: readonly OverlayLine[];
  /** 被跳过的行（锚缺失等）——调用方必须显式失败，不得静默少画 */
  readonly skipped: readonly string[];
}

export type CommittedOverlayFailure =
  | { readonly ok: false; readonly reason: "flow-not-ok"; readonly detail: string }
  | { readonly ok: false; readonly reason: "no-anchor"; readonly detail: string };

export interface OverlayAnchor {
  /** 成员行 / 被推进行的 DOM 锚（canvas 原字或 segment 的 getBoundingClientRect） */
  readonly rect: { x: number; y: number; width: number; height: number };
  /** 该行在流布局输入中的 top（import/Page 系；用于相对换算） */
  readonly flowInputTop: number;
  /** 该行在流布局输入中的 x */
  readonly flowInputX: number;
}

export type OverlayAnchorLookup = (sourceId: string) => OverlayAnchor | null;

/**
 * 计算提交后显示层的行清单。
 *
 * @param flow    A 流布局结果（提交时快照；必须 ok）
 * @param scope   C1 受影响范围（同一次计算；必须 ok）
 * @param anchors 来源 id → DOM 锚 + 流输入几何（运行时查 segment/canvas rect）
 */
export function computeCommittedOverlay(
  flow: FlowLayoutResult,
  scope: { readonly ok: true; readonly items: readonly AffectedScopeItem[] },
  anchors: OverlayAnchorLookup,
): CommittedOverlayPlan | CommittedOverlayFailure {
  if (!flow.ok) return { ok: false, reason: "flow-not-ok", detail: flow.reason };
  const lines: OverlayLine[] = [];
  const skipped: string[] = [];
  if (flow.lines.length === 0) {
    return { ok: false, reason: "no-anchor", detail: "flow 无输出行" };
  }
  const first = flow.lines[0]!;

  // ── ① unit 覆盖的 flow 行：**按 flow 行遍历**（每行只渲染一次）──
  //   实测教训：按成员遍历会让"被多个成员覆盖的行"（跨行折行的行，sources 含
  //   l5+l6）被每个成员锚各渲染一次 ⇒ 同一行重复出现/位置漂移（截图"以补"重复）。
  //   锚 = 该行 **首个 source** 的成员行（行首所在成员——行的起点归属）。
  const memberIds = new Set(scope.items.filter((i) => i.role === "unit-member").map((i) => i.sourceLineId));
  for (const fl of flow.lines) {
    const firstSrc = fl.sources.find((s) => memberIds.has(s.lineId));
    if (!firstSrc) {
      skipped.push(`flow 行 ${fl.index}: 无成员来源（${fl.sources.map((s) => s.lineId).join(",") || "none"}）`);
      continue;
    }
    const anchor = anchors(firstSrc.lineId);
    if (!anchor) {
      skipped.push(`${firstSrc.lineId}: DOM 锚缺失`);
      continue;
    }
    lines.push({
      text: fl.text,
      cssX: anchor.rect.x + (fl.box.x - anchor.flowInputX),
      cssY: anchor.rect.y + (fl.box.y - anchor.flowInputTop),
      cssW: fl.box.width,
      cssH: fl.box.height,
      sourceLineId: firstSrc.lineId,
      role: "unit-member",
    });
  }

  // ── ② 被推进的后续行（原文本、纯平移）──
  for (const item of scope.items) {
    if (item.role !== "displaced-successor") continue;
    const anchor = anchors(item.sourceLineId);
    if (!anchor) {
      skipped.push(`${item.sourceLineId}: DOM 锚缺失`);
      continue;
    }
    const delta = flow.metrics.delta;
    lines.push({
      text: "", // 文本由渲染层从来源 segment 现取（原文不变）——契约只负责几何
      cssX: anchor.rect.x,
      cssY: anchor.rect.y + delta,
      cssW: anchor.rect.width,
      cssH: anchor.rect.height,
      sourceLineId: item.sourceLineId,
      role: "displaced-successor",
    });
  }

  if (lines.length === 0) {
    return { ok: false, reason: "no-anchor", detail: `无可用锚（skipped: ${skipped.join("; ") || "none"}）` };
  }
  return { ok: true, lines, skipped };
}

/** ScopeRect → 简单几何（内部辅助；未用则保留给渲染层对账） */
export function rectOf(r: ScopeRect): { x: number; y: number; width: number; height: number } {
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

// ══ F3B-6.28 · C 收尾（R1 残差修复）：提交后「清除层」纯计算 ══════════════════
//
// 取证实锤（tests/e2e/c23-audit · residual-attribution）：
//   · mask（z40）对 canvas 原墨迹覆盖完整（隐藏 span+overlay 后旧位置 0 墨迹）；
//   · 残留来自 GlyphRenderer 的 **glyph span** —— `editedLines` 命中的行 span 以
//     z50 渲染 **legacy 原文**（Core 编辑不写 legacy ⇒ 文本未变），压在 mask 之上；
//   · overlay(z45) 只盖「新位置」盒，盖不住旧位置的 span 墨迹 ⇒ 旧字回显。
//
// 修复形状（不改冻结的 glyph-renderer）：在 overlay 层为**每个受影响行**追加一块
// 「清除矩形」（白底、无文本、z 与 overlay 文本层相同、DOM 顺序在其前），
// 几何 = 该行**原始 glyph 并集 + 既有 mask padding**（复用共享 kernel，
// 与 C2 mask 同一语义来源 —— 不扩大清除范围、不做坐标猜测）。

/** 提交后清除层的一块矩形（legacy/文档坐标；调用方负责换算到视口） */
export interface CommittedClearRect {
  readonly sourceLineId: string;
  readonly rect: { x: number; y: number; width: number; height: number };
}

/** sourceId → 该行 legacy glyph（调用方从 EditableDocument 提供；缺 ⇒ 跳过并记录） */
export type ClearGlyphLookup = (
  sourceId: string,
) =>
  | readonly {
      bbox?: { x: number; y: number; width: number; height: number } | null;
      originalBBox?: { x: number; y: number; width: number; height: number } | null;
    }[]
  | null;

export interface CommittedClearPlan {
  readonly rects: readonly CommittedClearRect[];
  /** 被跳过的行（incomplete / 无 glyph）——调用方必须可观测，不得静默少清 */
  readonly skipped: readonly string[];
}

/**
 * 清除层专用 padding：以 mask padding 为基线，但 **top = 3px**。
 *
 * 实测依据（tests/e2e/c23-audit · residual-pixels，r5）：
 *   · 计划清除区内旧字残差 = 155px / 6 行，**全部**位于行盒上沿之外 1px（y=-1）
 *     —— glyph span 的字形上伸（ascent 抗锯齿）超出 glyph bbox 顶，而
 *     `MASK_INK_PADDING.top = 0`（M7.7-054 方向性语义，冻结不动，导出 mask 复用）。
 *   · T2（F3B-6.4B）实测 accent 墨迹可高出 glyph bbox 顶 3px ⇒ 上界取 3。
 *   · 本 fixture 行间空白 ≈13px（行距 27.3 − bbox 高 13.95）≫ 3px ⇒ 不侵入上一行。
 *   · 仅用于**显示层**清除矩形；mask（导出链）语义不变。
 */
const CLEAR_INK_PADDING = {
  top: 3,
  bottom: MASK_INK_PADDING.bottom,
  left: MASK_INK_PADDING.left,
  right: MASK_INK_PADDING.right,
} as const;

/**
 * 计算提交后清除层矩形（纯函数）。
 *
 * 对每个受影响行（unit 成员 + 被推进行；`incomplete` 项排除）取
 * `calculateReconciliationGeometry({ originalGlyphs })`（共享 kernel，与 C2 mask
 * 同一并集实现），再套 `CLEAR_INK_PADDING`（见上：mask padding + 上沿补足）。
 */
export function computeCommittedClearRects(
  scope: { readonly ok: true; readonly items: readonly AffectedScopeItem[] },
  glyphsOf: ClearGlyphLookup,
): CommittedClearPlan {
  const rects: CommittedClearRect[] = [];
  const skipped: string[] = [];
  for (const item of scope.items) {
    if (item.incomplete) {
      skipped.push(`${item.sourceLineId}: scope incomplete`);
      continue;
    }
    const glyphs = glyphsOf(item.sourceLineId);
    if (!glyphs || glyphs.length === 0) {
      skipped.push(`${item.sourceLineId}: 无 glyph（清除区不可计算，不猜测）`);
      continue;
    }
    const union0 = calculateReconciliationGeometry({
      originalGlyphs: glyphs.map((g) => ({
        sourceBBox: g.originalBBox ?? undefined,
        currentBBox: g.bbox ?? undefined,
      })),
    });
    if (!union0) {
      skipped.push(`${item.sourceLineId}: glyph 并集为空`);
      continue;
    }
    // 与 applyMaskPadding 同构（方向性 padding），仅 top 按 CLEAR_INK_PADDING 补足
    const union = {
      x: union0.x - CLEAR_INK_PADDING.left,
      y: union0.y - CLEAR_INK_PADDING.top,
      width: union0.width + CLEAR_INK_PADDING.left + CLEAR_INK_PADDING.right,
      height: union0.height + CLEAR_INK_PADDING.top + CLEAR_INK_PADDING.bottom,
    };
    rects.push({ sourceLineId: item.sourceLineId, rect: union });
  }
  return { rects, skipped };
}
