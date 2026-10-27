/**
 * editor/binding/diffed-line-metrics.ts — Step 1 (Core real metrics)
 *
 * 解决 C6-F 的「看似精确的错误」：pdf-metrics.createLegacyLineMetrics 按位置取
 * advance（textIndex -> 原始 glyph）。一行被编辑后 textIndex 移位 => 同一下标拿到
 * 的是别的字符的 advance：数字都合法，但整行横向漂移。
 *
 * 做法：字符身份对齐（LCS）。只有可靠匹配的字符复用原 PDF advance；
 * 新增/替换的字符返回 undefined，交回 Core 的测量路径（fail-open 到诚实值）。
 *
 * 不是 newText[i] === oldText[i]：那在 ABCDEF -> ABXDEF 上会把 XDEF 判成「匹配」。
 *
 * 依赖边界：只依赖 Editor Core ../core/layout 与 legacy 类型。零 React / DOM。
 * 本模块不接线到任何生产渲染路径（Step 2/3 才接）。
 */
import type { EditableGlyph, EditableLine } from "../../document-model/types";
import { createFontMetricsProvider } from "../core/layout";
import type { FontMetricsProvider } from "../core/layout";

/** 行文本（与 pdf-metrics.lineText 同规则，保证偏移口径一致） */
export function lineTextOf(line: EditableLine): string {
  return line.glyphs.map((g) => g.char ?? "").join("");
}

export interface DiffedLineMetricsOptions {
  includeCharSpacing?: boolean;
  maxLcsCells?: number;
}

export interface CharIdentityPair {
  readonly newIndex: number;
  readonly oldIndex: number;
}

export interface DiffAlignment {
  readonly pairs: ReadonlyArray<CharIdentityPair>;
  readonly unmatchedNew: ReadonlySet<number>;
  readonly stats: {
    readonly oldLength: number;
    readonly newLength: number;
    readonly matched: number;
    readonly inserted: number;
    readonly deleted: number;
  };
}

/** 字符身份对齐（LCS）。LCS 表超限 => 返回 null（调用方 fail-closed） */
export function alignByCharIdentity(
  oldText: string,
  newText: string,
  options: { maxCells?: number } = {}
): DiffAlignment | null {
  const maxCells = options.maxCells ?? 250000;
  const n = oldText.length;
  const m = newText.length;
  if (n * m > maxCells) return null;

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i]!;
    const next = dp[i + 1]!;
    for (let j = m - 1; j >= 0; j--) {
      row[j] = oldText[i] === newText[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
    }
  }

  const pairs: CharIdentityPair[] = [];
  const unmatchedNew = new Set<number>();
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (oldText[i] === newText[j]) {
      pairs.push({ newIndex: j, oldIndex: i });
      matched++;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      i++;
    } else {
      unmatchedNew.add(j);
      j++;
    }
  }
  while (j < m) {
    unmatchedNew.add(j);
    j++;
  }

  return {
    pairs,
    unmatchedNew,
    stats: { oldLength: n, newLength: m, matched, inserted: unmatchedNew.size, deleted: n - matched },
  };
}

/**
 * 身份映射（**码点粒度**）：编辑后文本第 k 个**码点** → 原文本的**码点**下标；
 * `null` = 该码点是新增/替换来的（原 PDF 无对应字符）。
 *
 * D-3B-6（2026-10-16）：为「重绘 glyph 身份」提供唯一事实来源——上游
 * （flow 投影 / 重绘几何）**必须**用它判定字符身份，禁止再用「当前文本位置」
 * 直接当原 glyph 序号（那正是中间插入把「测」画成「（」的根因）。
 *
 * ⚠️ 下标口径契约（两套下标**不可**混用，勿直接透传）：
 *   · `alignByCharIdentity` 的 `pairs[].newIndex/oldIndex` 是 **UTF-16 码元**下标；
 *   · flow 布局 / 投影 / 本函数返回值按**码点**（`[...text]`）推进。
 *   本函数在两侧都做显式「码元→码点」转换；代理对字符因此不会整体错位。
 *
 * @returns 对齐失败（超预算等）⇒ `null` ⇒ 调用方必须 **fail-closed**
 *   （不得退化为位置口径、不得猜身份）。
 */
export function diffedIdentityByCodepoint(
  line: EditableLine,
  newText: string,
  options: { maxLcsCells?: number } = {},
): (number | null)[] | null {
  const oldText = lineTextOf(line);
  const alignment =
    oldText.length === 0
      ? null
      : alignByCharIdentity(oldText, newText, { maxCells: options.maxLcsCells ?? 250000 });
  if (alignment === null) return null;

  const unitToCodepoint = (text: string): Map<number, number> => {
    const m = new Map<number, number>();
    let cu = 0;
    // [...text] 按**码点**迭代；累加必须用 `cp.length`（UTF-16 **码元**数）——
    // 写成 [...cp].length 会恒为 1，代理对之后的身份将整体错位（D5 用例实测教训）。
    [...text].forEach((cp, i) => {
      m.set(cu, i);
      cu += cp.length;
    });
    return m;
  };
  const newMap = unitToCodepoint(newText);
  const oldMap = unitToCodepoint(oldText);

  const out: (number | null)[] = new Array<number>([...newText].length).fill(null);
  for (const pair of alignment.pairs) {
    const ncp = newMap.get(pair.newIndex);
    const ocp = oldMap.get(pair.oldIndex);
    if (ncp !== undefined && ocp !== undefined) out[ncp] = ocp;
  }
  return out;
}

export interface DiffedLineMetricsResult {
  readonly metrics: FontMetricsProvider;
  readonly alignment: DiffAlignment | null;
  readonly newIndexToGlyph: ReadonlyMap<number, EditableGlyph>;
  readonly stats: {
    readonly glyphs: number;
    readonly withRealAdvance: number;
    readonly measured: number;
    readonly deleted: number;
  };
  readonly warnings: string[];
}

/**
 * 为一行构造「编辑后仍复用原 PDF advance」的度量提供者。
 * · 可靠匹配 => 原 pdfAdvance ?? advanceWidth（+ charSpacing）
 * · 新增/替换 => undefined，交回测量路径，绝不猜
 * · 对齐失败 => alignment 为 null，全部走测量路径
 */
export function createDiffedLineMetrics(
  line: EditableLine,
  newText: string,
  options: DiffedLineMetricsOptions = {}
): DiffedLineMetricsResult {
  const includeCharSpacing = options.includeCharSpacing ?? true;
  const warnings: string[] = [];

  const oldText = lineTextOf(line);
  const alignment =
    oldText.length === 0
      ? null
      : alignByCharIdentity(oldText, newText, { maxCells: options.maxLcsCells ?? 250000 });

  if (alignment === null) {
    warnings.push(
      `line ${line.id}: align failed (oldLen=${oldText.length} newLen=${newText.length} over LCS budget) => all measured`
    );
  }
  if (line.glyphs.length > 0 && oldText.length === 0) {
    warnings.push(`line ${line.id}: glyphs non-empty but folded text empty`);
  }

  const newIndexToGlyph = new Map<number, EditableGlyph>();
  if (alignment) {
    for (const pair of alignment.pairs) {
      const glyph = line.glyphs[pair.oldIndex];
      if (glyph) newIndexToGlyph.set(pair.newIndex, glyph);
    }
  }
  // REVERSE-VERIFICATION: index-based (C6-F forbidden)
  if (process.env.DIFFED_INDEX_BASED === "1") {
    newIndexToGlyph.clear();
    for (let i = 0; i < line.glyphs.length; i++) newIndexToGlyph.set(i, line.glyphs[i]!);
  }

  const advanceOf = (glyph: EditableGlyph | undefined): number | undefined => {
    const raw = glyph?.metrics?.pdfAdvance ?? glyph?.metrics?.advanceWidth;
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return undefined;
    const spacing = includeCharSpacing ? glyph?.metrics?.charSpacing : undefined;
    return raw + (typeof spacing === "number" && Number.isFinite(spacing) ? spacing : 0);
  };

  const metrics = createFontMetricsProvider({
    // §18 L2：只对可靠匹配的字符返回原 PDF advance；其余 undefined => 走测量路径
    pdfsailGlyphMetrics: (query) => advanceOf(newIndexToGlyph.get(query.textIndex)),
    // 逐 glyph 注入原始度量 => 缓存键必须含位置（否则同形字符复用第一个值）
    cacheIncludesTextIndex: true,
  });

  let withRealAdvance = 0;
  for (const glyph of newIndexToGlyph.values()) {
    if (advanceOf(glyph) !== undefined) withRealAdvance += 1;
  }

  return {
    metrics,
    alignment,
    newIndexToGlyph,
    stats: {
      glyphs: line.glyphs.length,
      withRealAdvance,
      measured: alignment ? alignment.stats.inserted : newText.length,
      deleted: alignment ? alignment.stats.deleted : oldText.length,
    },
    warnings,
  };
}
