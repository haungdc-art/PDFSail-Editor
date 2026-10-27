/**
 * editing-surface-visual-geometry.ts — Reflow Step 4B-1 · **并行视觉几何通道**（纯函数）
 *
 * ── 职责（唯一）─────────────────────────────────────────────────────
 *   `CoreVisualLineGeometry[]`（4A，来自 Core layout 事实）
 *          +
 *   `EditingUnit`（logical editing structure，**只读**）
 *          ↓
 *   `EditingSurfaceVisualGeometry`（Core 驱动的视觉几何）
 *
 * ── ★ 不得违反的边界（用户裁决）────────────────────────────────────
 *   1. **绝不**把 visual lines 写回 `EditingUnit.lines`
 *      （合法状态：unit.logicalLines = 2，而 Core visual lines = 4+1 = 5）。
 *   2. **不改** UTF-16 offset / beforeinput / UnitTransaction / caret / Core History。
 *   3. 本模块**不生产** DOM，也不消费 DOM：只输出几何事实。
 *   4. P0-C（paragraph 粒度 surface 几何）**不改动**；本模块是**并行**通道。
 *
 * ── structural separator 的视觉呈现：**如实暴露，不发明**──────────
 *   `EditingUnit` 的显式 separator（`\n`）**不是 Core 概念** ⇒ Core 不给它任何几何。
 *   本模块**不猜**它该占多高、该放哪，只把paragraph 之间的视觉间隙
 *   作为 `paragraphGaps` **如实报告**，交由 4B-3/4B-4 做产品裁决。
 *   （坐标模型已冻结：separator 占 unit offset，但**不是** Core layout fact。）
 *
 * 硬边界：0 DOM / 0 React / 0 Command / 0 History / 0 Core 调用 / 0 PDFEditor；
 *   `EditingUnit` 与 `CoreVisualLineGeometry` 均**只作type-only 引用**。
 */

import type { Rect } from "../core/layout/types";
import type { EditingUnit } from "./editing-unit";
import type { CoreVisualLineGeometry } from "./core-visual-line-geometry";

// ══════════════════════════════════════════════════════════════════════
// 输出类型
// ══════════════════════════════════════════════════════════════════════

/** 一条落在 surface 上的 Core 视觉行 */
export interface SurfaceVisualLine {
  readonly visualLineKey: string;
  readonly coreLineId: string;
  readonly paragraphId: string;
  readonly textBoxId: string;
  readonly lineIndex: number;
  /** 在**所属 paragraph 内**的 UTF-16 区间（不是 unit 全局 offset） */
  readonly startInParagraphUtf16: number;
  readonly endInParagraphUtf16: number;
  readonly box: Rect;
  readonly baseline: number;
  readonly contentWidth: number;
  readonly textIndent: number;
  readonly hardBreak: boolean;
  /**
   * ★ R3 empty-line 判定：`width === 0 && height > 0` ⇒ **合法**空行。
   * （对应 C15 冻结边界：`height <= 0` / nonfinite / negative width 一律fail-closed，
   *   由本模块的 `degenerate-box` / `negative-width` 门在**构造阶段**拦截。）
   */
  readonly emptyLine: boolean;
}

/** 一个 paragraph 的视觉行分组（保持 EditingUnit 的 paragraph 粒度） */
export interface ParagraphVisualGroup {
  readonly paragraphId: string;
  readonly textBoxId: string;
  readonly lines: readonly SurfaceVisualLine[];
  /** 该 paragraph 内所有视觉行的 union bbox */
  readonly unionBox: Rect;
  /** 首行缩进（用户裁决的验证点之一） */
  readonly firstLineTextIndent: number;
  /** 该 paragraph 最深一条视觉行的 bottom */
  readonly coreBottom: number;
}

/** paragraph 之间的视觉间隙（**如实报告，不解释、不发明**） */
export interface ParagraphGap {
  readonly afterParagraphId: string;
  readonly beforeParagraphId: string;
  /** gap > 0 ⇒ 中间有视觉空白；gap < 0 ⇒ 视觉重叠（跨 TextBox 独立布局时可能） */
  readonly gapPx: number;
}

export interface EditingSurfaceVisualGeometry {
  readonly groups: readonly ParagraphVisualGroup[];
  /** 全部视觉行（按 group 顺序 + 组内 lineIndex 顺序） */
  readonly lines: readonly SurfaceVisualLine[];
  /** 全部视觉行的 union bbox（几何事实，不含任何 padding/constraint 猜测） */
  readonly unionBox: Rect;
  /** 最深一条视觉行的 bottom（= max(box.y + box.height)） */
  readonly coreBottom: number;
  /** Core 的换行约束宽度（取各 TextBox constraintBox.width 的最大值） */
  readonly constraintWidth: number;
  readonly paragraphCount: number;
  readonly visualLineCount: number;
  readonly emptyLineCount: number;
  readonly paragraphGaps: readonly ParagraphGap[];
  /**
   * ★ 视觉顺序与 logical（EditingUnit）顺序是否一致。
   * 不一致**不 fail**（跨 TextBox 独立布局可能重叠/乱序），只如实报告。
   */
  readonly visualOrderMatchesLogical: boolean;
  // ── logical 结构（**只读镜像**，绝不回写）──
  readonly logicalLineCount: number;
  readonly logicalTextLength: number;
  readonly unitId: string;
}

export type SurfaceVisualGeometryFailure =
  | "no-visual-lines"
  | "empty-unit"
  | "paragraph-set-mismatch"
  | "paragraph-not-in-unit"
  | "duplicate-visual-line-key"
  | "line-order-violation"
  | "invalid-line-range"
  | "degenerate-box"
  | "negative-width"
  | "nonfinite-box";

export type SurfaceVisualGeometryOutcome =
  | { readonly ok: true; readonly geometry: EditingSurfaceVisualGeometry }
  | { readonly ok: false; readonly reason: SurfaceVisualGeometryFailure; readonly detail: string };

export interface BuildSurfaceVisualGeometryInput {
  readonly unit: EditingUnit;
  /** 4A 的输出（Core layout 事实） */
  readonly visualLines: readonly CoreVisualLineGeometry[];
  /** 各 TextBox 的 Core 换行约束宽度（4A 的 `constraintBox.width`） */
  readonly constraintWidthByTextBox?: Readonly<Record<string, number>>;
}

// ══════════════════════════════════════════════════════════════════════
// 几何校验 + union
// ══════════════════════════════════════════════════════════════════════

function isFiniteBox(b: Rect): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function unionRect(boxes: readonly Rect[]): Rect {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.width > x1) x1 = b.x + b.width;
    if (b.y + b.height > y1) y1 = b.y + b.height;
  }
  return { x: round2(x0), y: round2(y0), width: round2(x1 - x0), height: round2(y1 - y0) };
}
const fail = (reason: SurfaceVisualGeometryFailure, detail: string): SurfaceVisualGeometryOutcome => ({
  ok: false,
  reason,
  detail,
});

/**
 * 主体：`CoreVisualLineGeometry[]` × `EditingUnit` → `EditingSurfaceVisualGeometry`。
 *
 * ★ 不写入 unit任何字段（EditingUnit 是只读输入）。
 * ★ fail-closed 只覆盖**几何非法**与**结构漂移**；视觉顺序不一致只报告。
 */
export function buildSurfaceVisualGeometry(
  input: BuildSurfaceVisualGeometryInput,
): SurfaceVisualGeometryOutcome {
  const unit = input.unit;
  if (!unit || unit.lines.length === 0) return fail("empty-unit", "EditingUnit 无 line");
  const src = input.visualLines ?? [];
  if (src.length === 0) return fail("no-visual-lines", "Core 未给出任何视觉行");

  // ── ① 几何合法性（C15 / R3 冻结边界）──
  for (const l of src) {
    const b = l.box;
    if (!isFiniteBox(b)) {
      return fail("nonfinite-box", `${l.visualLineKey} 的 box 非有限：${JSON.stringify(b)}`);
    }
    if (b.width < 0) {
      return fail("negative-width", `${l.visualLineKey} width=${b.width}`);
    }
    // R3：`width === 0 && height > 0` 是**合法 empty-line**，不得 fail。
    // height <= 0 才是退化。
    if (b.height <= 0) {
      return fail("degenerate-box", `${l.visualLineKey} height=${b.height}`);
    }
    // 区间单调（不要求相邻连续 —— soft-wrap 是 layout fact）
    if (!(l.startUtf16 >= 0 && l.startUtf16 <= l.endUtf16)) {
      return fail(
        "invalid-line-range",
        `${l.visualLineKey} 区间非法：[${l.startUtf16}, ${l.endUtf16})`,
      );
    }
  }

  // ── ② 结构一致性：视觉行的 paragraph 集合必须**恰好**等于 unit 的 line 集合 ──
  const unitParagraphIds = unit.lines.map((l) => l.paragraphId);
  const seenKeys = new Set<string>();
  const byParagraph = new Map<string, CoreVisualLineGeometry[]>();
  for (const l of src) {
    if (seenKeys.has(l.visualLineKey)) {
      return fail("duplicate-visual-line-key", `重复 visualLineKey=${l.visualLineKey}`);
    }
    seenKeys.add(l.visualLineKey);
    const arr = byParagraph.get(l.paragraphId);
    if (arr) arr.push(l);
    else byParagraph.set(l.paragraphId, [l]);
  }
  for (const pid of byParagraph.keys()) {
    if (!unitParagraphIds.includes(pid)) {
      return fail("paragraph-not-in-unit", `Core 视觉行引用了不在 unit 内的 paragraph=${pid}`);
    }
  }
  for (const pid of unitParagraphIds) {
    if (!byParagraph.has(pid)) {
      return fail("paragraph-set-mismatch", `unit 的 paragraph=${pid} 没有任何 Core 视觉行`);
    }
  }

  // ── ③ 组内顺序 + 组装（严格按 **EditingUnit 的 paragraph 顺序**）──
  const groups: ParagraphVisualGroup[] = [];
  const lines: SurfaceVisualLine[] = [];
  for (const unitLine of unit.lines) {
    const arr = byParagraph.get(unitLine.paragraphId)!;
    const ordered = [...arr].sort((a, b) => a.lineIndex - b.lineIndex);
    for (let i = 1; i < ordered.length; i++) {
      if (ordered[i]!.lineIndex <= ordered[i - 1]!.lineIndex) {
        return fail("line-order-violation", `paragraph=${unitLine.paragraphId} lineIndex 非递增`);
      }
    }
    const mapped: SurfaceVisualLine[] = ordered.map((l) => ({
      visualLineKey: l.visualLineKey,
      coreLineId: l.coreLineId,
      paragraphId: l.paragraphId,
      textBoxId: l.textBoxId,
      lineIndex: l.lineIndex,
      startInParagraphUtf16: l.startUtf16,
      endInParagraphUtf16: l.endUtf16,
      box: l.box,
      baseline: l.baseline,
      contentWidth: l.contentWidth,
      textIndent: l.textIndent,
      hardBreak: l.hardBreak,
      // ★ R3：width === 0 && height > 0 ⇒ 合法空行
      emptyLine: l.box.width === 0 && l.box.height > 0,
    }));
    lines.push(...mapped);
    groups.push({
      paragraphId: unitLine.paragraphId,
      textBoxId: unitLine.textBoxId,
      lines: mapped,
      unionBox: unionRect(mapped.map((l) => l.box)),
      firstLineTextIndent: mapped[0]!.textIndent,
      coreBottom: round2(Math.max(...mapped.map((l) => l.box.y + l.box.height))),
    });
  }

  // ── ④ constraintWidth（Core 换行约束）：取各 TextBox 最大值 ──
  const cw = input.constraintWidthByTextBox ?? {};
  const constraintWidth = round2(Math.max(0, ...Object.values(cw)));

  // ── ⑤ paragraph 间隙：**如实报告**（不解释、不发明 separator 几何）──
  const gaps: ParagraphGap[] = [];
  for (let i = 1; i < groups.length; i++) {
    gaps.push({
      afterParagraphId: groups[i - 1]!.paragraphId,
      beforeParagraphId: groups[i]!.paragraphId,
      gapPx: round2(groups[i]!.unionBox.y - groups[i - 1]!.coreBottom),
    });
  }

  // ── ⑥ 视觉顺序 vs logical 顺序（不一致只报告）──
  const visualOrderMatchesLogical = groups.every((g, i) => {
    if (i === 0) return true;
    return g.unionBox.y >= groups[i - 1]!.unionBox.y;
  });

  const unionBox = unionRect(lines.map((l) => l.box));
  return {
    ok: true,
    geometry: {
      groups,
      lines,
      unionBox,
      coreBottom: round2(Math.max(...lines.map((l) => l.box.y + l.box.height))),
      constraintWidth,
      paragraphCount: groups.length,
      visualLineCount: lines.length,
      emptyLineCount: lines.filter((l) => l.emptyLine).length,
      paragraphGaps: gaps,
      visualOrderMatchesLogical,
      // ── logical 只读镜像 ──
      logicalLineCount: unit.lines.length,
      logicalTextLength: unit.text.length,
      unitId: unit.unitId,
    },
  };
}