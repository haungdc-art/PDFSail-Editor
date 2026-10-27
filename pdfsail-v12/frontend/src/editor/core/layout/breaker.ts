/**
 * editor/core/layout/breaker.ts — EDITOR-CORE-006-B
 *
 * LineBreaker —— 唯一换行器（规范 §17）。**MERGE 既有两套断行算法**：
 *
 *   1. `document-model/text-measurement.breakTextIntoLinesByWords`
 *        token 化（CJK 逐字 / Latin 按 word / 空格合并）+ 行首空格跳过
 *        → 本文件 `tokenize()` 的基线，并**补齐两处缺口**
 *   2. `document-model/layout/line-reconstruction.ts`（1016 行）的**评分制**断行
 *        → 属「从已有 glyph 反推行」的 import 侧方向；它消费的是既成几何而非文本度量，
 *          故本层不复制其评分器（006-A §3 结论：两方向需合并于同一 LineBreaker，
 *          本层先落地编辑侧，import 侧由 legacy adapter 继续承担）
 *
 * 相对既有实现的**两处补齐**（006-A §3 实测缺口）：
 *   ✅ CJK 标点禁则（避头尾）—— 既有实现全仓 0 命中
 *   ✅ 长不可断 token —— 既有实现在 word 超宽时直接溢出
 *
 * ── 相对 `breakTextIntoLinesByWords` 的修正：CJK 标点单独成 token ──
 * 既有的 `isCJKChar` **不含** 0x3000-0x303F（CJK 标点），于是 "你好，world" 里的
 * "，" 会与 "world" 粘成一个 word token —— 既无法做禁则，断行点也错。
 * 本层把 CJK 标点单独成 token。
 *
 * ── 禁则的作用域 ────────────────────────────────────────────────────
 * 只对 CJK 标点/全角符号生效，**不改变 Latin 断行行为**，
 * 避免把既有英文排版行为一起改掉（§64 迁移安全规则）。
 *
 * ── emoji / 代理对 ──────────────────────────────────────────────────
 * 全程 `Array.from` 逐 code point 并维护 UTF-16 索引映射，
 * 代理对（emoji）绝不会被从中间切开（§17）。
 */

import type { TextStyle } from "../document/types";
import type { FontMetricsProvider } from "./metrics";
import type { AdvanceSource } from "./types";

// ─────────────────────────────────────────────────────────────────────
//  结果类型
// ─────────────────────────────────────────────────────────────────────

export interface BreakLine {
  /** 该行在段落文本中的 UTF-16 区间 [textStart, textEnd) */
  textStart: number;
  textEnd: number;
  /** 该行内容宽度（px，含 letterSpacing） */
  width: number;
  /** 是否由硬换行（"\n"）结束 */
  hardBreak: boolean;
}

export interface BreakResult {
  lines: BreakLine[];
  maxLineWidth: number;
  /** 该段落用到的度量来源集合（§18 可观测性） */
  advanceSources: AdvanceSource[];
  warnings: string[];
}

export interface BreakOptions {
  /** 启用 CJK 标点禁则，缺省 true */
  kinsoku?: boolean;
  /** 强制断开超宽不可断 token，缺省 true */
  breakLongTokens?: boolean;
  /** 单段最多产出的警告数 */
  maxWarnings?: number;
}

/**
 * 段落内按 UTF-16 索引解析样式。
 *
 * 一个段落可能有多个 run（不同 style），因此断行必须**逐字符**取样式，
 * 而不是整段用第一个 run 的样式近似。
 */
export type ParagraphStyleResolver = (textIndex: number) => TextStyle;

// ─────────────────────────────────────────────────────────────────────
//  CJK 判据与禁则字符集
// ─────────────────────────────────────────────────────────────────────

/** CJK 表意文字 / 假名 / 谚文（可逐字断行） */
export function isCJKIdeograph(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) || // Ext A
    (code >= 0xf900 && code <= 0xfaff) || // Compatibility Ideographs
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0x20000 && code <= 0x2ebef) // Ext B+（代理对）
  );
}

/**
 * CJK 标点 / 全角符号 —— 必须独立成 token 才能做禁则。
 * 既有实现的 `isCJKChar` 不覆盖 0x3000-0x303F，本层补齐。
 */
export function isCJKPunctuation(char: string): boolean {
  const code = char.codePointAt(0);
  if (code === undefined) return false;
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation（、。（）《》…）
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK Compatibility Forms
    (code >= 0xff01 && code <= 0xff60) || // Fullwidth Forms（！＂＃…）
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** 不能出现在**行首**的字符（避头）：CJK 收尾标点 */
export const NO_LINE_START_CHARS = "、。，．！？；：）〕］｝〉》」』】〗〙〛”’·ー～%‰℃°";

/** 不能出现在**行尾**的字符（避尾）：CJK 起始标点 */
export const NO_LINE_END_CHARS = "（〔［｛〈《「『【〖〘〚“‘";

// ─────────────────────────────────────────────────────────────────────
//  内部结构
// ─────────────────────────────────────────────────────────────────────

type UnitKind = "cjk" | "punct" | "word" | "space";

interface Unit {
  /** 段落文本 UTF-16 区间 */
  start: number;
  end: number;
  text: string;
  width: number;
  kind: UnitKind;
  /** 禁则：不得位于行首 */
  forbidLineStart: boolean;
  /** 禁则：不得位于行尾 */
  forbidLineEnd: boolean;
}

/** 一个候选行（unit 视图）。禁则调整在 unit 层完成，最后才 emit 成 BreakLine */
interface UnitLine {
  units: Unit[];
  /** 该行由硬换行结束（段末行） */
  hardBreak: boolean;
  /** 该行是一段的起始行 —— 禁则不得从上一条硬段跨界调入 unit */
  lockedStart: boolean;
  /**
   * 空行（无 unit）应落在的段落偏移。
   * 由所属硬段决定：段末偏移 = 该段 end。
   * 对 "\n" 这类文本，第 2 段的 end 已在新行符之后，因此连续空行位置正确。
   */
  emptyPos: number;
}

interface HardBreakSegment {
  start: number;
  end: number;
  text: string;
  hardBreak: boolean;
}

/** 按 "\n" 切段；"\n" 本身不属于任何行的文本（结构边界，CORE-002 §18） */
export function splitByHardBreak(text: string): HardBreakSegment[] {
  const segments: HardBreakSegment[] = [];
  let segStart = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") {
      segments.push({ start: segStart, end: i, text: text.slice(segStart, i), hardBreak: true });
      segStart = i + 1;
    }
  }
  segments.push({ start: segStart, end: text.length, text: text.slice(segStart), hardBreak: false });
  return segments;
}

// ─────────────────────────────────────────────────────────────────────
//  LineBreaker
// ─────────────────────────────────────────────────────────────────────

export class LineBreaker {
  private readonly metrics: FontMetricsProvider;
  private readonly kinsoku: boolean;
  private readonly breakLongTokens: boolean;
  private readonly maxWarnings: number;

  constructor(metrics: FontMetricsProvider, options: BreakOptions = {}) {
    this.metrics = metrics;
    this.kinsoku = options.kinsoku ?? true;
    this.breakLongTokens = options.breakLongTokens ?? true;
    this.maxWarnings = options.maxWarnings ?? 6;
  }

  /**
   * 对一个段落文本断行。
   *
   * @param paragraphText 段落文本（UTF-16）。含 "\n" 时按硬换行处理（容忍 legacy 文本）
   * @param style 段落统一样式，或按 UTF-16 索引解析样式（多 run 混排）
   * @param maxWidth 可用行宽（px，来自 TextBox 约束，§16）
   */
  break(
    paragraphText: string,
    style: TextStyle | ParagraphStyleResolver,
    maxWidth: number
  ): BreakResult {
    const warnings: string[] = [];
    const sources = new Set<AdvanceSource>();
    const effectiveMaxWidth = Number.isFinite(maxWidth) && maxWidth > 0 ? maxWidth : Infinity;
    const styleAt: ParagraphStyleResolver =
      typeof style === "function" ? style : () => style;

    const unitLines: UnitLine[] = [];
    let longTokenBreaks = 0;

    for (const segment of splitByHardBreak(paragraphText)) {
      const { units, longTokenBreaks: breaks } = this.tokenize(
        segment,
        styleAt,
        effectiveMaxWidth,
        sources
      );
      longTokenBreaks += breaks;
      unitLines.push(...this.fill(units, effectiveMaxWidth, segment));
    }

    const moves = this.kinsoku ? this.applyKinsoku(unitLines) : 0;
    const lines = emitLines(unitLines, paragraphText.length);

    if (longTokenBreaks > 0) {
      warnings.push(
        `${longTokenBreaks} 个超宽不可断 token 被强制按 code point 断开（§17 long unbreakable tokens）`
      );
    }
    if (moves > 0) {
      warnings.push(
        `CJK 标点禁则调整了 ${moves} 处行边界（避头尾，允许轻微溢出以满足禁则）`
      );
    }

    return {
      lines,
      maxLineWidth: lines.reduce((m, l) => Math.max(m, l.width), 0),
      advanceSources: [...sources],
      warnings: warnings.slice(0, this.maxWarnings),
    };
  }

  // ── token 化 ─────────────────────────────────────────────────────

  private tokenize(
    segment: HardBreakSegment,
    styleAt: ParagraphStyleResolver,
    maxWidth: number,
    sources: Set<AdvanceSource>
  ): { units: Unit[]; longTokenBreaks: number } {
    const text = segment.text;
    const chars = Array.from(text);

    // UTF-16 起点表（代理对按 2 个单元推进）
    const utf16: number[] = [];
    let cursor = 0;
    for (const ch of chars) {
      utf16.push(cursor);
      cursor += ch.length;
    }
    const utf16End = (charIndex: number): number =>
      charIndex >= chars.length ? text.length : utf16[charIndex];

    const units: Unit[] = [];
    let longTokenBreaks = 0;
    let i = 0;

    while (i < chars.length) {
      const ch = chars[i];
      let kind: UnitKind;
      if (isCJKPunctuation(ch)) kind = "punct";
      else if (isCJKIdeograph(ch)) kind = "cjk";
      else if (/\s/.test(ch)) kind = "space";
      else kind = "word";

      let end = i + 1;
      if (kind === "space" || kind === "word") {
        while (end < chars.length) {
          const next = chars[end];
          const nextKind: UnitKind = isCJKPunctuation(next)
            ? "punct"
            : isCJKIdeograph(next)
              ? "cjk"
              : /\s/.test(next)
                ? "space"
                : "word";
          if (nextKind !== kind) break;
          end += 1;
        }
      }

      const raw = chars.slice(i, end).join("");
      const charList = Array.from(raw);
      const unitStartIndex = segment.start + utf16[i];
      const letterSpacing = styleAt(unitStartIndex).letterSpacing ?? 0;
      let width = 0;
      for (let k = 0; k < charList.length; k++) {
        const textIndex = segment.start + utf16[i + k];
        const m = this.metrics.measure({
          char: charList[k],
          textIndex,
          style: styleAt(textIndex),
        });
        width += m.advance;
        sources.add(m.advanceSource);
      }
      width += letterSpacing * charList.length;

      const unit: Unit = {
        start: segment.start + utf16[i],
        end: segment.start + utf16End(end),
        text: raw,
        width,
        kind,
        forbidLineStart: kind === "punct" && NO_LINE_START_CHARS.includes(raw),
        forbidLineEnd: kind === "punct" && NO_LINE_END_CHARS.includes(raw),
      };

      // 长不可断 token：按 code point 切到能放下为止
      if (this.breakLongTokens && unit.width > maxWidth && charList.length > 1) {
        const parts = this.splitLongUnit(unit, charList, styleAt, maxWidth, sources);
        if (parts.length > 1) longTokenBreaks += 1;
        units.push(...parts);
      } else {
        units.push(unit);
      }
      i = end;
    }

    return { units, longTokenBreaks };
  }

  /** 把一个超宽 unit 按 code point 切成多个可放置的 unit（§17 long unbreakable tokens） */
  private splitLongUnit(
    unit: Unit,
    charList: string[],
    styleAt: ParagraphStyleResolver,
    maxWidth: number,
    sources: Set<AdvanceSource>
  ): Unit[] {
    const out: Unit[] = [];
    let chunkChars: string[] = [];
    let chunkWidth = 0;
    let chunkStart = unit.start;

    const flush = () => {
      if (chunkChars.length === 0) return;
      const text = chunkChars.join("");
      out.push({
        start: chunkStart,
        end: chunkStart + text.length,
        text,
        width: chunkWidth,
        kind: "word",
        forbidLineStart: false,
        forbidLineEnd: false,
      });
      chunkStart += text.length;
      chunkChars = [];
      chunkWidth = 0;
    };

    let idx = unit.start;
    for (const ch of charList) {
      const charStyle = styleAt(idx);
      const m = this.metrics.measure({ char: ch, textIndex: idx, style: charStyle });
      sources.add(m.advanceSource);
      const w = m.advance + (charStyle.letterSpacing ?? 0);
      if (chunkWidth + w > maxWidth && chunkChars.length > 0) flush();
      chunkChars.push(ch);
      chunkWidth += w;
      idx += ch.length;
    }
    flush();
    return out.length > 0 ? out : [unit];
  }

  // ── 贪心填充（unit 行）───────────────────────────────────────────

  private fill(units: Unit[], maxWidth: number, segment: HardBreakSegment): UnitLine[] {
    const lines: UnitLine[] = [];
    let current: Unit[] = [];
    const emptyPos = segment.end;

    for (const u of units) {
      // 行首空格丢弃（与既有 breakTextIntoLinesByWords 行为一致）
      if (u.kind === "space" && current.length === 0) continue;

      const currentWidth = sumWidth(current);
      if (current.length > 0 && currentWidth + u.width > maxWidth) {
        lines.push({ units: current, hardBreak: false, lockedStart: false, emptyPos });
        if (u.kind === "space") {
          current = [];
          continue;
        }
        current = [u];
      } else {
        current.push(u);
      }
    }
    lines.push({ units: current, hardBreak: false, lockedStart: false, emptyPos });

    // 硬换行标志只落在该段的最后一行
    lines[lines.length - 1].hardBreak = segment.hardBreak;
    // 该段首行不得从上一段借 unit
    lines[0].lockedStart = true;
    return lines;
  }

  // ── CJK 标点禁则 ─────────────────────────────────────────────────

  /**
   * 行边界调整：
   *   - 避头（行首禁则）：把下一行开头的收尾标点拉回本行（允许轻微溢出）
   *   - 避尾（行尾禁则）：把本行末尾的起始标点推到下一行
   * 只在非硬换行边界、且下一行不是段首时生效；只处理 CJK 标点 unit。
   */
  private applyKinsoku(lines: UnitLine[]): number {
    let moves = 0;
    for (let li = 0; li < lines.length - 1; li++) {
      const cur = lines[li];
      const next = lines[li + 1];
      if (next.lockedStart) continue;

      // 避头：下一行开头的连续收尾标点拉回本行
      while (next.units.length > 0 && cur.units.length > 0 && next.units[0].forbidLineStart) {
        cur.units.push(next.units.shift() as Unit);
        moves += 1;
      }
      // 避尾：本行末尾的连续起始标点推到下一行
      while (cur.units.length > 1 && cur.units[cur.units.length - 1].forbidLineEnd) {
        next.units.unshift(cur.units.pop() as Unit);
        moves += 1;
      }
    }
    return moves;
  }
}

// ─────────────────────────────────────────────────────────────────────
//  工具
// ─────────────────────────────────────────────────────────────────────

function sumWidth(units: Unit[]): number {
  let w = 0;
  for (const u of units) w += u.width;
  return w;
}

/**
 * unit 行 → BreakLine。
 * 空行（无 unit）落在该段的末尾偏移上（保留段落结构，如 "\n\n" 的中间空行）。
 */
function emitLines(unitLines: UnitLine[], paragraphEnd: number): BreakLine[] {
  const out: BreakLine[] = [];
  for (const line of unitLines) {
    if (line.units.length === 0) {
      const pos = Math.min(line.emptyPos, paragraphEnd);
      out.push({ textStart: pos, textEnd: pos, width: 0, hardBreak: line.hardBreak });
      continue;
    }
    const start = line.units[0].start;
    const end = line.units[line.units.length - 1].end;
    out.push({ textStart: start, textEnd: end, width: sumWidth(line.units), hardBreak: line.hardBreak });
  }
  return out;
}

export function createLineBreaker(
  metrics: FontMetricsProvider,
  options?: BreakOptions
): LineBreaker {
  return new LineBreaker(metrics, options);
}
