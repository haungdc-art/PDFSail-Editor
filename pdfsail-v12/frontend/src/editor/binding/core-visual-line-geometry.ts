/**
 * core-visual-line-geometry.ts — Reflow Step 4A · **并行视觉几何通道**（纯函数）
 *
 * ── 职责（唯一）─────────────────────────────────────────────────────
 *   Core `TextLayout` + paragraph identity
 *          ↓
 *   `CoreVisualLineGeometry[]`（visual-line 粒度的几何）
 *
 * ── 为什么是「并行通道」而不是扩展 P0-C ─────────────────────────────
 *   P0-C（`editing-unit-surface.ts`）是 **paragraph 粒度**的 editing surface 几何，
 *   其源码注释已明确把软折行划为「另一域，不要混用」；P0-A 不变量 I2 要求
 *   `paragraphId` 唯一 ⇒ `EditingUnit.lines` 的粒度**永远**是 paragraph。
 *   本模块**不改** EditingUnit、不改 P0-C，只提供一条并行的 visual-line 几何通道。
 *
 * ── 身份纪律：不创造第二套 visual-line identity ─────────────────────
 *   `CoreVisualLineGeometry` **extends** 已冻结的 `ReflowedVisualLine`（P0-E2-A），
 *   字段口径、`visualLineKey`（`${paragraphId}#L${i}`）、`textIndent`（相对段落左边界）
 *   **逐字节沿用** P0-E2-A 的算法，不重写。
 *   ★ 防漂移保证：契约测试断言本模块输出与 `reflowAfterMutation`（P0-E2-A）
 *     对**同一份真实数据**的 `visualLines` **完全相等**。
 *
 * ── ★ 与 P0-E2-A 的一处**有意分歧**（必须显式记录）────────────────────
 *   P0-E2-A（rebind 用途）要求 visual lines **无缝覆盖**整段：
 *   `line.textStart !== cursor` ⇒ `non-contiguous-visual-lines`（fail-closed）。
 *   本模块（几何投影用途）**不因此 fail**，只**如实报告** `contiguous`：
 *   理由：soft-wrap 是 layout fact；`line[i].textEnd → line[i+1].textStart` 之间的
 *   任何间隙都**不得**被解释成新的文本 separator（P0-E2-B 坐标模型已冻结）。
 *   「映射是否合法」由 rebind 判定；「几何事实是什么」由本模块如实呈现。
 *
 * 硬边界：0 DOM / 0 React / 0 Command / 0 History / 0 Core 调用 / 0 PDFEditor；
 *   不构造、不修改、不读取任何 EditingUnit。
 */

import type { LineLayout, ParagraphLayout, Rect, TextLayout } from "../core/layout/types";
import type { ReflowedVisualLine } from "./reflowed-paragraph";

// ══════════════════════════════════════════════════════════════════════
// 逐字节镜像 P0-E2-A 的两个私有辅助函数（那边未导出，只能镜像）
// ★ 由契约测试断言「本模块 === reflowAfterMutation 的 visualLines」来防漂移。
// ══════════════════════════════════════════════════════════════════════
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function rectOf(r: Rect): Rect {
  return { x: round2(r.x), y: round2(r.y), width: round2(r.width), height: round2(r.height) };
}

// ══════════════════════════════════════════════════════════════════════
// 输出类型：**扩展**已冻结的 ReflowedVisualLine，不重造字段
// ══════════════════════════════════════════════════════════════════════

/**
 * 一条 Core 视觉行的几何。
 * ★ 前 9 个字段全部来自 `ReflowedVisualLine`（P0-E2-A 冻结口径），本模块只**追加**
 *   三个**定位用**字段（不属于坐标模型，只是让调用方不必回查父级）。
 */
export interface CoreVisualLineGeometry extends ReflowedVisualLine {
  /** 所属 structural paragraph（structural identity） */
  readonly paragraphId: string;
  /** 所属 TextBox */
  readonly textBoxId: string;
  /** 在所属 paragraph 内的视觉行序号（0-based） */
  readonly lineIndex: number;
  /**
   * 本行与**上一行**是否首尾相接（`line[i].textStart === line[i-1].textEnd`）。
   * 首行恒为 true。★ **false 只报告、不 fail**：间隙是 layout fact，不得当 separator。
   */
  readonly contiguousWithPrevious: boolean;
}

/** 一个 paragraph 的视觉行投影结果 */
export interface CoreVisualLinesOfParagraph {
  readonly paragraphId: string;
  readonly textBoxId: string;
  readonly lines: readonly CoreVisualLineGeometry[];
  /** 视觉行是否无缝覆盖该 paragraph 全文（= P0-E2-A 的 non-contiguous 判定，只报告） */
  readonly contiguous: boolean;
  /** visual lines 覆盖的 UTF-16 长度（各行区间长度之和） */
  readonly coveredUtf16: number;
  /** 所属 paragraph 的布局矩形（Core 几何真值） */
  readonly paragraphBox: Rect;
  /**
   * 所属 TextBox 的布局约束矩形（Core 的**换行约束宽度**真值）。
   * ★ Step 2 审计里「Core 的换行宽度不可得」的那一项，其真值就在这里
   *   （属于 TextLayout 级事实，故由主入口注入，见 projectCoreVisualLines）。
   */
  readonly constraintBox: Rect;
}

export type CoreVisualLineFailure =
  | "no-layouts"
  | "paragraph-not-found"
  | "duplicate-paragraph"
  | "no-visual-lines";

export type CoreVisualLineOutcome =
  | {
      readonly ok: true;
      readonly paragraphs: readonly CoreVisualLinesOfParagraph[];
      /**扁平后的全部视觉行（跨 paragraph，按 paragraph 出现顺序） */
      readonly lines: readonly CoreVisualLineGeometry[];
      readonly totalLineCount: number;
    }
  | { readonly ok: false; readonly reason: CoreVisualLineFailure; readonly paragraphId: string | null };

export interface ProjectCoreVisualLinesInput {
  /** Core 渲染源持有的 `TextLayout[]`（`coreRenderSource.layouts`，未经裁剪） */
  readonly layouts: readonly TextLayout[];
  /** 只投影这些 paragraph（structural identity）。缺省 = 全部。 */
  readonly paragraphIds?: readonly string[];
}

// ══════════════════════════════════════════════════════════════════════

/**
 * 核心投影：**单个** paragraph 的 `LineLayout[]` → `CoreVisualLineGeometry[]`。
 * 导出以便测试与将来的增量消费；不含任何跨 paragraph 逻辑。
 */
export function projectParagraphVisualLines(args: {
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly paragraph: ParagraphLayout;
  readonly constraintBox?: Rect;
}): CoreVisualLinesOfParagraph {
  const { textBoxId, paragraphId, paragraph } = args;
  const raw: readonly LineLayout[] = paragraph.lines ?? [];
  // paragraphLeft = 各视觉行 box.x 的最小值（P0-E2-A 口径：悬挂缩进基准）
  const paragraphLeft = raw.length > 0 ? Math.min(...raw.map((l) => l.box.x)) : 0;

  let cursor = 0;
  let contiguous = true;
  const lines: CoreVisualLineGeometry[] = raw.map((l, index) => {
    const isContiguous = index === 0 ? true : l.textStart === cursor;
    if (!isContiguous) contiguous = false;
    cursor = l.textEnd;
    return {
      // ★ 与 P0-E2-A 逐字节同构
      visualLineKey: `${paragraphId}#L${index}`,
      coreLineId: l.lineId,
      startUtf16: l.textStart,
      endUtf16: l.textEnd,
      box: rectOf(l.box),
      baseline: l.baseline,
      contentWidth: l.contentWidth,
      hardBreak: l.hardBreak,
      textIndent: round2(l.box.x - paragraphLeft),
      // ── 本模块追加的定位字段 ──
      paragraphId,
      textBoxId,
      lineIndex: index,
      contiguousWithPrevious: isContiguous,
    };
  });

  const coveredUtf16 = lines.reduce((s, l) => s + (l.endUtf16 - l.startUtf16), 0);
  return {
    paragraphId,
    textBoxId,
    lines,
    contiguous,
    coveredUtf16,
    paragraphBox: rectOf(paragraph.box),
    constraintBox: rectOf(args.constraintBox ?? paragraph.box),
  };
}

/**
 * 主入口：把 `TextLayout[]` 中指定 paragraph 的完整 `LineLayout[]` 投影为视觉行几何。
 *
 * ★ fail-closed 只覆盖**结构性缺失**（找不到 paragraph / 重复 / 无视觉行）；
 *   区间不连续 **不 fail**，只报告（见文件头「与 P0-E2-A 的有意分歧」）。
 */
export function projectCoreVisualLines(
  input: ProjectCoreVisualLinesInput,
): CoreVisualLineOutcome {
  if (!input.layouts || input.layouts.length === 0) {
    return { ok: false, reason: "no-layouts", paragraphId: null };
  }
  const wanted = input.paragraphIds;
  const paragraphs: CoreVisualLinesOfParagraph[] = [];
  const flat: CoreVisualLineGeometry[] = [];
  const seen = new Set<string>();

  for (const layout of input.layouts) {
    for (const paragraph of layout.paragraphs ?? []) {
      const pid = paragraph.paragraphId;
      if (wanted && !wanted.includes(pid)) continue;
      if (seen.has(pid)) {
        return { ok: false, reason: "duplicate-paragraph", paragraphId: pid };
      }
      seen.add(pid);
      const projected = projectParagraphVisualLines({
        textBoxId: layout.textBoxId,
        paragraphId: pid,
        paragraph,
        // ★ TextLayout 级的换行约束（Core layout 的真实换行宽度来源）
        constraintBox: layout.constraintBox,
      });
      if (projected.lines.length === 0) {
        return { ok: false, reason: "no-visual-lines", paragraphId: pid };
      }
      paragraphs.push(projected);
      flat.push(...projected.lines);
    }
  }

  if (wanted) {
    for (const pid of wanted) {
      if (!seen.has(pid)) {
        return { ok: false, reason: "paragraph-not-found", paragraphId: pid };
      }
    }
  }
  if (paragraphs.length === 0) {
    return { ok: false, reason: "paragraph-not-found", paragraphId: wanted?.[0] ?? null };
  }

  return {
    ok: true,
    paragraphs,
    lines: flat,
    totalLineCount: flat.length,
  };
}