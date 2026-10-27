/**
 * editor/binding/table-cell-contract.ts — F3B-6.28 · 表格「单元格」边界识别（**纯 contract**）
 *
 * ── 用户诉求（2026-10-20）──────────────────────────────────────────────
 *   > 「表格的识别不能按段落来，应该是按照表格格子来识别，一个格子相当于一个段落」
 *
 *   现状事实（真实取证，`cases/gd-swim-2026.pdf` 第 11 页附件表格）：
 *   · PDF 表格行在 legacy 层是**一条 visual line**（一个 Core paragraph），
 *     其文本 = 多个 cell 文本用空白 operator 拼接而成。
 *   · 空白 operator = **列间隙**（实测宽度 18.4–115.4 px，远大于正文词间空格
 *     5.9–8.4 px）。
 *   · Core 侧**无表格概念**（`layoutGranularity = "visual-line"`）⇒ cell 只能是
 *     **Core paragraph 的子区间**（UTF-16 区间），不是新的 paragraph。
 *
 * ── 判据（为什么是「等距列」而不是「宽度阈值」）────────────────────────
 *   单靠「空白宽度 > 阈值」**不可靠**：真实数据里表格列间隙最窄 18.4 px
 *   （第 11 页 l16「1500米自由泳」行），而正文词间空格最宽 8.4 px；
 *   二者虽不重叠，但阈值随字号/字体漂移，不可作为**跨文档**判据。
 *
 *   ★ 采用**等距列**判据（表格的本质特征 = 列宽固定）：
 *     行内存在一段**连续近似等距**的内部列左界序列 ⇒ 该行是表格行。
 *   ★ 叠加**列间隙宽度**判据（2026-10-23 用户缺陷修复）：等距段涉及的空白簇
 *     宽度必须 ≥ 0.6×行字号。等距 alone 有假阳性——正文行会因「、50」与
 *     「+100」的宽度巧合形成 3 连等距（实测 8 行正文被误判 ⇒ 段落被拆）。
 *     标定：词间空格 0.25em vs 表格列间隙 ≥1.69em（真实 fixture 全量）。
 *
 *   真实数据对照（实测，等距相对偏差 ≤ 2%）：
 *     · 表格行 l11 「50米自由泳 24.50 …」  内部列距 102.06 ×5 ⇒ 连续等距长 5 ✓
 *     · 表格行 l12 「100米自由泳 55.50 …」  内部列距 …102.06×3 ⇒ 连续等距长 3 ✓
 *     · 表格行 l18/l24（有 1 列被宽文本打断）              ⇒ 连续等距长 3 ✓
 *     · 正文 l13「1.男子（10 项）：自由泳（50 米、…」  124.0/192.4/88.2/88.0 ⇒ 长度 2 ✗
 *     · 正文 l20「1.男子（6 项）：200 米（…」             112.9/112.0 ⇒ 长度 2 ✗
 *     · 正文 l5「日期：2026 年 9-12 月（…」               126.9/30.2/54.2/151.6/18.2 ⇒ 长度 1 ✗
 *   ⇒ 「连续等距长度 ≥ 3」可稳定区分表格行与正文行（含**结构对称的列表**
 *     这种正文里的等距干扰：l13/l16 的 88.2/88.0 只是一段 2 连等距）。
 *
 * ── cell 边界规则 ──────────────────────────────────────────────────────
 *   · 只有落在**等距列序列**上的空白簇才是「列边界」；
 *     其余空白（cell 内空格）**保留在 cell 文本内**（不误切）。
 *   · 非表格行 ⇒ `isTableRow = false` 且 `cells = []`（fail-closed：
 *     绝不把「分词结果」当 cell 用）。
 *
 * ── 坐标空间（已实测锁定）──────────────────────────────────────────────
 *   legacy glyph bbox 与 **Core 行盒同空间同尺度**（逐字节相等，取证
 *   `cases/gd-swim-2026.pdf` 第 1 页 21 行全部一致）⇒ cell 的 x/width 可直接
 *   与 Core 行盒的 y/height 组合成 cell 编辑面几何，无需任何换算系数。
 *
 * ── 硬边界 ─────────────────────────────────────────────────────────────
 *   纯函数：零 React / 零 DOM / 零 Core import / 零坐标换算 / 零 indexOf。
 *   本模块**只识别** cell，不构造任何 Core Command、不改文档、不判提交资格。
 */

export interface CellGlyphInput {
  readonly char: string;
  readonly bbox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface CellBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface TableCell {
  readonly index: number;
  /** cell 文本（不含作为列边界的空白；含 cell 内空格） */
  readonly text: string;
  /** cell 覆盖的 glyph 索引区间（闭区间；行内下标） */
  readonly startGlyphIndex: number;
  readonly endGlyphIndex: number;
  /** cell 在**行文本**（glyph 拼接）内的 UTF-16 区间 [startUtf16, endUtf16) */
  readonly startUtf16: number;
  readonly endUtf16: number;
  /** cell 墨迹盒（cell 内**非空白** glyph 的并集；与 Core 行盒同空间） */
  readonly bbox: CellBox | null;
}

export type TableCellDetectionReason =
  | "table-row"
  | "not-table-row"
  | "empty-line"
  | "insufficient-columns"
  | "narrow-column-gaps";

export interface TableCellDetectionEvidence {
  /** 全部候选内部列左界（= 每个列边界空白簇右侧第一非空白字形的 x） */
  readonly columnLefts: readonly number[];
  /** 相邻候选列左界间距 */
  readonly gaps: readonly number[];
  /** 最长连续近似等距段长度（gaps 个数） */
  readonly longestEquidistantRun: number;
  /** 最长等距段在 gaps 中的起始索引（-1 = 无） */
  readonly equidistantStart: number;
  /** 实际使用的相对偏差容差 */
  readonly toleranceRatio: number;
  /** ★ 等距段涉及的空白簇宽度序列（列间隙宽度判据的输入；空 = 无等距段） */
  readonly runBlankWidths: readonly number[];
  /** ★ 行字号参考值（px；非空白 glyph bbox 高度中位数，0 = 不可用） */
  readonly refFontSize: number;
}

export interface TableCellDetection {
  readonly isTableRow: boolean;
  readonly cells: readonly TableCell[];
  readonly reason: TableCellDetectionReason;
  readonly evidence: TableCellDetectionEvidence;
}

/** 默认参数（实测标定：表格列距 102.06 的相对抖动 ≤ 0.3%，正文词距不等距） */
export const TABLE_CELL_MIN_EQUIDISTANT_RUN = 3;
export const TABLE_CELL_EQUIDISTANT_TOLERANCE_RATIO = 0.02;
/**
 * ★ 2026-10-23（用户缺陷「非表格段落编辑态不能识别段落」）：**列间隙空白的最小宽度**
 * （单位 = 行字号的 em 比）。
 *
 * 根因（真实 fixture 全量取证）：等距判据 alone 会产生**假阳性**——正文行会因
 * 「、50」（全角顿号+2 数字 ≈ 2.8em）与「+100」（半角加号+3 数字 ≈ 2.8em）的
 * **宽度巧合**形成 3 连等距（实测 gd-swim 第 2/3/4 页共 8 行正文被误判为表格行，
 * 包括「合泳+800 米自由泳、50 米自由泳+100 米自由泳+200 米个人」）⇒
 * `table-row-not-merged` 守卫把逻辑段落拆成单行 ⇒ 用户看到「段落识别不出来」。
 *
 * 标定（同 fixture，全量 45 个旧判定行）：
 *   · 假阳性行：等距段空白宽度 = **0.25em**（词间空格）；
 *   · 真表格行：等距段空白宽度 ≥ **1.69em**（列间隙跳空）；
 *   ⇒ 0.6em 位于两者之间，两侧各 ~2.5× 余量。
 * 方向性：误判为表格 ⇒ 段落被拆（用户缺陷）；漏判为表格 ⇒ 该行走单行/段落路径
 * （fail-closed，方向安全）。
 */
export const TABLE_CELL_MIN_COLUMN_BLANK_EM_RATIO = 0.6;

/**
 * ★ 2026-10-24（用户缺陷「两列布局右列被吞进编辑面」）：**单一大列间隙 ⇒ 2 列**
 * 通道的间隙宽度阈值（单位 = 行字号的 em 比）。
 *
 * 根因：等距判据（`TABLE_CELL_MIN_EQUIDISTANT_RUN = 3`）要求 ≥3 个等距间隙
 * （≥4 列）⇒「标签 | 值」两列布局（简历头部 / 联系信息行）**结构上永远漏检**
 * ⇒ 整行含两列进编辑面、文本拼接、列间格式丢失。用户实测（Gelcimar CV）：
 * 点 "est. civil; solteiro" ⇒ 编辑面变成 "est. civil; solteiro idade; 41"
 * （右列 "idade; 41" 被吞；原文两列间有 ~180px 空档）。
 *
 * 标定（三方实测，行字号 ≈ 19.7–21px）：
 *   · 词间空格 4.6–6.6px = **0.23–0.34em**（正文行 9 个间隙全为 5.3）；
 *   · **拆组残片**（table-cell-resolver D2.1：宽间隙表格行被 groupIntoLines 拆成
 *     半行）的间隙 = 40px = **2em** —— 半行不得当完整表格行（D2.1 裁决，
 *     fail-closed 保持整行编辑）⇒ 阈值必须 > 2em；
 *   · 真两列布局列间隙 115–183px = **5.8–9.3em**（联系信息区 4 行 +
 *     admissão/demissão 3 行）；
 *   ⇒ 3em 距残片 1.5×、距真两列 1.9×、距词间 8.8×。且要求「恰好一个」大间隙
 *     ⇒ 3+ 列仍走等距通道（不猜列数）；refFontSize 不可得（≤0）⇒ 通道关闭
 *     （方向安全）。
 */
export const TABLE_CELL_WIDE_GAP_EM_RATIO = 3;

interface TextToken {
  readonly kind: "text";
  readonly startGlyph: number;
  readonly endGlyph: number;
  readonly text: string;
  readonly utf16Start: number;
  readonly utf16End: number;
  readonly box: CellBox | null;
}

interface SpaceToken {
  readonly kind: "space";
  readonly startGlyph: number;
  readonly endGlyph: number;
  readonly utf16Start: number;
  readonly utf16End: number;
  /** 空白簇的**总宽度**（各空白 glyph 的 bbox.width 之和） */
  readonly width: number;
}

type Token = TextToken | SpaceToken;

const isBlankChar = (ch: string): boolean => ch.trim().length === 0;

function unionBox(boxes: readonly (CellBox | null)[]): CellBox | null {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let any = false;
  for (const b of boxes) {
    if (!b) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) continue;
    any = true;
    if (b.x < x0) x0 = b.x;
    if (b.y < y0) y0 = b.y;
    if (b.x + b.width > x1) x1 = b.x + b.width;
    if (b.y + b.height > y1) y1 = b.y + b.height;
  }
  if (!any) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function boxOf(g: CellGlyphInput): CellBox | null {
  const b = g.bbox;
  if (!b) return null;
  if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return null;
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

/** 中位数（空数组 ⇒ 0） */
function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 把 glyph 流切成 text / space token（连续空白合并为一个 space token） */
function tokenize(glyphs: readonly CellGlyphInput[]): { tokens: Token[]; lineText: string } {
  const tokens: Token[] = [];
  let lineText = "";
  let utf16 = 0;
  let i = 0;
  while (i < glyphs.length) {
    const g = glyphs[i]!;
    const ch = g.char ?? "";
    if (isBlankChar(ch)) {
      const startGlyph = i;
      const startUtf16 = utf16;
      let text = "";
      let width = 0;
      while (i < glyphs.length) {
        const gg = glyphs[i]!;
        const c = gg.char ?? "";
        if (!isBlankChar(c)) break;
        text += c;
        utf16 += c.length;
        width += gg.bbox?.width ?? 0;
        i++;
      }
      tokens.push({
        kind: "space",
        startGlyph,
        endGlyph: i - 1,
        utf16Start: startUtf16,
        utf16End: utf16,
        width,
      });
      lineText += text;
      continue;
    }
    const startGlyph = i;
    const startUtf16 = utf16;
    let text = "";
    const boxes: (CellBox | null)[] = [];
    while (i < glyphs.length) {
      const gg = glyphs[i]!;
      const c = gg.char ?? "";
      if (isBlankChar(c)) break;
      text += c;
      utf16 += c.length;
      boxes.push(boxOf(gg));
      i++;
    }
    tokens.push({
      kind: "text",
      startGlyph,
      endGlyph: i - 1,
      text,
      utf16Start: startUtf16,
      utf16End: utf16,
      box: unionBox(boxes),
    });
    lineText += text;
  }
  return { tokens, lineText };
}

/**
 * 最长「连续近似等距」段（相对偏差 ≤ tol，基准 = 段内均值）。
 * 返回 { length, start }；length = 段内 gap 个数。
 */
function longestEquidistantRun(
  gaps: readonly number[],
  tol: number,
): { length: number; start: number } {
  let best = { length: 0, start: -1 };
  let s = 0;
  while (s < gaps.length) {
    let e = s;
    let sum = gaps[s]!;
    // 扩展右端：均值随之更新，容差相对均值
    while (e + 1 < gaps.length) {
      const nextMean = (sum + gaps[e + 1]!) / (e + 2 - s);
      const cur = gaps[e + 1]!;
      if (nextMean <= 0) break;
      if (Math.abs(cur - nextMean) / nextMean > tol) break;
      sum += cur;
      e++;
    }
    const len = e - s + 1;
    if (len > best.length) best = { length: len, start: s };
    s = e + 1 > s ? e + 1 : s + 1;
  }
  return best;
}

export interface DetectTableCellsOptions {
  readonly minEquidistantRun?: number;
  readonly toleranceRatio?: number;
  /**
   * ★ 行字号参考值（px）。提供后覆盖「从 glyph bbox 高度中位数派生」的缺省值。
   * 生产调用方（collectLineFeatures / isTableRowOfLine）持有 `style.fontSize`，
   * 传入可提高精度；缺省派生对真实数据等价（实测中位数高度 = 行字号）。
   */
  readonly fontSize?: number;
  /**
   * ★ 单一大列间隙（2 列）通道的阈值（em 比；缺省 `TABLE_CELL_WIDE_GAP_EM_RATIO`）。
   * 仅供测试/标定覆盖；生产用缺省值。
   */
  readonly wideGapEmRatio?: number;
}

/** 行字号参考值：非空白 glyph bbox 高度的中位数（无可用高度 ⇒ 0 = 判据不可用） */
function referenceFontSizeOf(glyphs: readonly CellGlyphInput[], override?: number): number {
  if (typeof override === "number" && override > 0) return override;
  const hs: number[] = [];
  for (const g of glyphs) {
    if (!g || (g.char ?? "").trim().length === 0) continue;
    const h = g.bbox?.height;
    if (typeof h === "number" && Number.isFinite(h) && h > 0) hs.push(h);
  }
  if (hs.length === 0) return 0;
  hs.sort((a, b) => a - b);
  const mid = hs.length >> 1;
  return hs.length % 2 === 1 ? hs[mid]! : (hs[mid - 1]! + hs[mid]!) / 2;
}

/**
 * 等距段涉及的空白簇宽度（列间隙宽度判据的输入）。
 *
 * 索引关系：`gaps[j] = columnLefts[j+1] − columnLefts[j]` 跨越文本段 T_{j+1} 与
 * 空白簇 S_{j+1} ⇒ gaps[j] 对应的空白宽度 = `columnGapWidths[j+1]`。
 * 等距段 = gaps[start .. start+len-1] ⇒ 空白 = columnGapWidths[start+1 .. start+len]。
 */
function runBlankWidthsOf(
  columnGapWidths: readonly number[],
  run: { readonly start: number; readonly length: number },
): number[] {
  const out: number[] = [];
  for (let j = run.start + 1; j <= run.start + run.length; j++) {
    if (j < 0 || j >= columnGapWidths.length) break;
    out.push(columnGapWidths[j]!);
  }
  return out;
}

/**
 * 识别一条 legacy visual line 的表格 cell 边界。
 *
 * ★ fail-closed：非表格行 ⇒ `isTableRow=false` + `cells=[]`（绝不把普通分词
 *   当作 cell，避免把正文「1.男子（10 项）」误当表格）。
 */
export function detectTableCells(
  glyphs: readonly CellGlyphInput[],
  options: DetectTableCellsOptions = {},
): TableCellDetection {
  const minRun = options.minEquidistantRun ?? TABLE_CELL_MIN_EQUIDISTANT_RUN;
  const tol = options.toleranceRatio ?? TABLE_CELL_EQUIDISTANT_TOLERANCE_RATIO;
  const emptyEvidence: TableCellDetectionEvidence = {
    columnLefts: [],
    gaps: [],
    longestEquidistantRun: 0,
    equidistantStart: -1,
    toleranceRatio: tol,
    runBlankWidths: [],
    refFontSize: 0,
  };

  if (!glyphs || glyphs.length === 0) {
    return { isTableRow: false, cells: [], reason: "empty-line", evidence: emptyEvidence };
  }

  const { tokens } = tokenize(glyphs);

  // 列间隙候选：**夹在两段文本之间**的空白簇（行首/行尾空白不是列间隙）。
  // 每个候选记录：右侧第一段文本的 x0（= 内部列左界）+ 空白簇总宽度。
  const columnLefts: number[] = [];
  const columnGapWidths: number[] = [];
  const columnGapTokenIndexes: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.kind !== "space") continue;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (!prev || prev.kind !== "text") continue; // 行首空白
    if (!next || next.kind !== "text" || !next.box) continue; // 行尾空白 / 无几何
    columnLefts.push(next.box.x);
    columnGapWidths.push(tk.width);
    columnGapTokenIndexes.push(i);
  }

  const gaps: number[] = [];
  for (let i = 1; i < columnLefts.length; i++) {
    gaps.push(columnLefts[i]! - columnLefts[i - 1]!);
  }

  const run = longestEquidistantRun(gaps, tol);
  // ★ 列间隙宽度判据（2026-10-23）：等距段涉及的空白必须达到「列间隙」量级
  //   （≥ 0.6×行字号）——词间空格（0.25em）会因宽度巧合形成等距假阳性。
  const refFontSize = referenceFontSizeOf(glyphs, options.fontSize);
  const runBlankWidths = runBlankWidthsOf(columnGapWidths, run);
  const blanksWideEnough =
    refFontSize <= 0 ||
    (runBlankWidths.length > 0 &&
      runBlankWidths.every((w) => w >= TABLE_CELL_MIN_COLUMN_BLANK_EM_RATIO * refFontSize));
  // ★ 2026-10-24：**单一大列间隙 ⇒ 2 列**准入通道（详见 TABLE_CELL_WIDE_GAP_EM_RATIO
  //   标定注记）。与等距通道互斥互补：等距通道覆盖 ≥4 列；本通道覆盖 2 列。
  //   内部间隙候选中**恰好一个**空白 ≥ 阈值 ⇒ 该 token index 即唯一列边界。
  const wideGapEmRatio = options.wideGapEmRatio ?? TABLE_CELL_WIDE_GAP_EM_RATIO;
  const wideGapThreshold =
    refFontSize > 0 ? wideGapEmRatio * refFontSize : Number.POSITIVE_INFINITY;
  let wideGapCount = 0;
  let wideGapTokenIndex: number | null = null;
  for (let i = 0; i < columnGapWidths.length; i++) {
    if (columnGapWidths[i]! >= wideGapThreshold) {
      wideGapCount++;
      wideGapTokenIndex = columnGapTokenIndexes[i]!;
    }
  }
  const twoColumn = refFontSize > 0 && wideGapCount === 1 && wideGapTokenIndex !== null;
  const evidence: TableCellDetectionEvidence = {
    columnLefts,
    gaps,
    longestEquidistantRun: run.length,
    equidistantStart: run.start,
    toleranceRatio: tol,
    runBlankWidths,
    refFontSize,
  };

  // ★ 等距判据**只**用于「这行是不是表格行」；列边界的取法与之解耦
  //   （见下方边界选择：宁可多切不可漏切，漏切会把两列并成一个格子 = 用户报的 bug）。
  //   准入 = 等距通道（≥3 等距间隙且空白达列间隙量级）**或** 2 列通道（恰一个大间隙）。
  const equidistantOk = run.length >= minRun && blanksWideEnough;
  if (!equidistantOk && !twoColumn) {
    return {
      isTableRow: false,
      cells: [],
      reason: run.length < minRun
        ? columnLefts.length < minRun
          ? "insufficient-columns"
          : "not-table-row"
        : "narrow-column-gaps",
      evidence,
    };
  }

  // 列边界 = 全部列间隙候选，减去「cell 内窄空格」。
  // 宽度判据（实测）：表格列间隙 18.4–115.4px，词内空格 5.9–8.4px ⇒
  // 以本行列间隙宽度中位数的一半为阈值，低于阈值者视为 cell 内空格（保留在 cell 文本里）。
  // ★ 2 列通道：边界 = 那**唯一**的大列间隙（不用中位数阈值——词间空格会全部
  //   越过 median/2 被误切成 cell，把 "Nome; Gelcimar Ferreira" 拆成 3 格）。
  //   ★ 优先级：等距通道（≥4 列真表格）**优先**于 2 列通道——实测回归（R3）：
  //     gd-swim 7 列等距行恰有一个 ≥3em 间隙 ⇒ twoColumn=true 若抢占会把
  //     7 格切成 2 格。2 列通道只兜底「等距不可用」的行。
  const boundaryTokenIndexes =
    !equidistantOk && twoColumn
      ? new Set<number>([wideGapTokenIndex!])
      : (() => {
          const widthThreshold = medianOf(columnGapWidths) * 0.5;
          const s = new Set<number>();
          for (let i = 0; i < columnGapTokenIndexes.length; i++) {
            if (columnGapWidths[i]! >= widthThreshold) s.add(columnGapTokenIndexes[i]!);
          }
          return s;
        })();
  if (boundaryTokenIndexes.size === 0) {
    return { isTableRow: false, cells: [], reason: "insufficient-columns", evidence };
  }

  // 按边界切 cell
  const cells: TableCell[] = [];
  let current: { startGlyph: number; endGlyph: number; utf16Start: number; utf16End: number; text: string; boxes: (CellBox | null)[] } | null = null;
  const flush = () => {
    if (!current) return;
    const text = current.text;
    if (text.length > 0) {
      cells.push({
        index: cells.length,
        text,
        startGlyphIndex: current.startGlyph,
        endGlyphIndex: current.endGlyph,
        startUtf16: current.utf16Start,
        endUtf16: current.utf16End,
        bbox: unionBox(current.boxes),
      });
    }
    current = null;
  };

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i]!;
    if (tk.kind === "space") {
      if (boundaryTokenIndexes.has(i)) {
        flush();
        continue;
      }
      // ★ 只有**夹在两段文本之间**的空白才是 cell 内空格（并入当前 cell 文本）；
      //   行首/行尾空白既不是列边界、也不是 cell 内空格 ⇒ 忽略（不污染 cell 文本）。
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      const isInnerSpace = !!prev && prev.kind === "text" && !!next && next.kind === "text";
      if (isInnerSpace && current) {
        current.text += " ";
        current.utf16End = tk.utf16End;
        current.endGlyph = tk.endGlyph;
      }
      continue;
    }
    if (!current) {
      current = {
        startGlyph: tk.startGlyph,
        endGlyph: tk.endGlyph,
        utf16Start: tk.utf16Start,
        utf16End: tk.utf16End,
        text: tk.text,
        boxes: tk.box ? [tk.box] : [],
      };
      continue;
    }
    current.text += tk.text;
    current.utf16End = tk.utf16End;
    current.endGlyph = tk.endGlyph;
    if (tk.box) current.boxes.push(tk.box);
  }
  flush();

  if (cells.length < 2) {
    return { isTableRow: false, cells: [], reason: "insufficient-columns", evidence };
  }
  return { isTableRow: true, cells, reason: "table-row", evidence };
}
