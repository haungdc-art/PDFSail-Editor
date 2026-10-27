/**
 * logical-paragraph-flow-layout.ts — F3B-6.28 · A 阶段：Core 跨 TextBox 段落流布局
 *
 * ── 定位（用户裁决 2026-10-12）────────────────────────────────────────
 *
 *   A = 建立**跨 TextBox 的段落流布局能力**（纯布局，不接生产输入/blur/Undo-Redo，
 *   不启用 EditingUnit，不改 C 的 reconciliation / D 的导出）。
 *
 *   上游：P0 契约（logical-paragraph-contract.ts）——本模块**只消费 confirmed 组**
 *   （A1）；unknown 组维持单段落行为，调用方不得把未确认组喂进本模块。
 *
 * ── 解决的问题（F3B-6.27 P1 根因）────────────────────────────────────
 *
 *   现状：1 视觉行 = 1 TextBox，Core `layoutTextBox` 按 textBox 独立排版 ⇒
 *   段落 reflow 无法推动后续行（para_46 三层面钉死原位置）。
 *
 *   A 的答案：
 *   · A2 把 confirmed 逻辑段落的**全部成员行文本聚合**后重新断行；
 *   · A3 后续 TextBox 的位置 = 原位置 + 流推进量 delta（**不再无条件保留原 top**）。
 *
 * ── 行高映射规则（A3 硬性要求，冻结）──────────────────────────────────
 *
 *   ★ reflow 后的行距 = **原始 PDF 行距**（`originalLineGap`，unit 内相邻行 y 差），
 *     **不是** Core 行盒高（fontSize ≈ 21.46px ≠ PDF 行距 ≈ 46.8px）。
 *   理由：重排结果必须与周围**未被重排的原始内容**共存于同一页面坐标系，
 *   若按 Core 行盒高累加，第二行起与后续原始内容的间距立即错位
 *   （F3B-6.27 导出态实测：第二行与首行仅差 4.4pt，而原始行距 31.2pt）。
 *   `lineGapSource` 可观测（"unit-adjacent" | "caller-provided"）；
 *   单行组无相邻差 ⇒ 必须由调用方给文档级行距估计，缺失 ⇒ fail-closed。
 *
 * ── 流推进规则（A3，冻结）────────────────────────────────────────────
 *
 *   后续内容属于同一「流」当且仅当：
 *     ① 同页；② 其行盒与逻辑段落行盒**水平区间重叠**（同栏）；
 *     ③ 其原始 top ≥ 逻辑段落原始 bottom（在其之后）。
 *   推进量 delta = (新行数 − 原行数) × usedLineGap，对同流全部后续内容**一致**
 *   （整体平移，保持它们之间的原始间距）。段落缩短 ⇒ delta 为负（上移），语义一致。
 *   非同流（跨栏/异列/上方）内容**绝不动**（门槛 1：原始布局不变性）。
 */

// ─────────────────────────────────────────────────────────────────────
// 输入
// ─────────────────────────────────────────────────────────────────────

/** 逻辑段落的成员行布局输入（1 成员行 = 1 底层 TextBox/Paragraph = 原始 1 视觉行） */
export interface FlowLineInput {
  readonly lineId: string;
  readonly textBoxId: string;
  readonly paragraphId: string;
  /** 该行承载的文本（= 该底层段落全文；当前粒度 1 视觉行 1 段落） */
  readonly text: string;
  /** 每字符 advance（px，与 text 按 UTF-16 码元一一对应；来源 = Core glyph metrics） */
  readonly advances: readonly number[];
  /** 原始行盒左缘（首行缩进 / 续行基准的证据） */
  readonly x: number;
  /** 原始行盒顶 y（页内坐标；originalLineGap 的计算依据） */
  readonly top: number;
  /** 原始行盒高（仅记录，不参与行距——见行高映射规则） */
  readonly height: number;
  /** 原始行盒宽（流右缘判定：unitRight = max(x+width)，防把邻栏内容误判同流） */
  readonly width: number;
}

/** 同页候选后续内容（是否真被推进由流规则判定） */
export interface FlowSuccessorInput {
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly text: string;
  readonly x: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
}

export interface FlowLayoutInput {
  /** P0 confirmed 组的成员行（按阅读顺序；≥1） */
  readonly lines: readonly FlowLineInput[];
  /**
   * 换行约束宽（px；口径 = Core TextBox constraintBox.width）。
   *
   * D-3B-0：**断行容量改由成员行原始右缘**（max(x+width) − 起排 x）推导，
   * 本字段保留为「约束宽合法性」fail-closed 入参与调用方口径记录
   * （原模型用它减首行缩进作容量，会把原始断行改写 —— 已废弃该用法）。
   */
  readonly constraintWidth: number;
  /**
   * 原始 PDF 行距（px）。
   * 成员行 ≥2 时本模块用相邻行 y 差自算并校验此值；单行组**必须**由调用方提供
   * （文档级行距估计），缺失/非正 ⇒ fail-closed。
   */
  readonly originalLineGap?: number;
  /** 同页候选后续内容（是否真被推进由流规则判定；见 A3） */
  readonly successors?: readonly FlowSuccessorInput[];
  /**
   * D-3B-0 · 原始断行保真：**本次编辑实际改动到的成员行** lineId。
   *
   * 语义（用户 2026-10-13 裁决；2026-10-18 二次确认——恢复软边界）：
   *   · 未变更成员行的**原始断行是硬约束** —— 它的整段文本不得被拆散，
   *     也不得被前/后成员行的文本续写（强制独占若干行）；
   *   · 变更成员行之后的边界为**软边界**，允许与后随文本合并（内容缩短时上移；
   *     内容变长折行出的尾字与后一成员合并成连续文本——用户 2026-10-18 明确期望
   *     「补」与下行「充通知为准）；」重排为一行，即段内连续重排模型）；
   *   · 缺省（不传）⇒ **unresolved**：全部成员行边界按硬断行处理（保守，不自动重排），
   *     并记入 warnings —— 宁可不重排，也不默认采用容量模型改写原始断行。
   *
   *   ⚠️ 2026-10-18 曾短暂改为「成员边界恒硬断行」，当日即按用户反馈回退：
   *      用户期望段内连续重排（合并是期望行为）；「测试消失」的真因是位移行取
   *      legacy 原文（已在 PDFEditor displacedTexts 修复），与合并无关。
   */
  readonly changedLineIds?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────

/** 单个来源片段：输出视觉行的 [textStart,textEnd) 来自哪个底层对象 */
export interface FlowLineSource {
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly lineId: string;
  /** 在**聚合文本**中的 UTF-16 区间 [start, end) */
  readonly textStart: number;
  readonly textEnd: number;
}

/** reflow 后的一个视觉行 */
export interface FlowVisualLine {
  readonly index: number;
  readonly text: string;
  readonly box: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** 来源映射（≥1；拼接后无缝覆盖聚合文本——门槛 5） */
  readonly sources: readonly FlowLineSource[];
  /** 该行是否保留了原始成员行的完整文本（未跨行拆分） */
  readonly intact: boolean;
}

/** 被流推进的后续内容（A3：新位置由布局决定，不再保留原 top） */
export interface DisplacedItem {
  readonly textBoxId: string;
  readonly paragraphId: string;
  readonly originalTop: number;
  readonly newTop: number;
  readonly delta: number;
}

export type FlowLayoutResult =
  | {
      readonly ok: true;
      readonly lines: readonly FlowVisualLine[];
      readonly displaced: readonly DisplacedItem[];
      /** 候选后续中未被推进的数量（非同流；门槛 1 可观测） */
      readonly untouchedSuccessors: number;
      readonly metrics: {
        readonly charsTotal: number;
        readonly newLineCount: number;
        readonly originalLineCount: number;
        readonly usedLineGap: number;
        readonly lineGapSource: "unit-adjacent" | "caller-provided";
        readonly firstLineIndent: number;
        readonly delta: number;
      };
      readonly warnings: readonly string[];
    }
  | { readonly ok: false; readonly reason: FlowLayoutFailure; readonly detail: string };

export type FlowLayoutFailure =
  | "empty-unit"
  | "invalid-constraint-width"
  | "advance-mismatch"
  | "invalid-advance"
  | "missing-line-gap"
  | "invalid-line-gap"
  | "non-monotonic-lines";

// ─────────────────────────────────────────────────────────────────────
// 核心
// ─────────────────────────────────────────────────────────────────────

/**
 * 贪心断行（逐字符；不做 CJK 禁则——A 简化，warning 记录）。
 *
 * D-3B-0（原始断行保真）：`hardBreakAfter` = **必须换行**的聚合下标集合
 * （该字符之后强制另起一行）——用于把「原始断行」作为硬约束注入贪心：
 * 未变更成员行的整段文本不得被拆散、也不得被后续成员行文本续写。
 */
/** 原始断行保真容差（CSS px）：见 `BREAK_FIT_EPSILON` 说明 */
const BREAK_FIT_EPSILON = 0.5;

function breakLines(
  advances: readonly number[],
  constraintWidth: number,
  firstLineIndent: number,
  hardBreakAfter?: ReadonlySet<number>,
  noSplitSpans?: ReadonlyMap<number, number>,
): number[][] {
  const rows: number[][] = [];
  let row: number[] = [];
  let width = 0;
  const limit = (isFirst: boolean) => constraintWidth - (isFirst && rows.length === 0 ? firstLineIndent : 0);
  let isFirstRow = true;
  for (let i = 0; i < advances.length; i++) {
    const adv = advances[i]!;
    let cap = isFirstRow ? limit(true) : constraintWidth;
    // ★ 未变更成员行的「整段不可拆」约束：若当前行剩余容量装不下该成员行的**整段**，
    //   则先换行（让该成员行独占新行），而不是把它的前几个字符留在上一行。
    //   （浏览器实测教训：l5 变更后溢出续写，把未变更的 l6 拆成 2 行 —— 那是编辑
    //    造成的，但把**未修改**的整行切开不是可接受的布局变化。）
    const spanWidth = noSplitSpans?.get(i);
    if (spanWidth !== undefined && row.length > 0 && width + spanWidth > cap + BREAK_FIT_EPSILON) {
      rows.push(row);
      row = [];
      width = 0;
      isFirstRow = false;
      cap = constraintWidth;
    }
    // ★ 保真容差：原始行盒宽本就由该行内容实测而来（容量 ≡ 原内容宽），逐字符累加的
    //   浮点误差不得把「恰好装得下」判成装不下 ⇒ 否则原始断行会被无意义地拆开。
    if (row.length > 0 && width + adv > cap + BREAK_FIT_EPSILON) {
      rows.push(row);
      row = [];
      width = 0;
      isFirstRow = false;
    }
    row.push(i);
    width += adv;
    if (hardBreakAfter?.has(i)) {
      rows.push(row);
      row = [];
      width = 0;
      isFirstRow = false;
    }
  }
  // 末尾硬断行后 row 为空 ⇒ 不得产出空行；但聚合为空时仍保留 1 行（既有行为）
  if (row.length > 0 || rows.length === 0) rows.push(row);
  return rows;
}

/**
 * 跨 TextBox 段落流布局（纯函数，fail-closed）。
 *
 * ⚠️ 输入的 `lines` 必须来自 P0 `groupLogicalParagraphs` 的 **confirmed** 组
 * （A1）；本模块无法自行校验组确认状态，调用方契约负责。
 */
export function computeFlowLayout(input: FlowLayoutInput): FlowLayoutResult {
  const warnings: string[] = [];
  const lines = input.lines;
  if (lines.length === 0) return { ok: false, reason: "empty-unit", detail: "逻辑段落组为空" };
  if (!(input.constraintWidth > 0)) {
    return { ok: false, reason: "invalid-constraint-width", detail: `constraintWidth=${input.constraintWidth}` };
  }
  for (const l of lines) {
    if (l.advances.length !== [...l.text].length) {
      return {
        ok: false,
        reason: "advance-mismatch",
        detail: `${l.lineId}: advances(${l.advances.length}) ≠ text 码元数(${[...l.text].length})`,
      };
    }
    // ★ 度量缺失必须显式失败（A-Integration I11）：NaN/负值/非有限 ⇒ 拒绝，
    //   绝不静默传播进布局输出（用户裁决："度量缺失…必须明确失败，不能偷偷回退"）。
    const bad = l.advances.findIndex((a) => !Number.isFinite(a) || a < 0);
    if (bad >= 0) {
      return {
        ok: false,
        reason: "invalid-advance",
        detail: `${l.lineId}: advances[${bad}] = ${l.advances[bad]}（度量缺失/非法 ⇒ fail-closed，不回退构造值）`,
      };
    }
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.top <= lines[i - 1]!.top) {
      return { ok: false, reason: "non-monotonic-lines", detail: `lines[${i}].top 必须严格递增（阅读顺序）` };
    }
  }

  // ── 行距：优先 unit 内相邻行差（实测），单行组用调用方提供值 ──
  let usedLineGap: number;
  let lineGapSource: "unit-adjacent" | "caller-provided";
  if (lines.length >= 2) {
    usedLineGap = lines[1]!.top - lines[0]!.top;
    lineGapSource = "unit-adjacent";
    if (input.originalLineGap !== undefined && Math.abs(input.originalLineGap - usedLineGap) > 0.5) {
      warnings.push(
        `调用方 originalLineGap(${input.originalLineGap?.toFixed(2)}) 与 unit 相邻行差(${usedLineGap.toFixed(2)})不一致 ⇒ 以实测为准`,
      );
    }
  } else {
    if (input.originalLineGap === undefined) {
      return {
        ok: false,
        reason: "missing-line-gap",
        detail: "单行组必须提供 originalLineGap（文档级行距估计）",
      };
    }
    if (!(input.originalLineGap > 0)) {
      return { ok: false, reason: "invalid-line-gap", detail: `originalLineGap=${input.originalLineGap}` };
    }
    usedLineGap = input.originalLineGap;
    lineGapSource = "caller-provided";
  }
  if (!(usedLineGap > 0)) {
    return { ok: false, reason: "invalid-line-gap", detail: `usedLineGap=${usedLineGap}` };
  }

  // ── 聚合文本（软换行不占 offset ⇒ 直接顺序拼接；每字符保留来源）──
  const chars: { ch: string; advance: number; srcIdx: number; localIdx: number }[] = [];
  const sourceSpans: { src: FlowLineSource; start: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const start = chars.length;
    const codePoints = [...l.text];
    for (let k = 0; k < codePoints.length; k++) {
      chars.push({ ch: codePoints[k]!, advance: l.advances[k] ?? 0, srcIdx: i, localIdx: k });
    }
    sourceSpans.push({
      src: { textBoxId: l.textBoxId, paragraphId: l.paragraphId, lineId: l.lineId, textStart: start, textEnd: chars.length },
      start,
    });
  }

  // ── 首行缩进（悬挂缩进：首行 x − 续行基准 x；非悬挂 ⇒ 0）──
  //   ★ D-3B-0：首行缩进**只是几何属性**（决定该行从哪里起排），不再是容量折减项。
  const minX = Math.min(...lines.map((l) => l.x));
  const baseX = minX;
  const firstLineIndent = Math.max(0, lines[0]!.x - minX);

  // ── 断行容量（D-3B-0：右缘证据模型，取代 constraintWidth − firstLineIndent）──
  //   容量 = 成员行**原始右缘**（max(x+width)，导入时事实）− 该行的起排 x。
  //   依据：原始断行是已有文档的布局事实；同一单元的各行共享同一右缘，
  //   首行因缩进少得的宽度由**缩进后的右缘差**体现，而不是从容量里再扣一次。
  //   ⇒ 首行容量 = (x₀+width₀) − x₀ = width₀ ≥ 原始首行内容宽（保真前提出了保证）。
  const rightEdge = Math.max(...lines.map((l) => l.x + l.width));
  const breakWidth = rightEdge - baseX;

  // ── 原始断行硬约束（D-3B-0；2026-10-18 恢复）──
  //   未变更成员行：其整段文本后强制断行 ⇒ 不被拆散、不被续写。
  //   变更成员行：边界为软（允许后随文本上移合并/尾字并入下行，也允许自身溢出换行）
  //   —— 用户 2026-10-18 明确期望段内连续重排（"补"与下行合并为一行）。
  //   未声明 changedLineIds ⇒ unresolved：全部按硬断行（保守，不自动重排）+ 告警。
  const hardBreakAfter = new Set<number>();
  /** 成员行起点 → 该成员行的**整段宽度**（未变更成员行：装不下就整段另起一行） */
  const noSplitSpans = new Map<number, number>();
  const changedSet = new Set(input.changedLineIds ?? []);
  const declared = input.changedLineIds !== undefined;
  if (!declared) {
    warnings.push(
      "original-break-unresolved: 未声明 changedLineIds ⇒ 全部成员行边界按原始断行硬约束处理（保守，不自动跨行合并）",
    );
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const start = sourceSpans[i]!.start;
    const endChar = start + [...l.text].length - 1;
    const isChanged = declared && changedSet.has(l.lineId);
    if (!isChanged) {
      hardBreakAfter.add(endChar);
      // 未变更成员行：整段不可拆（要么整段跟在当前行尾，要么另起一行独占）
      const spanWidth = l.advances.reduce((s, a) => s + (Number.isFinite(a) ? a : 0), 0);
      if (start > 0) noSplitSpans.set(start, spanWidth);
    }
  }

  // ── 断行 ──
  const advances = chars.map((c) => c.advance);
  const rows = breakLines(advances, breakWidth, firstLineIndent, hardBreakAfter, noSplitSpans);

  // ── 可观测性：原始断行是否真被保住（未变更成员行仍跨多行 ⇒ 告警）──
  //   细分两类，避免把「内容确实变长、断行不可避免」误报成「模型错误」：
  //     · original-break-overflow：内容宽已超过该行容量 ⇒ 断行不可避免（编辑所致），
  //       须人工确认是否为预期结果；
  //     · original-break-broken ：内容装得下却被拆开 ⇒ **容量模型错误**，必须修复。
  for (let i = 0; i < lines.length; i++) {
    if (declared && changedSet.has(lines[i]!.lineId)) continue;
    const start = sourceSpans[i]!.start;
    const endChar = start + [...lines[i]!.text].length - 1;
    const spanning = rows.filter((r) => r.some((idx) => idx >= start && idx <= endChar)).length;
    if (spanning <= 1) continue;
    const content = lines[i]!.advances.reduce((s, a) => s + (Number.isFinite(a) ? a : 0), 0);
    const rowCap = i === 0 ? breakWidth - firstLineIndent : breakWidth;
    if (content > rowCap + BREAK_FIT_EPSILON) {
      warnings.push(
        `original-break-overflow: 未变更成员行 ${lines[i]!.lineId} 的内容宽(${content.toFixed(1)}) 已超过其行容量(${rowCap.toFixed(1)}) ⇒ 原始断行无法保持（内容变长所致，断行不可避免）；须确认是否为预期编辑结果`,
      );
    } else {
      warnings.push(
        `original-break-broken: 未变更成员行 ${lines[i]!.lineId} 的内容(${content.toFixed(1)}) 装得下（容量 ${rowCap.toFixed(1)}）却被拆到 ${spanning} 行 ⇒ 容量模型错误，必须修复`,
      );
    }
  }

  // ── 输出行（top = 原首行 top + i × usedLineGap；行距冻结规则）──
  const unitTop = lines[0]!.top;
  const lineHeight = lines[0]!.height;
  const outLines: FlowVisualLine[] = rows.map((row, idx) => {
    const text = row.map((i) => chars[i]!.ch).join("");
    const width = row.reduce((s, i) => s + chars[i]!.advance, 0);
    const clean: FlowLineSource[] = [];
    for (const span of sourceSpans) {
      const s = Math.max(span.start, row[0]!);
      const e = Math.min(span.src.textEnd, row[row.length - 1]! + 1);
      if (e > s) {
        clean.push({
          textBoxId: span.src.textBoxId,
          paragraphId: span.src.paragraphId,
          lineId: span.src.lineId,
          textStart: s,
          textEnd: e,
        });
      }
    }
    const intact = clean.length === 1 && clean[0]!.textEnd - clean[0]!.textStart === row.length;
    return {
      index: idx,
      text,
      box: {
        x: idx === 0 ? baseX + firstLineIndent : baseX,
        y: unitTop + idx * usedLineGap,
        width,
        height: lineHeight,
      },
      sources: clean,
      intact,
    };
  });

  // ── A3：后续推进（流规则：同页由输入保证；同栏 + 在 unit 之后）──
  const newLineCount = rows.length;
  const originalLineCount = lines.length;
  const delta = (newLineCount - originalLineCount) * usedLineGap;
  const unitOriginalBottom = unitTop + originalLineCount * usedLineGap;
  // 流右缘 = 成员行盒实际右缘最大值 + 2×字号容差（约束宽是断行容量，不是栏界；
  // 用它会把右栏内容误判同流——T1b 实测教训）。
  const unitRight = Math.max(...lines.map((l) => l.x + l.width)) + lineHeight * 2;
  const displaced: DisplacedItem[] = [];
  let untouched = 0;
  for (const s of input.successors ?? []) {
    // 流规则 ②：同栏 = successor 左缘在流右缘之内，且其右缘越过 unit 左缘（水平区间重叠）
    const sRight = s.x + s.width;
    const overlaps = s.x < unitRight && sRight > baseX;
    // 流规则 ③：在 unit 原 bottom 之后（容差 = 半行距）
    const after = s.top >= unitOriginalBottom - usedLineGap / 2;
    if (overlaps && after && delta !== 0) {
      displaced.push({
        textBoxId: s.textBoxId,
        paragraphId: s.paragraphId,
        originalTop: s.top,
        newTop: s.top + delta,
        delta,
      });
    } else {
      untouched++;
    }
  }

  return {
    ok: true,
    lines: outLines,
    displaced,
    untouchedSuccessors: untouched,
    metrics: {
      charsTotal: chars.length,
      newLineCount,
      originalLineCount,
      usedLineGap,
      lineGapSource,
      firstLineIndent,
      delta,
    },
    warnings,
  };
}
