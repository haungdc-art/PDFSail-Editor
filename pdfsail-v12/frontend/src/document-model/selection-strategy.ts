/**
 * SelectionStrategy — Selection 扩展策略（Principle-5）
 *
 * 原则：Boundary 负责"定位"，Selection 负责"扩展"。
 * - Boundary 永远不返回 Selection，只回答"光标现在在哪里"。
 * - 决定"选一个字符 / 一个词 / 一句话 / 一个段落"交给 SelectionStrategy。
 *
 * 统一接口：所有选择行为（双击/三击/Ctrl+A/Shift 扩选/AI Rewrite/Replace）都实现
 * `expand(boundary)`，返回 SelectionRange。避免每个能力各自扫描一遍。
 */
import type { Boundary, DerivedSelection, TextFlow } from "./selection-engine";
import { deriveSelection } from "./selection-engine";

export interface SelectionStrategy {
  /** 从光标所在的 boundary，扩展为一段 SelectionRange */
  expand(boundary: Boundary, flow: TextFlow): DerivedSelection;
}

/** 按字符类别判断是否属于"词字符"（编辑体验优先，非语言学正确） */
function isWordChar(ch: string): boolean {
  if (ch === "") return false;
  // 词字符：字母、数字、CJK、货币符号、连接符（% 随金额）
  if (/[\p{L}\p{N}]/u.test(ch)) return true;        // 字母/数字/Unicode
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch)) return true; // CJK
  if (/[$￥€¥]/.test(ch)) return true;              // 货币符号（随数字作金额）
  if (ch === "%") return true;                      // 百分比（随数字）
  return false;
}

/** 连接符：两侧紧邻词字符时并入同一词 */
function isConnector(ch: string): boolean {
  return /[-'@._:/]/.test(ch);
}

/**
 * WordSelectionStrategy — 双击选词。
 * 从 boundary 所在字符向左右扩展，停在"边界符"（空白/标点/括号）或"连接符两侧非词字符"处。
 * 目前只实现英文 + 数字 + CJK 连续段（Task-007C 范围）。
 */
export class WordSelectionStrategy implements SelectionStrategy {
  expand(boundary: Boundary, flow: TextFlow): DerivedSelection {
    // 找到 boundary 所在的行，取行内连续字符序列
    const line = findLine(flow, boundary.page, boundary.blockId, boundary.lineId);
    if (!line || line.glyphs.length === 0) return deriveSelection({ anchor: boundary, focus: boundary }, flow);

    // 光标所在字符索引（boundary 的 edge 决定在哪个字符上）
    // 双击：选中光标所在"词"。boundary.edge=before 时在 glyphLocalIndex 字符上；after 时在该字符后（通常仍选该字符所在的词）
    const cursorGlyphIndex = boundary.edge === "before" ? boundary.glyphLocalIndex : boundary.glyphLocalIndex;
    const chars = line.glyphs.map((g) => g.char);

    // 从 cursorGlyphIndex 向左扩展起点，向右扩展终点
    // 扩展规则：相邻字符是"词字符 或 连接符"则并入。
    // 连接符（- ' @ . _ : /）在词字符之间/URL 链中持续并入；边界符（空格/标点/括号）断开。
    let start = cursorGlyphIndex;
    let end = cursorGlyphIndex + 1;

    // 向左扩展：只要左侧字符是词字符或连接符就并入（支持 URL 的 :// 链）
    while (start > 0) {
      const left = chars[start - 1];
      if (isWordChar(left) || isConnector(left)) { start--; continue; }
      break;
    }
    // 向右扩展：只要右侧字符是词字符或连接符就并入
    while (end < chars.length) {
      const right = chars[end];
      if (isWordChar(right) || isConnector(right)) { end++; continue; }
      break;
    }

    // 若光标落在连接符/边界符上，确保至少覆盖当前字符所在的词
    if (start > cursorGlyphIndex) start = cursorGlyphIndex;
    if (end < cursorGlyphIndex + 1) end = cursorGlyphIndex + 1;

    // 词可能为空（光标在边界符上）→ 退化为字符选择
    if (end <= start) return deriveSelection({ anchor: boundary, focus: boundary }, flow);

    // 构造词的 start/end boundary
    const startGlyph = line.glyphs[start];
    const endGlyph = line.glyphs[end - 1];
    const startBoundary: Boundary = {
      page: startGlyph.page,
      blockId: startGlyph.blockId,
      lineId: startGlyph.lineId,
      glyphLocalIndex: startGlyph.glyphLocalIndex,
      edge: "before",
    };
    const endBoundary: Boundary = {
      page: endGlyph.page,
      blockId: endGlyph.blockId,
      lineId: endGlyph.lineId,
      glyphLocalIndex: endGlyph.glyphLocalIndex,
      edge: "after",
    };
    return deriveSelection({ anchor: startBoundary, focus: endBoundary }, flow);
  }
}

/** 其余策略：TODO 占位 */
export class CharacterSelectionStrategy implements SelectionStrategy {
  expand(boundary: Boundary, flow: TextFlow): DerivedSelection {
    return deriveSelection({ anchor: boundary, focus: boundary }, flow);
  }
}

/** 句子结束符（V1：句号结束） */
const SENTENCE_END = new Set([".", "!", "?", "。", "！", "？"]);

/** 把 paragraph 展平为跨行连续字符序列（文本流顺序），并记录每个字符的 (line, glyphLocalIndex) */
function flattenParagraph(para: { page: number; blockId: string; lines: { lineId: string; glyphs: { page: number; blockId: string; lineId: string; glyphLocalIndex: number; char: string }[] }[] }) {
  const chars: string[] = [];
  const refs: { lineId: string; glyphLocalIndex: number }[] = [];
  for (const line of para.lines) {
    for (const g of line.glyphs) {
      chars.push(g.char);
      refs.push({ lineId: g.lineId, glyphLocalIndex: g.glyphLocalIndex });
    }
  }
  return { chars, refs };
}

/** 按稳定身份定位 paragraph */
function findParagraph(flow: TextFlow, page: number, blockId: string) {
  return flow.paragraphs.find((p) => p.page === page && p.blockId === blockId) ?? null;
}

/**
 * SentenceSelectionStrategy — 三击选句（V1）。
 * 句子边界：句号结束符 `. ! ? 。！？`。
 * 在 paragraph（block）内跨行展平，从光标向左右扩展到句子结束符。
 */
export class SentenceSelectionStrategy implements SelectionStrategy {
  expand(boundary: Boundary, flow: TextFlow): DerivedSelection {
    const para = findParagraph(flow, boundary.page, boundary.blockId);
    if (!para) return deriveSelection({ anchor: boundary, focus: boundary }, flow);

    const { chars, refs } = flattenParagraph(para);
    if (chars.length === 0) return deriveSelection({ anchor: boundary, focus: boundary }, flow);

    // 定位光标在展平序列中的位置
    let cursorIdx = -1;
    for (let i = 0; i < refs.length; i++) {
      if (refs[i].lineId === boundary.lineId && refs[i].glyphLocalIndex === boundary.glyphLocalIndex) {
        cursorIdx = i;
        break;
      }
    }
    if (cursorIdx === -1) cursorIdx = 0;

    // 句子起点：向左找最近的句子结束符，起点 = 结束符后第一个非空白字符（或段落开头）
    let start = 0;
    for (let i = cursorIdx - 1; i >= 0; i--) {
      if (SENTENCE_END.has(chars[i])) {
        // 跳过结束符后的空白（空格/换行），句子从第一个非空白字符开始
        let j = i + 1;
        while (j < chars.length && /\s/.test(chars[j])) j++;
        start = j;
        break;
      }
    }
    // 段落开头也可能有空白（行首空格），跳过
    while (start < chars.length && /\s/.test(chars[start])) start++;
    // 句子终点：向右找句子结束符（含结束符）
    let end = chars.length - 1;
    for (let i = cursorIdx; i < chars.length; i++) {
      if (SENTENCE_END.has(chars[i])) { end = i; break; }
    }

    // 构造 start/end Boundary
    const startRef = refs[start];
    const endRef = refs[end];
    const startBoundary: Boundary = {
      page: boundary.page, blockId: boundary.blockId, lineId: startRef.lineId,
      glyphLocalIndex: startRef.glyphLocalIndex, edge: "before",
    };
    const endBoundary: Boundary = {
      page: boundary.page, blockId: boundary.blockId, lineId: endRef.lineId,
      glyphLocalIndex: endRef.glyphLocalIndex, edge: "after",
    };
    return deriveSelection({ anchor: startBoundary, focus: endBoundary }, flow);
  }
}

/**
 * ParagraphSelectionStrategy — 选整个段落（block）。
 */
export class ParagraphSelectionStrategy implements SelectionStrategy {
  expand(boundary: Boundary, flow: TextFlow): DerivedSelection {
    const para = findParagraph(flow, boundary.page, boundary.blockId);
    if (!para || para.lines.length === 0) return deriveSelection({ anchor: boundary, focus: boundary }, flow);
    const first = para.lines[0].glyphs[0];
    const lastLine = para.lines[para.lines.length - 1];
    const last = lastLine.glyphs[lastLine.glyphs.length - 1];
    const startBoundary: Boundary = {
      page: first.page, blockId: first.blockId, lineId: first.lineId,
      glyphLocalIndex: first.glyphLocalIndex, edge: "before",
    };
    const endBoundary: Boundary = {
      page: last.page, blockId: last.blockId, lineId: last.lineId,
      glyphLocalIndex: last.glyphLocalIndex, edge: "after",
    };
    return deriveSelection({ anchor: startBoundary, focus: endBoundary }, flow);
  }
}

/** 按稳定身份定位 line（与 selection-engine 内部一致） */
function findLine(flow: TextFlow, page: number, blockId: string, lineId: string) {
  for (const p of flow.paragraphs) {
    if (p.page !== page || p.blockId !== blockId) continue;
    for (const l of p.lines) {
      if (l.lineId === lineId) return l;
    }
  }
  return null;
}
