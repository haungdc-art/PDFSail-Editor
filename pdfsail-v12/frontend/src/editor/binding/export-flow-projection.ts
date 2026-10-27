/**
 * editor/binding/export-flow-projection.ts — F3B-6.28 · D 阶段**第二步：投影契约**
 *
 * ── 定位（用户 2026-10-13 裁决：三点有条件批准）────────────────────────
 *   本模块是第二阶段「共享布局投影 + 导出重绘几何」的**纯函数契约层**：
 *     · 消费既有 `computeFlowLayout`（A 阶段）与 `computeAffectedScope`（C1）
 *     · 输出每条 flow 视觉行的：文本 / 来源 glyph / 目标 CSS 盒 / baseline
 *       / 逐字符 provenance（来源行 + 原 glyph 序号）
 *     · 输出清除集 ClearSet = UnitMembers ∪ DisplacedSuccessors
 *     · 输出位移行的 CSS 平移量（bridge 负责换算成 PDF pt）
 *
 *   **不接生产**：调用方（build-core-export-context → bridge）在后续步骤接入。
 *
 * ── 坐标口径（决策三，冻结）────────────────────────────────────────────
 *   · flow / scope / 本模块全部在 **CSS（legacy 文档）空间**，y 向下增长；
 *   · PDF 用户空间 y 向上增长；换算与 `export-renderer.cssToPdf` 完全同口径：
 *       totalScale = renderScale × cssScale
 *       pdfY = flipBase − cssY / totalScale          （flipBase = pageTopPt）
 *   · 因此「把 glyph 在 CSS 里下移 Δcss」⇒ PDF 里 **上移** Δcss/totalScale：
 *       f' = f − Δcss / totalScale
 *     （`pdfTransform[0..4]` 一律不动 ⇒ 字宽/间距/缩放不受影响）
 *
 * ── 失败纪律（决策一/二）──────────────────────────────────────────────
 *   · flow / scope 非 ok ⇒ fail-closed；
 *   · 成员行缺 glyph 数 / baseline ⇒ fail-closed（绝不猜几何）；
 *   · flow 行无来源 span ⇒ fail-closed（不可追溯 = 不可重绘）；
 *   · totalScale 非正/非有限 ⇒ fail-closed；
 *   · **绝不**在此层做字体选择或字符编码决策（那是 bridge/renderer 的职责）。
 */

import type { FlowLayoutResult } from "./logical-paragraph-flow-layout";
import type { AffectedScope, AffectedScopeFailure } from "./affected-scope-contract";

// ─────────────────────────────────────────────────────────────────────
//  输出类型
// ─────────────────────────────────────────────────────────────────────

/** 一个字符的重绘 provenance（CSS 空间） */
export interface ExportFlowGlyph {
  readonly char: string;
  /** 行盒左缘起的累计 x（CSS px） */
  readonly cssX: number;
  readonly cssAdvance: number;
  /** 来源原始行（unit 成员 lineId） */
  readonly sourceLineId: string;
  /**
   * 来源原始行内的 **glyph 序号**；null = 新增字符（原行没有对应 glyph ⇒ 无原字体/编码）。
   * ★ D-3B-6：只允许来自 `sourceIdentityOf` 的已验证身份（经 glyph 长度换算），
   *   禁止按当前文本位置直接赋值。
   */
  readonly sourceGlyphIndex: number | null;
}

/** 一条 flow 视觉行的重绘指令 */
export interface ExportFlowRedrawLine {
  readonly index: number;
  readonly text: string;
  /** 目标 CSS 盒（flow 布局产出；行距 = 原始 PDF 行距，见 flow 模块冻结规则） */
  readonly cssBox: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** 目标 baseline（CSS px）= unit 首成员行原 baseline + index × usedLineGap（与 flow box 同锚，见 D-3A 修复说明） */
  readonly baselineCssY: number;
  readonly glyphs: readonly ExportFlowGlyph[];
  /** 该行文本的来源成员行（可追溯；≥1） */
  readonly sourceLineIds: readonly string[];
  /** true = 该行全部字符都来自同一个未跨行的原成员行（几何可直接继承原行） */
  readonly intact: boolean;
}

export interface ExportFlowProjection {
  readonly ok: true;
  readonly redrawLines: readonly ExportFlowRedrawLine[];
  /** ClearSet = UnitMembers ∪ DisplacedSuccessors（原算子必须被剥离的行） */
  readonly clearLineIds: readonly string[];
  /** 位移行（被流推进的后续行） */
  readonly displacedLineIds: readonly string[];
  /** 位移量（CSS px，向下为正）；无位移 = 0 */
  readonly deltaCss: number;
  /** 流布局自带的 lineGap（CSS px）——重绘行距与位移量共用同一真值 */
  readonly usedLineGap: number;
  readonly warnings: readonly string[];
  /** 被跳过的对象（incomplete 等）——调用方必须可观测，不得静默少画 */
  readonly skipped: readonly string[];
}

export type ExportFlowProjectionFailure =
  | { readonly ok: false; readonly reason: "flow-not-ok"; readonly detail: string }
  | { readonly ok: false; readonly reason: "scope-not-ok"; readonly detail: string }
  | { readonly ok: false; readonly reason: "invalid-total-scale"; readonly detail: string }
  | { readonly ok: false; readonly reason: "missing-source-glyphs"; readonly detail: string }
  | { readonly ok: false; readonly reason: "missing-source-identity"; readonly detail: string }
  | { readonly ok: false; readonly reason: "missing-source-baseline"; readonly detail: string }
  | { readonly ok: false; readonly reason: "untraceable-flow-line"; readonly detail: string };

// ─────────────────────────────────────────────────────────────────────
//  输入
// ─────────────────────────────────────────────────────────────────────

export interface ExportFlowProjectionInput {
  readonly flow: FlowLayoutResult;
  /** C1 受影响范围（含 unit-member / displaced-successor 与 legacy lineId） */
  readonly scope: AffectedScope | AffectedScopeFailure;
  /**
   * D-3B-6：成员行 → **字符身份映射**（`diffedIdentityByCodepoint` 的产物）：
   * 编辑后文本第 k 个**码点** → 原文本码点下标；`null` = 新增字符。
   *
   * ★ 这是 `sourceGlyphIndex` 的**唯一**合法来源。缺 ⇒ fail-closed
   *   （`missing-source-identity`）——绝不退化为「按当前位置取原 glyph」，
   *   那会在中间插入时把新字符画成原文邻字（D-3B-6 步骤 5 实测根因）。
   */
  readonly sourceIdentityOf: (lineId: string) => readonly (number | null)[] | null;
  /**
   * 成员行 → 该行**原始** glyph 数组的码元长度（[...g.char].length）；缺 ⇒ fail-closed。
   * D-3B-6 起职责收窄为**纯位置换算**（原码点 → 原 glyph 序号）；
   * 字符**身份**一律由 `sourceIdentityOf` 提供，本输入不再暗示身份。
   */
  readonly sourceGlyphLengthsOf: (lineId: string) => readonly number[] | null;
  /** 成员行 → 原始 baseline（CSS px）；缺 ⇒ fail-closed */
  readonly sourceBaselineOf: (lineId: string) => number | null;
  /**
   * 成员行 → 逐**码元** advance（CSS px；**当前（编辑后）文本**的 advance，
   * 与 `FlowLineInput.advances` 同口径、同数组——flow 布局就是用它们断行的）。
   * 缺 ⇒ fail-closed。
   * ⚠️ 与 `sourceGlyphLengthsOf` 是两份不同数据：前者是「现在的排版事实」，
   *    后者是「原始 glyph 归属」（用于逐字符 provenance）；不可混用。
   */
  readonly sourceAdvancesOf: (lineId: string) => readonly number[] | null;
  /** renderScale × cssScale（与 export-renderer.cssToPdf 同口径；仅用于校验/记录） */
  readonly totalScale: number;
}

// ─────────────────────────────────────────────────────────────────────
//  坐标换算（决策三：bridge 负责 pt 平移；此处给出唯一实现与自校验）
// ─────────────────────────────────────────────────────────────────────

/** CSS 垂直位移量 → PDF 垂直位移量（正值 = CSS 下移 = PDF 上移） */
export function cssDeltaToPdfDelta(deltaCss: number, totalScale: number): number {
  if (!Number.isFinite(deltaCss) || !Number.isFinite(totalScale) || !(totalScale > 0)) {
    throw new Error(`cssDeltaToPdfDelta: 非法参数 deltaCss=${deltaCss} totalScale=${totalScale}`);
  }
  return deltaCss / totalScale;
}

/**
 * CSS baseline → PDF baseline（与 `export-renderer.cssToPdf` 的翻转分量同口径）。
 * 供测试与 bridge 交叉校验用；**不替代** cssToPdf（盒换算仍走渲染器）。
 */
export function cssBaselineToPdfBaseline(
  cssBaseline: number,
  flipBase: number,
  totalScale: number,
): number {
  if (
    !Number.isFinite(cssBaseline) ||
    !Number.isFinite(flipBase) ||
    !Number.isFinite(totalScale) ||
    !(totalScale > 0)
  ) {
    throw new Error("cssBaselineToPdfBaseline: 非法参数");
  }
  return flipBase - cssBaseline / totalScale;
}

export type TransformShiftResult =
  | { readonly ok: true; readonly transform: [number, number, number, number, number, number] }
  | { readonly ok: false; readonly reason: string };

/**
 * 把 raw-CID 的 `pdfTransform` 按 CSS 垂直位移量平移。
 *
 * 契约（决策三）：
 *   · 只改 `f`（y）：`f' = f − Δcss / totalScale`；
 *   · `a b c d e` **一律原样返回**（字宽/间距/缩放/首字符 x 不变）；
 *   · 输入非法 ⇒ fail-closed（调用方不得静默用原值）。
 */
export function shiftPdfTransformY(
  transform: readonly number[] | undefined | null,
  deltaCss: number,
  totalScale: number,
): TransformShiftResult {
  if (!transform || transform.length < 6) {
    return { ok: false, reason: `pdfTransform 缺失或长度不足（${transform ? transform.length : 0}）` };
  }
  const nums = transform.slice(0, 6);
  if (!nums.every((n) => Number.isFinite(n))) {
    return { ok: false, reason: "pdfTransform 含非有限值" };
  }
  if (!Number.isFinite(deltaCss)) return { ok: false, reason: `deltaCss 非有限（${deltaCss}）` };
  if (!Number.isFinite(totalScale) || !(totalScale > 0)) {
    return { ok: false, reason: `totalScale 非法（${totalScale}）` };
  }
  const dy = cssDeltaToPdfDelta(deltaCss, totalScale);
  return {
    ok: true,
    transform: [nums[0]!, nums[1]!, nums[2]!, nums[3]!, nums[4]!, nums[5]! - dy],
  };
}

// ─────────────────────────────────────────────────────────────────────
//  投影
// ─────────────────────────────────────────────────────────────────────

/** 码元 offset → glyph 序号（任一码元落在某 glyph 内即归属该 glyph；越界 ⇒ null） */
function codepointIndexToGlyphIndex(
  glyphLengths: readonly number[],
  codepointIndex: number,
): number | null {
  let acc = 0;
  for (let i = 0; i < glyphLengths.length; i += 1) {
    const len = glyphLengths[i]!;
    if (codepointIndex < acc + len) return i;
    acc += len;
  }
  return null;
}

export function computeExportFlowProjection(
  input: ExportFlowProjectionInput,
): ExportFlowProjection | ExportFlowProjectionFailure {
  const { flow, scope } = input;
  if (!flow.ok) {
    return { ok: false, reason: "flow-not-ok", detail: `${flow.reason}: ${flow.detail}` };
  }
  if (!scope.ok) {
    return { ok: false, reason: "scope-not-ok", detail: `${scope.reason}: ${scope.detail}` };
  }
  if (!Number.isFinite(input.totalScale) || !(input.totalScale > 0)) {
    return {
      ok: false,
      reason: "invalid-total-scale",
      detail: `totalScale=${input.totalScale}（必须 > 0 且有限；与 cssToPdf 同口径）`,
    };
  }

  const skipped: string[] = [];
  for (const item of scope.items) {
    if (item.incomplete) skipped.push(`${item.sourceLineId}: scope incomplete（${item.detail}）`);
  }

  // ── ClearSet = UnitMembers ∪ DisplacedSuccessors（决策二） ──
  //   行身份的唯一来源 = `scope.items[].sourceLineId`（C1 已把 flow 的 displaced 项
  //   映射回 legacy lineId）。`flow.displaced` 只有 Core id（textBoxId/paragraphId），
  //   在此层无法可靠反查 lineId ⇒ 不作为第二来源（避免猜身份）。
  const clearSet = new Set<string>();
  const displacedSet = new Set<string>();
  for (const item of scope.items) {
    if (item.role === "unit-member") clearSet.add(item.sourceLineId);
    else if (item.role === "displaced-successor") {
      clearSet.add(item.sourceLineId);
      displacedSet.add(item.sourceLineId);
    }
  }

  // ── 成员行原 glyph 长度 / baseline / advances（重绘 provenance 的来源） ──
  const glyphLengths = new Map<string, readonly number[]>();
  const baselines = new Map<string, number>();
  const advancesOf = new Map<string, readonly number[]>();
  const memberIds = new Set(
    scope.items.filter((i) => i.role === "unit-member").map((i) => i.sourceLineId),
  );
  for (const lineId of memberIds) {
    const lens = input.sourceGlyphLengthsOf(lineId);
    if (!lens || lens.length === 0) {
      return {
        ok: false,
        reason: "missing-source-glyphs",
        detail: `成员行 ${lineId} 无原始 glyph 长度信息（无法建立逐字符 provenance ⇒ 不重绘）`,
      };
    }
    glyphLengths.set(lineId, lens);
    const adv = input.sourceAdvancesOf(lineId);
    if (!adv || adv.length === 0) {
      return {
        ok: false,
        reason: "missing-source-glyphs",
        detail: `成员行 ${lineId} 无逐码元 advance（无法定位重绘字符 ⇒ 不重绘）`,
      };
    }
    advancesOf.set(lineId, adv);
    const bl = input.sourceBaselineOf(lineId);
    if (bl === null || !Number.isFinite(bl)) {
      return {
        ok: false,
        reason: "missing-source-baseline",
        detail: `成员行 ${lineId} 无原始 baseline（CSS）⇒ 无法定位重绘基线`,
      };
    }
    baselines.set(lineId, bl);
  }

  // ── 每个来源成员行的**聚合基准**（其第一个 span 的 textStart） ──
  //   `span.textStart/textEnd` 是聚合文本偏移；行内偏移必须相对「该来源行自己的
  //   聚合基准」计算，不能相对 span 起点（否则跨行的来源会被算成 0 —— 实测踩坑）。
  const srcBase = new Map<string, number>();
  for (const fl of flow.lines) {
    for (const s of fl.sources) {
      const cur = srcBase.get(s.lineId);
      if (cur === undefined || s.textStart < cur) srcBase.set(s.lineId, s.textStart);
    }
  }

  // ── 逐 flow 行构造重绘指令 ──
  const usedLineGap = flow.metrics.usedLineGap;
  // D-3A：行节奏锚点 = flow 行 0 的首来源 baseline（聚合文本从 unit 首成员行开始，
  //        故行 0 的首来源 = unit 首成员行；与 flow box 的 unitTop 锚一致）。
  const anchorBaseline: number | null =
    flow.lines.length > 0 && flow.lines[0]!.sources.length > 0
      ? baselines.get(flow.lines[0]!.sources[0]!.lineId) ?? null
      : null;
  const redrawLines: ExportFlowRedrawLine[] = [];

  for (const fl of flow.lines) {
    if (fl.sources.length === 0) {
      return {
        ok: false,
        reason: "untraceable-flow-line",
        detail: `flow 行 ${fl.index} 无来源 span（不可追溯 ⇒ 不可重绘）`,
      };
    }
    const firstSrc = fl.sources[0]!;
    if (!baselines.has(firstSrc.lineId)) {
      return {
        ok: false,
        reason: "missing-source-baseline",
        detail: `flow 行 ${fl.index} 的首来源 ${firstSrc.lineId} 不是 unit 成员行（无 baseline）`,
      };
    }
    // 行内基线（D-3A 修复 · 真实样本对照发现）：
    //   锚点必须是 **unit 首成员行**的 baseline（= flow 行 0 的首来源），
    //   而不是「该 flow 行自己的首来源」。理由：flow 布局的行节奏是
    //   `unitTop + index × usedLineGap`（flow 模块冻结规则，box 同锚）；
    //   续行的首来源可能是后面的成员行（如追加文本使 l6 的尾部独占一行），
    //   若按该行的首来源锚定，续行 baseline 会整体下移（成员行数−1）× 行距，
    //   与 flow box 脱节（gd-swim 实测：末行 baseline 466.128，正确 497.329）。
    //   行距仍用成员行实测间距（冻结规则），不引入第二套行距。
    if (anchorBaseline === null) {
      return {
        ok: false,
        reason: "missing-source-baseline",
        detail: "flow 行 0 无首来源 baseline（无法锚定 unit 行节奏）",
      };
    }
    const baselineCssY = anchorBaseline + fl.index * usedLineGap;

    // 逐字符：聚合 offset → 来源 span → 成员行内码元 offset → 原 glyph 序号
    //   ⚠️ `fl.sources` 的 textStart/textEnd 是**聚合文本**偏移（flow 输入所有成员行
    //      拼接后的坐标），不是行内偏移。该行的聚合基准 = 其 span 的最小 textStart。
    //   advance 取**来源行的真实逐码元 advance**（flow 断行用的就是它）⇒ 行内 x 与
    //      flow 行宽自洽（sum(advances) === fl.width），不会出现平均化错位。
    const aggBase = Math.min(...fl.sources.map((s) => s.textStart));
    if (!Number.isFinite(aggBase)) {
      return {
        ok: false,
        reason: "untraceable-flow-line",
        detail: `flow 行 ${fl.index} 的 span 起点非有限`,
      };
    }
    const glyphs: ExportFlowGlyph[] = [];
    let penX = fl.box.x;
    for (let local = 0; local < fl.text.length; local += 1) {
      const ch = fl.text[local]!;
      const aggStart = aggBase + local;
      const span = fl.sources.find((s) => aggStart >= s.textStart && aggStart < s.textEnd);
      if (!span) {
        return {
          ok: false,
          reason: "untraceable-flow-line",
          detail: `flow 行 ${fl.index} offset ${aggStart} 无来源 span（sources=${JSON.stringify(fl.sources)}）`,
        };
      }
      const lens = glyphLengths.get(span.lineId);
      const adv = advancesOf.get(span.lineId);
      if (!lens || !adv) {
        return {
          ok: false,
          reason: "missing-source-glyphs",
          detail: `flow 行 ${fl.index} 来源 ${span.lineId} 不是 unit 成员行`,
        };
      }
      const localCodepoint = aggStart - (srcBase.get(span.lineId) ?? aggStart);
      // D-3B-6：身份链 = 「新码点 →（身份映射）→ 原码点 →（glyph 长度换算）→ 原 glyph 序号」。
      //   · 第一段只能来自 sourceIdentityOf（LCS 对齐事实）；
      //   · 第二段仍由 sourceGlyphLengthsOf / codepointIndexToGlyphIndex 负责（位置→序号换算）。
      //   · 新增字符 ⇒ 身份为 null ⇒ sourceGlyphIndex = null ⇒ 分类 fallback（回退字体），
      //     绝不被顶替为原 glyph（旧实现按位置取值 ⇒ 中间插入画出错字）。
      const identity = input.sourceIdentityOf(span.lineId);
      if (!identity) {
        return {
          ok: false,
          reason: "missing-source-identity",
          detail:
            `flow 行 ${fl.index} 来源 ${span.lineId} 无字符身份映射（LCS 对齐不可用）⇒ fail-closed，` +
            `不得按当前位置推断原 glyph`,
        };
      }
      const oldCodepoint = localCodepoint < identity.length ? identity[localCodepoint] ?? null : null;
      const glyphIndex = oldCodepoint === null ? null : codepointIndexToGlyphIndex(lens, oldCodepoint);
      const charAdvance = adv[localCodepoint];
      if (charAdvance === undefined || !Number.isFinite(charAdvance) || charAdvance < 0) {
        return {
          ok: false,
          reason: "missing-source-glyphs",
          detail: `flow 行 ${fl.index} 字符 ${JSON.stringify(ch)} 无有效 advance（${span.lineId}[${localCodepoint}]）`,
        };
      }
      glyphs.push({
        char: ch,
        cssX: penX,
        cssAdvance: charAdvance,
        sourceLineId: span.lineId,
        sourceGlyphIndex: glyphIndex,
      });
      penX += charAdvance;
    }

    redrawLines.push({
      index: fl.index,
      text: fl.text,
      cssBox: { x: fl.box.x, y: fl.box.y, width: fl.box.width, height: fl.box.height },
      baselineCssY,
      glyphs,
      sourceLineIds: [...new Set(fl.sources.map((s) => s.lineId))],
      intact: fl.intact,
    });
  }

  return {
    ok: true,
    redrawLines,
    clearLineIds: [...clearSet],
    displacedLineIds: [...displacedSet],
    deltaCss: flow.metrics.delta,
    usedLineGap,
    warnings: [...flow.warnings],
    skipped,
  };
}
